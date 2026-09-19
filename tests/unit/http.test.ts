/**
 * The HTTP client: registry etiquette, retry behaviour, and the bounds added
 * to keep a scan from hanging or leaking.
 *
 * `fetch` is stubbed rather than reached, so these run offline and
 * deterministically. Timers are faked, which means the rate limiter and the
 * backoff can be asserted on directly rather than by waiting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError } from '../../src/core/http.js';

interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

function respond({
  status = 200,
  body = '{}',
  headers = {},
}: StubResponse = {}): Response {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Queues responses, returning each in turn and repeating the last.
 *
 * Honours `init.signal` the way the real `fetch` does, so cancellation is
 * exercised rather than assumed.
 */
function stubFetch(...responses: StubResponse[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (init.signal?.aborted) {
      return Promise.reject(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
        }),
      );
    }
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return Promise.resolve(respond(next));
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('HttpClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('identification', () => {
    it('sends a descriptive User-Agent, as crates.io requires', async () => {
      const calls = stubFetch({ body: '{"ok":true}' });
      await new HttpClient('1.2.3').getJson('https://example.com/a');

      const agent = (calls[0].init.headers as Record<string, string>)[
        'User-Agent'
      ];
      expect(agent).toContain('Orizzonte-VSCode/1.2.3');
      expect(agent).toContain('github.com/salvatorecorvaglia/orizzonte');
    });

    it('carries a contact address when one is configured, as Packagist asks', async () => {
      const calls = stubFetch();
      const client = new HttpClient('1.0.0', 'dev@example.com');
      await client.getJson('https://example.com/a');

      expect(
        (calls[0].init.headers as Record<string, string>)['User-Agent'],
      ).toContain('mailto=dev@example.com');
    });

    it('picks up a contact address added after construction', async () => {
      const calls = stubFetch();
      const client = new HttpClient('1.0.0');
      client.setContactEmail('1.0.0', 'later@example.com');
      await client.getJson('https://example.com/a');

      expect(
        (calls[0].init.headers as Record<string, string>)['User-Agent'],
      ).toContain('mailto=later@example.com');
    });
  });

  describe('ETag revalidation', () => {
    it('replays the cached body on a 304', async () => {
      const calls = stubFetch(
        { body: '{"v":1}', headers: { etag: 'W/"abc"' } },
        { status: 304 },
      );
      const client = new HttpClient('1.0.0');

      expect(await client.getJson('https://example.com/a')).toEqual({ v: 1 });
      expect(await client.getJson('https://example.com/a')).toEqual({ v: 1 });

      // The second request offered the validator rather than asking afresh.
      expect(
        (calls[1].init.headers as Record<string, string>)['If-None-Match'],
      ).toBe('W/"abc"');
    });

    it('sends If-Modified-Since when that is all the server gave', async () => {
      const calls = stubFetch(
        {
          body: '{"v":1}',
          headers: { 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' },
        },
        { status: 304 },
      );
      const client = new HttpClient('1.0.0');
      await client.getJson('https://example.com/a');
      await client.getJson('https://example.com/a');

      expect(
        (calls[1].init.headers as Record<string, string>)['If-Modified-Since'],
      ).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    });

    it('does not cache or revalidate a POST', async () => {
      const calls = stubFetch({ body: '{}', headers: { etag: 'W/"x"' } });
      const client = new HttpClient('1.0.0');

      await client.postJson('https://example.com/q', { a: 1 });
      await client.postJson('https://example.com/q', { a: 1 });

      expect(calls).toHaveLength(2);
      expect(
        (calls[1].init.headers as Record<string, string>)['If-None-Match'],
      ).toBeUndefined();
    });
  });

  describe('retries', () => {
    it('retries a 429 with backoff and returns the eventual success', async () => {
      const calls = stubFetch(
        { status: 429 },
        { status: 200, body: '{"v":2}' },
      );
      const client = new HttpClient('1.0.0');

      const promise = client.getJson('https://example.com/a');
      await vi.advanceTimersByTimeAsync(1000);

      expect(await promise).toEqual({ v: 2 });
      expect(calls).toHaveLength(2);
    });

    it('retries a 5xx', async () => {
      const calls = stubFetch({ status: 503 }, { status: 200, body: '{}' });
      const client = new HttpClient('1.0.0');

      const promise = client.getJson('https://example.com/a');
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(calls).toHaveLength(2);
    });

    it('gives up after three retries and reports the status', async () => {
      stubFetch({ status: 500 });
      const client = new HttpClient('1.0.0');

      const promise = client.getJson('https://example.com/a');
      const assertion = expect(promise).rejects.toBeInstanceOf(HttpError);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    });

    it('honours a short Retry-After', async () => {
      const calls = stubFetch(
        { status: 429, headers: { 'retry-after': '5' } },
        { status: 200, body: '{}' },
      );
      const client = new HttpClient('1.0.0');
      const promise = client.getJson('https://example.com/a');

      // Still waiting at 4s, through at 5s — the header, not the backoff.
      await vi.advanceTimersByTimeAsync(4000);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1500);
      await promise;
      expect(calls).toHaveLength(2);
    });

    it('refuses a Retry-After beyond the cap rather than appearing to hang', async () => {
      stubFetch({ status: 429, headers: { 'retry-after': '3600' } });
      const client = new HttpClient('1.0.0');

      // Rejects immediately: an hour-long sleep is indistinguishable from a bug.
      await expect(client.getJson('https://example.com/a')).rejects.toThrow(
        /retry-after/,
      );
    });

    it('does not retry an ordinary 404', async () => {
      const calls = stubFetch({ status: 404 });
      const client = new HttpClient('1.0.0');

      await expect(
        client.getJson('https://example.com/missing'),
      ).rejects.toMatchObject({ status: 404, isNotFound: true });
      expect(calls).toHaveLength(1);
    });
  });

  describe('rate limiting', () => {
    it('spaces crates.io requests to one per second', async () => {
      const calls = stubFetch();
      const client = new HttpClient('1.0.0');

      const all = Promise.all([
        client.getJson('https://crates.io/api/v1/crates/a'),
        client.getJson('https://crates.io/api/v1/crates/b'),
        client.getJson('https://crates.io/api/v1/crates/c'),
      ]);

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(3);
      await all;
    });

    it('does not throttle hosts with no declared limit', async () => {
      const calls = stubFetch();
      const client = new HttpClient('1.0.0');

      await Promise.all([
        client.getJson('https://registry.npmjs.org/a'),
        client.getJson('https://registry.npmjs.org/b'),
        client.getJson('https://registry.npmjs.org/c'),
      ]);
      expect(calls).toHaveLength(3);
    });
  });

  describe('cancellation', () => {
    it('propagates an already-aborted signal', async () => {
      stubFetch();
      const controller = new AbortController();
      controller.abort();

      const client = new HttpClient('1.0.0');
      await expect(
        client.getJson('https://example.com/a', { signal: controller.signal }),
      ).rejects.toThrow();
    });

    it('cancels an in-flight request when the caller aborts', async () => {
      /*
       * The caller's signal is combined with this request's own timeout. That
       * combination used to have a hand-rolled fallback for hosts without
       * `AbortSignal.any` which leaked a listener per *successful* request onto
       * the caller's signal — and a caller's signal covers a whole scan. The
       * fallback is gone; this holds the behaviour it was there to provide.
       */
      const abortError = () =>
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
        });
      globalThis.fetch = ((_url: string, init: RequestInit = {}) =>
        new Promise((_resolve, reject) => {
          // Already aborted by the time the request reaches `fetch` — the rate
          // limiter is awaited first, so this is the ordering that actually
          // happens here.
          if (init.signal?.aborted) {
            reject(abortError());
            return;
          }
          init.signal?.addEventListener('abort', () => reject(abortError()));
        })) as unknown as typeof fetch;

      const controller = new AbortController();
      const client = new HttpClient('1.0.0');
      const pending = client.getJson('https://example.com/slow', {
        signal: controller.signal,
      });

      controller.abort();
      await expect(pending).rejects.toThrow(/abort/i);
    });

    it('does not retain the caller signal after a request succeeds', async () => {
      /*
       * The specific regression: one listener per request accumulating on a
       * signal that outlives every one of them. A scan of 500 packages left
       * 500 behind.
       */
      stubFetch();
      const controller = new AbortController();
      const client = new HttpClient('1.0.0');

      let added = 0;
      let removed = 0;
      const signal = controller.signal;
      const originalAdd = signal.addEventListener.bind(signal);
      const originalRemove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((...args: Parameters<typeof originalAdd>) => {
        added++;
        return originalAdd(...args);
      }) as typeof signal.addEventListener;
      signal.removeEventListener = ((
        ...args: Parameters<typeof originalRemove>
      ) => {
        removed++;
        return originalRemove(...args);
      }) as typeof signal.removeEventListener;

      for (let i = 0; i < 20; i++) {
        await client.getJson(`https://example.com/${i}`, { signal });
      }

      // `AbortSignal.any` may register at most one listener per composite and
      // is expected to release it; what must not happen is 20 accumulating
      // with none released.
      expect(added - removed).toBeLessThan(20);
    });
  });
});

