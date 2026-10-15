/**
 * `depDiagnostics.ts` imports `vscode`, so it is exercised here against real
 * documents rather than under vitest.
 *
 * The behaviour worth pinning: a diagnostic sits on the line that declares the
 * vulnerable package, and follows that line when an edit moves it — it used to
 * stay where the line had been until the file was saved and rescanned.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ScanResult } from '../../src/core/scanner.js';
import { DepDiagnostics } from '../../src/ui/depDiagnostics.js';

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('DepDiagnostics', () => {
  let tmpDir: string;
  let diagnostics: DepDiagnostics;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orizzonte-diag-'));
    diagnostics = new DepDiagnostics();
  });

  afterEach(async () => {
    diagnostics.dispose();
    await vscode.commands.executeCommand(
      'workbench.action.revertAndCloseActiveEditor',
    );
    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it('marks the declaring line and follows it through an edit', async () => {
    const manifestPath = path.join(tmpDir, 'package.json');
    await fs.writeFile(
      manifestPath,
      '{\n  "dependencies": {\n    "lodash": "4.17.0"\n  }\n}\n',
    );
    const uri = vscode.Uri.file(manifestPath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    const result: ScanResult = {
      groups: [
        {
          label: 'p',
          manifestPath: uri.fsPath,
          ecosystem: 'node',
          toolchain: 'npm',
          dependencies: [
            {
              key: 'lodash',
              name: 'lodash',
              ecosystem: 'node',
              scope: 'prod',
              declared: '4.17.0',
              installed: '4.17.0',
              updateKind: 'none',
              vulnerabilities: [
                {
                  id: 'GHSA-1',
                  summary: 'Prototype pollution',
                  severity: 'high',
                  aliases: [],
                  url: 'https://osv.dev/vulnerability/GHSA-1',
                },
              ],
              manifestPath: uri.fsPath,
              projectLabel: 'p',
            },
          ],
        },
      ],
      manifestPaths: [uri.fsPath],
      manifests: [],
      summary: {
        totalDependencies: 1,
        outdated: 0,
        vulnerable: 1,
        deprecated: 0,
        stale: false,
      },
    };

    diagnostics.refresh(result);

    const lineOf = () =>
      vscode.languages.getDiagnostics(uri)[0]?.range.start.line;
    await waitFor(() => lineOf() === 2, 'the diagnostic on line 2');

    // Two lines inserted above the declaration, without saving.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      uri,
      new vscode.Position(1, 0),
      '  "name": "p",\n  "private": true,\n',
    );
    assert.ok(await vscode.workspace.applyEdit(edit));

    await waitFor(() => lineOf() === 4, 'the diagnostic to follow the edit');
  });
});
