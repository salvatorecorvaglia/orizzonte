/**
 * The version a manifest's dependencies actually resolved to, read from the
 * lockfile that governs it.
 *
 * Every provider used to carry its own parser for this, beside the readers in
 * this folder that already parsed the same files for the dependency graph and
 * the duplicate-version check — two parsers per format that disagreed. The npm,
 * pnpm and yarn ones in the Node provider also collapsed a monorepo's members
 * into one map, so every member was told the version its first-listed sibling
 * resolved. This is the one path now, and it asks per member.
 */

import * as path from 'node:path';
import type { ProviderContext } from '../../providers/provider.js';
import type { Ecosystem } from '../types.js';
import { maxSatisfying, registryConstraint } from '../versions/index.js';
import { lockfilesFor } from './index.js';
import { selectLockfile } from './resolve.js';
import type { ResolvedIndex } from './types.js';

/** One dependency as the lockfile knows it. */
export interface LockfileWant {
  /** The name as the lockfile spells it (after any provider normalisation). */
  name: string;
  /** The constraint the manifest declares, for picking among several copies. */
  declared: string;
}

/**
 * Resolved versions for the manifest in `manifestDir`, keyed by the names the
 * lockfile uses.
 *
 * Every package the lockfile mentions gets an answer, in this order of
 * certainty: the member's own entry where the format records one, the
 * `name@range` descriptor matching what the manifest declares, the single
 * version resolved, and finally — when several copies are installed — the
 * highest one the declared range admits.
 *
 * The parsed lockfile is memoised per scan through `ctx.lockfileMemo`, so a
 * workspace of fifty members parses its one root lockfile once.
 */
export async function readInstalledVersions(
  ecosystem: Ecosystem,
  manifestDir: string,
  ctx: Pick<ProviderContext, 'readFile' | 'workspaceRootFor' | 'lockfileMemo'>,
  wants: LockfileWant[] = [],
): Promise<Map<string, string>> {
  const found = await selectLockfile(
    manifestDir,
    lockfilesFor(ecosystem),
    (absolutePath) => ctx.readFile(absolutePath),
    ctx.workspaceRootFor(manifestDir),
    // Undefined keeps the walk going, so a lockfile that parsed to nothing
    // does not mask a usable one beside it or above it.
    (reader, text, absolutePath) => {
      const index = reader.resolved(text);
      return index && index.all.size > 0
        ? { index, lockDir: path.dirname(absolutePath) }
        : undefined;
    },
    ctx.lockfileMemo && { store: ctx.lockfileMemo, namespace: 'installed' },
  );
  if (!found) return new Map();

  const importer = path
    .relative(found.lockDir, manifestDir)
    .split(path.sep)
    .join('/');
  return chooseVersions(found.index, importer, wants, ecosystem);
}

/** The pure half of `readInstalledVersions`, for the tests. */
export function chooseVersions(
  index: ResolvedIndex,
  importer: string,
  wants: LockfileWant[],
  ecosystem: Ecosystem,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [name, versions] of index.all) result.set(name, versions[0]);

  for (const want of wants) {
    const exact = index.descriptors?.get(`${want.name}@${want.declared}`);
    if (exact) {
      result.set(want.name, exact);
      continue;
    }
    const versions = index.all.get(want.name);
    if (!versions || versions.length < 2) continue;
    const best = maxSatisfying(
      ecosystem,
      versions,
      registryConstraint(want.declared),
    );
    if (best) result.set(want.name, best);
  }

  // Last, so it wins: the member's own record is not a guess.
  for (const [name, version] of index.importer?.(importer) ?? []) {
    result.set(name, version);
  }
  return result;
}
