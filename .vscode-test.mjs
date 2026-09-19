import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  // Must match what `tsconfig.integration.json` actually emits: it compiles
  // with `rootDir: "."`, so `tests/integration/*.ts` lands in
  // `out/tests/integration/`. A glob that matches nothing makes Mocha report
  // "0 passing" and exit 0 — a green CI job that ran no tests at all.
  files: 'out/tests/integration/**/*.test.js',
  mocha: {
    ui: 'bdd',
    /*
     * Well above what a fixture scan needs, and well below "the suite has
     * hung". Mocha's 2s default is a filesystem walk away from flaking on a
     * cold or loaded CI runner, which is the kind of failure that teaches
     * people to re-run the build rather than read it.
     */
    timeout: 30_000,
  },
  workspaceFolder: 'tests/fixtures',
});
