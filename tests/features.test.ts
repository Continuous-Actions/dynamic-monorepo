// End-to-end tests for inference, Nx import, per-target impact, move detection,
// matrix batching and the CLI. All run the bundled dist/ files.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CFG, CONFIG, cleanup, pushPayload, Repo, runAction } from './helpers.ts';

afterAll(cleanup);

const push = (repo: Repo, before: string, after: string, inputs?: Record<string, string>) =>
  runAction(repo, { event: 'push', payload: pushPayload(before, after), inputs });
const pkg = (name: string, deps: Record<string, string> = {}) => JSON.stringify({ name, version: '1.0.0', dependencies: deps });

describe('infer: node workspaces', () => {
  function nodeRepo() {
    const repo = new Repo();
    const before = repo.commit('init', {
      [CFG]: 'infer: [node]\nprojects:\n  "@acme/web": { path: apps/web, targets: [build, test, deploy] }\n',
      'package.json': JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*', '!packages/ignored'] }),
      'packages/shared/package.json': pkg('@acme/shared'),
      'packages/ui/package.json': pkg('@acme/ui', { '@acme/shared': 'workspace:*', react: '^19' }),
      'packages/ignored/package.json': pkg('@acme/ignored'),
      'apps/web/package.json': pkg('@acme/web', { '@acme/ui': '*' }),
      'apps/api/package.json': JSON.stringify({ name: '@acme/api', devDependencies: { '@acme/shared': '*' } }),
    });
    return { repo, before };
  }

  it('builds the graph from package.json dependencies; explicit entries add targets', () => {
    const { repo, before } = nodeRepo();
    const after = repo.commit('shared', { 'packages/shared/src/index.ts': 'x' });
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect(r.json('affected')).toEqual(['@acme/shared', '@acme/api', '@acme/ui', '@acme/web']);
    expect(r.json('deploy')).toEqual(['@acme/web']);
    expect(r.json('affected')).not.toContain('@acme/ignored');
    expect(r.plan.reasons['@acme/web'].chain).toEqual(['@acme/shared', '@acme/ui', '@acme/web']);
  });

  it('a new workspace package is reported as added; a new dependency edge is picked up', () => {
    const { repo, before } = nodeRepo();
    const after = repo.commit('new', {
      'packages/auth/package.json': pkg('@acme/auth'),
      'apps/api/package.json': JSON.stringify({ name: '@acme/api', dependencies: { '@acme/auth': '*' }, devDependencies: { '@acme/shared': '*' } }),
    });
    const r = push(repo, before, after);
    expect(r.json('added')).toEqual(['@acme/auth']);
    expect(r.json('affected')).toEqual(['@acme/auth', '@acme/api']);
  });

  it('reads pnpm-workspace.yaml', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      [CFG]: 'infer: [node]\n',
      'package.json': '{"name":"root","private":true}',
      'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n",
      'libs/a/package.json': pkg('a'),
      'libs/b/package.json': pkg('b', { a: 'workspace:^' }),
    });
    const after = repo.commit('a', { 'libs/a/x.ts': '1' });
    expect(push(repo, before, after).json('affected')).toEqual(['a', 'b']);
  });
});

describe('infer: go and cargo', () => {
  it('go.work modules with require edges', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      [CFG]: 'infer: [go]\n',
      'go.work': 'go 1.23\n\nuse (\n\t./libs/core // core lib\n\t./services/api\n)\nuse ./tools\n',
      'libs/core/go.mod': 'module example.com/core\n\ngo 1.23\n',
      'services/api/go.mod': 'module example.com/api\n\ngo 1.23\n\nrequire (\n\texample.com/core v0.0.0\n\tgithub.com/x/y v1.2.3\n)\n',
      'tools/go.mod': 'module example.com/tools\nrequire example.com/api v0.0.0\n',
    });
    const after = repo.commit('core', { 'libs/core/core.go': 'package core' });
    expect(push(repo, before, after).json('affected')).toEqual(['libs/core', 'services/api', 'tools']);
  });

  it('cargo workspace members with path and workspace dependencies', () => {
    const repo = new Repo();
    const before = repo.commit('init', {
      [CFG]: 'infer: [cargo]\n',
      'Cargo.toml': '[workspace]\nmembers = [\n  "crates/*",\n  "bins/cli",\n]\nexclude = ["crates/scratch"]\n\n[workspace.dependencies]\ncore = { path = "crates/core" }\nserde = "1"\n',
      'crates/core/Cargo.toml': '[package]\nname = "core"\nversion = "0.1.0"\n',
      'crates/net/Cargo.toml': '[package]\nname = "net" # networking\n\n[dependencies]\ncore.workspace = true\nserde = { workspace = true }\n',
      'crates/scratch/Cargo.toml': '[package]\nname = "scratch"\n',
      'bins/cli/Cargo.toml': "[package]\nname = 'cli'\n\n[dependencies]\nnet = { path = \"../../crates/net\", version = \"0.1\" }\n\n[dev-dependencies.core]\npath = '../../crates/core'\n",
    });
    const after = repo.commit('core', { 'crates/core/src/lib.rs': '' });
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect(r.json('affected')).toEqual(['core', 'net', 'cli']);
    expect(r.json('affected')).not.toContain('scratch');
  });
});

