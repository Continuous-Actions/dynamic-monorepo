# Outputs

Every list is a compact JSON array, sorted in **dependency order**: dependencies come before dependents, and ties are broken by name. They are designed for `fromJSON()`.

| Output | Type | Description |
| --- | --- | --- |
| `changed` | JSON array | Projects that contain changed files, plus projects that were added, renamed or redefined in the config. |
| `affected` | JSON array | `changed` plus everything that transitively depends on those projects. |
| `build` / `test` / `deploy` | JSON array | The `affected` projects that have that target. |
| `build_batches` / `test_batches` / `deploy_batches` | JSON array of arrays | At most `max-jobs` balanced groups (default 256) that together contain every project in the list, in dependency order. Use these when a list can exceed GitHub's 256-job matrix limit. |
| `added` | JSON array | Projects in the head config but not in the base config. |
| `deleted` | JSON array | Projects that existed at base and are gone. They never appear in `affected`. |
| `renamed` | JSON array | `[{"from":"old","to":"new"}]` for projects renamed at the same path, or renamed and moved together by git. |
| `skipped` | JSON array | Projects that were not affected. |
| `paths` | JSON object | Maps each affected project to its directory: `{"api":"services/api"}`. |
| `has_changes` / `has_build` / `has_test` / `has_deploy` | `"true"`/`"false"` | Whether the matching list is non-empty. Use these to guard matrix jobs. |
| `all` | `"true"`/`"false"` | Whether every project was selected, because a global file changed or there was no usable comparison. |
| `reason` | string | Why `all` is true. |
| `base` / `head` | SHA | The commits that were compared. `base` is empty when there was no diff. |
| `plan_file` | path | `$RUNNER_TEMP/dynamic-monorepos-plan.json`: the full plan, including a reason for every project. |

## Patterns

**Guard against empty matrices.** In Actions, `matrix: ${{ fromJSON('[]') }}` fails the job:

```yaml
if: needs.plan.outputs.has_build == 'true'
```

**Look up a project's directory inside a matrix job:**

```yaml
working-directory: ${{ fromJSON(needs.plan.outputs.paths)[matrix.project] }}
```

**Required status checks.** Matrix jobs that are skipped count as "success", but a whole workflow skipped by `on.paths` leaves a required check pending forever. Run the workflow on every PR and add one gate job:

```yaml
gate:
  if: always()
  needs: [plan, build, test]
  runs-on: ubuntu-latest
  steps:
    - run: |
        [[ "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}" == "false" ]]
```

**Pass values to shell scripts through `env`.** Don't interpolate expressions inside `run:`:

```yaml
env:
  PROJECT: ${{ matrix.project }}
run: ./build.sh "$PROJECT"
```

Project names are already restricted to `[A-Za-z0-9._@/-]`. Passing them through `env` is still the habit that keeps every value safe.

## Size limits

GitHub limits a job's outputs to 1 MB each and 50 MB in total, and a matrix to 256 jobs. With 50,000 short project names the lists stay well below 1 MB. If a target list can exceed 256 entries, use the matching `*_batches` output.
