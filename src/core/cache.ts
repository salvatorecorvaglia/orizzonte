/**
 * A TTL cache, optionally persisted in `ExtensionContext.globalState`.
 *
 * Version lookups are cheap to repeat but rude to repeat often, and persisting
 * across reloads is what lets Orizzonte render instantly on the second open —
 * and render *something* when the machine is offline.
 *
 * Two bounds keep that from turning into a leak. The in-memory mirror is an LRU
 * so a large monorepo cannot grow it without limit, and `prune()` drops lapsed
 * entries out of the Memento on activation — without it, every package ever
 * seen in any workspace accumulates as its own key in a blob VS Code loads
 * synchronously at startup.
 */

export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  /** Present on the real VS Code Memento; used by `prune`. */
  keys?(): readonly string[];
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const STORAGE_PREFIX = 'orizzonte.cache.';

/**
 * How many entries the in-memory mirror holds. Comfortably above a large
 * monorepo's package count, so the LRU only engages on genuinely unbounded use.
 */
const DEFAULT_MAX_ENTRIES = 5000;

/**
 * How many entries `prune` leaves behind in the Memento.
 *
 * The in-memory LRU has never bounded what is *persisted*: `prune` dropped only
 * lapsed entries, so a user who opens many large workspaces accumulates live
 * ones without limit in a blob VS Code loads synchronously at every extension
 * host start. Keeping the newest-expiring ones is the closest stand-in for
 * recency that a stored entry carries.
 */
const MAX_PERSISTED_ENTRIES = 10_000;

/**
 * How long a write waits for company before being flushed.
 *
 * Short enough to be invisible even if the window closes moments later, long
 * enough that the burst of writes one scan produces lands as a single batch.
 */
const FLUSH_DELAY_MS = 50;

export const TTL = {
  /** Latest-version lookups: fresh enough to be useful, cheap enough to redo. */
  version: 60 * 60 * 1000,
  /** Descriptions, sizes — these barely move. */
  metadata: 24 * 60 * 60 * 1000,
  /** Advisories: worth re-checking a few times a day. */
  audit: 6 * 60 * 60 * 1000,
  /** The PyPI name index is enormous; refetch at most daily. */
  nameIndex: 24 * 60 * 60 * 1000,
} as const;

export interface SetOptions {
  /**
   * Whether the entry survives a reload. Defaults to true.
   *
   * Set false for values that are large enough to make `globalState` expensive
   * to load — the PyPI project index is tens of megabytes, and globalState is a
   * JSON blob VS Code reads and rewrites synchronously.
   */
  persist?: boolean;
}

export class TtlCache {
  /**
   * Mirrors persisted state so hot paths never touch the Memento.
   *
   * A `Map` preserves insertion order, which is all an LRU needs: re-inserting
   * on read moves an entry to the end, so the oldest is always first.
   */
  private readonly memory = new Map<string, Entry<unknown>>();

  /** Entries written to memory and awaiting a batched flush to storage. */
  private readonly pending = new Map<string, Entry<unknown>>();
  private flushTimer: NodeJS.Timeout | undefined;
  private inFlightFlush: Promise<void> | undefined;

  constructor(
    private readonly storage: Memento,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.read<T>(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
      // A lapsed entry sitting in the mirror does nobody any good — drop it
      // here rather than waiting on the LRU to eventually push it out by
      // count. That bound does nothing for a single oversized entry (the
      // PyPI name index is the case that motivated this): it is one of up to
      // `maxEntries`, so it would otherwise sit in memory for the life of the
      // window regardless of size. Storage is untouched: `prune()` already
      // owns that, and `getStale()` still needs to find it there.
      this.memory.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Returns a value even if its TTL has lapsed. Used for offline fallback, where
   * stale data beats an error screen — the UI badges it as stale.
   */
  getStale<T>(key: string): T | undefined {
    return this.read<T>(key)?.value;
  }

  async set<T>(
    key: string,
    value: T,
    ttlMs: number,
    options: SetOptions = {},
  ): Promise<void> {
    const entry: Entry<T> = { value, expiresAt: Date.now() + ttlMs };
    // The in-memory mirror is updated synchronously, so a `get` immediately
    // after a `set` sees the value whether or not it has been persisted yet.
    this.remember(key, entry);
    if (options.persist !== false) this.persist(key, entry);
  }

  /**
   * Queues one entry for `globalState`, to be written with whatever else is
   * queued alongside it.
   *
   * Deliberately does not wait for the write. The value is already in the
   * in-memory mirror by the time this is called, so every read is already
   * served; what remains is durability across a reload, which no caller is
   * blocked on. `set` used to await its own round-trip from inside a
   * bounded-concurrency worker, which put the persistence latency of hundreds
   * of packages directly into the scan. Buffering also collapses repeat writes
   * to one key — metadata and versions for a package arrive as separate
   * calls — into a single write.
   *
   * The cost is a window of up to `FLUSH_DELAY_MS` in which a closing window
   * loses the newest entries. `flushNow()` closes it at disposal, and losing a
   * cache entry costs one extra request on the next scan regardless.
   */
  private persist(key: string, entry: Entry<unknown>): void {
    this.pending.set(STORAGE_PREFIX + key, entry);
    this.flushTimer ??= setTimeout(() => {
      void this.flushNow();
    }, FLUSH_DELAY_MS);
  }

  /**
   * Writes everything buffered right now and resolves once it has landed.
   *
   * Called at disposal, and by tests — without it there is no way to observe
   * that the buffer reached storage, which is the one guarantee the old
   * write-through `set` gave for free.
   */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.pending.size === 0) return this.inFlightFlush;

    const batch = [...this.pending];
    this.pending.clear();

    // In parallel rather than in sequence: these are independent keys, and not
    // paying for them one at a time is the point of buffering.
    const flush = Promise.all(
      batch.map(([storageKey, entry]) =>
        // Best-effort, matching `prune`: a failed write costs one cache entry,
        // which is what happens anyway when nothing was persisted at all.
        Promise.resolve(this.storage.update(storageKey, entry)).catch(
          () => undefined,
        ),
      ),
    ).then(() => undefined);

    this.inFlightFlush = flush;
    await flush;
    if (this.inFlightFlush === flush) this.inFlightFlush = undefined;
  }

