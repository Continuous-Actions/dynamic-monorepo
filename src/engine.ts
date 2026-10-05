// The shared pipeline used by both the GitHub Action (main.ts) and the CLI (cli.ts):
// config -> comparison range -> diff -> plan.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigError, LIMITS, parseConfig, validateConfig, type Config, type RepoReader } from './config.ts';
import { Git } from './git.ts';
import { plan, type FileChange, type Plan } from './plan.ts';
import { resolveRange, type Range, type RangeInput } from './range.ts';
import { CONFIG_FILE, detectionLines } from './report.ts';

export type EngineInput = {
  cwd: string;
  config: string;
  fetch: boolean;
  range: Omit<RangeInput, 'fetch'>;
  log?: (msg: string) => void;
};

/** True when there is no config file and projects come from auto-detection alone. */
export type LoadedConfig = { git: Git; top: string; configRel: string; config: Config; noConfigFile: boolean };

export type EngineResult = { plan: Plan; range: Range; warnings: string[]; notes: string[] };

/** The configuration used when the default config file does not exist. */
const AUTO = { detect: true };

/** Loads the configuration from the working tree. Without the default config file, projects are auto-detected. */
export function loadConfig(cwd: string, configInput: string, log?: (msg: string) => void): LoadedConfig {
  const git = new Git(cwd, log);
  const top = git.toplevel();
  const configAbs = resolve(cwd, configInput);
  const configRel = relative(top, configAbs).split(sep).join('/');
  if (configRel.startsWith('..') || isAbsolute(configRel)) throw new ConfigError(configInput, ['config file must be inside the repository']);
  const reader = fsReader(top, git);
  if (!existsSync(configAbs)) {
    if (configInput !== CONFIG_FILE) {
      throw new ConfigError(configRel, ['file not found (check the "config" input; it is relative to "working-directory")']);
    }
    const config = validateConfig(AUTO, `(no ${configRel}; auto-detecting projects)`, reader);
    return { git, top, configRel, config, noConfigFile: true };
  }
  if (statSync(configAbs).size > LIMITS.configBytes) throw new ConfigError(configRel, [`file is larger than ${LIMITS.configBytes} bytes`]);
  const config = parseConfig(readFileSync(configAbs, 'utf8'), configRel, reader);
  return { git, top, configRel, config, noConfigFile: false };
}

export function execute(input: EngineInput): EngineResult {
  const { git, configRel, config: head, noConfigFile } = loadConfig(input.cwd, input.config, input.log);

  const { range, warnings } = resolveRange(git, { ...input.range, fetch: input.fetch });

  let changes: FileChange[] = [];
  let base: Config | null | undefined;
  if (range.kind === 'diff') {
    changes = git.diff(range.base, range.head);
    base = baseConfig(git, range.base, configRel, input.config === CONFIG_FILE, input.log);
  }
  const result = plan({ head, base, configPath: configRel, changes, forceAll: range.kind === 'all' ? range.why : undefined });
  return { plan: result, range, warnings, notes: detectionLines(head.detection, noConfigFile) };
}

/**
 * The configuration as it was at the base commit: the config file if it existed,
 * otherwise (default path only) auto-detection at that commit.
 * null = there was no configuration, undefined = it could not be read.
 */
function baseConfig(git: Git, rev: string, configRel: string, allowAuto: boolean, log?: (msg: string) => void): Config | null | undefined {
  const reader = gitReader(git, rev);
  const label = `${configRel}@${rev.slice(0, 12)}`;
  try {
    const text = git.show(rev, configRel);
    if (text !== undefined) return parseConfig(text, label, reader);
    if (!allowAuto) return null;
    try {
      return validateConfig(AUTO, `${label} (auto-detected)`, reader);
    } catch {
      return null; // nothing to detect at the base commit: treat as "no configuration"
    }
  } catch (err) {
    log?.(`base configuration unreadable: ${(err as Error).message}`);
    return undefined;
  }
}

/** Reads the working tree; the file list (for auto-detection) is the git index, so untracked and ignored files don't count. */
export function fsReader(top: string, git: Git): RepoReader {
  const read = (path: string) => {
    try {
      const abs = join(top, path);
      if (statSync(abs).size > LIMITS.configBytes) return undefined;
      return readFileSync(abs, 'utf8');
    } catch {
      return undefined;
    }
  };
  return {
    listDirs(dir) {
      try {
        return readdirSync(join(top, dir), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return [];
      }
    },
    read,
    listFiles: () => git.listFiles(),
    readMany(paths) {
      const out = new Map<string, string>();
      for (const p of paths) {
        const t = read(p);
        if (t !== undefined) out.set(p, t);
      }
      return out;
    },
  };
}

/** Reads files as they were at a commit, without touching the working tree. */
export function gitReader(git: Git, rev: string): RepoReader {
  return {
    listDirs: (dir) => git.listDirs(rev, dir),
    read: (path) => git.show(rev, path),
    listFiles: () => git.listFiles(rev),
    readMany: (paths) => git.readMany(rev, paths, LIMITS.configBytes),
  };
}
