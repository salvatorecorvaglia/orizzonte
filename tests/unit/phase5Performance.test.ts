import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Memento, TtlCache } from '../../src/core/cache.js';
import { HttpClient } from '../../src/core/http.js';
import {
  isRelatedMetadata,
  matchesMutationSnapshot,
} from '../../src/core/manifestMutationPolicy.js';
import { SharedRequests } from '../../src/core/sharedRequest.js';
import type { Dependency } from '../../src/core/types.js';
import { applyVersions } from '../../src/core/versionEnrichment.js';
import { PythonProvider } from '../../src/providers/python/index.js';
import { makeContext } from './helpers.js';

const dep = (overrides: Partial<Dependency> = {}): Dependency => ({
  key: 'pkg',
  name: 'pkg',
  ecosystem: 'node',
  scope: 'prod',
  declared: '^1',
  installed: '1.0.0',
  updateKind: 'unknown',
  manifestPath: '/p/package.json',
  projectLabel: 'p',
  vulnerabilities: [],
  ...overrides,
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('scan-scoped version calculations', () => {
  it('calculates once per package and range without caching member-specific fallbacks', () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      dep({
        key: String(i),
        declared: i < 100 ? '^1' : '^9',
        installed: i % 2 ? '1.0.0' : '1.0.1',
      }),
    );
    const metrics = applyVersions(
      rows,
      'node',
      new Map([['pkg', { versions: ['1.0.0', '1.0.1', '1.1.0'] }]]),
    );
    expect(metrics).toEqual({
      rows: 200,
      latestCalculations: 1,
      wantedCalculations: 2,
    });
    expect(rows[0].wanted).toBe('1.1.0');
    expect(rows[100].wanted).toBe('1.0.1');
    expect(rows[101].wanted).toBe('1.0.0');
    applyVersions(rows, 'node', new Map([['pkg', { versions: ['2.0.0'] }]]));
    expect(rows[0].latest).toBe('2.0.0');
  });
});

describe('shared request cancellation', () => {
  it('keeps work alive for other subscribers and removes completed entries', async () => {
    const requests = new SharedRequests<string>();
    let finish: (s: string) => void = () => {};
    let sharedSignal: AbortSignal | undefined;
    const load = vi.fn((signal: AbortSignal) => {
      sharedSignal = signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const firstController = new AbortController();
    const first = requests.run('key', load, firstController.signal);
    const second = requests.run('key', load);
    const cancelled = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    });
    await Promise.resolve();
    firstController.abort();
    await cancelled;
    expect(sharedSignal?.aborted).toBe(false);
    finish('ok');
    expect(await second).toBe('ok');
    expect(load).toHaveBeenCalledTimes(1);
    const next = requests.run('key', async () => 'new');
    expect(await next).toBe('new');
  });
  it('allows a superseding search to inherit the download', async () => {
    const requests = new SharedRequests<string>();
    const controller = new AbortController();
    let finish: (s: string) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const first = requests.run('key', load, controller.signal);
    const cancelled = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    const second = requests.run('key', load);
    await Promise.resolve();
    finish('ok');
    await cancelled;
    expect(await second).toBe('ok');
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('aborts abandoned work and does not poison the next request', async () => {
    const requests = new SharedRequests<string>();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const first = requests.run(
      'key',
      async (shared) => {
        signal = shared;
        await new Promise<void>((_resolve, reject) =>
          shared.addEventListener('abort', () => reject(shared.reason), {
            once: true,
          }),
        );
        return 'unused';
      },
      controller.signal,
    );
    const cancelled = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    });
    await Promise.resolve();
    controller.abort();
    await cancelled;
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(await requests.run('key', async () => 'new')).toBe('new');
  });
});

