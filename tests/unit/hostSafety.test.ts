import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => {
  const closed = new Set<(terminal: unknown) => void>();
  const ended = new Set<
    (event: { execution: unknown; exitCode?: number }) => void
  >();
  const integrated = new Set<
    (event: { terminal: unknown; shellIntegration: unknown }) => void
  >();
  const document = {
    text: 'pkg==1\n',
    version: 1,
    isDirty: false,
    lineCount: 1,
    getText: () => document.text,
    save: vi.fn(async () => true),
  };
  const terminal = {
    shellIntegration: undefined as
      | { executeCommand: ReturnType<typeof vi.fn> }
      | undefined,
    show: vi.fn(),
    sendText: vi.fn(),
    dispose: vi.fn(),
  };
  const workspace = {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: '/p' } }],
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
    getWorkspaceFolder: () => ({ uri: { fsPath: '/p' } }),
    findFiles: vi.fn(async () => [{ fsPath: '/p/package.json' }]),
    openTextDocument: vi.fn(async () => document),
    applyEdit: vi.fn(async (edit: { updates: string[] }) => {
      document.text = edit.updates.at(-1) ?? document.text;
      document.version++;
      return true;
    }),
  };
  const window = {
    createTerminal: vi.fn(() => terminal),
    onDidCloseTerminal: (fn: (terminal: unknown) => void) => {
      closed.add(fn);
      return { dispose: () => closed.delete(fn) };
    },
    onDidEndTerminalShellExecution: (
      fn: (event: { execution: unknown; exitCode?: number }) => void,
    ) => {
      ended.add(fn);
      return { dispose: () => ended.delete(fn) };
    },
    onDidChangeTerminalShellIntegration: (
      fn: (event: { terminal: unknown; shellIntegration: unknown }) => void,
    ) => {
      integrated.add(fn);
      return { dispose: () => integrated.delete(fn) };
    },
  };
  return { workspace, window, document, terminal, closed, ended, integrated };
});

vi.mock('vscode', () => ({
  workspace: host.workspace,
  window: host.window,
  env: { shell: '/bin/sh' },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  ThemeIcon: class {},
  Range: class {},
  WorkspaceEdit: class {
    updates: string[] = [];
    replace(_uri: unknown, _range: unknown, text: string) {
      this.updates.push(text);
    }
  },
}));

import { Scanner } from '../../src/core/scanner.js';
import type { Dependency, ProjectGroup } from '../../src/core/types.js';
import { PythonProvider } from '../../src/providers/python/index.js';
import { DependencyMutator } from '../../src/ui/dependencyMutator.js';
import { PanelInspections } from '../../src/ui/panel/inspections.js';
import { TerminalRunner } from '../../src/ui/terminalRunner.js';
import { makeContext } from './helpers.js';

function dependency(overrides: Partial<Dependency> = {}): Dependency {
  return {
    key: 'pkg',
    name: 'pkg',
    ecosystem: 'node',
    scope: 'prod',
    declared: '1.0.0',
    installed: '1.0.0',
    updateKind: 'none',
    manifestPath: '/p/package.json',
    projectLabel: 'app',
    vulnerabilities: [],
    ...overrides,
  };
}
function group(dep = dependency()): ProjectGroup {
  return {
    label: 'app',
    manifestPath: dep.manifestPath,
    ecosystem: dep.ecosystem,
    toolchain: 'npm',
    dependencies: [dep],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  host.workspace.isTrusted = true;
  host.document.text = 'pkg==1\n';
  host.document.version = 1;
  host.document.isDirty = false;
  host.terminal.shellIntegration = undefined;
});
afterEach(() => vi.useRealTimers());

