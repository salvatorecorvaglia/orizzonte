/**
 * package-lock.json (v2/v3).
 *
 * The `packages` map is keyed by install path, which is what carries both the
 * dependency edges and the resolved versions — so both readers here share one
 * understanding of what a key means.
 */

import {
  addEdges,
  addResolved,
  addVersion,
  type LockfileReader,
} from './types.js';

/** The synthetic node standing for the project itself. */
export const NPM_ROOT = '__root__';

interface NpmLock {
  packages?: Record<
    string,
    { version?: string; dependencies?: Record<string, string> }
  >;
  /** lockfileVersion 1's only map; v2 keeps it for old npm clients. */
  dependencies?: Record<string, { version?: string }>;
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

  /**
   * An install path names who owns the copy: `node_modules/x` is the root's,
   * `packages/web/node_modules/x` is the `packages/web` member's own (npm puts
   * one there when the member needs a version the root's hoisted copy does
   * not satisfy), and `node_modules/a/node_modules/x` is `a`'s private copy.
   *
   * A member resolves its own copy first and the hoisted one otherwise — the
   * same lookup Node does. Answering every member with the hoisted copy
   * reported the wrong version for exactly the package that differed.
   */
  resolved(text) {
    const lock = parse(text);
    if (!lock) return undefined;

    const root = new Map<string, string>();
    const members = new Map<string, Map<string, string>>();
    const nested: Array<[string, string]> = [];

    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      if (!entry.version) continue;
      const marker = key.lastIndexOf('node_modules/');
      if (marker < 0) continue; // the root, or a workspace member's own entry
      const name = key.slice(marker + 'node_modules/'.length);
      const owner = key.slice(0, marker).replace(/\/$/, '');

      if (owner === '') root.set(name, entry.version);
      else if (!owner.includes('node_modules')) {
        const map = members.get(owner) ?? new Map<string, string>();
        map.set(name, entry.version);
        members.set(owner, map);
      } else nested.push([name, entry.version]);
    }

    const all = new Map<string, string[]>();
    for (const [name, version] of root) addResolved(all, name, version);
    for (const map of members.values()) {
      for (const [name, version] of map) addResolved(all, name, version);
    }
    for (const [name, version] of nested) addResolved(all, name, version);
    for (const [name, entry] of Object.entries(lock.dependencies ?? {})) {
      if (entry.version) addResolved(all, name, entry.version);
    }

    return {
      all,
      importer: (importer) => {
        if (importer === '') return root;
        const own = members.get(importer);
        return own ? new Map([...root, ...own]) : root;
      },
    };
  },
};
