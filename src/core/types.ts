/**
 * Domain types shared by the extension host and the webview.
 *
 * Nothing in this file may import `vscode` — the webview bundle pulls these
 * types in and would break if it did.
 */

export type Ecosystem =
  | 'node'
  | 'python'
  | 'cargo'
  | 'golang'
  | 'composer'
  | 'maven'
  | 'gradle';

/** The package manager actually driving a given manifest. */
export type ToolchainId =
  | 'npm'
  | 'yarn'
  | 'pnpm'
  | 'bun'
  | 'pip'
  | 'uv'
  | 'poetry'
  | 'cargo'
  | 'go'
  | 'composer'
  | 'maven'
  | 'gradle';

/**
 * Where a dependency is declared. Every ecosystem maps its own vocabulary onto
 * this set so the UI only ever has to reason about five buckets.
 */
export type DepScope = 'prod' | 'dev' | 'build' | 'optional' | 'peer';

/** How far behind a dependency is. `none` means it is current. */
export type UpdateKind = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

export interface Toolchain {
  id: ToolchainId;
  ecosystem: Ecosystem;
  /** Absolute path the command should run in. */
  cwd: string;
  /**
   * Base name of the manifest this toolchain was detected for.
   *
   * Most commands only need `cwd`, but a few have to name the file — `pip
   * install -r` cannot assume `requirements.txt` in a project driven by
   * `requirements-dev.txt`.
   */
  manifestFile?: string;
  /** True when the manifest is a workspace member rather than the root. */
  isWorkspaceMember?: boolean;
  /** Python only: absolute path to the detected virtualenv, if any. */
  venvPath?: string;
  /**
   * Node/yarn only: true for Yarn 2+ ("Berry").
   *
   * The two lines are different package managers wearing one name — Berry
   * replaced `upgrade` with `up` and dropped several of v1's flags — so a
   * command built without knowing which is running is a coin flip.
   */
  yarnBerry?: boolean;
  /**
   * Maven/Gradle only: the wrapper script to invoke instead of the bare tool.
   * A project that ships a wrapper pins its own build-tool version, so calling
   * the system `mvn`/`gradle` can use a different one than CI does.
   */
  wrapper?: string;
}

export interface Vulnerability {
  id: string;
  summary: string;
  severity: Severity;
  /** CVE / GHSA identifiers this advisory is also known by. */
  aliases: string[];
  /** First version that is not affected, when the advisory states one. */
  fixedVersion?: string;
  /**
   * True when the advisory reported no severity we could read, and `severity`
   * is therefore Orizzonte's conservative default rather than anything the
   * advisory said.
   *
   * It matters most for CVSS v4.0 vectors, which have no closed-form base
   * score — so an advisory carrying only one of those lands on the default no
   * matter how serious it actually is. Presenting that as an ordinary
   * "moderate" is the kind of quiet under-reporting a security feature should
   * not do, so the UI says which it is.
   */
  severityUnknown?: boolean;
  url: string;
}

/** Registry-sourced facts about a package, independent of any project. */
export interface PackageMeta {
  name: string;
  description?: string;
  homepage?: string;
  repository?: string;
  changelogUrl?: string;
  /** Unpacked size in bytes, where the registry reports it. */
  sizeBytes?: number;
  /** Deprecation notice text. Presence means the package is deprecated. */
  deprecated?: string;
  author?: string;
  /** Weekly/recent downloads, where the registry reports it. */
  downloads?: number;
  /**
   * The license identifier as the registry reports it — usually but not
   * always a valid SPDX expression, since registries do not enforce the
   * grammar. Absence means the registry did not report one, not that the
   * package is unlicensed.
   */
  license?: string;
}

export interface Dependency {
  /** Stable identity across refreshes: `${manifestPath}::${scope}::${name}`. */
  key: string;
  name: string;
  ecosystem: Ecosystem;
  scope: DepScope;
  /** The raw constraint as written in the manifest, e.g. `^18.2.0`. */
  declared: string;
  /** The concrete version currently resolved, when a lockfile tells us. */
  installed?: string;
  /**
   * True when `installed` was inferred from the constraint rather than read
   * from a lockfile.
   *
   * It matters because advisories are matched against `installed`: a guess of
   * `1.2.3` from `^1.2.3` may name a version nobody has, so anything derived
   * from it has to be presented as indicative rather than certain.
   */
  installedIsApproximate?: boolean;
  /** Highest published version satisfying `declared`. */
  wanted?: string;
  /** Highest published version overall. */
  latest?: string;
  updateKind: UpdateKind;
  meta?: PackageMeta;
  vulnerabilities: Vulnerability[];
  /** Absolute path of the manifest that declares this dependency. */
  manifestPath: string;
  /** Human label for the owning project, e.g. `packages/web`. */
  projectLabel: string;
  /** True when the registry lookup failed; the row renders in a muted state. */
  lookupFailed?: boolean;
}

