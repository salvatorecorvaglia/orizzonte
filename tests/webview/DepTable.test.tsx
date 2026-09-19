/**
 * The dependency table: sorting, the ARIA grid contract, and the per-row
 * actions.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  Dependency,
  ProjectGroup,
  Vulnerability,
} from '../../src/core/types.js';
import { DepTable, type SortState } from '../../src/webview/DepTable.js';

function dep(overrides: Partial<Dependency> = {}): Dependency {
  return {
    key: overrides.name ?? 'k',
    name: 'pkg',
    ecosystem: 'node',
    scope: 'prod',
    declared: '^1.0.0',
    installed: '1.0.0',
    updateKind: 'none',
    vulnerabilities: [],
    manifestPath: '/p/package.json',
    projectLabel: 'app',
    ...overrides,
  };
}

function vuln(overrides: Partial<Vulnerability> = {}): Vulnerability {
  return {
    id: 'GHSA-1',
    summary: 's',
    severity: 'high',
    aliases: [],
    url: 'https://osv.dev/x',
    ...overrides,
  };
}

function group(dependencies: Dependency[]): ProjectGroup {
  return {
    label: 'app',
    manifestPath: '/p/package.json',
    ecosystem: 'node',
    toolchain: 'npm',
    dependencies,
  };
}

const noop = () => {};

function renderTable(
  groups: ProjectGroup[],
  sort: SortState = { key: 'name', direction: 'asc' },
  overrides: Partial<Parameters<typeof DepTable>[0]> = {},
) {
  return render(
    <DepTable
      groups={groups}
      sort={sort}
      onSortChange={noop}
      selectedKey={undefined}
      onSelect={noop}
      onUpdate={noop}
      onUninstall={noop}
      onUpdateAll={noop}
      loading={false}
      filtering={false}
      onClearFilters={noop}
      {...overrides}
    />,
  );
}

/**
 * Row names in render order.
 *
 * Read from the row's accessible name rather than the name cell's text, which
 * also carries the vulnerability and deprecation glyphs.
 */
function renderedNames(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1) // the header
    .map(
      (row) =>
        within(row)
          .getAllByRole('gridcell')[0]
          .querySelector('[data-package-name]')?.textContent ?? '',
    );
}

describe('sorting', () => {
  it('orders versions by the ecosystem scheme, not lexically', () => {
    // Collation would put 1.10.0 before 1.9.0 only by luck, and would rank a
    // release candidate above its own release.
    renderTable(
      [
        group([
          dep({ name: 'a', key: 'a', latest: '1.9.0' }),
          dep({ name: 'b', key: 'b', latest: '1.10.0' }),
          dep({ name: 'c', key: 'c', latest: '1.10.0-rc1' }),
        ]),
      ],
      { key: 'latest', direction: 'asc' },
    );

    expect(renderedNames()).toEqual(['a', 'c', 'b']);
  });

  it('respects Maven ordering, where SNAPSHOT precedes its release', () => {
    renderTable(
      [
        {
          ...group([
            dep({
              name: 'x',
              key: 'x',
              ecosystem: 'maven',
              latest: '1.0',
            }),
            dep({
              name: 'y',
              key: 'y',
              ecosystem: 'maven',
              latest: '1.0-SNAPSHOT',
            }),
          ]),
          ecosystem: 'maven',
        },
      ],
      { key: 'latest', direction: 'asc' },
    );

    expect(renderedNames()).toEqual(['y', 'x']);
  });

  it('sorts missing versions last regardless of direction', () => {
    renderTable(
      [
        group([
          dep({ name: 'a', key: 'a', latest: undefined }),
          dep({ name: 'b', key: 'b', latest: '1.0.0' }),
        ]),
      ],
      { key: 'latest', direction: 'asc' },
    );

    expect(renderedNames()).toEqual(['b', 'a']);
  });

  it('reverses on a descending sort', () => {
    renderTable(
      [
        group([
          dep({ name: 'a', key: 'a' }),
          dep({ name: 'b', key: 'b' }),
          dep({ name: 'c', key: 'c' }),
        ]),
      ],
      { key: 'name', direction: 'desc' },
    );

    expect(renderedNames()).toEqual(['c', 'b', 'a']);
  });

  it('ranks problems above merely outdated packages', () => {
    renderTable(
      [
        group([
          dep({ name: 'current', key: '1', updateKind: 'none' }),
          dep({ name: 'patch', key: '2', updateKind: 'patch' }),
          dep({
            name: 'vulnerable',
            key: '3',
            updateKind: 'none',
            vulnerabilities: [vuln()],
          }),
          dep({
            name: 'deprecated',
            key: '4',
            meta: { name: 'deprecated', deprecated: 'gone' },
          }),
        ]),
      ],
      { key: 'status', direction: 'asc' },
    );

    expect(renderedNames()).toEqual([
      'vulnerable',
      'deprecated',
      'patch',
      'current',
    ]);
  });

  it('sorts unknown sizes last in ascending order, matching the version columns', () => {
    renderTable(
      [
        group([
          dep({ name: 'small', key: 's', meta: { name: 's', sizeBytes: 100 } }),
          dep({ name: 'unknown', key: 'u' }),
          dep({ name: 'large', key: 'l', meta: { name: 'l', sizeBytes: 900 } }),
        ]),
      ],
      { key: 'size', direction: 'asc' },
    );

    expect(renderedNames()).toEqual(['small', 'large', 'unknown']);
  });
});

