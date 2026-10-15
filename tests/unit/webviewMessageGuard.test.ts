/**
 * The host acts on webview messages — it runs package managers and opens
 * files — so a malformed one is dropped at the boundary, whole.
 */

import { describe, expect, it } from 'vitest';
import { isWebviewMessage } from '../../src/core/webviewMessageGuard.js';

describe('isWebviewMessage', () => {
  it.each([
    [{ type: 'ready' }],
    [{ type: 'search', query: 'react', ecosystem: 'all', requestId: '1' }],
    [{ type: 'search', query: 'serde', ecosystem: 'cargo', requestId: '1' }],
    [
      {
        type: 'install',
        name: 'react',
        version: null,
        scope: 'dev',
        manifestPath: '/p/package.json',
      },
    ],
    [{ type: 'updateAll' }],
    [{ type: 'updateAll', manifestPath: '/p/package.json' }],
    [{ type: 'bulkUpdate', targets: [{ depKey: 'k', toVersion: '1.0.0' }] }],
    [{ type: 'bulkUninstall', depKeys: ['a', 'b'] }],
    [{ type: 'openManifest', manifestPath: '/p/package.json' }],
  ])('accepts %j', (message) => {
    expect(isWebviewMessage(message)).toBe(true);
  });

  it.each([
    [null],
    ['ready'],
    [{}],
    [{ type: 'nonsense' }],
    [{ type: 'toString' }],
    [{ type: 'update', depKey: 'k' }],
    [{ type: 'search', query: 'x', ecosystem: 'rubygems', requestId: '1' }],
    [
      {
        type: 'install',
        name: 'react',
        version: 1,
        scope: 'prod',
        manifestPath: '/p',
      },
    ],
    [
      {
        type: 'install',
        name: 'react',
        version: null,
        scope: 'everything',
        manifestPath: '/p',
      },
    ],
    [{ type: 'bulkUpdate', targets: [{ depKey: 'k' }] }],
    [{ type: 'bulkUninstall', depKeys: ['a', 2] }],
    [{ type: 'openExternal' }],
  ])('rejects %j', (message) => {
    expect(isWebviewMessage(message)).toBe(false);
  });
});
