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

  it('generates installCommand for prod, dev, and build scopes', () => {
    expect(
      provider.installCommand(toolchain, 'serde', '1.0.0', 'prod'),
    ).toEqual({
      argv: ['cargo', 'add', 'serde@1.0.0'],
      cwd: '/p',
      description: 'Add serde@1.0.0',
    });
    expect(provider.installCommand(toolchain, 'tokio', null, 'dev')).toEqual({
      argv: ['cargo', 'add', 'tokio', '--dev'],
      cwd: '/p',
      description: 'Add tokio',
    });
    expect(provider.installCommand(toolchain, 'cc', '1.0', 'build')).toEqual({
      argv: ['cargo', 'add', 'cc@1.0', '--build'],
      cwd: '/p',
      description: 'Add cc@1.0',
    });
    expect(
      provider.installCommand(toolchain, 'invalid name!', '1.0', 'prod'),
    ).toBeNull();
  });

  it('generates updateCommand, uninstallCommand, and updateAllCommand', () => {
    const dep = makeDep({
      name: 'serde',
      declared: '1.0.0',
      scope: 'prod',
      ecosystem: 'cargo',
      manifestPath: '/p/Cargo.toml',
    });
    expect(provider.updateCommand(toolchain, dep, '1.0.1')).toEqual({
      argv: ['cargo', 'add', 'serde@1.0.1'],
      cwd: '/p',
      description: 'Add serde@1.0.1',
    });
    expect(provider.uninstallCommand(toolchain, dep)).toEqual({
      argv: ['cargo', 'remove', 'serde'],
      cwd: '/p',
      description: 'Remove serde',
    });
    expect(
      provider.uninstallCommand(toolchain, { ...dep, name: 'bad name!' }),
    ).toBeNull();
    expect(provider.updateAllCommand(toolchain)).toEqual({
      argv: ['cargo', 'update'],
      cwd: '/p',
      description: 'Update all dependencies within their declared ranges',
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

  it('generates installCommand for prod and dev scopes', () => {
    expect(
      provider.installCommand(toolchain, 'guzzlehttp/guzzle', '^7.0', 'prod'),
    ).toEqual({
      argv: ['composer', 'require', 'guzzlehttp/guzzle:^7.0'],
      cwd: '/p',
      description: 'Require guzzlehttp/guzzle:^7.0',
    });
    expect(
      provider.installCommand(toolchain, 'phpunit/phpunit', '^9.0', 'dev'),
    ).toEqual({
      argv: ['composer', 'require', '--dev', 'phpunit/phpunit:^9.0'],
      cwd: '/p',
      description: 'Require phpunit/phpunit:^9.0',
    });
    expect(
      provider.installCommand(
        toolchain,
        'invalid package name',
        '^1.0',
        'prod',
      ),
    ).toBeNull();
  });

  it('generates updateCommand, uninstallCommand, and updateAllCommand', () => {
    const dep = makeDep({
      name: 'guzzlehttp/guzzle',
      declared: '^7.0',
      scope: 'prod',
      ecosystem: 'composer',
      manifestPath: '/p/composer.json',
    });
    const devDep: Dependency = { ...dep, scope: 'dev' };

    expect(provider.updateCommand(toolchain, dep, '^7.5')).toEqual({
      argv: ['composer', 'require', 'guzzlehttp/guzzle:^7.5'],
      cwd: '/p',
      description: 'Require guzzlehttp/guzzle:^7.5',
    });
    expect(provider.updateCommand(toolchain, devDep, '^7.5')).toEqual({
      argv: ['composer', 'require', '--dev', 'guzzlehttp/guzzle:^7.5'],
      cwd: '/p',
      description: 'Require guzzlehttp/guzzle:^7.5',
    });
    expect(provider.uninstallCommand(toolchain, dep)).toEqual({
      argv: ['composer', 'remove', 'guzzlehttp/guzzle'],
      cwd: '/p',
      description: 'Remove guzzlehttp/guzzle',
    });
    expect(provider.uninstallCommand(toolchain, devDep)).toEqual({
      argv: ['composer', 'remove', '--dev', 'guzzlehttp/guzzle'],
      cwd: '/p',
      description: 'Remove guzzlehttp/guzzle',
    });
    expect(
      provider.uninstallCommand(toolchain, { ...dep, name: 'bad name' }),
    ).toBeNull();
    expect(provider.updateAllCommand(toolchain)).toEqual({
      argv: ['composer', 'update'],
      cwd: '/p',
      description: 'Update all packages within their declared constraints',
    });
  });
});

describe('GoProvider commands', () => {
  const provider = new GoProvider();
  const toolchain: Toolchain = { id: 'go', ecosystem: 'golang', cwd: '/p' };

  it('generates installCommand, updateCommand, uninstallCommand, and updateAllCommand', () => {
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

    const dep = makeDep({
      name: 'github.com/gin-gonic/gin',
      declared: 'v1.9.0',
      scope: 'prod',
      ecosystem: 'golang',
      manifestPath: '/p/go.mod',
    });
    expect(provider.updateCommand(toolchain, dep, 'v1.9.1')).toEqual({
      argv: ['go', 'get', 'github.com/gin-gonic/gin@v1.9.1'],
      cwd: '/p',
      description: 'Get github.com/gin-gonic/gin@v1.9.1',
    });
    expect(provider.uninstallCommand(toolchain, dep)).toEqual({
      argv: ['go', 'get', 'github.com/gin-gonic/gin@none'],
      cwd: '/p',
      description: 'Remove github.com/gin-gonic/gin',
    });
    expect(provider.updateAllCommand(toolchain)).toEqual({
      argv: ['go', 'get', '-u', './...'],
      cwd: '/p',
      description: 'Update all modules to their latest minor/patch releases',
    });
  });
});

describe('NodeProvider commands', () => {
  const provider = new NodeProvider();

  it('generates installCommand for npm, yarn, pnpm, bun', () => {
    const npm: Toolchain = { id: 'npm', ecosystem: 'node', cwd: '/p' };
    const pnpm: Toolchain = { id: 'pnpm', ecosystem: 'node', cwd: '/p' };
    const yarn: Toolchain = { id: 'yarn', ecosystem: 'node', cwd: '/p' };
    const bun: Toolchain = { id: 'bun', ecosystem: 'node', cwd: '/p' };

    expect(provider.installCommand(npm, 'react', '^18.0.0', 'prod')).toEqual({
      argv: ['npm', 'install', 'react@^18.0.0'],
      cwd: '/p',
      description: 'Install react@^18.0.0',
    });
    expect(provider.installCommand(npm, 'vitest', '^2.0.0', 'dev')).toEqual({
      argv: ['npm', 'install', 'vitest@^2.0.0', '--save-dev'],
      cwd: '/p',
      description: 'Install vitest@^2.0.0 as a dev dependency',
    });
    expect(provider.installCommand(pnpm, 'react', '^18.0.0', 'prod')).toEqual({
      argv: ['pnpm', 'add', 'react@^18.0.0'],
      cwd: '/p',
      description: 'Install react@^18.0.0',
    });
    expect(provider.installCommand(pnpm, 'vitest', '^2.0.0', 'dev')).toEqual({
      argv: ['pnpm', 'add', 'vitest@^2.0.0', '--save-dev'],
      cwd: '/p',
      description: 'Install vitest@^2.0.0 as a dev dependency',
    });
    expect(provider.installCommand(yarn, 'react', '^18.0.0', 'prod')).toEqual({
      argv: ['yarn', 'add', 'react@^18.0.0'],
      cwd: '/p',
      description: 'Install react@^18.0.0',
    });
    expect(provider.installCommand(yarn, 'vitest', '^2.0.0', 'dev')).toEqual({
      argv: ['yarn', 'add', 'vitest@^2.0.0', '--dev'],
      cwd: '/p',
      description: 'Install vitest@^2.0.0 as a dev dependency',
    });
    expect(provider.installCommand(bun, 'react', '^18.0.0', 'prod')).toEqual({
      argv: ['bun', 'add', 'react@^18.0.0'],
      cwd: '/p',
      description: 'Install react@^18.0.0',
    });
    expect(provider.installCommand(bun, 'vitest', '^2.0.0', 'dev')).toEqual({
      argv: ['bun', 'add', 'vitest@^2.0.0', '--dev'],
      cwd: '/p',
      description: 'Install vitest@^2.0.0 as a dev dependency',
    });
  });

  it('preserves the declared range prefix when updating', () => {
    const npm: Toolchain = { id: 'npm', ecosystem: 'node', cwd: '/p' };
    const pnpm: Toolchain = { id: 'pnpm', ecosystem: 'node', cwd: '/p' };

    const caretDep = makeDep({
      name: 'react',
      declared: '^18.2.0',
      scope: 'prod',
      ecosystem: 'node',
      manifestPath: '/p/package.json',
    });
    expect(provider.updateCommand(npm, caretDep, '18.3.1')).toEqual({
      argv: ['npm', 'install', 'react@^18.3.1'],
      cwd: '/p',
      description: 'Install react@^18.3.1',
    });

    const tildeDep = makeDep({
      name: 'lodash',
      declared: '~4.17.0',
      scope: 'prod',
      ecosystem: 'node',
      manifestPath: '/p/package.json',
    });
    expect(provider.updateCommand(npm, tildeDep, '4.17.21')).toEqual({
      argv: ['npm', 'install', 'lodash@~4.17.21'],
      cwd: '/p',
      description: 'Install lodash@~4.17.21',
    });

    // An exact pin was a deliberate choice; updating must not silently
    // widen it into a range.
    const pinnedDep = makeDep({
      name: 'proj4',
      declared: '2.19.5',
      scope: 'prod',
      ecosystem: 'node',
      manifestPath: '/p/package.json',
    });
    expect(provider.updateCommand(pnpm, pinnedDep, '2.21.0')).toEqual({
      argv: ['pnpm', 'add', 'proj4@2.21.0'],
      cwd: '/p',
      description: 'Install proj4@2.21.0',
    });

    const compoundDep = makeDep({
      name: 'left-pad',
      declared: '>=1.0.0 <2',
      scope: 'prod',
      ecosystem: 'node',
      manifestPath: '/p/package.json',
    });
    expect(provider.updateCommand(npm, compoundDep, '1.3.0')).toEqual({
      argv: ['npm', 'install', 'left-pad@1.3.0'],
      cwd: '/p',
      description: 'Install left-pad@1.3.0',
    });
  });

  it('generates uninstallCommand for npm, yarn, pnpm, bun', () => {
    const npm: Toolchain = { id: 'npm', ecosystem: 'node', cwd: '/p' };
    const pnpm: Toolchain = { id: 'pnpm', ecosystem: 'node', cwd: '/p' };
    const yarn: Toolchain = { id: 'yarn', ecosystem: 'node', cwd: '/p' };
    const bun: Toolchain = { id: 'bun', ecosystem: 'node', cwd: '/p' };

    const dep = makeDep({
      name: 'react',
      declared: '^18.0.0',
      scope: 'prod',
      ecosystem: 'node',
      manifestPath: '/p/package.json',
    });

    expect(provider.uninstallCommand(npm, dep)).toEqual({
      argv: ['npm', 'uninstall', 'react'],
      cwd: '/p',
      description: 'Uninstall react',
    });
    expect(provider.uninstallCommand(pnpm, dep)).toEqual({
      argv: ['pnpm', 'remove', 'react'],
      cwd: '/p',
      description: 'Uninstall react',
    });
    expect(provider.uninstallCommand(yarn, dep)).toEqual({
      argv: ['yarn', 'remove', 'react'],
      cwd: '/p',
      description: 'Uninstall react',
    });
    expect(provider.uninstallCommand(bun, dep)).toEqual({
      argv: ['bun', 'remove', 'react'],
      cwd: '/p',
      description: 'Uninstall react',
    });
  });
});

describe('PythonProvider commands', () => {
  const provider = new PythonProvider();
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';

  it('generates installCommand for pip, uv, poetry', () => {
    const pip: Toolchain = { id: 'pip', ecosystem: 'python', cwd: '/p' };
    const uv: Toolchain = { id: 'uv', ecosystem: 'python', cwd: '/p' };
    const poetry: Toolchain = { id: 'poetry', ecosystem: 'python', cwd: '/p' };

    expect(provider.installCommand(pip, 'requests', '2.31.0', 'prod')).toEqual({
      argv: [pythonBin, '-m', 'pip', 'install', 'requests==2.31.0'],
      cwd: '/p',
      description: 'Install requests==2.31.0 with pip',
      writesManifest: false,
    });
    expect(provider.installCommand(uv, 'requests', '2.31.0', 'prod')).toEqual({
      argv: ['uv', 'add', 'requests==2.31.0'],
      cwd: '/p',
      description: 'Add requests==2.31.0 with uv',
    });
    expect(
      provider.installCommand(poetry, 'requests', '2.31.0', 'prod'),
    ).toEqual({
      argv: ['poetry', 'add', 'requests==2.31.0'],
      cwd: '/p',
      description: 'Add requests==2.31.0 with Poetry',
    });
  });

  it('generates uninstallCommand for pip, uv, poetry', () => {
    const pip: Toolchain = { id: 'pip', ecosystem: 'python', cwd: '/p' };
    const uv: Toolchain = { id: 'uv', ecosystem: 'python', cwd: '/p' };
    const poetry: Toolchain = { id: 'poetry', ecosystem: 'python', cwd: '/p' };

    const dep = makeDep({
      name: 'requests',
      declared: '2.31.0',
      scope: 'prod',
      ecosystem: 'python',
      manifestPath: '/p/requirements.txt',
    });

    expect(provider.uninstallCommand(pip, dep)).toEqual({
      argv: [pythonBin, '-m', 'pip', 'uninstall', '-y', 'requests'],
      cwd: '/p',
      description: 'Uninstall requests with pip',
      writesManifest: false,
    });
    expect(provider.uninstallCommand(uv, dep)).toEqual({
      argv: ['uv', 'remove', 'requests'],
      cwd: '/p',
      description: 'Remove requests with uv',
    });
    expect(provider.uninstallCommand(poetry, dep)).toEqual({
      argv: ['poetry', 'remove', 'requests'],
      cwd: '/p',
      description: 'Remove requests with Poetry',
    });
  });
});

describe('GradleProvider and MavenProvider commands', () => {
  const gradle = new GradleProvider();
  const maven = new MavenProvider();
  const toolchainG: Toolchain = {
    id: 'gradle',
    ecosystem: 'gradle',
    cwd: '/p',
  };
  const toolchainM: Toolchain = { id: 'maven', ecosystem: 'maven', cwd: '/p' };

  it('returns commands or null for Gradle and Maven', () => {
    expect(gradle.installCommand()).toBeNull();
    expect(gradle.updateAllCommand(toolchainG)).toEqual({
      argv: ['gradle', 'dependencies', '--write-locks'],
      cwd: '/p',
      description: 'Refresh Gradle dependency locks',
    });
    expect(maven.installCommand()).toBeNull();
    expect(maven.updateAllCommand(toolchainM)).toEqual({
      argv: ['mvn', 'versions:use-latest-releases'],
      cwd: '/p',
      description: 'Rewrite dependency versions to the latest releases',
    });
  });
});
