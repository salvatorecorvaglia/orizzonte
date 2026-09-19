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
import { addEdges, addVersion, type LockfileReader } from './types.js';

interface PnpmLockEntry {
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

interface PnpmLock {
  packages?: Record<string, PnpmLockEntry>;
  snapshots?: Record<string, PnpmLockEntry>;
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
};
