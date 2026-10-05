// Configuration loading and validation.
//
// The config file (dynamic-monorepo.config.json) is untrusted input. It is parsed
// by a strict JSON parser (duplicate keys rejected, prototype-less objects),
// size-limited, and validated into Maps so no user-controlled key is ever used
// as a property lookup on a plain object (prototype pollution).

import { parseJsonStrict } from './json.ts';
import { compileGlob, validatePattern, type Matcher } from './glob.ts';
import { detect, type Detection } from './detect.ts';
import { Graph } from './graph.ts';
import { importNx, infer, INFER_KINDS, SKIP_DIRS, type Inferred, type InferKind, type RepoReader } from './infer.ts';
import { normalizeDir } from './paths.ts';

export { normalizeDir } from './paths.ts';
export type { RepoReader } from './infer.ts';

export const TARGETS = ['build', 'test', 'deploy', 'docker'] as const;
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
  /** Per-target exclusions: changes matching these don't make the project "changed" for that target. */
  targetExclude: Partial<Record<Target, Matcher[]>>;
  /** Where the project came from, for explanations. */
  source: Source;
  /** Dockerfile found by auto-detection (repo-relative). */
  dockerfile?: string;
};

export type Source = 'projects' | 'discover' | InferKind | 'nx' | 'detect';

