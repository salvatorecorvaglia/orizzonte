/**
 * Discovers manifests, parses them, and enriches every dependency with
 * resolved versions, registry state, metadata and advisories.
 *
 * This is the orchestrator: providers know their own ecosystem, the scanner
 * knows the pipeline.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProviderContext, VersionInfo } from '../providers/provider.js';
import {
  manifestGlob,
  PROVIDERS,
  providerFor,
  providerForPath,
} from '../providers/registry.js';
import { mapWithConcurrency } from '../providers/shared/concurrency.js';
import { auditDependencies } from './audit.js';
import type {
  Dependency,
  Ecosystem,
  ParsedManifest,
  ProjectGroup,
  ScanSummary,
  SearchResult,
} from './types.js';
import {
  classifyUpdate,
  constraintToApproxVersion,
  maxSatisfying,
  maxVersion,
} from './versions/index.js';
import { assignWorkspaces, readSidecarMembers } from './workspaces.js';

export interface ScanResult {
  groups: ProjectGroup[];
  /**
   * Every manifest this scan parsed, including ones that declared no
   * dependencies of their own.
   *
   * `groups` deliberately omits those — a dependency-free workspace root has
   * no rows to show — but they are still files the scan found, and that is the
   * question the host's "is this a manifest I know about?" trust check is
   * really asking.
   */
  manifestPaths: string[];
  summary: ScanSummary;
}

/**
 * Upper bound on manifests discovered per scan.
 *
 * A cap is necessary — `findFiles` over a pathological tree is unbounded work —
 * but hitting one silently is how a monorepo quietly loses projects, so the
 * scanner reports when it truncates and the panel says so.
 */
const MAX_MANIFESTS = 2000;

/**
 * How many manifests are read and parsed at once.
 *
 * These are local filesystem reads, not registry calls, so the ceiling is the
 * extension host's own I/O rather than anyone's rate limit. Eight is enough to
 * keep the disk busy without flooding the event loop of a process that is also
 * drawing the editor.
 */
const MANIFEST_CONCURRENCY = 8;

/** What one manifest contributes to a scan. */
interface ManifestScan {
  manifest: ParsedManifest;
  members: string[];
  /** Absent when the manifest declares no dependencies of its own. */
  group?: ProjectGroup;
}

export class Scanner {
  /**
   * True when the last scan hit `MAX_MANIFESTS`. Read by the host so it can
   * tell the user results are incomplete rather than letting them assume the
   * missing projects simply do not exist.
   */
  private truncated = false;

  /**
   * Manifests found but not readable or not parseable in the last scan.
   *
   * These were dropped silently: the project simply did not appear, with
   * nothing on screen to distinguish "this file is malformed" from "there is
   * nothing here". The `MAX_MANIFESTS` truncation next to it has said so for
   * a while; this is the same courtesy for the other way results go missing.
   */
  private unreadable: string[] = [];

  /**
   * The in-flight scan's controller, so it can be called off.
   *
   * `scan` has always created one and threaded its signal through the manifest
   * walk, the version lookups and the audit — but nothing ever called `abort`,
   * so every `signal.aborted` branch below was unreachable and a scan could not
   * be stopped once started. That matters at shutdown: a scan of a large
   * monorepo outlives the window that asked for it, holding registry requests
   * open on behalf of an extension that is going away.
   */
  private inFlight: AbortController | undefined;

  get hitManifestLimit(): boolean {
    return this.truncated;
  }

  /** Paths the last scan could not read or parse. Empty on a clean scan. */
  get unreadableManifests(): readonly string[] {
    return this.unreadable;
  }

  /** The cap, so the message the host shows and the limit cannot disagree. */
  static readonly manifestLimit = MAX_MANIFESTS;

  constructor(private readonly ctx: ProviderContext) {}

