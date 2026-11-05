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

import { parse as parseToml } from 'smol-toml';
import { normalizeName } from '../pep503.js';
import {
  buildResolutionGraph,
  type GraphRecord,
  type GraphReference,
  resolutionId,
} from './graph.js';
import { splitTomlPackageBlocks, tomlField } from './toml.js';
import { addResolved, addVersion, type LockfileReader } from './types.js';

function reader(file: string): LockfileReader {
  return {
    file,

    edges(text) {
      let packages: Array<{
        name?: string;
        version?: string;
        source?: unknown;
        dependencies?: unknown;
      }>;
      try {
        packages =
          (parseToml(text) as { package?: typeof packages }).package ?? [];
      } catch {
        return undefined;
      }
      const records: GraphRecord[] = [];
      for (const entry of packages) {
        if (!entry.name) continue;
        const name = normalizeName(entry.name);
        const source = entry.source ? JSON.stringify(entry.source) : undefined;
        const dependencies: GraphReference[] = [];
        if (Array.isArray(entry.dependencies)) {
          for (const child of entry.dependencies as Array<{
            name?: string;
            version?: string;
            source?: unknown;
          }>) {
            if (child.name)
              dependencies.push({
                name: normalizeName(child.name),
                version: child.version,
                source: child.source ? JSON.stringify(child.source) : undefined,
              });
          }
        } else if (
          entry.dependencies &&
          typeof entry.dependencies === 'object'
        ) {
          for (const [child, value] of Object.entries(entry.dependencies)) {
            for (const alternative of Array.isArray(value) ? value : [value]) {
              const constraint =
                typeof alternative === 'string'
                  ? alternative
                  : (alternative as { version?: string } | undefined)?.version;
              dependencies.push({ name: normalizeName(child), constraint });
            }
          }
        }
        records.push({
          id: resolutionId(name, entry.version, source),
          name,
          version: entry.version,
          source,
          dependencies,
        });
      }
      const graph = buildResolutionGraph(records, 'python');
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

    resolved(text) {
      const all = new Map<string, string[]>();
      for (const block of splitTomlPackageBlocks(text)) {
        const name = tomlField(block, 'name');
        const version = tomlField(block, 'version');
        if (name && version) addResolved(all, normalizeName(name), version);
      }
      return all.size > 0 ? { all } : undefined;
    },
  };
}

export const uvLockfile = reader('uv.lock');
export const poetryLockfile = reader('poetry.lock');
