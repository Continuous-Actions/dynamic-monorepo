// The shared pipeline used by both the GitHub Action (main.ts) and the CLI (cli.ts):
// config -> comparison range -> diff -> plan.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
  // Compare real paths: the workspace may be reached through a symlink, junction or 8.3 short name.
  const top = realpath(git.toplevel());
  const configAbs = resolve(realpath(input.cwd), input.config);
  const configRel = relative(top, configAbs).split(sep).join('/');
  if (configRel === '..' || configRel.startsWith('../') || isAbsolute(configRel)) {
    throw new ConfigError(input.config, ['config file must be inside the repository']);
  }

  const { range, warnings } = resolveRange(git, { ...input.range, fetch: input.fetch });

  // The head configuration and manifests are read from the compared head commit, not the
  // working tree, so pull_request_target, an explicit "head" input and local edits can't
  // make the plan disagree with the diff. Untracked and ignored files never count.
  const headRev = range.head ?? git.resolve('HEAD');
  if (!headRev) throw new ConfigError(configRel, ['no commit to read the configuration from']);
  const headText = git.show(headRev, configRel);
  if (headText === undefined) {
    const hint = existsSync(configAbs) ? ' It exists in the working tree but is not committed at that revision.' : '';
    throw new ConfigError(configRel, [`file not found at ${headRev.slice(0, 12)}.${hint} Create it, or set the "config" input. See https://github.com/OpenMind-SI/${NAME}#configuration`]);
  }
  const head = parseConfig(headText, configRel, gitReader(git, headRev));
  warnings.push(...head.warnings);

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

function realpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
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
  let dirs: Set<string> | undefined;
  return {
    listDirs: (dir) => git.listDirs(rev, dir),
    read: (path) => git.show(rev, path),
    dirs: () => (dirs ??= git.allDirs(rev)),
  };
}
