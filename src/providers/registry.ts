/**
 * Provider lookup. This is the only file that has to change when a new
 * ecosystem is added.
 */

import * as path from 'node:path';
import type { Ecosystem } from '../core/types.js';
import { CargoProvider } from './cargo/index.js';
import { ComposerProvider } from './composer/index.js';
import { GoProvider } from './golang/index.js';
import { GradleProvider } from './gradle/index.js';
import { MavenProvider } from './maven/index.js';
import { NodeProvider } from './node/index.js';
import type { EcosystemProvider } from './provider.js';
import { PythonProvider } from './python/index.js';

export const PROVIDERS: EcosystemProvider[] = [
  new NodeProvider(),
  new PythonProvider(),
  new CargoProvider(),
  new GoProvider(),
  new ComposerProvider(),
  new MavenProvider(),
  new GradleProvider(),
];

const BY_ID = new Map<Ecosystem, EcosystemProvider>(
  PROVIDERS.map((provider) => [provider.id, provider]),
);

const BY_MANIFEST_FILE = new Map<string, EcosystemProvider>();
for (const provider of PROVIDERS) {
  for (const file of provider.manifestFiles) {
    BY_MANIFEST_FILE.set(file, provider);
  }
}

export function providerFor(ecosystem: Ecosystem): EcosystemProvider {
  const provider = BY_ID.get(ecosystem);
  if (!provider) {
    throw new Error(`No provider registered for ecosystem "${ecosystem}"`);
  }
  return provider;
}

/** Resolves a provider from an absolute manifest path, or undefined. */
export function providerForPath(
  absolutePath: string,
): EcosystemProvider | undefined {
  const base = path.basename(absolutePath);
  const direct = BY_MANIFEST_FILE.get(base);
  if (direct) return direct;

  // requirements*.txt is a family rather than a fixed name.
  if (/^requirements.*\.txt$/i.test(base)) {
    return BY_ID.get('python');
  }
  return undefined;
}

/**
 * Every file name and pattern worth watching: manifests plus lockfiles.
 *
 * Includes each provider's `manifestGlobs`, so the watcher no longer restates
 * Python's `requirements-*.txt` beside a list it otherwise derives entirely
 * from the providers.
 */
export function allWatchedFileNames(): string[] {
  const names = new Set<string>();
  for (const provider of PROVIDERS) {
    for (const file of provider.manifestFiles) names.add(file);
    for (const glob of provider.manifestGlobs ?? []) names.add(glob);
    for (const file of provider.lockFiles) names.add(file);
  }
  return [...names];
}

/** The glob VS Code uses to discover manifests. */
export function manifestGlob(): string {
  const names = new Set<string>();
  for (const provider of PROVIDERS) {
    for (const file of provider.manifestFiles) names.add(file);
    for (const glob of provider.manifestGlobs ?? []) names.add(glob);
  }
  return `**/{${[...names].join(',')}}`;
}
