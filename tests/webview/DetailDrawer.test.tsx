/**
 * The per-package detail drawer: metadata, advisories, and the reverse
 * dependency tree.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Dependency, DepNode } from '../../src/core/types.js';
import { DetailDrawer } from '../../src/webview/DetailDrawer.js';
import { posted } from './setup.js';

function dep(overrides: Partial<Dependency> = {}): Dependency {
  return {
    key: 'react',
    name: 'react',
    ecosystem: 'node',
    scope: 'prod',
    declared: '^18.0.0',
    installed: '18.0.0',
    updateKind: 'none',
    vulnerabilities: [],
    manifestPath: '/p/package.json',
    projectLabel: 'app',
    ...overrides,
  };
}

function renderDrawer(
  overrides: Partial<Parameters<typeof DetailDrawer>[0]> = {},
) {
  return render(
    <DetailDrawer
      dep={dep()}
      why={undefined}
      changelogEntries={undefined}
      changelogLoaded={false}
      reveal="details"
      onClose={() => {}}
      onUpdate={() => {}}
      onUninstall={() => {}}
      {...overrides}
    />,
  );
}

describe('lazy loading', () => {
  it('asks the host for metadata and the graph when it opens', () => {
    // Fetching these for every row up front would be thousands of calls.
    renderDrawer();
    expect(posted).toContainEqual({ type: 'requestDetails', depKey: 'react' });
    expect(posted).toContainEqual({ type: 'requestWhy', depKey: 'react' });
  });
});

describe('versions', () => {
  it('shows wanted only when it differs from what is installed', () => {
    const { rerender } = renderDrawer({
      dep: dep({ installed: '18.0.0', wanted: '18.0.0', latest: '19.0.0' }),
    });
    expect(screen.queryByText('Wanted')).toBeNull();

    rerender(
      <DetailDrawer
        dep={dep({ installed: '18.0.0', wanted: '18.3.1', latest: '19.0.0' })}
        why={undefined}
        changelogEntries={undefined}
        changelogLoaded={false}
        reveal="details"
        onClose={() => {}}
        onUpdate={() => {}}
        onUninstall={() => {}}
      />,
    );
    expect(screen.getByText('Wanted')).toBeInTheDocument();
    expect(screen.getByText('18.3.1')).toBeInTheDocument();
  });

  it('offers the in-range upgrade as well as the latest', async () => {
    // Taking the safe upgrade should not require editing the manifest by hand.
    const onUpdate = vi.fn();
    renderDrawer({
      dep: dep({
        installed: '18.0.0',
        wanted: '18.3.1',
        latest: '19.0.0',
        updateKind: 'major',
      }),
      onUpdate,
    });

    await userEvent.click(
      screen.getByRole('button', { name: /Update to 18\.3\.1/i }),
    );
    expect(onUpdate).toHaveBeenCalledWith(expect.anything(), '18.3.1');
  });

  it('marks a major upgrade as such on the button', () => {
    renderDrawer({
      dep: dep({ latest: '19.0.0', updateKind: 'major' }),
    });
    expect(
      screen.getByRole('button', { name: /Update to 19\.0\.0 \(major\)/i }),
    ).toBeInTheDocument();
  });

  it('offers no upgrade when the lookup failed', () => {
    renderDrawer({ dep: dep({ updateKind: 'unknown', lookupFailed: true }) });
    expect(screen.queryByRole('button', { name: /Update to/i })).toBeNull();
    expect(
      screen.getByText(/Could not reach the registry/i),
    ).toBeInTheDocument();
  });
});

describe('advisories', () => {
  const vulnerable = dep({
    vulnerabilities: [
      {
        id: 'GHSA-1',
        summary: 'Prototype pollution',
        severity: 'critical',
        aliases: ['CVE-2020-1'],
        fixedVersion: '18.1.0',
        url: 'https://osv.dev/vulnerability/GHSA-1',
      },
    ],
  });

  it('shows severity, fix and aliases', () => {
    renderDrawer({ dep: vulnerable });
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
    expect(screen.getByText('18.1.0')).toBeInTheDocument();
    expect(screen.getByText('CVE-2020-1')).toBeInTheDocument();
  });

  it('says so when the match was against an inferred version', () => {
    // Advisories are matched on `installed`; when that was guessed from the
    // constraint it may name a version nobody actually has.
    renderDrawer({
      dep: { ...vulnerable, installedIsApproximate: true },
    });
    expect(screen.getByText(/No lockfile pins a version/i)).toBeInTheDocument();
  });

  it('states the match plainly when a lockfile pinned the version', () => {
    renderDrawer({ dep: vulnerable });
    expect(screen.queryByText(/No lockfile pins a version/i)).toBeNull();
  });

  it('distinguishes severities by more than one uppercase word', () => {
    // Every advisory shared the same red callout, so a critical and a low were
    // told apart only by the text.
    renderDrawer({
      dep: dep({
        vulnerabilities: [
          {
            id: 'GHSA-crit',
            summary: 'bad',
            severity: 'critical',
            aliases: [],
            url: 'https://osv.dev/a',
          },
          {
            id: 'GHSA-low',
            summary: 'minor',
            severity: 'low',
            aliases: [],
            url: 'https://osv.dev/b',
          },
        ],
      }),
    });

    const critical = screen.getByText('CRITICAL').closest('.callout');
    const low = screen.getByText('LOW').closest('.callout');
    expect(critical).toHaveClass('severity-critical');
    expect(low).toHaveClass('severity-low');
  });
});

describe('managing the package', () => {
  it('offers the same remove the row does', async () => {
    const onUninstall = vi.fn();
    renderDrawer({ onUninstall });

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onUninstall).toHaveBeenCalledOnce();
  });
});

describe('the busy rule', () => {
  /*
   * The drawer offers the same writes the row does, so it takes the same rule.
   * It used to take none, so a scan disabled Update in the table and left the
   * identical button live one panel to the right.
   */
  it('blocks its writes while a scan or write is in flight', () => {
    renderDrawer({
      dep: dep({
        installed: '18.0.0',
        wanted: '18.2.0',
        latest: '19.0.0',
        updateKind: 'major',
      }),
      busy: true,
    });

    expect(
      screen.getByRole('button', { name: /Update to 18\.2\.0/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /Update to 19\.0\.0/i }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Remove$/ })).toBeDisabled();
  });

  it('leaves the reads available while it is in flight', () => {
    renderDrawer({
      dep: dep({ latest: '19.0.0', updateKind: 'major' }),
      busy: true,
    });

    // Metadata, links and the tree are reads: a scan does not touch them.
    expect(
      screen.getByRole('button', { name: /Open manifest/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /Close details/i }),
    ).toBeEnabled();
  });
});

