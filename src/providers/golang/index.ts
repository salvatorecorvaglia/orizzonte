/**
 * Go: go.mod driven by `go get`.
 *
 * Two Go-specific quirks shape this provider:
 *  - The module proxy requires case-escaped paths — an uppercase letter becomes
 *    `!` plus its lowercase form, so `github.com/BurntSushi/toml` is fetched as
 *    `github.com/!burnt!sushi/toml`.
 *  - There is no official module search API, so search resolves exact module
 *    paths and otherwise points at pkg.go.dev.
 */

import * as path from 'node:path';
import { cacheKey, TTL } from '../../core/cache.js';
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
import { fetchVersionsWithCache } from '../shared/cachedFetch.js';
import { changelogUrlFor } from '../shared/repository.js';

const DEFAULT_PROXY = 'https://proxy.golang.org';

/** A module path is a slash-separated set of domain-ish segments. */
const MODULE_PATTERN = /^[a-zA-Z0-9][\w.~-]*(?:\/[\w.~+-]+)*$/;

export class GoProvider implements EcosystemProvider {
  readonly id = 'golang' as const;
  readonly manifestFiles = ['go.mod'];
  readonly lockFiles = ['go.sum'];
  readonly osvEcosystem = 'Go';
  readonly depsDevSystem = 'GO';

  isValidPackageName(name: string): boolean {
    return name.length <= 512 && MODULE_PATTERN.test(name);
  }

  async parse(
    absolutePath: string,
    text: string,
    _ctx: ProviderContext,
  ): Promise<ParsedManifest> {
    const moduleName = /^module\s+(\S+)/m.exec(text)?.[1];
    const projectLabel =
      moduleName ?? path.basename(path.dirname(absolutePath));
    const dependencies: Dependency[] = [];
    const seen = new Set<string>();

    // `require` appears both as a block and as single lines. Handle both, and
    // treat the `// indirect` marker as our "not a direct dependency" signal.
    const requireBlocks = [...text.matchAll(/require\s*\(([\s\S]*?)\)/g)].map(
      (m) => m[1],
    );
    const singleLines = [
      ...text.matchAll(/^require\s+(\S+)\s+(\S+)(.*)$/gm),
    ].map((m) => `${m[1]} ${m[2]}${m[3]}`);

    const lines = [
      ...requireBlocks.flatMap((block) => block.split(/\r?\n/)),
      ...singleLines,
    ];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('//')) continue;

      const match = /^(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?/.exec(line);
      if (!match) continue;

      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);

      // Indirect requirements are transitive; showing them as top-level rows
      // would be misleading, so they land in the 'optional' bucket.
      const scope: DepScope = match[3] ? 'optional' : 'prod';

