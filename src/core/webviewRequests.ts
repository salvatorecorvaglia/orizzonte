/**
 * The decisions the host makes about a webview message *before* it acts on it:
 * which manifest is real, which row a key names, which of a bulk selection
 * still exists and passes its provider's grammar.
 *
 * These are the trust boundary. Messages from the webview name a manifest by
 * path and a dependency by key, and neither is ours to take at face value — a
 * path becomes a command's working directory and a file the editor opens, and
 * a version becomes an argument on a command line.
 *
 * They lived inside `PanelManager`, which imports `vscode` and therefore
 * cannot be loaded outside the editor at all. That made the one part of that
 * file worth testing directly the part reachable only through a full
 * integration run. Nothing here imports `vscode`, for the same reason
 * `scanQueue.ts` and `vocabulary.ts` do not.
 */

import type { Dependency, DepScope, ProjectGroup } from './types.js';

/** The shape these helpers need from a scan result. */
export interface ResolvedScan {
  groups: ProjectGroup[];
  manifestPaths: string[];
}

/**
 * True when `manifestPath` is one the last scan actually found.
 *
 * Checked against every manifest parsed, not only those that became groups: a
 * workspace root declaring members but no dependencies of its own has no rows
 * to show and so never becomes one, but it is still a file the scan found —
 * and it used to be the single manifest nothing could be installed into.
 */
export function isKnownManifest(
  scan: ResolvedScan,
  manifestPath: string,
): boolean {
  return scan.manifestPaths.includes(manifestPath);
}

/** The dependency a key names, with the group holding it. */
export function findDependency(
  scan: Pick<ResolvedScan, 'groups'>,
  depKey: string | undefined,
): { group: ProjectGroup; dep: Dependency } | undefined {
  if (!depKey) return undefined;
  for (const group of scan.groups) {
    const dep = group.dependencies.find(
      (candidate) => candidate.key === depKey,
    );
    if (dep) return { group, dep };
  }
  return undefined;
}

/** Where a package is already declared, if anywhere. */
export interface InstalledLocation {
  manifestPath: string;
  projectLabel: string;
  declared: string;
  scope: DepScope;
}

/**
 * Indexes the workspace by `ecosystem::name`, so annotating search results is
 * a lookup per result rather than a walk of every dependency per result.
 *
 * Search runs on what the user types, and the workspace can hold thousands of
 * packages; the walk made that product the cost of every keystroke-driven
 * search, for an answer a map gives directly.
 */
export function indexInstalledPackages(
  groups: ProjectGroup[],
): Map<string, InstalledLocation[]> {
  const index = new Map<string, InstalledLocation[]>();
  for (const group of groups) {
    for (const dep of group.dependencies) {
      const identity = `${dep.ecosystem}::${dep.name}`;
      const entry: InstalledLocation = {
        manifestPath: group.manifestPath,
        projectLabel: group.label,
        declared: dep.declared,
        scope: dep.scope,
      };
      const existing = index.get(identity);
      if (existing) existing.push(entry);
      else index.set(identity, [entry]);
    }
  }
  return index;
}

/**
 * The subset of a bulk update the host will actually run.
 *
 * Both halves of each target arrive from the webview and neither is more
 * trusted here than in the single-package path: a row the table no longer
 * holds is dropped, and so is a version that does not pass its provider's
 * grammar. Filtering before anything is confirmed is what keeps the
 * confirmation dialog's count honest — it should name what will run, not what
 * was asked for.
 */
export function resolveBulkUpdateTargets(
  scan: Pick<ResolvedScan, 'groups'>,
  targets: Array<{ depKey: string; toVersion: string }>,
  isValidVersion: (dep: Dependency, version: string) => boolean,
): Array<{ dep: Dependency; toVersion: string }> {
  const resolved: Array<{ dep: Dependency; toVersion: string }> = [];
  for (const target of targets) {
    const dep = findDependency(scan, target.depKey)?.dep;
    if (!dep) continue;
    if (!isValidVersion(dep, target.toVersion)) continue;
    resolved.push({ dep, toVersion: target.toVersion });
  }
  return resolved;
}

/** The rows a bulk uninstall names that the table still holds. */
export function resolveBulkUninstallTargets(
  scan: Pick<ResolvedScan, 'groups'>,
  depKeys: string[],
): Dependency[] {
  return depKeys
    .map((key) => findDependency(scan, key)?.dep)
    .filter((dep): dep is Dependency => dep !== undefined);
}
