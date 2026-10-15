/**
 * Private packages stay private: a name a project serves from its own registry
 * is not sent to the public one, the Go module proxy or OSV. And a Go module
 * the build replaces is judged as what the build actually uses.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  goPrivatePatterns,
  matchesGoPrivate,
  npmScopeOf,
  privateNpmScopes,
} from '../../src/core/privateRegistries.js';
import { isRegistryPackage, isUpdatable } from '../../src/core/vocabulary.js';
import {
  GoProvider,
  parseReplacements,
} from '../../src/providers/golang/index.js';
import { NodeProvider } from '../../src/providers/node/index.js';
import { findDep, makeContext } from './helpers.js';

describe('GOPRIVATE matching', () => {
  it('reads GOPRIVATE and GONOPROXY as comma-separated patterns', () => {
    expect(
      goPrivatePatterns({
        GOPRIVATE: 'git.corp.example.com, *.internal',
        GONOPROXY: 'example.org/private',
      }),
    ).toEqual(['git.corp.example.com', '*.internal', 'example.org/private']);
    expect(goPrivatePatterns({})).toEqual([]);
  });

  it.each([
    ['git.corp.example.com/team/repo', ['git.corp.example.com'], true],
    ['git.corp.example.com/team/repo', ['*.corp.example.com'], true],
    ['example.org/private/lib', ['example.org/private'], true],
    ['example.org/public/lib', ['example.org/private'], false],
    ['github.com/acme/secret', ['github.com/acme'], true],
    ['github.com/acmeco/lib', ['github.com/acme'], false],
    ['github.com/a/b', ['github.com/[ab]'], true],
    ['example.org', ['example.org/private'], false],
  ])('%s against %j is %s', (modulePath, patterns, expected) => {
    expect(matchesGoPrivate(modulePath, patterns)).toBe(expected);
  });
});

describe('.npmrc scopes', () => {
  it('collects scopes sent to a registry other than the public one', () => {
    const scopes = privateNpmScopes(
      [
        '# comment',
        '@acme:registry=https://npm.acme.internal/',
        '@public:registry=https://registry.npmjs.org/',
        '//npm.acme.internal/:_authToken=never-read',
        'registry=https://mirror.example.com/',
      ].join('\n'),
    );
    expect([...scopes]).toEqual(['@acme']);
  });

  it('knows a scoped name from a plain one', () => {
    expect(npmScopeOf('@acme/utils')).toBe('@acme');
    expect(npmScopeOf('lodash')).toBeUndefined();
  });

  it('marks packages in a private scope, and only those', async () => {
    const ctx = makeContext(
      {
        '/ws/.npmrc': '@acme:registry=https://npm.acme.internal/\n',
        '/ws/app/package.json': '',
      },
      '/ws',
    );
    const parsed = await new NodeProvider().parse(
      '/ws/app/package.json',
      JSON.stringify({
        dependencies: {
          '@acme/utils': '^1.0.0',
          lodash: '^4.17.0',
          'acme-alias': 'npm:@acme/core@^2.0.0',
        },
      }),
      ctx,
    );

    const utils = findDep(parsed.dependencies, '@acme/utils');
    expect(utils.source).toBe('private');
    expect(isRegistryPackage(utils)).toBe(false);
    expect(findDep(parsed.dependencies, 'acme-alias').source).toBe('private');
    expect(findDep(parsed.dependencies, 'lodash').source).toBeUndefined();
  });

  it('defers to a registry override, which can answer for private scopes', async () => {
    const ctx = {
      ...makeContext(
        { '/ws/.npmrc': '@acme:registry=https://npm.acme.internal/\n' },
        '/ws',
      ),
      registryOverride: () => 'https://npm.acme.internal',
    };
    const parsed = await new NodeProvider().parse(
      '/ws/package.json',
      JSON.stringify({ dependencies: { '@acme/utils': '^1.0.0' } }),
      ctx,
    );
    expect(findDep(parsed.dependencies, '@acme/utils').source).toBeUndefined();
  });
});

describe('Go modules', () => {
  const previous = process.env.GOPRIVATE;
  afterEach(() => {
    if (previous === undefined) delete process.env.GOPRIVATE;
    else process.env.GOPRIVATE = previous;
  });

  const goMod = `module example.com/app

go 1.22

require (
\tgithub.com/pkg/errors v0.9.1
\tgolang.org/x/net v0.20.0
\texample.com/local v1.0.0
\tgit.corp.example.com/team/lib v1.2.0
)

replace golang.org/x/net => golang.org/x/net v0.23.0

replace (
\texample.com/local => ../local
\tgithub.com/pkg/errors v0.9.1 => github.com/fork/errors v0.9.2 // patched
)
`;

  it('reads single-line and block replace directives', () => {
    expect(parseReplacements(goMod)).toEqual([
      { from: 'example.com/local', to: '../local' },
      {
        from: 'github.com/pkg/errors',
        fromVersion: 'v0.9.1',
        to: 'github.com/fork/errors',
        toVersion: 'v0.9.2',
      },
      {
        from: 'golang.org/x/net',
        to: 'golang.org/x/net',
        toVersion: 'v0.23.0',
      },
    ]);
  });

  it('judges a replaced module as what the build uses', async () => {
    delete process.env.GOPRIVATE;
    const parsed = await new GoProvider().parse(
      '/p/go.mod',
      goMod,
      makeContext(),
    );

    const net = findDep(parsed.dependencies, 'golang.org/x/net');
    expect(net).toMatchObject({ installed: 'v0.23.0', source: 'inherited' });
    expect(isUpdatable(net)).toBe(false);

    expect(findDep(parsed.dependencies, 'github.com/pkg/errors')).toMatchObject(
      {
        registryName: 'github.com/fork/errors',
        installed: 'v0.9.2',
      },
    );

    const local = findDep(parsed.dependencies, 'example.com/local');
    expect(local.source).toBe('path');
    expect(local.installed).toBeUndefined();
  });

  it('keeps GOPRIVATE modules away from the proxy and OSV', async () => {
    process.env.GOPRIVATE = 'git.corp.example.com';
    const parsed = await new GoProvider().parse(
      '/p/go.mod',
      goMod,
      makeContext(),
    );

    const lib = findDep(parsed.dependencies, 'git.corp.example.com/team/lib');
    expect(lib.source).toBe('private');
    expect(isRegistryPackage(lib)).toBe(false);
    expect(
      findDep(parsed.dependencies, 'github.com/pkg/errors').source,
    ).not.toBe('private');
  });
});
