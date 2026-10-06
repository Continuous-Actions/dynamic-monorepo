# Migrating from `on.paths` filters

Many monorepos start with one workflow per service, each limited by `on.paths`:

```yaml
# .github/workflows/api.yml, and a near-copy for every other service
on:
  pull_request:
    paths:
      - "services/api/**"
      - "libs/shared/**"     # because api uses shared
      - "package-lock.json"
```

This works until the repository grows. Then:

- **Dependencies are maintained by hand.** When `web` starts using `libs/shared`, someone has to remember to add `libs/shared/**` to `web.yml`. If nobody does, a breaking change to `shared` passes CI.
- **Required checks get stuck.** A workflow skipped by `on.paths` never reports a status, so a required check from it stays "Expected — Waiting for status to be reported" and the pull request can't merge.
- **The YAML is duplicated.** Every service has its own copy of the same setup, build and test steps. A fix to one has to be copied to all of them.
- **Adding a service means adding a workflow.**

`dynamic-monorepo` replaces all of these files with one workflow. It finds the projects, reads the dependencies from their manifests, and gives you the list of projects to build.

## Step 1: preview what would be detected

In the root of your repository:

```bash
npx dynamic-monorepo projects
```

This lists every project with its folder, targets and dependencies. Compare it with your existing workflows: each `services/*` or `apps/*` folder that has its own workflow should appear. To see what would run for your current branch:

```bash
npx dynamic-monorepo --base origin/main
```

## Step 2: map your `paths` lists

Go through the `paths` entries of each old workflow:

| Old `paths` entry | What to do |
| --- | --- |
| The service's own folder (`services/api/**`) | Nothing. The folder is the project. |
| A library the service uses (`libs/shared/**`) | Nothing, if the dependency is in `package.json`, `go.mod`, `Cargo.toml` or a `.csproj`. Otherwise add `"dependsOn": ["shared"]` in a config file. |
| A root lockfile (`package-lock.json`, `go.work.sum`, `Cargo.lock`, ...) | Nothing. A root lockfile selects every project of its ecosystem. |
| A shared file outside every project (`proto/api.proto`) | Add it to that project's `include`. |
| Something that should rebuild everything (`.github/workflows/**`, `Makefile`) | Add it to `global`. |
| A `paths-ignore` entry (`**/*.md`) | Add it to `ignore`. |

If the table told you to do nothing, you don't need a config file. Otherwise create `dynamic-monorepo.config.json`. Keep `"detect": true` so you only list what detection can't see:

```json
{
  "$schema": "https://raw.githubusercontent.com/continuous-actions/dynamic-monorepo/v1/schema.json",
  "detect": true,
  "projects": {
    "api": { "path": "services/api", "include": ["proto/api.proto"] }
  },
  "global": [".github/workflows/**", "Makefile"],
  "ignore": ["**/*.md"]
}
```

Run `npx dynamic-monorepo projects` again to check the result.

## Step 3: one workflow for every project

Replace the per-service workflows with one that runs on **every** pull request (no `on.paths`):

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
      paths: ${{ steps.plan.outputs.paths }}
      has_build: ${{ steps.plan.outputs.has_build }}
    steps:
      - uses: actions/checkout@v7
      - uses: continuous-actions/dynamic-monorepo@v1
        id: plan

  build:
    needs: plan
    if: needs.plan.outputs.has_build == 'true'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        project: ${{ fromJSON(needs.plan.outputs.build) }}
    steps:
      - uses: actions/checkout@v7
      - name: Build and test
        working-directory: ${{ fromJSON(needs.plan.outputs.paths)[matrix.project] }}
        run: echo "the build and test steps from your old workflows"

  # The one check to mark as required in branch protection.
  ci-ok:
    if: always()
    needs: [plan, build]
    runs-on: ubuntu-latest
    steps:
      - run: |
          [[ "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}" == "false" ]]
```

If services build differently, branch on the project inside the job (for example a `case "$PROJECT"` in a script, with `PROJECT: ${{ matrix.project }}` passed through `env`), or keep a small reusable workflow per kind of project and call it from the matrix.

## Step 4: switch over

1. Open a pull request that adds the new workflow and keeps the old ones. Check that the new workflow selects the same projects; the job summary says why each one was picked.
2. In branch protection, replace the per-service required checks with `ci-ok`.
3. Delete the old workflows.

## Afterwards

- A new service is picked up as soon as its `package.json`, `go.mod`, `Dockerfile` or other marker file is committed.
- A new dependency is picked up as soon as it is added to the manifest.
- For deployments, use the `deploy` and `docker` outputs the same way. Per-target exclusions (for example "a test-only change doesn't redeploy") are in [configuration.md](configuration.md#targets-per-target-impact).
