// Thin, injection-safe wrapper around the git CLI.
// Every invocation uses execFile with an argument array (never a shell), and
// user-supplied revisions are resolved to full SHAs before use.

import { execFileSync } from 'node:child_process';
import type { FileChange } from './plan.ts';

export const ZERO_SHA = /^0+$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// Conservative ref syntax: no leading "-", no "..", no control chars or spaces.
const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@^~{}-]{1,255}$/;

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export class Git {
  readonly cwd: string;
  readonly log: (msg: string) => void;
  constructor(cwd: string, log: (msg: string) => void = () => {}) {
    this.cwd = cwd;
    this.log = log;
  }

  run(args: string[], opts: { allowFail?: boolean; env?: Record<string, string> } = {}): string | undefined {
    try {
      return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
        cwd: this.cwd,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 512,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...opts.env },
        windowsHide: true,
      });
    } catch (err) {
      if (opts.allowFail) return undefined;
      const e = err as { stderr?: string; message: string };
      throw new GitError(`git ${args.filter((a) => !a.startsWith('-c')).join(' ')} failed: ${(e.stderr || e.message).trim().split('\n')[0]}`);
    }
  }

  toplevel(): string {
    return this.run(['rev-parse', '--show-toplevel'])!.trim();
  }

  isShallow(): boolean {
    return this.run(['rev-parse', '--is-shallow-repository'], { allowFail: true })?.trim() === 'true';
  }

  /** Resolves a revision to a commit SHA, or undefined if it is not available locally. */
  resolve(rev: string): string | undefined {
    if (!SHA_RE.test(rev) && !REF_RE.test(rev)) throw new GitError(`refusing suspicious revision "${rev.slice(0, 80)}"`);
    const out = this.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { allowFail: true });
    return out?.trim() || undefined;
  }

  /** Parent SHAs read from the raw commit object (works in shallow clones). */
  parents(sha: string): string[] {
    const raw = this.run(['cat-file', '-p', sha], { allowFail: true }) ?? '';
    const out: string[] = [];
    for (const line of raw.split('\n')) {
      if (line === '') break;
      const m = /^parent ([0-9a-f]{40,64})$/.exec(line);
      if (m) out.push(m[1]!);
    }
    return out;
  }

  /** Fetches commits by SHA or ref from origin. Returns false instead of throwing. */
  fetch(revs: string[], depth?: number | 'unshallow'): boolean {
    const args = ['fetch', '--no-tags', '--no-recurse-submodules', '--quiet'];
    if (depth === 'unshallow') args.push('--unshallow');
    else if (depth) args.push(`--depth=${depth}`);
    args.push('origin', ...revs);
    this.log(`git ${args.join(' ')}`);
    return this.run(args, { allowFail: true }) !== undefined;
  }

  /** Makes sure a commit object is present locally, fetching it if allowed. */
  ensure(rev: string, allowFetch: boolean): string | undefined {
    const local = this.resolve(rev);
    if (local || !allowFetch) return local;
    if (SHA_RE.test(rev)) {
      // Never turn a full clone into a shallow one: only limit depth if already shallow.
      this.fetch([rev], this.isShallow() ? 1 : undefined);
      return this.resolve(rev);
    }
    // A branch name: fetch it into its remote-tracking ref.
    if (REF_RE.test(rev) && !rev.startsWith('refs/')) {
      this.fetch([`+refs/heads/${rev}:refs/remotes/origin/${rev}`], this.isShallow() ? 1 : undefined);
      return this.resolve(`origin/${rev}`) ?? this.resolve(rev);
    }
    return undefined;
  }

  /** merge-base, deepening a shallow clone in bounded steps when needed. */
  mergeBase(a: string, b: string, allowFetch: boolean): string | undefined {
    const tryIt = () => this.run(['merge-base', a, b], { allowFail: true })?.trim() || undefined;
    let mb = tryIt();
    if (mb || !allowFetch || !this.isShallow()) return mb;
    for (const depth of [50, 500]) {
      this.fetch([a, b], depth);
      if ((mb = tryIt())) return mb;
    }
    this.fetch([a, b], 'unshallow');
    return tryIt();
  }

  /** Name-status diff between two commits (both must be present locally). */
  diff(base: string, head: string): FileChange[] {
    // --ignore-submodules=none / --no-relative: repository or runner git config must not hide changes.
    const out = this.run(['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none', '--no-relative', base, head, '--'])!;
    return parseNameStatus(out);
  }

  show(rev: string, path: string): string | undefined {
    return this.run(['show', `${rev}:${path}`], { allowFail: true });
  }

  /** Every file in a commit, or in the index when no revision is given. */
  listFiles(rev?: string): string[] {
    const args = rev
      ? ['ls-tree', '-r', '-z', '--name-only', '--full-tree', '--end-of-options', rev]
      : ['ls-files', '-z', '--cached', '--full-name', '--', ':/'];
    return (this.run(args, { allowFail: true }) ?? '').split('\0').filter(Boolean);
  }

  /**
   * Reads many files in one process (`git cat-file --batch`), at a commit or,
   * with no revision, from the index. Missing files and files over maxBytes are left out.
   */
  readMany(rev: string | undefined, paths: string[], maxBytes: number): Map<string, string> {
    const out = new Map<string, string>();
    const wanted = paths.filter((p) => !/[\n\r]/.test(p));
    if (wanted.length === 0) return out;
    let buf: Buffer;
    try {
      buf = execFileSync('git', ['cat-file', '--batch'], {
        cwd: this.cwd,
        input: wanted.map((p) => `${rev ?? ''}:${p}\n`).join(''),
        maxBuffer: 1024 * 1024 * 512,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        windowsHide: true,
      });
    } catch {
      return out;
    }
    let pos = 0;
    for (const path of wanted) {
      const nl = buf.indexOf(10, pos);
      if (nl < 0) break;
      const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(buf.toString('utf8', pos, nl));
      pos = nl + 1;
      if (!m) continue; // "<spec> missing"
      const size = Number(m[2]);
      if (m[1] === 'blob' && size <= maxBytes) out.set(path, buf.toString('utf8', pos, pos + size));
      pos += size + 1;
    }
    return out;
  }

  /** Every directory in the tree at a revision. */
  allDirs(rev: string): Set<string> {
    const out = this.run(['ls-tree', '-r', '-d', '-z', '--name-only', '--end-of-options', rev], { allowFail: true }) ?? '';
    return new Set(out.split('\0').filter(Boolean));
  }

  /** Immediate sub-directories of `dir` at a revision. */
  listDirs(rev: string, dir: string): string[] {
    const spec = dir === '.' ? rev : `${rev}:${dir}`;
    const out = this.run(['ls-tree', '-z', '--end-of-options', spec], { allowFail: true }) ?? '';
    return out.split('\0').filter(Boolean)
      .map((entry) => /^\d+ tree [0-9a-f]+\t(.+)$/.exec(entry)?.[1])
      .filter((x): x is string => x !== undefined);
  }
}

export function parseNameStatus(out: string): FileChange[] {
  const parts = out.split('\0');
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i++]!;
      const path = parts[i++]!;
      changes.push(letter === 'R' ? { status: 'renamed', path, oldPath } : { status: 'added', path });
      continue;
    }
    const path = parts[i++]!;
    const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'T' ? 'type-changed' : 'modified';
    changes.push({ status, path });
  }
  return changes;
}
