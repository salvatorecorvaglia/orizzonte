/**
 * The words and rankings both UI surfaces agree on.
 *
 * The tree view and the webview table present the same data, and until this
 * file existed they each had their own copy of "what is a scope called", "is
 * this outdated" and "how urgent is this" — which is why they could disagree
 * about ordering and vocabulary. Everything here has exactly one definition.
 *
 * Like `types.ts`, this file must not import `vscode`: the webview bundle pulls
 * it in.
 */

import type { Dependency, DepScope, Severity, Vulnerability } from './types.js';

/** Declaration order everywhere a scope list is shown, most-used first. */
export const ALL_SCOPES: DepScope[] = [
  'prod',
  'dev',
  'build',
  'peer',
  'optional',
];

/**
 * `short` is for dense surfaces (table badges, filter chips); `long` is for the
 * tree, where a row has the width to spell it out.
 */
export const SCOPE_LABELS: Record<DepScope, { short: string; long: string }> = {
  prod: { short: 'prod', long: 'Production' },
  dev: { short: 'dev', long: 'Development' },
  build: { short: 'build', long: 'Build' },
  peer: { short: 'peer', long: 'Peer' },
  optional: { short: 'optional', long: 'Optional' },
};

/** The version we treat as "what you have right now". */
export function currentVersion(dep: Dependency): string {
  return dep.installed ?? dep.declared;
}

/**
 * What to call a dependency's scope, in the ecosystem's own words.
 *
 * The five buckets are an internal simplification, and two ecosystems map onto
 * them in ways whose *label* then misleads. Go has no optional dependencies at
 * all: a `// indirect` requirement lands in the optional bucket because it is
 * not a direct one, and a row reading "optional" invites a reader to remove
 * something the build requires. The bucket is right; the word is not.
 *
 * Corrected here rather than at either display site, for the same reason
 * `statusRank` lives in this file.
 */
export function scopeLabel(
  dep: Dependency,
  form: 'short' | 'long' = 'short',
): string {
  if (dep.ecosystem === 'golang' && dep.scope === 'optional') {
    return form === 'short' ? 'indirect' : 'Indirect (transitive)';
  }
  return SCOPE_LABELS[dep.scope][form];
}

/**
 * What to show in the "declared" column.
 *
 * Cargo's `workspace = true` means "whatever the workspace root says", which
 * the parser records verbatim as the constraint `workspace` — accurate, and
 * unreadable as a version. Maven's equivalent is already spelled `managed`.
 */
export function declaredLabel(dep: Dependency): string {
  if (dep.ecosystem === 'cargo' && dep.declared === 'workspace') {
    return 'inherited from workspace';
  }
  return dep.declared;
}

/**
 * The single definition of "outdated".
 *
 * `unknown` is deliberately excluded: a failed lookup is not evidence that an
 * update exists, and counting it as one produces badges that never clear.
 */
export function hasUpdate(dep: Dependency): boolean {
  return (
    dep.updateKind === 'patch' ||
    dep.updateKind === 'minor' ||
    dep.updateKind === 'major'
  );
}

/**
 * Problem severity, lowest number first. Used for the table's Status sort and
 * for the tree's ordering, so a package sits in the same relative place in both.
 */
export function statusRank(dep: Dependency): number {
  if (dep.vulnerabilities.length > 0) return 0;
  if (dep.meta?.deprecated) return 1;
  if (dep.updateKind === 'major') return 2;
  if (dep.updateKind === 'minor') return 3;
  if (dep.updateKind === 'patch') return 4;
  return 5;
}

/** Problems first, then outdated, then alphabetical. */
export function sortByStatus(dependencies: Dependency[]): Dependency[] {
  return [...dependencies].sort(
    (a, b) => statusRank(a) - statusRank(b) || a.name.localeCompare(b.name),
  );
}

/** Advisory severity, worst first. The counterpart to `statusRank`. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
};

export function severityRank(vulnerability: Vulnerability): number {
  return SEVERITY_RANK[vulnerability.severity];
}

/**
 * Advisories worst-first, then by id so the order is stable between scans.
 *
 * OSV answers in its own order, which is neither severity nor anything else the
 * reader can use: a `critical` could sit below a `low` in the drawer, and the
 * tree's tooltip — which shows the first three — could omit the one advisory
 * that mattered. Sorting here rather than at either display site is what makes
 * both surfaces agree, the same reason `statusRank` lives in this file.
 */
export function sortBySeverity(
  vulnerabilities: Vulnerability[],
): Vulnerability[] {
  return [...vulnerabilities].sort(
    (a, b) => severityRank(a) - severityRank(b) || a.id.localeCompare(b.id),
  );
}
