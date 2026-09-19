/**
 * "Why is this installed?" — reverse dependency resolution.
 *
 * Accuracy comes first, so a local lockfile is always preferred: it describes
 * the tree that actually exists on disk. deps.dev is the fallback for projects
 * with no lockfile (a fresh clone, or Maven/Gradle), where the answer is
 * necessarily "what a resolver would produce" rather than "what you have".
 */

import * as path from 'node:path';
import type { ProviderContext } from '../providers/provider.js';
// The one PEP 503 implementation. A second copy lived here to avoid depending
// on a provider, but this file already imports the provider registry, and two
// normalisers that must agree exactly are two that can silently stop agreeing.
import { normalizeName as normalizePythonName } from '../providers/python/index.js';
import { providerFor } from '../providers/registry.js';
import {
  type ForwardGraph,
  lockfilesFor,
  NPM_ROOT,
  type VersionMap,
} from './lockfiles/index.js';
import {
  type LockfileMemo,
  type ReadFile,
  selectLockfile,
} from './lockfiles/resolve.js';
import type {
  Dependency,
  DependencyDiffEntry,
  DependencyDiffResult,
  DepNode,
  DuplicateVersionGroup,
  DuplicateVersionResult,
  Ecosystem,
} from './types.js';

const MAX_DEPTH = 8;

/**
 * How many distinct chains the reverse walk may collect before giving up.
 *
 * Well past what anyone reads, and far below what a dense lockfile can produce.
 */
const MAX_CHAINS = 200;

/**
 * The same budget as `MAX_CHAINS`, for the registry walk rather than the
 * lockfile one. Expanding each node once already bounds that walk by the size
 * of the graph deps.dev returned; this bounds it by a number this file
 * controls, so a graph far larger than anything worth reading cannot occupy
 * the extension host regardless.
 */
const MAX_REGISTRY_NODES = 2000;

/** Children shown under one package before the rest are elided. */
const MAX_REGISTRY_CHILDREN = 50;

export interface WhyResult {
  roots: DepNode[];
  source: 'lockfile' | 'registry';
}

/**
 * Builds the chain(s) of dependencies that lead to `target`.
 *
 * The returned tree is oriented from the direct dependency downwards, which is
 * how people read it: "eslint → chalk → ansi-styles".
 */
