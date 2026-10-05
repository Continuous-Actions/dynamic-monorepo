# Research: dependency-aware affected-project planning Action

Date: 2026-10-05. Method: primary sources (repo READMEs, official docs, GitHub issues, GitHub REST API for release dates/stars). Items marked **[unverified]** come from memory or secondary sources and need a check before we rely on them.

---

## 1. Summary

- **The change-detection primitive is commoditized; a graph-aware planner for generic monorepos is not.** `dorny/paths-filter` and `tj-actions/changed-files` map files to globs and have no dependency graph. Nx/Turborepo/moon/Rush/pnpm/Pants have graphs, but each is locked to its own tool and its own project declarations.
- **Every graph-aware tool shares one weak point: git history.** Turborepo: "if the checkout is too shallow, then all packages will be considered changed". Nx requires `fetch-depth: 0`. Wrong base SHA selection is the most common real-world failure (nx-set-shas #219/#220, turbo #9320, turbo #4559). Base/head resolution is where we win or lose.
- **Almost no tool gives Actions-native output.** Nx, Turborepo and moon emit tool-specific JSON or text; you still write `jq` glue to get a `strategy.matrix`. Only Turborepo (`turbo query affected`) emits a per-item `reason`. Nobody renders a job summary.
- **A close competitor exists but is tiny and very new:** `Rani367/affected` (CLI, created 2026-03-29, 7 stars, MIT, 13 ecosystems, `--explain`, `affected ci --format github` matrices, PR-comment action; `setup-affected` and `affected-pr-comment` have 0 stars). Also niche: `lightsofapollo/cargo-affect` (Rust only), `rogiervanstraten/terraform-affected-projects`. None has meaningful adoption. The value proposition is not owned, but it is not empty either.
- **Supply-chain trust is now a product requirement.** tj-actions/changed-files (CVE-2025-30066, 2025-03-14) had tags retargeted to a malicious commit that dumped runner secrets into logs; 23k+ repos exposed. That favors a small, bundled, SHA-pinnable action with no runtime downloads and no third-party action dependencies.
- **Platform constraints shape the output contract.** A matrix is capped at 256 jobs per workflow run. An empty matrix is reported to fail the workflow, so we must emit `has_work` flags. Path-filtered workflows leave required checks "Pending". The fix is to always run the workflow, let the planner decide, and use one aggregate gate job. We should document that pattern, not just emit JSON.
- **Recommended MVP:** declare projects and dependencies in one small config, compute the base SHA robustly (PR, push, new-branch, force-push, merge_group), do reverse-transitive closure, emit matrix JSON plus build/test/deploy lists, and write an explainable `$GITHUB_STEP_SUMMARY`. Do not become a build system, task runner, or cache.

---

## 2. Existing tools table

| Tool | Scope | Config burden | Graph-aware? | Actions-native output? | Notable pain |
|---|---|---|---|---|---|
| dorny/paths-filter | file to named filter (globs) | filters YAML (inline or file) | No (hand-write dependents as extra globs) | Partly: per-filter booleans, `changes` JSON array of filter names, `*_files` lists | No graph; PR path uses REST API with ~3000-file cap (#227, open); push needs fetch handling |
| tj-actions/changed-files | file lists, `files_yaml`, `dir_names` | glob inputs | No | Partly: `json`/`matrix` input gives escaped JSON; many outputs | 2025 compromise; two-dot diff on push (#2935); perf on big diffs (#2933); large surface |
| nrwl/nx-set-shas | computes NX_BASE/NX_HEAD only | tiny | n/a (feeds Nx) | `base`/`head` outputs, env vars | Last-successful-run lookup flaky (#219, #220, #75, #83, #128); needs `fetch-depth: 0` and `actions: read` |
| Nx `affected` / `nx show projects --affected` | project graph (plugins + project.json) | Nx workspace | Yes, full | No; `--json` is a name list; `--graph=file` dumps graph | Must adopt Nx; lockfile change marks everything affected by default; full history required |
| Turborepo `--filter` / `--affected` / `turbo query affected` | JS workspaces | turbo.json + workspaces | Yes (`...[main...HEAD]`) | No; `query` returns GraphQL-shaped JSON with `reason` | Shallow clone means all affected; #9320, #4559; package-level unless `affectedUsingTaskInputs` flag |
| bazel-diff / target-determinator | Bazel targets across two revisions | Bazel BUILD graph | Yes, exact (hash based) | No; target label lists | Query both revisions; Bazel required; heavy; env-var spurious diffs (TD cache) |
| Buck2 BTD | Buck targets | Buck | Yes | No | **[unverified]** docs page 404ed |
| Pants `--changed-since` + `--changed-dependents=transitive` | Pants targets (dep inference) | BUILD files + pants.toml | Yes (direct/transitive) | No | Docs: no transitive third-party understanding; lockfile change flags many targets |
| Lage | JS task runner | lage.config.js | Yes (package graph) | No | **[unverified]** `--since` semantics not confirmed; JS only |
| Rush | JS monorepo | rush.json | Yes | No; `rush list --json` | `--impacted-by` and `--only` labeled "unsafe"; Rush-only |
| moon `moon query projects --affected` | polyglot | `.moon/workspace.*` + `moon.yml` per project | Yes (`--upstream/--downstream` none/direct/deep) | JSON `{projects, options}`, not matrix shaped | Must adopt moon; remote compare vs `vcs.defaultBranch` |
| Lerna `changed` / `--since` | JS packages, publish oriented | lerna.json | `changed`: last-tag based, no filters | No | `changed` "does not support filter options" |
| pnpm `--filter "...[origin/main]"` | pnpm workspaces | pnpm-workspace.yaml only | Yes (`...` = dependents) | No (`pnpm ls --json`) | JS only; Git 2.24+; ignore-pattern and test-pattern options are useful ideas |
| LeanIX nx-affected-dependencies-action | Nx `affected` intersect `dep-graph --focus` | Nx | Yes (via Nx) | `affectedDeps`, `isAffected` | Nx only; 21 stars, v0.2.1 |
| silverlyra "Check for monorepo changes" | workspaces | small | No | `changes` for fromJSON | v0.1.0; path only |
| is-workspace-affected | one Yarn workspace per call | small | Yes (workspace deps) | boolean per call | Yarn only; 9 stars, v2.1.0 |
| Rani367/affected (+ setup-affected, affected-pr-comment) | 13 ecosystems, auto-detect | zero-config, optional `.affected.toml` | Yes, transitive, `--explain` | `affected ci --format github` matrix; PR comment | Created 2026-03; 7 stars; runtime binary install; maturity unknown |
| lightsofapollo/cargo-affect | Cargo workspaces | `affect.toml` (global, paths, sets) | Yes (reverse deps) | Cargo/nextest args, `plan`, `explain` | Rust only; 2 stars |
| terraform-affected-projects | Terraform roots | `project-marker` file | Yes (module refs) | outputs | Terraform only; 2 stars |
| trunk-io/merge-action | uploads Bazel impacted targets to Trunk | needs Trunk | via bazel-diff | uploads to service | Vendor-coupled; Bazel only |

---

## 3. Per-tool notes

### dorny/paths-filter
- Sources: https://github.com/dorny/paths-filter (README, releases). API shows v4.0.3 released 2026-08-05, v4.0.2 2026-07-02, v4.0.1 (merge queue support) 2026-03-17; v4.0.0 moved to Node 24. Repo pushed 2026-09-27, so it is maintained.
- Does: named globs to boolean outputs, `changes` JSON array of matching filter names, `<filter>_count`, optional `<filter>_files` (csv/json/shell/escape). Change-type (added/modified/deleted) and negation supported. picomatch globs.
- Base handling: PRs use the REST API (`pull-requests: read`); feature branches compare against merge-base with `base`, fetching iteratively (starts at `initial-fetch-depth`, default 100, doubling) until the merge-base is found; pushes to the same branch compare against the previous commit; merge queue uses event hashes.
- Complaints: PR file list truncated at 3000 files (https://github.com/dorny/paths-filter/issues/227, open when read, no maintainer reply). Output file lists must go through `env:` (multi-line filename escaping fix shipped in v4.0.3 / v3.0.4).
- Fit: good for booleans and `changes` into `fromJSON`. No dependency awareness; dependents must be hand-listed as globs, which rot silently.

### tj-actions/changed-files
- Source: https://github.com/tj-actions/changed-files (v47.0.6 released 2026-04-18; pushed 2026-09-28; ~2.7k stars).
- Does: file lists with status buckets, `files`/`files_yaml` globs, `dir_names`, `json`/`matrix` output, `fetch_depth` (default 25), `base_sha`/`sha` overrides. README says use fetch-depth 0 or 2 for pushes.
- **Compromise:** CVE-2025-30066 / GHSA-mrrh-fwg8-r2c3 (https://github.com/advisories/GHSA-mrrh-fwg8-r2c3). Affected through 45.0.7, patched 46.0.1, timeline 2025-03-14 to 15. A compromised PAT was used to retroactively repoint version tags to a malicious commit. The payload ran a Python script that read Runner.Worker memory, base64-encoded secrets and printed them to logs. 23,000+ repos exposed. Detected via anomalous calls to `gist.githubusercontent.com` (Harden-Runner). More: https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-tj-actionschanged-files-cve-2025-30066-and-reviewdogaction , https://www.aquasec.com/blog/github-action-tj-actions-changed-files-compromised/ . Lesson: mutable tags are an attack surface; pin by commit SHA; keep secrets out of jobs that run third-party actions.
- Other complaints: https://github.com/tj-actions/changed-files/issues/2935 (push on long-lived branch uses a hardcoded two-dot diff; reporter saw "477,742 changed files" vs 156 real, wants a merge-base option); #2933 (O(n^2) list building on large diffs, can crash the runner).
- Graph: none.

### Nx (affected, nx-set-shas)
- Docs: https://nx.dev/ci/features/affected . Algorithm: git diff to files, owning projects via the project graph, then projects that depend on them. Default base is main, head is the working tree; recommended CI base is the latest successful commit on main. `fetch-depth: 0` is required ("without the full Git history, there is no base commit"). By default a lockfile change marks all projects affected (`projectsAffectedByDependencyUpdates` in nx.json).
- Output: `nx show projects --affected --json [--base --head --type --withTarget]` returns names only (https://nx.dev/docs/reference/nx-commands); `nx affected -t build --graph=file.json` dumps a graph. No "why".
- nx-set-shas (https://github.com/nrwl/nx-set-shas, v5.0.1 2026-03-20): finds the last successful workflow run via the GitHub API; falls back to `HEAD~1` if none. Needs `contents: read` and `actions: read`.
- Issues: #220 cancelled run means fallback to HEAD~1 and that commit's projects are never built (runs endpoint can be stale up to 7 days; only 100 commits checked) https://github.com/nrwl/nx-set-shas/issues/220 ; #219 intermittent month-old base, whole repo affected https://github.com/nrwl/nx-set-shas/issues/219 ; #75 wrong SHAs https://github.com/nrwl/nx-set-shas/issues/75 ; #83 "0 projects" https://github.com/nrwl/nx-set-shas/issues/83 ; #128 merge queue SHAs https://github.com/nrwl/nx-set-shas/issues/128 .
- Takeaway: "last successful run" is correct in principle (do not lose commits whose CI was cancelled) but fragile and API dependent. A base strategy that does not depend on the runs API should be the default.

### Turborepo
- Docs: https://turborepo.dev/docs/reference/run , https://turborepo.dev/docs/crafting-your-repository/constructing-ci , https://turborepo.dev/docs/reference/query .
- `--filter` microsyntax: `...pkg` dependents, `pkg...` dependencies, `[HEAD^1]`, `[a]...[b]`, `!` negate, `tag:`. `--affected` equals `--filter=...[main...HEAD]` by default; `TURBO_SCM_BASE` / `TURBO_SCM_HEAD` override. In GitHub Actions it reads `GITHUB_BASE_REF` and `GITHUB_EVENT_PATH`; for force pushes it compares against the parent of the first commit on the branch.
- `turbo query affected [--packages | --tasks build] --base --head --exit-code` returns JSON with `reason` (`FileChanged`, `LockfileChanged`, `DependencyChanged`, `TaskFileChanged`). Closest existing thing to "why was X selected", but only for turbo-managed JS repos.
- Complaints: shallow checkout means all packages affected (fallback to running everything); https://github.com/vercel/turborepo/issues/9320 (`--affected` could not resolve `main` on a full checkout; fixed by PR #10732 behind `futureFlags.githubActionsRemoteBaseRefFallback`, shipped in 2.10.8, intended default in 3.0); https://github.com/vercel/turborepo/issues/4559 (`...[HEAD^]` broke on shallow clone, fetch-depth 2, from 1.9.1). Docs list a known bug where the graph includes tasks that do not exist in a package. Package-level granularity unless `futureFlags.affectedUsingTaskInputs`.

### Bazel / Buck
- bazel-diff https://github.com/Tinder/bazel-diff : `generate-hashes` at the start revision, `generate-hashes` at the final revision, then `get-impacted-targets`. Needs git and Bazel 7+; streams `streamed_proto` for scale; has a `serve` mode with caching.
- target-determinator https://github.com/bazel-contrib/target-determinator : Bazel 4+, wants a clean working directory (`--enforce-clean`), caches cquery by binary hash + bazel version + git tree SHA + pattern; env vars are not in the cache key; "no formal compatibility guarantees release-to-release"; Go API `WalkAffectedTargets`.
- trunk-io/merge-action https://github.com/trunk-io/merge-action wraps bazel-diff for Trunk Merge; PR only, Bazel only.
- Exact but cost two full graph queries. Out of reach for a generic Action; relevant only as the "exact" end of the spectrum. We should allow ingesting an externally computed project list but not compete with them.

### Pants
- https://www.pantsbuild.org/stable/docs/using-pants/advanced-target-selection : `--changed-since=<ref>`, `--changed-dependents=direct|transitive`. Documented CI recipe: `MERGE_BASE=$(git merge-base HEAD origin/main); pants --changed-since="$MERGE_BASE" --changed-dependents=transitive test`. Docs caveat: Pants does not understand transitive third-party dependencies here; lockfile or target-generator changes can flag many targets. This is the clearest statement of the semantic we implement (file to owner to reverse transitive) and a good naming model.

### Lage
- https://microsoft.github.io/lage/ : task runner that skips work based on changes and cache. The CLI reference page 404ed and the landing page lacks `--since` semantics, so details are **[unverified]**. Treat as JS-only with a package graph.

### Rush
- https://rushjs.io/pages/developer/selecting_subsets/ : `--to` (project plus deps), `--from` (project plus dependents), `--impacted-by` and `--only` flagged "unsafe", `git:<ref>` selectors for changed-since, `tag:`, `subspace:`; selections are unioned. Design lesson: Rush labels "dependents only, assume deps are fine" as unsafe. We keep "safe" as default and expose prerequisites (deps of affected) as a separate output.

### moon
- https://moonrepo.dev/docs/commands/query/projects : `--affected`, `--upstream none|direct|deep`, `--downstream none|direct|deep`, regex filters; output `{projects, options}`; needs `.moon/workspace.*` `projects` plus per-project `moon.yml`. `moon run --affected remote` compares HEAD against `vcs.defaultBranch` (https://moonrepo.dev/docs/run-task). Affected is input aware at task level. Good model for our depth knobs.

### Lerna
- https://github.com/lerna/lerna/blob/main/libs/commands/changed/README.md : `lerna changed` is tied to `lerna version`/publish, last-tag based by default, "does not support filter options". `--since` on `run`/`ls` dependents behavior is **[unverified]**.

### pnpm
- https://pnpm.io/filtering : `--filter "...[origin/main]"` is changed since ref plus dependents; `"...^[...]"` dependents only; comparisons use merge-base (documented change in a recent version); Git 2.24+ required; `--filter-prod` skips devDependencies; `--test-pattern` stops test-only changes cascading to dependents; `--changed-files-ignore-pattern` ignores docs etc. Worth copying as concepts: ignore patterns, test-pattern, prod vs dev edges.

---

## 4. Developer complaints (links)

Wrong or missing base SHA:
- nx-set-shas stale or month-old base: https://github.com/nrwl/nx-set-shas/issues/219
- cancelled run silently loses commits: https://github.com/nrwl/nx-set-shas/issues/220
- wrong SHAs, 0 projects on main, merge queue: https://github.com/nrwl/nx-set-shas/issues/75 , /83 , /128
- turbo `--affected` cannot resolve `main` even with full checkout: https://github.com/vercel/turborepo/issues/9320
- turbo shallow-clone `HEAD^` regression: https://github.com/vercel/turborepo/issues/4559
- tj-actions push on long-lived branch, two-dot diff, absurd file counts: https://github.com/tj-actions/changed-files/issues/2935

Scale and correctness:
- paths-filter truncates at 3000 PR files: https://github.com/dorny/paths-filter/issues/227
- tj-actions O(n^2) on large diffs: https://github.com/tj-actions/changed-files/issues/2933

Required checks vs skipped workflows:
- "check does not run, so does not pass and I can't merge": https://github.com/orgs/community/discussions/26251
- Skipping a matrix job hangs the PR when inner matrix jobs are required: https://github.com/actions/runner/issues/952
- Conditional jobs plus matrix make it impossible to require correct statuses: https://github.com/orgs/community/discussions/60792
- Require all tasks to pass without enumerating them: https://github.com/orgs/community/discussions/26733
- Path filtering does not work for merge_group: https://github.com/orgs/community/discussions/45899

Matrix limits:
- "Maximum object size exceeded" with ~6000-element matrix: https://github.com/orgs/community/discussions/125664
- Workaround for the 256 cap: https://github.com/cloudposse/github-action-matrix-extended

Security:
- CVE-2025-30066: https://github.com/advisories/GHSA-mrrh-fwg8-r2c3

Recurring themes: (1) wrong base SHA, so either everything runs or something silently does not; (2) shallow clones; (3) tool-specific project config plus CI glue; (4) no explanation of selection; (5) required checks and skipped jobs.

---

## 5. GitHub Actions platform constraints

Sources: docs.github.com pages and the github/docs repo markdown, cited inline.

**Matrix**
- A matrix generates a maximum of **256 jobs per workflow run**, hosted and self-hosted (limits table, `actions/reference/limits.md` in github/docs; also workflow-syntax). Plan for chunking or a `truncated` flag. Nested reusable workflows can multiply, per cloudposse's workaround.
- Dynamic matrix via `fromJSON(needs.<job>.outputs.<name>)` is the documented pattern (https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations).
- Empty matrix: reported to fail the workflow **[unverified: confirm exact behavior and message with a test run]**. Always output `has_work` and gate the matrix job with `if:`. Also test `include: []`.
- Controls to document: `max-parallel`, `fail-fast`, `continue-on-error`.
- Job output size limits (about 1 MB per output / 50 MB per run) **[unverified, recalled]**. Keep matrix JSON compact; consider a `plan.json` artifact for large plans.

**Triggers and path filters** (https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)
- `paths`/`paths-ignore` on push/pull_request: PRs use a three-dot diff (merge-base); pushes to existing branches use a two-dot diff (head vs before); new-branch pushes use the parent of the deepest pushed commit. A push with more than 1,000 commits, or a diff that times out, always runs the workflow. Workflows do not run if the diff exceeds 3,000 files and matches fall outside the first 3,000 returned.
- **A skipped workflow leaves its checks "Pending"**: the docs say checks of a workflow skipped by branch filtering, path filtering or commit message remain in a Pending state, blocking merge if required. A matrix whose parent job is skipped also leaves inner checks unreported (actions/runner#952).
- Recommended pattern: the workflow always triggers (no `on.paths`), a single `plan` job decides, downstream jobs are conditional, and a final always-running `gate` job (`if: always()`, fails on any `needs.*.result` of failure or cancelled) is the only required check. That skipped jobs themselves report success is widely reported but **[unverified in official docs]**; verify end to end in a scratch repo. Ship this recipe in our docs.
- `merge_group`: path filters are ignored on that trigger (discussion #45899), so planning must happen in-job. paths-filter v4.0.1 added merge-queue handling; we must handle merge_group base/head explicitly.

**Events and SHAs** (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- `pull_request`: `GITHUB_SHA` is the **merge commit** (`refs/pull/N/merge`); `github.event.pull_request.head.sha` is the PR tip; `github.event.pull_request.base.sha` is the base tip as of the event (can lag the current base; the merge commit's first parent is the real base tip). The correct diff is `merge-base(base, head)..head`, or `HEAD^1..HEAD` on the merge ref.
- `push`: `GITHUB_SHA` is the pushed tip; `github.event.before` is the previous tip. **`before` is all zeros on first push of a new branch**, and after a force push the old tip may be unreachable in a shallow or fresh clone. The payload has no added/removed/modified lists. Events are not created if more than 5,000 branches or more than three tags are pushed at once. Commits in the payload are truncated **[unverified, commonly cited as 20]**, so do not rely on `commits[]`.
- `merge_group`: `GITHUB_SHA` is the merge group SHA; base SHA lives in the event payload **[confirm field name, likely `merge_group.base_sha`]**.

**Checkout / history** (https://github.com/actions/checkout)
- Default is a single commit (`fetch-depth: 1`). On a PR merge ref that gives only the merge commit, so the base side is absent. `fetch-depth: 2` gets the merge commit and both parents. A merge-base across a long-lived branch needs `fetch-depth: 0` (slow on large repos) or a targeted deepen. Turborepo suggests blobless full history (`--filter=blob:none`) for large repos.
- Our action can reduce pain by fetching on its own: `git fetch --no-tags --depth=N origin <base> <head>`, then `--deepen` in a loop until `git merge-base` succeeds (paths-filter uses a doubling loop from 100), failing loudly. Fallback when no base exists: diff against the empty tree (everything changed, everything affected) and say so in the summary. Failing open (run everything) is safer than failing closed.
- Container jobs: "dubious ownership" requires `safe.directory` (paths-filter handles it).

**Security**
- Use `pull_request`, not `pull_request_target`, to avoid running untrusted code with secrets. The planner should need `contents: read` only (plus `actions: read` or `pull-requests: read` only if we opt into APIs).
- Treat file names and paths as untrusted: pass via `env`/JSON, never interpolate into `run:`. paths-filter shipped a fix for exactly this.
- Consumers should pin by SHA. We should publish from protected tags, consider immutable releases and provenance attestations **[verify current GitHub feature names]**, and avoid runtime downloads.

---

## 6. Gap analysis

**Is there an Action with essentially the same value proposition?** No mainstream one. Closest:
- **Rani367/affected + setup-affected + affected-pr-comment** (https://github.com/Rani367/affected, created 2026-03-29, 7 stars): zero-config multi-ecosystem graph, `--explain`, `affected ci --format github` dynamic matrix, PR comment with the dependency chain. Same pitch. Differences: a CLI installed by a setup action (runtime binary download rather than a self-contained Action), PR comment rather than job summary, unproven maturity. Study its CLI surface and `.affected.toml`; watch its issues.
- **cargo-affect** (Rust only; `plan`, `explain`, `global`, path overrides, sets): validates our design; global triggers, path to project overrides, and platform excludes are what real users need.
- **LeanIX nx-affected-dependencies-action** (Nx only), **is-workspace-affected** (Yarn only, one workspace per call), **silverlyra check-for-monorepo-changes** (no graph).
- Dominant practice remains: paths-filter or changed-files plus hand-maintained globs for dependents, or `nx`/`turbo` plus `jq` glue.

**What would genuinely differentiate (ranked by defensibility)**
1. **Correct, boring base-SHA resolution as a first-class feature**: PR (merge ref), push, new branch (zero `before`), force push, `merge_group`, `workflow_dispatch`, and shallow-clone self-deepening, with the chosen base and the reason printed. This is where incumbents' top complaints sit.
2. **Explainability**: job summary of "selected project | reason | chain (file, owner, ..., project)", plus "not selected" with reason, plus global-trigger and fallback notices. Only Turborepo's `reason` field comes close, and only inside its own tool.
3. **Tool-agnostic graph input**: declared graph in a small file; optional adapters (npm/pnpm workspaces, Cargo, Go) later; optionally ingest `nx show projects` or bazel-diff output. No build system adoption required.
4. **Actions-designed output contract**: `matrix` (`include` objects with `project`, `path`, `reason`, custom attributes), `has_work`, `count`, `truncated`, per-target lists (`build`, `test`, `deploy`), full `plan` JSON, and a documented gate-job recipe for required checks.
5. **Supply-chain posture**: single bundled dist, no third-party action dependencies, no runtime downloads, SHA-pin docs, minimal permissions, provenance. After tj-actions this is a real purchase criterion.
6. **Determinism and testability**: pure planning function over (changed files, graph, rules); reproducible locally via explicit `--changed-file` input (as cargo-affect does).

Not differentiating (do not pitch): "faster than paths-filter", "supports globs", "monorepo detection".

---

## 7. Implications for our scope

**MVP must**
- Config: one file (for example `.github/affected.yml`) declaring `projects` (name, path globs, optional tags and targets), `dependsOn` edges, `global` patterns (lockfiles, CI config, root tooling) that select everything or named sets, and `ignore` patterns (docs). Validate it: unknown project, cycles, overlapping ownership (rule: deepest path wins, or error), unowned files (policy: ignore, select-all, or warn).
- Changed files via git with a robust base/head resolver: PR (merge-base of base ref and head, handling stale `base.sha`), push (use `before` if reachable, else merge-base with default branch, else empty tree), new branch (zero SHA), force push (unreachable `before`), `merge_group`, `workflow_dispatch` (explicit input). Self-deepening fetch, clear warnings, a fail-open default and an optional `strict` fail-closed mode.
- Graph: file to owner project to reverse-transitive closure. Distinguish `changed` (direct) from `affected` (transitive) and retain the chain for every selected project. Options for depth (`direct|transitive`, as in Pants/moon) and edge kinds (prod vs dev, as in pnpm).
- Outputs (JSON, injection safe): `matrix` ready for `fromJSON`, `projects`, `changed_projects`, `affected_projects`, `has_work`, `count`, and per-target lists `build`, `test`, `deploy`. Define behavior at the 256 cap (`truncated` output, optional chunking into several matrices).
- `$GITHUB_STEP_SUMMARY`: table of selected projects with reason and chain; list of unselected projects with reason; base/head SHAs and how they were chosen; files that matched no project; warnings (shallow, fallback).
- Docs: copy-paste workflow showing plan job, conditional matrix jobs, and an always-run `gate` job as the single required check; explain why not to use `on.paths`.
- Security: bundled JS with no runtime downloads, `contents: read` only, no shell interpolation, SHA-pin guidance.

**MVP should explicitly NOT do**
- Run builds/tests, cache results, or orchestrate task order (Nx/Turbo/Bazel territory). We emit lists; users run commands.
- Infer fine-grained graphs from source or compute content hashes (bazel-diff's domain). Declared edges only, with manifest adapters later.
- Parse lockfiles for per-package dependency impact (Pants and Nx both struggle here). Offer `global` rules instead.
- Post PR comments or require write permissions (job summary only; a PR comment can be a later opt-in).
- Use the Actions runs API to find "last successful run" as the default base (nx-set-shas #219/#220). Offer as opt-in later. Note the tension: for deploys from `main`, base = `before` can lose commits when a run is cancelled; document it and consider an opt-in `base: last-successful`.
- Replace `paths-filter` for simple file to boolean use cases.
- Support every ecosystem at launch. Start with declared config, optionally npm/pnpm workspaces; keep adapters pluggable.

**Open questions to resolve by test before building**
1. Exact behavior of an empty `fromJSON` matrix (error text, `include: []` vs `{}`), and whether `if: needs.plan.outputs.has_work == 'true'` suffices.
2. How skipped jobs and skipped matrix jobs report to required checks today (verify the gate pattern end to end in a scratch repo).
3. Job output size limits (verify in current docs).
4. Whether `fetch-depth: 1` plus our own targeted `git fetch` is reliable on `pull_request` merge refs (including forks) and `merge_group`.
5. Read `Rani367/affected` source and issues to judge real maturity and decide whether to differentiate or collaborate.

---

## Sources (primary)
- https://github.com/dorny/paths-filter , releases, issue #227
- https://github.com/tj-actions/changed-files , issues #2933 #2935 ; https://github.com/advisories/GHSA-mrrh-fwg8-r2c3 ; https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-tj-actionschanged-files-cve-2025-30066-and-reviewdogaction
- https://github.com/nrwl/nx-set-shas , issues #75 #83 #128 #219 #220 ; https://nx.dev/ci/features/affected ; https://nx.dev/docs/reference/nx-commands
- https://turborepo.dev/docs/reference/run , /reference/query , /crafting-your-repository/constructing-ci ; https://github.com/vercel/turborepo/issues/9320 , /4559 , /pull/10732
- https://github.com/Tinder/bazel-diff ; https://github.com/bazel-contrib/target-determinator ; https://github.com/trunk-io/merge-action
- https://www.pantsbuild.org/stable/docs/using-pants/advanced-target-selection
- https://rushjs.io/pages/developer/selecting_subsets/ ; https://microsoft.github.io/lage/
- https://moonrepo.dev/docs/commands/query/projects , /run-task
- https://github.com/lerna/lerna/blob/main/libs/commands/changed/README.md ; https://pnpm.io/filtering
- https://github.com/Rani367/affected ; https://github.com/Rani367/setup-affected ; https://github.com/Rani367/affected-pr-comment ; https://github.com/lightsofapollo/cargo-affect ; https://github.com/rogiervanstraten/terraform-affected-projects
- https://github.com/marketplace/actions/nx-affected-dependencies-action ; /is-workspace-affected ; /check-for-monorepo-changes
- GitHub docs: workflow-syntax (paths filter), events-that-trigger-workflows, limits (github/docs `actions/reference/limits.md`), run-job-variations; community discussions #26251 #60792 #26733 #45899 #125664; actions/runner#952

## Addendum: practitioner guidance (2026)

The guide [GitHub Actions in 2026: monorepo CI/CD](https://dev.to/pockit_tools/github-actions-in-2026-the-complete-guide-to-monorepo-cicd-and-self-hosted-runners-1jop) reflects common practice: `paths-filter` or Turborepo filters for change detection, `fetch-depth: 0` "for accurate change detection", dynamic matrices with `fail-fast: false`, `concurrency` cancellation, and least-privilege `permissions`. What it means for us:
- Requiring `fetch-depth: 0` is the norm, and it is costly on large repositories. We avoid it by fetching only the commits we need, by SHA (see [git.md](git.md)). This is a concrete differentiator.
- Our examples include `fail-fast: false`, `concurrency`, `permissions: contents: read` and a required-check gate job.
- Caching and self-hosted runners are out of scope for this action.
