// End-to-end tests for zero-config auto-detection. No config file unless a test adds one.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { CONFIG, cleanup, pushPayload, Repo, runAction } from './helpers.ts';

afterAll(cleanup);

const push = (repo: Repo, before: string, after: string) => runAction(repo, { event: 'push', payload: pushPayload(before, after) });
const pkg = (name: string, deps: Record<string, string> = {}) => JSON.stringify({ name, version: '1.0.0', dependencies: deps });
const CLI = resolve(import.meta.dirname, '..', 'dist', 'cli.js');

/** node (shared <- web, web has a Dockerfile) + go (lib <- api) + a docker-only service + CI config. */
function polyglot() {
  const repo = new Repo();
  const before = repo.commit('init', {
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }),
    'yarn.lock': '# lock',
    'packages/shared/package.json': pkg('@acme/shared'),
    'packages/shared/index.ts': 'export {}',
    'apps/web/package.json': pkg('@acme/web', { '@acme/shared': 'workspace:*', react: '^19' }),
    'apps/web/Dockerfile': 'FROM node:24',
    'apps/web/index.ts': 'x',
    'libs/golib/go.mod': 'module example.com/lib\n\ngo 1.23\n',
    'libs/golib/lib.go': 'package lib',
    'services/api/go.mod': 'module example.com/api\n\ngo 1.23\n\nrequire example.com/lib v0.0.0\n\nreplace example.com/lib => ../../libs/golib\n',
    'services/api/main.go': 'package main',
    'deploy/proxy/Dockerfile': 'FROM nginx',
    '.github/workflows/ci.yml': 'on: push',
  });
  return { repo, before };
}

describe('auto-detection without a config file', () => {
  it('polyglot repo: node and go dependencies, docker targets and Dockerfile paths', () => {
    const { repo, before } = polyglot();
    const after = repo.commit('shared', { 'packages/shared/index.ts': 'export const a = 1' });
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect(r.json('affected')).toEqual(['@acme/shared', '@acme/web']);
    expect(r.json('build')).toEqual(['@acme/shared', '@acme/web']);
    expect(r.json('docker')).toEqual(['@acme/web']);
    expect(r.json('deploy')).toEqual(['@acme/web']);
    expect(r.json('dockerfiles')).toEqual({ '@acme/web': 'apps/web/Dockerfile' });
    expect(r.outputs['has_docker']).toBe('true');
    expect(r.json('skipped')).toEqual(['deploy/proxy', 'libs/golib', 'services/api']);
    expect(r.stdout).toContain('Detected 5 projects: 2 node, 2 go, 2 docker');
    expect(r.summary).toContain('How projects were found');
  });

  it('go modules depend on each other through require/replace', () => {
    const { repo, before } = polyglot();
    const after = repo.commit('lib', { 'libs/golib/lib.go': 'package lib // v2' });
    expect(push(repo, before, after).json('affected')).toEqual(['libs/golib', 'services/api']);
  });

  it('a Dockerfile-only change rebuilds that image', () => {
    const { repo, before } = polyglot();
    const after = repo.commit('df', { 'deploy/proxy/Dockerfile': 'FROM nginx:2' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual(['deploy/proxy']);
    expect(r.json('docker')).toEqual(['deploy/proxy']);
    expect(r.json('dockerfiles')).toEqual({ 'deploy/proxy': 'deploy/proxy/Dockerfile' });
  });

  it('a root lockfile change selects every project of that ecosystem only', () => {
    const { repo, before } = polyglot();
    const after = repo.commit('lock', { 'yarn.lock': '# lock v2' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual(['@acme/shared', '@acme/web']);
    expect(r.outputs['all']).toBe('false');
    expect(r.stdout).toContain('yarn.lock changes select every node project (2)');
  });

  it('CI config and other root files select nothing, and are listed', () => {
    const { repo, before } = polyglot();
    const after = repo.commit('ci', { '.github/workflows/ci.yml': 'on: [push]' });
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect(r.json('affected')).toEqual([]);
    expect(r.outputs['has_changes']).toBe('false');
    expect(r.plan.files.unowned).toEqual(['.github/workflows/ci.yml']);
  });

  it('a new project is reported as added (base commit is detected too)', () => {
    const { repo, before } = polyglot();
    const after = repo.commit('new', { 'services/worker/pyproject.toml': '[project]\nname = "worker"\n', 'services/worker/main.py': '' });
    const r = push(repo, before, after);
    expect(r.json('added')).toEqual(['services/worker']);
    expect(r.json('affected')).toEqual(['services/worker']);
  });

  it('nested projects: the deepest marker owns the file', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      'apps/web/package.json': pkg('web'),
      'apps/web/e2e/package.json': pkg('web-e2e'),
      'apps/web/src/a.ts': '1',
      'apps/web/e2e/a.spec.ts': '1',
    });
    const after = repo.commit('e2e', { 'apps/web/e2e/a.spec.ts': '2' });
    expect(push(repo, before, after).json('affected')).toEqual(['web-e2e']);
  });

  it('skips dependency, build, fixture and dot directories, and untracked files', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      'svc/go.mod': 'module example.com/svc\n',
      'node_modules/left-pad/package.json': pkg('left-pad'),
      'dist/package.json': pkg('dist'),
      'tests/fixtures/app/package.json': pkg('fixture'),
      '.devcontainer/Dockerfile': 'FROM x',
    });
    const after = repo.commit('x', { 'svc/main.go': 'package main' });
    repo.write({ 'untracked/package.json': pkg('untracked') });
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect([...r.json('affected'), ...r.json('skipped')]).toEqual(['svc']);
  });

  it('cargo: a bare workspace root is not a project; path dependencies are edges', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'Cargo.lock': '',
      'crates/core/Cargo.toml': '[package]\nname = "core"\n',
      'crates/cli/Cargo.toml': '[package]\nname = "cli"\n\n[dependencies]\ncore = { path = "../core" }\n',
    });
    const after = repo.commit('core', { 'crates/core/src/lib.rs': '' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual(['core', 'cli']);
    expect(r.json('skipped')).toEqual([]);
  });

  it('a repository with no marker files fails with a clear message', () => {
    const repo = new Repo();
    repo.commit('init', { 'notes.txt': '1' });
    const r = runAction(repo);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::error.*no projects found\. Auto-detection looks for package\.json, go\.mod/);
  });

  it('no comparison base still selects every detected project', () => {
    const { repo } = polyglot();
    const r = runAction(repo, { event: 'workflow_dispatch' });
    expect(r.outputs['all']).toBe('true');
    expect(r.json('affected')).toHaveLength(5);
  });
});

