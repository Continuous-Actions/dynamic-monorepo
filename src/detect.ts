// Auto-detection: find projects from marker files in the committed tree.
//
// A project is a directory that contains a marker file (package.json, go.mod,
// Dockerfile, ...). Dependencies come from the manifests themselves. Files are
// only read, never executed, and the scan is bounded.

import type { Target } from './config.ts';
import { load, CORE_SCHEMA } from 'js-yaml';
import { compileSegments, validatePattern } from './glob.ts';
import { parseToml, resolveRel, stripGoComments, type RepoReader } from './infer.ts';

export const DETECT_KINDS = ['node', 'go', 'cargo', 'python', 'maven', 'gradle', 'dotnet', 'docker', 'helm'] as const;
export type DetectKind = (typeof DETECT_KINDS)[number];

export type DetectedProject = {
  name: string;
  path: string;
  dependsOn: string[];
  targets: Target[];
  /** Root lockfiles that belong to the project's ecosystem. */
  include: string[];
  kinds: DetectKind[];
  dockerfile?: string;
};

export type Detection = {
  projects: DetectedProject[];
  /** Root lockfiles and the ecosystem whose projects they select. */
  lockfiles: { file: string; kind: DetectKind; projects: number }[];
  /** Marker files that were skipped, and why. */
  notes: string[];
};

export const DETECT_LIMITS = { files: 2_000_000, projects: 50_000, manifestBytes: 1024 * 1024 } as const;

/** Directories that never contain projects: dependencies, build output and test fixtures. Dot-directories are skipped too. */
export const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'out', 'bin', 'obj', 'testdata', 'fixtures', '__fixtures__', '__tests__']);

const LOCKFILES: [string, DetectKind][] = [
  ['package-lock.json', 'node'], ['npm-shrinkwrap.json', 'node'], ['yarn.lock', 'node'], ['pnpm-lock.yaml', 'node'], ['bun.lock', 'node'], ['bun.lockb', 'node'],
  ['go.work.sum', 'go'], ['Cargo.lock', 'cargo'], ['poetry.lock', 'python'], ['uv.lock', 'python'], ['Pipfile.lock', 'python'],
];

/** What a file name marks, if anything. */
export function markerKind(base: string): DetectKind | undefined {
  switch (base) {
    case 'package.json': return 'node';
    case 'go.mod': return 'go';
    case 'Cargo.toml': return 'cargo';
    case 'pyproject.toml': case 'setup.py': return 'python';
    case 'pom.xml': return 'maven';
    case 'build.gradle': case 'build.gradle.kts': return 'gradle';
    case 'Chart.yaml': return 'helm';
    case 'Dockerfile': case 'Containerfile': return 'docker';
  }
  if (/^Dockerfile\.[^/]+$/.test(base) || /^[^/]+\.Dockerfile$/.test(base) || /^Containerfile\.[^/]+$/.test(base)) return 'docker';
  if (/\.(cs|fs|vb)proj$/.test(base)) return 'dotnet';
  return undefined;
}

const dirOf = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.');
const skipped = (file: string) => file.split('/').slice(0, -1).some((seg) => seg.startsWith('.') || SKIP_DIRS.has(seg));

