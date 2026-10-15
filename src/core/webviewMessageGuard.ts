/**
 * The runtime shape check for messages arriving from the webview.
 *
 * `WebviewMessage` is a compile-time contract between two bundles this
 * extension ships together, and the webview runs under a strict CSP — so a
 * malformed message means a bug, not an attack. But the host acts on these
 * messages: it runs package managers and opens files. Checking the shape at
 * the boundary means a bad message is dropped here, whole, rather than
 * reaching a handler as `undefined` fields and failing somewhere downstream.
 *
 * Only the shape. Whether a path is a manifest the scan found, or a version
 * passes its provider's grammar, is still decided by the handlers — see
 * `webviewRequests.ts`.
 *
 * Kept free of `vscode` so it can be unit tested directly.
 */

import type { WebviewMessage } from './protocol.js';
import type { DepScope, Ecosystem } from './types.js';

const ECOSYSTEMS: ReadonlySet<string> = new Set<Ecosystem>([
  'node',
  'python',
  'cargo',
  'golang',
  'composer',
  'maven',
  'gradle',
]);

const SCOPES: ReadonlySet<string> = new Set<DepScope>([
  'prod',
  'dev',
  'build',
  'optional',
  'peer',
]);

type Fields = Record<string, unknown>;

const isString = (value: unknown): value is string => typeof value === 'string';

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

/** What each message type must carry, beyond `type` itself. */
const VALIDATORS: Record<WebviewMessage['type'], (message: Fields) => boolean> =
  {
    ready: () => true,
    refresh: () => true,
    checkUpdates: () => true,
    exportReport: () => true,
    search: (m) =>
      isString(m.query) &&
      isString(m.requestId) &&
      (m.ecosystem === 'all' ||
        (isString(m.ecosystem) && ECOSYSTEMS.has(m.ecosystem))),
    cancelSearch: (m) => isString(m.requestId),
    install: (m) =>
      isString(m.name) &&
      (m.version === null || isString(m.version)) &&
      isString(m.scope) &&
      SCOPES.has(m.scope) &&
      isString(m.manifestPath),
    update: (m) => isString(m.depKey) && isString(m.toVersion),
    updateAll: (m) => m.manifestPath === undefined || isString(m.manifestPath),
    uninstall: (m) => isString(m.depKey),
    bulkUpdate: (m) =>
      Array.isArray(m.targets) &&
      m.targets.every(
        (target: unknown) =>
          typeof target === 'object' &&
          target !== null &&
          isString((target as Fields).depKey) &&
          isString((target as Fields).toVersion),
      ),
    bulkUninstall: (m) => isStringArray(m.depKeys),
    requestDetails: (m) => isString(m.depKey),
    requestWhy: (m) => isString(m.depKey),
    requestDuplicates: (m) => isString(m.requestId),
    requestLicenses: (m) => isString(m.requestId),
    requestChangelog: (m) => isString(m.depKey),
    requestDependencyDiff: (m) => isString(m.requestId),
    openExternal: (m) => isString(m.url),
    openManifest: (m) =>
      isString(m.manifestPath) &&
      (m.packageName === undefined || isString(m.packageName)),
  };

/** True when `value` is a well-formed `WebviewMessage`. */
export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Fields;
  if (!isString(message.type) || !Object.hasOwn(VALIDATORS, message.type)) {
    return false;
  }
  return VALIDATORS[message.type as WebviewMessage['type']](message);
}
