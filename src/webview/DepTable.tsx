/**
 * The dependency table.
 *
 * Rows are virtualized: a large monorepo can easily declare a couple of
 * thousand dependencies, and rendering them all would make sorting and
 * filtering feel sluggish.
 *
 * Virtualization is also why keyboard support is a roving tabindex over the
 * whole row list rather than a tab stop per row: a row scrolled out of view is
 * not in the DOM, so no amount of `tabIndex` would let Tab reach it.
 * `aria-rowcount`/`aria-rowindex` tell assistive technology the true size of the
 * list even though only a window of it exists.
 *
 * This is also the one file where `useSemanticElements` and
 * `useFocusableInteractive` are switched off (see `biome.json`). Both rules ask
 * for something a virtualized grid cannot give: rows are absolutely positioned
 * at computed offsets, which a real `<table>` cannot express, and only the row
 * holding the roving tabindex is focusable — making every gridcell a tab stop
 * would be the accessibility regression, not the fix. Everywhere else in the
 * webview those rules are enforced.
 *
 * That contract covers the controls *inside* a row too, which is what makes it
 * more than a statement about the row elements. The checkbox and the two action
 * buttons are native elements, so each carried an implicit tab stop of its own
 * and ten rendered rows put thirty of them between Tab and the rest of the
 * panel. They now carry `tabIndex={-1}` and are reached with Left/Right from
 * the row that owns them, so the whole grid body is one tab stop whatever the
 * row count.
 *
 * The one deliberate exception is a group header's "Update All": those rows are
 * labels rather than stops, so the button is not in the roving sequence and
 * keeps a normal tab stop. There is one per project rather than one per row, so
 * it does not scale with the list the way the per-row controls did.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import type { FocusEvent, KeyboardEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dependency, Ecosystem, ProjectGroup } from '../core/types.js';
import { compareVersions } from '../core/versions/index.js';
import {
  currentVersion,
  declaredLabel,
  hasUpdate,
  scopeLabel,
  statusRank,
} from '../core/vocabulary.js';
import { formatBytes, GROUP_HEADER_HEIGHT, ROW_HEIGHT } from './format.js';
import { Icon } from './Icon.js';

export type SortKey =
  | 'name'
  | 'scope'
  | 'current'
  | 'latest'
  | 'size'
  | 'status';
export interface SortState {
  key: SortKey;
  direction: 'asc' | 'desc';
}

interface Props {
  groups: ProjectGroup[];
  /**
   * depKey -> a counter bumped each time that row's `meta` is merged in place.
   * Passed through to `DepRow` purely to give its memo comparator a prop that
   * actually changes value when the mutated-in-place `dep` does not.
   */
  metaVersions?: ReadonlyMap<string, number>;
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  selectedKey: string | undefined;
  onSelect: (dep: Dependency) => void;
  onUpdate: (dep: Dependency) => void;
  onUninstall: (dep: Dependency) => void;
  onUpdateAll: (manifestPath: string) => void;
  selectedDepKeys?: ReadonlySet<string>;
  onToggleSelectDep?: (depKey: string) => void;
  onToggleSelectAll?: (depKeys: string[]) => void;
  onBulkUpdateSelected?: () => void;
  onBulkRemoveSelected?: () => void;
  /** Set when a command asked to scroll a specific row into view. */
  scrollToKey?: string;
  /** Called once that scroll has happened, so the request is not repeated. */
  onScrollHandled?: () => void;
  /**
   * True while a scan or a write is in flight.
   *
   * The busy rule is stated in `Toolbar.tsx` and used to be enforced only
   * there, so a scan greyed out the toolbar's Update All while every row's own
   * Update — and the bulk bar's — stayed live: the same action offered as both
   * blocked and available on one screen. Only the writes take it; selection,
   * sorting and opening a row's details are reads and stay available.
   */
  busy?: boolean;
  /** True while the first scan is still running and there is nothing to show. */
  loading: boolean;
  /** True when a filter is narrowing the list — changes the empty state. */
  filtering: boolean;
  onClearFilters: () => void;
}

