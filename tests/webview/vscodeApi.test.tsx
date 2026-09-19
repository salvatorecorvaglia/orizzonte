/**
 * The host↔webview bridge contract: `post` reaches the extension host,
 * `onHostMessage` delivers (and can stop delivering) messages from it, and
 * state round-trips through `saveState`/`loadState`. Every other webview test
 * exercises this indirectly through a full component; this pins the bridge
 * itself down.
 */

import { describe, expect, it } from 'vitest';
import {
  loadState,
  onHostMessage,
  post,
  saveState,
} from '../../src/webview/vscodeApi.js';
import { posted } from './setup.js';

describe('post', () => {
  it('forwards the message to the extension host', () => {
    post({ type: 'refresh' });
    expect(posted).toEqual([{ type: 'refresh' }]);
  });
});

describe('onHostMessage', () => {
  it('delivers messages posted to the window', async () => {
    const received: unknown[] = [];
    const dispose = onHostMessage((message) => received.push(message));

    window.postMessage({ type: 'scanning', busy: true }, '*');
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispose();

    expect(received).toEqual([{ type: 'scanning', busy: true }]);
  });

  it('stops delivering messages once disposed', async () => {
    const received: unknown[] = [];
    const dispose = onHostMessage((message) => received.push(message));
    dispose();

    window.postMessage({ type: 'scanning', busy: false }, '*');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual([]);
  });

  it('does not affect a listener registered separately', async () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    const disposeFirst = onHostMessage((message) => first.push(message));
    const disposeSecond = onHostMessage((message) => second.push(message));

    disposeFirst();
    window.postMessage({ type: 'refresh' }, '*');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first).toEqual([]);
    expect(second).toEqual([{ type: 'refresh' }]);

    disposeSecond();
  });
});

describe('saveState / loadState', () => {
  it('returns undefined before anything has been saved', () => {
    expect(loadState()).toBeUndefined();
  });

  it('round-trips whatever was last saved', () => {
    saveState({ sort: 'name', filters: ['outdated'] });
    expect(loadState()).toEqual({ sort: 'name', filters: ['outdated'] });

    saveState({ sort: 'severity', filters: [] });
    expect(loadState()).toEqual({ sort: 'severity', filters: [] });
  });
});
