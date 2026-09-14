# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Renamed Panorama to Orizzonte**: The extension, its repository and every identifier it contributes now carry the new name. This is a breaking change for existing installs: the extension ID is now `orizzonte.orizzonte-vscode`, every command moved from `panorama.*` to `orizzonte.*`, and every setting moved from `panorama.*` to `orizzonte.*` (e.g. `panorama.registryOverrides` → `orizzonte.registryOverrides`), so values saved under the old keys must be copied across by hand. The Activity Bar view, webview CSS tokens (`--orizzonte-*`), branding assets (`orizzonte.svg`, `orizzonte.png`) and the registry User-Agent (`Orizzonte-VSCode/<version>`) follow suit. Earlier entries below use the new names for consistency.

## [2.10.0] - 2026-09-05

### Fixed

- **The Busy Rule Held Only in the Toolbar**: A scan or write in flight disabled "Update All", "Check updates", "Refresh" and "Export report", while every write in the table stayed live — each row's Update and Remove, a group header's "Update All", and the bulk bar's "Update Selected" / "Remove Selected" — as did the detail drawer's own copies of Update and Remove. The same action was offered as both blocked and available on one screen. `busy` now reaches `DepTable` and `DetailDrawer`, and the rule is documented as belonging to the panel rather than to the toolbar that states it, enforced at three sites. Reads are deliberately untouched: selection, sorting, opening a row's details, the drawer's links and metadata, and the bulk bar's "Clear selection" stay available, so the panel does not freeze wholesale while a background check runs.
- **Floating Bulk Bar Covered the Detail Drawer**: The bulk bar carries `z-index: 50` and the drawer, once it becomes an overlay, carried `1` — and nothing between them establishes a stacking context (`.app__body`, `.app__main` and `.table__wrapper` are all `position: relative` with `z-index: auto`), so both resolved in the root one and the larger value simply won. Because the drawer only floats below the 1400px breakpoint, this was not an edge case but every panel narrow enough to be in that block at all. The drawer now sits above the bar.
- **Bulk Bar Clipped on a Narrow Panel**: The bar is centred and absolutely positioned with no ceiling on its width, so below roughly 520px it overflowed the wrapper symmetrically and `.app`'s `overflow: hidden` clipped both ends — taking "Clear selection" and part of "Remove Selected" with them, at exactly the secondary-sidebar widths the 1000px and 720px breakpoints exist to serve. It now has a `max-width` and wraps, and its buttons drop their words for their icons at the existing 720px breakpoint through the same `.row-action__label` rule the rows already use; each carries an `aria-label` with the full wording, so the name survives being unable to show it.

### Changed

- **Diff Badges Off the Severity Ramp**: The dependency-diff panel painted `added` in patch blue, `changed` in minor yellow and `removed` in the red `theme.css` reserves for "vulnerable" — so a package merely absent from the compared branch wore the one colour that is meant to say an advisory exists against it. Added/removed/changed describe a direction rather than a magnitude or a health problem, so they now read from their own tokens (`--orizzonte-diff-added`, `--orizzonte-diff-changed`, `--orizzonte-diff-removed`: green, blue and a neutral) and are registered in the `forced-colors` block alongside the badges they sit beside. Nothing feeding the Status badge or the Latest column changed.
- **Flagged Licenses No Longer Wear the Vulnerability Red**: The license summary marked a policy-flagged license with `severity--vuln` while the banner directly above it used `callout--warn`, so one panel stated one state in two colours. The inline marker now uses the colour its own banner already does.

### Removed

- **Dead Webview CSS**: `.cell--checkbox` and the `--orizzonte-checkbox-column` token it alone consumed (the row checkbox lives inside the name cell, not a cell of its own), `.highlight-outdated` (never applied), and the `.kpi-dot--outdated` / `--vuln` / `--deprecated` modifiers left behind in 2.7.0 when those counts moved onto the filter chips. `.kpi-dot--total`, which the workspace total still renders, stays.

## [2.9.0] - 2026-09-02

### Added

