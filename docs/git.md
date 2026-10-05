# Git comparison strategy

## Checkout requirements

**Use the defaults.** A plain `actions/checkout` with `fetch-depth: 1` works. When a commit the action needs is missing, it fetches that commit from `origin` by SHA:

- `git fetch --depth=1 origin <sha>`
- a bounded `--depth=50`, then `--depth=500` deepening for merge-base
- `--unshallow` as a last resort

This relies on the credentials that `actions/checkout` persists by default.

- With `persist-credentials: false` on a **private** repository, the action can't fetch. Use `fetch-depth: 0`, or keep the persisted credentials.
- With `fetch: false`, the action never fetches. If history is missing, it selects all projects with a warning.
- `fetch-depth: 0` always works, but on large repositories it is slower than letting the action fetch only what it needs.

## Per event

| Event | Compared range |
| --- | --- |
| `pull_request` (default checkout) | HEAD is GitHub's test-merge commit, `refs/pull/N/merge`. The action diffs its **first parent** (the current base tip) against HEAD. That is exactly what merging would change, and new commits on the base branch are left out. |
| `pull_request` (checkout of the PR head) or `pull_request_target` | `merge-base(base.sha, head.sha)..head.sha`. The commits are fetched by SHA and nothing is checked out or executed. |
| `push` | `before..after`, a two-dot diff of the branch tips. This is correct for fast-forwards and force pushes, and it needs no shared history. |
| `push` to a new branch (`before` is all zeros) | `merge-base(default_branch, after)..after` |
| `push` of a tag | All projects |
| `merge_group` | `base_sha..head_sha` |
| `workflow_dispatch`, `schedule`, anything else | All projects. Set the `base` input to compare instead. |
| `base` input set (any event) | `merge-base(base, head)..head` |

The parents of the merge commit are read from the raw commit object (`git cat-file -p`), so this works even in a depth-1 clone, where git normally hides the parents.

## Fail-safe rule

If the right comparison can't be established, the action:

- outputs **every** project
- sets `all=true` and `reason=<why>`
- emits a `::warning`

Cases include:

- the `before` commit was garbage-collected
- history can't be fetched
- the event has no base

The action never guesses a base and never reports "nothing changed" because data is missing. Running too many jobs costs minutes; skipping a broken project costs correctness.

## Renames, deletes and the root

- **Renames:** both the old and the new path count. Moving a file from `libs/a` to `libs/b` affects both projects. If git's rename limit turns a rename into a delete plus an add, the result is the same.
- **Deleted files** count for the project that owned them.
- **Root files** affect a project only if it has `path: .`, or if they match `global` or a project's `include`. Otherwise they are listed as "outside any project".
- **`.github/` changes:** a change to the config file triggers the config comparison described in [configuration.md](configuration.md#config-changes). Add `.github/workflows/**` to `global` if a workflow change should rebuild everything.
