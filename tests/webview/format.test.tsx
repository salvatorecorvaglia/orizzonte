/**
 * The webview's presentation helpers.
 *
 * Pure functions with no rendering, but they live in the webview project
 * because that is where they are used — and because `formatDate` depends on a
 * DOM-ish locale environment rather than a bare Node one.
 */

import { describe, expect, it } from 'vitest';
import {
  ECOSYSTEM_LABELS,
  formatBytes,
  formatDate,
  formatDownloads,
} from '../../src/webview/format.js';

describe('formatBytes', () => {
  it('renders an em dash for nothing to show', () => {
    // Zero and negative are "the registry did not report a size", not "0 B".
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });

  it('keeps bytes whole and larger units to one decimal', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('drops the decimal once a value reaches double digits', () => {
    // A decimal on "1.5 KB" earns its place; on "512 KB" it is noise.
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(25 * 1024)).toBe('25 KB');
  });

  it('stops climbing at gigabytes rather than inventing a unit', () => {
    expect(formatBytes(4 * 1024 ** 3)).toBe('4.0 GB');
    expect(formatBytes(4096 * 1024 ** 3)).toBe('4096 GB');
  });
});

describe('formatDownloads', () => {
  it('renders nothing when the registry reported nothing', () => {
    // Distinct from zero downloads, which is a real and printable fact.
    expect(formatDownloads(undefined)).toBe('');
    expect(formatDownloads(0)).toBe('0');
  });

  it('abbreviates thousands and millions', () => {
    expect(formatDownloads(999)).toBe('999');
    expect(formatDownloads(1_000)).toBe('1k');
    expect(formatDownloads(12_500)).toBe('13k');
    expect(formatDownloads(1_000_000)).toBe('1.0M');
    expect(formatDownloads(2_500_000)).toBe('2.5M');
  });
});

describe('formatDate', () => {
  it('renders nothing for a missing or unparseable timestamp', () => {
    // Registry fields are not ours to trust; a bad date must not render
    // "Invalid Date" in the drawer.
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate('not a date')).toBe('');
  });

  it('renders a real timestamp as a short date', () => {
    const formatted = formatDate('2024-03-15T10:00:00Z');
    expect(formatted).not.toBe('');
    expect(formatted).toMatch(/2024/);
  });
});

describe('ECOSYSTEM_LABELS', () => {
  it('names every ecosystem the way its users do', () => {
    // The ids are ours; these are what people call the registries.
    expect(ECOSYSTEM_LABELS.node).toBe('npm');
    expect(ECOSYSTEM_LABELS.python).toBe('PyPI');
    expect(ECOSYSTEM_LABELS.cargo).toBe('crates.io');
  });

  it('covers every ecosystem, so no label can render as undefined', () => {
    const ecosystems = [
      'node',
      'python',
      'cargo',
      'golang',
      'composer',
      'maven',
      'gradle',
    ] as const;
    for (const id of ecosystems) {
      expect(ECOSYSTEM_LABELS[id]).toBeTruthy();
    }
  });
});