describe('the ARIA grid contract', () => {
  it('keeps rows inside the grid', () => {
    /*
     * A regression guard, not a conformance check: testing-library resolves
     * roles by attribute and does not enforce ARIA's required-owned-element
     * rules, so it would not notice the positioning wrappers on its own. Real
     * assistive technology does, which is why those wrappers carry
     * role="presentation" — asserted separately below.
     */
    renderTable([group([dep({ name: 'react', key: 'react' })])]);

    const grid = screen.getByRole('grid');
    expect(within(grid).getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('marks the virtualizer’s positioning wrappers as presentational', () => {
    // Without this the grid owns two levels of generic div before reaching a
    // row, which breaks the grid/row relationship for screen readers.
    const { container } = renderTable([
      group([dep({ name: 'react', key: 'react' })]),
    ]);

    const row = container.querySelector('[data-row-index]');
    expect(row).not.toBeNull();

    // Every element between the row and the rowgroup must be presentational.
    let node = row?.parentElement;
    const rowgroup = container.querySelector('[role="rowgroup"]');
    while (node && node !== rowgroup) {
      expect(node).toHaveAttribute('role', 'presentation');
      node = node.parentElement;
    }
    expect(node).toBe(rowgroup);
  });

  it('reports the true row count even though only a window is mounted', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      dep({ name: `pkg${i}`, key: `k${i}` }),
    );
    renderTable([group(many)]);

    // 500 rows plus the header.
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '501');
    expect(screen.getAllByRole('row').length).toBeLessThan(501);
  });

  it('marks the sorted column and leaves the others as none', async () => {
    const onSortChange = vi.fn();
    renderTable(
      [group([dep()])],
      { key: 'name', direction: 'asc' },
      {
        onSortChange,
      },
    );

    expect(
      screen.getByRole('columnheader', { name: /Package/ }),
    ).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('columnheader', { name: /Scope/ })).toHaveAttribute(
      'aria-sort',
      'none',
    );

    await userEvent.click(screen.getByRole('button', { name: /Package/ }));
    expect(onSortChange).toHaveBeenCalledWith({
      key: 'name',
      direction: 'desc',
    });
  });

  it('leaves the sort direction to aria-sort rather than the button name', () => {
    // The direction used to be a text arrow inside the label, so the accessible
    // name read "Package ↑" — the same fact aria-sort already carries, in a
    // form nobody chose to hear.
    renderTable([group([dep()])], { key: 'name', direction: 'desc' });

    const header = screen.getByRole('columnheader', { name: /Package/ });
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(within(header).getByRole('button').textContent?.trim()).toBe(
      'Package',
    );
  });
});

