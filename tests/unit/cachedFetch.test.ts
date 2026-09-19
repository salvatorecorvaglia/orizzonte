/**
 * The cache-first, stale-on-failure wrapper every provider's lookups run
 * through.
 *
 * It was reached only indirectly, through whichever provider a test happened to
 * exercise — so the behaviour that matters most here, falling back to a stale
 * entry when the registry is unreachable, was asserted for none of them
 * directly. That fallback is what puts data on screen when the network is down.
 */

import { describe, expect, it, vi } from 'vitest';
import { TTL } from '../../src/core/cache.js';
import {
  fetchMetadataWithCache,
  fetchVersionsWithCache,
} from '../../src/providers/shared/cachedFetch.js';
import { makeContext } from './helpers.js';

const info = (latest: string) => ({ versions: [latest], latest });

describe('fetchVersionsWithCache', () => {
  it('serves a cache hit without touching the network', async () => {
    const ctx = makeContext();
    await ctx.cache.set('k:react', info('18.0.0'), TTL.version);
    const fetchOne = vi.fn();

    const result = await fetchVersionsWithCache(
      ['react'],
      ctx,
      4,
      (name) => `k:${name}`,
      fetchOne,
    );

    expect(result.get('react')).toEqual(info('18.0.0'));
    expect(fetchOne).not.toHaveBeenCalled();
  });

  it('fetches and caches a miss', async () => {
    const ctx = makeContext();
    const fetchOne = vi.fn(async () => info('19.0.0'));

    await fetchVersionsWithCache(['react'], ctx, 4, (n) => `k:${n}`, fetchOne);

    expect(fetchOne).toHaveBeenCalledOnce();
    expect(ctx.cache.get('k:react')).toEqual(info('19.0.0'));
  });

  it('falls back to a lapsed entry when the registry fails', async () => {
    // The offline case: a stale version badged as such beats an empty table.
    const ctx = makeContext();
    await ctx.cache.set('k:react', info('18.0.0'), -1);
    // `get` drops a lapsed entry from the in-memory mirror, so the fallback
    // reads it back from storage — which means it has to have landed there.
    // In practice it always has: the entry was written by an earlier scan.
    await ctx.cache.flushNow();

    const result = await fetchVersionsWithCache(
      ['react'],
      ctx,
      4,
      (n) => `k:${n}`,
      async () => {
        throw new Error('ENOTFOUND');
      },
    );

    expect(result.get('react')).toEqual(info('18.0.0'));
  });

  it('omits a package that fails with nothing cached', async () => {
    const ctx = makeContext();

    const result = await fetchVersionsWithCache(
      ['react'],
      ctx,
      4,
      (n) => `k:${n}`,
      async () => {
        throw new Error('ENOTFOUND');
      },
    );

    // Absent, not guessed: the row renders as "lookup failed" rather than
    // claiming a version nobody published.
    expect(result.has('react')).toBe(false);
  });

  it('keeps one package’s failure from sinking the rest of the batch', async () => {
    const ctx = makeContext();

    const result = await fetchVersionsWithCache(
      ['good', 'bad', 'alsogood'],
      ctx,
      4,
      (n) => `k:${n}`,
      async (name) => {
        if (name === 'bad') throw new Error('nope');
        return info('1.0.0');
      },
    );

    expect([...result.keys()].sort()).toEqual(['alsogood', 'good']);
  });

  it('never puts an invalid name on the wire', async () => {
    // Names come from manifests, which are not ours to trust.
    const ctx = makeContext();
    const fetchOne = vi.fn(async () => info('1.0.0'));

    const result = await fetchVersionsWithCache(
      ['ok', '../../etc/passwd'],
      ctx,
      4,
      (n) => `k:${n}`,
      fetchOne,
      (name) => name === 'ok',
    );

    expect(fetchOne).toHaveBeenCalledOnce();
    expect(result.has('../../etc/passwd')).toBe(false);
  });

  it('skips caching a lookup that resolved to nothing', async () => {
    const ctx = makeContext();

    const result = await fetchVersionsWithCache(
      ['gone'],
      ctx,
      4,
      (n) => `k:${n}`,
      async () => undefined,
    );

    expect(result.has('gone')).toBe(false);
    expect(ctx.cache.get('k:gone')).toBeUndefined();
  });
});

describe('fetchMetadataWithCache', () => {
  it('serves a cache hit without fetching', async () => {
    const ctx = makeContext();
    await ctx.cache.set('m:react', { name: 'react' }, TTL.metadata);
    const fetchOne = vi.fn();

    expect(await fetchMetadataWithCache('m:react', ctx, fetchOne)).toEqual({
      name: 'react',
    });
    expect(fetchOne).not.toHaveBeenCalled();
  });

  it('falls back to a lapsed entry when the fetch fails', async () => {
    const ctx = makeContext();
    await ctx.cache.set('m:react', { name: 'react' }, -1);
    await ctx.cache.flushNow();

    const meta = await fetchMetadataWithCache('m:react', ctx, async () => {
      throw new Error('offline');
    });

    expect(meta).toEqual({ name: 'react' });
  });

  it('returns undefined when a failure has nothing to fall back to', async () => {
    const ctx = makeContext();

    expect(
      await fetchMetadataWithCache('m:new', ctx, async () => {
        throw new Error('offline');
      }),
    ).toBeUndefined();
  });
});
