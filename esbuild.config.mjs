import * as esbuild from 'esbuild';

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

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
