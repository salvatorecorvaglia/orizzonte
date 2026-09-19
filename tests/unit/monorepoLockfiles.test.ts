/**
 * Workspace members resolve the lockfile that actually governs them.
 *
 * In a pnpm/npm/yarn/Cargo/uv workspace only the root carries a lockfile, so
 * looking in the member's own directory — which is all this used to do — found
 * nothing for every package in every monorepo. The visible damage was four
 * features at once: resolved versions degraded to guesses derived from the
 * declared constraint, advisories were then matched against those guesses, and
 * both the duplicate-version and branch-diff checks reported "no lockfile to
 * check" for exactly the layout they are most useful in.
 */

import { describe, expect, it } from 'vitest';
import { findDuplicateVersions } from '../../src/core/depGraph.js';
import { CargoProvider } from '../../src/providers/cargo/index.js';
import { ComposerProvider } from '../../src/providers/composer/index.js';
import { NodeProvider } from '../../src/providers/node/index.js';
import { PythonProvider } from '../../src/providers/python/index.js';
import { makeContext } from './helpers.js';

const nodeProvider = new NodeProvider();
const cargoProvider = new CargoProvider();
const pythonProvider = new PythonProvider();
const composerProvider = new ComposerProvider();

const ROOT = '/ws';
const MEMBER = '/ws/packages/web';

describe('lockfile resolution across a workspace', () => {
  it('reads the root pnpm lockfile for a member that has none', async () => {
    const ctx = makeContext(
      {
        '/ws/pnpm-lock.yaml': `
lockfileVersion: '9.0'
packages:
  semver@7.8.5: {}
`,
      },
      ROOT,
    );

    const resolved = await nodeProvider.readLockfile(MEMBER, ctx);
    expect(resolved.get('semver')).toBe('7.8.5');
  });

  it("prefers a member's own lockfile over the root's", async () => {
    const ctx = makeContext(
      {
        '/ws/pnpm-lock.yaml': `
lockfileVersion: '9.0'
packages:
  semver@7.8.5: {}
`,
        '/ws/packages/web/package-lock.json': JSON.stringify({
          packages: { 'node_modules/semver': { version: '6.0.0' } },
        }),
      },
      ROOT,
    );

    const resolved = await nodeProvider.readLockfile(MEMBER, ctx);
    expect(resolved.get('semver')).toBe('6.0.0');
  });

  it('does not read a lockfile from outside the workspace folder', async () => {
    const ctx = makeContext(
      {
        '/pnpm-lock.yaml': `
lockfileVersion: '9.0'
packages:
  semver@1.0.0: {}
`,
      },
      ROOT,
    );

    expect((await nodeProvider.readLockfile(MEMBER, ctx)).size).toBe(0);
  });

  it('falls through a corrupt lockfile to a healthy one beside it', async () => {
    const ctx = makeContext(
      {
        '/ws/package-lock.json': '{ this is not json',
        '/ws/pnpm-lock.yaml': `
lockfileVersion: '9.0'
packages:
  semver@7.8.5: {}
`,
      },
      ROOT,
    );

    const resolved = await nodeProvider.readLockfile(MEMBER, ctx);
    expect(resolved.get('semver')).toBe('7.8.5');
  });

  it('reads the root Cargo.lock for a workspace member crate', async () => {
    const ctx = makeContext(
      {
        '/ws/Cargo.lock': `
[[package]]
name = "tokio"
version = "1.35.1"
`,
      },
      ROOT,
    );

    const resolved = await cargoProvider.readLockfile('/ws/crates/api', ctx);
    expect(resolved.get('tokio')).toBe('1.35.1');
  });

  it('reads the root uv.lock for a member project', async () => {
    const ctx = makeContext(
      {
        '/ws/uv.lock': `
[[package]]
name = "Flask"
version = "3.0.0"
`,
      },
      ROOT,
    );

    const resolved = await pythonProvider.readLockfile('/ws/apps/api', ctx);
    // PEP 503 normalisation still applies to whatever the lockfile spells.
    expect(resolved.get('flask')).toBe('3.0.0');
  });

  it('reads the root composer.lock for a nested project', async () => {
    const ctx = makeContext(
      {
        '/ws/composer.lock': JSON.stringify({
          packages: [{ name: 'monolog/monolog', version: 'v3.5.0' }],
        }),
      },
      ROOT,
    );

    const resolved = await composerProvider.readLockfile('/ws/src/app', ctx);
    expect(resolved.get('monolog/monolog')).toBe('3.5.0');
  });

  it('reads the shared root lockfile once for the whole workspace', async () => {
    const ctx = makeContext(
      {
        '/ws/pnpm-lock.yaml': `
lockfileVersion: '9.0'
packages:
  semver@7.8.5: {}
`,
      },
      ROOT,
    );

    // Now that every member resolves the *same* file, doing so naively would
    // read and parse one multi-megabyte lockfile once per member.
    const reads: string[] = [];
    const counted = {
      ...ctx,
      readFile: (absolutePath: string) => {
        reads.push(absolutePath.replace(/\\/g, '/'));
        return ctx.readFile(absolutePath);
      },
      lockfileMemo: new Map<string, unknown>(),
    };

    for (const member of [
      '/ws/packages/a',
      '/ws/packages/b',
      '/ws/packages/c',
    ]) {
      const resolved = await nodeProvider.readLockfile(member, counted);
      expect(resolved.get('semver')).toBe('7.8.5');
    }

    // The file all three members share is read once, not once per member.
    expect(
      reads.filter((at) => at.endsWith('/ws/pnpm-lock.yaml')),
    ).toHaveLength(1);
    // So are the shared directories they walk through on the way up; only each
    // member's own directory is probed separately.
    expect(
      reads.filter((at) => at.startsWith('/ws/packages/package-lock')),
    ).toHaveLength(1);
  });

  it('checks a member for duplicate versions instead of reporting it unchecked', async () => {
    const ctx = makeContext(
      {
        '/ws/pnpm-lock.yaml': `
lockfileVersion: '9.0'
packages:
  semver@6.3.1: {}
  semver@7.8.5: {}
`,
      },
      ROOT,
    );

    const result = await findDuplicateVersions(
      '/ws/packages/web/package.json',
      'node',
      ctx,
    );

    // The regression this guards: `checked: false` here meant the panel told
    // the user the project had no lockfile it could inspect.
    expect(result.checked).toBe(true);
    expect(result.groups).toEqual([
      { name: 'semver', versions: ['6.3.1', '7.8.5'] },
    ]);
  });
});
