/**
 * "What's changed" before an update: the GitHub releases published between
 * the installed and target version, read from the repository's own Releases
 * API rather than summarised — no attempt is made to parse or normalise the
 * body text, which is exactly what the maintainer wrote.
 *
 * GitHub only, deliberately: GitLab and Bitbucket have their own release
 * APIs, and covering them is real, separate work rather than a drive-by
 * addition — `changelogUrlFor` already draws the same line for the fallback
 * link. A dependency hosted anywhere else simply has nothing to show here.
 */

import type { ProviderContext } from '../providers/provider.js';
import { githubRepoFromUrl } from '../providers/shared/repository.js';
import { cacheKey, TTL } from './cache.js';
import { HttpError } from './http.js';
import type { ChangelogEntry } from './types.js';

/** Caps how much a single lookup can return, in case neither version's tag
 * can be found and the window falls back to "most recent releases". */
const MAX_ENTRIES = 15;

interface GitHubRelease {
  tag_name: string;
  name?: string;
  body?: string;
  html_url: string;
  published_at?: string;
  draft?: boolean;
}

/**
 * Releases between `installedVersion` and `targetVersion`, newest first.
 *
 * Undefined means "not a GitHub repository" — nothing to show, not a
 * failure. A genuine fetch failure (network, rate limit) throws instead, so
 * the caller can tell the two apart and say so.
 *
 * Matching a release to a version is done by comparing tag names as text,
 * not by parsing semver: tags are not guaranteed to be valid semver at all
 * (monorepo tags like `left-pad@1.2.3`, or non-numeric release names), and a
 * comparator that silently mis-ranks a foreign tag scheme is worse than one
 * that admits it could not find the boundary and falls back to "most recent
 * releases" instead.
 */
export async function fetchChangelog(
  repository: string,
  installedVersion: string | undefined,
  targetVersion: string,
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<ChangelogEntry[] | undefined> {
  const coords = githubRepoFromUrl(repository);
  if (!coords) return undefined;

  const key = cacheKey('github', 'releases', coords.owner, coords.repo);
  let releases = ctx.cache.get<GitHubRelease[]>(key);

  if (!releases) {
    try {
      releases = await ctx.http.getJson<GitHubRelease[]>(
        `https://api.github.com/repos/${coords.owner}/${coords.repo}/releases?per_page=30`,
        { signal, headers: { Accept: 'application/vnd.github+json' } },
      );
      await ctx.cache.set(key, releases, TTL.metadata);
    } catch (error) {
      // No releases published is a clean empty state, not a failure.
      if (error instanceof HttpError && error.status === 404) return [];

      const stale = ctx.cache.getStale<GitHubRelease[]>(key);
      if (!stale) throw error;
      releases = stale;
    }
  }

  const published = releases.filter((release) => !release.draft);

  // GitHub answers newest-first already. Start the window at the target
  // version's own release, if it can be found, so picking an older target
  // does not pull in releases past it.
  const targetIndex = published.findIndex((release) =>
    tagMatches(release.tag_name, targetVersion, coords.repo),
  );
  const windowed = targetIndex >= 0 ? published.slice(targetIndex) : published;

  // Stop at the installed version's own release, if that too can be found —
  // everything from there back predates this update.
  const installedIndex = installedVersion
    ? windowed.findIndex((release) =>
        tagMatches(release.tag_name, installedVersion, coords.repo),
      )
    : -1;
  const bounded =
    installedIndex >= 0
      ? windowed.slice(0, installedIndex)
      : windowed.slice(0, MAX_ENTRIES);

  return bounded.map((release) => ({
    version: release.tag_name,
    publishedAt: release.published_at,
    title:
      release.name && release.name !== release.tag_name
        ? release.name
        : undefined,
    body: release.body ?? '',
    url: release.html_url,
  }));
}

/** `v1.2.3`, `left-pad@1.2.3` and `1.2.3` all match version `1.2.3`. */
function tagMatches(tag: string, version: string, repoName: string): boolean {
  if (tag === version) return true;
  const scoped = tag.startsWith(`${repoName}@`)
    ? tag.slice(repoName.length + 1)
    : tag;
  const bare = scoped.replace(/^v/i, '');
  return bare === version || scoped === version;
}
