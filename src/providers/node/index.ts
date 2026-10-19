/**
 * Node ecosystem: package.json driven by npm, yarn, pnpm or bun.
 *
 * npm's registry is the richest of the seven — it reports deprecation, unpacked
 * size and repository links inline — so this provider needs no side lookups.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { cacheKey } from '../../core/cache.js';
import { readInstalledVersions } from '../../core/lockfiles/installed.js';
import { ancestorDirectories } from '../../core/lockfiles/resolve.js';
import { npmScopeOf, privateNpmScopes } from '../../core/privateRegistries.js';
import type {
  Dependency,
  DependencySource,
  DepScope,
  PackageMeta,
  ParsedManifest,
  SearchResult,
  Toolchain,
  ToolchainId,
} from '../../core/types.js';
import {
  applyDeclaredPrefix,
  registryConstraint,
} from '../../core/versions/index.js';
import { isUpdatable } from '../../core/vocabulary.js';
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

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * Scoped or plain, matching npm's own naming rules.
 *
 * Uppercase is accepted even though the registry has rejected it for new
 * packages since 2017: names published before then keep their capitals, and a
 * project depending on one could otherwise never be updated or removed from the
 * panel.
 *
 * A leading `-` is not. Names reach an argv from package.json, and one spelled
 * like a flag (`--global`) would be read as one by the package manager — no
 * shell is involved, so quoting cannot help.
 */
const NAME_PATTERN =
  /^(?:@[A-Za-z0-9~][A-Za-z0-9-._~]*\/)?[A-Za-z0-9~][A-Za-z0-9-._~]*$/;

/**
 * Where a package.json specifier points, and the registry name behind an alias.
 *
 * Only `registry` specifiers name a package the registry serves under that
 * name. `workspace:` is a sibling in this repository, `file:`/`link:` a local
 * directory, a git URL or `owner/repo` a checkout, and an `http(s)` URL a
 * tarball — asking the public registry about any of them reports on a
 * stranger's package, and "updating" one replaces the local code with it.
 *
 * `catalog:` (pnpm) and `patch:` (Yarn) are registry packages whose version is
 * owned elsewhere — the workspace catalog, the patch descriptor — so they are
 * worth looking up but not safe to rewrite from here.
 */
export function classifyNodeSpecifier(declared: string): {
  source: DependencySource;
  registryName?: string;
} {
  const spec = declared.trim();
  if (spec.startsWith('workspace:')) return { source: 'workspace' };
  if (/^(?:catalog|patch):/.test(spec)) return { source: 'inherited' };
  if (/^(?:file|link|portal):/.test(spec) || /^(?:\.{1,2}|~)?\//.test(spec)) {
    return { source: 'path' };
  }
  if (spec.startsWith('npm:')) {
    const target = /^npm:((?:@[^@/]+\/)?[^@]+)/.exec(spec)?.[1];
    return target
      ? { source: 'alias', registryName: target }
      : { source: 'registry' };
  }
  if (/^https?:\/\//i.test(spec)) return { source: 'url' };
  if (
    /^(?:git(?:\+[a-z]+)?|github|gitlab|bitbucket|gist):/i.test(spec) ||
    /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec)
  ) {
    return { source: 'git' };
  }
  return { source: 'registry' };
}

interface PackageJson {
  name?: string;
  version?: string;
  packageManager?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The abbreviated packument — a fraction of the full document's size. */
interface Packument {
  name: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
  time?: Record<string, string>;
}

interface PackumentVersion {
  version: string;
  deprecated?: string;
  dist?: { unpackedSize?: number; tarball?: string; size?: number };
  description?: string;
  homepage?: string;
  repository?: string | { url?: string };
  author?: string | { name?: string };
  /** Modern packages report a bare SPDX string; old ones a `{ type }` object. */
  license?: string | { type?: string };
  /** Older still: an array of `{ type }`, from before `license` was singular. */
  licenses?: Array<{ type?: string }>;
}

/** Every shape npm has used for a package's license, oldest first. */
function licenseFromPackument(version: PackumentVersion): string | undefined {
  if (typeof version.license === 'string') return version.license;
  if (version.license?.type) return version.license.type;
  return version.licenses?.[0]?.type;
}

export class NodeProvider implements EcosystemProvider {
  readonly id = 'node' as const;
  readonly manifestFiles = ['package.json'];
  readonly lockFiles = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ];
  readonly osvEcosystem = 'npm';
  readonly depsDevSystem = 'NPM';

