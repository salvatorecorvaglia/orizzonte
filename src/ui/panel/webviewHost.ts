/**
 * The webview panel itself: its lifecycle, its HTML shell, and the one channel
 * everything else posts through.
 *
 * Split out of `PanelManager` because it is the part with no opinions about
 * dependencies at all — it knows about `vscode.WebviewPanel`, a nonce and a
 * CSP, and nothing else. Keeping it separate leaves the manager to be about
 * what the messages *mean*.
 *
 * Security posture lives here too: the webview loads only local scripts under a
 * per-load nonce and is given no network access (`connect-src 'none'`). Every
 * registry call happens in the extension host, which is also the only place
 * that can reach the filesystem or spawn a terminal.
 */

import * as vscode from 'vscode';
import { BusyTracker } from '../../core/busyTracker.js';
import type { HostMessage, WebviewMessage } from '../../core/protocol.js';
import { buildContentSecurityPolicy, createNonce } from '../webviewSecurity.js';

export class WebviewHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  /** False between creating a panel and the React app announcing itself. */
  private webviewReady = false;

  /**
   * Reveals requested before the webview finished loading.
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

  /*
   * Reference-counted rather than a boolean: a scan and a package-manager
   * command overlap routinely, and whichever finished first used to clear the
   * other's spinner. See `core/busyTracker.ts`.
   */
  private readonly busyState = new BusyTracker((busy, label) => {
    this.post({ type: 'scanning', busy, label });
  });

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** Called for every message the webview sends, once it is open. */
    private readonly onMessage: (message: WebviewMessage) => void,
  ) {}

  /** True once the React app has announced itself. */
  get ready(): boolean {
    return this.webviewReady;
  }

  get busy(): boolean {
    return this.busyState.busy;
  }

  get busyLabel(): string | undefined {
    return this.busyState.label;
  }

  /**
   * Claims the busy state and returns the release for it. Callers pair the two
   * with a `finally` rather than remembering a matching "stop" call, and no
   * caller can clear a claim it does not hold.
   */
  beginBusy(label?: string): () => void {
    return this.busyState.begin(label);
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
      this.onDispose?.();
    });

    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      this.onMessage(message);
    });
  }

  /** Run when the panel is closed, so the owner can call off its own work. */
  onDispose: (() => void) | undefined;

  post(message: HostMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  /** Sends now if the webview can hear it, otherwise on its `ready`. */
  postOrQueue(message: HostMessage): void {
    if (this.webviewReady) {
      this.post(message);
      return;
    }
    this.pendingReveals.push(message);
  }

  /**
   * Marks the webview as listening and returns anything asked for while it was
   * still loading, for the caller to replay once it has sent the initial state.
   */
  takePendingReveals(): HostMessage[] {
    this.webviewReady = true;
    return this.pendingReveals.splice(0);
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
    // Nothing is left to release a claim once the panel is gone.
    this.busyState.reset();
    this.panel?.dispose();
  }
}
