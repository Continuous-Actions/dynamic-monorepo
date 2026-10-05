// Configuration loading and validation.
//
// The config file is untrusted input. It is parsed with js-yaml's CORE schema
// (no custom tags, no merge keys), size-limited, and then validated into
// Maps/frozen objects so no user-controlled key is ever used as a property
// lookup on a plain object (prototype pollution).

import { load, CORE_SCHEMA } from 'js-yaml';
import { compileGlob, validatePattern, type Matcher } from './glob.ts';

export const TARGETS = ['build', 'test', 'deploy'] as const;
export type Target = (typeof TARGETS)[number];
export const DEFAULT_TARGETS: readonly Target[] = ['build', 'test'];

export const LIMITS = {
  configBytes: 1024 * 1024,
  projects: 50_000,
  patternsPerList: 1_000,
  dependsOnPerProject: 1_000,
} as const;

export type Project = {
  name: string;
  /** Normalised repo-relative directory; "." means the repository root. */
  path: string;
  dependsOn: string[];
  targets: Target[];
  include: Matcher[];
  exclude: Matcher[];
  /** Where the project came from, for explanations. */
  source: 'projects' | 'discover';
};

export type Config = {
  projects: Map<string, Project>;
  global: Matcher[];
  ignore: Matcher[];
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`Invalid configuration ${file}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Lists immediate sub-directory names of a repo-relative directory. */
export type ListDirs = (dir: string) => string[];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_KEYS = new Set(['version', 'projects', 'discover', 'global', 'ignore']);
const PROJECT_KEYS = new Set(['path', 'dependsOn', 'targets', 'include', 'exclude']);

export function validateName(name: string): string | undefined {
  if (RESERVED.has(name)) return `"${name}" is a reserved name`;
  if (!NAME_RE.test(name)) {
    return `project name "${truncate(name)}" must match ${NAME_RE} (letters, digits, ".", "_", "@", "/", "-"; max 128 chars)`;
  }
  if (name.includes('//') || name.endsWith('/')) return `project name "${name}" must not contain "//" or end with "/"`;
  return undefined;
}

/** Normalises a repo-relative directory path or returns an error string. */
export function normalizeDir(raw: unknown): { path: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'must be a string' };
  if (raw.length === 0 || raw.length > 1024) return { error: 'must be 1-1024 characters' };
  if (raw.includes('\0')) return { error: 'must not contain NUL bytes' };
  if (raw.includes('\\')) return { error: 'must use "/" separators' };
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return { error: 'must be relative to the repository root' };
  if (/[*?[\]{}]/.test(raw)) return { error: 'must be a directory, not a glob (use "discover" or "include")' };
  const parts = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.includes('..')) return { error: 'must not contain ".." segments' };
  if (parts.includes('.git')) return { error: 'must not point inside .git' };
  return { path: parts.length === 0 ? '.' : parts.join('/') };
}

export function parseConfig(text: string, file: string, listDirs?: ListDirs): Config {
  if (Buffer.byteLength(text, 'utf8') > LIMITS.configBytes) {
    throw new ConfigError(file, [`file is larger than ${LIMITS.configBytes} bytes`]);
  }
  let doc: unknown;
  try {
    doc = load(text, { schema: CORE_SCHEMA, filename: file });
  } catch (err) {
    throw new ConfigError(file, [`YAML syntax error: ${(err as Error).message.split('\n')[0]}`]);
  }
  return validateConfig(doc, file, listDirs);
}

export function validateConfig(doc: unknown, file: string, listDirs?: ListDirs): Config {
  const problems: string[] = [];
  if (!isPlainObject(doc)) throw new ConfigError(file, ['top level must be a mapping']);

  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.has(key)) problems.push(`unknown top-level key "${truncate(key)}" (allowed: ${[...TOP_KEYS].join(', ')})`);
  }
  const version = doc['version'];
  if (version !== undefined && version !== 1) problems.push('"version" must be 1');

  const projects = new Map<string, Project>();
  const rawProjects = doc['projects'];
  if (rawProjects !== undefined && rawProjects !== null && !isPlainObject(rawProjects)) {
    problems.push('"projects" must be a mapping of project name to settings');
  } else if (rawProjects) {
    for (const [name, raw] of Object.entries(rawProjects)) {
      const p = validateProject(name, raw, problems);
      if (p) projects.set(name, p);
    }
  }

  const discover = stringList(doc['discover'], '"discover"', problems);
  for (const pattern of discover) {
    discoverProjects(pattern, projects, problems, listDirs);
  }

  if (projects.size === 0 && problems.length === 0) {
    problems.push('no projects defined (add "projects" or "discover")');
  }
  if (projects.size > LIMITS.projects) problems.push(`more than ${LIMITS.projects} projects`);

  // Two projects may not claim the same directory: ownership would be ambiguous.
  const byPath = new Map<string, string>();
  for (const p of projects.values()) {
    const other = byPath.get(p.path);
    if (other) problems.push(`projects "${other}" and "${p.name}" both use path "${p.path}"`);
    else byPath.set(p.path, p.name);
  }

  // Missing dependencies are reported here; cycles are reported by the graph.
  for (const p of projects.values()) {
    for (const dep of p.dependsOn) {
      if (!projects.has(dep)) {
        const hint = suggest(dep, [...projects.keys()]);
        problems.push(`project "${p.name}" depends on unknown project "${dep}"${hint ? ` (did you mean "${hint}"?)` : ''}`);
      }
    }
  }

  const global = globList(doc['global'], '"global"', problems);
  const ignore = globList(doc['ignore'], '"ignore"', problems);

  if (problems.length > 0) throw new ConfigError(file, problems);
  return { projects, global, ignore };
}

function validateProject(name: string, raw: unknown, problems: string[]): Project | undefined {
  const nameProblem = validateName(name);
  if (nameProblem) {
    problems.push(nameProblem);
    return undefined;
  }
  const where = `project "${name}"`;
  if (!isPlainObject(raw)) {
    problems.push(`${where} must be a mapping with at least "path"`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!PROJECT_KEYS.has(key)) {
      problems.push(`${where} has unknown key "${truncate(key)}" (allowed: ${[...PROJECT_KEYS].join(', ')})`);
    }
  }
  const dir = normalizeDir(raw['path']);
  if ('error' in dir) {
    problems.push(`${where}: "path" ${raw['path'] === undefined ? 'is required' : dir.error}`);
    return undefined;
  }
  const dependsOn = [...new Set(stringList(raw['dependsOn'], `${where} "dependsOn"`, problems))].sort();
  if (dependsOn.length > LIMITS.dependsOnPerProject) problems.push(`${where} has too many dependencies`);
  const targets = parseTargets(raw['targets'], where, problems);
  return {
    name,
    path: dir.path,
    dependsOn,
    targets,
    include: globList(raw['include'], `${where} "include"`, problems),
    exclude: globList(raw['exclude'], `${where} "exclude"`, problems),
    source: 'projects',
  };
}

function parseTargets(raw: unknown, where: string, problems: string[]): Target[] {
  if (raw === undefined) return [...DEFAULT_TARGETS];
  const list = stringList(raw, `${where} "targets"`, problems);
  const out: Target[] = [];
  for (const t of list) {
    if ((TARGETS as readonly string[]).includes(t)) {
      if (!out.includes(t as Target)) out.push(t as Target);
    } else {
      problems.push(`${where} has unknown target "${truncate(t)}" (allowed: ${TARGETS.join(', ')})`);
    }
  }
  return TARGETS.filter((t) => out.includes(t));
}

/**
 * Expands a discover pattern of the form "<dir>/*" into one project per
 * immediate sub-directory, named after the directory. Explicit "projects"
 * entries win over discovered ones (same name or same path).
 */
function discoverProjects(pattern: string, projects: Map<string, Project>, problems: string[], listDirs?: ListDirs): void {
  const m = /^(.*?)\/?\*$/.exec(pattern);
  const base = m ? normalizeDir(m[1] === '' ? '.' : m[1]) : undefined;
  if (!m || !base || 'error' in base) {
    problems.push(`"discover" entry "${truncate(pattern)}" must look like "<dir>/*" (one level, e.g. "packages/*")`);
    return;
  }
  if (!listDirs) return;
  const explicitPaths = new Set([...projects.values()].map((p) => p.path));
  const discovered = new Map<string, string>();
  for (const dirName of listDirs(base.path).sort()) {
    if (dirName.startsWith('.')) continue;
    const path = base.path === '.' ? dirName : `${base.path}/${dirName}`;
    if (explicitPaths.has(path)) continue;
    const existing = projects.get(dirName);
    if (existing) {
      if (existing.source === 'projects') continue; // explicit entry overrides
      problems.push(`discovered projects "${existing.path}" and "${path}" share the name "${dirName}"; declare one explicitly under "projects"`);
      continue;
    }
    const nameProblem = validateName(dirName);
    if (nameProblem) {
      problems.push(`discovered directory "${truncate(path)}": ${nameProblem}`);
      continue;
    }
    discovered.set(dirName, path);
    projects.set(dirName, {
      name: dirName, path, dependsOn: [], targets: [...DEFAULT_TARGETS], include: [], exclude: [], source: 'discover',
    });
  }
}

function stringList(raw: unknown, where: string, problems: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
    problems.push(`${where} must be a string or a list of strings`);
    return [];
  }
  if (list.length > LIMITS.patternsPerList) {
    problems.push(`${where} has more than ${LIMITS.patternsPerList} entries`);
    return [];
  }
  return list as string[];
}

function globList(raw: unknown, where: string, problems: string[]): Matcher[] {
  const out: Matcher[] = [];
  for (const pattern of stringList(raw, where, problems)) {
    const problem = validatePattern(pattern);
    if (problem) problems.push(`${where}: glob "${truncate(pattern)}" ${problem}`);
    else out.push(compileGlob(pattern));
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Closest name by edit distance, for "did you mean" hints. */
function suggest(name: string, candidates: string[]): string | undefined {
  if (candidates.length > 2000) return undefined;
  let best: string | undefined;
  let bestDist = Math.max(2, Math.floor(name.length / 3)) + 1;
  for (const c of candidates) {
    const d = editDistance(name, c, bestDist);
    if (d < bestDist) [best, bestDist] = [c, d];
  }
  return best;
}

function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) >= cap) return cap;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Stable fingerprint of everything about a project that affects planning. */
export function projectFingerprint(p: Project): string {
  return JSON.stringify([p.path, p.dependsOn, p.targets, p.include.map((m) => m.pattern), p.exclude.map((m) => m.pattern)]);
}
