/**
 * PEP 503 name normalisation: lowercase, runs of `-_.` collapse to a hyphen.
 *
 * Lives in `core/` rather than with the Python provider because the lockfile
 * readers and the dependency graph need it too, and the provider itself reads
 * lockfiles through those readers — keeping it there made `core` import a
 * provider that imports `core`.
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}
