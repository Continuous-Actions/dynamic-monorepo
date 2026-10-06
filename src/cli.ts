// Local CLI: preview what CI would run, using the same engine as the Action,
// and `projects` to list what the configuration (or auto-detection) finds.
//   npx github:continuous-actions/dynamic-monorepo [projects] [--base origin/main] [--json] [--verbose]

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, TARGETS } from './config.ts';
import { execute, fsReader, loadConfig, type LoadedConfig } from './engine.ts';
import { auditWorkflows, type AuditFinding } from './audit.ts';
import { applyFixes } from './fix.ts';
import { Git, GitError } from './git.ts';
import { CycleError, Graph } from './graph.ts';
import { CONFIG_FILE, detectionLines, NAME, serialize, textReport } from './report.ts';

const HELP = `${NAME} — preview which monorepo projects a change affects

Usage:
  ${NAME} [options]             What CI would build, test, deploy and docker-build for your changes
  ${NAME} projects [options]    List every project, its folder, targets and dependencies
  ${NAME} audit [options]       Check workflow on.*.paths filters against the dependency graph
  ${NAME} audit --fix           ...and add what's missing to those paths lists

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
  --fix              (audit) Edit the paths lists; nothing else in the workflows changes
  -h, --help         Show this help
`;

export function cli(argv: string[]): number {
  let args;
  let command: string | undefined;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' }, head: { type: 'string', default: 'HEAD' },
        config: { type: 'string', default: CONFIG_FILE }, cwd: { type: 'string', default: process.cwd() },
        uncommitted: { type: 'boolean', default: false }, fetch: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false }, verbose: { type: 'boolean', default: false },
        fix: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    args = parsed.values;
    command = parsed.positionals.join(' ') || undefined;
    if (command !== undefined && command !== 'projects' && command !== 'audit') throw new Error(`unknown command "${command}" (commands: projects, audit)`);
    if (parsed.values.fix && command !== 'audit') throw new Error('--fix only applies to the audit command');
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    if (command === 'projects') return listProjects(loadConfig(args.cwd, args.config), args.json);
    if (command === 'audit') return runAudit(loadConfig(args.cwd, args.config), args.json, args.fix);
    const git = new Git(args.cwd);
    const base = args.base ?? defaultBase(git);
    let head = args.head;
    if (args.uncommitted) head = snapshotWorkingTree(git) ?? head;
    const { plan, range, warnings, notes } = execute({
      cwd: args.cwd, config: args.config, fetch: args.fetch,
      range: { eventName: 'cli', event: {}, baseInput: base, headInput: head },
      log: args.verbose ? (m) => process.stderr.write(`[debug] ${m}\n`) : undefined,
    });
    for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
    process.stdout.write(args.json ? `${JSON.stringify(serialize(plan), null, 2)}\n` : `${textReport(plan, range, args.verbose, notes)}\n`);
    return 0;
  } catch (err) {
    const known = err instanceof ConfigError || err instanceof CycleError || err instanceof GitError;
    process.stderr.write(`error: ${known ? (err as Error).message : (err as Error).stack}\n`);
    return 1;
  }
}

/** Checks every workflow's on.*.paths list against the dependency graph. Exit 1 when something is wrong. */
function runAudit({ git, top, config }: LoadedConfig, asJson: boolean, fix: boolean): number {
  const findings = auditWorkflows(config, fsReader(top, git));
  if (fix) return fixAudit(top, findings, asJson);
  if (asJson) process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  else if (findings.length === 0) process.stdout.write('No path-filter problems found.\n');
  else for (const f of findings) process.stdout.write(`${f.file}:${f.line}: ${f.message}\n`);
  return findings.length === 0 ? 0 : 1;
}

/** Writes the fixable findings into the workflow files and reports the rest. Exit 1 if anything is left. */
function fixAudit(top: string, findings: AuditFinding[], asJson: boolean): number {
  const fixed: AuditFinding[] = [];
  const left: AuditFinding[] = [];
  for (const file of new Set(findings.map((f) => f.file))) {
    const abs = join(top, file);
    const before = readFileSync(abs, 'utf8');
    const r = applyFixes(before, findings.filter((f) => f.file === file));
    if (r.text !== before) writeFileSync(abs, r.text);
    fixed.push(...r.fixed);
    left.push(...r.skipped);
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ fixed, left }, null, 2)}\n`);
    return left.length === 0 ? 0 : 1;
  }
  const change = (f: AuditFinding) => (f.fix!.add ? `added \`${f.fix!.add}\`` : `\`${f.fix!.replace!.from}\` → \`${f.fix!.replace!.to}\``);
  const out = [
    ...fixed.map((f) => `fixed  ${f.file}: ${change(f)} in on.${f.fix!.event}.paths`),
    ...left.map((f) => `left   ${f.file}:${f.line}: ${f.message}`),
  ];
  if (out.length === 0) out.push('No path-filter problems found.');
  else out.push('', `${fixed.length} fixed, ${left.length} left to fix by hand.${fixed.length ? ' Review the edits with `git diff`.' : ''}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return left.length === 0 ? 0 : 1;
}

/** Prints every project in dependency order, plus how they were found and likely mistakes. */
function listProjects({ config, configRel, noConfigFile, top }: LoadedConfig, asJson: boolean): number {
  const graph = new Graph(config.projects.values(), { allowCycles: true });
  const projects = [...config.projects.values()].sort((a, b) => graph.rank.get(a.name)! - graph.rank.get(b.name)!);
  if (asJson) {
    const out = projects.map((p) => ({ name: p.name, path: p.path, targets: p.targets, dependsOn: p.dependsOn, source: p.source, dockerfile: p.dockerfile ?? null }));
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  const lines = [noConfigFile ? `Configuration: none (no ${configRel})` : `Configuration: ${configRel}`];
  lines.push(...detectionLines(config.detection, noConfigFile), '', `${projects.length} project(s), dependencies first:`);
  const w1 = Math.min(40, Math.max(...projects.map((p) => p.name.length)));
  const w2 = Math.min(40, Math.max(...projects.map((p) => p.path.length)));
  for (const p of projects) {
    const deps = p.dependsOn.length ? `  depends on: ${p.dependsOn.join(', ')}` : '';
    lines.push(`  ${p.name.padEnd(w1)}  ${p.path.padEnd(w2)}  [${p.targets.join(', ')}]${deps}`);
  }
  const pats = (ms: { pattern: string }[]) => ms.map((m) => m.pattern).join(', ') || 'none';
  lines.push('', `Global files (a change selects every project): ${pats(config.global)}`, `Ignored files: ${pats(config.ignore)}`);
  for (const t of TARGETS) {
    if (!projects.some((p) => p.targets.includes(t))) lines.push(`No project has the "${t}" target, so the "${t}" output is always empty.`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  for (const p of projects) {
    if (p.path !== '.' && !existsSync(join(top, p.path))) {
      process.stderr.write(`warning: project "${p.name}": folder "${p.path}" does not exist, so no file change will select it\n`);
    }
  }
  return 0;
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
