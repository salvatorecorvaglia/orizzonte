/**
 * Extension entry point: builds the object graph and registers commands.
 *
 * Everything here is wiring — the behaviour lives in `core/`, `providers/` and
 * `ui/`. Activation stays cheap because the first scan is scheduled rather than
 * awaited, so opening a project never blocks on the network.
 */

import * as vscode from 'vscode';
import { TtlCache } from './core/cache.js';
import { findDuplicateVersions } from './core/depGraph.js';
import { HttpClient } from './core/http.js';
import { buildReport, type ReportFormat } from './core/report.js';
import { Scanner, type ScanResult } from './core/scanner.js';
import { ScanQueue } from './core/scanQueue.js';
import type { ProjectDuplicateVersions } from './core/types.js';
import { ManifestWatcher } from './core/watcher.js';
import { findDependency } from './core/webviewRequests.js';
import { createProviderContext } from './core/workspace.js';
import type { ProviderContext } from './providers/provider.js';
import { manifestGlob } from './providers/registry.js';
import { DepCodeLensProvider } from './ui/depCodeLens.js';
import { DepDiagnostics } from './ui/depDiagnostics.js';
import { PanelManager } from './ui/panelManager.js';
import { SidebarViewProvider } from './ui/sidebarProvider.js';

/**
 * The object `activate` returns.
 *
 * Deliberately tiny and read-only: it exists so integration tests can assert on
 * a real scan rather than scraping the UI, and is not a public extension API.
 */
export interface OrizzonteApi {
  /** Runs a scan. Pass `checkUpdates: false` to stay entirely offline. */
  scan(options?: {
    checkUpdates?: boolean;
    audit?: boolean;
  }): Promise<ScanResult>;
  /** The most recent result, without triggering new work. */
  getResult(): ScanResult;
  /**
   * Total network requests issued since activation.
   *
   * Lets the integration suite assert the offline guarantee directly rather
   * than inferring it from how long a refresh took.
   */
  requestCount(): number;
}

/**
 * Shown by every command that needs a package and cannot find one. Identical
 * wording and identical consequences — none of them reveal an unrelated panel
 * as a side effect of failing.
 */
const NO_SELECTION_MESSAGE =
  'Select a package in the Orizzonte panel or sidebar first.';

