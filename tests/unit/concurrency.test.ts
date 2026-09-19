/**
 * The bounded-concurrency helper every provider's batched lookup runs through,
 * and which the workspace-wide panel checks now use too.
 *
 * Worth testing directly rather than only through its callers: the bound is
 * what keeps a fifty-project monorepo from opening fifty parallel
 * multi-megabyte parses, and the ordering guarantee is what lets callers label
 * results by position.
 */

import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../../src/providers/shared/concurrency.js';

/** Resolves on demand, so a test controls exactly when a worker finishes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    // Callers label results by position — the panel checks pair each result
    // with its project — so timing must not shuffle them.
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms / 10));
      return ms;
    });

    expect(results).toEqual([30, 10, 20]);
  });

  it('never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      4,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
      },
    );

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('actually runs work in parallel up to the limit', async () => {
    // A bound that silently serialised everything would pass the test above.
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let started = 0;

    const all = mapWithConcurrency(gates, 3, async (gate) => {
      started++;
      await gate.promise;
    });

    await Promise.resolve();
    expect(started).toBe(3);

    for (const gate of gates) gate.resolve();
    await all;
  });

  it('visits every item when there are more items than workers', async () => {
    const seen: number[] = [];

    await mapWithConcurrency(
      Array.from({ length: 50 }, (_, index) => index),
      3,
      async (item) => {
        seen.push(item);
      },
    );

    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50);
  });

  it('handles an empty list without spawning a worker', async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, async () => {
      calls++;
    });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects when a worker throws', async () => {
    // Callers wrap this in their own try/catch; it must not swallow.
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
  });
});
