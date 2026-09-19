/**
 * Gradle: build.gradle / build.gradle.kts, plus version catalogs.
 *
 * `build.gradle` is a Groovy/Kotlin *program*, not a data file — there is no
 * correct way to read it without executing it. Orizzonte therefore treats Gradle
 * as read-mostly and is explicit about which declarations it understands:
 *
 *   - `gradle/libs.versions.toml` version catalogs are real TOML and fully
 *     supported, including edits.
 *   - Literal `implementation "group:artifact:version"` declarations are read
 *     via pattern matching.
 *   - Anything computed at configuration time is shown read-only rather than
 *     guessed at.
 */

import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
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
  fetchMavenMetadata,
  fetchMavenVersions,
  searchMavenCentral,
} from '../shared/mavenCentral.js';

const COORDINATE_PATTERN = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;

/** Gradle configurations mapped onto our scope buckets. */
const CONFIGURATION_SCOPES: Record<string, DepScope> = {
  implementation: 'prod',
  api: 'prod',
  runtimeOnly: 'prod',
  compileOnly: 'build',
  annotationProcessor: 'build',
  kapt: 'build',
  ksp: 'build',
  testImplementation: 'dev',
  testRuntimeOnly: 'dev',
  testCompileOnly: 'dev',
  androidTestImplementation: 'dev',
  debugImplementation: 'dev',
};

const CONFIGURATION_NAMES = Object.keys(CONFIGURATION_SCOPES).join('|');

export class GradleProvider implements EcosystemProvider {
  readonly id = 'gradle' as const;
  readonly manifestFiles = [
    'build.gradle',
    'build.gradle.kts',
    'libs.versions.toml',
  ];
  readonly lockFiles = ['gradle.lockfile'];
  readonly osvEcosystem = 'Maven';
  readonly depsDevSystem = 'MAVEN';

  isValidPackageName(name: string): boolean {
    return COORDINATE_PATTERN.test(name);
  }

  async parse(
    absolutePath: string,
    text: string,
    ctx: ProviderContext,
  ): Promise<ParsedManifest> {
    void ctx;
    if (path.basename(absolutePath) === 'libs.versions.toml') {
      return this.parseVersionCatalog(absolutePath, text);
    }
    return this.parseBuildScript(absolutePath, text);
  }

  /**
   * Version catalogs are structured data, so this path is exact rather than
   * best-effort. Entries can be a coordinate string or a table with
   * `module`/`group`+`name` plus a literal or `version.ref` version.
   */
  private parseVersionCatalog(
    absolutePath: string,
    text: string,
  ): ParsedManifest {
    let doc: {
      versions?: Record<string, string>;
      libraries?: Record<string, unknown>;
    };
    try {
      doc = parseToml(text) as typeof doc;
    } catch {
      return emptyManifest(absolutePath);
    }

    const versions = doc.versions ?? {};
    const projectLabel = `${path.basename(path.dirname(path.dirname(absolutePath)))} (catalog)`;
    const dependencies: Dependency[] = [];

    for (const [alias, entry] of Object.entries(doc.libraries ?? {})) {
      const parsed = parseCatalogEntry(entry, versions);
      if (!parsed) continue;

      dependencies.push({
        // Keyed by alias, not by module: a catalog may point two aliases at
        // one module (a bom and its artifact, or a rename kept for
        // compatibility), and two rows sharing a key break row selection.
        key: dependencyKey(absolutePath, 'prod', `${alias}:${parsed.name}`),
        name: parsed.name,
        ecosystem: 'gradle',
        scope: 'prod',
        declared: parsed.version ?? 'unspecified',
        installed: parsed.version,
        updateKind: 'unknown',
        vulnerabilities: [],
        manifestPath: absolutePath,
        // The alias is how the developer refers to it, so keep it visible.
        projectLabel: `${projectLabel} · ${alias}`,
      });
    }

    return {
      ecosystem: 'gradle',
      path: absolutePath,
      name: projectLabel,
      dependencies,
    };
  }

