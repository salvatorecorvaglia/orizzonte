import type { FocusEvent, KeyboardEvent, Ref } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DepScope, ProjectGroup, ScanSummary } from '../core/types.js';
import { ALL_SCOPES, SCOPE_LABELS } from '../core/vocabulary.js';
import { Icon } from './Icon.js';

/**
 * Which overlay panel the app has open, or `null` for none.
 *
 * A single value rather than a flag per panel: they are mutually exclusive by
 * construction, which is what stops four of them stacking over the table and
 * what makes the `aria-expanded` states below derivable rather than
 * separately maintained.
 */
export type PanelId = 'search' | 'duplicates' | 'licenses' | 'diff' | null;

interface OverflowItem {
  id: string;
  /** Codicon name, without the `codicon-` prefix. */
  icon: string;
  label: string;
  title: string;
  onSelect: () => void;
  /** Set when the item toggles a panel, so the menu reports that panel's state. */
  expanded?: boolean;
  controls?: string;
  disabled?: boolean;
}

const OVERFLOW_MENU_ID = 'orizzonte-overflow-menu';

/**
 * The toolbar's secondary actions, behind one button.
 *
 * A real menu rather than a second row of buttons: the point is to stop four
 * occasional actions competing for width with the three used every session, and
 * a disclosure that pushes the table further down when opened would trade one
 * density problem for another.
 *
 * Its items are marked `data-menu-item` so the toolbar's roving tabindex skips
 * them — inside the menu, Up/Down is the expected movement, not the toolbar's
 * Left/Right, and those arrow keys are stopped here so the toolbar behind does
 * not act on them too.
 */