/**
 * The default for `selectedDepKeys`, hoisted out of the parameter list.
 *
 * A default expression is evaluated on every render, so `new Set()` there
 * allocated one per frame and — worse — handed every memo comparison a fresh
 * reference to disagree about.
 */
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

/** A flat render list so one virtualizer can cover group headers and rows. */
type Row =
  | { kind: 'group'; group: ProjectGroup; outdated: number }
  | { kind: 'dep'; dep: Dependency };

const COLUMNS: Array<{ key: SortKey | null; label: string; cell: string }> = [
  { key: 'name', label: 'Package', cell: 'cell--name' },
  { key: 'scope', label: 'Scope', cell: 'cell--scope' },
  { key: 'current', label: 'Current', cell: 'cell--version' },
  { key: 'latest', label: 'Latest', cell: 'cell--latest' },
  { key: 'size', label: 'Size', cell: 'cell--size' },
  { key: 'status', label: 'Status', cell: 'cell--status' },
  { key: null, label: 'Actions', cell: 'cell--actions' },
];

export function DepTable({
  groups,
  metaVersions,
  sort,
  onSortChange,
  selectedKey,
  onSelect,
  onUpdate,
  onUninstall,
  onUpdateAll,
  selectedDepKeys = EMPTY_SELECTION,
  onToggleSelectDep,
  onToggleSelectAll,
  onBulkUpdateSelected,
  onBulkRemoveSelected,
  scrollToKey,
  onScrollHandled,
  busy = false,
  loading,
  filtering,
  onClearFilters,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    const showHeaders = groups.length > 1;

    for (const group of groups) {
      const sorted = sortDependencies(group.dependencies, sort);
      if (sorted.length === 0) continue;

      if (showHeaders) {
        result.push({
          kind: 'group',
          group,
          outdated: sorted.filter(hasUpdate).length,
        });
      }
      for (const dep of sorted) {
        result.push({ kind: 'dep', dep });
      }
    }
    return result;
  }, [groups, sort]);

  const allDepKeys = useMemo(
    () =>
      rows
        .filter(
          (row): row is Extract<Row, { kind: 'dep' }> => row.kind === 'dep',
        )
        .map((row) => row.dep.key),
    [rows],
  );

  /*
   * Memoized because these walk every row, and this component re-renders on
   * every scroll frame the virtualizer produces. Two full passes over a few
   * thousand keys per frame is work the user feels as a sluggish scrollbar.
   */
  const allSelected = useMemo(
    () =>
      allDepKeys.length > 0 &&
      allDepKeys.every((key) => selectedDepKeys.has(key)),
    [allDepKeys, selectedDepKeys],
  );
  /*
   * Some but not all — a real third state, and the checkbox has to say so.
   * Without it, a partial selection renders identically to none, so the box
   * invites a click whose effect ("select the rest" or "clear what I have")
   * cannot be predicted from what is on screen.
   *
   * `indeterminate` is a DOM property with no HTML attribute, so React cannot
   * set it from JSX; a ref callback is the standard way.
   */
  const someSelected = useMemo(
    () => !allSelected && allDepKeys.some((key) => selectedDepKeys.has(key)),
    [allSelected, allDepKeys, selectedDepKeys],
  );

  // Read from effects that must not re-run when the list is merely rebuilt.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      rows[index].kind === 'group' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT,
    overscan: 12,
  });

  /*
   * A virtualized row that is scrolled out of view is not in the DOM, so a
   * command targeting it has to move the viewport rather than call focus().
   *
   * `rows` is deliberately not a dependency: it is a fresh array on every scan,
   * and re-running this would drag the viewport back to a row the user has
   * since scrolled away from. The request is cleared once honoured.
   */
  useEffect(() => {
    if (!scrollToKey) return;
    const index = rowsRef.current.findIndex(
      (row) => row.kind === 'dep' && row.dep.key === scrollToKey,
    );
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: 'center' });
      setFocusedIndex(index);
    }
    onScrollHandled?.();
  }, [scrollToKey, virtualizer, onScrollHandled]);

  const virtualItems = virtualizer.getVirtualItems();

  // Move DOM focus onto the row the roving tabindex points at, once the
  // virtualizer has actually rendered it.
  const shouldFocusRef = useRef(false);
  /*
   * `virtualItems` is in the dependency list on purpose: the row we want to
   * focus may not be mounted yet, so this has to run again each time the
   * virtualizer renders a new window.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!shouldFocusRef.current || focusedIndex < 0) return;
    const element = parentRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${focusedIndex}"]`,
    );
    if (element) {
      element.focus();
      shouldFocusRef.current = false;
    }
  }, [focusedIndex, virtualItems]);

  const moveFocus = useCallback(
    (from: number, step: number) => {
      const list = rowsRef.current;
      let next = from + step;
      // Group headers are labels, not stops.
      while (next >= 0 && next < list.length && list[next].kind !== 'dep') {
        next += step;
      }
      if (next < 0 || next >= list.length) return;
      shouldFocusRef.current = true;
      setFocusedIndex(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
    },
    [virtualizer],
  );

  const edgeDepIndex = useCallback((fromEnd: boolean) => {
    const list = rowsRef.current;
    if (fromEnd) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].kind === 'dep') return i;
      }
      return -1;
    }
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === 'dep') return i;
    }
    return -1;
  }, []);

  const jumpTo = useCallback(
    (index: number, align: 'start' | 'end') => {
      if (index < 0) return;
      shouldFocusRef.current = true;
      setFocusedIndex(index);
      virtualizer.scrollToIndex(index, { align });
    },
    [virtualizer],
  );

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(focusedIndex, 1);
        break;
      case 'ArrowUp':
        if (focusedIndex >= 0) {
          event.preventDefault();
          moveFocus(focusedIndex, -1);
        }
        break;
      case 'Home':
        event.preventDefault();
        jumpTo(edgeDepIndex(false), 'start');
        break;
      case 'End':
        event.preventDefault();
        jumpTo(edgeDepIndex(true), 'end');
        break;
    }
  };

  // Entering the grid with Tab lands on the first row rather than nowhere.
  const handleGridFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const index = focusedIndex >= 0 ? focusedIndex : edgeDepIndex(false);
    if (index < 0) return;
    shouldFocusRef.current = true;
    setFocusedIndex(index);
    virtualizer.scrollToIndex(index, { align: 'auto' });
  };

  const toggleSort = (key: SortKey) => {
    onSortChange(
      sort.key === key
        ? { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  };

  const ariaSort = (
    key: SortKey | null,
  ): 'none' | 'ascending' | 'descending' | undefined => {
    if (!key) return undefined;
    if (sort.key !== key) return 'none';
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  };

  if (loading) {
    return (
      <div className="empty" role="status">
        <h2>Reading your manifests…</h2>
        <p>Orizzonte is scanning the workspace for dependency files.</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return filtering ? (
      <div className="empty">
        <h2>No dependencies match your filters</h2>
        <p>Clear the search box and re-enable the scopes to see everything.</p>
        <button
          type="button"
          className="empty__action secondary"
          onClick={onClearFilters}
        >
          Clear filters
        </button>
      </div>
    ) : (
      <div className="empty">
        <h2>No dependencies declared</h2>
        <p>The manifests in this workspace do not declare any dependencies.</p>
      </div>
    );
  }

  // The grid is one row taller than the data: the header counts as row 1.
  const focusedRendered = virtualItems.some(
    (item) => item.index === focusedIndex,
  );

  return (
    /*
     * The bulk bar sits outside the grid, not inside it. A `role="grid"` may
     * only contain rows and rowgroups, so a toolbar as a direct child made the
     * whole grid's structure invalid — assistive technology counts children to
     * reconcile them against `aria-rowcount`.
     */
    <div
      /*
       * The modifier is what lets the stylesheet keep the last rows clear of
       * the floating bulk bar: the bar is absolutely positioned over the
       * scroller, so without reserved space it covers the very rows — and the
       * very buttons — the selection is about.
       */
      className={`table__wrapper ${
        selectedDepKeys.size > 0 ? 'table__wrapper--bulk' : ''
      }`}
    >
      {selectedDepKeys.size > 0 && (
        <div
          className="table__bulk-bar"
          role="toolbar"
          aria-label={`Actions for ${selectedDepKeys.size} selected package(s)`}
        >
          <span className="table__bulk-info">
            Selected <strong>{selectedDepKeys.size}</strong> package(s)
          </span>
          <div className="table__bulk-actions">
            {/*
             * The labels are wrapped in the same span the row actions use, so
             * the one rule that drops words for icons on a narrow panel covers
             * both. `aria-label` carries the full wording, which is what makes
             * losing the visible text survivable.
             */}
            {onBulkUpdateSelected && (
              <button
                type="button"
                className="btn-update-primary"
                aria-label="Update selected packages"
                title="Update selected packages"
                disabled={busy}
                onClick={onBulkUpdateSelected}
              >
                <Icon name="arrow-up" />{' '}
                <span className="row-action__label">Update Selected</span>
              </button>
            )}
            {onBulkRemoveSelected && (
              <button
                type="button"
                className="danger"
                aria-label="Remove selected packages"
                title="Remove selected packages"
                disabled={busy}
                onClick={onBulkRemoveSelected}
              >
                <Icon name="trash" />{' '}
                <span className="row-action__label">Remove Selected</span>
              </button>
            )}
            {/* Clearing a selection writes nothing, so a scan does not block it. */}
            <button
              type="button"
              className="ghost"
              aria-label="Clear selection"
              title="Clear selection"
              onClick={() => onToggleSelectAll?.([])}
            >
              <Icon name="close" />{' '}
              <span className="row-action__label">Clear selection</span>
            </button>
          </div>
        </div>
      )}

      <div
        className="table__grid"
        role="grid"
        aria-label="Dependencies"
        aria-rowcount={rows.length + 1}
      >
        <div className="table__header" role="row" aria-rowindex={1}>
          {COLUMNS.map((column) => (
            <div
              key={column.cell + column.label}
              className={`cell ${column.cell}`}
              role="columnheader"
              aria-sort={ariaSort(column.key)}
            >
              {column.key === 'name' ? (
                <div className="table__header-name-wrapper">
                  <input
                    type="checkbox"
                    className="row-checkbox"
                    checked={allSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = someSelected;
                    }}
                    // Names what it actually covers: with a filter applied,
                    // the rows on screen are not every dependency there is.
                    aria-label={
                      filtering
                        ? 'Select all matching dependencies'
                        : 'Select all dependencies'
                    }
                    onChange={() => onToggleSelectAll?.(allDepKeys)}
                  />
                  <button type="button" onClick={() => toggleSort('name')}>
                    {column.label}
                    {sort.key === 'name' && (
                      <Icon
                        name={
                          sort.direction === 'asc'
                            ? 'chevron-up'
                            : 'chevron-down'
                        }
                        className="table__sort"
                      />
                    )}
                  </button>
                </div>
              ) : column.key ? (
                <button
                  type="button"
                  onClick={() => toggleSort(column.key as SortKey)}
                >
                  {column.label}
                  {sort.key === column.key && (
                    <Icon
                      name={
                        sort.direction === 'asc' ? 'chevron-up' : 'chevron-down'
                      }
                      className="table__sort"
                    />
                  )}
                </button>
              ) : (
                <span className="table__header-label">{column.label}</span>
              )}
            </div>
          ))}
        </div>

        {/*
         * The scroller is the rowgroup *and* the element Tab lands on to enter
         * the grid.
         *
         * Making it presentational instead reads as tidier, and is wrong: a
         * `role="grid"` reconciles its rows through a rowgroup, so dropping
         * the role leaves the rows with no container to be counted in. The
         * roving tabindex has to live on a real element in that structure, and
         * this is the one that scrolls.
         */}
        <div
          className="table"
          ref={parentRef}
          role="rowgroup"
          tabIndex={focusedRendered ? -1 : 0}
          onKeyDown={handleGridKeyDown}
          onFocus={handleGridFocus}
        >
          <div
            role="presentation"
            style={{
              height: virtualizer.getTotalSize(),
              position: 'relative',
              width: '100%',
            }}
          >
            {virtualItems.map((virtualRow) => {
              const row = rows[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  role="presentation"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {row.kind === 'group' ? (
                    <GroupHeader
                      row={row}
                      rowIndex={virtualRow.index + 2}
                      busy={busy}
                      onUpdateAll={onUpdateAll}
                    />
                  ) : (
                    <DepRow
                      dep={row.dep}
                      metaVersion={metaVersions?.get(row.dep.key) ?? 0}
                      index={virtualRow.index}
                      rowIndex={virtualRow.index + 2}
                      tabbable={virtualRow.index === focusedIndex}
                      selected={row.dep.key === selectedKey}
                      checked={selectedDepKeys.has(row.dep.key)}
                      busy={busy}
                      onToggleSelect={onToggleSelectDep}
                      onSelect={onSelect}
                      onUpdate={onUpdate}
                      onUninstall={onUninstall}
                      onFocusRow={setFocusedIndex}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const GroupHeader = memo(function GroupHeader({
  row,
  rowIndex,
  busy,
  onUpdateAll,
}: {
  row: Extract<Row, { kind: 'group' }>;
  rowIndex: number;
  /** A scan or write in flight — see the `busy` note on `Props`. */
  busy: boolean;
  onUpdateAll: (manifestPath: string) => void;
}) {
  return (
    <div className="table__group" role="row" aria-rowindex={rowIndex}>
      <div className="table__group-cell" role="gridcell">
        <span>{row.group.label}</span>
        {row.group.isWorkspaceRoot && (
          <span
            className="badge badge--workspace"
            title="Declares workspace members"
          >
            workspace root
          </span>
        )}
        {row.group.workspaceRootLabel && (
          <span
            className="badge badge--workspace"
            title={`A workspace member of ${row.group.workspaceRootLabel}`}
          >
            in {row.group.workspaceRootLabel}
          </span>
        )}
        <span className="table__group-meta">
          {row.group.toolchain} · {row.group.dependencies.length} packages
          {row.outdated > 0 ? ` · ${row.outdated} outdated` : ''}
        </span>
        <div className="table__group-spacer" />
        {row.outdated > 0 && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onUpdateAll(row.group.manifestPath)}
          >
            Update All
          </button>
        )}
      </div>
    </div>
  );
});

function renderStatusBadge(dep: Dependency) {
  if (dep.vulnerabilities.length > 0) {
    return <span className="badge badge--vuln">VULNERABLE</span>;
  }
  if (dep.meta?.deprecated) {
    return <span className="badge badge--deprecated">DEPRECATED</span>;
  }
  switch (dep.updateKind) {
    case 'major':
      return <span className="badge badge--major">MAJOR</span>;
    case 'minor':
      return <span className="badge badge--minor">MINOR</span>;
    case 'patch':
      return <span className="badge badge--patch">PATCH</span>;
    case 'unknown':
      return <span className="badge badge--muted">UNKNOWN</span>;
    default:
      return <span className="badge badge--none">CURRENT</span>;
  }
}

const DepRow = memo(function DepRow({
  dep,
  metaVersion,
  index,
  rowIndex,
  tabbable,
  selected,
  checked,
  busy,
  onToggleSelect,
  onSelect,
  onUpdate,
  onUninstall,
  onFocusRow,
}: {
  dep: Dependency;
  /** Unused directly — its only job is to change value when `dep.meta` does. */
  metaVersion: number;
  index: number;
  rowIndex: number;
  tabbable: boolean;
  selected: boolean;
  checked: boolean;
  /** A scan or write in flight — see the `busy` note on `Props`. */
  busy: boolean;
  onToggleSelect: ((depKey: string) => void) | undefined;
  onSelect: (dep: Dependency) => void;
  onUpdate: (dep: Dependency) => void;
  onUninstall: (dep: Dependency) => void;
  onFocusRow: (index: number) => void;
}) {
  // Exists only so memo's shallow prop comparison sees a change when `dep`
  // (mutated in place, not replaced) does not.
  void metaVersion;
  const upgradeable = hasUpdate(dep);

  return (
    <div
      className={`row ${checked ? 'row--checked' : ''}`}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      data-row-index={index}
      tabIndex={tabbable ? 0 : -1}
      onFocus={() => onFocusRow(index)}
      onClick={() => onSelect(dep)}
      onKeyDown={(event) => {
        const row = event.currentTarget;

        /*
         * Left/Right move between the row's own controls, which is how they
         * are reached at all: they carry `tabIndex={-1}` so that the grid
         * keeps a single tab stop. The row itself is the first stop, so
         * ArrowLeft from the checkbox returns to it.
         */
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          const stops: HTMLElement[] = [
            row,
            ...row.querySelectorAll<HTMLElement>('input, button'),
          ];
          const from = stops.indexOf(event.target as HTMLElement);
          if (from < 0) return;
          const next = stops[from + (event.key === 'ArrowRight' ? 1 : -1)];
          if (!next) return;
          // Also stops the grid scrolling sideways under the focus ring.
          event.preventDefault();
          next.focus();
          return;
        }

        /*
         * Enter and Space belong to the row only while the row itself holds
         * focus. This guard is load-bearing: keydown bubbles from the
         * checkbox and the action buttons, so calling `preventDefault()`
         * unconditionally cancelled the click those keys were about to
         * synthesize — leaving every control in the row inoperable from the
         * keyboard and opening the drawer instead. A child's own
         * `stopPropagation` cannot help, because it runs on the click that
         * this already cancelled.
         */
        if (event.target !== row) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(dep);
        }
      }}
    >
      <div className="cell cell--name" role="gridcell" title={dep.name}>
        <input
          type="checkbox"
          className="row-checkbox"
          checked={checked}
          // Named after what it selects. Unlabelled, a screen reader announced
          // every row's box identically, with nothing to tell 156 of them
          // apart.
          aria-label={`Select ${dep.name}`}
          // Reached with Left/Right from the row, not with Tab — see the
          // roving tabindex note at the top of this file.
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggleSelect?.(dep.key)}
        />
        {dep.vulnerabilities.length > 0 && (
          <Icon
            name="shield"
            className="severity--vuln"
            label="Vulnerable"
            title={`${dep.vulnerabilities.length} known vulnerability(ies)`}
          />
        )}
        {dep.meta?.deprecated && (
          <Icon
            name="warning"
            className="severity--deprecated"
            label="Deprecated"
            title={dep.meta.deprecated}
          />
        )}
        <span data-package-name className="package-name-highlight">
          {dep.name}
        </span>
      </div>

      <div className="cell cell--scope" role="gridcell">
        <span className={`badge badge--${dep.scope}`}>{scopeLabel(dep)}</span>
      </div>

      <div
        className="cell cell--version"
        role="gridcell"
        title={`Declared as ${declaredLabel(dep)}`}
      >
        {currentVersion(dep)}
      </div>

      {/*
       * The target version is coloured from the severity map by how big the
       * jump is, not green-for-any-upgrade. Green said "safe" beside a MAJOR
       * badge saying the opposite, and it was the only colour in the panel
       * outside the map that `theme.css` calls the one definition of state.
       *
       * It is also what lets the Status badge stay on the worst problem: a
       * package that is both vulnerable and a major behind reads VULNERABLE
       * there, and the magnitude it used to lose is carried here. The `title`
       * states it in words, since colour alone would not.
       */}
      <div
        className="cell cell--latest"
        role="gridcell"
        title={
          upgradeable && dep.latest
            ? `${dep.updateKind} update available — ${dep.latest}`
            : undefined
        }
      >
        {dep.lookupFailed ? (
          <span className="muted" title="Registry lookup failed">
            —
          </span>
        ) : (
          <span className="version-diff">
            {upgradeable && dep.latest ? (
              <Icon name="arrow-right" className="version-diff__arrow" />
            ) : (
              <span className="version-diff__spacer" />
            )}
            <span
              className={
                upgradeable && dep.latest
                  ? `version-latest--${dep.updateKind}`
                  : 'version-latest--current'
              }
            >
              {dep.latest ?? '—'}
            </span>
          </span>
        )}
      </div>

      <div className="cell cell--size" role="gridcell">
        {formatBytes(dep.meta?.sizeBytes)}
      </div>

      <div className="cell cell--status" role="gridcell">
        {renderStatusBadge(dep)}
      </div>

      <div className="cell cell--actions" role="gridcell">
        {upgradeable && dep.latest && (
          <button
            type="button"
            className="btn-update-primary"
            aria-label={`Update ${dep.name} to ${dep.latest}`}
            title={`Update to ${dep.latest}`}
            tabIndex={-1}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onUpdate(dep);
            }}
          >
            <Icon name="arrow-up" />{' '}
            <span className="row-action__label">Update</span>
          </button>
        )}
        {/*
         * Always rendered, and placed in the second slot explicitly so it sits
         * on the same x whether or not the row above it had an update to
         * offer. It is revealed on hover, on focus within the row, and while
         * the row's details are open — the stylesheet does that with `opacity`
         * rather than `display`, so it stays focusable and stays in the
         * accessibility tree while invisible.
         */}
        <button
          type="button"
          className="ghost danger row-action--remove"
          aria-label={`Remove ${dep.name} from this project`}
          title={`Remove ${dep.name} from this project`}
          tabIndex={-1}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onUninstall(dep);
          }}
        >
          <Icon name="trash" />{' '}
          <span className="row-action__label">Remove</span>
        </button>
      </div>
    </div>
  );
});

