/**
 * "What's changed": GitHub releases between an installed and target version,
 * matched to versions by tag text rather than a semver parser — tags are not
 * guaranteed to be valid semver at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { fetchChangelog } from '../../src/core/changelog.js';
import type { HttpClient } from '../../src/core/http.js';
import { HttpError } from '../../src/core/http.js';
import { makeContext } from './helpers.js';

interface Release {
  tag_name: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
}

function withReleases(releases: Release[] | (() => Promise<Release[]>)) {
  const ctx = makeContext();
  const getJson = vi.fn((_url: string) =>
    typeof releases === 'function'
      ? releases()
      : Promise.resolve(releases as unknown),
  );
  return {
    ctx: { ...ctx, http: { ...ctx.http, getJson } as unknown as HttpClient },
    getJson,
  };
}

function release(overrides: Partial<Release> = {}): Release {
  return {
    tag_name: '1.0.0',
    html_url: 'https://github.com/foo/bar/releases/tag/1.0.0',
    ...overrides,
  };
}

const REPO = 'https://github.com/foo/bar';

describe('fetchChangelog', () => {
  it('returns undefined without a network call for a non-GitHub repository', async () => {
    const { ctx, getJson } = withReleases([]);
    const entries = await fetchChangelog(
      'https://gitlab.com/foo/bar',
      '1.0.0',
      '2.0.0',
      ctx,
    );
    expect(entries).toBeUndefined();
    expect(getJson).not.toHaveBeenCalled();
  });

  it('windows releases between the installed and target tags', async () => {
    const { ctx } = withReleases([
      release({ tag_name: 'v3.0.0' }),
      release({ tag_name: 'v2.0.0' }),
      release({ tag_name: 'v1.5.0' }),
      release({ tag_name: 'v1.0.0' }),
    ]);
    const entries = await fetchChangelog(REPO, '1.0.0', '2.0.0', ctx);
    expect(entries?.map((entry) => entry.version)).toEqual([
      'v2.0.0',
      'v1.5.0',
    ]);
  });

  it('matches tags with a bare version, no v prefix', async () => {
    const { ctx } = withReleases([
      release({ tag_name: '2.0.0' }),
      release({ tag_name: '1.0.0' }),
    ]);
    const entries = await fetchChangelog(REPO, '1.0.0', '2.0.0', ctx);
    expect(entries?.map((entry) => entry.version)).toEqual(['2.0.0']);
  });

  it('matches monorepo-style scoped tags like repo@version', async () => {
    const { ctx } = withReleases([
      release({ tag_name: 'bar@2.0.0' }),
      release({ tag_name: 'bar@1.0.0' }),
    ]);
    const entries = await fetchChangelog(REPO, '1.0.0', '2.0.0', ctx);
    expect(entries?.map((entry) => entry.version)).toEqual(['bar@2.0.0']);
  });

  it('excludes drafts', async () => {
    const { ctx } = withReleases([
      release({ tag_name: 'v2.0.0', draft: true }),
      release({ tag_name: 'v1.0.0' }),
    ]);
    const entries = await fetchChangelog(REPO, '1.0.0', '2.0.0', ctx);
    expect(entries).toEqual([]);
  });

  it('falls back to the most recent releases when the installed tag cannot be found', async () => {
    const { ctx } = withReleases([
      release({ tag_name: 'v3.0.0' }),
      release({ tag_name: 'v2.0.0' }),
    ]);
    // "0.9.0" was never tagged (predates the repo's release history), so the
    // window cannot be bounded on that side.
    const entries = await fetchChangelog(REPO, '0.9.0', '3.0.0', ctx);
    expect(entries?.map((entry) => entry.version)).toEqual([
      'v3.0.0',
      'v2.0.0',
    ]);
  });

  it('carries the title only when it differs from the tag, and the body verbatim', async () => {
    const { ctx } = withReleases([
      release({
        tag_name: 'v2.0.0',
        name: 'The Big One',
        body: 'line one\nline two',
      }),
    ]);
    const entries = await fetchChangelog(REPO, '1.0.0', '2.0.0', ctx);
    expect(entries?.[0]).toMatchObject({
      title: 'The Big One',
      body: 'line one\nline two',
    });
  });

  it('returns an empty array, not an error, when the repository has no releases (404)', async () => {
    const ctx = makeContext();
    const getJson = vi.fn(() =>
      Promise.reject(new HttpError('Not Found', 404, 'x')),
    );
    const withCtx = {
      ...ctx,
      http: { ...ctx.http, getJson } as unknown as HttpClient,
    };
    const entries = await fetchChangelog(REPO, '1.0.0', '2.0.0', withCtx);
    expect(entries).toEqual([]);
  });

  it('propagates a genuine fetch failure rather than hiding it as "no releases"', async () => {
    const ctx = makeContext();
    const getJson = vi.fn(() =>
      Promise.reject(new HttpError('rate limited', 403, 'x')),
    );
    const withCtx = {
      ...ctx,
      http: { ...ctx.http, getJson } as unknown as HttpClient,
    };
    await expect(
      fetchChangelog(REPO, '1.0.0', '2.0.0', withCtx),
    ).rejects.toThrow('rate limited');
  });

  it('caches the release list, so a second lookup makes no second request', async () => {
    const { ctx, getJson } = withReleases([release({ tag_name: 'v2.0.0' })]);
    await fetchChangelog(REPO, '1.0.0', '2.0.0', ctx);
    await fetchChangelog(REPO, '1.0.0', '2.0.0', ctx);
    expect(getJson).toHaveBeenCalledOnce();
  });
});
