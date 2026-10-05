# Configuration

The config file is optional. **Without it**, the action auto-detects projects from marker files, as described in the [README](../README.md#what-it-detects); that is the same as a config file containing only `{"detect": true}`.

When you need to change something, create `dynamic-monorepo.config.json` at the repository root. You can point the `config` input somewhere else (auto-detection without a file only applies to the default path). It's plain JSON with a published [JSON Schema](../schema.json), so editors autocomplete and validate it once you set `$schema`:

```json
{
  "$schema": "https://raw.githubusercontent.com/Continuous-Actions/dynamic-monorepo/v1/schema.json",
  "infer": ["node"],
  "projects": {
    "shared": { "path": "libs/shared" },
    "api": {
      "path": "services/api",
      "dependsOn": ["shared"],
      "targets": ["build", "test", "deploy"],
      "include": ["proto/api/**"],
      "exclude": ["services/api/docs/**"]
    },
    "web": { "path": "apps/web", "dependsOn": ["api"] }
  },
  "discover": ["packages/*"],
  "targets": {
    "deploy": { "exclude": ["**/*.test.ts", "**/__tests__/**"] }
  },
  "global": ["package-lock.json", ".github/workflows/**"],
  "ignore": ["**/*.md"]
}
```

There are four ways to define projects, and they combine. In priority order:

1. `projects`: explicit entries, which always win.
2. `infer` and `import`: read from workspace manifests (package.json workspaces, go.work, Cargo.toml) or from an Nx graph.
3. `detect`: auto-detection from marker files.
4. `discover`: one project per directory.

When an explicit entry has the same name or path as an inferred project, its settings win, but the inferred dependency edges are kept. So you only declare what the manifests can't express, such as `targets`.

## `projects`

| Key | Required | Notes |
| --- | --- | --- |
| `path` | yes | A repo-relative directory. `.` is the repository root. |
| `dependsOn` | no | A list of project names. Unknown names are an error, with a "did you mean" hint. |
| `targets` | no | `["build", "test", "deploy", "docker"]` or a subset. The default is `["build", "test"]`. In the object form, `{"build": {}, "deploy": {"exclude": [...]}}`, each target can have its own exclusions; see [per-target impact](#targets-per-target-impact). |
| `include` | no | Globs for files outside `path` that still belong to the project, such as a shared config file. |
| `exclude` | no | Globs for files under `path` that never count as changes. |

- **Names:** must match `^[A-Za-z0-9@][A-Za-z0-9._@/-]{0,213}$`. That allows npm package names like `@acme/web` and keeps characters with shell meaning out. `__proto__`, `constructor` and `prototype` are reserved.
- **Ownership:** a file belongs to the project with the **deepest** `path` that contains it, plus any project whose `include` matches it, minus any project whose `exclude` matches it.

## `detect`: auto-detection

`"detect": true` finds projects from marker files in the committed tree (`package.json`, `go.mod`, `Cargo.toml`, `*.csproj`, `pyproject.toml`, `setup.py`, `pom.xml`, `build.gradle(.kts)`, `Dockerfile`, `Containerfile`, `Chart.yaml`). The [README](../README.md#what-it-detects) lists the rules for names, targets, dependencies, lockfiles and skipped folders.

- It is **on** when there is no config file, and **off** when there is one, unless you set `"detect": true`.
- A project under `projects` with the same path replaces the detected one: your `targets`, `include` and `exclude` win, and the detected dependencies are added to your `dependsOn`.
- A detected name that is already used by another project falls back to the folder path.
- Only committed files are scanned (`git ls-files` for the checkout, `git ls-tree` for the base commit), so detection gives the same result on every machine.
- Limits: 2,000,000 files and 50,000 projects. Above that, set `"detect": false` and list projects explicitly.

## `infer`: dependencies from manifests

| Kind | Reads | Project name | Edges from |
| --- | --- | --- | --- |
| `node` | `package.json` `workspaces` (npm, Yarn, Bun) and `pnpm-workspace.yaml` | package `name` | `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies` that name another workspace package |
| `go` | `go.work` `use` directives, then each `go.mod` | directory, such as `services/api` | `require` and `replace` lines that name another workspace module |
| `cargo` | `Cargo.toml` `[workspace] members` and `exclude` | crate `name` | `path = ...` dependencies, and `workspace = true` dependencies that resolve to a member |

- **Patterns:** workspace patterns support exact directories, `dir/*` and `dir/**`. `**` goes up to 6 levels deep and skips `node_modules`, `vendor`, `target`, `dist`, `build` and dot-directories.
- **Exclusions:** `!` exclusions in `workspaces` are honoured.
- **Turborepo** uses the package.json workspace graph, so `"infer": ["node"]` gives you the same graph.

## `import`: Nx project graph

```json
{ "import": { "nx": "nx-graph.json" } }
```

Generate the file in an earlier step with `npx nx graph --file=nx-graph.json`. The action only reads the file; it never runs Nx.

- `npm:` external nodes are ignored.
- Every Nx dependency type (static, dynamic, implicit) becomes an edge.
- If the file doesn't exist at the base commit, `added`/`deleted` detection for imported projects is skipped. Changed files still select projects normally.

## `discover`

`"discover": ["packages/*"]` turns every immediate sub-directory into a project named after the directory. Explicit and inferred projects win over discovered ones.

## `targets`: per-target impact

By default, any change to a project selects it, and everything downstream, for all of its targets. Exclusions narrow that down per target:

```json
{
  "targets": { "deploy": { "exclude": ["**/*.test.ts", "**/__tests__/**"] } },
  "projects": {
    "api": { "path": "services/api", "targets": { "build": {}, "test": { "exclude": ["services/api/docs/**"] }, "deploy": {} } }
  }
}
```

A project appears in `deploy` only when it, or something it depends on, has a change that the deploy exclusions don't match. In the example:

- Editing only `libs/shared/foo.test.ts` re-tests everything downstream and redeploys nothing.
- Editing `services/api/docs/**` rebuilds and redeploys `api`, but doesn't re-test it.

Top-level `targets` apply to every project. Project-level exclusions are added on top. The `affected` output still lists every project touched by any change.

## Globs

Globs are always relative to the repository root:

- `*`: any characters within one path segment
- `**`: any number of segments
- `?`: exactly one character
- a trailing `/`: shorthand for `/**`

`*.md` matches only at the root; use `**/*.md` to match anywhere. Braces, character classes, negation and backslashes are rejected.

## Config changes between base and head

| Change | Effect |
| --- | --- |
| New project | Listed in `added` and affected. |
| Removed project | Listed in `deleted`. Never in `affected`. |
| Same path, new name | Listed in `renamed` (`{from, to}`). |
| Renamed **and** moved (most files git-renamed into the new project) | Listed in `renamed`. |
| A project's `path`, `dependsOn`, `targets`, `include` or `exclude` changed | That project and everything downstream are affected. |
| Top-level `global`, `ignore` or `targets` changed | Every project is affected. |
| The config file was added and there was nothing to auto-detect before, or the old version is unreadable | Every project is affected. |
| The config file was added to a repository that used auto-detection | Compared with what auto-detection found at the base commit, so only real differences select projects. |

Inferred projects are compared the same way. The base revision's manifests are read with `git show`, so a new workspace package shows up in `added`.

## Validation

All of these are hard errors:

- invalid JSON, including duplicate keys, reported with line and column
- unknown keys
- missing `path`
- absolute paths, `..` or `.git`
- two projects with the same path
- unknown dependencies
- **dependency cycles** (the full cycle is printed)
- invalid names
- unsupported glob syntax
- unknown `infer` kinds
- no projects at all (with auto-detection, the message lists the marker files it looked for)
- a missing Nx graph
- files over 1 MiB, or more than 50,000 projects
