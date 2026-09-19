/**
 * Provider lookup: the one place a new ecosystem plugs in, and the one file
 * every scan and every watcher registration goes through.
 */

import { describe, expect, it } from 'vitest';
import {
  allWatchedFileNames,
  manifestGlob,
  PROVIDERS,
  providerFor,
  providerForPath,
} from '../../src/providers/registry.js';

describe('providerFor', () => {
  it('resolves every registered ecosystem', () => {
    for (const provider of PROVIDERS) {
      expect(providerFor(provider.id)).toBe(provider);
    }
  });

  it('throws for an ecosystem with no registered provider', () => {
    // Not reachable through the `Ecosystem` union at compile time, but
    // `BY_ID` is built from a runtime array, so a typo in that list would
    // otherwise fail silently at the call site instead of loudly here.
    expect(() =>
      providerFor('ruby' as Parameters<typeof providerFor>[0]),
    ).toThrow('No provider registered for ecosystem "ruby"');
  });
});

describe('providerForPath', () => {
  it('resolves every manifest file name to its provider', () => {
    expect(providerForPath('/p/package.json')?.id).toBe('node');
    expect(providerForPath('/p/pyproject.toml')?.id).toBe('python');
    expect(providerForPath('/p/requirements.txt')?.id).toBe('python');
    expect(providerForPath('/p/requirements-dev.txt')?.id).toBe('python');
    expect(providerForPath('/p/Cargo.toml')?.id).toBe('cargo');
    expect(providerForPath('/p/go.mod')?.id).toBe('golang');
    expect(providerForPath('/p/composer.json')?.id).toBe('composer');
    expect(providerForPath('/p/pom.xml')?.id).toBe('maven');
    expect(providerForPath('/p/build.gradle')?.id).toBe('gradle');
    expect(providerForPath('/p/build.gradle.kts')?.id).toBe('gradle');
    expect(providerForPath('/p/gradle/libs.versions.toml')?.id).toBe('gradle');
    expect(providerForPath('/p/README.md')).toBeUndefined();
  });

  it('matches only the basename, ignoring the rest of the path', () => {
    expect(
      providerForPath('/very/deep/nested/workspace/package.json')?.id,
    ).toBe('node');
  });

  it('is case-sensitive, matching what most filesystems actually do', () => {
    expect(providerForPath('/p/Package.json')).toBeUndefined();
    expect(providerForPath('/p/CARGO.TOML')).toBeUndefined();
  });

  it('does not treat a similarly named file as a manifest', () => {
    // Extra suffix, wrong extension, or a name that merely contains the
    // manifest name are all real files a workspace could contain.
    expect(providerForPath('/p/package.json.bak')).toBeUndefined();
    expect(providerForPath('/p/package.json.orig')).toBeUndefined();
    expect(providerForPath('/p/notpackage.json')).toBeUndefined();
    expect(providerForPath('/p/mypom.xml')).toBeUndefined();
  });

  it('requires the requirements*.txt family to actually end in .txt', () => {
    expect(providerForPath('/p/requirements.txt.bak')).toBeUndefined();
    expect(providerForPath('/p/requirements')).toBeUndefined();
  });
});

describe('allWatchedFileNames', () => {
  it('includes every provider manifest and lockfile with no duplicates', () => {
    const names = allWatchedFileNames();
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);

    for (const provider of PROVIDERS) {
      for (const file of [...provider.manifestFiles, ...provider.lockFiles]) {
        expect(names).toContain(file);
      }
    }
  });
});

describe('manifestGlob', () => {
  it('is a brace-expansion glob covering every manifest file plus requirements-*.txt', () => {
    const glob = manifestGlob();
    expect(glob.startsWith('**/{')).toBe(true);
    expect(glob.endsWith('}')).toBe(true);
    expect(glob).toContain('package.json');
    expect(glob).toContain('pom.xml');
    expect(glob).toContain('requirements-*.txt');
    // Lockfiles are for the watcher, not discovery — they must not widen
    // what counts as a project.
    expect(glob).not.toContain('package-lock.json');
  });
});
