/**
 * Version comparison is the highest-risk correctness surface in Orizzonte: get
 * an ordering wrong and the UI confidently shows the wrong "latest". These
 * tests pin the rules that differ between ecosystems.
 */

import { describe, expect, it } from 'vitest';
import {
  compareComposer,
  composerConstraintToSemver,
} from '../../src/core/versions/composer.js';
import {
  applyDeclaredPrefix,
  classifyUpdate,
  compareVersions,
  constraintToApproxVersion,
  isPrerelease,
  maxSatisfying,
  maxVersion,
} from '../../src/core/versions/index.js';
import { compareMaven, maxMaven } from '../../src/core/versions/maven.js';
import {
  comparePep440,
  parsePep440,
  satisfiesPep440,
} from '../../src/core/versions/pep440.js';

const asc = (a: string, b: string, cmp: (x: string, y: string) => number) =>
  cmp(a, b) < 0 ? 'lt' : cmp(a, b) > 0 ? 'gt' : 'eq';

describe('PEP 440', () => {
  it('orders release segments numerically, not lexically', () => {
    expect(asc('1.9.0', '1.10.0', comparePep440)).toBe('lt');
    expect(asc('2.0.0', '10.0.0', comparePep440)).toBe('lt');
  });

  it('treats zero-padded releases as equal', () => {
    expect(comparePep440('1.0', '1.0.0')).toBe(0);
    expect(comparePep440('1.0.0.0', '1.0')).toBe(0);
  });

  it('sorts pre-releases below the final release', () => {
    expect(asc('1.0.0a1', '1.0.0', comparePep440)).toBe('lt');
    expect(asc('1.0.0b2', '1.0.0rc1', comparePep440)).toBe('lt');
    expect(asc('1.0.0alpha1', '1.0.0beta1', comparePep440)).toBe('lt');
  });

  it('sorts post-releases above the release they follow', () => {
    // This is the rule that differs most sharply from semver.
    expect(asc('1.0.0', '1.0.0.post1', comparePep440)).toBe('lt');
    expect(asc('1.0.0.post1', '1.0.1', comparePep440)).toBe('lt');
  });

  it('sorts dev releases below everything at the same version', () => {
    expect(asc('1.0.0.dev1', '1.0.0a1', comparePep440)).toBe('lt');
    expect(asc('1.0.0.dev1', '1.0.0', comparePep440)).toBe('lt');
  });

  it('honours epochs above all else', () => {
    expect(asc('1!1.0', '2.0', comparePep440)).toBe('gt');
  });

  it('parses the full grammar', () => {
    const parsed = parsePep440('1!2.3.4rc2.post3.dev4+local.1');
    expect(parsed).toMatchObject({
      epoch: 1,
      release: [2, 3, 4],
      preType: 'rc',
      preNumber: 2,
      postNumber: 3,
      devNumber: 4,
      local: 'local.1',
    });
  });

  it('evaluates specifier sets', () => {
    expect(satisfiesPep440('2.5.0', '>=2.0,<3.0')).toBe(true);
    expect(satisfiesPep440('3.0.0', '>=2.0,<3.0')).toBe(false);
    expect(satisfiesPep440('1.4.5', '~=1.4.2')).toBe(true);
    expect(satisfiesPep440('1.5.0', '~=1.4.2')).toBe(false);
    expect(satisfiesPep440('1.4.9', '==1.4.*')).toBe(true);
    expect(satisfiesPep440('1.5.0', '!=1.4.*')).toBe(true);
  });
});

