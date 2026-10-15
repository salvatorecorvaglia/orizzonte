/**
 * yarn.lock, in both of the formats that filename covers.
 *
 * Yarn 1 and Yarn 2+ ("Berry") are different file formats sharing one name:
 * v1 writes `version "4.3.0"`, Berry writes `version: 4.3.0`, and Berry
 * prefixes every block with a `__metadata:` header that is not a package.
 *
 * Both readers below are driven by one block walk for exactly that reason.
 * They used to be separate functions in a much longer file, and had drifted:
 * the edge reader understood Berry and the version reader did not, so every
 * Berry project reported no duplicate versions and an empty dependency diff —
 * a silently empty answer that reads identically to a clean one.
 */

import {
  addEdges,
  addResolved,
  addVersion,
  type LockfileReader,
} from './types.js';

/** Berry's schema-version header, which parses as a block but is not one. */
const METADATA_BLOCK = '__metadata';

/** The resolved version line, in either format. */
const VERSION_LINE = /^\s*version:?\s+"?([^"\s]+)"?\s*$/m;

/** `lodash@^4.17.0` and `@scope/pkg@npm:^1.0.0` both reduce to the bare name. */
export function yarnNameFromSpec(spec: string): string | undefined {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return spec || undefined;
  return spec.slice(0, at) || undefined;
}

interface YarnBlock {
  name: string;
  /** Every `name@range` the header lists; they all resolved to this block. */
  specs: string[];
  /** The block's lines with the header removed, still indented. */
  body: string[];
  /** The block verbatim, for line-oriented matches like the version. */
  text: string;
}

/**
 * Splits a yarn.lock into its package blocks.
 *
 * Blocks are separated by a blank line: a header naming one or more specs,
 * then an indented body that may contain a `dependencies:` map.
 */
function* blocks(text: string): Generator<YarnBlock> {
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    const header = lines[0].trim();
    if (header.startsWith('#') || !header.endsWith(':')) continue;

    // The header can list several specs; they all resolve to the same package.
    const specs = header
      .slice(0, -1)
      .split(',')
      .map((spec) => spec.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const name = specs[0] && yarnNameFromSpec(specs[0]);
    if (!name || name === METADATA_BLOCK) continue;

    yield { name, specs, body: lines.slice(1), text: block };
  }
}

export const yarnLockfile: LockfileReader = {
  file: 'yarn.lock',

  edges(text) {
    const graph = new Map<string, string[]>();

    for (const block of blocks(text)) {
      const children: string[] = [];
      let inDependencies = false;

      for (const line of block.body) {
        const trimmed = line.trim().replace(/^['"]|['"]$/g, '');
        if (/^(dependencies|optionalDependencies):$/.test(trimmed)) {
          inDependencies = true;
          continue;
        }
        // A non-indented-enough key ends the block.
        if (inDependencies && line.search(/\S/) <= 2) {
          inDependencies = false;
        }
        if (inDependencies) {
          const child = trimmed.split(/[:\s]/)[0].replace(/^['"]|['"]$/g, '');
          if (child) children.push(child);
        }
      }

      addEdges(graph, block.name, children);
    }

    return graph.size > 0 ? graph : undefined;
  },

  versions(text) {
    const versions = new Map<string, Set<string>>();
    for (const block of blocks(text)) {
      const match = VERSION_LINE.exec(block.text);
      if (match) addVersion(versions, block.name, match[1]);
    }
    return versions.size > 0 ? versions : undefined;
  },

  /**
   * A project using two majors of one package has two blocks for it, and the
   * first one is not necessarily the one the manifest asked for. The header
   * says which range each block answers, so the range the manifest declares
   * finds its own block.
   */
  resolved(text) {
    const all = new Map<string, string[]>();
    const descriptors = new Map<string, string>();

    for (const block of blocks(text)) {
      const version = VERSION_LINE.exec(block.text)?.[1];
      if (!version) continue;
      addResolved(all, block.name, version);
      for (const spec of block.specs) {
        descriptors.set(spec, version);
        // Berry spells a registry range `lodash@npm:^4.17.0`; the manifest
        // spells it `^4.17.0`.
        const at = spec.lastIndexOf('@');
        if (spec.slice(at + 1).startsWith('npm:')) {
          descriptors.set(
            `${spec.slice(0, at)}@${spec.slice(at + 1 + 'npm:'.length)}`,
            version,
          );
        }
      }
    }

    return all.size > 0 ? { all, descriptors } : undefined;
  },
};
