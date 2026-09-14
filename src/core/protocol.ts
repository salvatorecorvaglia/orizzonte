/**
 * The single source of truth for host <-> webview messaging.
 *
 * Both sides import these types, so a mismatch is a compile error rather than a
 * runtime surprise. Like `types.ts`, this file must not import `vscode`.
 */

import type {
  ChangelogEntry,
  DepNode,
  DepScope,
  Ecosystem,
  LicenseSummary,
  PackageMeta,
  ProjectDependencyDiff,
  ProjectDuplicateVersions,
  ProjectGroup,
  ScanSummary,
  SearchResult,
} from './types.js';

/** Messages the webview sends to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'checkUpdates' }
  | {
      type: 'search';
      query: string;
      ecosystem: Ecosystem | 'all';
      requestId: string;
    }
  | { type: 'cancelSearch'; requestId: string }
  | {
      type: 'install';
      name: string;
      version: string | null;
      scope: DepScope;
      manifestPath: string;
    }
  | { type: 'update'; depKey: string; toVersion: string }
  /**
   * Bulk update for one project, or — with no `manifestPath` — for a project
   * the user has yet to choose.
   *
   * The toolbar's global button counts outdated packages across the whole
   * workspace, so it cannot name a single manifest without picking one
   * arbitrarily. Omitting the path routes through the same quick-pick the
   * `orizzonte.updateAll` command uses.
   */
  | { type: 'updateAll'; manifestPath?: string }
  | { type: 'uninstall'; depKey: string }
  /*
   * Bulk actions are one message, not one per package.
   *
   * The host handles messages concurrently (`void this.handleMessage(...)`), so
   * a selection of ten packages posted as ten `update` messages produced ten
   * overlapping handlers: ten modal confirmations stacked on each other, and
   * ten `TerminalRunner.run` calls interleaving on a terminal that is a single
   * shared resource. Carrying the whole selection lets the host confirm once
   * and run the commands in order.
   */
  | {
      type: 'bulkUpdate';
      targets: Array<{ depKey: string; toVersion: string }>;
    }
  | { type: 'bulkUninstall'; depKeys: string[] }
  | { type: 'requestDetails'; depKey: string }
  | { type: 'requestWhy'; depKey: string }
  /**
   * Checks every project's lockfile for packages resolved at more than one
   * version at once. Unscoped, unlike `requestWhy`: it is a read-only,
   * local-only check (no registry call), so there is no per-project ambiguity
   * to resolve the way a mutating action like `updateAll` has.
   */
  | { type: 'requestDuplicates' }
  /**
   * Fetches license metadata for every unique package across the workspace
   * and groups them against `orizzonte.licenseAllowList`/`licenseDenyList`.
   *
   * Unlike `requestDuplicates` this does reach the network — once per unique
   * package, cached the same as any other metadata fetch — so unlike the
   * duplicate-version check it is not re-run automatically on every rescan,
   * only when the user opens the panel or asks it to refresh.
   */
  | { type: 'requestLicenses' }
  /** GitHub releases between a dependency's installed and target version. */
  | { type: 'requestChangelog'; depKey: string }
  /**
   * Compares every project's lockfile against a Git ref the user picks from
   * a native quick-pick — there is no webview form for ref selection, the
   * same reasoning `orizzonte.updateAll`'s project quick-pick already follows.
   */
  | { type: 'requestDependencyDiff' }
  | { type: 'exportReport' }
  | { type: 'openExternal'; url: string }
  | { type: 'openManifest'; manifestPath: string; packageName?: string };

/** Messages the extension host sends to the webview. */
export type HostMessage =
  | { type: 'state'; groups: ProjectGroup[]; summary: ScanSummary }
  /**
   * Lazily fetched metadata for one package.
   *
   * Deliberately narrower than `state`: re-posting the whole list when the
   * drawer fills in a size or a licence would resort the table under the
   * pointer of the user who just clicked a row.
   */
  | { type: 'depDetails'; depKey: string; meta: PackageMeta }
  | { type: 'scanning'; busy: boolean; label?: string }
  /**
   * `failed` names registries that did not answer. A partial result is still
   * worth showing, but silently omitting a whole ecosystem would leave the user
   * concluding the package does not exist.
   */
  | {
      type: 'searchResults';
      requestId: string;
      results: SearchResult[];
      failed: Ecosystem[];
    }
  | { type: 'searchError'; requestId: string; message: string }
  | {
      type: 'whyTree';
      depKey: string;
      roots: DepNode[];
      source: 'lockfile' | 'registry';
    }
  | { type: 'duplicateVersions'; results: ProjectDuplicateVersions[] }
  | { type: 'licenseSummary'; summary: LicenseSummary }
  /**
   * `entries` is undefined when the dependency's repository is not on
   * GitHub — nothing to show, not a failure; an `error` message covers an
   * actual fetch failure instead.
   */
  | {
      type: 'changelogEntries';
      depKey: string;
      entries: ChangelogEntry[] | undefined;
    }
  | {
      type: 'dependencyDiff';
      /** The Git ref everything was compared against, for the panel's heading. */
      ref: string;
      results: ProjectDependencyDiff[];
    }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string }
  /** Opens the registry search UI — fired by the `orizzonte.searchInstall` command. */
  | { type: 'focusSearch' }
  /**
   * Selects a package and opens its detail drawer on the "why" section — fired
   * by `orizzonte.showWhy`, including from the tree view's context menu.
   */
  | { type: 'focusDependency'; depKey: string; reveal: 'details' | 'why' };

/**
 * The subset of the VS Code webview API we use. Declared here so the React app
 * has a type for `acquireVsCodeApi()` without pulling in `@types/vscode`.
 */
export interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}
