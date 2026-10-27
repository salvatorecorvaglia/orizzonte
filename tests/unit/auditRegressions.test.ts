import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { auditDependencies } from '../../src/core/audit.js';
import { credentialCacheKey } from '../../src/core/cache.js';
import { ManifestIgnore } from '../../src/core/manifestIgnore.js';
import { canLookupDependency } from '../../src/core/registryAccess.js';
import { ScanQueue } from '../../src/core/scanQueue.js';
import type { ProjectGroup } from '../../src/core/types.js';
import {
  classifyUpdate,
  constraintToApproxVersion,
  maxSatisfying,
} from '../../src/core/versions/index.js';
import { collectProjectDuplicates } from '../../src/core/workspaceInspections.js';
import { CargoProvider } from '../../src/providers/cargo/index.js';
import { GradleProvider } from '../../src/providers/gradle/index.js';
import { MavenProvider } from '../../src/providers/maven/index.js';
import { NodeProvider } from '../../src/providers/node/index.js';
import { PythonProvider } from '../../src/providers/python/index.js';
import { fetchVersionsWithCache } from '../../src/providers/shared/cachedFetch.js';
import { makeContext } from './helpers.js';

function group(): ProjectGroup {
  return {
    label: 'app',
    manifestPath: '/p/package.json',
    ecosystem: 'node',
    toolchain: 'npm',
    dependencies: [
      {
        key: 'k',
        name: 'pkg',
        ecosystem: 'node',
        scope: 'prod',
        declared: '1.0.0',
        installed: '1.0.0',
        updateKind: 'none',
        vulnerabilities: [],
        manifestPath: '/p/package.json',
        projectLabel: 'app',
      },
    ],
  };
}

describe('safe declaration edits', () => {
  it('removes only the requested dependency from a minified POM', () => {
    const pom =
      '<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>1</version></dependency></dependencies></project>';
    expect(
      new MavenProvider().editManifest(pom, {
        kind: 'remove',
        name: 'g:a',
        scope: 'prod',
      }),
    ).toBe('<project><dependencies></dependencies></project>');
  });
  it('adds a dependency without duplicating markup preceding a minified closing tag', async () => {
    const provider = new MavenProvider();
    const result = provider.editManifest(
      '<project><dependencies></dependencies></project>',
      { kind: 'add', name: 'g:a', version: '2', scope: 'prod' },
    );
    expect(result?.match(/<project>/g)).toHaveLength(1);
    expect(
      (await provider.parse('/p/pom.xml', result!, makeContext()))
        .dependencies[0].name,
    ).toBe('g:a');
  });
  it('ignores comments and targets the selected Gradle configuration', () => {
    const text =
      '// testImplementation "g:a:0"\ndependencies {\n implementation "g:a:1"\n testImplementation "g:a:2"\n}\n';
    const result = new GradleProvider().editManifest(text, {
      kind: 'update',
      name: 'g:a',
      version: '3',
      scope: 'dev',
    });
    expect(result).toBe(
      text.replace('testImplementation "g:a:2"', 'testImplementation "g:a:3"'),
    );
  });
  it('refuses ambiguous Gradle edits', () => {
    expect(
      new GradleProvider().editManifest('implementation "g:a:1"\napi "g:a:2"', {
        kind: 'update',
        name: 'g:a',
        version: '3',
        scope: 'prod',
      }),
    ).toBeNull();
  });
  it('uses a Gradle declaration identity to disambiguate equal scopes', () => {
    expect(
      new GradleProvider().editManifest('implementation "g:a:1"\napi "g:a:2"', {
        kind: 'update',
        name: 'g:a',
        version: '3',
        scope: 'prod',
        declaration: 'api',
      }),
    ).toBe('implementation "g:a:1"\napi "g:a:3"');
  });
  it('updates a unique catalog version reference but refuses a shared one', () => {
    const text =
      '[versions]\nv="1"\n[libraries]\na={module="g:a",version.ref="v"}\n';
    const provider = new GradleProvider();
    expect(
      provider.editManifest(text, {
        kind: 'update',
        name: 'g:a',
        version: '2',
        scope: 'prod',
        declaration: 'a',
      }),
    ).toBe(text.replace('v="1"', 'v="2"'));
    expect(
      provider.editManifest(`${text}b={module="g:b",version.ref="v"}\n`, {
        kind: 'update',
        name: 'g:a',
        version: '2',
        scope: 'prod',
      }),
    ).toBeNull();
  });
  it('updates shorthand catalog entries and preserves comments', () => {
    const text = '[libraries]\na="g:a:1" # keep\n';
    expect(
      new GradleProvider().editManifest(text, {
        kind: 'update',
        name: 'g:a',
        version: '2',
        scope: 'prod',
      }),
    ).toBe('[libraries]\na="g:a:2" # keep\n');
  });
});

