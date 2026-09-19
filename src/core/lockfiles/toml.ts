/**
 * The `[[package]]` array-of-tables shape Cargo.lock, poetry.lock and uv.lock
 * all use, and the field reads every one of them needs.
 */

/**
 * Splits a TOML document into its `[[package]]` block bodies.
 *
 * Splitting on the header text alone would silently drop the first package in
 * a file that opens with `[[package]]` and no preamble, so the boundaries are
 * taken from the match positions instead.
 */
export function splitTomlPackageBlocks(text: string): string[] {
  const headers = [...text.matchAll(/(?:^|\n)\[\[package\]\][^\n]*\n/g)];
  return headers.map((header, index) => {
    const start = (header.index ?? 0) + header[0].length;
    const end =
      index + 1 < headers.length
        ? (headers[index + 1].index ?? text.length)
        : text.length;
    return text.slice(start, end);
  });
}

/** A quoted top-level string field, e.g. `name = "tokio"`. */
export function tomlField(block: string, field: string): string | undefined {
  return new RegExp(`^${field}\\s*=\\s*"([^"]+)"`, 'm').exec(block)?.[1];
}
