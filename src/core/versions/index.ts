/**
 * One comparison façade over every ecosystem's version scheme.
 *
 * Providers hand us an ecosystem plus raw strings; everything above this layer
 * only ever deals in `UpdateKind` and sorted arrays, never in scheme-specific
 * rules.
 */

import semver from 'semver';
import type { Ecosystem, UpdateKind } from '../types.js';
import {
  compareComposer,
  composerConstraintToSemver,
  isComposerPrerelease,
  maxComposer,
} from './composer.js';
import { compareMaven, isMavenPrerelease, maxMaven } from './maven.js';
import {
  comparePep440,
  isPep440Prerelease,
  maxSatisfyingPep440,
  satisfiesPep440,
} from './pep440.js';

export * from './composer.js';
export * from './maven.js';
export * from './pep440.js';

/** Which scheme an ecosystem uses. Cargo and Go are genuine semver. */
function schemeFor(
  ecosystem: Ecosystem,
): 'semver' | 'pep440' | 'maven' | 'composer' {
  switch (ecosystem) {
    case 'python':
      return 'pep440';
    case 'maven':
    case 'gradle':
      return 'maven';
    case 'composer':
      return 'composer';
    case 'node':
    case 'cargo':
    case 'golang':
      return 'semver';
  }
}

export function compareVersions(
  ecosystem: Ecosystem,
  a: string,
  b: string,
): number {
  switch (schemeFor(ecosystem)) {
    case 'pep440':
      return comparePep440(a, b);
    case 'maven':
      return compareMaven(a, b);
    case 'composer':
      return compareComposer(a, b);
    case 'semver': {
      const ca = semver.coerce(a, { loose: true });
      const cb = semver.coerce(b, { loose: true });
      // Prefer full semver comparison when both sides parse cleanly, so
      // prerelease tags are respected rather than coerced away.
      const va = semver.valid(a, { loose: true });
      const vb = semver.valid(b, { loose: true });
      if (va && vb) return semver.compare(va, vb);
      if (ca && cb) return semver.compare(ca, cb);
      return a.localeCompare(b);
    }
  }
}

export function isPrerelease(ecosystem: Ecosystem, version: string): boolean {
  switch (schemeFor(ecosystem)) {
    case 'pep440':
      return isPep440Prerelease(version);
    case 'maven':
      return isMavenPrerelease(version);
    case 'composer':
      return isComposerPrerelease(version);
    case 'semver': {
      const parsed = semver.parse(version, { loose: true });
      return parsed
        ? parsed.prerelease.length > 0
        : /-(alpha|beta|rc|next|canary|dev)/i.test(version);
    }
  }
}

/** Highest published version overall, ignoring prereleases where possible. */
export function maxVersion(
  ecosystem: Ecosystem,
  candidates: string[],
): string | undefined {
  if (candidates.length === 0) return undefined;
  switch (schemeFor(ecosystem)) {
    case 'maven':
      return maxMaven(candidates);
    case 'composer':
      return maxComposer(candidates);
    default: {
      const stable = candidates.filter(
        (candidate) => !isPrerelease(ecosystem, candidate),
      );
      const pool = stable.length > 0 ? stable : candidates;
      return [...pool].sort((a, b) => compareVersions(ecosystem, a, b))[
        pool.length - 1
      ];
    }
  }
}

/**
 * Highest published version satisfying the declared constraint — the "wanted"
 * column, i.e. what you'd get from a fresh install without editing anything.
 *
 * Returns undefined when the constraint cannot be evaluated (git URLs, branch
 * constraints, Gradle dynamic versions); the UI shows a dash rather than a lie.
 */
