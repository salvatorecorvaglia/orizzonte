/**
 * Reverse dependency resolution ("why is this installed?").
 *
 * Each lockfile format gets a sample in its real on-disk shape, because the
 * whole feature rests on parsing them correctly — a silently empty graph looks
 * identical to "no answer available".
 */

import { describe, expect, it } from 'vitest';
import {
  collectVersionsFrom,
  diffLockfileVersions,
  explainDependency,
  findDuplicateVersions,
} from '../../src/core/depGraph.js';
import type { Dependency, DepNode } from '../../src/core/types.js';
import { makeContext } from './helpers.js';

function dep(overrides: Partial<Dependency> = {}): Dependency {
  return {
    key: 'k',
    name: 'ansi-styles',
    ecosystem: 'node',
    scope: 'prod',
    declared: '*',
    installed: '4.3.0',
    updateKind: 'unknown',
    vulnerabilities: [],
    manifestPath: '/p/package.json',
    projectLabel: 'p',
    ...overrides,
  };
}

/** Collects every name appearing anywhere in the returned tree. */
function flatten(
  nodes: Array<{ name: string; children: unknown[] }>,
): string[] {
  const out: string[] = [];
  const walk = (list: Array<{ name: string; children: unknown[] }>) => {
    for (const node of list) {
      out.push(node.name);
      walk(node.children as Array<{ name: string; children: unknown[] }>);
    }
  };
  walk(nodes);
  return out;
}

describe('npm package-lock.json', () => {
  it('traces a transitive package back to its direct dependent', async () => {
    const ctx = makeContext({
      '/p/package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { chalk: '^4.0.0' } },
          'node_modules/chalk': {
            version: '4.1.2',
            dependencies: { 'ansi-styles': '^4.1.0' },
          },
          'node_modules/ansi-styles': { version: '4.3.0' },
        },
      }),
    });

    const result = await explainDependency(dep(), ctx);
    expect(result.source).toBe('lockfile');
    // chalk is why ansi-styles is present.
    expect(flatten(result.roots)).toEqual(['chalk', 'ansi-styles']);
  });
});

