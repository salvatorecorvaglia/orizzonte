/**
 * The VS Code-facing adapter that providers talk to.
 *
 * Providers are deliberately free of any `vscode` import so they stay unit
 * testable; this class supplies the file access and settings they need.
 */

import * as vscode from 'vscode';
import type { ProviderContext } from '../providers/provider.js';
import type { TtlCache } from './cache.js';
import type { HttpClient } from './http.js';
import {
  type RegistryOverrideValue,
  resolveRegistryAuthHeaders,
  resolveRegistryOverride,
} from './registryOverride.js';
import type { Ecosystem } from './types.js';

export function createProviderContext(
  http: HttpClient,
  cache: TtlCache,
): ProviderContext {
  return {
    http,
    cache,

    async readFile(absolutePath: string): Promise<string | null> {
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.file(absolutePath),
        );
        return Buffer.from(bytes).toString('utf8');
      } catch {
        return null;
      }
    },

    async exists(absolutePath: string): Promise<boolean> {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
        return true;
      } catch {
        return false;
      }
    },

    registryOverride(ecosystem: Ecosystem): string | undefined {
      // Restricted in package.json's untrustedWorkspaces.restrictedConfigurations,
      // so VS Code already withholds any workspace-scoped value here when the
      // workspace is untrusted — this only ever sees a value the user opted into.
      const overrides = vscode.workspace
        .getConfiguration('orizzonte')
        .get<Record<string, RegistryOverrideValue>>('registryOverrides', {});
      return resolveRegistryOverride(overrides, ecosystem);
    },

    registryAuthHeaders(
      ecosystem: Ecosystem,
    ): Record<string, string> | undefined {
      // Same restriction as registryOverride — this is a sub-field of the
      // same setting, not a separate one, so it inherits the same trust gate
      // without needing its own entry in restrictedConfigurations.
      const overrides = vscode.workspace
        .getConfiguration('orizzonte')
        .get<Record<string, RegistryOverrideValue>>('registryOverrides', {});
      return resolveRegistryAuthHeaders(overrides, ecosystem);
    },

    preferredToolchain(ecosystem: Ecosystem): string {
      const config = vscode.workspace.getConfiguration('orizzonte');
      if (ecosystem === 'node')
        return config.get<string>('preferredNodeManager', 'auto');
      if (ecosystem === 'python')
        return config.get<string>('pythonManager', 'auto');
      return 'auto';
    },
  };
}
