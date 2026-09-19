/**
 * PEP 440 version parsing and comparison.
 *
 * Python's scheme is not semver and the differences bite: `1.0.post1` sorts
 * *above* `1.0`, `1.0.dev1` sorts *below* `1.0a1`, epochs beat everything, and
 * release segments are zero-padded to equal length before comparing.
 *
 * Implemented directly rather than pulled from a dependency so the extension
 * carries no runtime package for ~150 lines of well-specified logic.
 */

export interface Pep440Version {
  epoch: number;
  release: number[];
  /** 'a' | 'b' | 'rc', normalised from alpha/beta/c/pre/preview. */
  preType?: string;
  preNumber?: number;
  postNumber?: number;
  devNumber?: number;
  local?: string;
  raw: string;
}

const VERSION_PATTERN =
  /^\s*v?(?:(?<epoch>\d+)!)?(?<release>\d+(?:\.\d+)*)(?<pre>[-_.]?(?<preType>a|b|c|rc|alpha|beta|pre|preview)[-_.]?(?<preNum>\d+)?)?(?<post>(?:-(?<postNum1>\d+))|(?:[-_.]?(?:post|rev|r)[-_.]?(?<postNum2>\d+)?))?(?<dev>[-_.]?dev[-_.]?(?<devNum>\d+)?)?(?:\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

const PRE_ALIASES: Record<string, string> = {
  alpha: 'a',
  a: 'a',
  beta: 'b',
  b: 'b',
  c: 'rc',
  pre: 'rc',
  preview: 'rc',
  rc: 'rc',
};

export function parsePep440(input: string): Pep440Version | null {
  const match = VERSION_PATTERN.exec(input);
  if (!match?.groups) {
    return null;
  }
  const g = match.groups;

  const version: Pep440Version = {
    epoch: g.epoch ? Number(g.epoch) : 0,
    release: g.release.split('.').map(Number),
    raw: input.trim(),
  };

  if (g.preType) {
    version.preType =
      PRE_ALIASES[g.preType.toLowerCase()] ?? g.preType.toLowerCase();
    version.preNumber = g.preNum ? Number(g.preNum) : 0;
  }
  if (g.post !== undefined) {
    version.postNumber = Number(g.postNum1 ?? g.postNum2 ?? 0);
  }
  if (g.dev !== undefined) {
    version.devNumber = g.devNum ? Number(g.devNum) : 0;
  }
  if (g.local) {
    version.local = g.local.toLowerCase();
  }

  return version;
}

/** Returns -1, 0 or 1. Unparseable versions sort last but stay stable. */
export function comparePep440(a: string, b: string): number {
  const va = parsePep440(a);
  const vb = parsePep440(b);
  if (!va && !vb) return a.localeCompare(b);
  if (!va) return -1;
  if (!vb) return 1;

  if (va.epoch !== vb.epoch) {
    return va.epoch < vb.epoch ? -1 : 1;
  }

  // Zero-pad the shorter release tuple: 1.0 and 1.0.0 are equal.
  const length = Math.max(va.release.length, vb.release.length);
  for (let i = 0; i < length; i++) {
    const left = va.release[i] ?? 0;
    const right = vb.release[i] ?? 0;
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }

  const preCmp = comparePre(va, vb);
  if (preCmp !== 0) return preCmp;

  const postCmp = compareOptional(
    va.postNumber,
    vb.postNumber,
    'absent-is-lower',
  );
  if (postCmp !== 0) return postCmp;

  // A dev release precedes the corresponding non-dev release.
  const devCmp = compareOptional(
    va.devNumber,
    vb.devNumber,
    'absent-is-higher',
  );
  if (devCmp !== 0) return devCmp;

  return 0;
}

function comparePre(a: Pep440Version, b: Pep440Version): number {
  // No pre-release segment outranks any pre-release segment — unless the
  // version is a pure dev release, which sorts below its own pre-releases.
  const aIsPre = a.preType !== undefined;
  const bIsPre = b.preType !== undefined;

  if (!aIsPre && !bIsPre) return 0;
  if (!aIsPre)
    return a.devNumber !== undefined && b.devNumber === undefined ? -1 : 1;
  if (!bIsPre)
    return b.devNumber !== undefined && a.devNumber === undefined ? 1 : -1;

  const order = ['a', 'b', 'rc'];
  const ai = order.indexOf(a.preType!);
  const bi = order.indexOf(b.preType!);
  if (ai !== bi) return ai < bi ? -1 : 1;

  const an = a.preNumber ?? 0;
  const bn = b.preNumber ?? 0;
  if (an !== bn) return an < bn ? -1 : 1;
  return 0;
}

function compareOptional(
  a: number | undefined,
  b: number | undefined,
  absent: 'absent-is-lower' | 'absent-is-higher',
): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return absent === 'absent-is-lower' ? -1 : 1;
  if (b === undefined) return absent === 'absent-is-lower' ? 1 : -1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}

