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
      }
    }
  }

  // Project-level config diff: added / deleted / renamed / redefined.
  const added: string[] = [];
  const deleted: string[] = [];
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
    if (configChanged && (patterns(base.global) !== patterns(head.global) || patterns(base.ignore) !== patterns(head.ignore))) {
      allReason ??= `"global" or "ignore" changed in ${configPath}`;
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
    if (!seeds.has(name)) {
      seeds.add(name);
      reasons.set(name, { kind: 'definition' });
    }
  }

  let affectedSet: Set<string>;
  if (allReason) {
    affectedSet = new Set(head.projects.keys());
    for (const name of affectedSet) if (!reasons.has(name)) reasons.set(name, { kind: 'all', why: allReason });
  } else {
    const reach = graph.reverseClosure(seeds);
    affectedSet = new Set(reach.parent.keys());
    for (const name of affectedSet) {
      if (!seeds.has(name)) reasons.set(name, { kind: 'dependency', chain: Graph.chain(reach, name) });
    }
  }

  const affected = graph.sort(affectedSet);
  const targets = Object.fromEntries(TARGETS.map((t) => [t, [] as string[]])) as Record<Target, string[]>;
  const paths: Record<string, string> = Object.create(null);
  for (const name of affected) {
    const p = head.projects.get(name)!;
    paths[name] = p.path;
    for (const t of p.targets) targets[t].push(name);
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
    reasons,
    files: { total, ignored, unowned: unowned.sort(compare), global: globalHits.sort(compare) },
  };
}

function patterns(ms: { pattern: string }[]): string {
  return JSON.stringify(ms.map((m) => m.pattern));
}
