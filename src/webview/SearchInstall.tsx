/**
 * Registry search and install.
 *
 * The key interaction detail: when a result is already declared in one of the
 * open manifests, the primary action flips from Install to Remove, so the
 * button always does the thing that makes sense for the current state.
 *
 * Searching works with no manifests open — only installing needs somewhere to
 * install into, so the target selector is what goes empty, not the panel.
 */

import type { KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DepScope,
  Ecosystem,
  ProjectGroup,
  SearchResult,
} from '../core/types.js';
import { SCOPE_LABELS } from '../core/vocabulary.js';
import { ECOSYSTEM_LABELS, formatDownloads } from './format.js';
import { Icon } from './Icon.js';
import { useDismissableOverlay } from './useDismissableOverlay.js';

interface Props {
  groups: ProjectGroup[];
  results: SearchResult[];
  error: string | undefined;
  /** Registries that did not answer while others did. */
  partialFailure?: Ecosystem[];
  searching: boolean;
  onSearch: (query: string, ecosystem: Ecosystem | 'all') => void;
  onInstall: (
    name: string,
    version: string | null,
    scope: DepScope,
    manifestPath: string,
  ) => void;
  onUninstall: (
    name: string,
    ecosystem: Ecosystem,
    manifestPath: string,
  ) => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 300;

/** `peer` is omitted: no package manager installs into it from a CLI. */
const INSTALLABLE_SCOPES: DepScope[] = ['prod', 'dev', 'build', 'optional'];

export function SearchInstall({
  groups,
  results,
  error,
  partialFailure,
  searching,
  onSearch,
  onInstall,
  onUninstall,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const [ecosystem, setEcosystem] = useState<Ecosystem | 'all'>('all');
  const [scope, setScope] = useState<DepScope>('prod');
  const [targetManifest, setTargetManifest] = useState<string>(
    groups[0]?.manifestPath ?? '',
  );
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus lands in the search box on open and goes back where it came from on
  // close — the same contract as the detail drawer.
  const handlePanelKeyDown = useDismissableOverlay(onClose, () =>
    inputRef.current?.focus(),
  );

  // Ecosystems actually present in this workspace — offering PyPI in a pure Go
  // project would just be noise.
  const availableEcosystems = useMemo(
    () => [...new Set(groups.map((group) => group.ecosystem))],
    [groups],
  );

  // Keep the install target valid as the workspace changes underneath us.
  useEffect(() => {
    if (!groups.some((group) => group.manifestPath === targetManifest)) {
      setTargetManifest(groups[0]?.manifestPath ?? '');
    }
  }, [groups, targetManifest]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;

    const timer = setTimeout(() => onSearch(trimmed, ecosystem), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, ecosystem, onSearch]);

  /*
   * Enter searches now.
   *
   * The debounce is right for someone still typing and wrong for someone who
   * has finished: pressing Enter in a search box and having nothing happen for
   * a third of a second reads as the box being broken. Re-setting the query to
   * itself cannot restart the debounce, so this calls through directly.
   */
  const handleQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    event.preventDefault();
    onSearch(trimmed, ecosystem);
  };

  const selectedGroup = groups.find(
    (group) => group.manifestPath === targetManifest,
  );

  /*
   * A named <section>, since the toolbar's toggle points at this with
   * aria-controls and the target of that pointer should be findable. A section
   * with an accessible name is a region natively — same reasoning as the
   * fieldset around the filter chips.
   */
  return (
    <section
      className="search-panel"
      id="orizzonte-search-panel"
      aria-label="Package search"
      onKeyDown={handlePanelKeyDown}
    >
      <div className="toolbar">
        <div className="toolbar__row">
          <div className="toolbar__search">
            <input
              ref={inputRef}
              type="search"
              placeholder="Search registries to install a new package…"
              value={query}
              aria-label="Search registries"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleQueryKeyDown}
            />
          </div>

          {/*
            Visible labels, not just aria-labels.

            These three selects decide *where* and *how* a package gets
            installed, and unlabelled they read as "All registries | my-app |
            prod" — three bare values with nothing saying which is the target
            project and which is the scope. The name of a control that changes
            what a write does should not be discoverable only by screen reader.
          */}
          <label className="field">
            <span className="field__label">Registry</span>
            <select
              value={ecosystem}
              onChange={(event) =>
                setEcosystem(event.target.value as Ecosystem | 'all')
              }
            >
              <option value="all">All registries</option>
              {availableEcosystems.map((id) => (
                <option key={id} value={id}>
                  {ECOSYSTEM_LABELS[id]}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Install into</span>
            <select
              value={targetManifest}
              disabled={groups.length === 0}
              onChange={(event) => setTargetManifest(event.target.value)}
            >
              {groups.length === 0 && (
                <option value="">No project to install into</option>
              )}
              {groups.map((group) => (
                <option key={group.manifestPath} value={group.manifestPath}>
                  {group.label}
                </option>
              ))}
            </select>
          </label>

          {/* The same four words the table, the chips and the tree use. */}
          <label className="field">
            <span className="field__label">Scope</span>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as DepScope)}
            >
              {INSTALLABLE_SCOPES.map((id) => (
                <option key={id} value={id}>
                  {SCOPE_LABELS[id].short}
                </option>
              ))}
            </select>
          </label>

          {/* The toolbar's toggle is not on screen in the empty workspace
              state, so the panel carries its own way out. */}
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="Close package search"
          >
            <Icon name="close" />
          </button>
        </div>

        {query.trim().length > 0 && query.trim().length < 2 && (
          <div className="muted">Type at least two characters.</div>
        )}
      </div>

      <div className="visually-hidden" role="status">
        {searching
          ? 'Searching registries'
          : results.length > 0
            ? `${results.length} package(s) found`
            : ''}
      </div>

      {error && (
        <div className="banners">
          <div className="callout callout--error" role="alert">
            {error}
          </div>
        </div>
      )}

      {/*
       * Some registries answered and some did not. Results below are real but
       * incomplete, and saying so is the difference between "not published" and
       * "we could not check".
       */}
      {!error && partialFailure && partialFailure.length > 0 && (
        <div className="banners">
          <div className="callout callout--info" role="status">
            Could not reach{' '}
            {partialFailure.map((id) => ECOSYSTEM_LABELS[id]).join(', ')}, so
            these results may be incomplete.
          </div>
        </div>
      )}

      {searching && results.length === 0 && (
        <div className="empty empty--inline">Searching…</div>
      )}

      {!searching &&
        query.trim().length >= 2 &&
        results.length === 0 &&
        !error && (
          <div className="empty">
            <h2>No packages found</h2>
            <p>
              Note that Go and PyPI have no official search API — for those,
              type the exact module path or package name.
            </p>
          </div>
        )}

      {results.map((result) => {
        // Only count it as installed if it is in the manifest we would target.
        const installedHere = result.installedIn?.find(
          (entry) => entry.manifestPath === targetManifest,
        );
        const installedElsewhere = result.installedIn?.filter(
          (entry) => entry.manifestPath !== targetManifest,
        );
        const compatible =
          !selectedGroup || selectedGroup.ecosystem === result.ecosystem;
        const disabledReason = !targetManifest
          ? 'Open a project with a dependency manifest to install into'
          : compatible
            ? undefined
            : `${result.name} is a ${ECOSYSTEM_LABELS[result.ecosystem]} package and cannot go into ${selectedGroup?.label}`;
        const disabledReasonId = `install-reason-${result.ecosystem}-${result.name}`;

        return (
          <div
            className="search-result"
            key={`${result.ecosystem}:${result.name}`}
          >
            <div className="search-result__info">
              <div className="search-result__name">
                <span>{result.name}</span>
                {result.version && (
                  <span className="muted">{result.version}</span>
                )}
                <span className="badge">
                  {ECOSYSTEM_LABELS[result.ecosystem]}
                </span>
                {result.deprecated && (
                  <span className="severity--deprecated">
                    <Icon name="warning" /> deprecated
                  </span>
                )}
                {result.downloads !== undefined && (
                  <span className="muted">
                    {formatDownloads(result.downloads)} downloads
                  </span>
                )}
              </div>
              {result.description && (
                <div className="search-result__desc">{result.description}</div>
              )}
              {installedElsewhere && installedElsewhere.length > 0 && (
                <div className="search-result__elsewhere">
                  Already in{' '}
                  {installedElsewhere
                    .map((entry) => entry.projectLabel)
                    .join(', ')}
                </div>
              )}
            </div>

            <div className="search-result__actions">
              {installedHere ? (
                <>
                  <span className="muted">{installedHere.declared}</span>
                  {/* Same word the table uses for the same action. */}
                  <button
                    type="button"
                    className="danger"
                    onClick={() =>
                      onUninstall(result.name, result.ecosystem, targetManifest)
                    }
                  >
                    Remove
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={!compatible || !targetManifest}
                  title={disabledReason}
                  aria-describedby={
                    disabledReason ? disabledReasonId : undefined
                  }
                  onClick={() =>
                    onInstall(
                      result.name,
                      result.version || null,
                      scope,
                      targetManifest,
                    )
                  }
                >
                  Install
                </button>
              )}
              {disabledReason && (
                // A `title` tooltip only reaches a mouse hovering the button;
                // this is the same text reachable by keyboard/screen reader.
                <span id={disabledReasonId} className="visually-hidden">
                  {disabledReason}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
