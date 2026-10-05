# dynamic-monorepos

**Dependency-aware affected-project planning for monorepos, built for GitHub Actions.**

`dynamic-monorepos` turns a git diff into the list of projects you actually need to build, test and deploy. It maps changed files to projects, walks your declared dependency graph to find everything downstream, and outputs JSON arrays ready for `strategy.matrix`. The job summary says why each project was picked.

```yaml
- uses: OpenMind-SI/dynamic-monorepos@v1
  id: plan
# steps.plan.outputs.build == '["shared","api","web"]'
```

- Single bundled JavaScript file (~71 KB). Nothing to install, no `npm install`, no Docker, no downloads at runtime.
- Works with a shallow `actions/checkout` (the default `fetch-depth: 1`). It fetches only the commits it needs, by SHA.
- Needs only `contents: read`. It runs no commands from your repository and never uses the GitHub API.
- Deterministic: the same inputs always give the same output, in dependency order.

## Why not `paths-filter`?

[`dorny/paths-filter`](https://github.com/dorny/paths-filter) and [`tj-actions/changed-files`](https://github.com/tj-actions/changed-files) tell you **which files changed**. Deciding **what to rebuild** is still up to you. If `libs/shared` changes, every service that imports it has to be rebuilt and retested. With path filters you end up hand-maintaining lists like `api: [services/api/**, libs/shared/**, libs/auth/**]`, and those lists go stale.

`dynamic-monorepos` stores the dependency graph once and computes the reverse-transitive closure for you:

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

**1. Describe your projects** in `.github/dynamic-monorepos.yml`:

```yaml
projects:
  shared:
    path: libs/shared
  api:
    path: services/api
    dependsOn: [shared]
    targets: [build, test, deploy]
  portal:
    path: apps/portal
    dependsOn: [api]
    targets: [build, test, deploy]

global:            # changes here affect every project
  - package-lock.json
ignore:            # changes here affect nothing
  - "**/*.md"
```

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
      - uses: OpenMind-SI/dynamic-monorepos@v1
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

See [examples/](examples/) for a complete workflow with test and deploy fan-out and a required-check gate job.

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
dynamic-monorepos: 5 affected / 7 projects
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
| `projects.<name>.targets` | Which of `build`, `test`, `deploy` lists the project appears in. Default `[build, test]`. |
| `projects.<name>.include` / `exclude` | Extra globs that belong to the project, or that it should ignore. |
| `discover` | `["packages/*"]`: every sub-directory becomes a project named after the directory. |
| `global` | Globs whose changes select every project. |
| `ignore` | Globs whose changes are ignored everywhere. |

Globs are relative to the repository root and support `*`, `**` and `?`. Cycles, unknown dependencies, unknown keys, duplicate paths and unsafe names or paths are all hard errors with clear messages. Full reference: [docs/configuration.md](docs/configuration.md).

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config` | `.github/dynamic-monorepos.yml` | Config file path. |
| `base` | — | Ref or SHA to compare against (merge-base with HEAD). Overrides event detection. |
| `head` | `HEAD` | Revision to compare. |
| `fetch` | `true` | Fetch missing commits by SHA in shallow clones. |
| `summary` | `true` | Write the job summary. |
| `verbose` | `false` | List skipped projects, unowned files, git commands and the full plan. |
| `working-directory` | `.` | Directory of the repository to analyse. |

## Performance

The planner is dominated by Node startup and `git`, not by graph work. Measured numbers are in [docs/benchmarks.md](docs/benchmarks.md):

- 1,000 projects with 10,000 changed files plans in well under 100 ms in-process.
- 10,000 projects with 100,000 changed files still plans in under a second.
- End to end on a real repository (including Node startup and `git diff`), the action typically finishes in a few hundred milliseconds.

## Security

The config file and git data are treated as untrusted input:

- YAML is parsed with the core schema only.
- Data is stored in `Map`s, so it can't pollute prototypes.
- Paths are normalised, and `..` and absolute paths are rejected.
- Project names are restricted to a shell-safe character set.
- Git is run with `execFile` and argument arrays, never through a shell.
- Revisions are validated before use.
- File names are neutralised in logs so they can't inject workflow commands.

See [SECURITY.md](SECURITY.md) and [docs/decisions.md](docs/decisions.md#security-model).

## Limitations

- Dependencies are declared, not inferred. `package.json`, `go.mod` and similar files are not read yet.
- A single matrix is capped at 256 jobs by GitHub. The action warns when a list is longer.
- A project that is renamed *and* moved in the same change shows up as deleted + added.

## License

[MIT](LICENSE) © OpenMind-SI
