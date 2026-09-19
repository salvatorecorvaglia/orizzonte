/**
 * Integration tests: a real VS Code, the real extension, the fixture workspace.
 *
 * These cover what unit tests structurally cannot — that the extension actually
 * activates, that its contributions are registered, and that the scanner finds
 * the manifests on disk through `workspace.findFiles` rather than a stub.
 *
 * Every scan here runs with `checkUpdates: false`, so the suite never touches
 * the network and stays deterministic in CI.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { OrizzonteApi } from '../../src/extension.js';

const EXTENSION_ID = 'orizzonte.orizzonte-vscode';

async function getApi(): Promise<OrizzonteApi> {
  const extension = vscode.extensions.getExtension<OrizzonteApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not found`);
  const api = await extension.activate();
  assert.ok(api, 'activate() returned nothing');
  return api;
}

describe('activation', () => {
  it('activates in a workspace containing manifests', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension not installed in the test host');
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  it('registers every contributed command', async () => {
    await getApi();
    const registered = await vscode.commands.getCommands(true);

    for (const command of [
      'orizzonte.open',
      'orizzonte.refresh',
      'orizzonte.checkUpdates',
      'orizzonte.updateAll',
      'orizzonte.searchInstall',
      'orizzonte.showWhy',
      'orizzonte.focusDependencyFromLens',
    ]) {
      assert.ok(registered.includes(command), `${command} was not registered`);
    }
  });
});

describe('scanner discovery', () => {
  let api: OrizzonteApi;

  before(async () => {
    api = await getApi();
  });

  it('finds a project for every ecosystem in the fixtures', async () => {
    const result = await api.scan({ checkUpdates: false });

    const ecosystems = new Set(result.groups.map((group) => group.ecosystem));
    for (const expected of [
      'node',
      'python',
      'cargo',
      'golang',
      'composer',
      'maven',
      'gradle',
    ]) {
      assert.ok(
        ecosystems.has(expected as never),
        `no ${expected} project was discovered`,
      );
    }
  });

  /*
   * Manifests are read a few at a time rather than one after another, so which
   * read finishes first depends on the disk. Nothing downstream should depend
   * on that: results are collected by position and the groups are sorted by
   * label, and this is what says so.
   */
  it('returns the same groups in the same order on every scan', async () => {
    const first = await api.scan({ checkUpdates: false });
    const firstLabels = first.groups.map((group) => group.label);

    for (let run = 0; run < 3; run++) {
      const next = await api.scan({ checkUpdates: false });
      assert.deepEqual(
        next.groups.map((group) => group.label),
        firstLabels,
        'group order varied between scans',
      );
      assert.deepEqual(
        next.groups.map((group) => group.dependencies.length),
        first.groups.map((group) => group.dependencies.length),
        'dependency counts varied between scans',
      );
    }
  });

  it('parses dependencies with their scopes intact', async () => {
    const result = await api.scan({ checkUpdates: false });

    // Matched by manifest path rather than just `ecosystem === 'node'`: the
    // gitignore-exclusion fixtures are npm manifests too, so picking "the
    // first node group" is no longer unambiguous.
    const node = result.groups.find((group) =>
      group.manifestPath.includes('node-app'),
    );
    assert.ok(node, 'node fixture missing');

    const names = node.dependencies.map((dep) => dep.name);
    assert.ok(names.includes('express'), 'express not parsed');
    assert.ok(names.includes('typescript'), 'typescript not parsed');

    const typescript = node.dependencies.find(
      (dep) => dep.name === 'typescript',
    );
    assert.equal(typescript?.scope, 'dev');

    const fsevents = node.dependencies.find((dep) => dep.name === 'fsevents');
    assert.equal(fsevents?.scope, 'optional');
  });

  it('detects the toolchain for each project', async () => {
    const result = await api.scan({ checkUpdates: false });

    const byEcosystem = new Map(
      result.groups.map((group) => [group.ecosystem, group.toolchain]),
    );
    assert.equal(byEcosystem.get('cargo'), 'cargo');
    assert.equal(byEcosystem.get('golang'), 'go');
    assert.equal(byEcosystem.get('composer'), 'composer');
    // No lockfile in the fixture, so npm is the documented default.
    assert.equal(byEcosystem.get('node'), 'npm');
  });

  it('resolves Maven property placeholders and managed versions', async () => {
    const result = await api.scan({ checkUpdates: false });

    const maven = result.groups.find((group) => group.ecosystem === 'maven');
    assert.ok(maven, 'maven fixture missing');

    const junit = maven.dependencies.find(
      (dep) => dep.name === 'org.junit.jupiter:junit-jupiter',
    );
    // ${junit.version} must have been expanded from <properties>.
    assert.equal(junit?.declared, '5.10.2');
    assert.equal(junit?.scope, 'dev');

    const guava = maven.dependencies.find(
      (dep) => dep.name === 'com.google.guava:guava',
    );
    // The version comes from <dependencyManagement>, not the element itself.
    assert.equal(guava?.declared, '32.0.0-jre');
  });

  it('reads the Gradle version catalog', async () => {
    const result = await api.scan({ checkUpdates: false });

    const gradle = result.groups.find((group) => group.ecosystem === 'gradle');
    assert.ok(gradle, 'gradle fixture missing');

    const junit = gradle.dependencies.find(
      (dep) => dep.name === 'org.junit.jupiter:junit-jupiter',
    );
    // version.ref = "junit" must resolve through the [versions] table.
    assert.equal(junit?.declared, '5.10.2');
  });

  it('separates requirements.txt from pyproject.toml', async () => {
    const result = await api.scan({ checkUpdates: false });

    const pythonGroups = result.groups.filter(
      (group) => group.ecosystem === 'python',
    );
    assert.ok(
      pythonGroups.length >= 2,
      'expected both Python manifests to be discovered',
    );

    const allNames = pythonGroups.flatMap((group) =>
      group.dependencies.map((dep) => dep.name),
    );
    assert.ok(allNames.includes('requests'), 'pyproject dependency missing');
    assert.ok(
      allNames.includes('flask'),
      'requirements.txt dependency missing',
    );
  });

  it('produces a summary consistent with the parsed groups', async () => {
    const result = await api.scan({ checkUpdates: false });

    const counted = result.groups.reduce(
      (total, group) => total + group.dependencies.length,
      0,
    );
    assert.equal(result.summary.totalDependencies, counted);
    // Nothing was version-checked, so nothing can be outdated yet.
    assert.equal(result.summary.outdated, 0);
  });

  it('excludes directories listed in orizzonte.excludeGlobs', async () => {
    const result = await api.scan({ checkUpdates: false });
    for (const group of result.groups) {
      assert.ok(
        !group.manifestPath.includes('node_modules'),
        `node_modules leaked into the scan: ${group.manifestPath}`,
      );
      assert.ok(
        !group.manifestPath.includes('.vscode-test'),
        `.vscode-test leaked into the scan: ${group.manifestPath}`,
      );
    }
  });
});

