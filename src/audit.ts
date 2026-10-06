// Path-filter audit: compares each workflow's `on.<event>.paths` list with the
// project dependency graph and reports filters that have drifted from it.
// Read-only: workflow files are parsed as data, nothing is executed.

import { load, CORE_SCHEMA } from 'js-yaml';
import type { Config, RepoReader } from './config.ts';
import { compileSegments, validatePattern } from './glob.ts';

export type AuditFinding = {
  /** Repo-relative workflow file. */
  file: string;
  /** 1-based line of the `paths:` key (best effort). */
  line: number;
  kind: 'missing-dependency' | 'directory-without-glob' | 'missing-workflow-file';
  message: string;
  /** What `audit --fix` changes in on.<event>.paths; absent when the fix needs a human. */
  fix?: { event: string; add?: string; replace?: { from: string; to: string } };
};

const EVENTS = ['push', 'pull_request', 'pull_request_target'];

export function auditWorkflows(config: Config, reader: RepoReader): AuditFinding[] {
  const files = reader.listFiles().filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).sort();
  const fileSet = new Set(reader.listFiles());
  const dirSet = new Set<string>();
  for (const f of fileSet) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirSet.add(f.slice(0, i));
  const projects = [...config.projects.values()].filter((p) => p.path !== '.');
  const findings: AuditFinding[] = [];
  const texts = reader.readMany(files);

  for (const file of files) {
    const text = texts.get(file);
    if (text === undefined) continue;
    let doc: any;
    try {
      doc = load(text, { schema: CORE_SCHEMA });
    } catch {
      continue;
    }
    const on = doc?.on ?? doc?.true; // YAML 1.1 parsers may read `on` as a boolean key
    if (!on || typeof on !== 'object' || Array.isArray(on)) continue;
    const lines = text.split(/\r?\n/);
    for (const event of EVENTS) {
      const paths: unknown = on[event]?.paths;
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) continue;
      const line = lineOf(lines, event, paths[0] as string);
      const include = (paths as string[]).filter((p) => !p.startsWith('!'));
      const add = (kind: AuditFinding['kind'], message: string, fix?: AuditFinding['fix']) => {
        if (!findings.some((f) => f.file === file && f.kind === kind && f.message === message)) findings.push({ file, line, kind, message, ...(fix && { fix }) });
      };

      for (const p of include) {
        if (p.startsWith('.github/workflows/') && !/[*?[]/.test(p) && !fileSet.has(p)) {
          add('missing-workflow-file', `\`${p}\` is listed under on.${event}.paths but no longer exists, so editing this workflow won't trigger it.`);
        }
        const bare = p.replace(/\/+$/, '');
        if (!/[*?[]/.test(bare) && dirSet.has(bare)) {
          add('directory-without-glob', `\`${p}\` is a directory; GitHub path filters need \`${bare}/**\` to match the files inside it.`, { event, replace: { from: p, to: `${bare}/**` } });
        }
      }

      // Only plain globs can be evaluated; skip the dependency check if any pattern is exotic.
      if (include.some((p) => validatePattern(p) !== undefined)) continue;
      const tests = include.map((p) => compileSegments(p));
      // A folder counts as watched if any pattern matches inside it, or is rooted inside it
      // (e.g. `pkg/src/**` watches the package's sources, which is a deliberate choice).
      const probes = (dir: string) => [`${dir}/__audit__/x`, `${dir}/x`, ...['src', 'lib', 'pkg', 'internal', 'app'].map((s) => `${dir}/${s}/__audit__/x`)];
      const covers = (dir: string) =>
        tests.some((t) => probes(dir).some((p) => t(p))) || include.some((p) => p.startsWith(`${dir}/`));
      if (include.some((p) => p === '**' || p === '**/*')) continue;
      // Projects the filter is specifically about: a pattern rooted inside the project directory.
      // A workflow is "about" a project only if it watches the whole folder (dir, dir/, dir/**,
      // dir/**/<glob>); filters naming single files or sub-folders are deliberately narrow.
      const listed = projects.filter((pr) => include.some((p) => p === pr.path || p === `${pr.path}/` || p.startsWith(`${pr.path}/**`)));
      if (listed.length === 0) continue;
      // One finding per missing folder, naming the listed projects that need it.
      const missing = new Map<string, Set<string>>();
      for (const pr of listed) {
        for (const dep of closure(config, pr.name)) {
          const d = config.projects.get(dep);
          if (!d || d.path === '.' || covers(d.path)) continue;
          (missing.get(dep) ?? missing.set(dep, new Set()).get(dep)!).add(pr.name);
        }
      }
      for (const [dep, users] of [...missing].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const d = config.projects.get(dep)!;
        const who = [...users].sort();
        const needs = who.length > 3 ? `${who.slice(0, 3).join(', ')} and ${who.length - 3} more` : who.join(', ');
        add('missing-dependency', `\`${d.path}/**\` is missing from on.${event}.paths: ${needs} depend${who.length === 1 ? 's' : ''} on \`${dep}\`, so a change there skips this workflow.`, { event, add: `${d.path}/**` });
      }
    }
  }
  return findings;
}

function closure(config: Config, name: string): Set<string> {
  const out = new Set<string>();
  const stack = [...(config.projects.get(name)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (out.has(n) || n === name) continue;
    out.add(n);
    stack.push(...(config.projects.get(n)?.dependsOn ?? []));
  }
  return out;
}

function lineOf(lines: string[], event: string, firstPath: string | undefined): number {
  const e = lines.findIndex((l) => new RegExp(`^\\s*${event}\\s*:`).test(l));
  const p = lines.findIndex((l, i) => i > e && /^\s*paths\s*:/.test(l));
  if (p >= 0) return p + 1;
  if (firstPath) {
    const q = lines.findIndex((l) => l.includes(firstPath));
    if (q >= 0) return q + 1;
  }
  return Math.max(1, e + 1);
}
