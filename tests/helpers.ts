// E2E harness: builds throwaway git repositories and runs the *bundled*
// action (dist/index.js) exactly as the runner would, via env vars and files.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';

export const CONFIG = 'dynamic-monorepo.config.json';
/** Write key: tests author configs in compact YAML; they are stored as JSON at CONFIG. */
export const CFG = '__config__';

/** YAML (test shorthand) -> JSON text. Unparseable input is written verbatim so syntax-error tests still work. */
export function toJson(yaml: string): string {
  try {
    return JSON.stringify(load(yaml), null, 2);
  } catch {
    return yaml;
  }
}

export const DIST = resolve(import.meta.dirname, '..', 'dist', 'index.js');
const tempDirs: string[] = [];

export function tmp(prefix = 'mi-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

export function cleanup(): void {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
}

export class Repo {
  readonly dir: string;
  constructor(dir?: string) {
    this.dir = dir ?? tmp('mi-repo-');
    if (!dir) {
      this.git('init', '-q', '-b', 'main');
      this.git('config', 'user.email', 'test@example.com');
      this.git('config', 'user.name', 'test');
      this.git('config', 'commit.gpgsign', 'false');
      this.git('config', 'core.autocrlf', 'false');
    }
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  write(files: Record<string, string | null>): this {
    for (const [key, raw] of Object.entries(files)) {
      const path = key === CFG ? CONFIG : key;
      const content = key === CFG && raw !== null ? toJson(raw) : raw;
      const abs = join(this.dir, path);
      if (content === null) rmSync(abs, { recursive: true, force: true });
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    return this;
  }

  commit(message = 'change', files?: Record<string, string | null>): string {
    if (files) this.write(files);
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.head();
  }

  head(): string {
    return this.git('rev-parse', 'HEAD');
  }

  /** Simulates GitHub's refs/pull/N/merge: a merge of `prHead` into `base`. Returns its SHA. */
  testMerge(base: string, prHead: string): string {
    this.git('checkout', '-q', '--detach', base);
    this.git('merge', '-q', '--no-ff', '--no-edit', prHead);
    return this.head();
  }

  fileUrl(): string {
    return pathToFileURL(this.dir).href;
  }
}

export type RunResult = {
  code: number;
  stdout: string;
  outputs: Record<string, string>;
  json: (name: string) => any;
  summary: string;
  plan: any;
};

export function runAction(repo: Repo | string, opts: {
  event?: string;
  payload?: unknown;
  inputs?: Record<string, string>;
  cwd?: string;
} = {}): RunResult {
  const work = tmp('mi-run-');
  const outFile = join(work, 'output');
  const summaryFile = join(work, 'summary');
  const eventFile = join(work, 'event.json');
  writeFileSync(outFile, '');
  writeFileSync(summaryFile, '');
  writeFileSync(eventFile, JSON.stringify(opts.payload ?? {}));
  const dir = typeof repo === 'string' ? repo : repo.dir;
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    SystemRoot: process.env['SystemRoot'] ?? '',
    HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
    USERPROFILE: process.env['USERPROFILE'] ?? '',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKSPACE: dir,
    GITHUB_OUTPUT: outFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_EVENT_NAME: opts.event ?? 'workflow_dispatch',
    RUNNER_TEMP: work,
  };
  for (const [k, v] of Object.entries(opts.inputs ?? {})) env[`INPUT_${k.toUpperCase()}`] = v;
  const r = spawnSync(process.execPath, [DIST], { cwd: opts.cwd ?? dir, env, encoding: 'utf8' });
  const outputs = parseOutputs(readFileSync(outFile, 'utf8'));
  const planFile = join(work, 'dynamic-monorepo-plan.json');
  return {
    code: r.status ?? -1,
    stdout: (r.stdout ?? '') + (r.stderr ?? ''),
    outputs,
    json: (name) => {
      if (!(name in outputs)) throw new Error(`no output "${name}"\n${r.stdout}${r.stderr}`);
      return JSON.parse(outputs[name]!);
    },
    summary: readFileSync(summaryFile, 'utf8'),
    plan: existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : undefined,
  };
}

/** Parses the GITHUB_OUTPUT heredoc format exactly like the runner does. */
export function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^=<]+)<<(.+)$/.exec(lines[i]!);
    if (!m) continue;
    const [, name, delim] = m;
    const value: string[] = [];
    while (++i < lines.length && lines[i] !== delim) value.push(lines[i]!);
    out[name!] = value.join('\n');
  }
  return out;
}

export const SMALL_CONFIG = `
projects:
  shared:
    path: libs/shared
  api:
    path: services/api
    dependsOn: [shared]
    targets: [build, test, deploy]
  web:
    path: apps/web
    dependsOn: [api]
    targets: [build, test, deploy]
global:
  - package-lock.json
ignore:
  - "**/*.md"
`;

/** shared <- api <- web, with one commit on main. */
export function smallRepo(config = SMALL_CONFIG): Repo {
  const repo = new Repo();
  repo.commit('init', {
    [CFG]: config,
    'package-lock.json': '{}',
    'README.md': '# root',
    'libs/shared/index.ts': 'export const a = 1;',
    'services/api/index.ts': 'export const b = 1;',
    'apps/web/index.ts': 'export const c = 1;',
  });
  return repo;
}

export function pushPayload(before: string, after: string, extra: Record<string, unknown> = {}) {
  return { ref: 'refs/heads/main', before, after, repository: { default_branch: 'main' }, ...extra };
}

export function prPayload(base: string, head: string) {
  return { pull_request: { base: { sha: base, ref: 'main' }, head: { sha: head, ref: 'feature' } } };
}
