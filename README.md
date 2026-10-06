# dynamic-monorepo

<!-- Scorecard URLs are case-sensitive: keep the org login "continuous-actions". -->
[![CI](https://github.com/continuous-actions/dynamic-monorepo/actions/workflows/ci.yml/badge.svg)](https://github.com/continuous-actions/dynamic-monorepo/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/continuous-actions/dynamic-monorepo?sort=semver)](https://github.com/continuous-actions/dynamic-monorepo/releases)
[![Marketplace](https://img.shields.io/badge/marketplace-dynamic--monorepo-blue?logo=github)](https://github.com/marketplace/actions/dynamic-monorepo)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/continuous-actions/dynamic-monorepo/badge)](https://scorecard.dev/viewer/?uri=github.com/continuous-actions/dynamic-monorepo)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Build, test and deploy only the projects a change affects. No config file needed.**

![A pull request changes libs/shared; dynamic-monorepo detects five projects, selects shared plus the two projects that depend on it, and skips the rest](docs/assets/hero.png)

`dynamic-monorepo` reads the git diff, finds the projects in your repository on its own (from `package.json`, `go.mod`, `Dockerfile` and similar files), follows the dependencies between them, and gives you JSON lists for a GitHub Actions matrix. Change a shared library and everything that uses it is rebuilt. Change a Dockerfile and that image is rebuilt. The job summary says why each project was picked.

**In use:** [rajadilipkolli/spring-boot-microservices-series-v2](https://github.com/rajadilipkolli/spring-boot-microservices-series-v2/pull/1775) builds its services with it, and [uni-helper/create-uni](https://github.com/uni-helper/create-uni/pull/194) runs the path-filter audit. Gaps the audit found have been fixed in [rhesis](https://github.com/rhesis-ai/rhesis/pull/2903), [GitWand](https://github.com/devlint/GitWand/pull/210) and [nagiyu-platform](https://github.com/nagiyu/nagiyu-platform/issues/3966).

**See it live:** the [demo monorepo](https://github.com/continuous-actions/dynamic-monorepo-demo) (Node, Go and Docker, no config) has pull requests showing what runs for a shared-library change, a Dockerfile change and a docs-only change.

<!-- toc -->
**Contents**

- [Quick start](#quick-start)
- [Already using `on.paths`? Audit it](#already-using-onpaths-audit-it)
- [What it detects](#what-it-detects)
- [What you get](#what-you-get)
- [Customising](#customising)
- [Troubleshooting](#troubleshooting)
- [For AI agents](#for-ai-agents)
- [FAQ](#faq)
- [Security](#security)
- [Inputs](#inputs)
- [How it works](#how-it-works)
- [Performance](#performance)
- [Limitations](#limitations)
- [License](#license)
<!-- /toc -->

## Quick start

> **Status:** v1 is stable. Inputs and outputs won't change incompatibly within `v1`.

Add this file as `.github/workflows/ci.yml` and open a pull request. That's the whole setup.

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
      docker: ${{ steps.plan.outputs.docker }}
      paths: ${{ steps.plan.outputs.paths }}
      dockerfiles: ${{ steps.plan.outputs.dockerfiles }}
      has_build: ${{ steps.plan.outputs.has_build }}
      has_docker: ${{ steps.plan.outputs.has_docker }}
    steps:
      - uses: actions/checkout@v7
      - uses: continuous-actions/dynamic-monorepo@v1
        id: plan

  build:
    needs: plan
    if: needs.plan.outputs.has_build == 'true'   # an empty matrix would fail the job
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        project: ${{ fromJSON(needs.plan.outputs.build) }}
    steps:
      - uses: actions/checkout@v7
      - name: Build
        working-directory: ${{ fromJSON(needs.plan.outputs.paths)[matrix.project] }}
        run: echo "replace with your build command"

  docker:
    needs: plan
    if: needs.plan.outputs.has_docker == 'true'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        project: ${{ fromJSON(needs.plan.outputs.docker) }}
    steps:
      - uses: actions/checkout@v7
      - name: Build image
        env:
          DIR: ${{ fromJSON(needs.plan.outputs.paths)[matrix.project] }}
          FILE: ${{ fromJSON(needs.plan.outputs.dockerfiles)[matrix.project] }}
        run: docker build -f "$FILE" "$DIR"
```

- The default `actions/checkout` (shallow, `fetch-depth: 1`) is enough. The action fetches only the commits it needs.
- It needs only `contents: read`, never runs code from your repository, and doesn't call the GitHub API. See [Security](#security).
- Add a `test` or `deploy` job the same way, using the `test`/`has_test` or `deploy`/`has_deploy` outputs.

**Already have one workflow per service?** Keep your reusable workflow and call it once per affected project: [docs/examples/reusable](docs/examples/reusable/workflow.yml).

To see what it finds before you push, run this in your repository:

```bash
npx github:continuous-actions/dynamic-monorepo projects            # every project, its folder, targets and dependencies
npx github:continuous-actions/dynamic-monorepo --base origin/main  # what CI would run for your branch
```

## Already using `on.paths`? Audit it

You don't have to change how your CI is triggered to get value. Add one step and it checks every workflow's `paths:` list against your real dependency graph:

```yaml
name: Path filter audit
on: pull_request
permissions:
  contents: read
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: continuous-actions/dynamic-monorepo@v1
        with:
          audit: warn   # or "fail" to block the PR
```

It annotates the workflow file and lists in the job summary:

- a package a workflow builds depends on (directly or transitively), but its folder isn't in `paths:`, so a change there silently skips that workflow
- a directory listed without `/**`, which matches nothing inside it
- a `.github/workflows/...` entry that no longer exists

Run it locally with `npx github:continuous-actions/dynamic-monorepo audit`. On a sample of active public monorepos, about a third had at least one of these problems.

**Prefer not to add an action?** `npx github:continuous-actions/dynamic-monorepo audit --fix` writes the missing folders into those `paths:` lists and adds `/**` to bare directories, then you commit the diff. It edits only the `paths` lists and keeps your comments and quoting. A list it can't edit safely (YAML anchors, multi-line entries) is reported instead, along with stale workflow references, which need a human.

## What it detects

A **project** is a folder that contains one of these files. A changed file belongs to the closest project folder above it.

| File | Kind | Dependencies come from |
| --- | --- | --- |
| `package.json` | node | `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` naming another detected package |
| `go.mod` | go | `require` and `replace` lines naming another detected module. A module with several `package main` folders is split into one project per package, linked by its own imports |
| `Cargo.toml` with `[package]` | cargo | `path` dependencies, and `workspace = true` dependencies with a path |
| `*.csproj`, `*.fsproj`, `*.vbproj` | dotnet | `<ProjectReference Include="...">` |
| `pyproject.toml`, `setup.py` | python | local path dependencies: `[tool.uv.sources]`, Poetry `path =` dependencies, and `@ file:` requirements |
| `pom.xml`, `build.gradle`, `build.gradle.kts` | maven, gradle | Maven `<parent>` and sibling `<dependency>` artifacts, Gradle `project(':a:b')`. Aggregator poms build nothing |
| `Dockerfile`, `Containerfile`, `*.Dockerfile`, `Dockerfile.*` | docker | — |
| `Chart.yaml` | helm | — |

- **Names:** the package name from `package.json` or `Cargo.toml` when it is unique, otherwise the folder path (`services/api`). A project at the repository root is called `root`.
- **Lists:** every project is in `build` and `test`. Projects with a Dockerfile or Containerfile are also in `docker` and `deploy`. Projects with a `Chart.yaml` are also in `deploy`.
- **Lockfiles** at the root (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `go.work.sum`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`) select every project of their ecosystem. Changing `yarn.lock` rebuilds the node projects, not the Go ones.
- **Not projects:** a root `package.json` that declares `workspaces` (or sits next to `pnpm-workspace.yaml`), a `Cargo.toml` without `[package]`, and anything under `node_modules`, `vendor`, `dist`, `build`, `target`, `out`, `bin`, `obj`, `testdata`, `fixtures`, `__fixtures__`, `__tests__` or a folder starting with `.`.
- **Only committed files count.** Untracked and ignored files are never scanned.
- **Files outside every project**, such as `.github/` or root scripts, select nothing, and the summary lists them. The exception is a project at the root (for example a root `package.json` without `workspaces`): it owns every file that isn't inside another project.
- **No usable comparison** (for example a manual run without a `base` input) selects every project, with a warning. The action never reports "nothing changed" just because it couldn't compare.

## What you get

```text
build        ["@acme/shared","@acme/web"]
test         ["@acme/shared","@acme/web"]
docker       ["@acme/web"]
deploy       ["@acme/web"]
paths        {"@acme/shared":"packages/shared","@acme/web":"apps/web"}
dockerfiles  {"@acme/web":"apps/web/Dockerfile"}
has_build true   has_test true   has_docker true   has_deploy true   all false
```

Lists are in dependency order: dependencies before the projects that use them. The log and job summary explain each choice:

```text
dynamic-monorepo: 2 affected / 5 projects
Compared: 09594672b857..63ef87f87cae (pull request merge commit vs its base parent)
Detected 5 projects: 2 node, 2 go, 2 docker (no dynamic-monorepo.config.json, so projects come from marker files).
yarn.lock changes select every node project (2).
Directly affected (1):
  @acme/shared — 1 changed file: packages/shared/index.ts
Transitively affected (1):
  @acme/web — depends on @acme/shared (@acme/shared → @acme/web)
```

All outputs: [docs/outputs.md](docs/outputs.md).

## Customising

You only need a config file to change what was detected. Create `dynamic-monorepo.config.json` at the repository root:

```json
{
  "$schema": "https://raw.githubusercontent.com/continuous-actions/dynamic-monorepo/v1/schema.json",
  "detect": true,
  "projects": {
    "web": { "path": "apps/web", "dependsOn": ["proto"], "targets": ["build", "test", "deploy"] },
    "proto": { "path": "proto" }
  },
  "global": [".github/workflows/**"],
  "ignore": ["**/*.md"]
}
```

- `"detect": true` keeps auto-detection on. **Once a config file exists, detection is off unless you set this.** Without it, list every project under `projects`.
- An entry under `projects` overrides the detected project at the same path. Detected dependencies are kept and added to yours.
- `global`: files whose changes select every project. `ignore`: files whose changes select nothing.
- You can also read dependencies from workspace files (`"infer": ["node", "go", "cargo"]`), import an Nx graph, or turn every sub-folder into a project (`"discover": ["services/*"]`).

The full reference, including per-target exclusions such as "test-only changes don't redeploy", is in [docs/configuration.md](docs/configuration.md).

## Troubleshooting

**The build job was skipped, or failed with "Matrix vector 'project' does not contain any values".** Nothing that job builds was affected. Keep the `if: needs.plan.outputs.has_build == 'true'` line, and read the plan job's summary to see what was compared.

**A project is missing, or has an odd name.** Run `npx github:continuous-actions/dynamic-monorepo projects`. Check that its marker file is committed and not inside a skipped folder (see [What it detects](#what-it-detects)). To add or rename a project, use a config file with `"detect": true` and an entry under `projects`.

**A change didn't select the project I expected.** The file is probably outside every project folder. Run with `verbose: true` to list such files. Add the file to that project's `include`, or to `global`.

**Every project was selected.** The warning and the `reason` output say why. The usual causes:

- A manual or scheduled run: there is nothing to compare with. Set the `base` input, for example `base: main`.
- A tag push, or a push whose previous commit no longer exists (force push).
- A file listed in `global` changed, or `global`, `ignore` or `targets` changed in the config file.
- History couldn't be fetched: with `persist-credentials: false` on a private repository, use `fetch-depth: 0`. See [docs/git.md](docs/git.md).

**Why was this project picked?** The job summary has a reason for each project. For the full detail, read the `plan_file` output, or run the CLI with `--json`.

**Making it a required check.** Skipped matrix jobs count as passed, but a workflow that never runs leaves a required check pending forever. Run the workflow on every pull request and require one gate job: see [docs/outputs.md](docs/outputs.md#patterns) and the [realistic example](docs/examples/realistic/workflow.yml).

**More than 256 projects in one list.** GitHub allows 256 jobs per matrix. Use `build_batches` (and `test_batches`, `deploy_batches`, `docker_batches`): each entry is a list of projects.

```yaml
strategy:
  matrix:
    batch: ${{ fromJSON(needs.plan.outputs.build_batches) }}
steps:
  - run: for p in $BATCH; do ./build.sh "$p"; done
    env:
      BATCH: ${{ join(matrix.batch, ' ') }}
```

## For AI agents

If you set up CI with an AI coding agent, this repository has machine-readable guidance for it:

- [`llms.txt`](llms.txt): what the action does, when to use it, the canonical workflow and every output.
- An [Agent Skill](skills/dynamic-monorepo/SKILL.md) (`SKILL.md`) that skill-aware agents, including Claude Code, can install to set up selective monorepo CI.
- A [JSON Schema](schema.json) for the optional config, and `--json` output from the CLI to check the plan.

A prompt to try: *"Set up GitHub Actions for this monorepo so that only changed projects and their dependents are built, using continuous-actions/dynamic-monorepo."*

## FAQ

**Does it need a token or secrets?** No. It reads the checked-out repository and runs `git`; the default `contents: read` permission is enough.

**Does it work with a shallow checkout?** Yes. The default `actions/checkout` (depth 1) is enough: missing commits are fetched by SHA. See [docs/git.md](docs/git.md).

**Pull requests, pushes, merge queues?** All of them. A pull request is compared with its base, a push with the previous commit, and a merge queue entry with its base. Manual and scheduled runs select every project unless you set `base`.

**Can I use it with Nx, Turborepo, pnpm, Go workspaces or Cargo workspaces?** Yes. Detection works on any of them as-is; a config file can also read an Nx graph or workspace manifests directly. See [docs/configuration.md](docs/configuration.md).

**I already have one workflow per service with `on.paths`. How do I switch?**  Follow [docs/migrating-from-path-filters.md](docs/migrating-from-path-filters.md): preview the detected projects, map each `paths` entry, and replace the per-service workflows with one workflow and one required check.

**What if it picks too much or too little?** Every decision is explained in the job summary. Add a config file to override names, dependencies, targets or global files; nothing else changes.

## Security

- **Permissions:** `contents: read` only. No secrets, no GitHub API calls, no third-party network access (it only fetches missing commits from your own `origin`).
- **Nothing from your repository is executed.** Manifests are parsed as data with size limits and a strict JSON parser; `git` runs without a shell and with repository diff drivers disabled. Project names and paths are limited to shell-safe characters, and file names can't inject workflow commands into logs. Details: [docs/decisions.md](docs/decisions.md#security-model).
- **What runs is what you can read:** `dist/` is committed and CI fails if it differs from a fresh build of `src/`. There is one bundled runtime dependency.
- **Pin it:** releases are immutable. For the strictest setup, pin a full commit SHA and let Dependabot update it:

  ```yaml
  - uses: continuous-actions/dynamic-monorepo@<commit-sha> # v1.0.0
  ```

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config` | `dynamic-monorepo.config.json` | Config file path. Optional: without it, projects are auto-detected. |
| `base` | — | Ref or SHA to compare against (merge-base with HEAD). Overrides event detection. |
| `head` | `HEAD` | Revision to compare. |
| `fetch` | `true` | Fetch missing commits by SHA in shallow clones. |
| `summary` | `true` | Write the job summary. |
| `verbose` | `false` | List skipped projects, unowned files, git commands and the full plan. |
| `audit` | `off` | `warn` or `fail`: check every workflow's `on.*.paths` list against the dependency graph. |
| `max-jobs` | `256` | Maximum entries in each `*_batches` output. |
| `working-directory` | `.` | Directory of the repository to analyse. |

## How it works

1. **Pick the comparison** from the event: a pull request's merge commit against its base, `before..after` for a push, `base_sha..head_sha` in a merge queue, or the `base` input. Details: [docs/git.md](docs/git.md).
2. **Diff** with `git diff --name-status -M`. A renamed file counts for both its old and new project.
3. **Find projects** in the config file and, when detection is on, in the committed files. This is done at both commits, so new and deleted projects are reported in `added` and `deleted`.
4. **Assign each changed file** to the deepest project folder that contains it, then apply `include`/`exclude`, `global` and `ignore`.
5. **Walk the dependency graph** from the changed projects to everything that depends on them, and sort the result in dependency order.
6. **Write outputs**, a job summary and a plan file with a reason for every project.


## Performance

A single bundled JavaScript file with nothing to install. Planning 1,000 projects with 1,000 changed files takes about 105 ms end to end on a hosted `ubuntu-latest` runner. Numbers: [docs/benchmarks.md](docs/benchmarks.md).

## Limitations

- Dependencies come from manifests, not from source imports. Docker and Helm projects get no dependency edges; add them with `dependsOn`.
- A Dockerfile in its own sub-folder (`services/api/docker/Dockerfile`) makes that sub-folder a separate project.
- Dependency edges are project-level, not per target.

## License

[MIT](LICENSE) © continuous-actions
