/**
 * The TTL cache: expiry, offline fallback, and the two bounds that keep it from
 * growing without limit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, type Memento, TTL, TtlCache } from '../../src/core/cache.js';

/** A Memento that can be enumerated, like the real one. */
class MapMemento implements Memento {
  readonly store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    // VS Code deletes the key when the value is undefined.
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

/** A Memento with no `keys()`, as an older host would present. */
class OpaqueMemento implements Memento {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

describe('TtlCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a value within its TTL and nothing after', async () => {
    const cache = new TtlCache(new MapMemento());
    await cache.set('k', 'v', 1000);

    expect(cache.get('k')).toBe('v');
    vi.advanceTimersByTime(1001);
    expect(cache.get('k')).toBeUndefined();
  });

  it('still returns a lapsed value through getStale', async () => {
    // This is what renders a dependency table when the machine is offline.
    const cache = new TtlCache(new MapMemento());
    await cache.set('k', 'v', 1000);

    vi.advanceTimersByTime(5000);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.getStale('k')).toBe('v');
  });

  it('reads through to storage on a cold start', () => {
    const storage = new MapMemento();
    storage.store.set('orizzonte.cache.k', {
      value: 'from disk',
      expiresAt: Date.now() + 10_000,
    });

    // A fresh instance has an empty memory mirror, as after a reload.
    expect(new TtlCache(storage).get('k')).toBe('from disk');
  });

  it('persists by default and skips storage when asked not to', async () => {
    const storage = new MapMemento();
    const cache = new TtlCache(storage);

    await cache.set('persisted', 1, TTL.version);
    await cache.set('ephemeral', 2, TTL.nameIndex, { persist: false });
    // Persistence is buffered so it stays off the scan's hot path; asserting
    // on storage means asking for the buffer to land first.
    await cache.flushNow();

    expect(storage.store.has('orizzonte.cache.persisted')).toBe(true);
    expect(storage.store.has('orizzonte.cache.ephemeral')).toBe(false);
    // Still readable in this session — it just does not survive a reload.
    expect(cache.get('ephemeral')).toBe(2);
  });

  /*
   * The LRU bounds *memory*, not storage: a persisted entry evicted from the
   * mirror is still read back through the Memento, which is the whole point of
   * having a cold layer. So eviction is observed on non-persisted entries,
   * where the mirror is the only copy.
   */
  it('evicts the least recently used entry from memory once full', async () => {
    const cache = new TtlCache(new MapMemento(), 3);
    const ephemeral = { persist: false } as const;

    await cache.set('a', 1, 10_000, ephemeral);
    await cache.set('b', 2, 10_000, ephemeral);
    await cache.set('c', 3, 10_000, ephemeral);

    // Reading 'a' makes 'b' the least recently used.
    expect(cache.get('a')).toBe(1);
    await cache.set('d', 4, 10_000, ephemeral);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('drops a lapsed entry from the memory mirror on access, not just by LRU count', async () => {
    // The LRU bound is by entry count, which does nothing for one oversized
    // entry (e.g. the PyPI name index) sitting among a handful of others —
    // it would otherwise never be pushed out. A lapsed, non-persisted entry
    // must actually leave the mirror once `get()` notices it has expired,
    // not just become logically unreachable through `get()` while still
    // sitting there. `getStale()` — which deliberately ignores expiry — is
    // the only way to observe whether it is still in memory, since a
    // non-persisted entry has nowhere else to be found.
    const cache = new TtlCache(new MapMemento());
    await cache.set('huge', 'x'.repeat(1000), 1000, { persist: false });

    vi.advanceTimersByTime(1001);
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.getStale('huge')).toBeUndefined();
  });

  it('keeps a persisted entry readable after it leaves the memory mirror', async () => {
    const cache = new TtlCache(new MapMemento(), 1);

    await cache.set('a', 'kept', 10_000);
    await cache.set('b', 'newer', 10_000);
    await cache.flushNow();

    // 'a' is out of the mirror but still on disk, so it reads through.
    expect(cache.get('a')).toBe('kept');
  });

  describe('prune', () => {
    it('drops lapsed entries out of storage and keeps live ones', async () => {
      const storage = new MapMemento();
      const cache = new TtlCache(storage);

      await cache.set('fresh', 1, 60_000);
      await cache.set('stale', 2, 1000);
      vi.advanceTimersByTime(30_000);

      expect(await cache.prune()).toBe(1);
      expect(storage.store.has('orizzonte.cache.fresh')).toBe(true);
      expect(storage.store.has('orizzonte.cache.stale')).toBe(false);
    });

    it('leaves keys belonging to other extensions alone', async () => {
      const storage = new MapMemento();
      storage.store.set('someone.else', 'not ours');
      const cache = new TtlCache(storage);
      await cache.set('stale', 1, 1);
      vi.advanceTimersByTime(1000);

      await cache.prune();
      expect(storage.store.get('someone.else')).toBe('not ours');
    });

    it('drops malformed entries, which are as useless as expired ones', async () => {
      const storage = new MapMemento();
      storage.store.set('orizzonte.cache.broken', { value: 1 }); // no expiresAt
      storage.store.set('orizzonte.cache.alsoBroken', null);

      expect(await new TtlCache(storage).prune()).toBe(2);
      expect(storage.store.size).toBe(0);
    });

    it('does nothing when the Memento cannot be enumerated', async () => {
      // No `keys()` means no way to find what to prune; it must not throw.
      expect(await new TtlCache(new OpaqueMemento()).prune()).toBe(0);
    });

    it('keeps pruning the rest when one deletion rejects', async () => {
      // A Memento write can fail (extension host under memory pressure, a
      // storage backend hiccup); one bad key must not reject the whole
      // prune() and turn `void cache.prune()` at the call site into an
      // unhandled rejection.
      const storage = new MapMemento();
      const cache = new TtlCache(storage);
      await cache.set('stale-a', 1, 1);
      await cache.set('stale-b', 2, 1);
      vi.advanceTimersByTime(1000);

      const originalUpdate = storage.update.bind(storage);
      storage.update = (key: string, value: unknown) => {
        if (key === 'orizzonte.cache.stale-a') {
          return Promise.reject(new Error('storage unavailable'));
        }
        return originalUpdate(key, value);
      };

      await expect(cache.prune()).resolves.toBe(1);
      expect(storage.store.has('orizzonte.cache.stale-a')).toBe(true);
      expect(storage.store.has('orizzonte.cache.stale-b')).toBe(false);
    });
  });
});

