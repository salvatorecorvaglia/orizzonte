/**
 * PHP: composer.json driven by composer.
 *
 * Packagist asks that clients identify themselves with a contact address in the
 * User-Agent; `core/http.ts` adds it from the `orizzonte.contactEmail` setting.
 */

import * as path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { cacheKey } from '../../core/cache.js';
import type {
  Dependency,
  DepScope,
  PackageMeta,
  ParsedManifest,
  SearchResult,
  Toolchain,
} from '../../core/types.js';
import {
  type Command,
  dependencyKey,
  type EcosystemProvider,
  type ProviderContext,
  type VersionInfo,
} from '../provider.js';
import {
  fetchMetadataWithCache,
  fetchVersionsWithCache,
} from '../shared/cachedFetch.js';
import {
  changelogUrlFor,
  normalizeRepositoryUrl,
} from '../shared/repository.js';

const DEFAULT_PACKAGIST = 'https://packagist.org';
const DEFAULT_REPO = 'https://repo.packagist.org';

/** Composer names are always `vendor/package`, lowercase. */
const NAME_PATTERN =
  /^[a-z0-9]+(?:[_.-][a-z0-9]+)*\/[a-z0-9]+(?:(?:[_.]|-{1,2})[a-z0-9]+)*$/;

/**
 * Encodes `vendor/package` for a URL path, keeping the separating slash.
 *
 * Packagist's p2 endpoint addresses packages as two path segments, so the slash
 * is structural and each side is encoded independently.
 */
function encodePackageName(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/');
}

/**
 * Platform requirements are not packages — `php`, `ext-*` and `composer-*`
 * describe the runtime and have no Packagist entry.
 */
function isPlatformRequirement(name: string): boolean {
  return (
    name === 'php' ||
    /^(ext|lib|composer)-/.test(name) ||
    name.startsWith('php-')
  );
}

interface P2Response {
  packages: Record<
    string,
    Array<{
      name: string;
      version: string;
      description?: string;
      homepage?: string;
      source?: { url?: string };
      abandoned?: boolean | string;
      /** An SPDX identifier per declared license, e.g. `["MIT"]`. */
      license?: string[];
    }>
  >;
}

export class ComposerProvider implements EcosystemProvider {
  readonly id = 'composer' as const;
  readonly manifestFiles = ['composer.json'];
  readonly lockFiles = ['composer.lock'];
  readonly osvEcosystem = 'Packagist';
  // No depsDevSystem: deps.dev does not support PHP/Packagist at all, so
  // there is no value that would resolve — "Why is this installed" falls
  // back to the manifest-only answer for a project with no composer.lock.

  isValidPackageName(name: string): boolean {
    return NAME_PATTERN.test(name);
  }

  async parse(
    absolutePath: string,
    text: string,
    _ctx: ProviderContext,
  ): Promise<ParsedManifest> {
    const json = (parseJsonc(text) ?? {}) as {
      name?: string;
      require?: Record<string, string>;
      'require-dev'?: Record<string, string>;
    };

    const projectLabel = json.name ?? path.basename(path.dirname(absolutePath));
    const dependencies: Dependency[] = [];

    const buckets: Array<[Record<string, string> | undefined, DepScope]> = [
      [json.require, 'prod'],
      [json['require-dev'], 'dev'],
    ];

    for (const [record, scope] of buckets) {
      for (const [name, declared] of Object.entries(record ?? {})) {
        if (isPlatformRequirement(name)) continue;
        dependencies.push({
          key: dependencyKey(absolutePath, scope, name),
          name,
          ecosystem: 'composer',
          scope,
          declared,
          updateKind: 'unknown',
          vulnerabilities: [],
          manifestPath: absolutePath,
          projectLabel,
        });
      }
    }

    return {
      ecosystem: 'composer',
      path: absolutePath,
      name: projectLabel,
      dependencies,
    };
  }

  async readLockfile(
    manifestDir: string,
    ctx: ProviderContext,
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    const text = await ctx.readFile(path.join(manifestDir, 'composer.lock'));
    if (!text) return resolved;
    try {
      const lock = JSON.parse(text) as {
        packages?: Array<{ name: string; version: string }>;
        'packages-dev'?: Array<{ name: string; version: string }>;
      };
      for (const entry of [
        ...(lock.packages ?? []),
        ...(lock['packages-dev'] ?? []),
      ]) {
        resolved.set(entry.name, entry.version.replace(/^v/, ''));
      }
    } catch {
      // Ignore malformed lockfiles.
    }
    return resolved;
  }