  private parseBuildScript(absolutePath: string, text: string): ParsedManifest {
    const projectLabel = path.basename(path.dirname(absolutePath));
    const dependencies: Dependency[] = [];
    const seen = new Set<string>();

    // Strip comments so commented-out dependencies do not show up as real ones.
    const source = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Matches: implementation 'g:a:v'  /  implementation("g:a:v")
    const literalPattern = new RegExp(
      String.raw`\b(${CONFIGURATION_NAMES})\s*(?:\(\s*)?['"]([^'":\s]+):([^'":\s]+)(?::([^'"\s]+))?['"]`,
      'g',
    );

    for (const match of source.matchAll(literalPattern)) {
      const [, configuration, group, artifact, version] = match;
      const name = `${group}:${artifact}`;
      const scope = CONFIGURATION_SCOPES[configuration] ?? 'prod';
      const key = `${scope}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // A version that is still a Gradle interpolation is not a real version.
      const literalVersion =
        version && !version.includes('$') ? version : undefined;

      dependencies.push({
        key: dependencyKey(absolutePath, scope, name),
        name,
        ecosystem: 'gradle',
        scope,
        declared: literalVersion ?? 'unspecified',
        installed: literalVersion,
        updateKind: 'unknown',
        vulnerabilities: [],
        manifestPath: absolutePath,
        projectLabel,
      });
    }

    // Catalog references (`libs.foo.bar`) are deliberately not resolved here:
    // `gradle/libs.versions.toml` is discovered and parsed as a manifest in its
    // own right, so following the reference would list every catalog entry
    // twice.

    return {
      ecosystem: 'gradle',
      path: absolutePath,
      name: projectLabel,
      dependencies,
    };
  }

  async detectToolchain(
    manifestPath: string,
    ctx: ProviderContext,
  ): Promise<Toolchain> {
    // A version catalog lives in `<root>/gradle/`, so its build directory is two
    // levels up rather than alongside it.
    const cwd =
      path.basename(manifestPath) === 'libs.versions.toml'
        ? path.dirname(path.dirname(manifestPath))
        : path.dirname(manifestPath);

    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    const hasWrapper = await ctx.exists(path.join(cwd, wrapper));

    return {
      id: 'gradle',
      ecosystem: 'gradle',
      cwd,
      ...(hasWrapper
        ? { wrapper: process.platform === 'win32' ? wrapper : `./${wrapper}` }
        : {}),
    };
  }

  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    return fetchMavenVersions(names, 'gradle', ctx, signal);
  }

  async fetchMetadata(
    name: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<PackageMeta | undefined> {
    return fetchMavenMetadata(name, ctx, signal);
  }

  async search(
    query: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    return searchMavenCentral(query, 'gradle', ctx, signal);
  }

  installCommand(): Command | null {
    return null; // handled via editManifest
  }

  updateCommand(): Command | null {
    return null;
  }

  uninstallCommand(): Command | null {
    return null;
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    // Only meaningful when dependency locking is switched on. Falls back to a
    // system `gradle` when the project ships no wrapper.
    return {
      argv: [toolchain.wrapper ?? 'gradle', 'dependencies', '--write-locks'],
      cwd: toolchain.cwd,
      description: 'Refresh Gradle dependency locks',
    };
  }

  /**
   * Edits only what can be edited safely: a literal version inside a build
   * script, or a version in a catalog. Returns null when the declaration is
   * computed, so the host surfaces "open the file" rather than corrupting it.
   */
  editManifest(
    manifestText: string,
    edit:
      | { kind: 'add'; name: string; version: string | null; scope: DepScope }
      | { kind: 'update'; name: string; version: string; scope: DepScope }
      | { kind: 'remove'; name: string; scope: DepScope },
  ): string | null {
    if (edit.kind !== 'update') {
      // Adding or removing means choosing a configuration and a location in a
      // script we cannot reliably reason about. Left to the user on purpose.
      return null;
    }

    const escaped = edit.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Build-script form: 'group:artifact:version'. A version containing `$` is
    // an interpolation pointing at a variable or catalog entry — overwriting it
    // with a literal would silently break that indirection everywhere else it
    // is used, so we decline and let the caller open the file instead.
    const literal = new RegExp(String.raw`(['"]${escaped}:)([^'"\s]+)(['"])`);
    const literalMatch = literal.exec(manifestText);
    if (literalMatch) {
      if (literalMatch[2].includes('$')) {
        return null;
      }
      // Uses a replacer function, not string interpolation: the version is
      // validated upstream, but a literal `$` in a replacement string is a
      // backreference, and this is the one place that would matter.
      return manifestText.replace(
        literal,
        (_full, prefix: string, _old: string, quote: string) =>
          `${prefix}${escapeGroovyOrKotlinString(edit.version, quote)}${quote}`,
      );
    }

    // Catalog form: module = "group:artifact" with an adjacent version.
    const [group, artifact] = edit.name.split(':');
    const catalogLine = new RegExp(
      String.raw`(module\s*=\s*"${escaped}"\s*,\s*version\s*=\s*")([^"]+)(")`,
    );
    if (catalogLine.test(manifestText)) {
      return manifestText.replace(
        catalogLine,
        (_full, prefix: string, _old: string, quote: string) =>
          `${prefix}${escapeGroovyOrKotlinString(edit.version, quote)}${quote}`,
      );
    }

    const splitForm = new RegExp(
      String.raw`(group\s*=\s*"${group}"\s*,\s*name\s*=\s*"${artifact}"\s*,\s*version\s*=\s*")([^"]+)(")`,
    );
    if (splitForm.test(manifestText)) {
      return manifestText.replace(
        splitForm,
        (_full, prefix: string, _old: string, quote: string) =>
          `${prefix}${escapeGroovyOrKotlinString(edit.version, quote)}${quote}`,
      );
    }

    return null;
  }
}

