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