describe('Maven ordering', () => {
  it('sorts SNAPSHOT below the matching release', () => {
    expect(asc('1.0-SNAPSHOT', '1.0', compareMaven)).toBe('lt');
  });

  it('applies the known qualifier order', () => {
    expect(asc('1.0-alpha', '1.0-beta', compareMaven)).toBe('lt');
    expect(asc('1.0-beta', '1.0-milestone', compareMaven)).toBe('lt');
    expect(asc('1.0-milestone', '1.0-rc', compareMaven)).toBe('lt');
    expect(asc('1.0-rc', '1.0', compareMaven)).toBe('lt');
    expect(asc('1.0', '1.0-sp', compareMaven)).toBe('lt');
  });

  it('treats trailing null items as equal', () => {
    expect(compareMaven('1.0', '1.0.0')).toBe(0);
    expect(compareMaven('1.0', '1.0-ga')).toBe(0);
    expect(compareMaven('1', '1.0.0')).toBe(0);
  });

  it('splits on digit/letter transitions', () => {
    expect(asc('1.0alpha1', '1.0beta1', compareMaven)).toBe('lt');
  });

  it('compares numbers numerically', () => {
    expect(asc('1.9', '1.10', compareMaven)).toBe('lt');
  });

  it('prefers stable releases when picking a max', () => {
    expect(maxMaven(['1.0', '2.0-SNAPSHOT', '1.5'])).toBe('1.5');
    // ...but falls back to prereleases when nothing stable exists.
    expect(maxMaven(['2.0-SNAPSHOT', '1.0-rc1'])).toBe('2.0-SNAPSHOT');
  });
});

describe('Composer ordering', () => {
  it('ignores a leading v', () => {
    expect(compareComposer('v1.2.3', '1.2.3')).toBe(0);
  });

  it('handles four-segment versions', () => {
    expect(asc('1.2.3.4', '1.2.3.5', compareComposer)).toBe('lt');
  });

  it('cannot represent a nonzero fourth segment in a semver range', () => {
    // node-semver has no fourth segment; silently dropping a nonzero one
    // would make 1.2.3.4 and 1.2.3.5 compare equal as a "wanted" constraint.
    expect(composerConstraintToSemver('1.2.3.4')).toBeNull();
    // A trailing zero build carries no information, so it's safe to drop.
    expect(composerConstraintToSemver('1.2.3.0')).toBe('1.2.3');
  });

  it('orders stability suffixes', () => {
    expect(asc('1.0.0-dev', '1.0.0-alpha', compareComposer)).toBe('lt');
    expect(asc('1.0.0-beta', '1.0.0-RC', compareComposer)).toBe('lt');
    expect(asc('1.0.0-RC', '1.0.0', compareComposer)).toBe('lt');
  });
});

describe('applyDeclaredPrefix', () => {
  it('carries caret and tilde operators onto the new version', () => {
    expect(applyDeclaredPrefix('^18.2.0', '18.3.1')).toBe('^18.3.1');
    expect(applyDeclaredPrefix('~1.2.3', '1.4.0')).toBe('~1.4.0');
  });

  it('keeps exact pins exact', () => {
    expect(applyDeclaredPrefix('2.19.5', '2.21.0')).toBe('2.21.0');
  });

  it('leaves compound ranges, tags and protocols untouched', () => {
    expect(applyDeclaredPrefix('>=1.2.0 <2', '1.9.0')).toBe('1.9.0');
    expect(applyDeclaredPrefix('*', '2.0.0')).toBe('2.0.0');
    expect(applyDeclaredPrefix('latest', '2.0.0')).toBe('2.0.0');
    expect(applyDeclaredPrefix('workspace:^', '1.1.0')).toBe('1.1.0');
  });

  it('does not mangle a target that is already a range or tag', () => {
    expect(applyDeclaredPrefix('^1.2.3', '^1.4.0')).toBe('^1.4.0');
    expect(applyDeclaredPrefix('^1.2.3', 'latest')).toBe('latest');
  });
});

describe('constraintToApproxVersion', () => {
  it('strips range operators down to the bare version', () => {
    expect(constraintToApproxVersion('^1.2.3')).toBe('1.2.3');
    expect(constraintToApproxVersion('~>4.5.0')).toBe('4.5.0');
    expect(constraintToApproxVersion('>=1.0.0 <2.0.0')).toBe('1.0.0');
  });

  it('skips a PEP 440 epoch rather than returning it as the version', () => {
    // A "first run of digits" match would stop at "1", not the version that
    // follows the epoch marker — wrong enough to throw off OSV audit matching.
    expect(constraintToApproxVersion('1!2.0.0')).toBe('2.0.0');
    expect(constraintToApproxVersion('>=1!2.0.0')).toBe('2.0.0');
  });

  it('returns undefined for a constraint with no version in it', () => {
    expect(constraintToApproxVersion('latest')).toBeUndefined();
    expect(constraintToApproxVersion('workspace:^')).toBeUndefined();
  });
});