export type Config = {
  projects: Map<string, Project>;
  global: Matcher[];
  ignore: Matcher[];
  /** Repository-wide per-target exclusions (top-level "targets"). */
  targetExclude: Record<Target, Matcher[]>;
  /** Fingerprint of settings whose change affects every project. */
  globalsKey: string;
  /** What auto-detection found, when "detect" is on. */
  detection?: Detection;
  /** Non-fatal problems worth surfacing in the log (e.g. a project path that does not exist). */
  warnings: string[];
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`Invalid configuration ${file}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const NAME_RE = /^[A-Za-z0-9@][A-Za-z0-9._@/-]{0,213}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_KEYS = new Set(['$schema', 'version', 'projects', 'detect', 'discover', 'infer', 'import', 'targets', 'global', 'ignore']);
const PROJECT_KEYS = new Set(['path', 'dependsOn', 'targets', 'include', 'exclude']);

export function validateName(name: string): string | undefined {
  if (RESERVED.has(name)) return `"${name}" is a reserved name`;
  if (!NAME_RE.test(name)) {
    return `project name "${truncate(name)}" must match ${NAME_RE} (letters, digits, ".", "_", "@", "/", "-"; max 214 chars)`;
  }
  if (name.includes('//') || name.endsWith('/') || name.includes('..')) return `project name "${name}" must not contain "//" or "..", or end with "/"`;
  return undefined;
}

export function parseConfig(text: string, file: string, reader?: RepoReader): Config {
  if (Buffer.byteLength(text, "utf8") > LIMITS.configBytes) {
    throw new ConfigError(file, [`file is larger than ${LIMITS.configBytes} bytes`]);
  }
  let doc: unknown;
  try {
    doc = parseJsonStrict(text);
  } catch (err) {
    throw new ConfigError(file, [`JSON syntax error: ${(err as Error).message}`]);
  }
  return validateConfig(doc, file, reader);
}

export function validateConfig(doc: unknown, file: string, reader?: RepoReader): Config {
  const problems: string[] = [];
  const warnings: string[] = [];
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
  // Explicitly declared edges, kept separately: a cycle among these is a configuration
  // mistake (hard error), while cycles that come from manifests (e.g. dev-dependencies) are tolerated.
  const explicitEdges = new Map([...projects.values()].map((p) => [p.name, [...p.dependsOn]]));

  // Inferred (ecosystem manifests) and imported (Nx graph) projects come after explicit ones.
  const kinds = stringList(doc['infer'], '"infer"', problems);
  for (const k of kinds) {
    if (!(INFER_KINDS as readonly string[]).includes(k)) problems.push(`"infer" has unknown kind "${truncate(k)}" (allowed: ${INFER_KINDS.join(', ')})`);
  }
  const rawImport = doc['import'];
  let nxFile: string | undefined;
  if (rawImport !== undefined && rawImport !== null) {
    if (!isPlainObject(rawImport) || Object.keys(rawImport).some((k) => k !== 'nx') || typeof rawImport['nx'] !== 'string') {
      problems.push('"import" must be a mapping like { nx: path/to/graph.json }');
    } else {
      const n = normalizeDir(rawImport['nx']);
      if ('error' in n) problems.push(`"import.nx" ${n.error}`);
      else nxFile = n.path;
    }
  }
  if (reader) {
    const found = [
      ...kinds.filter((k): k is InferKind => (INFER_KINDS as readonly string[]).includes(k)).flatMap((k) => infer(k, reader, problems)),
      ...(nxFile ? importNx(reader, nxFile, problems) : []),
    ];
    mergeInferred(found, projects, problems, warnings);
  }

  // Auto-detected projects (marker files) come after explicit, inferred and imported ones.
  const detectOn = doc['detect'] ?? false;
  if (typeof detectOn !== 'boolean') problems.push('"detect" must be true or false');
  let detection: Detection | undefined;
  if (detectOn === true && reader) {
    detection = detect(reader, (n) => validateName(n) === undefined, problems);
    mergeDetected(detection, projects);
  }

  const discover = stringList(doc['discover'], '"discover"', problems);
  for (const pattern of discover) {
    discoverProjects(pattern, projects, problems, warnings, reader);
  }

  if (projects.size === 0 && problems.length === 0) {
    problems.push(detectOn === true
      ? 'no projects found. Auto-detection looks for package.json, go.mod, Cargo.toml, pyproject.toml, setup.py, pom.xml, ' +
        'build.gradle(.kts), *.csproj, Dockerfile, Containerfile and Chart.yaml in committed files (skipping node_modules, vendor, dist, build, ' +
        'target, fixtures and dot-directories). Add one of those, or list your projects under "projects" in dynamic-monorepo.config.json'
      : 'no projects defined (add "projects", "detect", "infer", "import" or "discover")');
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
  let hints = 0;
  for (const p of projects.values()) {
    for (const dep of p.dependsOn) {
      if (!projects.has(dep)) {
        const hint = hints++ < 20 ? suggest(dep, [...projects.keys()]) : undefined;
        problems.push(`project "${p.name}" depends on unknown project "${dep}"${hint ? ` (did you mean "${hint}"?)` : ''}`);
      }
    }
  }

  const global = globList(doc['global'], '"global"', problems);
  const ignore = globList(doc['ignore'], '"ignore"', problems);
  const targetExclude = parseGlobalTargets(doc['targets'], problems);

  if (problems.length > 0) throw new ConfigError(file, problems);
  // Throws CycleError (with the full cycle) for cycles among explicitly declared dependencies.
  new Graph([...projects.keys()].map((name) => ({ name, dependsOn: explicitEdges.get(name) ?? [] })));
  const dirs = reader?.dirs?.();
  if (dirs) {
    for (const p of projects.values()) {
      if (p.path !== '.' && !dirs.has(p.path)) warnings.push(`project "${p.name}" path "${p.path}" does not exist in the repository (check spelling and letter case)`);
    }
  }
  const pats = (ms: Matcher[]) => ms.map((m) => m.pattern).sort();
  const globalsKey = JSON.stringify([pats(global), pats(ignore), TARGETS.map((t) => pats(targetExclude[t]))]);
  return { projects, global, ignore, targetExclude, globalsKey, detection, warnings };
}

/**
 * Adds auto-detected projects. An existing project at the same path wins (its
 * settings are kept, detected dependencies and Dockerfile are added). A detected
 * name already used by a project elsewhere falls back to the directory path.
 */
function mergeDetected(d: Detection, projects: Map<string, Project>): void {
  const byPath = new Map([...projects.values()].map((p) => [p.path, p]));
  const finalName = new Map<string, string>(); // detected name -> project name
  for (const f of d.projects) {
    const safe = normalizeDir(f.path);
    if ('error' in safe) {
      d.notes.push(`skipped "${f.path.slice(0, 80)}": the directory name ${safe.error}`);
      continue;
    }
    const existing = byPath.get(f.path);
    if (existing) {
      finalName.set(f.name, existing.name);
      existing.dockerfile ??= f.dockerfile;
      continue;
    }
    let name = f.name;
    if (projects.has(name)) name = f.path;
    if (projects.has(name) || validateName(name) !== undefined) {
      d.notes.push(`skipped "${f.path}": the name "${f.name}" is already used by another project`);
      continue;
    }
    finalName.set(f.name, name);
    const p: Project = {
      name, path: f.path, dependsOn: [], targets: f.targets, include: f.include.map(compileGlob), exclude: [], targetExclude: {},
      source: 'detect', dockerfile: f.dockerfile,
    };
    projects.set(name, p);
    byPath.set(f.path, p);
  }
  for (const f of d.projects) {
    const target = projects.get(finalName.get(f.name) ?? '');
    if (!target) continue;
    const deps = new Set(target.dependsOn);
    for (const dep of f.dependsOn) {
      const resolved = finalName.get(dep);
      if (resolved && resolved !== target.name) deps.add(resolved);
    }
    target.dependsOn = [...deps].sort();
  }
}

/**
 * Adds inferred projects. An explicit project with the same name or path wins,
 * but inferred dependency edges are kept (unioned), so you only declare what
 * the manifests cannot express.
 */
function mergeInferred(found: Inferred[], projects: Map<string, Project>, problems: string[], warnings: string[]): void {
  const byPath = new Map([...projects.values()].map((p) => [p.path, p.name]));
  const alias = new Map<string, string>(); // inferred name -> final project name
  for (const f of found) {
    const dir = normalizeDir(f.path);
    if ('error' in dir) {
      problems.push(`infer ${f.via}: "${truncate(f.path)}" ${dir.error}`);
      continue;
    }
    const sameName = projects.get(f.name);
    const samePath = byPath.has(dir.path) ? projects.get(byPath.get(dir.path)!) : undefined;
    if (sameName && sameName.path !== dir.path && sameName.source !== 'projects') {
      problems.push(`infer ${f.via}: "${f.name}" found at both "${sameName.path}" and "${dir.path}"`);
      continue;
    }
    const existing = sameName ?? samePath;
    if (sameName && sameName.path !== dir.path) {
      warnings.push(`infer ${f.via}: "${f.name}" at "${dir.path}" is overridden by the explicit project of the same name at "${sameName.path}"`);
    }
    if (existing) {
      alias.set(f.name, existing.name);
      continue;
    }
    const nameProblem = validateName(f.name);
    if (nameProblem) {
      problems.push(`infer ${f.via}: ${nameProblem}`);
      continue;
    }
    alias.set(f.name, f.name);
    byPath.set(dir.path, f.name);
    projects.set(f.name, {
      name: f.name, path: dir.path, dependsOn: [], targets: [...DEFAULT_TARGETS], include: [], exclude: [], targetExclude: {},
      source: f.via as Source,
    });
  }
  for (const f of found) {
    const target = projects.get(alias.get(f.name) ?? '');
    if (!target) continue;
    const deps = new Set(target.dependsOn);
    for (const d of f.dependsOn) {
      const resolved = alias.get(d);
      if (resolved && resolved !== target.name) deps.add(resolved);
    }
    target.dependsOn = [...deps].sort();
  }
}

/** Top-level `targets: { deploy: { exclude: [...] } }` applies to every project. */
function parseGlobalTargets(raw: unknown, problems: string[]): Record<Target, Matcher[]> {
  const out = Object.fromEntries(TARGETS.map((t) => [t, [] as Matcher[]])) as Record<Target, Matcher[]>;
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) {
    problems.push('top-level "targets" must be a mapping like { deploy: { exclude: ["**/*.test.ts"] } }');
    return out;
  }
  for (const [t, settings] of Object.entries(raw)) {
    if (!(TARGETS as readonly string[]).includes(t)) {
      problems.push(`top-level "targets" has unknown target "${truncate(t)}" (allowed: ${TARGETS.join(', ')})`);
    } else if (!isPlainObject(settings) || Object.keys(settings).some((k) => k !== 'exclude')) {
      problems.push(`top-level "targets.${t}" must be { exclude: [globs] }`);
    } else {
      out[t as Target] = globList(settings['exclude'], `"targets.${t}.exclude"`, problems);
    }
  }
  return out;
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
  const { targets, targetExclude } = parseTargets(raw['targets'], where, problems);
  return {
    name,
    path: dir.path,
    dependsOn,
    targets,
    include: globList(raw['include'], `${where} "include"`, problems),
    exclude: globList(raw['exclude'], `${where} "exclude"`, problems),
    targetExclude,
    source: 'projects',
  };
}

/** `targets` is a list (`[build, test]`) or a mapping (`{ build: {}, deploy: { exclude: [globs] } }`). */
function parseTargets(raw: unknown, where: string, problems: string[]): { targets: Target[]; targetExclude: Partial<Record<Target, Matcher[]>> } {
  const targetExclude: Partial<Record<Target, Matcher[]>> = {};
  if (raw === undefined || raw === null) return { targets: [...DEFAULT_TARGETS], targetExclude };
  const list: string[] = [];
  if (isPlainObject(raw)) {
    for (const [t, settings] of Object.entries(raw)) {
      list.push(t);
      if (settings === null || settings === true) continue;
      if (!isPlainObject(settings) || Object.keys(settings).some((k) => k !== 'exclude')) {
        problems.push(`${where} target "${truncate(t)}" settings must be empty or { exclude: [globs] }`);
      } else if ((TARGETS as readonly string[]).includes(t)) {
        targetExclude[t as Target] = globList(settings['exclude'], `${where} target "${t}" "exclude"`, problems);
      }
    }
  } else {
    list.push(...stringList(raw, `${where} "targets"`, problems));
  }
  const out: Target[] = [];
  for (const t of list) {
    if ((TARGETS as readonly string[]).includes(t)) {
      if (!out.includes(t as Target)) out.push(t as Target);
    } else {
      problems.push(`${where} has unknown target "${truncate(t)}" (allowed: ${TARGETS.join(', ')})`);
    }
  }
  return { targets: TARGETS.filter((t) => out.includes(t)), targetExclude };
}

/**
 * Expands a discover pattern of the form "<dir>/*" into one project per
 * immediate sub-directory, named after the directory. Explicit "projects"
 * entries win over discovered ones (same name or same path).
 */
function discoverProjects(pattern: string, projects: Map<string, Project>, problems: string[], warnings: string[], reader?: RepoReader): void {
  const m = /^(.*?)\/?\*$/.exec(pattern);
  const base = m ? normalizeDir(m[1] === '' ? '.' : m[1]) : undefined;
  if (!m || !base || 'error' in base) {
    problems.push(`"discover" entry "${truncate(pattern)}" must look like "<dir>/*" (one level, e.g. "packages/*")`);
    return;
  }
  if (!reader) return;
  const explicitPaths = new Set([...projects.values()].map((p) => p.path));
  for (const dirName of reader.listDirs(base.path).sort()) {
    if (dirName.startsWith('.') || SKIP_DIRS.has(dirName)) continue;
    const path = base.path === '.' ? dirName : `${base.path}/${dirName}`;
    if (explicitPaths.has(path)) continue;
    const existing = projects.get(dirName);
    if (existing) {
      if (existing.source !== 'discover') continue; // explicit or inferred entry overrides
      problems.push(`discovered projects "${existing.path}" and "${path}" share the name "${dirName}"; declare one explicitly under "projects"`);
      continue;
    }
    const nameProblem = validateName(dirName);
    if (nameProblem) {
      warnings.push(`skipped discovered directory "${truncate(path)}": ${nameProblem}`);
      continue;
    }
    projects.set(dirName, {
      name: dirName, path, dependsOn: [], targets: [...DEFAULT_TARGETS], include: [], exclude: [], targetExclude: {}, source: 'discover',
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
  const pats = (ms: Matcher[] | undefined) => ms?.map((m) => m.pattern).sort() ?? null;
  return JSON.stringify([p.path, p.dependsOn, p.targets, pats(p.include), pats(p.exclude), TARGETS.map((t) => pats(p.targetExclude[t]))]);
}
