/**
 * `sidebarProvider.ts` imports `vscode`, so — like `terminalRunner.ts` and
 * `webviewSecurity.ts` — it cannot be loaded under vitest (see the exclusion
 * list in `vitest.config.ts`) and can only be exercised here.
 *
 * `extension.test.ts`'s "sidebar view" suite only asserts that
 * `resolveWebviewView` runs without throwing; it never sends a message into
 * the resulting webview. This file exercises the two message types
 * `resolveWebviewView` actually handles (`openPanel`, `openUrl`), using a
 * real `vscode.Webview` (borrowed from a hidden panel, the same technique
 * `webviewSecurity.test.ts` uses) so `cspSource`/`asWebviewUri` are genuine —
 * only `onDidReceiveMessage` is captured rather than driven by real webview
 * script execution, since nothing in this test process can click a button
 * inside the webview's own isolated context.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SidebarViewProvider } from '../../src/ui/sidebarProvider.js';

type MessageHandler = (message: { type: string; url?: string }) => void;

/**
 * Runs `resolveWebviewView` against a real webview (so the CSP/HTML build
 * genuinely executes) and hands back the message handler it registered.
 */
function resolveWithRealWebview(provider: SidebarViewProvider): {
  handler: MessageHandler;
  dispose: () => void;
} {
  const panel = vscode.window.createWebviewPanel(
    'orizzonte.sidebar.test',
    'Orizzonte Sidebar Test',
    vscode.ViewColumn.Active,
    {},
  );

  let handler: MessageHandler | undefined;
  const fakeView = {
    webview: {
      ...panel.webview,
      get options() {
        return panel.webview.options;
      },
      set options(value) {
        panel.webview.options = value;
      },
      get html() {
        return panel.webview.html;
      },
      set html(value) {
        panel.webview.html = value;
      },
      asWebviewUri: (uri: vscode.Uri) => panel.webview.asWebviewUri(uri),
      get cspSource() {
        return panel.webview.cspSource;
      },
      onDidReceiveMessage: (listener: MessageHandler) => {
        handler = listener;
        return { dispose: () => undefined };
      },
    },
  } as unknown as vscode.WebviewView;

  provider.resolveWebviewView(
    fakeView,
    {} as vscode.WebviewViewResolveContext,
    new vscode.CancellationTokenSource().token,
  );

  assert.ok(handler, 'resolveWebviewView did not register a message handler');
  return { handler: handler as MessageHandler, dispose: () => panel.dispose() };
}

/** Stands in for `vscode.env.openExternal` for the duration of one test. */
function stubOpenExternal() {
  const calls: vscode.Uri[] = [];
  const original = vscode.env.openExternal;
  (
    vscode.env as { openExternal: typeof vscode.env.openExternal }
  ).openExternal = async (uri: vscode.Uri) => {
    calls.push(uri);
    return true;
  };
  return {
    calls,
    restore: () => {
      (
        vscode.env as { openExternal: typeof vscode.env.openExternal }
      ).openExternal = original;
    },
  };
}

/** Stands in for `vscode.commands.executeCommand` for the duration of one test. */
function stubExecuteCommand() {
  const calls: string[] = [];
  const original = vscode.commands.executeCommand;
  (
    vscode.commands as {
      executeCommand: typeof vscode.commands.executeCommand;
    }
  ).executeCommand = (async (command: string) => {
    calls.push(command);
    return undefined;
  }) as typeof vscode.commands.executeCommand;
  return {
    calls,
    restore: () => {
      (
        vscode.commands as {
          executeCommand: typeof vscode.commands.executeCommand;
        }
      ).executeCommand = original;
    },
  };
}

describe('SidebarViewProvider message handling', () => {
  it('routes "openPanel" to the orizzonte.open command', () => {
    const { handler, dispose } = resolveWithRealWebview(
      new SidebarViewProvider(vscode.Uri.file(__dirname)),
    );
    const stub = stubExecuteCommand();
    try {
      handler({ type: 'openPanel' });
      assert.deepEqual(stub.calls, ['orizzonte.open']);
    } finally {
      stub.restore();
      dispose();
    }
  });

  it('routes "openUrl" through the scheme-checked opener, not vscode.env.openExternal directly', () => {
    const { handler, dispose } = resolveWithRealWebview(
      new SidebarViewProvider(vscode.Uri.file(__dirname)),
    );
    const stub = stubOpenExternal();
    try {
      handler({
        type: 'openUrl',
        url: 'https://github.com/salvatorecorvaglia/orizzonte',
      });
      assert.equal(stub.calls.length, 1);
      assert.equal(
        stub.calls[0].toString(),
        'https://github.com/salvatorecorvaglia/orizzonte',
      );
    } finally {
      stub.restore();
      dispose();
    }
  });

  it('refuses a non-http(s) URL the same way the panel does', () => {
    const { handler, dispose } = resolveWithRealWebview(
      new SidebarViewProvider(vscode.Uri.file(__dirname)),
    );
    const stub = stubOpenExternal();
    try {
      handler({ type: 'openUrl', url: 'command:workbench.action.closeWindow' });
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
      dispose();
    }
  });

  it('does nothing for "openUrl" with no url, and does not throw on an unknown type', () => {
    const { handler, dispose } = resolveWithRealWebview(
      new SidebarViewProvider(vscode.Uri.file(__dirname)),
    );
    const stub = stubOpenExternal();
    try {
      assert.doesNotThrow(() => handler({ type: 'openUrl' }));
      assert.equal(stub.calls.length, 0);
      assert.doesNotThrow(() => handler({ type: 'somethingUnrecognised' }));
    } finally {
      stub.restore();
      dispose();
    }
  });
});
