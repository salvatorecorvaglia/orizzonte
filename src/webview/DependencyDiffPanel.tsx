/**
 * What a Git ref's lockfiles say the workspace would gain, lose, or change
 * versions on, compared with what is on disk right now.
 *
 * The ref itself is chosen through a native VS Code quick-pick, not webview
 * UI — this panel only ever renders a result that already named one.
 *
 * The added/removed/changed badges read from their own palette rather than the
 * severity ramp. They used to borrow it — removed was the red `badge--vuln` —
 * which put the colour `theme.css` reserves for "vulnerable" on a package that
 * is merely absent from the other branch.
 */

import type { ProjectDependencyDiff } from '../core/types.js';
import { ECOSYSTEM_LABELS } from './format.js';
import { Icon } from './Icon.js';
import { OverlayPanel } from './OverlayPanel.js';

interface Props {
  gitRef: string | undefined;
  results: ProjectDependencyDiff[] | undefined;
  onCompareAgain: () => void;
  onClose: () => void;
}

export function DependencyDiffPanel({
  gitRef,
  results,
  onCompareAgain,
  onClose,
}: Props) {
  const checked = (results ?? []).filter((entry) => entry.checked);
  const unchecked = [
    ...new Set(
      (results ?? [])
        .filter((entry) => !entry.checked)
        .map((entry) => entry.ecosystem),
    ),
  ];
  const withChanges = checked.filter(
    (entry) =>
      entry.added.length > 0 ||
      entry.removed.length > 0 ||
      entry.changed.length > 0,
  );

  return (
    <OverlayPanel
      id="orizzonte-dependency-diff-panel"
      label="Dependency changes"
      title={gitRef ? `Comparing with ${gitRef}` : 'Dependency changes'}
      closeLabel="Close dependency changes"
      onClose={onClose}
      actions={
        <button type="button" className="secondary" onClick={onCompareAgain}>
          <Icon name="git-compare" /> Compare with…
        </button>
      }
    >
      {unchecked.length > 0 && (
        <div className="banners">
          <div className="callout callout--info" role="status">
            No lockfile Orizzonte can diff for{' '}
            {unchecked.map((id) => ECOSYSTEM_LABELS[id]).join(', ')} projects.
          </div>
        </div>
      )}

      {withChanges.length === 0 && (
        <div className="empty">
          <h2>No dependency changes found</h2>
          <p>Every checked project resolves the same versions as {gitRef}.</p>
        </div>
      )}

      {withChanges.map((entry) => {
        const count =
          entry.added.length + entry.removed.length + entry.changed.length;
        return (
          <div key={entry.manifestPath}>
            <div className="table__group">
              <div className="table__group-cell">
                <span>{entry.projectLabel}</span>
                <span className="table__group-meta">
                  {count} {count === 1 ? 'change' : 'changes'}
                </span>
                <div className="table__group-spacer" />
              </div>
            </div>

            {entry.added.map((dep) => (
              <div className="search-result" key={`added-${dep.name}`}>
                <div className="search-result__info">
                  <div className="search-result__name">
                    <span className="badge badge--added">added</span>
                    <span>{dep.name}</span>
                    <span className="muted">{dep.after?.join(', ')}</span>
                  </div>
                </div>
              </div>
            ))}

            {entry.removed.map((dep) => (
              <div className="search-result" key={`removed-${dep.name}`}>
                <div className="search-result__info">
                  <div className="search-result__name">
                    <span className="badge badge--removed">removed</span>
                    <span>{dep.name}</span>
                    <span className="muted">{dep.before?.join(', ')}</span>
                  </div>
                </div>
              </div>
            ))}

            {entry.changed.map((dep) => (
              <div className="search-result" key={`changed-${dep.name}`}>
                <div className="search-result__info">
                  <div className="search-result__name">
                    <span className="badge badge--changed">changed</span>
                    <span>{dep.name}</span>
                    <span className="muted">
                      {dep.before?.join(', ')} → {dep.after?.join(', ')}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </OverlayPanel>
  );
}
