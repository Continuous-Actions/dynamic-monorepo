# Configuration

The default location is `.github/dynamic-monorepos.yml`. You can override it with the `config` input.

```yaml
version: 1               # optional; only 1 is accepted

projects:
  shared:
    path: libs/shared
  api:
    path: services/api
    dependsOn: [shared]
    targets: [build, test, deploy]
    include: ["proto/api/**"]          # extra files that belong to api
    exclude: ["services/api/docs/**"]  # files under api that don't count
  web:
    path: apps/web
    dependsOn: [api]

discover:                # optional: one project per sub-directory
  - packages/*

global:                  # a change here selects every project
  - package-lock.json
  - .github/workflows/**

ignore:                  # a change here selects nothing
  - "**/*.md"
```

## Projects

| Key | Required | Notes |
| --- | --- | --- |
| `path` | yes | A repo-relative directory. Trailing slashes and `./` are normalised. `.` is the repository root. |
| `dependsOn` | no | A list of project names. Duplicates are removed. Unknown names are an error, with a "did you mean" hint. |
| `targets` | no | A subset of `build`, `test`, `deploy`. Default `[build, test]`. Decides which output lists the project appears in. |
| `include` | no | Globs for files outside `path` that still belong to the project, such as a shared config file. A file can belong to several projects this way. |
| `exclude` | no | Globs for files inside the project that should not count as changes. |

**Project names** must match `^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$`. Names flow into matrices and often into `run:` scripts, so characters with shell meaning are rejected. `__proto__`, `constructor` and `prototype` are reserved.

**Ownership.** A file belongs to the project with the **deepest** `path` that contains it. For example, `apps/web/plugin/x.ts` belongs to `apps/web/plugin`, not to `apps/web`. It also belongs to every project whose `include` matches it. A project's `exclude` removes the file from that project only; the file is not passed on to a parent project. Files that belong to no project are listed as "outside any project" and affect nothing.

## Discovery

`discover: ["packages/*"]` turns every immediate sub-directory of `packages/` into a project named after the directory. Directories starting with `.` are skipped. Only the `<dir>/*` form is supported.

- An explicit `projects` entry with the same name or path overrides a discovered project. Use this to add `dependsOn` or `targets` to a discovered project.
- If two discovered directories share a name, that is an error. Declare one of them explicitly.
- A new directory that appears under a discovered folder is reported in `added`.

## Globs

Globs are always relative to the repository root. They support:

- `*`: any characters within one path segment
- `**`: any number of segments, including none
- `?`: exactly one character
- a trailing `/`: shorthand for `/**`

`*.md` matches only at the root. Use `**/*.md` to match at any depth, which is the same behaviour as GitHub's `on.paths`. Braces, character classes, negation and backslashes are **rejected** rather than half-supported.

## Config changes

When the config file changes, the version at the base commit is compared with the current one:

| Change | Effect |
| --- | --- |
| New project | Listed in `added` and affected. |
| Removed project (its path is no longer used) | Listed in `deleted`. It is not in `affected`, because it can't be built. |
| New name, same path | Listed in `renamed` as `{from, to}`. The new name is affected. |
| A project's `path`, `dependsOn`, `targets`, `include` or `exclude` changed | That project and its dependents are affected. |
| `global` or `ignore` changed | Every project is affected. |
| The config file was added, or the old version can't be read | Every project is affected. |

## Validation

All of these are hard errors. The action fails, and the step log gets a `::error` annotation listing every problem:

- malformed YAML
- duplicate keys
- unknown keys (for example `dependOn`)
- missing `path`
- absolute paths, paths containing `..`, or paths inside `.git`
- glob syntax in `path`
- two projects with the same path
- unknown dependencies
- dependency cycles (the full cycle is printed, for example `a -> c -> b -> a`)
- invalid names
- unsupported glob syntax
- files larger than 1 MiB, or more than 50,000 projects

### Why cycles are errors

A cycle makes build order undefined and is almost always a mistake. Rejecting it with the exact cycle path is more useful than producing a plan that looks plausible but is wrong.
