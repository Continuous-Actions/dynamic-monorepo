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

  it('pnpm: the root package.json is not a project when pnpm-workspace.yaml exists', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      'package.json': JSON.stringify({ name: 'monorepo', private: true }),
      'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n",
      'pnpm-lock.yaml': '',
      'libs/a/package.json': pkg('a'),
      'libs/b/package.json': pkg('b', { a: 'workspace:^' }),
    });
    const after = repo.commit('lock', { 'pnpm-lock.yaml': 'v2', 'scripts/x.sh': 'echo' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual(['a', 'b']);
    expect(r.json('skipped')).toEqual([]);
    expect(r.plan.files.unowned).toEqual(['scripts/x.sh']);
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

describe('Go modules with several binaries', () => {
  it('splits into package projects linked by imports', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      'go.mod': 'module example.com/app\n\ngo 1.23\n',
      'go.sum': '',
      'cmd/admin/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/app/internal/auth"\n)\n\nfunc main() { fmt.Println(auth.X) }\n',
      'cmd/chat/main.go': 'package main\n\nimport "example.com/app/internal/store"\n\nfunc main() { _ = store.Y }\n',
      'internal/auth/auth.go': 'package auth\n\nimport "example.com/app/internal/store"\n\nvar X = store.Y\n',
      'internal/store/store.go': '// Package store\npackage store\n\nvar Y = 1\n',
      'internal/util/util.go': 'package util\n',
      'deploy/admin/Dockerfile': 'FROM scratch\n',
    });
    const store = repo.commit('store', { 'internal/store/store.go': 'package store\n\nvar Y = 2\n' });
    const r = runAction(repo, { event: 'push', payload: { ref: 'refs/heads/main', before, after: store, repository: { default_branch: 'main' } } });
    expect(r.code).toBe(0);
    expect(r.json('affected')).toEqual(['internal/store', 'cmd/chat', 'internal/auth', 'cmd/admin']);
    expect(r.json('build')).toEqual(['cmd/chat', 'cmd/admin']);
    expect(r.json('test')).toEqual(['internal/store', 'cmd/chat', 'internal/auth', 'cmd/admin']);

    const util = repo.commit('util', { 'internal/util/util.go': 'package util\n\nvar Z = 1\n' });
    const r2 = runAction(repo, { event: 'push', payload: { ref: 'refs/heads/main', before: store, after: util, repository: { default_branch: 'main' } } });
    expect(r2.json('affected')).toEqual(['internal/util']);
    expect(r2.json('build')).toEqual([]);

    const bump = repo.commit('bump', { 'go.sum': 'example.com/x v1.0.0 h1:abc\n' });
    const r3 = runAction(repo, { event: 'push', payload: { ref: 'refs/heads/main', before: util, after: bump, repository: { default_branch: 'main' } } });
    expect(r3.json('build')).toEqual(['cmd/chat', 'cmd/admin']);
  });

  it('ignores external test packages that import their own package (no false cycle)', () => {
    const repo = new Repo();
    repo.commit('init', {
      'go.mod': 'module example.com/app\n',
      'cmd/a/main.go': 'package main\n\nimport "example.com/app/lib"\n\nfunc main() { lib.F() }\n',
      'cmd/b/main.go': 'package main\n\nfunc main() {}\n',
      'lib/lib.go': 'package lib\n\nfunc F() {}\n',
      'lib/lib_ext_test.go': 'package lib_test\n\nimport (\n\t"testing"\n\t"example.com/app/lib"\n\t"example.com/app/cmd/a"\n)\n\nfunc TestF(t *testing.T) { lib.F(); _ = a.X }\n',
    });
    const r = runAction(repo);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/cycle/i);
    expect(r.json('build').sort()).toEqual(['cmd/a', 'cmd/b']);
  });

  it('keeps a single-binary module as one project', () => {
    const repo = new Repo();
    repo.commit('init', { 'svc/go.mod': 'module example.com/svc\n', 'svc/main.go': 'package main\nfunc main(){}\n', 'svc/lib/lib.go': 'package lib\n' });
    const r = runAction(repo);
    expect(r.json('build')).toEqual(['svc']);
  });
});

