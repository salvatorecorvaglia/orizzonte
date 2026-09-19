/**
 * A codicon — the icon font VS Code draws its own UI with.
 *
 * The panel once used text glyphs picked to approximate codicons, so a
 * vulnerable package was a `shield` in one surface and a `⬤` in another while
 * `theme.css` claimed the two mirrored each other. Using the real font is what
 * makes the panel look like part of the editor rather than like a web page
 * embedded in one.
 *
 * Naming is the whole reason this is a component rather than a bare className:
 * an icon either carries meaning on its own — in which case it needs a name
 * assistive technology can read — or it decorates a control that is already
 * labelled, in which case announcing it again is noise. Passing `label` picks
 * the first; omitting it picks the second. There is no third option where the
 * icon is silently unlabelled.
 */

interface Props {
  /** Codicon name without the `codicon-` prefix, e.g. `shield`. */
  name: string;
  /**
   * The icon's accessible name. Provide it when the icon is the only signal;
   * omit it when a labelled ancestor already says the same thing.
   */
  label?: string;
  /** A description on hover. Not a substitute for `label`. */
  title?: string;
  className?: string;
}

export function Icon({ name, label, title, className }: Props) {
  const classes = ['codicon', `codicon-${name}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      title={title}
      {...(label
        ? { role: 'img', 'aria-label': label }
        : { 'aria-hidden': true })}
    />
  );
}
