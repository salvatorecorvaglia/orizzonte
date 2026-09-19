/**
 * Workspace detection: sidecar files and member attribution.
 *
 * The sidecar formats are the interesting part — a manifest never mentions
 * pnpm-workspace.yaml, go.work or settings.gradle, so nothing else in the scan
 * would notice a missed member.
 */

import { describe, expect, it } from 'vitest';
import type { ParsedManifest } from '../../src/core/types.js';
import {
  assignWorkspaces,
  globMatchesPath,
  readSidecarMembers,
} from '../../src/core/workspaces.js';
import { makeContext } from './helpers.js';

function manifest(overrides: Partial<ParsedManifest> = {}): ParsedManifest {
  return {
    ecosystem: 'node',
    path: '/repo/package.json',
    name: 'root',
    dependencies: [],
    ...overrides,
  };
}

describe('glob matching', () => {
  it('matches single-segment stars within one level only', () => {
    expect(globMatchesPath('packages/*', 'packages/web')).toBe(true);
    expect(globMatchesPath('packages/*', 'packages/web/nested')).toBe(false);
  });

  it('matches globstars across levels, including the base itself', () => {
    expect(globMatchesPath('apps/**', 'apps/web')).toBe(true);
    expect(globMatchesPath('apps/**', 'apps/web/deep/deeper')).toBe(true);
    expect(globMatchesPath('apps/**', 'apps')).toBe(true);
    expect(globMatchesPath('apps/**', 'services/api')).toBe(false);
  });

  it('matches literal paths exactly', () => {
    expect(globMatchesPath('packages/web', 'packages/web')).toBe(true);
    expect(globMatchesPath('packages/web', 'packages/api')).toBe(false);
  });

  it('normalises leading ./ and trailing slashes', () => {
    expect(globMatchesPath('./packages/*', 'packages/web')).toBe(true);
    expect(globMatchesPath('packages/*/', 'packages/web')).toBe(true);
  });

  it('treats negations as non-matching rather than guessing', () => {
    expect(globMatchesPath('!packages/legacy', 'packages/legacy')).toBe(false);
  });
});

describe('pnpm-workspace.yaml', () => {
  it('reads the packages list', async () => {
    const ctx = makeContext({
      '/repo/pnpm-workspace.yaml': `packages:
  - 'packages/*'
  - 'apps/**'
  - '!**/test/**'
`,
    });

    const members = await readSidecarMembers(manifest(), ctx);
    expect(members).toEqual(['packages/*', 'apps/**', '!**/test/**']);
  });

  it('returns nothing for a malformed file instead of throwing', async () => {
    const ctx = makeContext({
      '/repo/pnpm-workspace.yaml': 'packages: [unclosed',
    });
    await expect(readSidecarMembers(manifest(), ctx)).resolves.toEqual([]);
  });
});

describe('go.work', () => {
  it('reads a use block and single-line use directives', async () => {
    const ctx = makeContext({
      '/repo/go.work': `go 1.22

use (
	./cmd/api
	./internal/shared // a comment
)

use ./tools
`,
    });

    const members = await readSidecarMembers(
      manifest({ ecosystem: 'golang', path: '/repo/go.mod' }),
      ctx,
    );
    expect(members).toEqual(['./cmd/api', './internal/shared', './tools']);
  });
});

describe('settings.gradle', () => {
  it('converts Gradle project paths to directories', async () => {
    const ctx = makeContext({
      '/repo/settings.gradle': `rootProject.name = 'demo'
include ':app', ':core:data'
// include ':commented'
include ':libs:ui'
`,
    });

    const members = await readSidecarMembers(
      manifest({ ecosystem: 'gradle', path: '/repo/build.gradle' }),
      ctx,
    );
    expect(members).toEqual(['app', 'core/data', 'libs/ui']);
  });

  it('reads the Kotlin DSL variant', async () => {
    const ctx = makeContext({
      '/repo/settings.gradle.kts': `include("app", "core")`,
    });

    const members = await readSidecarMembers(
      manifest({ ecosystem: 'gradle', path: '/repo/build.gradle.kts' }),
      ctx,
    );
    expect(members).toEqual(['app', 'core']);
  });
});

describe('member attribution', () => {
  it('marks the root and attributes members beneath it', () => {
    const assignments = assignWorkspaces([
      {
        manifest: manifest({ path: '/repo/package.json' }),
        members: ['packages/*'],
      },
      {
        manifest: manifest({ path: '/repo/packages/web/package.json' }),
        members: [],
      },
      {
        manifest: manifest({ path: '/repo/packages/api/package.json' }),
        members: [],
      },
      {
        manifest: manifest({ path: '/repo/unrelated/package.json' }),
        members: [],
      },
    ]);

    expect(assignments.get('/repo/package.json')?.isRoot).toBe(true);
    expect(assignments.get('/repo/packages/web/package.json')?.rootPath).toBe(
      '/repo/package.json',
    );
    expect(assignments.get('/repo/packages/api/package.json')?.rootPath).toBe(
      '/repo/package.json',
    );
    // Outside the member glob, so not part of the workspace.
    expect(
      assignments.get('/repo/unrelated/package.json')?.rootPath,
    ).toBeUndefined();
  });

  it('does not attribute across ecosystems', () => {
    const assignments = assignWorkspaces([
      {
        manifest: manifest({ path: '/repo/package.json' }),
        members: ['packages/*'],
      },
      {
        manifest: manifest({
          ecosystem: 'cargo',
          path: '/repo/packages/rust/Cargo.toml',
        }),
        members: [],
      },
    ]);

    // A Cargo crate inside a JS workspace glob is still its own project.
    expect(
      assignments.get('/repo/packages/rust/Cargo.toml')?.rootPath,
    ).toBeUndefined();
  });

  it('prefers the nearest root when workspaces nest', () => {
    const assignments = assignWorkspaces([
      { manifest: manifest({ path: '/repo/package.json' }), members: ['**'] },
      {
        manifest: manifest({ path: '/repo/inner/package.json' }),
        members: ['pkg/*'],
      },
      {
        manifest: manifest({ path: '/repo/inner/pkg/a/package.json' }),
        members: [],
      },
    ]);

    expect(assignments.get('/repo/inner/pkg/a/package.json')?.rootPath).toBe(
      '/repo/inner/package.json',
    );
  });

  it('never attributes a manifest to itself', () => {
    const assignments = assignWorkspaces([
      { manifest: manifest({ path: '/repo/package.json' }), members: ['**'] },
    ]);
    expect(assignments.get('/repo/package.json')?.rootPath).toBeUndefined();
    expect(assignments.get('/repo/package.json')?.isRoot).toBe(true);
  });
});
