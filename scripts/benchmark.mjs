import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

// Compile in memory: benchmarks use production parsers without rewriting the repo.
const bundle = await build({
  stdin: {
    contents: `export {applyVersions} from './src/core/versionEnrichment.ts';
export {maxVersion,maxSatisfying,registryConstraint,classifyUpdate} from './src/core/versions/index.ts';
export {npmLockfile} from './src/core/lockfiles/npm.ts';
export {uvLockfile} from './src/core/lockfiles/python.ts';
export {TtlCache} from './src/core/cache.ts';
export {HttpClient} from './src/core/http.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  mainFields: ['module', 'main'],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const {
  applyVersions,
  maxVersion,
  maxSatisfying,
  registryConstraint,
  classifyUpdate,
  npmLockfile,
  uvLockfile,
  TtlCache,
  HttpClient,
} = module.exports;
const rowCount = 1000;
const names = 10;
const versions = Array.from({ length: 250 }, (_, i) => `1.0.${i}`);
const registry = new Map(
  Array.from({ length: names }, (_, i) => [`pkg-${i}`, { versions }]),
);
const rows = () =>
  Array.from({ length: rowCount }, (_, i) => ({
    key: String(i),
    name: `pkg-${i % names}`,
    ecosystem: 'node',
    scope: 'prod',
    declared: Math.floor(i / names) % 2 ? '^1' : '0.0.0',
    installed: `1.0.${i % 20}`,
    updateKind: 'unknown',
    vulnerabilities: [],
    manifestPath: `/workspace/${Math.floor(i / names)}/package.json`,
    projectLabel: 'fixture',
  }));
// The previous row-by-row algorithm is retained only as a benchmark baseline.
function baseline(dependencies) {
  for (const dep of dependencies) {
    const info = registry.get(dep.name);
    dep.latest = info.latest ?? maxVersion('node', info.versions);
    dep.lookupFailed = info.stale || undefined;
    dep.wanted =
      maxSatisfying('node', info.versions, registryConstraint(dep.declared)) ??
      dep.installed;
    dep.updateKind = classifyUpdate('node', dep.installed, dep.latest);
  }
}
function timed(fn, repeats = 3) {
  const samples = [];
  for (let i = 0; i < repeats; i++) {
    const start = performance.now();
    fn();
    samples.push(Number((performance.now() - start).toFixed(3)));
  }
  return {
    samplesMs: samples,
    medianMs: [...samples].sort((a, b) => a - b)[
      Math.floor(samples.length / 2)
    ],
  };
}
const before = rows();
const after = rows();
baseline(before);
const calculations = applyVersions(after, 'node', registry);
assert.deepEqual(after, before);
const enrichment = {
  rows: rowCount,
  packages: names,
  versionsPerPackage: versions.length,
  baseline: timed(() => baseline(rows())),
  optimized: timed(() => applyVersions(rows(), 'node', registry)),
  calculations,
};
const packages = { '': { dependencies: { 'pkg-0': '1.0.0' } } };
for (let i = 0; i < 5000; i++)
  packages[`node_modules/pkg-${i}`] = {
    version: '1.0.0',
    dependencies: i < 4999 ? { [`pkg-${i + 1}`]: '1.0.0' } : {},
  };
const npmText = JSON.stringify({ lockfileVersion: 3, packages });
const uvText = Array.from(
  { length: 2000 },
  (_, i) =>
    `[[package]]\nname="pkg-${i}"\nversion="1.0.0"\ndependencies=[${i < 1999 ? `{name="pkg-${i + 1}"}` : ''}]\n`,
).join('\n');
const parsing = {
  npm: {
    packages: 5000,
    inputBytes: Buffer.byteLength(npmText),
    graph: timed(() => npmLockfile.edges(npmText)),
    resolved: timed(() => npmLockfile.resolved(npmText)),
  },
  uv: {
    packages: 2000,
    inputBytes: Buffer.byteLength(uvText),
    graph: timed(() => uvLockfile.edges(uvText)),
  },
};
const stored = new Map();
const cache = new TtlCache({
  get: (key) => stored.get(key),
  keys: () => [...stored.keys()],
  update: (key, value) => {
    if (value === undefined) stored.delete(key);
    else stored.set(key, value);
    return Promise.resolve();
  },
});
global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const index = `\n${Array.from({ length: 100000 }, (_, i) => `project-${String(i).padStart(8, '0')}`).join('\n')}\n`;
await cache.set('python-index', index, 86400000, { persist: false });
await cache.set('version-fixture', { versions }, 3600000);
await cache.flushNow();
global.gc?.();
const heapAfter = process.memoryUsage().heapUsed;
const originalFetch = global.fetch;
const http = new HttpClient('benchmark');
try {
  global.fetch = async () =>
    new Response('é'.repeat(1000), { headers: { etag: 'benchmark' } });
  await http.getText('https://example.test/body');
} finally {
  global.fetch = originalFetch;
}
console.log(
  JSON.stringify(
    {
      runtime: process.version,
      platform: process.platform,
      architecture: process.arch,
      enrichment,
      parsing,
      cache: {
        ...cache.statistics(),
        http: http.cacheStatistics(),
        observedHeapDeltaBytes: heapAfter - heapBefore,
        heapMeasurement: global.gc
          ? 'GC-assisted approximate delta; includes fixture string, not just cache overhead'
          : 'GC unavailable; approximate process delta',
      },
    },
    null,
    2,
  ),
);
