import { afterAll, describe, expect, it } from 'vitest';
import { CFG, CONFIG, cleanup, prPayload, pushPayload, Repo, runAction, smallRepo, SMALL_CONFIG, tmp } from './helpers.ts';
import { execFileSync } from 'node:child_process';

afterAll(cleanup);

const push = (repo: Repo, before: string, after: string) => runAction(repo, { event: 'push', payload: pushPayload(before, after) });

describe('dependency propagation (push)', () => {
  it('shared change affects shared, api and web in dependency order', () => {
    const repo = smallRepo();
    const before = repo.head();
    const after = repo.commit('shared', { 'libs/shared/index.ts': 'export const a = 2;' });
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect(r.json('changed')).toEqual(['shared']);
    expect(r.json('affected')).toEqual(['shared', 'api', 'web']);
    expect(r.json('build')).toEqual(['shared', 'api', 'web']);
    expect(r.json('deploy')).toEqual(['api', 'web']);
    expect(r.json('paths')).toEqual({ shared: 'libs/shared', api: 'services/api', web: 'apps/web' });
    expect(r.outputs['has_changes']).toBe('true');
    expect(r.outputs['all']).toBe('false');
    expect(r.outputs['base']).toBe(before);
    expect(r.outputs['head']).toBe(after);
    expect(r.plan.reasons.web).toEqual({ kind: 'dependency', chain: ['shared', 'api', 'web'] });
    expect(r.summary).toContain('shared → api → web');
  });

  it('api change affects api and web only', () => {
    const repo = smallRepo();
    const before = repo.head();
    const after = repo.commit('api', { 'services/api/index.ts': 'x' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual(['api', 'web']);
    expect(r.json('skipped')).toEqual(['shared']);
  });

  it('leaf change affects only the leaf', () => {
    const repo = smallRepo();
    const before = repo.head();
    const after = repo.commit('web', { 'apps/web/index.ts': 'x' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual(['web']);
    expect(r.json('test')).toEqual(['web']);
  });

  it('no changes produces empty arrays and false flags', () => {
    const repo = smallRepo();
    const before = repo.head();
    const after = repo.commit('empty');
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual([]);
    expect(r.json('build')).toEqual([]);
    expect(r.outputs['has_changes']).toBe('false');
    expect(r.outputs['has_build']).toBe('false');
  });

  it('ignored files and root files outside projects affect nothing', () => {
    const repo = smallRepo();
    const before = repo.head();
    const after = repo.commit('docs', { 'apps/web/README.md': 'docs', 'Makefile': 'all:' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual([]);
    expect(r.plan.files.unowned).toEqual(['Makefile']);
    expect(r.plan.files.ignored).toBe(1);
  });

  it('a global file selects every project with a reason', () => {
    const repo = smallRepo();
    const before = repo.head();
    const after = repo.commit('lock', { 'package-lock.json': '{"x":1}' });
    const r = push(repo, before, after);
    expect(r.outputs['all']).toBe('true');
    expect(r.json('affected')).toEqual(['shared', 'api', 'web']);
    expect(r.outputs['reason']).toContain('package-lock.json');
  });

  it('deleting and renaming files is attributed to old and new owners', () => {
    const repo = smallRepo();
    repo.commit('more', { 'libs/shared/util.ts': 'export const u = 1;\n'.repeat(20) });
    const before = repo.head();
    repo.git('mv', 'libs/shared/util.ts', 'apps/web/util.ts');
    const after = repo.commit('move');
    const r = push(repo, before, after);
    expect(r.json('changed')).toEqual(['shared', 'web']);
    expect(r.json('affected')).toEqual(['shared', 'api', 'web']);

    const after2 = repo.commit('delete', { 'apps/web/util.ts': null });
    expect(push(repo, after, after2).json('affected')).toEqual(['web']);
  });

  it('handles file names with spaces and unicode', () => {
    const repo = smallRepo();
    const before = repo.head();
    const after = repo.commit('unicode', { 'services/api/sübdir/my file ✓.ts': 'x' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual(['api', 'web']);
    expect(r.plan.reasons.api.files).toEqual(['services/api/sübdir/my file ✓.ts']);
  });

  it('force push diffs the old and new branch tips', () => {
    const repo = smallRepo();
    const root = repo.head();
    const old = repo.commit('old', { 'apps/web/a.ts': 'x' });
    repo.git('reset', '-q', '--hard', root);
    const rewritten = repo.commit('new', { 'libs/shared/b.ts': 'y' });
    const r = runAction(repo, { event: 'push', payload: pushPayload(old, rewritten, { forced: true }) });
    // web's file disappeared and shared gained one: both are real changes vs the old tip.
    expect(r.json('changed')).toEqual(['shared', 'web']);
  });

  it('new branch push (before = 000...) compares with the default branch', () => {
    const repo = smallRepo();
    repo.git('checkout', '-q', '-b', 'feature');
    const after = repo.commit('feat', { 'services/api/x.ts': 'x' });
    const r = runAction(repo, {
      event: 'push',
      payload: { ref: 'refs/heads/feature', before: '0'.repeat(40), after, created: true, repository: { default_branch: 'main' } },
    });
    expect(r.json('affected')).toEqual(['api', 'web']);
    expect(r.stdout).toContain('default branch');
  });

  it('tag pushes select all projects', () => {
    const repo = smallRepo();
    const r = runAction(repo, { event: 'push', payload: { ref: 'refs/tags/v1.0.0', before: '0'.repeat(40), after: repo.head() } });
    expect(r.outputs['all']).toBe('true');
  });
});

describe('pull requests', () => {
  it('uses the test-merge commit first parent, ignoring unrelated base-branch progress', () => {
    const repo = smallRepo();
    const fork = repo.head();
    repo.git('checkout', '-q', '-b', 'feature');
    const prHead = repo.commit('pr', { 'services/api/pr.ts': 'x' });
    repo.git('checkout', '-q', 'main');
    const mainTip = repo.commit('main moved', { 'libs/shared/main.ts': 'x' }); // not part of the PR
    const merge = repo.testMerge(mainTip, prHead);
    const r = runAction(repo, { event: 'pull_request', payload: prPayload(fork, prHead) });
    expect(r.code).toBe(0);
    expect(r.json('affected')).toEqual(['api', 'web']);
    expect(r.outputs['base']).toBe(mainTip);
    expect(r.outputs['head']).toBe(merge);
  });

  it('falls back to merge-base when the PR head itself is checked out', () => {
    const repo = smallRepo();
    repo.git('checkout', '-q', '-b', 'feature');
    const prHead = repo.commit('pr', { 'apps/web/pr.ts': 'x' });
    repo.git('checkout', '-q', 'main');
    const mainTip = repo.commit('main moved', { 'libs/shared/main.ts': 'x' });
    repo.git('checkout', '-q', prHead);
    const r = runAction(repo, { event: 'pull_request', payload: prPayload(mainTip, prHead) });
    expect(r.json('affected')).toEqual(['web']);
  });

  it('pull_request_target (base branch checked out) still diffs the PR', () => {
    const repo = smallRepo();
    repo.git('checkout', '-q', '-b', 'feature');
    const prHead = repo.commit('pr', { 'libs/shared/pr.ts': 'x' });
    repo.git('checkout', '-q', 'main');
    const r = runAction(repo, { event: 'pull_request_target', payload: prPayload(repo.head(), prHead) });
    expect(r.json('affected')).toEqual(['shared', 'api', 'web']);
  });
});

describe('shallow clones', () => {
  function shallowPr(fetchDepth: number) {
    const origin = smallRepo();
    const fork = origin.head();
    for (let i = 0; i < 5; i++) origin.commit(`main ${i}`, { [`libs/shared/m${i}.ts`]: 'x' });
    origin.git('checkout', '-q', '-b', 'feature', fork);
    for (let i = 0; i < 5; i++) origin.commit(`pr ${i}`, { [`apps/web/p${i}.ts`]: 'x' });
    const prHead = origin.head();
    origin.git('checkout', '-q', 'main');
    const baseTip = origin.head();
    origin.git('update-ref', 'refs/pull/1/head', prHead);
    // Clone shallowly and check out the PR head only (no merge commit) to force merge-base work.
    const dir = tmp('mi-clone-');
    execFileSync('git', ['clone', '-q', `--depth=${fetchDepth}`, '--no-single-branch', origin.fileUrl(), dir]);
    const clone = new Repo(dir);
    clone.git('fetch', '-q', `--depth=${fetchDepth}`, 'origin', prHead);
    clone.git('checkout', '-q', '--detach', prHead);
    return { clone, baseTip, prHead };
  }

  it('fetches missing history to compute the merge-base', () => {
    const { clone, baseTip, prHead } = shallowPr(1);
    expect(clone.git('rev-parse', '--is-shallow-repository')).toBe('true');
    const r = runAction(clone, { event: 'pull_request', payload: prPayload(baseTip, prHead) });
    expect(r.code).toBe(0);
    expect(r.json('affected')).toEqual(['web']);
    expect(r.outputs['all']).toBe('false');
  });

  it('with fetch disabled, selects ALL with a warning instead of a wrong answer', () => {
    const { clone, baseTip, prHead } = shallowPr(1);
    const r = runAction(clone, { event: 'pull_request', payload: prPayload(baseTip, prHead), inputs: { fetch: 'false' } });
    expect(r.code).toBe(0);
    expect(r.outputs['all']).toBe('true');
    expect(r.stdout).toContain('::warning');
  });

  it('push with depth 1 fetches the "before" commit by SHA', () => {
    const origin = smallRepo();
    const before = origin.head();
    const after = origin.commit('api', { 'services/api/z.ts': 'x' });
    const dir = tmp('mi-clone-');
    execFileSync('git', ['clone', '-q', '--depth=1', origin.fileUrl(), dir]);
    const clone = new Repo(dir);
    expect(() => clone.git('cat-file', '-e', before)).toThrow();
    const r = runAction(clone, { event: 'push', payload: pushPayload(before, after) });
    expect(r.json('affected')).toEqual(['api', 'web']);
  });
});

describe('events without a base', () => {
  it('workflow_dispatch selects all projects and explains why', () => {
    const repo = smallRepo();
    const r = runAction(repo, { event: 'workflow_dispatch' });
    expect(r.outputs['all']).toBe('true');
    expect(r.json('build')).toEqual(['shared', 'api', 'web']);
    expect(r.outputs['reason']).toContain('workflow_dispatch');
  });

  it('the base input enables diffing for any event', () => {
    const repo = smallRepo();
    const base = repo.head();
    repo.commit('web', { 'apps/web/q.ts': 'x' });
    const r = runAction(repo, { event: 'schedule', inputs: { base } });
    expect(r.json('affected')).toEqual(['web']);
  });

  it('merge_group compares base_sha..head_sha', () => {
    const repo = smallRepo();
    const base = repo.head();
    const head = repo.commit('q', { 'libs/shared/q.ts': 'x' });
    const r = runAction(repo, { event: 'merge_group', payload: { merge_group: { base_sha: base, head_sha: head } } });
    expect(r.json('affected')).toEqual(['shared', 'api', 'web']);
  });
});

describe('configuration changes', () => {
  it('detects added, deleted, renamed and redefined projects', () => {
    const repo = new Repo();
    repo.commit('init', {
      [CFG]: `projects:
  a: { path: pkgs/a }
  b: { path: pkgs/b, dependsOn: [a] }
  old: { path: pkgs/old }
  legacy: { path: pkgs/legacy }
  c: { path: pkgs/c }
  d: { path: pkgs/d, dependsOn: [c] }
`,
      'pkgs/a/x': '1', 'pkgs/b/x': '1', 'pkgs/old/x': '1', 'pkgs/legacy/x': '1', 'pkgs/c/x': '1', 'pkgs/d/x': '1',
    });
    const before = repo.head();
    const after = repo.commit('reshape', {
      [CFG]: `projects:
  a: { path: pkgs/a }
  b: { path: pkgs/b, dependsOn: [a] }
  renamed: { path: pkgs/old }
  fresh: { path: pkgs/fresh, dependsOn: [a] }
  c: { path: pkgs/c, targets: [build, test, deploy] }
  d: { path: pkgs/d, dependsOn: [c] }
`,
      'pkgs/legacy': null,
      'pkgs/fresh/x': 'brand new project',
    });
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect(r.json('added')).toEqual(['fresh']);
    expect(r.json('deleted')).toEqual(['legacy']);
    expect(r.json('renamed')).toEqual([{ from: 'old', to: 'renamed' }]);
    // c was redefined (targets) -> c and its dependent d; fresh and renamed are new.
    expect(r.json('affected')).toEqual(['c', 'd', 'fresh', 'renamed']);
    expect(r.json('affected')).not.toContain('legacy');
    expect(r.outputs['all']).toBe('false');
  });

  it('changing global/ignore selects all; adding the config file selects all', () => {
    const repo = smallRepo();
    const before = repo.head();
    const after = repo.commit('cfg', { [CFG]: SMALL_CONFIG.replace('package-lock.json', 'yarn.lock') });
    expect(push(repo, before, after).outputs['all']).toBe('true');

    const fresh = new Repo();
    const b2 = fresh.commit('init', { 'apps/web/x': '1' });
    const a2 = fresh.commit('add cfg', { [CFG]: 'projects:\n  web: { path: apps/web }\n' });
    const r2 = push(fresh, b2, a2);
    expect(r2.outputs['all']).toBe('true');
    expect(r2.outputs['reason']).toContain('was added');
  });

  it('discovers projects and reports newly discovered directories as added', () => {
    const repo = new Repo();
    const cfg = 'discover: ["packages/*"]\nprojects:\n  app: { path: apps/app, dependsOn: [core] }\n';
    const before = repo.commit('init', { [CFG]: cfg, 'packages/core/x': '1', 'packages/util/x': '1', 'apps/app/x': '1' });
    const after = repo.commit('new pkg', { 'packages/newpkg/x': '1', 'packages/core/y': '2' });
    const r = push(repo, before, after);
    expect(r.json('added')).toEqual(['newpkg']);
    expect(r.json('affected')).toEqual(['core', 'app', 'newpkg']);
    expect(r.json('skipped')).toEqual(['util']);
  });
});

describe('project ownership', () => {
  it('nested projects: deepest path wins; include/exclude refine ownership', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      [CFG]: `projects:
  web: { path: apps/web, exclude: ["apps/web/docs/**"] }
  plugin: { path: apps/web/plugin }
  tooling: { path: tools, include: ["tsconfig.base.json"] }
  api: { path: services/api, include: ["tsconfig.base.json"] }
`,
      'apps/web/x': '1', 'apps/web/plugin/x': '1', 'tools/x': '1', 'services/api/x': '1', 'tsconfig.base.json': '{}',
    });
    const a1 = repo.commit('plugin', { 'apps/web/plugin/y': '2' });
    expect(push(repo, before, a1).json('affected')).toEqual(['plugin']);
    const a2 = repo.commit('docs', { 'apps/web/docs/z.md': '2' });
    expect(push(repo, a1, a2).json('affected')).toEqual([]);
    const a3 = repo.commit('tsconfig', { 'tsconfig.base.json': '{"a":1}' });
    expect(push(repo, a2, a3).json('affected')).toEqual(['api', 'tooling']);
  });

  it('a root project (path ".") owns otherwise-unowned files', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      [CFG]: 'projects:\n  root: { path: . }\n  lib: { path: lib }\n',
      'lib/x': '1', 'main.go': 'package main',
    });
    const after = repo.commit('root', { 'main.go': 'package main // edit' });
    expect(push(repo, before, after).json('affected')).toEqual(['root']);
  });
});

describe('failures are loud and clear', () => {
  const fail = (config: string) => {
    const repo = new Repo();
    repo.commit('init', { [CFG]: config, 'a/x': '1' });
    const r = runAction(repo, { event: 'workflow_dispatch' });
    expect(r.code).toBe(1);
    expect(r.outputs).toEqual({});
    return r.stdout;
  };

  it('missing configuration', () => {
    const repo = new Repo();
    repo.commit('init', { 'x': '1' });
    const r = runAction(repo);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::error.*file not found/);
  });
  it('malformed YAML', () => expect(fail('projects:\n  a: [unclosed')).toMatch(/::error.*JSON syntax error: unexpected character "p" at line 1, column 1/));
  it('duplicate project keys', () => {
    const repo = new Repo();
    repo.commit('init', { [CONFIG]: '{ "projects": { "a": { "path": "a" }, "a": { "path": "b" } } }', 'a/x': '1' });
    const r = runAction(repo);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/duplicate key "a" at line 1/);
  });
  it('unknown dependency with suggestion', () => expect(fail('projects:\n  shared: { path: a }\n  api: { path: b, dependsOn: [sharred] }\n')).toMatch(/unknown project "sharred".*did you mean "shared"/));
  it('cycles name the full cycle', () => {
    const out = fail('projects:\n  a: { path: a, dependsOn: [c] }\n  b: { path: b, dependsOn: [a] }\n  c: { path: c, dependsOn: [b] }\n  d: { path: d }\n');
    expect(out).toMatch(/::error.*Dependency cycle detected: a -> c -> b -> a/);
  });
  it('self dependency is a cycle', () => expect(fail('projects:\n  a: { path: a, dependsOn: [a] }\n')).toMatch(/cycle detected: a -> a/));
  it('path traversal', () => expect(fail('projects:\n  a: { path: ../../etc }\n')).toMatch(/must not contain "\.\." segments/));
  it('absolute paths', () => expect(fail('projects:\n  a: { path: /etc }\n')).toMatch(/relative to the repository root/));
  it('shell metacharacters in names', () => expect(fail('projects:\n  "$(curl evil)": { path: a }\n')).toMatch(/project name/));
  it('prototype keys', () => expect(fail('projects:\n  __proto__: { path: a }\n')).toMatch(/reserved name/));
  it('unknown keys (typos)', () => expect(fail('projects:\n  a: { path: a, dependOn: [b] }\n')).toMatch(/unknown key "dependOn"/));
  it('two projects on one path', () => expect(fail('projects:\n  a: { path: a }\n  b: { path: a/ }\n')).toMatch(/both use path "a"/));
  it('unsupported glob syntax', () => expect(fail('projects:\n  a: { path: a }\nglobal: ["{a,b}/**"]\n')).toMatch(/only "\*", "\*\*" and "\?"/));
  it('non-JSON input is rejected', () => expect(fail('projects:\n  a: !!js/function "x"\n')).toMatch(/::error/));
  it('suspicious base input is rejected', () => {
    const repo = smallRepo();
    const r = runAction(repo, { inputs: { base: '--output=/tmp/pwned' } });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/refusing suspicious revision/);
  });
});

describe('log safety', () => {
  it.skipIf(process.platform === 'win32')('file names cannot inject workflow commands', () => {
    const repo = new Repo();
    const before = repo.commit('init', { [CFG]: 'projects:\n  a: { path: a }\n', 'a/x': '1' });
    const after = repo.commit('evil', { '::warning::pwned': '1' });
    const r = runAction(repo, { event: 'push', payload: pushPayload(before, after), inputs: { verbose: 'true' } });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/^::warning::pwned/m);
  });
});
