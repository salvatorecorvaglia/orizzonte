/**
 * Toolchain detection inside a workspace.
 *
 * A workspace member carries neither a lockfile nor a `packageManager` field
 * of its own — both live at the root. Looking only beside the member read
 * every pnpm, Yarn and bun monorepo as npm, so Install ran `npm install` inside
 * a pnpm workspace member; and a uv workspace member as a pip project.
 */

import { describe, expect, it } from 'vitest';
import { NodeProvider } from '../../src/providers/node/index.js';
import { PythonProvider } from '../../src/providers/python/index.js';
import { makeContext } from './helpers.js';

const node = new NodeProvider();
const python = new PythonProvider();

describe('Node toolchain detection in a workspace', () => {
  it('finds the root lockfile for a member that has none', async () => {
    const ctx = makeContext(
      {
        '/ws/package.json': '{"private": true}',
        '/ws/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
        '/ws/packages/web/package.json': '{"name": "web"}',
      },
      '/ws',
    );

    const toolchain = await node.detectToolchain(
      '/ws/packages/web/package.json',
      ctx,
    );

    expect(toolchain.id).toBe('pnpm');
    // Commands still run in the member, where pnpm acts on that member.
    expect(toolchain.cwd).toBe('/ws/packages/web');
    expect(toolchain.isWorkspaceMember).toBe(true);
  });

  it("honours the root's packageManager field", async () => {
    const ctx = makeContext(
      {
        '/ws/package.json': JSON.stringify({ packageManager: 'yarn@4.1.0' }),
        '/ws/packages/web/package.json': '{"name": "web"}',
      },
      '/ws',
    );

    const toolchain = await node.detectToolchain(
      '/ws/packages/web/package.json',
      ctx,
    );

    expect(toolchain.id).toBe('yarn');
    expect(toolchain.yarnBerry).toBe(true);
  });

  it('reads Yarn Berry from a root .yarnrc.yml', async () => {
    const ctx = makeContext(
      {
        '/ws/yarn.lock': '',
        '/ws/.yarnrc.yml': 'nodeLinker: node-modules\n',
        '/ws/packages/web/package.json': '{}',
      },
      '/ws',
    );

    const toolchain = await node.detectToolchain(
      '/ws/packages/web/package.json',
      ctx,
    );

    expect(toolchain).toMatchObject({ id: 'yarn', yarnBerry: true });
  });

  it("prefers a member's own lockfile over the root's", async () => {
    const ctx = makeContext(
      {
        '/ws/pnpm-lock.yaml': '',
        '/ws/packages/legacy/package.json': '{}',
        '/ws/packages/legacy/package-lock.json': '{}',
      },
      '/ws',
    );

    const toolchain = await node.detectToolchain(
      '/ws/packages/legacy/package.json',
      ctx,
    );

    expect(toolchain.id).toBe('npm');
    expect(toolchain.isWorkspaceMember).toBeUndefined();
  });

  it('never looks above the workspace folder', async () => {
    const ctx = makeContext(
      {
        '/home/user/pnpm-lock.yaml': '',
        '/home/user/project/package.json': '{}',
      },
      '/home/user/project',
    );

    const toolchain = await node.detectToolchain(
      '/home/user/project/package.json',
      ctx,
    );

    expect(toolchain.id).toBe('npm');
  });
});

describe('Python toolchain detection in a workspace', () => {
  it('finds the root uv.lock for a uv workspace member', async () => {
    const ctx = makeContext(
      {
        '/ws/pyproject.toml': '[tool.uv.workspace]\nmembers = ["libs/*"]\n',
        '/ws/uv.lock': 'version = 1\n',
        '/ws/libs/core/pyproject.toml': '[project]\nname = "core"\n',
      },
      '/ws',
    );

    const toolchain = await python.detectToolchain(
      '/ws/libs/core/pyproject.toml',
      ctx,
    );

    expect(toolchain.id).toBe('uv');
    expect(toolchain.cwd).toBe('/ws/libs/core');
    expect(toolchain.isWorkspaceMember).toBe(true);
  });

  it('recognises a root [tool.uv.workspace] table without a lockfile', async () => {
    const ctx = makeContext(
      {
        '/ws/pyproject.toml': '[tool.uv.workspace]\nmembers = ["libs/*"]\n',
        '/ws/libs/core/pyproject.toml': '[project]\nname = "core"\n',
      },
      '/ws',
    );

    const toolchain = await python.detectToolchain(
      '/ws/libs/core/pyproject.toml',
      ctx,
    );

    expect(toolchain.id).toBe('uv');
  });

  it('always drives a requirements file with pip, even beside uv.lock', async () => {
    // `uv add` writes pyproject.toml, not the requirements file the user
    // picked — so the package landed somewhere else entirely.
    const ctx = makeContext({
      '/p/uv.lock': '',
      '/p/pyproject.toml': '[project]\nname = "p"\n',
      '/p/requirements-dev.txt': 'pytest\n',
    });

    const toolchain = await python.detectToolchain(
      '/p/requirements-dev.txt',
      ctx,
    );

    expect(toolchain.id).toBe('pip');
    expect(toolchain.manifestFile).toBe('requirements-dev.txt');
  });

  it('finds a virtualenv at the workspace root', async () => {
    const previous = process.env.VIRTUAL_ENV;
    delete process.env.VIRTUAL_ENV;
    try {
      const ctx = makeContext(
        {
          '/ws/.venv/pyvenv.cfg': 'home = /usr/bin\n',
          '/ws/uv.lock': '',
          '/ws/libs/core/pyproject.toml': '[project]\nname = "core"\n',
        },
        '/ws',
      );

      const toolchain = await python.detectToolchain(
        '/ws/libs/core/pyproject.toml',
        ctx,
      );

      expect(toolchain.venvPath?.replace(/\\/g, '/')).toBe('/ws/.venv');
    } finally {
      if (previous !== undefined) process.env.VIRTUAL_ENV = previous;
    }
  });
});
