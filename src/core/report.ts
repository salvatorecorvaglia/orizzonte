/**
 * Renders a scan into a standalone Markdown or JSON report — for sharing
 * with someone who does not have the editor open, or attaching to a PR.
 *
 * Kept free of `vscode`, like the other `core/` modules the webview or a
 * future non-editor caller might need to reuse: nothing here reads the
 * filesystem or shows a dialog, it only turns data already in memory into
 * text.
 */

import type {
  ProjectDuplicateVersions,
  ProjectGroup,
  ScanSummary,
} from './types.js';
import { currentVersion, hasUpdate, sortBySeverity } from './vocabulary.js';

export type ReportFormat = 'markdown' | 'json';

export interface ReportOptions {
  /** ISO timestamp; injected rather than read here so output is deterministic. */
  generatedAt: string;
  workspaceName?: string;
}

export function buildReport(
  groups: ProjectGroup[],
  summary: ScanSummary,
  duplicates: ProjectDuplicateVersions[],
  options: ReportOptions,
  format: ReportFormat,
): string {
  return format === 'json'
    ? buildJsonReport(groups, summary, duplicates, options)
    : buildMarkdownReport(groups, summary, duplicates, options);
}

function buildMarkdownReport(
  groups: ProjectGroup[],
  summary: ScanSummary,
  duplicates: ProjectDuplicateVersions[],
  options: ReportOptions,
): string {
  const duplicatesByPath = new Map(
    duplicates.map((entry) => [entry.manifestPath, entry]),
  );

  const lines: string[] = ['# Orizzonte Dependency Report', ''];
  if (options.workspaceName) {
    lines.push(`**Workspace:** ${options.workspaceName}  `);
  }
  lines.push(`**Generated:** ${options.generatedAt}`, '');

  lines.push(
    '## Summary',
    '',
    `- ${summary.totalDependencies} package(s) across ${groups.length} project(s)`,
    `- ${summary.outdated} outdated`,
    `- ${summary.vulnerable} vulnerable`,
    `- ${summary.deprecated} deprecated`,
  );
  if (summary.stale) {
    lines.push('- Data is cached — registries were unreachable at scan time');
  }
  lines.push('');

  for (const group of groups) {
    const outdated = group.dependencies.filter(hasUpdate);
    const vulnerable = group.dependencies.filter(
      (dep) => dep.vulnerabilities.length > 0,
    );
    const duplicate = duplicatesByPath.get(group.manifestPath);

    lines.push(
      `## ${group.label} (${group.ecosystem} / ${group.toolchain})`,
      '',
    );

    if (outdated.length > 0) {
      lines.push(
        '### Outdated',
        '',
        '| Package | Scope | Current | Wanted | Latest |',
        '|---|---|---|---|---|',
      );
      for (const dep of outdated) {
        lines.push(
          `| ${escapeCell(dep.name)} | ${dep.scope} | ${escapeCell(currentVersion(dep))} | ${escapeCell(dep.wanted ?? '—')} | ${escapeCell(dep.latest ?? '—')} |`,
        );
      }
      lines.push('');
    }

    if (vulnerable.length > 0) {
      lines.push(
        '### Vulnerable',
        '',
        '| Package | Severity | Advisory | Fixed in |',
        '|---|---|---|---|',
      );
      for (const dep of vulnerable) {
        const worst = sortBySeverity(dep.vulnerabilities)[0];
        lines.push(
          `| ${escapeCell(dep.name)} | ${worst.severity} | ${escapeCell(worst.summary)} | ${escapeCell(worst.fixedVersion ?? '—')} |`,
        );
      }
      lines.push('');
    }

    if (duplicate?.groups && duplicate.groups.length > 0) {
      lines.push(
        '### Duplicate versions',
        '',
        '| Package | Versions |',
        '|---|---|',
      );
      for (const dup of duplicate.groups) {
        lines.push(`| ${escapeCell(dup.name)} | ${dup.versions.join(', ')} |`);
      }
      lines.push('');
    } else if (duplicate && !duplicate.checked) {
      lines.push(
        '_Duplicate versions were not checked for this project — no lockfile Orizzonte can verify._',
        '',
      );
    }

    if (
      outdated.length === 0 &&
      vulnerable.length === 0 &&
      (!duplicate || duplicate.groups.length === 0) &&
      duplicate?.checked !== false
    ) {
      lines.push('_Nothing to report._', '');
    }
  }

  return lines.join('\n');
}

/** Escapes characters that would break a Markdown table cell. */
function escapeCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function buildJsonReport(
  groups: ProjectGroup[],
  summary: ScanSummary,
  duplicates: ProjectDuplicateVersions[],
  options: ReportOptions,
): string {
  const duplicatesByPath = new Map(
    duplicates.map((entry) => [entry.manifestPath, entry]),
  );

  const report = {
    generatedAt: options.generatedAt,
    workspaceName: options.workspaceName,
    summary,
    projects: groups.map((group) => {
      const duplicate = duplicatesByPath.get(group.manifestPath);
      return {
        label: group.label,
        ecosystem: group.ecosystem,
        toolchain: group.toolchain,
        manifestPath: group.manifestPath,
        outdated: group.dependencies.filter(hasUpdate).map((dep) => ({
          name: dep.name,
          scope: dep.scope,
          current: currentVersion(dep),
          wanted: dep.wanted,
          latest: dep.latest,
          updateKind: dep.updateKind,
        })),
        vulnerable: group.dependencies
          .filter((dep) => dep.vulnerabilities.length > 0)
          .map((dep) => ({
            name: dep.name,
            scope: dep.scope,
            vulnerabilities: sortBySeverity(dep.vulnerabilities),
          })),
        duplicateVersions: duplicate
          ? { checked: duplicate.checked, groups: duplicate.groups }
          : { checked: false, groups: [] },
      };
    }),
  };

  return JSON.stringify(report, null, 2);
}
