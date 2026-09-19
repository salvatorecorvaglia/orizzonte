/**
 * The shell every read-only overlay panel shares: duplicate versions, the
 * license summary, and the dependency diff.
 *
 * The three had been written at different times and had drifted into three
 * copies of one structure — section, toolbar row, title, spacer, close button,
 * live region — which is duplication worth collapsing on its own. It is worth
 * more than that here, because the copies had also drifted on behaviour: none
 * of them moved focus when it opened.
 *
 * That matters because `useDismissableOverlay` returns a React `onKeyDown` bound
 * to this section, so it only hears keys pressed *inside* the panel. These
 * panels open from the toolbar's More menu, which unmounts as it does — leaving
 * focus on `<body>`, where Escape never reaches the handler and the closing
 * focus restore has nothing live to return to. Taking focus on open is what
 * makes Escape work at all, so it belongs in the shared shell rather than in
 * three places that can each forget it.
 */

import type { ReactNode } from 'react';
import { useRef } from 'react';
import { Icon } from './Icon.js';
import { useDismissableOverlay } from './useDismissableOverlay.js';

interface Props {
  /** DOM id, so the toolbar control that opened this can point `aria-controls` at it. */
  id: string;
  /** The panel region's accessible name. */
  label: string;
  title: ReactNode;
  /** The close button's accessible name, e.g. "Close license summary". */
  closeLabel: string;
  onClose: () => void;
  /** Controls rendered before the close button, such as a Refresh. */
  actions?: ReactNode;
  /**
   * Announced politely as the panel's async state changes. Rendered even when
   * empty so assistive technology keeps observing the same node rather than
   * seeing one appear and disappear.
   */
  status?: string;
  children: ReactNode;
}

export function OverlayPanel({
  id,
  label,
  title,
  closeLabel,
  onClose,
  actions,
  status,
  children,
}: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const handlePanelKeyDown = useDismissableOverlay(onClose, () =>
    headingRef.current?.focus(),
  );

  return (
    <section
      className="search-panel"
      id={id}
      aria-label={label}
      onKeyDown={handlePanelKeyDown}
    >
      <div className="toolbar">
        <div className="toolbar__row">
          {/* Focusable so opening the panel moves the caret somewhere sensible
              — and so this panel can hear the Escape that closes it. */}
          <h2 className="toolbar__title" ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          <div className="toolbar__spacer" />
          {actions}
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label={closeLabel}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div className="visually-hidden" role="status">
        {status ?? ''}
      </div>

      {children}
    </section>
  );
}