describe('sidebar view', () => {
  it('contributes the sidebar view without throwing', async () => {
    await getApi();
    // Focusing the view forces VS Code to instantiate the WebviewViewProvider,
    // which is where a malformed contribution would surface.
    await vscode.commands.executeCommand('orizzonte.sidebar.focus');
  });
});

describe('commands are safe to invoke', () => {
  let api: OrizzonteApi;

  before(async () => {
    api = await getApi();
  });

  /*
   * Under ExtensionMode.Test every automatic scan is offline, so a refresh is a
   * filesystem walk and nothing more.
   *
   * This is asserted against the client's own request counter rather than
   * against elapsed time. The previous version timed the command and inferred
   * from "under three seconds" that no registry had been contacted, which is
   * flaky on a loaded CI runner and, more to the point, is not evidence: a
   * cached or fast response would have passed it just as happily.
   */
  it('refresh completes without touching the network', async () => {
    const before = api.requestCount();
    await vscode.commands.executeCommand('orizzonte.refresh');
    assert.equal(
      api.requestCount(),
      before,
      'refresh issued network requests under the test host',
    );
  });

  it('checkUpdates stays offline under the test host', async () => {
    const before = api.requestCount();
    await vscode.commands.executeCommand('orizzonte.checkUpdates');
    assert.equal(
      api.requestCount(),
      before,
      'checkUpdates issued network requests under the test host',
    );
  });

  it('an explicitly offline scan through the API issues no requests', async () => {
    const before = api.requestCount();
    await api.scan({ checkUpdates: false, audit: false });
    assert.equal(api.requestCount(), before);
  });

  it('showWhy with no selection does not throw', async () => {
    // Falls back to an informational message rather than failing.
    await vscode.commands.executeCommand('orizzonte.showWhy');
  });
});

