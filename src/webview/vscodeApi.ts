/**
 * The bridge to the extension host.
 *
 * `acquireVsCodeApi()` may only be called once per webview load, so the handle
 * is captured here and shared.
 */

import type {
  HostMessage,
  VsCodeApi,
  WebviewMessage,
} from '../core/protocol.js';

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}

export function onHostMessage(
  handler: (message: HostMessage) => void,
): () => void {
  const listener = (event: MessageEvent<HostMessage>) => handler(event.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** Persists UI state across panel reloads (sort order, filters). */
export function saveState<T>(state: T): void {
  api.setState(state);
}

export function loadState<T>(): T | undefined {
  return api.getState<T>();
}
