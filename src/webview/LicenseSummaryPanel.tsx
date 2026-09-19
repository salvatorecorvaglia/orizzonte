/**
 * Workspace-wide license summary: every unique package grouped by license,
 * checked against `orizzonte.licenseAllowList`/`licenseDenyList`.
 *
 * Unlike the duplicate-versions panel this reaches the network — once per
 * unique package — so it does not refetch itself on every scan; only the
 * explicit Refresh button does.
 */

import type { LicenseSummary } from '../core/types.js';
import { Icon } from './Icon.js';
import { OverlayPanel } from './OverlayPanel.js';

interface Props {
  /** Undefined until the first `requestLicenses` response arrives. */
  summary: LicenseSummary | undefined;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

export function LicenseSummaryPanel({
  summary,
  loading,
  onRefresh,
  onClose,
}: Props) {
  const groups = summary?.groups ?? [];
  const totalPackages = groups.reduce(
    (sum, group) => sum + group.packageNames.length,
    0,
  );
  const flaggedPackages = groups
    .filter((group) => group.flagged)
    .reduce((sum, group) => sum + group.packageNames.length, 0);

  return (
    <OverlayPanel
      id="orizzonte-licenses-panel"
      label="License summary"
      title="License summary"
      closeLabel="Close license summary"
      onClose={onClose}
      status={
        loading
          ? 'Checking package licenses'
          : summary
            ? `${totalPackages} package(s) across ${groups.length} license(s)`
            : ''
      }
      actions={
        <button
          type="button"
          className="secondary"
          onClick={onRefresh}
          disabled={loading}
          title="Re-check every package's license"
        >
          <Icon name="refresh" /> Refresh
        </button>
      }
    >
      {loading && !summary && (
        <div className="empty empty--inline">Checking package licenses…</div>
      )}

      {!loading && summary && groups.length === 0 && (
        <div className="empty">
          <h2>No packages to check</h2>
        </div>
      )}

      {!loading && flaggedPackages > 0 && (
        <div className="banners">
          <div className="callout callout--warn" role="alert">
            {flaggedPackages}{' '}
            {flaggedPackages === 1 ? 'package uses' : 'packages use'} a license
            your policy flags.
          </div>
        </div>
      )}

      {groups.map((group) => (
        <div className="search-result" key={group.license ?? '\u0000unknown'}>
          <div className="search-result__info">
            <div className="search-result__name">
              <span>{group.license ?? 'Unknown license'}</span>
              {/*
                Not the vulnerability red: a license your policy disallows is a
                policy fact, not an advisory, and this marker used to disagree
                with the `callout--warn` banner directly above it about which
                colour that state is.
              */}
              {group.flagged && (
                <span className="severity--flagged">
                  <Icon name="warning" /> flagged
                </span>
              )}
              <span className="badge badge--muted">
                {group.packageNames.length}{' '}
                {group.packageNames.length === 1 ? 'package' : 'packages'}
              </span>
            </div>
            <div className="search-result__desc">
              {group.packageNames.join(', ')}
            </div>
          </div>
        </div>
      ))}
    </OverlayPanel>
  );
}