  async detectToolchain(
    manifestPath: string,
    _ctx: ProviderContext,
  ): Promise<Toolchain> {
    return {
      id: 'composer',
      ecosystem: 'composer',
      cwd: path.dirname(manifestPath),
    };
  }

  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    return fetchVersionsWithCache(
      names,
      ctx,
      5,
      (name) => cacheKey('packagist', 'versions', name),
      async (name) => {
        const repo = ctx.registryOverride('composer') ?? DEFAULT_REPO;
        const response = await ctx.http.getJson<P2Response>(
          `${repo}/p2/${encodePackageName(name)}.json`,
          { signal, headers: ctx.registryAuthHeaders('composer') },
        );
        const releases = response.packages[name] ?? [];
        const abandoned = releases[0]?.abandoned;

        return {
          // Strip the conventional `v` prefix so comparisons stay uniform.
          versions: releases.map((release) =>
            release.version.replace(/^v/, ''),
          ),
          deprecated:
            abandoned === undefined || abandoned === false
              ? undefined
              : typeof abandoned === 'string'
                ? `Abandoned — use ${abandoned} instead`
                : 'This package is abandoned and no longer maintained',
        };
      },
      // Names come straight from composer.json, which is not ours to trust:
      // anything that is not a real Packagist name cannot resolve, and should
      // not be pasted into a URL to find that out.
      (name) => this.isValidPackageName(name),
    );
  }

  async fetchMetadata(
    name: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<PackageMeta | undefined> {
    if (!this.isValidPackageName(name)) return undefined;

    const key = cacheKey('packagist', 'meta', name);

    return fetchMetadataWithCache(key, ctx, async () => {
      const repo = ctx.registryOverride('composer') ?? DEFAULT_REPO;
      const response = await ctx.http.getJson<P2Response>(
        `${repo}/p2/${encodePackageName(name)}.json`,
        { signal, headers: ctx.registryAuthHeaders('composer') },
      );
      const latest = response.packages[name]?.[0];
      if (!latest) return undefined;

      const repository = normalizeRepositoryUrl(latest.source?.url);
      return {
        name,
        description: latest.description,
        homepage: latest.homepage,
        repository,
        changelogUrl: changelogUrlFor(repository),
        deprecated:
          latest.abandoned === undefined || latest.abandoned === false
            ? undefined
            : typeof latest.abandoned === 'string'
              ? `Abandoned — use ${latest.abandoned} instead`
              : 'This package is abandoned',
        license: latest.license?.length
          ? latest.license.join(' OR ')
          : undefined,
      };
    });
  }

  async search(
    query: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    interface SearchResponse {
      results: Array<{
        name: string;
        description?: string;
        downloads?: number;
        repository?: string;
        abandoned?: boolean | string;
      }>;
    }

    const packagist = ctx.registryOverride('composer') ?? DEFAULT_PACKAGIST;
    const response = await ctx.http.getJson<SearchResponse>(
      `${packagist}/search.json?q=${encodeURIComponent(query)}&per_page=25`,
      { signal, headers: ctx.registryAuthHeaders('composer') },
    );

    return response.results.map((entry) => ({
      name: entry.name,
      version: '',
      description: entry.description,
      ecosystem: 'composer' as const,
      downloads: entry.downloads,
      repository: entry.repository,
      deprecated: entry.abandoned ? 'Abandoned' : undefined,
    }));
  }

  installCommand(
    toolchain: Toolchain,
    name: string,
    version: string | null,
    scope: DepScope,
  ): Command | null {
    if (!this.isValidPackageName(name)) return null;
    const spec = version ? `${name}:${version}` : name;
    return {
      argv: [
        'composer',
        'require',
        ...(scope === 'dev' ? ['--dev'] : []),
        spec,
      ],
      cwd: toolchain.cwd,
      description: `Require ${spec}`,
    };
  }

  updateCommand(
    toolchain: Toolchain,
    dep: Dependency,
    toVersion: string,
  ): Command | null {
    return this.installCommand(toolchain, dep.name, toVersion, dep.scope);
  }

  uninstallCommand(toolchain: Toolchain, dep: Dependency): Command | null {
    if (!this.isValidPackageName(dep.name)) return null;
    return {
      argv: [
        'composer',
        'remove',
        ...(dep.scope === 'dev' ? ['--dev'] : []),
        dep.name,
      ],
      cwd: toolchain.cwd,
      description: `Remove ${dep.name}`,
    };
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    return {
      argv: ['composer', 'update'],
      cwd: toolchain.cwd,
      description: 'Update all packages within their declared constraints',
    };
  }
}
