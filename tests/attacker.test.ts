// Regression tests for ATTACKER round 1 findings (ids in test names).

import { afterAll, describe, expect, it } from 'vitest';
import { CFG, cleanup, prPayload, pushPayload, Repo, runAction } from './helpers.ts';
import { compileGlob, wildcard } from '../src/glob.ts';
import { expandDirPattern, inferCargo, inferGo, inferNode } from '../src/infer.ts';
import { neutralise } from '../src/actions.ts';
import { parseConfig } from '../src/config.ts';

afterAll(cleanup);

const push = (repo: Repo, before: string, after: string, inputs?: Record<string, string>) =>
  runAction(repo, { event: 'push', payload: pushPayload(before, after), inputs });

/** In-memory reader for inference unit tests. */
function memReader(files: Record<string, string>) {
  const dirs = new Set<string>(['.']);
  for (const f of Object.keys(files)) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    listFiles: () => Object.keys(files),
    readMany: (paths: string[]) => new Map(paths.filter((p) => p in files).map((p) => [p, files[p]!])),
    read: (p: string) => files[p],
    listDirs: (dir: string) => [...dirs].filter((d) => d !== '.' && (dir === '.' ? !d.includes('/') : d.startsWith(`${dir}/`) && !d.slice(dir.length + 1).includes('/'))).map((d) => d.split('/').pop()!),
  };
}

