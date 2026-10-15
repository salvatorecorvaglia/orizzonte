/**
 * Edits and commands that used to act on the wrong table, the wrong file or
 * the wrong package.
 *
 * Each case here once produced a command that failed, or a manifest that was
 * quietly wrong afterwards: a Cargo dev-dependency that could not be removed,
 * a Poetry `test` package re-added under `dev`, a pyproject.toml with a
 * requirements line appended to it, a Maven property overwritten by a literal.
 */

import { describe, expect, it } from 'vitest';
import type { Toolchain } from '../../src/core/types.js';
import { CargoProvider } from '../../src/providers/cargo/index.js';
import { MavenProvider } from '../../src/providers/maven/index.js';
import { PythonProvider } from '../../src/providers/python/index.js';
import { findDep, makeContext } from './helpers.js';

describe('Cargo', () => {
  const cargo = new CargoProvider();
  const toolchain: Toolchain = { id: 'cargo', ecosystem: 'cargo', cwd: '/p' };
  const manifest = `
[package]
name = "app"

[dependencies]
serde = "1.0"
json = { package = "serde_json", version = "1.0" }
tokio = { workspace = true }

[dev-dependencies]
proptest = "1"

[build-dependencies]
cc = "1"
`;

  it('names the table when removing a dev- or build-dependency', async () => {
    const parsed = await cargo.parse('/p/Cargo.toml', manifest, makeContext());

    expect(
      cargo.uninstallCommand(
        toolchain,
        findDep(parsed.dependencies, 'proptest'),
      )?.argv,
    ).toEqual(['cargo', 'remove', 'proptest', '--dev']);
    expect(
      cargo.uninstallCommand(toolchain, findDep(parsed.dependencies, 'cc'))
        ?.argv,
    ).toEqual(['cargo', 'remove', 'cc', '--build']);
    expect(
      cargo.uninstallCommand(toolchain, findDep(parsed.dependencies, 'serde'))
        ?.argv,
    ).toEqual(['cargo', 'remove', 'serde']);
  });

  it('looks a renamed crate up by its real name and keeps the rename on update', async () => {
    const parsed = await cargo.parse('/p/Cargo.toml', manifest, makeContext());
    const json = findDep(parsed.dependencies, 'json');

    expect(json).toMatchObject({ registryName: 'serde_json', source: 'alias' });
    expect(cargo.lockfileName(json)).toBe('serde_json');
    expect(cargo.updateCommand(toolchain, json, '1.0.120')?.argv).toEqual([
      'cargo',
      'add',
      'serde_json@1.0.120',
      '--rename',
      'json',
    ]);
  });

  it('does not rewrite a workspace-inherited version from the member', async () => {
    const parsed = await cargo.parse('/p/Cargo.toml', manifest, makeContext());
    const tokio = findDep(parsed.dependencies, 'tokio');

    expect(tokio.source).toBe('inherited');
    expect(cargo.updateCommand(toolchain, tokio, '1.40.0')).toBeNull();
  });
});

describe('Python groups and extras', () => {
  const python = new PythonProvider();
  const uv: Toolchain = { id: 'uv', ecosystem: 'python', cwd: '/p' };
  const poetry: Toolchain = { id: 'poetry', ecosystem: 'python', cwd: '/p' };

  const pep621 = `
[project]
name = "app"
dependencies = ["requests>=2"]

[project.optional-dependencies]
docs = ["sphinx>=7"]

[dependency-groups]
dev = ["pytest>=8"]
lint = ["ruff>=0.5"]
`;

  const poetryManifest = `
[tool.poetry]
name = "app"

[tool.poetry.dependencies]
python = "^3.11"
httpx = "^0.27"

[tool.poetry.group.test.dependencies]
pytest = "^8"
`;

  it('removes a package from the group or extra that declares it', async () => {
    const parsed = await python.parse(
      '/p/pyproject.toml',
      pep621,
      makeContext(),
    );

    expect(
      python.uninstallCommand(uv, findDep(parsed.dependencies, 'ruff'))?.argv,
    ).toEqual(['uv', 'remove', '--group', 'lint', 'ruff']);
    expect(
      python.uninstallCommand(uv, findDep(parsed.dependencies, 'pytest'))?.argv,
    ).toEqual(['uv', 'remove', '--dev', 'pytest']);
    expect(
      python.uninstallCommand(uv, findDep(parsed.dependencies, 'sphinx'))?.argv,
    ).toEqual(['uv', 'remove', '--optional', 'docs', 'sphinx']);
    expect(
      python.uninstallCommand(uv, findDep(parsed.dependencies, 'requests'))
        ?.argv,
    ).toEqual(['uv', 'remove', 'requests']);
  });

  it('updates a Poetry package in its own group rather than adding it to dev', async () => {
    const parsed = await python.parse(
      '/p/pyproject.toml',
      poetryManifest,
      makeContext(),
    );

    expect(
      python.updateCommand(
        poetry,
        findDep(parsed.dependencies, 'pytest'),
        '8.3.0',
      )?.argv,
    ).toEqual(['poetry', 'add', '--group', 'test', 'pytest@^8.3.0']);
    expect(
      python.uninstallCommand(poetry, findDep(parsed.dependencies, 'pytest'))
        ?.argv,
    ).toEqual(['poetry', 'remove', '--group', 'test', 'pytest']);
  });

  it('leaves a Poetry extra to the user rather than guess its flag', async () => {
    const parsed = await python.parse(
      '/p/pyproject.toml',
      pep621,
      makeContext(),
    );

    expect(
      python.uninstallCommand(poetry, findDep(parsed.dependencies, 'sphinx')),
    ).toBeNull();
  });
});

