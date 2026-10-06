# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [1.4.1] - 2026-10-07

### Added
- Published to npm as `dynamic-monorepo`, so the CLI runs with `npx dynamic-monorepo`. npm 12 refuses `npx github:...` installs by default (`EALLOWGIT`). New versions are published from `release.yml` with trusted publishing.

## [1.4.0] - 2026-10-07

### Added
- `audit --fix` (CLI): writes the missing dependency folders into each workflow's `on.<event>.paths` list and turns bare directories into `dir/**`, editing only those lists. Each edit is checked by re-parsing the workflow; anything it can't change safely is reported and left alone.

## [1.3.2] - 2026-10-06

### Fixed
- Node: without a workspace declaration, only `workspace:`/`file:`/`link:`/`portal:` dependencies link local packages (plain version ranges come from the registry).
- Maven: a dependency pinned to a different version than the local module is treated as the published artifact, not a local edge.
- Audit: only filters that watch a whole project folder (`dir`, `dir/`, `dir/**`) make a workflow "about" that project; file-scoped filters are treated as deliberately narrow.

## [1.3.1] - 2026-10-06

### Fixed
- Node: packages outside the workspace globs (for example `examples/*` that install published versions) are no longer linked to local packages by name.

## [1.3.0] - 2026-10-06

### Added
- Python: dependency edges from local path dependencies (`[tool.uv.sources]`, Poetry `path =`, `@ file:` requirements).

### Fixed
- Path-filter audit: wildcard roots (`crates/*/src/**`) and filters rooted inside a package count as watching it.

## [1.2.0] - 2026-10-05

### Added
- `audit` input (`off` / `warn` / `fail`) and `audit` CLI command: checks every workflow's `on.*.paths` list against the dependency graph and reports missing dependency folders, directories without `/**`, and references to deleted workflow files, as annotations and in the job summary. New output: `audit_findings`.

### Fixed
- `projects` CLI command no longer fails on dependency cycles that come from manifests.

## [1.1.0] - 2026-10-05

### Added
- Go: a module that builds several binaries (`cmd/*`) is split into one project per package, linked by its own imports. A change to `internal/foo` selects only the binaries that import it.
- Maven: modules depend on their parent pom and on sibling artifacts. Aggregator poms (`packaging pom`) build nothing.
- Gradle: `project(':a:b')` references create dependency edges.
- Docs: a recipe for calling an existing reusable workflow once per affected project, and a guide for migrating from `on.paths` filters.

### Fixed
- Go external test packages (`package foo_test`) no longer create false dependency cycles.

## [1.0.0] - 2026-10-05

First public release.

### Added
- Zero-config auto-detection: without a config file, projects are found from marker files (package.json, go.mod, Cargo.toml, *.csproj, pyproject.toml, pom.xml, build.gradle, Dockerfile, Chart.yaml) in the committed tree, with dependencies read from the manifests and root lockfiles scoped to their ecosystem. `"detect": true` combines it with a config file.
- `docker` target and outputs (`docker`, `docker_batches`, `has_docker`) plus a `dockerfiles` map.
- CLI `projects` command that lists every project, its folder, targets and dependencies.
- Initial release: dependency-aware affected-project planning.
- Event-aware git comparison (`pull_request`, `pull_request_target`, `push`, `merge_group`, and a `base` input) that works with shallow clones.
- JSON outputs for matrices: `changed`, `affected`, `build`, `test`, `deploy`, `added`, `deleted`, `renamed`, `skipped`, `paths`, plus `has_*` flags.
- Config diffing between base and head (added, deleted, renamed and redefined projects).
- `discover` for one project per sub-directory.
- Job summary and log explaining why each project was selected.
- JSON config `dynamic-monorepo.config.json`, with a published JSON Schema and duplicate-key detection.
- `infer`: projects and dependencies from npm/Yarn/pnpm/Bun workspaces, go.work and Cargo workspaces.
- `import.nx`: read an Nx project graph (`nx graph --file`).
- Per-target `exclude` (top-level and per project) for test-impact and deploy-impact planning.
- Detection of projects that are renamed and moved at the same time, using git renames.
- `*_batches` outputs and a `max-jobs` input for monorepos with more than 256 projects in one list.
- CLI (`dist/cli.js`, `npx github:continuous-actions/dynamic-monorepo`) to preview the plan locally, including uncommitted changes.
