# React Flag Hook Memory Stress Repro

This is the manual stress harness used to compare the behavior before and after PR #1420 for issue #1360.

It is meant to answer:

```text
Does rerendering many hooks keep adding OpenFeature handlers?
Are handlers removed after unmount?
Does heapUsed trend upward across rerenders after forced GC?
```

It is not a precise React memory profiler or a retained-object heap snapshot. `process.memoryUsage()` reports process-level Node/V8 memory, so the numbers include Jest, jsdom, React Testing Library, React, OpenFeature, and the Node runtime. The strongest signal in this repro is the direct instrumentation around `client.addHandler`, `client.removeHandler`, and `client.getBooleanDetails`.

## Compared Revisions

- Before PR #1420: `7099e9e8eb8103a3a9e5a4d7925c1aace2e05bc7`
- After PR #1420: `424efcf74a3184c0766bc87ae12b47a1a370265c`

## Repro File

Add this file as:

```text
packages/react/test/react-flag-memory-stress.spec.tsx
```

```tsx
import { jest } from '@jest/globals';
import { act, render } from '@testing-library/react';
import * as fs from 'fs';
import * as React from 'react';
import type { EventHandler, EventOptions } from '@openfeature/web-sdk';
import { OpenFeature, OpenFeatureProvider, ProviderEvents, TypedInMemoryProvider, useBooleanFlagValue } from '../src/';

type GcGlobal = typeof globalThis & { gc?: () => void };

const FLAG_KEY = 'stress-flag';
const FLAG_CONFIG = {
  [FLAG_KEY]: {
    disabled: false,
    variants: {
      on: true,
      off: false,
    },
    defaultVariant: 'on',
  },
} as const;

function forceGc() {
  const gc = (globalThis as GcGlobal).gc;
  if (!gc) {
    throw new Error('Run this test with node --expose-gc');
  }

  for (let i = 0; i < 4; i++) {
    gc();
  }
}

function makeEventCounters() {
  return {
    ready: 0,
    contextChanged: 0,
    configurationChanged: 0,
    total: 0,
  };
}

function incrementEventCounter(counters: ReturnType<typeof makeEventCounters>, event: ProviderEvents) {
  if (event === ProviderEvents.Ready) {
    counters.ready++;
  }

  if (event === ProviderEvents.ContextChanged) {
    counters.contextChanged++;
  }

  if (event === ProviderEvents.ConfigurationChanged) {
    counters.configurationChanged++;
  }

  counters.total++;
}

function memorySnapshot(label: string, client: ReturnType<typeof OpenFeature.getClient>) {
  const memory = process.memoryUsage();
  return {
    label,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    rss: memory.rss,
    handlers: {
      ready: client.getHandlers(ProviderEvents.Ready).length,
      contextChanged: client.getHandlers(ProviderEvents.ContextChanged).length,
      configurationChanged: client.getHandlers(ProviderEvents.ConfigurationChanged).length,
    },
  };
}

describe('react flag memory stress repro', () => {
  jest.setTimeout(120000);

  it('records handler churn and memory while parent rerenders many flag hooks', async () => {
    const hookCount = Number(process.env.OF_MEM_HOOK_COUNT ?? 500);
    const rerenders = Number(process.env.OF_MEM_RERENDERS ?? 1000);
    const sampleEvery = Number(process.env.OF_MEM_SAMPLE_EVERY ?? 100);
    const domain = process.env.OF_MEM_DOMAIN ?? 'react-flag-memory-stress';

    await OpenFeature.clearProviders();
    await OpenFeature.setProviderAndWait(domain, new TypedInMemoryProvider(FLAG_CONFIG));
    const client = OpenFeature.getClient(domain);
    const addCalls = makeEventCounters();
    const removeCalls = makeEventCounters();
    let resolverCalls = 0;
    const originalAddHandler = client.addHandler.bind(client);
    const originalRemoveHandler = client.removeHandler.bind(client);
    const originalGetBooleanDetails = client.getBooleanDetails.bind(client);

    client.addHandler = (eventType: ProviderEvents, handler: EventHandler, options: EventOptions) => {
      incrementEventCounter(addCalls, eventType);
      return originalAddHandler(eventType, handler, options);
    };
    client.removeHandler = (eventType: ProviderEvents, handler: EventHandler) => {
      incrementEventCounter(removeCalls, eventType);
      return originalRemoveHandler(eventType, handler);
    };
    client.getBooleanDetails = (...args: Parameters<typeof originalGetBooleanDetails>) => {
      resolverCalls++;
      return originalGetBooleanDetails(...args);
    };

    const snapshots: ReturnType<typeof memorySnapshot>[] = [];
    let unmount: (() => void) | undefined;

    function HookComponent() {
      useBooleanFlagValue(FLAG_KEY, false);
      return null;
    }

    function TestComponent({ tick }: { tick: number }) {
      return (
        <>
          <span data-testid="tick">{tick}</span>
          {Array.from({ length: hookCount }, (_, index) => (
            <HookComponent key={index} />
          ))}
        </>
      );
    }

    const renderStressTree = (tick: number) => (
      <OpenFeatureProvider client={client}>
        <TestComponent tick={tick} />
      </OpenFeatureProvider>
    );

    try {
      forceGc();
      snapshots.push(memorySnapshot('before-render-after-gc', client));

      const rendered = render(renderStressTree(0));
      unmount = rendered.unmount;
      const { rerender } = rendered;

      forceGc();
      snapshots.push(memorySnapshot('after-mount-after-gc', client));

      for (let tick = 1; tick <= rerenders; tick++) {
        act(() => {
          rerender(renderStressTree(tick));
        });

        if (tick % sampleEvery === 0 || tick === rerenders) {
          snapshots.push(memorySnapshot(`after-rerender-${tick}-before-gc`, client));
          forceGc();
          snapshots.push(memorySnapshot(`after-rerender-${tick}-after-gc`, client));
        }
      }

      snapshots.push(memorySnapshot('after-rerenders-before-gc', client));
      forceGc();
      snapshots.push(memorySnapshot('after-rerenders-after-gc', client));

      unmount();
      unmount = undefined;
      forceGc();
      snapshots.push(memorySnapshot('after-unmount-after-gc', client));

      const result = {
        label: process.env.OF_MEM_LABEL,
        hookCount,
        rerenders,
        sampleEvery,
        addCalls,
        removeCalls,
        resolverCalls,
        snapshots,
      };

      if (process.env.OF_MEM_RESULT_PATH) {
        fs.writeFileSync(process.env.OF_MEM_RESULT_PATH, JSON.stringify(result, null, 2));
      }

      const finalSnapshot = snapshots.at(-1)!;
      expect(finalSnapshot.handlers).toEqual({
        ready: 0,
        contextChanged: 0,
        configurationChanged: 0,
      });
    } finally {
      unmount?.();
      client.addHandler = originalAddHandler as typeof client.addHandler;
      client.removeHandler = originalRemoveHandler as typeof client.removeHandler;
      client.getBooleanDetails = originalGetBooleanDetails as typeof client.getBooleanDetails;
      await OpenFeature.clearProviders();
    }
  });
});
```

