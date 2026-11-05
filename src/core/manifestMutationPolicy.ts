import * as path from 'node:path';
import type { EcosystemProvider } from '../providers/provider.js';
import type { Dependency } from './types.js';

/** Fields that determine which declaration a prepared mutation is allowed to change. */
export function matchesMutationSnapshot(
  current: Dependency | undefined,
  original: Dependency,
): boolean {
  return (
    current !== undefined &&
    current.key === original.key &&
    current.declared === original.declared &&
    current.source === original.source &&
    current.registryName === original.registryName &&
    current.cargoTarget === original.cargoTarget &&
    JSON.stringify(current.group) === JSON.stringify(original.group) &&
    JSON.stringify(current.pythonRequirement) ===
      JSON.stringify(original.pythonRequirement)
  );
}

/** A package manager can read or write metadata in its directory and governing ancestors. */
export function isRelatedMetadata(
  file: string,
  cwd: string,
  provider: Pick<EcosystemProvider, 'manifestFiles' | 'lockFiles'>,
): boolean {
  const basename = path.basename(file);
  if (
    !provider.manifestFiles.includes(basename) &&
    !provider.lockFiles.includes(basename)
  )
    return false;
  return within(file, cwd) || within(cwd, path.dirname(file));
}
function within(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}
