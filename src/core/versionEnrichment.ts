import type { ProviderContext, VersionInfo } from '../providers/provider.js';
import { providerFor } from '../providers/registry.js';
import { canLookupDependency } from './registryAccess.js';
import type { Dependency, Ecosystem, ProjectGroup } from './types.js';
import {
  classifyUpdate,
  constraintToApproxVersion,
  maxSatisfying,
  maxVersion,
  registryConstraint,
} from './versions/index.js';
import { registryNameOf } from './vocabulary.js';

export interface EnrichmentMetrics {
  rows: number;
  latestCalculations: number;
  wantedCalculations: number;
}

/** One scan owns these results; no calculation survives new registry data. */
export async function enrichVersionGroups(
  groups: ProjectGroup[],
  ctx: ProviderContext,
  signal: AbortSignal,
): Promise<boolean> {
  /*
   * Index the dependencies by ecosystem once, and hand each merge step only
   * the rows it can act on.
   *
   * Both merge steps used to re-walk every group and every dependency and
   * skip what did not match, so the cost was the number of ecosystems times
   * the size of the whole workspace rather than the size of the workspace.
   */
  const byEcosystem = new Map<Ecosystem, Dependency[]>();
  for (const group of groups) {
    for (const dep of group.dependencies) {
      // A workspace sibling, local path or git checkout shares a name with
      // whatever the public registry holds under it, and nothing else.
      if (!canLookupDependency(dep, ctx)) continue;
      const existing = byEcosystem.get(dep.ecosystem);
      if (existing) existing.push(dep);
      else byEcosystem.set(dep.ecosystem, [dep]);
    }
  }

  if (byEcosystem.size === 0) return false;

  const outcomes = await Promise.all(
    [...byEcosystem.entries()].map(async ([ecosystem, dependencies]) => {
      const provider = providerFor(ecosystem);
      const names = [
        ...new Set(dependencies.map((dep) => registryNameOf(dep))),
      ];

      let versions: Map<string, VersionInfo>;
      try {
        versions = await provider.fetchVersions(names, ctx, signal);
      } catch (error) {
        // An abort is the caller's decision, not a registry failure, so it
        // propagates rather than being reported as an unreachable ecosystem.
        if (signal.aborted) throw error;
        markLookupFailed(dependencies);
        return false;
      }

      applyVersions(dependencies, ecosystem, versions);
      return dependencies.some((dep) => {
        const info = versions.get(registryNameOf(dep));
        return info && info.versions.length > 0 && !info.stale;
      });
    }),
  );

  return outcomes.every((succeeded) => !succeeded);
}

export function applyVersions(
  dependencies: Dependency[],
  ecosystem: Ecosystem,
  versions: Map<string, VersionInfo>,
): EnrichmentMetrics {
  const metrics: EnrichmentMetrics = {
    rows: dependencies.length,
    latestCalculations: 0,
    wantedCalculations: 0,
  };
  const latest = new Map<string, string | undefined>();
  const wanted = new Map<string, Map<string, string | undefined>>();
  for (const dep of dependencies) {
    const info = versions.get(registryNameOf(dep));
    if (!info || info.versions.length === 0) {
      dep.lookupFailed = true;
      dep.updateKind = 'unknown';
      continue;
    }

    const name = registryNameOf(dep);
    if (!latest.has(name)) {
      latest.set(name, info.latest ?? maxVersion(ecosystem, info.versions));
      metrics.latestCalculations++;
    }
    dep.latest = latest.get(name);
    dep.lookupFailed = info.stale || undefined;
    const constraint = registryConstraint(dep.declared);
    let constraints = wanted.get(name);
    if (!constraints) {
      constraints = new Map();
      wanted.set(name, constraints);
    }
    if (!constraints.has(constraint)) {
      constraints.set(
        constraint,
        maxSatisfying(ecosystem, info.versions, constraint),
      );
      metrics.wantedCalculations++;
    }
    // Installed versions differ by workspace member, so only cache the range result.
    dep.wanted = constraints.get(constraint) ?? dep.installed;

    if (info.deprecated || info.sizeBytes !== undefined) {
      dep.meta = {
        ...(dep.meta ?? { name: dep.name }),
        ...(info.deprecated ? { deprecated: info.deprecated } : {}),
        ...(info.sizeBytes !== undefined ? { sizeBytes: info.sizeBytes } : {}),
      };
    }

    // Compare against what is actually resolved, falling back to the
    // constraint's lower bound when nothing pins an exact version.
    const current = dep.installed ?? constraintToApproxVersion(dep.declared);
    dep.updateKind = classifyUpdate(ecosystem, current, dep.latest);
  }
  return metrics;
}

/** An unreachable registry greys out its own rows and asserts nothing else. */
function markLookupFailed(dependencies: Dependency[]): void {
  for (const dep of dependencies) {
    dep.lookupFailed = true;
    dep.updateKind = 'unknown';
  }
}