function json(text: string | undefined): any {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text.replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function toml(text: string | undefined): any {
  if (text === undefined) return undefined;
  try {
    return parseToml(text);
  } catch {
    return undefined;
  }
}

/**
 * Scans the committed files for markers. `validName` decides whether a
 * candidate name is usable (the config's project-name rules).
 */
export function detect(reader: RepoReader, validName: (name: string) => boolean, problems: string[]): Detection {
  const notes: string[] = [];
  const files = reader.listFiles();
  if (files.length > DETECT_LIMITS.files) {
    problems.push(`detect: the repository has more than ${DETECT_LIMITS.files} files; set "detect": false and list projects under "projects"`);
    return { projects: [], lockfiles: [], notes };
  }

  // 1. Directories with markers.
  const dirs = new Map<string, { kinds: Set<DetectKind>; markers: string[] }>();
  const skippedMarkers: string[] = [];
  for (const file of files) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    const kind = markerKind(base);
    if (!kind) continue;
    if (skipped(file)) {
      if (!file.split('/').includes('node_modules')) skippedMarkers.push(file);
      continue;
    }
    const dir = dirOf(file);
    const d = dirs.get(dir) ?? { kinds: new Set(), markers: [] };
    d.kinds.add(kind);
    d.markers.push(file);
    dirs.set(dir, d);
  }

  if (skippedMarkers.length > 0) {
    notes.push(`${skippedMarkers.length} marker file(s) inside skipped folders (${[...SKIP_DIRS].slice(0, 4).join(', ')}, …, dot-folders) were ignored, e.g. "${skippedMarkers.sort()[0]}"; declare such projects under "projects" to include them`);
  }

  // 2. Read the manifests that carry names or dependencies (one git process).
  const manifestNames = new Set(['package.json', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml']);
  const toRead = [...dirs.values()].flatMap((d) => d.markers).filter((f) => manifestNames.has(f.slice(f.lastIndexOf('/') + 1)) || /\.(cs|fs|vb)proj$/.test(f));
  const fileSet = new Set(files);
  if (!dirs.has('.') && fileSet.has('Cargo.toml')) toRead.push('Cargo.toml');
  if (!dirs.has('.') && fileSet.has('package.json')) toRead.push('package.json');
  if (fileSet.has('pnpm-workspace.yaml')) toRead.push('pnpm-workspace.yaml');
  const text = reader.readMany(toRead);
  const at = (dir: string, base: string) => text.get(dir === '.' ? base : `${dir}/${base}`);

  // A root package.json that declares workspaces, or a Cargo.toml without [package], is a workspace root, not a project.
  const rootPkg = json(at('.', 'package.json'));
  const drop = (dir: string, kind: DetectKind, why: string) => {
    const d = dirs.get(dir);
    if (!d?.kinds.delete(kind)) return;
    d.markers = d.markers.filter((m) => markerKind(m.slice(m.lastIndexOf('/') + 1)) !== kind);
    if (d.kinds.size === 0) dirs.delete(dir);
    notes.push(why);
  };
  if (rootPkg && (rootPkg.workspaces !== undefined || fileSet.has('pnpm-workspace.yaml'))) {
    drop('.', 'node', 'the root package.json is a workspace root (workspaces or pnpm-workspace.yaml), so it is not a project itself');
  }
  const cargoManifests = new Map<string, any>();
  for (const [dir, d] of [...dirs]) {
    if (!d.kinds.has('cargo')) continue;
    const m = toml(at(dir, 'Cargo.toml'));
    if (m?.package && typeof m.package === 'object') cargoManifests.set(dir, m);
    else drop(dir, 'cargo', `${dir === '.' ? '' : `${dir}/`}Cargo.toml has no [package] (workspace root), so it is not a project itself`);
  }
  // 2b. Go modules that build several binaries (several `package main` dirs under one go.mod)
  //     are split into one project per package, linked by the module's own imports, so a
  //     change to internal/foo selects only the binaries that (transitively) import it.
  const goPkgs = splitGoModules(dirs, files, reader, notes);

  if (dirs.size > DETECT_LIMITS.projects) {
    problems.push(`detect: found more than ${DETECT_LIMITS.projects} projects; set "detect": false and list projects under "projects"`);
    return { projects: [], lockfiles: [], notes };
  }

  // 3. Names: the package name when it is unique and valid, otherwise the directory path.
  const pkgName = new Map<string, string>();
  for (const [dir, d] of dirs) {
    const n = d.kinds.has('node') ? json(at(dir, 'package.json'))?.name : cargoManifests.get(dir)?.package?.name;
    if (typeof n === 'string' && validName(n)) pkgName.set(dir, n);
  }
  const counts = new Map<string, number>();
  for (const n of pkgName.values()) counts.set(n, (counts.get(n) ?? 0) + 1);
  const nameOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const dir of [...dirs.keys()].sort()) {
    const p = pkgName.get(dir);
    if (p !== undefined && counts.get(p) === 1 && !dirs.has(p)) nameOf.set(dir, p);
  }
  for (const n of nameOf.values()) taken.add(n);
  for (const dir of [...dirs.keys()].sort()) {
    if (nameOf.has(dir)) continue;
    const n = dir === '.' ? 'root' : dir;
    if (!validName(n) || taken.has(n)) {
      notes.push(`skipped "${dir}": its directory path is not a valid project name; declare it under "projects"`);
      dirs.delete(dir);
      continue;
    }
    nameOf.set(dir, n);
    taken.add(n);
  }

  // Workspace membership (npm/Yarn/Bun `workspaces`, pnpm-workspace.yaml). Without a
  // workspace declaration every package.json folder counts as a member.
  const wsPatterns: string[] = [];
  const rootWs = rootPkg?.workspaces;
  if (Array.isArray(rootWs)) wsPatterns.push(...rootWs);
  else if (Array.isArray(rootWs?.packages)) wsPatterns.push(...rootWs.packages);
  const pnpmWs = text.get('pnpm-workspace.yaml');
  if (pnpmWs !== undefined) {
    try {
      const doc = load(pnpmWs, { schema: CORE_SCHEMA }) as any;
      if (Array.isArray(doc?.packages)) wsPatterns.push(...doc.packages);
    } catch {
      // unreadable pnpm-workspace.yaml: fall back to treating every package as a member
    }
  }
  const clean = (p: string) => p.replace(/^!/, '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const memberTests = wsPatterns.filter((p) => typeof p === 'string' && !p.startsWith('!') && validatePattern(clean(p)) === undefined).map((p) => compileSegments(clean(p)));
  const excludeTests = wsPatterns.filter((p) => typeof p === 'string' && p.startsWith('!') && validatePattern(clean(p)) === undefined).map((p) => compileSegments(clean(p)));
  const isWorkspaceMember = (dir: string) =>
    memberTests.length === 0 || (memberTests.some((t) => t(dir)) && !excludeTests.some((t) => t(dir)));

  // 4. Dependencies between detected projects, from the manifests.
  const edges = new Map<string, Set<string>>([...dirs.keys()].map((d) => [d, new Set<string>()]));
  const link = (from: string, toDir: string | undefined) => {
    if (toDir !== undefined && toDir !== from && dirs.has(toDir)) edges.get(from)!.add(toDir);
  };
  const nodeByName = new Map<string, string>();
  const ambiguous = new Set<string>();
  const goByModule = new Map<string, string>();
  for (const [dir, d] of dirs) {
    if (d.kinds.has('node')) {
      const n = json(at(dir, 'package.json'))?.name;
      if (typeof n === 'string' && isWorkspaceMember(dir)) {
        if (nodeByName.has(n) && nodeByName.get(n) !== dir) ambiguous.add(n);
        else nodeByName.set(n, dir);
      }
    }
    if (d.kinds.has('go')) {
      const mod = /^\s*module\s+(\S+)/m.exec(stripGoComments(at(dir, 'go.mod') ?? ''))?.[1]?.replace(/^"|"$/g, '');
      if (mod) goByModule.set(mod, dir);
    }
  }
  // Maven: artifactId -> directory, and which poms only aggregate modules (packaging "pom").
  const poms = new Map<string, Pom>();
  const mavenByArtifact = new Map<string, string>();
  for (const [dir, d] of dirs) {
    if (!d.kinds.has('maven')) continue;
    const pom = parsePom(at(dir, 'pom.xml'));
    if (!pom) continue;
    poms.set(dir, pom);
    if (pom.artifactId) mavenByArtifact.set(pom.artifactId, dir);
  }
  // A package name used by two folders can't be resolved to one project: drop those edges and say so.
  for (const n of [...ambiguous].sort()) {
    nodeByName.delete(n);
    notes.push(`package name "${n}" is used by more than one folder; dependencies on it are ignored (rename one, or declare the edge with "dependsOn")`);
  }
  const rootCargo = cargoManifests.get('.') ?? toml(text.get('Cargo.toml'));
  const wsDeps: Record<string, any> = rootCargo?.workspace?.dependencies ?? {};
  for (const [dir, d] of dirs) {
    if (d.kinds.has('node')) {
      const pkg = json(at(dir, 'package.json'));
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = pkg?.[field];
        // Only workspace members resolve sibling packages locally; a package outside the
        // workspace globs (e.g. examples/*) installs the published version from the registry.
        if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
        for (const [k, spec] of Object.entries<unknown>(deps)) {
          // Explicit local protocols always point at a local package.
          const local = typeof spec === 'string' && /^(workspace|file|link|portal):/.test(spec);
          // Without a workspace declaration, npm/Yarn/pnpm install plain version ranges from
          // the registry, so only explicit local protocols create edges.
          if (local || (memberTests.length > 0 && isWorkspaceMember(dir))) link(dir, nodeByName.get(k));
        }
      }
    }
    if (d.kinds.has('go')) {
      const mod = stripGoComments(at(dir, 'go.mod') ?? '');
      for (const m of mod.matchAll(/^\s*(?:require|replace)\s*\(([\s\S]*?)\)|^\s*(?:require|replace)\s+([^\n]+)/gm)) {
        for (const line of (m[1] ?? m[2] ?? '').split('\n')) {
          const first = line.trim().split(/\s+/)[0]?.replace(/^"|"$/g, '');
          if (first) link(dir, goByModule.get(first));
          const local = /=>\s*(\.{1,2}\/\S*)/.exec(line)?.[1];
          if (local) link(dir, resolveRel(dir, local));
        }
      }
    }
    if (d.kinds.has('python')) {
      // Local path dependencies: uv `[tool.uv.sources] x = { path = "../x" }`, Poetry
      // `x = { path = "../x" }` (main and group dependencies), PDM/Hatch `x @ file:///${PROJECT_ROOT}/../x`.
      const py = toml(at(dir, 'pyproject.toml'));
      const tables: any[] = [py?.tool?.uv?.sources, py?.tool?.poetry?.dependencies, py?.tool?.poetry?.['dev-dependencies']];
      for (const g of Object.values<any>(py?.tool?.poetry?.group ?? {})) tables.push(g?.dependencies);
      for (const t of tables) {
        if (!t || typeof t !== 'object') continue;
        for (const spec of Object.values<any>(t)) {
          const entries = Array.isArray(spec) ? spec : [spec];
          for (const e of entries) if (typeof e?.path === 'string') link(dir, resolveRel(dir, e.path));
        }
      }
      const reqs = [...(Array.isArray(py?.project?.dependencies) ? py.project.dependencies : []),
        ...Object.values<any>(py?.project?.['optional-dependencies'] ?? {}).flat()];
      for (const r of reqs) {
        const m = typeof r === 'string' ? /@\s*file:(?:\/\/)?(?:\$\{PROJECT_ROOT\}\/)?(\S+)/.exec(r) : null;
        if (m) link(dir, resolveRel(dir, m[1]!.replace(/^\/+/, '')));
      }
    }
    const crate = cargoManifests.get(dir);
    if (crate) {
      for (const table of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
        const deps = crate[table];
        if (!deps || typeof deps !== 'object') continue;
        for (const [key, spec] of Object.entries<any>(deps)) {
          if (typeof spec?.path === 'string') link(dir, resolveRel(dir, spec.path));
          else if (spec?.workspace === true && typeof wsDeps[key]?.path === 'string') link(dir, resolveRel('.', wsDeps[key].path));
        }
      }
    }
    for (const imp of goPkgs.get(dir)?.imports ?? []) link(dir, imp);
    const pom = poms.get(dir);
    if (pom) {
      // A module depends on its parent pom (shared versions and plugins) and on sibling artifacts it uses.
      if (pom.parent) link(dir, mavenByArtifact.get(pom.parent));
      for (const dep of pom.dependencies) {
        // A pinned version that differs from the local module's means the published artifact.
        const target = mavenByArtifact.get(dep.artifactId);
        const local = target ? poms.get(target)?.version : undefined;
        if (dep.version && !dep.version.includes('${') && local && dep.version !== local) continue;
        link(dir, target);
      }
    }
    if (d.kinds.has('gradle')) {
      const script = at(dir, 'build.gradle') ?? at(dir, 'build.gradle.kts') ?? '';
      // project(':libs:core') -> libs/core (Gradle's default project directory layout).
      for (const m of stripGoComments(script).matchAll(/project\s*\(\s*(?:path\s*[:=]\s*)?["']:([^"']+)["']/g)) {
        link(dir, m[1]!.replace(/:/g, '/'));
      }
    }
    for (const proj of d.markers.filter((m) => /\.(cs|fs|vb)proj$/.test(m))) {
      for (const m of (text.get(proj) ?? '').matchAll(/<ProjectReference\s+Include\s*=\s*"([^"]+)"/g)) {
        const target = resolveRel(dir, m[1]!.replace(/\\/g, '/'));
        if (target !== undefined) link(dir, dirOf(target));
      }
    }
  }

  // 5. Targets, Dockerfiles and root lockfiles.
  const kindCount = new Map<DetectKind, number>();
  for (const d of dirs.values()) for (const k of d.kinds) kindCount.set(k, (kindCount.get(k) ?? 0) + 1);
  const lockfiles = LOCKFILES.filter(([f, k]) => kindCount.has(k) && fileSet.has(f)).map(([file, kind]) => ({ file, kind, projects: kindCount.get(kind)! }));
  const projects: DetectedProject[] = [];
  for (const [dir, d] of [...dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const kinds = DETECT_KINDS.filter((k) => d.kinds.has(k));
    const container = d.kinds.has('docker') || d.kinds.has('helm');
    const goPkg = goPkgs.get(dir);
    // Go library packages are tested, not built; binaries (package main) are built and tested.
    // A Maven pom with packaging "pom" only aggregates modules: it has nothing of its own to build.
    const aggregator = poms.get(dir)?.packaging === 'pom' && d.kinds.size === 1;
    const base: Target[] = aggregator ? [] : goPkg && !goPkg.main && d.kinds.size === 1 ? ['test'] : ['build', 'test'];
    const targets: Target[] = [...base, ...(container ? (['deploy'] as const) : []), ...(d.kinds.has('docker') ? (['docker'] as const) : [])];
    const dockerfiles = d.markers.filter((m) => markerKind(m.slice(m.lastIndexOf('/') + 1)) === 'docker').sort();
    const prefer = (base: string) => dockerfiles.find((f) => f === (dir === '.' ? base : `${dir}/${base}`));
    projects.push({
      name: nameOf.get(dir)!,
      path: dir,
      dependsOn: [...edges.get(dir)!].map((x) => nameOf.get(x)!).sort(),
      targets,
      include: [...lockfiles.filter((l) => d.kinds.has(l.kind) && dir !== '.').map((l) => l.file), ...(goPkg?.include ?? [])],
      kinds,
      dockerfile: prefer('Dockerfile') ?? prefer('Containerfile') ?? dockerfiles[0],
    });
  }
  return { projects, lockfiles, notes };
}

/** "12 projects: 7 node, 3 docker, 2 go" */
export function detectionSummary(d: Detection): string {
  const counts = new Map<DetectKind, number>();
  for (const p of d.projects) for (const k of p.kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const parts = [...counts].sort((a, b) => b[1] - a[1] || DETECT_KINDS.indexOf(a[0]) - DETECT_KINDS.indexOf(b[0])).map(([k, n]) => `${n} ${k}`);
  return `${d.projects.length} project${d.projects.length === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

type GoPackage = { module: string; main: boolean; imports: Set<string>; include: string[] };

const GO_LIMITS = { filesPerModule: 20_000 };

/**
 * Splits Go modules that contain two or more `package main` directories into one
 * project per package directory. Each package depends on the module packages it
 * imports, and every package includes its module's go.mod/go.sum (a dependency bump
 * affects them all). Modules with a single binary keep the module-level project.
 * Mutates `dirs`; returns package info keyed by directory.
 */
function splitGoModules(
  dirs: Map<string, { kinds: Set<DetectKind>; markers: string[] }>,
  files: string[],
  reader: RepoReader,
  notes: string[],
): Map<string, GoPackage> {
  const out = new Map<string, GoPackage>();
  const moduleDirs = [...dirs].filter(([, d]) => d.kinds.has('go')).map(([dir]) => dir);
  if (moduleDirs.length === 0) return out;
  const within = (dir: string, file: string) => dir === '.' || file.startsWith(`${dir}/`);
  // The module a file belongs to is the deepest module directory containing it.
  const ownerModule = (file: string) => {
    let best: string | undefined;
    for (const m of moduleDirs) if (within(m, file) && (best === undefined || m.length > best.length)) best = m;
    return best;
  };
  const goFiles = new Map<string, string[]>(); // module dir -> .go files
  for (const f of files) {
    if (!f.endsWith('.go') || skipped(f)) continue;
    const m = ownerModule(f);
    if (m === undefined) continue;
    const list = goFiles.get(m) ?? [];
    list.push(f);
    goFiles.set(m, list);
  }
  for (const moduleDir of moduleDirs) {
    const list = goFiles.get(moduleDir) ?? [];
    if (list.length === 0) continue;
    if (list.length > GO_LIMITS.filesPerModule) {
      notes.push(`Go module "${moduleDir}" has more than ${GO_LIMITS.filesPerModule} .go files; it is treated as one project`);
      continue;
    }
    const gomod = reader.readMany([moduleDir === '.' ? 'go.mod' : `${moduleDir}/go.mod`]);
    const modPath = /^\s*module\s+(\S+)/m.exec(stripGoComments([...gomod.values()][0] ?? ''))?.[1]?.replace(/^"|"$/g, '');
    if (!modPath) continue;
    const sources = reader.readMany(list);
    const pkgs = new Map<string, { main: boolean; imports: Set<string> }>();
    for (const file of list) {
      const src = sources.get(file);
      if (src === undefined) continue;
      const dir = dirOf(file);
      const pkg = pkgs.get(dir) ?? { main: false, imports: new Set<string>() };
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (!file.endsWith('_test.go') && /^\s*package\s+main\b/m.test(code)) pkg.main = true;
      // External test packages (`package foo_test`) may import their own package; that is
      // not a dependency of the package and would otherwise create a cycle.
      const externalTest = file.endsWith('_test.go') && /^\s*package\s+\w+_test\b/m.test(code);
      for (const spec of externalTest ? [] : goImports(code)) {
        if (spec !== modPath && !spec.startsWith(`${modPath}/`)) continue;
        const rel = spec === modPath ? '' : spec.slice(modPath.length + 1);
        pkg.imports.add(rel === '' ? moduleDir : moduleDir === '.' ? rel : `${moduleDir}/${rel}`);
      }
      pkgs.set(dir, pkg);
    }
    const mains = [...pkgs.values()].filter((p) => p.main).length;
    if (mains < 2) continue;
    const include = [moduleDir === '.' ? 'go.mod' : `${moduleDir}/go.mod`, moduleDir === '.' ? 'go.sum' : `${moduleDir}/go.sum`];
    // Replace the module-level project with package-level projects.
    const modEntry = dirs.get(moduleDir)!;
    modEntry.kinds.delete('go');
    if (modEntry.kinds.size === 0 && !pkgs.has(moduleDir)) dirs.delete(moduleDir);
    for (const [dir, p] of pkgs) {
      const entry = dirs.get(dir) ?? { kinds: new Set<DetectKind>(), markers: [] };
      entry.kinds.add('go');
      dirs.set(dir, entry);
      p.imports.delete(dir);
      out.set(dir, { module: moduleDir, main: p.main, imports: new Set([...p.imports].filter((i) => pkgs.has(i))), include });
    }
    notes.push(`Go module "${modPath}" builds ${mains} binaries, so it was split into ${pkgs.size} package projects linked by their imports (binaries: build, test; libraries: test)`);
  }
  return out;
}

/** Import paths from Go source (comments already stripped). */
function goImports(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const s of m[1]!.matchAll(/"([^"]+)"/g)) out.push(s[1]!);
  }
  for (const m of code.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push(m[1]!);
  return out;
}

type Pom = { artifactId?: string; version?: string; parent?: string; packaging?: string; dependencies: { artifactId: string; version?: string }[] };

/** Reads the parts of a pom.xml that matter for the project graph (regex-based; no XML entities, no execution). */
function parsePom(xml: string | undefined): Pom | undefined {
  if (xml === undefined) return undefined;
  const strip = (s: string, tag: string) => s.replace(new RegExp(String.raw`<${tag}\b[\s\S]*?</${tag}>`, 'g'), '');
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  const first = (s: string, tag: string) => new RegExp(String.raw`<${tag}>\s*([^<\s]+)\s*</${tag}>`).exec(s)?.[1];
  const parentBlock = /<parent\b[\s\S]*?<\/parent>/.exec(text)?.[0];
  let own = strip(text, 'parent');
  own = strip(strip(strip(strip(own, 'dependencyManagement'), 'build'), 'profiles'), 'reporting');
  const depsBlocks = [...own.matchAll(/<dependencies\b[\s\S]*?<\/dependencies>/g)].map((m) => m[0]);
  const dependencies = depsBlocks.flatMap((b) => [...b.matchAll(/<dependency\b[\s\S]*?<\/dependency>/g)].map((m) => ({
    artifactId: first(m[0], 'artifactId') ?? '',
    version: first(m[0], 'version'),
  }))).filter((d) => d.artifactId !== '');
  const head = strip(own, 'dependencies');
  return {
    artifactId: first(head, 'artifactId'),
    parent: parentBlock ? first(parentBlock, 'artifactId') : undefined,
    packaging: first(head, 'packaging'),
    version: first(head, 'version') ?? (parentBlock ? first(parentBlock, 'version') : undefined),
    dependencies,
  };
}
