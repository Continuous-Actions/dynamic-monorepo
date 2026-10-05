// GitHub Action entry point: inputs -> engine -> outputs, log and job summary.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { appendSummary, command, getBoolean, getInput, group, info, setOutput } from './actions.ts';
import { ConfigError, TARGETS } from './config.ts';
import { execute } from './engine.ts';
import { GitError } from './git.ts';
import { CycleError } from './graph.ts';
import type { Plan } from './plan.ts';
import { batches, CONFIG_FILE, markdownReport, NAME, serialize, textReport } from './report.ts';

const MATRIX_LIMIT = 256;

export function run(): number {
  const t0 = performance.now();
  try {
    const cwd = resolve(process.env['GITHUB_WORKSPACE'] || process.cwd(), getInput('working-directory', '.'));
    const verbose = getBoolean('verbose', false);
    const maxJobs = Number(getInput('max-jobs', String(MATRIX_LIMIT)));
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > MATRIX_LIMIT) throw new Error(`input "max-jobs" must be an integer from 1 to ${MATRIX_LIMIT}`);

    const { plan, range, warnings } = execute({
      cwd,
      config: getInput('config', CONFIG_FILE),
      fetch: getBoolean('fetch', true),
      range: {
        eventName: process.env['GITHUB_EVENT_NAME'] ?? '',
        event: readEvent(),
        baseInput: getInput('base') || undefined,
        headInput: getInput('head', 'HEAD'),
      },
      log: verbose ? (m) => info(`[debug] ${m}`) : undefined,
    });
    for (const w of warnings) command('warning', w, { title: NAME });
    if (range.kind === 'all') command('warning', `Selecting all projects: ${range.why}`, { title: NAME });

    writeOutputs(plan, range.kind === 'diff' ? range.base : '', range.head ?? '', maxJobs);
    for (const t of TARGETS) {
      if (plan.targets[t].length > maxJobs) {
        info(`"${t}" has ${plan.targets[t].length} projects (more than ${maxJobs}); use the "${t}_batches" output to stay within one matrix.`);
      }
    }
    info(textReport(plan, range, verbose));
    if (verbose) group('Plan JSON', () => info(JSON.stringify(serialize(plan), null, 2)));
    if (getBoolean('summary', true)) appendSummary(markdownReport(plan, range));
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

function writeOutputs(p: Plan, base: string, head: string, maxJobs: number): void {
  const json = (v: unknown) => JSON.stringify(v);
  setOutput('changed', json(p.changed));
  setOutput('affected', json(p.affected));
  for (const t of TARGETS) {
    setOutput(t, json(p.targets[t]));
    setOutput(`${t}_batches`, json(batches(p.targets[t], maxJobs)));
    setOutput(`has_${t}`, String(p.targets[t].length > 0));
  }
  setOutput('added', json(p.added));
  setOutput('deleted', json(p.deleted));
  setOutput('renamed', json(p.renamed));
  setOutput('skipped', json(p.skipped));
  setOutput('paths', json(p.paths));
  setOutput('has_changes', String(p.affected.length > 0));
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
