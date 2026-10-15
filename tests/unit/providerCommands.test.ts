/**
 * The command each provider builds, one behaviour per test.
 *
 * These used to be a handful of "generates X, Y and Z" tests with a dozen
 * assertions each, so a failure named a whole provider rather than the rule it
 * broke — and a wrong argv could sit among the passing ones unnoticed, which is
 * how `cargo remove` without `--dev` was pinned as correct.
 */

import { describe, expect, it } from 'vitest';
import type {
  Dependency,
  DepScope,
  Ecosystem,
  Toolchain,
} from '../../src/core/types.js';
import { CargoProvider } from '../../src/providers/cargo/index.js';
import { ComposerProvider } from '../../src/providers/composer/index.js';
import { GoProvider } from '../../src/providers/golang/index.js';
import { GradleProvider } from '../../src/providers/gradle/index.js';
import { MavenProvider } from '../../src/providers/maven/index.js';
import { NodeProvider } from '../../src/providers/node/index.js';
import { PythonProvider } from '../../src/providers/python/index.js';

function makeDep(
  overrides: Partial<Dependency> & {
    name: string;
    declared: string;
    scope: DepScope;
    ecosystem: Ecosystem;
    manifestPath: string;
  },
): Dependency {
  return {
    key: `${overrides.ecosystem}:${overrides.name}`,
    updateKind: 'none',
    vulnerabilities: [],
    projectLabel: 'demo',
    ...overrides,
  };
}

describe('CargoProvider commands', () => {
  const provider = new CargoProvider();
  const toolchain: Toolchain = { id: 'cargo', ecosystem: 'cargo', cwd: '/p' };
  const serde = makeDep({
    name: 'serde',
    declared: '1.0.0',
    scope: 'prod',
    ecosystem: 'cargo',
    manifestPath: '/p/Cargo.toml',
  });

  it.each([
    [
      'serde',
      '1.0.0',
      'prod',
      ['cargo', 'add', 'serde@1.0.0'],
      'Add serde@1.0.0',
    ],
    ['tokio', null, 'dev', ['cargo', 'add', 'tokio', '--dev'], 'Add tokio'],
    ['cc', '1.0', 'build', ['cargo', 'add', 'cc@1.0', '--build'], 'Add cc@1.0'],
  ] as const)(
    'adds %s (%s) to the %s table',
    (name, version, scope, argv, description) => {
      expect(provider.installCommand(toolchain, name, version, scope)).toEqual({
        argv,
        cwd: '/p',
        description,
      });
    },
  );

  it('refuses to install an invalid crate name', () => {
    expect(
      provider.installCommand(toolchain, 'invalid name!', '1.0', 'prod'),
    ).toBeNull();
  });

  it('updates by adding the new version', () => {
    expect(provider.updateCommand(toolchain, serde, '1.0.1')).toEqual({
      argv: ['cargo', 'add', 'serde@1.0.1'],
      cwd: '/p',
      description: 'Add serde@1.0.1',
    });
  });

  it('removes a crate', () => {
    expect(provider.uninstallCommand(toolchain, serde)).toEqual({
      argv: ['cargo', 'remove', 'serde'],
      cwd: '/p',
      description: 'Remove serde',
    });
  });

  it('refuses to remove an invalid crate name', () => {
    expect(
      provider.uninstallCommand(toolchain, { ...serde, name: 'bad name!' }),
    ).toBeNull();
  });

  it('updates everything within the declared ranges', () => {
    expect(provider.updateAllCommand(toolchain)).toEqual({
      argv: ['cargo', 'update'],
      cwd: '/p',
      description: 'Update all dependencies within their declared ranges',
      reach: 'ranges',
    });
  });
});

