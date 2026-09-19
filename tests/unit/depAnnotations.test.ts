/**
 * Inline editor feedback: what a CodeLens/diagnostic should say for a given
 * dependency, computed without touching `vscode` so these fixtures can drive
 * it directly rather than through the editor.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticSpecs,
  buildLensSpecs,
} from '../../src/core/depAnnotations.js';
import type { Dependency, Vulnerability } from '../../src/core/types.js';

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

function vuln(overrides: Partial<Vulnerability> = {}): Vulnerability {
  return {
    id: 'GHSA-1',
    summary: 'a bad thing can happen',
    severity: 'high',
    aliases: [],
    url: 'https://osv.dev/x',
    ...overrides,
  };
}

const manifestText = '{\n  "dependencies": {\n    "pkg": "^1.0.0"\n  }\n}\n';

describe('buildLensSpecs', () => {
  it('produces no lens for a current, non-vulnerable dependency', () => {
    expect(buildLensSpecs(manifestText, [dep()])).toEqual([]);
  });

  it('skips an update lens for an unknown update kind', () => {
    // A failed lookup is not evidence an update exists (mirrors `hasUpdate`).
    expect(
      buildLensSpecs(manifestText, [dep({ updateKind: 'unknown' })]),
    ).toEqual([]);
  });

  it('surfaces an available update', () => {
    const specs = buildLensSpecs(manifestText, [
      dep({ updateKind: 'minor', latest: '1.2.0' }),
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.title).toBe('↑ 1.2.0 available');
    expect(specs[0]?.offset).toBeGreaterThanOrEqual(0);
  });

  it('surfaces vulnerability count and worst severity', () => {
    const specs = buildLensSpecs(manifestText, [
      dep({
        vulnerabilities: [
          vuln({ id: 'a', severity: 'low' }),
          vuln({ id: 'b', severity: 'critical' }),
        ],
      }),
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.title).toBe('⚠ 2 vulnerabilities (critical)');
  });

  it('uses singular wording for exactly one vulnerability', () => {
    const specs = buildLensSpecs(manifestText, [
      dep({ vulnerabilities: [vuln({ severity: 'moderate' })] }),
    ]);
    expect(specs[0]?.title).toBe('⚠ 1 vulnerability (moderate)');
  });

  it('combines an update and a vulnerability in one lens', () => {
    const specs = buildLensSpecs(manifestText, [
      dep({
        updateKind: 'major',
        latest: '2.0.0',
        vulnerabilities: [vuln({ severity: 'high' })],
      }),
    ]);
    expect(specs[0]?.title).toBe(
      '↑ 2.0.0 available  ·  ⚠ 1 vulnerability (high)',
    );
  });

  it('skips a dependency whose declaration cannot be located', () => {
    const specs = buildLensSpecs(manifestText, [
      dep({ name: 'not-in-text', updateKind: 'patch', latest: '1.0.1' }),
    ]);
    expect(specs).toEqual([]);
  });
});

describe('buildDiagnosticSpecs', () => {
  it('produces no diagnostic when there are no vulnerabilities', () => {
    expect(buildDiagnosticSpecs(manifestText, [dep()])).toEqual([]);
  });

  it('reports the single vulnerability by summary and severity', () => {
    const specs = buildDiagnosticSpecs(manifestText, [
      dep({
        vulnerabilities: [
          vuln({ summary: 'prototype pollution', severity: 'high' }),
        ],
      }),
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.message).toBe('pkg: prototype pollution (high)');
    expect(specs[0]?.severity).toBe('high');
  });

  it('summarizes multiple vulnerabilities by count and worst severity', () => {
    const specs = buildDiagnosticSpecs(manifestText, [
      dep({
        vulnerabilities: [
          vuln({ id: 'a', severity: 'moderate' }),
          vuln({ id: 'b', severity: 'critical' }),
        ],
      }),
    ]);
    expect(specs[0]?.message).toBe(
      'pkg: 2 known vulnerabilities, worst is critical',
    );
    expect(specs[0]?.severity).toBe('critical');
  });

  it('skips a dependency whose declaration cannot be located', () => {
    const specs = buildDiagnosticSpecs(manifestText, [
      dep({ name: 'not-in-text', vulnerabilities: [vuln()] }),
    ]);
    expect(specs).toEqual([]);
  });
});
