/**
 * Cargo.lock.
 *
 * Resolution identities include the package name, version and source.
 * Dependency references may explicitly select a version and source.
 */

import {
  buildResolutionGraph,
  type GraphRecord,
  resolutionId,
} from './graph.js';
import { splitTomlPackageBlocks, tomlField } from './toml.js';
import { addResolved, addVersion, type LockfileReader } from './types.js';

export const cargoLockfile: LockfileReader = {
  file: 'Cargo.lock',

  edges(text) {
    const records: GraphRecord[] = [];
    for (const block of splitTomlPackageBlocks(text)) {
      const name = tomlField(block, 'name');
      if (!name) continue;
      const version = tomlField(block, 'version');
      const source = tomlField(block, 'source');
      const depsBlock =
        /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(block)?.[1] ?? '';
      records.push({
        id: resolutionId(name, version, source),
        name,
        version,
        source,
        dependencies: [...depsBlock.matchAll(/"([^"\n]+)"/g)].map((match) => {
          const [child, childVersion, ...origin] = match[1].split(' ');
          return {
            name: child,
            version: childVersion,
            source: origin.length
              ? origin.join(' ').replace(/^\(|\)$/g, '')
              : undefined,
          };
        }),
      });
    }
    const graph = buildResolutionGraph(records, 'cargo');
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

  resolved(text) {
    const all = new Map<string, string[]>();
    for (const block of splitTomlPackageBlocks(text)) {
      const name = tomlField(block, 'name');
      const version = tomlField(block, 'version');
      if (name && version) addResolved(all, name, version);
    }
    return { all };
  },
};
