# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [Unreleased]

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
- CLI (`dist/cli.js`, `npx github:Continuous-Actions/dynamic-monorepo`) to preview the plan locally, including uncommitted changes.
