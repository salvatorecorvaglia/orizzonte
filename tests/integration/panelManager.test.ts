/**
 * `panelManager.ts` imports `vscode`, so it cannot be loaded under vitest at
 * all (see the exclusion list in `vitest.config.ts`). It is also the
 * largest untested file in the codebase — `extension.test.ts`'s "commands
 * are safe to invoke" suite only checks that the `orizzonte.open` command
 * does not throw; it never sends a message into the resulting panel.
 *
 * `vscode.window.createWebviewPanel` is called internally by `reveal()`, so
 * — unlike `SidebarViewProvider.resolveWebviewView`, which takes a webview
 * as a parameter — there is no way to hand `PanelManager` a fake one.
 * Instead this intercepts `createWebviewPanel` itself for the duration of
 * one `reveal()` call, wrapping the real panel's `webview.onDidReceiveMessage`
 * and `webview.postMessage` just long enough to capture the message handler
 * `PanelManager` registers and the messages it posts back — the real panel
 * underneath is untouched, so its own CSP/HTML build still genuinely runs.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Memento, TtlCache } from '../../src/core/cache.js';
import { HttpClient } from '../../src/core/http.js';
import type { HostMessage, WebviewMessage } from '../../src/core/protocol.js';
import { Scanner, type ScanResult } from '../../src/core/scanner.js';
import type { Dependency, ProjectGroup } from '../../src/core/types.js';
import { createProviderContext } from '../../src/core/workspace.js';
import { PanelManager } from '../../src/ui/panelManager.js';

class MapMemento implements Memento {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

/**
 * Intercepts the next `createWebviewPanel` call to capture the message
 * handler `PanelManager` registers and every message it posts back.
 */
function interceptNextPanel(): {
  ready: Promise<{
    receive: (message: WebviewMessage) => void;
    posted: HostMessage[];
  }>;
  restore: () => void;
} {
  const original = vscode.window.createWebviewPanel;
  let resolveReady: (value: {
    receive: (message: WebviewMessage) => void;
    posted: HostMessage[];
  }) => void;
  const ready = new Promise<{
    receive: (message: WebviewMessage) => void;
    posted: HostMessage[];
  }>((resolve) => {
    resolveReady = resolve;
  });

  (
    vscode.window as {
      createWebviewPanel: typeof vscode.window.createWebviewPanel;
    }
  ).createWebviewPanel = ((...args: Parameters<typeof original>) => {
    const panel = original(...args);
    const posted: HostMessage[] = [];
    const originalPostMessage = panel.webview.postMessage.bind(panel.webview);
    (
      panel.webview as { postMessage: typeof panel.webview.postMessage }
    ).postMessage = (async (message: HostMessage) => {
      posted.push(message);
      return originalPostMessage(message);
    }) as typeof panel.webview.postMessage;

    const originalOnDidReceiveMessage = panel.webview.onDidReceiveMessage.bind(
      panel.webview,
    );
    (
      panel.webview as {
        onDidReceiveMessage: typeof panel.webview.onDidReceiveMessage;
      }
    ).onDidReceiveMessage = ((listener: (message: WebviewMessage) => void) => {
      resolveReady({ receive: listener, posted });
      return originalOnDidReceiveMessage(listener);
    }) as typeof panel.webview.onDidReceiveMessage;

    return panel;
  }) as typeof original;

  return {
    ready,
    restore: () => {
      (
        vscode.window as {
          createWebviewPanel: typeof vscode.window.createWebviewPanel;
        }
      ).createWebviewPanel = original;
    },
  };
}

/**
 * Removes a temp directory that VS Code has had files open from. Windows keeps
 * a handle on such a file for a beat after the editor closes, so a plain `rm`
 * can fail with EBUSY — `maxRetries` waits that handle out.
 */
async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

function emptyScanResult(): ScanResult {
  return {
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
}

/** Waits for `posted` to contain a message of `type`, or fails after a beat. */
async function waitForMessage<T extends HostMessage['type']>(
  posted: HostMessage[],
  type: T,
): Promise<Extract<HostMessage, { type: T }>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const found = posted.find((m) => m.type === type);
    if (found) return found as Extract<HostMessage, { type: T }>;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    `no "${type}" message was posted; got: ${posted.map((m) => m.type).join(', ')}`,
  );
}

