/**
 * The shared validation helpers every provider's install/update/uninstall
 * path is gated behind before a name or version reaches a shell command.
 */

import { describe, expect, it, vi } from 'vitest';
import { CargoProvider } from '../../src/providers/cargo/index.js';
import { NodeProvider } from '../../src/providers/node/index.js';
import type { EcosystemProvider } from '../../src/providers/provider.js';
import {
  isValidVersionDefault,
  normalizeScope,
  validateVersion,
} from '../../src/providers/provider.js';
import { PythonProvider } from '../../src/providers/python/index.js';

describe('isValidVersionDefault', () => {
  it('accepts the concrete target versions callers actually validate', () => {
    // Every call site (panelManager.ts's install/update handlers) validates a
    // literal target version chosen by the user, never a range — so the
    // grammar requires an alphanumeric first character even though `^`, `~`,
    // `>`, `<` etc. are all allowed later in the string.
    for (const version of [
      '1.2.3',
      'v1.2.3',
      '1.0.0-beta.1',
      '1.0.0+build.5',
      '1.2.*',
      '2024.1.15',
    ]) {
      expect(isValidVersionDefault(version)).toBe(true);
    }
  });

  it('rejects a version starting with a range operator', () => {
    // Not a hole: nothing here validates a full range string, only a
    // concrete target — a leading operator is the caller's declared-prefix
    // logic (`applyDeclaredPrefix`) reapplying it afterwards, not something
    // this grammar is meant to accept as input.
    for (const version of ['^1.2.3', '~1.2.3', '>=1.0.0', '[1.0,2.0)']) {
      expect(isValidVersionDefault(version)).toBe(false);
    }
  });

  it('rejects the characters that make shell injection possible', () => {
    // Quotes, spaces mid-token in a way that would split argv, backticks and
    // `$` are exactly what a POSIX/PowerShell/cmd payload needs.
    for (const version of [
      '1.0.0`whoami`',
      '1.0.0$(whoami)',
      '1.0.0"; rm -rf /"',
      "1.0.0'; rm -rf /'",
      '$env:PATH',
    ]) {
      expect(isValidVersionDefault(version)).toBe(false);
    }
  });

  it('rejects an empty string and one starting with punctuation', () => {
    expect(isValidVersionDefault('')).toBe(false);
    expect(isValidVersionDefault('.1.0.0')).toBe(false);
    expect(isValidVersionDefault('-1.0.0')).toBe(false);
  });

  it('rejects a bare space, which would otherwise split one argv element into two', () => {
    expect(isValidVersionDefault('>=1.0.0 <2.0.0')).toBe(false);
  });

  it('caps length at 256, the bound documented on the pattern', () => {
    expect(isValidVersionDefault(`1${'.0'.repeat(127)}`)).toBe(true); // 255 chars
    expect(isValidVersionDefault(`1${'0'.repeat(256)}`)).toBe(false); // 257 chars
  });
});

describe('validateVersion', () => {
  const withoutOverride = {} as EcosystemProvider;

  it('falls back to the shared grammar when the provider has none of its own', () => {
    expect(validateVersion(withoutOverride, '1.2.3')).toBe(true);
    expect(validateVersion(withoutOverride, '1.0.0`whoami`')).toBe(false);
  });

  it('defers to the provider’s own rule when it defines one, even if stricter', () => {
    // Maven's own rule forbids `<`/`>`, which the shared grammar allows — the
    // exact case this function exists to get right: never silently widen a
    // provider's narrower rule by falling back past it.
    const strict: EcosystemProvider = {
      ...withoutOverride,
      isValidVersion: (v: string) => /^[0-9.]+$/.test(v),
    };
    expect(validateVersion(strict, '1.2.3')).toBe(true);
    expect(validateVersion(strict, '>=1.2.3')).toBe(false);
  });

  it('defers to the provider’s own rule even when it is looser', () => {
    const loose: EcosystemProvider = {
      ...withoutOverride,
      isValidVersion: () => true,
    };
    expect(validateVersion(loose, 'anything at all')).toBe(true);
  });
});

describe('normalizeScope', () => {
  it('maps ecosystem-specific scope vocabulary onto the five shared buckets', () => {
    expect(normalizeScope('dev')).toBe('dev');
    expect(normalizeScope('development')).toBe('dev');
    expect(normalizeScope('test')).toBe('dev');
    expect(normalizeScope('testing')).toBe('dev');
    expect(normalizeScope('build')).toBe('build');
    expect(normalizeScope('provided')).toBe('build');
    expect(normalizeScope('compile-only')).toBe('build');
    expect(normalizeScope('optional')).toBe('optional');
    expect(normalizeScope('peer')).toBe('peer');
    expect(normalizeScope('peerDependencies')).toBe('peer');
    expect(normalizeScope('runtime')).toBe('prod');
    expect(normalizeScope('compile')).toBe('prod');
  });

  it('is case-insensitive', () => {
    expect(normalizeScope('DEV')).toBe('dev');
    expect(normalizeScope('Optional')).toBe('optional');
  });

  it('defaults to prod for anything unrecognised', () => {
    expect(normalizeScope('')).toBe('prod');
    expect(normalizeScope('whatever-this-is')).toBe('prod');
  });
});

/*
 * `fetchVersions` has always refused a name that is not a real one before
 * putting it in a URL. `fetchMetadata` did not — and it is reached with a
 * manifest-supplied name too, from the detail drawer and from the license
 * summary. Both now hold the same line.
 */
describe('fetchMetadata name validation', () => {
  /** A context whose http records whether it was reached at all. */
  function spyingContext() {
    const getJson = vi.fn(() => Promise.reject(new Error('should not be hit')));
    return {
      getJson,
      ctx: {
        http: { getJson } as never,
        cache: {
          get: () => undefined,
          getStale: () => undefined,
          set: () => Promise.resolve(),
        } as never,
        readFile: () => Promise.resolve(null),
        exists: () => Promise.resolve(false),
        registryOverride: () => undefined,
        registryAuthHeaders: () => undefined,
        preferredToolchain: () => 'auto',
        workspaceRootFor: () => undefined,
      },
    };
  }

  const providers: Array<[string, EcosystemProvider]> = [
    ['node', new NodeProvider()],
    ['python', new PythonProvider()],
    ['cargo', new CargoProvider()],
  ];

  for (const [label, provider] of providers) {
    it(`${label} does not put a name that is not a name into a URL`, async () => {
      const { ctx, getJson } = spyingContext();

      for (const name of [
        '../../admin',
        'has space',
        'semi;colon',
        '',
        'back\\slash',
      ]) {
        await expect(
          provider.fetchMetadata(name, ctx),
        ).resolves.toBeUndefined();
      }

      expect(getJson).not.toHaveBeenCalled();
    });

    it(`${label} still attempts a legitimate name`, async () => {
      const { ctx, getJson } = spyingContext();
      const name = label === 'cargo' ? 'serde' : 'requests';

      // Rejected by the stub, not by validation — the point is that it got
      // as far as the request.
      await provider.fetchMetadata(name, ctx);
      expect(getJson).toHaveBeenCalled();
    });
  }
});
