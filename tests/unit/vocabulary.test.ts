/**
 * The shared vocabulary.
 *
 * This module exists so the tree view and the panel cannot drift into
 * describing the same package two different ways, which is exactly what these
 * tests pin down.
 */

import { describe, expect, it } from 'vitest';
import type { Dependency, UpdateKind } from '../../src/core/types.js';
import {
  ALL_SCOPES,
  currentVersion,
  declaredLabel,
  hasUpdate,
  SCOPE_LABELS,
  scopeLabel,
  sortByStatus,
  statusRank,
} from '../../src/core/vocabulary.js';

function dep(overrides: Partial<Dependency> = {}): Dependency {
  return {
    key: 'k',
    name: 'pkg',
    ecosystem: 'node',
    scope: 'prod',
    declared: '^1.0.0',
    updateKind: 'none',
    vulnerabilities: [],
    manifestPath: '/p/package.json',
    projectLabel: 'app',
    ...overrides,
  };
}

const vuln = {
  id: 'GHSA-1',
  summary: 's',
  severity: 'high' as const,
  aliases: [],
  url: 'https://osv.dev/x',
};

describe('scope labels', () => {
  it('labels every scope the type allows', () => {
    // A scope with no label would render as a blank badge.
    for (const scope of ALL_SCOPES) {
      expect(SCOPE_LABELS[scope]?.short).toBeTruthy();
      expect(SCOPE_LABELS[scope]?.long).toBeTruthy();
    }
    expect(Object.keys(SCOPE_LABELS).sort()).toEqual([...ALL_SCOPES].sort());
  });
});

describe('currentVersion', () => {
  it('prefers the resolved version over the constraint', () => {
    expect(
      currentVersion(dep({ installed: '1.2.3', declared: '^1.0.0' })),
    ).toBe('1.2.3');
  });

  it('falls back to the constraint when nothing is resolved', () => {
    expect(currentVersion(dep({ declared: '^1.0.0' }))).toBe('^1.0.0');
  });
});

describe('hasUpdate', () => {
  it('counts only the three real update kinds', () => {
    const kinds: Array<[UpdateKind, boolean]> = [
      ['patch', true],
      ['minor', true],
      ['major', true],
      ['none', false],
      // A failed lookup is not evidence an update exists; counting it would
      // produce a badge that never clears.
      ['unknown', false],
    ];
    for (const [updateKind, expected] of kinds) {
      expect(hasUpdate(dep({ updateKind }))).toBe(expected);
    }
  });
});

describe('statusRank', () => {
  it('puts problems above staleness, and vulnerabilities above everything', () => {
    const ranks = [
      statusRank(dep({ vulnerabilities: [vuln] })),
      statusRank(dep({ meta: { name: 'p', deprecated: 'gone' } })),
      statusRank(dep({ updateKind: 'major' })),
      statusRank(dep({ updateKind: 'minor' })),
      statusRank(dep({ updateKind: 'patch' })),
      statusRank(dep({ updateKind: 'none' })),
    ];
    // Strictly increasing: every tier is distinguishable from the next.
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('ranks a vulnerable package above a deprecated one even when both apply', () => {
    expect(
      statusRank(
        dep({
          vulnerabilities: [vuln],
          meta: { name: 'p', deprecated: 'gone' },
        }),
      ),
    ).toBe(statusRank(dep({ vulnerabilities: [vuln] })));
  });
});

describe('sortByStatus', () => {
  it('orders by severity, then alphabetically, without mutating the input', () => {
    const input = [
      dep({ name: 'zed', updateKind: 'none' }),
      dep({ name: 'beta', vulnerabilities: [vuln] }),
      dep({ name: 'alpha', updateKind: 'major' }),
      dep({ name: 'aardvark', updateKind: 'none' }),
    ];
    const original = [...input];

    expect(sortByStatus(input).map((d) => d.name)).toEqual([
      'beta',
      'alpha',
      'aardvark',
      'zed',
    ]);
    expect(input).toEqual(original);
  });
});

/*
 * The five scope buckets are an internal simplification, and the word shown to
 * the user is not always the bucket's own name.
 */
describe('scopeLabel', () => {
  it('calls a Go indirect requirement indirect, not optional', () => {
    // Go has no optional dependencies. A `// indirect` requirement lands in
    // that bucket because it is not direct, and "optional" invites a reader to
    // remove something the build requires.
    const indirect = dep({ ecosystem: 'golang', scope: 'optional' });
    expect(scopeLabel(indirect)).toBe('indirect');
    expect(scopeLabel(indirect, 'long')).toBe('Indirect (transitive)');
  });

  it('leaves every other ecosystem on the shared vocabulary', () => {
    expect(scopeLabel(dep({ ecosystem: 'node', scope: 'optional' }))).toBe(
      'optional',
    );
    expect(scopeLabel(dep({ ecosystem: 'node', scope: 'dev' }))).toBe('dev');
    expect(scopeLabel(dep({ ecosystem: 'golang', scope: 'prod' }))).toBe(
      'prod',
    );
    expect(scopeLabel(dep({ ecosystem: 'node', scope: 'dev' }), 'long')).toBe(
      'Development',
    );
  });
});

describe('declaredLabel', () => {
  it('spells out a Cargo workspace inheritance', () => {
    expect(
      declaredLabel(dep({ ecosystem: 'cargo', declared: 'workspace' })),
    ).toBe('inherited from workspace');
  });

  it('passes a real constraint through untouched', () => {
    expect(declaredLabel(dep({ ecosystem: 'cargo', declared: '1.0' }))).toBe(
      '1.0',
    );
    expect(
      declaredLabel(dep({ ecosystem: 'node', declared: 'workspace' })),
    ).toBe('workspace');
  });
});