describe('source and declaration identity', () => {
  it.each([
    [
      '[project]\nname="app"\ndependencies=["secret @ https://internal/secret.whl"]',
      'url',
    ],
    ['[tool.poetry.dependencies]\nsecret={path="../secret"}', 'path'],
    [
      '[tool.poetry.dependencies]\nsecret={git="https://internal/secret"}',
      'git',
    ],
    [
      '[project]\ndependencies=["secret"]\n[tool.uv.sources]\nsecret={workspace=true}',
      'workspace',
    ],
  ])('preserves Python non-registry sources', async (text, source) => {
    const provider = new PythonProvider();
    const parsed = await provider.parse(
      '/p/pyproject.toml',
      text,
      makeContext(),
    );
    expect(parsed.dependencies[0].source).toBe(source);
    expect(
      provider.updateCommand(
        { id: 'uv', ecosystem: 'python', cwd: '/p' },
        parsed.dependencies[0],
        '2',
      ),
    ).toBeNull();
  });
  it('keeps the same Python package in two named groups', async () => {
    const parsed = await new PythonProvider().parse(
      '/p/pyproject.toml',
      '[dependency-groups]\ndev=["ruff>=1"]\ntest=["ruff>=2"]',
      makeContext(),
    );
    expect(parsed.dependencies.map((dep) => dep.group?.name)).toEqual([
      'dev',
      'test',
    ]);
    expect(new Set(parsed.dependencies.map((dep) => dep.key)).size).toBe(2);
  });
  it('does not produce a pip requirements command for pyproject.toml', () => {
    expect(
      new PythonProvider().updateAllCommand({
        id: 'pip',
        ecosystem: 'python',
        cwd: '/p',
        manifestFile: 'pyproject.toml',
      }),
    ).toBeNull();
  });
  it('recognizes an alternate Cargo registry', async () => {
    const dep = (
      await new CargoProvider().parse(
        '/p/Cargo.toml',
        '[dependencies]\nsecret={package="internal", version="1",registry="corp"}',
        makeContext(),
      )
    ).dependencies[0];
    expect(dep).toMatchObject({ source: 'private', registryName: 'internal' });
  });
  it('treats a private default npm registry as private for unscoped names too', async () => {
    const ctx = makeContext(
      { '/p/.npmrc': 'registry=https://internal.example' },
      '/p',
    );
    const dep = (
      await new NodeProvider().parse(
        '/p/package.json',
        '{"dependencies":{"secret":"1"}}',
        ctx,
      )
    ).dependencies[0];
    expect(dep.source).toBe('private');
  });
  it.each([
    [new PythonProvider(), '/p/pyproject.toml', '[broken'],
    [new CargoProvider(), '/p/Cargo.toml', '[broken'],
    [new GradleProvider(), '/p/gradle/libs.versions.toml', '[broken'],
    [new MavenProvider(), '/p/pom.xml', '<project>'],
    [new NodeProvider(), '/p/package.json', '{broken'],
  ])(
    'reports invalid manifests instead of inventing empty projects',
    async (provider, file, text) => {
      await expect(provider.parse(file, text, makeContext())).rejects.toThrow();
    },
  );
});

