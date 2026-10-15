/**
 * Maven Central, shared by the Maven and Gradle providers.
 *
 * Versions come from each artifact's `maven-metadata.xml`, the file every
 * Maven repository serves — Central, Nexus and Artifactory alike — listing
 * every version it holds. Search uses Central's Solr API, since a plain
 * repository has no search.
 *
 * Coordinates are `groupId:artifactId`, so everything here splits on the colon
 * and queries the `g:` / `a:` fields rather than doing free-text matching.
 */

import { XMLParser } from 'fast-xml-parser';
import { cacheKey } from '../../core/cache.js';
import type { Ecosystem, PackageMeta, SearchResult } from '../../core/types.js';
import { maxMaven } from '../../core/versions/maven.js';
import type { ProviderContext, VersionInfo } from '../provider.js';
import { fetchVersionsWithCache } from './cachedFetch.js';

const DEFAULT_SOLR = 'https://search.maven.org/solrsearch/select';

/** Maven Central's repository, which serves `maven-metadata.xml`. */
const DEFAULT_REPOSITORY = 'https://repo1.maven.org/maven2';

/**
 * Whether a configured override is a Solr search endpoint rather than a Maven
 * repository.
 *
 * Overrides used to be read as Solr endpoints only — which no Nexus or
 * Artifactory speaks — so an existing one of that shape keeps working exactly
 * as before, and anything else is taken as the repository base it almost
 * certainly is.
 */
export function isSolrEndpoint(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return /solrsearch/.test(pathname) || /\/select\/?$/.test(pathname);
  } catch {
    return false;
  }
}