describe('HttpError', () => {
  it('singles out 404, which is an expected outcome rather than a failure', () => {
    expect(new HttpError('404 Not Found', 404, 'u').isNotFound).toBe(true);
    expect(new HttpError('500 Server Error', 500, 'u').isNotFound).toBe(false);
  });
});

describe('conditional requests', () => {
  // Same harness as `describe('HttpClient')` above; a sibling block does not
  // inherit its hooks.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('re-asks unconditionally when a 304 names an entry it no longer holds', async () => {
    // The entry validated against can be evicted between sending
    // `If-None-Match` and the answer arriving — routine during a scan large
    // enough to cycle the cache. The 304 is then unusable, and reporting it as
    // a failed request (which is where `!response.ok` sent it) turned a
    // successful revalidation into an error the caller had to fall back from.
    const calls = stubFetch(
      { body: 'first', headers: { etag: 'W/"1"' } },
      { status: 304 },
      { body: 'second', headers: { etag: 'W/"2"' } },
    );
    const client = new HttpClient('1.0.0');

    expect(await client.getText('https://example.com/a')).toBe('first');

    // Simulate the eviction by asking a client that never saw the first body.
    const cold = new HttpClient('1.0.0');
    const body = await cold.getText('https://example.com/a');

    expect(body).toBe('second');
    // Two attempts: the conditional one, then the unconditional retry.
    expect(calls).toHaveLength(3);
    expect(calls[2].init.headers).not.toHaveProperty('If-None-Match');
  });

  it('does not serve an authenticated response to an unauthenticated request', async () => {
    const calls = stubFetch(
      { body: 'private', headers: { etag: 'W/"p"' } },
      { body: 'public', headers: { etag: 'W/"q"' } },
    );
    const client = new HttpClient('1.0.0');

    await client.getText('https://registry.example/pkg', {
      headers: { Authorization: 'Bearer secret' },
    });
    const anonymous = await client.getText('https://registry.example/pkg');

    // Same URL, different credentials: the second must be a real request, not
    // a revalidation of the first's cached body.
    expect(anonymous).toBe('public');
    expect(calls).toHaveLength(2);
    expect(calls[1].init.headers).not.toHaveProperty('If-None-Match');
  });

  it('still revalidates when the same credentials ask again', async () => {
    const calls = stubFetch(
      { body: 'private', headers: { etag: 'W/"p"' } },
      { status: 304 },
    );
    const client = new HttpClient('1.0.0');
    const headers = { Authorization: 'Bearer secret' };

    await client.getText('https://registry.example/pkg', { headers });
    const again = await client.getText('https://registry.example/pkg', {
      headers,
    });

    expect(again).toBe('private');
    expect(
      (calls[1].init.headers as Record<string, string>)['If-None-Match'],
    ).toBe('W/"p"');
  });
});

describe('rate limiter cancellation', () => {
  // Same harness as `describe('HttpClient')` above; a sibling block does not
  // inherit its hooks.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives up its place in the queue when the caller cancels', async () => {
    // crates.io is capped at one request per second, so a cancelled scan of a
    // large project used to keep issuing requests for minutes afterwards.
    stubFetch({ body: '{}' });
    const client = new HttpClient('1.0.0');
    const controller = new AbortController();

    const first = client.getText('https://crates.io/a');
    // Capture the outcome immediately so the rejection is never unhandled.
    const outcome = client
      .getText('https://crates.io/b', { signal: controller.signal })
      .then(
        () => 'resolved',
        (error: unknown) => (error as Error).name,
      );

    controller.abort();
    await vi.advanceTimersByTimeAsync(2000);

    await first;
    expect(await outcome).toBe('AbortError');
  });
});
