import type { ProviderContext } from '../providers/provider.js';
import type { Dependency } from './types.js';
import { isRegistryPackage } from './vocabulary.js';

/** Private names may reach only an explicitly configured registry, never a public fallback. */
export function canLookupDependency(
  dep: Dependency,
  ctx: ProviderContext,
): boolean {
  return (
    isRegistryPackage(dep) ||
    (dep.source === 'private' &&
      ctx.registryOverride(dep.ecosystem) !== undefined)
  );
}
