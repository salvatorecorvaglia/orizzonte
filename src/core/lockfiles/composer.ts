/**
 * composer.lock.
 *
 * `packages` and `packages-dev` are both arrays of installed packages; both
 * readers walk the same concatenation of them.
 */

import { addVersion, type LockfileReader } from './types.js';

interface ComposerEntry {
  name: string;
  version?: string;
  require?: Record<string, string>;
}

interface ComposerLock {
  packages?: ComposerEntry[];
  'packages-dev'?: ComposerEntry[];
}

function entries(text: string): ComposerEntry[] | undefined {
  try {
    const lock = JSON.parse(text) as ComposerLock;
    return [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])];
  } catch {
    return undefined;
  }
}

export const composerLockfile: LockfileReader = {
  file: 'composer.lock',

  edges(text) {
    const all = entries(text);
    if (!all) return undefined;

    const graph = new Map<string, string[]>();
    for (const entry of all) {
      graph.set(
        entry.name,
        // `php` and `ext-*` are platform requirements, not packages anyone
        // installed — showing them as dependencies answers a question nobody
        // asked.
        Object.keys(entry.require ?? {}).filter(
          (name) => name !== 'php' && !name.startsWith('ext-'),
        ),
      );
    }
    return graph;
  },

  versions(text) {
    const all = entries(text);
    if (!all) return undefined;

    const versions = new Map<string, Set<string>>();
    for (const entry of all) {
      if (entry.version) addVersion(versions, entry.name, entry.version);
    }
    return versions;
  },
};
