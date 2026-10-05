// Project dependency graph.
//
// Edges point from a project to the projects it depends on. "Affected" is the
// reverse-transitive closure: everything that (directly or indirectly) depends
// on a changed project. Cycles are rejected because they make build order
// undefined and are almost always a configuration mistake.

import type { Project } from './config.ts';

export class CycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
    this.cycle = cycle;
  }
}

export type Reach = {
  /** Projects reached, mapped to the project they were reached from (undefined for seeds). */
  parent: Map<string, string | undefined>;
};

export class Graph {
  readonly deps = new Map<string, readonly string[]>();
  readonly dependents = new Map<string, string[]>();
  /** Topological rank: dependencies before dependents, ties broken by name. */
  readonly rank = new Map<string, number>();

  constructor(projects: Iterable<Project>) {
    for (const p of projects) {
      this.deps.set(p.name, p.dependsOn);
      if (!this.dependents.has(p.name)) this.dependents.set(p.name, []);
    }
    for (const [name, deps] of this.deps) {
      for (const d of deps) {
        const list = this.dependents.get(d);
        if (!list) throw new Error(`project "${name}" depends on unknown project "${d}"`);
        list.push(name);
      }
    }
    for (const list of this.dependents.values()) list.sort(compare);
    this.computeRank();
  }

  /** Kahn's algorithm with a name-ordered queue => deterministic order. */
  private computeRank(): void {
    const indegree = new Map<string, number>();
    for (const [name, deps] of this.deps) indegree.set(name, deps.length);
    const heap = new MinHeap();
    for (const [name, n] of indegree) if (n === 0) heap.push(name);
    let i = 0;
    while (heap.size > 0) {
      const name = heap.pop()!;
      this.rank.set(name, i++);
      for (const dependent of this.dependents.get(name)!) {
        const n = indegree.get(dependent)! - 1;
        indegree.set(dependent, n);
        if (n === 0) heap.push(dependent);
      }
    }
    if (this.rank.size !== this.deps.size) throw new CycleError(this.findCycle());
  }

  /** Returns one concrete cycle (first node repeated at the end), for error messages. */
  private findCycle(): string[] {
    const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
    const names = [...this.deps.keys()].filter((n) => !this.rank.has(n)).sort(compare);
    for (const start of names) {
      if (state.has(start)) continue;
      // Iterative DFS to stay safe on very deep graphs.
      const stack: { node: string; i: number }[] = [{ node: start, i: 0 }];
      const path: string[] = [start];
      state.set(start, 1);
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        const deps = this.deps.get(top.node)!;
        if (top.i < deps.length) {
          const next = deps[top.i++]!;
          const s = state.get(next);
          if (s === 1) return [...path.slice(path.indexOf(next)), next];
          if (s === undefined) {
            state.set(next, 1);
            stack.push({ node: next, i: 0 });
            path.push(next);
          }
        } else {
          state.set(top.node, 2);
          stack.pop();
          path.pop();
        }
      }
    }
    return names.slice(0, 2);
  }

  /**
   * Breadth-first walk over dependents from all seeds at once. The parent of
   * each reached node gives the shortest explanation chain back to a seed.
   */
  reverseClosure(seeds: Iterable<string>): Reach {
    const parent = new Map<string, string | undefined>();
    const queue: string[] = [];
    for (const s of [...seeds].sort(compare)) {
      if (!parent.has(s) && this.deps.has(s)) {
        parent.set(s, undefined);
        queue.push(s);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head]!;
      for (const d of this.dependents.get(node)!) {
        if (!parent.has(d)) {
          parent.set(d, node);
          queue.push(d);
        }
      }
    }
    return { parent };
  }

  /** Chain from a seed to `name`, e.g. ["shared", "api", "portal"]. */
  static chain(reach: Reach, name: string): string[] {
    const out = [name];
    let cur = reach.parent.get(name);
    while (cur !== undefined) {
      out.push(cur);
      cur = reach.parent.get(cur);
    }
    return out.reverse();
  }

  sort(names: Iterable<string>): string[] {
    return [...names].sort((a, b) => (this.rank.get(a) ?? 0) - (this.rank.get(b) ?? 0) || compare(a, b));
  }
}

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

class MinHeap {
  private items: string[] = [];
  get size(): number {
    return this.items.length;
  }
  push(v: string): void {
    const a = this.items;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]! <= a[i]!) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): string | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]! < a[m]!) m = l;
        if (r < a.length && a[r]! < a[m]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}
