import { describe, expect, it } from 'vitest';
import { chooseVersions } from '../../src/core/lockfiles/installed.js';
import { MavenProvider } from '../../src/providers/maven/index.js';
import { makeContext } from './helpers.js';

describe('review regressions', () => {
  it('does not claim an incompatible lockfile version is installed', () => {
    expect(
      chooseVersions(
        { all: new Map([['foo', ['1.0.0', '2.0.0']]]) },
        '',
        [{ name: 'foo', declared: '^3.0.0' }],
        'node',
      ).has('foo'),
    ).toBe(false);
  });
  it('does not treat Maven ranges as resolved versions', async () => {
    const parsed = await new MavenProvider().parse(
      '/p/pom.xml',
      '<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>[1,2)</version></dependency></dependencies></project>',
      makeContext(),
    );
    expect(parsed.dependencies[0].installed).toBeUndefined();
  });
});