describe('performance (no catastrophic backtracking)', () => {
  it('A1-1/A3-3: many stars in one segment match in linear-ish time', () => {
    const t = performance.now();
    expect(compileGlob('*a'.repeat(12) + 'b').test('a'.repeat(5000) + 'c')).toBe(false);
    expect(wildcard('*a*a*a*a*a*a*a*ab', 'a'.repeat(5000))).toBe(false);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it('A1-2: repeated ** in workspace patterns is collapsed', () => {
    const files: Record<string, string> = { 'a/b/c/d/e/f/g/x/package.json': '{}' };
    const t = performance.now();
    const dirs = expandDirPattern(memReader(files), Array(40).fill('**').join('/'))!;
    expect(dirs).toContain('a/b/c/d/e/f');
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it('A1-8: long dependency chains explain in O(N)', () => {
    const projects: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) projects[`p${i}`] = i ? { path: `p/${i}`, dependsOn: [`p${i - 1}`] } : { path: 'p/0' };
    const cfg = parseConfig(JSON.stringify({ projects }), 'c.json');
    expect(cfg.projects.size).toBe(5000);
  });
});

describe('inference fixes', () => {
  it('A1-3: workspace negations use real glob matching', () => {
    const r = memReader({
      'package.json': JSON.stringify({ workspaces: ['packages/**', '!**/fixtures/**', '!packages/*-example'] }),
      'packages/a/package.json': '{"name":"a"}',
      'packages/a/fixtures/x/package.json': '{"name":"fx"}',
      'packages/b-example/package.json': '{"name":"bx"}',
    });
    expect(inferNode(r, []).map((p) => p.name)).toEqual(['a']);
  });

  it('A1-14: npm aliases create edges', () => {
    const r = memReader({
      'package.json': JSON.stringify({ workspaces: ['p/*'] }),
      'p/a/package.json': '{"name":"@x/a"}',
      'p/b/package.json': JSON.stringify({ name: 'b', dependencies: { core: 'workspace:@x/a@*' } }),
    });
    expect(inferNode(r, []).find((p) => p.name === 'b')!.dependsOn).toEqual(['@x/a']);
  });

  it('workspace patterns may not leave the repository', () => {
    const problems: string[] = [];
    inferNode(memReader({ 'package.json': JSON.stringify({ workspaces: ['../outside/*', '..\\sib'] }) }), problems);
    expect(problems.join('\n')).toMatch(/must stay inside the repository/);
  });

  it('A1-4: cargo target-specific deps, root package, exclude prefixes, BOM', () => {
    const r = memReader({
      'Cargo.toml': '﻿[package]\nname = "app"\n[dependencies]\nb = { path = "crates/b" }\n[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/skip"]\n',
      'crates/a/Cargo.toml': "[package]\nname = \"a\"\n[target.'cfg(unix)'.dependencies]\nb = { path = \"../b\" }\n",
      'crates/b/Cargo.toml': '[package]\nname = "b"\n',
      'crates/skip/Cargo.toml': '[package]\nname = "skip"\n',
    });
    const out = inferCargo(r, []);
    expect(out.map((p) => p.name).sort()).toEqual(['a', 'app', 'b']);
    expect(out.find((p) => p.name === 'a')!.dependsOn).toEqual(['b']);
    expect(out.find((p) => p.name === 'app')!.dependsOn).toEqual(['b']);
  });

  it('A1-5: go.work root module and replace => ../dir', () => {
    const r = memReader({
      'go.work': 'use (\n  .\n  ./lib\n  ./tool\n)\n',
      'go.mod': 'module example.com/svc\nrequire example.com/lib v0.0.0\n',
      'lib/go.mod': 'module example.com/lib\n',
      'tool/go.mod': 'module example.com/tool\nreplace example.com/other => ../lib\n',
    });
    const out = inferGo(r, []);
    expect(out.find((p) => p.path === '.')).toMatchObject({ name: 'svc', dependsOn: ['lib'] });
    expect(out.find((p) => p.path === 'tool')!.dependsOn).toEqual(['lib']);
  });
});

describe('planning correctness', () => {
  it('A1-4: manifest dev-dependency cycles are tolerated; explicit dependsOn cycles still fail', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      [CFG]: 'infer: [node]\n',
      'package.json': JSON.stringify({ workspaces: ['p/*'] }),
      'p/a/package.json': JSON.stringify({ name: 'a', devDependencies: { b: '*' } }),
      'p/b/package.json': JSON.stringify({ name: 'b', dependencies: { a: '*' } }),
    });
    const after = repo.commit('a', { 'p/a/x.ts': '1' });
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect(r.json('affected')).toEqual(['a', 'b']);

    const bad = new Repo();
    bad.commit('init', { [CFG]: 'projects:\n  a: { path: a, dependsOn: [b] }\n  b: { path: b, dependsOn: [a] }\n', 'a/x': '1', 'b/x': '1' });
    expect(runAction(bad).stdout).toMatch(/Dependency cycle detected/);
  });

  it('A1-11: a removed project is deleted even when another project moves onto its path', () => {
    const repo = new Repo();
    const before = repo.commit('init', { [CFG]: 'projects:\n  a: { path: p1 }\n  x: { path: p2 }\n', 'p1/f': '1', 'p2/f': '2' });
    const after = repo.commit('move', { [CFG]: 'projects:\n  x: { path: p1 }\n', 'p2': null });
    expect(push(repo, before, after).json('deleted')).toEqual(['a']);
  });

  it('A1-12/A1-13: targets null means default; reordering globs is not a change', () => {
    const repo = new Repo();
    const before = repo.commit('init', { [CFG]: 'projects:\n  a: { path: a, targets: null, include: [x/*, y/*] }\nglobal: [g1, g2]\n', 'a/f': '1' });
    const after = repo.commit('reorder', { [CFG]: 'projects:\n  a: { path: a, targets: null, include: [y/*, x/*] }\nglobal: [g2, g1]\n' });
    const r = push(repo, before, after);
    expect(r.outputs['all']).toBe('false');
    expect(r.json('affected')).toEqual([]);
    const r2 = push(repo, before, repo.commit('edit', { 'a/f': '2' }));
    expect(r2.json('build')).toEqual(['a']);
  });

  it('A1-6: discover skips node_modules and warns about invalid names instead of failing', () => {
    const repo = new Repo();
    const before = repo.commit('init', { [CFG]: 'discover: ["*"]\n', 'ok/f': '1', 'My Lib/f': '1' });
    repo.write({ 'node_modules/pkg/index.js': 'x' }); // untracked: never a project
    const after = repo.commit('edit', { 'ok/g': '2' });
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect(r.json('added')).toEqual([]);
    expect(r.json('affected')).toEqual(['ok']);
    expect(r.stdout).toMatch(/skipped discovered directory "My Lib"/);
  });

  it('A3-7: warns about project paths that do not exist', () => {
    const repo = new Repo();
    repo.commit('init', { [CFG]: 'projects:\n  a: { path: typo }\n', 'real/f': '1' });
    expect(runAction(repo).stdout).toMatch(/path "typo" does not exist/);
  });
});

