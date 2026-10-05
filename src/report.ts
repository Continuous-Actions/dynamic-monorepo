// Human-readable explanations: a compact log and a GitHub job summary.

import { TARGETS } from './config.ts';
import { detectionSummary, type Detection } from './detect.ts';
import type { Plan, Reason } from './plan.ts';
import type { Range } from './range.ts';

export const NAME = 'dynamic-monorepo';
export const CONFIG_FILE = 'dynamic-monorepo.config.json';
const LIST_LIMIT = 50;

export function explain(r: Reason | undefined): string {
  if (!r) return 'no changed files and no dependency on a changed project';
  switch (r.kind) {
    case 'files':
      return `${r.count} changed file${r.count === 1 ? '' : 's'}: ${r.files.join(', ')}${r.count > r.files.length ? ', …' : ''}`;
    case 'dependency':
      return `depends on ${r.chain[0]} (${r.chain.join(' → ')})`;
    case 'definition':
      return 'project added, renamed or redefined in the configuration';
    case 'all':
      return `all projects selected: ${r.why}`;
  }
}

function rangeLine(range: Range): string {
  return range.kind === 'diff'
    ? `${range.base.slice(0, 12)}..${range.head.slice(0, 12)} (${range.how})`
    : `none — ${range.why}`;
}

function cap(list: string[], n = LIST_LIMIT): string[] {
  return list.length > n ? [...list.slice(0, n), `… and ${list.length - n} more`] : list;
}

export function textReport(plan: Plan, range: Range, verbose: boolean, notes: string[] = []): string {
  const lines: string[] = [];
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`${title} (${items.length}):`);
    for (const i of cap(items)) lines.push(`  ${i}`);
  };
  lines.push(`${NAME}: ${plan.affected.length} affected / ${plan.affected.length + plan.skipped.length} projects`);
  lines.push(`Compared: ${rangeLine(range)}`);
  for (const n of notes) lines.push(n);
  lines.push(`Changed files: ${plan.files.total}${plan.files.ignored ? ` (${plan.files.ignored} ignored)` : ''}`);
  if (plan.all) lines.push(`ALL projects selected: ${plan.allReason}`);
  const direct = plan.affected.filter((n) => plan.reasons.get(n)?.kind !== 'dependency');
  const transitive = plan.affected.filter((n) => plan.reasons.get(n)?.kind === 'dependency');
  section('Directly affected', direct.map((n) => `${n} — ${explain(plan.reasons.get(n))}`));
  section('Transitively affected', transitive.map((n) => `${n} — ${explain(plan.reasons.get(n))}`));
  section('Build', plan.targets.build);
  section('Test', plan.targets.test);
  section('Deploy', plan.targets.deploy);
  section('Docker', plan.targets.docker);
  section('Added', plan.added);
  section('Deleted', plan.deleted);
  section('Renamed', plan.renamed.map((r) => `${r.from} → ${r.to}`));
  if (verbose) {
    section('Skipped', plan.skipped.map((n) => `${n} — ${explain(undefined)}`));
    section('Files outside any project', plan.files.unowned);
  } else {
    if (plan.skipped.length) lines.push(`Skipped: ${plan.skipped.length} project(s) with no changes and no changed dependencies (set verbose: true to list)`);
    if (plan.files.unowned.length) lines.push(`Files outside any project: ${plan.files.unowned.length}`);
  }
  return lines.join('\n');
}

/** Code span for project names (already restricted to a safe charset; this is defence in depth). */
const code = (s: string) => `\`${s.replace(/[\x00-\x1f\x7f\u2028\u2029`|]+/g, ' ')}\``;