describe('auto-detection with a config file', () => {
  it('is off unless "detect": true; explicit projects override detected ones', () => {
    const { repo, before } = polyglot();
    const cfg = JSON.stringify({ detect: true, projects: { '@acme/web': { path: 'apps/web', targets: ['build'] } } });
    const mid = repo.commit('cfg', { [CONFIG]: cfg });
    const after = repo.commit('shared', { 'packages/shared/index.ts': 'export const b = 1' });
    const r = push(repo, mid, after);
    expect(r.json('affected')).toEqual(['@acme/shared', '@acme/web']);
    expect(r.json('docker')).toEqual([]);
    expect(r.json('build')).toEqual(['@acme/shared', '@acme/web']);
    // Adding a config that keeps the detected graph does not select everything.
    const r2 = push(repo, before, mid);
    expect(r2.outputs['all']).toBe('false');
  });

  it('a config file without "detect" ignores marker files', () => {
    const { repo } = polyglot();
    const before = repo.commit('cfg', { [CONFIG]: JSON.stringify({ projects: { api: { path: 'services/api' } } }) });
    const after = repo.commit('web', { 'apps/web/index.ts': 'y' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual([]);
    expect(r.json('skipped')).toEqual(['api']);
  });
});

describe('README quick start', () => {
  it('is valid YAML and only uses outputs the action declares', async () => {
    const { readFileSync } = await import('node:fs');
    const { load } = await import('js-yaml');
    const root = resolve(import.meta.dirname, '..');
    const declared = Object.keys((load(readFileSync(resolve(root, 'action.yml'), 'utf8')) as any).outputs);
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const workflow = /```yaml\n(name: CI[\s\S]*?)```/.exec(readme)![1]!;
    const doc = load(workflow) as any;
    const planOutputs = Object.keys(doc.jobs.plan.outputs);
    for (const [, name] of workflow.matchAll(/steps\.plan\.outputs\.(\w+)/g)) expect(declared).toContain(name);
    for (const [, name] of workflow.matchAll(/needs\.plan\.outputs\.(\w+)/g)) expect(planOutputs).toContain(name);
  });
});

describe('CLI: projects', () => {
  it('lists detected projects in dependency order with targets', () => {
    const { repo } = polyglot();
    const r = spawnSync(process.execPath, [CLI, 'projects'], { cwd: repo.dir, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Configuration: none (no dynamic-monorepo.config.json)');
    expect(r.stdout).toMatch(/@acme\/web\s+apps\/web\s+\[build, test, deploy, docker\]\s+depends on: @acme\/shared/);
    const json = JSON.parse(spawnSync(process.execPath, [CLI, 'projects', '--json'], { cwd: repo.dir, encoding: 'utf8' }).stdout);
    expect(json.map((p: { name: string }) => p.name)).toEqual(['@acme/shared', '@acme/web', 'deploy/proxy', 'libs/golib', 'services/api']);
  });

  it('rejects unknown commands', () => {
    const { repo } = polyglot();
    const r = spawnSync(process.execPath, [CLI, 'nope'], { cwd: repo.dir, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown command "nope"');
  });
});
