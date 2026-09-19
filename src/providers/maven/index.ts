/**
 * Java: pom.xml driven by Maven.
 *
 * Maven has no `add`/`remove` CLI worth using, so this is the one provider that
 * edits its manifest directly. Version resolution has to cope with three
 * indirections: `${property}` placeholders, `<dependencyManagement>` defaults,
 * and versions inherited from a `<parent>`.
 */

import * as path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
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
  normalizeScope,
  type ProviderContext,
  type VersionInfo,
} from '../provider.js';
import {
  fetchMavenMetadata,
  fetchMavenVersions,
  searchMavenCentral,
} from '../shared/mavenCentral.js';

const COORDINATE_PATTERN = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;

interface PomDependency {
  groupId?: string;
  artifactId?: string;
  version?: string;
  scope?: string;
  optional?: string | boolean;
}

interface Pom {
  project?: {
    groupId?: string;
    artifactId?: string;
    version?: string;
    properties?: Record<string, string | number>;
    parent?: { groupId?: string; artifactId?: string; version?: string };
    modules?: { module?: string | string[] };
    dependencies?: { dependency?: PomDependency | PomDependency[] };
    dependencyManagement?: {
      dependencies?: { dependency?: PomDependency | PomDependency[] };
    };
  };
}

export class MavenProvider implements EcosystemProvider {
  readonly id = 'maven' as const;
  readonly manifestFiles = ['pom.xml'];
  readonly lockFiles = [];
  readonly osvEcosystem = 'Maven';
  readonly depsDevSystem = 'MAVEN';

  isValidPackageName(name: string): boolean {
    return COORDINATE_PATTERN.test(name);
  }

