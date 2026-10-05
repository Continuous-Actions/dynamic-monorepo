# dynamic-monorepo

**Dependency-aware affected-project planning for monorepos, built for GitHub Actions.**

`dynamic-monorepo` turns a git diff into the list of projects you actually need to build, test and deploy. It maps changed files to projects, walks your declared dependency graph to find everything downstream, and outputs JSON arrays ready for `strategy.matrix`. The job summary says why each project was picked.

```yaml
- uses: OpenMind-SI/dynamic-monorepo@v1
  id: plan
# steps.plan.outputs.build == '["shared","api","web"]'
```

- Single bundled JavaScript file (~84 KB). Nothing to install, no `npm install`, no Docker, no downloads at runtime.
- Works with a shallow `actions/checkout` (the default `fetch-depth: 1`). It fetches only the commits it needs, by SHA.
- Needs only `contents: read`. It runs no commands from your repository and never uses the GitHub API.
- Deterministic: the same inputs always give the same output, in dependency order.

## Why not `paths-filter`?

[`dorny/paths-filter`](https://github.com/dorny/paths-filter) and [`tj-actions/changed-files`](https://github.com/tj-actions/changed-files) tell you **which files changed**. Deciding **what to rebuild** is still up to you. If `libs/shared` changes, every service that imports it has to be rebuilt and retested. With path filters you end up hand-maintaining lists like `api: [services/api/**, libs/shared/**, libs/auth/**]`, and those lists go stale.

`dynamic-monorepo` stores the dependency graph once and computes the reverse-transitive closure for you:

```
shared ─▶ api ─▶ portal
```

| Change in | changed | affected |
| --- | --- | --- |
| `libs/shared/**` | `shared` | `shared`, `api`, `portal` |
| `services/api/**` | `api` | `api`, `portal` |
| `apps/portal/**` | `portal` | `portal` |

Nx, Turborepo, Bazel, Pants and moon do this too, but only inside their own toolchains, and none of them outputs a ready-made Actions matrix. See [docs/research.md](docs/research.md) for the full comparison.

## Quick start

**1. Describe your projects** in `dynamic-monorepo.config.json` at the repository root:

```json
{
  "$schema": "https://raw.githubusercontent.com/OpenMind-SI/dynamic-monorepo/v1/schema.json",
  "projects": {
    "shared": { "path": "libs/shared" },
    "api":    { "path": "services/api", "dependsOn": ["shared"], "targets": ["build", "test", "deploy"] },
    "portal": { "path": "apps/portal",  "dependsOn": ["api"],    "targets": ["build", "test", "deploy"] }
  },
  "global": ["package-lock.json"],
  "ignore": ["**/*.md"]
}
```

`global` lists files whose changes affect every project. `ignore` lists files whose changes affect nothing.

**Already have a workspace?** You don't have to list anything. The action can read the graph from your manifests:

```json
{ "infer": ["node"] }
```

`node` covers npm, Yarn, pnpm, Bun and Turborepo workspaces. You can also use `go` (go.work), `cargo` (Cargo workspaces), or import an Nx graph with `{ "import": { "nx": "nx-graph.json" } }`.

**2. Plan, then fan out:**

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      build: ${{ steps.plan.outputs.build }}
      paths: ${{ steps.plan.outputs.paths }}
      has_build: ${{ steps.plan.outputs.has_build }}
    steps:
      - uses: actions/checkout@v7
      - uses: OpenMind-SI/dynamic-monorepo@v1
        id: plan

  build:
    needs: plan
    if: needs.plan.outputs.has_build == 'true'   # an empty matrix is an error in Actions
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        project: ${{ fromJSON(needs.plan.outputs.build) }}
    steps:
      - uses: actions/checkout@v7
      - run: npm run build
        working-directory: ${{ fromJSON(needs.plan.outputs.paths)[matrix.project] }}
```

See [docs/examples/](docs/examples/) for a complete workflow with test and deploy fan-out and a required-check gate job.

## What the output looks like

Job outputs (all JSON values are compact and valid inside `fromJSON()`):

```text
changed     ["auth"]
affected    ["auth","api","admin","portal","reporting"]
build       ["auth","api","admin","portal","reporting"]
test        ["auth","api","admin","portal"]
deploy      ["api","admin","portal","reporting"]
skipped     ["shared","worker"]
paths       {"auth":"libs/auth","api":"services/api", ...}
has_changes true    has_build true    has_test true    has_deploy true
all         false   (true when a global file changed or no comparison base exists)
```

The log, and the job summary as a table, read like this:

```text
dynamic-monorepo: 5 affected / 7 projects
Compared: 09594672b857..63ef87f87cae (pull request merge commit vs its base parent)
Changed files: 1
Directly affected (1):
  auth — 1 changed file: libs/auth/src/token.ts
Transitively affected (4):
  api — depends on auth (auth → api)
  admin — depends on auth (auth → admin)
  portal — depends on auth (auth → api → portal)
  reporting — depends on auth (auth → api → reporting)
Skipped: 2 project(s) with no changes and no changed dependencies (set verbose: true to list)
```

The complete output reference is in [docs/outputs.md](docs/outputs.md).

## How it works

1. **Pick the comparison** from the event ([docs/git.md](docs/git.md)):
   - `pull_request`: GitHub's test-merge commit is compared with its first parent, so you get exactly what the PR would change.
   - `push`: compares `before` with `after`. A new branch is compared with the default branch.
   - `merge_group`: compares `base_sha` with `head_sha`.
   - Anything else: compares against the `base` input, or selects all projects.
2. **Diff** with `git diff --name-status -z -M`, which counts both the old and the new path of a rename.
3. **Assign files to projects** by the deepest matching `path`, then apply `include`/`exclude` globs. `global` files select every project. `ignore` files are dropped.
4. **Compare configs.** The config at the base commit is checked against the current one to find added, deleted and renamed projects, and projects whose definition changed.
5. **Walk the graph** in reverse, breadth-first from the changed projects. The result is sorted topologically, with ties broken by name.
6. **Write outputs**, a job summary and a full plan JSON file.

If the correct comparison can't be worked out (no base, history that can't be fetched, an unknown event), every project is selected with a warning. **The action never silently reports "nothing changed".**

## Configuration

| Key | Meaning |
| --- | --- |
| `projects.<name>.path` | Directory owned by the project (required). The deepest match wins for nested projects. `.` means the repository root. |
| `projects.<name>.dependsOn` | Projects this one depends on. A change to any of them affects this project. |
| `projects.<name>.targets` | Which of `build`, `test`, `deploy` lists the project appears in. Default `["build", "test"]`. The object form adds per-target `exclude` globs. |
| `projects.<name>.include` / `exclude` | Extra globs that belong to the project, or that it should ignore. |
| `infer` | `["node", "go", "cargo"]`: read projects and dependencies from workspace manifests. |
| `import` | `{"nx": "nx-graph.json"}`: use the graph from `nx graph --file`. |
| `discover` | `["packages/*"]`: every sub-directory becomes a project named after the directory. |
| `targets` | `{"deploy": {"exclude": ["**/*.test.ts"]}}`: changes that never trigger a target, such as test-only edits not causing a redeploy. |
| `global` | Globs whose changes select every project. |
| `ignore` | Globs whose changes are ignored everywhere. |

Globs are relative to the repository root and support `*`, `**` and `?`. Invalid JSON (including duplicate keys), cycles, unknown dependencies, unknown keys, duplicate paths and unsafe names or paths are all hard errors with clear messages. Full reference: [docs/configuration.md](docs/configuration.md).

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config` | `dynamic-monorepo.config.json` | Config file path. |
| `base` | — | Ref or SHA to compare against (merge-base with HEAD). Overrides event detection. |
| `head` | `HEAD` | Revision to compare. |
| `fetch` | `true` | Fetch missing commits by SHA in shallow clones. |
| `summary` | `true` | Write the job summary. |
| `verbose` | `false` | List skipped projects, unowned files, git commands and the full plan. |
| `max-jobs` | `256` | Maximum entries in each `*_batches` output. |
| `working-directory` | `.` | Directory of the repository to analyse. |

## Preview locally (CLI)

The same engine runs on your machine, so you can see what CI would run before you push:

```bash
npx github:OpenMind-SI/dynamic-monorepo --base origin/main
```

Other flags: `--json` (full plan with reasons), `--uncommitted` (include working-tree edits) and `--verbose`. Run `--help` for the full list.

## Very large monorepos

GitHub caps a matrix at 256 jobs. If a list can be longer than that, use `build_batches` (also `test_batches` and `deploy_batches`). It holds at most `max-jobs` balanced groups that together contain every project, in dependency order:

```yaml
strategy:
  matrix:
    batch: ${{ fromJSON(needs.plan.outputs.build_batches) }}
steps:
  - run: for p in $BATCH; do ./build.sh "$p"; done
    env:
      BATCH: ${{ join(matrix.batch, ' ') }}
```

## Performance

The planner is dominated by Node startup and `git`, not by graph work. Measured numbers are in [docs/benchmarks.md](docs/benchmarks.md):

- 1,000 projects with 10,000 changed files plans in well under 100 ms in-process.
- 10,000 projects with 100,000 changed files still plans in under a second.
- End to end on a hosted `ubuntu-latest` runner, including Node startup and `git diff`: about **50 ms** for 10 projects, **105 ms** for 1,000 projects with 1,000 changed files, and **233 ms** for 5,000 projects with 10,000 changed files.

## Security

The config file and git data are treated as untrusted input:

- The config is parsed by a strict JSON parser that rejects duplicate keys. Manifests are only read, never executed.
- Data is stored in `Map`s, so it can't pollute prototypes.
- Paths are normalised, and `..` and absolute paths are rejected.
- Project names are restricted to a shell-safe character set.
- Git is run with `execFile` and argument arrays, never through a shell.
- Revisions are validated before use.
- File names are neutralised in logs so they can't inject workflow commands.

See [SECURITY.md](SECURITY.md) and [docs/decisions.md](docs/decisions.md#security-model).

## Limitations

- Inference reads manifests (package.json, go.work/go.mod, Cargo.toml) and Nx graph files. It doesn't analyse source imports.
- A project is detected as renamed *and* moved only when git reports most of its files as renamed into the new location.
- Dependency edges are project-level. Per-target graphs (for example, a test that depends on another project's deployment) aren't modelled yet.

## License

[MIT](LICENSE) © OpenMind-SI
