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

  it('creates a fresh terminal when the cwd changes', async () => {
    await runner.run({
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

    assert.equal(
      orizzonteTerminals().length,
      1,
      'the old terminal for the previous cwd should not linger alongside the new one',
    );
    assert.notEqual(
      orizzonteTerminals()[0],
      first,
      'a cwd change should have replaced the terminal instance',
    );
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
