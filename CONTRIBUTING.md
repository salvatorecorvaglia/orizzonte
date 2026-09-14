# Contributing to Orizzonte 🔭

Thank you for your interest in contributing to **Orizzonte**! We welcome contributions, bug reports, feature requests, and documentation improvements from the community.

---

## 🛠️ Prerequisites

Before you start, ensure you have the following installed on your system:

- **Node.js**: `v22.13.0` or higher
- **pnpm**: `v11.23.0` or higher (managed via `packageManager` in `package.json`)
- **VS Code**: `v1.107.0` or higher (Orizzonte requires VS Code 1.107+ APIs)

---

## 🏗️ Architecture Overview

Orizzonte is structured as a VS Code extension with a dual-layer architecture:

- **Extension Host (`src/`)**: Written in TypeScript and compiled with `esbuild`. Responsible for scanning manifest files concurrently with `.gitignore` awareness (`src/core/workspaces.ts`), workspace file watching (`src/core/watcher.ts`), reference-counted operation tracking (`src/core/busyTracker.ts`), modular lockfile parsing (`src/core/lockfiles/`), package manager CLI execution & terminal orchestration (`src/ui/dependencyMutator.ts`), shared registry API querying & HTTP caching (`src/providers/shared/cachedFetch.ts`), package size tracking, OSV.dev vulnerability auditing (`src/core/audit.ts`), license policy checks (`src/core/licensePolicy.ts`), manifest CodeLenses & Problems-panel diagnostics for outdated/vulnerable dependencies (`src/core/depAnnotations.ts`), dependency report export (`src/core/report.ts`), Git ref comparison for the "Compare with…" action (`src/ui/gitDiff.ts`), sidebar view provider (`orizzonte.sidebar`), and webview panel lifecycle & typed message routing (`src/ui/panelManager.ts`, `src/core/webviewRequests.ts`).

