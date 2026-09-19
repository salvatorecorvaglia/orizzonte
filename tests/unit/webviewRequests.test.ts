/**
 * The host's trust boundary: what it accepts from the webview before acting.
 *
 * These decisions used to live inside `PanelManager`, which imports `vscode`
 * and so could only be exercised through a full integration run — which is why
 * the one part of that file most worth testing directly was the part hardest
 * to reach.
 */

import { describe, expect, it } from 'vitest';
import type { Dependency, ProjectGroup } from '../../src/core/types.js';
import {
  findDependency,
  indexInstalledPackages,
  isKnownManifest,
  resolveBulkUninstallTargets,
  resolveBulkUpdateTargets,
} from '../../src/core/webviewRequests.js';

function dep(overrides: Partial<Dependency> = {}): Dependency {
  return {
    key: '/p/package.json::prod::lodash',
    name: 'lodash',
    ecosystem: 'node',
    scope: 'prod',
    declared: '^4.0.0',
    installed: '4.17.21',
    updateKind: 'minor',
    vulnerabilities: [],
    manifestPath: '/p/package.json',
    projectLabel: 'app',
    ...overrides,
  };
}

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    label: 'app',
    manifestPath: '/p/package.json',
    ecosystem: 'node',
    toolchain: 'npm',
    dependencies: [dep()],
    ...overrides,
  };
}

describe('isKnownManifest', () => {
  it('accepts a manifest the scan found', () => {
    const scan = { groups: [group()], manifestPaths: ['/p/package.json'] };
    expect(isKnownManifest(scan, '/p/package.json')).toBe(true);
  });

  it('refuses a path the scan never saw', () => {
    const scan = { groups: [group()], manifestPaths: ['/p/package.json'] };
    // The path becomes a command's cwd and a file the editor opens, so an
    // unrecognised one is refused rather than acted on.
    expect(isKnownManifest(scan, '/etc/passwd')).toBe(false);
    expect(isKnownManifest(scan, '/p/../p/package.json')).toBe(false);
    expect(isKnownManifest(scan, '')).toBe(false);
  });

  it('accepts a dependency-free workspace root', () => {
    /*
     * A root declaring members but no dependencies of its own has no rows to
     * show, so it never becomes a group. Gating on `groups` made it the one
     * manifest in the workspace nothing could be installed into.
     */
    const scan = {
      groups: [group({ manifestPath: '/p/packages/web/package.json' })],
      manifestPaths: ['/p/package.json', '/p/packages/web/package.json'],
    };
    expect(isKnownManifest(scan, '/p/package.json')).toBe(true);
  });
});

describe('findDependency', () => {
  it('finds a row by key across groups', () => {
    const other = dep({ key: 'other', name: 'chalk' });
    const scan = {
      groups: [
        group({ dependencies: [other] }),
        group({ manifestPath: '/q/package.json', dependencies: [dep()] }),
      ],
    };
    expect(findDependency(scan, 'other')?.dep.name).toBe('chalk');
    expect(findDependency(scan, dep().key)?.group.manifestPath).toBe(
      '/q/package.json',
    );
  });

  it('returns nothing for a key no row carries, and for no key at all', () => {
    const scan = { groups: [group()] };
    expect(findDependency(scan, 'ghost')).toBeUndefined();
    expect(findDependency(scan, undefined)).toBeUndefined();
  });
});

describe('indexInstalledPackages', () => {
  it('groups every location a package is declared in', () => {
    const index = indexInstalledPackages([
      group(),
      group({
        label: 'api',
        manifestPath: '/q/package.json',
        dependencies: [
          dep({
            key: 'q',
            manifestPath: '/q/package.json',
            declared: '~4.0.0',
          }),
        ],
      }),
    ]);

    expect(index.get('node::lodash')).toEqual([
      {
        manifestPath: '/p/package.json',
        projectLabel: 'app',
        declared: '^4.0.0',
        scope: 'prod',
      },
      {
        manifestPath: '/q/package.json',
        projectLabel: 'api',
        declared: '~4.0.0',
        scope: 'prod',
      },
    ]);
  });

  it('keys by ecosystem as well as name', () => {
    // `lodash` on npm and a same-named package elsewhere are different
    // packages, and offering "uninstall" for the wrong one would act on it.
    const index = indexInstalledPackages([
      group(),
      group({
        manifestPath: '/py/pyproject.toml',
        ecosystem: 'python',
        toolchain: 'pip',
        dependencies: [
          dep({
            key: 'py',
            ecosystem: 'python',
            manifestPath: '/py/pyproject.toml',
          }),
        ],
      }),
    ]);

    expect(index.get('node::lodash')).toHaveLength(1);
    expect(index.get('python::lodash')).toHaveLength(1);
  });
});

describe('resolveBulkUpdateTargets', () => {
  const scan = { groups: [group()] };
  const accept = () => true;

  it('drops rows the table no longer holds', () => {
    // An uninstall between selecting and confirming leaves a key matching
    // nothing; the host used to skip it silently after counting it.
    const resolved = resolveBulkUpdateTargets(
      scan,
      [
        { depKey: dep().key, toVersion: '4.18.0' },
        { depKey: 'removed-since', toVersion: '1.0.0' },
      ],
      accept,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].dep.name).toBe('lodash');
  });

  it('drops a version its provider will not accept', () => {
    const resolved = resolveBulkUpdateTargets(
      scan,
      [{ depKey: dep().key, toVersion: '1.0.0; rm -rf /' }],
      (_dep, version) => /^[\d.]+$/.test(version),
    );
    expect(resolved).toEqual([]);
  });

  it('filters before anything is confirmed, so the count is honest', () => {
    const resolved = resolveBulkUpdateTargets(
      scan,
      [
        { depKey: dep().key, toVersion: '4.18.0' },
        { depKey: 'ghost-a', toVersion: '1.0.0' },
        { depKey: 'ghost-b', toVersion: '1.0.0' },
      ],
      accept,
    );
    // Three asked for, one runnable — the dialog must say one.
    expect(resolved).toHaveLength(1);
  });
});

describe('resolveBulkUninstallTargets', () => {
  it('keeps only the rows that still exist', () => {
    const scan = { groups: [group()] };
    expect(
      resolveBulkUninstallTargets(scan, [dep().key, 'ghost']).map(
        (d) => d.name,
      ),
    ).toEqual(['lodash']);
  });
});
