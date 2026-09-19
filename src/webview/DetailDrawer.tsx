/**
 * The per-package detail panel: metadata, advisories, and the reverse
 * dependency tree that answers "why is this here?".
 */

import { useEffect, useRef } from 'react';
import type { ChangelogEntry, Dependency, DepNode } from '../core/types.js';
import {
  currentVersion,
  declaredLabel,
  hasUpdate,
  scopeLabel,
} from '../core/vocabulary.js';
import { ECOSYSTEM_LABELS, formatBytes, formatDate } from './format.js';
import { Icon } from './Icon.js';
import { useDismissableOverlay } from './useDismissableOverlay.js';
import { post } from './vscodeApi.js';

interface Props {
  dep: Dependency;
  why: { roots: DepNode[]; source: 'lockfile' | 'registry' } | undefined;
  /**
   * Undefined and `changelogLoaded: false` means "not answered yet";
   * undefined with `changelogLoaded: true` means the host looked and found
   * nothing to show (not a GitHub repository) — the two read differently
   * because only the second means there is nothing left to wait for.
   */
  changelogEntries: ChangelogEntry[] | undefined;
  changelogLoaded: boolean;
  /** Which section the command that opened this drawer wants to land on. */
  reveal: 'details' | 'why';
  /**
   * True while a scan or a write is in flight.
   *
   * The drawer offers the same writes the row does, so it takes the same busy
   * rule — otherwise a scan blocked Update in the table and left the identical
   * button live one panel to the right. Links, metadata and the Why tree are
   * reads and stay available.
   */
  busy?: boolean;
  onClose: () => void;
  /** `toVersion` defaults to `latest` when the caller does not name one. */
  onUpdate: (dep: Dependency, toVersion?: string) => void;
  onUninstall: (dep: Dependency) => void;
}

