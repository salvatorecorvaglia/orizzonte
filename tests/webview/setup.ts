/**
 * jsdom setup for the webview suite.
 *
 * Two things the real VS Code webview host provides have to be stood up here:
 * `acquireVsCodeApi`, which the bridge captures at module load, and the layout
 * metrics the virtualizer reads — jsdom reports every element as zero-sized, so
 * without them no row is ever considered visible and the table renders empty.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// Tells React that `act()` is available, so state updates driven from tests are
// batched and flushed rather than warned about.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Messages the app has posted, for assertions. */
export const posted: unknown[] = [];

let persisted: unknown;

vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: (message: unknown) => posted.push(message),
  getState: () => persisted,
  setState: (state: unknown) => {
    persisted = state;
  },
}));

/**
 * Give every element a non-zero box.
 *
 * @tanstack/react-virtual measures the scroll container to decide how many rows
 * to mount; jsdom's default of 0 would mount none.
 */
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  value: 800,
});
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  value: 1200,
});
HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return {
    width: 1200,
    height: 800,
    top: 0,
    left: 0,
    bottom: 800,
    right: 1200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
};

// The virtualizer observes the scroll element; jsdom has no implementation.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

HTMLElement.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  posted.length = 0;
  persisted = undefined;
});