  /**
   * Maven versions, including the range syntax `[1.0,2.0)` and `(,1.0]`.
   *
   * Narrower than the shared default in two ways that matter here. This is the
   * one provider that writes versions into a *markup* file, and the shared
   * grammar permits `<` and `>` — inert on a command line, but enough to
   * produce a POM that no longer parses. `$` and quotes are excluded for the
   * usual command-line reasons; nothing Maven calls a version contains any of
   * them.
   */
  isValidVersion(version: string): boolean {
    // A range opens with `[` or `(`, so the first character cannot be
    // restricted to alphanumerics the way the shared grammar does.
    return (
      version.length <= 256 &&
      /^[A-Za-z0-9[(][A-Za-z0-9._+\-[\](),]*$/.test(version)
    );
  }

  async parse(
    absolutePath: string,
    text: string,
    _ctx: ProviderContext,
  ): Promise<ParsedManifest> {
    const parser = new XMLParser({
      ignoreAttributes: true,
      parseTagValue: false,
      trimValues: true,
    });

    let pom: Pom;
    try {
      pom = parser.parse(text) as Pom;
    } catch {
      return {
        ecosystem: 'maven',
        path: absolutePath,
        name: path.basename(path.dirname(absolutePath)),
        dependencies: [],
      };
    }

    const project = pom.project;
    if (!project) {
      return {
        ecosystem: 'maven',
        path: absolutePath,
        name: path.basename(path.dirname(absolutePath)),
        dependencies: [],
      };
    }

    const projectLabel =
      project.artifactId ?? path.basename(path.dirname(absolutePath));
    const properties = buildPropertyTable(project);

    // dependencyManagement supplies versions omitted in the dependency itself.
    const managed = new Map<string, string>();
    for (const entry of toArray(
      project.dependencyManagement?.dependencies?.dependency,
    )) {
      if (entry.groupId && entry.artifactId && entry.version) {
        managed.set(
          `${entry.groupId}:${entry.artifactId}`,
          resolveProperties(entry.version, properties),
        );
      }
    }

    const dependencies: Dependency[] = [];
    for (const entry of toArray(project.dependencies?.dependency)) {
      if (!entry.groupId || !entry.artifactId) continue;

      const name = `${resolveProperties(entry.groupId, properties)}:${resolveProperties(entry.artifactId, properties)}`;
      const scope = mavenScope(entry);

      const declared = entry.version
        ? resolveProperties(entry.version, properties)
        : (managed.get(name) ?? '');

      dependencies.push({
        key: dependencyKey(absolutePath, scope, name),
        name,
        ecosystem: 'maven',
        scope,
        // An empty string means "inherited"; the UI renders it as such rather
        // than pretending we know the number.
        declared: declared || 'managed',
        installed: declared || undefined,
        updateKind: 'unknown',
        vulnerabilities: [],
        manifestPath: absolutePath,
        projectLabel,
      });
    }

    const modules = toArray(project.modules?.module).filter(
      (module): module is string => typeof module === 'string',
    );

    return {
      ecosystem: 'maven',
      path: absolutePath,
      name: projectLabel,
      dependencies,
      workspaceMembers: modules,
      isWorkspaceRoot: modules.length > 0 && dependencies.length === 0,
    };
  }

  async detectToolchain(
    manifestPath: string,
    ctx: ProviderContext,
  ): Promise<Toolchain> {
    const cwd = path.dirname(manifestPath);
    // Prefer the wrapper when the project ships one — it pins the Maven version,
    // so using the system `mvn` could build with a different one than CI does.
    const wrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
    const hasWrapper = await ctx.exists(path.join(cwd, wrapper));
    return {
      id: 'maven',
      ecosystem: 'maven',
      cwd,
      // POSIX needs the explicit ./ since cwd is not on PATH.
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
    return fetchMavenVersions(names, 'maven', ctx, signal);
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
    return searchMavenCentral(query, 'maven', ctx, signal);
  }

  installCommand(): Command | null {
    // Maven has no `add`. The host applies `editManifest` and then runs a sync.
    return null;
  }

  updateCommand(): Command | null {
    return null;
  }

  uninstallCommand(): Command | null {
    return null;
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    // Provided by the versions plugin, which is fetched on demand.
    return {
      argv: [toolchain.wrapper ?? 'mvn', 'versions:use-latest-releases'],
      cwd: toolchain.cwd,
      description: 'Rewrite dependency versions to the latest releases',
    };
  }

  /**
   * Minimal, format-preserving XML edits.
   *
   * Deliberately string-level rather than re-serialising the parsed tree: a full
   * round-trip through the XML parser would reflow the whole file and produce an
   * unreviewable diff.
   */
  editManifest(
    manifestText: string,
    edit:
      | { kind: 'add'; name: string; version: string | null; scope: DepScope }
      | { kind: 'update'; name: string; version: string; scope: DepScope }
      | { kind: 'remove'; name: string; scope: DepScope },
  ): string | null {
    const coordinate = edit.name.split(':');
    if (coordinate.length !== 2) return null;
    const [groupId, artifactId] = coordinate;

    if (edit.kind === 'remove') {
      // Only ever the real declaration: deleting a managed default would drop
      // the version out from under every other module that relies on it.
      const block = findDeclaredBlock(manifestText, groupId, artifactId);
      if (!block) return null;
      // Take the leading whitespace with the block so we do not leave a blank line.
      const start = manifestText.lastIndexOf('\n', block.start) + 1;
      return (
        manifestText.slice(0, start) +
        manifestText.slice(block.end).replace(/^\r?\n/, '')
      );
    }

    if (edit.kind === 'update') {
      const block = findVersionBlock(manifestText, groupId, artifactId);
      if (!block) return null;
      const body = manifestText.slice(block.start, block.end);
      const updated = body.replace(
        /<version>[^<]*<\/version>/,
        // `$` is meaningful in a replacement string (`$1`, `$&`), so the
        // version goes in through a function rather than by interpolation.
        () => `<version>${escapeXml(edit.version)}</version>`,
      );
      return (
        manifestText.slice(0, block.start) +
        updated +
        manifestText.slice(block.end)
      );
    }

    // Add: insert before the closing </dependencies>, matching its indentation.
    // A managed entry is not a dependency of this module, so it does not count
    // as "already present".
    if (findDeclaredBlock(manifestText, groupId, artifactId)) return null;
    const closing = manifestText.lastIndexOf('</dependencies>');
    if (closing === -1) return null;

    const lineStart = manifestText.lastIndexOf('\n', closing) + 1;
    const indent = manifestText.slice(lineStart, closing);
    const inner = `${indent}    `;

    const versionLine = edit.version
      ? `\n${inner}<version>${escapeXml(edit.version)}</version>`
      : '';
    const scopeLine =
      edit.scope === 'dev' ? `\n${inner}<scope>test</scope>` : '';

    const snippet =
      `${indent}<dependency>\n` +
      `${inner}<groupId>${escapeXml(groupId)}</groupId>\n` +
      `${inner}<artifactId>${escapeXml(artifactId)}</artifactId>` +
      `${versionLine}${scopeLine}\n` +
      `${indent}</dependency>\n`;

    return (
      manifestText.slice(0, lineStart) + snippet + manifestText.slice(lineStart)
    );
  }
}

interface DependencyBlock {
  start: number;
  end: number;
  /** True when this element sits inside `<dependencyManagement>`. */
  managed: boolean;
  /** True when the element carries its own `<version>`. */
  hasVersion: boolean;
}

/**
 * Locates every `<dependency>` element matching a coordinate.
 *
 * A coordinate can legitimately appear twice: once in `<dependencyManagement>`
 * declaring the version for the whole reactor, and once in `<dependencies>`
 * requesting it. Which of the two an edit belongs in depends on the edit, so
 * this reports both and lets the caller choose.
 */
function findDependencyBlocks(
  text: string,
  groupId: string,
  artifactId: string,
): DependencyBlock[] {
  const managed = managedRanges(text);
  const blocks: DependencyBlock[] = [];

  for (const match of text.matchAll(/<dependency>[\s\S]*?<\/dependency>/g)) {
    const body = match[0];
    const g = /<groupId>\s*([^<]*)\s*<\/groupId>/.exec(body)?.[1]?.trim();
    const a = /<artifactId>\s*([^<]*)\s*<\/artifactId>/.exec(body)?.[1]?.trim();
    if (g !== groupId || a !== artifactId) continue;

    const start = match.index!;
    blocks.push({
      start,
      end: start + body.length,
      managed: managed.some(([from, to]) => start >= from && start < to),
      hasVersion: /<version>/.test(body),
    });
  }

  return blocks;
}

/**
 * Picks the element an update should rewrite.
 *
 * The declaration in `<dependencies>` wins whenever it pins its own version —
 * that is the one the user clicked, and rewriting the managed default instead
 * would silently change the version for every module in the reactor. Only when
 * the declaration defers (no `<version>` of its own) does the managed block
 * become the right place, because that is where the version actually lives.
 */
function findVersionBlock(
  text: string,
  groupId: string,
  artifactId: string,
): DependencyBlock | null {
  const blocks = findDependencyBlocks(text, groupId, artifactId);
  return (
    blocks.find((block) => !block.managed && block.hasVersion) ??
    blocks.find((block) => block.managed && block.hasVersion) ??
    null
  );
}

/** The declaration in `<dependencies>`, ignoring any managed default. */
function findDeclaredBlock(
  text: string,
  groupId: string,
  artifactId: string,
): DependencyBlock | null {
  return (
    findDependencyBlocks(text, groupId, artifactId).find(
      (block) => !block.managed,
    ) ?? null
  );
}

/** Character ranges covered by `<dependencyManagement>` blocks. */
function managedRanges(text: string): Array<[number, number]> {
  return [
    ...text.matchAll(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g),
  ].map((match) => [match.index!, match.index! + match[0].length]);
}

/** Collects `<properties>` plus the implicit project.* and parent.* values. */
function buildPropertyTable(
  project: NonNullable<Pom['project']>,
): Map<string, string> {
  const table = new Map<string, string>();
  for (const [key, value] of Object.entries(project.properties ?? {})) {
    table.set(key, String(value));
  }
  if (project.version) {
    table.set('project.version', project.version);
    table.set('pom.version', project.version);
  }
  if (project.groupId) table.set('project.groupId', project.groupId);
  if (project.parent?.version) {
    table.set('project.parent.version', project.parent.version);
  }
  return table;
}

/** Expands `${...}` placeholders, guarding against self-referential loops. */
function resolveProperties(
  value: string,
  properties: Map<string, string>,
): string {
  let result = value;
  for (let depth = 0; depth < 5 && result.includes('${'); depth++) {
    result = result.replace(
      /\$\{([^}]+)\}/g,
      (whole, key: string) => properties.get(key) ?? whole,
    );
  }
  return result;
}

function mavenScope(entry: PomDependency): DepScope {
  if (entry.optional === true || entry.optional === 'true') return 'optional';
  const raw = entry.scope ?? 'compile';
  if (raw === 'test') return 'dev';
  if (raw === 'provided' || raw === 'system') return 'build';
  return normalizeScope(raw);
}

/**
 * Escapes text destined for an XML element body.
 *
 * The second layer, not the first: `isValidVersion` and `isValidPackageName`
 * already refuse the characters that matter. This is here because those two
 * guard the *host's* path into `editManifest`, and a writer that produces
 * well-formed XML whatever it is handed does not depend on every future caller
 * having validated first — which is the assumption that tends to lapse.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