  isValidPackageName(name: string): boolean {
    return name.length <= 214 && NAME_PATTERN.test(name);
  }

  async parse(
    absolutePath: string,
    text: string,
    ctx: ProviderContext,
  ): Promise<ParsedManifest> {
    const errors: ParseError[] = [];
    const privateScopes = await this.privateScopes(absolutePath, ctx);
    const json = (parseJsonc(text, errors, { allowTrailingComma: true }) ??
      {}) as PackageJson;

    if (
      errors.length > 0 ||
      !json ||
      typeof json !== 'object' ||
      Array.isArray(json)
    )
      throw new Error(`Invalid JSON: ${absolutePath}`);

    const projectLabel = json.name ?? path.basename(path.dirname(absolutePath));
    const dependencies: Dependency[] = [];

    const buckets: Array<[Record<string, string> | undefined, DepScope]> = [
      [json.dependencies, 'prod'],
      [json.devDependencies, 'dev'],
      [json.optionalDependencies, 'optional'],
      [json.peerDependencies, 'peer'],
    ];

    for (const [record, scope] of buckets) {
      for (const [name, declared] of Object.entries(record ?? {})) {
        if (typeof declared !== 'string') continue;
        const classified = classifyNodeSpecifier(declared);
        const { registryName } = classified;
        // A scope an .npmrc sends to a private registry is not the public
        // registry's to answer for — asking it discloses an internal name.
        const npmScope = npmScopeOf(registryName ?? name);
        const source =
          (classified.source === 'registry' || classified.source === 'alias') &&
          ((npmScope !== undefined && privateScopes.has(npmScope)) ||
            privateScopes.has('*'))
            ? 'private'
            : classified.source;
        dependencies.push({
          key: dependencyKey(absolutePath, scope, name),
          name,
          ecosystem: 'node',
          scope,
          declared,
          updateKind: 'unknown',
          vulnerabilities: [],
          manifestPath: absolutePath,
          projectLabel,
          // Only recorded when it says something: an ordinary registry
          // dependency is the default every consumer already assumes.
          ...(source !== 'registry' ? { source } : {}),
          ...(registryName ? { registryName } : {}),
        });
      }
    }

    const workspaceGlobs = Array.isArray(json.workspaces)
      ? json.workspaces
      : (json.workspaces?.packages ?? []);

    return {
      ecosystem: 'node',
      path: absolutePath,
      name: projectLabel,
      dependencies,
      workspaceMembers: workspaceGlobs,
      isWorkspaceRoot: workspaceGlobs.length > 0 && dependencies.length === 0,
    };
  }

  /**
   * The npm scopes this project's `.npmrc` files send to a private registry:
   * each one from the manifest's directory up to the workspace folder, and
   * the user's own. Read per scan through the scan memo, so a monorepo's
   * members share one read of each file.
   *
   * None when `orizzonte.registryOverrides` names an npm registry: lookups
   * then go to the registry the user pointed Orizzonte at, which can answer
   * for private scopes itself.
   */
  private async privateScopes(
    manifestPath: string,
    ctx: ProviderContext,
  ): Promise<Set<string>> {
    const files = [
      ...ancestorDirectories(
        path.dirname(manifestPath),
        ctx.workspaceRootFor(manifestPath),
      ).map((dir) => path.join(dir, '.npmrc')),
      path.join(os.homedir(), '.npmrc'),
    ];

    const scopes = new Set<string>();
    for (const file of files) {
      const memoKey = `npmrc\u0000${file}`;
      let found = ctx.lockfileMemo?.get(memoKey) as Set<string> | undefined;
      if (!found) {
        const text = await ctx.readFile(file);
        found = text ? privateNpmScopes(text) : new Set<string>();
        ctx.lockfileMemo?.set(memoKey, found);
      }
      for (const scope of found) scopes.add(scope);
    }
    return scopes;
  }