describe('Python project index flights', () => {
  it('shares a cold index across provider instances and isolates credentials', async () => {
    const ctx = makeContext();
    let release: (value: unknown) => void = () => {};
    const indexes: AbortSignal[] = [];
    ctx.http.getJson = vi.fn(
      async (url: string, options?: { signal?: AbortSignal }) => {
        if (url.endsWith('/simple/')) {
          indexes.push(options!.signal!);
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        throw new Error('no exact match');
      },
    ) as typeof ctx.http.getJson;
    const firstController = new AbortController();
    const first = new PythonProvider().search(
      'left',
      ctx,
      firstController.signal,
    );
    const cancelled = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    });
    const second = new PythonProvider().search('right', ctx);
    await vi.waitFor(() => expect(indexes).toHaveLength(1));
    firstController.abort();
    expect(indexes[0].aborted).toBe(false);
    release({ projects: [{ name: 'right-tools' }] });
    await cancelled;
    expect((await second).map((result) => result.name)).toContain(
      'right-tools',
    );
    const privateContext = {
      ...ctx,
      registryAuthHeaders: () => ({ Authorization: 'Bearer different' }),
    };
    const third = new PythonProvider().search('private', privateContext);
    await vi.waitFor(() => expect(indexes).toHaveLength(2));
    release({ projects: [{ name: 'private-tools' }] });
    expect((await third).map((result) => result.name)).toContain(
      'private-tools',
    );
  });
});

describe('HTTP deadlines', () => {
  it('bounds the initial limiter queue and never sends expired work', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const client = new HttpClient('test');
    await client.getJson('https://crates.io/first');
    const pending = client.getJson('https://crates.io/queued', {
      timeoutMs: 100,
    });
    const failed = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await vi.advanceTimersByTimeAsync(401);
    await failed;
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('caps a later attempt at the remaining whole-request time', async () => {
    vi.useFakeTimers();
    let call = 0;
    const start = Date.now();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        call++;
        if (call === 1)
          return new Promise<Response>((resolve) =>
            setTimeout(
              () =>
                resolve(
                  new Response('', {
                    status: 503,
                    headers: { 'retry-after': '0.25' },
                  }),
                ),
              90,
            ),
          );
        return new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener(
            'abort',
            () => reject(init.signal!.reason),
            { once: true },
          ),
        );
      }),
    );
    const pending = new HttpClient('test').getJson(
      'https://example.test/retry',
      { timeoutMs: 100 },
    );
    const failed = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await vi.advanceTimersByTimeAsync(400);
    await failed;
    expect(Date.now() - start).toBe(400);
    expect(call).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('accounts for non-ASCII response bytes accurately', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('é'.repeat(20), { headers: { etag: 'x' } }),
      ),
    );
    const client = new HttpClient('test');
    await client.getText('https://example.test/bytes');
    expect(client.cacheStatistics()).toEqual({
      entries: 1,
      serializedBytes: 40,
    });
  });
});

describe('cache resource accounting', () => {
  it('reports persisted and memory-only values separately without changing eviction', async () => {
    const stored = new Map<string, unknown>();
    const storage: Memento = {
      get: <T>(key: string) => stored.get(key) as T,
      keys: () => [...stored.keys()],
      update: async (key, value) => {
        stored.set(key, value);
      },
    };
    const cache = new TtlCache(storage, 1);
    await cache.set('persisted', 'é', 10000);
    await cache.flushNow();
    await cache.set('index', 'x'.repeat(100), 10000, { persist: false });
    const stats = cache.statistics();
    expect(stats.memory.entries).toBe(1);
    expect(stats.persisted.entries).toBe(1);
    expect(stats.pending.entries).toBe(0);
    expect(stats.memory.serializedBytes).toBeGreaterThan(100);
    expect(cache.get('persisted')).toBe('é');
    expect(cache.statistics().memory.entries).toBe(1);
  });
});

describe('manifest mutation policy', () => {
  it('rejects changed targets and requirement semantics', () => {
    const original = dep({ cargoTarget: 'cfg(windows)' });
    expect(matchesMutationSnapshot({ ...original }, original)).toBe(true);
    expect(
      matchesMutationSnapshot(
        { ...original, cargoTarget: 'cfg(unix)' },
        original,
      ),
    ).toBe(false);
    expect(matchesMutationSnapshot(undefined, original)).toBe(false);
  });
  it('checks governing metadata without blocking unrelated dirty source files', () => {
    const provider = {
      manifestFiles: ['package.json'],
      lockFiles: ['pnpm-lock.yaml'],
    };
    expect(
      isRelatedMetadata('/p/pnpm-lock.yaml', '/p/packages/app', provider),
    ).toBe(true);
    expect(
      isRelatedMetadata('/p/packages/app/package.json', '/p', provider),
    ).toBe(true);
    expect(isRelatedMetadata('/p/other.ts', '/p', provider)).toBe(false);
    expect(isRelatedMetadata('/unrelated/package.json', '/p', provider)).toBe(
      false,
    );
  });
});