describe('pnpm-lock.yaml', () => {
  it('parses the v9 snapshots layout', async () => {
    const ctx = makeContext({
      '/p/pnpm-lock.yaml': `lockfileVersion: '9.0'

snapshots:

  chalk@4.1.2:
    dependencies:
      ansi-styles: 4.3.0
      supports-color: 7.2.0

  ansi-styles@4.3.0:
    dependencies:
      color-convert: 2.0.1

  color-convert@2.0.1: {}
`,
    });

    const result = await explainDependency(dep(), ctx);
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['chalk', 'ansi-styles']);
  });

  it('strips scopes and peer suffixes from package keys', async () => {
    const ctx = makeContext({
      '/p/pnpm-lock.yaml': `lockfileVersion: '9.0'

snapshots:

  '@babel/core@7.24.0(supports-color@8.1.1)':
    dependencies:
      '@babel/traverse': 7.24.0

  '@babel/traverse@7.24.0': {}
`,
    });

    const result = await explainDependency(
      dep({ name: '@babel/traverse' }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    // The scope must survive and the (peer) suffix must not.
    expect(flatten(result.roots)).toEqual(['@babel/core', '@babel/traverse']);
  });

  it('does not mistake a workspace member path in importers: for a package', async () => {
    // `importers:` shares the same 2-space-indent, colon-terminated shape as
    // `packages:`/`snapshots:` — a line-oriented parser had no way to tell a
    // workspace path like `packages/ui:` apart from a real package entry.
    const ctx = makeContext({
      '/p/pnpm-lock.yaml': `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      chalk:
        specifier: ^4.1.2
        version: 4.1.2

  packages/ui:
    dependencies:
      chalk:
        specifier: ^4.1.2
        version: 4.1.2

snapshots:

  chalk@4.1.2:
    dependencies:
      ansi-styles: 4.3.0

  ansi-styles@4.3.0: {}
`,
    });

    const result = await explainDependency(dep({ name: 'ansi-styles' }), ctx);
    expect(result.source).toBe('lockfile');
    // Only the real dependency edge, not a phantom "packages/ui" root.
    expect(flatten(result.roots)).toEqual(['chalk', 'ansi-styles']);
  });
});

describe('yarn.lock', () => {
  it('parses v1 blocks', async () => {
    const ctx = makeContext({
      '/p/yarn.lock': `# yarn lockfile v1


chalk@^4.0.0:
  version "4.1.2"
  resolved "https://registry.yarnpkg.com/chalk/-/chalk-4.1.2.tgz"
  dependencies:
    ansi-styles "^4.1.0"
    supports-color "^7.1.0"

ansi-styles@^4.1.0:
  version "4.3.0"
  resolved "https://registry.yarnpkg.com/ansi-styles/-/ansi-styles-4.3.0.tgz"
  dependencies:
    color-convert "^2.0.1"
`,
    });

    const result = await explainDependency(dep(), ctx);
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['chalk', 'ansi-styles']);
  });

  /*
   * Yarn 2+ ("Berry") writes a YAML-ish lockfile: the version is `version: x`
   * with a colon, where v1 wrote `version "x"` with whitespace and quotes. The
   * two lines are different formats sharing one filename, so every parser that
   * reads this file has to handle both — see the duplicate-version test below,
   * which is where that stopped being true.
   */
  it('parses berry (v2+) blocks', async () => {
    const ctx = makeContext({
      '/p/yarn.lock': `# This file is generated by running "yarn install"

__metadata:
  version: 8
  cacheKey: 10

"chalk@npm:^4.0.0":
  version: 4.1.2
  resolution: "chalk@npm:4.1.2"
  dependencies:
    ansi-styles: "npm:^4.1.0"
    supports-color: "npm:^7.1.0"

"ansi-styles@npm:^4.1.0":
  version: 4.3.0
  resolution: "ansi-styles@npm:4.3.0"
  dependencies:
    color-convert: "npm:^2.0.1"
`,
    });

    const result = await explainDependency(dep(), ctx);
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['chalk', 'ansi-styles']);
  });
});

