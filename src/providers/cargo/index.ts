/**
 * Rust: Cargo.toml driven by cargo.
 *
 * crates.io is strict about client behaviour — a descriptive User-Agent is
 * mandatory and clients are capped at one request per second. Both rules are
 * enforced centrally in `core/http.ts`, so this provider just calls through.
 */

import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { cacheKey } from '../../core/cache.js';
import { selectLockfile } from '../../core/lockfiles/resolve.js';
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

const DEFAULT_REGISTRY = 'https://crates.io';
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

interface CrateResponse {
  crate: {
    name: string;
    description?: string;
    homepage?: string;
    repository?: string;
    documentation?: string;
    downloads?: number;
    max_stable_version?: string;
    newest_version?: string;
  };
  versions?: Array<{
    num: string;
    yanked: boolean;
    crate_size?: number;
    /** An SPDX expression, e.g. `"MIT OR Apache-2.0"`. */
    license?: string;
  }>;
}

export class CargoProvider implements EcosystemProvider {
  readonly id = 'cargo' as const;
  readonly manifestFiles = ['Cargo.toml'];
  readonly lockFiles = ['Cargo.lock'];
  readonly osvEcosystem = 'crates.io';
  readonly depsDevSystem = 'CARGO';

  isValidPackageName(name: string): boolean {
    return name.length <= 64 && NAME_PATTERN.test(name);
  }

  async parse(
    absolutePath: string,
    text: string,
    _ctx: ProviderContext,
  ): Promise<ParsedManifest> {
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(text) as Record<string, unknown>;
    } catch {
      return {
        ecosystem: 'cargo',
        path: absolutePath,
        name: path.basename(path.dirname(absolutePath)),
        dependencies: [],
      };
    }

    const pkg = doc.package as { name?: string } | undefined;
    const projectLabel = pkg?.name ?? path.basename(path.dirname(absolutePath));
    const dependencies: Dependency[] = [];

    const buckets: Array<[string, DepScope]> = [
      ['dependencies', 'prod'],
      ['dev-dependencies', 'dev'],
      ['build-dependencies', 'build'],
    ];

    for (const [tableName, scope] of buckets) {
      const table = doc[tableName] as Record<string, unknown> | undefined;
      for (const [name, value] of Object.entries(table ?? {})) {
        const declared = cargoConstraint(value);
        // Path and git dependencies have no registry version to compare against.
        if (declared === null) continue;
        dependencies.push({
          key: dependencyKey(absolutePath, scope, name),
          name,
          ecosystem: 'cargo',
          scope,
          declared,
          updateKind: 'unknown',
          vulnerabilities: [],
          manifestPath: absolutePath,
          projectLabel,
        });
      }
    }

    // A virtual manifest declares [workspace] and no [package].
    const workspace = doc.workspace as { members?: string[] } | undefined;

