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
  let p = pattern.replace(/^\.\//, '');
  if (p.endsWith('/')) p += '**';
  // Collapse runs of "**" (they are equivalent) and compile each other segment
  // into a small anchored regex. "**" is matched by dynamic programming over
  // segments, which is O(pattern segments x path segments) with no backtracking.
  const segs: (RegExp | '**')[] = [];
  for (const seg of p.split('/')) {
    if (seg === '**') {
      if (segs[segs.length - 1] !== '**') segs.push('**');
      continue;
    }
    let re = '';
    for (const ch of seg) {
      if (ch === '*') re += re.endsWith('[^/]*') ? '' : '[^/]*';
      else if (ch === '?') re += '[^/]';
      else re += ch.replace(/[.+^$()|]/g, '\\$&');
    }
    segs.push(new RegExp(`^${re}$`));
  }
  return { pattern, test: (path) => matchSegments(segs, path.split('/')) };
}

function matchSegments(pat: readonly (RegExp | '**')[], parts: readonly string[]): boolean {
  // reach[j] = pattern prefix consumed so far can align with parts[0..j)
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
      for (let j = 0; j < parts.length; j++) if (reach[j] && seg.test(parts[j]!)) next[j + 1] = 1;
    }
    reach = next;
  }
  return reach[parts.length] === 1;
}

export function anyMatch(matchers: readonly Matcher[], path: string): Matcher | undefined {
  for (const m of matchers) if (m.test(path)) return m;
  return undefined;
}