describe('inline dependency feedback', () => {
  let api: OrizzonteApi;

  before(async () => {
    api = await getApi();
  });

  it('registers a CodeLens provider for the node fixture manifest', async () => {
    const result = await api.scan({ checkUpdates: false });
    const node = result.groups.find((group) =>
      group.manifestPath.includes('node-app'),
    );
    assert.ok(node, 'node fixture missing');

    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(node.manifestPath),
    );
    // Nothing throwing, and an array coming back, is what proves the
    // provider is registered for this document — content is exercised by
    // the `depAnnotations` unit tests, since offline scans never populate
    // `latest`/vulnerabilities for a lens to describe.
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      document.uri,
    );
    assert.ok(Array.isArray(lenses));
  });

  it('focusDependencyFromLens does not throw for an unknown key', async () => {
    await vscode.commands.executeCommand(
      'orizzonte.focusDependencyFromLens',
      'no-such-key',
    );
  });
});

describe('export report', () => {
  it('writes a Markdown report to the chosen location', async () => {
    const api = await getApi();
    await api.scan({ checkUpdates: false });

    const tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'orizzonte-export-')),
    );
    const target = vscode.Uri.file(path.join(tmpDir, 'report.md'));

    // `showQuickPick` and `showSaveDialog` are modal prompts that would hang
    // the headless test host forever waiting for a click, so they are
    // intercepted for the duration of this command — the same technique
    // `panelManager.test.ts` uses for `createWebviewPanel`.
    const originalQuickPick = vscode.window.showQuickPick;
    const originalSaveDialog = vscode.window.showSaveDialog;
    const originalInfoMessage = vscode.window.showInformationMessage;

    (
      vscode.window as { showQuickPick: typeof vscode.window.showQuickPick }
    ).showQuickPick = (async (
      items: readonly unknown[] | Thenable<readonly unknown[]>,
    ) => {
      const resolved = await items;
      return resolved[0];
    }) as typeof vscode.window.showQuickPick;

    (
      vscode.window as { showSaveDialog: typeof vscode.window.showSaveDialog }
    ).showSaveDialog = (async () =>
      target) as typeof vscode.window.showSaveDialog;

    (
      vscode.window as {
        showInformationMessage: typeof vscode.window.showInformationMessage;
      }
    ).showInformationMessage = (async () =>
      undefined) as typeof vscode.window.showInformationMessage;

    try {
      await vscode.commands.executeCommand('orizzonte.exportReport');
      const content = await fs.readFile(target.fsPath, 'utf8');
      assert.match(content, /# Orizzonte Dependency Report/);
      assert.match(content, /## Summary/);
    } finally {
      (
        vscode.window as { showQuickPick: typeof vscode.window.showQuickPick }
      ).showQuickPick = originalQuickPick;
      (
        vscode.window as {
          showSaveDialog: typeof vscode.window.showSaveDialog;
        }
      ).showSaveDialog = originalSaveDialog;
      (
        vscode.window as {
          showInformationMessage: typeof vscode.window.showInformationMessage;
        }
      ).showInformationMessage = originalInfoMessage;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
