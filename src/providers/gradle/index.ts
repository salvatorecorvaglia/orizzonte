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
    _ctx: ProviderContext,
  ): Promise<ParsedManifest> {
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
      throw new Error(`Invalid TOML: ${absolutePath}`);
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
        declaration: alias,
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
    const source = maskComments(text);

    // Matches: implementation 'g:a:v'  /  implementation("g:a:v")
    const literalPattern = new RegExp(
      String.raw`\b(${CONFIGURATION_NAMES})\s*(?:\(\s*)?['"]([^'":\s]+):([^'":\s]+)(?::([^'"\s]+))?['"]`,
      'g',
    );

    for (const match of source.matchAll(literalPattern)) {
      const [, configuration, group, artifact, version] = match;
      const name = `${group}:${artifact}`;
      const scope = CONFIGURATION_SCOPES[configuration] ?? 'prod';
      const key = `${configuration}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // A version that is still a Gradle interpolation is not a real version.
      const literalVersion =
        version && !version.includes('$') ? version : undefined;

      dependencies.push({
        key: dependencyKey(absolutePath, scope, `${configuration}:${name}`),
        declaration: configuration,
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
    _ctx: ProviderContext,
    _signal?: AbortSignal,
  ): Promise<PackageMeta | undefined> {
    return fetchMavenMetadata(name);
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

  /**
   * None. Gradle has no command that updates declared versions — the one this
   * used to run, `dependencies --write-locks`, rewrites lock state and changes
   * nothing in the build script, so "Update All" reported success and left
   * every row outdated. Returning null makes the host update each package
   * through `editManifest` instead, which does change the declared versions.
   */
  updateAllCommand(_toolchain: Toolchain): Command | null {
    return null;
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
      | {
          kind: 'update';
          name: string;
          version: string;
          scope: DepScope;
          declaration?: string;
        }
      | { kind: 'remove'; name: string; scope: DepScope },
  ): string | null {
    if (edit.kind !== 'update') {
      // Adding or removing means choosing a configuration and a location in a
      // script we cannot reliably reason about. Left to the user on purpose.
      return null;
    }

    const escaped = edit.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const source = maskComments(manifestText);
    const pattern = new RegExp(
      String.raw`\b(${CONFIGURATION_NAMES})\s*(?:\(\s*)?(['"])${escaped}:([^'"\s]+)\2`,
      'g',
    );
    const matches = [...source.matchAll(pattern)].filter(
      (match) =>
        CONFIGURATION_SCOPES[match[1]] === edit.scope &&
        (!edit.declaration || edit.declaration === match[1]),
    );
    if (matches.length === 1) {
      const match = matches[0];
      if (match[3].includes('$')) return null;
      const start = match.index + match[0].lastIndexOf(match[3]);
      return (
        manifestText.slice(0, start) +
        escapeGroovyOrKotlinString(edit.version, match[2]) +
        manifestText.slice(start + match[3].length)
      );
    }
    if (matches.length > 1 || !/^\s*\[libraries\]/m.test(manifestText))
      return null;
    return editCatalog(manifestText, edit.name, edit.version, edit.declaration);
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

/** Masks comments without moving declaration offsets or touching quoted URLs. */
function maskComments(text: string): string {
  let result = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      result += char;
      if (char === '\\' && i + 1 < text.length) result += text[++i];
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
      result += char;
    } else if (char === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const block = text[i + 1] === '*';
      result += '  ';
      i++;
      while (++i < text.length) {
        if (!block && text[i] === '\n') {
          result += '\n';
          break;
        }
        if (block && text[i] === '*' && text[i + 1] === '/') {
          result += '  ';
          i++;
          break;
        }
        result += text[i] === '\n' || text[i] === '\r' ? text[i] : ' ';
      }
    } else result += char;
  }
  return result;
}

function editCatalog(
  text: string,
  name: string,
  version: string,
  declaration?: string,
): string | null {
  let doc: {
    versions?: Record<string, string>;
    libraries?: Record<string, unknown>;
  };
  try {
    doc = parseToml(text) as typeof doc;
  } catch {
    return null;
  }
  const candidates = Object.entries(doc.libraries ?? {}).filter(
    ([alias, value]) =>
      (!declaration || alias === declaration) &&
      parseCatalogEntry(value, doc.versions ?? {})?.name === name,
  );
  if (candidates.length !== 1) return null;
  const [alias, entry] = candidates[0];
  const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const section = /(?:^|\n)\[libraries\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(
    text,
  );
  if (!section) return null;
  const line = new RegExp(
    String.raw`^\s*(?:${escapedAlias}|"${escapedAlias}"|'${escapedAlias}')\s*=.*$`,
    'm',
  ).exec(section[1]);
  if (!line) return null;
  const table =
    entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>)
      : undefined;
  const ref =
    table?.version && typeof table.version === 'object'
      ? (table.version as { ref?: string }).ref
      : undefined;
  if (ref) {
    const users = Object.values(doc.libraries ?? {}).filter(
      (value) =>
        value &&
        typeof value === 'object' &&
        (value as { version?: { ref?: string } }).version?.ref === ref,
    );
    if (users.length !== 1) return null;
    const sectionVersions =
      /(?:^|\n)\[versions\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(text);
    if (!sectionVersions) return null;
    const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const field = new RegExp(
      String.raw`^(\s*(?:${escapedRef}|"${escapedRef}"|'${escapedRef}')\s*=\s*)(["'])([^"']*)\2`,
      'm',
    ).exec(sectionVersions[1]);
    if (!field) return null;
    const start =
      sectionVersions.index +
      sectionVersions[0].indexOf(sectionVersions[1]) +
      field.index +
      field[1].length +
      1;
    return (
      text.slice(0, start) +
      escapeGroovyOrKotlinString(version, field[2]) +
      text.slice(start + field[3].length)
    );
  }
  const updated =
    typeof entry === 'string'
      ? line[0].replace(
          /(["'][^"']+:[^"']+:)[^"']+(["'])/,
          (_all, prefix: string, quote: string) =>
            `${prefix}${escapeGroovyOrKotlinString(version, quote)}${quote}`,
        )
      : line[0].replace(
          /(\bversion\s*=\s*)(["'])[^"']*\2/,
          (_all, prefix: string, quote: string) =>
            `${prefix}${quote}${escapeGroovyOrKotlinString(version, quote)}${quote}`,
        );
  if (updated === line[0]) return null;
  const start = section.index + section[0].indexOf(section[1]) + line.index;
  const result =
    text.slice(0, start) + updated + text.slice(start + line[0].length);
  try {
    parseToml(result);
  } catch {
    return null;
  }
  return result;
}
