/**
 * Presentation helpers for the webview.
 *
 * Vocabulary and rankings shared with the tree view live in
 * `core/vocabulary.ts` — this file is only about how the webview renders things.
 */

import type { Ecosystem } from '../core/types.js';

export const ECOSYSTEM_LABELS: Record<Ecosystem, string> = {
  node: 'npm',
  python: 'PyPI',
  cargo: 'crates.io',
  golang: 'Go',
  composer: 'Packagist',
  maven: 'Maven',
  gradle: 'Gradle',
};

/**
 * Row metrics live here rather than only in CSS because the virtualizer needs
 * them as numbers. `main.tsx` publishes them as custom properties so the
 * stylesheet follows these values instead of restating them.
 */
export const ROW_HEIGHT = 34;
export const GROUP_HEADER_HEIGHT = 40;

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDownloads(downloads: number | undefined): string {
  if (downloads === undefined) return '';
  if (downloads >= 1_000_000) return `${(downloads / 1_000_000).toFixed(1)}M`;
  if (downloads >= 1_000) return `${Math.round(downloads / 1_000)}k`;
  return String(downloads);
}

/** An ISO timestamp as a short, locale-formatted date, or empty for none. */
export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
