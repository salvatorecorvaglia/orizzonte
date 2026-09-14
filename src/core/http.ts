/**
 * The one place Orizzonte talks to the network.
 *
 * Every registry has its own etiquette and we honour all of it here rather than
 * scattering headers and sleeps across seven providers:
 *   - crates.io requires a descriptive User-Agent and caps clients at 1 req/sec.
 *   - Packagist asks that the User-Agent carry a contact address.
 *   - Everyone benefits from ETag revalidation and backoff on 429/5xx.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Ceiling on how long a `Retry-After` may put a request to sleep.
 *
 * Registries under load reply with values in the hundreds or thousands of
 * seconds. Honouring those literally means a scan that appears to hang with no
 * way to tell it apart from a bug, so past this point we give up and let the
 * caller fall back to cached data — which is the same outcome, arrived at
 * immediately and visibly.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/** The first try plus its retries. Also scales the whole-request deadline. */
const MAX_ATTEMPTS = 4;

/**
 * How many responses the ETag cache retains.
 *
 * Entries hold full response bodies, so this is the difference between a
 * revalidation cache and a memory leak: one scan of a large monorepo would
 * otherwise pin every packument it fetched for the life of the window.
 */
const MAX_CACHED_RESPONSES = 500;

/** Requests per second, per host. Absent means "no explicit limit". */
const RATE_LIMITS: Record<string, number> = {
  'crates.io': 1,
  'api.osv.dev': 10,
  'api.deps.dev': 10,
  'search.maven.org': 5,
  'packagist.org': 5,
  'repo.packagist.org': 5,
  // Neither publishes a documented cap, but both are hit hard by a large
  // Python or Go monorepo's scan — the same self-imposed politeness limit
  // already applied to osv.dev and deps.dev, so one busy scan cannot burst
  // past what's reasonable for either registry to field unprompted.
  'pypi.org': 10,
  'proxy.golang.org': 10,
};

export interface HttpOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Skip the ETag cache for this request. */
  noCache?: boolean;
  timeoutMs?: number;
}

interface CachedEntry {
  etag?: string;
  lastModified?: string;
  body: string;
}

/**
 * A token bucket that releases one slot per interval. Requests queue rather
 * than fail, so a 200-crate project degrades to "slow" instead of "rate limited".
 */
class HostLimiter {
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;

  constructor(requestsPerSecond: number) {
    this.intervalMs = Math.ceil(1000 / requestsPerSecond);
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer !== undefined) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    next();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, this.intervalMs);
  }
}

export class HttpClient {
  private readonly limiters = new Map<string, HostLimiter>();
  private readonly etagCache = new Map<string, CachedEntry>();
  private userAgent: string;

  /**
   * How many requests this client has issued.
   *
   * Exposed so the integration suite can assert its offline guarantee against
   * something real. It used to time a refresh and infer from the duration that
   * no registry was contacted, which is both flaky on a loaded CI runner and
   * not actually evidence of anything.
   */
  private requests = 0;

  get requestCount(): number {
    return this.requests;
  }

  constructor(extensionVersion: string, contactEmail?: string) {
    this.userAgent = buildUserAgent(extensionVersion, contactEmail);
  }

  /** Rebuilds the User-Agent after the user edits `orizzonte.contactEmail`. */
  setContactEmail(extensionVersion: string, contactEmail?: string): void {
    this.userAgent = buildUserAgent(extensionVersion, contactEmail);
  }

