/**
 * `.gitignore`-driven exclusion (`Scanner.gitignoreExcludes`) is private and
 * reads real files through `vscode.workspace`, so it can only be exercised
 * end to end, through a real scan in the fixture workspace.
 *
 * `tests/fixtures/.gitignore` and `tests/fixtures/gitignore-test/**` exist
 * solely to give this file something to assert against.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { OrizzonteApi } from '../../src/extension.js';

const EXTENSION_ID = 'orizzonte.orizzonte-vscode';

async function getApi(): Promise<OrizzonteApi> {
  const extension = vscode.extensions.getExtension<OrizzonteApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not found`);
  return extension.activate();
}

describe('.gitignore exclusion', () => {
  it('excludes a plain directory line, ignores a negation, and does not choke on a glob line', async () => {
    const api = await getApi();
    const result = await api.scan({ checkUpdates: false });

    const manifestPaths = result.groups.map((group) =>
      group.manifestPath.replaceAll('\\', '/'),
    );

    assert.ok(
      !manifestPaths.some((p) => p.includes('gitignore-test/ignored-pkg')),
      'a literal .gitignore directory entry should have excluded ignored-pkg',
    );
    assert.ok(
      manifestPaths.some((p) => p.includes('gitignore-test/kept-pkg')),
      'a negation line is skipped rather than honoured, so kept-pkg must still be scanned',
    );
  });

  it('is not derailed by an entry containing a brace-pattern metacharacter', async () => {
    /*
     * `.gitignore` carries a `gitignore-test/od,d-name` entry. The excludes are
     * joined into `{a,b,c}` before being handed to `findFiles`, so an unescaped
     * comma would split that group and corrupt every exclude beside it. The
     * assertion is that the *other* excludes still work.
     */
    const api = await getApi();
    const result = await api.scan({ checkUpdates: false });
    const manifestPaths = result.groups.map((group) =>
      group.manifestPath.replaceAll('\\', '/'),
    );

    assert.ok(
      !manifestPaths.some((p) => p.includes('gitignore-test/ignored-pkg')),
      'a comma-bearing entry must not break the excludes alongside it',
    );
    assert.ok(
      manifestPaths.some((p) => p.includes('node-app')),
      'the scan must still find the ordinary fixture projects',
    );
  });
});
