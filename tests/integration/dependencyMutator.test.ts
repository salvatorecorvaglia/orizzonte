/**
 * `dependencyMutator.ts` imports `vscode`, so — like `terminalRunner.ts` and
 * `webviewSecurity.ts` — it cannot be loaded under vitest at all (see the
 * exclusion list in `vitest.config.ts`) and can only be exercised here.
 *
 * `MavenProvider` is used throughout: its install/update/uninstall commands
 * are always `null` (Maven has no `add`/`remove` CLI worth using — see its
 * own header comment), so every path here goes straight through
 * `applyManifestEdit` without needing a real `mvn` on the test host.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Memento, TtlCache } from '../../src/core/cache.js';
import { HttpClient } from '../../src/core/http.js';
import type { Dependency } from '../../src/core/types.js';
import { createProviderContext } from '../../src/core/workspace.js';
import { GradleProvider } from '../../src/providers/gradle/index.js';
import { MavenProvider } from '../../src/providers/maven/index.js';
import { DependencyMutator } from '../../src/ui/dependencyMutator.js';
import { TerminalRunner } from '../../src/ui/terminalRunner.js';

class MapMemento implements Memento {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <groupId>com.acme</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
  </dependencies>
</project>
`;

const provider = new MavenProvider();

function guavaDep(manifestPath: string): Dependency {
  return {
    key: 'k',
    name: 'com.google.guava:guava',
    ecosystem: 'maven',
    scope: 'prod',
    declared: '33.0.0-jre',
    installed: '33.0.0-jre',
    updateKind: 'minor',
    vulnerabilities: [],
    manifestPath,
    projectLabel: 'demo',
  };
}

describe('DependencyMutator', () => {
  let tmpDir: string;
  let pomPath: string;
  let mutator: DependencyMutator;
  let terminal: TerminalRunner;
  let failures: string[];

  beforeEach(async () => {
    tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'orizzonte-mutator-')),
    );
    pomPath = path.join(tmpDir, 'pom.xml');
    await fs.writeFile(pomPath, POM, 'utf8');

    const http = new HttpClient('0.0.0-test');
    const cache = new TtlCache(new MapMemento());
    const ctx = createProviderContext(http, cache);
    terminal = new TerminalRunner();
    failures = [];
    mutator = new DependencyMutator(
      ctx,
      terminal,
      // The busy claim is the panel's concern; this suite only cares that the
      // mutator releases whatever it takes.
      () => () => undefined,
      (message) => failures.push(message),
    );
  });

  afterEach(async () => {
    terminal.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rewrites the version in place and saves the file to disk', async () => {
    const applied = await mutator.update(
      guavaDep(pomPath),
      provider,
      '33.1.0-jre',
    );
    assert.equal(applied, true);
    assert.deepEqual(failures, []);

    const onDisk = await fs.readFile(pomPath, 'utf8');
    assert.match(onDisk, /<version>33\.1\.0-jre<\/version>/);
    assert.doesNotMatch(onDisk, /33\.0\.0-jre/);
  });

  it('does not force-save a document that already had unrelated unsaved edits', async () => {
    const uri = vscode.Uri.file(pomPath);
    const document = await vscode.workspace.openTextDocument(uri);

    const priorEdit = new vscode.WorkspaceEdit();
    priorEdit.insert(
      uri,
      new vscode.Position(0, 0),
      '<!-- work in progress -->\n',
    );
    assert.ok(await vscode.workspace.applyEdit(priorEdit));
    assert.equal(document.isDirty, true);

    try {
      const applied = await mutator.update(
        guavaDep(pomPath),
        provider,
        '33.1.0-jre',
      );
      assert.equal(applied, true);

      // The live buffer carries both changes...
      assert.match(document.getText(), /33\.1\.0-jre/);
      assert.match(document.getText(), /work in progress/);
      // ...but auto-save was skipped because the document was already dirty
      // with content the mutator did not write and should not silently
      // commit on the user's behalf.
      assert.equal(document.isDirty, true);

      // The on-disk copy must therefore still be the original, unedited pom.
      const onDisk = await fs.readFile(pomPath, 'utf8');
      assert.doesNotMatch(onDisk, /33\.1\.0-jre/);
    } finally {
      // Leave no dirty editor behind for whatever runs next in this window.
      const revert = new vscode.WorkspaceEdit();
      revert.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), POM);
      await vscode.workspace.applyEdit(revert);
      await document.save();
    }
  });

  it('opens the manifest instead of guessing when editManifest cannot apply the edit', async () => {
    // Gradle build scripts can't be safely added to — see its own
    // editManifest comment — so `install` has nothing to run and nothing to
    // rewrite, and must report failure rather than silently doing nothing.
    const gradlePath = path.join(tmpDir, 'build.gradle');
    await fs.writeFile(gradlePath, 'dependencies {}\n', 'utf8');

    const applied = await mutator.install(
      new GradleProvider(),
      gradlePath,
      'com.google.guava:guava',
      '33.1.0-jre',
      'prod',
    );
    assert.equal(applied, false);
  });
});
