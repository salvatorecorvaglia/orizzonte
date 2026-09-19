/**
 * The shared overlay behaviour: Escape closes, and focus goes somewhere useful
 * on open and back where it came from on close.
 *
 * The handler this hook returns is a React `onKeyDown` on the overlay's root,
 * so it only ever fires while focus is *inside* the overlay. That makes "move
 * focus in on open" load-bearing rather than a nicety: an overlay that opens
 * without taking focus — from a menu item that then unmounts, leaving focus on
 * `<body>` — can never receive the Escape it is listening for.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useDismissableOverlay } from '../../src/webview/useDismissableOverlay.js';

function Overlay({
  onClose,
  takeFocus,
}: {
  onClose: () => void;
  takeFocus: boolean;
}) {
  const handleKeyDown = useDismissableOverlay(
    onClose,
    takeFocus ? () => document.getElementById('heading')?.focus() : undefined,
  );

  return (
    <section aria-label="Overlay" onKeyDown={handleKeyDown}>
      <h2 id="heading" tabIndex={-1}>
        Overlay
      </h2>
      <button type="button">Inside</button>
    </section>
  );
}

describe('useDismissableOverlay', () => {
  it('closes on Escape when the overlay has focus', async () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} takeFocus />);

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('moves focus into the overlay on open', () => {
    render(<Overlay onClose={() => {}} takeFocus />);

    expect(screen.getByRole('heading', { name: 'Overlay' })).toHaveFocus();
  });

  it('ignores keys other than Escape', async () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} takeFocus />);

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('a');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('restores focus to whatever had it before the overlay opened', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(opener).toHaveFocus();

    const { unmount } = render(<Overlay onClose={() => {}} takeFocus />);
    expect(screen.getByRole('heading', { name: 'Overlay' })).toHaveFocus();

    unmount();

    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('cannot hear Escape when nothing moved focus in — the regression', async () => {
    const onClose = vi.fn();
    // No `onOpenFocus`, and the opener is gone, which is exactly the state the
    // toolbar's More menu leaves behind when it opens a panel and unmounts.
    render(<Overlay onClose={onClose} takeFocus={false} />);
    expect(document.body).toHaveFocus();

    await userEvent.keyboard('{Escape}');

    // Documents *why* every overlay must take focus: without it the key event
    // is dispatched at the body and never reaches the panel's handler.
    expect(onClose).not.toHaveBeenCalled();
  });
});