export interface ParsedManifest {
  ecosystem: Ecosystem;
  /** Absolute path of the manifest file. */
  path: string;
  /** Display name, from the manifest if it declares one. */
  name: string;
  dependencies: Dependency[];
  /** Absolute paths of workspace member manifests this file declares. */
  workspaceMembers?: string[];
  /** True when this manifest is purely a workspace root with no own deps. */
  isWorkspaceRoot?: boolean;
}

export interface ProjectGroup {
  label: string;
  manifestPath: string;
  ecosystem: Ecosystem;
  toolchain: ToolchainId;
  dependencies: Dependency[];
  /** True when this manifest declares workspace members. */
  isWorkspaceRoot?: boolean;
  /** Label of the workspace root this group belongs to, when it is a member. */
  workspaceRootLabel?: string;
}

export interface SearchResult {
  name: string;
  version: string;
  description?: string;
  ecosystem: Ecosystem;
  downloads?: number;
  deprecated?: string;
  repository?: string;
  /** Set by the host when the package already appears in a loaded manifest. */
  installedIn?: Array<{
    manifestPath: string;
    projectLabel: string;
    declared: string;
    scope: DepScope;
  }>;
}

/** A node in the "why is this installed" reverse-dependency tree. */
export interface DepNode {
  name: string;
  version?: string;
  /** The constraint the parent asked for. */
  requestedRange?: string;
  children: DepNode[];
  /** True when expansion stopped because of a cycle or the depth cap. */
  truncated?: boolean;
}

/** A package resolved at more than one version at once within a project. */
export interface DuplicateVersionGroup {
  name: string;
  /** Distinct resolved versions, ascending lexicographically. */
  versions: string[];
}

export interface DuplicateVersionResult {
  /**
   * False when no reliable local source of resolved versions exists — no
   * lockfile on disk, or an ecosystem (Go, Maven, Gradle) with no lockfile
   * `findDuplicateVersions` trusts for this. Distinguishing "not checked"
   * from "checked, nothing duplicated" matters: collapsing them into one
   * empty `groups` array would let a project no one could actually check
   * read as clean.
   */
  checked: boolean;
  groups: DuplicateVersionGroup[];
}

/** One project's duplicate-version check, for the panel's aggregate view. */
export interface ProjectDuplicateVersions extends DuplicateVersionResult {
  manifestPath: string;
  projectLabel: string;
  ecosystem: Ecosystem;
}

/** Every package sharing one license, for the workspace-wide license summary. */
export interface LicenseGroup {
  /** `undefined` groups every package Orizzonte could not attribute a license to. */
  license: string | undefined;
  packageNames: string[];
  /** True when this license fails the configured allow/deny policy. */
  flagged: boolean;
}

export interface LicenseSummary {
  groups: LicenseGroup[];
}

/** One GitHub release, standing in for a changelog entry. */
export interface ChangelogEntry {
  /** The release's tag name, verbatim — not necessarily a bare version. */
  version: string;
  publishedAt: string | undefined;
  /** The release title, when it says more than the tag already does. */
  title: string | undefined;
  /** Markdown release notes, as GitHub returns them. */
  body: string;
  url: string;
}

/** A package resolved at a different version (or not at all) on either side
 * of a dependency diff. */
export interface DependencyDiffEntry {
  name: string;
  /** Undefined when the package is not present on that side of the diff. */
  before: string[] | undefined;
  after: string[] | undefined;
}

export interface DependencyDiffResult {
  /** False when the lockfile could not be read on one or both sides. */
  checked: boolean;
  added: DependencyDiffEntry[];
  removed: DependencyDiffEntry[];
  changed: DependencyDiffEntry[];
}

/** One project's dependency diff, for the panel's aggregate view. */
export interface ProjectDependencyDiff extends DependencyDiffResult {
  manifestPath: string;
  projectLabel: string;
  ecosystem: Ecosystem;
}

export interface ScanSummary {
  totalDependencies: number;
  outdated: number;
  vulnerable: number;
  deprecated: number;
  /** True when results came from cache because the network was unreachable. */
  stale: boolean;
}
