# Examples

| Example | What it shows |
| --- | --- |
| [minimal](minimal/) | Three projects (`shared` → `api` → `web`) and a single build matrix. |
| [realistic](realistic/) | Seven projects with converging dependencies, build, test and deploy matrices, merge queue support, and a required-check gate job. |

Copy `dynamic-monorepos.yml` to `.github/dynamic-monorepos.yml` and `workflow.yml` to `.github/workflows/ci.yml`.
The `realistic` config is exercised on real runners by [`.github/workflows/integration.yml`](../.github/workflows/integration.yml).
