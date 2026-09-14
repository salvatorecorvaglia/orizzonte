/**
 * Webview root: owns all UI state and routes host messages to it.
 *
 * Deliberately the only stateful component — everything below is presentational,
 * which keeps the message handling in one readable place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostMessage } from '../core/protocol.js';
import type {
  ChangelogEntry,
  Dependency,
  DepNode,
  DepScope,
  Ecosystem,
  LicenseSummary,
  ProjectDependencyDiff,
  ProjectDuplicateVersions,
  ProjectGroup,
  ScanSummary,
  SearchResult,
} from '../core/types.js';
import { ALL_SCOPES, hasUpdate } from '../core/vocabulary.js';
import { DependencyDiffPanel } from './DependencyDiffPanel.js';
import { DepTable, type SortState } from './DepTable.js';
import { DetailDrawer } from './DetailDrawer.js';
import { DuplicatesPanel } from './DuplicatesPanel.js';
import { Icon } from './Icon.js';
import { LicenseSummaryPanel } from './LicenseSummaryPanel.js';
import { SearchInstall } from './SearchInstall.js';
import { type Filters, type PanelId, Toolbar } from './Toolbar.js';
import { loadState, onHostMessage, post, saveState } from './vscodeApi.js';

/**
 * Survives a webview reload (a VS Code window reload, or an extension
 * update) — everyday tab switches already survive via `retainContextWhenHidden`
 * and never touch this.
 *
 * Deliberately narrower than the full `Filters` shape: sort order and which
 * scope chips are on are durable preferences about how someone likes to look
 * at their dependencies. Search text and the only-outdated/vulnerable/
 * deprecated toggles are the opposite — a one-off narrowing for the task at
 * hand — and persisting those would mean a reload weeks later silently
 * reopens the panel pre-filtered down to whatever the user was chasing last,
 * with nothing on screen explaining why so few rows are showing. Every panel
 * instead opens at the same fixed starting point — see `initialFilters`.
 */
interface PersistedState {
  sort: SortState;
  scopes: DepScope[];
}

const EMPTY_SUMMARY: ScanSummary = {
  totalDependencies: 0,
  outdated: 0,
  vulnerable: 0,
  deprecated: 0,
  stale: false,
};

const NOTICE_TIMEOUT_MS = 8000;
/**
 * Caps the error queue so a broken registry during a large `updateAll`
 * cannot enqueue one string per package without bound. The newest is always
 * kept — that is what is shown — so the oldest are dropped first.
 */
const MAX_QUEUED_ERRORS = 50;

function defaultFilters(scopes?: DepScope[]): Filters {
  return {
    text: '',
    scopes: new Set(scopes ?? ALL_SCOPES),
    onlyOutdated: false,
    onlyVulnerable: false,
    onlyDeprecated: false,
  };
}

/**
 * What the panel opens with: the outdated chip already on.
 *
 * The list a fresh panel is useful for is "what needs updating", not the full
 * inventory — on a large manifest the handful of outdated packages are
 * otherwise buried among hundreds of current ones. The chip is pressed and the
 * empty state offers "Clear filters", so the narrowing is visible and one
 * click away from the full list; it is only the starting point, never sticky
 * (see `PersistedState`).
 */
function initialFilters(scopes?: DepScope[]): Filters {
  return { ...defaultFilters(scopes), onlyOutdated: true };
}

/** Whether anything is currently narrowing the list — drives the empty state. */
function isFiltering(filters: Filters): boolean {
  return (
    filters.text.trim().length > 0 ||
    filters.scopes.size !== ALL_SCOPES.length ||
    filters.onlyOutdated ||
    filters.onlyVulnerable ||
    filters.onlyDeprecated
  );
}

