# Examples

| Example | What it shows |
| --- | --- |
| [minimal](minimal/) | Three projects (`shared` → `api` → `web`) and a single build matrix. |
| [realistic](realistic/) | Seven projects with converging dependencies, build, test and deploy matrices, merge queue support, and a required-check gate job. |

Copy `dynamic-monorepo.config.json` to your repository root and `workflow.yml` to `.github/workflows/ci.yml`.

The realistic graph:

```text
shared ◀─ auth ◀─ api ◀─ portal
  ▲        ▲       ▲
  │        └───────┴──── admin
  └── worker ◀── reporting (also depends on api)
```
The `realistic` config is exercised on real runners by [`.github/workflows/dynamic-monorepo.yml` (the "Dynamic-Monorepo" workflow)](../../.github/workflows/dynamic-monorepo.yml).
