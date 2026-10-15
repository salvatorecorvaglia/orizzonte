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
import type { ProjectGroup, Severity } from '../core/types.js';

const SEVERITY_TO_DIAGNOSTIC: Record<Severity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  high: vscode.DiagnosticSeverity.Error,
  moderate: vscode.DiagnosticSeverity.Warning,
  low: vscode.DiagnosticSeverity.Information,
};

/** How long an edit to a manifest settles before its diagnostics move. */
const EDIT_DEBOUNCE_MS = 300;

export class DepDiagnostics implements vscode.Disposable {
  private readonly collection =
    vscode.languages.createDiagnosticCollection('orizzonte');

  /** The groups of the last scan, by manifest path. */
  private groups = new Map<string, ProjectGroup>();

  private readonly pendingEdits = new Map<string, NodeJS.Timeout>();

  private readonly subscriptions: vscode.Disposable[] = [
    // A manifest opened after the scan landed. Only that document is worked
    // out: this event also fires for git's virtual documents, output channels
    // and every file Go to Definition peeks at, and recomputing every open
    // manifest for each of them was work for nothing.
    vscode.workspace.onDidOpenTextDocument((document) => {
      this.refreshDocument(document);
    }),
    // Diagnostics for a closed manifest otherwise stay in the Problems panel
    // until the next scan.
    vscode.workspace.onDidCloseTextDocument((document) => {
      this.cancelPendingEdit(document.uri);
      this.collection.delete(document.uri);
    }),
    // Offsets move as the user types; a diagnostic left where the line used
    // to be points at the wrong dependency until the file is saved and
    // rescanned.
    vscode.workspace.onDidChangeTextDocument((event) => {
      const document = event.document;
      if (!this.groups.has(document.uri.fsPath)) return;
      this.cancelPendingEdit(document.uri);
      this.pendingEdits.set(
        document.uri.toString(),
        setTimeout(() => {
          this.pendingEdits.delete(document.uri.toString());
          this.refreshDocument(document);
        }, EDIT_DEBOUNCE_MS),
      );
    }),
  ];

  /** Recomputes diagnostics for every manifest currently open in an editor. */
  refresh(result: ScanResult): void {
    this.groups = new Map(
      result.groups.map((group) => [group.manifestPath, group]),
    );
    this.collection.clear();
    for (const document of vscode.workspace.textDocuments) {
      this.refreshDocument(document);
    }
  }

  /** Recomputes diagnostics for one document, from the last scan. */
  private refreshDocument(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file') return;
    const group = this.groups.get(document.uri.fsPath);
    if (!group) return;

    const specs = buildDiagnosticSpecs(document.getText(), group.dependencies);
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

  private cancelPendingEdit(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.pendingEdits.get(key);
    if (timer) clearTimeout(timer);
    this.pendingEdits.delete(key);
  }

  dispose(): void {
    for (const timer of this.pendingEdits.values()) clearTimeout(timer);
    this.pendingEdits.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.collection.dispose();
  }
}
