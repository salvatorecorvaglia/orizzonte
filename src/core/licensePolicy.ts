/**
 * Grouping packages by license and checking that against an allow/deny list.
 *
 * Licenses are read as SPDX expressions, because that is what registries
 * report: crates are almost all `MIT OR Apache-2.0`, npm has `(MIT AND
 * Zlib)`, and a plain string match flagged every one of them against an allow
 * list of `MIT, Apache-2.0` while letting `GPL-3.0-or-later` past a deny list
 * of `GPL-3.0`. The rules applied:
 *
 *   - `A OR B` passes when either does — the user may pick the license.
 *   - `A AND B` passes only when both do.
 *   - `A WITH exception` is judged on `A`.
 *   - `-only`, `-or-later` and `+` variants match their base identifier.
 *   - PyPI's classifier names (`MIT License`, `Apache Software License`) are
 *     read as the SPDX identifiers they stand for.
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
  if (policy.allow.length > 0) {
    if (license === undefined) return true;
    const allow = new Set(policy.allow.map(licenseKey));
    return !satisfies(parseLicense(license), (id) => allow.has(id));
  }
  if (policy.deny.length > 0) {
    if (license === undefined) return false;
    const deny = new Set(policy.deny.map(licenseKey));
    return !satisfies(parseLicense(license), (id) => !deny.has(id));
  }
  return false;
}

type LicenseNode =
  | { kind: 'id'; id: string }
  | { kind: 'or' | 'and'; left: LicenseNode; right: LicenseNode };

/** Whether the expression can be honoured using only licenses `ok` accepts. */
function satisfies(node: LicenseNode, ok: (key: string) => boolean): boolean {
  switch (node.kind) {
    case 'id':
      return ok(licenseKey(node.id));
    case 'or':
      return satisfies(node.left, ok) || satisfies(node.right, ok);
    case 'and':
      return satisfies(node.left, ok) && satisfies(node.right, ok);
  }
}

/**
 * Parses an SPDX expression, falling back to one opaque identifier for
 * anything that is not one — a free-text license name is still matched as a
 * whole rather than dropped.
 */
export function parseLicense(raw: string): LicenseNode {
  const text = raw.trim();
  if (CLASSIFIER_ALIASES.has(text.toLowerCase()))
    return { kind: 'id', id: text };

  // Cargo's pre-SPDX `MIT/Apache-2.0` means `MIT OR Apache-2.0`.
  const tokens = text.replace(/\s*\/\s*/g, ' OR ').match(/\(|\)|[^\s()]+/g);
  if (!tokens) return { kind: 'id', id: text };

  let position = 0;
  const peek = () => tokens[position]?.toUpperCase();

  const factor = (): LicenseNode | undefined => {
    if (peek() === '(') {
      position++;
      const inner = expression();
      if (peek() !== ')') return undefined;
      position++;
      return inner;
    }
    const id = tokens[position];
    if (!id || ['AND', 'OR', 'WITH', ')'].includes(id.toUpperCase())) {
      return undefined;
    }
    position++;
    if (peek() === 'WITH') position += 2; // the exception does not change the license
    return { kind: 'id', id };
  };

  const term = (): LicenseNode | undefined => {
    let left = factor();
    while (left && peek() === 'AND') {
      position++;
      const right = factor();
      if (!right) return undefined;
      left = { kind: 'and', left, right };
    }
    return left;
  };

  const expression = (): LicenseNode | undefined => {
    let left = term();
    while (left && peek() === 'OR') {
      position++;
      const right = term();
      if (!right) return undefined;
      left = { kind: 'or', left, right };
    }
    return left;
  };

  const parsed = expression();
  // Leftover tokens mean this was prose ("BSD 3-Clause License"), not SPDX.
  return parsed && position === tokens.length
    ? parsed
    : { kind: 'id', id: text };
}

/**
 * The comparison key for one identifier: case-folded, classifier names mapped
 * to SPDX, and the `-only` / `-or-later` / `+` suffixes dropped so a policy
 * naming the base license covers every variant of it.
 */
export function licenseKey(id: string): string {
  const lower = id.trim().toLowerCase();
  const canonical = CLASSIFIER_ALIASES.get(lower) ?? lower;
  return canonical.replace(/(?:-only|-or-later|\+)$/, '');
}

/**
 * PyPI trove classifiers and other common spellings, to SPDX. Keys are lower
 * case. Deliberately short: the licenses a policy is realistically written
 * about, not the whole SPDX list.
 */
const CLASSIFIER_ALIASES = new Map<string, string>([
  ['mit license', 'mit'],
  ['the mit license', 'mit'],
  ['apache software license', 'apache-2.0'],
  ['apache license 2.0', 'apache-2.0'],
  ['apache license, version 2.0', 'apache-2.0'],
  ['apache 2.0', 'apache-2.0'],
  ['apache-2', 'apache-2.0'],
  ['isc license (iscl)', 'isc'],
  ['isc license', 'isc'],
  ['bsd-3-clause license', 'bsd-3-clause'],
  ['mozilla public license 2.0 (mpl 2.0)', 'mpl-2.0'],
  ['gnu general public license v2 (gplv2)', 'gpl-2.0'],
  ['gnu general public license v3 (gplv3)', 'gpl-3.0'],
  ['gnu general public license v2 or later (gplv2+)', 'gpl-2.0'],
  ['gnu general public license v3 or later (gplv3+)', 'gpl-3.0'],
  ['gnu lesser general public license v2 (lgplv2)', 'lgpl-2.0'],
  ['gnu lesser general public license v3 (lgplv3)', 'lgpl-3.0'],
  ['gnu affero general public license v3', 'agpl-3.0'],
  ['python software foundation license', 'psf-2.0'],
  ['the unlicense (unlicense)', 'unlicense'],
]);

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
