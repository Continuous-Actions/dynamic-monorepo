// Benchmarks. Run: node bench/bench.ts   (Node >= 24, after `npm run build`)
// 1) In-process phases on synthetic graphs (config parse, graph build, planning).
// 2) End-to-end: the bundled action against a real git repository.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseConfig } from '../src/config.ts';
import { Graph } from '../src/graph.ts';
import { plan, type FileChange } from '../src/plan.ts';

const DIST = resolve(import.meta.dirname, '..', 'dist', 'index.js');

/** Deterministic PRNG so runs are comparable. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** Layered DAG: libs at the bottom, apps on top; each project depends on up to 3 lower ones. */
export function synthConfig(n: number, seed = 1): string {
  const r = rng(seed);
  const projects: Record<string, { path: string; dependsOn?: string[] }> = {};
  for (let i = 0; i < n; i++) {
    const deps = new Set<string>();
    if (i > 0) for (let k = Math.floor(r() * 4); k > 0; k--) deps.add(`p${Math.floor(r() * i)}`);
    const kind = i < n * 0.3 ? "libs" : i < n * 0.8 ? "services" : "apps";
    projects[`p${i}`] = deps.size ? { path: `${kind}/p${i}`, dependsOn: [...deps] } : { path: `${kind}/p${i}` };
  }
  return JSON.stringify({ projects, ignore: ["**/*.md"] }, null, 2);
}

function synthChanges(n: number, files: number, seed = 2): FileChange[] {
  const r = rng(seed);
  const out: FileChange[] = [];
  for (let i = 0; i < files; i++) {
    const p = Math.floor(r() * n);
    const kind = p < n * 0.3 ? 'libs' : p < n * 0.8 ? 'services' : 'apps';
    out.push({ status: 'modified', path: `${kind}/p${p}/src/deep/dir/file${i}.ts` });
  }
  return out;
}

function time<T>(fn: () => T, reps = 5): { ms: number; value: T } {
  let best = Infinity;
  let value!: T;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    value = fn();
    best = Math.min(best, performance.now() - t);
  }
  return { ms: best, value };
}

const fmt = (ms: number) => (ms < 10 ? ms.toFixed(2) : ms.toFixed(1));

console.log('## In-process (best of 5, ms)\n');
console.log('| projects | changed files | parse+validate | graph build | plan | affected |');
console.log('| ---: | ---: | ---: | ---: | ---: | ---: |');
for (const [n, files] of [[10, 10], [100, 100], [500, 1_000], [1_000, 10_000], [5_000, 100_000], [10_000, 100_000]] as const) {
  const text = synthConfig(n);
  const parse = time(() => parseConfig(text, 'bench.json'));
  const graph = time(() => new Graph(parse.value.projects.values()));
  const changes = synthChanges(n, files);
  // Only a handful of projects touched is the common case; 100k files stresses ownership lookup.
  const p = time(() => plan({ head: parse.value, configPath: 'bench.json', changes, base: parse.value }));
  console.log(`| ${n} | ${files} | ${fmt(parse.ms)} | ${fmt(graph.ms)} | ${fmt(p.ms)} | ${p.value.affected.length} |`);
}

// ---- End to end ----
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
}

function e2e(n: number, changedFiles: number) {
  const dir = mkdtempSync(join(tmpdir(), 'dm-bench-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'b@example.com');
    git(dir, 'config', 'user.name', 'bench');
    const write = (p: string, c: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    };
    write('dynamic-monorepo.config.json', synthConfig(n));
    for (let i = 0; i < n; i++) {
      const kind = i < n * 0.3 ? 'libs' : i < n * 0.8 ? 'services' : 'apps';
      write(`${kind}/p${i}/index.ts`, `export const x = ${i};\n`);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const before = git(dir, 'rev-parse', 'HEAD');
    for (const c of synthChanges(n, changedFiles)) write(c.path, 'changed\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'change');
    const after = git(dir, 'rev-parse', 'HEAD');
    const work = mkdtempSync(join(tmpdir(), 'dm-bench-run-'));
    const event = join(work, 'event.json');
    writeFileSync(event, JSON.stringify({ ref: 'refs/heads/main', before, after, repository: { default_branch: 'main' } }));
    const env = {
      ...process.env, GITHUB_WORKSPACE: dir, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: join(work, 'out'), GITHUB_STEP_SUMMARY: join(work, 'summary'), RUNNER_TEMP: work,
    };
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const r = spawnSync(process.execPath, [DIST], { env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stdout + r.stderr);
      best = Math.min(best, performance.now() - t);
    }
    rmSync(work, { recursive: true, force: true });
    return best;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

let baseline = Infinity;
for (let i = 0; i < 5; i++) {
  const t = performance.now();
  spawnSync(process.execPath, ['-e', '0']);
  baseline = Math.min(baseline, performance.now() - t);
}
console.log(`\n## End to end (bundled action, real git repo, push event; best of 5)\n`);
console.log(`Bundle: dist/index.js = ${statSync(DIST).size} bytes. Node startup baseline (\`node -e 0\`): ${fmt(baseline)} ms\n`);
console.log('| projects | changed files | total wall time (ms) |');
console.log('| ---: | ---: | ---: |');
for (const [n, files] of [[10, 5], [100, 50], [1_000, 1_000], [5_000, 10_000]] as const) {
  console.log(`| ${n} | ${files} | ${fmt(e2e(n, files))} |`);
}
console.log(`\nPlatform: ${process.platform}/${process.arch}, Node ${process.version}`);
