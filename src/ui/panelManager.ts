/**
 * Routes what the webview asks for, and owns everything that can change the
 * workspace: installs, updates, removals, and the confirmations in front of
 * them.
 *
 * Two collaborators hold the rest. `panel/webviewHost.ts` owns the panel
 * itself — lifecycle, the HTML shell and its CSP, and the one channel messages
 * go out on. `panel/inspections.ts` owns every read-only question: search,
 * details, "why is this installed", duplicates, licences, release notes and the
 * branch diff. The split is along what a handler is allowed to do, so the file
 * that can run a package manager stays small enough to read in one sitting.
 *
 * Security posture: the webview names a manifest by path rather than by an
 * opaque key, so `isKnownManifest` below is the trust boundary — nothing
 * becomes a command's cwd or an opened file without passing it. Package names
 * and versions are re-validated here too, however trustworthy the webview that
 * sent them looked.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { findDeclaration } from '../core/findDeclaration.js';
import type { HostMessage, WebviewMessage } from '../core/protocol.js';
import type { Scanner, ScanResult } from '../core/scanner.js';
import type { Dependency, DepScope, ProjectGroup } from '../core/types.js';
import { hasUpdate } from '../core/vocabulary.js';
import {
  findDependency,
  isKnownManifest,
  resolveBulkUninstallTargets,
  resolveBulkUpdateTargets,
} from '../core/webviewRequests.js';
import type { ProviderContext } from '../providers/provider.js';
import { validateVersion } from '../providers/provider.js';
import { providerFor, providerForPath } from '../providers/registry.js';
import { DependencyMutator, type ToolchainCache } from './dependencyMutator.js';
import { PanelInspections } from './panel/inspections.js';
import { WebviewHost } from './panel/webviewHost.js';
import { TerminalRunner } from './terminalRunner.js';
import { openExternalUrl } from './webviewSecurity.js';

export class PanelManager implements vscode.Disposable {
  private readonly host: WebviewHost;
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
  private readonly terminal = new TerminalRunner();
  private readonly mutator: DependencyMutator;
  /** Everything the panel can *ask*, as opposed to everything it can change. */
  private readonly inspections: PanelInspections;

  constructor(
    extensionUri: vscode.Uri,
    scanner: Scanner,
    ctx: ProviderContext,
    private readonly onStateChanged: (result: ScanResult) => void,
  ) {
    this.mutator = new DependencyMutator(
      ctx,
      this.terminal,
      (label) => this.beginBusy(label),
      (message) => this.post({ type: 'error', message }),
    );

    /*
     * Messages are handled concurrently, deliberately.
     *
     * Serialising them through a queue would make a slow read — a license sweep
     * across a large workspace — block every click behind it, which is the
     * opposite of what the panel should feel like. What must not interleave is
     * handled a layer down instead, where the constraint actually is:
     * `TerminalRunner` runs package-manager commands through a `SerialQueue`
     * because one terminal cannot run two at once, `applyManifestEdit` refuses
     * an edit built against a document version that has moved, and bulk actions
     * arrive as a single message (see `bulkUpdate` in `core/protocol.ts`)
     * precisely so N packages cannot become N overlapping handlers.
     *
     * What remains is two *separate* user gestures landing together — which
     * takes clicking Update on two rows inside the same tick, and which the
     * webview's own busy state already disables.
     */
    this.inspections = new PanelInspections(
      ctx,
      scanner,
      (message) => this.post(message),
      () => this.latest,
      (depKey) => {
        this.selectedKey = depKey;
      },
    );

    this.host = new WebviewHost(extensionUri, (message) => {
      this.handleMessage(message).catch((error: unknown) => {
        this.post({ type: 'error', message: describeError(error) });
      });
    });

    // Closing the panel calls off the work that was running for it; nothing is
    // waiting for those answers any more.
    this.host.onDispose = () => {
      this.inspections.abortInFlight();
    };
  }

  get currentResult(): ScanResult {
    return this.latest;
  }

  /** Opens the panel, or reveals it if already open. */
  reveal(): void {
    this.host.reveal();
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
    return this.host.beginBusy(label);
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
    this.host.post(message);
  }

  /** Sends now if the webview can hear it, otherwise on its `ready`. */
  private postOrQueue(message: HostMessage): void {
    this.host.postOrQueue(message);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        const pending = this.host.takePendingReveals();
        this.post({
          type: 'state',
          groups: this.latest.groups,
          summary: this.latest.summary,
        });
        this.post({
          type: 'scanning',
          busy: this.host.busy,
          label: this.host.busyLabel,
        });
        // Anything asked for while the panel was still loading, replayed now
        // that there is something listening — and after `state`, so the row it
        // names already exists.
        for (const message of pending) {
          this.post(message);
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
        await this.inspections.handleSearch(
          message.query,
          message.ecosystem,
          message.requestId,
        );
        return;

      case 'cancelSearch':
        this.inspections.cancelSearch(message.requestId);
        return;

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
        await this.inspections.handleDetails(message.depKey);
        return;

      case 'requestWhy':
        await this.inspections.handleWhy(message.depKey);
        return;

      case 'requestDuplicates':
        await this.inspections.handleDuplicates(message.requestId);
        return;

      case 'requestLicenses':
        await this.inspections.handleLicenses(message.requestId);
        return;

      case 'requestChangelog':
        await this.inspections.handleChangelog(message.depKey);
        return;

      case 'requestDependencyDiff':
        await this.inspections.handleDependencyDiff(message.requestId);
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
    // One detection per project for the whole batch, not one per package.
    const toolchains: ToolchainCache = new Map();
    for (const entry of resolved) {
      try {
        if (
          !(await this.mutator.update(
            entry.dep,
            providerFor(entry.dep.ecosystem),
            entry.toVersion,
            toolchains,
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
    const toolchains: ToolchainCache = new Map();
    for (const dep of deps) {
      try {
        if (
          !(await this.mutator.uninstall(
            dep,
            providerFor(dep.ecosystem),
            toolchains,
          ))
        ) {
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

  dispose(): void {
    // The same reasoning the panel's own teardown applies: these outlive the
    // panel otherwise, and the license check fans out one registry request per
    // unique package in the workspace.
    this.inspections.dispose();
    this.terminal.dispose();
    this.host.dispose();
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
