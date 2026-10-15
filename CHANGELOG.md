# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-10-15

### Added

- Dependency source awareness: workspace, file, git and tarball specifiers are no longer treated as registry packages (looked up, audited or offered updates), so updating a `workspace:*` sibling can no longer replace it with a public package of the same name.
- Private registry support: Go module paths honour `GOPRIVATE`/`GONOPROXY`, npm scopes configured in `.npmrc` are recognised, and private names are never sent to the public registry, the Go module proxy or OSV.dev.
- Installed-version resolution read once from the governing lockfile per workspace member, instead of per-provider parsers (fixing monorepo members being told a sibling's resolved version).
- Toolchain detection inside workspaces now walks up to the root lockfile and `packageManager` field, so pnpm/Yarn/bun/uv members are no longer treated as npm/pip.
- Manifest editing fixes for Cargo dev/build dependencies, Poetry test/dev groups, and Maven property-based versions.
- Runtime validation of messages arriving from the webview at the host boundary.
- Performance work: unread response bodies are cancelled, Cargo uses the sparse index with throttling, startup payloads are compacted, Maven Central lookups are de-duplicated, and release notes are length-capped.
- Shared error-description helper (`describeError`/`isAbortError`) used across the host.

### Changed

- The Activity Bar view is now drawn and themed natively by VS Code (a launcher with Open/Search plus project links) instead of a hosted webview.
- Registry/config descriptions and viewsWelcome content expanded to document untrusted-workspace and Maven behaviour.
- Update commands now preserve the declared operator (e.g. `^1.2`, `>=2.28`) instead of pinning to an exact version, and workspace-wide checks are reported once rather than per member.
- Problem-panel diagnostics now follow the declaration line as the manifest is edited.

### Removed

- The webview-based sidebar provider (`src/ui/sidebarProvider.ts`) and its integration test, superseded by the native Activity Bar view.

### Fixed

- Monorepo lockfile parsing and importer resolution across npm, pnpm, Yarn, Cargo, Composer and Python lockfiles.
- Duplicate-version and dependency-graph findings no longer repeat for every member of a workspace.
- Audit, license-policy and registry-override handling hardened and covered by additional tests.

## [1.0.0] - 2026-09-23

### Added

- First implementation of Orizzonte.