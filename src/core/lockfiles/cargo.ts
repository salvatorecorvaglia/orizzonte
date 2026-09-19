/**
 * Cargo.lock.
 *
 * A flat sequence of `[[package]]` tables, read with the shared TOML block
 * splitter and a couple of field reads rather than a full TOML parse — the
 * two fields either reader needs are the same two.
 */

import { splitTomlPackageBlocks, tomlField } from './toml.js';
import { addVersion, type LockfileReader } from './types.js';

export const cargoLockfile: LockfileReader = {
  file: 'Cargo.lock',

  edges(text) {
    const graph = new Map<string, string[]>();
    for (const block of splitTomlPackageBlocks(text)) {
      const name = tomlField(block, 'name');
      if (!name) continue;
      const depsBlock =
        /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(block)?.[1] ?? '';
      graph.set(
        name,
        [...depsBlock.matchAll(/"([^"\s]+)/g)].map(
          (match) => match[1].split(' ')[0],
        ),
      );
    }
    return graph;
  },

  versions(text) {
    const versions = new Map<string, Set<string>>();
    for (const block of splitTomlPackageBlocks(text)) {
      const name = tomlField(block, 'name');
      const version = tomlField(block, 'version');
      if (name && version) addVersion(versions, name, version);
    }
    return versions;
  },
};
