/**
 * The webview root: host-message routing and the states it puts the UI into.
 *
 * Messages are delivered the way the host delivers them — a `message` event on
 * `window` — so the bridge in `vscodeApi.ts` is exercised rather than bypassed.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { HostMessage } from '../../src/core/protocol.js';
import type {
  ProjectDependencyDiff,
  ProjectGroup,
  ScanSummary,
} from '../../src/core/types.js';
import { App } from '../../src/webview/App.js';
import { posted } from './setup.js';

const EMPTY_SUMMARY: ScanSummary = {
  totalDependencies: 0,
  outdated: 0,
  vulnerable: 0,
  deprecated: 0,
  stale: false,
};

/**
 * The id the app generated for its most recent request of `type`.
 *
 * Overlay-panel answers are correlated now, so a reply carrying the wrong id is
 * ignored by design — a test that invents one would be asserting on a message
 * the app is supposed to drop.
 */
function lastRequestId(type: string): string {
  const request = [...posted]
    .reverse()
    .find((message): message is { type: string; requestId: string } =>
      Boolean(
        message &&
          typeof message === 'object' &&
          (message as { type?: string }).type === type,
      ),
    );
  if (!request?.requestId) {
    throw new Error(`No ${type} has been posted`);
  }
  return request.requestId;
}

function send(message: HostMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    label: 'app',
    manifestPath: '/p/package.json',
    ecosystem: 'node',
    toolchain: 'npm',
    dependencies: [
      {
        key: 'react',
        name: 'react',
        ecosystem: 'node',
        scope: 'prod',
        declared: '^18.0.0',
        installed: '18.0.0',
        latest: '19.0.0',
        updateKind: 'major',
        vulnerabilities: [],
        manifestPath: '/p/package.json',
        projectLabel: 'app',
      },
    ],
    ...overrides,
  };
}

/** Renders and completes the host handshake with one populated group. */
function renderLoaded(groups = [group()]) {
  const result = render(<App />);
  send({
    type: 'state',
    groups,
    summary: { ...EMPTY_SUMMARY, totalDependencies: groups.length },
  });
  return result;
}

/**
 * Turns the "outdated" chip off.
 *
 * The panel opens narrowed to what needs updating, so a fixture built around
 * an up-to-date package has no row on screen until this runs.
 */
async function showEveryPackage() {
  await userEvent.click(screen.getByRole('button', { name: /^outdated/i }));
}

/**
 * Clicks a toolbar action, opening the overflow menu first when that is where
 * the action lives now.
 *
 * Duplicate versions, Licenses, Compare with… and Export report moved behind
 * one "More" button; the three actions used every session stayed inline. Tests
 * that only care *that* an action runs should not have to know which side of
 * that line it fell on.
 */
async function toolbarAction(name: RegExp) {
  const inline = screen.queryByRole('button', { name });
  if (inline) {
    await userEvent.click(inline);
    return;
  }
  await userEvent.click(screen.getByRole('button', { name: /^More$/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name }));
}

describe('handshake', () => {
  it('announces itself so the host knows it can post', () => {
    render(<App />);
    expect(posted).toContainEqual({ type: 'ready' });
  });
});

describe('empty workspace', () => {
  it('offers a way into registry search', async () => {
    // Searching does not need a manifest — only installing does — so the
    // empty state has to keep the search panel reachable. The toolbar that
    // normally opens it is not rendered here.
    render(<App />);
    send({ type: 'state', groups: [], summary: EMPTY_SUMMARY });

    const open = screen.getByRole('button', {
      name: /Search.*package|Add package/i,
    });
    await userEvent.click(open);

    expect(
      screen.getByRole('searchbox', { name: /Search registries/i }),
    ).toBeInTheDocument();
  });

  it('still offers a rescan', async () => {
    render(<App />);
    send({ type: 'state', groups: [], summary: EMPTY_SUMMARY });

    await userEvent.click(screen.getByRole('button', { name: /Scan again/i }));
    expect(posted).toContainEqual({ type: 'refresh' });
  });
});