- **Reference-Counted Busy State Management**: Implemented `BusyTracker` to track concurrent background tasks, manifest scans, and package mutations with event-driven state synchronization, timeouts, and cancellation support to keep UI progress indicators strictly in sync.
- **Modular Lockfile Parsers**: Refactored monolithic dependency graph resolution into dedicated, modular lockfile parsers (`src/core/lockfiles/` for npm, pnpm, yarn, Cargo, Composer, poetry/uv) with unified type safety and lockfile detection.
- **Typed Webview-Host Request Protocol**: Implemented promise-based, correlated request/response messaging (`src/core/webviewRequests.ts`) for reliable asynchronous communication between the webview and the extension host.

### Changed

- **Webview Accessibility**: Replaced non-interactive clickable elements with semantic `<button>` elements across table controls and header actions, improving keyboard navigation, focus management, and screen-reader compatibility.
- **Overlay & Backdrop Dismissal**: Refined `useDismissableOverlay` hook logic for backdrop dismissal and `Escape` key handling across popovers, drawers, and overlay panels.
- **Cache & Audit Optimization**: Improved memory-bounded LRU eviction and serialization in `TtlCache`, alongside enhanced OSV.dev vulnerability query batching and retry handling in the HTTP client layer.
- **Panel Opens Filtered to `outdated`**: The "Show only" `outdated` chip now starts pressed, so a fresh panel is the list of packages that need updating rather than the full inventory — on a large manifest the handful of outdated ones were otherwise buried among hundreds of current ones. The chip is visibly pressed and the empty state's "Clear filters" is one click from the whole list, so nothing is hidden without a way back. Like the other status toggles it is a starting point rather than a preference: it is not persisted, so every panel opens the same way instead of reopening whatever was last being chased. "Clear filters" and the `focusDependency` command still reset to no filters at all, so revealing an up-to-date package does not open the drawer beside a table with no matching row.
- **Dependency Bumps**: `ovsx` to `^1.1.1`, `@types/node` to `^26.4.1` and `@testing-library/user-event` to `^14.6.7`.

## [2.8.0] - 2026-08-29

### Added

