---
name: dynamic-monorepo
description: Set up GitHub Actions CI for a monorepo so that only the projects a change affects are built, tested, deployed or turned into Docker images. Use when a repository has several services, apps or libraries (package.json, go.mod, Cargo.toml, pyproject.toml, pom.xml, Gradle, .csproj, Dockerfile, Helm charts) and the user wants selective or affected-only CI or a dynamic build matrix, or wants to replace per-service workflows and hand-maintained path filters.
---

# Selective monorepo CI with dynamic-monorepo

1. **Check that it fits.** The repository needs two or more buildable folders with marker files. Preview what will be detected (nothing to install):
   `npx github:Continuous-Actions/dynamic-monorepo projects`
2. **Add one planning job** and fan out with `fromJSON`. Copy the snippet exactly. The `if:` guard is required, because an empty matrix fails the job.

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    outputs:
      build: ${{ steps.plan.outputs.build }}
      docker: ${{ steps.plan.outputs.docker }}
      paths: ${{ steps.plan.outputs.paths }}
      dockerfiles: ${{ steps.plan.outputs.dockerfiles }}
      has_build: ${{ steps.plan.outputs.has_build }}
      has_docker: ${{ steps.plan.outputs.has_docker }}
    steps:
      - uses: actions/checkout@v7
      - uses: Continuous-Actions/dynamic-monorepo@v1
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
      - name: Build
        working-directory: ${{ fromJSON(needs.plan.outputs.paths)[matrix.project] }}
        run: echo "replace with the project's build command"

  docker:
    needs: plan
    if: needs.plan.outputs.has_docker == 'true'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        project: ${{ fromJSON(needs.plan.outputs.docker) }}
    steps:
      - uses: actions/checkout@v7
      - env:
          DIR: ${{ fromJSON(needs.plan.outputs.paths)[matrix.project] }}
          FILE: ${{ fromJSON(needs.plan.outputs.dockerfiles)[matrix.project] }}
        run: docker build -f "$FILE" "$DIR"
```

3. **Required status checks.** Add a final job with `if: always()` that fails only when a job it depends on failed, and make that job the only required check.
4. **Correct detection only if needed.** Add `dynamic-monorepo.config.json` at the repository root with `"detect": true`. Override projects under `projects` (`dependsOn`, `targets`, `include`, `exclude`), and use `global` or `ignore` globs for files that should select every project or none. Schema: https://raw.githubusercontent.com/Continuous-Actions/dynamic-monorepo/v1/schema.json
5. **Verify on a branch.** `npx github:Continuous-Actions/dynamic-monorepo --base origin/main` shows what CI will run and why.

If the user wants to keep their existing `on.paths` workflows, add the action as a check instead with `with: { audit: warn }` (or `fail`); it reports `paths:` lists that miss a dependency's folder. Locally: `npx github:Continuous-Actions/dynamic-monorepo audit`.

Notes:
- It works with the default shallow checkout.
- It needs only `contents: read`.
- For `workflow_dispatch` or `schedule` runs, set the `base` input. Otherwise every project is selected.
- If the repository already has one workflow per service limited by `on.paths`, map each `paths` entry as described in https://github.com/Continuous-Actions/dynamic-monorepo/blob/main/docs/migrating-from-path-filters.md, and don't put `on.paths` on the new workflow (a skipped workflow leaves required checks pending).

Full docs: https://github.com/Continuous-Actions/dynamic-monorepo
