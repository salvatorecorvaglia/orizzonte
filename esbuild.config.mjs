import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

/**
 * Copy the codicon font and stylesheet into `dist/`.
 *
 * The Activity Bar view is a hand-written HTML string rather than part of the
 * Vite bundle, so it cannot reach the copy Vite inlines into the panel's
 * stylesheet — and `node_modules` is excluded from the published .vsix, so it
 * cannot reach the package either. Copying the two files it needs into `dist`
 * lets that view keep a `localResourceRoots` grant of exactly the directory it
 * loads from, which is the property `sidebarProvider` was careful to establish.
 */
async function copyCodicons() {
  const require = createRequire(import.meta.url);
  const source = dirname(require.resolve('@vscode/codicons/package.json'));
  const target = 'dist/codicons';
  await mkdir(target, { recursive: true });
  for (const file of ['codicon.css', 'codicon.ttf']) {
    await cp(join(source, 'dist', file), join(target, file));
  }
}

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * The extension host runs in Node inside VS Code, so `vscode` is provided at
 * runtime and must never be bundled.
 */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  // Matches `engines.node`. Targeting an older runtime than the one we require
  // only costs downlevelling we do not need.
  target: 'node22',
  external: ['vscode'],
  /**
   * Prefer the ESM entry point of every dependency.
   *
   * esbuild's Node default is ['main', 'module'], which picks up UMD builds
   * (jsonc-parser ships one as `main`). A UMD wrapper calls `require()` from
   * inside a factory function, which esbuild cannot statically analyse, so
   * those requires survive into the bundle and fail at runtime with
   * "Cannot find module './impl/format'". The ESM build bundles cleanly.
   */
  mainFields: ['module', 'main'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

await copyCodicons();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