  /**
   * Resolved versions from the nearest lockfile at or above `manifestDir`,
   * as this member resolves them — see `core/lockfiles/installed.ts`.
   */
  async readLockfile(
    manifestDir: string,
    ctx: ProviderContext,
    dependencies: Dependency[] = [],
  ): Promise<Map<string, string>> {
    return readInstalledVersions(
      'node',
      manifestDir,
      ctx,
      dependencies.map((dep) => ({ name: dep.name, declared: dep.declared })),
    );
  }

  /**
   * The package manager driving this manifest.
   *
   * Walks up to the workspace folder rather than looking only beside the
   * manifest. A workspace member carries neither a lockfile nor a
   * `packageManager` field of its own — both live at the root — so looking in
   * the member's directory alone read every pnpm, Yarn and bun monorepo as
   * npm, and ran `npm install` inside a pnpm workspace.
   *
   * The nearest directory with any signal wins, and within one directory the
   * `packageManager` field outranks a lockfile: it is the project's own
   * declaration. Commands still run in the member's directory, where every one
   * of these managers acts on that member.
   */
  async detectToolchain(
    manifestPath: string,
    ctx: ProviderContext,
    knownText?: string,
  ): Promise<Toolchain> {
    const cwd = path.dirname(manifestPath);
    const dirs = ancestorDirectories(cwd, ctx.workspaceRootFor(manifestPath));

    let declared: { id: string; major: string | undefined } | undefined;
    let locked: ToolchainId | undefined;
    let signalDir = cwd;

    for (const dir of dirs) {
      // The scanner has just parsed this file; re-reading it here doubled the
      // manifest reads of every scan for one regex against `packageManager`.
      const text =
        dir === dirs[0] && knownText !== undefined
          ? knownText
          : await ctx.readFile(path.join(dir, 'package.json'));
      const match = text ? PACKAGE_MANAGER_PATTERN.exec(text) : null;
      if (match && isNodeToolchain(match[1])) {
        declared = { id: match[1], major: match[2] };
      }
      if (!declared) {
        for (const [file, id] of LOCKFILE_TOOLCHAINS) {
          if (await ctx.exists(path.join(dir, file))) {
            locked = id;
            break;
          }
        }
      }
      if (declared || locked) {
        signalDir = dir;
        break;
      }
    }

    const preferred = ctx.preferredToolchain('node');
    // Checked rather than cast. `package.json` constrains this setting to an
    // enum, but the value ends up as argv[0] of a command — "the schema says
    // so" is a property of the manifest, not of this function.
    const id: ToolchainId = isNodeToolchain(preferred)
      ? preferred
      : declared && isNodeToolchain(declared.id)
        ? declared.id
        : (locked ?? 'npm');

    return {
      id,
      ecosystem: 'node',
      cwd,
      ...(signalDir !== cwd ? { isWorkspaceMember: true } : {}),
      ...(id === 'yarn'
        ? {
            yarnBerry: await isYarnBerry(
              dirs,
              declared?.id === 'yarn' ? declared.major : undefined,
              ctx,
            ),
          }
        : {}),
    };
  }

  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    const registry = ctx.registryOverride('node') ?? DEFAULT_REGISTRY;

