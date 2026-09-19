/**
 * A ProviderContext backed by an in-memory filesystem.
 *
 * Providers never import `vscode`, which is exactly what lets these tests run
 * as plain Node with no editor and no network.
 */

import { type Memento, TtlCache } from '../../src/core/cache.js';
import type { HttpClient } from '../../src/core/http.js';
import type { ProviderContext } from '../../src/providers/provider.js';

class MapMemento implements Memento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

export function makeContext(
  files: Record<string, string> = {},
  /**
   * The workspace folder the fake reports for every path, which is what bounds
   * the upward lockfile walk. Tests that exercise a monorepo pass their root;
   * the rest never walk far enough for it to matter.
   */
  workspaceRoot?: string,
): ProviderContext {
  const http = {
    getJson: () => Promise.reject(new Error('network disabled in tests')),
    postJson: () => Promise.reject(new Error('network disabled in tests')),
    getText: () => Promise.reject(new Error('network disabled in tests')),
    setContactEmail: () => undefined,
  } as unknown as HttpClient;

  const normalizePath = (p: string) => p.replace(/\\/g, '/');

  const normalizedFiles: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) {
    normalizedFiles[normalizePath(k)] = v;
  }

  return {
    http,
    cache: new TtlCache(new MapMemento()),
    readFile: (absolutePath: string) =>
      Promise.resolve(normalizedFiles[normalizePath(absolutePath)] ?? null),
    exists: (absolutePath: string) =>
      Promise.resolve(
        Object.keys(normalizedFiles).some(
          (key) =>
            key === normalizePath(absolutePath) ||
            key.startsWith(`${normalizePath(absolutePath)}/`),
        ),
      ),
    registryOverride: () => undefined,
    registryAuthHeaders: () => undefined,
    workspaceRootFor: () => workspaceRoot,
    preferredToolchain: () => 'auto',
  };
}

/** Finds a parsed dependency by name, failing loudly when it is missing. */
export function findDep<T extends { name: string }>(
  dependencies: T[],
  name: string,
): T {
  const found = dependencies.find((dep) => dep.name === name);
  if (!found) {
    throw new Error(
      `Expected a dependency named "${name}", got: ${dependencies.map((d) => d.name).join(', ')}`,
    );
  }
  return found;
}
