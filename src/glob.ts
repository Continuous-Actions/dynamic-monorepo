// Minimal, dependency-free glob matcher for repository-relative POSIX paths.
//
// Supported syntax (deliberately small, documented in docs/configuration.md):
//   **   any number of path segments (including zero)
//   *    any characters except "/"
//   ?    exactly one character except "/"
//   dir/ trailing slash is shorthand for dir/**
// Patterns are always anchored at the repository root. Anything else that
// looks like extended glob syntax ({a,b}, [abc], !negation) is rejected so a
// pattern never silently means something other than what the author expects.
//
// Matching never uses regular expressions: segments are compared with a
// linear wildcard matcher and "**" with dynamic programming over segments, so
// hostile patterns or file names cannot cause catastrophic backtracking.

export type Matcher = { pattern: string; test: (path: string) => boolean };

const UNSUPPORTED = /[{}[\]!\\]/;

export function validatePattern(pattern: string): string | undefined {
  if (pattern.length === 0) return 'pattern is empty';
  if (pattern.length > 1024) return 'pattern is longer than 1024 characters';
  if (pattern.includes('\0')) return 'pattern contains a NUL byte';
  if (pattern.startsWith('/')) return 'pattern must be relative to the repository root (no leading "/")';
  if (UNSUPPORTED.test(pattern)) return 'only "*", "**" and "?" wildcards are supported ({}, [], ! and \\ are not)';
  if (pattern.split('/').includes('..')) return 'pattern must not contain ".." segments';
  return undefined;
}

export function compileGlob(pattern: string): Matcher {
  const problem = validatePattern(pattern);
  if (problem) throw new Error(`invalid glob "${pattern}": ${problem}`);
  return { pattern, test: compileSegments(pattern) };
}

/** Compiles a glob without validation (callers validate). Returns a path tester. */
export function compileSegments(pattern: string): (path: string) => boolean {
  let p = pattern.replace(/^\.\//, '');
  if (p.endsWith('/')) p += '**';
  const segs: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '**') {
      if (segs[segs.length - 1] !== '**') segs.push('**'); // "**/**" == "**"
    } else {
      segs.push(seg.replace(/\*+/g, '*'));
    }
  }
  // Literal leading directories give a cheap pre-filter for the common case.
  const literal: string[] = [];
  for (const seg of segs) {
    if (/[*?]/.test(seg)) break;
    literal.push(seg);
  }
  const prefix = literal.join('/');
  return (path) => path.startsWith(prefix) && matchSegments(segs, path.split('/'));
}

function matchSegments(pat: readonly string[], parts: readonly string[]): boolean {
  // reach[j] = the pattern prefix consumed so far can align with parts[0..j)
  let reach = new Uint8Array(parts.length + 1);
  reach[0] = 1;
  for (const seg of pat) {
    const next = new Uint8Array(parts.length + 1);
    if (seg === '**') {
      let on = 0;
      for (let j = 0; j <= parts.length; j++) {
        if (reach[j]) on = 1;
        next[j] = on;
      }
    } else {
      for (let j = 0; j < parts.length; j++) if (reach[j] && wildcard(seg, parts[j]!)) next[j + 1] = 1;
    }
    reach = next;
  }
  return reach[parts.length] === 1;
}

/**
 * Matches one path segment against a pattern with "*" and "?" in O(n*m) worst
 * case without recursion (classic single-backtrack-point algorithm).
 */
export function wildcard(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const c = pattern[p];
    if (c === '?' || (c !== undefined && c !== '*' && c === text[t])) {
      p++;
      t++;
    } else if (c === '*') {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

export function anyMatch(matchers: readonly Matcher[], path: string): Matcher | undefined {
  for (const m of matchers) if (m.test(path)) return m;
  return undefined;
}