- **Webview UI (`src/webview/`)**: React application built with TypeScript, Vite, and TanStack Virtual (`@tanstack/react-virtual`). Rendered inside a VS Code Webview panel (`orizzonte.open`) for deep, interactive dependency management with full accessibility support (roving `tabindex` table focus, global keyboard shortcuts, dismissable overlay management via `useDismissableOverlay`, the toolbar overflow menu's `role="menu"` keyboard pattern, error queuing toast alerts, and ARIA live progress indicators).

### Webview conventions

A few rules the webview is written to. They are easy to break by accident and cheap to keep:

- **One overlay panel at a time**: search, duplicate versions, licenses and the dependency diff are driven by a single `activePanel` value in `App.tsx` (`PanelId`, exported from `Toolbar.tsx`), not a boolean each. Independent flags let all four stack over the table and made the toolbar's `aria-expanded` states something to maintain separately rather than derive.
- **The dependency grid is one tab stop**: rows carry the roving `tabindex`; the controls inside a row (`checkbox`, Update, Remove) carry `tabIndex={-1}` and are reached with Left/Right from their row. A new native control inside a row needs `tabIndex={-1}`, or it multiplies tab stops by the row count. A group header's "Update All" is the deliberate exception — one per project, not one per row.
- **Tokens, not literals, in `theme.css`**: colours come from the VS Code theme tokens or the severity map, and spacing, radii, control sizes and grid tracks come from the `--orizzonte-*` variables. This holds in `src/ui/sidebarProvider.ts` too — the Activity Bar view is a hand-written HTML document, so it restates the radius scale rather than inheriting it.
- **Hiding a grid column means restating the tracks**: `display: none` stops an element being a grid item, so every cell after it shifts back one track. Each breakpoint in `theme.css` therefore redefines `--orizzonte-table-columns` with the columns it still has.
- **Reveal-on-hover uses `opacity`**: never `display` or `visibility`, which would take the control out of the accessibility tree and out of the keyboard order the roving `tabindex` exists to provide.

---

## 🚀 Getting Started

1. **Fork and clone the repository**:
   ```bash
   git clone https://github.com/salvatorecorvaglia/orizzonte.git
   cd orizzonte
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

---

## 💻 Development Workflow

### 1. Watch Mode & Local Iteration

To develop Orizzonte locally with live compilation:

```bash
pnpm run watch
```

This starts concurrent watch processes for both the Extension Host (`esbuild`) and the React Webview UI (`vite`).

### 2. Debugging in VS Code

1. Open the project folder in VS Code.
2. Press **`F5`** (or go to the **Run & Debug** panel and select **Run Extension**).
3. A new **Extension Development Host** window will launch running your local build of Orizzonte.
4. Open any project or workspace with supported dependency manifests (`package.json`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `go.mod`, `composer.json`, `pom.xml`, `build.gradle`, `build.gradle.kts`) to test functionality.

---

## 📜 Available Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `build` | `pnpm run build` | Builds both the extension host (`build:host`) and webview UI (`build:webview`). |
| `build:host` | `pnpm run build:host` | Compiles extension host TypeScript source into `dist/extension.js` using `esbuild`, and copies the codicon font and stylesheet into `dist/codicons` for the Activity Bar view. |
| `build:webview` | `pnpm run build:webview` | Bundles webview UI application into `dist/webview` using `vite`. |
| `watch` | `pnpm run watch` | Watches for source changes and incrementally rebuilds host & webview assets. |
| `typecheck` | `pnpm run typecheck` | Runs `tsc --noEmit` across both extension host and webview TypeScript configurations. |
| `lint` | `pnpm run lint` | Runs [Biome](https://biomejs.dev) linter and formatter checks across the codebase. |
| `lint:fix` | `pnpm run lint:fix` | Runs Biome checks and automatically applies safe fixes. |
| `format` | `pnpm run format` | Formats all files using Biome. |
| `test` | `pnpm run test` | Runs unit test suite via [Vitest](https://vitest.dev). |
| `test:watch` | `pnpm run test:watch` | Runs Vitest in interactive watch mode for rapid iteration. |
| `test:coverage` | `pnpm run test:coverage` | Runs unit tests and generates code coverage reports. |
| `test:integration` | `pnpm run test:integration` | Runs VS Code extension integration tests inside an automated extension host. |
| `test:all` | `pnpm run test:all` | Executes both unit test and integration test suites. |
| `package` | `pnpm run package` | Packages the extension into a standalone `.vsix` installer file using `@vscode/vsce`. |
| `publish:ovsx` | `pnpm run publish:ovsx` | Publishes the packaged `.vsix` extension to the [Open VSX Registry](https://open-vsx.org/) via `ovsx`. |

---

## 🧪 Testing & Verification Guidelines

Orizzonte includes comprehensive test suites across three layers:
- **Unit Tests (`tests/unit/`)**: Verifies manifest parsers (`parsers.test.ts`), provider management commands & input validation (`providerCommands.test.ts`, `providerValidation.test.ts`), registry metadata lookups & caching (`registries.test.ts`, `registry.test.ts`, `registryOverride.test.ts`), the TTL cache (`cache.test.ts`), the "why is this installed" dependency graph (`depGraph.test.ts`), busy state management (`busyTracker.test.ts`), webview request routing (`webviewRequests.test.ts`), scan queues (`scanQueue.test.ts`, `serialQueue.test.ts`), shell-argument quoting (`quoting.test.ts`), version utilities (`versions.test.ts`), OSV.dev auditing (`audit.test.ts`), license policy checks (`licensePolicy.test.ts`), manifest CodeLens/diagnostic annotations (`depAnnotations.test.ts`), GitHub "What's Changed" release-note matching (`changelog.test.ts`), declaration lookups (`findDeclaration.test.ts`), report export (`report.test.ts`), and workspace discovery (`workspaces.test.ts`, `vocabulary.test.ts`, `http.test.ts`).
- **Webview Component Tests (`tests/webview/`)**: Verifies React component logic (`App.test.tsx`, `DepTable.test.tsx`, `SearchInstall.test.tsx`, `DetailDrawer.test.tsx`, `Toolbar.test.tsx`), UI interactions, and VS Code API message communication (`vscodeApi.test.tsx`) using Testing Library & JSDOM.
- **Integration Tests (`tests/integration/`)**: Verifies host execution inside VS Code Extension Host including terminal command execution (`terminalRunner.test.ts`), manifest mutation (`dependencyMutator.test.ts`), webview panel lifecycle (`panelManager.test.ts`), the sidebar view (`sidebarProvider.test.ts`), workspace file watching (`watcher.test.ts`), webview security & CSP headers (`webviewSecurity.test.ts`), and scanner exclusion policies (`scannerExclusions.test.ts`).

Before submitting a pull request, verify that all quality and test checks pass cleanly:

```bash
# 1. Verify TypeScript types across host and webview
pnpm run typecheck

# 2. Check code style and formatting rules with Biome
pnpm run lint

# 3. Format code automatically (if needed)
pnpm run format

# 4. Run unit & webview component test suite
pnpm run test

# 5. Run integration tests (optional locally, mandatory in CI)
pnpm run test:integration
```

---

## 📬 Submitting Pull Requests

1. **Create a topic branch**:
   ```bash
   git checkout -b feature/awesome-feature
   ```
2. **Commit your changes**:
   Keep commits atomic and write clear, descriptive commit messages.
3. **Push to your fork**:
   ```bash
   git push origin feature/awesome-feature
   ```
4. **Open a Pull Request**:
   - Provide a clear title and description explaining the motivation and changes made.
   - Link related issues (e.g. `Fixes #123`).
   - Ensure all CI workflow checks pass.

---

Happy coding! 🔭