describe('cacheKey', () => {
  it('encodes parts so they cannot collide across the separator', () => {
    // Without encoding, ('a:b', 'c') and ('a', 'b:c') would be one key.
    expect(cacheKey('a:b', 'c')).not.toBe(cacheKey('a', 'b:c'));
  });

  it('keeps distinct registries distinct', () => {
    expect(cacheKey('npm', 'versions', 'https://a', 'react')).not.toBe(
      cacheKey('npm', 'versions', 'https://b', 'react'),
    );
  });
});

describe('write batching', () => {
  /** A Memento that records every write it is asked to perform. */
  function countingMemento() {
    const store = new Map<string, unknown>();
    const writes: string[] = [];
    return {
      writes,
      memento: {
        get: <T>(key: string) => store.get(key) as T | undefined,
        update: (key: string, value: unknown) => {
          writes.push(key);
          if (value === undefined) store.delete(key);
          else store.set(key, value);
          return Promise.resolve();
        },
        keys: () => [...store.keys()],
      },
    };
  }

  it('collapses repeat writes to one key into a single storage write', async () => {
    /*
     * Metadata and versions for the same package land as separate `set` calls.
     * Each used to be its own awaited round-trip from inside a
     * bounded-concurrency worker, so the persistence cost was serialised into
     * the scan.
     */
    const { memento, writes } = countingMemento();
    const cache = new TtlCache(memento);

    await Promise.all([
      cache.set('pkg', { v: 1 }, 60_000),
      cache.set('pkg', { v: 2 }, 60_000),
      cache.set('pkg', { v: 3 }, 60_000),
    ]);
    await cache.flushNow();

    expect(writes).toEqual(['orizzonte.cache.pkg']);
    // The last write wins, and the in-memory mirror agrees with storage.
    expect(cache.get('pkg')).toEqual({ v: 3 });
  });

  it('makes a value readable immediately, before it reaches storage', async () => {
    // Buffering must not open a window where a just-written value reads as
    // missing — a scan reads back what it just cached.
    const { memento } = countingMemento();
    const cache = new TtlCache(memento);

    const pending = cache.set('pkg', 'value', 60_000);
    expect(cache.get('pkg')).toBe('value');
    await pending;
    await cache.flushNow();
  });

  it('persists the entry once the buffer is flushed', async () => {
    const { memento, writes } = countingMemento();
    const cache = new TtlCache(memento);

    await cache.set('pkg', 'value', 60_000);
    await cache.flushNow();

    expect(writes).toContain('orizzonte.cache.pkg');
    expect(memento.get('orizzonte.cache.pkg')).toBeDefined();
  });

  it('flushes on its own timer without anyone asking', async () => {
    // Disposal calls `flushNow`, but an extension that simply keeps running
    // must still reach storage.
    const { memento, writes } = countingMemento();
    const cache = new TtlCache(memento);

    vi.useFakeTimers();
    try {
      await cache.set('pkg', 'value', 60_000);
      await vi.advanceTimersByTimeAsync(120);
    } finally {
      vi.useRealTimers();
    }

    expect(writes).toContain('orizzonte.cache.pkg');
    void memento;
  });

  it('keeps pruning after a storage write fails', async () => {
    // One failed removal must not abandon the rest of the sweep.
    const store = new Map<string, unknown>();
    const lapsed = { value: 'x', expiresAt: Date.now() - 1000 };
    store.set('orizzonte.cache.a', lapsed);
    store.set('orizzonte.cache.b', lapsed);
    store.set('orizzonte.cache.c', lapsed);

    const cache = new TtlCache({
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => {
        if (key === 'orizzonte.cache.b')
          return Promise.reject(new Error('nope'));
        store.delete(key);
        void value;
        return Promise.resolve();
      },
      keys: () => [...store.keys()],
    });

    expect(await cache.prune()).toBe(2);
    expect(store.has('orizzonte.cache.a')).toBe(false);
    expect(store.has('orizzonte.cache.c')).toBe(false);
  });
});

