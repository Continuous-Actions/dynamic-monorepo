import { describe, expect, it } from 'vitest';
import { Graph, CycleError } from '../src/graph.ts';
import { compileGlob } from '../src/glob.ts';
import type { Project } from '../src/config.ts';

const g = (edges: Record<string, string[]>) =>
  new Graph(Object.entries(edges).map(([name, dependsOn]): Project => ({
    name, path: name, dependsOn, targets: ['build'], include: [], exclude: [], source: 'projects',
  })));
const affected = (graph: Graph, ...seeds: string[]) => graph.sort(graph.reverseClosure(seeds).parent.keys());

describe('graph', () => {
  it('linear chain', () => {
    const graph = g({ shared: [], api: ['shared'], portal: ['api'] });
    expect(affected(graph, 'shared')).toEqual(['shared', 'api', 'portal']);
    expect(affected(graph, 'api')).toEqual(['api', 'portal']);
    expect(affected(graph, 'portal')).toEqual(['portal']);
  });

  it('branching, converging (diamond), multiple roots and disconnected nodes', () => {
    const graph = g({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'], x: [], y: ['x'], lone: [] });
    expect(affected(graph, 'a')).toEqual(['a', 'b', 'c', 'd']);
    expect(affected(graph, 'b', 'x')).toEqual(['b', 'd', 'x', 'y']);
    expect(affected(graph, 'lone')).toEqual(['lone']);
    const reach = graph.reverseClosure(['a']);
    expect(Graph.chain(reach, 'd')).toEqual(['a', 'b', 'd']); // shortest, name-ordered
  });

  it('order is deterministic regardless of declaration order', () => {
    const one = g({ b: ['a'], a: [], c: ['a'] });
    const two = g({ c: ['a'], a: [], b: ['a'] });
    expect(affected(one, 'a')).toEqual(affected(two, 'a'));
    expect(affected(one, 'a')).toEqual(['a', 'b', 'c']);
  });

  it('reports a concrete cycle', () => {
    expect(() => g({ a: ['b'], b: ['c'], c: ['a'], ok: [] })).toThrowError(CycleError);
    try { g({ a: ['b'], b: ['a'] }); } catch (e) { expect((e as CycleError).cycle).toEqual(['a', 'b', 'a']); }
  });

  it('handles deep chains without recursion limits', () => {
    const edges: Record<string, string[]> = { p0: [] };
    for (let i = 1; i < 20000; i++) edges[`p${i}`] = [`p${i - 1}`];
    expect(affected(g(edges), 'p0')).toHaveLength(20000);
    edges['p0'] = ['p19999'];
    expect(() => g(edges)).toThrowError(CycleError);
  });
});

describe('glob', () => {
  it.each([
    ['**/*.md', 'README.md', true], ['**/*.md', 'a/b/c.md', true], ['*.md', 'a/b.md', false],
    ['docs/', 'docs/a/b', true], ['a/**/b', 'a/b', true], ['a/**/b', 'a/x/y/b', true],
    ['a/?.ts', 'a/x.ts', true], ['a/?.ts', 'a/xy.ts', false], ['a.b', 'axb', false], ['a/*', 'a/b/c', false],
  ])('%s vs %s -> %s', (pattern, path, expected) => {
    expect(compileGlob(pattern).test(path)).toBe(expected);
  });

  it('is linear on pathological input (no ReDoS)', () => {
    const m = compileGlob('**/**/**/**/**/**/**/**/x');
    const t = performance.now();
    m.test('a/'.repeat(5000) + 'y');
    expect(performance.now() - t).toBeLessThan(500);
  });
});