## How To Run

Run from the repository root. This command is intentionally not a normal CI unit-test command.

```bash
OF_MEM_LABEL=before-pr \
OF_MEM_HOOK_COUNT=500 \
OF_MEM_RERENDERS=1000 \
OF_MEM_SAMPLE_EVERY=100 \
OF_MEM_RESULT_PATH=/tmp/openfeature-react-memory-before.json \
node --expose-gc ./node_modules/jest/bin/jest.js \
  --selectProjects=react \
  --runTestsByPath packages/react/test/react-flag-memory-stress.spec.tsx \
  --runInBand \
  --coverage=false \
  --logHeapUsage
```

For the after-PR run, use a different label and output file:

```bash
OF_MEM_LABEL=after-pr \
OF_MEM_HOOK_COUNT=500 \
OF_MEM_RERENDERS=1000 \
OF_MEM_SAMPLE_EVERY=100 \
OF_MEM_RESULT_PATH=/tmp/openfeature-react-memory-after.json \
node --expose-gc ./node_modules/jest/bin/jest.js \
  --selectProjects=react \
  --runTestsByPath packages/react/test/react-flag-memory-stress.spec.tsx \
  --runInBand \
  --coverage=false \
  --logHeapUsage
```

## Requirements

- Run with `node --expose-gc`; the test fails without it.
- Run with `--runInBand` so one Jest worker owns the process memory counters.
- Use the React Jest project from the repo root (`--selectProjects=react`) so TypeScript/jsdom/module mapping match the existing test setup.
- Treat `heapUsed`, `heapTotal`, and `rss` as process-level trend data, not exact component memory.
- Prefer handler counters as the main signal for this issue.
- Keep this as a manual stress/debug script, not as a normal CI test.