describe('requirements.txt edits', () => {
  const python = new PythonProvider();

  it('refuses to edit pyproject.toml as if it were a requirements file', () => {
    const pyproject = '[project]\nname = "app"\ndependencies = []\n';

    expect(
      python.editManifest(
        pyproject,
        { kind: 'add', name: 'requests', version: '2.32.3', scope: 'prod' },
        'pyproject.toml',
      ),
    ).toBeNull();
  });

  it('keeps extras and environment markers on update', () => {
    const original =
      'requests[security,socks]>=2.0 ; python_version < "3.11"  # net\nflask\n';

    const updated = python.editManifest(
      original,
      { kind: 'update', name: 'requests', version: '2.32.3', scope: 'prod' },
      'requirements.txt',
    );

    expect(updated).toBe(
      'requests[security,socks]>=2.32.3 ; python_version < "3.11"  # net\nflask\n',
    );
  });

  it('keeps CRLF line endings', () => {
    const updated = python.editManifest(
      'flask==2.0\r\nrequests==2.0\r\n',
      { kind: 'update', name: 'requests', version: '2.32.3', scope: 'prod' },
      'requirements.txt',
    );

    expect(updated).toBe('flask==2.0\r\nrequests==2.32.3\r\n');
  });

  it('reads a hash-pinned requirement without its continuation', async () => {
    const text =
      'requests==2.31.0 \\\n    --hash=sha256:aaa \\\n    --hash=sha256:bbb\nflask==3.0.0\n';

    const parsed = await python.parse(
      '/p/requirements.txt',
      text,
      makeContext(),
    );

    expect(parsed.dependencies.map((dep) => [dep.name, dep.declared])).toEqual([
      ['requests', '==2.31.0'],
      ['flask', '==3.0.0'],
    ]);
  });

  it('will not update a hash-pinned requirement, whose hashes it cannot compute', () => {
    const text = 'requests==2.31.0 \\\n    --hash=sha256:aaa\nflask==3.0.0\n';

    expect(
      python.editManifest(
        text,
        { kind: 'update', name: 'requests', version: '2.32.3', scope: 'prod' },
        'requirements.txt',
      ),
    ).toBeNull();
  });

  it('removes a hash-pinned requirement together with its hash lines', () => {
    const text =
      'requests==2.31.0 \\\n    --hash=sha256:aaa \\\n    --hash=sha256:bbb\nflask==3.0.0\n';

    expect(
      python.editManifest(
        text,
        { kind: 'remove', name: 'requests', scope: 'prod' },
        'requirements.txt',
      ),
    ).toBe('flask==3.0.0\n');
  });

  it('removes every marker-specific line of a package, but will not guess which to update', () => {
    const text =
      'numpy==1.24 ; python_version < "3.9"\nnumpy==2.0 ; python_version >= "3.9"\nflask\n';

    expect(
      python.editManifest(
        text,
        { kind: 'remove', name: 'numpy', scope: 'prod' },
        'requirements.txt',
      ),
    ).toBe('flask\n');
    expect(
      python.editManifest(
        text,
        { kind: 'update', name: 'numpy', version: '2.1', scope: 'prod' },
        'requirements.txt',
      ),
    ).toBeNull();
  });
});

describe('Maven POM edits', () => {
  const maven = new MavenProvider();

  const pom = `<project>
  <properties>
    <jackson.version>2.17.0</jackson.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>\${jackson.version}</version>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.9</version>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <dependencies>
          <dependency>
            <groupId>org.junit.platform</groupId>
            <artifactId>junit-platform-launcher</artifactId>
            <version>1.10.0</version>
          </dependency>
        </dependencies>
      </plugin>
    </plugins>
  </build>
</project>
`;

  it('will not overwrite a property-driven version with a literal', () => {
    expect(
      maven.editManifest(pom, {
        kind: 'update',
        name: 'com.fasterxml.jackson.core:jackson-databind',
        version: '2.18.0',
        scope: 'prod',
      }),
    ).toBeNull();
  });

  it("adds to the project's dependencies, not a plugin's", () => {
    const updated = maven.editManifest(pom, {
      kind: 'add',
      name: 'com.google.guava:guava',
      version: '33.0.0-jre',
      scope: 'prod',
    });

    expect(updated).not.toBeNull();
    const added = updated!.indexOf('<artifactId>guava</artifactId>');
    expect(added).toBeGreaterThan(updated!.indexOf('slf4j-api'));
    expect(added).toBeLessThan(updated!.indexOf('<build>'));
  });

  it("does not treat a plugin's dependency as the project's own", () => {
    expect(
      maven.editManifest(pom, {
        kind: 'remove',
        name: 'org.junit.platform:junit-platform-launcher',
        scope: 'prod',
      }),
    ).toBeNull();
  });

  it('does not report an unresolved property as the installed version', async () => {
    const parsed = await maven.parse(
      '/p/pom.xml',
      `<project><dependencies><dependency>
        <groupId>org.springframework</groupId>
        <artifactId>spring-core</artifactId>
        <version>\${spring.version}</version>
      </dependency></dependencies></project>`,
      makeContext(),
    );

    const spring = findDep(
      parsed.dependencies,
      'org.springframework:spring-core',
    );
    expect(spring.declared).toBe(`\${spring.version}`);
    expect(spring.installed).toBeUndefined();
  });
});