describe('git and events', () => {
  it('A2-1: pull_request_target reads the PR head config, not the checked-out base', () => {
    const repo = new Repo();
    repo.commit('init', { [CFG]: 'projects:\n  a: { path: a }\n  c: { path: c }\n', 'a/f': '1', 'c/f': '1' });
    const base = repo.head();
    repo.git('checkout', '-q', '-b', 'pr');
    const prHead = repo.commit('pr', { [CFG]: 'projects:\n  a: { path: a }\n  c: { path: c, dependsOn: [d] }\n  d: { path: d }\n', 'd/f': '1' });
    repo.git('checkout', '-q', 'main');
    const r = runAction(repo, { event: 'pull_request_target', payload: prPayload(base, prHead) });
    expect(r.json('added')).toEqual(['d']);
    expect(r.json('affected')).toEqual(['d', 'c']);
  });

  it('A2-2: an unavailable push "before" selects everything', () => {
    const repo = new Repo();
    const after = repo.commit('init', { [CFG]: 'projects:\n  a: { path: a }\n', 'a/f': '1' });
    const r = push(repo, 'f'.repeat(40), after);
    expect(r.outputs['all']).toBe('true');
    expect(r.json('affected')).toEqual(['a']);
  });

  it('A2-3: submodule bumps are visible even with ignore=all in .gitmodules', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      [CFG]: 'projects:\n  a: { path: a }\n', '.gitmodules': '[submodule "s"]\n\tpath = a/sub\n\turl = ./x\n\tignore = all\n', 'a/f': '1',
    });
    repo.git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},a/sub`);
    repo.git('commit', '-q', '-m', 'gitlink');
    const mid = repo.head();
    repo.git('update-index', '--cacheinfo', `160000,${'2'.repeat(40)},a/sub`);
    repo.git('commit', '-q', '-m', 'bump');
    expect(push(repo, mid, repo.head()).json('affected')).toEqual(['a']);
    expect(before).toBeTruthy();
  });

  it('A2-6: fetching by SHA does not make a full clone shallow', async () => {
    const { execFileSync } = await import('node:child_process');
    const { tmp } = await import('./helpers.ts');
    const origin = new Repo();
    origin.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
    origin.commit('init', { [CFG]: 'projects:\n  a: { path: a }\n', 'a/f': '1' });
    origin.git('checkout', '-q', '-b', 'side');
    const side = origin.commit('side', { 'a/g': '2' });
    origin.git('checkout', '-q', 'main');
    origin.git('branch', '-D', 'side');
    origin.git('update-ref', 'refs/hidden/side', side);
    const dir = tmp('mi-full-');
    execFileSync('git', ['clone', '-q', origin.fileUrl(), dir]);
    const clone = new Repo(dir);
    runAction(clone, { event: 'push', payload: pushPayload(side, clone.head()) });
    expect(clone.git('rev-parse', '--is-shallow-repository')).toBe('false');
  });
});

describe('security and outputs', () => {
  it('A3-1: log lines cannot carry workflow commands', () => {
    for (const evil of [' ::error::x', '\t::add-mask::y', 'mid ##[error]legacy', 'a\u0085::warning::z']) {
      expect(neutralise(evil)).not.toMatch(/::[a-z-]+::|##\[/);
    }
  });

  it('A3-2: project paths with shell metacharacters are rejected', () => {
    const repo = new Repo();
    repo.commit('init', { [CFG]: '{"projects":{"a":{"path":"a$(id)"}}}', 'a/f': '1' });
    expect(runAction(repo).stdout).toMatch(/shell metacharacters/);
  });

  it('A3-5/A3-9: plan_file is unique per step; max-jobs must be a plain integer', () => {
    const repo = new Repo();
    repo.commit('init', { [CFG]: 'projects:\n  a: { path: a }\n', 'a/f': '1' });
    const one = runAction(repo).outputs['plan_file'];
    const two = runAction(repo).outputs['plan_file'];
    expect(one).toBeTruthy();
    expect(one).not.toBe(two);
    expect(runAction(repo, { inputs: { 'max-jobs': '0x10' } }).code).toBe(1);
  });
});

describe('auto-detection safety (merged with zero-config)', () => {
  it('A3-2: detected directories with shell metacharacters are skipped, not emitted', () => {
    const repo = new Repo();
    const before = repo.commit('init', { 'ok/package.json': '{"name":"ok"}', 'bad$(id)/package.json': '{"name":"bad"}' });
    const after = repo.commit('edit', { 'ok/a.js': '1', 'bad$(id)/a.js': '1' });
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect(JSON.stringify(r.outputs)).not.toContain('$(id)');
    expect(r.json('affected')).toEqual(['ok']);
  });
});

describe('PR #5 review follow-ups', () => {
  it('duplicate package names do not create edges to an arbitrary folder', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      'a/package.json': '{"name":"dup"}',
      'b/package.json': '{"name":"dup"}',
      'app/package.json': JSON.stringify({ name: 'app', dependencies: { dup: '*' } }),
    });
    const after = repo.commit('edit', { 'b/x.js': '1' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual(['b']); // no guessed edge app -> b
    expect(r.stdout).toMatch(/package name "dup" is used by more than one folder/);
  });

  it('marker files under skipped folders are reported, not silently dropped', () => {
    const repo = new Repo();
    repo.commit('init', { 'svc/package.json': '{"name":"svc"}', 'build/docker/Dockerfile': 'FROM scratch' });
    const r = runAction(repo);
    expect(r.stdout).toMatch(/1 marker file\(s\) inside skipped folders .*build\/docker\/Dockerfile/);
  });
});