describe('Cargo.lock', () => {
  it('traces through the package array', async () => {
    const ctx = makeContext({
      '/p/Cargo.lock': `version = 3

[[package]]
name = "tokio"
version = "1.35.1"
dependencies = [
 "mio",
 "bytes",
]

[[package]]
name = "mio"
version = "0.8.10"
dependencies = [
 "libc",
]
`,
    });

    const result = await explainDependency(
      dep({ name: 'libc', ecosystem: 'cargo', manifestPath: '/p/Cargo.toml' }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['tokio', 'mio', 'libc']);
  });
});

describe('poetry.lock', () => {
  it('reads [package.dependencies] tables', async () => {
    const ctx = makeContext({
      '/p/poetry.lock': `[[package]]
name = "requests"
version = "2.31.0"

[package.dependencies]
urllib3 = ">=1.21.1,<3"
certifi = ">=2017.4.17"

[[package]]
name = "urllib3"
version = "2.2.1"
`,
    });

    const result = await explainDependency(
      dep({
        name: 'urllib3',
        ecosystem: 'python',
        manifestPath: '/p/pyproject.toml',
      }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['requests', 'urllib3']);
  });
});

describe('uv.lock', () => {
  it('reads the dependencies array of tables', async () => {
    const ctx = makeContext({
      '/p/uv.lock': `version = 1

[[package]]
name = "requests"
version = "2.31.0"
dependencies = [
    { name = "urllib3" },
    { name = "certifi" },
]

[[package]]
name = "urllib3"
version = "2.2.1"
`,
    });

    const result = await explainDependency(
      dep({
        name: 'urllib3',
        ecosystem: 'python',
        manifestPath: '/p/pyproject.toml',
      }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['requests', 'urllib3']);
  });

  it('normalises names per PEP 503 so underscores still match', async () => {
    const ctx = makeContext({
      '/p/uv.lock': `version = 1

[[package]]
name = "flask"
version = "3.0.0"
dependencies = [
    { name = "Jinja2" },
]

[[package]]
name = "jinja2"
version = "3.1.2"
`,
    });

    const result = await explainDependency(
      dep({
        name: 'Jinja2',
        ecosystem: 'python',
        manifestPath: '/p/pyproject.toml',
      }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['flask', 'jinja2']);
  });
});

describe('composer.lock', () => {
  it('drops platform requirements from the graph', async () => {
    const ctx = makeContext({
      '/p/composer.lock': JSON.stringify({
        packages: [
          {
            name: 'laravel/framework',
            require: { php: '^8.2', 'psr/log': '^3.0' },
          },
          { name: 'psr/log', require: { php: '^8.0' } },
        ],
      }),
    });

    const result = await explainDependency(
      dep({
        name: 'psr/log',
        ecosystem: 'composer',
        manifestPath: '/p/composer.json',
      }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['laravel/framework', 'psr/log']);
  });
});

describe('cycle and depth safety', () => {
  it('terminates on a dependency cycle', async () => {
    const ctx = makeContext({
      '/p/Cargo.lock': `[[package]]
name = "a"
version = "1.0.0"
dependencies = [
 "b",
]

[[package]]
name = "b"
version = "1.0.0"
dependencies = [
 "a",
]
`,
    });

    const result = await explainDependency(
      dep({ name: 'a', ecosystem: 'cargo', manifestPath: '/p/Cargo.toml' }),
      ctx,
    );
    // The assertion that matters is that this returns at all.
    expect(result.roots.length).toBeGreaterThan(0);
  });
});

/*
 * The registry fallback (deps.dev) is the path every Go, Maven and Gradle
 * project takes, because none of them has a lockfile describing edges. Those
 * graphs are dense diamonds — many packages depending on the same few — which
 * is the shape that makes an unbudgeted path walk explode.
 */
describe('deps.dev registry fallback', () => {
  /**
   * A layered graph where every node in one layer depends on every node in the
   * next. Distinct root-to-leaf *paths* grow as `width ** depth`, while the
   * node count stays at `width * depth` — so a walk that enumerates paths and
   * a walk that visits nodes differ by orders of magnitude on the same input.
   */
  function denseDiamond(width: number, depth: number) {
    type Node = {
      versionKey: { system: string; name: string; version: string };
      relation: 'SELF' | 'DIRECT' | 'INDIRECT';
    };
    const nodes: Node[] = [
      {
        versionKey: { system: 'MAVEN', name: 'root', version: '1.0.0' },
        relation: 'SELF',
      },
    ];
    const layers: number[][] = [[0]];

    for (let layer = 1; layer <= depth; layer++) {
      const indices: number[] = [];
      for (let i = 0; i < width; i++) {
        indices.push(nodes.length);
        nodes.push({
          versionKey: {
            system: 'MAVEN',
            name: `pkg-${layer}-${i}`,
            version: '1.0.0',
          },
          relation: 'INDIRECT',
        });
      }
      layers.push(indices);
    }

    const edges: Array<{ fromNode: number; toNode: number }> = [];
    for (let layer = 0; layer < depth; layer++) {
      for (const from of layers[layer]) {
        for (const to of layers[layer + 1]) {
          edges.push({ fromNode: from, toNode: to });
        }
      }
    }

    return { nodes, edges };
  }

  function contextReturning(response: unknown) {
    const ctx = makeContext({});
    return {
      ...ctx,
      http: {
        ...ctx.http,
        getJson: () => Promise.resolve(response),
      } as unknown as typeof ctx.http,
    };
  }

  /** Counts every node the expansion actually materialised. */
  function countNodes(nodes: DepNode[]): number {
    return nodes.reduce(
      (total, node) => total + 1 + countNodes(node.children),
      0,
    );
  }

  it('stays bounded on a dense graph instead of enumerating every path', async () => {
    // 4 wide by 8 deep: 33 nodes, but 4 ** 8 = 65_536 distinct paths. Walking
    // paths materialises ~87k tree nodes and then asks `postMessage` to
    // serialise them, on the same single thread that draws the editor.
    const ctx = contextReturning(denseDiamond(4, 8));

    const result = await explainDependency(
      dep({ name: 'org.example:root', ecosystem: 'maven' }),
      ctx,
    );

    expect(result.source).toBe('registry');
    expect(result.roots).toHaveLength(1);
    // Comfortably above what this graph needs (33 nodes plus repeat markers)
    // and far below what enumerating paths produces.
    expect(countNodes(result.roots)).toBeLessThan(500);
  });

  it('marks a package it has already expanded rather than repeating its subtree', async () => {
    /*
     * `shared` is reached from both `a` and `b`. It is expanded once; the
     * second reference names it and stops, which is both what keeps the walk
     * linear and what stops the drawer showing one subtree twice.
     */
    const ctx = contextReturning({
      nodes: [
        {
          versionKey: { system: 'MAVEN', name: 'root', version: '1.0.0' },
          relation: 'SELF',
        },
        {
          versionKey: { system: 'MAVEN', name: 'a', version: '1.0.0' },
          relation: 'DIRECT',
        },
        {
          versionKey: { system: 'MAVEN', name: 'b', version: '1.0.0' },
          relation: 'DIRECT',
        },
        {
          versionKey: { system: 'MAVEN', name: 'shared', version: '1.0.0' },
          relation: 'INDIRECT',
        },
        {
          versionKey: { system: 'MAVEN', name: 'leaf', version: '1.0.0' },
          relation: 'INDIRECT',
        },
      ],
      edges: [
        { fromNode: 0, toNode: 1 },
        { fromNode: 0, toNode: 2 },
        { fromNode: 1, toNode: 3 },
        { fromNode: 2, toNode: 3 },
        { fromNode: 3, toNode: 4 },
      ],
    });

    const result = await explainDependency(
      dep({ name: 'org.example:root', ecosystem: 'maven' }),
      ctx,
    );

    const [a, b] = result.roots[0].children;
    // Whichever is expanded first carries the real subtree...
    expect(a.children.map((child) => child.name)).toEqual(['shared']);
    expect(a.children[0].children.map((child) => child.name)).toEqual(['leaf']);
    // ...and the second reference is a named, truncated leaf, not a repeat.
    expect(b.children.map((child) => child.name)).toEqual(['shared']);
    expect(b.children[0].children).toEqual([]);
    expect(b.children[0].truncated).toBe(true);
  });
});

describe('graceful degradation', () => {
  it('reports no answer rather than throwing when no lockfile exists', async () => {
    const result = await explainDependency(dep(), makeContext({}));
    // The registry path is unreachable in tests, so this must fall back cleanly.
    expect(result.source).toBe('registry');
    expect(result.roots).toEqual([]);
  });
});

describe('findDuplicateVersions', () => {
  it('flags a package resolved at two versions in an npm lockfile', async () => {
    const ctx = makeContext({
      '/p/package-lock.json': JSON.stringify({
        packages: {
          '': { dependencies: { a: '^1.0.0', b: '^1.0.0' } },
          'node_modules/a': {
            version: '1.0.0',
            dependencies: { 'ansi-styles': '^3.0.0' },
          },
          'node_modules/a/node_modules/ansi-styles': { version: '3.2.1' },
          'node_modules/ansi-styles': { version: '4.3.0' },
          'node_modules/b': { version: '1.0.0' },
        },
      }),
    });

    const result = await findDuplicateVersions('/p/package.json', 'node', ctx);
    expect(result.checked).toBe(true);
    expect(result.groups).toEqual([
      { name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] },
    ]);
  });

  it('finds nothing to report when every package resolves once', async () => {
    const ctx = makeContext({
      '/p/package-lock.json': JSON.stringify({
        packages: {
          '': { dependencies: { chalk: '^4.0.0' } },
          'node_modules/chalk': { version: '4.1.2' },
        },
      }),
    });

    const result = await findDuplicateVersions('/p/package.json', 'node', ctx);
    expect(result.checked).toBe(true);
    expect(result.groups).toEqual([]);
  });

  it('flags a duplicate in the pnpm snapshots layout, from the key alone', async () => {
    const ctx = makeContext({
      '/p/pnpm-lock.yaml': `lockfileVersion: '9.0'

snapshots:

  a@1.0.0:
    dependencies:
      ansi-styles: 3.2.1

  ansi-styles@3.2.1: {}

  ansi-styles@4.3.0: {}
`,
    });

    const result = await findDuplicateVersions('/p/package.json', 'node', ctx);
    expect(result.checked).toBe(true);
    expect(result.groups).toEqual([
      { name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] },
    ]);
  });

  it('flags a duplicate across yarn.lock blocks', async () => {
    const ctx = makeContext({
      '/p/yarn.lock': `# yarn lockfile v1


ansi-styles@^3.0.0:
  version "3.2.1"
  resolved "https://registry.yarnpkg.com/ansi-styles/-/ansi-styles-3.2.1.tgz"

ansi-styles@^4.1.0:
  version "4.3.0"
  resolved "https://registry.yarnpkg.com/ansi-styles/-/ansi-styles-4.3.0.tgz"
`,
    });

    const result = await findDuplicateVersions('/p/package.json', 'node', ctx);
    expect(result.checked).toBe(true);
    expect(result.groups).toEqual([
      { name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] },
    ]);
  });

  /*
   * The same file in Berry's format. `parseYarnLockVersions` only matched v1's
   * `version "x"`, so a Berry project reported no duplicates at all — and an
   * empty result is indistinguishable from a clean one.
   */
  it('flags a duplicate across berry (v2+) yarn.lock blocks', async () => {
    const ctx = makeContext({
      '/p/yarn.lock': `__metadata:
  version: 8

"ansi-styles@npm:^3.0.0":
  version: 3.2.1
  resolution: "ansi-styles@npm:3.2.1"

"ansi-styles@npm:^4.1.0":
  version: 4.3.0
  resolution: "ansi-styles@npm:4.3.0"
`,
    });

    const result = await findDuplicateVersions('/p/package.json', 'node', ctx);
    expect(result.checked).toBe(true);
    expect(result.groups).toEqual([
      { name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] },
    ]);
  });

  it('flags a duplicate across Cargo.lock package entries', async () => {
    const ctx = makeContext({
      '/p/Cargo.lock': `[[package]]
name = "tokio"
version = "1.35.1"
dependencies = [
 "windows-sys",
]

[[package]]
name = "windows-sys"
version = "0.48.0"

[[package]]
name = "windows-sys"
version = "0.52.0"
`,
    });

    const result = await findDuplicateVersions('/p/Cargo.toml', 'cargo', ctx);
    expect(result.checked).toBe(true);
    expect(result.groups).toEqual([
      { name: 'windows-sys', versions: ['0.48.0', '0.52.0'] },
    ]);
  });

  it('flags a duplicate across composer.lock packages and packages-dev', async () => {
    const ctx = makeContext({
      '/p/composer.lock': JSON.stringify({
        packages: [{ name: 'psr/log', version: '3.0.0' }],
        'packages-dev': [{ name: 'psr/log', version: '2.0.0' }],
      }),
    });

    const result = await findDuplicateVersions(
      '/p/composer.json',
      'composer',
      ctx,
    );
    expect(result.checked).toBe(true);
    expect(result.groups).toEqual([
      { name: 'psr/log', versions: ['2.0.0', '3.0.0'] },
    ]);
  });

  it('flags a duplicate in a poetry.lock, normalising PEP 503 names', async () => {
    const ctx = makeContext({
      '/p/poetry.lock': `[[package]]
name = "flask"
version = "3.0.0"

[package.dependencies]
Jinja2 = ">=3.1"

[[package]]
name = "Jinja2"
version = "3.1.2"

[[package]]
name = "jinja2"
version = "3.0.0"
`,
    });

    const result = await findDuplicateVersions(
      '/p/pyproject.toml',
      'python',
      ctx,
    );
    expect(result.checked).toBe(true);
    expect(result.groups).toEqual([
      { name: 'jinja2', versions: ['3.0.0', '3.1.2'] },
    ]);
  });

  it('reports unchecked, not clean, when no lockfile exists', async () => {
    const result = await findDuplicateVersions(
      '/p/package.json',
      'node',
      makeContext({}),
    );
    expect(result.checked).toBe(false);
    expect(result.groups).toEqual([]);
  });

  it('reports unchecked for ecosystems with no trustworthy local lockfile', async () => {
    for (const ecosystem of ['golang', 'maven', 'gradle'] as const) {
      const result = await findDuplicateVersions(
        '/p/manifest',
        ecosystem,
        makeContext({ '/p/go.sum': 'irrelevant' }),
      );
      expect(result.checked).toBe(false);
      expect(result.groups).toEqual([]);
    }
  });
});

describe('collectVersionsFrom', () => {
  it('reads through a caller-supplied reader instead of ProviderContext', async () => {
    const files: Record<string, string> = {
      '/p/package-lock.json': JSON.stringify({
        packages: {
          '': { dependencies: { chalk: '^4.0.0' } },
          'node_modules/chalk': { version: '4.1.2' },
        },
      }),
    };
    const versions = await collectVersionsFrom(
      '/p',
      'node',
      async (absolutePath) => files[absolutePath.replace(/\\/g, '/')] ?? null,
    );
    expect(versions?.get('chalk')).toEqual(new Set(['4.1.2']));
  });

  it('returns undefined when the reader has nothing for any candidate file', async () => {
    const versions = await collectVersionsFrom(
      '/p',
      'node',
      async () => undefined,
    );
    expect(versions).toBeUndefined();
  });
});

describe('diffLockfileVersions', () => {
  it('reports unchecked when either side could not be read', () => {
    const map = new Map([['a', new Set(['1.0.0'])]]);
    expect(diffLockfileVersions(undefined, map)).toEqual({
      checked: false,
      added: [],
      removed: [],
      changed: [],
    });
    expect(diffLockfileVersions(map, undefined)).toEqual({
      checked: false,
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('reports a package present only on the "after" side as added', () => {
    const before = new Map();
    const after = new Map([['react', new Set(['18.0.0'])]]);
    const result = diffLockfileVersions(before, after);
    expect(result.checked).toBe(true);
    expect(result.added).toEqual([
      { name: 'react', before: undefined, after: ['18.0.0'] },
    ]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('reports a package present only on the "before" side as removed', () => {
    const before = new Map([['left-pad', new Set(['1.0.0'])]]);
    const after = new Map();
    const result = diffLockfileVersions(before, after);
    expect(result.removed).toEqual([
      { name: 'left-pad', before: ['1.0.0'], after: undefined },
    ]);
  });

  it('reports a version change for a package present on both sides', () => {
    const before = new Map([['react', new Set(['18.0.0'])]]);
    const after = new Map([['react', new Set(['19.0.0'])]]);
    const result = diffLockfileVersions(before, after);
    expect(result.changed).toEqual([
      { name: 'react', before: ['18.0.0'], after: ['19.0.0'] },
    ]);
  });

  it('reports nothing for a package resolved the same way on both sides', () => {
    const before = new Map([['react', new Set(['18.0.0'])]]);
    const after = new Map([['react', new Set(['18.0.0'])]]);
    const result = diffLockfileVersions(before, after);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('treats an unordered version set as equal regardless of insertion order', () => {
    const before = new Map([['a', new Set(['1.0.0', '2.0.0'])]]);
    const after = new Map([['a', new Set(['2.0.0', '1.0.0'])]]);
    expect(diffLockfileVersions(before, after).changed).toEqual([]);
  });

  it('sorts every bucket alphabetically by name', () => {
    const before = new Map();
    const after = new Map([
      ['zeta', new Set(['1.0.0'])],
      ['alpha', new Set(['1.0.0'])],
    ]);
    const result = diffLockfileVersions(before, after);
    expect(result.added.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
  });
});