- **Open VSX Registry Support**: Added automated publishing to [Open VSX](https://open-vsx.org/) in the release pipeline via GitHub Actions and the `ovsx` CLI (`publish:ovsx` script).

## [2.7.0] - 2026-08-28

### Added

- **Toolbar Overflow Menu**: The four occasional toolbar actions — "Duplicate versions", "Licenses", "Compare with…" and "Export report" — moved behind a single "More" button. Seven equally weighted buttons wrapped to two lines and put Refresh in competition with Export report; what stays inline is now what gets used every session. The menu is a real `role="menu"` with the expected keyboard pattern (Up/Down, Home/End, Escape to close and return focus, Tab to dismiss), and its items are excluded from the toolbar's roving `tabindex` so Left/Right never walks into a popup that may not be open.
- **Counts on the Filter Chips**: The `outdated`/`vulnerable`/`deprecated` counts now live on the filter chips they duplicated, instead of on a second set of KPI pills beside them. The pills were spans shaped exactly like the chips — same capsule, border, dot and words — so half the row responded to a click and half did not, with nothing to tell them apart. Each chip carries an `aria-label` spelling the count out ("outdated, 125 packages"), since the visible text alone announces as "outdated 125".
- **Codicons in the Activity Bar View**: The view's three link buttons use VS Code's own codicons instead of emoji. `build:host` copies `codicon.css` and `codicon.ttf` into `dist/codicons`, because that view is a hand-written HTML document rather than part of the Vite bundle and `node_modules` is excluded from the published `.vsix`; `localResourceRoots` grants exactly that directory and nothing more.
- **Severity-Coloured Target Versions**: The Latest column is now coloured by how big the jump is (major/minor/patch) rather than green-for-any-upgrade — green said "safe" beside a MAJOR badge saying the opposite. It also lets the Status badge stay on the worst problem: a package that is both vulnerable and a major behind reads VULNERABLE there and carries its magnitude here, stated in words in the cell's `title` since colour alone would not.
- **Narrow-Layout Breakpoint**: A new 720px breakpoint for the panel dragged into the secondary sidebar. Below it, Scope is dropped (it is one badge, repeated in the drawer, and unlike the version columns nothing about it changes what you would do about a package) and the row actions keep their icons without their words — both buttons already carry an `aria-label`, so the name survives being unable to show it. Previously nothing happened below 1000px and the table kept an ~890px floor, scrolling sideways for good.

### Changed

- **One Overlay Panel at a Time**: The four overlay panels (search, duplicate versions, licenses, dependency diff) are now driven by a single `activePanel` value rather than a boolean each. With independent flags nothing closed one when another opened, so all four could be on screen at once — each capped at 45vh — and push the table out of view entirely. Being mutually exclusive by construction is also what keeps the toolbar's `aria-expanded` states honest, since they are read straight off that value.
- **Remove Revealed on Hover, Focus and Selection**: A destructive action on every row at once is noise, and one stray click from something irreversible. Remove now appears on row hover, on focus within the row, and while the row's details are open — via `opacity` rather than `display`/`visibility`, so it stays focusable and stays in the accessibility tree while invisible.
- **Fixed Action Slots**: The actions column is two fixed slots rather than a flex row, so Update and Remove land on the same x in every row. Remove used to slide left on every row with no update to offer, so a column of destructive buttons never shared an x-axis.
- **Bulk Bar No Longer Covers the Last Rows**: The floating bulk action bar is absolutely positioned over the scroller, so the table now reserves space beneath it while a selection exists — it was covering the very rows, and the very buttons, the selection is about.
- **Activity Bar View Uses Theme Tokens**: Replaced the hardcoded hex fallbacks throughout the view (`#cccccc`, `#181818`, `#38bdf8`, `rgba(...)` shadows and borders) with the VS Code theme tokens alone, and collapsed the 16px/12px/8px/6px radii that had accumulated there onto the same three-radius scale the panel uses.
- **Panel Titles Are Headings**: The overlay panels' titles are `<h2>` rather than `<span>` — the panels are named regions, and a region whose contents outrank its own title is not an outline.
- **Named Sizing Tokens in `theme.css`**: Logo size, checkbox size and column, dot size, action slot width and the grid's column tracks are now variables. Four different dot sizes and three different tile radii had made it into the file by being written into components instead.
- **Dependency Bumps**: `fast-xml-parser` to `^5.11.1` and `@types/node` to `^26.4.0`.

### Fixed

- **Row Controls Inoperable From the Keyboard**: A row's `Enter`/`Space` handler called `preventDefault()` unconditionally, and keydown bubbles from the checkbox and the action buttons — so those keys cancelled the click they were about to synthesize on every control in the row, opening the detail drawer instead. `Enter` and `Space` now belong to the row only while the row itself holds focus. A child's own `stopPropagation` could not have helped, since it runs on the click this already cancelled.
- **Thirty Tab Stops Between the Table and the Rest of the Panel**: The per-row checkbox and action buttons are native elements, so each carried an implicit tab stop and ten rendered rows put thirty of them in the sequence. They now carry `tabIndex={-1}` and are reached with Left/Right from the row that owns them, so the grid body is one tab stop whatever the row count. A group header's "Update All" is the deliberate exception — those rows are labels rather than stops, and there is one such button per project rather than one per row.
- **Unlabelled Row Checkboxes**: Each row's checkbox now carries an `aria-label` naming what it selects; a screen reader previously announced every row's box identically, with nothing to tell them apart.
- **Columns Shifted a Track When One Was Hidden**: `display: none` stops an element being a grid item, so dropping Size at a breakpoint left Status in Size's track and Actions in Status's, clipping both buttons against a track a fifth of the width they need. Each breakpoint now restates the tracks it still has.
- **In-Flight Search Left Running**: The search request is now cancelled when the search panel stops being the open one, which includes another panel replacing it. Opening Licenses over a running search previously left the request live, with its result landing in a panel nobody is looking at.
- **Dead Listener Broke the Author Link**: The Activity Bar view registered a click handler on a `link-license` element that no longer exists; the resulting `TypeError` meant the author link's handler was never registered at all.
- **`prefers-reduced-motion` Ignored on the Update Buttons**: The primary Update / Update All buttons' hover transition arrived after that block was written, so the preference was honoured for the scan bar and quietly ignored on the one control anybody hovers repeatedly.
- **Selected and Checked Rows Were Indistinguishable**: Bulk-set membership and "this row's details are open" both painted `list-inactiveSelectionBackground`, so three ticked rows and a fourth open in the drawer were four identically highlighted rows while the bulk bar said three. Membership now draws an inset accent bar, and forced-colours mode — where `box-shadow` is dropped — distinguishes the two with solid versus dashed outlines instead.

### Removed

- **KPI Pills for Outdated / Vulnerable / Deprecated**: Their counts moved onto the filter chips they duplicated. The workspace total, which has no chip of its own, stays.
- **Unused `updateClass` Helper**: Removed `updateClass()` from `src/webview/format.ts` along with its now-unused `UpdateKind` import.

## [2.6.0] - 2026-08-26

### Added

- **Inline Update & Vulnerability CodeLenses**: Manifest files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `composer.json`, `pom.xml`, `build.gradle(.kts)`) now show a CodeLens above each dependency with an available update and/or known vulnerabilities, so that status is visible without opening the Orizzonte panel. Clicking a lens opens the panel on that dependency's details.
- **Vulnerability Diagnostics**: Dependencies with known vulnerabilities are now also reported as Problems-panel diagnostics on their declaration line, for open manifest files.
- **Duplicate Version Detection**: A new "Duplicate versions" panel checks each project's lockfile (npm, pnpm, yarn, Cargo, Composer, poetry/uv) for packages resolved at more than one version at once, listing every project and version group found. Go, Maven and Gradle are reported as unchecked rather than clean, since none has a lockfile Orizzonte can trust for this.
- **Export Dependency Report**: A new "Export report" action (toolbar button and `orizzonte.exportReport` command) writes the current scan — outdated packages, known vulnerabilities and duplicate versions, per project — to a Markdown or JSON file the user chooses, for sharing outside the editor or attaching to a PR.
- **License Metadata & Policy**: Package metadata now includes the registry-reported license (npm, PyPI, Crates.io, Packagist), shown in the dependency detail drawer. A new "License summary" panel checks every unique package in the workspace and groups them by license, flagging any that violate the new `orizzonte.licenseAllowList`/`licenseDenyList` settings. Go, Maven and Gradle packages are grouped as unknown rather than guessed, since none of their registries expose a license Orizzonte can attribute with confidence.
- **Authenticated Registry Overrides**: `orizzonte.registryOverrides` entries can now be an object naming an environment variable that holds a bearer token for that registry (e.g. `{ "npm": { "url": "https://registry.mycompany.com", "tokenEnvVar": "COMPANY_NPM_TOKEN" } }`), for private registries (Artifactory, Nexus, GitHub Packages, private PyPI/Packagist mirrors, ...) that require authentication. The token is read from the named environment variable at request time and is never written to settings or any other Orizzonte-managed storage; it is also never sent unless the configured URL passes the same scheme validation the existing unauthenticated override already requires, so a malformed override can never leak a token to the public registry. Supported by all seven providers.
- **"What's Changed" Before Updating**: The detail drawer now shows GitHub release notes between a dependency's installed and target version, for packages hosted on GitHub with an available update. Matched by comparing release tag text rather than parsing semver, so it degrades to "most recent releases" instead of guessing when a tag can't be matched.
- **Compare Dependencies With a Branch**: A new "Compare with…" toolbar action lets you pick a Git ref (from a native quick-pick) and shows what every project's lockfile would add, remove, or change versions on relative to the working tree — useful for seeing a PR's or branch's actual dependency impact without leaving the editor. Limited to workspaces with exactly one Git repository.

