import { describe, expect, it } from 'vitest';
import type { Toolchain } from '../../src/core/types.js';
import { PythonProvider } from '../../src/providers/python/index.js';
import { makeContext } from './helpers.js';

const provider = new PythonProvider();
const uv: Toolchain = { id: 'uv', ecosystem: 'python', cwd: '/p' };
const requirement = 'requests[socks]>=2; python_version < "3.12"';
async function parse(text: string, file = 'pyproject.toml') {
  return provider.parse(`/p/${file}`, text, makeContext({}, '/p'));
}

describe('Python requirement semantics', () => {
  it.each([
    `[project]\ndependencies=['${requirement}']`,
    `[project.optional-dependencies]\nnetwork=['${requirement}']`,
    `[dependency-groups]\nnetwork=['${requirement}']`,
  ])('retains extras and markers in every PEP 508 group', async (text) => {
    const {
      dependencies: [dep],
    } = await parse(text);
    expect(dep.pythonRequirement).toMatchObject({
      raw: requirement,
      extras: ['socks'],
      marker: 'python_version < "3.12"',
    });
    expect(provider.updateCommand(uv, dep, '2.32.0')?.argv.at(-1)).toBe(
      'requests[socks]>=2.32.0; python_version < "3.12"',
    );
    expect(
      provider.updateCommand({ ...uv, id: 'poetry' }, dep, '2.32.0'),
    ).toBeNull();
    expect(provider.canMutateDependency(dep, 'remove')).toBe(false);
  });
  it('keeps conditional declarations distinct and refuses an ambiguous manager update', async () => {
    const parsed = await parse(
      `[project]\ndependencies=['requests>=2; python_version < "3.12"','requests>=3; python_version >= "3.12"']`,
    );
    expect(parsed.dependencies).toHaveLength(2);
    expect(new Set(parsed.dependencies.map((d) => d.key)).size).toBe(2);
    for (const dep of parsed.dependencies)
      expect(provider.canMutateDependency(dep, 'update')).toBe(false);
  });
  it('keeps simple Poetry version tables updatable', async () => {
    const {
      dependencies: [dep],
    } = await parse('[tool.poetry.dependencies]\nrequests={version="^2.0"}');
    expect(
      provider.updateCommand({ ...uv, id: 'poetry' }, dep, '3.0')?.argv,
    ).toEqual(['poetry', 'add', 'requests@^3.0']);
  });
  it('refuses complex Poetry table mutations rather than dropping their fields', async () => {
    const {
      dependencies: [dep],
    } = await parse(
      '[tool.poetry.dependencies]\nrequests={version="^2",markers="python_version < \'3.12\'",extras=["socks"]}',
    );
    expect(provider.canMutateDependency(dep, 'update')).toBe(false);
    expect(provider.canMutateDependency(dep, 'remove')).toBe(false);
  });
  it('carries pip extras and marker through the command and paired file edit', async () => {
    const {
      dependencies: [dep],
    } = await parse(requirement, 'requirements.txt');
    expect(
      provider.updateCommand({ ...uv, id: 'pip' }, dep, '2.32.0')?.argv.at(-1),
    ).toBe('requests[socks]>=2.32.0; python_version < "3.12"');
    expect(
      provider.editManifest(
        `${requirement}\n`,
        { kind: 'update', name: dep.name, version: '2.32.0', scope: dep.scope },
        'requirements.txt',
      ),
    ).toBe('requests[socks]>=2.32.0; python_version < "3.12"\n');
  });
  it('keeps same-name declarations in different groups independently updatable', async () => {
    const parsed = await parse(
      '[dependency-groups]\ntest=["requests>=2"]\nlint=["requests>=2"]',
    );
    expect(parsed.dependencies).toHaveLength(2);
    expect(
      provider.updateCommand(uv, parsed.dependencies[0], '3')?.argv,
    ).toEqual(['uv', 'add', '--group', 'test', 'requests>=3']);
  });
});
