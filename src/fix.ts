// `audit --fix`: applies audit findings to the workflow text, editing only the
// `on.<event>.paths` list and keeping comments, quoting and layout. Every edit is
// checked by parsing the result: if anything other than that list changed, or the
// list isn't exactly what was intended, the file is left alone.

import { isDeepStrictEqual } from 'node:util';
import { load, CORE_SCHEMA } from 'js-yaml';
import type { AuditFinding } from './audit.ts';

export type FixResult = { text: string; fixed: AuditFinding[]; skipped: AuditFinding[] };

export function applyFixes(original: string, findings: AuditFinding[]): FixResult {
  let text = original;
  const fixed: AuditFinding[] = [];
  const skipped: AuditFinding[] = [];
  for (const f of findings) {
    const next = f.fix ? fixOne(text, f.fix) : undefined;
    if (next === undefined) skipped.push(f);
    else {
      text = next;
      fixed.push(f);
    }
  }
  return { text, fixed, skipped };
}

type Fix = NonNullable<AuditFinding['fix']>;

function parse(text: string): any {
  try {
    return load(text, { schema: CORE_SCHEMA });
  } catch {
    return undefined;
  }
}

const onOf = (doc: any) => (doc && typeof doc === 'object' ? ('on' in doc ? 'on' : 'true' in doc ? 'true' : undefined) : undefined);

/** Returns the edited text, or undefined when the edit can't be made safely. */
function fixOne(text: string, fix: Fix): string | undefined {
  const before = parse(text);
  const key = onOf(before);
  const paths: unknown = key && before[key]?.[fix.event]?.paths;
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return undefined;
  let want: string[];
  if (fix.add !== undefined) {
    if (paths.includes(fix.add)) return text;
    want = [...paths, fix.add];
  } else if (fix.replace) {
    const { from, to } = fix.replace;
    if (!paths.includes(from)) return undefined;
    want = paths.includes(to) ? paths.filter((p) => p !== from) : paths.map((p) => (p === from ? to : p));
  } else return undefined;

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = locate(lines, fix.event);
  if (!at) return undefined;
  if (at.kind === 'flow') {
    const line = lines[at.line]!;
    const open = line.indexOf('[', at.col);
    const close = line.replace(/\s+#[^'"]*$/, '').lastIndexOf(']'); // ignore a `]` in a trailing comment
    if (open < 0 || close < open) return undefined;
    const inner = line.slice(open + 1, close);
    const style = styleOf(inner.trim());
    lines[at.line] = fix.add !== undefined
      ? `${line.slice(0, close).replace(/\s*$/, '')}${inner.trim() ? ', ' : ''}${quote(fix.add, style)}${line.slice(close)}`
      : `${line.slice(0, open)}[${want.map((p) => quote(p, style)).join(', ')}]${line.slice(close + 1)}`;
  } else {
    const style = styleOf(lines[at.items[0]!]!.replace(/^\s*-\s*/, ''));
    const indent = /^(\s*-\s*)/.exec(lines[at.items[0]!]!)![1]!;
    if (fix.add !== undefined) {
      lines.splice(at.items[at.items.length - 1]! + 1, 0, `${indent}${quote(fix.add, style)}`);
    } else {
      const { from, to } = fix.replace!;
      const i = at.items.find((n) => scalarOf(lines[n]!) === from);
      if (i === undefined) return undefined;
      const comment = /\s+#.*$/.exec(lines[i]!.slice(indent.length).replace(/^(['"]).*?\1/, ''))?.[0] ?? '';
      if (want.length < paths.length) lines.splice(i, 1);
      else lines[i] = `${indent}${quote(to, styleOf(lines[i]!.slice(indent.length)))}${comment}`;
    }
  }
  const out = lines.join(eol);
  // The result must parse to the same document with only this paths list changed.
  const after = parse(out);
  if (!after) return undefined;
  const expected = structuredClone(before);
  expected[key!][fix.event].paths = want;
  return isDeepStrictEqual(after, expected) ? out : undefined;
}

type Where = { kind: 'flow'; line: number; col: number } | { kind: 'block'; items: number[] };

const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
const blank = (l: string) => /^\s*(#.*)?$/.test(l);
const keyRe = (k: string) => new RegExp(`^(\\s*)(["']?)${k}\\2\\s*:(.*)$`);

/** Finds the `paths:` value under top-level `on:` → `<event>:` in block style. */
function locate(lines: string[], event: string): Where | undefined {
  const on = lines.findIndex((l) => /^(["']?)on\1\s*:\s*(#.*)?$/.test(l));
  if (on < 0) return undefined;
  const ev = child(lines, on, 0, event);
  if (!ev) return undefined;
  const p = child(lines, ev.line, ev.indent, 'paths');
  if (!p) return undefined;
  const rest = p.rest.replace(/\s+#.*$/, '').trim();
  if (rest.startsWith('[')) return rest.endsWith(']') ? { kind: 'flow', line: p.line, col: lines[p.line]!.indexOf(':') } : undefined;
  if (rest !== '') return undefined;
  const items: number[] = [];
  for (let i = p.line + 1; i < lines.length; i++) {
    if (blank(lines[i]!)) continue;
    const ind = indentOf(lines[i]!);
    if (ind < p.indent || (ind === p.indent && !/^\s*-(\s|$)/.test(lines[i]!))) break;
    if (!/^\s*-\s+\S/.test(lines[i]!)) return undefined; // nested or multi-line entries: leave to a human
    if (items.length > 0 && ind !== indentOf(lines[items[0]!]!)) return undefined;
    items.push(i);
  }
  return items.length > 0 ? { kind: 'block', items } : undefined;
}

/** The direct child `key:` of the mapping that starts after line `parent` (indented deeper than `parentIndent`). */
function child(lines: string[], parent: number, parentIndent: number, key: string) {
  let indent = -1;
  for (let i = parent + 1; i < lines.length; i++) {
    if (blank(lines[i]!)) continue;
    const ind = indentOf(lines[i]!);
    if (ind <= parentIndent) return undefined;
    if (indent < 0) indent = ind;
    if (ind !== indent) continue;
    const m = keyRe(key).exec(lines[i]!);
    if (m) return { line: i, indent: ind, rest: m[3] ?? "" };
  }
  return undefined;
}

type Style = 'single' | 'double' | 'plain';
const styleOf = (s: string): Style => (s.startsWith("'") ? 'single' : s.startsWith('"') ? 'double' : 'plain');

function quote(s: string, style: Style): string {
  if (style === 'double') return JSON.stringify(s);
  if (style === 'plain' && /^[A-Za-z0-9._/-][A-Za-z0-9._/*-]*$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

function scalarOf(line: string): string | undefined {
  const v = parse(line.replace(/^\s*-\s*/, '- '));
  return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;
}