describe('ComposerProvider commands', () => {
  const provider = new ComposerProvider();
  const toolchain: Toolchain = {
    id: 'composer',
    ecosystem: 'composer',
    cwd: '/p',
  };
  const guzzle = makeDep({
    name: 'guzzlehttp/guzzle',
    declared: '^7.0',
    scope: 'prod',
    ecosystem: 'composer',
    manifestPath: '/p/composer.json',
  });
  const devGuzzle: Dependency = { ...guzzle, scope: 'dev' };

  it('requires a package', () => {
    expect(
      provider.installCommand(toolchain, 'guzzlehttp/guzzle', '^7.0', 'prod'),
    ).toEqual({
      argv: ['composer', 'require', 'guzzlehttp/guzzle:^7.0'],
      cwd: '/p',
      description: 'Require guzzlehttp/guzzle:^7.0',
    });
  });

  it('requires a dev package with --dev', () => {
    expect(
      provider.installCommand(toolchain, 'phpunit/phpunit', '^9.0', 'dev'),
    ).toEqual({
      argv: ['composer', 'require', '--dev', 'phpunit/phpunit:^9.0'],
      cwd: '/p',
      description: 'Require phpunit/phpunit:^9.0',
    });
  });

  it('refuses to install an invalid package name', () => {
    expect(
      provider.installCommand(
        toolchain,
        'invalid package name',
        '^1.0',
        'prod',
      ),
    ).toBeNull();
  });

  it.each([
    [guzzle, ['composer', 'require', 'guzzlehttp/guzzle:^7.5']],
    [devGuzzle, ['composer', 'require', '--dev', 'guzzlehttp/guzzle:^7.5']],
  ])('updates in the table the package lives in', (dep, argv) => {
    expect(provider.updateCommand(toolchain, dep, '^7.5')).toEqual({
      argv,
      cwd: '/p',
      description: 'Require guzzlehttp/guzzle:^7.5',
    });
  });

  it.each([
    [guzzle, ['composer', 'remove', 'guzzlehttp/guzzle']],
    [devGuzzle, ['composer', 'remove', '--dev', 'guzzlehttp/guzzle']],
  ])('removes from the table the package lives in', (dep, argv) => {
    expect(provider.uninstallCommand(toolchain, dep)).toEqual({
      argv,
      cwd: '/p',
      description: 'Remove guzzlehttp/guzzle',
    });
  });

  it('refuses to remove an invalid package name', () => {
    expect(
      provider.uninstallCommand(toolchain, { ...guzzle, name: 'bad name' }),
    ).toBeNull();
  });

  it('updates everything within the declared constraints', () => {
    expect(provider.updateAllCommand(toolchain)).toEqual({
      argv: ['composer', 'update'],
      cwd: '/p',
      description: 'Update all packages within their declared constraints',
      reach: 'ranges',
    });
  });
});

describe('GoProvider commands', () => {
  const provider = new GoProvider();
  const toolchain: Toolchain = { id: 'go', ecosystem: 'golang', cwd: '/p' };
  const gin = makeDep({
    name: 'github.com/gin-gonic/gin',
    declared: 'v1.9.0',
    scope: 'prod',
    ecosystem: 'golang',
    manifestPath: '/p/go.mod',
  });

  it('gets a module at the requested version', () => {
    expect(
      provider.installCommand(
        toolchain,
        'github.com/gin-gonic/gin',
        'v1.9.0',
        'prod',
      ),
    ).toEqual({
      argv: ['go', 'get', 'github.com/gin-gonic/gin@v1.9.0'],
      cwd: '/p',
      description: 'Get github.com/gin-gonic/gin@v1.9.0',
    });
  });

  it('gets @latest when no version is requested', () => {
    expect(
      provider.installCommand(
        toolchain,
        'github.com/gin-gonic/gin',
        null,
        'prod',
      ),
    ).toEqual({
      argv: ['go', 'get', 'github.com/gin-gonic/gin@latest'],
      cwd: '/p',
      description: 'Get github.com/gin-gonic/gin@latest',
    });
  });

  it('updates by getting the new version', () => {
    expect(provider.updateCommand(toolchain, gin, 'v1.9.1')).toEqual({
      argv: ['go', 'get', 'github.com/gin-gonic/gin@v1.9.1'],
      cwd: '/p',
      description: 'Get github.com/gin-gonic/gin@v1.9.1',
    });
  });

  it('removes a requirement with @none', () => {
    expect(provider.uninstallCommand(toolchain, gin)).toEqual({
      argv: ['go', 'get', 'github.com/gin-gonic/gin@none'],
      cwd: '/p',
      description: 'Remove github.com/gin-gonic/gin',
    });
  });

  it('updates every module to its latest minor or patch release', () => {
    expect(provider.updateAllCommand(toolchain)).toEqual({
      argv: ['go', 'get', '-u', './...'],
      cwd: '/p',
      description: 'Update all modules to their latest minor/patch releases',
      reach: 'ranges',
    });
  });
});

