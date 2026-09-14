/**
 * The Activity Bar view: a launcher for the dependency panel.
 *
 * Deliberately not a second data surface. The panel is where dependencies are
 * read and acted on, and an Activity Bar view that duplicated it would be a
 * second copy of the table to keep in sync — the exact drift the tree view it
 * replaced used to produce. What belongs here is the way in: the branding, the
 * version, and the button. The real actions live in the view's title bar, where
 * `package.json` contributes them as `view/title` menu items.
 */

import * as vscode from 'vscode';
import {
  buildContentSecurityPolicy,
  createNonce,
  openExternalUrl,
} from './webviewSecurity.js';

/**
 * Escapes text interpolated into this file's HTML.
 *
 * The only interpolated value today is the extension's own version, read from
 * our `package.json` — so this is not defending against a value we expect to
 * be hostile. It is here because it was the one place in either webview shell
 * where a value reached the document unescaped, and "it happens to be
 * trusted" is a property of today's caller rather than of the code.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'orizzonte.sidebar';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly version: string = '0.0.0',
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
      // Only the directories the view actually loads from. The whole extension
      // directory was reachable before, which is a wider grant than a logo, a
      // button and an icon font need.
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicons'),
      ],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: { type: string; url?: string }) => {
        switch (message.type) {
          case 'openPanel':
            void vscode.commands.executeCommand('orizzonte.open');
            break;
          case 'openUrl':
            // Through the shared helper, which checks the scheme. This used to
            // hand any URI straight to `openExternal` — including the forms
            // that do something other than open a web page.
            if (message.url) {
              void openExternalUrl(message.url);
            }
            break;
        }
      },
    );
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'orizzonte.png'),
    );

    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicons', 'codicon.css'),
    );

    const nonce = createNonce();
    const csp = buildContentSecurityPolicy(webview, nonce);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${codiconUri}" rel="stylesheet" />
  <title>Orizzonte Sidebar</title>
  <style>
    /*
     * The panel's tokens, restated because this view is a hand-written
     * document rather than part of the webview bundle. Kept to the same three
     * radii the panel uses — this file had accumulated 16px, 12px, 8px and 6px
     * between them.
     */
    :root {
      --orizzonte-radius: 4px;
      --orizzonte-radius-lg: 8px;
      --orizzonte-radius-pill: 999px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      padding: 16px 12px;
      line-height: 1.4;
    }
    .sidebar {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      width: 100%;
    }
    .logo-container {
      margin-top: 8px;
      margin-bottom: 12px;
    }
    .logo-img {
      width: 72px;
      height: 72px;
      object-fit: contain;
      border-radius: var(--orizzonte-radius-lg);
      box-shadow: 0 4px 14px var(--vscode-widget-shadow);
    }
    .title {
      font-size: 1.15em;
      font-weight: 700;
      color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
      margin-bottom: 6px;
    }
    .version-badge {
      display: inline-block;
      padding: 2px 10px;
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border: 1px solid var(--vscode-badge-background);
      border-radius: var(--orizzonte-radius-pill);
      font-size: 0.82em;
      font-weight: 600;
      margin-bottom: 14px;
    }
    .description {
      font-size: 0.88em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 18px;
      padding: 0 4px;
    }
    .btn-primary {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      padding: 9px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: var(--orizzonte-radius);
      font-size: 0.95em;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 6px var(--vscode-widget-shadow);
      transition: background-color 0.15s ease;
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .divider {
      width: 100%;
      height: 1px;
      background-color: var(--vscode-sideBar-border, var(--vscode-panel-border));
      margin: 20px 0 16px 0;
      border: none;
    }
    .github-section {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      text-align: left;
    }
    .github-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.78em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
      margin-bottom: 10px;
    }
    .github-icon {
      fill: currentColor;
    }
    .repo-card {
      width: 100%;
      padding: 10px 12px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: var(--orizzonte-radius-lg);
      margin-bottom: 12px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
      /* It is a <button> now, so the UA's own text styling has to be undone. */
      display: block;
      text-align: left;
      font: inherit;
      color: inherit;
    }
    .repo-card:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .repo-title {
      font-size: 0.9em;
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 2px;
      word-break: break-all;
    }
    .repo-sub {
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
    }
    .github-links {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .github-link-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 10px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-widget-border);
      border-radius: var(--orizzonte-radius);
      font-size: 0.85em;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
      text-align: left;
    }
    .github-link-btn:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }
    .author-footer {
      margin-top: 16px;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      width: 100%;
      text-align: center;
    }
    .author-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
      /* Same reset: a <button> that has to read as inline text. */
      background: none;
      border: none;
      padding: 0;
      font: inherit;
    }
    .author-link:hover {
      text-decoration: underline;
    }
    /*
     * Keyboard focus has to be visible for the same reason it has to be
     * possible. One rule covering every control here rather than one per
     * class, so a control added later cannot miss it.
     */
    button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
  </style>
</head>
<body>
  <div class="sidebar">
    <div class="logo-container">
      <img src="${logoUri}" alt="Orizzonte Logo" class="logo-img" />
    </div>

    <h2 class="title">Orizzonte</h2>
    <span class="version-badge">v${escapeHtml(this.version)}</span>

    <p class="description">
      Universal Visual Package Manager for Visual Studio Code
    </p>

    <button type="button" class="btn-primary" id="btn-open">
      Open Orizzonte
    </button>

    <div class="divider"></div>

    <div class="github-section">
      <div class="github-header">
        <svg class="github-icon" viewBox="0 0 16 16" width="14" height="14">
          <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
        </svg>
        GitHub Project
      </div>

      <!--
        A button, not a div with a click handler. The three links below it were
        already real buttons; this and the author credit were not, so neither
        could be reached with Tab or activated with Enter — they were clickable
        with a pointer only, in a panel whose every other control is keyboard
        operable.
      -->
      <button type="button" class="repo-card" id="link-repo">
        <div class="repo-title">
          salvatorecorvaglia/orizzonte
        </div>
        <div class="repo-sub">Source code, releases &amp; issues</div>
      </button>

      <div class="github-links">
        <button type="button" class="github-link-btn" id="link-star">
          <span class="codicon codicon-star-full"></span> Star on GitHub
        </button>
        <button type="button" class="github-link-btn" id="link-issues">
          <span class="codicon codicon-bug"></span> Report an Issue
        </button>
        <button type="button" class="github-link-btn" id="link-changelog">
          <span class="codicon codicon-history"></span> Release Notes
        </button>
      </div>

      <div class="author-footer">
        Created by <button type="button" id="link-author" class="author-link">@salvatorecorvaglia</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('btn-open').addEventListener('click', () => {
      vscode.postMessage({ type: 'openPanel' });
    });

    const repoUrl = 'https://github.com/salvatorecorvaglia/orizzonte';

    document.getElementById('link-repo').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: repoUrl });
    });
    document.getElementById('link-star').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: repoUrl });
    });
    document.getElementById('link-issues').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: repoUrl + '/issues' });
    });
    document.getElementById('link-changelog').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: repoUrl + '/releases' });
    });
    document.getElementById('link-author').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: 'https://github.com/salvatorecorvaglia' });
    });
  </script>
</body>
</html>`;
  }
}
