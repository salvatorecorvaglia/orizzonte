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
import { readInstalledVersions } from '../../core/lockfiles/installed.js';
import type {
  Dependency,
  DepScope,
  PackageMeta,
  ParsedManifest,
  SearchResult,
  Toolchain,
} from '../../core/types.js';
import { maxVersion } from '../../core/versions/index.js';
import { isUpdatable, registryNameOf } from '../../core/vocabulary.js';
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

/**
 * crates.io's sparse index: one static, CDN-served file per crate listing
 * every published version. It is what Cargo itself reads, and what crates.io
 * asks tools to use for version data.
 */
const SPARSE_INDEX = 'https://index.crates.io';
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
        const registryName = renamedPackage(value);
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
          // `workspace = true` is a real crate whose version the workspace
          // root owns: worth looking up, not rewritable from the member —
          // `cargo add foo@2` there replaces the inheritance with a pin.
          ...(declared === 'workspace' ? { source: 'inherited' as const } : {}),
          // `foo = { package = "bar" }` is the crate `bar`, used as `foo`.
          ...(registryName
            ? {
                registryName,
                ...(declared === 'workspace'
                  ? {}
                  : { source: 'alias' as const }),
              }
            : {}),
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
   * Resolved versions from the nearest Cargo.lock at or above `manifestDir` —
   * see `core/lockfiles/installed.ts`. A lockfile may hold two majors of one
   * crate; the declared requirement picks this manifest's.
   */
  async readLockfile(
    manifestDir: string,
    ctx: ProviderContext,
    dependencies: Dependency[] = [],
  ): Promise<Map<string, string>> {
    return readInstalledVersions(
      'cargo',
      manifestDir,
      ctx,
      dependencies.map((dep) => ({
        name: registryNameOf(dep),
        declared: dep.declared,
      })),
    );
  }

  /** Cargo.lock records a crate by its real name, not a `package =` alias. */
  lockfileName(dep: Dependency): string {
    return registryNameOf(dep);
  }

  async detectToolchain(
    manifestPath: string,
    _ctx: ProviderContext,
  ): Promise<Toolchain> {
    return { id: 'cargo', ecosystem: 'cargo', cwd: path.dirname(manifestPath) };
  }

  /**
   * Every published version of each crate.
   *
   * From the sparse index when talking to crates.io. The API this used to
   * call is capped at one request per second, so a cold scan of a
   * 200-crate workspace took over three minutes; the index is a CDN with no
   * such cap. The index carries no download sizes — the drawer's metadata
   * fetch still supplies those — which is the trade.
   *
   * A registry override still goes through the API: a private registry
   * speaks crates.io's API, but need not serve a sparse index at the same
   * address.
   */
  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    const override = ctx.registryOverride('cargo');
    if (!override) {
      return fetchVersionsWithCache(
        names,
        ctx,
        8,
        (name) => cacheKey('crates', 'versions', SPARSE_INDEX, name),
        async (name) => {
          const text = await ctx.http.getText(
            `${SPARSE_INDEX}/${sparseIndexPath(name)}`,
            { signal },
          );
          const versions = parseSparseIndex(text);
          if (versions.length === 0) return undefined;
          return { versions, latest: maxVersion('cargo', versions) };
        },
        (name) => this.isValidPackageName(name),
        'cargo',
      );
    }

    const registry = override;
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
      'cargo',
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
    return {
      argv: ['cargo', 'add', spec, ...tableFlags(scope)],
      cwd: toolchain.cwd,
      description: `Add ${spec}`,
    };
  }

  updateCommand(
    toolchain: Toolchain,
    dep: Dependency,
    toVersion: string,
  ): Command | null {
    if (!isUpdatable(dep)) return null;
    const crate = registryNameOf(dep);
    const command = this.installCommand(toolchain, crate, toVersion, dep.scope);
    // A renamed dependency stays renamed: without `--rename` cargo would add
    // the crate a second time under its own name.
    if (command && crate !== dep.name) {
      if (!this.isValidPackageName(dep.name)) return null;
      command.argv.push('--rename', dep.name);
    }
    return command;
  }

  uninstallCommand(toolchain: Toolchain, dep: Dependency): Command | null {
    if (!this.isValidPackageName(dep.name)) return null;
    // `cargo remove` looks only in [dependencies] unless told otherwise, so
    // removing a dev- or build-dependency without the flag always failed.
    return {
      argv: ['cargo', 'remove', dep.name, ...tableFlags(dep.scope)],
      cwd: toolchain.cwd,
      description: `Remove ${dep.name}`,
    };
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    return {
      argv: ['cargo', 'update'],
      cwd: toolchain.cwd,
      description: 'Update all dependencies within their declared ranges',
      reach: 'ranges',
    };
  }
}

/**
 * A crate's file in the sparse index, per the registry index layout: names of
 * one, two and three characters get their own directories, and longer ones
 * are sharded by their first two pairs of characters. Always lower case.
 */
export function sparseIndexPath(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

/**
 * The versions a sparse-index file lists, yanked ones left out. One JSON
 * object per line; a line that does not parse is skipped rather than failing
 * the crate.
 */
export function parseSparseIndex(text: string): string[] {
  const versions: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as { vers?: unknown; yanked?: unknown };
      if (typeof entry.vers === 'string' && entry.yanked !== true) {
        versions.push(entry.vers);
      }
    } catch {
      // A malformed line costs one version, not the crate.
    }
  }
  return versions;
}

/** The flag naming the dependency table a scope lives in. */
function tableFlags(scope: DepScope): string[] {
  if (scope === 'dev') return ['--dev'];
  if (scope === 'build') return ['--build'];
  return [];
}

/** The crate behind `foo = { package = "bar" }`, when it is renamed. */
function renamedPackage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pkg = (value as Record<string, unknown>).package;
  return typeof pkg === 'string' && pkg !== '' ? pkg : undefined;
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
