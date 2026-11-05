/**
 * composer.lock.
 *
 * `packages` and `packages-dev` are both arrays of installed packages; both
 * readers walk the same concatenation of them.
 */

import { buildResolutionGraph, resolutionId } from './graph.js';
import { addResolved, addVersion, type LockfileReader } from './types.js';

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

    const graph = buildResolutionGraph(
      all.map((entry) => ({
        id: resolutionId(entry.name, entry.version),
        name: entry.name,
        version: entry.version,
        dependencies: Object.entries(entry.require ?? {})
          .filter(([name]) => name !== 'php' && !name.startsWith('ext-'))
          .map(([name, constraint]) => ({ name, constraint })),
      })),
      'composer',
    );
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

  resolved(text) {
    const all = entries(text);
    if (!all) return undefined;

    const resolved = new Map<string, string[]>();
    for (const entry of all) {
      // `v3.5.0` and `3.5.0` are the same release; registries answer with
      // the second, so the comparison has to use it too.
      if (entry.version) {
        addResolved(resolved, entry.name, entry.version.replace(/^v/, ''));
      }
    }
    return { all: resolved };
  },
};
