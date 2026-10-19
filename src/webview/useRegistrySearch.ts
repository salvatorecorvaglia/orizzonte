import { useCallback, useReducer, useRef } from 'react';
import type { HostMessage } from '../core/protocol.js';
import type { Ecosystem, SearchResult } from '../core/types.js';
import { post } from './vscodeApi.js';

type Response = Extract<HostMessage, { type: 'searchResults' | 'searchError' }>;
interface SearchState {
  results: SearchResult[];
  error?: string;
  partialFailure?: Ecosystem[];
  searching: boolean;
  activeId?: string;
}
type Action =
  | Response
  | { type: 'start'; requestId: string }
  | { type: 'cancel' };

function reduce(state: SearchState, action: Action): SearchState {
  switch (action.type) {
    case 'start':
      return {
        ...state,
        error: undefined,
        partialFailure: undefined,
        searching: true,
        activeId: action.requestId,
      };
    case 'cancel':
      return { ...state, searching: false, activeId: undefined };
    case 'searchResults':
      return {
        results: action.results,
        partialFailure: action.failed.length ? action.failed : undefined,
        searching: false,
      };
    case 'searchError':
      return {
        ...state,
        error: action.message,
        partialFailure: undefined,
        searching: false,
        activeId: undefined,
      };
  }
}

/** Owns search correlation independently of the app's scan and selection state. */
export function useRegistrySearch() {
  const [state, dispatch] = useReducer(reduce, {
    results: [],
    searching: false,
  });
  const active = useRef<string | undefined>(undefined);
  const cancel = useCallback(() => {
    if (active.current)
      post({ type: 'cancelSearch', requestId: active.current });
    active.current = undefined;
    dispatch({ type: 'cancel' });
  }, []);
  const search = useCallback((query: string, ecosystem: Ecosystem | 'all') => {
    if (active.current)
      post({ type: 'cancelSearch', requestId: active.current });
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    active.current = requestId;
    dispatch({ type: 'start', requestId });
    post({ type: 'search', query, ecosystem, requestId });
  }, []);
  const receive = useCallback((message: Response) => {
    if (message.requestId !== active.current) return;
    active.current = undefined;
    dispatch(message);
  }, []);
  return { ...state, search, receive, cancel };
}
