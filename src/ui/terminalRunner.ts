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
  private terminalCwd: string | undefined;

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
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === this.terminal) {
          for (const cancel of [...this.pending]) cancel();
          this.terminal = undefined;
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
  run(command: Command): Promise<{ exitCode: number | undefined }> {
    return this.queue.run(() => this.execute(command));
  }

  private async execute(
    command: Command,
  ): Promise<{ exitCode: number | undefined }> {
    if (this.disposed)
      throw new Error('The terminal runner has been disposed.');
    if (!vscode.workspace.isTrusted)
      throw new Error('Trust this workspace before running package managers.');
    const terminal = this.ensureTerminal(command.cwd);
    terminal.show(true);

    // Shell integration can take a moment to attach to a freshly created
    // terminal; a short wait avoids needlessly falling back on the first run.
    const integration = await this.waitForShellIntegration(terminal, 3000);

    if (this.disposed || this.terminal !== terminal)
      return { exitCode: undefined };
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

    /*
     * With shell integration, hand over argv and let VS Code quote it.
     *
     * It knows which shell the terminal is actually running, which is the one
     * thing `detectShell` can only infer — so this removes the guess from the
     * path that covers almost every run, rather than making the guess better.
     */
    const [executable, ...args] = command.argv;
    const execution = integration.executeCommand(executable, args);

    return new Promise((resolve) => {
      const finish = (exitCode?: number) => {
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

  private ensureTerminal(cwd: string): vscode.Terminal {
    if (this.terminal && !this.lastCommandSettled)
      throw new Error(
        'The previous command has no verified completion. Review and close the Orizzonte terminal before starting another managed operation.',
      );
    // Reuse the terminal unless the working directory changed — a monorepo can
    // target several packages in one session.
    if (this.terminal && this.terminalCwd === cwd) {
      return this.terminal;
    }
    this.terminal?.dispose();
    this.lastCommandSettled = true;
    this.terminalCwd = cwd;
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
    if (terminal.shellIntegration) {
      return terminal.shellIntegration;
    }

    return new Promise((resolve) => {
      const finish = (integration?: vscode.TerminalShellIntegration) => {
        listener.dispose();
        clearTimeout(timer);
        this.pending.delete(cancel);
        resolve(integration);
      };
      const cancel = () => finish();
      const listener = vscode.window.onDidChangeTerminalShellIntegration(
        (event) => {
          if (event.terminal === terminal) finish(event.shellIntegration);
        },
      );
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
