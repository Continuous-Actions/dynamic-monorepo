// Zero-dependency implementation of the GitHub Actions runner protocol:
// inputs, outputs, job summary, annotations and log groups.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EOL } from 'node:os';

export function getInput(name: string, fallback = ''): string {
  const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

export function getBoolean(name: string, fallback: boolean): boolean {
  const v = getInput(name, String(fallback)).toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'off'].includes(v)) return false;
  throw new Error(`input "${name}" must be true or false, got "${v.slice(0, 20)}"`);
}

/** Writes an output using a random heredoc delimiter that cannot appear in the value. */
export function setOutput(name: string, value: string): void {
  const file = process.env['GITHUB_OUTPUT'];
  if (!file) {
    process.stdout.write(`${name}=${value}${EOL}`);
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  if (name.includes(delimiter) || value.includes(delimiter)) throw new Error('output delimiter collision');
  appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`, 'utf8');
}

export function appendSummary(markdown: string): boolean {
  const file = process.env['GITHUB_STEP_SUMMARY'];
  if (!file) return false;
  appendFileSync(file, markdown, 'utf8');
  return true;
}

function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function command(cmd: 'error' | 'warning' | 'notice' | 'debug', message: string, props: Record<string, string> = {}): void {
  const p = Object.entries(props).map(([k, v]) => `${k}=${escapeProperty(v)}`).join(',');
  process.stdout.write(`::${cmd}${p ? ` ${p}` : ''}::${escapeData(message)}${EOL}`);
}

/**
 * Makes untrusted text (file names, config values) inert in the log: the runner
 * treats "::cmd::" after leading whitespace and "##[cmd]" anywhere in a line as
 * workflow commands, and also splits lines on a lone \r.
 */
export function neutralise(line: string): string {
  return line
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?')
    .replace(/::/g, ':\u200b:')
    .replace(/##\[/g, '#\u200b#[');
}

export function info(message: string): void {
  process.stdout.write(message.split(/\r\n|\r|\n|\u2028|\u2029/).map(neutralise).join(EOL) + EOL);
}

export function group(title: string, body: () => void): void {
  process.stdout.write(`::group::${escapeData(title)}${EOL}`);
  try {
    body();
  } finally {
    process.stdout.write(`::endgroup::${EOL}`);
  }
}
