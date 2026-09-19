/**
 * Which refs "Compare with…" offers, and how paths reach `Repository.show`.
 *
 * This is the half of the branch-comparison feature that does not touch
 * `vscode`, and until it was split out the feature had no tests at all.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type GitRepositoryState,
  REF_TYPE_HEAD,
  REF_TYPE_REMOTE_HEAD,
  refChoices,
  toRepoRelativePath,
} from '../../src/core/gitRefs.js';

function state(
  overrides: Partial<GitRepositoryState> = {},
): GitRepositoryState {
  return { HEAD: undefined, refs: [], ...overrides };
}

describe('refChoices', () => {
  it('offers nothing for a repository with no branches', () => {
    // A fresh `git init`. The caller uses the empty list to say so rather than
    // opening an empty picker.
    expect(refChoices(state())).toEqual([]);
  });

  it('puts the current branch’s upstream first and labels it', () => {
    // "What would this branch change relative to where it is going" is the
    // question people open this for.
    const choices = refChoices(
      state({
        HEAD: {
          type: REF_TYPE_HEAD,
          name: 'feature',
          upstream: { remote: 'origin', name: 'main' },
        },
        refs: [
          { type: REF_TYPE_HEAD, name: 'feature' },
          { type: REF_TYPE_HEAD, name: 'main' },
        ],
      }),
    );

    expect(choices[0]).toEqual({
      label: 'origin/main',
      description: 'upstream',
      revSpec: 'origin/main',
    });
  });

  it('sorts local heads and lists them before remote-tracking branches', () => {
    const choices = refChoices(
      state({
        refs: [
          { type: REF_TYPE_HEAD, name: 'zeta' },
          { type: REF_TYPE_HEAD, name: 'alpha' },
          { type: REF_TYPE_REMOTE_HEAD, name: 'main', remote: 'origin' },
        ],
      }),
    );

    expect(choices.map((choice) => choice.revSpec)).toEqual([
      'alpha',
      'zeta',
      'origin/main',
    ]);
  });

  it('never offers the same revision twice', () => {
    // The upstream is usually also present as a remote-tracking ref.
    const choices = refChoices(
      state({
        HEAD: {
          type: REF_TYPE_HEAD,
          name: 'main',
          upstream: { remote: 'origin', name: 'main' },
        },
        refs: [
          { type: REF_TYPE_REMOTE_HEAD, name: 'main', remote: 'origin' },
          { type: REF_TYPE_HEAD, name: 'main' },
        ],
      }),
    );

    const specs = choices.map((choice) => choice.revSpec);
    expect(new Set(specs).size).toBe(specs.length);
    expect(specs).toEqual(['origin/main', 'main']);
  });

  it('ignores refs that are neither a head nor a remote head', () => {
    // Tags and stashes are not things to compare dependencies against here.
    const choices = refChoices(state({ refs: [{ type: 2, name: 'v1.0.0' }] }));

    expect(choices).toEqual([]);
  });

  it('skips a nameless ref rather than offering a blank entry', () => {
    const choices = refChoices(
      state({
        refs: [
          { type: REF_TYPE_HEAD },
          { type: REF_TYPE_REMOTE_HEAD, name: 'main' },
        ],
      }),
    );

    expect(choices).toEqual([]);
  });

  it('drops an upstream that names only half of itself', () => {
    const choices = refChoices(
      state({
        HEAD: {
          type: REF_TYPE_HEAD,
          name: 'main',
          upstream: { remote: 'origin' },
        },
      }),
    );

    expect(choices).toEqual([]);
  });
});

describe('toRepoRelativePath', () => {
  it('returns a forward-slashed path relative to the repository root', () => {
    // `show()` wants forward slashes on every platform, including Windows.
    const root = path.join(path.sep, 'repo');
    const file = path.join(root, 'packages', 'web', 'package-lock.json');

    expect(toRepoRelativePath(root, file)).toBe(
      'packages/web/package-lock.json',
    );
  });

  it('handles a file at the repository root', () => {
    const root = path.join(path.sep, 'repo');

    expect(toRepoRelativePath(root, path.join(root, 'pnpm-lock.yaml'))).toBe(
      'pnpm-lock.yaml',
    );
  });
});
