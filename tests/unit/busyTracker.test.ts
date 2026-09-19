/**
 * Reference-counted busy state.
 *
 * The rule worth pinning down: one holder releasing must never clear another
 * holder's claim. That was the original bug — a package-manager command
 * finishing turned off the spinner a background scan still owned, so the panel
 * claimed to be idle for the rest of the scan.
 */

import { describe, expect, it } from 'vitest';
import { BusyTracker } from '../../src/core/busyTracker.js';

function trackerWithLog() {
  const states: Array<{ busy: boolean; label?: string }> = [];
  const tracker = new BusyTracker((busy, label) =>
    states.push({ busy, label }),
  );
  return { tracker, states };
}

describe('BusyTracker', () => {
  it('stays busy until every claim is released', () => {
    const { tracker } = trackerWithLog();

    const scan = tracker.begin('Checking registries…');
    const install = tracker.begin('Install left-pad');
    expect(tracker.busy).toBe(true);

    // The command finishes first — this used to write `false` and strand the
    // scan's spinner off.
    install();
    expect(tracker.busy).toBe(true);

    scan();
    expect(tracker.busy).toBe(false);
  });

  it('shows the most recent claim, and falls back when it is released', () => {
    const { tracker } = trackerWithLog();

    tracker.begin('Checking registries…');
    expect(tracker.label).toBe('Checking registries…');

    const install = tracker.begin('Install left-pad');
    expect(tracker.label).toBe('Install left-pad');

    install();
    expect(tracker.label).toBe('Checking registries…');
  });

  it('reports a change only when the state actually changes', () => {
    const { tracker, states } = trackerWithLog();

    const first = tracker.begin('Reading manifests…');
    const second = tracker.begin('Reading manifests…');
    first();
    second();

    // busy(label) -> idle. The second identical claim adds nothing to report.
    expect(states).toEqual([
      { busy: true, label: 'Reading manifests…' },
      { busy: false, label: undefined },
    ]);
  });

  it('ignores a repeated release rather than dropping someone else claim', () => {
    const { tracker } = trackerWithLog();

    const scan = tracker.begin('Checking registries…');
    const install = tracker.begin('Install left-pad');

    install();
    install();
    install();

    expect(tracker.busy).toBe(true);
    scan();
    expect(tracker.busy).toBe(false);
  });

  it('drops every claim on reset, so disposal cannot strand a spinner', () => {
    const { tracker, states } = trackerWithLog();

    tracker.begin('Checking registries…');
    tracker.begin('Install left-pad');
    tracker.reset();

    expect(tracker.busy).toBe(false);
    expect(states[states.length - 1]).toEqual({
      busy: false,
      label: undefined,
    });
  });
});