## [2.5.0] - 2026-08-25

### Added

- **Custom Registry Overrides for All Providers**: Extended `orizzonte.registryOverrides` support to Cargo, Composer, Go, and Maven/Gradle (previously limited to npm and PyPI), so a private registry or mirror can be configured for every ecosystem.
- **Workspace Trust Support**: Declared the `untrustedWorkspaces` capability in `package.json`, restricting `orizzonte.registryOverrides` so it is not read from an untrusted workspace's settings.
- **Update Preserves the Declared Version Range Operator**: Updating a Node dependency now carries the manifest's existing `^`/`~` prefix onto the new version (`applyDeclaredPrefix`) instead of silently pinning an exact version.
- **CI Verify Gate on Release**: `release.yml` now runs lint, typecheck, and unit tests in a dedicated `Verify` job that `Release` depends on.
- **Registry Rate Limits for PyPI & the Go Proxy**: Added self-imposed per-host rate limits for `pypi.org` and `proxy.golang.org`, matching the existing limits for Maven Central, Packagist, and OSV.dev.
- **Expanded Test Coverage**: Added integration tests for `DependencyMutator`, `PanelManager`, and `SidebarViewProvider`, and unit tests for `TtlCache`, `depGraph`, `registryOverride`, provider input validation, and shell quoting.

