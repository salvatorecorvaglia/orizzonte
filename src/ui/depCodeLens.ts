/**
 * Surfaces update/vulnerability status directly above each declared
 * dependency, so a user does not have to open the panel to see what a
 * manifest line already implies.
 */

import * as vscode from 'vscode';
import { buildLensSpecs } from '../core/depAnnotations.js';
import type { ScanResult } from '../core/scanner.js';

export class DepCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly getResult: () => ScanResult) {}

  /** Called whenever a new scan result lands, so open editors pick it up. */
  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const group = this.getResult().groups.find(
      (candidate) => candidate.manifestPath === document.uri.fsPath,
    );
    if (!group) return [];

    return buildLensSpecs(document.getText(), group.dependencies).map(
      (spec) => {
        const range = document.lineAt(
          document.positionAt(spec.offset).line,
        ).range;
        return new vscode.CodeLens(range, {
          title: spec.title,
          command: 'orizzonte.focusDependencyFromLens',
          arguments: [spec.dep.key],
        });
      },
    );
  }
}
