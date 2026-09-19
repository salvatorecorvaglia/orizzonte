/**
 * Finds the lockfile that actually governs a manifest.
 *
 * A workspace member has no lockfile of its own — in pnpm, npm, yarn and Cargo
 * workspaces the single lockfile sits at the root and resolves the whole tree.
 * Looking only in the manifest's own directory therefore finds nothing for every
 * member of every monorepo, which is the layout this extension advertises
 * support for: resolved versions silently degrade to guesses derived from the
 * declared constraint, the duplicate-version and diff checks report "no lockfile
 * to check", and "why is this installed" falls back to the registry.
 *
 * So the search walks up. The nearest lockfile wins, because a member that does
 * have its own is not governed by the root's; and the walk stops at the
 * workspace folder, because a lockfile outside the workspace describes a project
 * the user did not open.
 */

import * as path from 'node:path';

/** Reads a file, resolving to null/undefined when it is not there. */
export type ReadFile = (
  absolutePath: string,
) => Promise<string | null | undefined>;

/**
 * A scan-scoped memo for the walk.
 *
 * Now that a member resolves its root's lockfile, every member of a workspace
 * resolves the *same* file — so without this, a 50-package monorepo read and
 * parsed one multi-megabyte `pnpm-lock.yaml` fifty times over. The store is
 * created per scan and thrown away with it, which is what keeps a memo of file
 * contents from becoming a cache that can go stale.
 *
 * `namespace` separates callers that parse one file into different shapes — the
 * providers want resolved versions, `depGraph` wants edges — so they cannot
 * read each other's entries back.
 */
export interface LockfileMemo {
  store: Map<string, unknown>;
  namespace: string;
}

export interface FoundLockfile<T> {
  /** The candidate that matched, so the caller knows which format it read. */
  candidate: T;
  /** Absolute path of the lockfile that matched. */
  path: string;
  /** Its contents. */
  text: string;
}

/**
 * The nearest ancestor directory (starting with `startDir` itself) holding one
 * of `candidates`, along with that file's contents.
 *
 * Candidate order is the tie-break *within* one directory — a project with both
 * a `package-lock.json` and a `yarn.lock` is read as whichever the caller listed
 * first. Proximity wins *across* directories, so a member's own lockfile always
 * beats the root's.
 *
 * The content is returned rather than just the path because every caller parses
 * it immediately, and because it lets the same walk run against a Git ref (where
 * "does this path exist" is only answerable by trying to read it).
 */
export async function findLockfile<T extends { file: string }>(
  startDir: string,
  candidates: readonly T[],
  read: ReadFile,
  stopAt?: string,
): Promise<FoundLockfile<T> | undefined> {
  return selectLockfile(
    startDir,
    candidates,
    read,
    stopAt,
    (candidate, text, at) => ({
      candidate,
      path: at,
      text,
    }),
  );
}

/**
 * The same walk, but the caller decides whether a file it found is usable.
 *
 * `select` returning undefined means "this one did not work out" and the walk
 * carries on — to the next candidate in the same directory, then upward. That
 * fallback is the point: a project holding both a corrupt `package-lock.json`
 * and a healthy `yarn.lock` should be read from the yarn file rather than
 * reported as having no lockfile at all, and only the caller doing the parsing
 * can tell the two apart.
 */
export async function selectLockfile<T extends { file: string }, R>(
  startDir: string,
  candidates: readonly T[],
  read: ReadFile,
  stopAt: string | undefined,
  select: (candidate: T, text: string, absolutePath: string) => R | undefined,
  memo?: LockfileMemo,
): Promise<R | undefined> {
  if (candidates.length === 0) return undefined;

  const boundary = stopAt ? normalizeDir(stopAt) : undefined;
  let dir = normalizeDir(startDir);

  // A manifest outside the workspace folder has no boundary to walk within;
  // searching upward from it would wander into the user's home directory.
  if (boundary && !isWithin(dir, boundary)) return undefined;

  for (;;) {
    for (const candidate of candidates) {
      const absolutePath = path.join(dir, candidate.file);
      const memoKey = memo && `${memo.namespace}\u0000${absolutePath}`;

      // A remembered miss matters as much as a remembered hit: every member of
      // a workspace walks through the same empty directories on its way up.
      if (memoKey !== undefined && memo?.store.has(memoKey)) {
        const cached = memo.store.get(memoKey) as R | undefined;
        if (cached !== undefined) return cached;
        continue;
      }

      const text = await read(absolutePath);
      const selected = text ? select(candidate, text, absolutePath) : undefined;
      if (memoKey !== undefined) memo?.store.set(memoKey, selected);
      if (selected !== undefined) return selected;
    }

    if (boundary && dir === boundary) return undefined;

    const parent = path.dirname(dir);
    // `path.dirname` of a filesystem root returns the root itself.
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Trims trailing separators so two spellings of one directory compare equal.
 *
 * Deliberately *not* `path.resolve`: these paths already arrive absolute (from
 * `Uri.fsPath`, or from a test's in-memory tree), and on Windows `resolve`
 * would rewrite a rooted path like `/ws` into `C:\\ws` — turning every
 * subsequent lookup into a path the caller never stored.
 */
function normalizeDir(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  return trimmed === '' ? dir : trimmed;
}

/** True when `dir` is `root` or sits beneath it. */
function isWithin(dir: string, root: string): boolean {
  if (dir === root) return true;
  const relative = path.relative(root, dir);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}
