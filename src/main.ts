// Action entry point: wires inputs -> git range -> plan -> outputs/summary.

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { appendSummary, command, getBoolean, getInput, group, info, setOutput } from './actions.ts';
import { ConfigError, LIMITS, parseConfig, type Config } from './config.ts';
import { Git, GitError } from './git.ts';
import { CycleError } from './graph.ts';
import { plan, type FileChange, type Plan } from './plan.ts';
import { resolveRange } from './range.ts';
import { markdownReport, NAME, textReport } from './report.ts';

const MATRIX_LIMIT = 256;

export function run(): number {
  const t0 = performance.now();
  try {
    const cwd = resolve(process.env['GITHUB_WORKSPACE'] || process.cwd(), getInput('working-directory', '.'));
    const verbose = getBoolean('verbose', false);
    const allowFetch = getBoolean('fetch', true);
    const writeSummary = getBoolean('summary', true);
    const git = new Git(cwd, verbose ? (m) => info(`[debug] ${m}`) : undefined);
    const top = git.toplevel();

    const configInput = getInput('config', `.github/${NAME}.yml`);
    const configAbs = resolve(cwd, configInput);
    const configRel = relative(top, configAbs).split(sep).join('/');
    if (configRel.startsWith('..') || isAbsolute(configRel)) throw new ConfigError(configInput, ['config file must be inside the repository']);
    if (!existsSync(configAbs)) {
      throw new ConfigError(configRel, [`file not found (create it, or set the "config" input). See https://github.com/OpenMind-SI/${NAME}#configuration`]);
    }
    if (statSync(configAbs).size > LIMITS.configBytes) throw new ConfigError(configRel, [`file is larger than ${LIMITS.configBytes} bytes`]);
    const head = parseConfig(readFileSync(configAbs, 'utf8'), configRel, (dir) => listDirsFs(top, dir));

    const eventName = process.env['GITHUB_EVENT_NAME'] ?? '';
    const event = readEvent();
    const { range, warnings } = resolveRange(git, {
      eventName, event, baseInput: getInput('base') || undefined, headInput: getInput('head', 'HEAD'), fetch: allowFetch,
    });
    for (const w of warnings) command('warning', w, { title: NAME });

    let changes: FileChange[] = [];
    let base: Config | null | undefined;
    if (range.kind === 'diff') {
      changes = git.diff(range.base, range.head);
      const baseText = git.show(range.base, configRel);
      if (baseText === undefined) base = null;
      else {
        try {
          base = parseConfig(baseText, `${configRel}@${range.base.slice(0, 12)}`, (dir) => git.listDirs(range.base, dir));
        } catch (err) {
          base = undefined;
          if (verbose) info(`[debug] base configuration unreadable: ${(err as Error).message}`);
        }
      }
    } else {
      command('warning', `Selecting all projects: ${range.why}`, { title: NAME });
    }

    const result = plan({ head, base, configPath: configRel, changes, forceAll: range.kind === 'all' ? range.why : undefined });
    writeOutputs(result, range.kind === 'diff' ? range.base : '', range.kind === 'diff' ? range.head : range.head ?? '');

    for (const t of ['build', 'test', 'deploy'] as const) {
      if (result.targets[t].length > MATRIX_LIMIT) {
        command('warning', `"${t}" has ${result.targets[t].length} projects; a single matrix is limited to ${MATRIX_LIMIT} jobs`, { title: NAME });
      }
    }
    info(textReport(result, range, verbose));
    if (verbose) group('Plan JSON', () => info(JSON.stringify(serialize(result), null, 2)));
    if (writeSummary) appendSummary(markdownReport(result, range));
    info(`Completed in ${Math.round(performance.now() - t0)} ms`);
    return 0;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof CycleError || err instanceof GitError) {
      command('error', err.message, { title: `${NAME}: ${err.name}` });
    } else {
      command('error', `Unexpected failure: ${(err as Error).stack ?? String(err)}`, { title: NAME });
    }
    return 1;
  }
}

function listDirsFs(top: string, dir: string): string[] {
  try {
    return readdirSync(join(top, dir), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function readEvent(): Record<string, any> {
  const p = process.env['GITHUB_EVENT_PATH'];
  if (!p || !existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function serialize(p: Plan) {
  return {
    all: p.all,
    allReason: p.allReason ?? null,
    changed: p.changed,
    affected: p.affected,
    build: p.targets.build,
    test: p.targets.test,
    deploy: p.targets.deploy,
    added: p.added,
    deleted: p.deleted,
    renamed: p.renamed,
    skipped: p.skipped,
    paths: p.paths,
    reasons: Object.fromEntries([...p.reasons].sort(([a], [b]) => (a < b ? -1 : 1))),
    files: p.files,
  };
}

function writeOutputs(p: Plan, base: string, head: string): void {
  const json = (v: unknown) => JSON.stringify(v);
  setOutput('changed', json(p.changed));
  setOutput('affected', json(p.affected));
  setOutput('build', json(p.targets.build));
  setOutput('test', json(p.targets.test));
  setOutput('deploy', json(p.targets.deploy));
  setOutput('added', json(p.added));
  setOutput('deleted', json(p.deleted));
  setOutput('renamed', json(p.renamed));
  setOutput('skipped', json(p.skipped));
  setOutput('paths', json(p.paths));
  setOutput('has_changes', String(p.affected.length > 0));
  setOutput('has_build', String(p.targets.build.length > 0));
  setOutput('has_test', String(p.targets.test.length > 0));
  setOutput('has_deploy', String(p.targets.deploy.length > 0));
  setOutput('all', String(p.all));
  setOutput('reason', p.allReason ?? '');
  setOutput('base', base);
  setOutput('head', head);
  const dir = process.env['RUNNER_TEMP'];
  if (dir) {
    const file = join(dir, `${NAME}-plan.json`);
    writeFileSync(file, JSON.stringify(serialize(p), null, 2));
    setOutput('plan_file', file);
  }
}

process.exitCode = run();
