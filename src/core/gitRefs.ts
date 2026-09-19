/**
 * The `vscode`-free half of the "compare with a branch" feature: which refs are
 * worth offering, and how a workspace path is expressed relative to a
 * repository root.
 *
 * Split out of `ui/gitDiff.ts` because that file imports `vscode` and so cannot
 * be loaded outside the editor — which left the whole feature untested. The
 * decisions worth testing are all here; what stays there is the adapter that
 * calls the Git extension's API.
 */

import * as path from 'node:path';

/** From the real `git.d.ts`'s `RefType` enum — only the two kinds we show. */
export const REF_TYPE_HEAD = 0;
export const REF_TYPE_REMOTE_HEAD = 1;

export interface GitRef {
  readonly type: number;
  readonly name?: string;
  readonly remote?: string;
}

export interface GitBranch extends GitRef {
  readonly upstream?: { readonly name?: string; readonly remote?: string };
}

export interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly refs: GitRef[];
}

/** One offerable ref: what to show, and the revision it names. */
export interface RefChoice {
  label: string;
  description?: string;
  revSpec: string;
}

/**
 * Branches worth offering, the current branch's upstream first.
 *
 * Upstream leads because "what would this branch change relative to where it
 * is going" is the question people actually open this for. Local heads follow,
 * then remote-tracking branches; duplicates are dropped so a branch that is
 * also the upstream appears once.
 */
export function refChoices(state: GitRepositoryState): RefChoice[] {
  const upstream = state.HEAD?.upstream;
  const upstreamSpec =
    upstream?.remote && upstream.name
      ? `${upstream.remote}/${upstream.name}`
      : undefined;

  const seen = new Set<string>();
  const choices: RefChoice[] = [];

  if (upstreamSpec) {
    choices.push({
      label: upstreamSpec,
      description: 'upstream',
      revSpec: upstreamSpec,
    });
    seen.add(upstreamSpec);
  }

  const heads = state.refs
    .filter(
      (ref): ref is GitRef & { name: string } =>
        ref.type === REF_TYPE_HEAD && Boolean(ref.name),
    )
    .map((ref) => ref.name)
    .sort();
  for (const name of heads) {
    if (seen.has(name)) continue;
    seen.add(name);
    choices.push({ label: name, revSpec: name });
  }

  const remotes = state.refs
    .filter(
      (ref): ref is GitRef & { name: string; remote: string } =>
        ref.type === REF_TYPE_REMOTE_HEAD &&
        Boolean(ref.name) &&
        Boolean(ref.remote),
    )
    .map((ref) => `${ref.remote}/${ref.name}`)
    .sort();
  for (const spec of remotes) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    choices.push({ label: spec, revSpec: spec });
  }

  return choices;
}

/**
 * A repository-root-relative, forward-slashed path, which is what
 * `Repository.show` wants regardless of platform.
 */
export function toRepoRelativePath(
  repositoryRoot: string,
  absolutePath: string,
): string {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
}
