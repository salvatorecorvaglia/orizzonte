/**
 * Registry adapters that talk to a network: Maven Central's Solr API, and the
 * repository/changelog URL normalisation every provider feeds its links through.
 */

import { describe, expect, it, vi } from 'vitest';
import { CargoProvider } from '../../src/providers/cargo/index.js';
import { ComposerProvider } from '../../src/providers/composer/index.js';
import { GoProvider } from '../../src/providers/golang/index.js';
import { NodeProvider } from '../../src/providers/node/index.js';
import { PythonProvider } from '../../src/providers/python/index.js';
import {
  fetchMavenVersions,
  searchMavenCentral,
  splitCoordinate,
} from '../../src/providers/shared/mavenCentral.js';
import {
  changelogUrlFor,
  normalizeRepositoryUrl,
} from '../../src/providers/shared/repository.js';
import { makeContext } from './helpers.js';

/** A context whose http returns one scripted JSON body. */
function withResponse(body: unknown) {
  const ctx = makeContext();
  // Typed with the URL parameter so `mock.calls` can be asserted on.
  const getJson = vi.fn((_url: string) => Promise.resolve(body));
  return {
    ctx: { ...ctx, http: { ...ctx.http, getJson } as never },
    getJson,
  };
}

describe('splitCoordinate', () => {
  it('splits a groupId:artifactId pair', () => {
    expect(splitCoordinate('com.google.guava:guava')).toEqual({
      groupId: 'com.google.guava',
      artifactId: 'guava',
    });
  });

  it('rejects anything that is not a full coordinate', () => {
    expect(splitCoordinate('guava')).toBeNull();
    expect(splitCoordinate(':guava')).toBeNull();
    expect(splitCoordinate('com.google:')).toBeNull();
  });
});

describe('fetchMavenVersions', () => {
  it('queries the group and artifact fields rather than free text', async () => {
    const { ctx, getJson } = withResponse({
      response: { numFound: 2, docs: [{ v: '1.0' }, { v: '2.0' }] },
    });

    await fetchMavenVersions(['com.google.guava:guava'], 'maven', ctx);

    const url = getJson.mock.calls[0][0];
    expect(url).toContain('g:com.google.guava');
    expect(url).toContain('a:guava');
    // core=gav returns one document per version rather than per artifact.
    expect(url).toContain('core=gav');
  });

  it('picks the highest stable version as latest', async () => {
    const { ctx } = withResponse({
      response: {
        numFound: 3,
        docs: [{ v: '1.0' }, { v: '3.0-SNAPSHOT' }, { v: '2.0' }],
      },
    });

    const result = await fetchMavenVersions(['g:a'], 'maven', ctx);
    expect(result.get('g:a')?.latest).toBe('2.0');
    expect(result.get('g:a')?.versions).toHaveLength(3);
  });

  it('skips names that are not coordinates instead of querying for them', async () => {
    const { ctx, getJson } = withResponse({
      response: { numFound: 0, docs: [] },
    });

    const result = await fetchMavenVersions(['not-a-coordinate'], 'maven', ctx);
    expect(result.size).toBe(0);
    expect(getJson).not.toHaveBeenCalled();
  });

  it('serves a cached result without a second request', async () => {
    const { ctx, getJson } = withResponse({
      response: { numFound: 1, docs: [{ v: '1.0' }] },
    });

    await fetchMavenVersions(['g:a'], 'maven', ctx);
    await fetchMavenVersions(['g:a'], 'maven', ctx);
    expect(getJson).toHaveBeenCalledOnce();
  });

  it('returns nothing rather than throwing when Solr is unreachable', async () => {
    // makeContext's http rejects every call.
    const result = await fetchMavenVersions(['g:a'], 'maven', makeContext());
    expect(result.size).toBe(0);
  });
});

