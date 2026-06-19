# React Flag Memory Stress Repro

Manual stress repro for issue #1360 and PR #1420.

This folder is intentionally separate from normal package tests. It is useful for checking handler churn and process-level memory trends while repeatedly rerendering many React flag hooks.

It answers:

```text
Does rerendering many hooks keep adding OpenFeature handlers?
Are handlers removed after unmount?
Does heapUsed trend upward across rerenders after forced GC?
```

It does not precisely measure React component memory or prove retained object paths. `process.memoryUsage()` reports process-level Node/V8 counters, so results include Jest, jsdom, React Testing Library, React, OpenFeature, and runtime allocations.

## Files

- `react-flag-memory-stress.spec.tsx`: the stress test
- `jest.config.cjs`: isolated Jest config that mirrors the React package mappings
- `tsconfig.json`: TS config for this external repro folder
- `summarize-results.js`: converts JSON output byte values into MB summaries

## Run

Run from the repository root.

To compare two revisions, make sure this `repros/react-flag-memory-stress` folder is available in both checkouts. For example, create two `git worktree` directories for the before/after commits and copy this repro folder into each one before running the commands below. The "before PR" commit itself will not contain this new repro folder unless you copy it there as a local, uncommitted test harness.

Before PR #1420:

```bash
OF_MEM_LABEL=before-pr \
OF_MEM_HOOK_COUNT=500 \
OF_MEM_RERENDERS=1000 \
OF_MEM_SAMPLE_EVERY=100 \
OF_MEM_RESULT_PATH=/tmp/openfeature-react-memory-before.json \
node --expose-gc ./node_modules/jest/bin/jest.js \
  --config repros/react-flag-memory-stress/jest.config.cjs \
  --runInBand \
  --coverage=false \
  --logHeapUsage
```

After PR #1420:

```bash
OF_MEM_LABEL=after-pr \
OF_MEM_HOOK_COUNT=500 \
OF_MEM_RERENDERS=1000 \
OF_MEM_SAMPLE_EVERY=100 \
OF_MEM_RESULT_PATH=/tmp/openfeature-react-memory-after.json \
node --expose-gc ./node_modules/jest/bin/jest.js \
  --config repros/react-flag-memory-stress/jest.config.cjs \
  --runInBand \
  --coverage=false \
  --logHeapUsage
```

The important environment variables are:

- `OF_MEM_LABEL`: label written to the result JSON
- `OF_MEM_HOOK_COUNT`: number of hook components to mount, default `500`
- `OF_MEM_RERENDERS`: number of parent rerenders, default `1000`
- `OF_MEM_SAMPLE_EVERY`: interval for before/after forced-GC samples, default `100`
- `OF_MEM_RESULT_PATH`: where to write the JSON metrics

## Analyze

Summarize one or more JSON result files:

```bash
node repros/react-flag-memory-stress/summarize-results.js \
  /tmp/openfeature-react-memory-after.json
```

To compare before and after, run the repro in both revisions first, then pass both result files:

```bash
node repros/react-flag-memory-stress/summarize-results.js \
  /tmp/openfeature-react-memory-before.json \
  /tmp/openfeature-react-memory-after.json
```

The best signals are:

- `addCalls` and `removeCalls`: direct handler churn counters
- `resolverCalls`: how many `getBooleanDetails` evaluations ran
- `handlersAfterUnmount`: should be `{ ready: 0, contextChanged: 0, configurationChanged: 0 }`
- `gcTrend`: post-forced-GC heap/RSS trend at each sample interval
- `heapGrowthAfterGcFromMountMB`: process-level V8 heap growth after forced GC

Treat `rss` as broad process pressure, not exact JS object retention.

## Latest Local Comparison

Compared revisions:

- Before PR #1420: `7099e9e8eb8103a3a9e5a4d7925c1aace2e05bc7`
- After PR #1420: `424efcf74a3184c0766bc87ae12b47a1a370265c`

Run parameters:

```text
OF_MEM_HOOK_COUNT=500
OF_MEM_RERENDERS=1000
OF_MEM_SAMPLE_EVERY=100
```

| Metric                                 |  Before PR |   After PR |   Improvement |
| -------------------------------------- | ---------: | ---------: | ------------: |
| Jest total runtime                     |     23.31s |      7.42s |    68% faster |
| Test body runtime                      |     22.14s |      6.07s |    73% faster |
| Total handler adds                     |  1,504,500 |      4,500 |   99.7% fewer |
| Total handler removes                  |  1,504,500 |      4,500 |   99.7% fewer |
| Ready handler adds                     |    501,000 |      1,000 |   99.8% fewer |
| Boolean resolver calls                 |  1,001,000 |    501,000 |     50% fewer |
| Peak heap                              |  781.62 MB |  559.69 MB |     28% lower |
| Heap after rerenders + forced GC       |  446.06 MB |  438.58 MB | 7.48 MB lower |
| Heap growth after forced GC from mount |  +10.10 MB |   +2.58 MB |     74% lower |
| RSS growth after forced GC from mount  | +237.38 MB | +106.98 MB |     55% lower |
| Handlers after unmount                 |  0 / 0 / 0 |  0 / 0 / 0 | clean in both |

Post-GC heap trend:

| Rerender tick | Before PR heapUsed | After PR heapUsed |
| ------------: | -----------------: | ----------------: |
|           100 |          445.58 MB |         438.12 MB |
|           500 |          445.85 MB |         438.36 MB |
|          1000 |          446.06 MB |         438.58 MB |

## Interpretation

This repro strongly supports that PR #1420 removes pathological event handler churn during normal parent rerenders:

```text
Before PR: 1,504,500 handler adds and 1,504,500 handler removes
After PR:      4,500 handler adds and     4,500 handler removes
```

It also shows repeated flag evaluations drop by about half:

```text
Before PR: 1,001,000 getBooleanDetails calls
After PR:    501,000 getBooleanDetails calls
```

The post-GC heap trend is stable in both cases, so this is best described as a memory stress harness and handler-churn repro, not a precise heap-snapshot profiler. For retained-object paths, use a V8 heap snapshot workflow such as `v8.writeHeapSnapshot()`, the Node inspector, or `--heapsnapshot-signal`.

## Requirements And Caveats

- Run with `node --expose-gc`; the test fails without it.
- Run with `--runInBand` so one Jest worker owns the process memory counters.
- Keep this as a manual debug script, not a normal CI unit test.
- Process memory numbers are trends only. Prefer handler counters as the primary signal.

References:

- Node `process.memoryUsage()`: https://nodejs.org/api/process.html#processmemoryusage
- Node memory diagnostics: https://nodejs.org/learn/diagnostics/memory/understanding-and-tuning-memory
- Node heap snapshots: https://nodejs.org/learn/diagnostics/memory/using-heap-snapshot
- Jest CLI memory debugging: https://jestjs.io/docs/cli#--logheapusage
