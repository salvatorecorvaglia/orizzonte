/**
 * The panel's read-only questions: registry search, a package's details, "why
 * is this installed", duplicate versions, the license summary, release notes,
 * and the branch comparison.
 *
 * Split from `PanelManager` along the line that matters — nothing here writes
 * anything. These handlers read the last scan, ask a registry or the local
 * filesystem, and post an answer back; none of them can change a manifest, run
 * a command, or touch a terminal. What stays behind in the manager is the half
 * that can, which is also the half that has to confirm before it acts.
 *
 * Every request here is cancellable and supersedes its predecessor, so the
 * controllers live here too rather than being reached back into.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { fetchChangelog } from '../../core/changelog.js';
import {
  collectVersionsFrom,
  diffLockfileVersions,
  explainDependency,
  findDuplicateVersions,
} from '../../core/depGraph.js';
import { buildLicenseSummary } from '../../core/licensePolicy.js';
import type { HostMessage } from '../../core/protocol.js';
import type { Scanner, ScanResult } from '../../core/scanner.js';
import type { Dependency, Ecosystem, ProjectGroup } from '../../core/types.js';
import {
  findDependency,
  indexInstalledPackages,
} from '../../core/webviewRequests.js';
import type { ProviderContext } from '../../providers/provider.js';
import { providerFor } from '../../providers/registry.js';
import { mapWithConcurrency } from '../../providers/shared/concurrency.js';
import { findSingleRepository, gitFileReader, pickRef } from '../gitDiff.js';

/**
 * How many projects a workspace-wide local check looks at concurrently.
 *
 * These read and parse lockfiles, and the dependency diff also spawns `git
 * show` per project, so an unbounded `Promise.all` over a large monorepo was a
 * burst of dozens of parallel multi-megabyte parses and subprocesses. Matches
 * the fan-out the license check already uses.
 */
const LOCAL_SCAN_CONCURRENCY = 6;

