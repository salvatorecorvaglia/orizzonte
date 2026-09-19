/**
 * Turning the many shapes of "repository" that registries report into a
 * clickable URL, and guessing a changelog link from it.
 *
 * Registries hand back `git+ssh://git@github.com/foo/bar.git`,
 * `git://github.com/foo/bar`, `github:foo/bar`, and plain HTTPS. The UI wants
 * one form.
 */

export function normalizeRepositoryUrl(
  raw: string | undefined,
): string | undefined {
  if (!raw) return undefined;
  let url = raw.trim();
  if (url === '') return undefined;

  // Shorthand forms used by package.json.
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/.exec(url);
  if (shorthand) {
    const host =
      shorthand[1] === 'github'
        ? 'github.com'
        : shorthand[1] === 'gitlab'
          ? 'gitlab.com'
          : 'bitbucket.org';
    return `https://${host}/${shorthand[2].replace(/\.git$/, '')}`;
  }

  // A bare `owner/repo` is a GitHub shorthand.
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) {
    return `https://github.com/${url}`;
  }

  url = url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');

  if (!/^https?:\/\//.test(url)) {
    return undefined;
  }

  try {
    // Round-trip through URL to drop credentials and normalise the host.
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Splits a normalised GitHub repository URL into owner/repo, for the GitHub
 * Releases API. Undefined for every other forge — GitLab and Bitbucket have
 * their own release APIs this does not attempt to speak.
 */
export function githubRepoFromUrl(
  repository: string | undefined,
): { owner: string; repo: string } | undefined {
  if (!repository) return undefined;
  try {
    const url = new URL(repository);
    if (url.hostname !== 'github.com') return undefined;
    const [owner, repo] = url.pathname.replace(/^\//, '').split('/');
    if (!owner || !repo) return undefined;
    return { owner, repo };
  } catch {
    return undefined;
  }
}

/**
 * Best-effort changelog link. For GitHub and GitLab the releases page is more
 * reliably present than a CHANGELOG file, so we prefer it.
 */
export function changelogUrlFor(
  repository: string | undefined,
): string | undefined {
  if (!repository) return undefined;
  try {
    const url = new URL(repository);
    if (url.hostname === 'github.com') {
      return `${repository}/releases`;
    }
    if (url.hostname === 'gitlab.com') {
      return `${repository}/-/releases`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