describe('severity markers', () => {
  it('names the icons, which are the only signal in their cell', () => {
    // They are icons, not text: without a name a screen reader reaches a row
    // that looks identical to a healthy one.
    renderTable([
      group([
        dep({ name: 'vulnerable-pkg', key: 'v', vulnerabilities: [vuln()] }),
        dep({
          name: 'old-pkg',
          key: 'd',
          meta: { name: 'old-pkg', deprecated: 'Use something else' },
        }),
      ]),
    ]);

    expect(screen.getByRole('img', { name: 'Vulnerable' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Deprecated' })).toBeInTheDocument();
  });

  it('shows no marker on a healthy package', () => {
    renderTable([group([dep({ name: 'fine', key: 'f' })])]);
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('metaVersions', () => {
  /*
   * Regression test for a stale-render bug: App.tsx merges lazily fetched
   * metadata by mutating `dep.meta` in place (to avoid re-sorting the table),
   * which means `dep`'s object identity never changes. DepRow is wrapped in
   * `React.memo`, so without some other prop that actually changes value, the
   * row would silently keep rendering its old (pre-fetch) content forever.
   * `metaVersions` is that prop.
   */
  it('re-renders a row after its mutated-in-place meta gains a size', () => {
    const groups = [group([dep({ name: 'pkg', key: 'k' })])];
    const { rerender } = renderTable(groups, undefined, {
      metaVersions: { k: 0 },
    });

    const sizeCellBefore = screen
      .getAllByRole('gridcell')
      .find((cell) => cell.className.includes('cell--size'));
    expect(sizeCellBefore?.textContent).toBe('—');

    // Simulate App.tsx's in-place merge: same `dep`/`groups` object identity,
    // only the `meta` field and the row's version counter change.
    groups[0].dependencies[0].meta = { name: 'pkg', sizeBytes: 2048 };

    rerender(
      <DepTable
        groups={groups}
        sort={{ key: 'name', direction: 'asc' }}
        onSortChange={noop}
        selectedKey={undefined}
        onSelect={noop}
        onUpdate={noop}
        onUninstall={noop}
        onUpdateAll={noop}
        loading={false}
        filtering={false}
        onClearFilters={noop}
        metaVersions={{ k: 1 }}
      />,
    );

    const sizeCellAfter = screen
      .getAllByRole('gridcell')
      .find((cell) => cell.className.includes('cell--size'));
    expect(sizeCellAfter?.textContent).toBe('2.0 KB');
  });
});

describe('row actions', () => {
  it('names each action with its package, so they are distinguishable', () => {
    // Twenty buttons all called "Remove" are unusable with a screen reader.
    renderTable([
      group([
        dep({
          name: 'react',
          key: 'react',
          updateKind: 'minor',
          latest: '2.0.0',
        }),
        dep({ name: 'lodash', key: 'lodash' }),
      ]),
    ]);

    expect(
      screen.getByRole('button', { name: /Remove react/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Remove lodash/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Update react to 2\.0\.0/i }),
    ).toBeInTheDocument();
  });

  it('offers update only where an update exists', () => {
    renderTable([
      group([dep({ name: 'current', key: 'c', updateKind: 'none' })]),
    ]);

    expect(screen.queryByRole('button', { name: /Update/i })).toBeNull();
    expect(
      screen.getByRole('button', { name: /Remove current/i }),
    ).toBeInTheDocument();
  });

  /*
   * The busy rule belongs to the whole panel, not to the toolbar that states
   * it. Enforced there alone, a scan greyed out Update All while every row's
   * own Update stayed live — the same action offered as both blocked and
   * available on one screen.
   */
  it('blocks the row writes while a scan or write is in flight', () => {
    renderTable(
      [
        group([
          dep({
            name: 'react',
            key: 'react',
            updateKind: 'minor',
            latest: '2.0.0',
          }),
        ]),
      ],
      undefined,
      { busy: true },
    );

    expect(
      screen.getByRole('button', { name: /Update react to 2\.0\.0/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /Remove react/i }),
    ).toBeDisabled();
  });

  it('leaves the row writes available when nothing is in flight', () => {
    renderTable([
      group([
        dep({
          name: 'react',
          key: 'react',
          updateKind: 'minor',
          latest: '2.0.0',
        }),
      ]),
    ]);

    expect(
      screen.getByRole('button', { name: /Update react to 2\.0\.0/i }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: /Remove react/i })).toBeEnabled();
  });

  it('does not select the row when an action is clicked', async () => {
    const onSelect = vi.fn();
    const onUninstall = vi.fn();
    renderTable([group([dep({ name: 'react', key: 'react' })])], undefined, {
      onSelect,
      onUninstall,
    });

    await userEvent.click(
      screen.getByRole('button', { name: /Remove react/i }),
    );

    expect(onUninstall).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('the bulk bar', () => {
  const selection = ['react'];

  function renderBulkBar(overrides: Record<string, unknown> = {}) {
    return renderTable(
      [
        group([
          dep({
            name: 'react',
            key: 'react',
            updateKind: 'minor',
            latest: '2.0.0',
          }),
        ]),
      ],
      undefined,
      {
        selectedDepKeys: new Set(selection),
        onBulkUpdateSelected: noop,
        onBulkRemoveSelected: noop,
        onToggleSelectAll: noop,
        ...overrides,
      },
    );
  }

  it('blocks its writes while a scan or write is in flight', () => {
    renderBulkBar({ busy: true });

    expect(
      screen.getByRole('button', { name: /Update selected packages/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /Remove selected packages/i }),
    ).toBeDisabled();
    // Clearing a selection writes nothing, so the scan does not block it.
    expect(
      screen.getByRole('button', { name: /Clear selection/i }),
    ).toBeEnabled();
  });

  it('names its actions, since a narrow panel shows only their icons', () => {
    renderBulkBar();

    for (const name of [
      /Update selected packages/i,
      /Remove selected packages/i,
      /Clear selection/i,
    ]) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
  });
});

describe('keyboard navigation', () => {
  /** `data-row-index` of the row currently holding real DOM focus, if any. */
  function focusedRowIndex(): string | null {
    return document.activeElement instanceof HTMLElement
      ? document.activeElement.getAttribute('data-row-index')
      : null;
  }

  it('enters the grid on the first row and moves down/up with the arrow keys', () => {
    renderTable([
      group([
        dep({ name: 'a', key: 'a' }),
        dep({ name: 'b', key: 'b' }),
        dep({ name: 'c', key: 'c' }),
      ]),
    ]);

    fireEvent.focus(screen.getByRole('rowgroup'));
    expect(focusedRowIndex()).toBe('0');

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    expect(focusedRowIndex()).toBe('1');

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    expect(focusedRowIndex()).toBe('2');

    // Already on the last row: nothing to move to.
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    expect(focusedRowIndex()).toBe('2');

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowUp',
    });
    expect(focusedRowIndex()).toBe('1');

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowUp',
    });
    expect(focusedRowIndex()).toBe('0');

    // Already on the first row: nothing to move to.
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowUp',
    });
    expect(focusedRowIndex()).toBe('0');
  });

  it('jumps to the first and last row with Home and End', () => {
    renderTable([
      group(['a', 'b', 'c', 'd', 'e'].map((name) => dep({ name, key: name }))),
    ]);

    fireEvent.focus(screen.getByRole('rowgroup'));
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    expect(focusedRowIndex()).toBe('1');

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(focusedRowIndex()).toBe('4');

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(focusedRowIndex()).toBe('0');
  });

  it('skips group header rows rather than stopping on them', () => {
    // Two groups so headers render at all — a single group never shows one.
    renderTable([
      { ...group([dep({ name: 'a1', key: 'a1' })]), label: 'first' },
      {
        ...group([dep({ name: 'b1', key: 'b1' })]),
        label: 'second',
        manifestPath: '/p2/package.json',
      },
    ]);

    // Rows: [header:first, a1, header:second, b1] — indices 0-3.
    fireEvent.focus(screen.getByRole('rowgroup'));
    // Entering the grid lands on the first *dep* row, not the header.
    expect(focusedRowIndex()).toBe('1');

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    // Index 2 is the second group's header — skipped straight through to b1.
    expect(focusedRowIndex()).toBe('3');
  });
});

describe('empty and loading states', () => {
  it('distinguishes "nothing matches your filter" from "nothing declared"', () => {
    const onClearFilters = vi.fn();
    const { rerender } = renderTable([], undefined, {
      filtering: true,
      onClearFilters,
    });
    expect(screen.getByText(/No dependencies match/i)).toBeInTheDocument();

    rerender(
      <DepTable
        groups={[]}
        sort={{ key: 'name', direction: 'asc' }}
        onSortChange={noop}
        selectedKey={undefined}
        onSelect={noop}
        onUpdate={noop}
        onUninstall={noop}
        onUpdateAll={noop}
        loading={false}
        filtering={false}
        onClearFilters={onClearFilters}
      />,
    );
    expect(screen.getByText(/No dependencies declared/i)).toBeInTheDocument();
  });

  it('announces the first scan as a status rather than silently blank', () => {
    renderTable([], undefined, { loading: true });
    expect(screen.getByRole('status')).toHaveTextContent(
      /Reading your manifests/i,
    );
  });
});

/*
 * The row's keyboard contract.
 *
 * Every control in a row was once unreachable from the keyboard: the row's
 * keydown handler called `preventDefault()` on Enter and Space to open the
 * drawer, and because keydown bubbles from the row's children that also
 * cancelled the click those keys synthesize on the focused checkbox or button.
 *
 * The first two tests are the behaviour that handler exists to provide; the
 * rest are what it used to break, including the single-tab-stop contract the
 * top of DepTable.tsx states.
 */
describe('row controls: keyboard and naming', () => {
  /** The first dependency row, past the header. */
  function firstRow(): HTMLElement {
    return screen.getAllByRole('row')[1];
  }

  function rowCheckbox(): HTMLInputElement {
    return within(firstRow()).getByRole('checkbox') as HTMLInputElement;
  }

  /**
   * Elements inside the grid body that Tab can actually reach.
   *
   * `tabIndex` rather than the attribute: a `<button>` with no attribute at all
   * still reports 0, and it is those implicit stops — one per control, per
   * rendered row — that the roving tabindex is supposed to suppress.
   */
  function tabStopsInGridBody(): HTMLElement[] {
    const body = screen.getByRole('rowgroup');
    return [
      ...body.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]',
      ),
    ].filter((element) => element.tabIndex >= 0);
  }

  function outdated() {
    return group([
      dep({
        name: 'left-pad',
        key: 'left-pad',
        updateKind: 'major',
        latest: '2.0.0',
      }),
    ]);
  }

  // ---- the row itself: must keep working ----

  it('opens the drawer on Enter when the row itself holds focus', () => {
    const onSelect = vi.fn();
    renderTable([outdated()], undefined, { onSelect });

    fireEvent.focus(screen.getByRole('rowgroup'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('opens the drawer on Space when the row itself holds focus', () => {
    const onSelect = vi.fn();
    renderTable([outdated()], undefined, { onSelect });

    fireEvent.focus(screen.getByRole('rowgroup'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: ' ' });

    expect(onSelect).toHaveBeenCalledOnce();
  });

  // ---- the controls inside it: currently unreachable ----

  it('ticks the row checkbox on Space', async () => {
    const onToggleSelectDep = vi.fn();
    renderTable([outdated()], undefined, {
      onToggleSelectDep,
      selectedDepKeys: new Set<string>(),
    });

    rowCheckbox().focus();
    await userEvent.keyboard(' ');

    expect(onToggleSelectDep).toHaveBeenCalledWith('left-pad');
  });

  it('does not open the drawer when Space ticks the checkbox', async () => {
    const onSelect = vi.fn();
    renderTable([outdated()], undefined, {
      onSelect,
      onToggleSelectDep: noop,
      selectedDepKeys: new Set<string>(),
    });

    rowCheckbox().focus();
    await userEvent.keyboard(' ');

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('runs the row Update button on Enter', async () => {
    const onUpdate = vi.fn();
    renderTable([outdated()], undefined, { onUpdate });

    screen.getByRole('button', { name: /Update left-pad/i }).focus();
    await userEvent.keyboard('{Enter}');

    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('runs the row Update button on Space', async () => {
    const onUpdate = vi.fn();
    renderTable([outdated()], undefined, { onUpdate });

    screen.getByRole('button', { name: /Update left-pad/i }).focus();
    await userEvent.keyboard(' ');

    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('runs the row Remove button on Enter', async () => {
    const onUninstall = vi.fn();
    renderTable([outdated()], undefined, { onUninstall });

    screen.getByRole('button', { name: /Remove left-pad/i }).focus();
    await userEvent.keyboard('{Enter}');

    expect(onUninstall).toHaveBeenCalledOnce();
  });

  it('names the row checkbox after the package it selects', () => {
    renderTable([outdated()], undefined, {
      onToggleSelectDep: noop,
      selectedDepKeys: new Set<string>(),
    });

    // The header's select-all box is named, and changes wording under a
    // filter. The per-row box it sits above says nothing at all, so a screen
    // reader announces every one of them identically.
    expect(rowCheckbox()).toHaveAccessibleName(/left-pad/i);
  });

  it('gives every control it renders an accessible name', () => {
    renderTable([outdated()], undefined, {
      onToggleSelectDep: noop,
      selectedDepKeys: new Set<string>(),
    });

    const controls = [
      ...screen
        .getByRole('rowgroup')
        .querySelectorAll<HTMLElement>('button, input'),
    ];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control).toHaveAccessibleName();
    }
  });

  it('walks the row\u2019s own controls with Left and Right', () => {
    renderTable([outdated()], undefined, {
      onToggleSelectDep: noop,
      selectedDepKeys: new Set<string>(),
    });

    fireEvent.focus(screen.getByRole('rowgroup'));
    const row = firstRow();
    expect(document.activeElement).toBe(row);

    // The row is the first stop, then its controls in DOM order.
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowRight',
    });
    expect(document.activeElement).toBe(rowCheckbox());

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowRight',
    });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Update left-pad/i }),
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowRight',
    });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Remove left-pad/i }),
    );

    // Past the last control there is nowhere to go, rather than wrapping.
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowRight',
    });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Remove left-pad/i }),
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowLeft',
    });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Update left-pad/i }),
    );
  });

  it('returns focus to row level when arrowing down from a control', () => {
    renderTable([
      group(
        ['a', 'b'].map((name) =>
          dep({ name, key: name, updateKind: 'major', latest: '2.0.0' }),
        ),
      ),
    ]);

    fireEvent.focus(screen.getByRole('rowgroup'));
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowRight',
    });
    expect(document.activeElement).not.toBe(screen.getAllByRole('row')[1]);

    // Row-to-row movement still belongs to the grid, from wherever focus sits.
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    expect(
      (document.activeElement as HTMLElement).getAttribute('data-row-index'),
    ).toBe('1');
  });

  it('keeps the whole grid body to a single tab stop', () => {
    renderTable([
      group(
        ['a', 'b', 'c', 'd', 'e'].map((name) =>
          dep({ name, key: name, updateKind: 'major', latest: '2.0.0' }),
        ),
      ),
    ]);

    fireEvent.focus(screen.getByRole('rowgroup'));

    // One roving stop for the grid, per the contract stated at the top of
    // DepTable.tsx. Today each row contributes three more of its own.
    expect(tabStopsInGridBody()).toHaveLength(1);
  });
});

