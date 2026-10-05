// Pure planning: (head config, optional base config, changed files) -> Plan.
// No I/O here, which keeps it fast to test and easy to reason about.

import { projectFingerprint, TARGETS, type Config, type Project, type Target } from './config.ts';
import { anyMatch } from './glob.ts';
import { compare, Graph } from './graph.ts';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'type-changed';
export type FileChange = { status: ChangeStatus; path: string; oldPath?: string };

export type Reason =
  | { kind: 'files'; files: string[]; count: number }
  | { kind: 'dependency'; chain: string[] }
  | { kind: 'definition' }
  | { kind: 'all'; why: string };

export type Plan = {
  all: boolean;
  allReason?: string;
  changed: string[];
  affected: string[];
  targets: Record<Target, string[]>;
  added: string[];
  deleted: string[];
  renamed: { from: string; to: string }[];
  skipped: string[];
  paths: Record<string, string>;
  /** Dockerfile of each project in the docker list, when known. */
  dockerfiles: Record<string, string>;
  reasons: Map<string, Reason>;
  files: { total: number; ignored: number; unowned: string[]; global: string[] };
};

export type PlanInput = {
  head: Config;
  configPath: string;
  changes: FileChange[];
  /** Config at the base revision; null when it did not exist, undefined when unknown. */
  base?: Config | null;
  /** Force selection of every project (no usable base, etc.). */
  forceAll?: string;
};

const MAX_REASON_FILES = 5;

export class Owners {
  private readonly byPath = new Map<string, Project>();
  private readonly withInclude: Project[] = [];
  private readonly root: Project | undefined;

  constructor(config: Config) {
    for (const p of config.projects.values()) {
      this.byPath.set(p.path, p);
      if (p.include.length > 0) this.withInclude.push(p);
    }
    this.root = this.byPath.get('.');
  }

  /** Projects that own a file: deepest directory match plus any "include" matches, minus "exclude". */
  of(file: string): Project[] {
    const out: Project[] = [];
    let dir = file;
    let owner: Project | undefined;
    for (let i = dir.lastIndexOf('/'); i > 0; i = dir.lastIndexOf('/')) {
      dir = dir.slice(0, i);
      owner = this.byPath.get(dir);
      if (owner) break;
    }
    owner ??= this.root;
    if (owner && !anyMatch(owner.exclude, file)) out.push(owner);
    for (const p of this.withInclude) {
      if (p !== owner && anyMatch(p.include, file) && !anyMatch(p.exclude, file)) out.push(p);
    }
    return out;
  }
}