/**
 * Orders two version cells using their own ecosystem's rules.
 *
 * Collation with `numeric: true` gets simple cases right and the interesting
 * ones wrong: it ranks `1.0.0-rc1` above `1.0.0`, and it has no idea that Maven
 * sorts `1.0-SNAPSHOT` below `1.0`. Deferring to `core/versions` is also what
 * keeps the table's ordering consistent with the "is this outdated" judgement
 * made from exactly those comparators.
 *
 * Rows from two different ecosystems only meet when the table shows several
 * projects at once; there is no shared ordering to appeal to, so those fall
 * back to a plain string comparison.
 */
function compareVersionCells(
  ecosystemA: Ecosystem,
  a: string | undefined,
  ecosystemB: Ecosystem,
  b: string | undefined,
): number {
  // Missing versions sort last in ascending order.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  if (ecosystemA !== ecosystemB) {
    return a.localeCompare(b, undefined, { numeric: true });
  }
  return compareVersions(ecosystemA, a, b);
}

function sortDependencies(
  dependencies: Dependency[],
  sort: SortState,
): Dependency[] {
  const factor = sort.direction === 'asc' ? 1 : -1;

  return [...dependencies].sort((a, b) => {
    let comparison = 0;
    switch (sort.key) {
      case 'name':
        comparison = a.name.localeCompare(b.name);
        break;
      case 'scope':
        comparison =
          a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name);
        break;
      case 'current':
        comparison = compareVersionCells(
          a.ecosystem,
          currentVersion(a),
          b.ecosystem,
          currentVersion(b),
        );
        break;
      case 'latest':
        comparison = compareVersionCells(
          a.ecosystem,
          a.latest,
          b.ecosystem,
          b.latest,
        );
        break;
      case 'size': {
        // Missing sizes sort last in ascending order, matching the version
        // columns' convention — not first, which is what defaulting the
        // missing value to -1 used to produce.
        const sizeA = a.meta?.sizeBytes;
        const sizeB = b.meta?.sizeBytes;
        if (sizeA === undefined && sizeB === undefined) comparison = 0;
        else if (sizeA === undefined) comparison = 1;
        else if (sizeB === undefined) comparison = -1;
        else comparison = sizeA - sizeB;
        break;
      }
      case 'status':
        comparison =
          statusRank(a) - statusRank(b) || a.name.localeCompare(b.name);
        break;
    }
    return comparison * factor;
  });
}
