/**
 * Watches manifests and lockfiles, debounced.
 *
 * Lockfiles matter as much as manifests here: watching them is what makes the
 * panel refresh itself after an install finishes, whether Orizzonte started it
 * or the user typed the command themselves.
 */

import * as vscode from 'vscode';
import { allWatchedFileNames } from '../providers/registry.js';

const DEBOUNCE_MS = 300;

export class ManifestWatcher implements vscode.Disposable {
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly onChange: () => void) {
    // `allWatchedFileNames` now carries each provider's own glob patterns, so
    // this no longer appends Python's `requirements-*.txt` by hand.
    const names = allWatchedFileNames();
    // A single brace pattern keeps this to one watcher rather than a dozen.
    const pattern = `**/{${names.join(',')}}`;

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange((uri) => this.schedule(uri));
    watcher.onDidCreate((uri) => this.schedule(uri));
    watcher.onDidDelete((uri) => this.schedule(uri));
    this.watchers.push(watcher);
  }

  /**
   * Coalesces bursts — an install rewrites the manifest and lockfile together.
   *
   * Paths the scan would ignore are dropped before the debounce rather than
   * after: `npm install` writes thousands of `package.json` files under
   * `node_modules`, none of which change what Orizzonte displays.
   */
  private schedule(uri: vscode.Uri): void {
    if (isExcluded(uri)) return;

    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onChange();
    }, DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
  }
}

/**
 * Whether a changed file sits somewhere `orizzonte.excludeGlobs` rules out.
 *
 * Matched with a plain segment test rather than a glob engine: the setting's
 * entries are directory patterns (`**​/node_modules/**`), and the only question
 * that matters is whether the path runs through one of those directories.
 */
export function isExcluded(uri: vscode.Uri): boolean {
  const segments = uri.path.split('/');
  const excluded = excludedDirectories();
  return segments.some((segment) => excluded.has(segment));
}

/**
 * The directory names `orizzonte.excludeGlobs` rules out, with the parse cached.
 *
 * This runs once per filesystem event, and `npm install` produces thousands of
 * them in a burst — re-running a regex over every configured glob each time is
 * work repeated for an answer that only changes when the setting does.
 *
 * The configuration itself is still read every call, and the cache is keyed on
 * what that read returned. Caching the *read* as well would have been faster
 * still, but it would need invalidating from somewhere — and a module-level
 * cache whose freshness depends on some class having been constructed is one
 * that goes stale for every caller that does not construct it. Reading a
 * value VS Code already holds in memory and comparing a handful of short
 * strings is not the cost this exists to avoid.
 */
let cachedGlobKey: string | undefined;
let cachedExcludedDirectories = new Set<string>();

function excludedDirectories(): Set<string> {
  const globs = vscode.workspace
    .getConfiguration('orizzonte')
    .get<string[]>('excludeGlobs', []);

  // `\0` cannot appear in a glob, so this cannot collide across different
  // lists that happen to concatenate alike.
  const key = globs.join('\0');
  if (key === cachedGlobKey) return cachedExcludedDirectories;

  const directories = new Set<string>();
  for (const glob of globs) {
    // Anything that is not a simple `**/dir/**` pattern is left to the scan,
    // which has the real glob engine.
    const directory = /^\*\*\/(.+?)\/\*\*$/.exec(glob)?.[1];
    if (directory !== undefined) directories.add(directory);
  }

  cachedGlobKey = key;
  cachedExcludedDirectories = directories;
  return directories;
}