describe('links', () => {
  it('routes external links through the host rather than navigating', async () => {
    // The webview has no network and no navigation; the host opens the browser.
    renderDrawer({
      dep: dep({
        meta: {
          name: 'react',
          homepage: 'https://react.dev',
          repository: 'https://github.com/facebook/react',
        },
      }),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Homepage' }));
    expect(posted).toContainEqual({
      type: 'openExternal',
      url: 'https://react.dev',
    });
  });

  it('opens the manifest at the declaration', async () => {
    renderDrawer();
    await userEvent.click(
      screen.getByRole('button', { name: /Open manifest/i }),
    );
    expect(posted).toContainEqual({
      type: 'openManifest',
      manifestPath: '/p/package.json',
      packageName: 'react',
    });
  });
});

describe("what's changed", () => {
  const withUpdateAndRepo = dep({
    latest: '19.0.0',
    updateKind: 'major',
    meta: { name: 'react', repository: 'https://github.com/facebook/react' },
  });

  it('does not render for a package with no available update', () => {
    renderDrawer({ dep: dep({ updateKind: 'none' }) });
    expect(screen.queryByText(/What.s changed/i)).toBeNull();
  });

  it('does not render before a repository is known', () => {
    renderDrawer({
      dep: dep({ latest: '19.0.0', updateKind: 'major' }),
    });
    expect(screen.queryByText(/What.s changed/i)).toBeNull();
  });

  it('shows a loading state while the host has not answered yet', () => {
    renderDrawer({
      dep: withUpdateAndRepo,
      changelogEntries: undefined,
      changelogLoaded: false,
    });
    expect(screen.getByText(/What.s changed/i)).toBeInTheDocument();
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it('hides the section once the host reports the repository is not on GitHub', () => {
    renderDrawer({
      dep: withUpdateAndRepo,
      changelogEntries: undefined,
      changelogLoaded: true,
    });
    expect(screen.queryByText(/What.s changed/i)).toBeNull();
  });

  it('says so when the host found no release notes for this update', () => {
    renderDrawer({
      dep: withUpdateAndRepo,
      changelogEntries: [],
      changelogLoaded: true,
    });
    expect(
      screen.getByText(/No release notes found for this update/i),
    ).toBeInTheDocument();
  });

  it('lists the fetched entries and opens one through the host', async () => {
    renderDrawer({
      dep: withUpdateAndRepo,
      changelogEntries: [
        {
          version: 'v19.0.0',
          title: 'React 19',
          body: 'Highlights here',
          publishedAt: '2026-01-01T00:00:00Z',
          url: 'https://github.com/facebook/react/releases/tag/v19.0.0',
        },
      ],
      changelogLoaded: true,
    });

    expect(screen.getByText('React 19')).toBeInTheDocument();
    expect(screen.getByText('Highlights here')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'React 19' }));
    expect(posted).toContainEqual({
      type: 'openExternal',
      url: 'https://github.com/facebook/react/releases/tag/v19.0.0',
    });
  });

  it('falls back to the tag as a title when the release has none of its own', () => {
    renderDrawer({
      dep: withUpdateAndRepo,
      changelogEntries: [
        {
          version: 'v19.0.0',
          title: undefined,
          body: '',
          publishedAt: undefined,
          url: 'https://github.com/facebook/react/releases/tag/v19.0.0',
        },
      ],
      changelogLoaded: true,
    });
    expect(screen.getByRole('button', { name: 'v19.0.0' })).toBeInTheDocument();
    expect(screen.getByText(/No description provided/i)).toBeInTheDocument();
  });
});

describe('the why tree', () => {
  it('distinguishes resolving from having no answer', () => {
    const { rerender } = renderDrawer({ why: undefined });
    expect(screen.getByText(/Resolving/i)).toBeInTheDocument();

    rerender(
      <DetailDrawer
        dep={dep()}
        why={{ roots: [], source: 'lockfile' }}
        changelogEntries={undefined}
        changelogLoaded={false}
        reveal="details"
        onClose={() => {}}
        onUpdate={() => {}}
        onUninstall={() => {}}
      />,
    );
    expect(
      screen.getByText(/No dependency graph available/i),
    ).toBeInTheDocument();
  });

  it('says where the answer came from, since the two mean different things', () => {
    const roots: DepNode[] = [{ name: 'eslint', children: [] }];
    const { rerender } = renderDrawer({
      why: { roots, source: 'lockfile' },
    });
    expect(screen.getByText(/From this project/i)).toBeInTheDocument();

    rerender(
      <DetailDrawer
        dep={dep()}
        why={{ roots, source: 'registry' }}
        changelogEntries={undefined}
        changelogLoaded={false}
        reveal="details"
        onClose={() => {}}
        onUpdate={() => {}}
        onUninstall={() => {}}
      />,
    );
    expect(screen.getByText(/Resolved from the registry/i)).toBeInTheDocument();
  });

  it('renders nested chains', () => {
    renderDrawer({
      why: {
        source: 'lockfile',
        roots: [
          {
            name: 'eslint',
            children: [
              { name: 'chalk', requestedRange: '^4.0.0', children: [] },
            ],
          },
        ],
      },
    });

    expect(screen.getByText('eslint')).toBeInTheDocument();
    expect(screen.getByText('chalk')).toBeInTheDocument();
    expect(screen.getByText('(^4.0.0)')).toBeInTheDocument();
  });

  it('terminates on a self-referential tree instead of recursing forever', () => {
    // A cyclic graph reaching the renderer must not lock up the webview.
    const a: DepNode = { name: 'a', children: [] };
    const b: DepNode = { name: 'b', children: [a] };
    a.children.push(b);

    expect(() =>
      renderDrawer({ why: { roots: [a], source: 'registry' } }),
    ).not.toThrow();
    expect(screen.getAllByText('a').length).toBeGreaterThan(0);
  });
});

describe('dismissal', () => {
  it('closes on the button and on Escape', async () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });

    await userEvent.click(
      screen.getByRole('button', { name: /Close details/i }),
    );
    expect(onClose).toHaveBeenCalledOnce();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('names itself for assistive technology', () => {
    renderDrawer();
    const drawer = screen.getByRole('complementary', {
      name: /Details for react/i,
    });
    expect(
      within(drawer).getByRole('heading', { name: 'react' }),
    ).toBeInTheDocument();
  });
});

describe('opening straight to the Why section', () => {
  it('focuses it, so Escape still closes the drawer', async () => {
    const onClose = vi.fn();
    renderDrawer({ reveal: 'why', onClose });

    // Scrolling alone left focus outside the drawer, where its own keydown
    // handler could never see the key.
    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
  });
});
