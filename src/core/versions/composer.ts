/**
 * Composer version handling.
 *
 * Composer is semver-flavoured but tolerant: versions may carry a `v` prefix,
 * use four numeric segments (`1.2.3.4`), and stability suffixes are ordered
 * dev < alpha < beta < RC < stable < patch.
 */

const STABILITY_ORDER: Record<string, number> = {
  dev: 0,
  alpha: 1,
  a: 1,
  beta: 2,
  b: 2,
  rc: 3,
  '': 4, // stable
  pl: 5,
  p: 5,
};

interface ComposerVersion {
  parts: number[];
  stability: string;
  stabilityNumber: number;
}

function parse(input: string): ComposerVersion | null {
  const cleaned = input.trim().replace(/^v/i, '');
  const match =
    /^(\d+(?:\.\d+)*)(?:[-_.]?(dev|alpha|a|beta|b|rc|pl|p)[-_.]?(\d+)?)?/i.exec(
      cleaned,
    );
  if (!match) return null;

  const stability = (match[2] ?? '').toLowerCase();
  return {
    parts: match[1].split('.').map(Number),
    stability,
    stabilityNumber: match[3] ? Number(match[3]) : 0,
  };
}

export function compareComposer(a: string, b: string): number {
  const va = parse(a);
  const vb = parse(b);
  if (!va && !vb) return a.localeCompare(b);
  if (!va) return -1;
  if (!vb) return 1;

  const length = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < length; i++) {
    const left = va.parts[i] ?? 0;
    const right = vb.parts[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }

  const sa = STABILITY_ORDER[va.stability] ?? 4;
  const sb = STABILITY_ORDER[vb.stability] ?? 4;
  if (sa !== sb) return sa < sb ? -1 : 1;

  if (va.stabilityNumber !== vb.stabilityNumber) {
    return va.stabilityNumber < vb.stabilityNumber ? -1 : 1;
  }
  return 0;
}

export function isComposerPrerelease(version: string): boolean {
  const parsed = parse(version);
  if (!parsed) return false;
  const rank = STABILITY_ORDER[parsed.stability] ?? 4;
  return rank < 4;
}

export function maxComposer(candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const stable = candidates.filter(
    (candidate) => !isComposerPrerelease(candidate),
  );
  const pool = stable.length > 0 ? stable : candidates;
  return [...pool].sort(compareComposer)[pool.length - 1];
}

/**
 * Normalises a Composer constraint into something the `semver` package can
 * evaluate. Composer's `^`, `~`, `>=` and `||` already match semver; the parts
 * that differ are `v` prefixes, `.*` wildcards and four-segment versions.
 *
 * Returns null when the constraint cannot be represented (e.g. `dev-main`),
 * which callers treat as "cannot compute a wanted version".
 */
export function composerConstraintToSemver(constraint: string): string | null {
  const trimmed = constraint.trim();
  if (trimmed === '' || trimmed === '*') return '*';
  // Branch constraints have no ordering we can reason about.
  if (/^dev-/i.test(trimmed) || /-dev$/i.test(trimmed)) return null;

  // node-semver has no concept of a fourth segment. Dropping a `.0` build
  // number is lossless, but dropping a nonzero one (`1.2.3.4` vs `1.2.3.5`)
  // would silently make two distinct builds compare equal — better to say
  // the constraint cannot be evaluated than to guess and be wrong.
  let droppedPrecision = false;
  const normalised = trimmed
    .replace(/\bv(\d)/gi, '$1')
    .replace(
      /(\d+)\.(\d+)\.(\d+)\.(\d+)/g,
      (_full, major, minor, patch, build) => {
        if (build !== '0') droppedPrecision = true;
        return `${major}.${minor}.${patch}`;
      },
    )
    .replace(/\s*\|\|\s*/g, ' || ')
    .replace(/\s+-\s+/g, ' - ');

  if (droppedPrecision) return null;
  return normalised;
}
