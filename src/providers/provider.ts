/**
 * The contract every ecosystem implements.
 *
 * Adding a language means adding one folder under `src/providers/` and
 * registering it in `registry.ts` — nothing above this layer changes.
 */

import type { TtlCache } from '../core/cache.js';
import type { HttpClient } from '../core/http.js';
import type {
  Dependency,
  DepScope,
  Ecosystem,
  PackageMeta,
  ParsedManifest,
  SearchResult,
  Toolchain,
} from '../core/types.js';

export interface ProviderContext {
  http: HttpClient;
  cache: TtlCache;
  /** Reads a workspace file as UTF-8; resolves to null when absent. */
  readFile(absolutePath: string): Promise<string | null>;
  /** True when the path exists (file or directory). */
  exists(absolutePath: string): Promise<boolean>;
  /** Per-ecosystem registry base URL overrides from settings. */
  registryOverride(ecosystem: Ecosystem): string | undefined;
  /**
   * The `Authorization` header for a private registry override, when one is
   * configured with a `tokenEnvVar` and that environment variable is set.
   * Undefined otherwise — including when `registryOverride` itself would
   * return undefined, so a bad URL can never leave a token pointed at the
   * public registry.
   */
  registryAuthHeaders(ecosystem: Ecosystem): Record<string, string> | undefined;
  /** User's forced toolchain choice, or 'auto'. */
  preferredToolchain(ecosystem: Ecosystem): string;
  /**
   * The workspace folder `absolutePath` belongs to, or undefined when it
   * belongs to none.
   *
   * The lockfile search walks upward from a manifest (a workspace member has
   * no lockfile of its own), and this is where that walk has to stop: a
   * lockfile above the workspace folder describes a project the user did not
   * open. See `core/lockfiles/resolve.ts`.
   */
  workspaceRootFor(absolutePath: string): string | undefined;
  /**
   * Scratch space shared by every lockfile lookup within one scan, so the root
   * lockfile a whole workspace shares is read and parsed once rather than once
   * per member. Absent outside a scan, where there is nothing to share.
   */
  lockfileMemo?: Map<string, unknown>;
}

/** Version facts for a single package, as returned by a registry. */
export interface VersionInfo {
  /** Every published version, unsorted. */
  versions: string[];
  /** The registry's own notion of "latest", which may exclude prereleases. */
  latest?: string;
  /** Deprecation notice for the package as a whole. */
  deprecated?: string;
  /** Unpacked size or package size in bytes for the latest version. */
  sizeBytes?: number;
}

/** A command to run, expressed as argv so nothing is shell-interpolated. */
export interface Command {
  argv: string[];
  cwd: string;
  /** Shown to the user before the command runs. */
  description: string;
  /**
   * False when running this leaves the manifest untouched, so the host must
   * also apply `editManifest` for the change to survive.
   *
   * `pip install` is the case that matters: it installs into the environment
   * and writes nothing back, so without the paired edit the package disappears
   * again on the next `pip install -r requirements.txt`. Defaults to true,
   * because every other package manager records what it did.
   */
  writesManifest?: boolean;
}

export interface EcosystemProvider {
  readonly id: Ecosystem;

  /** File names (not globs) this provider claims. */
  readonly manifestFiles: string[];

  /**
   * Extra glob patterns this provider's manifests can take, where a fixed name
   * cannot describe them.
   *
   * Only Python needs this: `requirements.txt` is one of a family whose other
   * members are named freely (`requirements-dev.txt`, `requirements-ci.txt`).
   * That pattern used to be spelled out in `registry.ts` and again in
   * `watcher.ts`, both times beside names those files derive from providers —
   * so the one ecosystem fact in the list lived everywhere except with its
   * ecosystem.
   */
  readonly manifestGlobs?: string[];

  /** Lockfiles worth watching for change, and parsing for resolved versions. */
  readonly lockFiles: string[];

  /** Validates a package name before it can reach a command line. */
  isValidPackageName(name: string): boolean;

  /**
   * Validates a version or constraint before it can reach a command line.
   *
   * Versions arrive from registry search results and from the webview, so they
   * are no more trusted than names are. Providers that accept an unusual
   * grammar (Maven ranges, Composer stability flags) override the default.
   */
  isValidVersion?(version: string): boolean;

