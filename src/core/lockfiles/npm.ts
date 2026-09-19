/**
 * package-lock.json (v2/v3).
 *
 * The `packages` map is keyed by install path, which is what carries both the
 * dependency edges and the resolved versions — so both readers here share one
 * understanding of what a key means.
 */

import { addEdges, addVersion, type LockfileReader } from './types.js';

/** The synthetic node standing for the project itself. */
export const NPM_ROOT = '__root__';

interface NpmLock {
  packages?: Record<
    string,
    { version?: string; dependencies?: Record<string, string> }
  >;
}

/**
 * Turns a `packages` key from a v2/v3 npm lockfile into a graph node name.
 *
 * Three shapes appear, and only one of them mentions `node_modules`:
 *   ""                         the root project
 *   "node_modules/lodash"      an installed package
 *   "packages/web"             a workspace member
 *
 * Slicing blindly from `lastIndexOf('node_modules/')` yields an empty string
 * for that third case — every workspace member collapsing onto one nameless
 * node, with all their edges unioned together — which is exactly the monorepo
 * where "why is this installed" is worth asking.
 */
export function npmLockName(key: string): string {
  if (key === '') return NPM_ROOT;

  const marker = key.lastIndexOf('node_modules/');
  if (marker >= 0) return key.slice(marker + 'node_modules/'.length);

  // A workspace member. It is a root of the graph in its own right: nothing
  // depends on it, and its dependencies are the project's own.
  return NPM_ROOT;
}

function parse(text: string): NpmLock | undefined {
  try {
    return JSON.parse(text) as NpmLock;
  } catch {
    return undefined;
  }
}

export const npmLockfile: LockfileReader = {
  file: 'package-lock.json',

  edges(text) {
    const lock = parse(text);
    if (!lock) return undefined;

    const graph = new Map<string, string[]>();
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      // A package can appear at several install paths; union their edges.
      addEdges(graph, npmLockName(key), Object.keys(entry.dependencies ?? {}));
    }
    return graph;
  },

  versions(text) {
    const lock = parse(text);
    if (!lock) return undefined;

    const versions = new Map<string, Set<string>>();
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      if (!entry.version) continue;
      const name = npmLockName(key);
      // The root project and workspace members collapse onto `__root__`;
      // neither is "an installed dependency with a version".
      if (name === NPM_ROOT) continue;
      addVersion(versions, name, entry.version);
    }
    return versions;
  },
};
