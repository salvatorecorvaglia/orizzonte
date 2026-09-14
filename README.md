# Orizzonte 🔭

**Universal Visual Package Manager for Visual Studio Code**

**Orizzonte** provides a unified, visual, multi-ecosystem package management experience directly inside VS Code.

---

## ✨ Features

- 🌐 **Universal Multi-Ecosystem Support**: Native parsing for `package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `composer.json`, `pom.xml`, `build.gradle`, and `build.gradle.kts`.
- ⚡ **Panel-First Interface**:
  - **React Webview Panel** (`orizzonte.open`): Interactive, virtualized UI built with React, Vite, and TanStack Virtual for deep dependency analysis, search, sorting, and filtering. This is where dependencies are read and acted on.
  - **Activity Bar View** (`orizzonte.sidebar`): A compact launcher for the panel. Its title bar carries the toolbar actions — open, search, check updates, refresh and update all — so they are one click away without the panel being open.
  - **Inline CodeLenses**: Manifest files show a CodeLens above each dependency with an available update and/or known vulnerabilities, so status is visible without opening the panel — clicking one jumps straight to that dependency's details.
- 🎛️ **Focused Toolbar**: The actions used every session — search, check updates, refresh — stay inline; duplicate versions, licenses, branch comparison and report export sit behind a **More** menu with full keyboard support. Filter chips carry their own counts, so a number and the control that acts on it are the same thing, and one overlay panel is open at a time rather than four stacking over the table. The panel opens with the `outdated` chip already pressed — what needs updating rather than the whole inventory — with "Clear filters" one click from the full list.
- 📐 **Density-Aware Layout**: The table adapts as the panel narrows — dropping the Size and Scope columns, then reducing the row actions to icons — so it stays usable dragged into the secondary sidebar instead of scrolling sideways.
- 🛡️ **Security Vulnerability Audits**: Automated security scans powered by [OSV.dev](https://osv.dev) to detect known CVEs and advisories affecting your direct and transitive dependencies, surfaced both in the panel and as Problems-panel diagnostics on open manifest files.
- 🔄 **Smart Update Checks & One-Click Upgrades**: Highlights outdated packages with semver diff indicators (`major`, `minor`, `patch`) and updates dependencies directly from the interface. The target version is coloured by how big the jump is, so a major upgrade never reads as safe, and the detail drawer shows GitHub release notes ("What's Changed") between the installed and target version before you upgrade.
- 🧬 **Duplicate Version Detection**: A dedicated panel powered by modular lockfile parsers (`src/core/lockfiles/`) checks each project's lockfile for packages resolved at more than one version at once (npm, pnpm, yarn, Cargo, Composer, poetry/uv).
- ⚖️ **License Metadata & Policy**: Registry-reported license info per package, plus a "License summary" panel that groups every dependency by license and flags violations of configurable allow/deny lists.
- 🔀 **Compare Dependencies With a Branch**: Pick a Git ref and see what every project's lockfile would add, remove, or change versions on relative to the working tree — a PR's or branch's dependency impact at a glance.
- 📤 **Export Dependency Report**: Write the current scan — outdated packages, known vulnerabilities, and duplicate versions — to a Markdown or JSON file for sharing outside the editor.
- 📏 **Package Size Tracking**: Tracks unpacked size or download size for packages across Node (npm), Rust (Cargo), and Python (PyPI) registries.
- 🔍 **Registry Search & Package Installation**: Search public registries (npm, PyPI, Crates.io, Packagist, Maven Central) and install packages into your manifests without leaving VS Code.
- 🌲 **"Why Is This Installed?" Dependency Inspector**: Inspect transitive dependencies and trace exact resolution paths.
- 📁 **Monorepo & Multi-Root Support**: Automatically discovers and aggregates nested manifest files across complex monorepos and multi-root workspaces with `.gitignore` and glob exclusion awareness.
- ♿ **Accessible & Keyboard-First UI**: The whole dependency grid is a single tab stop — Up/Down moves between rows, Left/Right reaches a row's own checkbox and actions — with semantic button controls, a global `Ctrl+F` / `Cmd+F` search shortcut, dismissable overlays (`Escape` key & backdrop dismissal for drawers, menus and modals), ARIA live progress indicators, `prefers-reduced-motion` support, and focus rings and row states that survive high-contrast and forced-colours themes.
- 🚀 **High Performance & Shared Caching**: Built-in HTTP caching layer across registry queries, concurrent background manifest scanning, and reference-counted operation tracking (`BusyTracker`) for smooth progress indication across async tasks.
- 🔔 **Error Notification Queue**: Queued toast notification system for managing host and registry errors without silent dropping.
- ⚙️ **Custom Registries & Proxy Overrides**: Configure private registries per ecosystem (npm, PyPI, Crates.io, Packagist, Go Proxy, Maven Central), including authenticated overrides via an environment-variable-held bearer token, and custom `User-Agent` contact headers. Registry overrides are ignored in untrusted workspaces.

---

## 📦 Supported Ecosystems

| Ecosystem | Manifest Files | Supported Package Managers | Registries |
| :--- | :--- | :--- | :--- |
| **Node.js / JS** | `package.json` | `npm`, `yarn`, `pnpm`, `bun` | npm Registry |
| **Python** | `pyproject.toml`, `requirements.txt` | `pip`, `uv`, `poetry` | PyPI |
| **Rust** | `Cargo.toml` | `cargo` | Crates.io |
| **Go** | `go.mod` | `go` | Go Proxy / Index |
| **PHP** | `composer.json` | `composer` | Packagist |
| **Java / Kotlin** | `pom.xml`, `build.gradle`, `build.gradle.kts` | `maven`, `gradle` | Maven Central |

---

## 🚀 Installation & Getting Started

### Installation
- **Open VSX**: Install from the [Open VSX Registry](https://open-vsx.org/extension/orizzonte/orizzonte-vscode) or search `Orizzonte` in VS Code / VSCodium / Gitpod.
- **GitHub Release**: Download the compiled `.vsix` from [GitHub Releases](https://github.com/salvatorecorvaglia/orizzonte/releases) and run **`Extensions: Install from VSIX...`**.

### Getting Started
1. Open any project or workspace containing supported manifest files in VS Code.
2. Open Orizzonte:
   - Click on the **Orizzonte** icon in the Activity Bar.
   - Or open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **`Orizzonte: Open Dependency Panel`**.
3. Use the toolbar actions to check for updates, scan security vulnerabilities, or search and install new dependencies.
4. The **More** menu holds the occasional actions: duplicate-version detection, the license summary, comparing against a branch, and exporting a report.

---

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📜 Changelog

Detailed release history and version changes can be found in [CHANGELOG.md](CHANGELOG.md).

## 🔐 Security

If you discover a security vulnerability, please see our [Security Policy](SECURITY.md).

## 📝 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

---

**Author**: [Salvatore Corvaglia](https://github.com/salvatorecorvaglia)