/**
 * pnpm-lock.yaml.
 *
 * Read with the real YAML parser rather than by indentation: `importers:`
 * shares the same 2-space-indent, colon-terminated shape as `packages:`/
 * `snapshots:`, and a hand-rolled line scanner had no way to tell them apart
 * from the text alone. Only the latter two hold the resolved dependency
 * graph — that shape is stable across lockfile versions 5–9, where the
 * surrounding schema is not.
 */

import { parse as parseYaml } from 'yaml';
import {
  addEdges,
  addResolved,
  addVersion,
  type LockfileReader,
} from './types.js';

interface PnpmLockEntry {
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

/** A direct dependency: `{ specifier, version }` since v6, a bare string before. */
type PnpmImporterDep = string | { version?: string };

interface PnpmImporter {
  dependencies?: Record<string, PnpmImporterDep>;
  devDependencies?: Record<string, PnpmImporterDep>;
  optionalDependencies?: Record<string, PnpmImporterDep>;
}

interface PnpmLock {
  importers?: Record<string, PnpmImporter>;
  packages?: Record<string, PnpmLockEntry>;
  snapshots?: Record<string, PnpmLockEntry>;
}

/**
 * The version an importer entry resolved to, or undefined for one that is not
 * a registry version at all (`link:../utils` for a workspace sibling).
 */
function importerVersion(dep: PnpmImporterDep | undefined): string | undefined {
  const raw = typeof dep === 'string' ? dep : dep?.version;
  if (!raw || /^(?:link|file|workspace):/.test(raw)) return undefined;
  const paren = raw.indexOf('(');
  return paren >= 0 ? raw.slice(0, paren) : raw;
}

/**
 * Splits a pnpm-lock.yaml package key into its name and resolved version.
 *
 * `/@scope/name@1.2.3(peer@1)` and `name@1.2.3` both reduce to
 * `{ name: '@scope/name' | 'name', version: '1.2.3' }`.
 */
export function splitPnpmKey(key: string): {
  name: string | undefined;
  version: string | undefined;
} {
  let rest = key.startsWith('/') ? key.slice(1) : key;
  // Drop the peer-dependency suffix pnpm appends in parentheses.
  const paren = rest.indexOf('(');
  if (paren >= 0) rest = rest.slice(0, paren);

  const at = rest.lastIndexOf('@');
  if (at <= 0) return { name: rest || undefined, version: undefined };
  return {
    name: rest.slice(0, at) || undefined,
    version: rest.slice(at + 1) || undefined,
  };
}

function parse(text: string): PnpmLock | undefined {
  try {
    return (parseYaml(text) ?? {}) as PnpmLock;
  } catch {
    return undefined;
  }
}

export const pnpmLockfile: LockfileReader = {
  file: 'pnpm-lock.yaml',

  edges(text) {
    const doc = parse(text);
    if (!doc) return undefined;

    const graph = new Map<string, string[]>();
    for (const section of [doc.packages, doc.snapshots]) {
      for (const [key, entry] of Object.entries(section ?? {})) {
        const { name } = splitPnpmKey(key);
        if (!name) continue;
        if (!graph.has(name)) graph.set(name, []);

        const children = [
          ...Object.keys(entry?.dependencies ?? {}),
          ...Object.keys(entry?.optionalDependencies ?? {}),
        ];
        if (children.length === 0) continue;
        addEdges(graph, name, children);
      }
    }
    return graph.size > 0 ? graph : undefined;
  },

  versions(text) {
    const doc = parse(text);
    if (!doc) return undefined;

    const versions = new Map<string, Set<string>>();
    for (const section of [doc.packages, doc.snapshots]) {
      for (const key of Object.keys(section ?? {})) {
        const { name, version } = splitPnpmKey(key);
        if (name && version) addVersion(versions, name, version);
      }
    }
    return versions.size > 0 ? versions : undefined;
  },

  /**
   * `importers:` is keyed by each member's path — `.` for the root — and lists
   * exactly what that member resolved. Merging every importer into one map
   * let the first member listed decide the version for all of them.
   */
  resolved(text) {
    const doc = parse(text);
    if (!doc) return undefined;

    const all = new Map<string, string[]>();
    const importers = new Map<string, Map<string, string>>();

    for (const [path, importer] of Object.entries(doc.importers ?? {})) {
      const map = new Map<string, string>();
      for (const bucket of [
        importer?.dependencies,
        importer?.devDependencies,
        importer?.optionalDependencies,
      ]) {
        for (const [name, dep] of Object.entries(bucket ?? {})) {
          const version = importerVersion(dep);
          if (version) map.set(name, version);
        }
      }
      importers.set(path, map);
      for (const [name, version] of map) addResolved(all, name, version);
    }

    for (const section of [doc.packages, doc.snapshots]) {
      for (const key of Object.keys(section ?? {})) {
        const { name, version } = splitPnpmKey(key);
        if (name && version) addResolved(all, name, version);
      }
    }

    return {
      all,
      importer: (importer) => importers.get(importer === '' ? '.' : importer),
    };
  },
};
