/**
 * Grouping packages by license and checking that against an allow/deny list.
 */

import { describe, expect, it } from 'vitest';
import {
  buildLicenseSummary,
  isLicenseFlagged,
  type LicensePolicy,
} from '../../src/core/licensePolicy.js';

const NO_POLICY: LicensePolicy = { allow: [], deny: [] };

describe('isLicenseFlagged', () => {
  it('flags nothing when no policy is configured', () => {
    expect(isLicenseFlagged('GPL-3.0', NO_POLICY)).toBe(false);
    expect(isLicenseFlagged(undefined, NO_POLICY)).toBe(false);
  });

  it('flags anything not on a non-empty allow list, including unknown', () => {
    const policy: LicensePolicy = { allow: ['MIT', 'Apache-2.0'], deny: [] };
    expect(isLicenseFlagged('MIT', policy)).toBe(false);
    expect(isLicenseFlagged('GPL-3.0', policy)).toBe(true);
    expect(isLicenseFlagged(undefined, policy)).toBe(true);
  });

  it('flags only what is on a deny list, leaving unknown alone', () => {
    const policy: LicensePolicy = { allow: [], deny: ['GPL-3.0'] };
    expect(isLicenseFlagged('GPL-3.0', policy)).toBe(true);
    expect(isLicenseFlagged('MIT', policy)).toBe(false);
    // Nothing to blame a package for being unclassifiable.
    expect(isLicenseFlagged(undefined, policy)).toBe(false);
  });

  it('matches case-insensitively', () => {
    const policy: LicensePolicy = { allow: [], deny: ['gpl-3.0'] };
    expect(isLicenseFlagged('GPL-3.0', policy)).toBe(true);
  });

  it('lets allow take precedence when both lists are set', () => {
    const policy: LicensePolicy = { allow: ['MIT'], deny: ['MIT'] };
    expect(isLicenseFlagged('MIT', policy)).toBe(false);
  });
});

describe('buildLicenseSummary', () => {
  it('groups packages by license', () => {
    const summary = buildLicenseSummary(
      [
        { name: 'b-pkg', license: 'MIT' },
        { name: 'a-pkg', license: 'MIT' },
        { name: 'c-pkg', license: 'ISC' },
      ],
      NO_POLICY,
    );
    const mit = summary.groups.find((group) => group.license === 'MIT');
    expect(mit?.packageNames).toEqual(['a-pkg', 'b-pkg']);
    expect(
      summary.groups.find((group) => group.license === 'ISC'),
    ).toBeTruthy();
  });

  it('groups packages with no license under undefined', () => {
    const summary = buildLicenseSummary(
      [{ name: 'a', license: undefined }],
      NO_POLICY,
    );
    expect(summary.groups).toEqual([
      { license: undefined, packageNames: ['a'], flagged: false },
    ]);
  });

  it('sorts flagged licenses first, then alphabetically, with unknown last', () => {
    const policy: LicensePolicy = { allow: [], deny: ['GPL-3.0'] };
    const summary = buildLicenseSummary(
      [
        { name: 'z', license: undefined },
        { name: 'b', license: 'MIT' },
        { name: 'a', license: 'Apache-2.0' },
        { name: 'g', license: 'GPL-3.0' },
      ],
      policy,
    );
    expect(summary.groups.map((group) => group.license)).toEqual([
      'GPL-3.0',
      'Apache-2.0',
      'MIT',
      undefined,
    ]);
    expect(summary.groups[0].flagged).toBe(true);
  });
});