describe('import: nx graph', () => {
  it('reads nodes and dependencies from nx graph --file output', () => {
    const repo = new Repo();
    const graph = {
      graph: {
        nodes: {
          'shared-utils': { name: 'shared-utils', type: 'lib', data: { root: 'libs/shared/utils' } },
          'feature-cart': { name: 'feature-cart', type: 'lib', data: { root: 'libs/feature/cart' } },
          shop: { name: 'shop', type: 'app', data: { root: 'apps/shop' } },
          'shop-e2e': { name: 'shop-e2e', type: 'e2e', data: { root: 'apps/shop-e2e' } },
        },
        dependencies: {
          'feature-cart': [{ source: 'feature-cart', target: 'shared-utils', type: 'static' }],
          shop: [{ source: 'shop', target: 'feature-cart', type: 'static' }, { source: 'shop', target: 'npm:react', type: 'static' }],
          'shop-e2e': [{ source: 'shop-e2e', target: 'shop', type: 'implicit' }],
          'shared-utils': [],
        },
      },
    };
    const before = repo.commit('init', {
      [CFG]: 'import: { nx: nx-graph.json }\nprojects:\n  shop-e2e: { path: apps/shop-e2e, targets: [test] }\n',
      'nx-graph.json': JSON.stringify(graph),
      'libs/shared/utils/x.ts': '1', 'libs/feature/cart/x.ts': '1', 'apps/shop/x.ts': '1', 'apps/shop-e2e/x.ts': '1',
    });
    const after = repo.commit('utils', { 'libs/shared/utils/y.ts': '2' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual(['shared-utils', 'feature-cart', 'shop', 'shop-e2e']);
    expect(r.json('build')).toEqual(['shared-utils', 'feature-cart', 'shop']);
    expect(r.json('test')).toEqual(['shared-utils', 'feature-cart', 'shop', 'shop-e2e']);
  });

  it('a missing graph file is a clear error', () => {
    const repo = new Repo();
    repo.commit('init', { [CFG]: 'import: { nx: graph.json }\n', 'a/x': '1' });
    const r = runAction(repo);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/nx graph --file=graph\.json/);
  });
});

describe('per-target impact (test-impact / deploy-impact)', () => {
  const cfg = `
targets:
  deploy: { exclude: ["**/*.test.ts", "**/__tests__/**"] }
projects:
  shared: { path: libs/shared }
  api:
    path: services/api
    dependsOn: [shared]
    targets:
      build: {}
      test: { exclude: ["services/api/docs/**"] }
      deploy: {}
  web: { path: apps/web, dependsOn: [api], targets: [build, test, deploy] }
`;
  it('test-only edits do not redeploy anything downstream', () => {
    const repo = new Repo();
    const before = repo.commit('init', { [CFG]: cfg, 'libs/shared/a.ts': '1', 'services/api/a.ts': '1', 'apps/web/a.ts': '1' });
    const after = repo.commit('tests', { 'libs/shared/a.test.ts': 'test' });
    const r = push(repo, before, after);
    expect(r.json('affected')).toEqual(['shared', 'api', 'web']);
    expect(r.json('test')).toEqual(['shared', 'api', 'web']);
    expect(r.json('deploy')).toEqual([]);
    expect(r.outputs['has_deploy']).toBe('false');
  });

  it('project-level target excludes: api docs skip tests but still build and deploy', () => {
    const repo = new Repo();
    const before = repo.commit('init', { [CFG]: cfg, 'libs/shared/a.ts': '1', 'services/api/a.ts': '1', 'apps/web/a.ts': '1' });
    const after = repo.commit('docs', { 'services/api/docs/guide.txt': 'docs' });
    const r = push(repo, before, after);
    expect(r.json('build')).toEqual(['api', 'web']);
    expect(r.json('test')).toEqual([]);
    expect(r.json('deploy')).toEqual(['api', 'web']);
  });

  it('changing top-level targets settings selects everything', () => {
    const repo = new Repo();
    const before = repo.commit('init', { [CFG]: cfg, 'libs/shared/a.ts': '1', 'services/api/a.ts': '1', 'apps/web/a.ts': '1' });
    const after = repo.commit('cfg', { [CFG]: cfg.replace('"**/__tests__/**"', '"**/__mocks__/**"') });
    expect(push(repo, before, after).outputs['all']).toBe('true');
  });
});

describe('renamed and moved projects', () => {
  it('detects a project renamed and moved in one change via git renames', () => {
    const repo = new Repo();
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`libs/old-auth/src/f${i}.ts`] = `export const v${i} = ${'1'.repeat(200)};\n`;
    const before = repo.commit('init', {
      [CFG]: 'projects:\n  old-auth: { path: libs/old-auth }\n  api: { path: services/api, dependsOn: [old-auth] }\n',
      'services/api/x.ts': '1', ...files,
    });
    mkdirSync(resolve(repo.dir, 'packages'));
    repo.git('mv', 'libs/old-auth', 'packages/auth');
    repo.write({ [CFG]: 'projects:\n  auth: { path: packages/auth }\n  api: { path: services/api, dependsOn: [auth] }\n' });
    const after = repo.commit('rename+move');
    const r = push(repo, before, after);
    expect(r.code).toBe(0);
    expect(r.json('renamed')).toEqual([{ from: 'old-auth', to: 'auth' }]);
    expect(r.json('added')).toEqual([]);
    expect(r.json('deleted')).toEqual([]);
    expect(r.json('affected')).toEqual(['auth', 'api']);
  });
});

