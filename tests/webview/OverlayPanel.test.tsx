/**
 * The three read-only overlay panels, through the shell they now share.
 *
 * The behaviour under test is the one that was missing from all three: they
 * open from the toolbar's More menu, which unmounts as they appear, so unless
 * the panel takes focus itself nothing inside it can ever receive the Escape
 * that is supposed to close it — and the user is left on `<body>` with no
 * keyboard route back.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  LicenseSummary,
  ProjectDependencyDiff,
  ProjectDuplicateVersions,
} from '../../src/core/types.js';
import { DependencyDiffPanel } from '../../src/webview/DependencyDiffPanel.js';
import { DuplicatesPanel } from '../../src/webview/DuplicatesPanel.js';
import { LicenseSummaryPanel } from '../../src/webview/LicenseSummaryPanel.js';

const duplicates: ProjectDuplicateVersions[] = [
  {
    manifestPath: '/ws/packages/web/package.json',
    projectLabel: 'packages/web',
    ecosystem: 'node',
    checked: true,
    groups: [{ name: 'semver', versions: ['6.3.1', '7.8.5'] }],
  },
];

const licenses: LicenseSummary = {
  groups: [
    { license: 'MIT', packageNames: ['react', 'semver'], flagged: false },
    { license: 'GPL-3.0', packageNames: ['copyleft'], flagged: true },
  ],
};

const diff: ProjectDependencyDiff[] = [
  {
    manifestPath: '/ws/package.json',
    projectLabel: 'app',
    ecosystem: 'node',
    checked: true,
    added: [{ name: 'left-pad', before: undefined, after: ['1.3.0'] }],
    removed: [],
    changed: [],
  },
];

/** Each panel, with the label its close button carries. */
const panels = [
  {
    name: 'DuplicatesPanel',
    closeLabel: 'Close duplicate versions',
    element: (onClose: () => void) => (
      <DuplicatesPanel results={duplicates} loading={false} onClose={onClose} />
    ),
  },
  {
    name: 'LicenseSummaryPanel',
    closeLabel: 'Close license summary',
    element: (onClose: () => void) => (
      <LicenseSummaryPanel
        summary={licenses}
        loading={false}
        onRefresh={() => {}}
        onClose={onClose}
      />
    ),
  },
  {
    name: 'DependencyDiffPanel',
    closeLabel: 'Close dependency changes',
    element: (onClose: () => void) => (
      <DependencyDiffPanel
        gitRef="main"
        results={diff}
        onCompareAgain={() => {}}
        onClose={onClose}
      />
    ),
  },
];

describe.each(panels)('$name', ({ closeLabel, element }) => {
  it('takes focus when it opens', () => {
    render(element(() => {}));
    expect(screen.getByRole('heading', { level: 2 })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(element(onClose));

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes from its close button', async () => {
    const onClose = vi.fn();
    render(element(onClose));

    await userEvent.click(screen.getByRole('button', { name: closeLabel }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('returns focus to the control that opened it', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(element(() => {}));
    unmount();

    expect(opener).toHaveFocus();
    opener.remove();
  });
});

describe('panel content', () => {
  it('lists each duplicated package with its versions', () => {
    render(
      <DuplicatesPanel
        results={duplicates}
        loading={false}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('semver')).toBeInTheDocument();
    expect(screen.getByText('6.3.1')).toBeInTheDocument();
    expect(screen.getByText('7.8.5')).toBeInTheDocument();
  });

  it('shows the loading state before the first result arrives', () => {
    render(<DuplicatesPanel results={undefined} loading onClose={() => {}} />);

    expect(screen.getByText('Checking lockfiles…')).toBeInTheDocument();
  });

  it('warns when a license fails the configured policy', () => {
    render(
      <LicenseSummaryPanel
        summary={licenses}
        loading={false}
        onRefresh={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      '1 package uses a license your policy flags',
    );
  });

  it('names the ref it compared against', () => {
    render(
      <DependencyDiffPanel
        gitRef="main"
        results={diff}
        onCompareAgain={() => {}}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Comparing with main' }),
    ).toBeInTheDocument();
    expect(screen.getByText('left-pad')).toBeInTheDocument();
  });
});
