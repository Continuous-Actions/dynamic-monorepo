// Project and dependency inference from ecosystem manifests, plus Nx graph import.
// Everything here only *reads* files through a RepoReader; nothing is executed.

import { load, CORE_SCHEMA } from 'js-yaml';
import { normalizeDir } from './paths.ts';

export type RepoReader = {
  /** Immediate sub-directory names of a repo-relative directory ("." = root). */
  listDirs(dir: string): string[];
  /** File contents, or undefined if the file does not exist. */
  read(path: string): string | undefined;
  /** Every committed file, repo-relative (used by auto-detection). */
  listFiles(): string[];
  /** Contents of many files at once; missing or oversized files are left out. */
  readMany(paths: string[]): Map<string, string>;
};

export type Inferred = { name: string; path: string; dependsOn: string[]; via: string };
export const INFER_KINDS = ['node', 'go', 'cargo'] as const;
export type InferKind = (typeof INFER_KINDS)[number];

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build']);
const MAX_MANIFEST = 1024 * 1024;

/** Expands workspace-style directory patterns: "a/b", "a/*", "a/**". */
export function expandDirPattern(reader: RepoReader, pattern: string): string[] {
  let p = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (p.startsWith('!')) return []; // exclusions are handled by the caller
  if (p === '' || p === '.') return ['.'];
  const parts = p.split('/');
  let current: string[] = ['.'];
  for (const part of parts) {
    const next: string[] = [];
    for (const dir of current) {
      if (part === '**') {
        next.push(...walk(reader, dir, MAX_DEPTH));
      } else if (part.includes('*')) {
        const re = new RegExp(`^${part.replace(/[.+^$()|[\]{}\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
        for (const d of reader.listDirs(dir)) if (re.test(d) && !d.startsWith('.') && !SKIP_DIRS.has(d)) next.push(join(dir, d));
      } else if (part !== '..') {
        next.push(join(dir, part));
      }
    }
    current = next;
  }
  return [...new Set(current)].sort();
}

function walk(reader: RepoReader, dir: string, depth: number): string[] {
  const out = [dir];
  if (depth === 0) return out;
  for (const d of reader.listDirs(dir)) {
    if (d.startsWith('.') || SKIP_DIRS.has(d)) continue;
    out.push(...walk(reader, join(dir, d), depth - 1));
  }
  return out;
}

const join = (dir: string, name: string) => (dir === '.' ? name : `${dir}/${name}`);

function readSafe(reader: RepoReader, path: string): string | undefined {
  const t = reader.read(path);
  return t !== undefined && t.length <= MAX_MANIFEST ? t : undefined;
}

function parseJson(text: string | undefined): any {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

function excluded(patterns: string[]): (dir: string) => boolean {
  const negs = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1).replace(/^\.\//, '').replace(/\/+$/, ''));
  return (dir) => negs.some((n) => n === dir || (n.endsWith('/**') && dir.startsWith(n.slice(0, -2))) || (n.endsWith('/*') && dir.startsWith(n.slice(0, -1)) && !dir.slice(n.length - 1).includes('/')));
}

/** package.json workspaces (npm, Yarn, Bun) and pnpm-workspace.yaml. Names are package names. */
export function inferNode(reader: RepoReader, problems: string[]): Inferred[] {
  const root = parseJson(readSafe(reader, 'package.json'));
  let patterns: string[] = [];
  const ws = root?.workspaces;
  if (Array.isArray(ws)) patterns = ws;
  else if (Array.isArray(ws?.packages)) patterns = ws.packages;
  const pnpm = readSafe(reader, 'pnpm-workspace.yaml');
  if (pnpm !== undefined) {
    try {
      const doc = load(pnpm, { schema: CORE_SCHEMA }) as any;
      if (Array.isArray(doc?.packages)) patterns.push(...doc.packages);
    } catch {
      problems.push('infer node: pnpm-workspace.yaml is not valid YAML');
    }
  }
  patterns = patterns.filter((p): p is string => typeof p === 'string');
  if (patterns.length === 0) {
    problems.push('infer node: no "workspaces" in package.json and no pnpm-workspace.yaml packages');
    return [];
  }
  const isExcluded = excluded(patterns);
  const pkgs = new Map<string, { path: string; deps: string[] }>();
  for (const pattern of patterns) {
    for (const dir of expandDirPattern(reader, pattern)) {
      if (dir === '.' || isExcluded(dir)) continue;
      const pkg = parseJson(readSafe(reader, `${dir}/package.json`));
      if (!pkg || typeof pkg.name !== 'string') continue;
      const deps = new Set<string>();
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const d = pkg[field];
        if (d && typeof d === 'object' && !Array.isArray(d)) for (const k of Object.keys(d)) deps.add(k);
      }
      const prev = pkgs.get(pkg.name);
      if (prev && prev.path !== dir) problems.push(`infer node: package "${pkg.name}" exists in both "${prev.path}" and "${dir}"`);
      else pkgs.set(pkg.name, { path: dir, deps: [...deps] });
    }
  }
  return [...pkgs].map(([name, p]) => ({
    name, path: p.path, via: 'node', dependsOn: p.deps.filter((d) => d !== name && pkgs.has(d)).sort(),
  }));
}

/** go.work "use" directives; edges from go.mod "require"/"replace" of other workspace modules. Names are directories. */
export function inferGo(reader: RepoReader, problems: string[]): Inferred[] {
  const work = readSafe(reader, 'go.work');
  if (work === undefined) {
    problems.push('infer go: go.work not found');
    return [];
  }
  const dirs = new Set<string>();
  for (const m of stripGoComments(work).matchAll(/^\s*use\s*\(([\s\S]*?)\)|^\s*use\s+(\S+)/gm)) {
    const block = m[1] ?? m[2] ?? '';
    for (const raw of block.split(/\s+/).filter(Boolean)) {
      const n = normalizeDir(raw.replace(/^"|"$/g, ''));
      if ('path' in n && n.path !== '.') dirs.add(n.path);
    }
  }
  const modules = new Map<string, string>(); // module path -> dir
  const requires = new Map<string, Set<string>>();
  for (const dir of [...dirs].sort()) {
    const gomod = readSafe(reader, `${dir}/go.mod`);
    if (gomod === undefined) {
      problems.push(`infer go: ${dir}/go.mod not found`);
      continue;
    }
    const text = stripGoComments(gomod);
    const mod = /^\s*module\s+(\S+)/m.exec(text)?.[1]?.replace(/^"|"$/g, '');
    if (!mod) continue;
    modules.set(mod, dir);
    const req = new Set<string>();
    for (const m of text.matchAll(/^\s*(?:require|replace)\s*\(([\s\S]*?)\)|^\s*(?:require|replace)\s+(\S+)/gm)) {
      for (const line of (m[1] ?? m[2] ?? '').split('\n')) {
        const first = line.trim().split(/\s+/)[0];
        if (first) req.add(first.replace(/^"|"$/g, ''));
      }
    }
    requires.set(dir, req);
  }
  return [...modules].map(([mod, dir]) => ({
    name: dir, path: dir, via: 'go',
    dependsOn: [...(requires.get(dir) ?? [])].map((r) => modules.get(r)).filter((d): d is string => d !== undefined && d !== dir).sort(),
  }));
}

export const stripGoComments = (s: string) => s.replace(/\/\/[^\n]*/g, '');

/** Cargo [workspace] members; edges from path dependencies (directly or via workspace.dependencies). Names are crate names. */
export function inferCargo(reader: RepoReader, problems: string[]): Inferred[] {
  const rootText = readSafe(reader, 'Cargo.toml');
  const root = rootText === undefined ? undefined : parseTomlSafe(rootText, 'Cargo.toml', problems);
  const workspace = root?.['workspace'];
  const members: unknown = workspace?.['members'];
  if (!Array.isArray(members)) {
    problems.push('infer cargo: Cargo.toml has no [workspace] members');
    return [];
  }
  const excludes: string[] = Array.isArray(workspace['exclude']) ? workspace['exclude'].filter((x: unknown) => typeof x === 'string') : [];
  const wsDeps: Record<string, any> = workspace['dependencies'] ?? {};
  const crates = new Map<string, { path: string; deps: Set<string> }>();
  const byDir = new Map<string, string>();
  const manifests: [string, any][] = [];
  for (const pattern of members.filter((m): m is string => typeof m === 'string')) {
    for (const dir of expandDirPattern(reader, pattern)) {
      if (excludes.some((e) => e.replace(/\/+$/, '') === dir)) continue;
      const text = readSafe(reader, `${dir}/Cargo.toml`);
      if (text === undefined) continue;
      const manifest = parseTomlSafe(text, `${dir}/Cargo.toml`, problems);
      const name = manifest?.['package']?.['name'];
      if (typeof name !== 'string') continue;
      crates.set(name, { path: dir, deps: new Set() });
      byDir.set(dir, name);
      manifests.push([dir, manifest]);
    }
  }
  for (const [dir, manifest] of manifests) {
    const self = byDir.get(dir)!;
    for (const table of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      const deps = manifest[table];
      if (!deps || typeof deps !== 'object') continue;
      for (const [key, spec] of Object.entries<any>(deps)) {
        const pkgName = typeof spec?.package === 'string' ? spec.package : key;
        let path: unknown = spec?.path;
        let base = dir;
        if (spec?.workspace === true) {
          path = wsDeps[key]?.path;
          base = '.';
        }
        if (typeof path === 'string') {
          const target = resolveRel(base, path);
          const dep = target !== undefined ? byDir.get(target) : undefined;
          if (dep && dep !== self) crates.get(self)!.deps.add(dep);
        } else if (crates.has(pkgName) && pkgName !== self && spec?.workspace === true) {
          crates.get(self)!.deps.add(pkgName);
        }
      }
    }
  }
  return [...crates].map(([name, c]) => ({ name, path: c.path, via: 'cargo', dependsOn: [...c.deps].sort() }));
}

export function resolveRel(base: string, rel: string): string | undefined {
  const parts = base === '.' ? [] : base.split('/');
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

/** Nx project graph JSON produced by `nx graph --file=<path>.json`. */
export function importNx(reader: RepoReader, file: string, problems: string[]): Inferred[] {
  const doc = parseJson(readSafe(reader, file));
  const graph = doc?.graph ?? doc;
  const nodes = graph?.nodes;
  if (!nodes || typeof nodes !== 'object') {
    problems.push(`import nx: "${file}" is missing or is not an Nx graph (expected { graph: { nodes, dependencies } }; generate it with "nx graph --file=${file}")`);
    return [];
  }
  const out: Inferred[] = [];
  const names = new Set(Object.keys(nodes).filter((k) => !k.startsWith('npm:')));
  for (const name of [...names].sort()) {
    const root = nodes[name]?.data?.root;
    if (typeof root !== 'string') continue;
    const deps = Array.isArray(graph.dependencies?.[name]) ? graph.dependencies[name] : [];
    out.push({
      name, path: root === '' ? '.' : root, via: 'nx',
      dependsOn: [...new Set<string>(deps.map((d: any) => d?.target).filter((t: unknown): t is string => typeof t === 'string' && names.has(t) && t !== name))].sort(),
    });
  }
  return out;
}

export function infer(kind: InferKind, reader: RepoReader, problems: string[]): Inferred[] {
  switch (kind) {
    case 'node': return inferNode(reader, problems);
    case 'go': return inferGo(reader, problems);
    case 'cargo': return inferCargo(reader, problems);
  }
}

// ---------------------------------------------------------------------------
// Minimal TOML reader: enough for Cargo manifests (tables, dotted keys, strings,
// numbers, booleans, arrays incl. multi-line, inline tables). Unknown syntax is
// skipped rather than guessed. Objects are created without prototypes.

function parseTomlSafe(text: string, file: string, problems: string[]): any {
  try {
    return parseToml(text);
  } catch (err) {
    problems.push(`${file}: ${(err as Error).message}`);
    return undefined;
  }
}

export function parseToml(text: string): any {
  const root = obj();
  let table = root;
  const src = text.replace(/\r\n/g, '\n');
  let i = 0;
  const peek = () => src[i];
  const ws = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++; };
  const wsnl = () => {
    for (;;) {
      ws();
      if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
      if (src[i] === '\n') { i++; continue; }
      break;
    }
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      ws();
      if (peek() === '"' || peek() === "'") parts.push(str());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
        if (!m) throw new Error(`invalid key at offset ${i}`);
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
      if (peek() === '.') { i++; continue; }
      return parts;
    }
  };
  const str = (): string => {
    const q = src[i]!;
    const triple = src.startsWith(q.repeat(3), i);
    if (triple) {
      const end = src.indexOf(q.repeat(3), i + 3);
      if (end < 0) throw new Error('unterminated string');
      const s = src.slice(i + 3, end).replace(/^\n/, '');
      i = end + 3;
      return s;
    }
    i++;
    let s = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\n') throw new Error('unterminated string');
      if (q === '"' && src[i] === '\\') {
        const c = src[++i];
        s += c === 'n' ? '\n' : c === 't' ? '\t' : c ?? '';
        i++;
      } else s += src[i++];
    }
    i++;
    return s;
  };
  const value = (): unknown => {
    ws();
    const c = peek();
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        wsnl();
        if (peek() === ']') { i++; return arr; }
        arr.push(value());
        wsnl();
        if (peek() === ',') i++;
      }
    }
    if (c === '{') {
      i++;
      const t = obj();
      for (;;) {
        ws();
        if (peek() === '}') { i++; return t; }
        const k = key();
        if (peek() !== '=') throw new Error('expected "=" in inline table');
        i++;
        assign(t, k, value());
        ws();
        if (peek() === ',') i++;
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i));
    if (!m) throw new Error(`invalid value at offset ${i}`);
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0];
  };
  while (i < src.length) {
    wsnl();
    if (i >= src.length) break;
    if (peek() === '[') {
      const arrayTable = src[i + 1] === '[';
      i += arrayTable ? 2 : 1;
      const k = key();
      i += arrayTable ? 2 : 1;
      if (arrayTable) {
        const parent = descend(root, k.slice(0, -1));
        const last = k[k.length - 1]!;
        const list = Array.isArray(parent[last]) ? parent[last] : (parent[last] = []);
        table = obj();
        list.push(table);
      } else table = descend(root, k);
      continue;
    }
    const k = key();
    if (peek() !== '=') throw new Error(`expected "=" after key "${k.join('.')}"`);
    i++;
    assign(table, k, value());
    ws();
    if (peek() === '#') while (i < src.length && src[i] !== '\n') i++;
  }
  return root;
}

function obj(): Record<string, any> {
  return Object.create(null);
}

function descend(t: Record<string, any>, keys: string[]): Record<string, any> {
  let cur = t;
  for (const k of keys) {
    const next = cur[k];
    if (Array.isArray(next)) cur = next[next.length - 1];
    else if (next && typeof next === 'object') cur = next;
    else cur = cur[k] = obj();
  }
  return cur;
}

function assign(t: Record<string, any>, keys: string[], v: unknown): void {
  const parent = descend(t, keys.slice(0, -1));
  parent[keys[keys.length - 1]!] = v;
}
