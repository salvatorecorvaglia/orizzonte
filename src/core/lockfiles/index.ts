/**
 * Which lockfiles each ecosystem may have, in the order they are tried.
 *
 * One list, feeding both the "why is this installed" walk and the
 * duplicate-version and diff checks. They used to keep separate lists of
 * separate parsers for the same files, which is how the two yarn readers came
 * to disagree about Yarn Berry.
 */

import type { Ecosystem } from '../types.js';
import { cargoLockfile } from './cargo.js';
import { composerLockfile } from './composer.js';
import { npmLockfile } from './npm.js';
import { pnpmLockfile } from './pnpm.js';
import { poetryLockfile, uvLockfile } from './python.js';
import type { LockfileReader } from './types.js';
import { yarnLockfile } from './yarn.js';

export { NPM_ROOT } from './npm.js';
export * from './types.js';

/**
 * Go, Maven and Gradle are absent on purpose.
 *
 * `go.sum` lists hashes for every version that ever appeared anywhere in the
 * module graph's history, not the versions minimal version selection actually
 * chose — so nearly every module would read as duplicated — and it records
 * nothing about who requires whom. Maven and Gradle have no lockfile at all in
 * the general case.
 */
export function lockfilesFor(ecosystem: Ecosystem): LockfileReader[] {
  switch (ecosystem) {
    case 'node':
      // A workspace declares no fixed choice, so all three are tried.
      return [npmLockfile, pnpmLockfile, yarnLockfile];
    case 'cargo':
      return [cargoLockfile];
    case 'composer':
      return [composerLockfile];
    case 'python':
      // A project can be uv- or Poetry-managed with no marker outside the
      // lockfile itself.
      return [uvLockfile, poetryLockfile];
    default:
      return [];
  }
}
