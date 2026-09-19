/**
 * Maven's version ordering, per the ComparableVersion algorithm.
 *
 * Maven does not use semver. Its rules are unusual enough to be worth spelling
 * out, because getting them wrong silently shows the wrong "latest":
 *   - Versions split into items on `.`, `-`, and digit/letter boundaries.
 *   - Known qualifiers have a fixed order: alpha < beta < milestone < rc <
 *     snapshot < (release) < sp.
 *   - The empty string represents a final release, so `1.0` > `1.0-SNAPSHOT`.
 *   - Trailing "null" items are trimmed, making `1.0` and `1.0.0` equal.
 */

const QUALIFIER_ORDER: Record<string, number> = {
  alpha: 0,
  a: 0,
  beta: 1,
  b: 1,
  milestone: 2,
  m: 2,
  rc: 3,
  cr: 3,
  snapshot: 4,
  '': 5, // a plain release
  ga: 5,
  final: 5,
  release: 5,
  sp: 6,
};

type Item =
  | { kind: 'number'; value: number }
  | { kind: 'qualifier'; value: string };

function tokenize(version: string): Item[] {
  const items: Item[] = [];
  let buffer = '';
  let bufferIsDigit: boolean | undefined;

  const flush = () => {
    if (buffer === '') return;
    if (bufferIsDigit) {
      items.push({ kind: 'number', value: Number(buffer) });
    } else {
      items.push({ kind: 'qualifier', value: buffer.toLowerCase() });
    }
    buffer = '';
    bufferIsDigit = undefined;
  };

  for (const char of version.trim()) {
    if (char === '.' || char === '-') {
      flush();
      continue;
    }
    const isDigit = char >= '0' && char <= '9';
    // A digit/letter transition starts a new item: "1alpha" -> [1, alpha].
    if (bufferIsDigit !== undefined && isDigit !== bufferIsDigit) {
      flush();
    }
    bufferIsDigit = isDigit;
    buffer += char;
  }
  flush();

  return trimNulls(items);
}

/**
 * Drops trailing items that mean "nothing", so `1.0.0`, `1.0` and `1.0-ga`
 * compare as equal.
 */
function trimNulls(items: Item[]): Item[] {
  const result = [...items];
  while (result.length > 0) {
    const last = result[result.length - 1];
    const isNull =
      (last.kind === 'number' && last.value === 0) ||
      (last.kind === 'qualifier' && QUALIFIER_ORDER[last.value] === 5);
    if (!isNull) break;
    result.pop();
  }
  return result;
}

function compareItems(a: Item | undefined, b: Item | undefined): number {
  // A missing item is a "null" item: numeric 0, or a plain release qualifier.
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) {
    return b?.kind === 'number'
      ? b?.value === 0
        ? 0
        : -1
      : -compareItems(b, undefined);
  }
  if (b === undefined) {
    if (a.kind === 'number') return a.value === 0 ? 0 : 1;
    const rank = QUALIFIER_ORDER[a.value];
    if (rank === undefined) return 1; // unknown qualifiers outrank releases
    return rank === 5 ? 0 : rank > 5 ? 1 : -1;
  }

  // Numbers always outrank qualifiers.
  if (a.kind === 'number' && b.kind === 'number') {
    return a.value === b.value ? 0 : a.value < b.value ? -1 : 1;
  }
  if (a.kind === 'number') return 1;
  if (b.kind === 'number') return -1;

  const ra = QUALIFIER_ORDER[a.value];
  const rb = QUALIFIER_ORDER[b.value];
  // Unknown qualifiers sort after known ones, then alphabetically.
  if (ra === undefined && rb === undefined)
    return a.value.localeCompare(b.value);
  if (ra === undefined) return 1;
  if (rb === undefined) return -1;
  return ra === rb ? 0 : ra < rb ? -1 : 1;
}

export function compareMaven(a: string, b: string): number {
  const itemsA = tokenize(a);
  const itemsB = tokenize(b);
  const length = Math.max(itemsA.length, itemsB.length);
  for (let i = 0; i < length; i++) {
    const cmp = compareItems(itemsA[i], itemsB[i]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function isMavenPrerelease(version: string): boolean {
  const lower = version.toLowerCase();
  return (
    lower.includes('snapshot') ||
    lower.includes('alpha') ||
    lower.includes('beta') ||
    /-m\d/.test(lower) ||
    /-rc/.test(lower) ||
    /-cr/.test(lower)
  );
}

/** Highest stable version, falling back to prereleases only if that is all there is. */
export function maxMaven(candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const stable = candidates.filter(
    (candidate) => !isMavenPrerelease(candidate),
  );
  const pool = stable.length > 0 ? stable : candidates;
  return [...pool].sort(compareMaven)[pool.length - 1];
}
