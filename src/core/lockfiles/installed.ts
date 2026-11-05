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
import type { Dependency, Ecosystem, VersionResolution } from '../types.js';
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
  /** Optional owner: scanner-facing calls retain per-declaration evidence. */
  dependency?: Dependency;
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
  if (!found) {
    for (const want of wants) {
      if (!want.dependency) continue;
      want.dependency.versionResolution = {
        source: 'unresolved',
        confidence: 'unknown',
      };
      want.dependency.installed = undefined;
      want.dependency.installedIsApproximate = true;
    }
    return new Map();
  }

  const importer = path
    .relative(found.lockDir, manifestDir)
    .split(path.sep)
    .join('/');
  // npm builds a merged importer map; compute it once for the whole manifest.
  const entries = found.index.importer?.(importer);
  const index = found.index.importer
    ? { ...found.index, importer: () => entries }
    : found.index;
  for (const want of wants) {
    if (!want.dependency) continue;
    const resolution = resolveVersion(index, importer, want, ecosystem);
    want.dependency.versionResolution = resolution;
    want.dependency.installed = resolution.version;
    want.dependency.installedIsApproximate = resolution.confidence !== 'exact';
  }
  return chooseVersions(index, importer, wants, ecosystem);
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
    const resolution = resolveVersion(index, importer, want, ecosystem);
    if (resolution.version) result.set(want.name, resolution.version);
    else result.delete(want.name);
  }
  // Preserve the legacy map's importer entries for callers without declarations.
  if (wants.length === 0) {
    for (const [name, version] of index.importer?.(importer) ?? [])
      result.set(name, version);
  }
  return result;
}

/** Resolve one declaration without collapsing another declaration of the same name. */
export function resolveVersion(
  index: ResolvedIndex,
  importer: string,
  want: LockfileWant,
  ecosystem: Ecosystem,
): VersionResolution {
  const constraint = registryConstraint(want.declared);
  const compatible = (version: string) =>
    maxSatisfying(ecosystem, [version], constraint) === version;
  const importerEntries = index.importer?.(importer);
  const imported = importerEntries?.get(want.name);
  if (imported !== undefined) {
    return compatible(imported)
      ? { version: imported, source: 'lockfile-importer', confidence: 'exact' }
      : { source: 'unresolved', confidence: 'unknown' };
  }
  const descriptor = index.descriptors?.get(`${want.name}@${want.declared}`);
  if (descriptor !== undefined)
    return {
      version: descriptor,
      source: 'lockfile-descriptor',
      confidence: 'exact',
    };
  const versions = [...new Set(index.all.get(want.name) ?? [])];
  const best = maxSatisfying(ecosystem, versions, constraint);
  if (!best) return { source: 'unresolved', confidence: 'unknown' };
  return {
    version: best,
    source: versions.length === 1 ? 'lockfile-single' : 'lockfile-range',
    confidence: versions.length === 1 && !index.importer ? 'exact' : 'inferred',
  };
}
