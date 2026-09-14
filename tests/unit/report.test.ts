/**
 * The exportable dependency report: what a scan renders to Markdown or JSON,
 * computed without touching `vscode` so these fixtures can drive it directly.
 */

import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/core/report.js';
import type {
  Dependency,
  ProjectDuplicateVersions,
  ProjectGroup,
  ScanSummary,
  Vulnerability,
} from '../../src/core/types.js';

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

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    label: 'app',
    manifestPath: '/p/package.json',
    ecosystem: 'node',
    toolchain: 'npm',
    dependencies: [],
    ...overrides,
  };
}

const EMPTY_SUMMARY: ScanSummary = {
  totalDependencies: 0,
  outdated: 0,
  vulnerable: 0,
  deprecated: 0,
  stale: false,
};

const OPTIONS = { generatedAt: '2026-08-26T00:00:00.000Z' };

describe('buildReport (markdown)', () => {
  it('states the summary counts and generation time', () => {
    const output = buildReport(
      [],
      { ...EMPTY_SUMMARY, totalDependencies: 5, outdated: 2, vulnerable: 1 },
      [],
      OPTIONS,
      'markdown',
    );
    expect(output).toContain('# Orizzonte Dependency Report');
    expect(output).toContain('**Generated:** 2026-08-26T00:00:00.000Z');
    expect(output).toContain('5 package(s) across 0 project(s)');
    expect(output).toContain('- 2 outdated');
    expect(output).toContain('- 1 vulnerable');
  });

  it('notes stale data and includes the workspace name when given', () => {
    const output = buildReport(
      [],
      { ...EMPTY_SUMMARY, stale: true },
      [],
      { ...OPTIONS, workspaceName: 'my-repo' },
      'markdown',
    );
    expect(output).toContain('**Workspace:** my-repo');
    expect(output).toContain('registries were unreachable at scan time');
  });

  it('lists an outdated dependency with its current/wanted/latest versions', () => {
    const g = group({
      dependencies: [
        dep({
          name: 'react',
          installed: '18.0.0',
          wanted: '18.2.0',
          latest: '19.0.0',
          updateKind: 'major',
        }),
      ],
    });
    const output = buildReport([g], EMPTY_SUMMARY, [], OPTIONS, 'markdown');
    expect(output).toContain('### Outdated');
    expect(output).toContain('| react | prod | 18.0.0 | 18.2.0 | 19.0.0 |');
  });

  it('lists a vulnerable dependency by its worst severity, escaping a pipe in the summary', () => {
    const g = group({
      dependencies: [
        dep({
          name: 'lodash',
          vulnerabilities: [
            vuln({ id: 'a', severity: 'low', summary: 'x | y' }),
            vuln({
              id: 'b',
              severity: 'critical',
              summary: 'prototype pollution',
              fixedVersion: '4.17.21',
            }),
          ],
        }),
      ],
    });
    const output = buildReport([g], EMPTY_SUMMARY, [], OPTIONS, 'markdown');
    expect(output).toContain('### Vulnerable');
    expect(output).toContain(
      '| lodash | critical | prototype pollution | 4.17.21 |',
    );
    expect(output).not.toContain('x | y');
  });

  it('lists duplicate version groups for a checked project', () => {
    const g = group();
    const duplicates: ProjectDuplicateVersions[] = [
      {
        manifestPath: g.manifestPath,
        projectLabel: g.label,
        ecosystem: g.ecosystem,
        checked: true,
        groups: [{ name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] }],
      },
    ];
    const output = buildReport(
      [g],
      EMPTY_SUMMARY,
      duplicates,
      OPTIONS,
      'markdown',
    );
    expect(output).toContain('### Duplicate versions');
    expect(output).toContain('| ansi-styles | 3.2.1, 4.3.0 |');
  });

  it('says a project was not checked rather than calling it clean', () => {
    const g = group();
    const duplicates: ProjectDuplicateVersions[] = [
      {
        manifestPath: g.manifestPath,
        projectLabel: g.label,
        ecosystem: g.ecosystem,
        checked: false,
        groups: [],
      },
    ];
    const output = buildReport(
      [g],
      EMPTY_SUMMARY,
      duplicates,
      OPTIONS,
      'markdown',
    );
    expect(output).toContain('were not checked for this project');
    expect(output).not.toContain('Nothing to report');
  });

  it('says there is nothing to report for a clean, checked project', () => {
    const g = group();
    const duplicates: ProjectDuplicateVersions[] = [
      {
        manifestPath: g.manifestPath,
        projectLabel: g.label,
        ecosystem: g.ecosystem,
        checked: true,
        groups: [],
      },
    ];
    const output = buildReport(
      [g],
      EMPTY_SUMMARY,
      duplicates,
      OPTIONS,
      'markdown',
    );
    expect(output).toContain('_Nothing to report._');
  });
});

describe('buildReport (json)', () => {
  it('produces a structured document with one entry per project', () => {
    const g = group({
      dependencies: [
        dep({
          name: 'react',
          installed: '18.0.0',
          latest: '19.0.0',
          updateKind: 'major',
          vulnerabilities: [vuln({ severity: 'moderate' })],
        }),
      ],
    });
    const duplicates: ProjectDuplicateVersions[] = [
      {
        manifestPath: g.manifestPath,
        projectLabel: g.label,
        ecosystem: g.ecosystem,
        checked: true,
        groups: [{ name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] }],
      },
    ];

    const output = buildReport(
      [g],
      { ...EMPTY_SUMMARY, totalDependencies: 1 },
      duplicates,
      OPTIONS,
      'json',
    );
    const parsed = JSON.parse(output);

    expect(parsed.generatedAt).toBe(OPTIONS.generatedAt);
    expect(parsed.summary.totalDependencies).toBe(1);
    expect(parsed.projects).toHaveLength(1);

    const project = parsed.projects[0];
    expect(project.label).toBe('app');
    expect(project.outdated).toEqual([
      {
        name: 'react',
        scope: 'prod',
        current: '18.0.0',
        wanted: undefined,
        latest: '19.0.0',
        updateKind: 'major',
      },
    ]);
    expect(project.vulnerable[0].name).toBe('react');
    expect(project.duplicateVersions).toEqual({
      checked: true,
      groups: [{ name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] }],
    });
  });

  it('reports an unchecked project rather than an empty clean one', () => {
    const g = group();
    const output = buildReport([g], EMPTY_SUMMARY, [], OPTIONS, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.projects[0].duplicateVersions).toEqual({
      checked: false,
      groups: [],
    });
  });
});