export function maxSatisfying(
  ecosystem: Ecosystem,
  candidates: string[],
  constraint: string,
): string | undefined {
  if (candidates.length === 0) return undefined;
  const cleaned = constraint.trim();
  if (cleaned === '' || cleaned === '*' || cleaned === 'latest') {
    return maxVersion(ecosystem, candidates);
  }

  switch (schemeFor(ecosystem)) {
    case 'pep440':
      return maxSatisfyingPep440(candidates, cleaned);
    case 'maven': {
      // Maven ranges like [1.0,2.0) are rare in practice; a literal pin is the
      // norm, so an exact match is the honest answer.
      if (candidates.includes(cleaned)) return cleaned;
      return undefined;
    }
    case 'composer': {
      const range = composerConstraintToSemver(cleaned);
      if (!range) return undefined;
      return maxSatisfyingSemver(candidates, range);
    }
    case 'semver':
      return maxSatisfyingSemver(candidates, cleaned);
  }
}

function maxSatisfyingSemver(
  candidates: string[],
  range: string,
): string | undefined {
  if (!semver.validRange(range, { loose: true })) {
    return undefined;
  }
  const usable = candidates
    .map((candidate) => ({
      raw: candidate,
      parsed: semver.valid(candidate, { loose: true }),
    }))
    .filter(
      (entry): entry is { raw: string; parsed: string } =>
        entry.parsed !== null,
    );

  const best = semver.maxSatisfying(
    usable.map((entry) => entry.parsed),
    range,
    { loose: true },
  );
  if (!best) return undefined;
  return usable.find((entry) => entry.parsed === best)?.raw ?? best;
}

/**
 * Classifies the gap between what is installed and what is available.
 *
 * `from` is the resolved current version. When we only know a constraint we
 * pass its lower bound, which is why `unknown` is a real outcome here.
 */
export function classifyUpdate(
  ecosystem: Ecosystem,
  from: string | undefined,
  to: string | undefined,
): UpdateKind {
  if (!from || !to) return 'unknown';
  if (compareVersions(ecosystem, from, to) >= 0) return 'none';

  const a = semver.coerce(from, { loose: true });
  const b = semver.coerce(to, { loose: true });
  if (!a || !b) return 'unknown';

  if (b.major !== a.major) return 'major';

  // Below 1.0.0, semver gives the leading non-zero component the role major
  // normally plays: `^0.5` allows 0.5.x but not 0.6, and `^0.0.3` allows
  // nothing else at all. Reporting 0.5 -> 0.8 as a "minor" bump would tell the
  // user it is safe when it is exactly as breaking as a major.
  if (a.major === 0) {
    if (b.minor !== a.minor) return 'major';
    if (a.minor === 0 && b.patch !== a.patch) return 'major';
  }

  if (b.minor !== a.minor) return 'minor';
  if (b.patch !== a.patch) return 'patch';
  return 'none';
}

/**
 * Strips a constraint down to a concrete version for display, e.g. `^1.2.3`
 * becomes `1.2.3`. Used when no lockfile pins an exact version, and this
 * value is what the audit step matches advisories against — a wrong guess
 * means wrong vulnerability results, not just a wrong-looking cell.
 *
 * The leading `(?:\d+!)?` skips a PEP 440 epoch (`1!2.0.0`), which is
 * otherwise indistinguishable from the version itself to a plain "first run
 * of digits" match — without it this would return `1`, not `2.0.0`.
 */
export function constraintToApproxVersion(
  constraint: string,
): string | undefined {
  const match = /(?:\d+!)?(\d+(?:\.\d+)*(?:[-+][0-9a-zA-Z.-]+)?)/.exec(
    constraint,
  );
  return match?.[1];
}

/**
 * Carries a simple range operator from a declared constraint onto a new
 * concrete version, so updating `^1.2.3` to `1.4.0` yields `^1.4.0` rather
 * than silently pinning `1.4.0`.
 *
 * Everything else is left untouched: exact pins stay pinned (the author asked
 * for exactness), and compound ranges (`>=1 <2`), dist-tags (`latest`) or
 * workspace protocols have no single operator worth preserving.
 */
export function applyDeclaredPrefix(declared: string, version: string): string {
  // Only bare versions get a prefix; a range or tag arriving as the target is
  // passed through verbatim rather than mangled.
  if (!/^\d/.test(version)) return version;
  const match = /^([~^])\s*\d/.exec(declared.trim());
  return match ? `${match[1]}${version}` : version;
}

export { satisfiesPep440 };
