// Repo-relative path normalisation shared by config parsing and inference.

/** Normalises a repo-relative directory path or returns an error string. */
export function normalizeDir(raw: unknown): { path: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'must be a string' };
  if (raw.length === 0 || raw.length > 1024) return { error: 'must be 1-1024 characters' };
  // Paths are output (e.g. the "paths" map) and commonly end up in shell
  // scripts, so control characters and shell metacharacters are rejected.
  if (/[\u0000-\u001f\u007f"'`$;|&<>!]/.test(raw)) return { error: 'must not contain control characters, quotes or shell metacharacters ($ ` ; | & < > !)' };
  if (raw.includes('\\')) return { error: 'must use "/" separators' };
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return { error: 'must be relative to the repository root' };
  if (/[*?[\]{}]/.test(raw)) return { error: 'must be a directory, not a glob (use "discover" or "include")' };
  const parts = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.includes('..')) return { error: 'must not contain ".." segments' };
  if (parts.includes('.git')) return { error: 'must not point inside .git' };
  return { path: parts.length === 0 ? '.' : parts.join('/') };
}
