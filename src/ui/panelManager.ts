/**
 * Owns the webview panel: its lifecycle, its HTML shell, and the message router
 * connecting the React app to the scanner, providers and terminal.
 *
 * Security posture: the webview loads only local scripts under a per-load nonce
 * and is given no network access at all (`connect-src 'none'`). Every registry
 * call happens in the extension host, which is also the only place that can
 * reach the filesystem or spawn a terminal.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { BusyTracker } from '../core/busyTracker.js';
import { fetchChangelog } from '../core/changelog.js';
import {
  collectVersionsFrom,
  diffLockfileVersions,
  explainDependency,
  findDuplicateVersions,
} from '../core/depGraph.js';
import { findDeclaration } from '../core/findDeclaration.js';
import { buildLicenseSummary } from '../core/licensePolicy.js';
import type { HostMessage, WebviewMessage } from '../core/protocol.js';
import type { Scanner, ScanResult } from '../core/scanner.js';
import type {
  Dependency,
  DepScope,
  Ecosystem,
  ProjectGroup,
} from '../core/types.js';
import { hasUpdate } from '../core/vocabulary.js';
import {
  findDependency,
  indexInstalledPackages,
  isKnownManifest,
  resolveBulkUninstallTargets,
  resolveBulkUpdateTargets,
} from '../core/webviewRequests.js';
import type { ProviderContext } from '../providers/provider.js';
import { validateVersion } from '../providers/provider.js';
import { providerFor, providerForPath } from '../providers/registry.js';
import { mapWithConcurrency } from '../providers/shared/concurrency.js';
import { DependencyMutator } from './dependencyMutator.js';
import { findSingleRepository, gitFileReader, pickRef } from './gitDiff.js';
import { TerminalRunner } from './terminalRunner.js';
import {
  buildContentSecurityPolicy,
  createNonce,
  openExternalUrl,
} from './webviewSecurity.js';

export class PanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private latest: ScanResult = {
    groups: [],
    manifestPaths: [],
    summary: {
      totalDependencies: 0,
      outdated: 0,
      vulnerable: 0,
      deprecated: 0,
      stale: false,
    },
  };
  private readonly searches = new Map<string, AbortController>();
  /** The in-flight "why is this installed" resolution, if any. */
  private whyRequest: AbortController | undefined;
  /** The in-flight workspace-wide license check, if any. */
  private licenseRequest: AbortController | undefined;
  private readonly terminal = new TerminalRunner();
  /*
   * Reference-counted rather than a boolean: a scan and a package-manager
   * command overlap routinely, and whichever finished first used to clear the
   * other's spinner. See `core/busyTracker.ts`.
   */
  private readonly busyState = new BusyTracker((busy, label) => {
    this.post({ type: 'scanning', busy, label });
  });
  /** False between creating a panel and the React app announcing itself. */
  private webviewReady = false;
  /**
   * A reveal requested before the webview finished loading.
   *
   * Opening the panel and telling it what to show happen in the same tick, but
   * a message posted to a webview that has not loaded yet is simply dropped —
   * which is how "click a package in the tree" used to open the panel on
   * nothing in particular.
   *
   * A list rather than one slot: two commands can land before the webview is
   * ready (open the search panel, then reveal a package), and a single slot
   * silently discarded the first.
   */
  private readonly pendingReveals: HostMessage[] = [];
  private readonly mutator: DependencyMutator;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly scanner: Scanner,
    private readonly ctx: ProviderContext,
    private readonly onStateChanged: (result: ScanResult) => void,
  ) {
    this.mutator = new DependencyMutator(
      ctx,
      this.terminal,
      (label) => this.beginBusy(label),
      (message) => this.post({ type: 'error', message }),
    );
  }

  get currentResult(): ScanResult {
    return this.latest;
  }

  /** Opens the panel, or reveals it if already open. */
  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'orizzonte.dependencies',
      'Orizzonte: Dependencies',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The table keeps sort/filter state, so rebuilding it on every tab
        // switch would be user-hostile.
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        ],
      },
    );

    this.panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      'resources',
      'orizzonte.svg',
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.webviewReady = false;
      this.pendingReveals.length = 0;
      for (const controller of this.searches.values()) {
        controller.abort();
      }
      this.searches.clear();
    });

    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      this.handleMessage(message).catch((error: unknown) => {
        this.post({ type: 'error', message: describeError(error) });
      });
    });
  }

  /** Pushes a new scan result to the webview and the tree view. */
  setResult(result: ScanResult): void {
    this.latest = result;
    this.post({
      type: 'state',
      groups: result.groups,
      summary: result.summary,
    });
    this.onStateChanged(result);
  }

  /**
   * Claims the busy state and returns the release for it. Callers pair the two
   * with a `finally` rather than remembering a matching "stop" call, and no
   * caller can clear a claim it does not hold.
   */
  beginBusy(label?: string): () => void {
    return this.busyState.begin(label);
  }

  /** Opens the panel with the registry search UI focused. */
  revealSearch(): void {
    this.reveal();
    this.postOrQueue({ type: 'focusSearch' });
  }

  /**
   * Opens the panel with a specific package selected. Used by the tree view's
   * "Why Is This Installed?" action, and by the command palette when a row is
   * already selected.
   */
  revealDependency(depKey: string, section: 'details' | 'why'): void {
    this.reveal();
    this.postOrQueue({ type: 'focusDependency', depKey, reveal: section });
  }

  /** The row most recently opened in the drawer, for command-palette actions. */
  get lastSelectedKey(): string | undefined {
    return this.selectedKey;
  }

  private selectedKey: string | undefined;

  private post(message: HostMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  /** Sends now if the webview can hear it, otherwise on its `ready`. */
  private postOrQueue(message: HostMessage): void {
    if (this.webviewReady) {
      this.post(message);
      return;
    }
    this.pendingReveals.push(message);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        this.webviewReady = true;
        this.post({
          type: 'state',
          groups: this.latest.groups,
          summary: this.latest.summary,
        });
        this.post({
          type: 'scanning',
          busy: this.busyState.busy,
          label: this.busyState.label,
        });
        // Anything asked for while the panel was still loading, replayed now
        // that there is something listening — and after `state`, so the row it
        // names already exists.
        for (const pending of this.pendingReveals.splice(0)) {
          this.post(pending);
        }
        return;
      }

      case 'refresh':
        await vscode.commands.executeCommand('orizzonte.refresh');
        return;

      case 'checkUpdates':
        await vscode.commands.executeCommand('orizzonte.checkUpdates');
        return;

      case 'exportReport':
        await vscode.commands.executeCommand('orizzonte.exportReport');
        return;

      case 'search':
        await this.handleSearch(
          message.query,
          message.ecosystem,
          message.requestId,
        );
        return;

      case 'cancelSearch': {
        this.searches.get(message.requestId)?.abort();
        this.searches.delete(message.requestId);
        return;
      }

      case 'install':
        if (!this.isKnownManifest(message.manifestPath)) {
          this.post({ type: 'error', message: 'Unknown manifest.' });
          return;
        }
        await this.handleInstall(
          message.name,
          message.version,
          message.scope,
          message.manifestPath,
        );
        return;

      case 'update':
        await this.handleUpdate(message.depKey, message.toVersion);
        return;

      case 'updateAll':
        // Without a manifest the command owns the choice, because it owns the
        // quick-pick that makes it.
        if (message.manifestPath === undefined) {
          await vscode.commands.executeCommand('orizzonte.updateAll');
        } else {
          await this.updateAll(message.manifestPath);
        }
        return;

      case 'bulkUpdate':
        await this.handleBulkUpdate(message.targets);
        return;

      case 'bulkUninstall':
        await this.handleBulkUninstall(message.depKeys);
        return;

      case 'uninstall':
        await this.handleUninstall(message.depKey);
        return;

      case 'requestDetails':
        await this.handleDetails(message.depKey);
        return;

      case 'requestWhy':
        await this.handleWhy(message.depKey);
        return;

      case 'requestDuplicates':
        await this.handleDuplicates();
        return;

      case 'requestLicenses':
        await this.handleLicenses();
        return;

      case 'requestChangelog':
        await this.handleChangelog(message.depKey);
        return;

      case 'requestDependencyDiff':
        await this.handleDependencyDiff();
        return;

      case 'openExternal':
        await this.openExternal(message.url);
        return;

      case 'openManifest':
        if (!this.isKnownManifest(message.manifestPath)) {
          this.post({ type: 'error', message: 'Unknown manifest.' });
          return;
        }
        await this.openManifest(message.manifestPath, message.packageName);
        return;
    }
  }

  private async handleSearch(
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
      const installedByPackage = indexInstalledPackages(this.latest.groups);

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

  private async handleInstall(
    name: string,
    version: string | null,
    scope: DepScope,
    manifestPath: string,
  ): Promise<void> {
    const provider = providerForPath(manifestPath);
    if (!provider) {
      this.post({
        type: 'error',
        message: `No provider handles ${path.basename(manifestPath)}`,
      });
      return;
    }

    if (!provider.isValidPackageName(name)) {
      this.post({
        type: 'error',
        message: `"${name}" is not a valid package name.`,
      });
      return;
    }

    // A version is no more trusted than a name: both arrive from the webview,
    // and both end up on a command line.
    if (version !== null && !validateVersion(provider, version)) {
      this.post({
        type: 'error',
        message: `"${version}" is not a valid version.`,
      });
      return;
    }

    const applied = await this.mutator.install(
      provider,
      manifestPath,
      name,
      version,
      scope,
    );

    if (!applied) {
      this.post({
        type: 'error',
        message:
          `Orizzonte cannot add ${name} to ${path.basename(manifestPath)} automatically. ` +
          `Opening the file so you can add it by hand.`,
      });
      await this.openManifest(manifestPath);
    }
    await this.refresh();
  }

  private async handleUpdate(depKey: string, toVersion: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found) return;
    const { dep } = found;

    if (!validateVersion(providerFor(dep.ecosystem), toVersion)) {
      this.post({
        type: 'error',
        message: `"${toVersion}" is not a valid version.`,
      });
      return;
    }

    // Bulk updates already ask before crossing a major boundary; a single one
    // is no less likely to break the build, so it asks too.
    if (dep.updateKind === 'major') {
      const choice = await vscode.window.showWarningMessage(
        `Update ${dep.name} to ${toVersion}?`,
        {
          modal: true,
          detail: `This is a major upgrade from ${dep.installed ?? dep.declared} and may contain breaking changes.`,
        },
        'Update',
      );
      if (choice !== 'Update') return;
    }

    const applied = await this.mutator.update(
      dep,
      providerFor(dep.ecosystem),
      toVersion,
    );

    if (!applied) {
      this.post({
        type: 'error',
        message:
          `${dep.name} is declared in a form Orizzonte cannot rewrite safely ` +
          `(a computed or inherited version). Opening the file instead.`,
      });
      await this.openManifest(dep.manifestPath, dep.name);
    }
    await this.refresh();
  }

  /**
   * Every selected package, confirmed once and run in order.
   *
   * Sequential rather than parallel for the same reason `updateAll` is: these
   * are package-manager writes against a shared lockfile, run through a single
   * terminal.
   */
  private async handleBulkUpdate(
    targets: Array<{ depKey: string; toVersion: string }>,
  ): Promise<void> {
    // Rows the table no longer holds, and versions that do not pass their
    // provider's grammar, are dropped before anything is confirmed or run —
    // both arrive from the webview and neither is more trusted here than in
    // the single-package path.
    const resolved = resolveBulkUpdateTargets(this.latest, targets, (dep, v) =>
      validateVersion(providerFor(dep.ecosystem), v),
    );

    if (resolved.length === 0) return;

    const majors = resolved.filter((entry) => entry.dep.updateKind === 'major');
    const detail = majorUpgradeDetail(resolved.length, majors.length);

    const choice = await vscode.window.showWarningMessage(
      `Update ${resolved.length} selected package(s)?`,
      { modal: true, detail },
      'Update',
    );
    if (choice !== 'Update') return;

    // Named rather than counted: a package Orizzonte cannot rewrite is the one
    // the user has to go and edit by hand, so it has to be identifiable.
    const skipped: string[] = [];
    for (const entry of resolved) {
      try {
        if (
          !(await this.mutator.update(
            entry.dep,
            providerFor(entry.dep.ecosystem),
            entry.toVersion,
          ))
        ) {
          skipped.push(entry.dep.name);
        }
      } catch {
        // One package failing to update (terminal disposed mid-run, a
        // manifest edit that throws) should not abandon the rest of the
        // batch — it's reported the same way a declined rewrite is.
        skipped.push(entry.dep.name);
      }
    }

    if (skipped.length > 0) {
      this.post({
        type: 'error',
        message:
          `Could not update ${skipped.join(', ')} automatically — ` +
          `declared in a form Orizzonte cannot rewrite safely.`,
      });
    }
    await this.refresh();
  }

  private async handleBulkUninstall(depKeys: string[]): Promise<void> {
    const deps = resolveBulkUninstallTargets(this.latest, depKeys);

    if (deps.length === 0) return;

    const choice = await vscode.window.showWarningMessage(
      `Remove ${deps.length} selected package(s)?`,
      {
        modal: true,
        detail: deps.map((dep) => dep.name).join(', '),
      },
      'Remove',
    );
    if (choice !== 'Remove') return;

    const skipped: string[] = [];
    for (const dep of deps) {
      try {
        if (!(await this.mutator.uninstall(dep, providerFor(dep.ecosystem)))) {
          skipped.push(dep.name);
        }
      } catch {
        skipped.push(dep.name);
      }
    }

    if (skipped.length > 0) {
      this.post({
        type: 'error',
        message: `Could not remove ${skipped.join(', ')} automatically.`,
      });
    }
    await this.refresh();
  }

  /** Also invoked from the `orizzonte.updateAll` command, not just the webview. */
  async updateAll(manifestPath: string): Promise<void> {
    const group = this.latest.groups.find(
      (candidate) => candidate.manifestPath === manifestPath,
    );
    if (!group) return;

    const outdated = group.dependencies.filter(hasUpdate);
    if (outdated.length === 0) {
      this.post({
        type: 'notice',
        message: 'Everything is already up to date.',
      });
      return;
    }

    const majors = outdated.filter((dep) => dep.updateKind === 'major');
    const detail = majorUpgradeDetail(outdated.length, majors.length);

    const choice = await vscode.window.showWarningMessage(
      `Update all dependencies in ${group.label}?`,
      { modal: true, detail },
      'Update',
    );
    if (choice !== 'Update') return;

    const provider = providerFor(group.ecosystem);
    const applied = await this.mutator.updateAll(provider, manifestPath);

    if (!applied) {
      this.post({
        type: 'error',
        message: `No bulk update command for ${group.ecosystem}.`,
      });
      return;
    }

    await this.refresh();
  }

  private async handleUninstall(depKey: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found) return;
    const { dep } = found;

    const choice = await vscode.window.showWarningMessage(
      `Remove ${dep.name} from ${path.basename(dep.manifestPath)}?`,
      { modal: true },
      'Remove',
    );
    if (choice !== 'Remove') return;

    const applied = await this.mutator.uninstall(
      dep,
      providerFor(dep.ecosystem),
    );

    if (!applied) {
      this.post({
        type: 'error',
        message: `Orizzonte could not remove ${dep.name} automatically. Opening the manifest.`,
      });
      await this.openManifest(dep.manifestPath, dep.name);
    }
    await this.refresh();
  }

  private async handleDetails(depKey: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found) return;

    // The webview requests details whenever a row opens, which makes this the
    // host's view of "what is selected" for command-palette actions.
    this.selectedKey = depKey;

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

  private async handleWhy(depKey: string): Promise<void> {
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
   * Unlike `handleWhy`, this touches only the local filesystem — no registry
   * fallback to race against — so there is nothing here worth cancelling.
   */
  private async handleDuplicates(): Promise<void> {
    try {
      const results = await Promise.all(
        this.latest.groups.map(async (group) => {
          const result = await findDuplicateVersions(
            group.manifestPath,
            group.ecosystem,
            this.ctx,
          );
          return {
            manifestPath: group.manifestPath,
            projectLabel: group.label,
            ecosystem: group.ecosystem,
            ...result,
          };
        }),
      );
      this.post({ type: 'duplicateVersions', results });
    } catch (error) {
      this.post({ type: 'error', message: describeError(error) });
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
  private async handleLicenses(): Promise<void> {
    this.licenseRequest?.abort();
    const controller = new AbortController();
    this.licenseRequest = controller;

    try {
      // Keyed by ecosystem+name so a package several projects share is only
      // ever fetched once, regardless of how many manifests declare it.
      const unique = new Map<string, { name: string; ecosystem: Ecosystem }>();
      for (const group of this.latest.groups) {
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
      this.post({ type: 'licenseSummary', summary });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.post({ type: 'error', message: describeError(error) });
    }
  }

  /**
   * GitHub releases between a dependency's installed and target version.
   *
   * `entries: undefined` covers "not a GitHub repository" and "details
   * have not been fetched yet, so there is no repository to check" — both
   * are "nothing to show", not a failure, so neither posts an `error`.
   */
  private async handleChangelog(depKey: string): Promise<void> {
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
  private async handleDependencyDiff(): Promise<void> {
    const found = await findSingleRepository();
    if (!found.ok) {
      this.post({ type: 'notice', message: found.message });
      return;
    }

    const ref = await pickRef(found.repository);
    if (!ref) return;

    try {
      const readAtRef = gitFileReader(found.repository, ref);
      const results = await Promise.all(
        this.latest.groups.map(async (group) => {
          const dir = path.dirname(group.manifestPath);
          const [before, after] = await Promise.all([
            collectVersionsFrom(dir, group.ecosystem, readAtRef),
            collectVersionsFrom(dir, group.ecosystem, (absolutePath) =>
              this.ctx.readFile(absolutePath),
            ),
          ]);
          return {
            manifestPath: group.manifestPath,
            projectLabel: group.label,
            ecosystem: group.ecosystem,
            ...diffLockfileVersions(before, after),
          };
        }),
      );
      this.post({ type: 'dependencyDiff', ref, results });
    } catch (error) {
      this.post({ type: 'error', message: describeError(error) });
    }
  }

  /**
   * Rescans the workspace.
   *
   * The watcher usually fires first; going through the command makes the
   * refresh deterministic even on filesystems where watch events are
   * unreliable.
   */
  private async refresh(): Promise<void> {
    await vscode.commands.executeCommand('orizzonte.refresh');
  }

  private findDependency(
    depKey: string,
  ): { group: ProjectGroup; dep: Dependency } | undefined {
    return findDependency(this.latest, depKey);
  }

  /**
   * True if `manifestPath` belongs to a manifest the last scan actually
   * found. Messages from the webview name a manifest by path rather than by
   * an opaque key (unlike dependencies, which resolve through
   * `findDependency`), so this is the one place that trust boundary is
   * enforced before the path is used as a command's cwd or opened as a file.
   */
  private isKnownManifest(manifestPath: string): boolean {
    return isKnownManifest(this.latest, manifestPath);
  }

  /** Only ever opens http(s) links, so a malformed registry field is inert. */
  private async openExternal(url: string): Promise<void> {
    await openExternalUrl(url);
  }

  private async openManifest(
    manifestPath: string,
    packageName?: string,
  ): Promise<void> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(manifestPath),
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
    });

    if (!packageName) return;

    const index = findDeclaration(document.getText(), packageName);
    if (index >= 0) {
      const position = document.positionAt(index);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter,
      );
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, 'index.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, 'index.css'),
    );
    const nonce = createNonce();
    const csp = buildContentSecurityPolicy(webview, nonce);

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Orizzonte</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    // The same reasoning `onDidDispose` already applies to `searches`: these
    // outlive the panel otherwise, and the license check fans out one registry
    // request per unique package in the workspace.
    this.whyRequest?.abort();
    this.licenseRequest?.abort();
    for (const controller of this.searches.values()) controller.abort();
    this.searches.clear();
    // Nothing is left to release a claim once the panel is gone.
    this.busyState.reset();
    this.terminal.dispose();
    this.panel?.dispose();
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The confirmation dialog detail shared by bulk-update and update-all. */
function majorUpgradeDetail(count: number, majorCount: number): string {
  return majorCount > 0
    ? `${count} package(s), including ${majorCount} major upgrade(s) that may contain breaking changes.`
    : `${count} package(s), all minor or patch.`;
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