    return {
      ecosystem: 'cargo',
      path: absolutePath,
      name: projectLabel,
      dependencies,
      workspaceMembers: workspace?.members,
      isWorkspaceRoot: workspace !== undefined && pkg === undefined,
    };
  }

  /**
   * Resolved versions from the nearest lockfile at or above `manifestDir`.
   *
   * The walk matters for workspaces, where only the root carries a lockfile —
   * see `core/lockfiles/resolve.ts`.
   */
  async readLockfile(
    manifestDir: string,
    ctx: ProviderContext,
  ): Promise<Map<string, string>> {
    const found = await selectLockfile(
      manifestDir,
      [{ file: 'Cargo.lock' }],
      (absolutePath) => ctx.readFile(absolutePath),
      ctx.workspaceRootFor(manifestDir),
      (_candidate, text) => {
        const resolved = new Map<string, string>();
        try {
          const doc = parseToml(text) as {
            package?: Array<{ name?: string; version?: string }>;
          };
          for (const entry of doc.package ?? []) {
            if (entry.name && entry.version)
              resolved.set(entry.name, entry.version);
          }
        } catch {
          // An unparseable lockfile just means no resolved versions.
        }
        // Undefined keeps the walk going; an empty map here would stop it at a
        // lockfile that told us nothing.
        return resolved.size > 0 ? resolved : undefined;
      },
      ctx.lockfileMemo && { store: ctx.lockfileMemo, namespace: 'resolved' },
    );
    return found ?? new Map<string, string>();
  }

  async detectToolchain(
    manifestPath: string,
    _ctx: ProviderContext,
  ): Promise<Toolchain> {
    return { id: 'cargo', ecosystem: 'cargo', cwd: path.dirname(manifestPath) };
  }

  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    const registry = ctx.registryOverride('cargo') ?? DEFAULT_REGISTRY;
    return fetchVersionsWithCache(
      names,
      ctx,
      // The 1 req/sec cap on crates.io is enforced once, centrally, by
      // `HttpClient`'s own host limiter (see core/http.ts) — every request
      // queues there regardless of how many are dispatched concurrently, so
      // this concurrency only bounds how many workers are waiting on that
      // queue at once, not how fast requests actually leave.
      8,
      // The registry is part of the key. Cached entries live in `globalState`,
      // which is shared by every workspace in the install — so without it, a
      // private-registry answer in one project is served to another project
      // that has no override at all, and switching an override on or off keeps
      // serving the previous registry's versions until the TTL lapses.
      (name) => cacheKey('crates', 'versions', registry, name),
      async (name) => {
        const response = await ctx.http.getJson<CrateResponse>(
          `${registry}/api/v1/crates/${encodeURIComponent(name)}`,
          { signal, headers: ctx.registryAuthHeaders('cargo') },
        );
        const latestNum =
          response.crate.max_stable_version ?? response.crate.newest_version;
        const latestVerObj =
          (response.versions ?? []).find((v) => v.num === latestNum) ??
          response.versions?.[0];
        return {
          versions: (response.versions ?? [])
            .filter((v) => !v.yanked)
            .map((v) => v.num),
          latest: latestNum,
          sizeBytes: latestVerObj?.crate_size,
        };
      },
      // Names come straight from Cargo.toml, which is not ours to trust:
      // anything that is not a real crate name cannot resolve, and should
      // not be pasted into a URL to find that out.
      (name) => this.isValidPackageName(name),
    );
  }

  async fetchMetadata(
    name: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<PackageMeta | undefined> {
    // Same reasoning as `fetchVersions`, which already checks: names come from
    // Cargo.toml, and one is about to become a URL path segment.
    if (!this.isValidPackageName(name)) return undefined;

    // Keyed by registry, as node's and python's are: an override and the
    // public registry must not serve each other's cached metadata.
    const registry = ctx.registryOverride('cargo') ?? DEFAULT_REGISTRY;
    const key = cacheKey('crates', 'meta', registry, name);

    return fetchMetadataWithCache(key, ctx, async () => {
      const response = await ctx.http.getJson<CrateResponse>(
        `${registry}/api/v1/crates/${encodeURIComponent(name)}`,
        { signal, headers: ctx.registryAuthHeaders('cargo') },
      );
      const newest = response.versions?.[0];
      const repository = normalizeRepositoryUrl(response.crate.repository);

      return {
        name: response.crate.name,
        description: response.crate.description,
        homepage: response.crate.homepage ?? response.crate.documentation,
        repository,
        changelogUrl: changelogUrlFor(repository),
        sizeBytes: newest?.crate_size,
        downloads: response.crate.downloads,
        license: newest?.license,
      };
    });
  }

  async search(
    query: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    interface SearchResponse {
      crates: Array<{
        name: string;
        max_stable_version?: string;
        newest_version?: string;
        description?: string;
        downloads?: number;
        repository?: string;
      }>;
    }

    const registry = ctx.registryOverride('cargo') ?? DEFAULT_REGISTRY;
    const response = await ctx.http.getJson<SearchResponse>(
      `${registry}/api/v1/crates?q=${encodeURIComponent(query)}&per_page=25`,
      { signal, headers: ctx.registryAuthHeaders('cargo') },
    );

    return response.crates.map((crate) => ({
      name: crate.name,
      version: crate.max_stable_version ?? crate.newest_version ?? '',
      description: crate.description,
      ecosystem: 'cargo' as const,
      downloads: crate.downloads,
      repository: crate.repository,
    }));
  }

  installCommand(
    toolchain: Toolchain,
    name: string,
    version: string | null,
    scope: DepScope,
  ): Command | null {
    if (!this.isValidPackageName(name)) return null;
    const spec = version ? `${name}@${version}` : name;
    const flags =
      scope === 'dev' ? ['--dev'] : scope === 'build' ? ['--build'] : [];
    return {
      argv: ['cargo', 'add', spec, ...flags],
      cwd: toolchain.cwd,
      description: `Add ${spec}`,
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
      argv: ['cargo', 'remove', dep.name],
      cwd: toolchain.cwd,
      description: `Remove ${dep.name}`,
    };
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    return {
      argv: ['cargo', 'update'],
      cwd: toolchain.cwd,
      description: 'Update all dependencies within their declared ranges',
    };
  }
}

/**
 * Cargo dependencies are either a version string or a table. Returns null for
 * path/git dependencies, which have no registry version to track.
 */
function cargoConstraint(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const table = value as Record<string, unknown>;
    if (table.path !== undefined || table.git !== undefined) return null;
    if (typeof table.version === 'string') return table.version;
    // A workspace-inherited dependency: the root manifest holds the constraint.
    if (table.workspace === true) return 'workspace';
  }
  return null;
}
