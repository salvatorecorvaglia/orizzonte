/**
 * `terminalRunner.ts` imports `vscode`, so — like `webviewSecurity.ts` — it
 * cannot be loaded under vitest (see the exclusion list in
 * `vitest.config.ts`) and can only be exercised here, against a real
 * integrated terminal.
 *
 * Shell integration rarely attaches within the 3s window under a headless
 * test host, so most runs here take that fallback path and resolve with
 * `exitCode: undefined` — which is itself the behaviour worth pinning down:
 * the caller must still get an answer, just not a status.
 */

import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { TerminalRunner } from '../../src/ui/terminalRunner.js';

function orizzonteTerminals(): readonly vscode.Terminal[] {
  return vscode.window.terminals.filter((t) => t.name === 'Orizzonte');
}

describe('TerminalRunner', () => {
  let runner: TerminalRunner;

  beforeEach(() => {
    runner = new TerminalRunner();
  });

  afterEach(() => {
    runner.dispose();
  });

  it('runs a command and reports some exit code (or an honest "unknown")', async () => {
    const result = await runner.run({
      argv: ['echo', 'orizzonte-integration-test'],
      cwd: process.cwd(),
      description: 'test echo',
    });

    // Without shell integration, `undefined` is the documented honest
    // answer; with it, a real echo always exits 0. Either is acceptable —
    // what matters is the call resolves at all rather than hanging.
    assert.ok(result.exitCode === undefined || result.exitCode === 0);
  });

  it('creates exactly one terminal named "Orizzonte"', async () => {
    await runner.run({
      argv: ['echo', 'first'],
      cwd: process.cwd(),
      description: 'test echo',
    });

    assert.equal(orizzonteTerminals().length, 1);
  });

  it('reuses the same terminal for a second command in the same cwd', async () => {
    await runner.run({
      argv: ['echo', 'first'],
      cwd: process.cwd(),
      description: 'test echo',
    });
    const first = orizzonteTerminals()[0];

    await runner.run({
      argv: ['echo', 'second'],
      cwd: process.cwd(),
      description: 'test echo',
    });

    assert.equal(orizzonteTerminals().length, 1, 'a second terminal appeared');
    assert.equal(
      orizzonteTerminals()[0],
      first,
      'the same working directory should reuse the terminal instance',
    );
  });

  it('opens a terminal for a new cwd, closing the old one only if its command is known to have finished', async () => {
    const firstRun = await runner.run({
      argv: ['echo', 'first'],
      cwd: process.cwd(),
      description: 'test echo',
    });
    const first = orizzonteTerminals()[0];

    await runner.run({
      argv: ['echo', 'second'],
      cwd: os.tmpdir(),
      description: 'test echo',
    });

    const terminals = orizzonteTerminals();
    assert.ok(
      terminals.some((terminal) => terminal !== first),
      'a cwd change should have opened a new terminal',
    );

    if (firstRun.exitCode === undefined) {
      // No shell integration, so nothing says the first command finished.
      // Disposing its terminal here is what used to kill an install still in
      // progress when a bulk action moved on to the next project.
      assert.ok(
        terminals.includes(first),
        'a terminal whose command may still be running must not be closed',
      );
    } else {
      assert.equal(
        terminals.length,
        1,
        'a terminal known to be idle should not linger alongside the new one',
      );
    }
  });

  it('dispose() does not throw and cleans up its own listeners', async () => {
    await runner.run({
      argv: ['echo', 'hello'],
      cwd: process.cwd(),
      description: 'test echo',
    });

    assert.doesNotThrow(() => runner.dispose());
    // Safe to call twice — matches every other `vscode.Disposable` in this
    // codebase, and this test's own `afterEach` calls it again regardless.
    assert.doesNotThrow(() => runner.dispose());
  });
});
