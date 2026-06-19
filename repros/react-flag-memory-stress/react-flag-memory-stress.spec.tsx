import { jest } from '@jest/globals';
import { act, render } from '@testing-library/react';
import type { EventHandler, EventOptions } from '@openfeature/web-sdk';
import * as fs from 'fs';
import * as React from 'react';
import {
  OpenFeature,
  OpenFeatureProvider,
  ProviderEvents,
  TypedInMemoryProvider,
  useBooleanFlagValue,
} from '../../packages/react/src/';

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
