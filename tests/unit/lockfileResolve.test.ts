/**
 * The upward lockfile walk.
 *
 * Paths are built with `path.join` throughout rather than written as literals,
 * because this suite runs on Windows in CI and the walk is entirely about path
 * separators and root detection.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLockfile } from '../../src/core/lockfiles/resolve.js';

const NPM = { file: 'package-lock.json' };
const PNPM = { file: 'pnpm-lock.yaml' };
const YARN = { file: 'yarn.lock' };

/** A reader over an in-memory tree, keyed by normalised absolute path. */
function reader(files: Record<string, string>) {
  const normalize = (p: string) => path.resolve(p).replace(/\\/g, '/');
  const store = new Map(
    Object.entries(files).map(([key, value]) => [normalize(key), value]),
  );
  return (absolutePath: string) =>
    Promise.resolve(store.get(normalize(absolutePath)));
}

const root = path.resolve(path.sep, 'ws');
const member = path.join(root, 'packages', 'web');

describe('findLockfile', () => {
  it('finds a lockfile in the starting directory', async () => {
    const found = await findLockfile(
      root,
      [NPM],
      reader({ [path.join(root, 'package-lock.json')]: '{}' }),
      root,
    );

    expect(found?.path).toBe(path.join(root, 'package-lock.json'));
    expect(found?.text).toBe('{}');
    expect(found?.candidate).toBe(NPM);
  });

  it('walks up to the workspace root for a member with no lockfile', async () => {
    const found = await findLockfile(
      member,
      [NPM, PNPM, YARN],
      reader({ [path.join(root, 'pnpm-lock.yaml')]: 'lockfileVersion: 9' }),
      root,
    );

    expect(found?.path).toBe(path.join(root, 'pnpm-lock.yaml'));
    expect(found?.candidate).toBe(PNPM);
  });

  it("prefers a member's own lockfile over the root's", async () => {
    const found = await findLockfile(
      member,
      [NPM, PNPM],
      reader({
        [path.join(member, 'package-lock.json')]: '{"member":true}',
        [path.join(root, 'pnpm-lock.yaml')]: 'lockfileVersion: 9',
      }),
      root,
    );

    expect(found?.path).toBe(path.join(member, 'package-lock.json'));
  });

  it('uses candidate order to break a tie within one directory', async () => {
    const files = {
      [path.join(root, 'package-lock.json')]: '{}',
      [path.join(root, 'yarn.lock')]: '# yarn',
    };

    expect(
      (await findLockfile(root, [NPM, YARN], reader(files), root))?.candidate,
    ).toBe(NPM);
    expect(
      (await findLockfile(root, [YARN, NPM], reader(files), root))?.candidate,
    ).toBe(YARN);
  });

  it('stops at the workspace boundary rather than escaping it', async () => {
    const outside = path.join(path.dirname(root), 'package-lock.json');

    const found = await findLockfile(
      member,
      [NPM],
      reader({ [outside]: '{"escaped":true}' }),
      root,
    );

    expect(found).toBeUndefined();
  });

  it('refuses to search from a directory outside the boundary', async () => {
    const elsewhere = path.join(path.dirname(root), 'other');

    const found = await findLockfile(
      elsewhere,
      [NPM],
      reader({ [path.join(elsewhere, 'package-lock.json')]: '{}' }),
      root,
    );

    expect(found).toBeUndefined();
  });

  it('terminates at the filesystem root when given no boundary', async () => {
    const found = await findLockfile(member, [NPM], reader({}));
    expect(found).toBeUndefined();
  });

  it('treats an empty lockfile as absent and keeps walking', async () => {
    const found = await findLockfile(
      member,
      [NPM],
      reader({
        [path.join(member, 'package-lock.json')]: '',
        [path.join(root, 'package-lock.json')]: '{"root":true}',
      }),
      root,
    );

    expect(found?.path).toBe(path.join(root, 'package-lock.json'));
  });

  it('returns undefined when there are no candidates', async () => {
    expect(await findLockfile(member, [], reader({}), root)).toBeUndefined();
  });
});
