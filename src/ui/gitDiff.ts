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

import * as vscode from 'vscode';
import {
  type GitRepositoryState,
  type RefChoice,
  refChoices,
  toRepoRelativePath,
} from '../core/gitRefs.js';

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

/**
 * What a ref picker can come back with.
 *
 * "The user dismissed the picker" and "there was nothing to put in it" used to
 * be the same `undefined`, so a repository with no branches yet — a fresh `git
 * init` — answered the Compare command with silence: no picker, no panel, no
 * explanation. They are told apart here so the caller can say so.
 */
export type RefPick =
  | { status: 'picked'; ref: string }
  | { status: 'cancelled' }
  | { status: 'none' };

/** A native quick-pick of the repository's branches. */
export async function pickRef(repository: GitRepository): Promise<RefPick> {
  const choices: Array<RefChoice & vscode.QuickPickItem> = refChoices(
    repository.state,
  );
  if (choices.length === 0) return { status: 'none' };

  const picked = await vscode.window.showQuickPick(choices, {
    title: 'Compare dependencies with…',
  });
  return picked
    ? { status: 'picked', ref: picked.revSpec }
    : { status: 'cancelled' };
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
    const relative = toRepoRelativePath(
      repository.rootUri.fsPath,
      absolutePath,
    );
    try {
      return await repository.show(ref, relative);
    } catch {
      return undefined;
    }
  };
}
