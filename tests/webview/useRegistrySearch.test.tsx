import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { HostMessage } from '../../src/core/protocol.js';
import { useRegistrySearch } from '../../src/webview/useRegistrySearch.js';
import { posted } from './setup.js';

function lastRequest(): string {
  const requests = posted as Array<{ type: string; requestId: string }>;
  return requests.filter((message) => message.type === 'search').at(-1)!
    .requestId;
}

describe('registry search correlation', () => {
  it('ignores superseded responses and keeps the current request loading', () => {
    const { result } = renderHook(() => useRegistrySearch());
    act(() => result.current.search('first', 'node'));
    const old = lastRequest();
    act(() => result.current.search('second', 'node'));
    const current = lastRequest();
    act(() =>
      result.current.receive({
        type: 'searchError',
        requestId: old,
        message: 'old failure',
      }),
    );
    expect(result.current.searching).toBe(true);
    expect(result.current.error).toBeUndefined();
    act(() =>
      result.current.receive({
        type: 'searchResults',
        requestId: current,
        results: [{ name: 'second', version: '1', ecosystem: 'node' }],
        failed: ['python'],
      }),
    );
    expect(result.current.results[0].name).toBe('second');
    expect(result.current.partialFailure).toEqual(['python']);
    expect(result.current.searching).toBe(false);
  });
  it('cancels active work and ignores its late response', () => {
    const { result } = renderHook(() => useRegistrySearch());
    act(() => result.current.search('first', 'all'));
    const requestId = lastRequest();
    act(() => result.current.cancel());
    expect(posted).toContainEqual({ type: 'cancelSearch', requestId });
    act(() =>
      result.current.receive({
        type: 'searchResults',
        requestId,
        results: [{ name: 'old', version: '1', ecosystem: 'node' }],
        failed: [],
      }),
    );
    expect(result.current.results).toEqual([]);
  });
  it('reports a current failure and clears its loading state', () => {
    const { result } = renderHook(() => useRegistrySearch());
    act(() => result.current.search('first', 'node'));
    const response: Extract<HostMessage, { type: 'searchError' }> = {
      type: 'searchError',
      requestId: lastRequest(),
      message: 'offline',
    };
    act(() => result.current.receive(response));
    expect(result.current.error).toBe('offline');
    expect(result.current.activeId).toBeUndefined();
    expect(result.current.searching).toBe(false);
  });
});
