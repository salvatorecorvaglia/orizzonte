import { describe, expect, it } from 'vitest';
import { explainDependency } from '../../src/core/depGraph.js';
import { cargoLockfile } from '../../src/core/lockfiles/cargo.js';
import { buildResolutionGraph } from '../../src/core/lockfiles/graph.js';
import { pnpmLockfile } from '../../src/core/lockfiles/pnpm.js';
import type { Dependency, DepNode, Ecosystem } from '../../src/core/types.js';
import { makeContext } from './helpers.js';

const target = (ecosystem: Ecosystem): Dependency => ({
  key: 'x',
  name: 'shared',
  ecosystem,
  scope: 'prod',
  declared: '*',
  installed: '1.0.0',
  updateKind: 'none',
  vulnerabilities: [],
  manifestPath:
    ecosystem === 'cargo'
      ? '/p/Cargo.toml'
      : ecosystem === 'python'
        ? '/p/pyproject.toml'
        : ecosystem === 'composer'
          ? '/p/composer.json'
          : '/p/package.json',
  projectLabel: 'p',
});
function nodes(roots: DepNode[]): DepNode[] {
  return roots.flatMap((node) => [node, ...nodes(node.children)]);
}
const fixtures = [
  {
    ecosystem: 'node',
    file: 'package-lock.json',
    text: JSON.stringify({
      packages: {
        '': { dependencies: { a: '*', b: '*' } },
        'node_modules/a': {
          version: '1.0.0',
          dependencies: { shared: '1.0.0' },
        },
        'node_modules/b': {
          version: '1.0.0',
          dependencies: { shared: '2.0.0' },
        },
        'node_modules/shared': { version: '1.0.0' },
        'node_modules/b/node_modules/shared': { version: '2.0.0' },
      },
    }),
  },
  {
    ecosystem: 'node',
    file: 'pnpm-lock.yaml',
    text: `snapshots:
  a@1.0.0:
    dependencies:
      shared: 1.0.0
  b@1.0.0:
    dependencies:
      shared: 2.0.0
  shared@1.0.0: {}
  shared@2.0.0: {}
`,
  },
  {
    ecosystem: 'node',
    file: 'yarn.lock',
    text: `a@*:
  version "1.0.0"
  dependencies:
    shared "^1"

b@*:
  version "1.0.0"
  dependencies:
    shared "^2"

shared@^1:
  version "1.0.0"

shared@^2:
  version "2.0.0"
`,
  },
  {
    ecosystem: 'cargo',
    file: 'Cargo.lock',
    text: `[[package]]
name="a"
version="1.0.0"
dependencies=["shared 1.0.0"]
[[package]]
name="b"
version="1.0.0"
dependencies=["shared 2.0.0"]
[[package]]
name="shared"
version="1.0.0"
[[package]]
name="shared"
version="2.0.0"
`,
  },
  {
    ecosystem: 'python',
    file: 'uv.lock',
    text: `[[package]]
name="a"
version="1.0.0"
dependencies=[{name="shared",version="1.0.0"}]
[[package]]
name="b"
version="1.0.0"
dependencies=[{name="shared",version="2.0.0"}]
[[package]]
name="shared"
version="1.0.0"
[[package]]
name="shared"
version="2.0.0"
`,
  },
  {
    ecosystem: 'python',
    file: 'poetry.lock',
    text: `[[package]]
name="a"
version="1.0.0"
[package.dependencies]
shared="<2"
[[package]]
name="b"
version="1.0.0"
[package.dependencies]
shared=">=2"
[[package]]
name="shared"
version="1.0.0"
[[package]]
name="shared"
version="2.0.0"
`,
  },
  {
    ecosystem: 'composer',
    file: 'composer.lock',
    text: JSON.stringify({
      packages: [
        { name: 'a', version: '1.0.0', require: { shared: '^1' } },
        { name: 'b', version: '1.0.0', require: { shared: '^2' } },
        { name: 'shared', version: 'v1.0.0' },
        { name: 'shared', version: '2.0.0' },
      ],
    }),
  },
] as const;