### Fixed

- **`pnpm-lock.yaml` Parsed with a Real YAML Parser**: `NodeProvider` and the "why is this installed" dependency graph (`core/depGraph.ts`) now parse `pnpm-lock.yaml` with the `yaml` package instead of regex/indentation scanning, correctly separating the `importers:` block from `packages:`/`snapshots:` and fixing resolution on lockfiles the hand-rolled parser used to get wrong.
- **Lazily Fetched Metadata Not Rendering**: Description, license, and size metadata fetched after the initial scan and merged into an existing row could be silently dropped by the virtualized table's row memoization, since the underlying dependency object is mutated in place rather than replaced. Rows now re-render when their metadata arrives.
- **Windows Command Injection via Crafted Version Strings**: cmd.exe's `.cmd`/`.bat` wrappers — what npm/yarn/pnpm are on Windows — treat unquoted `,` and `=` as argument delimiters, and `!VAR!` expands under delayed expansion. Both are now stripped/rejected by the shell-quoting layer so a malicious registry response cannot smuggle extra arguments into an install or update command.
- **PEP 440 Epoch Versions in Vulnerability Matching**: `constraintToApproxVersion`, whose result feeds the OSV.dev audit match, previously returned just the epoch digit for a constraint like `1!2.0.0`; it now correctly returns `2.0.0`.
- **Table Sort: Missing Sizes**: Rows without size metadata now sort last in ascending size order, matching the convention used for missing version data, instead of sorting first.
- **Sidebar Theme Colors**: Replaced hardcoded hex colors and a typo'd `--vscode-sidebar-background` token in `SidebarViewProvider` with the correct VS Code theme tokens (`--vscode-badge-*`, `--vscode-button-*`, `--vscode-sideBar-background`), fixing contrast in custom and high-contrast themes.
- **Manifest Edit Race**: `DependencyMutator` now checks that the document version hasn't changed between reading and applying a manifest edit, and no longer force-saves a manifest the user already had unrelated unsaved changes open in.
- **Cache Pruning Failures No Longer Abort the Sweep**: A single failed storage write during `TtlCache.prune()` no longer stops the rest of the sweep, and a lapsed in-memory entry is now evicted on read rather than lingering until pushed out by the LRU count bound.
- **Unhandled Rejection on Activation**: `cache.prune()` errors during extension activation are now caught instead of becoming an unhandled promise rejection.

### Accessibility

- **Search & Install Disabled Reason**: The reason an "Install" button is disabled (wrong ecosystem, no target manifest) is now also exposed via `aria-describedby`, not only a `title` tooltip a keyboard or screen-reader user cannot reach.

### Changed

- **Metadata Caching Deduplicated**: Node, Cargo, Composer, and Python providers now share a single `fetchMetadataWithCache` helper instead of each re-implementing the same cache-first, stale-on-failure logic.
- **Per-Ecosystem Maven Version Cache Keys**: Maven and Gradle version lookups are now cached under separate keys so a registry override on one no longer serves cached results to the other.
- **Queued Error Toasts Capped**: The webview's error notification queue is capped at 50 entries so a broken registry during a large bulk update can't grow it without bound.