describe('workspace membership', () => {
  it('packages outside the workspace globs are not linked to local packages by name', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      'packages/ui/package.json': '{"name":"ui"}',
      'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { ui: 'workspace:*' } }),
      'examples/demo/package.json': JSON.stringify({ name: 'demo', dependencies: { ui: '^1.0.0' } }),
    });
    const after = repo.commit('ui', { 'packages/ui/x.js': '1' });
    const r = runAction(repo, { event: 'push', payload: { ref: 'refs/heads/main', before, after, repository: { default_branch: 'main' } } });
    expect(r.json('affected')).toEqual(['ui', 'app']);
  });
});

describe('Python path dependencies', () => {
  it('links uv sources and Poetry path dependencies', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      'packages/devutils/pyproject.toml': '[project]\nname = "devutils"\n',
      'packages/core/pyproject.toml': '[project]\nname = "core"\n\n[tool.uv.sources]\ndevutils = { path = "../devutils/", editable = true }\n',
      'packages/web/pyproject.toml': '[tool.poetry]\nname = "web"\n\n[tool.poetry.group.dev.dependencies]\ncore = { path = "../core", develop = true }\n',
      'packages/other/pyproject.toml': '[project]\nname = "other"\n',
    });
    const after = repo.commit('devutils', { 'packages/devutils/x.py': 'x = 1\n' });
    const r = runAction(repo, { event: 'push', payload: { ref: 'refs/heads/main', before, after, repository: { default_branch: 'main' } } });
    expect(r.json('affected')).toEqual(['packages/devutils', 'packages/core', 'packages/web']);
  });
});

describe('Maven and Gradle edges', () => {
  it('links Maven modules to their parent and sibling artifacts; aggregator poms build nothing', () => {
    const repo = new Repo();
    const pom = (a: string, extra = '') => `<project><parent><groupId>g</groupId><artifactId>parent</artifactId></parent><artifactId>${a}</artifactId>${extra}</project>`;
    const before = repo.commit('init', {
      'pom.xml': '<project><groupId>g</groupId><artifactId>parent</artifactId><packaging>pom</packaging><modules><module>core</module><module>api</module><module>web</module></modules><dependencyManagement><dependencies><dependency><artifactId>web</artifactId></dependency></dependencies></dependencyManagement></project>',
      'core/pom.xml': pom('core'),
      'api/pom.xml': pom('api', '<dependencies><dependency><groupId>g</groupId><artifactId>core</artifactId></dependency></dependencies>'),
      'web/pom.xml': pom('web'),
    });
    const after = repo.commit('core', { 'core/src/A.java': 'class A {}' });
    const r = runAction(repo, { event: 'push', payload: { ref: 'refs/heads/main', before, after, repository: { default_branch: 'main' } } });
    expect(r.json('affected')).toEqual(['core', 'api']);
    const after2 = repo.commit('parent', { 'pom.xml': '<project><groupId>g</groupId><artifactId>parent</artifactId><packaging>pom</packaging><version>2</version></project>' });
    const r2 = runAction(repo, { event: 'push', payload: { ref: 'refs/heads/main', before: after, after: after2, repository: { default_branch: 'main' } } });
    expect(r2.json('build').sort()).toEqual(['api', 'core', 'web']);
    expect(r2.json('build')).not.toContain('root');
  });

  it('links Gradle projects via project(":path")', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      'settings.gradle': "include 'libs:core', 'app'",
      'libs/core/build.gradle': 'plugins { id "java" }',
      'app/build.gradle': "dependencies { implementation project(':libs:core') }",
    });
    const after = repo.commit('core', { 'libs/core/src/A.java': 'class A {}' });
    const r = runAction(repo, { event: 'push', payload: { ref: 'refs/heads/main', before, after, repository: { default_branch: 'main' } } });
    expect(r.json('affected')).toEqual(['libs/core', 'app']);
  });
});