  parse(
    absolutePath: string,
    text: string,
    ctx: ProviderContext,
  ): Promise<ParsedManifest>;

  /**
   * Reads resolved versions out of a lockfile, keyed by package name.
   * Returning an empty map is fine — the UI falls back to the constraint.
   *
   * Keys are in the ecosystem's canonical form; implement `normalizeName` when
   * that differs from what the manifest writes, or the two never meet.
   */
  readLockfile?(
    manifestDir: string,
    ctx: ProviderContext,
  ): Promise<Map<string, string>>;

  /**
   * The ecosystem's canonical form of a package name, where it has one.
   *
   * Only Python needs this today (PEP 503 collapses runs of `-_.` to a single
   * hyphen and lowercases), but any ecosystem whose lockfile spells names
   * differently from its manifest belongs here.
   */
  normalizeName?(name: string): string;

  /**
   * @param manifestText The manifest's contents, when the caller already has
   *   them. Optional so callers that do not (the mutator, acting on a user
   *   gesture) need not read the file just to pass it; providers that use it
   *   fall back to reading. The scanner *does* have it — it just parsed the
   *   file — and was otherwise reading every manifest in the workspace twice
   *   on every scan.
   */
  detectToolchain(
    manifestPath: string,
    ctx: ProviderContext,
    manifestText?: string,
  ): Promise<Toolchain>;

  /** Batched version lookup. Implementations should respect `signal`. */
  fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>>;

  fetchMetadata(
    name: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<PackageMeta | undefined>;

  search(
    query: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<SearchResult[]>;

  /** The OSV.dev ecosystem string, when OSV covers this ecosystem. */
  readonly osvEcosystem?: string;

  /** The deps.dev system name, when deps.dev covers this ecosystem. */
  readonly depsDevSystem?: string;

  installCommand(
    toolchain: Toolchain,
    name: string,
    version: string | null,
    scope: DepScope,
  ): Command | null;

  updateCommand(
    toolchain: Toolchain,
    dep: Dependency,
    toVersion: string,
  ): Command | null;

  uninstallCommand(toolchain: Toolchain, dep: Dependency): Command | null;

  updateAllCommand(toolchain: Toolchain): Command | null;

  /**
   * Some ecosystems have no CLI for a given edit (requirements.txt pins, Maven
   * POM versions). Those providers implement this instead, returning the new
   * manifest text, and the host applies it as a WorkspaceEdit.
   */
  editManifest?(
    manifestText: string,
    edit:
      | { kind: 'add'; name: string; version: string | null; scope: DepScope }
      | { kind: 'update'; name: string; version: string; scope: DepScope }
      | { kind: 'remove'; name: string; scope: DepScope },
  ): string | null;
}

/**
 * The default version grammar, deliberately narrow.
 *
 * Every ecosystem Orizzonte supports expresses versions and constraints with
 * digits, letters and a small set of punctuation. Nothing legitimate needs a
 * quote, a space, a backtick or a dollar sign — the characters that make shell
 * injection possible — so refusing them costs nothing and closes the category.
 */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+~^><=!*\-[\](),|]*$/;

export function isValidVersionDefault(version: string): boolean {
  return version.length <= 256 && VERSION_PATTERN.test(version);
}

/**
 * Validates a version against a provider's own rule, falling back to the shared
 * grammar. Callers use this rather than reaching for `provider.isValidVersion`
 * directly, so the fallback can never be forgotten.
 */
export function validateVersion(
  provider: EcosystemProvider,
  version: string,
): boolean {
  return provider.isValidVersion
    ? provider.isValidVersion(version)
    : isValidVersionDefault(version);
}

/** Maps an ecosystem's own scope vocabulary onto our five buckets. */
export function normalizeScope(raw: string): DepScope {
  const lower = raw.toLowerCase();
  if (lower.includes('dev') || lower === 'test' || lower === 'testing')
    return 'dev';
  if (lower === 'build' || lower === 'provided' || lower === 'compile-only')
    return 'build';
  if (lower.includes('optional')) return 'optional';
  if (lower.includes('peer')) return 'peer';
  return 'prod';
}

/** Builds the stable per-row identity the webview uses for selection. */
export function dependencyKey(
  manifestPath: string,
  scope: DepScope,
  name: string,
): string {
  return `${manifestPath}::${scope}::${name}`;
}
