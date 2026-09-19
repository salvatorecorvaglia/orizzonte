import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Two projects rather than one, because the two halves of this codebase need
 * different environments: the extension host is plain Node, and the webview
 * needs a DOM. Running them as projects keeps a single `vitest run` covering
 * both, and a single coverage report across them.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'webview',
          include: ['tests/webview/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/webview/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      /*
       * Everything that imports `vscode`.
       *
       * That module only exists inside the editor, so these cannot be loaded
       * here at all — they are covered by `test:integration`, which runs in a
       * real VS Code and cannot report into this run. Counting them would put
       * a permanent ~2000 uncovered lines in the denominator and make the
       * threshold measure how much `vscode`-free code exists rather than how
       * well it is tested.
       *
       * The deliberate design consequence: keeping logic out of these files is
       * what makes it testable, so this list should stay short.
       */
      exclude: [
        'src/extension.ts',
        'src/**/*.d.ts',
        'src/core/protocol.ts',
        'src/core/types.ts',
        'src/core/scanner.ts',
        'src/core/watcher.ts',
        'src/core/workspace.ts',
        'src/ui/dependencyMutator.ts',
        // These two import `vscode` like the rest of `ui/`, so they cannot be
        // loaded here either — they were simply missed. Left in, they were
        // counted at 0% and measured how much `vscode`-importing code exists
        // rather than how well anything is tested, which is exactly what this
        // list exists to stop.
        'src/ui/depCodeLens.ts',
        'src/ui/depDiagnostics.ts',
        'src/ui/gitDiff.ts',
        'src/ui/panelManager.ts',
        // Split out of `panelManager.ts`; they import `vscode` for the same
        // reasons it does and are covered by `test:integration` alongside it.
        'src/ui/panel/inspections.ts',
        'src/ui/panel/webviewHost.ts',
        'src/ui/sidebarProvider.ts',
        'src/ui/terminalRunner.ts',
        'src/ui/webviewSecurity.ts',
        'src/webview/main.tsx',
      ],
      /*
       * Set just under what the suite currently achieves (92.2% lines, 79.9%
       * branches, 89.9% functions, 88.8% statements), so the gate catches
       * regressions without failing on the next honest refactor.
       *
       * Raise these when coverage rises; do not lower them to make a red build
       * green. Branches still trails the others, and remains the gap worth
       * closing next.
       *
       * What this gate deliberately does *not* cover is the excluded list
       * above. `test:integration` exercises those files but cannot report into
       * a threshold here, and gating it on its own is not currently worth the
       * plumbing: the extension it loads is `dist/extension.js`, a minified
       * production bundle with no source map, so coverage collected against it
       * measures the bundle rather than `src/`. Making that meaningful means
       * building an unminified, mapped bundle just for tests. Until then the
       * lever that actually works is the one the exclusion list already
       * describes — move logic out of `vscode`-importing files, as
       * `core/gitRefs.ts` was moved out of `ui/gitDiff.ts`, and this list
       * shrinks.
       */
      thresholds: {
        lines: 92,
        functions: 89,
        branches: 79,
        statements: 88,
      },
    },
  },
});