  /**
   * Runs the full pipeline. `onPartial` fires once with manifest data before
   * any network call, so the table paints immediately and fills in after.
   *
   * Callers never overlap two scans: `ScanQueue` (see `core/scanQueue.ts`) is
   * the only production caller, and it never starts one while another is
   * still running.
   */
  async scan(
    options: { checkUpdates: boolean; audit: boolean },
    onPartial?: (result: ScanResult) => void,
  ): Promise<ScanResult> {
    // Defensive rather than expected: `ScanQueue` is the only production
    // caller and never overlaps two scans. If one ever does, the older scan is
    // the one whose result nobody is waiting for.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const signal = controller.signal;

    try {
      return await this.runScan(options, signal, onPartial);
    } finally {
      // Only clear the field if it still points at *this* scan; a newer one
      // has already replaced it otherwise.
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }

  /** Stops any in-flight scan. Called when the extension is disposed. */
  cancel(): void {
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  private async runScan(
    options: { checkUpdates: boolean; audit: boolean },
    signal: AbortSignal,
    onPartial?: (result: ScanResult) => void,
  ): Promise<ScanResult> {
    const { groups, manifestPaths } = await this.collectGroups(signal);

    const partial: ScanResult = {
      groups,
      manifestPaths,
      summary: summarize(groups, false),
    };
    onPartial?.(partial);

    if (!options.checkUpdates || groups.length === 0) {
      return partial;
    }

    let stale = false;
    try {
      // Only a total failure means "stale". One unreachable registry should
      // grey out its own ecosystem's rows, not relabel results that arrived
      // perfectly well from the other six.
      stale = await this.enrichVersions(groups, signal);

      // Deliberately outside the version-lookup outcome: advisories come from
      // OSV, not from the registries, so a registry being down is no reason to
      // skip the security check.
      if (options.audit) {
        await auditDependencies(groups, this.ctx, signal);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      stale = true;
    }

    return { groups, manifestPaths, summary: summarize(groups, stale) };
  }

  /** Finds and parses every manifest in the workspace. */
  private async collectGroups(
    signal: AbortSignal,
  ): Promise<{ groups: ProjectGroup[]; manifestPaths: string[] }> {
    const excludes = [
      ...vscode.workspace
        .getConfiguration('orizzonte')
        .get<string[]>('excludeGlobs', []),
      ...(await this.gitignoreExcludes()),
    ];
    const excludePattern =
      excludes.length > 0 ? `{${excludes.join(',')}}` : undefined;

    this.unreadable = [];
    const uris = await vscode.workspace.findFiles(
      manifestGlob(),
      excludePattern,
      MAX_MANIFESTS,
    );
    this.truncated = uris.length >= MAX_MANIFESTS;

    /*
     * Read and parse manifests a few at a time rather than strictly one after
     * another.
     *
     * Each manifest costs several awaited filesystem round-trips — the file,
     * a sidecar workspace file, the toolchain probes, a lockfile — and a
     * monorepo can hold hundreds. Done sequentially that is thousands of
     * serialised reads before the table paints anything.
     *
     * Results are written into a slot rather than pushed, so the output order
     * is the order `findFiles` returned regardless of which read finishes
     * first. Nothing downstream depends on that order — `assignWorkspaces`
     * keys by path and the groups are sorted by label below — but a scan whose
     * result varies with disk timing is not one anybody can reason about.
     */
    const slots = new Array<ManifestScan | undefined>(uris.length);

    await mapWithConcurrency(
      uris.map((uri, index) => ({ uri, index })),
      MANIFEST_CONCURRENCY,
      async ({ uri, index }) => {
        // A superseded scan stops here rather than walking the rest of the
        // workspace to produce a result the caller has already discarded.
        if (signal.aborted) return;
        slots[index] = await this.scanManifest(uri.fsPath);
      },
    );

    const groups: ProjectGroup[] = [];
    const manifestPaths: string[] = [];
    // Collected alongside the groups so workspace membership can be resolved
    // once every manifest is known.
    const parsed: Array<{ manifest: ParsedManifest; members: string[] }> = [];

    for (const slot of slots) {
      if (!slot) continue;
      parsed.push({ manifest: slot.manifest, members: slot.members });
      manifestPaths.push(slot.manifest.path);
      if (slot.group) groups.push(slot.group);
    }

    this.applyWorkspaceInfo(groups, parsed);

    groups.sort((a, b) => a.label.localeCompare(b.label));
    return { groups, manifestPaths };
  }

  /**
   * Everything one manifest contributes: its parsed form, the workspace members
   * it declares, and — when it has dependencies of its own — the group the
   * table shows.
   *
   * Returns undefined when the file is unreadable or unparseable. One bad
   * manifest must not sink the scan.
   */
  private async scanManifest(
    manifestPath: string,
  ): Promise<ManifestScan | undefined> {
    const provider = providerForPath(manifestPath);
    if (!provider) return undefined;

    const text = await this.ctx.readFile(manifestPath);
    if (text === null) {
      this.unreadable.push(manifestPath);
      return undefined;
    }

    let manifest: ParsedManifest;
    try {
      manifest = await provider.parse(manifestPath, text, this.ctx);
    } catch {
      // Still swallowed — one bad manifest must not sink the scan — but
      // recorded, so the host can say a file was skipped rather than leaving
      // its absence to be read as "no dependencies here".
      this.unreadable.push(manifestPath);
      return undefined;
    }

    // Members declared in the manifest, plus any from a sidecar file
    // (pnpm-workspace.yaml, go.work, settings.gradle) the manifest never
    // mentions. Recorded even for dependency-free roots, since a root's whole
    // job may be to declare members.
    const sidecar = await readSidecarMembers(manifest, this.ctx);
    const members = [...(manifest.workspaceMembers ?? []), ...sidecar];

    if (manifest.dependencies.length === 0) {
      return { manifest, members };
    }

    const toolchain = await provider.detectToolchain(
      manifestPath,
      this.ctx,
      text,
    );

    // Fill in resolved versions from the lockfile where the provider has one.
    if (provider.readLockfile) {
      try {
        const resolved = await provider.readLockfile(
          path.dirname(manifestPath),
          this.ctx,
        );
        if (resolved.size > 0) {
          // Providers normalise their lockfile keys to whatever their
          // ecosystem considers canonical, so the manifest name has to go
          // through the same normalisation to find them. Without this, PEP
          // 503 alone loses every Python resolution: `typing_extensions` in
          // pyproject.toml never matches `typing-extensions` in uv.lock.
          const normalize = provider.normalizeName ?? ((name: string) => name);
          for (const dep of manifest.dependencies) {
            dep.installed ??=
              resolved.get(dep.name) ??
              resolved.get(dep.name.toLowerCase()) ??
              resolved.get(normalize(dep.name));
          }
        }
      } catch {
        // Lockfile parsing is an optimisation, never a hard requirement.
      }
    }

    // Without a lockfile, approximate from the constraint so the table still
    // shows a number rather than a blank cell — but record that it is a
    // guess, because the audit matches advisories against this value.
    for (const dep of manifest.dependencies) {
      if (dep.installed !== undefined) continue;
      const approximate = constraintToApproxVersion(dep.declared);
      if (approximate === undefined) continue;
      dep.installed = approximate;
      dep.installedIsApproximate = true;
    }

    return {
      manifest,
      members,
      group: {
        label: relativeLabel(manifestPath, manifest.name),
        manifestPath,
        ecosystem: manifest.ecosystem,
        toolchain: toolchain.id,
        dependencies: manifest.dependencies,
      },
    };
  }

  /**
   * Turns each workspace folder's `.gitignore` into exclude globs.
   *
   * `findFiles` does not consult `.gitignore` — only `files.exclude` and the
   * pattern we pass — so a vendored or generated tree would otherwise be
   * scanned and show up as a project the user does not own.
   *
   * Only directory-shaped, non-negated entries are translated; the full
   * gitignore grammar (negations, anchoring, character classes) is more than a
   * scan filter needs, and over-excluding would hide real manifests.
   */
  private async gitignoreExcludes(): Promise<string[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const globs = new Set<string>();

    for (const folder of folders) {
      const text = await this.ctx.readFile(
        path.join(folder.uri.fsPath, '.gitignore'),
      );
      if (!text) continue;

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        // A negation re-includes a path; honouring it would need full gitignore
        // semantics, so we skip the rule rather than get it subtly wrong.
        if (line.startsWith('!')) continue;
        // Anything with a glob or character class is left to git.
        if (/[*?[\]]/.test(line)) continue;
        /*
         * `,`, `{` and `}` are structural in the brace pattern these entries
         * are joined into below, not in gitignore's own grammar — a directory
         * legitimately named `a,b` would split the group and corrupt every
         * other exclude alongside it. There is nothing to escape them with, so
         * the entry is dropped: one directory scanned that need not be, rather
         * than an exclude list that silently stops working.
         */
        if (/[,{}]/.test(line)) continue;

        const cleaned = line.replace(/^\/+/, '').replace(/\/+$/, '');
        if (cleaned === '' || cleaned.includes('..')) continue;

        globs.add(`**/${cleaned}/**`);
      }
    }

    return [...globs];
  }

  /**
   * Marks each group as a workspace root or a member of one, so the UI can say
   * where a package sits rather than showing a flat list of unrelated projects.
   */
  private applyWorkspaceInfo(
    groups: ProjectGroup[],
    parsed: Array<{ manifest: ParsedManifest; members: string[] }>,
  ): void {
    const assignments = assignWorkspaces(parsed);
    const labelByPath = new Map(
      groups.map((group) => [group.manifestPath, group.label]),
    );

    for (const group of groups) {
      const info = assignments.get(group.manifestPath);
      if (!info) continue;

      if (info.isRoot) {
        group.isWorkspaceRoot = true;
      }
      if (info.rootPath) {
        // A root with no dependencies of its own never became a group, so fall
        // back to its directory name rather than dropping the attribution.
        group.workspaceRootLabel =
          labelByPath.get(info.rootPath) ??
          path.basename(path.dirname(info.rootPath));
      }
    }
  }

  /**
   * One batched registry round-trip per ecosystem, then merge the results.
   *
   * Returns true only when *every* ecosystem failed, which is the one case that
   * genuinely means "you are looking at cached data". Ecosystems are isolated
   * from each other: a provider that throws marks its own dependencies
   * `lookupFailed` and leaves the rest untouched.
   */
  private async enrichVersions(
    groups: ProjectGroup[],
    signal: AbortSignal,
  ): Promise<boolean> {
    /*
     * Index the dependencies by ecosystem once, and hand each merge step only
     * the rows it can act on.
     *
     * Both merge steps used to re-walk every group and every dependency and
     * skip what did not match, so the cost was the number of ecosystems times
     * the size of the whole workspace rather than the size of the workspace.
     */
    const byEcosystem = new Map<Ecosystem, Dependency[]>();
    for (const group of groups) {
      for (const dep of group.dependencies) {
        const existing = byEcosystem.get(dep.ecosystem);
        if (existing) existing.push(dep);
        else byEcosystem.set(dep.ecosystem, [dep]);
      }
    }

    if (byEcosystem.size === 0) return false;

    const outcomes = await Promise.all(
      [...byEcosystem.entries()].map(async ([ecosystem, dependencies]) => {
        const provider = providerFor(ecosystem);
        const names = [...new Set(dependencies.map((dep) => dep.name))];

        let versions: Map<string, VersionInfo>;
        try {
          versions = await provider.fetchVersions(names, this.ctx, signal);
        } catch (error) {
          // An abort is the caller's decision, not a registry failure, so it
          // propagates rather than being reported as an unreachable ecosystem.
          if (signal.aborted) throw error;
          markLookupFailed(dependencies);
          return false;
        }

        this.applyVersions(dependencies, ecosystem, versions);
        return true;
      }),
    );

    return outcomes.every((succeeded) => !succeeded);
  }

  private applyVersions(
    dependencies: Dependency[],
    ecosystem: Ecosystem,
    versions: Map<string, VersionInfo>,
  ): void {
    for (const dep of dependencies) {
      const info = versions.get(dep.name);
      if (!info || info.versions.length === 0) {
        dep.lookupFailed = true;
        dep.updateKind = 'unknown';
        continue;
      }

      dep.latest = info.latest ?? maxVersion(ecosystem, info.versions);
      dep.wanted =
        maxSatisfying(ecosystem, info.versions, dep.declared) ?? dep.installed;

      if (info.deprecated || info.sizeBytes !== undefined) {
        dep.meta = {
          ...(dep.meta ?? { name: dep.name }),
          ...(info.deprecated ? { deprecated: info.deprecated } : {}),
          ...(info.sizeBytes !== undefined
            ? { sizeBytes: info.sizeBytes }
            : {}),
        };
      }

      // Compare against what is actually resolved, falling back to the
      // constraint's lower bound when nothing pins an exact version.
      const current = dep.installed ?? constraintToApproxVersion(dep.declared);
      dep.updateKind = classifyUpdate(ecosystem, current, dep.latest);
    }
  }

  /** Fetches rich metadata for a single package, on demand from the drawer. */
  async fetchDetails(dep: Dependency, signal?: AbortSignal) {
    const provider = providerFor(dep.ecosystem);
    return provider.fetchMetadata(dep.name, this.ctx, signal);
  }

  /**
   * Registry search across one ecosystem or all of them.
   *
   * Reports which registries failed alongside the results. One unreachable
   * registry out of seven is a footnote, but *every* registry failing used to
   * render as "No packages found" — which sends the user looking for a package
   * that is right where they thought it was.
   */
  async search(
    query: string,
    ecosystem: Ecosystem | 'all',
    signal: AbortSignal,
  ): Promise<{ results: SearchResult[]; failed: Ecosystem[] }> {
    const targets = ecosystem === 'all' ? PROVIDERS : [providerFor(ecosystem)];

    const settled = await Promise.allSettled(
      targets.map((provider) => provider.search(query, this.ctx, signal)),
    );

    const results: SearchResult[] = [];
    const failed: Ecosystem[] = [];

    settled.forEach((entry, index) => {
      if (entry.status === 'fulfilled') results.push(...entry.value);
      else failed.push(targets[index].id);
    });

    return { results, failed };
  }
}

/** An unreachable registry greys out its own rows and asserts nothing else. */
function markLookupFailed(dependencies: Dependency[]): void {
  for (const dep of dependencies) {
    dep.lookupFailed = true;
    dep.updateKind = 'unknown';
  }
}

function summarize(groups: ProjectGroup[], stale: boolean): ScanSummary {
  let total = 0;
  let outdated = 0;
  let vulnerable = 0;
  let deprecated = 0;

  for (const group of groups) {
    for (const dep of group.dependencies) {
      total++;
      const isOutdated =
        dep.updateKind === 'patch' ||
        dep.updateKind === 'minor' ||
        dep.updateKind === 'major';
      if (isOutdated) {
        outdated++;
      }
      if (dep.vulnerabilities.length > 0) vulnerable++;
      if (dep.meta?.deprecated) deprecated++;
    }
  }

  return {
    totalDependencies: total,
    outdated,
    vulnerable,
    deprecated,
    stale,
  };
}

/**
 * A label that is short but unambiguous: the workspace-relative directory, or
 * the manifest's own name when it sits at the root.
 */
function relativeLabel(manifestPath: string, manifestName: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(manifestPath),
  );
  if (!folder) return manifestName;

  const relative = path.relative(folder.uri.fsPath, path.dirname(manifestPath));
  const base = path.basename(manifestPath);

  // Several manifests can share a directory (pyproject.toml + requirements.txt),
  // so name the file when it is not the directory's obvious primary manifest.
  const suffix =
    base === 'package.json' || base === 'pyproject.toml' ? '' : ` · ${base}`;

  if (relative === '') return `${manifestName}${suffix}`;
  return `${relative}${suffix}`;
}
