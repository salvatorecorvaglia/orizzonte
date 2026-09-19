/**
 * uv.lock and poetry.lock.
 *
 * Both are TOML arrays of `[[package]]` tables and share the version read, but
 * they record requirements differently — Poetry nests them under
 * `[package.dependencies]`, uv under a `dependencies = [{ name = "..." }]`
 * array — so the edge reader handles both rather than pretending they match.
 *
 * Every name goes through PEP 503 normalisation, which is what lets a manifest
 * declaring `Jinja2` meet a lockfile recording `jinja2`.
 */

import { normalizeName } from '../../providers/python/index.js';
import { splitTomlPackageBlocks, tomlField } from './toml.js';
import { addVersion, type LockfileReader } from './types.js';

function reader(file: string): LockfileReader {
  return {
    file,

    edges(text) {
      const graph = new Map<string, string[]>();

      for (const block of splitTomlPackageBlocks(text)) {
        const name = tomlField(block, 'name');
        if (!name) continue;

        const children = new Set<string>();

        // uv: dependencies = [{ name = "x" }, ...]
        const uvArray = /\ndependencies\s*=\s*\[([\s\S]*?)\n\]/.exec(
          block,
        )?.[1];
        if (uvArray) {
          for (const match of uvArray.matchAll(/name\s*=\s*"([^"]+)"/g)) {
            children.add(normalizeName(match[1]));
          }
        }

        // poetry: [package.dependencies] followed by `key = "constraint"`
        // lines, ending at the next table header.
        const poetryTable =
          /\n\[package\.dependencies\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(
            block,
          )?.[1];
        if (poetryTable) {
          for (const line of poetryTable.split(/\r?\n/)) {
            const key = /^([A-Za-z0-9._-]+)\s*=/.exec(line.trim())?.[1];
            if (key) children.add(normalizeName(key));
          }
        }

        graph.set(normalizeName(name), [...children]);
      }

      return graph.size > 0 ? graph : undefined;
    },

    versions(text) {
      const versions = new Map<string, Set<string>>();
      for (const block of splitTomlPackageBlocks(text)) {
        const name = tomlField(block, 'name');
        const version = tomlField(block, 'version');
        if (name && version) {
          addVersion(versions, normalizeName(name), version);
        }
      }
      return versions.size > 0 ? versions : undefined;
    },
  };
}

export const uvLockfile = reader('uv.lock');
export const poetryLockfile = reader('poetry.lock');
