/**
 * Duplicate package versions: packages a project's lockfile resolves to more
 * than one version at once.
 *
 * Read-only and workspace-wide, unlike the search panel — there is nothing to
 * target, only something to look at — so it has no per-project picker of its
 * own; results are grouped by project instead.
 */

import type { ProjectDuplicateVersions } from '../core/types.js';
import { ECOSYSTEM_LABELS } from './format.js';
import { OverlayPanel } from './OverlayPanel.js';

interface Props {
  /** Undefined until the first `requestDuplicates` response arrives. */
  results: ProjectDuplicateVersions[] | undefined;
  loading: boolean;
  onClose: () => void;
}

export function DuplicatesPanel({ results, loading, onClose }: Props) {
  const checked = (results ?? []).filter((entry) => entry.checked);
  const unchecked = [
    ...new Set(
      (results ?? [])
        .filter((entry) => !entry.checked)
        .map((entry) => entry.ecosystem),
    ),
  ];
  const withDuplicates = checked.filter((entry) => entry.groups.length > 0);
  const totalDuplicates = withDuplicates.reduce(
    (sum, entry) => sum + entry.groups.length,
    0,
  );

  return (
    <OverlayPanel
      id="orizzonte-duplicates-panel"
      label="Duplicate package versions"
      title="Duplicate versions"
      closeLabel="Close duplicate versions"
      onClose={onClose}
      status={
        loading
          ? 'Checking lockfiles for duplicate versions'
          : results
            ? `${totalDuplicates} duplicated package(s) found`
            : ''
      }
    >
      {loading && !results && (
        <div className="empty empty--inline">Checking lockfiles…</div>
      )}

      {!loading && results && unchecked.length > 0 && (
        <div className="banners">
          <div className="callout callout--info" role="status">
            {unchecked.map((id) => ECOSYSTEM_LABELS[id]).join(', ')}{' '}
            {unchecked.length === 1 ? 'has' : 'have'} no lockfile Orizzonte can
            check for duplicates.
          </div>
        </div>
      )}

      {!loading && results && totalDuplicates === 0 && (
        <div className="empty">
          <h2>No duplicate versions found</h2>
          <p>
            Every checked project resolves each package to a single version.
          </p>
        </div>
      )}

      {withDuplicates.map((entry) => (
        <div key={entry.manifestPath}>
          <div className="table__group">
            <div className="table__group-cell">
              <span>{entry.projectLabel}</span>
              <span className="table__group-meta">
                {entry.groups.length} duplicated{' '}
                {entry.groups.length === 1 ? 'package' : 'packages'}
              </span>
              <div className="table__group-spacer" />
            </div>
          </div>
          {entry.groups.map((group) => (
            <div
              className="search-result"
              key={`${entry.manifestPath}:${group.name}`}
            >
              <div className="search-result__info">
                <div className="search-result__name">
                  <span>{group.name}</span>
                  {group.versions.map((version) => (
                    <span className="badge badge--muted" key={version}>
                      {version}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </OverlayPanel>
  );
}