export class PanelInspections implements vscode.Disposable {
  private readonly searches = new Map<string, AbortController>();
  /** The in-flight "why is this installed" resolution, if any. */
  private whyRequest: AbortController | undefined;
  /** The in-flight workspace-wide license check, if any. */
  private licenseRequest: AbortController | undefined;
  /**
   * The in-flight duplicate-version check, if any.
   *
   * It reads only the local filesystem, so there is no request to call off —
   * but there is still a *result* to suppress once the user has asked a second
   * time, which is what the other two panels already used their controller for.
   */
  private duplicatesRequest: AbortController | undefined;
  /** The in-flight dependency diff, if any. */
  private diffRequest: AbortController | undefined;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly scanner: Scanner,
    private readonly post: (message: HostMessage) => void,
    /** The last scan, read fresh on each call rather than captured once. */
    private readonly latest: () => ScanResult,
    /** Records which row the drawer last opened, for command-palette actions. */
    private readonly onSelected: (depKey: string) => void,
  ) {}

  private findDependency(
    depKey: string,
  ): { group: ProjectGroup; dep: Dependency } | undefined {
    return findDependency(this.latest(), depKey);
  }

  async handleSearch(
    query: string,
    ecosystem: Ecosystem | 'all',
    requestId: string,
  ): Promise<void> {
    // Supersede any in-flight search — the user has typed since.
    for (const [id, controller] of this.searches) {
      controller.abort();
      this.searches.delete(id);
    }

    const controller = new AbortController();
    this.searches.set(requestId, controller);

    try {
      const { results, failed } = await this.scanner.search(
        query,
        ecosystem,
        controller.signal,
      );

      /*
       * Annotate anything already present in a loaded manifest so the UI can
       * offer "uninstall" instead of "install".
       *
       * Indexed once rather than re-walked per result. This used to scan every
       * group and every dependency for each of up to 25 results across seven
       * ecosystems, so a workspace with a few thousand packages did close to a
       * million comparisons on every keystroke-driven search — for an answer
       * that is one map lookup.
       */
      const installedByPackage = indexInstalledPackages(this.latest().groups);

      for (const result of results) {
        const matches = installedByPackage.get(
          `${result.ecosystem}::${result.name}`,
        );
        if (matches && matches.length > 0) {
          result.installedIn = matches;
        }
      }

      if (!controller.signal.aborted) {
        // Nothing came back and nothing succeeded: that is a failure, not an
        // empty result set, and saying "no packages found" would be a lie.
        if (results.length === 0 && failed.length > 0) {
          this.post({
            type: 'searchError',
            requestId,
            message: `Could not reach ${failed.map(registryName).join(', ')}. Check your connection and try again.`,
          });
          return;
        }
        this.post({ type: 'searchResults', requestId, results, failed });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.post({
          type: 'searchError',
          requestId,
          message: describeError(error),
        });
      }
    } finally {
      this.searches.delete(requestId);
    }
  }

  async handleDetails(depKey: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found) return;

    // The webview requests details whenever a row opens, which makes this the
    // host's view of "what is selected" for command-palette actions.
    this.onSelected(depKey);

    try {
      const meta = await this.scanner.fetchDetails(found.dep);
      if (meta) {
        // Preserve any deprecation notice the version lookup already found.
        found.dep.meta = {
          ...meta,
          deprecated: meta.deprecated ?? found.dep.meta?.deprecated,
        };
        // Deliberately not a full `state` push: replacing the whole list would
        // re-sort it, and a row that gains a size while the table is sorted by
        // Size would move out from under the user who just clicked it.
        this.post({ type: 'depDetails', depKey, meta: found.dep.meta });
      }
    } catch (error) {
      this.post({ type: 'error', message: describeError(error) });
    }
  }

  async handleWhy(depKey: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found) return;

    // Clicking through rows quickly would otherwise leave every earlier
    // resolution running, and the registry fallback is the slowest call in the
    // extension.
    this.whyRequest?.abort();
    const controller = new AbortController();
    this.whyRequest = controller;

    try {
      const result = await explainDependency(
        found.dep,
        this.ctx,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      this.post({
        type: 'whyTree',
        depKey,
        roots: result.roots,
        source: result.source,
      });
    } catch (error) {
      // A superseded request is the expected outcome of clicking the next row,
      // not something to put in front of the user.
      if (controller.signal.aborted) return;
      this.post({ type: 'error', message: describeError(error) });
    }
  }

  /**
   * Checks every project's lockfile for packages resolved at more than one
   * version at once.
   *
   * Unlike `handleWhy` this touches only the local filesystem, so there is no
   * request to abort — but a second ask still supersedes the first, because
   * otherwise a slow answer can land after the panel has been closed and
   * reopened and overwrite the newer one.
   */
  async handleDuplicates(requestId: string): Promise<void> {
    this.duplicatesRequest?.abort();
    const controller = new AbortController();
    this.duplicatesRequest = controller;

    try {
      /*
       * A few at a time, not all at once.
       *
       * Every group here reads and parses a lockfile, and in a workspace they
       * all resolve the *same* one — so a fifty-project monorepo used to open
       * fifty concurrent reads of one multi-megabyte file. The shared memo
       * collapses that to a single read; the concurrency cap is what stops the
       * first pass through it being fifty parallel misses.
       */
      const ctx = this.lockfileScopedContext();
      const results = await mapWithConcurrency(
        this.latest().groups,
        LOCAL_SCAN_CONCURRENCY,
        async (group) => ({
          manifestPath: group.manifestPath,
          projectLabel: group.label,
          ecosystem: group.ecosystem,
          ...(await findDuplicateVersions(
            group.manifestPath,
            group.ecosystem,
            ctx,
          )),
        }),
      );

      if (controller.signal.aborted) return;
      this.post({ type: 'duplicateVersions', requestId, results });
    } catch (error) {
      if (controller.signal.aborted) return;
      // The panel has a spinner running; it needs telling, not just the banner.
      this.post({
        type: 'panelRequestFailed',
        requestId,
        message: describeError(error),
      });
    }
  }

  /**
   * Fetches license metadata for every unique package across the workspace
   * and groups them against the configured allow/deny list.
   *
   * Unlike `handleDuplicates` this does reach the network — once per unique
   * package — so, like `handleWhy`, a second request supersedes the first
   * rather than letting both race to post a result.
   */
  async handleLicenses(requestId: string): Promise<void> {
    this.licenseRequest?.abort();
    const controller = new AbortController();
    this.licenseRequest = controller;

    try {
      // Keyed by ecosystem+name so a package several projects share is only
      // ever fetched once, regardless of how many manifests declare it.
      const unique = new Map<string, { name: string; ecosystem: Ecosystem }>();
      for (const group of this.latest().groups) {
        for (const dep of group.dependencies) {
          unique.set(`${dep.ecosystem}::${dep.name}`, {
            name: dep.name,
            ecosystem: dep.ecosystem,
          });
        }
      }

      const packages: Array<{ name: string; license: string | undefined }> = [];
      await mapWithConcurrency([...unique.values()], 6, async (entry) => {
        if (controller.signal.aborted) return;
        try {
          const meta = await providerFor(entry.ecosystem).fetchMetadata(
            entry.name,
            this.ctx,
            controller.signal,
          );
          packages.push({ name: entry.name, license: meta?.license });
        } catch {
          packages.push({ name: entry.name, license: undefined });
        }
      });

      if (controller.signal.aborted) return;

      const config = vscode.workspace.getConfiguration('orizzonte');
      const summary = buildLicenseSummary(packages, {
        allow: config.get<string[]>('licenseAllowList', []),
        deny: config.get<string[]>('licenseDenyList', []),
      });
      this.post({ type: 'licenseSummary', requestId, summary });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.post({
        type: 'panelRequestFailed',
        requestId,
        message: describeError(error),
      });
    }
  }

  /**
   * GitHub releases between a dependency's installed and target version.
   *
   * `entries: undefined` covers "not a GitHub repository" and "details
   * have not been fetched yet, so there is no repository to check" — both
   * are "nothing to show", not a failure, so neither posts an `error`.
   */
  async handleChangelog(depKey: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found) return;

    const repository = found.dep.meta?.repository;
    const target = found.dep.latest;
    if (!repository || !target) {
      this.post({ type: 'changelogEntries', depKey, entries: undefined });
      return;
    }

    try {
      const entries = await fetchChangelog(
        repository,
        found.dep.installed,
        target,
        this.ctx,
      );
      this.post({ type: 'changelogEntries', depKey, entries });
    } catch (error) {
      this.post({ type: 'error', message: describeError(error) });
    }
  }

  /**
   * Compares every project's lockfile against a Git ref the user picks.
   *
   * The ref picker is a native quick-pick, not webview UI — the same reason
   * `orizzonte.updateAll`'s project picker is native — so this needs no
   * request/response round trip just to ask which ref, only to report back
   * once one is chosen (or nothing at all, if the picker was dismissed).
   */
  async handleDependencyDiff(requestId: string): Promise<void> {
    this.diffRequest?.abort();
    const controller = new AbortController();
    this.diffRequest = controller;

    const found = await findSingleRepository();
    if (!found.ok) {
      this.post({ type: 'notice', message: found.message });
      this.post({ type: 'panelRequestFailed', requestId });
      return;
    }

    const picked = await pickRef(found.repository);
    if (picked.status !== 'picked') {
      // A repository with nothing to compare against is worth saying out loud;
      // dismissing the picker is not, having been the user's own choice. Either
      // way the request is over and the panel must stop waiting on it.
      if (picked.status === 'none') {
        this.post({
          type: 'notice',
          message: 'This repository has no branches to compare against yet.',
        });
      }
      this.post({ type: 'panelRequestFailed', requestId });
      return;
    }
    const ref = picked.ref;

    try {
      const readAtRef = gitFileReader(found.repository, ref);
      // Bounded for the same reason the duplicate check is, and more so: each
      // group here spawns `git show` twice.
      const workingTree = this.lockfileScopedContext();
      const atRef = new Map<string, unknown>();
      const results = await mapWithConcurrency(
        this.latest().groups,
        LOCAL_SCAN_CONCURRENCY,
        async (group) => {
          const dir = path.dirname(group.manifestPath);
          const stopAt = workingTree.workspaceRootFor(dir);
          const [before, after] = await Promise.all([
            collectVersionsFrom(dir, group.ecosystem, readAtRef, stopAt, {
              store: atRef,
              namespace: 'diff-before',
            }),
            collectVersionsFrom(
              dir,
              group.ecosystem,
              (absolutePath) => workingTree.readFile(absolutePath),
              stopAt,
              workingTree.lockfileMemo && {
                store: workingTree.lockfileMemo,
                namespace: 'diff-after',
              },
            ),
          ]);
          return {
            manifestPath: group.manifestPath,
            projectLabel: group.label,
            ecosystem: group.ecosystem,
            ...diffLockfileVersions(before, after),
          };
        },
      );

      if (controller.signal.aborted) return;
      this.post({ type: 'dependencyDiff', requestId, ref, results });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.post({
        type: 'panelRequestFailed',
        requestId,
        message: describeError(error),
      });
    }
  }

  /**
   * A context carrying a memo shared by one panel request's lockfile reads.
   *
   * The panel's own context is long-lived, so it deliberately has none: a memo
   * of file contents that outlived the request would be a cache nobody
   * invalidates. Each request gets a fresh one instead.
   */
  private lockfileScopedContext(): ProviderContext {
    return { ...this.ctx, lockfileMemo: new Map<string, unknown>() };
  }

  /** Drops a search the user has moved on from. */
  cancelSearch(requestId: string): void {
    this.searches.get(requestId)?.abort();
    this.searches.delete(requestId);
  }

  /** Calls off every request whose answer nobody is waiting for any more. */
  abortInFlight(): void {
    this.whyRequest?.abort();
    this.licenseRequest?.abort();
    this.duplicatesRequest?.abort();
    this.diffRequest?.abort();
    for (const controller of this.searches.values()) controller.abort();
    this.searches.clear();
  }

  dispose(): void {
    this.abortInFlight();
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The name users know a registry by, which is rarely our ecosystem id. */
function registryName(ecosystem: Ecosystem): string {
  const names: Record<Ecosystem, string> = {
    node: 'npm',
    python: 'PyPI',
    cargo: 'crates.io',
    golang: 'the Go module proxy',
    composer: 'Packagist',
    maven: 'Maven Central',
    gradle: 'Maven Central',
  };
  return names[ecosystem];
}
