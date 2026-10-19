/**
 * Python: pyproject.toml (PEP 621, Poetry, or uv) and requirements.txt,
 * driven by pip, uv or poetry.
 *
 * Two things make Python harder than the rest:
 *  - PyPI has no official JSON search API, so exact-name lookup is the primary
 *    path and a cached PEP 691 name index backs prefix search.
 *  - Requirement strings carry extras and environment markers
 *    (`requests[security]>=2.0; python_version < "3.11"`), which must be
 *    stripped before the name is usable.
 */

import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { cacheKey, credentialCacheKey, TTL } from '../../core/cache.js';
import { readInstalledVersions } from '../../core/lockfiles/installed.js';
import { ancestorDirectories } from '../../core/lockfiles/resolve.js';
import { normalizeName } from '../../core/pep503.js';
import type {
  Dependency,
  DependencyGroup,
  DependencySource,
  DepScope,
  PackageMeta,
  ParsedManifest,
  SearchResult,
  Toolchain,
} from '../../core/types.js';
import { maxVersion } from '../../core/versions/index.js';
import { isUpdatable } from '../../core/vocabulary.js';
import {
  type Command,
  dependencyKey,
  type EcosystemProvider,
  normalizeScope,
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

const DEFAULT_INDEX = 'https://pypi.org';

/** PEP 508 names: letters, digits, and single -_. separators. */
const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

interface PyPiResponse {
  info: {
    name: string;
    version: string;
    summary?: string;
    home_page?: string;
    yanked?: boolean;
    yanked_reason?: string;
    author?: string;
    project_urls?: Record<string, string>;
    requires_dist?: string[];
    /** Free text — a full license's worth, in the worst case — not an identifier. */
    license?: string;
    /** `"License :: OSI Approved :: MIT License"` and the like. */
    classifiers?: string[];
  };
  urls?: Array<{ size?: number; packagetype?: string }>;
}

/**
 * PyPI's `info.license` is free text a maintainer typed by hand — some paste
 * the entire license body into it — so it is trusted only when it is short
 * enough to plausibly be a name. `classifiers` is a controlled vocabulary and
 * tried first for that reason; its trailing segment is the readable part
 * (`"License :: OSI Approved :: MIT License"` -> `"MIT License"`).
 */
function licenseFromPyPi(info: PyPiResponse['info']): string | undefined {
  const classifier = info.classifiers?.find((entry) =>
    entry.startsWith('License ::'),
  );
  if (classifier) {
    const parts = classifier.split('::').map((part) => part.trim());
    const last = parts[parts.length - 1];
    if (last && last !== 'OSI Approved') return last;
  }

  const raw = info.license?.trim();
  if (raw && raw.length <= 40 && !raw.includes('\n')) return raw;

  return undefined;
}

/** PEP 691 simple index — the closest thing PyPI has to a package list. */
interface SimpleIndex {
  projects: Array<{ name: string }>;
}

export class PythonProvider implements EcosystemProvider {
  readonly id = 'python' as const;
  readonly manifestFiles = [
    'pyproject.toml',
    'requirements.txt',
    'requirements-dev.txt',
  ];
  /** `requirements-<anything>.txt`, which no fixed name can cover. */
  readonly manifestGlobs = ['requirements-*.txt'];
  readonly lockFiles = ['poetry.lock', 'uv.lock', 'Pipfile.lock'];
  readonly osvEcosystem = 'PyPI';
  readonly depsDevSystem = 'PYPI';

  isValidPackageName(name: string): boolean {
    return name.length <= 214 && NAME_PATTERN.test(name);
  }

  /** PEP 503: what `readLockfile` keys by, so the scanner can match manifests. */
  normalizeName(name: string): string {
    return normalizeName(name);
  }

  async parse(
    absolutePath: string,
    text: string,
    _ctx: ProviderContext,
  ): Promise<ParsedManifest> {
    const base = path.basename(absolutePath);
    return base === 'pyproject.toml'
      ? this.parsePyproject(absolutePath, text)
      : this.parseRequirements(absolutePath, text);
  }

  private parsePyproject(absolutePath: string, text: string): ParsedManifest {
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Invalid TOML: ${absolutePath}`);
    }

    const project = doc.project as Record<string, unknown> | undefined;
    const tool = doc.tool as Record<string, unknown> | undefined;
    const poetry = tool?.poetry as Record<string, unknown> | undefined;

    const projectLabel =
      (project?.name as string) ??
      (poetry?.name as string) ??
      path.basename(path.dirname(absolutePath));

    const dependencies: Dependency[] = [];
    // A pyproject can declare the same package twice — PEP 621 and Poetry
    // tables coexist during a migration, and extras repeat their base
    // requirements. Two rows sharing a key break selection and React
    // reconciliation, so the first declaration wins.
    const seen = new Set<string>();

    const add = (
      name: string,
      declared: string,
      scope: DepScope,
      group?: DependencyGroup,
      source?: DependencySource,
    ) => {
      if (!name) return;
      const identity = group
        ? `${normalizeName(name)}::${group.kind}::${group.name}`
        : normalizeName(name);
      const key = dependencyKey(absolutePath, scope, identity);
      if (seen.has(key)) return;
      seen.add(key);

      dependencies.push({
        key,
        name,
        ecosystem: 'python',
        scope,
        declared,
        updateKind: 'unknown',
        vulnerabilities: [],
        manifestPath: absolutePath,
        projectLabel,
        // The table it lives in, not just the scope it maps to: `uv remove`
        // and `poetry remove` have to be told which group to edit, and
        // `test`, `lint` and `docs` all collapse onto the same scope.
        ...(group ? { group } : {}),
        ...((source ?? requirementSource(declared) ?? uvSource(doc, name))
          ? {
              source:
                source ?? requirementSource(declared) ?? uvSource(doc, name),
            }
          : {}),
      });
    };

    // PEP 621: project.dependencies is a list of requirement strings.
    for (const entry of (project?.dependencies as string[] | undefined) ?? []) {
      const parsed = parseRequirement(entry);
      if (parsed) add(parsed.name, parsed.specifier, 'prod');
    }

    // PEP 735 / setuptools: optional-dependencies is a table of extras.
    const optional = project?.['optional-dependencies'] as
      | Record<string, string[]>
      | undefined;
    for (const [group, entries] of Object.entries(optional ?? {})) {
      const scope = normalizeScope(group);
      for (const entry of entries) {
        const parsed = parseRequirement(entry);
        if (parsed)
          add(parsed.name, parsed.specifier, scope, {
            kind: 'extra',
            name: group,
          });
      }
    }

    // PEP 735 dependency-groups (uv, pip 25+).
    const groups = doc['dependency-groups'] as
      | Record<string, unknown[]>
      | undefined;
    for (const [group, entries] of Object.entries(groups ?? {})) {
      const scope = normalizeScope(group);
      for (const entry of entries) {
        if (typeof entry !== 'string') continue; // skip {include-group = ...}
        const parsed = parseRequirement(entry);
        if (parsed)
          add(parsed.name, parsed.specifier, scope, {
            kind: 'group',
            name: group,
          });
      }
    }

    // Poetry uses tables keyed by name, with either a string or a table value.
    const poetryDeps = poetry?.dependencies as
      | Record<string, unknown>
      | undefined;
    for (const [name, value] of Object.entries(poetryDeps ?? {})) {
      if (name.toLowerCase() === 'python') continue; // the interpreter, not a package
      add(
        name,
        poetryConstraint(value),
        'prod',
        undefined,
        poetrySource(value),
      );
    }
    const poetryGroups = poetry?.group as
      | Record<string, { dependencies?: Record<string, unknown> }>
      | undefined;
    for (const [group, body] of Object.entries(poetryGroups ?? {})) {
      const scope = normalizeScope(group);
      for (const [name, value] of Object.entries(body.dependencies ?? {})) {
        add(
          name,
          poetryConstraint(value),
          scope,
          {
            kind: 'group',
            name: group,
          },
          poetrySource(value),
        );
      }
    }
    // Poetry's pre-1.2 dev group.
    const legacyDev = poetry?.['dev-dependencies'] as
      | Record<string, unknown>
      | undefined;
    for (const [name, value] of Object.entries(legacyDev ?? {})) {
      add(
        name,
        poetryConstraint(value),
        'dev',
        { kind: 'group', name: 'dev' },
        poetrySource(value),
      );
    }

    // uv workspace members.
    const uv = tool?.uv as Record<string, unknown> | undefined;
    const workspace = uv?.workspace as { members?: string[] } | undefined;

    return {
      ecosystem: 'python',
      path: absolutePath,
      name: projectLabel,
      dependencies,
      workspaceMembers: workspace?.members,
      isWorkspaceRoot:
        (workspace?.members?.length ?? 0) > 0 && dependencies.length === 0,
    };
  }

  private parseRequirements(
    absolutePath: string,
    text: string,
  ): ParsedManifest {
    const projectLabel = path.basename(path.dirname(absolutePath));
    // Convention: a file named *dev* holds dev dependencies.
    const scope: DepScope = /dev|test/i.test(path.basename(absolutePath))
      ? 'dev'
      : 'prod';
    const dependencies: Dependency[] = [];
    const seen = new Set<string>();

    for (const { text: logical } of logicalLines(text.split(/\r?\n/))) {
      const line = requirementPart(logical);
      if (line === '') continue;
      // Skip includes, editable installs, index URLs and bare flags.
      if (line.startsWith('-') || line.startsWith('--')) continue;
      // Skip direct URLs and local paths, which have no registry version.
      if (
        /^[a-z]+:\/\//i.test(line) ||
        line.startsWith('.') ||
        line.startsWith('/')
      )
        continue;

      const parsed = parseRequirement(line);
      if (!parsed) continue;

      const marker = line.includes(';')
        ? `::${line.slice(line.indexOf(';') + 1).trim()}`
        : '';
      const key = dependencyKey(
        absolutePath,
        scope,
        `${normalizeName(parsed.name)}${marker}`,
      );
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push({
        key,
        name: parsed.name,
        ecosystem: 'python',
        scope,
        declared: parsed.specifier,
        ...(requirementSource(parsed.specifier)
          ? { source: requirementSource(parsed.specifier) }
          : {}),
        updateKind: 'unknown',
        vulnerabilities: [],
        manifestPath: absolutePath,
        projectLabel,
      });
    }

    return {
      ecosystem: 'python',
      path: absolutePath,
      name: projectLabel,
      dependencies,
    };
  }

  /**
   * Resolved versions from the nearest uv.lock or poetry.lock at or above
   * `manifestDir` — see `core/lockfiles/installed.ts`. Keyed by PEP 503 name.
   */
  async readLockfile(
    manifestDir: string,
    ctx: ProviderContext,
    dependencies: Dependency[] = [],
  ): Promise<Map<string, string>> {
    return readInstalledVersions(
      'python',
      manifestDir,
      ctx,
      dependencies.map((dep) => ({
        name: normalizeName(dep.name),
        declared: dep.declared,
      })),
    );
  }

  /**
   * The tool driving this manifest.
   *
   * A requirements file is always pip's: `uv add` and `poetry add` write to
   * pyproject.toml, so detecting uv beside a `requirements-dev.txt` and running
   * `uv add` installed the package somewhere other than the file the user
   * picked.
   *
   * For pyproject.toml the lockfile walk goes up to the workspace folder. A uv
   * workspace member has no `uv.lock` of its own — the root holds it — so
   * looking only beside the manifest read every member as a pip project.
   */
  async detectToolchain(
    manifestPath: string,
    ctx: ProviderContext,
  ): Promise<Toolchain> {
    const cwd = path.dirname(manifestPath);
    const manifestFile = path.basename(manifestPath);
    const dirs = ancestorDirectories(cwd, ctx.workspaceRootFor(manifestPath));

    const venvPath = await this.findVenv(dirs, ctx);
    const base = {
      ecosystem: 'python' as const,
      cwd,
      venvPath,
      manifestFile,
    };

    if (manifestFile !== 'pyproject.toml') {
      return { ...base, id: 'pip' };
    }

    const preferred = ctx.preferredToolchain('python');
    if (preferred === 'pip' || preferred === 'uv' || preferred === 'poetry') {
      return { ...base, id: preferred };
    }

    for (const dir of dirs) {
      if (await ctx.exists(path.join(dir, 'uv.lock')))
        return { ...base, id: 'uv', ...memberFlag(dir, cwd) };
      if (await ctx.exists(path.join(dir, 'poetry.lock')))
        return { ...base, id: 'poetry', ...memberFlag(dir, cwd) };
    }

    // No lockfile — fall back to what pyproject.toml declares, here or at a
    // workspace root above.
    for (const dir of dirs) {
      const pyproject = await ctx.readFile(path.join(dir, 'pyproject.toml'));
      if (!pyproject) continue;
      if (/\[tool\.poetry[\].]/.test(pyproject))
        return { ...base, id: 'poetry', ...memberFlag(dir, cwd) };
      if (/\[tool\.uv[\].]/.test(pyproject))
        return { ...base, id: 'uv', ...memberFlag(dir, cwd) };
    }

    return { ...base, id: 'pip' };
  }

  /** The nearest virtualenv, beside the manifest or at a workspace root. */
  private async findVenv(
    dirs: string[],
    ctx: ProviderContext,
  ): Promise<string | undefined> {
    // An activated environment wins over anything on disk.
    const active = process.env.VIRTUAL_ENV;
    if (active) return active;
    for (const dir of dirs) {
      for (const candidate of ['.venv', 'venv', 'env']) {
        const full = path.join(dir, candidate);
        if (await ctx.exists(path.join(full, 'pyvenv.cfg'))) return full;
      }
    }
    return undefined;
  }

  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    const index = ctx.registryOverride('python') ?? DEFAULT_INDEX;

    return fetchVersionsWithCache(
      names,
      ctx,
      8,
      (name) => cacheKey('pypi', 'versions', index, name),
      async (name) => {
        // The PEP 691 simple endpoint is the supported source for the version
        // list; the legacy JSON `releases` key is deprecated.
        const simple = await ctx.http.getJson<{
          versions?: string[];
          files?: Array<{ filename?: string; size?: number }>;
        }>(`${index}/simple/${encodeURIComponent(normalizeName(name))}/`, {
          signal,
          headers: {
            Accept: 'application/vnd.pypi.simple.v1+json',
            ...ctx.registryAuthHeaders('python'),
          },
        });
        const versions = simple.versions ?? [];
        const lastFile = simple.files?.[simple.files.length - 1];
        return {
          versions,
          sizeBytes: lastFile?.size,
        };
      },
      // Names come from pyproject.toml and requirements files, and each one
      // becomes a URL path segment; one that is not a PEP 508 name cannot
      // resolve anyway.
      (name) => this.isValidPackageName(name),
      'python',
    );
  }

  async fetchMetadata(
    name: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<PackageMeta | undefined> {
    // Same reasoning as `fetchVersions`: names arrive from pyproject.toml and
    // requirements.txt, and one is about to become a URL path segment. This
    // also gives `search` its exact-name miss for a query that is not a name,
    // which then falls through to the index scan.
    if (!this.isValidPackageName(name)) return undefined;

    const index = ctx.registryOverride('python') ?? DEFAULT_INDEX;
    const key = cacheKey('pypi', 'meta', index, name);

    return fetchMetadataWithCache(
      key,
      ctx,
      async () => {
        const response = await ctx.http.getJson<PyPiResponse>(
          `${index}/pypi/${encodeURIComponent(name)}/json`,
          { signal, headers: ctx.registryAuthHeaders('python') },
        );
        const urls = response.info.project_urls ?? {};
        const repository = normalizeRepositoryUrl(
          urls.Source ??
            urls.Repository ??
            urls['Source Code'] ??
            urls.Homepage ??
            response.info.home_page,
        );
        // Prefer the wheel's size; sdists are misleadingly large.
        const wheel = response.urls?.find(
          (entry) => entry.packagetype === 'bdist_wheel',
        );

        return {
          name: response.info.name,
          description: response.info.summary,
          homepage: response.info.home_page,
          repository,
          changelogUrl:
            urls.Changelog ?? urls.Changes ?? changelogUrlFor(repository),
          sizeBytes: wheel?.size ?? response.urls?.[0]?.size,
          deprecated: response.info.yanked
            ? `Yanked from PyPI${response.info.yanked_reason ? `: ${response.info.yanked_reason}` : ''}`
            : undefined,
          author: response.info.author,
          license: licenseFromPyPi(response.info),
        };
      },
      this.id,
    );
  }

  /**
   * PyPI has no search API. We try an exact-name hit first (the common case
   * when someone types a package they already know), then fall back to
   * substring matching over the cached PEP 691 project index.
   */
  async search(
    query: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const index = ctx.registryOverride('python') ?? DEFAULT_INDEX;
    const results: SearchResult[] = [];

    const exact = await this.fetchMetadata(query, ctx, signal).catch(
      () => undefined,
    );
    if (exact) {
      const versions = await this.fetchVersions([query], ctx, signal);
      results.push({
        name: exact.name,
        // Ordered by PEP 440, not by position. The simple index makes no
        // promise about the order of `versions`, so taking the last entry
        // offered — and installed — whatever PyPI happened to list last,
        // which can be an old patch release or a prerelease.
        version:
          maxVersion('python', versions.get(query)?.versions ?? []) ?? '',
        description: exact.description,
        ecosystem: 'python',
        deprecated: exact.deprecated,
        repository: exact.repository,
      });
    }

    const names = await this.projectIndex(index, ctx, signal);
    const needle = normalizeName(query);
    const matches = candidateNames(names, needle)
      // Prefix matches are far more relevant than substring matches.
      .sort((a, b) => {
        const aPrefix = a.startsWith(needle) ? 0 : 1;
        const bPrefix = b.startsWith(needle) ? 0 : 1;
        return aPrefix - bPrefix || a.length - b.length;
      })
      .slice(0, 24);

    for (const name of matches) {
      results.push({ name, version: '', ecosystem: 'python' });
    }

    return results;
  }

  /**
   * Downloads and caches the full PyPI project list (large, so daily at most).
   *
   * Held in memory only. The index is over half a million names, and
   * `globalState` is a JSON blob VS Code loads and rewrites synchronously —
   * persisting this made every subsequent extension-host start pay for a search
   * the user may have run once. Re-fetching it after a reload costs one request
   * on the next search instead.
   *
   * Kept as one newline-delimited string rather than an array of names. Half a
   * million separate strings plus the array holding them costs several times
   * what the same characters cost joined, and this is retained for a day —
   * `persist: false` kept it out of `globalState`, but it still sat in the
   * memory mirror the whole time. Searching it is a scan either way.
   */
  private async projectIndex(
    index: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<string> {
    const key = credentialCacheKey(
      cacheKey('pypi', 'index', index),
      ctx.registryAuthHeaders('python'),
    );
    const cached = ctx.cache.get<string>(key);
    if (cached !== undefined) return cached;

    try {
      const response = await ctx.http.getJson<SimpleIndex>(`${index}/simple/`, {
        signal,
        headers: {
          Accept: 'application/vnd.pypi.simple.v1+json',
          ...ctx.registryAuthHeaders('python'),
        },
        timeoutMs: 60_000,
        /*
         * Keeping this out of `globalState` is only half the job: the ETag
         * cache in `http.ts` retains full response bodies, so revalidating a
         * tens-of-megabyte document would pin the raw JSON in memory for the
         * life of the window — undoing `persist: false` one layer down. The
         * parsed name list above is the copy worth keeping.
         */
        noCache: true,
      });
      // Leading and trailing delimiters so every name is bounded by one,
      // which is what lets `candidateNames` find line edges without a split.
      const joined = `\n${response.projects
        .map((entry) => normalizeName(entry.name))
        .join('\n')}\n`;
      await ctx.cache.set(key, joined, TTL.nameIndex, { persist: false });
      return joined;
    } catch {
      return ctx.cache.getStale<string>(key) ?? '';
    }
  }

  installCommand(
    toolchain: Toolchain,
    name: string,
    version: string | null,
    scope: DepScope,
  ): Command | null {
    // A fresh install has no group yet; dev and build land in the group both
    // tools call `dev`.
    const group: DependencyGroup | undefined =
      scope === 'dev' || scope === 'build'
        ? { kind: 'group', name: 'dev' }
        : undefined;
    return this.addCommand(toolchain, name, version, group);
  }

  updateCommand(
    toolchain: Toolchain,
    dep: Dependency,
    toVersion: string,
  ): Command | null {
    if (!isUpdatable(dep)) return null;
    // The group the package already lives in, so the update lands there
    // rather than as a second copy in `dev`.
    return this.addCommand(
      toolchain,
      dep.name,
      toVersion,
      dep.group,
      dep.declared,
    );
  }

  private addCommand(
    toolchain: Toolchain,
    name: string,
    version: string | null,
    group: DependencyGroup | undefined,
    declared?: string,
  ): Command | null {
    if (!this.isValidPackageName(name)) return null;
    const operator = version ? updateOperator(declared, toolchain.id) : '==';
    const spec = !version
      ? name
      : operator === '^' || operator === '~'
        ? `${name}@${operator}${version}`
        : `${name}${operator}${version}`;

    switch (toolchain.id) {
      case 'uv': {
        const flags = uvGroupFlags(group);
        return (
          flags && {
            argv: ['uv', 'add', ...flags, spec],
            cwd: toolchain.cwd,
            description: `Add ${spec} with uv`,
          }
        );
      }
      case 'poetry': {
        const flags = poetryGroupFlags(group);
        return (
          flags && {
            argv: ['poetry', 'add', ...flags, spec],
            cwd: toolchain.cwd,
            description: `Add ${spec} with Poetry`,
          }
        );
      }
      default:
        // pip installs into the environment and writes nothing back, so the
        // host pairs this with an `editManifest` call.
        return {
          argv: [pythonExe(toolchain), '-m', 'pip', 'install', spec],
          cwd: toolchain.cwd,
          description: `Install ${spec} with pip`,
          writesManifest: false,
        };
    }
  }

  uninstallCommand(toolchain: Toolchain, dep: Dependency): Command | null {
    if (!this.isValidPackageName(dep.name)) return null;
    switch (toolchain.id) {
      case 'uv': {
        const flags = uvGroupFlags(dep.group);
        return (
          flags && {
            argv: ['uv', 'remove', ...flags, dep.name],
            cwd: toolchain.cwd,
            description: `Remove ${dep.name} with uv`,
          }
        );
      }
      case 'poetry': {
        const flags = poetryGroupFlags(dep.group);
        return (
          flags && {
            argv: ['poetry', 'remove', ...flags, dep.name],
            cwd: toolchain.cwd,
            description: `Remove ${dep.name} with Poetry`,
          }
        );
      }
      default:
        return {
          argv: [
            pythonExe(toolchain),
            '-m',
            'pip',
            'uninstall',
            '-y',
            dep.name,
          ],
          cwd: toolchain.cwd,
          description: `Uninstall ${dep.name} with pip`,
          writesManifest: false,
        };
    }
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    switch (toolchain.id) {
      case 'uv':
        return {
          argv: ['uv', 'lock', '--upgrade'],
          cwd: toolchain.cwd,
          description: 'Upgrade all locked versions with uv',
          reach: 'ranges',
        };
      case 'poetry':
        return {
          argv: ['poetry', 'update'],
          cwd: toolchain.cwd,
          description: 'Update all with Poetry',
          reach: 'ranges',
        };
      default: {
        // pip has no "update all"; the requirements file is the source of
        // truth. It is named from the manifest rather than assumed, so a
        // project driven by `requirements-dev.txt` does not silently reinstall
        // a `requirements.txt` that may not even exist.
        if (toolchain.manifestFile === 'pyproject.toml') return null;
        const requirements = toolchain.manifestFile ?? 'requirements.txt';
        return {
          argv: [
            pythonExe(toolchain),
            '-m',
            'pip',
            'install',
            '--upgrade',
            '-r',
            requirements,
          ],
          cwd: toolchain.cwd,
          description: `Reinstall ${requirements} with upgrades`,
          reach: 'ranges',
        };
      }
    }
  }

  /**
   * requirements.txt has no CLI that can rewrite a pin, so we edit it directly —
   * line by line, preserving comments, ordering, extras, environment markers,
   * line endings and unrelated flags.
   *
   * Only requirements files. pyproject.toml is TOML with requirements inside
   * string arrays; editing it as lines appended `name==1.2.3` to the end of
   * the file and left it unparseable. Returning null there lets the host open
   * the file for a hand edit instead.
   *
   * A requirement pinned with `--hash` is refused too: the new version needs
   * new hashes, which cannot be computed here, and keeping the old ones makes
   * `pip install --require-hashes` fail on a mismatch.
   */
  editManifest(
    manifestText: string,
    edit:
      | { kind: 'add'; name: string; version: string | null; scope: DepScope }
      | { kind: 'update'; name: string; version: string; scope: DepScope }
      | { kind: 'remove'; name: string; scope: DepScope },
    manifestFile?: string,
  ): string | null {
    if (manifestFile !== undefined && !isRequirementsFile(manifestFile)) {
      return null;
    }

    const eol = manifestText.includes('\r\n') ? '\r\n' : '\n';
    const lines = manifestText.split(/\r?\n/);
    const target = normalizeName(edit.name);

    const matches = logicalLines(lines).filter((logical) => {
      const bare = requirementPart(logical.text);
      if (bare === '' || bare.startsWith('-')) return false;
      const parsed = parseRequirement(bare);
      return parsed ? normalizeName(parsed.name) === target : false;
    });

    if (edit.kind === 'remove') {
      if (matches.length === 0) return null;
      // Every declaration of it, including one per environment marker, and
      // every continuation line (`--hash=…`) that belongs to each.
      for (const match of [...matches].reverse()) {
        lines.splice(match.start, match.end - match.start + 1);
      }
      return lines.join(eol);
    }

    const pinned = edit.version ? `${edit.name}==${edit.version}` : edit.name;

    if (matches.length === 0) {
      if (edit.kind === 'update') return null;
      // Append, keeping exactly one trailing newline.
      while (lines.length > 0 && lines[lines.length - 1].trim() === '')
        lines.pop();
      lines.push(pinned, '');
      return lines.join(eol);
    }

    // Declared more than once (one line per environment marker): which of
    // them to move is the user's call, not ours.
    if (matches.length > 1) return null;
    const [match] = matches;
    if (/(?:^|\s)--hash[=\s]/.test(match.text)) return null;

    const original = lines[match.start];
    // The comment keeps the whitespace that separated it from the requirement.
    const commentMatch = /(?:^|\s+)#.*$/.exec(original);
    const body = commentMatch
      ? original.slice(0, commentMatch.index)
      : original;
    const comment = commentMatch?.[0] ?? '';

    const parsed = parseRequirement(body.trim());
    if (!parsed) return null;
    // `flask>=2` moves to `flask>=3.0.0`, not to a pin nobody asked for.
    const operator =
      edit.kind === 'update' ? updateOperator(parsed.specifier, 'pip') : '==';
    const leading = /^\s*/.exec(body)?.[0] ?? '';
    const extras = /^[^[;]*?(\[[^\]]*\])/.exec(body)?.[1] ?? '';
    // The marker, with whatever spacing preceded its `;`.
    const marker = /\s*;.*$/.exec(body.trimEnd())?.[0] ?? '';
    const specifier = edit.version ? `${operator}${edit.version}` : '';

    lines[match.start] =
      `${leading}${parsed.name}${extras}${specifier}${marker}${comment}`;
    return lines.join(eol);
  }
}

function pythonExe(toolchain: Toolchain): string {
  // Windows ships `python`; `python3` exists on POSIX and is the safer name
  // there, where `python` may still be a Python 2 interpreter.
  if (!toolchain.venvPath) {
    return process.platform === 'win32' ? 'python' : 'python3';
  }
  // Windows venvs put the interpreter in Scripts/, POSIX in bin/.
  return process.platform === 'win32'
    ? path.join(toolchain.venvPath, 'Scripts', 'python.exe')
    : path.join(toolchain.venvPath, 'bin', 'python');
}

/**
 * The operator an update should write, carried over from the declared
 * constraint so an update keeps the project's style rather than pinning.
 *
 * Only a single-operator constraint is carried: `>=2.28` becomes `>=2.32.3`,
 * but `>=2,<3` is pinned, because moving its lower bound past the upper one
 * would be a constraint nothing satisfies. Poetry's own `^` and `~` survive
 * for Poetry; for pip and uv, which speak only PEP 440, they are pinned.
 */
function updateOperator(
  declared: string | undefined,
  tool: string,
): '==' | '>=' | '~=' | '^' | '~' {
  const match = /^\s*(>=|~=|==|\^|~)\s*[\w.*+!-]+\s*$/.exec(declared ?? '');
  const operator = match?.[1];
  if (operator === '>=' || operator === '~=') return operator;
  if ((operator === '^' || operator === '~') && tool === 'poetry') {
    return operator;
  }
  return '==';
}

/** `requirements.txt`, `requirements-dev.txt`, `requirements_ci.txt`, … */
function isRequirementsFile(fileName: string): boolean {
  return /^requirements.*\.txt$/i.test(fileName);
}

/** Marks a toolchain found above the manifest as governing a member. */
function memberFlag(
  signalDir: string,
  cwd: string,
): { isWorkspaceMember?: true } {
  return signalDir !== cwd ? { isWorkspaceMember: true } : {};
}

/**
 * The group flags uv needs to find a package, or null when uv cannot express
 * the table it lives in.
 */
function uvGroupFlags(group: DependencyGroup | undefined): string[] | null {
  if (!group) return [];
  if (!isGroupName(group.name)) return null;
  if (group.kind === 'extra') return ['--optional', group.name];
  return group.name === 'dev' ? ['--dev'] : ['--group', group.name];
}

/**
 * Poetry's equivalent. Extras are left alone: Poetry 1.x takes `--optional` as
 * a bare switch and 2.x as `--optional <extra>`, and guessing wrong edits the
 * wrong table.
 */
function poetryGroupFlags(group: DependencyGroup | undefined): string[] | null {
  if (!group) return [];
  if (group.kind === 'extra' || !isGroupName(group.name)) return null;
  return ['--group', group.name];
}

/** Group and extra names, as PEP 685/735 allow them — and nothing flag-like. */
function isGroupName(name: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name);
}

/**
 * A requirements file's physical lines joined into logical ones.
 *
 * pip treats a trailing backslash as a line continuation, which is how
 * `pip-compile --generate-hashes` writes every entry: the requirement, then
 * one `--hash=…` per line. Read line by line, the requirement kept its `\` as
 * part of the specifier and the hash lines looked like stray flags.
 */
function logicalLines(
  lines: string[],
): Array<{ text: string; start: number; end: number }> {
  const result: Array<{ text: string; start: number; end: number }> = [];
  for (let start = 0; start < lines.length; start++) {
    let end = start;
    let text = lines[start];
    while (/\\\s*$/.test(text) && end + 1 < lines.length) {
      end++;
      text = `${text.replace(/\\\s*$/, ' ')}${lines[end]}`;
    }
    result.push({ text: text.replace(/\\\s*$/, ''), start, end });
    start = end;
  }
  return result;
}

/**
 * The requirement itself: comment removed, and per-requirement options
 * (`--hash`, `--config-settings`) cut off so they do not read as part of the
 * version specifier.
 */
function requirementPart(line: string): string {
  const commentIndex = line.search(/(?:^|\s)#/);
  const bare = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  return bare.replace(/\s+--?[A-Za-z][\s\S]*$/, '').trim();
}

/** PEP 503 name normalisation, shared with the lockfile readers. */
export { normalizeName };

/**
 * Splits a PEP 508 requirement into name and specifier, discarding extras and
 * environment markers.
 */
export function parseRequirement(
  input: string,
): { name: string; specifier: string; extras: string[] } | null {
  // Drop the environment marker.
  const withoutMarker = input.split(';')[0].trim();
  if (withoutMarker === '') return null;

  const match =
    /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*(.*)$/.exec(
      withoutMarker,
    );
  if (!match) return null;

  return {
    name: match[1],
    extras: match[2] ? match[2].split(',').map((extra) => extra.trim()) : [],
    specifier: match[3].trim(),
  };
}

/** Poetry values may be a string constraint or a table with a `version` key. */
function poetryConstraint(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'version' in value) {
    return String((value as { version: unknown }).version);
  }
  return '*';
}

function requirementSource(specifier: string): DependencySource | undefined {
  if (!specifier.trim().startsWith('@')) return undefined;
  const target = specifier.trim().slice(1).trim();
  if (/^(?:git|hg|svn|bzr)\+/.test(target)) return 'git';
  if (/^(?:file:|\.{0,2}\/)/.test(target)) return 'path';
  return 'url';
}

function poetrySource(value: unknown): DependencySource | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.path !== undefined) return 'path';
  if (entry.git !== undefined) return 'git';
  if (entry.url !== undefined) return 'url';
  if (entry.source !== undefined) return 'private';
  return undefined;
}

function uvSource(
  doc: Record<string, unknown>,
  name: string,
): DependencySource | undefined {
  const tool = doc.tool as
    | { uv?: { sources?: Record<string, unknown> } }
    | undefined;
  const entry = tool?.uv?.sources?.[name];
  if (Array.isArray(entry)) return 'private';
  if (!entry || typeof entry !== 'object') return undefined;
  if ('workspace' in entry) return 'workspace';
  if ('index' in entry) return 'private';
  return poetrySource(entry);
}

/**
 * Candidate names containing `needle`, walked over the joined index.
 *
 * `indexOf` from the last hit is what makes this a scan rather than half a
 * million separate `String.includes` calls with the intermediate array those
 * produced.
 */
function candidateNames(joined: string, needle: string): string[] {
  if (needle === '' || joined === '') return [];

  const matches: string[] = [];
  let from = 0;

  while (matches.length < MAX_INDEX_CANDIDATES) {
    const hit = joined.indexOf(needle, from);
    if (hit < 0) break;

    const start = joined.lastIndexOf('\n', hit) + 1;
    let end = joined.indexOf('\n', hit);
    if (end < 0) end = joined.length;

    const name = joined.slice(start, end);
    // An exact hit is already offered above, from the registry itself, with
    // a real version and description attached.
    if (name && name !== needle) matches.push(name);
    from = end + 1;
  }

  return matches;
}

/**
 * How many index hits are ranked before the top 24 are taken.
 *
 * A short query matches tens of thousands of names, and every one past this
 * is a name nobody scrolls to. Collecting them all — which is what filtering
 * the whole array did — costs an array proportional to the query's vagueness.
 */
const MAX_INDEX_CANDIDATES = 2000;
