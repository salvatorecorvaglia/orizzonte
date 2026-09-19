/**
 * The ordering guarantee the integrated terminal depends on.
 *
 * These assert overlap directly — by recording entry and exit around a task
 * that yields — rather than by timing, which would pass on a fast machine
 * whatever the implementation did.
 */

import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../../src/core/serialQueue.js';

/** A task that records when it starts and stops, and finishes on demand. */
function tracked(log: string[], name: string) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    release,
    task: async () => {
      log.push(`start:${name}`);
      await gate;
      log.push(`end:${name}`);
      return name;
    },
  };
}

describe('SerialQueue', () => {
  it('does not start a task while another is running', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const first = tracked(log, 'a');
    const second = tracked(log, 'b');

    const a = queue.run(first.task);
    const b = queue.run(second.task);

    // Both are queued, but only the first may have begun.
    await Promise.resolve();
    expect(log).toEqual(['start:a']);

    first.release();
    await a;
    second.release();
    await b;

    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('preserves the order tasks were queued in', async () => {
    const queue = new SerialQueue();
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3, 4].map((index) =>
        queue.run(async () => {
          // A yield long enough that an unserialised queue would interleave.
          await new Promise((resolve) => setTimeout(resolve, 5 - index));
          order.push(index);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('resolves each caller with its own task’s result', async () => {
    const queue = new SerialQueue();
    const results = await Promise.all([
      queue.run(async () => 'first'),
      queue.run(async () => 'second'),
    ]);
    expect(results).toEqual(['first', 'second']);
  });

  /*
   * The case that matters for a bulk update: one package failing to install
   * must not take the rest of the batch down with it.
   */
  it('keeps running after a task rejects, and rejects only that caller', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];

    const failing = queue.run(async () => {
      log.push('failing');
      throw new Error('install failed');
    });
    const following = queue.run(async () => {
      log.push('following');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('install failed');
    await expect(following).resolves.toBe('ok');
    expect(log).toEqual(['failing', 'following']);
  });

  it('runs a task queued after the queue has drained', async () => {
    const queue = new SerialQueue();
    await queue.run(async () => 'first');
    await expect(queue.run(async () => 'later')).resolves.toBe('later');
  });
});
