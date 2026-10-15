/**
 * What a lockfile reader produces.
 *
 * Every supported format answers the same two questions — who requires whom,
 * and what version did each package resolve to — so both shapes are declared
 * once here and every format module returns them.
 */

/** name -> the names it directly requires. */
export type ForwardGraph = Map<string, string[]>;

/** name -> every version the lockfile resolves it at. */
export type VersionMap = Map<string, Set<string>>;

/**
 * What a lockfile says a project resolved each package to.
 *
 * Three levels of certainty, most certain first — a format provides what it
 * records:
 *   - `importer`: the exact answer for one workspace member (npm's per-member
 *     `node_modules`, pnpm's `importers:`). A monorepo whose members pin
 *     different versions of one package cannot be answered any other way.
 *   - `descriptors`: `name@range` to the version it resolved (yarn.lock
 *     headers), which picks the right copy when several are installed.
 *   - `all`: every copy of every package, in file order, the preferred one
 *     first. The last resort, narrowed by the declared range when there is
 *     more than one.
 */
export interface ResolvedIndex {
  all: Map<string, string[]>;
  /**
   * @param importer The manifest's directory relative to the lockfile's,
   *   `/`-separated, `''` for the lockfile's own directory.
   */
  importer?(importer: string): Map<string, string> | undefined;
  descriptors?: Map<string, string>;
}

/** Appends a resolved version, keeping first-seen order and no repeats. */
export function addResolved(
  all: Map<string, string[]>,
  name: string,
  version: string,
): void {
  const list = all.get(name);
  if (!list) all.set(name, [version]);
  else if (!list.includes(version)) list.push(version);
}

/**
 * One lockfile format.
 *
 * Both readers are part of the same interface on purpose. They used to be two
 * unrelated functions per format sitting in one long file, and the pair for
 * yarn silently disagreed: the edge reader understood Yarn Berry's `version:`
 * line and the version reader did not, so Berry projects reported no duplicate
 * versions at all. Declaring them together is what makes "these two must agree
 * about this file" a property of the code rather than of whoever edits it.
 */
export interface LockfileReader {
  /** The file this reader parses, relative to the manifest's directory. */
  readonly file: string;
  /** Dependency edges, or undefined when the file cannot be understood. */
  edges(text: string): ForwardGraph | undefined;
  /** Resolved versions, or undefined when the file cannot be understood. */
  versions(text: string): VersionMap | undefined;
  /**
   * What each package resolved to, per workspace member where the format
   * records it; undefined when the file cannot be understood.
   */
  resolved(text: string): ResolvedIndex | undefined;
}

/** Records one resolved version, creating the set on first sight. */
export function addVersion(
  map: VersionMap,
  name: string,
  version: string,
): void {
  const set = map.get(name);
  if (set) set.add(version);
  else map.set(name, new Set([version]));
}

/** Unions `children` into `name`'s edges; a package can appear more than once. */
export function addEdges(
  graph: ForwardGraph,
  name: string,
  children: string[],
): void {
  const existing = graph.get(name);
  graph.set(
    name,
    existing ? [...new Set([...existing, ...children])] : children,
  );
}
