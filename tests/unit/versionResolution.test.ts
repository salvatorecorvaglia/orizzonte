import { describe, expect, it, vi } from 'vitest';
import { auditDependencies } from '../../src/core/audit.js';
import { resolveVersion } from '../../src/core/lockfiles/installed.js';
import type { ResolvedIndex } from '../../src/core/lockfiles/types.js';
import type { ProjectGroup } from '../../src/core/types.js';
import { GradleProvider } from '../../src/providers/gradle/index.js';
import { MavenProvider } from '../../src/providers/maven/index.js';
import { NodeProvider } from '../../src/providers/node/index.js';
import { makeContext } from './helpers.js';

const want = { name: 'pkg', declared: '^1.0.0' };
const resolve = (index: ResolvedIndex) =>
  resolveVersion(index, '', want, 'node');

describe('resolution evidence', () => {
  it('distinguishes a range fallback from an exact importer', () => {
    const index = { all: new Map([['pkg', ['1.0.0', '1.1.0']]]) };
    expect(resolve(index)).toMatchObject({
      version: '1.1.0',
      source: 'lockfile-range',
      confidence: 'inferred',
    });
    expect(
      resolve({ ...index, importer: () => new Map([['pkg', '1.0.0']]) }),
    ).toMatchObject({
      version: '1.0.0',
      source: 'lockfile-importer',
      confidence: 'exact',
    });
  });
  it('rejects incompatible importer data rather than substituting a sibling', () => {
    expect(
      resolve({
        all: new Map([['pkg', ['1.0.0']]]),
        importer: () => new Map([['pkg', '2.0.0']]),
      }),
    ).toMatchObject({ source: 'unresolved', confidence: 'unknown' });
  });
  it('retains exact descriptor evidence', () => {
    expect(
      resolve({
        all: new Map([['pkg', ['1.0.0', '1.1.0']]]),
        descriptors: new Map([['pkg@^1.0.0', '1.0.0']]),
      }),
    ).toMatchObject({ source: 'lockfile-descriptor', confidence: 'exact' });
  });
  it('accepts a compatible unique copy, rejecting an incompatible unique copy', () => {
    expect(resolve({ all: new Map([['pkg', ['1.1.0']]]) })).toMatchObject({
      source: 'lockfile-single',
      confidence: 'exact',
    });
    expect(resolve({ all: new Map([['pkg', ['2.0.0']]]) })).toEqual({
      source: 'unresolved',
      confidence: 'unknown',
    });
  });
  it('does not treat a sibling fallback as an exact importer resolution', () => {
    expect(
      resolve({
        all: new Map([['pkg', ['1.1.0']]]),
        importer: () => undefined,
      }),
    ).toMatchObject({ version: '1.1.0', confidence: 'inferred' });
  });
  it('audits a compatible exact importer normally', async () => {
    const ctx = makeContext();
    const post = vi
      .spyOn(ctx.http, 'postJson')
      .mockResolvedValue({ results: [{}] });
    const parsed = await new NodeProvider().parse(
      '/p/package.json',
      '{"dependencies":{"pkg":"^1.0.0"}}',
      ctx,
    );
    const dep = parsed.dependencies[0];
    dep.installed = '1.1.0';
    dep.versionResolution = {
      version: '1.1.0',
      source: 'lockfile-importer',
      confidence: 'exact',
    };
    const group: ProjectGroup = {
      label: 'p',
      manifestPath: parsed.path,
      ecosystem: 'node',
      toolchain: 'npm',
      dependencies: [dep],
    };
    expect(await auditDependencies([group], ctx)).toMatchObject({
      complete: true,
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('clears old resolution evidence when a lockfile disappears', async () => {
    const provider = new NodeProvider();
    const ctx = makeContext();
    const parsed = await provider.parse(
      '/p/package.json',
      '{"dependencies":{"pkg":"^1.0.0"}}',
      ctx,
    );
    const dep = parsed.dependencies[0];
    dep.installed = '1.1.0';
    dep.versionResolution = {
      version: '1.1.0',
      source: 'lockfile-importer',
      confidence: 'exact',
    };
    await provider.readLockfile('/p', ctx, parsed.dependencies);
    expect(dep.installed).toBeUndefined();
    expect(dep.versionResolution).toEqual({
      source: 'unresolved',
      confidence: 'unknown',
    });
  });
  it('preserves per-declaration versions for repeated names', async () => {
    const provider = new NodeProvider();
    const ctx = makeContext(
      {
        '/p/yarn.lock':
          'pkg@^1.0.0:\n  version "1.1.0"\n\npkg@^2.0.0:\n  version "2.1.0"\n',
      },
      '/p',
    );
    const manifest = await provider.parse(
      '/p/package.json',
      '{"dependencies":{"pkg":"^1.0.0"},"devDependencies":{"pkg":"^2.0.0"}}',
      ctx,
    );
    await provider.readLockfile('/p', ctx, manifest.dependencies);
    expect(
      manifest.dependencies.map((d) => d.versionResolution?.version),
    ).toEqual(['1.1.0', '2.1.0']);
  });
  it('skips inferred versions even if the legacy approximation flag is absent', async () => {
    const ctx = makeContext();
    const post = vi.spyOn(ctx.http, 'postJson');
    const parsed = await new NodeProvider().parse(
      '/p/package.json',
      '{"dependencies":{"pkg":"^1.0.0"}}',
      ctx,
    );
    parsed.dependencies[0].installed = '1.1.0';
    parsed.dependencies[0].versionResolution = {
      version: '1.1.0',
      source: 'lockfile-range',
      confidence: 'inferred',
    };
    const group: ProjectGroup = {
      label: 'p',
      manifestPath: parsed.path,
      ecosystem: 'node',
      toolchain: 'npm',
      dependencies: parsed.dependencies,
    };
    expect(await auditDependencies([group], ctx)).toEqual({
      complete: false,
      skipped: 1,
    });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('Java selectors', () => {
  it.each(['[1,2)', 'LATEST', 'RELEASE', '1.0-SNAPSHOT'])(
    'does not treat Maven %s as installed',
    async (version) => {
      const ctx = makeContext();
      const manifest = await new MavenProvider().parse(
        '/p/pom.xml',
        `<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>${version}</version></dependency></dependencies></project>`,
        ctx,
      );
      expect(manifest.dependencies[0].installed).toBeUndefined();
    },
  );
  it('refuses a Java range at the audit boundary even if a caller sets installed', async () => {
    const ctx = makeContext();
    const post = vi.spyOn(ctx.http, 'postJson');
    const parsed = await new GradleProvider().parse(
      '/p/build.gradle',
      'implementation "g:a:[1,2)"',
      ctx,
    );
    parsed.dependencies[0].installed = '[1,2)';
    const group: ProjectGroup = {
      label: 'p',
      manifestPath: parsed.path,
      ecosystem: 'gradle',
      toolchain: 'gradle',
      dependencies: parsed.dependencies,
    };
    expect(await auditDependencies([group], ctx)).toMatchObject({
      complete: false,
      skipped: 1,
    });
    expect(post).not.toHaveBeenCalled();
  });
  it.each(['1.+', 'latest.release', '[1,2)', '1.0-SNAPSHOT'])(
    'preserves Gradle %s without claiming a resolution',
    async (version) => {
      const ctx = makeContext();
      const provider = new GradleProvider();
      for (const [file, text] of [
        ['build.gradle', `implementation "g:a:${version}"`],
        [
          'libs.versions.toml',
          `[libraries]\na={module="g:a",version="${version}"}`,
        ],
      ]) {
        const manifest = await provider.parse(`/p/${file}`, text, ctx);
        expect(manifest.dependencies[0].declared).toBe(version);
        expect(manifest.dependencies[0].installed).toBeUndefined();
      }
    },
  );
});
