/**
 * `resolveRegistryOverride`: alias resolution, trimming, and the http(s)-only
 * scheme check that keeps `orizzonte.registryOverrides` from sending a
 * malformed or exotic URL straight to `fetch()`.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveRegistryAuthHeaders,
  resolveRegistryOverride,
} from '../../src/core/registryOverride.js';

describe('resolveRegistryOverride', () => {
  it('returns undefined when nothing is configured for the ecosystem', () => {
    expect(resolveRegistryOverride({}, 'cargo')).toBeUndefined();
    expect(
      resolveRegistryOverride({ cargo: 'https://cargo.internal' }, 'maven'),
    ).toBeUndefined();
  });

  it('matches the ecosystem id directly for ecosystems with no alias', () => {
    expect(
      resolveRegistryOverride({ cargo: 'https://cargo.internal' }, 'cargo'),
    ).toBe('https://cargo.internal');
  });

  it('accepts the common alias so users need not know the internal id', () => {
    expect(
      resolveRegistryOverride({ npm: 'https://npm.internal' }, 'node'),
    ).toBe('https://npm.internal');
    expect(
      resolveRegistryOverride({ pypi: 'https://pypi.internal' }, 'python'),
    ).toBe('https://pypi.internal');
  });

  it('prefers the internal id over the alias when both are set', () => {
    expect(
      resolveRegistryOverride(
        { node: 'https://node-wins.internal', npm: 'https://alias.internal' },
        'node',
      ),
    ).toBe('https://node-wins.internal');
  });

  it('strips one or more trailing slashes', () => {
    expect(
      resolveRegistryOverride({ cargo: 'https://cargo.internal/' }, 'cargo'),
    ).toBe('https://cargo.internal');
    expect(
      resolveRegistryOverride({ cargo: 'https://cargo.internal//' }, 'cargo'),
    ).toBe('https://cargo.internal');
  });

  it('trims surrounding whitespace', () => {
    expect(
      resolveRegistryOverride({ cargo: '  https://cargo.internal  ' }, 'cargo'),
    ).toBe('https://cargo.internal');
  });

  it('accepts http as well as https', () => {
    expect(
      resolveRegistryOverride({ cargo: 'http://cargo.internal' }, 'cargo'),
    ).toBe('http://cargo.internal');
  });

  it('rejects a non-http(s) scheme rather than passing it to fetch()', () => {
    expect(
      resolveRegistryOverride({ cargo: 'file:///etc/passwd' }, 'cargo'),
    ).toBeUndefined();
    expect(
      resolveRegistryOverride({ cargo: 'javascript:alert(1)' }, 'cargo'),
    ).toBeUndefined();
    expect(
      resolveRegistryOverride({ cargo: 'ftp://cargo.internal' }, 'cargo'),
    ).toBeUndefined();
  });

  it('rejects a value that is not a URL at all', () => {
    expect(
      resolveRegistryOverride({ cargo: 'not a url' }, 'cargo'),
    ).toBeUndefined();
    expect(resolveRegistryOverride({ cargo: '' }, 'cargo')).toBeUndefined();
  });

  it('reads the URL out of the object form the same way as the bare string', () => {
    expect(
      resolveRegistryOverride(
        { cargo: { url: 'https://cargo.internal/', tokenEnvVar: 'X' } },
        'cargo',
      ),
    ).toBe('https://cargo.internal');
  });
});

describe('resolveRegistryAuthHeaders', () => {
  it('returns undefined when no override is configured', () => {
    expect(resolveRegistryAuthHeaders({}, 'cargo')).toBeUndefined();
  });

  it('returns undefined for a bare-string override with no token', () => {
    expect(
      resolveRegistryAuthHeaders({ cargo: 'https://cargo.internal' }, 'cargo'),
    ).toBeUndefined();
  });

  it('returns undefined when tokenEnvVar is set but the variable is not', () => {
    expect(
      resolveRegistryAuthHeaders(
        {
          cargo: {
            url: 'https://cargo.internal',
            tokenEnvVar: 'MISSING_TOKEN',
          },
        },
        'cargo',
        {},
      ),
    ).toBeUndefined();
  });

  it('returns undefined for an empty or whitespace-only token', () => {
    expect(
      resolveRegistryAuthHeaders(
        { cargo: { url: 'https://cargo.internal', tokenEnvVar: 'TOK' } },
        'cargo',
        { TOK: '   ' },
      ),
    ).toBeUndefined();
  });

  it('builds a Bearer Authorization header from the named environment variable', () => {
    expect(
      resolveRegistryAuthHeaders(
        { cargo: { url: 'https://cargo.internal', tokenEnvVar: 'TOK' } },
        'cargo',
        { TOK: 'secret-value' },
      ),
    ).toEqual({ Authorization: 'Bearer secret-value' });
  });

  it('resolves through the ecosystem alias, matching resolveRegistryOverride', () => {
    expect(
      resolveRegistryAuthHeaders(
        { npm: { url: 'https://npm.internal', tokenEnvVar: 'TOK' } },
        'node',
        { TOK: 'secret-value' },
      ),
    ).toEqual({ Authorization: 'Bearer secret-value' });
  });

  it('never sends a token alongside a URL that fails its own scheme check', () => {
    // A malformed override URL means the caller falls back to the *public*
    // registry — a token must not ride along to wherever that ends up.
    expect(
      resolveRegistryAuthHeaders(
        { cargo: { url: 'ftp://cargo.internal', tokenEnvVar: 'TOK' } },
        'cargo',
        { TOK: 'secret-value' },
      ),
    ).toBeUndefined();
  });
});
