/**
 * Grouping packages by license and checking that against an allow/deny list.
 *
 * Deliberately a single case-insensitive string match, not an SPDX-expression
 * evaluator: registries report a mix of bare identifiers ("MIT") and compound
 * expressions ("MIT OR Apache-2.0"), and parsing the latter correctly is real,
 * separate work. A policy entry matches what a registry actually reported,
 * verbatim — good enough to flag "GPL-3.0" outright, not to reason about
 * dual-license terms.
 */

import type { LicenseGroup, LicenseSummary } from './types.js';

export interface LicensePolicy {
  /** When non-empty, only these licenses pass; everything else — including
   * unknown — is flagged. Takes precedence over `deny`. */
  allow: string[];
  /** When `allow` is empty, these specific licenses are flagged. */
  deny: string[];
}

export function isLicenseFlagged(
  license: string | undefined,
  policy: LicensePolicy,
): boolean {
  const normalized = license?.toLowerCase();

  if (policy.allow.length > 0) {
    const allow = policy.allow.map((entry) => entry.toLowerCase());
    return normalized === undefined || !allow.includes(normalized);
  }
  if (policy.deny.length > 0) {
    const deny = policy.deny.map((entry) => entry.toLowerCase());
    return normalized !== undefined && deny.includes(normalized);
  }
  return false;
}

export function buildLicenseSummary(
  packages: Array<{ name: string; license: string | undefined }>,
  policy: LicensePolicy,
): LicenseSummary {
  const byLicense = new Map<string | undefined, string[]>();
  for (const pkg of packages) {
    const list = byLicense.get(pkg.license);
    if (list) list.push(pkg.name);
    else byLicense.set(pkg.license, [pkg.name]);
  }

  const groups: LicenseGroup[] = [...byLicense.entries()].map(
    ([license, packageNames]) => ({
      license,
      packageNames: [...packageNames].sort(),
      flagged: isLicenseFlagged(license, policy),
    }),
  );

  /*
   * Flagged first (the thing worth acting on), then alphabetical by license,
   * with unknown last — it is the one group with nothing to alphabetize and
   * the one a policy can never clear, so it reads better as a coda than
   * interleaved among named licenses.
   */
  groups.sort((a, b) => {
    if (a.license === undefined) return 1;
    if (b.license === undefined) return -1;
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    return a.license.localeCompare(b.license);
  });

  return { groups };
}
