/**
 * Locating a package's declaration inside a manifest.
 *
 * Used by "Open manifest" to put the caret on the line the user meant. Kept
 * free of any `vscode` import so it can be tested against real manifest text
 * from all seven formats rather than through the editor.
 */

/**
 * Returns the offset where `packageName` is declared, or -1.
 *
 * A plain `indexOf` lands on the first textual occurrence, which across seven
 * manifest formats is very often the wrong one — a repository URL, a comment,
 * or a longer name that merely starts with this one (`react` inside
 * `react-dom`). The delimited forms below cover how each supported format
 * writes a declaration; the bare search remains only as a last resort, since
 * landing somewhere in the right file still beats landing at line 1.
 */
export function findDeclaration(text: string, packageName: string): number {
  const patterns = patternsFor(packageName);

  for (const pattern of patterns) {
    // Compiled patterns are reused across calls, and `exec` on a /g-less
    // regex ignores `lastIndex`, so there is no cursor to reset here.
    const match = pattern.exec(text);
    if (match) {
      // Point at the name itself rather than at whatever delimiter opened it.
      const offset = match[0].indexOf(packageName);
      return offset >= 0 ? match.index + offset : match.index;
    }
  }

  return text.indexOf(packageName);
}

/**
 * The compiled patterns for one package name, cached across calls.
 *
 * Every call used to build five `RegExp`s from scratch. That is fine once, but
 * the callers are `buildLensSpecs` and `buildDiagnosticSpecs`, which call this
 * once per dependency — and `provideCodeLenses` re-runs them whenever the
 * document changes. A manifest with a few hundred dependencies therefore
 * recompiled a couple of thousand regexes on every keystroke, on the extension
 * host's single thread. The names are stable between calls; the compiled form
 * is the part worth keeping.
 */
const patternCache = new Map<string, RegExp[]>();

/**
 * Bounds the cache. Comfortably above the largest single manifest, so the
 * eviction path only engages across a workspace far bigger than one editor
 * view — and a cache that can grow without limit is not a cache.
 */
const MAX_CACHED_PATTERNS = 4000;

function patternsFor(packageName: string): RegExp[] {
  const cached = patternCache.get(packageName);
  if (cached) return cached;

  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    // JSON keys: "name": — package.json, composer.json.
    new RegExp(`"${escaped}"\\s*:`),
    // TOML keys: name = , "name" = , [tool.poetry.dependencies] entries.
    new RegExp(`^\\s*["']?${escaped}["']?\\s*=`, 'm'),
    // Maven coordinates, where the artifact is the second half.
    new RegExp(
      `<artifactId>\\s*${escaped.split(':').pop() ?? escaped}\\s*</artifactId>`,
    ),
    // Gradle and version catalogs: 'group:artifact:version'.
    new RegExp(`["']${escaped}[:"']`),
    // requirements.txt and go.mod: a whole word at the start of a line.
    new RegExp(`^\\s*${escaped}(?=[\\s=<>!~^@;[,]|$)`, 'm'),
  ];

  if (patternCache.size >= MAX_CACHED_PATTERNS) {
    // Insertion order is eviction order; one at a time is enough to hold the
    // bound, and this only runs once the cache is already full.
    const oldest = patternCache.keys().next();
    if (!oldest.done) patternCache.delete(oldest.value);
  }
  patternCache.set(packageName, patterns);
  return patterns;
}
