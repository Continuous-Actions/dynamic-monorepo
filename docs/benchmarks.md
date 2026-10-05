# Benchmarks

Numbers come from `node bench/bench.ts`. CI runs it on every push and writes the result to the job summary, so Linux numbers can be found in each CI run.

Synthetic graph: a layered DAG with libs, services and apps, where each project depends on up to 3 lower projects (dense on purpose). "plan" covers file ownership, the config diff, graph closure and sorting.

### Windows 11 (local dev machine)

#### In-process (best of 5, ms)

| projects | changed files | parse+validate | graph build | plan | affected |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 0.25 | 0.02 | 0.07 | 10 |
| 100 | 100 | 0.91 | 0.16 | 0.48 | 83 |
| 500 | 1000 | 2.43 | 0.31 | 2.23 | 485 |
| 1000 | 10000 | 4.66 | 0.54 | 12.7 | 1000 |
| 5000 | 100000 | 21.2 | 3.38 | 121.3 | 4951 |
| 10000 | 100000 | 35.1 | 6.80 | 141.7 | 9529 |

#### End to end (bundled action, real git repo, push event; best of 5)

Bundle: dist/index.js = 71255 bytes. Node startup baseline (`node -e 0`): 74.5 ms

| projects | changed files | total wall time (ms) |
| ---: | ---: | ---: |
| 10 | 5 | 516.2 |
| 100 | 50 | 538.0 |
| 1000 | 1000 | 1048.5 |
| 5000 | 10000 | 672.4 |

Platform: win32/x64, Node v24.21.0

Note: on Windows, each git process spawn costs about 50 ms, which dominates the end-to-end times. Linux runners spawn processes far faster; see the Linux table below.

### Linux: GitHub-hosted `ubuntu-latest` runner (CI run 37253383631)

Bundle: `dist/index.js` = 71,255 bytes. Node startup baseline (`node -e 0`): **20.5 ms**. Node v24.21.0, linux/x64.

#### In-process (best of 5, ms)

| projects | changed files | parse+validate | graph build | plan | affected |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 0.29 | 0.01 | 0.07 | 10 |
| 100 | 100 | 1.08 | 0.20 | 0.63 | 83 |
| 500 | 1000 | 3.48 | 0.39 | 2.35 | 485 |
| 1000 | 10000 | 4.04 | 0.55 | 13.9 | 1000 |
| 5000 | 100000 | 19.6 | 4.14 | 120.8 | 4951 |
| 10000 | 100000 | 32.5 | 9.44 | 143.7 | 9529 |

#### End to end (bundled action, real git repo, push event; best of 5)

| projects | changed files | total wall time (ms) |
| ---: | ---: | ---: |
| 10 | 5 | 50.2 |
| 100 | 50 | 57.2 |
| 1000 | 1000 | 105.2 |
| 5000 | 10000 | 232.9 |

**Conclusion:** at 1,000 projects the whole action, including Node startup and git, finishes in about 0.1 s on a hosted runner. A compiled (Rust) binary could save at most the ~20 ms Node startup plus a few ms of CPU, which isn't worth shipping and maintaining five-plus platform binaries.
