// Local CLI: preview what CI would run, using the same engine as the Action.
//   npx github:OpenMind-SI/dynamic-monorepo [--base origin/main] [--json] [--verbose]

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError } from './config.ts';
import { execute } from './engine.ts';
import { Git, GitError } from './git.ts';
import { CycleError } from './graph.ts';
import { CONFIG_FILE, NAME, serialize, textReport } from './report.ts';

const HELP = `${NAME} — preview which monorepo projects a change affects

Usage: ${NAME} [options]

Options:
  --base <ref>       Compare against the merge-base with this ref
                     (default: origin/HEAD, else origin/main, else main)
  --head <ref>       Revision to compare (default: HEAD)
  --config <path>    Config file (default: ${CONFIG_FILE})
  --cwd <dir>        Repository directory (default: current directory)
  --uncommitted      Also include uncommitted changes in the working tree
  --fetch            Allow fetching missing commits from origin
  --json             Print the full plan as JSON
  --verbose          List skipped projects and unowned files
  -h, --help         Show this help
`;

export function cli(argv: string[]): number {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' }, head: { type: 'string', default: 'HEAD' },
        config: { type: 'string', default: CONFIG_FILE }, cwd: { type: 'string', default: process.cwd() },
        uncommitted: { type: 'boolean', default: false }, fetch: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false }, verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }).values;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const git = new Git(args.cwd);
    const base = args.base ?? defaultBase(git);
    let head = args.head;
    if (args.uncommitted) head = snapshotWorkingTree(git) ?? head;
    const { plan, range, warnings } = execute({
      cwd: args.cwd, config: args.config, fetch: args.fetch,
      range: { eventName: 'cli', event: {}, baseInput: base, headInput: head },
      log: args.verbose ? (m) => process.stderr.write(`[debug] ${m}\n`) : undefined,
    });
    for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
    process.stdout.write(args.json ? `${JSON.stringify(serialize(plan), null, 2)}\n` : `${textReport(plan, range, args.verbose)}\n`);
    return 0;
  } catch (err) {
    const known = err instanceof ConfigError || err instanceof CycleError || err instanceof GitError;
    process.stderr.write(`error: ${known ? (err as Error).message : (err as Error).stack}\n`);
    return 1;
  }
}

function defaultBase(git: Git): string | undefined {
  const sym = git.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })?.trim();
  for (const ref of [sym, 'origin/main', 'origin/master', 'main', 'master']) {
    if (ref && git.resolve(ref)) return ref;
  }
  return undefined;
}

/** Snapshots the working tree (incl. untracked, honouring .gitignore) as a dangling commit, using a throwaway index. */
function snapshotWorkingTree(git: Git): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "dm-snapshot-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    git.run(["read-tree", "HEAD"], { env });
    git.run(["add", "-A"], { env });
    const tree = git.run(["write-tree"], { env })!.trim();
    return git.run(["commit-tree", tree, "-p", "HEAD", "-m", "dynamic-monorepo working tree snapshot"], {
      env: { GIT_AUTHOR_NAME: "snapshot", GIT_AUTHOR_EMAIL: "snapshot@localhost", GIT_COMMITTER_NAME: "snapshot", GIT_COMMITTER_EMAIL: "snapshot@localhost" },
    })!.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exitCode = cli(process.argv.slice(2));