describe('cross-ecosystem facade', () => {
  it('routes each ecosystem to its own scheme', () => {
    // Only PEP 440 ranks a post-release above the plain release.
    expect(compareVersions('python', '1.0.0.post1', '1.0.0')).toBeGreaterThan(
      0,
    );
    expect(compareVersions('maven', '1.0-SNAPSHOT', '1.0')).toBeLessThan(0);
    expect(compareVersions('node', '1.0.0-beta', '1.0.0')).toBeLessThan(0);
  });

  it('detects prereleases per ecosystem', () => {
    expect(isPrerelease('node', '1.0.0-rc.1')).toBe(true);
    expect(isPrerelease('python', '1.0.0a1')).toBe(true);
    expect(isPrerelease('maven', '1.0-SNAPSHOT')).toBe(true);
    expect(isPrerelease('cargo', '1.0.0')).toBe(false);
  });

  it('excludes prereleases from maxVersion when stable versions exist', () => {
    expect(maxVersion('node', ['1.0.0', '2.0.0-beta.1'])).toBe('1.0.0');
    expect(maxVersion('python', ['1.0.0', '2.0.0a1'])).toBe('1.0.0');
  });

  it('resolves the wanted version from a semver range', () => {
    const versions = ['1.0.0', '1.2.0', '1.9.3', '2.0.0'];
    expect(maxSatisfying('node', versions, '^1.0.0')).toBe('1.9.3');
    expect(maxSatisfying('node', versions, '~1.2.0')).toBe('1.2.0');
    expect(maxSatisfying('node', versions, '*')).toBe('2.0.0');
  });

  it('resolves the wanted version from a PEP 440 specifier', () => {
    const versions = ['1.0.0', '1.2.0', '2.0.0'];
    expect(maxSatisfying('python', versions, '>=1.0,<2.0')).toBe('1.2.0');
  });

  it('returns undefined for constraints it cannot evaluate', () => {
    // Git and branch constraints have no orderable meaning.
    expect(maxSatisfying('node', ['1.0.0'], 'github:foo/bar')).toBeUndefined();
    expect(maxSatisfying('composer', ['1.0.0'], 'dev-main')).toBeUndefined();
    // A four-segment pin with a nonzero build number: node-semver cannot
    // distinguish it from any other build of the same 1.2.3 release, so a
    // dash is the honest answer rather than a guessed build.
    expect(
      maxSatisfying('composer', ['1.2.3.4', '1.2.3.5'], '1.2.3.4'),
    ).toBeUndefined();
  });

  it('classifies the size of an update', () => {
    expect(classifyUpdate('node', '1.0.0', '2.0.0')).toBe('major');
    expect(classifyUpdate('node', '1.0.0', '1.1.0')).toBe('minor');
    expect(classifyUpdate('node', '1.0.0', '1.0.1')).toBe('patch');
    expect(classifyUpdate('node', '1.0.0', '1.0.0')).toBe('none');
    // Already ahead of the registry (a local build) is not an update.
    expect(classifyUpdate('node', '2.0.0', '1.0.0')).toBe('none');
    expect(classifyUpdate('node', undefined, '1.0.0')).toBe('unknown');
  });

  it('treats pre-1.0 minor bumps as breaking', () => {
    // `^0.5` allows 0.5.x but not 0.6, so 0.5 -> 0.8 is as breaking as a major.
    // Calling it "minor" would tell the user it is safe when it is not.
    expect(classifyUpdate('cargo', '0.5.1', '0.8.2')).toBe('major');
    expect(classifyUpdate('node', '0.1.0', '0.2.0')).toBe('major');
    // Within the same minor, a patch is still just a patch.
    expect(classifyUpdate('cargo', '0.5.1', '0.5.9')).toBe('patch');
    // `^0.0.3` allows nothing else, so every bump there is breaking.
    expect(classifyUpdate('node', '0.0.3', '0.0.4')).toBe('major');
    // Crossing into 1.0 is a major by the ordinary rule.
    expect(classifyUpdate('node', '0.9.0', '1.0.0')).toBe('major');
  });
});