### Removed

- **Dead Scanner Cancellation Code**: Removed `Scanner.cancel()` and its `inFlight` guard — `ScanQueue` is the only caller and never overlaps scans, so the guard was unreachable.
- **Unused `toolchainOf` Helper**: Removed the unused `toolchainOf()` export and its `ToolchainId` import from `providers/provider.ts`.

## [2.4.0] - 2026-08-20

### Added

- **Provider Dependency Management Unit Test Suite**: Added dedicated unit tests (`tests/unit/providerCommands.test.ts`) validating command generation (`installCommand`, `uninstallCommand`, `updateCommand`) across all 6 ecosystem providers (`Cargo`, `Composer`, `Go`, `Gradle`, `Node`, `Python`).
- **Webview CSS Module Declarations**: Added ambient CSS module declarations (`src/webview/env.d.ts`) and configured global DOM / Vitest test types in `tsconfig.json`.

### Fixed

- **`pnpm-lock.yaml` Resolution Priority**: Fixed version resolution in `NodeProvider` (`src/providers/node/index.ts`) so direct dependency version specifiers declared under `importers` take priority over transitive package definitions.
- **`package-lock.json` Top-Level Precedence**: Enhanced `package-lock.json` parsing to ensure direct top-level `node_modules` paths take precedence over nested transitive entries.
- **Cross-Platform Python Binary Selection**: Standardized Python executable binary selection (`python` on Windows vs `python3` on POSIX environments) for `pip` command execution in `PythonProvider`.

### Changed

- **Dependencies & Toolchain Upgrades**: Upgraded core framework and build tools including React 19 (`^19.2.8`), TypeScript 7 (`^7.0.2`), Vite 8 (`^8.2.2`), Vitest 4 (`^4.1.11`), `@types/node` (`^26.2.0`), `@types/react` (`^19.2.18`), and Biome (`^2.5.9`).
- **Integration Test TSConfig Clean-up**: Removed obsolete `moduleResolution` setting from `tsconfig.integration.json`.

## [2.3.0] - 2026-08-19

### Added

- **`DependencyMutator` Service**: Decoupled package update and uninstall command orchestration from `PanelManager` into a dedicated `DependencyMutator` service layer (`src/ui/dependencyMutator.ts`).
- **Shared Registry Caching (`cachedFetch`)**: Added a unified HTTP caching and request handler (`src/providers/shared/cachedFetch.ts`) across all ecosystem providers (Cargo, Composer, Go, Gradle, Node, Python) to optimize registry lookups and standardize header management.
- **`useDismissableOverlay` Custom Hook**: Added custom React hook (`src/webview/useDismissableOverlay.ts`) to centralize `Escape` key listener, backdrop click detection, and focus management across webview overlay components (`DetailDrawer` and `SearchInstall`).
- **Comprehensive Integration & Webview Test Suites**: Added new integration test coverage for terminal execution (`terminalRunner.test.ts`), workspace file watching (`watcher.test.ts`), webview security & CSP policies (`webviewSecurity.test.ts`), scanner exclusion rules (`scannerExclusions.test.ts`), webview table rendering (`DepTable.test.tsx`), and VS Code API communication (`vscodeApi.test.tsx`).

### Changed

- **Refactored `PanelManager`**: Streamlined webview panel lifecycle management, state synchronization, and message routing by delegating mutation logic to `DependencyMutator`.
- **Enhanced Workspace Manifest Scanner**: Improved `src/core/workspaces.ts` and `src/core/scanQueue.ts` to strictly observe nested `.gitignore` files and workspace glob exclusions during manifest file discovery.
- **Dependency & Build Maintenance**: Updated devDependencies (Biome, Testing Library) and added `minimumReleaseAgeExclude` configurations in `pnpm-workspace.yaml`.

## [2.2.0] - 2026-08-18

### Added

