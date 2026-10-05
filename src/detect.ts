// Auto-detection: find projects from marker files in the committed tree.
//
// A project is a directory that contains a marker file (package.json, go.mod,
// Dockerfile, ...). Dependencies come from the manifests themselves. Files are
// only read, never executed, and the scan is bounded.

import type { Target } from './config.ts';
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
  for (const file of files) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    const kind = markerKind(base);
    if (!kind || skipped(file)) continue;
    const dir = dirOf(file);
    const d = dirs.get(dir) ?? { kinds: new Set(), markers: [] };
    d.kinds.add(kind);
    d.markers.push(file);
    dirs.set(dir, d);
  }

  // 2. Read the manifests that carry names or dependencies (one git process).
  const manifestNames = new Set(['package.json', 'Cargo.toml', 'go.mod']);
  const toRead = [...dirs.values()].flatMap((d) => d.markers).filter((f) => manifestNames.has(f.slice(f.lastIndexOf('/') + 1)) || /\.(cs|fs|vb)proj$/.test(f));
  const fileSet = new Set(files);
  if (!dirs.has('.') && fileSet.has('Cargo.toml')) toRead.push('Cargo.toml');
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
  if (rootPkg && rootPkg.workspaces !== undefined) drop('.', 'node', 'package.json at the root declares workspaces, so it is not a project itself');
  const cargoManifests = new Map<string, any>();
  for (const [dir, d] of [...dirs]) {
    if (!d.kinds.has('cargo')) continue;
    const m = toml(at(dir, 'Cargo.toml'));
    if (m?.package && typeof m.package === 'object') cargoManifests.set(dir, m);
    else drop(dir, 'cargo', `${dir === '.' ? '' : `${dir}/`}Cargo.toml has no [package] (workspace root), so it is not a project itself`);
  }
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

  // 4. Dependencies between detected projects, from the manifests.
  const edges = new Map<string, Set<string>>([...dirs.keys()].map((d) => [d, new Set<string>()]));
  const link = (from: string, toDir: string | undefined) => {
    if (toDir !== undefined && toDir !== from && dirs.has(toDir)) edges.get(from)!.add(toDir);
  };
  const nodeByName = new Map<string, string>();
  const goByModule = new Map<string, string>();
  for (const [dir, d] of dirs) {
    if (d.kinds.has('node')) {
      const n = json(at(dir, 'package.json'))?.name;
      if (typeof n === 'string') nodeByName.set(n, dir);
    }
    if (d.kinds.has('go')) {
      const mod = /^\s*module\s+(\S+)/m.exec(stripGoComments(at(dir, 'go.mod') ?? ''))?.[1]?.replace(/^"|"$/g, '');
      if (mod) goByModule.set(mod, dir);
    }
  }
  const rootCargo = cargoManifests.get('.') ?? toml(text.get('Cargo.toml'));
  const wsDeps: Record<string, any> = rootCargo?.workspace?.dependencies ?? {};
  for (const [dir, d] of dirs) {
    if (d.kinds.has('node')) {
      const pkg = json(at(dir, 'package.json'));
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = pkg?.[field];
        if (deps && typeof deps === 'object' && !Array.isArray(deps)) for (const k of Object.keys(deps)) link(dir, nodeByName.get(k));
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
    const targets: Target[] = ['build', 'test', ...(container ? (['deploy'] as const) : []), ...(d.kinds.has('docker') ? (['docker'] as const) : [])];
    const dockerfiles = d.markers.filter((m) => markerKind(m.slice(m.lastIndexOf('/') + 1)) === 'docker').sort();
    const prefer = (base: string) => dockerfiles.find((f) => f === (dir === '.' ? base : `${dir}/${base}`));
    projects.push({
      name: nameOf.get(dir)!,
      path: dir,
      dependsOn: [...edges.get(dir)!].map((x) => nameOf.get(x)!).sort(),
      targets,
      include: lockfiles.filter((l) => d.kinds.has(l.kind) && dir !== '.').map((l) => l.file),
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
