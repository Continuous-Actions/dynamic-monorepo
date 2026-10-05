# Research: runtime, distribution, marketplace, git strategy

Date: 2026-10-05. Method: GitHub docs, github/docs source, actions/* repos and `gh api`, GitHub changelog. Items marked **[inferred]** are engineering judgment, not a documented guarantee. Items marked **[unverified]** were not confirmed from a primary source.

## A. JavaScript action runtime status

- `runs.using` accepts `node20` and `node24` in the metadata reference: https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax
- Timeline (changelog https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/):
  - 2025-07-25: runner v2.327.1 is the first release with Node 24 action support (release notes "Runner Support for executing Node24 Actions"): https://github.com/actions/runner/releases/tag/v2.327.1
  - 2025-08-13: v2.328.0 supports Node 20 and 24, Node 20 still the default. `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` previewed Node 24.
  - 2026-06-16: runners default to Node 24 for JavaScript actions, even those declaring `node20`. Temporary opt-out: `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true`.
  - 2026-09-23: **Node 20 removed**; opt-out gone. https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/ Maintainers are told to set `runs.using: node24` and release.
- Conclusion: use `runs.using: node24`. `node20` is not a valid target any more. Node 24 does not run on macOS 13.4 and older, and has no official ARM32 support, so self-hosted runners on those are unsupported.
- Self-hosted minimum: runner **>= 2.327.1** for node24 (first with support). Today's latest is v2.337.0 (2026-08-26): https://github.com/actions/runner/releases. Self-hosted runners self-update unless disabled. The runner ships its own Node under `externals/node24`, so the action does not depend on a Node install on the machine.
- The Node used to run the action is the runner's bundled `externals/node24`, not the image's `actions/setup-node` toolcache Node. Image Node versions are therefore not a constraint:

| Label | Image (checked 2026-10) | Default Node on image | Source |
|---|---|---|---|
| ubuntu-latest = ubuntu-24.04 (x64) | 20260927.320.1 | 22.23.3 (24.21.0 cached) | https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md |
| windows-latest = windows-2025 | 20260927.275.1 | 22.23.3 (24.21.0 cached) | https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md |
| macos-latest = macos-26 (arm64) | 20260907.0351.1 | 24.20.0 | https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md |
| macos-15 (arm64) | 20260907.0337.1 | 22.23.2 | https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md |
| ubuntu-24.04-arm | has its own readme (`Ubuntu2404-Arm64-Readme.md`) | **[unverified]**, same toolset family | https://github.com/actions/runner-images |

- Label map: https://github.com/actions/runner-images (README). `-latest` migration is gradual (1-2 months). Other ARM labels: `ubuntu-26.04-arm`, `windows-11-arm`. Git on all hosted images is 2.55.x, so modern git features (`--filter`, `--deepen`, `merge-base`) are safe.
- First-party actions already moved: `actions/checkout` is v7.0.1 (2026-07-20), `runs.using: node24`; `actions/typescript-action` also uses node24 and `"node": ">=24.0.0"`.

## B. Compiled (Rust) binary distribution options

Facts from docs:
- Docker container actions "can only execute on runners with a Linux operating system" and are slower "because of the latency to build and retrieve the container": https://docs.github.com/en/actions/concepts/workflows-and-actions/custom-actions
- JavaScript actions "run directly on the runner"; docs advise pure JS not relying on other binaries (same page).
- Dockerfile-based actions are rebuilt per run unless `image:` points at a pre-built registry image (`docker://`); runners do not cache images across jobs on hosted runners. Anecdotal: a Dockerfile-build action went from ~1 min to ~6 s after switching to a prebuilt image (https://bullrich.dev/blog/how-to-optimize-a-docker-based-github-action.html). No rigorous published JS vs container benchmark found. Treat as qualitative: JS action cold start is a few hundred ms for node spawn plus bundle load. **[inferred]**

| Option | Platforms | Cold start | Notes |
|---|---|---|---|
| JS shim (`dist/index.js`) downloads release binary for `RUNNER_OS`/`RUNNER_ARCH`, verifies checksum, caches via `@actions/tool-cache` or `$RUNNER_TOOL_CACHE`, execs | linux/win/mac x64+arm64 | node start + HTTPS download (typ. 2-10 MB, ~0.2-1 s on hosted runners **[inferred]**), near zero on cache hit | Needs network to github.com release assets, a checksum/attestation story, and a release pipeline producing 5-6 targets. Most flexible. Pin the binary version to the action's tag. |
| Commit per-platform binaries into repo (`bin/<target>/`) | all (those you build) | zero download | Repo bloat, binaries in git history, unreviewable diffs, `chmod +x` and Windows `.exe` handling, supply-chain red flag (opaque blobs in tagged source). Not recommended. |
| Composite action + `cargo install` / `cargo-binstall` | all, requires rust toolchain or binstall | `cargo install` compile = minutes; binstall = download | Hosted images have rustup/cargo, self-hosted may not. Compile time kills the "fast planner" use case. |
| Docker container action | Linux only | image pull/build seconds to a minute | Fails on windows/macos runners and on self-hosted without Docker. Cannot be used in `container:` jobs on non-Linux. |
| Pure JS/TS (no binary) | all | lowest | Possible here: the work is YAML parse, `git diff`, graph walk. Performance is not a bottleneck for typical monorepos. **[inferred]** |

Verdict **[inferred]**: for a YAML + git + graph planner, a bundled Node action avoids every distribution problem above. Use a Rust binary only if the core must be shared with a CLI; then use the JS-shim-with-download pattern, with SHA-256 pinned in the bundle.

## C. GitHub Marketplace publishing requirements (current)

Source: https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace (content: https://github.com/github/docs/blob/main/content/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace.md)
- Public repo. Exactly one `action.yml`/`action.yaml` at the root (extra ones in subfolders are not listed).
- `name` must be unique across Marketplace; must not equal an existing Marketplace action name, a user/org name (unless you own it), a Marketplace category, or a reserved GitHub feature name.
- `description` required (metadata syntax). `branding` (`icon` Feather icon, `color`) is optional in the metadata reference but needed for a good listing: https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax
- Must accept the GitHub Marketplace Developer Agreement (owner or org owner; the Publish checkbox is disabled otherwise). Publishing requires 2FA. Choose a primary category (required), optional secondary. Publishing is immediate with no review.
- **Workflow-files rule:** older docs said a repository "must not contain any workflow files". The current docs source no longer lists this as a requirement. It now says only that the repo should "only include the metadata file, code, and files necessary for the action" (soft guidance). Community/third-party pages still repeat the old rule. Treat as relaxed; **[unverified]** by an actual publish attempt. Low-risk option: keep CI workflows in `.github/workflows/` anyway (the new advice is not enforced) and test publish with a draft release.
- Mechanism: create a GitHub Release with "Publish this Action to the GitHub Marketplace" ticked. Deleting the repo deletes the listing and frees the name. The name is tied to the repo, so transfers keep the listing.
- Immutable releases (GA 2025-10-28): assets locked, tag protected from move/delete, signed Sigstore attestation; tags of a deleted immutable release can never be reused. https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/ Enable at repo or org settings; only new releases are covered.
- Versioning guidance: https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases says floating major tags (`v1`) may be moved to the latest compatible release, and full semver release tags (`v1.2.3`) are the immutable ones. Practical pattern: make GitHub Releases only for `vX.Y.Z` (immutable), move the plain `v1` tag via git (not a Release) so it stays movable. **[inferred]** from the docs: a `v1` that has an immutable *release* could not move.
- Committed `dist/`: JS actions are executed straight from the tagged repo contents (no install step), so the bundled `dist/index.js` must be committed on release commits. Enforce with a CI "check-dist" job that rebuilds and `git diff --exit-code dist/`.
- Template: `actions/typescript-action` currently bundles with **Rollup** (`npx rollup --config rollup.config.ts` with `@rollup/plugin-typescript`, `plugin-commonjs`, `plugin-node-resolve`; rollup ^4.57), not `ncc`, and targets `node24`, `@actions/core ^3.0.0`. https://github.com/actions/typescript-action (`package.json`, `action.yml`). `@vercel/ncc` is still widely used but is no longer the template default.

## D. Toolkit, zero-dependency feasibility, command protocol

**@actions/core**
- Latest 3.0.1. v3.0.0 is **ESM-only** (breaking; CJS must `import()`). v2.0.0 added Node 24 support. https://github.com/actions/toolkit/blob/main/packages/core/RELEASES.md
- Own unpacked size ~86 KB, but depends on `@actions/exec` ^3 and `@actions/http-client` ^4 (which pulls `undici`), so the bundled output grows to hundreds of KB to ~1 MB+ **[inferred, not measured]**. Registry: https://www.npmjs.com/package/@actions/core
- Zero-dep is reasonable: the needed surface is four small features (below), about 60 lines. Skip `http-client`/`undici`/`tool-cache` unless doing downloads. Reference implementation: https://github.com/actions/toolkit/tree/main/packages/core/src (`command.ts`, `file-command.ts`).

**Outputs / env via files**
- `echo "name=value" >> "$GITHUB_OUTPUT"`; multiline: `name<<DELIM\nvalue\nDELIM\n`. https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
- Docs warning: the delimiter must not appear on a line of its own in the value; "If the value is completely arbitrary then you shouldn't use this format."
- Delimiter-injection issue: if an attacker-controlled value contains a line equal to the delimiter, the remainder is parsed as additional `name=value` lines, letting it set arbitrary outputs/env (`GITHUB_ENV`, `GITHUB_PATH` variants are worse). Toolkit mitigation (`file-command.ts`): delimiter `ghadelimiter_<crypto.randomUUID()>`, then throw if key or value contains it; lines joined with `os.EOL`; file opened append, UTF-8. Reproduce this exactly. Also: key must not contain `<<`, `=`, or newline **[inferred]**; ordinary single-line `k=v` is only safe when the value has no `\n`/`\r`, so always use the heredoc form (or reject newlines) for anything derived from file names or branch names (user-controlled). Branch/file names with newlines are legal in git.
- Outputs are also not multi-line-safe in `${{ }}` expressions into `run:` scripts (script injection): https://docs.github.com/en/actions/reference/security/secure-use (use env vars).

**Step summary**: append Markdown to `$GITHUB_STEP_SUMMARY`; limit **1 MiB per step**, max 20 summaries per job shown; upload failures do not fail the job; secrets are masked. Source: workflow-commands doc above. Keep a size budget (truncate tables at e.g. 900 KiB with a "truncated" note) **[inferred]**.

**Annotations / groups**: `::error file=..,line=..,endLine=..,title=..::message`, `::warning ...`, `::notice ...`, `::group::title` / `::endgroup::`, `::debug::`. Written to stdout. Limit: GitHub shows max 10 error + 10 warning + 10 notice annotations per step (50 per job) **[unverified here, long-standing documented behavior]**.

**Escaping** (verbatim from toolkit `command.ts`: https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts):
- message/data: `%` -> `%25`, `\r` -> `%0D`, `\n` -> `%0A` (replace `%` first).
- properties (`file`, `title`, ...): the same three plus `:` -> `%3A` and `,` -> `%2C`.
- The GitHub docs page does not spell these out; the toolkit source is the authority.
- `set-output`/`save-state`/`set-env`/`add-path` stdout commands are deprecated/disabled; use file commands.

**Limits**
- Matrix: max **256 jobs** per workflow run (hosted and self-hosted): https://docs.github.com/en/actions/reference/limits
- Job outputs: max **1 MB per job**, **50 MB total per workflow run**, measured in UTF-16 (~2 bytes/char, so effectively ~500k characters). Stated in the workflow-syntax / reusable-workflow docs and repeated by secondary sources; the limits page fetched did not list it, so cite https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax (`jobs.<job_id>.outputs`) **[verify page wording]**. Cap the planner's JSON output well below this (and cap matrix at 256 entries; chunk or fail with a clear error).
- Empty matrix: `strategy.matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}` with `[]` or `{"include":[]}` makes the job fail at evaluation ("Matrix vector ... does not contain any values"), not skip. Standard guard on the matrix job: `if: ${{ needs.plan.outputs.matrix != '[]' }}` (or emit a boolean `has-changes` output and `if: needs.plan.outputs.has-changes == 'true'`). Source: https://github.com/orgs/community/discussions/27096. The "use `matrix.include:`" trick appears in third-party posts; **[unverified]**, do not rely on it. Provide a `has-affected`/`any` boolean output.

## E. Checkout and git strategy

Sources: https://github.com/actions/checkout (README, v7), https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows, https://docs.github.com/en/webhooks/webhook-events-and-payloads
- `fetch-depth` default **1**; `0` = all history, all branches and tags. `filter` (e.g. `blob:none`) enables a partial clone; `sparse-checkout` available. v6+ stores credentials in a file under `$RUNNER_TEMP`, not `.git/config`; `persist-credentials` defaults true (needed for later `git fetch` in the action; keep it).
- `pull_request`: `GITHUB_SHA` = "last merge commit on the PR merge branch", `GITHUB_REF` = `refs/pull/N/merge`. Checkout therefore gets a merge commit (HEAD) whose parent 1 is the base-branch tip when the merge ref was built and parent 2 is the PR head. With depth 1, parents are not present (`HEAD^1` fails). With `fetch-depth: 2` both parents exist, so `git diff HEAD^1 HEAD` = exactly what the PR changes, and `HEAD^1` tracks the current base tip, which may differ from `github.event.pull_request.base.sha` (that value is the base tip when the PR was opened/last synchronized). Workflows do not run for PRs with merge conflicts. For fork PRs the token is read-only but git fetch of the base works (same repo).
- `fetch-depth: 0` cost: whole history plus all refs; seconds for small repos, minutes and GBs for large monorepos. `filter: blob:none` + `fetch-depth: 0` downloads commits/trees only (blobs fetched lazily by `git diff --name-only`, which needs trees, not blobs, for name-only; content diffs/rename detection fetch blobs). Treat as **[inferred]** but standard git behavior (https://git-scm.com/docs/partial-clone).
- Deepening: `git fetch --deepen=N origin <ref>` (or `--shallow-since`, `--unshallow`) extends a shallow clone. `git merge-base A B` fails with exit 1 and no output when history is too shallow, so loop: deepen (e.g. 50, 200, 1000, then `--unshallow`) until merge-base succeeds. **[inferred]** pattern, commonly used.
- Fetching a specific SHA: `git fetch --no-tags --depth=1 origin <sha>` works on github.com (uploadpack.allowReachableSHA1InWant semantics for reachable SHAs; GitHub allows fetching any reachable commit by SHA). Cheapest way to get the base for a two-dot diff.
- `push`: payload `before` = "most recent commit on ref before the push", `after` = after; GITHUB_SHA = tip pushed. `before` is `0000000000000000000000000000000000000000` for a new branch or tag creation and for a branch created by push. On force push, `before` may not be an ancestor of `after`, and after the old commit is unreachable the object may be missing, so `git cat-file -e before^{commit}` can fail; the fetch of that SHA may fail (gc'd). Payload `commits` array is capped (2048), so don't derive changes from it. Events are not created for >5000 branches or >3 tags pushed at once.
- `merge_group` (only `checks_requested`): GITHUB_SHA = merge-group commit, GITHUB_REF = merge group ref; payload has `merge_group.base_sha`, `head_sha`, `base_ref`, `head_ref`. Diff `base_sha...head_sha` (or `base_sha head_sha`): fetch `base_sha` by SHA. The checked-out `GITHUB_SHA` equals `head_sha`.
- `workflow_dispatch`: no base/before in payload; only `inputs` and `ref`. `schedule`: runs on latest default-branch commit, no diff context, payload just the cron string. For both, a diff is not meaningful: require an explicit `base` input or fall back to "all projects" (or `HEAD^` if the user opts in).
- `pull_request_target`/`workflow_run`: not covered; `pull_request_target` checks out the base ref by default, don't blindly diff there.

## F. Supply-chain practices (2025-2026)

- tj-actions/changed-files, March 14 2025 (CVE-2025-30066): a PAT stolen via reviewdog/action-setup (CVE-2025-30154) was used to repoint version tags to a commit that dumped runner secrets into logs; ~15 h window, 23k+ repos exposed. CISA: https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-tj-actionschanged-files-cve-2025-30066-and-reviewdogaction ; analysis: https://www.stepsecurity.io/blog/harden-runner-detection-tj-actions-changed-files-action-is-compromised , https://unit42.paloaltonetworks.com/github-actions-supply-chain-attack/ . Lesson: movable tags are not integrity; repos that pinned to a SHA were unaffected. This action is itself a "changed-files" class tool, so expect users to scrutinize it.
- Docs: pin to full-length commit SHA (verify it is from the action repo, not a fork); Dependabot updates `owner/repo@sha # vX` form; default `GITHUB_TOKEN` to read; avoid `${{ }}` in `run:` (pass via env): https://docs.github.com/en/actions/reference/security/secure-use
- Org/enterprise policy can now require SHA pinning and block actions: https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/ . So this action must be usable pinned by SHA: no runtime fetch of unpinned code, no floating dependency on a moving `v1` internally.
- 2026 roadmap: workflow dependency locking (`dependencies:` lockfile of SHAs incl. transitive composite deps), native egress firewall, scoped secrets, policy-driven execution: https://github.blog/news-insights/product-news/whats-coming-to-our-github-actions-2026-security-roadmap/ . An action with no network egress and no transitive actions fits that model best.
- Immutable releases also let consumers verify with `gh release verify` / attestations; OpenSSF Scorecard treats immutable-release pins as pinned: https://github.com/ossf/scorecard/pull/5248
- Minimal deps: each npm dependency is bundled into committed `dist/`, which reviewers cannot read; fewer deps means a reviewable bundle. Commit lockfile, `npm ci`, pin build tools, rebuild `dist` in CI and diff, enable 2FA + branch/tag protection, publish provenance.

## Recommendations for this action

**Runtime**
- `runs.using: node24`, `main: dist/index.js`, nothing else (no `post`). Document min self-hosted runner 2.327.1 (practically current). `engines.node >=24`. Tests and local dev on Node 24.
- Do not use a Rust binary or container for v1; pure TypeScript is cross-platform (Linux/Windows/macOS, x64/arm64), cold start ~ node boot. Revisit a download-shim only if profiling shows the graph walk is slow.

**Bundler / build**
- Follow `actions/typescript-action`: TypeScript + Rollup (esbuild is an acceptable lighter alternative; ncc is legacy). Output a single ESM-or-CJS `dist/index.js` (+ sourcemap optional), committed. CI job `check-dist` rebuilds and fails on diff. Release workflow builds, commits dist to the release commit, tags `vX.Y.Z`.

**Dependency policy**
- Zero runtime dependencies for the action logic: implement `setOutput` (random-UUID heredoc delimiter, throw on collision, reject/escape keys), `summary` (append to `GITHUB_STEP_SUMMARY`, truncate at ~1 MiB), `error/warning/notice` (escape data `%,\r,\n`; properties additionally `:` and `,`), `group/endgroup`, `getInput` (read `INPUT_<NAME>` upper-cased, spaces to `_`). Use `node:child_process` `execFile` (never a shell) for git, with `-c core.quotepath=off` / `-z` output to survive odd file names.
- YAML parsing is the one real dependency need; prefer one audited, zero-transitive-dep parser (e.g. `yaml`), pinned exactly, bundled. Dev-only deps (TypeScript, Rollup, test runner) stay out of the bundle. Dependabot for npm and github-actions; lockfile committed; our own workflows pin third-party actions by SHA with `# vX.Y.Z` comment and `permissions: contents: read`.

**Marketplace / release**
- Unique `name` (check search + no org/user clash), `description`, `branding`, public repo, root `action.yml`. Enable immutable releases and 2FA. Cut releases only as `vX.Y.Z`, move the lightweight `v1` tag (git ref, not a Release) after each compatible release. Tell users to pin by SHA in README. Test-publish a draft release early to confirm the workflow-files rule is not enforced.

**Checkout guidance (README)**
- Required: `actions/checkout` with `fetch-depth: 0` is simplest; recommended lean: `fetch-depth: 1` plus the action fetching exactly what it needs (the action should do the extra fetch itself, so users need not tune depth). Keep `persist-credentials: true` (default) so the action can `git fetch`. Optionally `filter: blob:none` with `fetch-depth: 0` for big repos.

**Git strategy per event** (action computes `base`/`head`; `inputs.base`/`inputs.head` override all)
- `pull_request`: head = `GITHUB_SHA` (merge commit). If HEAD has two parents: ensure `HEAD^1` present (`git fetch --depth=2` on HEAD or fetch parent SHA) and diff `HEAD^1..HEAD`; else fall back to `event.pull_request.base.sha`, fetched by SHA, diff `base..HEAD` (two-dot against the merge result), or three-dot with deepen loop if merge-base is wanted.
- `push`: base = `payload.before`. If all zeros (new branch/tag) or the commit cannot be fetched/`cat-file` fails (force push, gc) -> try merge-base with the default branch (`repository.default_branch`) via deepen loop; if still unresolved -> mark all projects affected and emit a warning annotation.
- `merge_group`: base = `merge_group.base_sha`, head = `merge_group.head_sha`; fetch base by SHA; diff two-dot.
- `workflow_dispatch`: use `base` input if provided, else default `all` projects (or `HEAD^` when `fallback: previous-commit`). `schedule`: default `all`; no diff.
- Fail-safe rule: any git failure degrades to "all affected" + warning, never to "nothing affected", because a silent empty plan skips CI. Use bounded deepen loops (50, 200, 1000, unshallow) and `--no-tags --no-recurse-submodules`, `-c protocol.version=2`.
- Outputs: JSON arrays/objects, always `has-affected` boolean; document `if: needs.plan.outputs.has-affected == 'true'` guard for `fromJSON` matrices, cap at 256 and 1 MB (error or chunk, never silently truncate).