- **GitHub Project References Panel in Left Sidebar**: Added interactive project reference card, quick action links (Star on GitHub, Report an Issue, Release Notes, MIT License), and author credits in `SidebarViewProvider`.
- **Floating Bulk Action Bar**: Redesigned selection toolbar into a floating card centered at the bottom of the webview with backdrop blur and smooth shadow.
- **KPI Summary Pills & Filter Indicators**: Converted header summary text into status KPI pills with colored dot indicators, and added colored indicator dots to filter chips (`outdated`, `vulnerable`, `deprecated`).
- **Native Codicon Icons Integration**: Added VS Code Codicon icons to webview toolbar buttons (`Add package`, `Check updates`, `Refresh`) and row actions (`Update`, `Remove`).

### Changed

- **Deterministic CSS Grid Table Layout**: Converted dependency table header and data rows to a unified 7-track CSS Grid layout (`grid-template-columns`), eliminating layout calculation mismatches and scrollbar gutter offsets between headers and virtualized body rows.
- **Unified Left Alignment for Table Columns**: Standardized header and data cell alignment to left-aligned across all table columns (`Package`, `Scope`, `Current`, `Latest`, `Size`, `Status`, `Actions`) for consistent starting edge alignment.
- **Monospaced Data Cell Typography & Soft Badges**: Applied monospaced editor typography specifically to data cell versions and sizes while preserving header UI font, refreshed status badges with soft-tint backgrounds, and added directional version diff indicators.

## [2.1.0] - 2026-08-13

### Added

- **Package size tracking across providers**: Cargo (Crates.io `crate_size`), Node (npm `unpackedSize` / `size`), and Python (PyPI release file size) providers now fetch and expose package size metadata for installed and latest dependency versions.

### Changed

- **Dependency table UI layout & alignment**: Refined table header alignment for action cells (`.cell--actions`), enabled `scrollbar-gutter: stable` to prevent horizontal layout jumps during virtualization, and improved package name text truncation and size button positioning.


## [2.0.0] - 2026-08-13

### Fixed

- **Bulk actions no longer race**: "Update Selected" and "Remove Selected" sent one message per package, and the host handles messages concurrently — so a selection of ten stacked ten modal confirmations and ran ten package-manager commands at once through a single shared terminal. The selection now travels as one message (`bulkUpdate` / `bulkUninstall`), confirmed once and run in order, and `TerminalRunner` serialises commands regardless of caller.
- **"Update All" updated only the first project**: the toolbar button counted outdated packages across the whole workspace but always targeted `groups[0]`. With several projects it now asks which one, reusing the existing quick-pick.
- **Failed commands were silent**: a non-zero exit code from an install or update was discarded, leaving a refresh that appeared to do nothing. Failures now surface in the panel's error banner.
- **PyPI search offered the wrong version**: the version to install was taken as the last entry of the simple index's `versions` array, which is unordered. It is now the highest by PEP 440.
- **Integration tests never ran**: `.vscode-test.mjs` globbed `out/test/integration/**` while the build emits `out/tests/integration/**`, so Mocha matched nothing and exited 0. The 16 integration tests now run in CI.
- **Test fixtures shipped in the VSIX**: `.vscodeignore` excluded `test/**` rather than `tests/**`, publishing all eight fixture manifests inside the extension.

### Security

- **Sidebar webview hardened** to match the panel: CSP nonces now come from `randomBytes` rather than `Math.random`, external URLs are scheme-checked before being opened, and `localResourceRoots` is narrowed from the whole extension directory to `resources/`. Both surfaces share `ui/webviewSecurity.ts` so they cannot drift apart again.
- **Maven manifest writes are escaped**, and Maven gets a version grammar that rejects `<` and `>` while still accepting ranges like `[1.0,2.0)` — the shared grammar allows them because they are inert on a command line, but this is the one provider that writes into markup.
- Maven Central coordinates are URL-encoded in the search path, as they already were in the version lookup.

### Changed