/** Where a repository keeps an artifact's metadata. */
export function mavenMetadataUrl(
  repository: string,
  groupId: string,
  artifactId: string,
): string {
  const groupPath = groupId
    .split('.')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${repository}/${groupPath}/${encodeURIComponent(artifactId)}/maven-metadata.xml`;
}

/** Every version a `maven-metadata.xml` lists. */
export function parseMavenMetadata(xml: string): string[] {
  const parser = new XMLParser({ parseTagValue: false, trimValues: true });
  const doc = parser.parse(xml) as {
    metadata?: { versioning?: { versions?: { version?: unknown } } };
  };
  const listed = doc.metadata?.versioning?.versions?.version;
  const versions = Array.isArray(listed) ? listed : [listed];
  return versions.filter(
    (version): version is string =>
      typeof version === 'string' && version !== '',
  );
}

interface SolrResponse {
  response: {
    numFound: number;
    docs: Array<{
      id: string;
      g: string;
      a: string;
      v?: string;
      latestVersion?: string;
      p?: string;
      timestamp?: number;
    }>;
  };
}

/**
 * Solr requests currently in flight, by URL and credentials.
 *
 * The Maven and Gradle providers both ask Maven Central, and they ask the same
 * questions: searching "All registries" sent every query twice, and a
 * workspace with both a pom.xml and a Gradle build depending on one artifact
 * looked it up twice per scan. Concurrent identical requests now share one
 * response. Nothing is kept once it settles — `http.ts` and the TTL cache
 * already own caching; this only stops duplicates racing each other.
 */
const inFlight = new Map<string, Promise<SolrResponse>>();

function solrQuery(
  ctx: ProviderContext,
  url: string,
  headers: Record<string, string> | undefined,
  signal?: AbortSignal,
): Promise<SolrResponse> {
  const key = `${url}\u0000${headers?.Authorization ?? ''}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = ctx.http
    .getJson<SolrResponse>(url, { signal, headers })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export function splitCoordinate(
  name: string,
): { groupId: string; artifactId: string } | null {
  const parts = name.split(':');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { groupId: parts[0], artifactId: parts[1] };
}

/**
 * Every published version of each artifact.
 *
 * From `maven-metadata.xml` — complete, and served by any Maven repository.
 * This used to ask Central's Solr API, which returned at most 200 versions (so
 * a long history came back truncated) and which a private repository override
 * could never answer, since Nexus and Artifactory do not speak Solr. An
 * override that is itself a Solr endpoint is still asked the old way.
 */
export async function fetchMavenVersions(
  names: string[],
  ecosystem: Ecosystem,
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<Map<string, VersionInfo>> {
  const override = ctx.registryOverride(ecosystem);
  const useSolr = override !== undefined && isSolrEndpoint(override);
  const base = override ?? DEFAULT_REPOSITORY;
  const headers = ctx.registryAuthHeaders(ecosystem);

  return fetchVersionsWithCache(
    names,
    ctx,
    // Five at a time: one request per artifact is unavoidable, and in series
    // a Maven project's scan took as many round-trips as it has dependencies.
    5,
    // Keyed by the endpoint as well as the ecosystem: these entries live in
    // `globalState`, shared by every workspace in the install, so a private
    // repository's answers must not be served to a project with no override.
    (name) => cacheKey(ecosystem, 'versions', base, name),
    async (name) => {
      const coordinate = splitCoordinate(name);
      if (!coordinate) return undefined;

      let versions: string[];
      if (useSolr) {
        // core=gav returns one document per version rather than per artifact.
        const url =
          `${base}?q=g:${encodeURIComponent(coordinate.groupId)}+AND+a:${encodeURIComponent(coordinate.artifactId)}` +
          `&core=gav&rows=200&wt=json`;
        const response = await solrQuery(ctx, url, headers, signal);
        versions = response.response.docs
          .map((doc) => doc.v)
          .filter((version): version is string => Boolean(version));
      } else {
        const xml = await ctx.http.getText(
          mavenMetadataUrl(base, coordinate.groupId, coordinate.artifactId),
          { signal, headers: { Accept: 'application/xml', ...headers } },
        );
        versions = parseMavenMetadata(xml);
      }

      if (versions.length === 0) return undefined;
      return { versions, latest: maxMaven(versions) };
    },
    (name) => splitCoordinate(name) !== null,
    ecosystem,
  );
}

/**
 * Links for a Maven coordinate.
 *
 * Nothing is fetched: Solr carries no descriptions or licences, so this
 * derives the one reliable link — the artifact's page on Maven Central — from
 * the coordinate alone rather than inventing fields. Nothing is cached either;
 * it used to store this computed value in `globalState`, one entry per Maven
 * package, to save recomputing a string.
 */
export async function fetchMavenMetadata(
  name: string,
): Promise<PackageMeta | undefined> {
  const coordinate = splitCoordinate(name);
  if (!coordinate) return undefined;
  return {
    name,
    homepage: `https://central.sonatype.com/artifact/${coordinate.groupId}/${coordinate.artifactId}`,
  };
}

export async function searchMavenCentral(
  query: string,
  ecosystem: Ecosystem,
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  // A colon means the user typed a full coordinate; query the fields directly.
  // Both halves are encoded, as they are in `fetchMavenVersions` — the query
  // comes from a text box, and a `&` or `#` in it would otherwise end the
  // parameter early and change what was asked.
  const coordinate = query.includes(':') ? splitCoordinate(query) : null;
  const q = coordinate
    ? `g:${encodeURIComponent(coordinate.groupId)}+AND+a:${encodeURIComponent(coordinate.artifactId)}`
    : encodeURIComponent(query);

  // A repository override has no search API, so search stays on Central's
  // Solr unless the override is a Solr endpoint itself. Credentials go only
  // to the override they belong to.
  const override = ctx.registryOverride(ecosystem);
  const solrOverride =
    override !== undefined && isSolrEndpoint(override) ? override : undefined;
  const response = await solrQuery(
    ctx,
    `${solrOverride ?? DEFAULT_SOLR}?q=${q}&rows=25&wt=json`,
    solrOverride ? ctx.registryAuthHeaders(ecosystem) : undefined,
    signal,
  );

  return response.response.docs.map((doc) => ({
    name: `${doc.g}:${doc.a}`,
    version: doc.latestVersion ?? doc.v ?? '',
    ecosystem,
    repository: `https://central.sonatype.com/artifact/${doc.g}/${doc.a}`,
  }));
}
