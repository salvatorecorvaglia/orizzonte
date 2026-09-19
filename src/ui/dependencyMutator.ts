/**
 * Applies one dependency change: install, update, uninstall or "update all".
 *
 * All three single-package operations follow the same shape — the provider's
 * CLI command where it has one, a manifest edit as its build-or-fallback —
 * so this is the one place that shape lives, rather than three near-identical
 * copies of it in `PanelManager`.
 */

import * as vscode from 'vscode';
import type { Dependency, DepScope, Toolchain } from '../core/types.js';
import type {
  Command,
  EcosystemProvider,
  ProviderContext,
} from '../providers/provider.js';
import type { TerminalRunner } from './terminalRunner.js';

type ManifestEdit = Parameters<
  NonNullable<EcosystemProvider['editManifest']>
>[1];

/**
 * Toolchain detections shared across one batch of mutations.
 *
 * Detection is several filesystem probes — lockfiles, a virtualenv, a wrapper
 * script — and a bulk update of fifty packages in one project repeated all of
 * them fifty times over for an answer that cannot change between them. Scoped
 * to the batch rather than cached on the class, because between batches it very
 * much can: the user may have switched package manager or deleted a lockfile.
 */
export type ToolchainCache = Map<string, Toolchain>;

export class DependencyMutator {
  constructor(
    private readonly ctx: ProviderContext,
    private readonly terminal: TerminalRunner,
    /**
     * Claims the panel's busy indicator while a command runs, returning the
     * release for that claim. A claim rather than a boolean because a scan can
     * be running at the same time, and this used to turn off its spinner.
     */
    private readonly beginBusy: (label?: string) => () => void,
    /** A command ran but exited non-zero; not the same as "not applied". */
    private readonly onCommandFailed: (message: string) => void,
  ) {}

  async install(
    provider: EcosystemProvider,
    manifestPath: string,
    name: string,
    version: string | null,
    scope: DepScope,
    toolchains?: ToolchainCache,
  ): Promise<boolean> {
    const toolchain = await this.toolchainFor(
      provider,
      manifestPath,
      toolchains,
    );
    const command = provider.installCommand(toolchain, name, version, scope);
    return this.apply(provider, manifestPath, command, {
      kind: 'add',
      name,
      version,
      scope,
    });
  }

  async update(
    dep: Dependency,
    provider: EcosystemProvider,
    toVersion: string,
    toolchains?: ToolchainCache,
  ): Promise<boolean> {
    const toolchain = await this.toolchainFor(
      provider,
      dep.manifestPath,
      toolchains,
    );
    const command = provider.updateCommand(toolchain, dep, toVersion);
    return this.apply(provider, dep.manifestPath, command, {
      kind: 'update',
      name: dep.name,
      version: toVersion,
      scope: dep.scope,
    });
  }

  async uninstall(
    dep: Dependency,
    provider: EcosystemProvider,
    toolchains?: ToolchainCache,
  ): Promise<boolean> {
    const toolchain = await this.toolchainFor(
      provider,
      dep.manifestPath,
      toolchains,
    );
    const command = provider.uninstallCommand(toolchain, dep);
    return this.apply(provider, dep.manifestPath, command, {
      kind: 'remove',
      name: dep.name,
      scope: dep.scope,
    });
  }

  /** Runs the provider's bulk-update command. False when it has none. */
  async updateAll(
    provider: EcosystemProvider,
    manifestPath: string,
  ): Promise<boolean> {
    const toolchain = await provider.detectToolchain(manifestPath, this.ctx);
    const command = provider.updateAllCommand(toolchain);
    if (!command) return false;

    await this.runCommand(command.argv, command.cwd, command.description);
    return true;
  }

  /**
   * The toolchain driving `manifestPath`, reusing the batch's answer when it
   * has one. Keyed by ecosystem as well as path, since two providers can claim
   * manifests in one directory (`pyproject.toml` beside `package.json`).
   */
  private async toolchainFor(
    provider: EcosystemProvider,
    manifestPath: string,
    toolchains?: ToolchainCache,
  ): Promise<Toolchain> {
    const key = `${provider.id}::${manifestPath}`;
    const cached = toolchains?.get(key);
    if (cached) return cached;

    const toolchain = await provider.detectToolchain(manifestPath, this.ctx);
    toolchains?.set(key, toolchain);
    return toolchain;
  }

  /**
   * Runs `command` (if given) and applies a manifest edit as either its
   * build-or-fallback: the edit lands when the command does not write the
   * manifest itself, or in place of the command when there is none.
   */
  private async apply(
    provider: EcosystemProvider,
    manifestPath: string,
    command: Command | null,
    edit: ManifestEdit,
  ): Promise<boolean> {
    if (command) {
      await this.runCommand(command.argv, command.cwd, command.description);
      if (command.writesManifest === false) {
        await this.applyManifestEdit(provider, manifestPath, edit);
      }
      return true;
    }

    return this.applyManifestEdit(provider, manifestPath, edit);
  }

  /**
   * Runs one command and reports whether it failed.
   *
   * Refreshing is the caller's job, not this method's: a bulk action runs many
   * commands and should rescan the workspace once at the end rather than after
   * each package.
   *
   * A non-zero exit is surfaced. It used to be discarded, so a failed install —
   * a typo'd version, a private registry needing auth, no network — produced a
   * refresh that changed nothing and no explanation of why. `undefined` is
   * different from a failure: it means the shell reported no status at all
   * (no shell integration), which is not evidence of anything.
   */
  private async runCommand(
    argv: string[],
    cwd: string,
    description: string,
  ): Promise<void> {
    const doneBusy = this.beginBusy(description);
    let exitCode: number | undefined;
    try {
      ({ exitCode } = await this.terminal.run({ argv, cwd, description }));
    } finally {
      doneBusy();
    }

    if (exitCode !== undefined && exitCode !== 0) {
      this.onCommandFailed(
        `${argv.join(' ')} failed with exit code ${exitCode}. See the Orizzonte terminal for details.`,
      );
    }
  }

  /**
   * Applies a provider's manifest edit as a WorkspaceEdit, so it lands in the
   * undo stack and respects any unsaved buffer the user has open.
   */
  private async applyManifestEdit(
    provider: EcosystemProvider,
    manifestPath: string,
    edit: ManifestEdit,
  ): Promise<boolean> {
    if (!provider.editManifest) return false;

    const uri = vscode.Uri.file(manifestPath);
    const document = await vscode.workspace.openTextDocument(uri);
    const versionBeforeEdit = document.version;
    const wasDirty = document.isDirty;
    const updated = provider.editManifest(document.getText(), edit);
    if (updated === null) return false;

    // A whole-document replace built from a snapshot is only safe against
    // that same snapshot — guards a future `editManifest` becoming async (or
    // any other yield landing above) from silently clobbering a concurrent
    // edit that lands in the gap.
    if (document.version !== versionBeforeEdit) return false;

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(
      uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      updated,
    );
    const ok = await vscode.workspace.applyEdit(workspaceEdit);
    if (!ok) return false;

    // Only auto-save when our edit was the only change in flight. Forcing a
    // save while the user has unrelated unsaved edits open would commit those
    // too, without them having chosen to.
    if (!wasDirty) {
      await document.save();
    }
    return true;
  }
}
