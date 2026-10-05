// Decides which two commits to compare for the current GitHub event.
// Rule: when the correct comparison cannot be established we select ALL
// projects (with a warning). We never guess and never return "nothing changed".

import { Git, ZERO_SHA } from './git.ts';

export type Range =
  | { kind: 'diff'; base: string; head: string; how: string }
  | { kind: 'all'; head: string | undefined; why: string };

export type RangeInput = {
  eventName: string;
  event: Record<string, any>;
  baseInput?: string;
  headInput: string;
  fetch: boolean;
};

export function resolveRange(git: Git, input: RangeInput): { range: Range; warnings: string[] } {
  const warnings: string[] = [];
  const all = (why: string, head?: string): { range: Range; warnings: string[] } => ({ range: { kind: 'all', head, why }, warnings });
  const { event, eventName, fetch } = input;

  const head = git.ensure(input.headInput, fetch);
  if (!head) return all(`head revision "${input.headInput}" is not available`);

  // 1. Explicit base always wins: compare against the merge-base (like "base...head").
  if (input.baseInput) {
    const base = git.ensure(input.baseInput, fetch);
    if (!base) return all(`base revision "${input.baseInput}" could not be found or fetched`, head);
    const mb = git.mergeBase(base, head, fetch);
    if (!mb) return all(`no common ancestor between "${input.baseInput}" and ${head.slice(0, 12)} (is history available? see docs/git.md)`, head);
    return { range: { kind: 'diff', base: mb, head, how: `merge-base of input "${input.baseInput}" and HEAD` }, warnings };
  }

  switch (eventName) {
    case 'pull_request':
    case 'pull_request_target': {
      const pr = event['pull_request'];
      const prHead: unknown = pr?.head?.sha;
      const prBase: unknown = pr?.base?.sha;
      if (typeof prHead !== 'string' || typeof prBase !== 'string') return all('pull_request payload has no base/head SHA', head);
      // Default checkout: HEAD is GitHub's test-merge commit (parents: base tip, PR head).
      // Diffing against its first parent gives exactly what the PR would change.
      const parents = git.parents(head);
      if (parents.length === 2 && parents[1] === prHead) {
        const p1 = git.ensure(parents[0]!, fetch);
        if (p1) return { range: { kind: 'diff', base: p1, head, how: 'pull request merge commit vs its base parent' }, warnings };
      }
      // Otherwise (checkout of the PR head, or pull_request_target on the base branch):
      // compare merge-base(base, PR head) .. PR head.
      const h = git.ensure(prHead, fetch);
      const b = git.ensure(prBase, fetch);
      if (!h || !b) return all('could not fetch the pull request base/head commits', head);
      const mb = git.mergeBase(b, h, fetch);
      if (!mb) return all('could not find the merge-base of the pull request (history unavailable)', head);
      return { range: { kind: 'diff', base: mb, head: h, how: 'merge-base of pull request base and head' }, warnings };
    }

    case 'merge_group': {
      const mg = event['merge_group'];
      const b = typeof mg?.base_sha === 'string' ? git.ensure(mg.base_sha, fetch) : undefined;
      const h = typeof mg?.head_sha === 'string' ? git.ensure(mg.head_sha, fetch) : head;
      if (!b || !h) return all('merge_group payload base/head commits are unavailable', head);
      return { range: { kind: 'diff', base: b, head: h, how: 'merge queue base_sha..head_sha' }, warnings };
    }

    case 'push': {
      const ref: unknown = event['ref'];
      if (typeof ref === 'string' && ref.startsWith('refs/tags/')) return all('tag push (no meaningful base)', head);
      const after = typeof event['after'] === 'string' && !ZERO_SHA.test(event['after']) ? git.ensure(event['after'], fetch) ?? head : head;
      const before: unknown = event['before'];
      if (typeof before === 'string' && !ZERO_SHA.test(before)) {
        // Two-dot diff of the branch state before and after the push. Correct for
        // fast-forwards and force pushes alike, and needs no shared history.
        const b = git.ensure(before, fetch);
        if (b) return { range: { kind: 'diff', base: b, head: after, how: 'push "before".."after"' }, warnings };
        warnings.push(`push "before" commit ${before.slice(0, 12)} is unavailable (force push or garbage-collected); falling back to the default branch`);
      }
      // New branch (before = 000...) or unavailable before: compare to the default branch.
      const def: unknown = event['repository']?.default_branch;
      const branch = typeof ref === 'string' ? ref.replace(/^refs\/heads\//, '') : undefined;
      if (typeof def === 'string' && def !== branch) {
        const d = git.ensure(def, fetch);
        const mb = d && git.mergeBase(d, after, fetch);
        if (mb) return { range: { kind: 'diff', base: mb, head: after, how: `new branch: merge-base with default branch "${def}"` }, warnings };
      }
      return all('push has no usable "before" commit', head);
    }

    default:
      return all(`event "${eventName || 'unknown'}" has no comparison base (set the "base" input to compare against a ref)`, head);
  }
}
