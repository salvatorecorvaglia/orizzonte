/**
 * Reports known vulnerabilities as Problems-panel diagnostics on the
 * manifest line that declares the affected dependency.
 *
 * Scoped to currently open documents rather than every manifest the scanner
 * found: opening files the user never asked to see, just to diagnose them,
 * would be a surprising side effect for a tree with hundreds of manifests.
 */

import * as vscode from 'vscode';
import { buildDiagnosticSpecs } from '../core/depAnnotations.js';
import type { ScanResult } from '../core/scanner.js';
import type { Severity } from '../core/types.js';

const SEVERITY_TO_DIAGNOSTIC: Record<Severity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  high: vscode.DiagnosticSeverity.Error,
  moderate: vscode.DiagnosticSeverity.Warning,
  low: vscode.DiagnosticSeverity.Information,
};

export class DepDiagnostics implements vscode.Disposable {
  private readonly collection =
    vscode.languages.createDiagnosticCollection('orizzonte');

  /** Recomputes diagnostics for every manifest currently open in an editor. */
  refresh(result: ScanResult): void {
    this.collection.clear();

    for (const document of vscode.workspace.textDocuments) {
      const group = result.groups.find(
        (candidate) => candidate.manifestPath === document.uri.fsPath,
      );
      if (!group) continue;

      const specs = buildDiagnosticSpecs(
        document.getText(),
        group.dependencies,
      );
      this.collection.set(
        document.uri,
        specs.map((spec) => {
          const range = document.lineAt(
            document.positionAt(spec.offset).line,
          ).range;
          const diagnostic = new vscode.Diagnostic(
            range,
            spec.message,
            SEVERITY_TO_DIAGNOSTIC[spec.severity],
          );
          diagnostic.source = 'Orizzonte';
          return diagnostic;
        }),
      );
    }
  }

  dispose(): void {
    this.collection.dispose();
  }
}