describe('scan freshness and cache provenance', () => {
  it('coalesces invalidated callers into one fresh follow-up scan', async () => {
    const complete: Array<(value: number) => void> = [];
    const run = vi.fn(
      () => new Promise<number>((resolve) => complete.push(resolve)),
    );
    const queue = new ScanQueue(run);
    const first = queue.request({ checkUpdates: true });
    queue.invalidate();
    const next = queue.request({ checkUpdates: true });
    const same = queue.request({ checkUpdates: true });
    complete[0](1);
    expect(await first).toBe(1);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    complete[1](2);
    expect(await next).toBe(2);
    expect(await same).toBe(2);
    await queue.settled();
  });
  it('marks stale fallback data and propagates cancellation', async () => {
    const ctx = makeContext();
    await ctx.cache.set('pkg', { versions: ['1'] }, -1);
    await ctx.cache.flushNow();
    const result = await fetchVersionsWithCache(
      ['pkg'],
      ctx,
      1,
      () => 'pkg',
      async () => {
        throw new Error('offline');
      },
    );
    expect(result.get('pkg')).toMatchObject({ stale: true });
    await expect(
      fetchVersionsWithCache(
        ['pkg'],
        ctx,
        1,
        () => 'pkg',
        async () => {
          throw new DOMException('cancelled', 'AbortError');
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('partitions authenticated cached results without storing tokens', async () => {
    const ctx = makeContext();
    let authorization: string | undefined = 'Bearer token-A';
    ctx.registryAuthHeaders = () =>
      authorization ? { Authorization: authorization } : undefined;
    const fetch = vi.fn(async () => ({ versions: ['1'] }));
    await fetchVersionsWithCache(
      ['pkg'],
      ctx,
      1,
      () => 'pkg',
      fetch,
      undefined,
      'node',
    );
    authorization = 'Bearer token-B';
    await fetchVersionsWithCache(
      ['pkg'],
      ctx,
      1,
      () => 'pkg',
      fetch,
      undefined,
      'node',
    );
    authorization = undefined;
    await fetchVersionsWithCache(
      ['pkg'],
      ctx,
      1,
      () => 'pkg',
      fetch,
      undefined,
      'node',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      credentialCacheKey('pkg', { Authorization: 'Bearer token-A' }),
    ).not.toContain('token-A');
  });
});

describe('audit completion', () => {
  it('keeps private audit names private even when a registry override is configured', async () => {
    const ctx = makeContext();
    const project = group();
    project.dependencies[0].source = 'private';
    ctx.registryOverride = () => 'https://internal.example';
    const post = vi.spyOn(ctx.http, 'postJson');
    expect(canLookupDependency(project.dependencies[0], ctx)).toBe(true);
    await auditDependencies([project], ctx);
    expect(post).not.toHaveBeenCalled();
    ctx.registryOverride = () => undefined;
    expect(canLookupDependency(project.dependencies[0], ctx)).toBe(false);
  });

  it('marks unfinished pagination incomplete', async () => {
    const ctx = makeContext();
    const postJson = vi.fn(async () => ({
      results: [{ vulns: [], next_page_token: 'more' }],
    }));
    ctx.http.postJson = postJson as typeof ctx.http.postJson;
    expect(await auditDependencies([group()], ctx)).toEqual({
      complete: false,
    });
    expect(postJson).toHaveBeenCalledTimes(5);
  });
  it('marks missing batch responses incomplete', async () => {
    const ctx = makeContext();
    ctx.http.postJson = vi.fn(async () => ({
      results: [],
    })) as typeof ctx.http.postJson;
    expect(await auditDependencies([group()], ctx)).toEqual({
      complete: false,
    });
  });
  it('does not audit guessed versions as resolved facts', async () => {
    const ctx = makeContext();
    const post = vi.spyOn(ctx.http, 'postJson');
    const project = group();
    project.dependencies[0].installedIsApproximate = true;
    expect(await auditDependencies([project], ctx)).toEqual({
      complete: false,
      skipped: 1,
    });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('ecosystem version semantics', () => {
  it.each([
    ['node', '1.0.0-rc.1', '1.0.0'],
    ['python', '1.0rc1', '1.0'],
    ['python', '1.0', '1.0.post1'],
  ] as const)(
    'recognizes %s release transitions as updates',
    (ecosystem, from, to) => {
      expect(classifyUpdate(ecosystem, from, to)).toBe('release');
    },
  );
  it('preserves PEP 440 epochs and treats epoch changes as major', () => {
    expect(constraintToApproxVersion('>=1!2.0')).toBe('1!2.0');
    expect(classifyUpdate('python', '1!2.0', '2!1.0')).toBe('major');
  });
  it('uses Cargo caret requirements and Go minor/patch upgrades', () => {
    expect(maxSatisfying('cargo', ['1.0.0', '1.2.0', '2.0.0'], '1.0.0')).toBe(
      '1.2.0',
    );
    expect(
      maxSatisfying('golang', ['v1.0.0', 'v1.2.0', 'v2.0.0'], 'v1.0.0'),
    ).toBe('v1.2.0');
  });
});

describe('workspace I/O', () => {
  it('scopes anchoring, negation, and nested rules to their directory', async () => {
    const ctx = makeContext({
      '/a/.gitignore': '/generated/\n*.json\n',
      '/a/kept/.gitignore': '!package.json\n',
    });
    const matcher = new ManifestIgnore(ctx.readFile);
    expect(await matcher.ignores('/a', '/a/generated/package.json')).toBe(true);
    expect(await matcher.ignores('/b', '/b/generated/package.json')).toBe(
      false,
    );
    expect(await matcher.ignores('/a', '/a/kept/package.json')).toBe(false);
    expect(await matcher.ignores('/a', '/a/kept/other.json')).toBe(true);
  });
  it('does not re-include files under an ignored parent directory', async () => {
    const ctx = makeContext({
      '/a/.gitignore': 'generated/\n!generated/package.json\n',
    });
    expect(
      await new ManifestIgnore(ctx.readFile).ignores(
        '/a',
        '/a/generated/package.json',
      ),
    ).toBe(true);
  });
  it('shares concurrent root lockfile reads and collapses duplicate reports', async () => {
    const ctx = makeContext(
      {
        '/p/package-lock.json': JSON.stringify({
          packages: {
            'node_modules/pkg': { version: '1' },
            'node_modules/other/node_modules/pkg': { version: '2' },
          },
        }),
      },
      '/p',
    );
    const read = vi.spyOn(ctx, 'readFile');
    const groups = Array.from({ length: 8 }, (_, i) => ({
      ...group(),
      manifestPath: `/p/member${i}/package.json`,
    }));
    const result = await collectProjectDuplicates(groups, ctx);
    expect(result).toHaveLength(1);
    expect(result[0].groups[0]).toMatchObject({
      name: 'pkg',
      versions: ['1', '2'],
    });
    // One read per representation, independent of the number of concurrent members.
    expect(
      read.mock.calls.filter(
        ([file]) => file === path.join('/p', 'package-lock.json'),
      ),
    ).toHaveLength(2);
  });
});