describe('version-aware reverse graphs', () => {
  it.each(fixtures)(
    'keeps the selected version separate in $file',
    async ({ ecosystem, file, text }) => {
      const result = await explainDependency(
        target(ecosystem),
        makeContext({ [`/p/${file}`]: text }, '/p'),
      );
      expect(result.source).toBe('lockfile');
      expect(nodes(result.roots).map((n) => n.name)).toEqual(['a', 'shared']);
      expect(nodes(result.roots).every((n) => n.id)).toBe(true);
      expect(nodes(result.roots).at(-1)?.version?.replace(/^v/, '')).toBe(
        '1.0.0',
      );
    },
  );
  it('uses importer reachability to exclude other workspace members', async () => {
    const lock = {
      packages: {
        'packages/first': { dependencies: { a: '*' } },
        'packages/second': { dependencies: { b: '*' } },
        'node_modules/a': { version: '1', dependencies: { shared: '*' } },
        'node_modules/b': { version: '1', dependencies: { shared: '*' } },
        'node_modules/shared': { version: '1.0.0' },
      },
    };
    const result = await explainDependency(
      { ...target('node'), manifestPath: '/p/packages/first/package.json' },
      makeContext({ '/p/package-lock.json': JSON.stringify(lock) }, '/p'),
    );
    expect(nodes(result.roots).map((n) => n.name)).toEqual(['a', 'shared']);
  });
  it('preserves pnpm peer contexts with the same name and version', () => {
    const graph = pnpmLockfile.edges(
      'snapshots:\n  shared@1.0.0(peer@1): {}\n  shared@1.0.0(peer@2): {}\n',
    )!;
    expect([...graph.values()].filter((n) => n.name === 'shared')).toHaveLength(
      2,
    );
    expect(new Set([...graph.values()].map((n) => n.id)).size).toBe(2);
  });
  it('keeps ambiguous Cargo references partial instead of joining both versions', () => {
    const graph = cargoLockfile.edges(
      '[[package]]\nname="a"\nversion="1"\ndependencies=["shared"]\n[[package]]\nname="shared"\nversion="1"\n[[package]]\nname="shared"\nversion="2"\n',
    )!;
    const parent = [...graph.values()].find((n) => n.name === 'a')!;
    expect(graph.get(parent.children[0])).toMatchObject({
      name: 'shared',
      truncated: true,
    });
    expect(graph.get(parent.children[0])?.version).toBeUndefined();
  });
  it('does not collapse duplicate identities with different conditional dependency lists', () => {
    const graph = buildResolutionGraph(
      [
        {
          id: 'same',
          name: 'pkg',
          version: '1',
          dependencies: [{ name: 'left' }],
        },
        {
          id: 'same',
          name: 'pkg',
          version: '1',
          dependencies: [{ name: 'right' }],
        },
      ],
      'python',
    );
    const copies = [...graph.values()].filter((n) => n.name === 'pkg');
    expect(copies).toHaveLength(2);
    expect(copies.map((n) => n.children.length)).toEqual([1, 1]);
  });
  it('does not mix Cargo packages from different sources at the same version', () => {
    const graph = cargoLockfile.edges(
      '[[package]]\nname="parent"\nversion="1"\ndependencies=["shared 1.0.0 (registry+https://one.example)"]\n[[package]]\nname="shared"\nversion="1.0.0"\nsource="registry+https://one.example"\n[[package]]\nname="shared"\nversion="1.0.0"\nsource="registry+https://two.example"\n',
    )!;
    const parent = [...graph.values()].find((node) => node.name === 'parent')!;
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toContain('one.example');
    expect(parent.children[0]).not.toContain('two.example');
  });
  it('handles scoped v5 pnpm keys with legacy peer suffixes', () => {
    const graph = pnpmLockfile.edges(
      'packages:\n  /@scope/parent/1.0.0_peer@2.0.0:\n    dependencies:\n      shared: 1.0.0\n  /shared/1.0.0: {}\n',
    )!;
    const parent = [...graph.values()].find(
      (node) => node.name === '@scope/parent',
    )!;
    expect(parent.version).toBe('1.0.0');
    expect(graph.get(parent.children[0])).toMatchObject({
      name: 'shared',
      version: '1.0.0',
    });
  });
  it('resolves Yarn aliases to the real package identity', async () => {
    const result = await explainDependency(
      target('node'),
      makeContext(
        {
          '/p/yarn.lock':
            'parent@*:\n  version "1.0.0"\n  dependencies:\n    alias "npm:shared@^1"\n\nalias@npm:shared@^1:\n  version "1.0.0"\n',
        },
        '/p',
      ),
    );
    expect(nodes(result.roots).map((node) => node.name)).toEqual([
      'parent',
      'shared',
    ]);
  });
  it('falls back without throwing on structurally invalid lockfile entries', async () => {
    const result = await explainDependency(
      target('node'),
      makeContext(
        { '/p/package-lock.json': '{"packages":{"node_modules/shared":null}}' },
        '/p',
      ),
    );
    expect(result.roots).toEqual([]);
  });
});
