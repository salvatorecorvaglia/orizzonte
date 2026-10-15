/**
 * The cache-first, stale-on-failure fetch pattern every provider's
 * `fetchVersions` shares: a cache hit skips the network; a miss fetches and
 * caches; a failure (of any kind — a 404, a malformed response, a DNS error)
 * falls back to whatever the cache still remembers for that one package
 * rather than rejecting the whole batch or leaving it with no data at all.
 *
 * Maven and Gradle already share their own version of this via
 * `shared/mavenCentral.ts`; this is the same shape for the five providers
 * that talk to a different registry each.
 */

import { TTL } from '../../core/cache.js';
import type { Ecosystem, PackageMeta } from '../../core/types.js';
import {
  compareVersions,
  isPrerelease,
  maxVersion,
} from '../../core/versions/index.js';
import type { ProviderContext, VersionInfo } from '../provider.js';
import { mapWithConcurrency } from './concurrency.js';

export async function fetchVersionsWithCache(
  names: string[],
  ctx: ProviderContext,
  concurrency: number,
  cacheKeyFor: (name: string) => string,
  fetchOne: (name: string) => Promise<VersionInfo | undefined>,
  /** Names are manifest-sourced and not ours to trust; skipped silently. */
  isValidName?: (name: string) => boolean,
  /** When given, the cached copy is compacted — see `compactVersionInfo`. */
  ecosystem?: Ecosystem,
): Promise<Map<string, VersionInfo>> {
  const result = new Map<string, VersionInfo>();

  await mapWithConcurrency(names, concurrency, async (name) => {
    if (isValidName && !isValidName(name)) return;

    const key = cacheKeyFor(name);
    const cached = ctx.cache.get<VersionInfo>(key);
    if (cached) {
      result.set(name, cached);
      return;
    }

    try {
      const info = await fetchOne(name);
      if (info === undefined) return;
      result.set(name, info);
      await ctx.cache.set(
        key,
        ecosystem ? compactVersionInfo(ecosystem, info) : info,
        TTL.version,
      );
    } catch {
      const stale = ctx.cache.getStale<VersionInfo>(key);
      if (stale) result.set(name, stale);
    }
  });

  return result;
}

/**
 * A version list trimmed for storage: every stable release, plus only the
 * prereleases newer than the latest stable one.
 *
 * The cache persists to `globalState`, which VS Code loads synchronously at
 * every extension-host start, and a few packages dominate it: `next` and
 * `typescript` publish a canary or a nightly almost daily, so their lists run
 * to thousands of entries — nearly all of them prereleases of versions that
 * have long since shipped. Nothing here reads those: `latest` and the update
 * badge are stable releases, and a range matches a prerelease only of the
 * version it names. The scan that fetched the list still sees all of it; only
 * the copy kept for later is trimmed.
 */
export function compactVersionInfo(
  ecosystem: Ecosystem,
  info: VersionInfo,
): VersionInfo {
  const stable = info.versions.filter(
    (version) => !isPrerelease(ecosystem, version),
  );
  if (stable.length === 0 || stable.length === info.versions.length) {
    return info;
  }
  const newestStable = maxVersion(ecosystem, stable);
  if (newestStable === undefined) return info;
  return {
    ...info,
    versions: info.versions.filter(
      (version) =>
        !isPrerelease(ecosystem, version) ||
        compareVersions(ecosystem, version, newestStable) > 0,
    ),
  };
}

/**
 * The same cache-first, stale-on-failure shape as `fetchVersionsWithCache`,
 * for the single-package `fetchMetadata` every provider implements the same
 * way: a cache hit skips the network, a miss fetches and caches, and a
 * failure falls back to whatever the cache still remembers rather than
 * surfacing an error for what is, from the user's perspective, just a
 * missing description.
 */
export async function fetchMetadataWithCache(
  key: string,
  ctx: ProviderContext,
  fetchOne: () => Promise<PackageMeta | undefined>,
): Promise<PackageMeta | undefined> {
  const cached = ctx.cache.get<PackageMeta>(key);
  if (cached) return cached;

  try {
    const meta = await fetchOne();
    if (meta === undefined) return undefined;
    await ctx.cache.set(key, meta, TTL.metadata);
    return meta;
  } catch {
    return ctx.cache.getStale<PackageMeta>(key);
  }
}
