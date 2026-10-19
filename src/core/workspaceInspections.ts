import * as path from 'node:path';
import type { ProviderContext } from '../providers/provider.js';
import { mapWithConcurrency } from '../providers/shared/concurrency.js';
import {
  findDuplicateVersions,
  lockfilePathFor,
  mergeSharedLockfiles,
} from './depGraph.js';
import type { ProjectDuplicateVersions, ProjectGroup } from './types.js';

/** Shared by the panel and report export: one memo and bounded I/O per sweep. */
export async function collectProjectDuplicates(
  groups: ProjectGroup[],
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<ProjectDuplicateVersions[]> {
  const ctx = { ...providerContext, lockfileMemo: new Map<string, unknown>() };
  const lockfiles = new Map<string, string | undefined>();
  const results = await mapWithConcurrency(groups, 6, async (group) => {
    signal?.throwIfAborted();
    const dir = path.dirname(group.manifestPath);
    lockfiles.set(
      group.manifestPath,
      await lockfilePathFor(
        dir,
        group.ecosystem,
        (file) => ctx.readFile(file),
        ctx.workspaceRootFor(dir),
        { store: ctx.lockfileMemo, namespace: 'lockfile-path' },
      ),
    );
    const result = await findDuplicateVersions(
      group.manifestPath,
      group.ecosystem,
      ctx,
    );
    return {
      manifestPath: group.manifestPath,
      projectLabel: group.label,
      ecosystem: group.ecosystem,
      ...result,
    };
  });
  signal?.throwIfAborted();
  return mergeSharedLockfiles(results, (result) =>
    lockfiles.get(result.manifestPath),
  );
}