## Summarizing Results

The JSON result file contains byte values. This Node snippet prints the most useful comparison fields:

```bash
node - /tmp/openfeature-react-memory-before.json /tmp/openfeature-react-memory-after.json <<'NODE'
const fs = require('fs');
const mb = (n) => Number((n / 1024 / 1024).toFixed(2));

for (const file of process.argv.slice(2)) {
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  const snapshots = Object.fromEntries(result.snapshots.map((snapshot) => [snapshot.label, snapshot]));
  const mount = snapshots['after-mount-after-gc'];
  const after = snapshots['after-rerenders-after-gc'];
  const unmount = snapshots['after-unmount-after-gc'];
  const peakHeap = Math.max(...result.snapshots.map((snapshot) => snapshot.heapUsed));
  const peakRss = Math.max(...result.snapshots.map((snapshot) => snapshot.rss));
  const gcTrend = result.snapshots
    .filter((snapshot) => /^after-rerender-\d+-after-gc$/.test(snapshot.label))
    .map((snapshot) => ({
      tick: Number(snapshot.label.match(/\d+/)[0]),
      heapUsedMB: mb(snapshot.heapUsed),
      rssMB: mb(snapshot.rss),
    }));

  console.log(JSON.stringify({
    file,
    label: result.label,
    hookCount: result.hookCount,
    rerenders: result.rerenders,
    sampleEvery: result.sampleEvery,
    addCalls: result.addCalls,
    removeCalls: result.removeCalls,
    resolverCalls: result.resolverCalls,
    handlersAfterMount: mount.handlers,
    handlersAfterRerenders: after.handlers,
    handlersAfterUnmount: unmount.handlers,
    heapMountMB: mb(mount.heapUsed),
    heapAfterRerendersGcMB: mb(after.heapUsed),
    heapUnmountGcMB: mb(unmount.heapUsed),
    heapGrowthAfterGcFromMountMB: mb(after.heapUsed - mount.heapUsed),
    peakHeapMB: mb(peakHeap),
    rssMountMB: mb(mount.rss),
    rssAfterRerendersGcMB: mb(after.rss),
    rssUnmountGcMB: mb(unmount.rss),
    rssGrowthAfterGcFromMountMB: mb(after.rss - mount.rss),
    peakRssMB: mb(peakRss),
    gcTrend,
  }, null, 2));
}
NODE
```

## Latest Local Run

Environment:

```text
OF_MEM_HOOK_COUNT=500
OF_MEM_RERENDERS=1000
OF_MEM_SAMPLE_EVERY=100
```

Comparison:

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

This repro strongly supports that PR #1420 removes the pathological handler churn from normal parent rerenders:

```text
Before PR: 1,504,500 handler adds and 1,504,500 handler removes
After PR:      4,500 handler adds and     4,500 handler removes
```

It also shows that repeated flag evaluations drop by about half:

```text
Before PR: 1,001,000 getBooleanDetails calls
After PR:    501,000 getBooleanDetails calls
```

The post-GC heap trend is stable in both cases, which matches the caveat that this harness is better at showing handler churn and memory pressure than proving a precise retained-object leak. For exact retained paths, use a real V8 heap snapshot workflow such as `v8.writeHeapSnapshot()`, the Node inspector, or `--heapsnapshot-signal`, then compare heap graphs in Chrome DevTools.

## References

- Node `process.memoryUsage()`: https://nodejs.org/api/process.html#processmemoryusage
- Node GC exposure / memory diagnostics: https://nodejs.org/learn/diagnostics/memory/understanding-and-tuning-memory
- Node heap snapshots: https://nodejs.org/learn/diagnostics/memory/using-heap-snapshot
- Jest CLI memory debugging: https://jestjs.io/docs/cli#--logheapusage