export function App() {
  const persisted = loadState<PersistedState>();

  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [summary, setSummary] = useState<ScanSummary>(EMPTY_SUMMARY);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  /*
   * Errors queue rather than overwrite.
   *
   * This was a single slot, so a second failure replaced the first without a
   * trace — and failures arrive in clusters: "Update all" against a broken
   * registry produces one per package. The newest is shown, with a count of
   * what is behind it, so nothing is silently dropped.
   */
  const [errors, setErrors] = useState<string[]>([]);
  const error = errors[errors.length - 1];
  /** True once the host has sent at least one scan result. */
  const [loaded, setLoaded] = useState(false);

  const [sort, setSort] = useState<SortState>(
    persisted?.sort ?? { key: 'status', direction: 'asc' },
  );
  const [filters, setFilters] = useState<Filters>(() =>
    initialFilters(persisted?.scopes),
  );

  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const [scrollToKey, setScrollToKey] = useState<string | undefined>();
  const [revealSection, setRevealSection] = useState<'details' | 'why'>(
    'details',
  );
  const [whyByKey, setWhyByKey] = useState<
    Record<string, { roots: DepNode[]; source: 'lockfile' | 'registry' }>
  >({});
  /**
   * depKey -> the changelog entries fetched for it, or undefined when the
   * host looked and found nothing to show. A key's mere presence (checked
   * with `in`, not a truthiness test) is what tells "answered, nothing to
   * show" apart from "not asked yet" — see `DetailDrawer`'s `changelogLoaded`.
   */
  const [changelogByKey, setChangelogByKey] = useState<
    Record<string, ChangelogEntry[] | undefined>
  >({});

  /*
   * Which overlay panel is open, if any.
   *
   * One value rather than a boolean each, because the four panels are siblings
   * above the table and each is capped at 45vh: with independent flags nothing
   * closed one when another opened, so all four could be on screen at once and
   * push the table out of view entirely. Making them mutually exclusive by
   * construction is also what keeps the toolbar's `aria-expanded` states honest
   * — they are read straight off this.
   */
  const [activePanel, setActivePanel] = useState<PanelId>(null);

  /** Opens a panel, or closes it when it is already the open one. */
  const togglePanel = useCallback((panel: Exclude<PanelId, null>) => {
    setActivePanel((current) => (current === panel ? null : panel));
  }, []);

  const closePanel = useCallback(() => setActivePanel(null), []);

  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const [duplicateResults, setDuplicateResults] = useState<
    ProjectDuplicateVersions[] | undefined
  >();

  const [licensesLoading, setLicensesLoading] = useState(false);
  const [licenseSummary, setLicenseSummary] = useState<
    LicenseSummary | undefined
  >();

  /*
   * No loading flag: the wait for a ref is a native quick-pick, which is
   * already its own visible "waiting for you" — a webview spinner under it
   * would just be a second one. The panel itself only ever opens once a
   * result lands, so cancelling the picker leaves nothing stuck open.
   */
  const [dependencyDiffRef, setDependencyDiffRef] = useState<
    string | undefined
  >();
  const [dependencyDiffResults, setDependencyDiffResults] = useState<
    ProjectDependencyDiff[] | undefined
  >();

  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | undefined>();
  /** Registries that did not answer, when others did. */
  const [searchPartial, setSearchPartial] = useState<Ecosystem[] | undefined>();
  const [searching, setSearching] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string | undefined>();

  /**
   * Forces a render after lazily fetched metadata is merged into an existing
   * row. See the `depDetails` case below for why that merge does not replace
   * `groups`; `metaVersionsRef` is the per-row counterpart that lets the
   * specific row re-render despite `React.memo`.
   */
  const [, setRenderTick] = useState(0);
  /**
   * depKey -> a counter bumped each time that row's `meta` is merged.
   *
   * `DepRow` is memoized on shallow prop equality, and `dep` keeps its
   * identity across a merge (mutated in place, not replaced) so that sorted
   * order does not shift while the user is looking at it. Without some prop
   * that actually changes value, memo sees the same `dep` reference and skips
   * the re-render — this counter is that prop.
   */
  const metaVersionsRef = useRef<Map<string, number>>(new Map());
  const groupsRef = useRef<ProjectGroup[]>([]);
  const filterRef = useRef<HTMLInputElement>(null);

  const [selectedDepKeys, setSelectedDepKeys] = useState<Set<string>>(
    new Set(),
  );

  const handleToggleSelectDep = useCallback((depKey: string) => {
    setSelectedDepKeys((prev) => {
      const next = new Set(prev);
      if (next.has(depKey)) {
        next.delete(depKey);
      } else {
        next.add(depKey);
      }
      return next;
    });
  }, []);

  /*
   * Select-all acts on the rows it was given — the ones currently visible —
   * and leaves any selection outside them alone.
   *
   * It used to replace the whole set, so ticking the header box while a filter
   * was applied silently discarded everything selected in the rows the filter
   * had hidden. An empty list still means "clear everything", which is what the
   * bulk bar's own Clear button asks for.
   */
  const handleToggleSelectAll = useCallback((depKeys: string[]) => {
    setSelectedDepKeys((prev) => {
      if (depKeys.length === 0) return new Set();
      const next = new Set(prev);
      if (depKeys.every((key) => prev.has(key))) {
        for (const key of depKeys) next.delete(key);
      } else {
        for (const key of depKeys) next.add(key);
      }
      return next;
    });
  }, []);

  /*
   * One message carrying the whole selection, not one per package — see the
   * `bulkUpdate` comment in `core/protocol.ts` for why N messages raced.
   */
  const handleBulkUpdateSelected = useCallback(() => {
    const targets: Array<{ depKey: string; toVersion: string }> = [];
    for (const group of groups) {
      for (const dep of group.dependencies) {
        if (selectedDepKeys.has(dep.key) && hasUpdate(dep) && dep.latest) {
          targets.push({ depKey: dep.key, toVersion: dep.latest });
        }
      }
    }
    if (targets.length === 0) return;
    post({ type: 'bulkUpdate', targets });
  }, [groups, selectedDepKeys]);

  const handleBulkRemoveSelected = useCallback(() => {
    if (selectedDepKeys.size === 0) return;
    post({ type: 'bulkUninstall', depKeys: [...selectedDepKeys] });
  }, [selectedDepKeys]);

  /*
   * Ctrl/Cmd+F focuses the filter box.
   *
   * The panel is a webview, so the editor's own Find does not reach it and the
   * keystroke would otherwise do nothing at all. Filtering a few hundred rows
   * is the most common thing anyone does here and it had no keyboard route.
   */
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'f' || !(event.ctrlKey || event.metaKey)) return;
      const input = filterRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Persist the bits of UI state worth surviving a reload.
  useEffect(() => {
    saveState<PersistedState>({ sort, scopes: [...filters.scopes] });
  }, [sort, filters.scopes]);

  useEffect(() => {
    const dispose = onHostMessage((message: HostMessage) => {
      switch (message.type) {
        case 'state': {
          groupsRef.current = message.groups;
          setGroups(message.groups);
          setSummary(message.summary);
          setLoaded(true);
          /*
           * Drop selected rows the new scan no longer has.
           *
           * A key names a package in a manifest, so uninstalling one — or
           * removing the manifest — leaves a key behind that matches nothing.
           * The bulk bar counts the set, so those ghosts kept inflating "3
           * packages selected" past what the table could show, and the host
           * silently skipped them.
           */
          const live = new Set<string>();
          for (const group of message.groups) {
            for (const dep of group.dependencies) live.add(dep.key);
          }
          setSelectedDepKeys((prev) => {
            const next = new Set<string>();
            for (const key of prev) {
              if (live.has(key)) next.add(key);
            }
            return next.size === prev.size ? prev : next;
          });
          /*
           * A new scan can have changed the graph — an install, an update, a
           * lockfile written by something else. The cached answers describe the
           * old one, and a "why is this installed" tree that is quietly one
           * scan out of date is worse than no answer, because nothing about it
           * looks stale. The drawer re-requests on demand.
           */
          setWhyByKey({});
          setChangelogByKey({});
          break;
        }

        case 'depDetails': {
          /*
           * Merged in place instead of rebuilding `groups`.
           *
           * A new `groups` array would recompute the sort, so a row that gains
           * a size or a deprecation notice while the table is sorted by Size or
           * Status would jump out from under the pointer of the user who just
           * clicked it. Mutating the row and forcing a render keeps the order
           * the user is looking at.
           */
          for (const group of groupsRef.current) {
            const dep = group.dependencies.find(
              (candidate) => candidate.key === message.depKey,
            );
            if (!dep) continue;
            // Preserve any deprecation notice the version lookup already found.
            dep.meta = {
              ...message.meta,
              deprecated: message.meta.deprecated ?? dep.meta?.deprecated,
            };
            metaVersionsRef.current.set(
              dep.key,
              (metaVersionsRef.current.get(dep.key) ?? 0) + 1,
            );
            setRenderTick((tick) => tick + 1);
            /*
             * Only once the repository is known, and only for a package that
             * actually has an update to preview — a package already current
             * has no "between" for the changelog to describe.
             */
            if (dep.meta.repository && hasUpdate(dep)) {
              post({ type: 'requestChangelog', depKey: dep.key });
            }
            break;
          }
          break;
        }

        case 'scanning':
          setBusy(message.busy);
          setBusyLabel(message.label);
          break;

        case 'searchResults':
          setSearchResults(message.results);
          setSearchError(undefined);
          // Some registries answered and some did not. The results are real, so
          // they are shown — but silently dropping an ecosystem would read as
          // "that package does not exist".
          setSearchPartial(
            message.failed.length > 0 ? message.failed : undefined,
          );
          setSearching(false);
          setActiveRequestId(undefined);
          break;

        case 'searchError':
          setSearchError(message.message);
          setSearchPartial(undefined);
          setSearching(false);
          setActiveRequestId(undefined);
          break;

        case 'whyTree':
          setWhyByKey((current) => ({
            ...current,
            [message.depKey]: { roots: message.roots, source: message.source },
          }));
          break;

        case 'duplicateVersions':
          setDuplicateResults(message.results);
          setDuplicatesLoading(false);
          break;

        case 'licenseSummary':
          setLicenseSummary(message.summary);
          setLicensesLoading(false);
          break;

        case 'changelogEntries':
          setChangelogByKey((current) => ({
            ...current,
            [message.depKey]: message.entries,
          }));
          break;

        case 'dependencyDiff':
          setDependencyDiffRef(message.ref);
          setDependencyDiffResults(message.results);
          setActivePanel('diff');
          break;

        case 'error':
          setErrors((current) => {
            // A repeat of the message already on screen is not new information.
            if (current[current.length - 1] === message.message) return current;
            const next = [...current, message.message];
            return next.length > MAX_QUEUED_ERRORS
              ? next.slice(next.length - MAX_QUEUED_ERRORS)
              : next;
          });
          break;

        case 'notice':
          setNotice(message.message);
          break;

        case 'focusSearch':
          setActivePanel('search');
          break;

        case 'focusDependency':
          setSelectedKey(message.depKey);
          setScrollToKey(message.depKey);
          setRevealSection(message.reveal);
          /*
           * Clear the filters so the row being revealed is actually in the
           * table.
           *
           * The drawer reads from `groups` and would open regardless, but the
           * table renders `filteredGroups` — so asking "why is this installed"
           * about a package the current filters exclude used to open a drawer
           * beside a table with no matching row, and the scroll request found
           * nothing to scroll to. The command names a specific package; that
           * is a clearer statement of intent than a filter left over from
           * earlier.
           */
          setFilters((current) =>
            isFiltering(current) ? defaultFilters() : current,
          );
          break;
      }
    });

    post({ type: 'ready' });
    return dispose;
  }, []);

  /*
   * Notices are transient chatter and dismiss themselves; errors do not. An
   * error that disappears on its own is one the user may never have read, and
   * the two used to share a single timer, so a notice could cut an error's
   * visible life to a second.
   */
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const filteredGroups = useMemo(() => {
    const needle = filters.text.trim().toLowerCase();

    return groups
      .map((group) => ({
        ...group,
        dependencies: group.dependencies.filter((dep) => {
          if (!filters.scopes.has(dep.scope)) return false;
          if (needle && !dep.name.toLowerCase().includes(needle)) return false;
          if (filters.onlyOutdated && !hasUpdate(dep)) return false;
          if (filters.onlyVulnerable && dep.vulnerabilities.length === 0)
            return false;
          if (filters.onlyDeprecated && !dep.meta?.deprecated) return false;
          return true;
        }),
      }))
      .filter((group) => group.dependencies.length > 0);
  }, [groups, filters]);

  const selected = useMemo(() => {
    if (!selectedKey) return undefined;
    for (const group of groups) {
      const dep = group.dependencies.find(
        (candidate) => candidate.key === selectedKey,
      );
      if (dep) return dep;
    }
    return undefined;
  }, [groups, selectedKey]);

  const handleSearch = useCallback(
    (query: string, ecosystem: Ecosystem | 'all') => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setSearching(true);
      setSearchError(undefined);
      setActiveRequestId(requestId);
      post({ type: 'search', query, ecosystem, requestId });
    },
    [],
  );

  /*
   * Cancel any in-flight search when the search panel stops being the open
   * one — which now includes another panel replacing it, not just the user
   * closing it. Without that, opening Licenses over a running search left the
   * request live and its result landing in a panel nobody is looking at.
   */
  useEffect(() => {
    if (activePanel !== 'search' && activeRequestId) {
      post({ type: 'cancelSearch', requestId: activeRequestId });
      setActiveRequestId(undefined);
      setSearching(false);
    }
  }, [activePanel, activeRequestId]);

  /*
   * Runs the check whenever the panel opens, and again whenever a new scan
   * lands while it stays open — the previous answer describes a lockfile
   * that may no longer be the one on disk (an install, an update, a lockfile
   * written by something else). `groups` only changes via a `state` message,
   * which is exactly a rescan, so it belongs in the dependency list even
   * though the body never reads it.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (activePanel !== 'duplicates') return;
    setDuplicatesLoading(true);
    post({ type: 'requestDuplicates' });
  }, [activePanel, groups]);

  /*
   * Runs once when the panel opens. Unlike the duplicate-version check this
   * reaches the network per package, so — deliberately unlike that effect —
   * `groups` stays out of the dependency list and a rescan does not refetch;
   * the panel's own Refresh button covers "check again".
   */
  useEffect(() => {
    if (activePanel !== 'licenses') return;
    setLicensesLoading(true);
    post({ type: 'requestLicenses' });
  }, [activePanel]);

  const handleRefreshLicenses = useCallback(() => {
    setLicensesLoading(true);
    post({ type: 'requestLicenses' });
  }, []);

  // `toVersion` lets the drawer offer the in-range upgrade as well as the
  // latest; the table's Update button has only one target and omits it.
  const handleUpdate = useCallback((dep: Dependency, toVersion?: string) => {
    const target = toVersion ?? dep.latest;
    if (!target) return;
    post({ type: 'update', depKey: dep.key, toVersion: target });
  }, []);

  const handleUninstall = useCallback((dep: Dependency) => {
    post({ type: 'uninstall', depKey: dep.key });
  }, []);

  const handleUninstallByName = useCallback(
    (name: string, ecosystem: Ecosystem, manifestPath: string) => {
      for (const group of groups) {
        if (group.manifestPath !== manifestPath) continue;
        const dep = group.dependencies.find(
          (candidate) =>
            candidate.name === name && candidate.ecosystem === ecosystem,
        );
        if (dep) {
          post({ type: 'uninstall', depKey: dep.key });
          return;
        }
      }
    },
    [groups],
  );

  const handleSelect = useCallback(
    (dep: Dependency) => {
      setRevealSection('details');
      setSelectedKey(dep.key === selectedKey ? undefined : dep.key);
    },
    [selectedKey],
  );

  // A command asked to reveal a row; once the table has moved there, forget it,
  // or the next unrelated re-render would drag the viewport back.
  const handleScrollHandled = useCallback(() => setScrollToKey(undefined), []);

  const duplicatesPanel =
    activePanel === 'duplicates' ? (
      <DuplicatesPanel
        results={duplicateResults}
        loading={duplicatesLoading}
        onClose={closePanel}
      />
    ) : null;

  const licensesPanel =
    activePanel === 'licenses' ? (
      <LicenseSummaryPanel
        summary={licenseSummary}
        loading={licensesLoading}
        onRefresh={handleRefreshLicenses}
        onClose={closePanel}
      />
    ) : null;

  const dependencyDiffPanel =
    activePanel === 'diff' ? (
      <DependencyDiffPanel
        gitRef={dependencyDiffRef}
        results={dependencyDiffResults}
        onCompareAgain={() => post({ type: 'requestDependencyDiff' })}
        onClose={closePanel}
      />
    ) : null;

  const searchPanel =
    activePanel === 'search' ? (
      <SearchInstall
        groups={groups}
        results={searchResults}
        error={searchError}
        partialFailure={searchPartial}
        searching={searching}
        onSearch={handleSearch}
        onInstall={(name, version, scope, manifestPath) =>
          post({ type: 'install', name, version, scope, manifestPath })
        }
        onUninstall={handleUninstallByName}
        onClose={closePanel}
      />
    ) : null;

  // Rendered only when there is something to say — an always-present wrapper
  // would leave a strip of padding above the table.
  const banners = (error || notice) && (
    <div className="banners">
      {error && (
        <div className="callout callout--error banner" role="alert">
          <div className="banner__text">
            {error}
            {errors.length > 1 && (
              <span className="muted">
                {' '}
                and {errors.length - 1} earlier{' '}
                {errors.length === 2 ? 'error' : 'errors'}
              </span>
            )}
          </div>
          <button
            type="button"
            className="ghost"
            // Dismissing shows the one behind it rather than clearing the lot,
            // so a queued error still gets read.
            aria-label={
              errors.length > 1
                ? 'Dismiss error and show the previous one'
                : 'Dismiss error'
            }
            onClick={() => setErrors((current) => current.slice(0, -1))}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {notice && (
        <div className="callout callout--info banner" role="status">
          <div className="banner__text">{notice}</div>
          <button
            type="button"
            className="ghost"
            aria-label="Dismiss notice"
            onClick={() => setNotice(undefined)}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
    </div>
  );

  /*
   * A workspace with no manifests at all.
   *
   * Registry search still works here — only *installing* needs a manifest — so
   * the empty state carries its own way in. The toolbar, which is the only
   * other thing that can open the panel, is deliberately not rendered in this
   * branch, and without a button here the feature was reachable only from the
   * command palette.
   */
  if (groups.length === 0 && loaded && !busy) {
    return (
      // Banners above the search panel, as in the main branch below. They used
      // to swap places between the two, so an error moved down the screen when
      // the workspace happened to have no manifests.
      <div className="app">
        {banners}
        {searchPanel}
        <div className="empty">
          <h2>No dependency manifests found</h2>
          <p>
            Orizzonte looks for package.json, pyproject.toml, requirements.txt,
            Cargo.toml, go.mod, composer.json, pom.xml, build.gradle and
            build.gradle.kts anywhere in this workspace.
          </p>
          <div className="empty__actions">
            <button
              type="button"
              className="empty__action"
              onClick={() => post({ type: 'refresh' })}
            >
              Scan again
            </button>
            {activePanel !== 'search' && (
              <button
                type="button"
                className="empty__action secondary"
                onClick={() => setActivePanel('search')}
              >
                Search packages
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar
        groups={groups}
        filterRef={filterRef}
        filters={filters}
        onFiltersChange={setFilters}
        summary={summary}
        busy={busy}
        busyLabel={busyLabel}
        activePanel={activePanel}
        onToggleInstall={() => togglePanel('search')}
        onToggleDuplicates={() => togglePanel('duplicates')}
        onToggleLicenses={() => togglePanel('licenses')}
        onCompareDependencies={() => post({ type: 'requestDependencyDiff' })}
        onExportReport={() => post({ type: 'exportReport' })}
        onRefresh={() => post({ type: 'refresh' })}
        onCheckUpdates={() => post({ type: 'checkUpdates' })}
        // No manifest means "the user has not chosen a project yet"; the host
        // asks. Substituting `groups[0]` here is what made the global button
        // update one project while claiming to update them all.
        onUpdateAll={(manifestPath) =>
          post({ type: 'updateAll', manifestPath })
        }
      />

      {banners}

      {searchPanel}
      {duplicatesPanel}
      {licensesPanel}
      {dependencyDiffPanel}

      <div className="app__body">
        <div className="app__main">
          <DepTable
            groups={filteredGroups}
            metaVersions={metaVersionsRef.current}
            sort={sort}
            onSortChange={setSort}
            selectedKey={selectedKey}
            onSelect={handleSelect}
            onUpdate={handleUpdate}
            onUninstall={handleUninstall}
            onUpdateAll={(manifestPath) =>
              post({ type: 'updateAll', manifestPath })
            }
            selectedDepKeys={selectedDepKeys}
            onToggleSelectDep={handleToggleSelectDep}
            onToggleSelectAll={handleToggleSelectAll}
            onBulkUpdateSelected={handleBulkUpdateSelected}
            onBulkRemoveSelected={handleBulkRemoveSelected}
            scrollToKey={scrollToKey}
            onScrollHandled={handleScrollHandled}
            busy={busy}
            loading={!loaded || (busy && groups.length === 0)}
            filtering={isFiltering(filters)}
            onClearFilters={() => setFilters(defaultFilters())}
          />
        </div>

        {selected && (
          <DetailDrawer
            dep={selected}
            why={whyByKey[selected.key]}
            changelogEntries={changelogByKey[selected.key]}
            changelogLoaded={selected.key in changelogByKey}
            reveal={revealSection}
            busy={busy}
            onClose={() => setSelectedKey(undefined)}
            onUpdate={handleUpdate}
            onUninstall={handleUninstall}
          />
        )}
      </div>
    </div>
  );
}
