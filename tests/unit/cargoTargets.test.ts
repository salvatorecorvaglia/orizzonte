import { describe, expect, it } from 'vitest';
import { CargoProvider } from '../../src/providers/cargo/index.js';
import { makeContext } from './helpers.js';

const provider = new CargoProvider();
const toolchain = { id: 'cargo', ecosystem: 'cargo', cwd: '/p' } as const;
const text = `[package]
name = "app"
version = "1.0.0"
[dependencies]
serde = "1"
[target.'cfg(windows)'.dependencies]
serde = {version = "2", features = ["derive"]}
[target.'cfg(unix)'.dev-dependencies]
serde = "3"
[target.wasm32-unknown-unknown.build-dependencies]
renamed = {package = "serde", version = "4"}
`;

describe('Cargo target-specific dependencies', () => {
  it('keeps scope, target and aliases distinct from unconditional declarations', async () => {
    const { dependencies } = await provider.parse(
      '/p/Cargo.toml',
      text,
      makeContext(),
    );
    expect(dependencies).toHaveLength(4);
    expect(new Set(dependencies.map((dep) => dep.key)).size).toBe(4);
    expect(
      dependencies.map((dep) => [dep.name, dep.scope, dep.cargoTarget]),
    ).toEqual([
      ['serde', 'prod', undefined],
      ['serde', 'prod', 'cfg(windows)'],
      ['serde', 'dev', 'cfg(unix)'],
      ['renamed', 'build', 'wasm32-unknown-unknown'],
    ]);
    expect(dependencies[3].registryName).toBe('serde');
  });
  it('updates and removes only the selected target and scope', async () => {
    const { dependencies } = await provider.parse(
      '/p/Cargo.toml',
      text,
      makeContext(),
    );
    expect(
      provider.updateCommand(toolchain, dependencies[1], '2.1')?.argv,
    ).toEqual(['cargo', 'add', 'serde@2.1', '--target', 'cfg(windows)']);
    expect(provider.uninstallCommand(toolchain, dependencies[2])?.argv).toEqual(
      ['cargo', 'remove', 'serde', '--dev', '--target', 'cfg(unix)'],
    );
    expect(
      provider.updateCommand(toolchain, dependencies[3], '4.1')?.argv,
    ).toEqual([
      'cargo',
      'add',
      'serde@4.1',
      '--build',
      '--rename',
      'renamed',
      '--target',
      'wasm32-unknown-unknown',
    ]);
  });
  it('retains different lockfile evidence for same-name conditional declarations', async () => {
    const ctx = makeContext(
      {
        '/p/Cargo.lock':
          '[[package]]\nname="serde"\nversion="1.5.0"\n\n[[package]]\nname="serde"\nversion="2.5.0"\n',
      },
      '/p',
    );
    const { dependencies } = await provider.parse('/p/Cargo.toml', text, ctx);
    await provider.readLockfile('/p', ctx, dependencies);
    expect(dependencies[0].installed).toBe('1.5.0');
    expect(dependencies[1].installed).toBe('2.5.0');
  });
  it('refuses flag-like target values and inherited updates', async () => {
    const { dependencies } = await provider.parse(
      '/p/Cargo.toml',
      "[target.'cfg(windows)'.dependencies]\nserde={workspace=true}",
      makeContext(),
    );
    expect(dependencies[0].source).toBe('inherited');
    expect(provider.updateCommand(toolchain, dependencies[0], '2')).toBeNull();
    expect(
      provider.uninstallCommand(toolchain, {
        ...dependencies[0],
        cargoTarget: '--config=evil',
      }),
    ).toBeNull();
  });
  it('retains local and git target declarations without treating them as registry packages', async () => {
    const { dependencies } = await provider.parse(
      '/p/Cargo.toml',
      `[target.'cfg(unix)'.dependencies]\nlocal={path="../local"}\nremote={git="https://private.example/repo"}\n`,
      makeContext(),
    );
    expect(
      dependencies.map((dep) => [dep.name, dep.source, dep.cargoTarget]),
    ).toEqual([
      ['local', 'path', 'cfg(unix)'],
      ['remote', 'git', 'cfg(unix)'],
    ]);
    for (const dep of dependencies)
      expect(provider.updateCommand(toolchain, dep, '2')).toBeNull();
  });
});