function OverflowMenu({ items }: { items: OverflowItem[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const menuItems = useCallback(
    (): HTMLElement[] => [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        []),
    ],
    [],
  );

  // Opening a menu puts the caret in it; there is nowhere else sensible.
  useEffect(() => {
    if (open) menuItems()[0]?.focus();
  }, [open, menuItems]);

  // A click anywhere else dismisses it, as any menu does.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = menuItems();
    const index = list.indexOf(event.target as HTMLElement);

    switch (event.key) {
      case 'Escape':
        event.stopPropagation();
        close(true);
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        event.stopPropagation();
        if (index < 0) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        list[(index + step + list.length) % list.length]?.focus();
        break;
      }
      case 'Home':
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        (event.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        // The toolbar's own roving nav must not fire from inside the menu.
        event.stopPropagation();
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div className="toolbar__overflow">
      <button
        ref={triggerRef}
        type="button"
        className="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? OVERFLOW_MENU_ID : undefined}
        title="Duplicate versions, licenses, branch comparison and report export"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="ellipsis" /> More
      </button>

      {open && (
        <div
          ref={menuRef}
          id={OVERFLOW_MENU_ID}
          className="toolbar__menu"
          role="menu"
          aria-label="More actions"
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-menu-item
              className="toolbar__menu-item"
              disabled={item.disabled}
              aria-expanded={item.expanded}
              aria-controls={item.controls}
              title={item.title}
              onClick={() => {
                item.onSelect();
                close(true);
              }}
            >
              <Icon name={item.icon} /> {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface Filters {
  text: string;
  scopes: Set<DepScope>;
  onlyOutdated: boolean;
  onlyVulnerable: boolean;
  onlyDeprecated: boolean;
}

interface Props {
  groups?: ProjectGroup[];
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  summary: ScanSummary;
  busy: boolean;
  busyLabel: string | undefined;
  onRefresh: () => void;
  onCheckUpdates: () => void;
  onUpdateAll?: (manifestPath?: string) => void;
  onToggleInstall: () => void;
  activePanel: PanelId;
  onToggleDuplicates?: () => void;
  onToggleLicenses?: () => void;
  onCompareDependencies?: () => void;
  onExportReport?: () => void;
  /** Lets the app put the caret here from a keyboard shortcut. */
  filterRef?: Ref<HTMLInputElement>;
}

export function Toolbar({
  groups = [],
  filters,
  onFiltersChange,
  summary,
  busy,
  busyLabel,
  onRefresh,
  onCheckUpdates,
  onUpdateAll,
  onToggleInstall,
  activePanel,
  onToggleDuplicates,
  onToggleLicenses,
  onCompareDependencies,
  onExportReport,
  filterRef,
}: Props) {
  const toggleScope = (scope: DepScope) => {
    const scopes = new Set(filters.scopes);
    if (scopes.has(scope)) {
      scopes.delete(scope);
    } else {
      scopes.add(scope);
    }
    onFiltersChange({ ...filters, scopes });
  };

  const container = useRef<HTMLDivElement>(null);
  /** Which button currently holds the toolbar's single tab stop. */
  const [activeIndex, setActiveIndex] = useState(0);

  /*
   * `:not([data-menu-item])` keeps the overflow menu's own items out of the
   * toolbar's roving sequence. They belong to the menu, which runs the usual
   * Up/Down menu pattern over them; folding them in here would make Left/Right
   * walk into a popup that may not even be open.
   */
  const toolbarButtons = useCallback(
    (): HTMLElement[] => [
      ...(container.current?.querySelectorAll<HTMLElement>(
        'button:not([data-menu-item])',
      ) ?? []),
    ],
    [],
  );

  /*
   * A toolbar is one tab stop; arrow keys move within it.
   *
   * Assigning `tabIndex` imperatively rather than in JSX because the buttons
   * are conditional — "Update All" appears only when something is outdated —
   * so their count and order change, and the index that holds the stop has to
   * be clamped against whatever is on screen now. The dependency list is what
   * actually changes that: which buttons render is a function of these.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const buttons = toolbarButtons();
    if (buttons.length === 0) return;
    const active = Math.min(activeIndex, buttons.length - 1);
    buttons.forEach((button, index) => {
      button.tabIndex = index === active ? 0 : -1;
    });
  }, [activeIndex, toolbarButtons, activePanel, summary.outdated, busy]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;

    const focusable = toolbarButtons();
    const index = focusable.indexOf(target);
    if (index < 0) return;

    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + step + focusable.length) % focusable.length;
    setActiveIndex(next);
    focusable[next]?.focus();
  };

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const index = toolbarButtons().indexOf(event.target as HTMLElement);
    if (index >= 0) setActiveIndex(index);
  };

  const activeToolchains = useMemo(() => {
    if (!groups || groups.length === 0) return [];
    const set = new Set<string>();
    for (const g of groups) {
      if (g.toolchain) set.add(g.toolchain.toUpperCase());
    }
    return Array.from(set);
  }, [groups]);

  /*
   * The count next to this button is the whole workspace's, so the action has
   * to be the whole workspace's too. With one project that is unambiguous;
   * with several, naming none of them lets the host ask which — it used to
   * silently pass `groups[0]`, promising to update everything and updating
   * whichever project happened to sort first.
   */
  /*
   * The three status filters, and the counts that used to sit beside them as
   * separate KPI pills.
   *
   * Those pills were spans shaped exactly like these chips — same capsule, same
   * border, same coloured dot, same words — so half the row responded to a
   * click and half did not, with nothing to tell them apart. One interactive
   * element per concept, carrying its own count.
   */
  const statusChips = [
    {
      id: 'outdated',
      count: summary.outdated,
      pressed: filters.onlyOutdated,
      toggle: () =>
        onFiltersChange({ ...filters, onlyOutdated: !filters.onlyOutdated }),
    },
    {
      id: 'vulnerable',
      count: summary.vulnerable,
      pressed: filters.onlyVulnerable,
      toggle: () =>
        onFiltersChange({
          ...filters,
          onlyVulnerable: !filters.onlyVulnerable,
        }),
    },
    {
      id: 'deprecated',
      count: summary.deprecated,
      pressed: filters.onlyDeprecated,
      toggle: () =>
        onFiltersChange({
          ...filters,
          onlyDeprecated: !filters.onlyDeprecated,
        }),
    },
  ] as const;

  /*
   * The secondary actions, behind one button rather than spread across the row.
   *
   * Seven equally weighted buttons wrapped to two lines and put Refresh in
   * competition with Export report. What stays inline is what gets used every
   * session; these four are occasional, and none of them is destructive.
   */
  const overflowItems: OverflowItem[] = [
    ...(onToggleDuplicates
      ? [
          {
            id: 'duplicates',
            icon: 'layers',
            label: 'Duplicate versions',
            title: 'Find packages resolved at more than one version at once',
            onSelect: onToggleDuplicates,
            expanded: activePanel === 'duplicates',
            controls: 'orizzonte-duplicates-panel',
          },
        ]
      : []),
    ...(onToggleLicenses
      ? [
          {
            id: 'licenses',
            icon: 'law',
            label: 'Licenses',
            title: "Check every package's license against your allow/deny list",
            onSelect: onToggleLicenses,
            expanded: activePanel === 'licenses',
            controls: 'orizzonte-licenses-panel',
          },
        ]
      : []),
    ...(onCompareDependencies
      ? [
          {
            id: 'diff',
            icon: 'git-compare',
            label: 'Compare with…',
            title: 'Compare dependencies with another branch',
            onSelect: onCompareDependencies,
            expanded: activePanel === 'diff',
            controls: 'orizzonte-dependency-diff-panel',
          },
        ]
      : []),
    ...(onExportReport
      ? [
          {
            id: 'export',
            icon: 'export',
            label: 'Export report',
            title:
              'Save the current outdated, vulnerable and duplicate-version findings as a file',
            onSelect: onExportReport,
            // Writes a file from the findings, so a scan in flight blocks it —
            // see the busy rule above the action row.
            disabled: busy,
          },
        ]
      : []),
  ];

  const handleGlobalUpdateAll = () => {
    if (!onUpdateAll || groups.length === 0) return;
    onUpdateAll(groups.length === 1 ? groups[0].manifestPath : undefined);
  };

  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label="Orizzonte actions"
      ref={container}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
    >
      {/* Top Header & Environment Bar */}
      <div className="toolbar__header-bar">
        <div className="toolbar__branding">
          <div className="toolbar__logo-icon">
            <Icon name="package" />
          </div>
          <div className="toolbar__title-group">
            <span className="toolbar__title">Orizzonte</span>
            {/*
              The toolchains in play, and nothing else. An "active" pill said
              only that the panel was rendering, and the package count is in
              the summary at the end of the filter row — two counts of the same
              thing in one toolbar invite the reader to look for the difference.
            */}
            <div className="toolbar__env-pills">
              {activeToolchains.map((tc) => (
                <span key={tc} className="env-pill env-pill--toolchain">
                  {tc}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="toolbar__header-actions">
          {summary.outdated > 0 && (
            <button
              type="button"
              className="btn-update-all-primary"
              onClick={handleGlobalUpdateAll}
              disabled={busy}
            >
              Update All ({summary.outdated})
            </button>
          )}
        </div>
      </div>

      {/*
        Main Control & Search Row.

        The busy rule, stated once because it was previously visible only as a
        pattern in which buttons happened to carry `disabled`: a scan in flight
        blocks anything that writes or rescans — Update All, Check updates,
        Refresh, Export report — and leaves the read-only panels reachable, so
        the panel does not freeze wholesale while a background check runs.

        The rule is the whole panel's, not this toolbar's. It is enforced at
        three sites, and it has to stay that way: here, in `DepTable` (the row
        actions, the group headers' Update All, and the bulk bar) and in
        `DetailDrawer` (its copies of Update and Remove). Enforcing it only
        here is what left a greyed-out Update All beside a column of live
        Update buttons doing the identical thing.
      */}
      <div className="toolbar__row">
        <div className="toolbar__search">
          <input
            ref={filterRef}
            type="search"
            placeholder="Filter installed packages…"
            value={filters.text}
            aria-label="Filter installed packages"
            onChange={(event) =>
              onFiltersChange({ ...filters, text: event.target.value })
            }
          />
        </div>

        <button
          type="button"
          className="btn-accent"
          onClick={onToggleInstall}
          aria-expanded={activePanel === 'search'}
          aria-controls="orizzonte-search-panel"
        >
          <Icon name={activePanel === 'search' ? 'close' : 'add'} />{' '}
          {activePanel === 'search' ? 'Close search' : 'Add package'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onCheckUpdates}
          disabled={busy}
          title="Query the registries now for newer versions, even if automatic checks are off"
        >
          <Icon name="cloud-download" /> Check updates
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onRefresh}
          disabled={busy}
          title="Re-read the manifests and lockfiles from disk"
        >
          <Icon name="refresh" /> Refresh
        </button>
        {overflowItems.length > 0 && <OverflowMenu items={overflowItems} />}
      </div>

      {/* Filter Chips & Summary Row */}
      <div className="toolbar__row">
        <fieldset className="toolbar__group">
          <legend className="toolbar__legend">Scope</legend>
          <div className="toolbar__chips">
            {ALL_SCOPES.map((scope) => (
              <button
                type="button"
                key={scope}
                className="chip"
                aria-pressed={filters.scopes.has(scope)}
                onClick={() => toggleScope(scope)}
              >
                {SCOPE_LABELS[scope].short}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="toolbar__group toolbar__group--divided">
          <legend className="toolbar__legend">Show only</legend>
          <div className="toolbar__chips">
            {statusChips.map((chip) => (
              <button
                type="button"
                key={chip.id}
                className="chip"
                aria-pressed={chip.pressed}
                /*
                 * Spelled out rather than left to the visible text, which
                 * would announce as "outdated 125" and leave the number to be
                 * guessed at.
                 */
                aria-label={
                  chip.count > 0
                    ? `${chip.id}, ${chip.count} ${
                        chip.count === 1 ? 'package' : 'packages'
                      }`
                    : chip.id
                }
                onClick={chip.toggle}
              >
                <span className={`chip__dot chip__dot--${chip.id}`} /> {chip.id}
                {chip.count > 0 && (
                  <span className="chip__count">{chip.count}</span>
                )}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="toolbar__spacer" />

        {/*
          Readable, not hidden. This was `aria-hidden`, which left the only
          statement of *what* is happening ("Checking registries…") available
          to sighted users alone — the progress bar below announces that
          something is happening, not what.
        */}
        {busy && busyLabel && <span className="muted">{busyLabel}</span>}

        {/*
          The workspace total, which is the one count with no chip of its own.
          The outdated/vulnerable/deprecated counts moved onto the filter chips
          they duplicated.
        */}
        <div className="toolbar__summary" role="status">
          <span className="toolbar__kpi">
            <span className="kpi-dot kpi-dot--total" />{' '}
            {summary.totalDependencies} packages
          </span>
          {summary.stale && (
            <span className="toolbar__kpi" title="Registries were unreachable">
              cached
            </span>
          )}
        </div>
      </div>

      {/*
        Indeterminate on purpose: a scan reports no percentage, and a
        progressbar with no `aria-valuenow` is exactly how that is expressed.
        Stating the bounds without a value would claim a measurement we do not
        have.
      */}
      {busy && (
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={busyLabel ?? 'Scanning'}
        />
      )}
    </div>
  );
}