describe('NodeProvider commands', () => {
  const provider = new NodeProvider();
  const toolchain = (id: 'npm' | 'pnpm' | 'yarn' | 'bun'): Toolchain => ({
    id,
    ecosystem: 'node',
    cwd: '/p',
  });
  const react = makeDep({
    name: 'react',
    declared: '^18.0.0',
    scope: 'prod',
    ecosystem: 'node',
    manifestPath: '/p/package.json',
  });

  it.each([
    ['npm', ['npm', 'install', 'react@^18.0.0']],
    ['pnpm', ['pnpm', 'add', 'react@^18.0.0']],
    ['yarn', ['yarn', 'add', 'react@^18.0.0']],
    ['bun', ['bun', 'add', 'react@^18.0.0']],
  ] as const)('%s installs a package with its own verb', (id, argv) => {
    expect(
      provider.installCommand(toolchain(id), 'react', '^18.0.0', 'prod'),
    ).toEqual({ argv, cwd: '/p', description: 'Install react@^18.0.0' });
  });

  it.each([
    ['npm', ['npm', 'install', 'vitest@^2.0.0', '--save-dev']],
    ['pnpm', ['pnpm', 'add', 'vitest@^2.0.0', '--save-dev']],
    ['yarn', ['yarn', 'add', 'vitest@^2.0.0', '--dev']],
    ['bun', ['bun', 'add', 'vitest@^2.0.0', '--dev']],
  ] as const)('%s installs a dev dependency with its own flag', (id, argv) => {
    expect(
      provider.installCommand(toolchain(id), 'vitest', '^2.0.0', 'dev'),
    ).toEqual({
      argv,
      cwd: '/p',
      description: 'Install vitest@^2.0.0 as a dev dependency',
    });
  });

  it.each([
    ['caret', '^18.2.0', '18.3.1', 'react@^18.3.1'],
    ['tilde', '~4.17.0', '4.17.21', 'react@~4.17.21'],
    // An exact pin was a deliberate choice; updating must not silently widen
    // it into a range.
    ['exact pin', '2.19.5', '2.21.0', 'react@2.21.0'],
    // A compound range has no single operator worth carrying over.
    ['compound range', '>=1.0.0 <2', '1.3.0', 'react@1.3.0'],
  ])(
    'keeps a %s constraint style when updating',
    (_style, declared, toVersion, spec) => {
      expect(
        provider.updateCommand(
          toolchain('npm'),
          { ...react, declared },
          toVersion,
        )?.argv,
      ).toEqual(['npm', 'install', spec]);
    },
  );

  it.each([
    ['npm', ['npm', 'uninstall', 'react']],
    ['pnpm', ['pnpm', 'remove', 'react']],
    ['yarn', ['yarn', 'remove', 'react']],
    ['bun', ['bun', 'remove', 'react']],
  ] as const)('%s uninstalls with its own verb', (id, argv) => {
    expect(provider.uninstallCommand(toolchain(id), react)).toEqual({
      argv,
      cwd: '/p',
      description: 'Uninstall react',
    });
  });
});

describe('PythonProvider commands', () => {
  const provider = new PythonProvider();
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  const toolchain = (id: 'pip' | 'uv' | 'poetry'): Toolchain => ({
    id,
    ecosystem: 'python',
    cwd: '/p',
  });
  const requests = makeDep({
    name: 'requests',
    declared: '2.31.0',
    scope: 'prod',
    ecosystem: 'python',
    manifestPath: '/p/requirements.txt',
  });

  it('installs with pip, pairing it with a manifest edit', () => {
    expect(
      provider.installCommand(toolchain('pip'), 'requests', '2.31.0', 'prod'),
    ).toEqual({
      argv: [pythonBin, '-m', 'pip', 'install', 'requests==2.31.0'],
      cwd: '/p',
      description: 'Install requests==2.31.0 with pip',
      writesManifest: false,
    });
  });

  it.each([
    ['uv', ['uv', 'add', 'requests==2.31.0'], 'Add requests==2.31.0 with uv'],
    [
      'poetry',
      ['poetry', 'add', 'requests==2.31.0'],
      'Add requests==2.31.0 with Poetry',
    ],
  ] as const)(
    'installs with %s, which writes the manifest itself',
    (id, argv, description) => {
      expect(
        provider.installCommand(toolchain(id), 'requests', '2.31.0', 'prod'),
      ).toEqual({ argv, cwd: '/p', description });
    },
  );

  it('uninstalls with pip, pairing it with a manifest edit', () => {
    expect(provider.uninstallCommand(toolchain('pip'), requests)).toEqual({
      argv: [pythonBin, '-m', 'pip', 'uninstall', '-y', 'requests'],
      cwd: '/p',
      description: 'Uninstall requests with pip',
      writesManifest: false,
    });
  });

  it.each([
    ['uv', ['uv', 'remove', 'requests'], 'Remove requests with uv'],
    ['poetry', ['poetry', 'remove', 'requests'], 'Remove requests with Poetry'],
  ] as const)('uninstalls with %s', (id, argv, description) => {
    expect(provider.uninstallCommand(toolchain(id), requests)).toEqual({
      argv,
      cwd: '/p',
      description,
    });
  });
});

describe('GradleProvider and MavenProvider commands', () => {
  const gradle = new GradleProvider();
  const maven = new MavenProvider();

  it('leaves Gradle installs to a build-file edit', () => {
    expect(gradle.installCommand()).toBeNull();
  });

  it('has no Gradle bulk command, so the host updates each package instead', () => {
    // Gradle has no command that updates declared versions.
    expect(
      gradle.updateAllCommand({ id: 'gradle', ecosystem: 'gradle', cwd: '/p' }),
    ).toBeNull();
  });

  it('leaves Maven installs to a POM edit', () => {
    expect(maven.installCommand()).toBeNull();
  });

  it('bulk-updates Maven to the latest releases, and says so', () => {
    expect(
      maven.updateAllCommand({ id: 'maven', ecosystem: 'maven', cwd: '/p' }),
    ).toEqual({
      argv: ['mvn', 'versions:use-latest-releases'],
      cwd: '/p',
      description: 'Rewrite dependency versions to the latest releases',
      reach: 'latest',
    });
  });
});
