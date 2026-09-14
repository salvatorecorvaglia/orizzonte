/**
 * The slice of the built-in Git extension's API needed to compare a lockfile
 * against another ref: finding the workspace's one repository, letting the
 * user pick a ref from it, and reading a file's content there.
 *
 * The interfaces below are a small, locally-declared subset of the real
 * `git.d.ts` the Git extension publishes — not a dependency on it, since
 * that typing has no npm package of its own. Only what this file calls is
 * declared.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';

interface GitRef {
  readonly type: number;
  readonly name?: string;
  readonly remote?: string;
}

interface GitBranch extends GitRef {
  readonly upstream?: { readonly name?: string; readonly remote?: string };
}

interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly refs: GitRef[];
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
  show(ref: string, path: string): Promise<string>;
}

interface GitApi {
  readonly repositories: GitRepository[];
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

/** From the real `git.d.ts`'s `RefType` enum — only the two kinds shown in the picker. */
const REF_TYPE_HEAD = 0;
const REF_TYPE_REMOTE_HEAD = 1;

async function getGitApi(): Promise<GitApi | undefined> {
  const extension =
    vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!extension) return undefined;
  try {
    const exports = extension.isActive
      ? extension.exports
      : await extension.activate();
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}

export type RepositoryLookup =
  | { ok: true; repository: GitRepository }
  | { ok: false; message: string };

/**
 * The workspace's one Git repository, or an explanatory message when there
 * is not exactly one. Orizzonte compares within a single repository rather
 * than building a repository picker for the far less common multi-repo case.
 */
export async function findSingleRepository(): Promise<RepositoryLookup> {
  const api = await getGitApi();
  if (!api) {
    return {
      ok: false,
      message: 'The built-in Git extension is not available.',
    };
  }
  if (api.repositories.length === 0) {
    return { ok: false, message: 'This workspace is not a Git repository.' };
  }
  if (api.repositories.length > 1) {
    return {
      ok: false,
      message:
        'This workspace has more than one Git repository; Orizzonte compares dependencies within a single repository.',
    };
  }
  return { ok: true, repository: api.repositories[0] };
}

interface RefChoice extends vscode.QuickPickItem {
  revSpec: string;
}

/** Branches worth offering, the current branch's upstream first if known. */
function refChoices(repository: GitRepository): RefChoice[] {
  const upstream = repository.state.HEAD?.upstream;
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

  const heads = repository.state.refs
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

  const remotes = repository.state.refs
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

/** A native quick-pick of the repository's branches. Undefined on cancel. */
export async function pickRef(
  repository: GitRepository,
): Promise<string | undefined> {
  const choices = refChoices(repository);
  if (choices.length === 0) return undefined;
  const picked = await vscode.window.showQuickPick(choices, {
    title: 'Compare dependencies with…',
  });
  return picked?.revSpec;
}

/**
 * A `collectVersionsFrom`-shaped reader backed by `ref` instead of disk.
 * Undefined for a path that did not exist at that ref — the same contract
 * `ProviderContext.readFile` uses, so the caller cannot tell the two
 * sources apart.
 */
export function gitFileReader(
  repository: GitRepository,
  ref: string,
): (absolutePath: string) => Promise<string | undefined> {
  return async (absolutePath: string) => {
    // `show()` wants a repo-root-relative, forward-slashed path regardless
    // of platform.
    const relative = path
      .relative(repository.rootUri.fsPath, absolutePath)
      .split(path.sep)
      .join('/');
    try {
      return await repository.show(ref, relative);
    } catch {
      return undefined;
    }
  };
}
