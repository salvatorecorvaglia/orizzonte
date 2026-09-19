/**
 * What an editor should show inline for a declared dependency: a CodeLens
 * label for updates/vulnerabilities, and a diagnostic for known
 * vulnerabilities. Kept free of `vscode` so it can be tested against
 * dependency fixtures directly rather than through the editor — the actual
 * `CodeLens`/`Diagnostic` objects are built by the thin wrappers in `ui/`.
 */

import { findDeclaration } from './findDeclaration.js';
import type { Dependency, Severity } from './types.js';
import { hasUpdate, sortBySeverity } from './vocabulary.js';

export interface DepLensSpec {
  /** Offset into the manifest text where `dep`'s declaration starts. */
  offset: number;
  dep: Dependency;
  title: string;
}

export interface DepDiagnosticSpec {
  offset: number;
  dep: Dependency;
  message: string;
  /** The worst severity among `dep.vulnerabilities`. */
  severity: Severity;
}

/** One lens per dependency with an update or a known vulnerability. */
export function buildLensSpecs(
  manifestText: string,
  dependencies: Dependency[],
): DepLensSpec[] {
  const specs: DepLensSpec[] = [];
  for (const dep of dependencies) {
    const title = lensTitle(dep);
    if (!title) continue;
    const offset = findDeclaration(manifestText, dep.name);
    if (offset < 0) continue;
    specs.push({ offset, dep, title });
  }
  return specs;
}

function lensTitle(dep: Dependency): string | undefined {
  const parts: string[] = [];
  if (hasUpdate(dep) && dep.latest) {
    parts.push(`↑ ${dep.latest} available`);
  }
  if (dep.vulnerabilities.length > 0) {
    const count = dep.vulnerabilities.length;
    const worst = sortBySeverity(dep.vulnerabilities)[0]?.severity;
    const noun = count === 1 ? 'vulnerability' : 'vulnerabilities';
    parts.push(`⚠ ${count} ${noun}${worst ? ` (${worst})` : ''}`);
  }
  return parts.length > 0 ? parts.join('  ·  ') : undefined;
}

/** One diagnostic per dependency carrying at least one known vulnerability. */
export function buildDiagnosticSpecs(
  manifestText: string,
  dependencies: Dependency[],
): DepDiagnosticSpec[] {
  const specs: DepDiagnosticSpec[] = [];
  for (const dep of dependencies) {
    if (dep.vulnerabilities.length === 0) continue;
    const offset = findDeclaration(manifestText, dep.name);
    if (offset < 0) continue;

    const sorted = sortBySeverity(dep.vulnerabilities);
    const worst = sorted[0];
    const message =
      dep.vulnerabilities.length === 1
        ? `${dep.name}: ${worst.summary} (${worst.severity})`
        : `${dep.name}: ${dep.vulnerabilities.length} known vulnerabilities, worst is ${worst.severity}`;
    specs.push({ offset, dep, message, severity: worst.severity });
  }
  return specs;
}
