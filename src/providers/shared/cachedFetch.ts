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
import type { PackageMeta } from '../../core/types.js';
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
      await ctx.cache.set(key, info, TTL.version);
    } catch {
      const stale = ctx.cache.getStale<VersionInfo>(key);
      if (stale) result.set(name, stale);
    }
  });

  return result;
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
