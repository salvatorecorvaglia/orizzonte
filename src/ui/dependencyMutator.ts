/**
 * Applies one dependency change: install, update, uninstall or "update all".
 *
 * All three single-package operations follow the same shape — the provider's
 * CLI command where it has one, a manifest edit as its build-or-fallback —
 * so this is the one place that shape lives, rather than three near-identical
 * copies of it in `PanelManager`.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  isRelatedMetadata,
  matchesMutationSnapshot,
} from '../core/manifestMutationPolicy.js';
import type { MutationResult } from '../core/mutationBatch.js';

export type { MutationResult } from '../core/mutationBatch.js';

import { SerialQueue } from '../core/serialQueue.js';
import type { Dependency, DepScope, Toolchain } from '../core/types.js';
import { isUpdatable } from '../core/vocabulary.js';
import type {
  Command,
  EcosystemProvider,
  ProviderContext,
} from '../providers/provider.js';
import { providerForPath } from '../providers/registry.js';
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
  private readonly queue = new SerialQueue();
  private readonly bulkSnapshots = new WeakMap<
    Command,
    { manifestPath: string; text: string }
  >();
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
  ): Promise<MutationResult> {
    return this.queue.run(async () => {
      requireWorkspaceTrust();
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
    });
  }

  async update(
    dep: Dependency,
    provider: EcosystemProvider,
    toVersion: string,
    toolchains?: ToolchainCache,
  ): Promise<MutationResult> {
    return this.queue.run(async () => {
      requireWorkspaceTrust();
      if (
        !isUpdatable(dep) ||
        provider.canMutateDependency?.(dep, 'update') === false
      )
        return 'unsupported';
      const toolchain = await this.toolchainFor(
        provider,
        dep.manifestPath,
        toolchains,
      );
      const command = provider.updateCommand(toolchain, dep, toVersion);
      return this.apply(
        provider,
        dep.manifestPath,
        command,
        {
          kind: 'update',
          name: dep.name,
          version: toVersion,
          scope: dep.scope,
          declaration: dep.declaration,
        },
        dep,
      );
    });
  }

  async uninstall(
    dep: Dependency,
    provider: EcosystemProvider,
    toolchains?: ToolchainCache,
  ): Promise<MutationResult> {
    return this.queue.run(async () => {
      requireWorkspaceTrust();
      if (provider.canMutateDependency?.(dep, 'remove') === false)
        return 'unsupported';
      const toolchain = await this.toolchainFor(
        provider,
        dep.manifestPath,
        toolchains,
      );
      const command = provider.uninstallCommand(toolchain, dep);
      return this.apply(
        provider,
        dep.manifestPath,
        command,
        {
          kind: 'remove',
          name: dep.name,
          scope: dep.scope,
        },
        dep,
      );
    });
  }

  /**
   * The provider's bulk-update command for `manifestPath`, or null when the
   * ecosystem has none. Separate from running it so the host can word its
   * confirmation around what the command will actually do.
   */
  async bulkUpdateCommand(
    provider: EcosystemProvider,
    manifestPath: string,
  ): Promise<Command | null> {
    requireWorkspaceTrust();
    const toolchain = await provider.detectToolchain(manifestPath, this.ctx);
    const command = provider.updateAllCommand(toolchain);
    if (command) {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(manifestPath),
      );
      this.bulkSnapshots.set(command, {
        manifestPath,
        text: document.getText(),
      });
    }
    return command;
  }

  /** Runs a command from `bulkUpdateCommand`. */
  async runBulkUpdate(
    command: Command,
    manifestPath: string,
  ): Promise<MutationResult> {
    return this.queue.run(async () => {
      requireWorkspaceTrust();
      const snapshot = this.bulkSnapshots.get(command);
      const preflight = async () => {
        await this.preflight(command, manifestPath);
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.file(manifestPath),
        );
        if (
          snapshot &&
          (snapshot.manifestPath !== manifestPath ||
            document.getText() !== snapshot.text)
        )
          throw new Error(
            'The manifest changed after the bulk update was prepared. Refresh and retry.',
          );
      };
      await preflight();
      return this.runCommand(
        command.argv,
        command.cwd,
        command.description,
        preflight,
      );
    });
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
   *
   * Unsupported means the manifest cannot be edited and the user has to
   * make it by hand — including when the command ran but the paired edit
   * could not be made (pip beside a pyproject.toml), which used to report
   * success and leave the manifest silently out of step with the environment.
   * A command that *failed* is not followed by its edit: recording a package
   * the install just refused would leave the manifest claiming it anyway.
   */
  private async apply(
    provider: EcosystemProvider,
    manifestPath: string,
    command: Command | null,
    edit: ManifestEdit,
    original?: Dependency,
  ): Promise<MutationResult> {
    requireWorkspaceTrust();
    let snapshot:
      | { document: vscode.TextDocument; version: number }
      | undefined;
    if (command?.writesManifest === false) {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(manifestPath),
      );
      if (
        !provider.editManifest ||
        provider.editManifest(
          document.getText(),
          edit,
          path.basename(manifestPath),
        ) === null
      )
        return 'unsupported';
      snapshot = { document, version: document.version };
    }
    const preflight = command
      ? () => this.preflight(command, manifestPath, provider, original)
      : undefined;
    if (preflight) await preflight();
    if (command) {
      const outcome = await this.runCommand(
        command.argv,
        command.cwd,
        command.description,
        preflight,
      );
      if (outcome !== 'applied' || command.writesManifest !== false)
        return outcome;
      if (snapshot && snapshot.document.version !== snapshot.version) {
        this.onCommandFailed(
          'The manifest changed while the command ran. Review it before applying the change.',
        );
        return 'failed';
      }
    }
    return this.applyManifestEdit(provider, manifestPath, edit);
  }

  /** Validate again at terminal dispatch, after any shell startup or queue wait. */
  private async preflight(
    command: Command,
    manifestPath: string,
    provider?: EcosystemProvider,
    original?: Dependency,
  ): Promise<void> {
    requireWorkspaceTrust();
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(manifestPath),
    );
    const activeProvider = provider ?? providerForPath(manifestPath);
    const documents = new Set([
      document,
      ...(vscode.workspace.textDocuments ?? []),
    ]);
    for (const open of documents) {
      const file = open.uri?.fsPath;
      const relatedMetadata =
        file &&
        activeProvider &&
        isRelatedMetadata(file, command.cwd, activeProvider);
      if (open === document || relatedMetadata) {
        if (open.isDirty)
          throw new Error(
            'Save the manifest and related project files before running a package manager, then retry the operation.',
          );
      }
    }
    if (!original || !provider) return;
    const version = document.version;
    const manifest = await provider.parse(
      manifestPath,
      document.getText(),
      this.ctx,
    );
    const current = manifest.dependencies.find(
      (dep) => dep.key === original.key,
    );
    // Legacy callers without declaration metadata are checked for CLI-backed
    // manifest writes; parsed Python requirements are always checked.
    if (
      (command.writesManifest !== false || original.pythonRequirement) &&
      !matchesMutationSnapshot(current, original)
    ) {
      throw new Error(
        'The dependency declaration changed since the last scan. Refresh and retry the operation.',
      );
    }
    if (document.isDirty || document.version !== version)
      throw new Error(
        'The manifest changed during validation. Refresh and retry the operation.',
      );
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
    preflight?: () => Promise<void>,
  ): Promise<MutationResult> {
    const doneBusy = this.beginBusy(description);
    let exitCode: number | undefined;
    try {
      ({ exitCode } = await this.terminal.run(
        { argv, cwd, description },
        preflight,
      ));
    } finally {
      doneBusy();
    }

    if (exitCode !== undefined && exitCode !== 0) {
      this.onCommandFailed(
        `${argv.join(' ')} failed with exit code ${exitCode}. See the Orizzonte terminal for details.`,
      );
      return 'failed';
    }
    if (exitCode === undefined) {
      this.onCommandFailed(
        'Command completion could not be verified. Use the Orizzonte terminal to review or run the command, then refresh. Automatic follow-up edits were not applied.',
      );
      return 'pending';
    }
    return 'applied';
  }

  /**
   * Applies a provider's manifest edit as a WorkspaceEdit, so it lands in the
   * undo stack and respects any unsaved buffer the user has open.
   */
  private async applyManifestEdit(
    provider: EcosystemProvider,
    manifestPath: string,
    edit: ManifestEdit,
  ): Promise<MutationResult> {
    if (!provider.editManifest) return 'unsupported';

    const uri = vscode.Uri.file(manifestPath);
    const document = await vscode.workspace.openTextDocument(uri);
    const versionBeforeEdit = document.version;
    const wasDirty = document.isDirty;
    const updated = provider.editManifest(
      document.getText(),
      edit,
      path.basename(manifestPath),
    );
    if (updated === null) return 'unsupported';

    // A whole-document replace built from a snapshot is only safe against
    // that same snapshot — guards a future `editManifest` becoming async (or
    // any other yield landing above) from silently clobbering a concurrent
    // edit that lands in the gap.
    if (document.version !== versionBeforeEdit) return 'unsupported';

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(
      uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      updated,
    );
    const ok = await vscode.workspace.applyEdit(workspaceEdit);
    if (!ok) return 'unsupported';

    // Only auto-save when our edit was the only change in flight. Forcing a
    // save while the user has unrelated unsaved edits open would commit those
    // too, without them having chosen to.
    if (!wasDirty) {
      if (!(await document.save())) return 'failed';
    }
    return 'applied';
  }
}

function requireWorkspaceTrust(): void {
  if (!vscode.workspace.isTrusted)
    throw new Error(
      'Trust this workspace before changing dependencies or running package managers.',
    );
}