export function plan(input: PlanInput): Plan {
  const { head, configPath, changes } = input;
  const graph = new Graph(head.projects.values());
  const owners = new Owners(head);
  const reasons = new Map<string, Reason>();
  const fileHits = new Map<string, string[]>();
  const fileCounts = new Map<string, number>();
  // Per target: projects with at least one change that is not excluded for that target.
  const targetSeeds = Object.fromEntries(TARGETS.map((t) => [t, new Set<string>()])) as Record<Target, Set<string>>;
  const unowned: string[] = [];
  const globalHits: string[] = [];
  let ignored = 0;
  let total = 0;
  let configChanged = false;

  for (const change of changes) {
    const paths = change.oldPath && change.oldPath !== change.path ? [change.path, change.oldPath] : [change.path];
    for (const file of paths) {
      total++;
      if (file === configPath) {
        configChanged = true;
        continue;
      }
      if (anyMatch(head.ignore, file)) {
        ignored++;
        continue;
      }
      if (anyMatch(head.global, file)) {
        globalHits.push(file);
        continue;
      }
      const owned = owners.of(file);
      if (owned.length === 0) unowned.push(file);
      for (const p of owned) {
        const n = (fileCounts.get(p.name) ?? 0) + 1;
        fileCounts.set(p.name, n);
        if (n <= MAX_REASON_FILES) {
          const list = fileHits.get(p.name) ?? [];
          list.push(file);
          fileHits.set(p.name, list);
        }
        for (const t of TARGETS) {
          if (!anyMatch(head.targetExclude[t], file) && !anyMatch(p.targetExclude[t] ?? [], file)) targetSeeds[t].add(p.name);
        }
      }
    }
  }

  // Project-level config diff: added / deleted / renamed / redefined.
  let added: string[] = [];
  let deleted: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const redefined: string[] = [];
  let allReason = input.forceAll;
  const base = input.base;

  if (base) {
    const headByPath = new Map([...head.projects.values()].map((p) => [p.path, p.name]));
    const baseByPath = new Map([...base.projects.values()].map((p) => [p.path, p.name]));
    for (const p of head.projects.values()) {
      const old = base.projects.get(p.name);
      if (old) {
        if (projectFingerprint(old) !== projectFingerprint(p)) redefined.push(p.name);
        continue;
      }
      const oldName = baseByPath.get(p.path);
      if (oldName !== undefined && !head.projects.has(oldName)) renamed.push({ from: oldName, to: p.name });
      else added.push(p.name);
    }
    for (const p of base.projects.values()) {
      if (!head.projects.has(p.name) && headByPath.get(p.path) === undefined) deleted.push(p.name);
    }
    // Renamed AND moved: most of a deleted project's files were git-renamed into one added project.
    for (const pair of movedProjects(changes, new Owners(base), owners, new Set(deleted), new Set(added))) {
      renamed.push(pair);
      deleted = deleted.filter((n) => n !== pair.from);
      added = added.filter((n) => n !== pair.to);
    }
    if (configChanged && base.globalsKey !== head.globalsKey) {
      allReason ??= `"global", "ignore" or "targets" changed in ${configPath}`;
    }
  } else if (configChanged) {
    allReason ??= base === null
      ? `${configPath} was added`
      : `${configPath} changed and its previous version could not be read`;
  }
  if (!allReason && globalHits.length > 0) {
    allReason = `global file changed: ${globalHits[0]}${globalHits.length > 1 ? ` (+${globalHits.length - 1} more)` : ''}`;
  }

  // Seeds: projects with changed files, new projects, and redefined projects.
  const seeds = new Set<string>();
  for (const name of fileHits.keys()) {
    seeds.add(name);
    reasons.set(name, { kind: 'files', files: fileHits.get(name)!, count: fileCounts.get(name)! });
  }
  for (const name of [...redefined, ...added, ...renamed.map((r) => r.to)]) {
    for (const t of TARGETS) targetSeeds[t].add(name);
    if (!seeds.has(name)) {
      seeds.add(name);
      reasons.set(name, { kind: 'definition' });
    }
  }

  let affectedSet: Set<string>;
  const targets = Object.fromEntries(TARGETS.map((t) => [t, [] as string[]])) as Record<Target, string[]>;
  const has = (name: string, t: Target) => head.projects.get(name)!.targets.includes(t);
  if (allReason) {
    affectedSet = new Set(head.projects.keys());
    for (const name of affectedSet) if (!reasons.has(name)) reasons.set(name, { kind: 'all', why: allReason });
    for (const t of TARGETS) targets[t] = graph.sort([...affectedSet].filter((n) => has(n, t)));
  } else {
    const reach = graph.reverseClosure(seeds);
    affectedSet = new Set(reach.parent.keys());
    for (const name of affectedSet) {
      if (!seeds.has(name)) reasons.set(name, { kind: 'dependency', chain: Graph.chain(reach, name) });
    }
    // Each target propagates only from changes that are relevant to it (e.g. test-only edits don't redeploy).
    for (const t of TARGETS) {
      const r = targetSeeds[t].size === seeds.size ? reach : graph.reverseClosure(targetSeeds[t]);
      targets[t] = graph.sort([...r.parent.keys()].filter((n) => has(n, t)));
    }
  }

  const affected = graph.sort(affectedSet);
  const paths: Record<string, string> = Object.create(null);
  for (const name of affected) paths[name] = head.projects.get(name)!.path;
  const dockerfiles: Record<string, string> = Object.create(null);
  for (const name of targets.docker) {
    const f = head.projects.get(name)!.dockerfile;
    if (f) dockerfiles[name] = f;
  }

  return {
    all: allReason !== undefined,
    allReason,
    changed: graph.sort(seeds),
    affected,
    targets,
    added: graph.sort(added),
    deleted: deleted.sort(compare),
    renamed: renamed.sort((a, b) => compare(a.to, b.to)),
    skipped: graph.sort([...head.projects.keys()].filter((n) => !affectedSet.has(n))),
    paths,
    dockerfiles,
    reasons,
    files: { total, ignored, unowned: unowned.sort(compare), global: globalHits.sort(compare) },
  };
}

/**
 * Pairs a deleted project with an added one when more than half of the deleted
 * project's removed/renamed files were renamed into the added project.
 */
function movedProjects(changes: FileChange[], baseOwners: Owners, headOwners: Owners, deleted: Set<string>, added: Set<string>): { from: string; to: string }[] {
  if (deleted.size === 0 || added.size === 0) return [];
  const outgoing = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const c of changes) {
    const oldPath = c.status === 'renamed' ? c.oldPath : c.status === 'deleted' ? c.path : undefined;
    if (!oldPath) continue;
    for (const from of baseOwners.of(oldPath)) {
      if (!deleted.has(from.name)) continue;
      outgoing.set(from.name, (outgoing.get(from.name) ?? 0) + 1);
      if (c.status !== 'renamed') continue;
      for (const to of headOwners.of(c.path)) {
        if (added.has(to.name)) pairs.set(`${from.name}\0${to.name}`, (pairs.get(`${from.name}\0${to.name}`) ?? 0) + 1);
      }
    }
  }
  const ranked = [...pairs].map(([k, n]) => {
    const [from, to] = k.split('\0') as [string, string];
    return { from, to, n };
  }).sort((a, b) => b.n - a.n || compare(a.from, b.from) || compare(a.to, b.to));
  const used = new Set<string>();
  const out: { from: string; to: string }[] = [];
  for (const { from, to, n } of ranked) {
    if (used.has(`f:${from}`) || used.has(`t:${to}`) || n * 2 <= (outgoing.get(from) ?? 0)) continue;
    used.add(`f:${from}`).add(`t:${to}`);
    out.push({ from, to });
  }
  return out;
}
