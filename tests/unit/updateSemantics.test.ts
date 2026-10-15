/**
 * What an update writes, and what a workspace-wide check reports.
 *
 * Updates used to pin: `composer require vendor/pkg:1.2.3` over `^1.2`, `uv add
 * requests==2.32.3` over `>=2.28`. And every member of a workspace reported
 * its root lockfile's duplicates and diff again, so a fifty-package monorepo
 * showed the same findings fifty times.
 */

import { describe, expect, it } from 'vitest';
import {
  lockfilePathFor,
  mergeSharedLockfiles,
} from '../../src/core/depGraph.js';
import type { Dependency, Toolchain } from '../../src/core/types.js';
import { ComposerProvider } from '../../src/providers/composer/index.js';
import { NodeProvider } from '../../src/providers/node/index.js';
import { PythonProvider } from '../../src/providers/python/index.js';
import { makeContext } from './helpers.js';

function dep(overrides: Partial<Dependency>): Dependency {
  return {
    key: 'k',
    name: 'x',
    ecosystem: 'python',
    scope: 'prod',
    declared: '',
    updateKind: 'minor',
    vulnerabilities: [],
    manifestPath: '/p/pyproject.toml',
    projectLabel: 'p',
    ...overrides,
  };
}

describe('updates keep the declared operator', () => {
  const python = new PythonProvider();
  const uv: Toolchain = { id: 'uv', ecosystem: 'python', cwd: '/p' };
  const poetry: Toolchain = { id: 'poetry', ecosystem: 'python', cwd: '/p' };

  it.each([
    ['>=2.28', 'requests>=2.32.3'],
    ['~=2.28', 'requests~=2.32.3'],
    ['==2.28.0', 'requests==2.32.3'],
    // Moving the lower bound of a compound range could pass its upper bound.
    ['>=2,<3', 'requests==2.32.3'],
    ['', 'requests==2.32.3'],
  ])('uv: %s becomes %s', (declared, spec) => {
    expect(
      python.updateCommand(uv, dep({ name: 'requests', declared }), '2.32.3')
        ?.argv,
    ).toEqual(['uv', 'add', spec]);
  });

  it("keeps Poetry's caret and tilde for Poetry", () => {
    expect(
      python.updateCommand(
        poetry,
        dep({ name: 'httpx', declared: '^0.27' }),
        '0.28.1',
      )?.argv,
    ).toEqual(['poetry', 'add', 'httpx@^0.28.1']);
    expect(
      python.updateCommand(
        poetry,
        dep({ name: 'httpx', declared: '~0.27' }),
        '0.27.2',
      )?.argv,
    ).toEqual(['poetry', 'add', 'httpx@~0.27.2']);
  });

  it('keeps a >= floor in requirements.txt', () => {
    expect(
      python.editManifest(
        'flask>=2.0\n',
        { kind: 'update', name: 'flask', version: '3.0.3', scope: 'prod' },
        'requirements.txt',
      ),
    ).toBe('flask>=3.0.3\n');
  });

  it('keeps a Composer caret', () => {
    const composer = new ComposerProvider();
    expect(
      composer.updateCommand(
        { id: 'composer', ecosystem: 'composer', cwd: '/p' },
        dep({
          name: 'monolog/monolog',
          ecosystem: 'composer',
          declared: '^3.5',
        }),
        '3.7.0',
      )?.argv,
    ).toEqual(['composer', 'require', 'monolog/monolog:^3.7.0']);
  });
});

describe('bulk update reach', () => {
  it('re-resolves ranges in Yarn Berry rather than jumping to latest', () => {
    const command = new NodeProvider().updateAllCommand({
      id: 'yarn',
      ecosystem: 'node',
      cwd: '/p',
      yarnBerry: true,
    });
    expect(command).toMatchObject({
      argv: ['yarn', 'up', '-R', '*'],
      reach: 'ranges',
    });
  });
});

describe('mergeSharedLockfiles', () => {
  const results = [
    { manifestPath: '/ws/packages/a/package.json', projectLabel: 'a' },
    { manifestPath: '/ws/package.json', projectLabel: 'root' },
    { manifestPath: '/ws/packages/b/package.json', projectLabel: 'b' },
    { manifestPath: '/other/package.json', projectLabel: 'other' },
  ];
  const lockfiles: Record<string, string | undefined> = {
    '/ws/packages/a/package.json': '/ws/pnpm-lock.yaml',
    '/ws/package.json': '/ws/pnpm-lock.yaml',
    '/ws/packages/b/package.json': '/ws/pnpm-lock.yaml',
    '/other/package.json': undefined,
  };

  it('reports a shared lockfile once, under the project beside it', () => {
    const merged = mergeSharedLockfiles(
      results,
      (result) => lockfiles[result.manifestPath],
    );

    expect(merged.map((result) => result.projectLabel)).toEqual([
      'root and 2 other projects sharing pnpm-lock.yaml',
      'other',
    ]);
    expect(merged[0].manifestPath).toBe('/ws/package.json');
  });

  it('leaves a project with a lockfile of its own untouched', () => {
    const merged = mergeSharedLockfiles(
      [results[3]],
      () => '/other/package-lock.json',
    );
    expect(merged).toEqual([results[3]]);
  });
});

describe('lockfilePathFor', () => {
  it('names the root lockfile a member reads', async () => {
    const ctx = makeContext(
      {
        '/ws/pnpm-lock.yaml':
          "lockfileVersion: '9.0'\npackages:\n  a@1.0.0: {}\n",
      },
      '/ws',
    );

    const found = await lockfilePathFor(
      '/ws/packages/web',
      'node',
      (absolutePath) => ctx.readFile(absolutePath),
      '/ws',
    );

    expect(found?.replace(/\\/g, '/')).toBe('/ws/pnpm-lock.yaml');
  });
});
