import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const scenarios = [
  { width: 480, theme: 'dark', zoom: 1, contrast: false },
  { width: 1000, theme: 'light', zoom: 1, contrast: false },
  { width: 1440, theme: 'dark', zoom: 1, contrast: false },
  { width: 480, theme: 'dark', zoom: 1.5, contrast: false },
  { width: 1000, theme: 'dark', zoom: 1, contrast: true },
] as const;

for (const { width, theme, zoom, contrast } of scenarios) {
  test(`webview renders virtual rows and supports keyboard navigation at ${width}px (${theme}, ${zoom}x, contrast=${contrast})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({
      colorScheme: theme,
      forcedColors: contrast ? 'active' : 'none',
      reducedMotion: 'reduce',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(
      '<!doctype html><html><body><div id="root"></div></body></html>',
    );
    await page.evaluate(
      `window.__posted = []; window.acquireVsCodeApi = () => ({postMessage: m => window.__posted.push(m),getState:()=>undefined,setState:()=>{}})`,
    );
    await page.addStyleTag({
      content: await readFile('dist/webview/index.css', 'utf8'),
    });
    const iconFont = await readFile('dist/webview/index.ttf');
    await page.addStyleTag({
      content: `@font-face { font-family: codicon; src: url(data:font/ttf;base64,${iconFont.toString('base64')}) format('truetype'); }`,
    });
    await page.addStyleTag({
      content: `:root {
      --vscode-font-family: system-ui;
      --vscode-font-size: 13px;
      --vscode-editor-background: ${theme === 'dark' ? '#1e1e1e' : '#ffffff'};
      --vscode-editor-foreground: ${theme === 'dark' ? '#dddddd' : '#222222'};
      --vscode-foreground: ${theme === 'dark' ? '#dddddd' : '#222222'};
      --vscode-descriptionForeground: ${theme === 'dark' ? '#aaaaaa' : '#555555'};
      --vscode-button-background: #007acc;
      --vscode-button-foreground: white;
      --vscode-input-background: ${theme === 'dark' ? '#333333' : '#eeeeee'};
      --vscode-input-foreground: ${theme === 'dark' ? '#dddddd' : '#222222'};
      --vscode-panel-border: #777777;
      --vscode-focusBorder: #007acc;
    } html { zoom: ${zoom}; }`,
    });
    await page.addScriptTag({
      content: await readFile('dist/webview/index.js', 'utf8'),
    });
    await expect
      .poll(() =>
        page.evaluate(`window.__posted.some(m => m.type === 'ready')`),
      )
      .toBe(true);
    const dependencies = Array.from({ length: 200 }, (_, i) => ({
      key: `pkg-${i}`,
      name: `pkg-${String(i).padStart(3, '0')}`,
      ecosystem: 'node',
      scope: 'prod',
      declared: '^1.0.0',
      installed: '1.0.0',
      latest: '1.1.0',
      wanted: '1.1.0',
      updateKind: 'minor',
      vulnerabilities: [],
      manifestPath: '/p/package.json',
      projectLabel: 'app',
    }));
    const state = {
      type: 'state',
      groups: [
        {
          label: 'app',
          manifestPath: '/p/package.json',
          ecosystem: 'node',
          toolchain: 'npm',
          dependencies,
        },
      ],
      manifests: [],
      summary: {
        totalDependencies: 200,
        outdated: 200,
        vulnerable: 0,
        deprecated: 0,
        stale: false,
        auditStatus: 'notRun',
      },
    };
    await page.evaluate(`window.postMessage(${JSON.stringify(state)}, '*')`);
    await expect(page.getByText('pkg-000', { exact: true })).toBeVisible();
    expect(await page.getByRole('row').count()).toBeLessThan(100);
    await expect(
      page.getByRole('status').filter({ hasText: 'audit not run' }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: test.info().outputPath('webview.png') });
    await page.getByRole('rowgroup').focus();
    await page.keyboard.press('End');
    await expect(
      page.getByRole('row', { selected: false }).filter({ hasText: 'pkg-199' }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('complementary', { name: 'Details for pkg-199' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await page.evaluate(
      `window.postMessage({ type: 'scanning', busy: true, label: 'Checking registries' }, '*')`,
    );
    await page.getByRole('button', { name: 'Add package' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: 'More' })).toBeFocused();
    expect(errors).toEqual([]);
  });
}
