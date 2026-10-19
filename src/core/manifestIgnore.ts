import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { ReadFile } from './lockfiles/resolve.js';

/** A scan-scoped matcher; nested rules never escape their workspace root. */
export class ManifestIgnore {
  private readonly rules = new Map<string, Promise<Ignore>>();

  constructor(private readonly read: ReadFile) {}

  async ignores(root: string, manifest: string): Promise<boolean> {
    const relative = path.relative(root, manifest);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      return false;
    const parts = relative.split(path.sep);
    const active: Array<{ dir: string; rules: Ignore }> = [];
    let dir = root;
    for (let i = 0; i < parts.length; i++) {
      // Git cannot re-include a file inside a directory that remains ignored.
      if (i > 0 && this.matches(active, `${dir}${path.sep}`)) return true;
      active.push({ dir, rules: await this.rulesFor(dir) });
      if (i < parts.length - 1) dir = path.join(dir, parts[i]);
    }
    return this.matches(active, manifest);
  }

  private matches(
    active: Array<{ dir: string; rules: Ignore }>,
    target: string,
  ): boolean {
    let ignored = false;
    for (const entry of active) {
      const relative =
        path.relative(entry.dir, target).split(path.sep).join('/') +
        (target.endsWith(path.sep) ? '/' : '');
      if (!relative || relative === '/') continue;
      const result = entry.rules.test(relative);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }

  private rulesFor(dir: string): Promise<Ignore> {
    let pending = this.rules.get(dir);
    if (!pending) {
      pending = this.read(path.join(dir, '.gitignore')).then((text) =>
        ignore().add(text ?? ''),
      );
      this.rules.set(dir, pending);
    }
    return pending;
  }
}
