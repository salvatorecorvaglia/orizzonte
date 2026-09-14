/**
 * `watcher.ts` imports `vscode`, so — like the other files in this
 * directory — it cannot be loaded under vitest and can only be exercised
 * here.
 *
 * `isExcluded` is exported solely so it can be tested directly rather than
 * indirectly through real filesystem watcher events, which would make this
 * suite depend on OS-level file-change latency.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { isExcluded } from '../../src/core/watcher.js';

describe('isExcluded', () => {
  const config = vscode.workspace.getConfiguration('orizzonte');

  afterEach(async () => {
    await config.update(
      'excludeGlobs',
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  });

  it('excludes a path running through a watched directory', async () => {
    await config.update(
      'excludeGlobs',
      ['**/node_modules/**'],
      vscode.ConfigurationTarget.Workspace,
    );

    const uri = vscode.Uri.file('/repo/node_modules/some-pkg/package.json');
    assert.equal(isExcluded(uri), true);
  });

  it('does not exclude a path outside every watched directory', async () => {
    await config.update(
      'excludeGlobs',
      ['**/node_modules/**'],
      vscode.ConfigurationTarget.Workspace,
    );

    const uri = vscode.Uri.file('/repo/packages/app/package.json');
    assert.equal(isExcluded(uri), false);
  });

  it('does not exclude a path when the glob is not the exact **/dir/** shape', async () => {
    // The documented limitation: only the exact `**/dir/**` shape is
    // fast-path matched here. Anything else — a suffix glob, a single-star
    // pattern, a directory pattern with no trailing `/**` — is left alone
    // rather than partially honoured.
    await config.update(
      'excludeGlobs',
      ['src/**', '**/*.test.js', '**/dist', '**/*.log'],
      vscode.ConfigurationTarget.Workspace,
    );

    // None of these should ever be treated as excluded by the fast path, even
    // though a real glob engine would match some of them.
    assert.equal(
      isExcluded(vscode.Uri.file('/repo/src/index.ts')),
      false,
      '"src/**" is not the "**/dir/**" shape',
    );
    assert.equal(
      isExcluded(vscode.Uri.file('/repo/dist/index.js')),
      false,
      '"**/dist" (no trailing /**) is not the "**/dir/**" shape',
    );
  });

  it('has no watched directories when excludeGlobs is empty', async () => {
    await config.update(
      'excludeGlobs',
      [],
      vscode.ConfigurationTarget.Workspace,
    );

    assert.equal(
      isExcluded(vscode.Uri.file('/repo/node_modules/pkg/package.json')),
      false,
    );
  });
});