    return fetchVersionsWithCache(
      names,
      ctx,
      8,
      (name) => cacheKey('npm', 'versions', registry, name),
      async (name) => {
        const packument = await ctx.http.getJson<Packument>(
          `${registry}/${encodeName(name)}`,
          {
            signal,
            headers: {
              // The abbreviated document drops README and other bulk.
              Accept: 'application/vnd.npm.install-v1+json',
              ...ctx.registryAuthHeaders('node'),
            },
          },
        );
        const versions = Object.keys(packument.versions ?? {});
        const latestTag = packument['dist-tags']?.latest;
        const latestVer = latestTag
          ? packument.versions?.[latestTag]
          : undefined;
        return {
          versions,
          latest: latestTag,
          deprecated: latestVer?.deprecated,
          sizeBytes: latestVer?.dist?.unpackedSize ?? latestVer?.dist?.size,
        };
      },
      // Names come straight from package.json, which is not ours to trust:
      // anything that is not a real npm name cannot resolve, and should not
      // be pasted into a URL to find that out. 404s are normal (private or
      // renamed packages); other failures (a malformed packument, a DNS
      // error) are just as unactionable per package, so every failure here
      // falls back to stale data rather than rejecting the whole batch and
      // losing results already fetched for sibling packages.
      (name) => this.isValidPackageName(name),
      'node',
    );
  }

  async fetchMetadata(
    name: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<PackageMeta | undefined> {
    // Names reaching here come from a manifest (the detail drawer and the
    // license summary both pass one straight through) and are no more ours to
    // trust than the ones `fetchVersions` already checks. Anything that is not
    // a real npm name cannot resolve, so there is nothing lost by not asking —
    // and a name is about to become a URL path segment.
    if (!this.isValidPackageName(name)) return undefined;

    const registry = ctx.registryOverride('node') ?? DEFAULT_REGISTRY;
    const key = cacheKey('npm', 'meta', registry, name);

    return fetchMetadataWithCache(
      key,
      ctx,
      async () => {
        // The full version document, not the abbreviated packument: the
        // abbreviated form is install-oriented and carries none of the fields we
        // need here (repository, homepage, description).
        const version = await ctx.http.getJson<PackumentVersion>(
          `${registry}/${encodeName(name)}/latest`,
          { signal, headers: ctx.registryAuthHeaders('node') },
        );
        if (!version) return undefined;

        const repository = normalizeRepositoryUrl(
          typeof version.repository === 'string'
            ? version.repository
            : version.repository?.url,
        );

        return {
          name,
          description: version.description,
          homepage: version.homepage,
          repository,
          changelogUrl: changelogUrlFor(repository),
          sizeBytes: version.dist?.unpackedSize,
          deprecated: version.deprecated,
          author:
            typeof version.author === 'string'
              ? version.author
              : version.author?.name,
          license: licenseFromPackument(version),
        };
      },
      this.id,
    );
  }

  async search(
    query: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const registry = ctx.registryOverride('node') ?? DEFAULT_REGISTRY;
    const url = `${registry}/-/v1/search?text=${encodeURIComponent(query)}&size=25`;

    interface SearchResponse {
      objects: Array<{
        package: {
          name: string;
          version: string;
          description?: string;
          links?: { repository?: string };
        };
        downloads?: { weekly?: number };
      }>;
    }

    const response = await ctx.http.getJson<SearchResponse>(url, {
      signal,
      headers: ctx.registryAuthHeaders('node'),
    });
    return response.objects.map((entry) => ({
      name: entry.package.name,
      version: entry.package.version,
      description: entry.package.description,
      ecosystem: 'node' as const,
      downloads: entry.downloads?.weekly,
      repository: normalizeRepositoryUrl(entry.package.links?.repository),
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

    const flags = scopeFlags(toolchain, scope);
    const verb = toolchain.id === 'npm' ? 'install' : 'add';
    const argv = [toolchain.id, verb, spec, ...flags];

    return {
      argv,
      cwd: toolchain.cwd,
      description: `Install ${spec}${scope === 'dev' ? ' as a dev dependency' : ''}`,
    };
  }

  updateCommand(
    toolchain: Toolchain,
    dep: Dependency,
    toVersion: string,
  ): Command | null {
    // A workspace sibling, a path, a git checkout or a catalog entry has no
    // registry version this manifest could move to: `pnpm add foo@^2` would
    // replace the local code with whatever the public registry calls `foo`.
    if (!isUpdatable(dep)) return null;

    // `toVersion` is a bare version from the registry. Re-applying the range
    // operator the manifest already uses (`^`, `~`) keeps the project's
    // constraint style instead of silently pinning an exact version.
    const version = applyDeclaredPrefix(
      registryConstraint(dep.declared),
      toVersion,
    );

    // An alias keeps its alias: `strip-ansi-cjs@npm:strip-ansi@^6.0.1`.
    if (dep.source === 'alias') {
      if (!dep.registryName || !this.isValidPackageName(dep.registryName)) {
        return null;
      }
      return this.installCommand(
        toolchain,
        dep.name,
        `npm:${dep.registryName}@${version}`,
        dep.scope,
      );
    }
    return this.installCommand(toolchain, dep.name, version, dep.scope);
  }

  uninstallCommand(toolchain: Toolchain, dep: Dependency): Command | null {
    if (!this.isValidPackageName(dep.name)) return null;
    const verb = toolchain.id === 'npm' ? 'uninstall' : 'remove';
    return {
      argv: [toolchain.id, verb, dep.name],
      cwd: toolchain.cwd,
      description: `Uninstall ${dep.name}`,
    };
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    // Each of these respects the declared ranges rather than jumping majors,
    // which is the behaviour people expect from an "update all" button.
    //
    // The verb is not shared: npm, pnpm and bun spell it `update`, Yarn 1
    // spells it `upgrade`. Yarn 2+ has no equivalent verb: its `up` needs a
    // package pattern and moves each match to its *latest* release, rewriting
    // the manifest. `up -R` with a match-all pattern is the within-ranges form
    // — it re-resolves every range and touches only the lockfile.
    const argv =
      toolchain.id === 'yarn'
        ? toolchain.yarnBerry
          ? ['yarn', 'up', '-R', '*']
          : ['yarn', 'upgrade']
        : [toolchain.id, 'update'];

    return {
      argv,
      cwd: toolchain.cwd,
      description: 'Update all dependencies within their declared ranges',
      reach: 'ranges',
    };
  }
}

/**
 * The flag that files an install under the right dependency bucket.
 *
 * The four managers agree on almost nothing here. npm and pnpm use the
 * `--save-*` family; Yarn 1 and bun use the short forms; Yarn 2+ dropped
 * `--optional` and `--peer` in favour of `--optional`/`--peer` on `yarn add`
 * only for peer, so anything it cannot express is left to the manifest.
 */
function scopeFlags(toolchain: Toolchain, scope: DepScope): string[] {
  const savePrefixed = toolchain.id === 'npm' || toolchain.id === 'pnpm';

  switch (scope) {
    case 'dev':
      return savePrefixed ? ['--save-dev'] : ['--dev'];
    case 'optional':
      return savePrefixed ? ['--save-optional'] : ['--optional'];
    case 'peer':
      return savePrefixed ? ['--save-peer'] : ['--peer'];
    default:
      return [];
  }
}

const PACKAGE_MANAGER_PATTERN = /"packageManager"\s*:\s*"([a-z]+)@(\d+)?/;

/** Lockfiles that identify a manager, checked in this order per directory. */
const LOCKFILE_TOOLCHAINS: ReadonlyArray<[string, ToolchainId]> = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

/**
 * Distinguishes Yarn 2+ from Yarn 1.
 *
 * Three signals, cheapest first: the major in `packageManager`, the presence of
 * `.yarnrc.yml` (Berry-only — v1 used `.yarnrc`), and the `__metadata` block
 * Berry writes at the top of every lockfile it owns. The files are looked for
 * in the same directories toolchain detection walked, since in a workspace
 * they sit at the root rather than beside the member.
 */
async function isYarnBerry(
  dirs: string[],
  declaredMajor: string | undefined,
  ctx: ProviderContext,
): Promise<boolean> {
  if (declaredMajor) return Number(declaredMajor) >= 2;
  for (const dir of dirs) {
    if (await ctx.exists(path.join(dir, '.yarnrc.yml'))) return true;
    const lock = await ctx.readFile(path.join(dir, 'yarn.lock'));
    if (lock !== null) return /^__metadata:/m.test(lock);
  }
  return false;
}

/** The four managers this provider knows how to drive. */
const NODE_TOOLCHAINS = ['npm', 'yarn', 'pnpm', 'bun'] as const;

function isNodeToolchain(
  value: string,
): value is (typeof NODE_TOOLCHAINS)[number] {
  return (NODE_TOOLCHAINS as readonly string[]).includes(value);
}

/** Encode scoped package names for npm registry API while preserving the leading '@'. */
function encodeName(name: string): string {
  return encodeURIComponent(name).replace(/^%40/, '@');
}