describe('notices and errors', () => {
  it('gives an error an assertive role and keeps it until dismissed', async () => {
    renderLoaded();
    send({ type: 'error', message: 'Something broke' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something broke');

    await userEvent.click(
      within(alert).getByRole('button', { name: /Dismiss/i }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps notices separate from errors so one cannot cut the other short', () => {
    renderLoaded();
    send({ type: 'error', message: 'the error' });
    send({ type: 'notice', message: 'the notice' });

    expect(screen.getByRole('alert')).toHaveTextContent('the error');
    expect(screen.getByText('the notice')).toBeInTheDocument();
  });

  /*
   * Errors used to occupy one slot, so the second silently replaced the first.
   * "Update all" against an unreachable registry produces one per package.
   */
  it('queues errors instead of letting a later one erase an earlier one', async () => {
    renderLoaded();
    send({ type: 'error', message: 'first failure' });
    send({ type: 'error', message: 'second failure' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('second failure');
    expect(alert).toHaveTextContent('and 1 earlier error');

    // Dismissing reveals the one behind it rather than discarding the queue.
    await userEvent.click(
      within(alert).getByRole('button', { name: /Dismiss/i }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('first failure');

    await userEvent.click(
      within(screen.getByRole('alert')).getByRole('button', {
        name: /Dismiss/i,
      }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not queue a repeat of the message already on screen', () => {
    renderLoaded();
    send({ type: 'error', message: 'same failure' });
    send({ type: 'error', message: 'same failure' });

    expect(screen.getByRole('alert')).not.toHaveTextContent('earlier');
  });

  it('caps the error queue rather than growing it without bound', () => {
    // "Update all" against a broken registry can fail once per package —
    // hundreds of distinct messages in a large monorepo.
    renderLoaded();
    for (let i = 0; i < 60; i++) {
      send({ type: 'error', message: `failure ${i}` });
    }

    const alert = screen.getByRole('alert');
    // The newest is always what is shown...
    expect(alert).toHaveTextContent('failure 59');
    // ...and the queue behind it is capped, not 59 deep.
    expect(alert).toHaveTextContent('and 49 earlier errors');
  });
});

describe('keyboard shortcuts', () => {
  it('sends Ctrl/Cmd+F to the filter box, which the editor Find cannot reach', async () => {
    renderLoaded();
    const filter = screen.getByRole('searchbox', {
      name: /Filter installed packages/i,
    });
    expect(document.activeElement).not.toBe(filter);

    await userEvent.keyboard('{Control>}f{/Control}');
    expect(document.activeElement).toBe(filter);
  });
});

describe('the why tree cache', () => {
  it('drops cached answers when a new scan arrives', async () => {
    // The graph can have changed under it, and a tree that is quietly one scan
    // stale looks exactly like a current one.
    renderLoaded();
    await userEvent.click(screen.getByText('react'));
    send({
      type: 'whyTree',
      depKey: 'react',
      source: 'lockfile',
      roots: [{ name: 'webpack', children: [] }],
    });
    expect(screen.getByText('webpack')).toBeInTheDocument();

    send({ type: 'state', groups: [group()], summary: EMPTY_SUMMARY });

    expect(screen.queryByText('webpack')).toBeNull();
    expect(screen.getByText(/Resolving/i)).toBeInTheDocument();
  });
});

describe('duplicate versions', () => {
  it('requests a check when the panel opens and shows what comes back', async () => {
    renderLoaded();
    await toolbarAction(/Duplicate versions/i);
    expect(posted).toContainEqual({
      type: 'requestDuplicates',
      requestId: expect.any(String),
    });

    send({
      type: 'duplicateVersions',
      requestId: lastRequestId('requestDuplicates'),
      results: [
        {
          manifestPath: '/p/package.json',
          projectLabel: 'app',
          ecosystem: 'node',
          checked: true,
          groups: [{ name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] }],
        },
      ],
    });

    expect(screen.getByText('ansi-styles')).toBeInTheDocument();
    expect(screen.getByText('3.2.1')).toBeInTheDocument();
    expect(screen.getByText('4.3.0')).toBeInTheDocument();
  });

  it('re-checks when a new scan lands while the panel stays open', async () => {
    renderLoaded();
    await toolbarAction(/Duplicate versions/i);
    // The click itself already posted one request; a rescan must post another.
    const before = posted.length;

    send({ type: 'state', groups: [group()], summary: EMPTY_SUMMARY });

    expect(posted.length).toBeGreaterThan(before);
    expect(posted.at(-1)).toEqual({
      type: 'requestDuplicates',
      requestId: expect.any(String),
    });
  });

  it('stops waiting when the request fails', async () => {
    renderLoaded();
    await toolbarAction(/Duplicate versions/i);
    expect(screen.getByText('Checking lockfiles…')).toBeInTheDocument();

    // A failure used to arrive as a bare `error`, which nothing tied back to
    // the panel — so the banner appeared and the spinner ran for the rest of
    // the session.
    send({
      type: 'panelRequestFailed',
      requestId: lastRequestId('requestDuplicates'),
      message: 'Could not read the lockfile.',
    });

    expect(screen.queryByText('Checking lockfiles…')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read the lockfile.',
    );
  });

  it('ignores an answer to a request it has already superseded', async () => {
    renderLoaded();
    await toolbarAction(/Duplicate versions/i);
    const stale = lastRequestId('requestDuplicates');

    // Close and reopen: the second request is the live one now.
    await toolbarAction(/Duplicate versions/i);
    await toolbarAction(/Duplicate versions/i);
    expect(lastRequestId('requestDuplicates')).not.toBe(stale);

    send({
      type: 'duplicateVersions',
      requestId: stale,
      results: [
        {
          manifestPath: '/p/package.json',
          projectLabel: 'app',
          ecosystem: 'node',
          checked: true,
          groups: [{ name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] }],
        },
      ],
    });

    // The slow first answer must not overwrite what the second asked for.
    expect(screen.queryByText('ansi-styles')).toBeNull();
    expect(screen.getByText('Checking lockfiles…')).toBeInTheDocument();
  });

  it('says so when every checked project is clean', async () => {
    renderLoaded();
    await toolbarAction(/Duplicate versions/i);
    send({
      type: 'duplicateVersions',
      requestId: lastRequestId('requestDuplicates'),
      results: [
        {
          manifestPath: '/p/package.json',
          projectLabel: 'app',
          ecosystem: 'node',
          checked: true,
          groups: [],
        },
      ],
    });

    expect(
      screen.getByText(/No duplicate versions found/i),
    ).toBeInTheDocument();
  });
});

describe('license summary', () => {
  it('requests a check when the panel opens and shows what comes back', async () => {
    renderLoaded();
    await toolbarAction(/Licenses/i);
    expect(posted).toContainEqual({
      type: 'requestLicenses',
      requestId: expect.any(String),
    });

    send({
      type: 'licenseSummary',
      requestId: lastRequestId('requestLicenses'),
      summary: {
        groups: [{ license: 'MIT', packageNames: ['react'], flagged: false }],
      },
    });

    const panel = screen.getByRole('region', { name: /License summary/i });
    expect(within(panel).getByText('MIT')).toBeInTheDocument();
    expect(within(panel).getByText('react')).toBeInTheDocument();
  });

  it('does not re-check automatically when a new scan lands', async () => {
    // Unlike duplicate versions, this reaches the network per package, so a
    // rescan must not silently trigger a fresh round of registry calls.
    renderLoaded();
    await toolbarAction(/Licenses/i);
    const before = posted.length;

    send({ type: 'state', groups: [group()], summary: EMPTY_SUMMARY });

    expect(posted.length).toBe(before);
  });

  it('re-checks when Refresh is clicked', async () => {
    renderLoaded();
    await toolbarAction(/Licenses/i);
    // The Refresh button is disabled while a check is in flight, so the
    // first (loading) response has to land before it can be clicked again.
    send({
      type: 'licenseSummary',
      requestId: lastRequestId('requestLicenses'),
      summary: { groups: [] },
    });
    const before = posted.length;

    // Scoped to the panel: the main toolbar has its own "Refresh" button
    // with the same accessible name, for rescanning manifests instead.
    const panel = screen.getByRole('region', { name: /License summary/i });
    await userEvent.click(
      within(panel).getByRole('button', { name: /^Refresh$/i }),
    );

    expect(posted.length).toBeGreaterThan(before);
    expect(posted.at(-1)).toEqual({
      type: 'requestLicenses',
      requestId: expect.any(String),
    });
  });

  it('flags a license the policy denies', async () => {
    renderLoaded();
    await toolbarAction(/Licenses/i);
    send({
      type: 'licenseSummary',
      requestId: lastRequestId('requestLicenses'),
      summary: {
        groups: [
          { license: 'GPL-3.0', packageNames: ['copyleft-pkg'], flagged: true },
        ],
      },
    });

    expect(screen.getByText(/flagged/i)).toBeInTheDocument();
    expect(
      screen.getByText(/uses a license your policy flags/i),
    ).toBeInTheDocument();
  });
});

describe('export report', () => {
  it('asks the host to export when the toolbar button is clicked', async () => {
    renderLoaded();
    await toolbarAction(/Export report/i);
    expect(posted).toContainEqual({ type: 'exportReport' });
  });
});

describe('detail metadata', () => {
  it('merges into the open row without reordering the table', async () => {
    // A row that gains a size while sorted by Size must not jump out from
    // under the pointer of the user who just clicked it.
    renderLoaded();
    await userEvent.click(screen.getByText('react'));

    send({
      type: 'depDetails',
      depKey: 'react',
      meta: { name: 'react', sizeBytes: 1024 },
    });

    await waitFor(() => {
      expect(screen.getAllByText('1.0 KB').length).toBeGreaterThan(0);
    });
  });

  it('requests the changelog once a repository is known for an outdated package', async () => {
    // `group()`'s react has updateKind "major", so a repository is the only
    // missing ingredient.
    renderLoaded();
    await userEvent.click(screen.getByText('react'));

    send({
      type: 'depDetails',
      depKey: 'react',
      meta: { name: 'react', repository: 'https://github.com/facebook/react' },
    });

    expect(posted).toContainEqual({
      type: 'requestChangelog',
      depKey: 'react',
    });
  });

  it('does not request a changelog for a package with no update', async () => {
    renderLoaded([
      {
        ...group(),
        dependencies: [
          {
            ...group().dependencies[0],
            updateKind: 'none' as const,
            latest: undefined,
          },
        ],
      },
    ]);
    await showEveryPackage();
    await userEvent.click(screen.getByText('react'));

    send({
      type: 'depDetails',
      depKey: 'react',
      meta: { name: 'react', repository: 'https://github.com/facebook/react' },
    });

    expect(
      posted.filter(
        (m) => (m as { type?: string }).type === 'requestChangelog',
      ),
    ).toHaveLength(0);
  });
});

describe('dependency diff', () => {
  it('asks the host to compare when the toolbar button is clicked', async () => {
    renderLoaded();
    await toolbarAction(/Compare with/i);
    expect(posted).toContainEqual({
      type: 'requestDependencyDiff',
      requestId: expect.any(String),
    });
  });

  it('opens the panel once the host answers with a ref and results', async () => {
    renderLoaded();
    // The answer is correlated, so it has to answer a request that was made.
    await toolbarAction(/Compare with/i);
    send({
      type: 'dependencyDiff',
      requestId: lastRequestId('requestDependencyDiff'),
      ref: 'origin/main',
      results: [
        {
          manifestPath: '/p/package.json',
          projectLabel: 'app',
          ecosystem: 'node',
          checked: true,
          added: [{ name: 'left-pad', before: undefined, after: ['1.0.0'] }],
          removed: [],
          changed: [],
        },
      ],
    });

    expect(
      screen.getByText(/Comparing with origin\/main/i),
    ).toBeInTheDocument();
    expect(screen.getByText('left-pad')).toBeInTheDocument();
  });
});

describe('selection', () => {
  it('opens the drawer for the row the host asks to reveal', async () => {
    renderLoaded();
    send({ type: 'focusDependency', depKey: 'react', reveal: 'why' });

    await waitFor(() => {
      expect(
        screen.getByRole('complementary', { name: /Details for react/i }),
      ).toBeInTheDocument();
    });
    // Opening the drawer asks the host for the data it cannot compute itself.
    expect(posted).toContainEqual({ type: 'requestWhy', depKey: 'react' });
  });

  it('opens the search panel when the host asks for it', async () => {
    renderLoaded();
    send({ type: 'focusSearch' });

    await waitFor(() => {
      expect(
        screen.getByRole('searchbox', { name: /Search registries/i }),
      ).toBeInTheDocument();
    });
  });
});

describe('filtering', () => {
  it('narrows the table by name', async () => {
    renderLoaded([
      {
        ...group(),
        dependencies: [
          ...group().dependencies,
          {
            ...group().dependencies[0],
            key: 'lodash',
            name: 'lodash',
          },
        ],
      },
    ]);

    await userEvent.type(
      screen.getByRole('searchbox', { name: /Filter installed packages/i }),
      'loda',
    );

    await waitFor(() => {
      expect(screen.queryByText('react')).toBeNull();
    });
    expect(screen.getByText('lodash')).toBeInTheDocument();
  });

  it('opens showing only what is outdated', async () => {
    renderLoaded([
      {
        ...group(),
        dependencies: [
          ...group().dependencies,
          {
            ...group().dependencies[0],
            key: 'lodash',
            name: 'lodash',
            latest: undefined,
            updateKind: 'none' as const,
          },
        ],
      },
    ]);

    // react has a 19.0.0 waiting; lodash is current, so it starts hidden.
    expect(screen.getByRole('button', { name: /^outdated/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('react')).toBeInTheDocument();
    expect(screen.queryByText('lodash')).toBeNull();

    // And the chip is the way back to the full list.
    await showEveryPackage();
    expect(screen.getByText('lodash')).toBeInTheDocument();
  });
});

/*
 * Bulk actions used to post one message per selected package. The host handles
 * messages concurrently, so N messages meant N modal confirmations and N
 * commands racing on one terminal — the whole selection travels as one message
 * precisely so the host can confirm once and run them in order.
 */
describe('bulk actions', () => {
  function twoOutdated(): ProjectGroup {
    const base = group().dependencies[0];
    return {
      ...group(),
      dependencies: [
        base,
        { ...base, key: 'lodash', name: 'lodash', latest: '5.0.0' },
      ],
    };
  }

  async function selectAll() {
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Select all/i }),
    );
  }

  it('posts one bulkUpdate carrying every selected package', async () => {
    renderLoaded([twoOutdated()]);
    await selectAll();

    await userEvent.click(
      screen.getByRole('button', { name: /Update Selected/i }),
    );

    const bulk = posted.filter(
      (message): message is { type: string; targets: unknown[] } =>
        (message as { type?: string }).type === 'bulkUpdate',
    );
    expect(bulk).toHaveLength(1);
    expect(bulk[0].targets).toEqual([
      { depKey: 'react', toVersion: '19.0.0' },
      { depKey: 'lodash', toVersion: '5.0.0' },
    ]);
    // The per-package message is what raced; it must not be sent as well.
    expect(
      posted.filter((m) => (m as { type?: string }).type === 'update'),
    ).toHaveLength(0);
  });

  it('posts one bulkUninstall carrying every selected package', async () => {
    renderLoaded([twoOutdated()]);
    await selectAll();

    await userEvent.click(
      screen.getByRole('button', { name: /Remove Selected/i }),
    );

    const bulk = posted.filter(
      (message): message is { type: string; depKeys: string[] } =>
        (message as { type?: string }).type === 'bulkUninstall',
    );
    expect(bulk).toHaveLength(1);
    expect(bulk[0].depKeys.sort()).toEqual(['lodash', 'react']);
    expect(
      posted.filter((m) => (m as { type?: string }).type === 'uninstall'),
    ).toHaveLength(0);
  });

  it('says nothing when the selection has no upgrade to apply', async () => {
    // Selected, but already current: there is no version to update to, so the
    // host should not be asked to confirm an empty batch.
    const current = group().dependencies[0];
    renderLoaded([
      {
        ...group(),
        dependencies: [
          { ...current, latest: undefined, updateKind: 'none' as const },
        ],
      },
    ]);
    await showEveryPackage();
    await selectAll();

    await userEvent.click(
      screen.getByRole('button', { name: /Update Selected/i }),
    );

    expect(
      posted.filter((m) => (m as { type?: string }).type === 'bulkUpdate'),
    ).toHaveLength(0);
  });
});

/*
 * The toolbar's count is the whole workspace's, so its action has to be too.
 * It used to pass `groups[0]` regardless, updating one project while the label
 * promised all of them.
 */
describe('global update all', () => {
  const outdatedSummary = {
    ...EMPTY_SUMMARY,
    totalDependencies: 2,
    outdated: 2,
  };

  function renderProjects(groups: ProjectGroup[]) {
    const result = render(<App />);
    send({ type: 'state', groups, summary: outdatedSummary });
    return result;
  }

  it('names the only project when there is just one', async () => {
    renderProjects([group()]);
    // The toolbar's button carries the workspace-wide count; the per-group
    // headers render an "Update all" of their own, which this must not match.
    await userEvent.click(
      screen.getByRole('button', { name: /Update All \(/ }),
    );

    expect(posted).toContainEqual({
      type: 'updateAll',
      manifestPath: '/p/package.json',
    });
  });

  it('names no project when there are several, so the host asks', async () => {
    renderProjects([
      group(),
      { ...group(), label: 'api', manifestPath: '/q/package.json' },
    ]);
    // The toolbar's button carries the workspace-wide count; the per-group
    // headers render an "Update all" of their own, which this must not match.
    await userEvent.click(
      screen.getByRole('button', { name: /Update All \(/ }),
    );

    const updateAll = posted.filter(
      (message): message is { type: string; manifestPath?: string } =>
        (message as { type?: string }).type === 'updateAll',
    );
    expect(updateAll).toHaveLength(1);
    expect(updateAll[0].manifestPath).toBeUndefined();
  });
});

/*
 * Selection has to survive filtering, and not survive a package disappearing.
 *
 * The bulk toolbar's accessible name carries the count, so these assert on
 * that rather than on body text — "Selected 2" and "Update Selected" both
 * contain the word.
 */
describe('selection bookkeeping', () => {
  function twoPackages(): ProjectGroup {
    const base = group().dependencies[0];
    return {
      ...group(),
      dependencies: [base, { ...base, key: 'lodash', name: 'lodash' }],
    };
  }

  /** The select-all box, whose label changes when a filter is applied. */
  function selectAllBox(): HTMLInputElement {
    return screen.getByRole('checkbox', {
      name: /Select all/i,
    }) as HTMLInputElement;
  }

  /** The per-row boxes, i.e. every checkbox that is not the header's. */
  function rowBoxes(): HTMLElement[] {
    const header = selectAllBox();
    return screen.getAllByRole('checkbox').filter((box) => box !== header);
  }

  function selectedCount(): number {
    const bar = screen.queryByRole('toolbar', { name: /Actions for/i });
    if (!bar) return 0;
    const label = bar.getAttribute('aria-label') ?? '';
    return Number(/Actions for (\d+)/.exec(label)?.[1] ?? 0);
  }

  /** The checkbox belonging to a named package's row. */
  function boxForRow(name: string): HTMLElement {
    const row = screen.getByText(name).closest('[role="row"]');
    if (!row) throw new Error(`no row for ${name}`);
    return within(row as HTMLElement).getByRole('checkbox');
  }

  it('keeps selections the filter is hiding when select-all is used', async () => {
    renderLoaded([twoPackages()]);

    // Select react specifically — it is the row the filter below will hide.
    await userEvent.click(boxForRow('react'));
    expect(selectedCount()).toBe(1);

    // Narrow to the other package, then select all of what is showing.
    await userEvent.type(
      screen.getByRole('searchbox', { name: /Filter installed packages/i }),
      'loda',
    );
    await waitFor(() => expect(screen.queryByText('react')).toBeNull());
    await userEvent.click(selectAllBox());

    // Both: replacing the set would have discarded the hidden row.
    await waitFor(() => expect(selectedCount()).toBe(2));
  });

  it('renames the select-all box when a filter is narrowing the list', async () => {
    renderLoaded([twoPackages()]);
    await showEveryPackage();
    expect(
      screen.getByRole('checkbox', { name: /Select all dependencies/i }),
    ).toBeInTheDocument();

    await userEvent.type(
      screen.getByRole('searchbox', { name: /Filter installed packages/i }),
      'loda',
    );

    await waitFor(() => {
      expect(
        screen.getByRole('checkbox', { name: /Select all matching/i }),
      ).toBeInTheDocument();
    });
  });

  it('drops selected rows a new scan no longer contains', async () => {
    renderLoaded([twoPackages()]);
    await userEvent.click(selectAllBox());
    expect(selectedCount()).toBe(2);

    // lodash has been uninstalled; its key now names nothing.
    send({
      type: 'state',
      groups: [group()],
      summary: { ...EMPTY_SUMMARY, totalDependencies: 1 },
    });

    await waitFor(() => expect(selectedCount()).toBe(1));
  });

  it('marks the select-all box indeterminate on a partial selection', async () => {
    renderLoaded([twoPackages()]);
    expect(selectAllBox().indeterminate).toBe(false);

    const boxes = rowBoxes();
    await userEvent.click(boxes[0]);

    // Neither all nor none, and the box has to say so rather than rendering
    // identically to an empty selection.
    await waitFor(() => expect(selectAllBox().indeterminate).toBe(true));
    expect(selectAllBox().checked).toBe(false);

    await userEvent.click(boxes[1]);
    await waitFor(() => expect(selectAllBox().indeterminate).toBe(false));
    expect(selectAllBox().checked).toBe(true);
  });
});

/*
 * One overlay panel at a time.
 *
 * Search, duplicates, licenses and the dependency diff were four independent
 * booleans rendered as four siblings above the table, each capped at 45vh.
 * Nothing closed one when another opened, so all four could be on screen at
 * once and push the table out of view entirely. They are now a single
 * `activePanel` value, which is also what makes the toolbar's aria-expanded
 * states mutually exclusive rather than separately maintained.
 */
describe('panel exclusivity', () => {
  const PANELS = {
    search: /Package search/i,
    duplicates: /Duplicate package versions/i,
    licenses: /License summary/i,
    diff: /Dependency changes/i,
  };

  /** Which overlay panels are currently on screen. */
  function openPanels(): string[] {
    return Object.entries(PANELS)
      .filter(([, name]) => screen.queryByRole('region', { name }) !== null)
      .map(([id]) => id);
  }

  const open = {
    // The toggle relabels itself once the panel is open, so match either word.
    search: () =>
      userEvent.click(
        screen.getByRole('button', { name: /Add package|Close search/i }),
      ),
    duplicates: () => toolbarAction(/Duplicate versions/i),
    licenses: () => toolbarAction(/Licenses/i),
    /**
     * Asks for a diff and delivers the answer to it.
     *
     * The panel opens on the result rather than on the click — the ref picker
     * is native, not webview UI — and the result is now correlated, so it has
     * to quote the id the request carried.
     */
    diff: async (results: ProjectDependencyDiff[] = []) => {
      await toolbarAction(/Compare with/i);
      send({
        type: 'dependencyDiff',
        requestId: lastRequestId('requestDependencyDiff'),
        ref: 'origin/main',
        results,
      });
    },
  };

  it('opens each panel on its own', async () => {
    renderLoaded();

    await open.duplicates();
    expect(openPanels()).toEqual(['duplicates']);
  });

  it('closes the duplicates panel when licenses opens', async () => {
    renderLoaded();

    await open.duplicates();
    await open.licenses();

    expect(openPanels()).toEqual(['licenses']);
  });

  it('closes the licenses panel when search opens', async () => {
    renderLoaded();

    await open.licenses();
    await open.search();

    expect(openPanels()).toEqual(['search']);
  });

  it('closes an open panel when a diff result arrives', async () => {
    renderLoaded();

    await open.search();
    await open.diff();

    expect(openPanels()).toEqual(['diff']);
  });

  it('never leaves more than one panel on screen', async () => {
    renderLoaded();

    await open.search();
    await open.duplicates();
    await open.licenses();
    await open.diff();

    // Four panels at up to 45vh each is 180vh of overlay above a table that
    // has nowhere left to render.
    expect(openPanels()).toHaveLength(1);
  });

  /**
   * Runs a real search and resolves once the host has been asked, so the
   * cancellation tests below have something in flight to cancel.
   */
  async function startSearch() {
    await open.search();
    await userEvent.type(
      screen.getByRole('searchbox', { name: /Search registries/i }),
      'left-pad',
    );
    await waitFor(() =>
      expect(
        posted.some((m) => (m as { type?: string }).type === 'search'),
      ).toBe(true),
    );
  }

  function cancelled(): boolean {
    return posted.some((m) => (m as { type?: string }).type === 'cancelSearch');
  }

  it('cancels an in-flight search when the panel is closed', async () => {
    renderLoaded();
    await startSearch();
    expect(cancelled()).toBe(false);

    await open.search(); // the toggle closes it again
    await waitFor(() => expect(cancelled()).toBe(true));
  });

  it('cancels an in-flight search when another panel replaces it', async () => {
    renderLoaded();
    await startSearch();
    expect(cancelled()).toBe(false);

    // Search is no longer the open panel, so its request has to be dropped —
    // otherwise the result lands in a panel nobody is looking at.
    await open.licenses();
    await waitFor(() => expect(cancelled()).toBe(true));
    expect(openPanels()).toEqual(['licenses']);
  });

  it('re-checks duplicates on a rescan, but only while it is the open panel', async () => {
    renderLoaded();
    await open.duplicates();
    const afterOpen = posted.length;

    send({ type: 'state', groups: [group()], summary: EMPTY_SUMMARY });
    expect(posted.at(-1)).toEqual({
      type: 'requestDuplicates',
      requestId: expect.any(String),
    });

    // Switching away must stop the rescan hook firing for a closed panel.
    await open.licenses();
    const afterSwitch = posted.length;
    send({ type: 'state', groups: [group()], summary: EMPTY_SUMMARY });
    expect(
      posted
        .slice(afterSwitch)
        .some((m) => (m as { type?: string }).type === 'requestDuplicates'),
    ).toBe(false);
    expect(afterOpen).toBeLessThan(posted.length);
  });

  it('does not refetch licenses on a rescan', async () => {
    renderLoaded();
    await open.licenses();
    const after = posted.length;

    // Deliberately unlike duplicates: this one reaches the network per
    // package, so only the panel's own Refresh re-runs it.
    send({ type: 'state', groups: [group()], summary: EMPTY_SUMMARY });
    expect(
      posted
        .slice(after)
        .some((m) => (m as { type?: string }).type === 'requestLicenses'),
    ).toBe(false);
  });

  it('reports the expanded state of the compare action', async () => {
    renderLoaded();
    const toggleMore = () =>
      userEvent.click(screen.getByRole('button', { name: /^More$/i }));

    // It moved into the overflow menu, but it still has to say whether its
    // panel is open — which is the thing it never did as a bare button.
    await toggleMore();
    expect(
      screen.getByRole('menuitem', { name: /Compare with/i }),
    ).toHaveAttribute('aria-expanded', 'false');
    await toggleMore();

    await open.diff();

    await toggleMore();
    expect(
      screen.getByRole('menuitem', { name: /Compare with/i }),
    ).toHaveAttribute('aria-expanded', 'true');
  });
});
