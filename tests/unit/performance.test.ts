/**
 * The costs Phase 4 took out: connections held by unread bodies, a Cargo scan
 * throttled to one crate a second, a startup blob carrying thousands of
 * prereleases, release notes cached at any length, and Maven Central asked
 * everything twice.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchChangelog } from '../../src/core/changelog.js';
import type { HttpClient as HttpClientType } from '../../src/core/http.js';
import { HttpClient } from '../../src/core/http.js';
import {
  CargoProvider,
  parseSparseIndex,
  sparseIndexPath,
} from '../../src/providers/cargo/index.js';
import { compactVersionInfo } from '../../src/providers/shared/cachedFetch.js';
import { searchMavenCentral } from '../../src/providers/shared/mavenCentral.js';
import { makeContext } from './helpers.js';

describe('unread response bodies', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubWithBody(statuses: number[]) {
    const cancels: number[] = [];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        const status = statuses[Math.min(call, statuses.length - 1)];
        const index = call++;
        return Promise.resolve({
          status,
          statusText: 'x',
          ok: status >= 200 && status < 300,
          headers: { get: () => null },
          text: () => Promise.resolve('{}'),
          body: {
            cancel: () => {
              cancels.push(index);
              return Promise.resolve();
            },
          },
        } as unknown as Response);
      }),
    );
    return cancels;
  }

  it('releases the body of an error it will not read', async () => {
    const cancels = stubWithBody([404]);
    await expect(
      new HttpClient('1.0.0').getJson('https://example.com/missing'),
    ).rejects.toThrow('404');
    expect(cancels).toEqual([0]);
  });

  it('releases the body of a response it is about to retry', async () => {
    vi.useFakeTimers();
    const cancels = stubWithBody([503, 200]);
    const pending = new HttpClient('1.0.0').getJson(
      'https://example.com/flaky',
    );
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({});
    expect(cancels).toEqual([0]);
  });
});

describe('crates.io sparse index', () => {
  it.each([
    ['a', '1/a'],
    ['cc', '2/cc'],
    ['url', '3/u/url'],
    ['serde', 'se/rd/serde'],
    ['Inflector', 'in/fl/inflector'],
  ])('%s lives at %s', (name, expected) => {
    expect(sparseIndexPath(name)).toBe(expected);
  });

  it('lists versions, leaving out yanked ones and lines that do not parse', () => {
    const text = [
      '{"name":"x","vers":"1.0.0","yanked":false}',
      '{"name":"x","vers":"1.0.1","yanked":true}',
      'not json',
      '{"name":"x","vers":"1.1.0","yanked":false}',
      '',
    ].join('\n');
    expect(parseSparseIndex(text)).toEqual(['1.0.0', '1.1.0']);
  });

  it('asks the index, not the rate-limited API, when no registry is overridden', async () => {
    const getText = vi.fn(() =>
      Promise.resolve(
        '{"vers":"1.0.200","yanked":false}\n{"vers":"1.0.201-rc.1","yanked":false}\n',
      ),
    );
    const getJson = vi.fn();
    const ctx = {
      ...makeContext(),
      http: { getText, getJson } as unknown as HttpClientType,
    };

    const versions = await new CargoProvider().fetchVersions(['serde'], ctx);

    expect(getText).toHaveBeenCalledWith(
      'https://index.crates.io/se/rd/serde',
      expect.anything(),
    );
    expect(getJson).not.toHaveBeenCalled();
    expect(versions.get('serde')?.latest).toBe('1.0.200');
  });
});

describe('compactVersionInfo', () => {
  it('preserves prereleases that can still satisfy explicit constraints', () => {
    const compacted = compactVersionInfo('node', {
      versions: [
        '14.0.0',
        '14.1.0-canary.1',
        '14.1.0-canary.2',
        '14.1.0',
        '15.0.0-canary.1',
      ],
      latest: '14.1.0',
    });

    expect(compacted.versions).toEqual([
      '14.0.0',
      '14.1.0-canary.1',
      '14.1.0-canary.2',
      '14.1.0',
      '15.0.0-canary.1',
    ]);
    expect(compacted.latest).toBe('14.1.0');
  });

  it('keeps a list with no stable release as it is', () => {
    const info = { versions: ['0.1.0-alpha.1', '0.1.0-alpha.2'] };
    expect(compactVersionInfo('node', info)).toEqual(info);
  });

  it('uses the ecosystem’s own notion of a prerelease', () => {
    const compacted = compactVersionInfo('python', {
      versions: ['1.0', '1.1rc1', '1.1', '2.0a1'],
    });
    expect(compacted.versions).toEqual(['1.0', '1.1rc1', '1.1', '2.0a1']);
  });
});

describe('cached release notes', () => {
  it('keeps only what the drawer shows, with long bodies capped', async () => {
    const ctx = makeContext();
    const getJson = vi.fn(() =>
      Promise.resolve([
        {
          tag_name: '2.0.0',
          body: 'x'.repeat(10_000),
          html_url: 'https://github.com/a/b/releases/tag/2.0.0',
          author: { login: 'someone', avatar_url: 'https://example.com' },
          assets: [{ name: 'huge.zip' }],
        },
      ]),
    );
    const withHttp = {
      ...ctx,
      http: { ...ctx.http, getJson } as unknown as HttpClientType,
    };

    const entries = await fetchChangelog(
      'https://github.com/a/b',
      undefined,
      '2.0.0',
      withHttp,
    );

    expect(entries?.[0].body.length).toBeLessThanOrEqual(4001);
    expect(entries?.[0].body.endsWith('…')).toBe(true);
    const cached = withHttp.cache.get<Array<Record<string, unknown>>>(
      'github:releases:a:b',
    );
    expect(cached?.[0]).not.toHaveProperty('author');
    expect(cached?.[0]).not.toHaveProperty('assets');
  });
});

describe('Maven Central', () => {
  it('shares one request between concurrent identical searches', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const getJson = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const ctx = {
      ...makeContext(),
      http: { getJson } as unknown as HttpClientType,
    };

    const maven = searchMavenCentral('guava', 'maven', ctx);
    const gradle = searchMavenCentral('guava', 'gradle', ctx);
    resolve({
      response: {
        numFound: 1,
        docs: [
          {
            id: 'x',
            g: 'com.google.guava',
            a: 'guava',
            latestVersion: '33.0.0',
          },
        ],
      },
    });

    const [fromMaven, fromGradle] = await Promise.all([maven, gradle]);
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(fromMaven[0]).toMatchObject({
      ecosystem: 'maven',
      version: '33.0.0',
    });
    expect(fromGradle[0]).toMatchObject({
      ecosystem: 'gradle',
      version: '33.0.0',
    });
  });
});
