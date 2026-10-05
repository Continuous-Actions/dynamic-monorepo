# Configuration

The config file is `dynamic-monorepo.config.json` at the repository root. You can point the `config` input somewhere else. It's plain JSON with a published [JSON Schema](../schema.json), so editors autocomplete and validate it once you set `$schema`:

```json
{
  "$schema": "https://raw.githubusercontent.com/OpenMind-SI/dynamic-monorepos/v1/schema.json",
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

There are three ways to define projects, and they combine. In priority order:

1. `projects`: explicit entries, which always win.
2. `infer` and `import`: read from manifests (package.json, go.work, Cargo.toml) or from an Nx graph.
3. `discover`: one project per directory.

When an explicit entry has the same name or path as an inferred project, its settings win, but the inferred dependency edges are kept. So you only declare what the manifests can't express, such as `targets`.

## `projects`

| Key | Required | Notes |
| --- | --- | --- |
| `path` | yes | A repo-relative directory. `.` is the repository root. |
| `dependsOn` | no | A list of project names. Unknown names are an error, with a "did you mean" hint. |
| `targets` | no | `["build", "test", "deploy"]` or a subset. The default is `["build", "test"]`. In the object form, `{"build": {}, "deploy": {"exclude": [...]}}`, each target can have its own exclusions; see [per-target impact](#targets-per-target-impact). |
| `include` | no | Globs for files outside `path` that still belong to the project, such as a shared config file. |
| `exclude` | no | Globs for files under `path` that never count as changes. |

- **Names:** must match `^[A-Za-z0-9@][A-Za-z0-9._@/-]{0,213}$`. That allows npm package names like `@acme/web` and keeps characters with shell meaning out. `__proto__`, `constructor` and `prototype` are reserved.
- **Ownership:** a file belongs to the project with the **deepest** `path` that contains it, plus any project whose `include` matches it, minus any project whose `exclude` matches it.

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
| The config file was added, or the old version is unreadable | Every project is affected. |

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
- a missing Nx graph
- files over 1 MiB, or more than 50,000 projects