  async getJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
    const text = await this.request(url, options);
    return JSON.parse(text) as T;
  }

  async postJson<T>(
    url: string,
    body: unknown,
    options: HttpOptions = {},
  ): Promise<T> {
    const text = await this.request(url, {
      ...options,
      method: 'POST',
      body,
      noCache: true,
    });
    return JSON.parse(text) as T;
  }

  async getText(url: string, options: HttpOptions = {}): Promise<string> {
    return this.request(url, options);
  }

  private async request(url: string, options: HttpOptions): Promise<string> {
    await this.waitForSlot(url);
    /*
     * The deadline covers the whole retry chain, not each attempt.
     *
     * Each attempt already gets its own timeout, but three retries with a
     * `Retry-After` of up to a minute between them could keep one request
     * alive for several minutes — with the scan it belongs to still showing a
     * spinner. Past this point cached data, badged as stale, is a better
     * answer than a request nobody is still waiting for.
     */
    const deadline =
      Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) * MAX_ATTEMPTS;
    return this.attempt(url, options, 0, deadline);
  }

  /**
   * Takes a slot from the host's rate limiter, if it has one.
   *
   * Called before every attempt including retries: a 429 is the server asking
   * for *less* traffic, so replaying the request outside the limiter would be
   * precisely backwards.
   */
  private async waitForSlot(url: string): Promise<void> {
    const host = new URL(url).host;
    const limit = RATE_LIMITS[host];
    if (limit === undefined) return;

    let limiter = this.limiters.get(host);
    if (!limiter) {
      limiter = new HostLimiter(limit);
      this.limiters.set(host, limiter);
    }
    await limiter.acquire();
  }

  private async attempt(
    url: string,
    options: HttpOptions,
    retryCount: number,
    deadline: number,
  ): Promise<string> {
    const cached = options.noCache ? undefined : this.etagCache.get(url);

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
      ...options.headers,
    };
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }
    if (cached?.lastModified) {
      headers['If-Modified-Since'] = cached.lastModified;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    // Combine the caller's cancellation with our own timeout so a hung registry
    // can never wedge a scan.
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = options.signal
      ? anySignal([options.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      this.requests++;
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal,
      });

      // 304 means our cached copy is still good.
      if (response.status === 304 && cached) {
        return cached.body;
      }

      if (response.status === 429 || response.status >= 500) {
        if (retryCount < MAX_ATTEMPTS - 1) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const requested =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 2 ** retryCount * 500;
          // A registry asking us to wait an hour gets a 404-shaped answer
          // instead; the caller falls back to cache rather than appearing hung.
          if (requested > MAX_RETRY_AFTER_MS) {
            throw new HttpError(
              `${response.status} ${response.statusText} (retry-after ${Math.round(requested / 1000)}s exceeds the cap)`,
              response.status,
              url,
            );
          }
          // Sleeping past the deadline and then retrying spends the wait to
          // learn nothing, so stop here and let the caller fall back.
          if (Date.now() + requested >= deadline) {
            throw new HttpError(
              `${response.status} ${response.statusText} (gave up after ${retryCount + 1} attempts)`,
              response.status,
              url,
            );
          }
          await sleep(requested, options.signal);
          await this.waitForSlot(url);
          return this.attempt(url, options, retryCount + 1, deadline);
        }
      }

      if (!response.ok) {
        throw new HttpError(
          `${response.status} ${response.statusText}`,
          response.status,
          url,
        );
      }

      const body = await response.text();

      if (!options.noCache) {
        const etag = response.headers.get('etag') ?? undefined;
        const lastModified = response.headers.get('last-modified') ?? undefined;
        if (etag || lastModified) {
          this.rememberResponse(url, { etag, lastModified, body });
        }
      }

      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stores a revalidatable response, evicting the least recently stored once the
   * cache is full. Insertion order is the eviction order: `Map` preserves it,
   * and a re-store deletes first so the entry moves to the end.
   */
  private rememberResponse(url: string, entry: CachedEntry): void {
    this.etagCache.delete(url);
    this.etagCache.set(url, entry);

    while (this.etagCache.size > MAX_CACHED_RESPONSES) {
      const oldest = this.etagCache.keys().next();
      if (oldest.done) break;
      this.etagCache.delete(oldest.value);
    }
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** A missing package is an expected outcome, not a failure worth surfacing. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

function buildUserAgent(version: string, contactEmail?: string): string {
  const contact = contactEmail?.trim() ? `; mailto=${contactEmail.trim()}` : '';
  return `Orizzonte-VSCode/${version} (+https://github.com/salvatorecorvaglia/orizzonte${contact})`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Combines the caller's cancellation with this request's own timeout.
 *
 * This used to carry a hand-rolled fallback for hosts without
 * `AbortSignal.any`. It was unreachable — `engines.node` requires 22.13, and
 * the API has existed since Node 20 — and it leaked: it detached its listeners
 * only when something aborted, so a request that simply *succeeded* left one
 * listener behind on the caller's signal. That signal covers a whole scan, so
 * the listeners accumulated one per package, which is precisely the leak the
 * fallback's own comment claimed to prevent. Deleting it is the fix.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}
