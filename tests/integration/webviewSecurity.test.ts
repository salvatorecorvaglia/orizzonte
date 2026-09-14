/**
 * `webviewSecurity.ts` imports `vscode`, so — like every other file that
 * does — it cannot be loaded under vitest at all (see the exclusion list in
 * `vitest.config.ts`). This is the one place it can actually run.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  buildContentSecurityPolicy,
  createNonce,
  openExternalUrl,
} from '../../src/ui/webviewSecurity.js';

describe('createNonce', () => {
  it('is unguessable and CSP-safe', () => {
    const nonce = createNonce();

    // 24 random bytes, base64url-encoded: exactly 32 characters, no padding.
    assert.equal(nonce.length, 32);
    assert.match(nonce, /^[A-Za-z0-9_-]+$/);
  });

  it('never repeats across calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createNonce()));
    assert.equal(seen.size, 50, 'two calls produced the same nonce');
  });
});

describe('openExternalUrl', () => {
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

  it('opens an https URL', async () => {
    const stub = stubOpenExternal();
    try {
      await openExternalUrl('https://example.com/package');
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].toString(), 'https://example.com/package');
    } finally {
      stub.restore();
    }
  });

  it('opens an http URL', async () => {
    const stub = stubOpenExternal();
    try {
      await openExternalUrl('http://example.com/package');
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });

  it('refuses a file: URL', async () => {
    const stub = stubOpenExternal();
    try {
      await openExternalUrl('file:///etc/passwd');
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });

  it('refuses a command: URL', async () => {
    // The form that would let a malicious registry field trigger an
    // arbitrary VS Code command rather than just opening a page.
    const stub = stubOpenExternal();
    try {
      await openExternalUrl('command:workbench.action.closeWindow');
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });

  it('refuses a vscode: URL', async () => {
    const stub = stubOpenExternal();
    try {
      await openExternalUrl('vscode://some.extension/action');
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });

  it('does not throw on an unparseable URL', async () => {
    const stub = stubOpenExternal();
    try {
      await openExternalUrl('not a url at all');
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });
});

describe('buildContentSecurityPolicy', () => {
  /** A real webview, disposed after the test — this needs a live `cspSource`. */
  function withWebview<T>(run: (webview: vscode.Webview) => T): T {
    const panel = vscode.window.createWebviewPanel(
      'orizzonte.test',
      'Orizzonte Test',
      vscode.ViewColumn.Active,
      {},
    );
    try {
      return run(panel.webview);
    } finally {
      panel.dispose();
    }
  }

  it('locks scripts to the given nonce and blocks network access', () => {
    withWebview((webview) => {
      const nonce = createNonce();
      const csp = buildContentSecurityPolicy(webview, nonce);

      assert.match(csp, /default-src 'none'/);
      assert.match(csp, new RegExp(`script-src 'nonce-${nonce}'`));
      assert.match(csp, /connect-src 'none'/);
    });
  });

  it('scopes image/style/font sources to the webview itself', () => {
    withWebview((webview) => {
      const csp = buildContentSecurityPolicy(webview, createNonce());

      for (const directive of ['img-src', 'style-src', 'font-src']) {
        assert.ok(
          csp.includes(`${directive} ${webview.cspSource}`),
          `expected "${directive}" to be scoped to ${webview.cspSource}`,
        );
      }
    });
  });

  it('produces a fresh nonce-bound policy on every call', () => {
    withWebview((webview) => {
      const first = buildContentSecurityPolicy(webview, createNonce());
      const second = buildContentSecurityPolicy(webview, createNonce());
      assert.notEqual(first, second);
    });
  });
});