/**
 * Escapes a value for interpolation into a single- or double-quoted
 * Groovy/Kotlin string literal.
 *
 * Belt-and-suspenders: `validateVersion` already rejects quotes and
 * backslashes before an edit reaches here, but `editManifest` is a public
 * method, not one only reachable through that gate, so it defends itself the
 * same way the Maven provider's XML escaping does.
 */
function escapeGroovyOrKotlinString(value: string, quote: string): string {
  const escaped = value.replace(/\\/g, '\\\\');
  return quote === "'"
    ? escaped.replace(/'/g, "\\'")
    : escaped.replace(/"/g, '\\"');
}

function parseCatalogEntry(
  entry: unknown,
  versions: Record<string, string>,
): { name: string; version?: string } | null {
  if (typeof entry === 'string') {
    // Shorthand: "group:artifact:version"
    const parts = entry.split(':');
    if (parts.length < 2) return null;
    return { name: `${parts[0]}:${parts[1]}`, version: parts[2] };
  }

  if (!entry || typeof entry !== 'object') return null;
  const table = entry as Record<string, unknown>;

  const name =
    typeof table.module === 'string'
      ? table.module
      : typeof table.group === 'string' && typeof table.name === 'string'
        ? `${table.group}:${table.name}`
        : null;
  if (!name) return null;

  let version: string | undefined;
  if (typeof table.version === 'string') {
    version = table.version;
  } else if (table.version && typeof table.version === 'object') {
    const versionTable = table.version as Record<string, unknown>;
    if (typeof versionTable.ref === 'string') {
      version = versions[versionTable.ref];
    } else if (typeof versionTable.require === 'string') {
      version = versionTable.require;
    }
  } else if (typeof table['version.ref'] === 'string') {
    version = versions[table['version.ref'] as string];
  }

  return { name, version };
}

function emptyManifest(absolutePath: string): ParsedManifest {
  return {
    ecosystem: 'gradle',
    path: absolutePath,
    name: path.basename(path.dirname(absolutePath)),
    dependencies: [],
  };
}
