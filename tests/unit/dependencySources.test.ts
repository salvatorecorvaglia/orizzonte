/**
 * Dependencies that are not registry packages.
 *
 * `workspace:*`, `file:`, git and tarball specifiers share a *name* with
 * whatever the public registry holds under it, and nothing else. They used to
 * be looked up, audited and offered "Update" like any other row — and updating
 * a `workspace:*` sibling ran `pnpm add @acme/utils@^x`, replacing the local
 * package with a public one of the same name.
 */

import { describe, expect, it, vi } from 'vitest';
import { auditDependencies } from '../../src/core/audit.js';
import type { HttpClient } from '../../src/core/http.js';
import type {
  Dependency,
  ProjectGroup,
  Toolchain,
} from '../../src/core/types.js';
import { registryConstraint } from '../../src/core/versions/index.js';
import {
  isRegistryPackage,
  isUpdatable,
  registryNameOf,
} from '../../src/core/vocabulary.js';
import {
  classifyNodeSpecifier,
  NodeProvider,
} from '../../src/providers/node/index.js';
import { findDep, makeContext } from './helpers.js';

const node = new NodeProvider();
const pnpm: Toolchain = { id: 'pnpm', ecosystem: 'node', cwd: '/p' };

describe('classifyNodeSpecifier', () => {
  it.each([
    ['^1.2.3', 'registry'],
    ['latest', 'registry'],
    ['>=1 <2', 'registry'],
    ['workspace:*', 'workspace'],
    ['workspace:^1.0.0', 'workspace'],
    ['file:../utils', 'path'],
    ['link:../utils', 'path'],
    ['./vendor/pkg', 'path'],
    ['git+https://github.com/a/b.git', 'git'],
    ['git+ssh://git@github.com/a/b.git#v1', 'git'],
    ['github:a/b', 'git'],
    ['a/b#main', 'git'],
    ['https://example.com/pkg.tgz', 'url'],
    ['catalog:', 'inherited'],
    ['catalog:react18', 'inherited'],
    ['npm:string-width@^4.2.0', 'alias'],
  ])('%s is %s', (spec, source) => {
    expect(classifyNodeSpecifier(spec).source).toBe(source);
  });

  it('names the real package behind an npm alias, scoped or not', () => {
    expect(classifyNodeSpecifier('npm:string-width@^4.2.0').registryName).toBe(
      'string-width',
    );
    expect(classifyNodeSpecifier('npm:@scope/real@1.0.0').registryName).toBe(
      '@scope/real',
    );
  });
});

describe('registryConstraint', () => {
  it('extracts the range from an npm alias', () => {
    expect(registryConstraint('npm:string-width@^4.2.0')).toBe('^4.2.0');
    expect(registryConstraint('npm:@scope/real@~1.0.0')).toBe('~1.0.0');
    expect(registryConstraint('npm:real')).toBe('*');
    expect(registryConstraint('^1.0.0')).toBe('^1.0.0');
  });
});

describe('NodeProvider and dependency sources', () => {
  const manifest = JSON.stringify({
    dependencies: {
      react: '^18.2.0',
      '@acme/utils': 'workspace:*',
      local: 'file:../local',
      'strip-ansi-cjs': 'npm:strip-ansi@^6.0.1',
    },
  });

  it('records only non-default sources on the parsed rows', async () => {
    const parsed = await node.parse('/p/package.json', manifest, makeContext());

    expect(findDep(parsed.dependencies, 'react').source).toBeUndefined();
    expect(findDep(parsed.dependencies, '@acme/utils').source).toBe(
      'workspace',
    );
    expect(findDep(parsed.dependencies, 'local').source).toBe('path');
    expect(findDep(parsed.dependencies, 'strip-ansi-cjs')).toMatchObject({
      source: 'alias',
      registryName: 'strip-ansi',
    });
  });

  it('refuses to update a workspace or path dependency', async () => {
    const parsed = await node.parse('/p/package.json', manifest, makeContext());

    expect(
      node.updateCommand(
        pnpm,
        findDep(parsed.dependencies, '@acme/utils'),
        '9.9.9',
      ),
    ).toBeNull();
    expect(
      node.updateCommand(pnpm, findDep(parsed.dependencies, 'local'), '1.0.0'),
    ).toBeNull();
  });

  it('updates an alias in place, keeping the alias and its range operator', async () => {
    const parsed = await node.parse('/p/package.json', manifest, makeContext());

    expect(
      node.updateCommand(
        pnpm,
        findDep(parsed.dependencies, 'strip-ansi-cjs'),
        '6.0.2',
      )?.argv,
    ).toEqual(['pnpm', 'add', 'strip-ansi-cjs@npm:strip-ansi@^6.0.2']);
  });

  it('rejects a package name that would read as a flag', () => {
    expect(node.isValidPackageName('--global')).toBe(false);
    expect(node.isValidPackageName('-g')).toBe(false);
    expect(node.isValidPackageName('@-scope/pkg')).toBe(false);
    expect(node.isValidPackageName('left-pad')).toBe(true);
    expect(node.isValidPackageName('@types/node')).toBe(true);
  });
});

describe('source helpers', () => {
  it('treats aliases and inherited versions as registry packages', () => {
    expect(isRegistryPackage({})).toBe(true);
    expect(isRegistryPackage({ source: 'alias' })).toBe(true);
    expect(isRegistryPackage({ source: 'inherited' })).toBe(true);
    expect(isRegistryPackage({ source: 'workspace' })).toBe(false);
    expect(isRegistryPackage({ source: 'git' })).toBe(false);
  });

  it('only lets a directly declared registry version be rewritten', () => {
    expect(isUpdatable({})).toBe(true);
    expect(isUpdatable({ source: 'alias' })).toBe(true);
    expect(isUpdatable({ source: 'inherited' })).toBe(false);
    expect(isUpdatable({ source: 'path' })).toBe(false);
  });

  it('looks packages up by their registry name', () => {
    expect(registryNameOf({ name: 'foo' })).toBe('foo');
    expect(registryNameOf({ name: 'foo', registryName: 'bar' })).toBe('bar');
  });
});

describe('auditDependencies and dependency sources', () => {
  function dep(overrides: Partial<Dependency>): Dependency {
    return {
      key: `k-${overrides.name}`,
      name: 'x',
      ecosystem: 'node',
      scope: 'prod',
      declared: '1.0.0',
      installed: '1.0.0',
      updateKind: 'unknown',
      vulnerabilities: [],
      manifestPath: '/p/package.json',
      projectLabel: 'p',
      ...overrides,
    };
  }

  it('never sends a workspace package to OSV, and queries an alias by its real name', async () => {
    const postJson = vi.fn().mockResolvedValue({ results: [{}] });
    const ctx = {
      ...makeContext(),
      http: { postJson } as unknown as HttpClient,
    };
    const group: ProjectGroup = {
      label: 'p',
      manifestPath: '/p/package.json',
      ecosystem: 'node',
      toolchain: 'pnpm',
      dependencies: [
        dep({ name: '@acme/internal', source: 'workspace' }),
        dep({
          name: 'strip-ansi-cjs',
          source: 'alias',
          registryName: 'strip-ansi',
        }),
      ],
    };

    await auditDependencies([group], ctx);

    expect(postJson).toHaveBeenCalledTimes(1);
    const body = postJson.mock.calls[0][1] as {
      queries: Array<{ package: { name: string } }>;
    };
    expect(body.queries.map((query) => query.package.name)).toEqual([
      'strip-ansi',
    ]);
  });
});