export async function explainDependency(
  target: Dependency,
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<WhyResult> {
  const forward = await buildForwardGraph(target, ctx);
  // Reading and parsing a large lockfile is not instant; a caller that has
  // moved on should not pay for the walk as well.
  if (signal?.aborted) return { roots: [], source: 'lockfile' };

  if (forward && forward.size > 0) {
    // The lookup key must go through the same normalisation the graph keys did,
    // or a manifest that declares `Jinja2` will never match a lockfile that
    // records `jinja2`.
    const roots = tracePaths(forward, graphKey(target.name, target.ecosystem));
    if (roots.length > 0) {
      return { roots, source: 'lockfile' };
    }
  }

  const registryTree = await buildFromDepsDev(target, ctx, signal);
  return { roots: registryTree, source: 'registry' };
}

/** Normalises a package name into the form its ecosystem's graph is keyed by. */
function graphKey(name: string, ecosystem: Ecosystem): string {
  return ecosystem === 'python' ? normalizePythonName(name) : name;
}

/**
 * The dependency edges from whichever lockfile the project has.
 *
 * Ecosystems with no such file — Go, Maven, Gradle — have no readers
 * registered and fall through to the registry path, which does carry edges.
 * See `lockfiles/index.ts` for why each is left out.
 */
async function buildForwardGraph(
  target: Dependency,
  ctx: ProviderContext,
): Promise<ForwardGraph | undefined> {
  const dir = path.dirname(target.manifestPath);

  // An unreadable or edge-less lockfile is not the end of the search: the walk
  // carries on to the next format and then upward, exactly as it did when this
  // looked in one directory only.
  return selectLockfile(
    dir,
    lockfilesFor(target.ecosystem),
    (absolutePath) => ctx.readFile(absolutePath),
    ctx.workspaceRootFor(target.manifestPath),
    (lockfile, text) => {
      const graph = lockfile.edges(text);
      return graph && graph.size > 0 ? graph : undefined;
    },
  );
}

/**
 * Walks the graph backwards from `target` to every package that requires it,
 * then returns those chains root-first.
 */
function tracePaths(graph: ForwardGraph, target: string): DepNode[] {
  // Invert once; a package can have many dependents.
  const reverse = new Map<string, string[]>();
  for (const [parent, children] of graph) {
    for (const child of children) {
      const list = reverse.get(child);
      if (list) list.push(parent);
      else reverse.set(child, [parent]);
    }
  }

  if (!reverse.has(target)) return [];

  const chains: string[][] = [];
  /** True when the budget stopped the walk, so the UI can say the tree is partial. */
  let truncated = false;

  /*
   * Depth-first walk up the reverse edges, collecting each distinct chain.
   *
   * The budget is checked *inside* the recursion, not applied to the finished
   * list. This enumerates simple paths, so its cost is the product of the
   * branching factors rather than their sum: a widely-depended-on package in a
   * real lockfile can have tens of parents at each of eight levels, and
   * collecting every path before truncating to 40 would occupy the extension
   * host — which is single-threaded, and shared with the editor — for minutes.
   */
  const walk = (name: string, chain: string[], visited: Set<string>) => {
    if (chains.length >= MAX_CHAINS) {
      truncated = true;
      return;
    }
    if (chain.length > MAX_DEPTH) {
      chains.push([...chain]);
      truncated = true;
      return;
    }
    const parents = reverse.get(name);
    if (!parents || parents.length === 0 || name === NPM_ROOT) {
      chains.push([...chain]);
      return;
    }
    // When every parent is already on the current path we are inside a cycle.
    // The chain built so far is still the honest answer, so record it rather
    // than returning nothing and making a cyclic graph look like no graph.
    let advanced = false;

    for (const parent of parents) {
      if (chains.length >= MAX_CHAINS) {
        truncated = true;
        return;
      }
      if (visited.has(parent)) continue; // cycle guard
      advanced = true;
      if (parent === NPM_ROOT) {
        chains.push([...chain]);
        continue;
      }
      visited.add(parent);
      walk(parent, [parent, ...chain], visited);
      visited.delete(parent);
    }

    if (!advanced) {
      chains.push([...chain]);
    }
  };

  walk(target, [target], new Set([target]));

  // Fold the chains into a tree so shared prefixes render once.
  const roots: DepNode[] = [];
  for (const chain of chains) {
    let level = roots;
    let node: DepNode | undefined;
    for (const name of chain) {
      node = level.find((candidate) => candidate.name === name);
      if (!node) {
        node = { name, children: [] };
        level.push(node);
      }
      level = node.children;
    }
    // Mark the leaf of a chain the budget cut short, so the drawer can show
    // that the answer continues past what is displayed.
    if (truncated && node && chain.length > MAX_DEPTH) {
      node.truncated = true;
    }
  }

  return roots;
}

interface DepsDevResponse {
  nodes: Array<{
    versionKey: { system: string; name: string; version: string };
    relation: 'SELF' | 'DIRECT' | 'INDIRECT';
  }>;
  edges: Array<{ fromNode: number; toNode: number; requirement?: string }>;
}

/**
 * Fallback path: ask deps.dev for the resolved graph of the *package itself*
 * and show what it pulls in. This answers "what does this bring with it",
 * which is the useful question when no local lockfile exists.
 */
async function buildFromDepsDev(
  target: Dependency,
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<DepNode[]> {
  const provider = providerFor(target.ecosystem);
  const system = provider.depsDevSystem;
  const version = target.installed ?? target.latest;
  if (!system || !version) return [];

  // deps.dev takes the package name as one URL-encoded path segment; Maven
  // coordinates keep their colon, encoded as %3A.
  const url =
    `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(target.name)}` +
    `/versions/${encodeURIComponent(version)}:dependencies`;

  try {
    const response = await ctx.http.getJson<DepsDevResponse>(url, { signal });

    // The response is an adjacency list, which may contain cycles — Go and
    // Maven graphs routinely do. Materialising it by sharing child arrays
    // would reproduce those cycles as a cyclic *object*, and `postMessage`
    // JSON-serializes: one `Converting circular structure to JSON` and the
    // whole drawer silently stays empty. So the tree is expanded by explicit
    // traversal, with each node expanded at most once.
    const edgesFrom = new Map<number, Array<{ to: number; range?: string }>>();
    for (const edge of response.edges) {
      if (edge.fromNode === edge.toNode) continue;
      const list = edgesFrom.get(edge.fromNode);
      if (list) list.push({ to: edge.toNode, range: edge.requirement });
      else
        edgesFrom.set(edge.fromNode, [
          { to: edge.toNode, range: edge.requirement },
        ]);
    }

    /*
     * Each node is expanded once, tracked in `expanded`; every later reference
     * to it becomes a named, truncated leaf.
     *
     * This used to track only the *current path*, which cuts cycles but does
     * nothing about diamonds — and a resolved dependency graph is mostly
     * diamonds, because that is what it means for packages to share a
     * dependency. Re-expanding on every distinct path made the cost the
     * product of the branching factors rather than their sum: a 4-wide,
     * 8-deep graph of 33 nodes materialised 87,381 of them, and this runs on
     * the extension host's single thread, which is also the one drawing the
     * editor. The result was then handed to `postMessage` to serialise.
     *
     * Expanding once is also the better answer to show: the drawer asks "what
     * does this bring with it", and repeating one subtree under every package
     * that shares it buries that answer rather than making it clearer.
     * Cycles fall out of the same rule — a back edge points at something
     * already expanded — so they need no separate case.
     */
    const expanded = new Set<number>();
    /** A hard ceiling, in case a future change reintroduces a repeat path. */
    let budget = MAX_REGISTRY_NODES;

    const reference = (index: number, range?: string): DepNode => ({
      name: response.nodes[index].versionKey.name,
      version: response.nodes[index].versionKey.version,
      requestedRange: range,
      children: [],
      truncated: true,
    });

    const expand = (index: number, depth: number): DepNode => {
      const source = response.nodes[index];
      const node: DepNode = {
        name: source.versionKey.name,
        version: source.versionKey.version,
        children: [],
      };

      if (depth >= MAX_DEPTH) {
        node.truncated = true;
        return node;
      }

      for (const edge of edgesFrom.get(index) ?? []) {
        if (!response.nodes[edge.to]) continue;
        if (node.children.length >= MAX_REGISTRY_CHILDREN || budget <= 0) {
          node.truncated = true;
          break;
        }

        // Already shown somewhere in this tree — name it and stop.
        if (expanded.has(edge.to)) {
          node.children.push(reference(edge.to, edge.range));
          budget--;
          continue;
        }

        expanded.add(edge.to);
        budget--;
        const child = expand(edge.to, depth + 1);
        child.requestedRange = edge.range;
        node.children.push(child);
      }

      return node;
    };

    const selfIndex = response.nodes.findIndex(
      (node) => node.relation === 'SELF',
    );
    if (selfIndex < 0) return [];
    expanded.add(selfIndex);
    return [expand(selfIndex, 0)];
  } catch {
    return [];
  }
}

/**
 * Packages resolved at more than one version at once within a single
 * project — every extra copy adds to install size, and which one a given
 * import actually resolves to can depend on where in the tree it was
 * required from. Read from whichever lockfile exists, the same per-ecosystem
 * discovery `explainDependency` uses — deliberately a second, independent
 * pass over that file rather than a shared one, so this stays free to change
 * without touching the "why" walk's tested behaviour.
 *
 * Go is left unchecked even though `go.sum` lists every module@version pair:
 * it records hashes for every version that ever appeared anywhere in the
 * module graph's history, not the versions minimal version selection
 * actually chose, so nearly every module would read as "duplicated" whether
 * or not the build contains more than one copy. Maven and Gradle have no
 * lockfile in the general case, matching `buildForwardGraph`.
 */
export async function findDuplicateVersions(
  manifestPath: string,
  ecosystem: Ecosystem,
  ctx: ProviderContext,
): Promise<DuplicateVersionResult> {
  const dir = path.dirname(manifestPath);
  const versions = await collectVersions(dir, ecosystem, ctx);
  if (!versions) return { checked: false, groups: [] };

  const groups: DuplicateVersionGroup[] = [];
  for (const [name, versionSet] of versions) {
    if (versionSet.size > 1) {
      groups.push({ name, versions: [...versionSet].sort() });
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));

  return { checked: true, groups };
}

async function collectVersions(
  dir: string,
  ecosystem: Ecosystem,
  ctx: ProviderContext,
): Promise<VersionMap | undefined> {
  return collectVersionsFrom(
    dir,
    ecosystem,
    (absolutePath) => ctx.readFile(absolutePath),
    ctx.workspaceRootFor(dir),
    ctx.lockfileMemo && { store: ctx.lockfileMemo, namespace: 'versions' },
  );
}

/**
 * The same lookup as `collectVersions`, but through a caller-supplied reader
 * instead of `ProviderContext.readFile` — what lets `diffLockfileVersions`'s
 * caller read a lockfile out of Git history instead of off disk, reusing
 * every format's parser rather than a second copy of each.
 */
export async function collectVersionsFrom(
  dir: string,
  ecosystem: Ecosystem,
  readFile: ReadFile,
  /**
   * Where the upward walk stops. Omitted only by callers with no workspace to
   * bound it — the walk then gives up at the filesystem root, which is safe
   * but will not find a root lockfile above an unopened folder.
   */
  stopAt?: string,
  /**
   * Shared across one workspace-wide sweep, so the single lockfile every
   * member resolves is read and parsed once rather than once per project.
   */
  memo?: LockfileMemo,
): Promise<VersionMap | undefined> {
  return selectLockfile(
    dir,
    lockfilesFor(ecosystem),
    readFile,
    stopAt,
    (lockfile, text) => lockfile.versions(text),
    memo,
  );
}

/**
 * Compares two lockfile version maps — typically "this ref" vs "the working
 * tree" — and reports what changed. `undefined` on either side means the
 * lockfile could not be read there (missing, or an unsupported ecosystem),
 * distinguished from "read and found equal" the same way
 * `DuplicateVersionResult.checked` does.
 */
export function diffLockfileVersions(
  before: VersionMap | undefined,
  after: VersionMap | undefined,
): DependencyDiffResult {
  if (!before || !after) {
    return { checked: false, added: [], removed: [], changed: [] };
  }

  const added: DependencyDiffEntry[] = [];
  const removed: DependencyDiffEntry[] = [];
  const changed: DependencyDiffEntry[] = [];

  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of names) {
    const beforeVersions = before.get(name);
    const afterVersions = after.get(name);

    if (!beforeVersions) {
      added.push({
        name,
        before: undefined,
        after: [...afterVersions!].sort(),
      });
      continue;
    }
    if (!afterVersions) {
      removed.push({
        name,
        before: [...beforeVersions].sort(),
        after: undefined,
      });
      continue;
    }

    const beforeSorted = [...beforeVersions].sort();
    const afterSorted = [...afterVersions].sort();
    if (beforeSorted.join(',') !== afterSorted.join(',')) {
      changed.push({ name, before: beforeSorted, after: afterSorted });
    }
  }

  const byName = (a: DependencyDiffEntry, b: DependencyDiffEntry) =>
    a.name.localeCompare(b.name);
  added.sort(byName);
  removed.sort(byName);
  changed.sort(byName);

  return { checked: true, added, removed, changed };
}
