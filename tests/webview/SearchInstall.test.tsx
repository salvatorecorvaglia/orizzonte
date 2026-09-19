/**
 * Registry search and install.
 *
 * The interaction that matters: the primary action reflects the state of the
 * *targeted* manifest, so the button always does the thing that makes sense.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectGroup, SearchResult } from '../../src/core/types.js';
import { SearchInstall } from '../../src/webview/SearchInstall.js';

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    label: 'web',
    manifestPath: '/p/package.json',
    ecosystem: 'node',
    toolchain: 'npm',
    dependencies: [],
    ...overrides,
  };
}

const noop = () => {};

function renderPanel(
  overrides: Partial<Parameters<typeof SearchInstall>[0]> = {},
) {
  const props = {
    groups: [group()],
    results: [] as SearchResult[],
    error: undefined,
    searching: false,
    onSearch: noop,
    onInstall: noop,
    onUninstall: noop,
    onClose: noop,
    ...overrides,
  };
  return { ...render(<SearchInstall {...props} />), props };
}

const reactResult: SearchResult = {
  name: 'react',
  version: '18.2.0',
  description: 'A JavaScript library',
  ecosystem: 'node',
};

describe('searching', () => {
  it('waits for a second character before querying a registry', async () => {
    const onSearch = vi.fn();
    renderPanel({ onSearch });

    await userEvent.type(
      screen.getByRole('searchbox', { name: /Search registries/i }),
      'r',
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onSearch).not.toHaveBeenCalled();
    expect(screen.getByText(/at least two characters/i)).toBeInTheDocument();
  });

  it('debounces, so a typed word is one query rather than five', async () => {
    const onSearch = vi.fn();
    renderPanel({ onSearch });

    await userEvent.type(
      screen.getByRole('searchbox', { name: /Search registries/i }),
      'react',
    );
    await waitFor(() => expect(onSearch).toHaveBeenCalled());
    expect(onSearch).toHaveBeenCalledOnce();
    expect(onSearch).toHaveBeenCalledWith('react', 'all');
  });

  it('searches immediately on Enter rather than waiting out the debounce', async () => {
    // The debounce is right for someone mid-word and wrong for someone who has
    // finished: pressing Enter and getting nothing reads as a broken box.
    const onSearch = vi.fn();
    renderPanel({ onSearch });

    const box = screen.getByRole('searchbox', { name: /Search registries/i });
    await userEvent.type(box, 'react{Enter}');

    expect(onSearch).toHaveBeenCalledWith('react', 'all');
  });

  it('ignores Enter below the two-character floor', async () => {
    const onSearch = vi.fn();
    renderPanel({ onSearch });

    await userEvent.type(
      screen.getByRole('searchbox', { name: /Search registries/i }),
      'r{Enter}',
    );

    expect(onSearch).not.toHaveBeenCalled();
  });

  it('closes on Escape, the same as the detail drawer', async () => {
    // Two dismissable overlays in one webview that disagree about Escape is
    // the kind of inconsistency you find by having a keystroke ignored.
    const onClose = vi.fn();
    renderPanel({ onClose });

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('names its controls visibly, not only to assistive technology', () => {
    renderPanel();
    // These three decide where and how a package is written to a manifest.
    for (const label of ['Registry', 'Install into', 'Scope']) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });

  it('offers only the ecosystems present in the workspace', () => {
    renderPanel({
      groups: [
        group(),
        group({ ecosystem: 'cargo', manifestPath: '/p/Cargo.toml' }),
      ],
    });

    const select = screen.getByRole('combobox', { name: /Registry/i });
    const options = [...select.querySelectorAll('option')].map(
      (o) => o.textContent,
    );
    expect(options).toEqual(['All registries', 'npm', 'crates.io']);
  });
});

describe('install and remove', () => {
  it('installs into the targeted manifest with the chosen scope', async () => {
    const onInstall = vi.fn();
    renderPanel({ results: [reactResult], onInstall });

    await userEvent.selectOptions(
      // Named "Scope", the word the table column and the filter chips use.
      screen.getByRole('combobox', { name: /^Scope$/i }),
      'dev',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));

    expect(onInstall).toHaveBeenCalledWith(
      'react',
      '18.2.0',
      'dev',
      '/p/package.json',
    );
  });

  it('flips to Remove when the package is already in the targeted manifest', async () => {
    const onUninstall = vi.fn();
    renderPanel({
      results: [
        {
          ...reactResult,
          installedIn: [
            {
              manifestPath: '/p/package.json',
              projectLabel: 'web',
              declared: '^18.0.0',
              scope: 'prod',
            },
          ],
        },
      ],
      onUninstall,
    });

    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onUninstall).toHaveBeenCalledWith(
      'react',
      'node',
      '/p/package.json',
    );
  });

  it('still offers Install when the package is only in a different project', () => {
    renderPanel({
      results: [
        {
          ...reactResult,
          installedIn: [
            {
              manifestPath: '/other/package.json',
              projectLabel: 'api',
              declared: '^18.0.0',
              scope: 'prod',
            },
          ],
        },
      ],
    });

    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled();
    // ...but says where it already is, so the duplication is a choice.
    expect(screen.getByText(/Already in.*api/i)).toBeInTheDocument();
  });

  it('refuses to install a package into a foreign ecosystem', () => {
    renderPanel({
      results: [{ name: 'serde', version: '1.0', ecosystem: 'cargo' }],
    });
    const button = screen.getByRole('button', { name: 'Install' });
    expect(button).toBeDisabled();
    // The reason is reachable by keyboard/screen reader, not only a mouse
    // hover tooltip — `aria-describedby` must point at real, visible text.
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toMatch(
      /cannot go into/i,
    );
  });

  it('disables installing when there is nowhere to install into', () => {
    renderPanel({ groups: [], results: [reactResult] });
    const button = screen.getByRole('button', { name: 'Install' });
    expect(button).toBeDisabled();
    expect(
      screen.getByRole('combobox', { name: /Install into/i }),
    ).toBeDisabled();

    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toMatch(
      /dependency manifest/i,
    );
  });
});

describe('result states', () => {
  it('reports a registry failure rather than passing it off as no matches', () => {
    // "No packages found" for an unreachable registry sends people looking for
    // a package that is right there.
    renderPanel({ error: 'crates.io is unreachable' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'crates.io is unreachable',
    );
    expect(screen.queryByText(/No packages found/i)).toBeNull();
  });

  it('announces result counts to assistive technology', async () => {
    const { rerender, props } = renderPanel({ searching: true });
    expect(screen.getByRole('status')).toHaveTextContent(/Searching/i);

    rerender(
      <SearchInstall {...props} searching={false} results={[reactResult]} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/1 package/i);
  });
});
