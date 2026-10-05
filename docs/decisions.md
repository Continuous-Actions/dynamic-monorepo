# Architecture decisions

These are short records of *why* the action works the way it does. Research notes are in [research.md](research.md) and [research-runtime.md](research-runtime.md).

## Naming

**Decision:** `OpenMind-SI/dynamic-monorepos`. The repository, the Action (`uses: OpenMind-SI/dynamic-monorepos@v1`) and any future npm/CLI package all use the same name. The Marketplace display name is "Dynamic Monorepos".
**Why:** The research shortlisted `monorepo-impact` (66/80), `affected-plan`, `impact-matrix` and `monorepo-affected` ([naming.md](naming.md)). The maintainer picked `dynamic-monorepos`. On 2026-10-05 it was free on Marketplace, npm and as a GitHub user/org, and no repositories had a similar name. It names the outcome (dynamic, per-change CI for monorepos) and doesn't clash with Nx's "affected" or Terraform's "plan". Identical repo and action names keep `uses:` obvious.

## Organisation

**Decision:** The project lives under the existing `OpenMind-SI` org. The name is product-specific, so the org can hold sibling tools later (a security action, an optimizer, release tooling) without renames. Nothing in the code assumes it is the only project in the org.

## Runtime and language

**Decision:** TypeScript, bundled with esbuild into one ESM file, `dist/index.js` (≈71 KB), running on `node24`. The only runtime dependency is `js-yaml`, and it is bundled. There is no `@actions/core`: the runner protocol takes about 60 lines in `src/actions.ts`.
**Why:**

- **Measured:** Node startup is about 40–75 ms. The planning work for 1,000 projects and 10,000 changed files takes about 18 ms in-process ([benchmarks.md](benchmarks.md)). The rest of the wall time is git process spawns.
- **What Rust could save:** at most tens of milliseconds per run. That is noise next to job scheduling, which takes seconds.
- **What Rust would cost:** five-plus platform binaries (linux x64/arm64, macOS x64/arm64, windows), plus either a download shim or committed binaries, which is a larger supply-chain surface.
- **Other options:** container actions are Linux-only and add image pull time.
- **Runtime choice:** `node24` is the required JavaScript runtime since `node20` was removed on 2026-09-23.

**Revisit if:** profiling on real repositories shows CPU time above about 1 s.

## Configuration design

**Decision:** One YAML file with five top-level keys (`version`, `projects`, `discover`, `global`, `ignore`) and five project keys (`path`, `dependsOn`, `targets`, `include`, `exclude`). The naming follows Nx and Turborepo conventions (`dependsOn`, `targets`). Globs are repo-root anchored and limited to `*`, `**` and `?`. Unknown keys are errors.
**Why:** The config has to be obvious to read in review and quick to debug. A strict schema catches typos like `dependOn`, which would otherwise quietly turn into "no dependency". Anything beyond simple glob syntax is rejected rather than half-supported.
**Not done (yet):** dependency inference from `package.json` or `go.mod`, named inputs, per-target dependency graphs.

## Dependency graph

**Decision:** Edges point from a project to its dependencies.

- **Affected** is the breadth-first reverse-transitive closure from all changed projects at once.
- **Ordering** comes from a topological sort (Kahn's algorithm with a name-ordered heap), so it is deterministic and dependencies come first.
- **Cycles** are errors that print one concrete cycle path.
- **Duplicate dependencies** are removed.
- **Missing dependencies** are errors.

**Why:** BFS parents give the shortest "why" chain for free (`shared → api → portal`). Topological order makes the output usable for sequential builds. Cycle detection is iterative, so it is safe on 20,000-deep chains.

## Git comparison strategy

**Decision:** The comparison range depends on the event ([git.md](git.md)). Missing commits are fetched by SHA. If no correct comparison is possible, every project is selected.
**Why:** The research found that a wrong base SHA and shallow clones are the main source of failures for existing tools (nx-set-shas, Turborepo, tj-actions). Two choices avoid needing `fetch-depth: 0`:

- reading merge-commit parents from the raw commit object
- using two-dot diffs for pushes

Selecting all projects costs minutes; under-selecting costs correctness.

## Output API

**Decision:**

- Compact JSON arrays: `changed`, `affected`, `build`, `test`, `deploy`, `added`, `deleted`, `skipped`
- `renamed` as `{from,to}` objects
- a `paths` object for looking up a project's directory
- string booleans: `has_*`, `all`
- `reason`, `base`, `head`
- a `plan_file` with full per-project reasons

**Why:** These shapes drop straight into `fromJSON()` for matrices. The `has_*` flags work around the empty-matrix error. The large, detailed plan goes in a file rather than an output, to stay well under the per-output limits.

## Security model

- **Untrusted input:** the config file, the git history and file names.
- **YAML:** core schema only, so there are no custom tags or merge keys. The config is limited to 1 MiB and 50,000 projects. Parsed data is validated into `Map`s, so there is no prototype pollution.
- **Paths:** normalised. `..`, absolute paths, drive letters, backslashes and `.git` are rejected.
- **Names:** restricted to `[A-Za-z0-9._@/-]`, with no leading `-`. `__proto__` and similar names are reserved.
- **Git:** always run with `execFile` and argument arrays, never through a shell. `GIT_TERMINAL_PROMPT=0`. User revisions are validated against a strict ref/SHA pattern and passed after `--end-of-options`. The diff uses `--no-ext-diff --no-textconv`, so repository-configured diff drivers never run.
- **Logs:** lines from untrusted data that start with `::` are neutralised, so file names can't inject workflow commands. The job summary escapes Markdown and HTML.
- **Permissions:** `contents: read`. The action makes no API calls, uses no token and runs no repository-defined commands.
- **Supply chain:** one bundled runtime dependency. The CI that builds and tests the bundle pins actions by SHA.

## Performance characteristics

- File ownership costs O(directory depth) per file, using a path-prefix map.
- `include` globs cost O(projects with `include`) per file. Globs use a backtracking-free, segment-level dynamic-programming matcher.
- The graph walk costs O(V + E).
- In practice the cost is dominated by process startup and `git diff`. Numbers are in [benchmarks.md](benchmarks.md).
