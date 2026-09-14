/**
 * The security primitives every Orizzonte webview shares.
 *
 * Orizzonte has two webview surfaces — the dependency panel and the Activity Bar
 * view — and they had drifted apart on exactly the details that matter: one
 * generated its CSP nonce from `Math.random`, and one opened whatever URL it was
 * handed without looking at the scheme. Neither difference was deliberate; they
 * were simply written at different times.
 *
 * Defining both here means a new surface gets the stronger behaviour by
 * importing it, rather than by whoever writes it remembering to.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * A CSP nonce.
 *
 * Has to be unguessable to be worth anything: a nonce an attacker can predict
 * is a `script-src` directive that permits their script. `Math.random` is not a
 * CSPRNG and is not seeded unpredictably, so it cannot supply one. Base64url
 * keeps the value valid inside `script-src 'nonce-...'` without escaping.
 */
export function createNonce(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * The Content-Security-Policy every Orizzonte webview shares.
 *
 * `connect-src 'none'` is deliberate: no webview talks to the network
 * directly — every registry call happens in the extension host. Scripts load
 * only under this load's nonce, so injected markup cannot run its own.
 *
 * Building this here rather than per-surface is what the whole file exists
 * for — see the module comment. A surface that needs a narrower policy can
 * still write its own, but the default for a new one is this, not a
 * hand-rolled string that quietly drops a directive.
 */
export function buildContentSecurityPolicy(
  webview: vscode.Webview,
  nonce: string,
): string {
  return [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `connect-src 'none'`,
  ].join('; ');
}

/**
 * Opens a URL in the user's browser, if it is one worth opening.
 *
 * Everything reaching this comes from a registry response or from the webview,
 * neither of which is ours to trust. The scheme check is what keeps a `file:`,
 * `command:` or `vscode:` URI — the forms that do something other than open a
 * web page — from being handed to `openExternal`.
 */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    const parsed = vscode.Uri.parse(url, true);
    if (parsed.scheme !== 'https' && parsed.scheme !== 'http') {
      return;
    }
    await vscode.env.openExternal(parsed);
  } catch {
    // An unparseable URL is simply ignored: there is nothing to open, and
    // nothing the user could do about a malformed link in a registry record.
  }
}
