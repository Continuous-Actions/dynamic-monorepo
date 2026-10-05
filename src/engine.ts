// The shared pipeline used by both the GitHub Action (main.ts) and the CLI (cli.ts):
// config -> comparison range -> diff -> plan.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigError, LIMITS, parseConfig, type Config, type RepoReader } from './config.ts';
import { Git } from './git.ts';
import { plan, type FileChange, type Plan } from './plan.ts';
import { resolveRange, type Range, type RangeInput } from './range.ts';
import { NAME } from './report.ts';

export type EngineInput = {
  cwd: string;
  config: string;
  fetch: boolean;
  range: Omit<RangeInput, 'fetch'>;
  log?: (msg: string) => void;
};

export type EngineResult = { plan: Plan; range: Range; warnings: string[] };

export function execute(input: EngineInput): EngineResult {
  const git = new Git(input.cwd, input.log);
  const top = git.toplevel();
  const configAbs = resolve(input.cwd, input.config);
  const configRel = relative(top, configAbs).split(sep).join('/');
  if (configRel.startsWith('..') || isAbsolute(configRel)) throw new ConfigError(input.config, ['config file must be inside the repository']);
  if (!existsSync(configAbs)) {
    throw new ConfigError(configRel, [`file not found (create it, or set the "config" input). See https://github.com/OpenMind-SI/${NAME}#configuration`]);
  }
  if (statSync(configAbs).size > LIMITS.configBytes) throw new ConfigError(configRel, [`file is larger than ${LIMITS.configBytes} bytes`]);
  const head = parseConfig(readFileSync(configAbs, 'utf8'), configRel, fsReader(top));

  const { range, warnings } = resolveRange(git, { ...input.range, fetch: input.fetch });

  let changes: FileChange[] = [];
  let base: Config | null | undefined;
  if (range.kind === 'diff') {
    changes = git.diff(range.base, range.head);
    const baseText = git.show(range.base, configRel);
    if (baseText === undefined) base = null;
    else {
      try {
        base = parseConfig(baseText, `${configRel}@${range.base.slice(0, 12)}`, gitReader(git, range.base));
      } catch (err) {
        base = undefined;
        input.log?.(`base configuration unreadable: ${(err as Error).message}`);
      }
    }
  }
  const result = plan({ head, base, configPath: configRel, changes, forceAll: range.kind === 'all' ? range.why : undefined });
  return { plan: result, range, warnings };
}

/** Reads the working tree. Paths are repo-relative and already validated. */
export function fsReader(top: string): RepoReader {
  return {
    listDirs(dir) {
      try {
        return readdirSync(join(top, dir), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return [];
      }
    },
    read(path) {
      try {
        const abs = join(top, path);
        if (statSync(abs).size > LIMITS.configBytes) return undefined;
        return readFileSync(abs, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/** Reads files as they were at a commit, without touching the working tree. */
export function gitReader(git: Git, rev: string): RepoReader {
  return { listDirs: (dir) => git.listDirs(rev, dir), read: (path) => git.show(rev, path) };
}