  /**
   * Drops every lapsed entry from the Memento.
   *
   * Called once on activation rather than on each write: the work is
   * proportional to what has accumulated, not to what is being stored, and
   * doing it on the write path would put a scan behind a full key enumeration.
   *
   * Returns the number of keys removed, which the caller may log.
   */
  async prune(now = Date.now()): Promise<number> {
    // A Memento without `keys()` (the test double, or an older host) simply
    // cannot be enumerated; there is nothing to do and nothing to report.
    const keys = this.storage.keys?.();
    if (!keys) return 0;

    const lapsed: string[] = [];
    const live: Array<{ key: string; expiresAt: number }> = [];
    for (const storageKey of keys) {
      if (!storageKey.startsWith(STORAGE_PREFIX)) continue;
      const entry = this.storage.get<Entry<unknown>>(storageKey);
      // A malformed entry is as useless as an expired one.
      if (isEntry(entry) && entry.expiresAt >= now) {
        live.push({ key: storageKey, expiresAt: entry.expiresAt });
        continue;
      }
      lapsed.push(storageKey);
    }

    /*
     * Unexpired entries are bounded too.
     *
     * Dropping only what has lapsed leaves a Memento that grows with every
     * workspace ever opened, and this one is read synchronously at startup.
     * The soonest-expiring are discarded first: they are the closest thing a
     * stored entry carries to "least recently useful", and they are the ones
     * about to be dropped anyway.
     */
    if (live.length > MAX_PERSISTED_ENTRIES) {
      live.sort((a, b) => a.expiresAt - b.expiresAt);
      for (const entry of live.slice(0, live.length - MAX_PERSISTED_ENTRIES)) {
        lapsed.push(entry.key);
      }
    }

    /*
     * Removed in parallel rather than one awaited write after another. This
     * runs on activation, where the work is proportional to everything that
     * has ever accumulated — a user who has opened many workspaces can have
     * thousands of lapsed keys, and paying a round-trip for each in series put
     * that whole sweep in front of the first scan.
     */
    const results = await Promise.all(
      lapsed.map(async (storageKey) => {
        try {
          await this.storage.update(storageKey, undefined);
        } catch {
          // Best-effort: a write that fails here just leaves one stale entry
          // behind, which is what happens if prune() never runs at all — not
          // worth losing the rest of the sweep, or turning into an unhandled
          // rejection for `void cache.prune()` at the call site.
          return false;
        }
        this.memory.delete(storageKey.slice(STORAGE_PREFIX.length));
        return true;
      }),
    );
    return results.filter(Boolean).length;
  }

  private read<T>(key: string): Entry<T> | undefined {
    const hot = this.memory.get(key) as Entry<T> | undefined;
    if (hot) {
      // Re-insert so this becomes the most recently used.
      this.memory.delete(key);
      this.memory.set(key, hot);
      return hot;
    }
    const cold = this.storage.get<Entry<T>>(STORAGE_PREFIX + key);
    /*
     * Validated on the way in, the way `prune` validates on the way out.
     *
     * `globalState` is a JSON blob that has survived every version of this
     * extension the user has ever run, so a stored entry is not guaranteed to
     * be one we would write today. An `expiresAt` that is not a number makes
     * `expiresAt < Date.now()` false — so a malformed entry never expired and
     * was served as fresh forever.
     */
    if (!isEntry(cold)) return undefined;
    this.remember(key, cold);
    return cold as Entry<T>;
  }

  private remember(key: string, entry: Entry<unknown>): void {
    // Delete first so a re-write moves the key to the end of the order.
    this.memory.delete(key);
    this.memory.set(key, entry);

    while (this.memory.size > this.maxEntries) {
      const oldest = this.memory.keys().next();
      if (oldest.done) break;
      this.memory.delete(oldest.value);
    }
  }
}

/** Whether a value read back from storage is an entry we can still trust. */
function isEntry(value: unknown): value is Entry<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Entry<unknown>).expiresAt === 'number' &&
    Number.isFinite((value as Entry<unknown>).expiresAt)
  );
}

/** Builds a collision-free cache key from its parts. */
export function cacheKey(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}