      dependencies.push({
        key: dependencyKey(absolutePath, scope, name),
        name,
        ecosystem: 'golang',
        scope,
        declared: match[2],
        installed: match[2], // go.mod pins exact versions
        updateKind: 'unknown',
        vulnerabilities: [],
        manifestPath: absolutePath,
        projectLabel,
      });
    }

    return {
      ecosystem: 'golang',
      path: absolutePath,
      name: projectLabel,
      dependencies,
    };
  }

  async detectToolchain(
    manifestPath: string,
    _ctx: ProviderContext,
  ): Promise<Toolchain> {
    return { id: 'go', ecosystem: 'golang', cwd: path.dirname(manifestPath) };
  }

  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    const proxy = ctx.registryOverride('golang') ?? DEFAULT_PROXY;
    return fetchVersionsWithCache(
      names,
      ctx,
      6,
      // Keyed by proxy for the same reason npm and PyPI are: these entries
      // live in `globalState`, shared across every workspace, so an unkeyed
      // entry lets a private proxy's answers leak into a project that has
      // no override — and survives switching one on or off.
      (name) => cacheKey('go', 'versions', proxy, name),
      async (name) => {
        const escaped = escapeModulePath(name);
        // @latest is authoritative and cheap; @v/list gives the full history but
        // omits versions the proxy has not cached, so we merge both.
        const headers = ctx.registryAuthHeaders('golang');
        const [latest, list] = await Promise.all([
          ctx.http
            .getJson<{ Version: string }>(`${proxy}/${escaped}/@latest`, {
              signal,
              headers,
            })
            .catch(() => undefined),
          ctx.http
            .getText(`${proxy}/${escaped}/@v/list`, { signal, headers })
            .catch(() => ''),
        ]);

        const versions = list
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (latest?.Version && !versions.includes(latest.Version)) {
          versions.push(latest.Version);
        }
        if (versions.length === 0) return undefined;

        return { versions, latest: latest?.Version };
      },
      // Names come straight from go.mod, which is not ours to trust: anything
      // that is not a real module path cannot resolve, and should not be
      // pasted into a URL to find that out.
      (name) => this.isValidPackageName(name),
    );
  }

  async fetchMetadata(
    name: string,
    ctx: ProviderContext,
    _signal?: AbortSignal,
  ): Promise<PackageMeta | undefined> {
    const key = cacheKey(
      'go',
      'meta',
      ctx.registryOverride('golang') ?? DEFAULT_PROXY,
      name,
    );
    const cached = ctx.cache.get<PackageMeta>(key);
    if (cached) return cached;

    // The proxy serves no descriptions or licences. Where the module path is a
    // known forge we can at least derive real repository and changelog links.
    const repository = repositoryFromModulePath(name);
    const meta: PackageMeta = {
      name,
      repository,
      homepage: `https://pkg.go.dev/${name}`,
      changelogUrl: changelogUrlFor(repository),
    };
    await ctx.cache.set(key, meta, TTL.metadata);
    return meta;
  }

  /**
   * Go has no search API. If the query looks like a module path we verify it
   * against the proxy; otherwise the UI offers a pkg.go.dev link instead.
   */
  async search(
    query: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!this.isValidPackageName(trimmed) || !trimmed.includes('/')) {
      return [];
    }

    try {
      const proxy = ctx.registryOverride('golang') ?? DEFAULT_PROXY;
      const latest = await ctx.http.getJson<{ Version: string }>(
        `${proxy}/${escapeModulePath(trimmed)}/@latest`,
        { signal, headers: ctx.registryAuthHeaders('golang') },
      );
      return [
        {
          name: trimmed,
          version: latest.Version,
          ecosystem: 'golang',
          repository: repositoryFromModulePath(trimmed),
        },
      ];
    } catch {
      return [];
    }
  }

  installCommand(
    toolchain: Toolchain,
    name: string,
    version: string | null,
    _scope: DepScope,
  ): Command | null {
    if (!this.isValidPackageName(name)) return null;
    const spec = version ? `${name}@${version}` : `${name}@latest`;
    return {
      argv: ['go', 'get', spec],
      cwd: toolchain.cwd,
      description: `Get ${spec}`,
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
    // `go get pkg@none` drops the requirement; tidy then prunes go.sum.
    return {
      argv: ['go', 'get', `${dep.name}@none`],
      cwd: toolchain.cwd,
      description: `Remove ${dep.name}`,
    };
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    return {
      argv: ['go', 'get', '-u', './...'],
      cwd: toolchain.cwd,
      description: 'Update all modules to their latest minor/patch releases',
    };
  }
}

/**
 * The proxy protocol lowercases module paths, escaping each original uppercase
 * letter as `!` + lowercase, so distinct paths stay distinct on case-insensitive
 * filesystems.
 */
export function escapeModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, (char) => `!${char.toLowerCase()}`);
}

/** Recognises the common forges so we can offer a real repository link. */
function repositoryFromModulePath(modulePath: string): string | undefined {
  const segments = modulePath.split('/');
  const host = segments[0];
  if (
    ['github.com', 'gitlab.com', 'bitbucket.org'].includes(host) &&
    segments.length >= 3
  ) {
    return `https://${segments.slice(0, 3).join('/')}`;
  }
  return undefined;
}