describe('matrix batches', () => {
  it('splits large lists into at most max-jobs balanced batches in dependency order', () => {
    const repo = new Repo();
    const lines = ['projects:'];
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      lines.push(`  p${i}: { path: p/${i}${i > 0 ? ', dependsOn: [p0]' : ''} }`);
      files[`p/${i}/x`] = '1';
    }
    const before = repo.commit('init', { [CFG]: lines.join('\n') + '\n', ...files });
    const after = repo.commit('root', { 'p/0/y': '2' });
    const r = push(repo, before, after, { 'max-jobs': '3' });
    const b = r.json('build_batches') as string[][];
    expect(b).toHaveLength(3);
    expect(b.flat()).toEqual(r.json('build'));
    expect(Math.max(...b.map((x) => x.length)) - Math.min(...b.map((x) => x.length))).toBeLessThanOrEqual(1);
    expect(push(repo, after, repo.commit('none')).json('build_batches')).toEqual([]);
  });

  it('rejects invalid max-jobs', () => {
    const repo = new Repo();
    repo.commit('init', { [CFG]: 'projects:\n  a: { path: a }\n', 'a/x': '1' });
    expect(runAction(repo, { inputs: { 'max-jobs': '300' } }).code).toBe(1);
  });
});

describe('path-filter audit', () => {
  const wf = (paths: string) => `name: web\non:\n  pull_request:\n    paths:\n${paths}\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
  function auditRepo() {
    const repo = new Repo();
    repo.commit('init', {
      'package.json': JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }),
      'packages/shared/package.json': '{"name":"shared"}',
      'packages/ui/package.json': JSON.stringify({ name: 'ui', dependencies: { shared: '*' } }),
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { ui: '*' } }),
      '.github/workflows/web.yml': wf("      - 'apps/web/**'\n      - 'packages/ui/**'\n      - '.github/workflows/old-web.yml'"),
      '.github/workflows/ui.yml': wf("      - 'packages/ui'\n      - 'packages/shared/**'"),
    });
    return repo;
  }

  it('reports missing transitive dependencies, directories without globs and stale workflow references', () => {
    const repo = auditRepo();
    const r = runAction(repo, { inputs: { audit: 'warn' } });
    expect(r.code).toBe(0);
    expect(r.outputs['audit_findings']).toBe('3');
    expect(r.stdout).toMatch(/::warning [^\n]*file=.github\/workflows\/web.yml,line=\d+::`packages\/shared\/\*\*` is missing from on.pull_request.paths/);
    expect(r.stdout).toMatch(/old-web.yml.*no longer exists/);
    expect(r.stdout).toMatch(/packages\/ui. is a directory/);
    expect(r.summary).toContain('Path-filter audit (3)');
  });

  it('fail mode fails the step; the CLI exits 1', () => {
    const repo = auditRepo();
    expect(runAction(repo, { inputs: { audit: 'fail' } }).code).toBe(1);
    const cli = spawnSync(process.execPath, [resolve(import.meta.dirname, '..', 'dist', 'cli.js'), 'audit'], { cwd: repo.dir, encoding: 'utf8' });
    expect(cli.status).toBe(1);
    expect(cli.stdout).toMatch(/web.yml:\d+: `packages\/shared\/\*\*` is missing/);
  });

  describe('--fix', () => {
    const CLI = resolve(import.meta.dirname, '..', 'dist', 'cli.js');
    const run = (dir: string, ...args: string[]) => spawnSync(process.execPath, [CLI, 'audit', '--fix', ...args], { cwd: dir, encoding: 'utf8' });
    const read = (repo: Repo, f: string) => readFileSync(join(repo.dir, f), 'utf8');

    it('adds missing folders and globs directories, editing only the paths lists', () => {
      const repo = auditRepo();
      repo.write({ '.github/workflows/web.yml': wf("      - 'apps/web/**'   # the app\n      - 'packages/ui/**'\n      - '.github/workflows/old-web.yml'").replace('name: web', '# keep me\nname: web') });
      const r = run(repo.dir);
      expect(r.status).toBe(1); // the stale workflow reference needs a human
      expect(r.stdout).toContain("fixed  .github/workflows/web.yml: added `packages/shared/**` in on.pull_request.paths");
      expect(r.stdout).toContain('fixed  .github/workflows/ui.yml: `packages/ui` → `packages/ui/**`');
      expect(r.stdout).toMatch(/left {3}\.github\/workflows\/web\.yml:\d+: `\.github\/workflows\/old-web\.yml`/);
      expect(read(repo, '.github/workflows/web.yml')).toBe(
        wf("      - 'apps/web/**'   # the app\n      - 'packages/ui/**'\n      - '.github/workflows/old-web.yml'\n      - 'packages/shared/**'").replace('name: web', '# keep me\nname: web'),
      );
      expect(read(repo, '.github/workflows/ui.yml')).toBe(wf("      - 'packages/ui/**'\n      - 'packages/shared/**'"));
      const again = spawnSync(process.execPath, [CLI, 'audit'], { cwd: repo.dir, encoding: 'utf8' });
      expect(again.stdout.trim().split('\n')).toHaveLength(1);
      expect(again.stdout).toContain('old-web.yml');
    });

    it('keeps flow lists, plain scalars and CRLF line endings', () => {
      const repo = auditRepo();
      const flow = 'name: web\r\non:\r\n  push:\r\n    paths: [apps/web/**, packages/ui/**]  # keep [x]\r\njobs:\r\n  t:\r\n    runs-on: ubuntu-latest\r\n    steps:\r\n      - run: echo hi\r\n';
      repo.write({ '.github/workflows/web.yml': flow, '.github/workflows/ui.yml': null });
      expect(run(repo.dir).status).toBe(0);
      expect(read(repo, '.github/workflows/web.yml')).toBe(flow.replace('packages/ui/**]', 'packages/ui/**, packages/shared/**]'));
    });

    it('leaves lists it cannot edit safely untouched', () => {
      const repo = auditRepo();
      const anchored = "name: web\non:\n  push:\n    paths: &p\n      - 'apps/web/**'\n  pull_request:\n    paths: *p\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
      repo.write({ '.github/workflows/web.yml': anchored, '.github/workflows/ui.yml': null });
      repo.write({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { shared: '*' } }) });
      const r = run(repo.dir, '--json');
      expect(r.status).toBe(1);
      const out = JSON.parse(r.stdout);
      expect(out.fixed).toEqual([]);
      expect(out.left.length).toBeGreaterThan(0);
      expect(read(repo, '.github/workflows/web.yml')).toBe(anchored);
    });

    it('is only accepted by audit', () => {
      const repo = auditRepo();
      const r = spawnSync(process.execPath, [CLI, '--fix'], { cwd: repo.dir, encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--fix only applies to the audit command');
    });
  });
});

describe('CLI', () => {
  const CLI = resolve(import.meta.dirname, '..', 'dist', 'cli.js');
  const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

  function repoWithBranch() {
    const repo = new Repo();
    repo.commit('init', { [CFG]: 'projects:\n  lib: { path: lib }\n  app: { path: app, dependsOn: [lib] }\n', 'lib/x': '1', 'app/x': '1' });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('lib', { 'lib/y': '2' });
    return repo;
  }

  it('previews against main and prints the explanation', () => {
    const repo = repoWithBranch();
    const r = cli(repo.dir, '--base', 'main');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 affected / 2 projects');
    expect(r.stdout).toContain('app — depends on lib (lib → app)');
  });

  it('--json prints the plan; default base falls back to main', () => {
    const repo = repoWithBranch();
    const r = cli(repo.dir, '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).affected).toEqual(['lib', 'app']);
  });

  it('--uncommitted includes working-tree edits', () => {
    const repo = repoWithBranch();
    repo.git('checkout', '-q', 'main');
    repo.write({ 'app/new-file': 'wip' });
    const r = cli(repo.dir, '--uncommitted', '--json');
    expect(JSON.parse(r.stdout).affected).toEqual(['app']);
  });

  it('reports config errors and bad flags with non-zero exit codes', () => {
    const repo = new Repo();
    repo.commit('init', { [CONFIG]: '{ "projects": ', 'a/x': '1' });
    expect(cli(repo.dir, '--base', 'HEAD').status).toBe(1);
    expect(cli(repo.dir, '--nope').status).toBe(2);
  });
});