describe('searchMavenCentral', () => {
  it('queries the fields directly when the user types a full coordinate', async () => {
    const { ctx, getJson } = withResponse({
      response: { numFound: 0, docs: [] },
    });

    await searchMavenCentral('com.google.guava:guava', 'maven', ctx);
    expect(getJson.mock.calls[0][0]).toContain(
      'g:com.google.guava+AND+a:guava',
    );
  });

  it('maps documents onto coordinates with a browsable link', async () => {
    const { ctx } = withResponse({
      response: {
        numFound: 1,
        docs: [{ id: 'x', g: 'com.acme', a: 'lib', latestVersion: '3.1' }],
      },
    });

    expect(await searchMavenCentral('lib', 'gradle', ctx)).toEqual([
      {
        name: 'com.acme:lib',
        version: '3.1',
        ecosystem: 'gradle',
        repository: 'https://central.sonatype.com/artifact/com.acme/lib',
      },
    ]);
  });
});

describe('normalizeRepositoryUrl', () => {
  it('resolves the shorthand forms package.json allows', () => {
    expect(normalizeRepositoryUrl('github:foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
    expect(normalizeRepositoryUrl('gitlab:foo/bar')).toBe(
      'https://gitlab.com/foo/bar',
    );
    expect(normalizeRepositoryUrl('bitbucket:foo/bar')).toBe(
      'https://bitbucket.org/foo/bar',
    );
    expect(normalizeRepositoryUrl('foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
  });

  it('rewrites git transports to something a browser can open', () => {
    expect(normalizeRepositoryUrl('git+https://github.com/foo/bar.git')).toBe(
      'https://github.com/foo/bar',
    );
    expect(normalizeRepositoryUrl('git://github.com/foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
    expect(normalizeRepositoryUrl('git@github.com:foo/bar.git')).toBe(
      'https://github.com/foo/bar',
    );
    expect(normalizeRepositoryUrl('ssh://git@github.com/foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
  });

  it('strips credentials rather than putting them in a clickable link', () => {
    expect(normalizeRepositoryUrl('https://user:pass@github.com/foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
  });

  it('declines anything that is not http(s) once normalised', () => {
    expect(normalizeRepositoryUrl(undefined)).toBeUndefined();
    expect(normalizeRepositoryUrl('   ')).toBeUndefined();
    expect(normalizeRepositoryUrl('file:///etc/passwd')).toBeUndefined();
    expect(normalizeRepositoryUrl('javascript:alert(1)')).toBeUndefined();
  });
});

describe('changelogUrlFor', () => {
  it('points at the releases page, which is likelier to exist than a file', () => {
    expect(changelogUrlFor('https://github.com/foo/bar')).toBe(
      'https://github.com/foo/bar/releases',
    );
    expect(changelogUrlFor('https://gitlab.com/foo/bar')).toBe(
      'https://gitlab.com/foo/bar/-/releases',
    );
  });

  it('offers nothing for forges whose layout it does not know', () => {
    expect(changelogUrlFor('https://bitbucket.org/foo/bar')).toBeUndefined();
    expect(changelogUrlFor(undefined)).toBeUndefined();
    expect(changelogUrlFor('not a url')).toBeUndefined();
  });
});

/**
 * PyPI's simple index makes no promise about the order of `versions`, so the
 * version offered for install has to be chosen by PEP 440 rather than by
 * position. Taking the last entry offered whatever PyPI happened to list last.
 */
describe('PythonProvider.search', () => {
  /** Routes each of the three calls `search` makes to its own scripted body. */
  function withPyPi(versions: string[]) {
    const ctx = makeContext();
    const getJson = vi.fn((url: string) => {
      if (url.endsWith('/json')) {
        return Promise.resolve({
          info: { name: 'requests', summary: 'HTTP for Humans' },
          urls: [],
        });
      }
      if (/\/simple\/[^/]+\/$/.test(url)) {
        return Promise.resolve({ versions });
      }
      // The full project index, used for the substring-match fallback.
      return Promise.resolve({ projects: [] });
    });
    return { ...ctx, http: { ...ctx.http, getJson } as never };
  }

  /** The same routing, but with a populated project index to search. */
  function withProjectIndex(names: string[]) {
    const ctx = makeContext();
    const getJson = vi.fn((url: string) => {
      if (url.endsWith('/simple/')) {
        return Promise.resolve({ projects: names.map((name) => ({ name })) });
      }
      // No exact hit, so the index fallback is the only source of results.
      return Promise.reject(new Error('not found'));
    });
    return { ...ctx, http: { ...ctx.http, getJson } as never };
  }

  it('ranks prefix matches above substring matches from the project index', async () => {
    /*
     * The index is held as one newline-delimited string rather than half a
     * million separate names, and scanned with `indexOf` rather than filtered.
     * These assertions are about the behaviour that has to survive that: which
     * names match, and in what order.
     */
    const provider = new PythonProvider();
    const results = await provider.search(
      'requests',
      withProjectIndex([
        'types-requests',
        'requests-oauthlib',
        'requests',
        'requests-toolbelt',
        'unrelated',
      ]),
    );

    const names = results.map((result) => result.name);
    // The exact name is offered by the registry lookup above, not the index,
    // so the index fallback deliberately leaves it out.
    expect(names).not.toContain('requests');
    expect(names).not.toContain('unrelated');
    // Prefix matches first, shorter first within each group.
    expect(names).toEqual([
      'requests-oauthlib',
      'requests-toolbelt',
      'types-requests',
    ]);
  });

  it('normalises index names so an underscore query still matches', async () => {
    // PEP 503 collapses `-_.` runs and lowercases; the index is stored in that
    // form, so the query has to go through it too.
    const provider = new PythonProvider();
    const results = await provider.search(
      'Typing_Extensions',
      withProjectIndex(['typing-extensions-stub', 'typing_extensions']),
    );

    expect(results.map((result) => result.name)).toEqual([
      'typing-extensions-stub',
    ]);
  });

  it('finds nothing in an index that could not be fetched', async () => {
    const provider = new PythonProvider();
    const ctx = makeContext();
    const failing = {
      ...ctx,
      http: {
        ...ctx.http,
        getJson: vi.fn(() => Promise.reject(new Error('offline'))),
      } as never,
    };

    await expect(provider.search('requests', failing)).resolves.toEqual([]);
  });

  it('offers the highest version, not the last one listed', async () => {
    const provider = new PythonProvider();
    // Deliberately unsorted, with the newest release in the middle and an
    // older patch last — the shape that made the previous implementation wrong.
    const results = await provider.search(
      'requests',
      withPyPi(['2.28.0', '2.32.3', '2.31.0', '2.9.1']),
    );

    expect(results[0].name).toBe('requests');
    expect(results[0].version).toBe('2.32.3');
  });

  it('prefers a stable release over a later prerelease', async () => {
    const provider = new PythonProvider();
    const results = await provider.search(
      'requests',
      withPyPi(['2.31.0', '3.0.0rc1']),
    );

    expect(results[0].version).toBe('2.31.0');
  });

  it('offers no version rather than a wrong one when nothing is published', async () => {
    const provider = new PythonProvider();
    const results = await provider.search('requests', withPyPi([]));

    expect(results[0].version).toBe('');
  });
});

describe('NodeProvider.fetchVersions', () => {
  it('keeps results for packages that succeeded when another in the batch fails', async () => {
    // A malformed packument (or a DNS error) for one package used to reject
    // the whole `Promise.all` in `mapWithConcurrency`, wiping out every
    // already-fetched sibling result for the batch. Each name's outcome must
    // be independent.
    const ctx = makeContext();
    const getJson = vi.fn((url: string) => {
      if (url.includes('bad-package')) {
        return Promise.reject(new TypeError('unexpected token in JSON'));
      }
      return Promise.resolve({
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': {} },
      });
    });

    const provider = new NodeProvider();
    const results = await provider.fetchVersions(
      ['good-package', 'bad-package'],
      { ...ctx, http: { ...ctx.http, getJson } as never },
    );

    expect(results.get('good-package')?.latest).toBe('1.0.0');
    expect(results.has('bad-package')).toBe(false);
  });
});

describe('searchMavenCentral encoding', () => {
  it('encodes both halves of a typed coordinate', async () => {
    // The query is a text box. An unencoded `&` would end the `q` parameter
    // early and change what Solr was actually asked.
    const { ctx, getJson } = withResponse({
      response: { numFound: 0, docs: [] },
    });

    await searchMavenCentral('com.example&x:widget#y', 'maven', ctx);

    const url = getJson.mock.calls[0][0];
    expect(url).toContain('g:com.example%26x');
    expect(url).toContain('a:widget%23y');
    expect(url).not.toContain('&x:');
  });
});

/**
 * `orizzonte.registryOverrides` used to only be wired up for Node and Python —
 * the other five providers hardcoded their public registry, so a compliance
 * mirror configured for e.g. Cargo silently kept talking to crates.io. One
 * test per provider (plus Maven/Gradle, sharing `mavenCentral.ts`) pins that
 * every ecosystem's outbound request actually goes to the configured host.
 */
describe('registryOverride wiring', () => {
  function withOverride(ecosystem: string, override: string, body: unknown) {
    const ctx = makeContext();
    const getJson = vi.fn((_url: string) => Promise.resolve(body));
    const getText = vi.fn((_url: string) => Promise.resolve(''));
    return {
      ctx: {
        ...ctx,
        http: { ...ctx.http, getJson, getText } as never,
        registryOverride: (eco: string) =>
          eco === ecosystem ? override : undefined,
      },
      getJson,
      getText,
    };
  }

  it('CargoProvider.fetchVersions uses the configured registry', async () => {
    const { ctx, getJson } = withOverride('cargo', 'https://cargo.internal', {
      crate: { name: 'serde', newest_version: '1.0.0' },
      versions: [{ num: '1.0.0', yanked: false }],
    });

    await new CargoProvider().fetchVersions(['serde'], ctx);

    expect(getJson.mock.calls[0][0]).toMatch(/^https:\/\/cargo\.internal\//);
  });

  it('ComposerProvider.fetchVersions uses the configured registry', async () => {
    const { ctx, getJson } = withOverride(
      'composer',
      'https://packagist.internal',
      {
        packages: { 'vendor/pkg': [{ name: 'vendor/pkg', version: '1.0.0' }] },
      },
    );

    await new ComposerProvider().fetchVersions(['vendor/pkg'], ctx);

    expect(getJson.mock.calls[0][0]).toMatch(
      /^https:\/\/packagist\.internal\//,
    );
  });

  it('GoProvider.fetchVersions uses the configured registry', async () => {
    const { ctx, getJson, getText } = withOverride(
      'golang',
      'https://proxy.internal',
      { Version: 'v1.0.0' },
    );
    getText.mockResolvedValue('v1.0.0\n');

    await new GoProvider().fetchVersions(['github.com/foo/bar'], ctx);

    expect(getJson.mock.calls[0][0]).toMatch(/^https:\/\/proxy\.internal\//);
    expect(getText.mock.calls[0][0]).toMatch(/^https:\/\/proxy\.internal\//);
  });

  it('fetchMavenVersions resolves the override per ecosystem, not globally', async () => {
    const ctx = makeContext();
    const getJson = vi.fn((_url: string) =>
      Promise.resolve({ response: { numFound: 1, docs: [{ v: '1.0' }] } }),
    );
    const withMaven = {
      ...ctx,
      http: { ...ctx.http, getJson } as never,
      // Only "maven" has an override configured; "gradle" must still fall
      // back to the public default rather than reusing maven's value.
      registryOverride: (eco: string) =>
        eco === 'maven' ? 'https://maven.internal' : undefined,
    };

    await fetchMavenVersions(['g:a'], 'maven', withMaven);
    expect(getJson.mock.calls[0][0]).toMatch(/^https:\/\/maven\.internal\?/);

    await fetchMavenVersions(['g:a'], 'gradle', withMaven);
    expect(getJson.mock.calls[1][0]).toMatch(/^https:\/\/search\.maven\.org\//);
  });
});

/*
 * One test per provider that reports a license, pinning the shape each
 * registry actually uses — npm's has drifted across three formats over the
 * years, PyPI's free-text field is untrustworthy on its own, and Packagist's
 * is an array even when there is exactly one license.
 */
describe('license extraction', () => {
  it('NodeProvider reads the modern bare-string form', async () => {
    const { ctx } = withResponse({
      version: '1.0.0',
      license: 'MIT',
    });
    const meta = await new NodeProvider().fetchMetadata('left-pad', ctx);
    expect(meta?.license).toBe('MIT');
  });

  it('NodeProvider falls back to the legacy { type } object', async () => {
    const { ctx } = withResponse({
      version: '1.0.0',
      license: { type: 'ISC' },
    });
    const meta = await new NodeProvider().fetchMetadata('old-pkg', ctx);
    expect(meta?.license).toBe('ISC');
  });

  it('NodeProvider falls back to the even older licenses array', async () => {
    const { ctx } = withResponse({
      version: '1.0.0',
      licenses: [{ type: 'BSD-3-Clause' }],
    });
    const meta = await new NodeProvider().fetchMetadata('ancient-pkg', ctx);
    expect(meta?.license).toBe('BSD-3-Clause');
  });

  it('PythonProvider prefers the classifiers over free-text license', async () => {
    const { ctx } = withResponse({
      info: {
        name: 'requests',
        version: '2.31.0',
        classifiers: [
          'Programming Language :: Python :: 3',
          'License :: OSI Approved :: Apache Software License',
        ],
        license: 'a very long hand-pasted license body that is not a name',
      },
    });
    const meta = await new PythonProvider().fetchMetadata('requests', ctx);
    expect(meta?.license).toBe('Apache Software License');
  });

  it('PythonProvider falls back to a short free-text license with no classifier', async () => {
    const { ctx } = withResponse({
      info: { name: 'demo', version: '1.0.0', license: 'MIT' },
    });
    const meta = await new PythonProvider().fetchMetadata('demo', ctx);
    expect(meta?.license).toBe('MIT');
  });

  it('PythonProvider reports no license rather than a pasted-in license body', async () => {
    const { ctx } = withResponse({
      info: {
        name: 'demo',
        version: '1.0.0',
        license: 'Copyright (c) 2024...\nPermission is hereby granted...',
      },
    });
    const meta = await new PythonProvider().fetchMetadata('demo', ctx);
    expect(meta?.license).toBeUndefined();
  });

  it("CargoProvider reads the newest version's license expression", async () => {
    const { ctx } = withResponse({
      crate: { name: 'serde' },
      versions: [{ num: '1.0.0', yanked: false, license: 'MIT OR Apache-2.0' }],
    });
    const meta = await new CargoProvider().fetchMetadata('serde', ctx);
    expect(meta?.license).toBe('MIT OR Apache-2.0');
  });

  it('ComposerProvider joins a multi-license array with OR', async () => {
    const { ctx } = withResponse({
      packages: {
        'vendor/pkg': [
          {
            name: 'vendor/pkg',
            version: '1.0.0',
            license: ['MIT', 'Apache-2.0'],
          },
        ],
      },
    });
    const meta = await new ComposerProvider().fetchMetadata('vendor/pkg', ctx);
    expect(meta?.license).toBe('MIT OR Apache-2.0');
  });

  it('ComposerProvider reports no license for an empty array', async () => {
    const { ctx } = withResponse({
      packages: {
        'vendor/pkg': [{ name: 'vendor/pkg', version: '1.0.0', license: [] }],
      },
    });
    const meta = await new ComposerProvider().fetchMetadata('vendor/pkg', ctx);
    expect(meta?.license).toBeUndefined();
  });
});

/*
 * One test per provider (plus Maven Central, shared by Maven and Gradle)
 * pinning that a configured `registryAuthHeaders` actually reaches the
 * outgoing request — the config plumbing is covered by
 * `registryOverride.test.ts`, but only these prove a provider does not
 * silently drop the header on its way to `ctx.http`.
 */
describe('authenticated registry overrides', () => {
  function withAuth(body: unknown) {
    const ctx = makeContext();
    // Typed with the options parameter too, so `mock.calls[n][1]` — the
    // headers a call actually sent — typechecks.
    const getJson = vi.fn(
      (_url: string, _options?: { headers?: Record<string, string> }) =>
        Promise.resolve(body),
    );
    const getText = vi.fn(
      (_url: string, _options?: { headers?: Record<string, string> }) =>
        Promise.resolve(''),
    );
    return {
      ctx: {
        ...ctx,
        http: { ...ctx.http, getJson, getText } as never,
        registryOverride: () => 'https://registry.internal',
        registryAuthHeaders: () => ({ Authorization: 'Bearer secret-value' }),
      },
      getJson,
      getText,
    };
  }

  it('NodeProvider.fetchVersions attaches the header', async () => {
    const { ctx, getJson } = withAuth({ versions: {} });
    await new NodeProvider().fetchVersions(['left-pad'], ctx);
    expect(getJson.mock.calls[0][1]?.headers?.Authorization).toBe(
      'Bearer secret-value',
    );
  });

  it('NodeProvider.fetchMetadata attaches the header', async () => {
    const { ctx, getJson } = withAuth({ version: '1.0.0' });
    await new NodeProvider().fetchMetadata('left-pad', ctx);
    expect(getJson.mock.calls[0][1]?.headers?.Authorization).toBe(
      'Bearer secret-value',
    );
  });

  it('PythonProvider.fetchVersions attaches the header', async () => {
    const { ctx, getJson } = withAuth({ versions: [] });
    await new PythonProvider().fetchVersions(['requests'], ctx);
    expect(getJson.mock.calls[0][1]?.headers?.Authorization).toBe(
      'Bearer secret-value',
    );
  });

  it('CargoProvider.fetchVersions attaches the header', async () => {
    const { ctx, getJson } = withAuth({ crate: { name: 'serde' } });
    await new CargoProvider().fetchVersions(['serde'], ctx);
    expect(getJson.mock.calls[0][1]?.headers?.Authorization).toBe(
      'Bearer secret-value',
    );
  });

  it('ComposerProvider.fetchVersions attaches the header', async () => {
    const { ctx, getJson } = withAuth({ packages: {} });
    await new ComposerProvider().fetchVersions(['vendor/pkg'], ctx);
    expect(getJson.mock.calls[0][1]?.headers?.Authorization).toBe(
      'Bearer secret-value',
    );
  });

  it('GoProvider.fetchVersions attaches the header to both requests', async () => {
    const { ctx, getJson, getText } = withAuth({ Version: 'v1.0.0' });
    await new GoProvider().fetchVersions(['github.com/foo/bar'], ctx);
    expect(getJson.mock.calls[0][1]?.headers?.Authorization).toBe(
      'Bearer secret-value',
    );
    expect(getText.mock.calls[0][1]?.headers?.Authorization).toBe(
      'Bearer secret-value',
    );
  });

  it('fetchMavenVersions attaches the header', async () => {
    const { ctx, getJson } = withAuth({
      response: { numFound: 0, docs: [] },
    });
    await fetchMavenVersions(['g:a'], 'maven', ctx);
    expect(getJson.mock.calls[0][1]?.headers?.Authorization).toBe(
      'Bearer secret-value',
    );
  });
});