// File names are attacker-controlled (they come from the PR). Collapse control
// characters first so nothing can start a new Markdown line (heading, list,
// blockquote, table row), then entity-encode everything with inline meaning.
export const esc = (s: string) =>
  s.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').replace(/[&<>"'|`\\\[\]*_#~@:!=-]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Explains what auto-detection found and the rules it applied. Empty when detection is off. */
export function detectionLines(d: Detection | undefined, noConfigFile: boolean): string[] {
  if (!d) return [];
  const lines = [`Detected ${detectionSummary(d)}${noConfigFile ? ` (no ${CONFIG_FILE}, so projects come from marker files)` : ''}.`];
  for (const l of d.lockfiles) lines.push(`${l.file} changes select every ${l.kind} project (${l.projects}).`);
  if (d.projects.some((p) => p.targets.includes('docker'))) {
    lines.push('Projects with a Dockerfile or Containerfile get the docker and deploy targets; projects with a Chart.yaml get deploy.');
  }
  lines.push(d.projects.some((p) => p.path === '.')
    ? 'A project at the repository root owns every file that is not inside another project.'
    : 'Changed files outside every project (for example .github/ or root scripts) select nothing.');
  for (const n of d.notes) lines.push(`Note: ${n}.`);
  return lines;
}

export function markdownReport(plan: Plan, range: Range, notes: string[] = []): string {
  const out: string[] = [];
  out.push(`## ${NAME}`);
  out.push('');
  out.push(`**${plan.affected.length}** of **${plan.affected.length + plan.skipped.length}** projects affected · ` +
    `${TARGETS.map((t) => `${t} **${plan.targets[t].length}**`).join(' · ')} · ` +
    `${plan.files.total} changed file(s)`);
  out.push('');
  out.push(`Compared: ${esc(rangeLine(range))}`);
  if (plan.all) out.push('', `> [!WARNING]\n> All projects selected: ${esc(plan.allReason ?? '')}`);
  if (notes.length) {
    out.push('', '<details><summary>How projects were found</summary>', '', notes.map((n) => `- ${esc(n)}`).join('\n'), '', '</details>');
  }
  out.push('');
  if (plan.affected.length > 0) {
    out.push('| Project | Targets | Why |', '| --- | --- | --- |');
    for (const n of cap(plan.affected, 200)) {
      const targets = TARGETS.filter((t) => plan.targets[t].includes(n)).join(', ');
      out.push(`| ${code(n)} | ${targets || '—'} | ${esc(explain(plan.reasons.get(n)))} |`);
    }
    out.push('');
  }
  const extra: [string, string[]][] = [
    ['Added', plan.added],
    ['Deleted', plan.deleted],
    ['Renamed', plan.renamed.map((r) => `${r.from} → ${r.to}`)],
  ];
  for (const [title, items] of extra) if (items.length) out.push(`**${title}:** ${cap(items).map(code).join(', ')}`, '');
  if (plan.skipped.length) {
    out.push(`<details><summary>Skipped (${plan.skipped.length}) — no changed files and no dependency on a changed project</summary>`, '',
      cap(plan.skipped, 500).map(code).join(', '), '', '</details>', '');
  }
  if (plan.files.unowned.length) {
    out.push(`<details><summary>Changed files outside any project (${plan.files.unowned.length})</summary>`, '',
      cap(plan.files.unowned, 200).map((f) => `- ${esc(f)}`).join('\n'), '', '</details>', '');
  }
  return out.join('\n') + '\n';
}

/** Splits a list into at most `max` balanced batches, keeping dependency order inside each batch. */
export function batches(list: string[], max: number): string[][] {
  const n = Math.min(max, list.length);
  const out: string[][] = Array.from({ length: n }, () => []);
  list.forEach((name, i) => out[Math.floor((i * n) / list.length)]!.push(name));
  return out;
}

export function serialize(p: Plan) {
  return {
    all: p.all,
    allReason: p.allReason ?? null,
    changed: p.changed,
    affected: p.affected,
    build: p.targets.build,
    test: p.targets.test,
    deploy: p.targets.deploy,
    docker: p.targets.docker,
    added: p.added,
    deleted: p.deleted,
    renamed: p.renamed,
    skipped: p.skipped,
    paths: p.paths,
    dockerfiles: p.dockerfiles,
    reasons: Object.fromEntries([...p.reasons].sort(([a], [b]) => (a < b ? -1 : 1))),
    files: p.files,
  };
}
