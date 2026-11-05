/**
 * Runs package-manager commands in a visible integrated terminal.
 *
 * Visible on purpose: you can watch what Orizzonte does, interrupt it, and
 * answer any prompt the tool raises (npm 2FA, private-registry auth, Poetry
 * keyring). None of that works with a hidden child process.
 *
 * Commands arrive as argv arrays and are quoted in `quoting.ts` — no caller ever
 * builds a shell string, so nothing typed into the UI can be interpreted as
 * shell syntax.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { SerialQueue } from '../core/serialQueue.js';
import type { Command } from '../providers/provider.js';
import { buildCommandLine, detectShell } from './quoting.js';

const TERMINAL_NAME = 'Orizzonte';

export class TerminalRunner implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private disposed = false;
  private readonly pending = new Set<() => void>();
  private readonly disposables: vscode.Disposable[] = [];

  /** See `SerialQueue`: one terminal cannot run two commands at once. */
  private readonly queue = new SerialQueue();

  /** The directory the current terminal was opened in, so it can be reused. */
  private readonly activeExecutions = new Set<vscode.TerminalShellExecution>();

  /**
   * Whether the current terminal's last command is known to have finished.
   *
   * Without shell integration a command is prepared for manual execution.
   * Block further managed commands until that terminal is closed, since the
   * user may have started it and its completion cannot be verified.
   */
  private lastCommandSettled = true;

  constructor(private readonly completionTimeoutMs = 10 * 60 * 1000) {
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        if (event.terminal === this.terminal)
          this.activeExecutions.add(event.execution);
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.terminal === this.terminal)
          this.activeExecutions.delete(event.execution);
      }),
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === this.terminal) {
          for (const cancel of [...this.pending]) cancel();
          this.terminal = undefined;
          this.activeExecutions.clear();
          this.lastCommandSettled = true;
        }
      }),
    );
  }

  /**
   * Runs `command` once every command queued before it has finished.
   *
   * With shell integration we get the real exit code. Without it (an unsupported
   * shell, or integration still starting up) we prepare a command for manual execution and
   * report `undefined`. A subsequent managed command is blocked until the user
   * closes that terminal.
   */
  run(
    command: Command,
    beforeExecute?: () => Promise<void>,
  ): Promise<{ exitCode: number | undefined }> {
    return this.queue.run(() => this.execute(command, beforeExecute));
  }

  private async execute(
    command: Command,
    beforeExecute?: () => Promise<void>,
  ): Promise<{ exitCode: number | undefined }> {
    if (this.disposed)
      throw new Error('The terminal runner has been disposed.');
    if (!vscode.workspace.isTrusted)
      throw new Error('Trust this workspace before running package managers.');
    let terminal = this.ensureTerminal(command.cwd);
    terminal.show(true);

    // Shell integration can take a moment to attach to a freshly created
    // terminal; a short wait avoids needlessly falling back on the first run.
    let integration = await this.waitForShellIntegration(terminal, 3000);
    if (integration && !this.matchesCwd(integration, command.cwd)) {
      terminal = this.ensureTerminal(command.cwd, true);
      terminal.show(true);
      integration = await this.waitForShellIntegration(terminal, 3000);
      if (integration && !this.matchesCwd(integration, command.cwd)) {
        throw new Error(
          'Cannot verify the terminal working directory. Close the Orizzonte terminal and retry.',
        );
      }
    }
    this.requireIdle();
    await beforeExecute?.();
    this.requireIdle();
    if (integration && !this.matchesCwd(integration, command.cwd)) {
      throw new Error(
        'The terminal working directory changed before execution. Retry the operation.',
      );
    }

    if (this.disposed || this.terminal !== terminal)
      return { exitCode: undefined };
    if (!vscode.workspace.isTrusted)
      throw new Error('Trust this workspace before running package managers.');
    if (!integration) {
      // Prepare a command for manual review without executing it: there is no
      // reliable completion signal for paired edits or another queued command.
      terminal.sendText(
        buildCommandLine(command.argv, detectShell(vscode.env.shell)),
        false,
      );
      this.lastCommandSettled = false;
      return { exitCode: undefined };
    }

    // The argv overload only applies weak escaping. Use our literal quoting
    // with the shell the terminal reports, including requirement marker strings.
    const shell = terminal.state?.shell;
    if (
      !shell ||
      !/^(?:bash|zsh|sh|ksh|fish|gitbash|pwsh|powershell|cmd)$/.test(shell)
    ) {
      throw new Error(
        'Cannot verify the terminal shell. Select a supported shell profile and retry.',
      );
    }
    const execution = integration.executeCommand(
      buildCommandLine(
        command.argv,
        shell === 'gitbash' ? 'posix' : detectShell(shell),
      ),
    );

    return new Promise((resolve) => {
      let settled = false;
      const finish = (exitCode?: number) => {
        if (settled) return;
        settled = true;
        listener.dispose();
        clearTimeout(timeout);
        this.pending.delete(cancel);
        this.lastCommandSettled = exitCode !== undefined;
        // Let the shell-integration end event finish updating the terminal
        // before a queued operation tries to start its next command.
        if (exitCode !== undefined) setImmediate(() => resolve({ exitCode }));
        else resolve({ exitCode });
      };
      const cancel = () => finish();
      const listener = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) finish(event.exitCode);
      });
      const timeout = setTimeout(cancel, this.completionTimeoutMs);
      this.pending.add(cancel);
    });
  }

  private matchesCwd(
    integration: vscode.TerminalShellIntegration | undefined,
    cwd: string,
  ): boolean {
    return (
      integration?.cwd?.scheme === 'file' &&
      path.relative(path.resolve(cwd), path.resolve(integration.cwd.fsPath)) ===
        ''
    );
  }

  private requireIdle(): void {
    if (this.activeExecutions.size > 0)
      throw new Error(
        'Another command is running in the Orizzonte terminal. Wait for it to finish before retrying.',
      );
  }

  private ensureTerminal(cwd: string, force = false): vscode.Terminal {
    this.requireIdle();
    if (this.terminal && !this.lastCommandSettled)
      throw new Error(
        'The previous command has no verified completion. Review and close the Orizzonte terminal before starting another managed operation.',
      );
    // Reuse the terminal unless the working directory changed — a monorepo can
    // target several packages in one session.
    if (
      !force &&
      this.terminal &&
      this.matchesCwd(this.terminal.shellIntegration, cwd)
    ) {
      return this.terminal;
    }
    this.terminal?.dispose();
    this.lastCommandSettled = true;
    this.activeExecutions.clear();
    this.terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      cwd,
      iconPath: new vscode.ThemeIcon('package'),
    });
    return this.terminal;
  }

  private async waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs: number,
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration?.cwd && terminal.state?.shell) {
      return terminal.shellIntegration;
    }

    return new Promise((resolve) => {
      const finish = (integration?: vscode.TerminalShellIntegration) => {
        listener.dispose();
        clearTimeout(timer);
        clearInterval(poll);
        this.pending.delete(cancel);
        resolve(integration);
      };
      const cancel = () => finish(terminal.shellIntegration);
      const listener = vscode.window.onDidChangeTerminalShellIntegration(
        (event) => {
          if (
            event.terminal === terminal &&
            event.shellIntegration.cwd &&
            terminal.state?.shell
          )
            finish(event.shellIntegration);
        },
      );
      // Integration attaches before its first prompt reports cwd and shell.
      // Those fields may update without another integration-change event.
      const poll = setInterval(() => {
        if (terminal.shellIntegration?.cwd && terminal.state?.shell)
          finish(terminal.shellIntegration);
      }, 50);
      const timer = setTimeout(cancel, timeoutMs);
      this.pending.add(cancel);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of [...this.pending]) cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.terminal?.dispose();
  }
}