describe('PanelManager message handling', () => {
  let manager: PanelManager;

  function makeManager(): PanelManager {
    const http = new HttpClient('0.0.0-test');
    const cache = new TtlCache(new MapMemento());
    const ctx = createProviderContext(http, cache);
    const scanner = new Scanner(ctx);
    return new PanelManager(
      vscode.extensions.getExtension('orizzonte.orizzonte-vscode')!
        .extensionUri,
      scanner,
      ctx,
      () => undefined,
    );
  }

  afterEach(() => {
    manager?.dispose();
  });

  it('replies to "ready" with the current state and clears a queued reveal', async () => {
    manager = makeManager();

    const dep: Dependency = {
      key: 'k',
      name: 'demo-pkg',
      ecosystem: 'node',
      scope: 'prod',
      declared: '1.0.0',
      installed: '1.0.0',
      updateKind: 'none',
      vulnerabilities: [],
      manifestPath: '/does/not/matter/package.json',
      projectLabel: 'demo',
    };
    const group: ProjectGroup = {
      label: 'demo',
      manifestPath: '/does/not/matter/package.json',
      ecosystem: 'node',
      toolchain: 'npm',
      dependencies: [dep],
    };
    manager.setResult({
      groups: [group],
      manifestPaths: [group.manifestPath],
      summary: {
        totalDependencies: 1,
        outdated: 0,
        vulnerable: 0,
        deprecated: 0,
        stale: false,
      },
    });

    const intercept = interceptNextPanel();
    try {
      // Queued before the webview exists — "ready" must replay it.
      manager.revealDependency(dep.key, 'why');
      const { receive, posted } = await intercept.ready;

      receive({ type: 'ready' });

      const state = await waitForMessage(posted, 'state');
      assert.equal(state.groups[0]?.dependencies[0]?.key, 'k');

      const focus = await waitForMessage(posted, 'focusDependency');
      assert.equal(focus.depKey, 'k');

      // The reveal must not still be queued behind a second "ready".
      posted.length = 0;
      receive({ type: 'ready' });
      await waitForMessage(posted, 'state');
      assert.equal(
        posted.some((m) => m.type === 'focusDependency'),
        false,
        'a already-delivered reveal was replayed a second time',
      );
    } finally {
      intercept.restore();
    }
  });

  it('opens the manifest for "openManifest", but refuses an unknown path', async () => {
    manager = makeManager();

    const tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'orizzonte-panel-manifest-')),
    );
    const manifestPath = path.join(tmpDir, 'package.json');
    await fs.writeFile(manifestPath, '{"name":"demo","dependencies":{}}\n');

    manager.setResult({
      groups: [
        {
          label: 'demo',
          manifestPath,
          ecosystem: 'node',
          toolchain: 'npm',
          dependencies: [],
        },
      ],
      manifestPaths: [manifestPath],
      summary: {
        totalDependencies: 0,
        outdated: 0,
        vulnerable: 0,
        deprecated: 0,
        stale: false,
      },
    });

    const intercept = interceptNextPanel();
    try {
      manager.reveal();
      const { receive, posted } = await intercept.ready;
      receive({ type: 'ready' });
      await waitForMessage(posted, 'state');

      // An unknown manifest is refused rather than opened.
      receive({
        type: 'openManifest',
        manifestPath: path.join(tmpDir, 'not-scanned.json'),
      });
      const error = await waitForMessage(posted, 'error');
      assert.match(error.message, /Unknown manifest/);

      // The real one opens.
      posted.length = 0;
      receive({ type: 'openManifest', manifestPath });
      for (let attempt = 0; attempt < 50; attempt++) {
        if (
          vscode.window.visibleTextEditors.some(
            (editor) =>
              editor.document.uri.fsPath.toLowerCase() ===
              manifestPath.toLowerCase(),
          )
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(
        vscode.window.visibleTextEditors.some(
          (editor) =>
            editor.document.uri.fsPath.toLowerCase() ===
            manifestPath.toLowerCase(),
        ),
        'the manifest was not opened in an editor',
      );
    } finally {
      intercept.restore();
      // The manifest is open in an editor, which locks it on Windows.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await removeTempDir(tmpDir);
    }
  });

  it('starts from an empty result before anything has been scanned', () => {
    manager = makeManager();
    assert.deepEqual(manager.currentResult, emptyScanResult());
  });

  it('answers "requestDuplicates" from a real lockfile on disk', async () => {
    manager = makeManager();

    const tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'orizzonte-panel-duplicates-')),
    );
    const manifestPath = path.join(tmpDir, 'package.json');
    await fs.writeFile(manifestPath, '{"name":"demo","dependencies":{}}\n');
    await fs.writeFile(
      path.join(tmpDir, 'package-lock.json'),
      JSON.stringify({
        packages: {
          '': { dependencies: { a: '^1.0.0' } },
          'node_modules/a': {
            version: '1.0.0',
            dependencies: { 'ansi-styles': '^3.0.0' },
          },
          'node_modules/a/node_modules/ansi-styles': { version: '3.2.1' },
          'node_modules/ansi-styles': { version: '4.3.0' },
        },
      }),
    );

    manager.setResult({
      groups: [
        {
          label: 'demo',
          manifestPath,
          ecosystem: 'node',
          toolchain: 'npm',
          dependencies: [],
        },
      ],
      manifestPaths: [manifestPath],
      summary: {
        totalDependencies: 0,
        outdated: 0,
        vulnerable: 0,
        deprecated: 0,
        stale: false,
      },
    });

    const intercept = interceptNextPanel();
    try {
      manager.reveal();
      const { receive, posted } = await intercept.ready;
      receive({ type: 'ready' });
      await waitForMessage(posted, 'state');

      receive({ type: 'requestDuplicates' });
      const response = await waitForMessage(posted, 'duplicateVersions');

      assert.equal(response.results.length, 1);
      assert.equal(response.results[0]?.checked, true);
      assert.deepEqual(response.results[0]?.groups, [
        { name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] },
      ]);
    } finally {
      intercept.restore();
      await removeTempDir(tmpDir);
    }
  });

  /*
   * "requestLicenses" fetches each package's metadata over the network, which
   * this suite cannot exercise — CI may have no egress at all. An empty
   * result still proves the message is wired end to end without a single
   * registry call, since there is nothing to fetch.
   */
  it('answers "requestLicenses" with an empty summary when there is nothing to check', async () => {
    manager = makeManager();
    manager.setResult(emptyScanResult());

    const intercept = interceptNextPanel();
    try {
      manager.reveal();
      const { receive, posted } = await intercept.ready;
      receive({ type: 'ready' });
      await waitForMessage(posted, 'state');

      receive({ type: 'requestLicenses' });
      const response = await waitForMessage(posted, 'licenseSummary');

      assert.deepEqual(response.summary, { groups: [] });
    } finally {
      intercept.restore();
    }
  });

  /*
   * A dependency with no `meta` yet (details never fetched) has no
   * repository to check, so this proves the message is wired end to end
   * without ever reaching the network — the changelog fetch itself is
   * covered by `changelog.test.ts`, which can script GitHub's response.
   */
  it('answers "requestChangelog" without a network call when no repository is known', async () => {
    manager = makeManager();

    const dep: Dependency = {
      key: 'k',
      name: 'demo-pkg',
      ecosystem: 'node',
      scope: 'prod',
      declared: '^1.0.0',
      installed: '1.0.0',
      latest: '2.0.0',
      updateKind: 'major',
      vulnerabilities: [],
      manifestPath: '/does/not/matter/package.json',
      projectLabel: 'demo',
    };
    manager.setResult({
      groups: [
        {
          label: 'demo',
          manifestPath: '/does/not/matter/package.json',
          ecosystem: 'node',
          toolchain: 'npm',
          dependencies: [dep],
        },
      ],
      manifestPaths: ['/does/not/matter/package.json'],
      summary: {
        totalDependencies: 1,
        outdated: 1,
        vulnerable: 0,
        deprecated: 0,
        stale: false,
      },
    });

    const intercept = interceptNextPanel();
    try {
      manager.reveal();
      const { receive, posted } = await intercept.ready;
      receive({ type: 'ready' });
      await waitForMessage(posted, 'state');

      receive({ type: 'requestChangelog', depKey: 'k' });
      const response = await waitForMessage(posted, 'changelogEntries');

      assert.equal(response.depKey, 'k');
      assert.equal(response.entries, undefined);
    } finally {
      intercept.restore();
    }
  });
});