/** True when the version carries a pre-release or dev marker. */
export function isPep440Prerelease(input: string): boolean {
  const parsed = parsePep440(input);
  return parsed
    ? parsed.preType !== undefined || parsed.devNumber !== undefined
    : false;
}

/**
 * Checks a version against a PEP 440 specifier set such as
 * `>=1.2,<2.0` or `~=1.4.2`.
 */
export function satisfiesPep440(version: string, specifier: string): boolean {
  const clauses = specifier
    .split(',')
    .map((clause) => clause.trim())
    .filter(Boolean);

  if (clauses.length === 0) {
    return true;
  }

  return clauses.every((clause) => satisfiesSingle(version, clause));
}

function satisfiesSingle(version: string, clause: string): boolean {
  const match = /^(===|==|!=|<=|>=|~=|<|>)?\s*(.+)$/.exec(clause);
  if (!match) {
    return true;
  }
  const operator = match[1] ?? '==';
  const target = match[2].trim();

  if (operator === '===') {
    return version === target;
  }

  // Wildcards only make sense for equality comparisons.
  if (target.endsWith('.*') && (operator === '==' || operator === '!=')) {
    const prefix = target.slice(0, -2);
    const matches = version === prefix || version.startsWith(`${prefix}.`);
    return operator === '==' ? matches : !matches;
  }

  const cmp = comparePep440(version, target);

  switch (operator) {
    case '==':
      return cmp === 0;
    case '!=':
      return cmp !== 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '~=': {
      // Compatible release: >= target, and < the target with its last
      // component dropped and the preceding one bumped.
      if (cmp < 0) return false;
      const parsed = parsePep440(target);
      if (!parsed || parsed.release.length < 2) return cmp >= 0;
      const ceiling = parsed.release.slice(0, -1);
      ceiling[ceiling.length - 1] += 1;
      return comparePep440(version, ceiling.join('.')) < 0;
    }
    default:
      return true;
  }
}

/**
 * Highest version in `candidates` satisfying `specifier`.
 *
 * Prereleases are excluded unless asked for — but a specifier that *names* a
 * prerelease is asking for one, which is how PEP 440 itself defines it. Without
 * that, a project pinned `==2.0.0rc1` had no wanted version at all: the only
 * version that satisfied the constraint was filtered out before the comparison.
 */
export function maxSatisfyingPep440(
  candidates: string[],
  specifier: string,
  allowPrerelease = specifierMentionsPrerelease(specifier),
): string | undefined {
  const eligible = candidates.filter((candidate) => {
    if (!allowPrerelease && isPep440Prerelease(candidate)) return false;
    return satisfiesPep440(candidate, specifier);
  });
  if (eligible.length === 0) return undefined;
  return eligible.sort(comparePep440)[eligible.length - 1];
}

/** True when any clause of the specifier names a pre-release or dev version. */
function specifierMentionsPrerelease(specifier: string): boolean {
  return specifier
    .split(',')
    .some((clause) =>
      isPep440Prerelease(clause.replace(/^\s*(===|==|!=|<=|>=|~=|<|>)\s*/, '')),
    );
}
