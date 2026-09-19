/**
 * Scan coalescing.
 *
 * The rule worth pinning down: an offline scan must never be handed to a caller
 * that asked for registry data. That substitution is invisible — the command
 * appears to succeed and the versions simply do not update.
 */

import { describe, expect, it, vi } from 'vitest';
import { ScanQueue, type ScanRequest } from '../../src/core/scanQueue.js';

/** A queue whose runs resolve only when the test says so. */
function deferredQueue() {
  const calls: ScanRequest[] = [];
  const resolvers: Array<(value: string) => void> = [];

  const queue = new ScanQueue<string>((request) => {
    calls.push(request);
    return new Promise<string>((resolve) => {
      resolvers.push(resolve);
    });
  });

  return {
    queue,
    calls,
    /** Completes the nth run, in the order they started. */
    finish: (index: number, value = `run${index}`) => resolvers[index](value),
  };
}

describe('ScanQueue', () => {
  it('runs a scan when nothing is in flight', async () => {
    const { queue, calls, finish } = deferredQueue();

    const promise = queue.request({ checkUpdates: true });
    expect(calls).toHaveLength(1);

    finish(0, 'done');
    expect(await promise).toBe('done');
  });

  it('shares one in-flight scan with equivalent callers', async () => {
    const { queue, calls, finish } = deferredQueue();

    const a = queue.request({ checkUpdates: true });
    const b = queue.request({ checkUpdates: true });
    expect(calls).toHaveLength(1);

    finish(0, 'shared');
    expect(await a).toBe('shared');
    expect(await b).toBe('shared');
  });

  it('gives an offline caller the online scan already running', async () => {
    // The stronger scan is a superset: it reads the manifests too.
    const { queue, calls, finish } = deferredQueue();

    queue.request({ checkUpdates: true });
    const offline = queue.request({ checkUpdates: false });
    expect(calls).toHaveLength(1);

    finish(0, 'online');
    expect(await offline).toBe('online');
  });

  it('does not palm an offline scan off on a caller that wants updates', async () => {
    /*
     * The regression this file exists for. With `autoCheckUpdates` off, the
     * activation scan is offline; a user running "Check for Updates" while it
     * is still going used to receive that offline result and no feedback.
     */
    const { queue, calls, finish } = deferredQueue();

    queue.request({ checkUpdates: false });
    const wantsUpdates = queue.request({ checkUpdates: true });

    // Still only the offline scan; the stronger one is queued behind it.
    expect(calls).toHaveLength(1);

    finish(0, 'offline');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].checkUpdates).toBe(true);

    finish(1, 'online');
    expect(await wantsUpdates).toBe('online');
  });

  it('queues only one follow-up for several update requests', async () => {
    const { queue, calls, finish } = deferredQueue();

    queue.request({ checkUpdates: false });
    const first = queue.request({ checkUpdates: true });
    const second = queue.request({ checkUpdates: true });

    finish(0, 'offline');
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    finish(1, 'online');
    expect(await first).toBe('online');
    expect(await second).toBe('online');
    // Two scans total, not three.
    expect(calls).toHaveLength(2);
  });

  it('carries the audit flag through to the run', async () => {
    const { queue, calls, finish } = deferredQueue();

    queue.request({ checkUpdates: true, audit: false });
    expect(calls[0].audit).toBe(false);
    finish(0);
  });

  it('does not palm an unaudited scan off on a caller that wants audit data', async () => {
    /*
     * The audit-flag counterpart of the checkUpdates regression above: a
     * caller asking for vulnerability data must not be handed a result from
     * an in-flight scan that never ran the audit step, or it will believe it
     * has vulnerability data it never actually fetched.
     */
    const { queue, calls, finish } = deferredQueue();

    queue.request({ checkUpdates: true, audit: false });
    const wantsAudit = queue.request({ checkUpdates: true, audit: true });

    expect(calls).toHaveLength(1);

    finish(0, 'unaudited');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].audit).toBe(true);

    finish(1, 'audited');
    expect(await wantsAudit).toBe('audited');
  });

  it('starts fresh once a scan has settled', async () => {
    const { queue, calls, finish } = deferredQueue();

    const first = queue.request({ checkUpdates: false });
    finish(0, 'a');
    await first;

    queue.request({ checkUpdates: false });
    expect(calls).toHaveLength(2);
    finish(1);
  });

  it('does not wedge the queue when a scan rejects', async () => {
    const failing = new ScanQueue<string>(() =>
      Promise.reject(new Error('boom')),
    );
    await expect(failing.request({ checkUpdates: true })).rejects.toThrow(
      'boom',
    );

    // A rejected scan must clear the slot, or nothing would ever run again.
    const succeeding = new ScanQueue<string>(() => Promise.resolve('ok'));
    expect(await succeeding.request({ checkUpdates: true })).toBe('ok');
  });

  it('settles without throwing on a failed scan', async () => {
    const failing = new ScanQueue<string>(() =>
      Promise.reject(new Error('boom')),
    );
    failing.request({ checkUpdates: true }).catch(() => undefined);

    await expect(failing.settled()).resolves.toBeUndefined();
  });
});

describe('failure isolation', () => {
  it('runs a queued stronger request even when the scan ahead of it rejects', async () => {
    const calls: boolean[] = [];
    const queue = new ScanQueue<string>(async (request) => {
      calls.push(request.checkUpdates);
      if (!request.checkUpdates) throw new Error('offline scan blew up');
      return 'registry data';
    });

    const offline = queue.request({ checkUpdates: false });
    const online = queue.request({ checkUpdates: true });

    // The failing request still reports its own failure to its own caller...
    await expect(offline).rejects.toThrow('offline scan blew up');
    // ...and the one queued behind it gets the answer it actually asked for,
    // rather than inheriting an error from a request it never made.
    await expect(online).resolves.toBe('registry data');
    expect(calls).toEqual([false, true]);
  });
});