export function activate(context: vscode.ExtensionContext): OrizzonteApi {
  const version =
    (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  const config = () => vscode.workspace.getConfiguration('orizzonte');

  /**
   * Under the integration test host every scan stays offline.
   *
   * Registry results change daily and CI may have no egress at all, so a suite
   * that reached the network would be both slow and flaky. Tests that genuinely
   * want a lookup can still opt in through `OrizzonteApi.scan`.
   */
  const isTestHost = context.extensionMode === vscode.ExtensionMode.Test;

  /** Whether an automatic or command-driven scan may contact registries. */
  const networkAllowed = (requested = true): boolean =>
    !isTestHost && requested && config().get<boolean>('autoCheckUpdates', true);

  const http = new HttpClient(version, config().get<string>('contactEmail'));
  const cache = new TtlCache(context.globalState);
  // Lapsed entries would otherwise accumulate in globalState forever, and
  // globalState is loaded synchronously on every extension-host start. Not
  // awaited: nothing below depends on it, and activation stays cheap.
  void cache.prune().catch(() => undefined);
  const providerContext = createProviderContext(http, cache);
  const scanner = new Scanner(providerContext);

  const statusBar = vscode.window.createStatusBarItem(
    'orizzonte.status',
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.name = 'Orizzonte Dependencies';
  statusBar.command = 'orizzonte.open';

  const codeLensProvider = new DepCodeLensProvider(() => panel.currentResult);
  const diagnostics = new DepDiagnostics();

  const panel = new PanelManager(
    context.extensionUri,
    scanner,
    providerContext,
    (result) => {
      updateStatusBar(statusBar, result);
      codeLensProvider.refresh();
      diagnostics.refresh(result);
    },
  );

  /** The single path through which every refresh flows. */
  const scans = new ScanQueue<ScanResult | undefined>((request) =>
    doScan(request.checkUpdates, request.audit),
  );

  const runScan = (
    checkUpdates: boolean,
    audit?: boolean,
  ): Promise<ScanResult | undefined> => scans.request({ checkUpdates, audit });

  const doScan = async (
    checkUpdates: boolean,
    audit?: boolean,
  ): Promise<ScanResult | undefined> => {
    const doneBusy = panel.beginBusy(
      checkUpdates ? 'Checking registries…' : 'Reading manifests…',
    );

    try {
      const result = await scanner.scan(
        {
          checkUpdates,
          audit: audit ?? config().get<boolean>('enableAudit', true),
        },
        // Paint manifest data immediately; registry data lands a moment later.
        (partial) => panel.setResult(partial),
      );
      panel.setResult(result);

      if (result.summary.stale) {
        vscode.window.setStatusBarMessage(
          '$(cloud-offline) Orizzonte: showing cached data — registries unreachable',
          5000,
        );
      }
      if (scanner.hitManifestLimit) {
        vscode.window.setStatusBarMessage(
          `$(warning) Orizzonte: stopped at ${Scanner.manifestLimit} manifests — add patterns to orizzonte.excludeGlobs`,
          8000,
        );
      }
      // A manifest that could not be parsed used to vanish from the results
      // with nothing said, which reads exactly like a project that declares
      // no dependencies.
      const unreadable = scanner.unreadableManifests;
      if (unreadable.length > 0) {
        const names = unreadable
          .slice(0, 3)
          .map((file) => vscode.workspace.asRelativePath(file))
          .join(', ');
        const more =
          unreadable.length > 3 ? ` and ${unreadable.length - 3} more` : '';
        vscode.window.setStatusBarMessage(
          `$(warning) Orizzonte: could not read ${names}${more}`,
          8000,
        );
      }
      return result;
    } catch (error) {
      if (!isAbort(error)) {
        void vscode.window.showErrorMessage(
          `Orizzonte scan failed: ${describe(error)}`,
        );
      }
      return undefined;
    } finally {
      doneBusy();
    }
  };

  const watcher = new ManifestWatcher(() => {
    void runScan(networkAllowed());
  });

  const sidebarProvider = new SidebarViewProvider(
    context.extensionUri,
    version,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewType,
      sidebarProvider,
    ),
    statusBar,
    panel,
    watcher,
    diagnostics,

    vscode.languages.registerCodeLensProvider(
      { pattern: manifestGlob() },
      codeLensProvider,
    ),

    // Opening a manifest that was not among the documents already open when
    // the last scan landed is the one case `diagnostics.refresh` would
    // otherwise miss, since it only walks `workspace.textDocuments`.
    vscode.workspace.onDidOpenTextDocument(() => {
      diagnostics.refresh(panel.currentResult);
    }),

    // CodeLens-only: hidden from the command palette (see menus.commandPalette
    // in package.json), since it exists purely to give a lens something to
    // invoke.
    vscode.commands.registerCommand(
      'orizzonte.focusDependencyFromLens',
      (depKey: string) => {
        panel.revealDependency(depKey, 'details');
      },
    ),

    vscode.commands.registerCommand('orizzonte.open', () => {
      panel.reveal();
      void runScan(networkAllowed());
    }),

    vscode.commands.registerCommand('orizzonte.refresh', () =>
      runScan(networkAllowed()),
    ),

    // Explicit user intent, so this ignores autoCheckUpdates — but still stays
    // offline under the test host.
    vscode.commands.registerCommand('orizzonte.checkUpdates', () =>
      runScan(!isTestHost),
    ),

    vscode.commands.registerCommand('orizzonte.searchInstall', () => {
      panel.revealSearch();
    }),

    vscode.commands.registerCommand('orizzonte.updateAll', async () => {
      const groups = panel.currentResult.groups;
      if (groups.length === 0) {
        void vscode.window.showInformationMessage(
          'Orizzonte has not found any manifests yet.',
        );
        return;
      }
      // With one project there is nothing to disambiguate.
      const target = groups.length === 1 ? groups[0] : await pickGroup(groups);
      if (!target) return;
      panel.reveal();
      await panel.updateAll(target.manifestPath);
    }),

    vscode.commands.registerCommand('orizzonte.exportReport', async () => {
      const result = panel.currentResult;
      if (result.groups.length === 0) {
        void vscode.window.showInformationMessage(
          'Orizzonte has not found any manifests yet.',
        );
        return;
      }

      const format = await pickReportFormat();
      if (!format) return;

      // Local-only and cheap (no registry call), so gathering it fresh for
      // every export is simpler than caching an answer that may already be
      // stale by the time someone reads the report.
      const duplicates = await collectDuplicateVersions(
        result.groups,
        providerContext,
      );

      const content = buildReport(
        result.groups,
        result.summary,
        duplicates,
        {
          generatedAt: new Date().toISOString(),
          workspaceName: vscode.workspace.name,
        },
        format,
      );

      const extension = format === 'json' ? 'json' : 'md';
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({
        defaultUri: workspaceFolder
          ? vscode.Uri.joinPath(
              workspaceFolder,
              `orizzonte-report.${extension}`,
            )
          : undefined,
        filters: format === 'json' ? { JSON: ['json'] } : { Markdown: ['md'] },
      });
      if (!target) return;

      await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));

      const openAction = 'Open';
      const choice = await vscode.window.showInformationMessage(
        `Orizzonte report saved to ${vscode.workspace.asRelativePath(target)}`,
        openAction,
      );
      if (choice === openAction) {
        const document = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(document);
      }
    }),

    // Invoked from the command palette, which carries no argument — the row
    // the user last opened in the drawer is the selection it acts on.
    vscode.commands.registerCommand('orizzonte.showWhy', () => {
      const dep = findDependency(
        panel.currentResult,
        panel.lastSelectedKey,
      )?.dep;
      if (!dep) {
        void vscode.window.showInformationMessage(NO_SELECTION_MESSAGE);
        return;
      }
      panel.revealDependency(dep.key, 'why');
    }),

    // Rebuilding the User-Agent keeps the contact address in sync with settings.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('orizzonte.contactEmail')) {
        http.setContactEmail(version, config().get<string>('contactEmail'));
      }
      if (
        event.affectsConfiguration('orizzonte.excludeGlobs') ||
        event.affectsConfiguration('orizzonte.preferredNodeManager') ||
        event.affectsConfiguration('orizzonte.pythonManager')
      ) {
        void runScan(false);
      }
      // Re-arm rather than wait for a window reload — a setting that only takes
      // effect after a restart reads as a setting that does not work.
      if (event.affectsConfiguration('orizzonte.checkIntervalMinutes')) {
        armPeriodicCheck();
      }
    }),
  );

  // Periodic background re-check, when enabled. Never armed under the test
  // host, where a timer firing mid-suite would be a source of flakiness.
  let periodicTimer: NodeJS.Timeout | undefined;

  const armPeriodicCheck = (): void => {
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = undefined;
    }
    if (isTestHost) return;

    const intervalMinutes = config().get<number>('checkIntervalMinutes', 60);
    if (intervalMinutes <= 0) return;

    periodicTimer = setInterval(
      () => {
        if (networkAllowed()) {
          void runScan(true);
        }
      },
      intervalMinutes * 60 * 1000,
    );
  };

  armPeriodicCheck();
  context.subscriptions.push({
    dispose: () => {
      if (periodicTimer) clearInterval(periodicTimer);
      // A scan of a large monorepo outlives the window that asked for it
      // otherwise, holding registry requests open for an extension that is
      // going away.
      scanner.cancel();
      // Cache writes are buffered so they stay off the scan's hot path; this
      // closes the window in which a shutdown would drop the newest entries.
      void cache.flushNow();
    },
  });

  // Kick off the first scan without blocking activation.
  void runScan(networkAllowed());

  return {
    scan: async (options) => {
      // Let any in-flight scan settle first, so a caller never observes the
      // empty state that precedes the activation scan.
      await scans.settled();
      const result = await runScan(
        options?.checkUpdates ?? false,
        options?.audit ?? false,
      );
      return result ?? panel.currentResult;
    },
    getResult: () => panel.currentResult,
    requestCount: () => http.requestCount,
  };
}

