import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditDependencies } from '../../src/core/audit.js';
import { explainDependency } from '../../src/core/depGraph.js';
import { canLookupDependency } from '../../src/core/registryAccess.js';
import type { ProjectGroup } from '../../src/core/types.js';
import { GradleProvider } from '../../src/providers/gradle/index.js';
import { MavenProvider } from '../../src/providers/maven/index.js';
import { PythonProvider } from '../../src/providers/python/index.js';
import { makeContext } from './helpers.js';

const cases = [
  {
    provider: new PythonProvider(),
    path: '/ws/requirements.txt',
    text: '--index-url https://private.example/simple\nsecret==1.0.0',
  },
  {
    provider: new PythonProvider(),
    path: '/ws/pyproject.toml',
    text: '[project]\ndependencies=["secret==1.0.0"]\n[[tool.uv.index]]\nurl="https://private.example/simple"',
  },
  {
    provider: new MavenProvider(),
    path: '/ws/pom.xml',
    text: '<project><repositories><repository><url>https://private.example</url></repository></repositories><dependencies><dependency><groupId>secret</groupId><artifactId>lib</artifactId><version>1.0.0</version></dependency></dependencies></project>',
  },
  {
    provider: new GradleProvider(),
    path: '/ws/app/build.gradle',
    text: 'implementation "secret:lib:1.0.0"',
    files: {
      '/ws/settings.gradle':
        'dependencyResolutionManagement { repositories { maven { url "https://private.example" } } }',
    },
  },
];

describe('custom repository privacy', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(cases)(
    'protects $path from public registry and advisory requests',
    async ({ provider, path, text, files }) => {
      const ctx = makeContext(files, '/ws');
      const get = vi.spyOn(ctx.http, 'getJson');
      const post = vi.spyOn(ctx.http, 'postJson');
      const manifest = await provider.parse(path, text, ctx);
      expect(manifest.dependencies).toHaveLength(1);
      const dep = manifest.dependencies[0];
      dep.installed = '1.0.0';
      expect(dep.source).toBe('private');
      expect(canLookupDependency(dep, ctx)).toBe(false);
      const group: ProjectGroup = {
        label: 'app',
        manifestPath: path,
        ecosystem: manifest.ecosystem,
        toolchain: 'npm',
        dependencies: [dep],
      };
      expect(await auditDependencies([group], ctx)).toMatchObject({
        complete: false,
        skipped: 1,
      });
      await explainDependency(dep, ctx);
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(
        canLookupDependency(dep, {
          ...ctx,
          registryOverride: () => 'https://private.example',
        }),
      ).toBe(true);
    },
  );
  it('keeps ordinary public Python dependencies eligible', async () => {
    const ctx = makeContext({}, '/ws');
    const parsed = await new PythonProvider().parse(
      '/ws/requirements.txt',
      'requests==2.32.0',
      ctx,
    );
    expect(canLookupDependency(parsed.dependencies[0], ctx)).toBe(true);
  });
  it('shares configuration reads within a scan and refreshes them next scan', async () => {
    const ctx = makeContext({}, '/ws');
    ctx.lockfileMemo = new Map();
    let configuration = '';
    const read = vi
      .spyOn(ctx, 'readFile')
      .mockImplementation(async (file) =>
        file === '/ws/uv.toml' ? configuration : null,
      );
    const provider = new PythonProvider();
    await Promise.all(
      ['a', 'b'].map((member) =>
        provider.parse(
          `/ws/${member}/requirements.txt`,
          'requests==2.32.0',
          ctx,
        ),
      ),
    );
    expect(
      read.mock.calls.filter(([file]) => file === '/ws/uv.toml'),
    ).toHaveLength(1);
    configuration = 'default-index="https://private.example/simple"';
    ctx.lockfileMemo = new Map();
    const parsed = await provider.parse(
      '/ws/a/requirements.txt',
      'requests==2.32.0',
      ctx,
    );
    expect(parsed.dependencies[0].source).toBe('private');
    expect(
      read.mock.calls.filter(([file]) => file === '/ws/uv.toml'),
    ).toHaveLength(2);
  });
  it.each([
    'PIP_INDEX_URL',
    'PIP_EXTRA_INDEX_URL',
    'UV_INDEX_URL',
    'UV_DEFAULT_INDEX',
    'UV_INDEX',
  ])(
    'protects packages when %s points at a private index',
    async (variable) => {
      vi.stubEnv(variable, 'https://private.example/simple');
      const parsed = await new PythonProvider().parse(
        '/ws/requirements.txt',
        'secret==1.0',
        makeContext({}, '/ws'),
      );
      expect(parsed.dependencies[0].source).toBe('private');
    },
  );
  it('recognizes user Maven mirrors', async () => {
    const files = {
      [path.join(os.homedir(), '.m2/settings.xml')]:
        '<settings><mirrors><mirror><url>https://private.example</url></mirror></mirrors></settings>',
    };
    const fixture = cases[2];
    const parsed = await fixture.provider.parse(
      fixture.path,
      fixture.text.replace(/<repositories>[\s\S]*?<\/repositories>/, ''),
      makeContext(files, '/ws'),
    );
    expect(parsed.dependencies[0].source).toBe('private');
  });
  it('recognizes an explicitly selected pip configuration file', async () => {
    vi.stubEnv('PIP_CONFIG_FILE', '/config/pip.conf');
    const ctx = makeContext(
      {
        '/config/pip.conf':
          '[global]\nindex-url=https://private.example/simple',
      },
      '/ws',
    );
    const parsed = await new PythonProvider().parse(
      '/ws/requirements.txt',
      'secret==1.0',
      ctx,
    );
    expect(parsed.dependencies[0].source).toBe('private');
  });
  it('does not suppress a standard Gradle Maven Central project', async () => {
    const parsed = await new GradleProvider().parse(
      '/ws/build.gradle',
      'repositories { mavenCentral() }\nimplementation "org.example:lib:1.0"',
      makeContext({}, '/ws'),
    );
    expect(parsed.dependencies[0].source).toBeUndefined();
  });
  it.each([
    '-i https://private.example/simple',
    '-f /private/wheels',
    '-r private.txt',
    '--no-index',
  ])('protects requirements using %s', async (option) => {
    const ctx = makeContext({}, '/ws');
    const parsed = await new PythonProvider().parse(
      '/ws/requirements.txt',
      `${option}\nsecret==1.0`,
      ctx,
    );
    expect(canLookupDependency(parsed.dependencies[0], ctx)).toBe(false);
  });
  it('treats an invalid index environment value as uncertain', async () => {
    vi.stubEnv('UV_INDEX', 'unresolved-index');
    const parsed = await new PythonProvider().parse(
      '/ws/requirements.txt',
      'secret==1.0',
      makeContext({}, '/ws'),
    );
    expect(parsed.dependencies[0].source).toBe('private');
  });
});
