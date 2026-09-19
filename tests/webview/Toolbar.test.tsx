/**
 * The toolbar: filters, the summary line, and its keyboard contract.
 */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ScanSummary } from '../../src/core/types.js';
import { type Filters, Toolbar } from '../../src/webview/Toolbar.js';

const ALL: Filters = {
  text: '',
  scopes: new Set(['prod', 'dev', 'build', 'peer', 'optional']),
  onlyOutdated: false,
  onlyVulnerable: false,
  onlyDeprecated: false,
};

const SUMMARY: ScanSummary = {
  totalDependencies: 12,
  outdated: 3,
  vulnerable: 1,
  deprecated: 2,
  stale: false,
};

function renderToolbar(overrides: Partial<Parameters<typeof Toolbar>[0]> = {}) {
  const props = {
    filters: ALL,
    onFiltersChange: vi.fn(),
    summary: SUMMARY,
    busy: false,
    busyLabel: undefined,
    activePanel: null,
    onToggleInstall: vi.fn(),
    onRefresh: vi.fn(),
    onCheckUpdates: vi.fn(),
    ...overrides,
  };
  return { ...render(<Toolbar {...props} />), props };
}

describe('filters', () => {
  it('toggles a scope without disturbing the others', async () => {
    const onFiltersChange = vi.fn();
    renderToolbar({ onFiltersChange });

    await userEvent.click(screen.getByRole('button', { name: 'dev' }));

    const next = onFiltersChange.mock.calls[0][0] as Filters;
    expect(next.scopes.has('dev')).toBe(false);
    expect(next.scopes.has('prod')).toBe(true);
  });

  it('reports the state of each chip through aria-pressed', () => {
    renderToolbar({ filters: { ...ALL, onlyOutdated: true } });

    expect(screen.getByRole('button', { name: /^outdated/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /^vulnerable/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('separates the two chip families, which pull in opposite directions', () => {
    renderToolbar();

    // Named by their legends, so the grouping is available to a screen reader
    // and not only to the eye.
    expect(screen.getByRole('group', { name: 'Scope' })).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Show only' }),
    ).toBeInTheDocument();

    // And each chip lands in the group it belongs to.
    const scope = screen.getByRole('group', { name: 'Scope' });
    expect(within(scope).getByRole('button', { name: 'dev' })).toBeVisible();
    expect(
      within(scope).queryByRole('button', { name: /^outdated/ }),
    ).toBeNull();
  });
});

describe('the summary line', () => {
  it('keeps the workspace total, and only that', () => {
    renderToolbar();
    const status = screen.getByRole('status');

    // The outdated/vulnerable/deprecated counts moved onto the filter chips
    // they used to sit beside as identical-looking but inert pills.
    expect(status).toHaveTextContent('12 packages');
    expect(status).not.toHaveTextContent('outdated');
    expect(status).not.toHaveTextContent('vulnerable');
  });

  it('carries each count on the chip that filters by it', () => {
    const { rerender, props } = renderToolbar();

    // One element per concept: the chip states the count and toggles the
    // filter, rather than a span stating it beside a button that does.
    expect(
      screen.getByRole('button', { name: 'outdated, 3 packages' }),
    ).toHaveTextContent('3');
    expect(
      screen.getByRole('button', { name: 'vulnerable, 1 package' }),
    ).toBeInTheDocument();

    rerender(
      <Toolbar
        {...props}
        summary={{ ...SUMMARY, outdated: 0, vulnerable: 0, deprecated: 0 }}
      />,
    );

    // At zero the chip stays — it is still a filter — but says nothing more.
    const chip = screen.getByRole('button', { name: 'outdated' });
    expect(chip).toBeInTheDocument();
    expect(chip).not.toHaveTextContent('0');
  });

  it('says when the data came from cache', () => {
    renderToolbar({ summary: { ...SUMMARY, stale: true } });
    expect(screen.getByRole('status')).toHaveTextContent('cached');
  });
});

describe('actions', () => {
  it('distinguishes re-reading from disk from querying registries', async () => {
    const onRefresh = vi.fn();
    const onCheckUpdates = vi.fn();
    renderToolbar({ onRefresh, onCheckUpdates });

    await userEvent.click(
      screen.getByRole('button', { name: /Check updates/i }),
    );
    expect(onCheckUpdates).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^Refresh/i }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('disables the scan actions while one is running', () => {
    renderToolbar({ busy: true });
    expect(
      screen.getByRole('button', { name: /Check updates/i }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Refresh/i })).toBeDisabled();
  });

  it('exposes the search panel toggle as an expander', () => {
    const { rerender, props } = renderToolbar();
    const toggle = screen.getByRole('button', { name: /Add package/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'orizzonte-search-panel');

    rerender(<Toolbar {...props} activePanel="search" />);
    expect(
      screen.getByRole('button', { name: /Close search/i }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('expands exactly the action whose panel is open', async () => {
    const { rerender, props } = renderToolbar({
      onToggleDuplicates: vi.fn(),
      onToggleLicenses: vi.fn(),
      onCompareDependencies: vi.fn(),
    });

    // The three panel actions live behind the overflow button now; the menu
    // still has to say which of their panels is open.
    await userEvent.click(screen.getByRole('button', { name: /^More$/i }));

    const expanded = () =>
      screen
        .getAllByRole('menuitem')
        .filter((item) => item.getAttribute('aria-expanded') === 'true')
        .map((item) => item.textContent?.trim());

    expect(expanded()).toEqual([]);

    // Each panel id lights its own action and no other — which is the point of
    // taking one `activePanel` rather than a flag per panel.
    rerender(<Toolbar {...props} activePanel="duplicates" />);
    expect(expanded()).toEqual(['Duplicate versions']);

    rerender(<Toolbar {...props} activePanel="licenses" />);
    expect(expanded()).toEqual(['Licenses']);

    rerender(<Toolbar {...props} activePanel="diff" />);
    expect(expanded()).toEqual(['Compare with…']);
  });

  it('announces progress as a progressbar rather than a bare div', () => {
    renderToolbar({ busy: true, busyLabel: 'Checking registries…' });
    // The label names the progressbar rather than joining the summary's live
    // region, so progress is announced once and as progress.
    expect(screen.getByRole('progressbar')).toHaveAccessibleName(
      'Checking registries…',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(
      'Checking registries',
    );
  });

  it('keeps the busy label visible even though it is not announced twice', () => {
    renderToolbar({ busy: true, busyLabel: 'Checking registries…' });
    expect(screen.getByText('Checking registries…')).toBeInTheDocument();
  });
});

describe('keyboard navigation', () => {
  /** Every button the roving tabindex covers, in DOM order. */
  const toolbarButtons = () =>
    [
      ...screen.getByRole('toolbar').querySelectorAll('button'),
    ] as HTMLElement[];

  it('moves between controls with arrow keys, as role=toolbar implies', async () => {
    // A toolbar is one tab stop; arrows move within it. Declaring the role
    // without implementing that leaves a promise the widget does not keep.
    renderToolbar();

    const chips = screen.getAllByRole('button', { name: /prod|dev|build/ });
    // Focusing a toolbar button moves the tab stop, which is a state update.
    await act(async () => chips[0].focus());
    expect(document.activeElement).toBe(chips[0]);

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chips[1]);

    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(chips[0]);
  });

  it('is a single tab stop — the other half of the same promise', () => {
    renderToolbar();

    const tabbable = toolbarButtons().filter((button) => button.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(toolbarButtons().length).toBeGreaterThan(1);
  });

  it('moves the tab stop along with the arrow keys', async () => {
    renderToolbar();

    const buttons = toolbarButtons();
    await act(async () => buttons[0].focus());
    await userEvent.keyboard('{ArrowRight}');

    expect(toolbarButtons().filter((b) => b.tabIndex === 0)).toEqual([
      buttons[1],
    ]);
    expect(buttons[0].tabIndex).toBe(-1);
  });

  it('adopts a button that is focused directly, so re-entry returns there', async () => {
    renderToolbar();

    const refresh = screen.getByRole('button', { name: /^Refresh/i });
    // Wrapped so the render the focus handler schedules has flushed before the
    // assertion reads tabIndex back out of the DOM.
    await act(async () => refresh.focus());

    expect(refresh.tabIndex).toBe(0);
    expect(toolbarButtons().filter((b) => b.tabIndex === 0)).toEqual([refresh]);
  });
});

describe('the overflow menu', () => {
  function renderWithOverflow(
    overrides: Partial<Parameters<typeof Toolbar>[0]> = {},
  ) {
    return renderToolbar({
      onToggleDuplicates: vi.fn(),
      onToggleLicenses: vi.fn(),
      onCompareDependencies: vi.fn(),
      onExportReport: vi.fn(),
      ...overrides,
    });
  }

  const more = () => screen.getByRole('button', { name: /^More$/i });
  const openMenu = () => userEvent.click(more());

  it('keeps the everyday actions inline and the occasional ones behind it', async () => {
    renderWithOverflow();

    // Inline: what gets used every session.
    for (const name of [/Add package/i, /Check updates/i, /^Refresh/i]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    // Not inline until the menu is opened.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Duplicate versions/i }),
    ).toBeNull();

    await openMenu();
    expect(
      screen.getAllByRole('menuitem').map((i) => i.textContent?.trim()),
    ).toEqual([
      'Duplicate versions',
      'Licenses',
      'Compare with…',
      'Export report',
    ]);
  });

  it('reports its own state and puts the caret on the first item', async () => {
    renderWithOverflow();
    expect(more()).toHaveAttribute('aria-expanded', 'false');
    expect(more()).toHaveAttribute('aria-haspopup', 'menu');

    await openMenu();
    expect(more()).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
  });

  it('moves between items with the arrow keys, and wraps', async () => {
    renderWithOverflow();
    await openMenu();
    const items = screen.getAllByRole('menuitem');

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);

    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(items[0]);

    // Up from the first item lands on the last, as a menu does.
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(items[items.length - 1]);

    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('closes on Escape and hands focus back to the button that opened it', async () => {
    renderWithOverflow();
    await openMenu();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it('runs the action it was opened for, then closes', async () => {
    const onToggleLicenses = vi.fn();
    renderWithOverflow({ onToggleLicenses });
    await openMenu();

    await userEvent.click(screen.getByRole('menuitem', { name: /Licenses/i }));

    expect(onToggleLicenses).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it('blocks Export report while a scan is running, per the busy rule', async () => {
    renderWithOverflow({ busy: true });
    await openMenu();

    // Writes a file from the findings, so a scan in flight blocks it — while
    // the read-only panels beside it stay reachable.
    expect(
      screen.getByRole('menuitem', { name: /Export report/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('menuitem', { name: /Duplicate versions/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole('menuitem', { name: /Compare with/i }),
    ).toBeEnabled();
  });

  it('keeps its items out of the toolbar’s roving tabindex', async () => {
    renderWithOverflow();
    await openMenu();

    // The toolbar hands its single tab stop around its own buttons; the menu
    // runs Up/Down over its items instead, so they must not be swept into it.
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item).toHaveAttribute('data-menu-item');
    }
    const roving = [
      ...screen.getByRole('toolbar').querySelectorAll('button'),
    ].filter((b) => !b.hasAttribute('data-menu-item'));
    expect(roving.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });
});
