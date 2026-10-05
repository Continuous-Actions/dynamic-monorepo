# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [Unreleased]

### Added
- Initial release: dependency-aware affected-project planning.
- Event-aware git comparison (`pull_request`, `pull_request_target`, `push`, `merge_group`, and a `base` input) that works with shallow clones.
- JSON outputs for matrices: `changed`, `affected`, `build`, `test`, `deploy`, `added`, `deleted`, `renamed`, `skipped`, `paths`, plus `has_*` flags.
- Config diffing between base and head (added, deleted, renamed and redefined projects).
- `discover` for one project per sub-directory.
- Job summary and log explaining why each project was selected.