describe('managed command lifecycle', () => {
  it('prepares a manual command without executing or starting another operation', async () => {
    vi.useFakeTimers();
    const runner = new TerminalRunner();
    try {
      const result = runner.run({
        argv: ['echo', 'safe'],
        cwd: '/p',
        description: 'test',
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await result).toEqual({ exitCode: undefined });
      expect(host.terminal.sendText).toHaveBeenCalledWith('echo safe', false);
      await expect(
        runner.run({
          argv: ['echo', 'next'],
          cwd: '/other',
          description: 'test',
        }),
      ).rejects.toThrow('previous command');
      expect(host.terminal.sendText).toHaveBeenCalledTimes(1);
    } finally {
      runner.dispose();
    }
  });
  it('returns the actual command failure', async () => {
    const execution = {};
    const executeCommand = vi.fn(() => execution);
    host.terminal.shellIntegration = { executeCommand };
    const runner = new TerminalRunner();
    try {
      const result = runner.run({
        argv: ['npm', 'install'],
        cwd: '/p',
        description: 'test',
      });
      await vi.waitFor(() => expect(executeCommand).toHaveBeenCalled());
      for (const listener of host.ended) listener({ execution, exitCode: 7 });
      expect(await result).toEqual({ exitCode: 7 });
      expect(host.ended.size).toBe(0);
    } finally {
      runner.dispose();
    }
  });
  it('settles immediately when an executing terminal closes', async () => {
    const executeCommand = vi.fn(() => ({}));
    host.terminal.shellIntegration = { executeCommand };
    const runner = new TerminalRunner();
    try {
      const result = runner.run({
        argv: ['npm', 'install'],
        cwd: '/p',
        description: 'test',
      });
      await vi.waitFor(() => expect(executeCommand).toHaveBeenCalled());
      for (const listener of host.closed) listener(host.terminal);
      expect(await result).toEqual({ exitCode: undefined });
      expect(host.ended.size).toBe(0);
    } finally {
      runner.dispose();
    }
  });
  it('treats a missing execution-end event as unverified and blocks follow-up work', async () => {
    vi.useFakeTimers();
    host.terminal.shellIntegration = { executeCommand: vi.fn(() => ({})) };
    const runner = new TerminalRunner(20);
    try {
      const result = runner.run({
        argv: ['echo'],
        cwd: '/p',
        description: 'test',
      });
      await vi.advanceTimersByTimeAsync(30);
      expect(await result).toEqual({ exitCode: undefined });
      expect(host.ended.size).toBe(0);
      await expect(
        runner.run({ argv: ['echo'], cwd: '/p', description: 'test' }),
      ).rejects.toThrow('previous command');
    } finally {
      runner.dispose();
    }
  });
  it('cancels startup waits and rejects queued work after disposal', async () => {
    vi.useFakeTimers();
    const runner = new TerminalRunner();
    const first = runner.run({
      argv: ['echo'],
      cwd: '/p',
      description: 'test',
    });
    await vi.advanceTimersByTimeAsync(1);
    runner.dispose();
    expect(await first).toEqual({ exitCode: undefined });
    await expect(
      runner.run({ argv: ['echo'], cwd: '/p', description: 'test' }),
    ).rejects.toThrow('disposed');
    expect(host.integrated.size).toBe(0);
    expect(host.terminal.sendText).not.toHaveBeenCalled();
  });
});

describe('mutation safety', () => {
  function mutator(exitCode?: number) {
    const terminal = { run: vi.fn(async () => ({ exitCode })) };
    const failed = vi.fn();
    return {
      value: new DependencyMutator(
        makeContext(),
        terminal as unknown as TerminalRunner,
        () => () => undefined,
        failed,
      ),
      terminal,
      failed,
    };
  }
  it('blocks untrusted mutations before detecting or executing a tool', async () => {
    host.workspace.isTrusted = false;
    const { value, terminal } = mutator(0);
    await expect(
      value.install(
        new PythonProvider(),
        '/p/requirements.txt',
        'pkg',
        '2',
        'prod',
      ),
    ).rejects.toThrow('Trust');
    expect(terminal.run).not.toHaveBeenCalled();
  });
  it('preflights unsupported pyproject and hash edits before running pip', async () => {
    const { value, terminal } = mutator(0);
    expect(
      await value.install(
        new PythonProvider(),
        '/p/pyproject.toml',
        'pkg',
        '2',
        'prod',
      ),
    ).toBe('unsupported');
    host.document.text = 'pkg==1 --hash=sha256:aaa\n';
    expect(
      await value.update(
        dependency({
          ecosystem: 'python',
          manifestPath: '/p/requirements.txt',
        }),
        new PythonProvider(),
        '2',
      ),
    ).toBe('unsupported');
    expect(terminal.run).not.toHaveBeenCalled();
  });
  it.each([undefined, 1])(
    'never follows an unknown or failed install with a manifest edit',
    async (exitCode) => {
      const { value, failed } = mutator(exitCode);
      const result = await value.update(
        dependency({
          ecosystem: 'python',
          manifestPath: '/p/requirements.txt',
        }),
        new PythonProvider(),
        '2',
      );
      expect(result).toBe(exitCode === undefined ? 'pending' : 'failed');
      expect(host.workspace.applyEdit).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalled();
    },
  );
  it('serializes manifest changes across separate mutation requests', async () => {
    const { value, terminal } = mutator(0);
    let finish: (result: { exitCode: number }) => void = () => undefined;
    terminal.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const dep = dependency({
      ecosystem: 'python',
      manifestPath: '/p/requirements.txt',
    });
    const first = value.update(dep, new PythonProvider(), '2');
    const second = value.update(dep, new PythonProvider(), '3');
    await vi.waitFor(() => expect(terminal.run).toHaveBeenCalledTimes(1));
    finish({ exitCode: 0 });
    expect(await first).toBe('applied');
    expect(await second).toBe('applied');
    expect(host.document.text).toBe('pkg==3\n');
  });
  it('preserves user edits made while a command is running', async () => {
    const { value, terminal } = mutator(0);
    let finish: (result: { exitCode: number }) => void = () => undefined;
    terminal.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = value.update(
      dependency({ ecosystem: 'python', manifestPath: '/p/requirements.txt' }),
      new PythonProvider(),
      '2',
    );
    await vi.waitFor(() => expect(terminal.run).toHaveBeenCalled());
    host.document.text = 'pkg==1\n# user edit\n';
    host.document.version++;
    finish({ exitCode: 0 });
    expect(await result).toBe('failed');
    expect(host.workspace.applyEdit).not.toHaveBeenCalled();
    expect(host.document.text).toContain('# user edit');
  });
  it('applies a requirements edit after a verified successful command', async () => {
    const { value } = mutator(0);
    expect(
      await value.update(
        dependency({
          ecosystem: 'python',
          manifestPath: '/p/requirements.txt',
        }),
        new PythonProvider(),
        '2',
      ),
    ).toBe('applied');
    expect(host.document.text).toBe('pkg==2\n');
  });
});

describe('scan and inspection boundaries', () => {
  it('marks an unreachable registry stale and an unaudited scan not run', async () => {
    const scanner = new Scanner(
      makeContext(
        { '/p/package.json': '{"dependencies":{"pkg":"1.0.0"}}' },
        '/p',
      ),
    );
    const result = await scanner.scan({ checkUpdates: true, audit: false });
    expect(result.summary).toMatchObject({
      stale: true,
      auditStatus: 'notRun',
    });
    expect(result.groups[0].dependencies[0].lookupFailed).toBe(true);
  });
  it('reports malformed manifests as skipped files', async () => {
    const scanner = new Scanner(
      makeContext({ '/p/package.json': '{broken' }, '/p'),
    );
    expect(
      (await scanner.scan({ checkUpdates: false, audit: false })).manifestPaths,
    ).toEqual([]);
    expect(scanner.unreadableManifests).toEqual(['/p/package.json']);
  });
  it('propagates cancellation during registry enrichment', async () => {
    const ctx = makeContext(
      { '/p/package.json': '{"dependencies":{"pkg":"1.0.0"}}' },
      '/p',
    );
    ctx.http.getJson = vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    ) as typeof ctx.http.getJson;
    const scanner = new Scanner(ctx);
    const result = scanner.scan({ checkUpdates: true, audit: false });
    await vi.waitFor(() => expect(ctx.http.getJson).toHaveBeenCalled());
    scanner.cancel();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not query private package metadata from details or license inspection', async () => {
    const ctx = makeContext();
    const getJson = vi.spyOn(ctx.http, 'getJson');
    const project = group(dependency({ source: 'private' }));
    const inspector = new PanelInspections(
      ctx,
      new Scanner(ctx),
      vi.fn(),
      () => ({
        groups: [project],
        manifestPaths: [project.manifestPath],
        manifests: [],
        summary: {
          totalDependencies: 1,
          outdated: 0,
          vulnerable: 0,
          deprecated: 0,
          stale: false,
        },
      }),
      vi.fn(),
    );
    await inspector.handleDetails('pkg');
    await inspector.handleLicenses('license');
    expect(getJson).not.toHaveBeenCalled();
    inspector.dispose();
  });
});