- **Manifest scanning is concurrent** (8 at a time) and honours cancellation, instead of awaiting every file, sidecar, toolchain probe and lockfile one after another. Results are collected by position, so output is identical regardless of which read finishes first.
- **Maven Central version lookups run 5 at a time**, matching the rate limit already configured for the host, instead of strictly serially.
- The PyPI project index is fetched with `noCache`, so the tens-of-megabyte response body is no longer retained in the HTTP layer's revalidation cache for the life of the window.
- HTTP retries now share one deadline across the whole chain rather than each attempt getting a fresh timeout.
- **Every colour in the webview is a theme token again.** A block of hardcoded hex values had accumulated at the end of `theme.css` (and in the sidebar's inline styles), which broke contrast in light themes and ignored high-contrast ones. Added a `forced-colors` block.
- Go's `// indirect` requirements are labelled "indirect" rather than "optional", and Cargo's `workspace = true` reads as "inherited from workspace". Both corrections live in `core/vocabulary.ts`.
- The Activity Bar view is named "Orizzonte" and documented as what it is — a launcher for the panel, not a second place to inspect dependencies.
- **CI/CD & Release Workflow**:
  - Updated GitHub Actions workflows (`ci.yml` and `release.yml`) for improved build reliability and release automation.
  - Upgraded Biome linter schema configuration and cleaned up whitespace across test suites.

### Accessibility

- The bulk-action bar was a non-row child of `role="grid"`, which invalidated the grid's structure. It is now a labelled toolbar outside the grid.
- The select-all checkbox reports an indeterminate state on a partial selection, names what it covers when a filter is applied, and no longer discards selections the filter is hiding. Selections are dropped when a rescan removes the package.
- The scan progress bar carries indeterminate progressbar semantics, and its textual label is no longer `aria-hidden`.

### Removed

- **Dead tree-view surface**: `ui/treeProvider.ts` and the `orizzonte.revealDependency` command were left unreferenced by the sidebar migration and have been deleted, along with ~100 lines of sidebar CSS for markup that does not exist and a duplicated PEP 503 name normaliser.
- **Mute List Functionality**:
  - Removed package muting capability across extension host, workspace state, webview toolbar, detail drawer, and commands (`orizzonte.toggleMute` and `orizzonte.clearMuted`).

## [1.2.0] - 2026-08-12

### Added

- **Modernized Webview Interface & Layout**:
  - Redesigned webview toolbar with improved controls, spacing, and visual grouping.
  - Enhanced dependency data table styling and typography for improved scanability.
  - Refreshed high-contrast, dark mode, and light mode visual themes in `theme.css`.

### Changed

- **Test Infrastructure Consolidation**:
  - Unified test directory layout by consolidating `test/` into `tests/`.
  - Updated build configurations (`tsconfig.json`, `tsconfig.integration.json`, `vitest.config.ts`, `biome.json`, and `package.json`) to reflect unified test structure.
- **Branding & Vector Assets**:
  - High-resolution SVG and PNG branding asset updates (`orizzonte.svg` and `orizzonte.png`).

## [1.1.0] - 2026-08-12

### Added

- **Keyboard Navigation & Accessibility**:
  - Global `Ctrl+F` / `Cmd+F` keyboard shortcut to focus and select the webview search filter input.
  - Roving `tabindex` and arrow key navigation support across dependency data tables and search result lists.
  - ARIA progress roles, live regions (`aria-live="polite"`), and semantic attributes for screen readers.
  - Grouped toolbar filter controls with enhanced keyboard focus styling and high-contrast theme support.
- **Error Notification Queuing**:
  - Error queuing toast alert system to manage and present multiple concurrent host/registry errors without silent dropping.
- **Branding & Visuals**:
  - Vector branding assets (`orizzonte.svg` and `orizzonte.png`) for extension sidebar icon and webview headers.

### Changed

- Enhanced registry provider abstraction with input validation and LRU cache eviction policies for dependency metadata and security vulnerability lookups.
- Standardized cross-platform path normalization across integration test helpers.

## [1.0.0] - 2026-08-10

### Added

- First implementation of Orizzonte.

[Unreleased]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.10.0...HEAD
[2.10.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.9.0...v2.10.0
[2.9.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.8.0...v2.9.0
[2.8.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.7.0...v2.8.0
[2.7.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/salvatorecorvaglia/orizzonte/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/salvatorecorvaglia/orizzonte/releases/tag/v1.0.0