describe('entries written by an older version', () => {
  it('ignores a stored entry whose expiry is not a number', () => {
    // `globalState` outlives every version of the extension the user has run,
    // so what comes back is not guaranteed to be what we would write today. A
    // non-numeric `expiresAt` makes `expiresAt < Date.now()` false, so the
    // entry never expired and was served as fresh forever.
    const storage = new MapMemento();
    storage.store.set('orizzonte.cache.k', {
      value: 'stale forever',
      expiresAt: 'not a number',
    });

    expect(new TtlCache(storage).get('k')).toBeUndefined();
  });

  it('ignores a stored entry that is not an object at all', () => {
    const storage = new MapMemento();
    storage.store.set('orizzonte.cache.k', 'just a string');

    expect(new TtlCache(storage).get('k')).toBeUndefined();
  });

  it('prunes a malformed entry rather than leaving it in place', async () => {
    const storage = new MapMemento();
    storage.store.set('orizzonte.cache.bad', { value: 1, expiresAt: null });

    expect(await new TtlCache(storage).prune()).toBe(1);
    expect(storage.store.has('orizzonte.cache.bad')).toBe(false);
  });
});

describe('the persisted entry cap', () => {
  it('drops the soonest-expiring entries once storage is over the limit', async () => {
    /*
     * `prune` dropped only *lapsed* entries, so a user who opens many large
     * workspaces accumulated live ones without limit — in a blob VS Code reads
     * synchronously at every extension host start.
     */
    const storage = new MapMemento();
    const now = Date.now();
    const total = 10_050;
    for (let index = 0; index < total; index++) {
      storage.store.set(`orizzonte.cache.k${index}`, {
        value: index,
        // Ascending, so the lowest indices are the soonest to expire.
        expiresAt: now + 60_000 + index,
      });
    }

    const removed = await new TtlCache(storage).prune(now);

    expect(removed).toBe(total - 10_000);
    expect(storage.store.size).toBe(10_000);
    // The soonest-expiring went first; the longest-lived survived.
    expect(storage.store.has('orizzonte.cache.k0')).toBe(false);
    expect(storage.store.has(`orizzonte.cache.k${total - 1}`)).toBe(true);
  });

  it('leaves a storage under the limit untouched', async () => {
    const storage = new MapMemento();
    const now = Date.now();
    storage.store.set('orizzonte.cache.k', { value: 1, expiresAt: now + 1000 });

    expect(await new TtlCache(storage).prune(now)).toBe(0);
    expect(storage.store.size).toBe(1);
  });
});