export function deactivate(): void {
  // All resources are registered in context.subscriptions and disposed by VS Code.
}

async function pickGroup(groups: ScanResult['groups']) {
  const picked = await vscode.window.showQuickPick(
    groups.map((group) => ({
      label: group.label,
      description: group.toolchain,
      group,
    })),
    { title: 'Which project do you want to update?' },
  );
  return picked?.group;
}

async function pickReportFormat(): Promise<ReportFormat | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: 'Markdown',
        description: 'Readable — for sharing or a PR description',
        format: 'markdown' as const,
      },
      {
        label: 'JSON',
        description: 'Structured — for scripts or other tools',
        format: 'json' as const,
      },
    ],
    { title: 'Export dependency report as…' },
  );
  return picked?.format;
}

/** Best-effort: a project whose ecosystem has no trustworthy lockfile just
 * reports `checked: false` rather than failing the whole export. */
async function collectDuplicateVersions(
  groups: ScanResult['groups'],
  ctx: ProviderContext,
): Promise<ProjectDuplicateVersions[]> {
  return Promise.all(
    groups.map(async (group) => ({
      manifestPath: group.manifestPath,
      projectLabel: group.label,
      ecosystem: group.ecosystem,
      ...(await findDuplicateVersions(
        group.manifestPath,
        group.ecosystem,
        ctx,
      )),
    })),
  );
}

function updateStatusBar(item: vscode.StatusBarItem, result: ScanResult): void {
  const { totalDependencies, outdated, vulnerable } = result.summary;

  if (totalDependencies === 0) {
    item.hide();
    return;
  }

  const parts: string[] = [];
  if (vulnerable > 0) parts.push(`$(shield) ${vulnerable}`);
  if (outdated > 0) parts.push(`$(arrow-up) ${outdated}`);

  item.text =
    parts.length > 0
      ? `$(package) ${parts.join(' ')}`
      : `$(package) ${totalDependencies}`;
  item.tooltip = `Orizzonte — ${totalDependencies} dependencies, ${outdated} outdated, ${vulnerable} vulnerable`;
  /*
   * `text` is icons and bare numbers ("$(shield) 1 $(arrow-up) 6"), which a
   * screen reader reads as two unexplained digits. The label spells out what
   * they count.
   */
  item.accessibilityInformation = {
    label: `Orizzonte: ${totalDependencies} dependencies, ${outdated} outdated, ${vulnerable} vulnerable`,
    role: 'button',
  };
  item.backgroundColor =
    vulnerable > 0
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  item.show();
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