/*
 * Row action layout.
 *
 * Two guarantees the stylesheet relies on, asserted here because jsdom applies
 * no CSS: Remove is always rendered (it is revealed with `opacity`, never
 * `display`, so hiding it must not mean removing it), and the wrapper carries
 * the modifier that reserves space under the floating bulk bar.
 */
describe('row actions and bulk-bar clearance', () => {
  function wrapper(container: HTMLElement): HTMLElement {
    const found = container.querySelector<HTMLElement>('.table__wrapper');
    if (!found) throw new Error('table wrapper not rendered');
    return found;
  }

  it('renders Remove on every row, with or without an update to offer', () => {
    renderTable([
      group([
        dep({ name: 'current', key: 'c', updateKind: 'none' }),
        dep({
          name: 'stale',
          key: 's',
          updateKind: 'major',
          latest: '2.0.0',
        }),
      ]),
    ]);

    // The row with no update still gets a Remove, and it still sits in the
    // second slot rather than sliding into the empty Update one.
    for (const name of ['current', 'stale']) {
      const button = screen.getByRole('button', {
        name: new RegExp(`Remove ${name}`, 'i'),
      });
      expect(button).toHaveClass('row-action--remove');
    }
  });

  it('keeps Remove focusable and named while it is visually hidden', () => {
    renderTable([group([dep({ name: 'left-pad', key: 'left-pad' })])]);

    // Nothing is hovered here, which is exactly the state the stylesheet
    // renders at `opacity: 0` — it must still be reachable and announced.
    const remove = screen.getByRole('button', { name: /Remove left-pad/i });
    expect(remove).toHaveAccessibleName();
    remove.focus();
    expect(document.activeElement).toBe(remove);
  });

  it('reserves room under the bulk bar only while a selection exists', () => {
    const { container: none } = renderTable([
      group([dep({ name: 'a', key: 'a' })]),
    ]);
    expect(wrapper(none)).not.toHaveClass('table__wrapper--bulk');

    cleanup();

    const { container: some } = renderTable(
      [group([dep({ name: 'a', key: 'a' })])],
      undefined,
      { selectedDepKeys: new Set(['a']), onToggleSelectDep: noop },
    );
    expect(wrapper(some)).toHaveClass('table__wrapper--bulk');
  });
});