export function DetailDrawer({
  dep,
  why,
  changelogEntries,
  changelogLoaded,
  reveal,
  busy = false,
  onClose,
  onUpdate,
  onUninstall,
}: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const whyRef = useRef<HTMLElement>(null);
  const handleKeyDown = useDismissableOverlay(onClose);

  // Metadata and the dependency tree are fetched lazily — pulling them for
  // every row up front would mean thousands of needless registry calls.
  useEffect(() => {
    post({ type: 'requestDetails', depKey: dep.key });
    post({ type: 'requestWhy', depKey: dep.key });
  }, [dep.key]);

  /*
   * "Why Is This Installed?" opens this drawer specifically to answer that
   * question, but the Why tree is the last section — without this the user
   * lands at the top and has to go looking for what they asked for.
   *
   * `dep.key` is in the dependency list so that asking "why" about a second
   * package reveals the section again rather than leaving the drawer wherever
   * the previous package left it.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (reveal === 'why') {
      // Focused as well as scrolled to. `useDismissableOverlay` listens on the
      // drawer's own element, so a drawer nothing has focused cannot hear the
      // Escape that closes it — which is what opening straight to the Why
      // section used to do.
      whyRef.current?.scrollIntoView({ block: 'start' });
      whyRef.current?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [reveal, dep.key]);

  const openLink = (url: string) => post({ type: 'openExternal', url });
  const { homepage, repository, changelogUrl } = dep.meta ?? {};

  return (
    <aside
      className="drawer"
      aria-label={`Details for ${dep.name}`}
      onKeyDown={handleKeyDown}
    >
      <div className="drawer__title">
        {/* Focusable so opening the drawer moves the caret somewhere sensible. */}
        <h2 ref={headingRef} tabIndex={-1}>
          {dep.name}
        </h2>
        <button
          type="button"
          className="ghost"
          onClick={onClose}
          aria-label="Close details"
        >
          <Icon name="close" />
        </button>
      </div>

      <div className="muted drawer__subtitle">
        {ECOSYSTEM_LABELS[dep.ecosystem]} · {dep.projectLabel}
      </div>

      {dep.meta?.deprecated && (
        <div className="callout callout--warn">
          <strong>Deprecated.</strong> {dep.meta.deprecated}
        </div>
      )}

      {dep.lookupFailed && (
        <div className="callout callout--info">
          Could not reach the registry for this package, so version information
          may be missing or out of date.
        </div>
      )}

      {dep.meta?.description && (
        <p className="drawer__desc">{dep.meta.description}</p>
      )}

      <section>
        <h3>Versions</h3>
        <dl>
          <dt>Declared</dt>
          <dd>
            <code>{declaredLabel(dep)}</code>
          </dd>
          <dt>Scope</dt>
          <dd>{scopeLabel(dep, 'long')}</dd>
          <dt>Installed</dt>
          <dd>
            <code>{currentVersion(dep)}</code>
          </dd>
          {dep.wanted && dep.wanted !== dep.installed && (
            <>
              <dt title="Highest version allowed by the declared range">
                Wanted
              </dt>
              <dd>
                <code>{dep.wanted}</code>
              </dd>
            </>
          )}
          <dt>Latest</dt>
          <dd>
            <code>{dep.latest ?? '—'}</code>
          </dd>
        </dl>

        {/*
         * Two upgrades are worth offering, because they answer different
         * questions. `wanted` is the highest version the declared range already
         * allows — it needs no manifest change and cannot break the build by
         * definition — while `latest` may cross a major boundary. Showing only
         * the second meant the safe upgrade was computed, displayed, and then
         * left to be applied by hand.
         */}
        <div className="drawer__actions">
          {dep.wanted &&
            dep.wanted !== dep.installed &&
            dep.wanted !== dep.latest && (
              <button
                type="button"
                className="drawer__action secondary"
                disabled={busy}
                onClick={() => onUpdate(dep, dep.wanted)}
              >
                Update to {dep.wanted}
              </button>
            )}
          {dep.latest &&
            dep.updateKind !== 'none' &&
            dep.updateKind !== 'unknown' && (
              <button
                type="button"
                className="drawer__action"
                disabled={busy}
                onClick={() => onUpdate(dep, dep.latest)}
              >
                Update to {dep.latest}
                {dep.updateKind === 'major' ? ' (major)' : ''}
              </button>
            )}
        </div>
      </section>

      {/*
       * Only offered alongside an actual update — a package already current
       * has no "between" to show — and only once a repository is known,
       * which `changelogLoaded` distinguishes from "checked, and it isn't
       * on GitHub" (the section stays hidden for the latter).
       */}
      {hasUpdate(dep) &&
        dep.meta?.repository &&
        (!changelogLoaded || changelogEntries) && (
          <section>
            <h3>What&rsquo;s changed</h3>
            {!changelogLoaded ? (
              <div className="muted">Loading…</div>
            ) : changelogEntries!.length === 0 ? (
              <div className="muted">
                No release notes found for this update.
              </div>
            ) : (
              <div className="changelog">
                {changelogEntries!.map((entry) => (
                  <div className="changelog__entry" key={entry.url}>
                    <div className="changelog__entry-header">
                      <button
                        type="button"
                        className="link"
                        onClick={() => openLink(entry.url)}
                      >
                        {entry.title ?? entry.version}
                      </button>
                      {entry.publishedAt && (
                        <span className="muted">
                          {formatDate(entry.publishedAt)}
                        </span>
                      )}
                    </div>
                    <div className="changelog__entry-body">
                      {entry.body || 'No description provided.'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

      <section>
        <h3>Package</h3>
        <dl>
          <dt>Size</dt>
          <dd>{formatBytes(dep.meta?.sizeBytes)}</dd>
          {dep.meta?.license && (
            <>
              <dt>License</dt>
              <dd>{dep.meta.license}</dd>
            </>
          )}
          {dep.meta?.author && (
            <>
              <dt>Author</dt>
              <dd>{dep.meta.author}</dd>
            </>
          )}
        </dl>

        <div className="drawer__links">
          {homepage && (
            <button
              type="button"
              className="link"
              onClick={() => openLink(homepage)}
            >
              Homepage
            </button>
          )}
          {repository && (
            <button
              type="button"
              className="link"
              onClick={() => openLink(repository)}
            >
              Repository
            </button>
          )}
          {changelogUrl && (
            <button
              type="button"
              className="link"
              onClick={() => openLink(changelogUrl)}
            >
              Changelog
            </button>
          )}
          <button
            type="button"
            className="link"
            onClick={() =>
              post({
                type: 'openManifest',
                manifestPath: dep.manifestPath,
                packageName: dep.name,
              })
            }
          >
            Open manifest
          </button>
        </div>
      </section>

      {dep.vulnerabilities.length > 0 && (
        <section>
          <h3>Security ({dep.vulnerabilities.length})</h3>
          {/*
           * Advisories are matched against the resolved version. When no
           * lockfile pinned one we compared against the constraint's lower
           * bound, which may name a version nobody actually installed — so the
           * result is worth reading, but not worth stating as fact.
           */}
          {dep.installedIsApproximate && (
            <div className="callout callout--info">
              No lockfile pins a version for this package, so these advisories
              were matched against <code>{currentVersion(dep)}</code>, inferred
              from <code>{dep.declared}</code>. Install the project to check
              against what you actually have.
            </div>
          )}
          {/*
           * Ordered worst-first by `core/audit`, so the advisory that decides
           * what you do about this package is the one you read first.
           */}
          {dep.vulnerabilities.map((vuln) => (
            <div
              key={vuln.id}
              className={`callout callout--error severity-${vuln.severity}`}
            >
              <div>
                {/*
                 * A dot carrying the severity colour. Every advisory used the
                 * same red callout, so `critical` and `low` were told apart by
                 * one word of uppercase text and nothing else.
                 */}
                <span className="severity-dot" aria-hidden="true" />
                <strong>{vuln.severity.toUpperCase()}</strong>
                {/*
                 * Said out loud when the rating is ours rather than the
                 * advisory's — most often a CVSS v4.0 vector, which has no
                 * closed-form score. Presenting that as a plain "MODERATE"
                 * reads as a measured verdict on something nobody measured.
                 */}
                {vuln.severityUnknown && (
                  <span
                    className="muted"
                    title="This advisory reported no severity Orizzonte could read, so this is a conservative default rather than the advisory's own rating."
                  >
                    {' '}
                    (not reported)
                  </span>
                )}{' '}
                ·{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => openLink(vuln.url)}
                >
                  {vuln.id}
                </button>
              </div>
              <div className="callout__line">{vuln.summary}</div>
              {vuln.fixedVersion && (
                <div className="callout__line">
                  Fixed in <code>{vuln.fixedVersion}</code>
                </div>
              )}
              {vuln.aliases.length > 0 && (
                <div className="muted callout__aliases">
                  {vuln.aliases.join(', ')}
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {/*
       * The same actions the row offers, in the same words.
       *
       * The row has Update and Remove; the drawer had only Update, so
       * reading about a package and then deciding to remove it meant
       * closing the drawer and finding the row again — in a list the drawer may
       * have scrolled away from. These post the identical messages the row
       * does, including the host's confirmation prompt before an uninstall.
       *
       * Placed after Security and before the Why tree: you should have read any
       * advisory before you are offered Remove, and the tree can run long
       * enough to push these off the screen.
       */}
      <section>
        <h3>Manage</h3>
        <div className="drawer__actions">
          <button
            type="button"
            className="danger"
            title={`Remove ${dep.name} from this project`}
            disabled={busy}
            onClick={() => onUninstall(dep)}
          >
            Remove
          </button>
        </div>
      </section>

      <section ref={whyRef} tabIndex={-1}>
        <h3>Why is this installed?</h3>
        {why === undefined ? (
          <div className="muted">Resolving…</div>
        ) : why.roots.length === 0 ? (
          <div className="muted">
            No dependency graph available. Install the project to generate a
            lockfile and this will fill in.
          </div>
        ) : (
          <>
            <div className="muted drawer__why-source">
              {why.source === 'lockfile'
                ? 'From this project’s lockfile.'
                : 'Resolved from the registry — no local lockfile was found.'}
            </div>
            <div className="tree">
              <NodeList nodes={why.roots} depth={0} />
            </div>
          </>
        )}
      </section>
    </aside>
  );
}

function NodeList({ nodes, depth }: { nodes: DepNode[]; depth: number }) {
  // A hard stop keeps a pathological graph from locking up the renderer.
  if (depth > 8) {
    return (
      <ul>
        <li className="muted">…</li>
      </ul>
    );
  }

  return (
    <ul>
      {nodes.map((node) => (
        <li
          key={`${node.name}-${node.version ?? ''}-${node.requestedRange ?? ''}`}
        >
          {node.name}
          {node.version && <span className="muted"> {node.version}</span>}
          {node.requestedRange && (
            <span className="muted"> ({node.requestedRange})</span>
          )}
          {node.children.length > 0 && (
            <NodeList nodes={node.children} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}
