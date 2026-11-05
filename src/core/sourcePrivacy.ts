import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderContext } from '../providers/provider.js';
import { ancestorDirectories } from './lockfiles/resolve.js';
import type { ParsedManifest } from './types.js';
import { isRegistryPackage } from './vocabulary.js';

/** Repository declarations are source hints, not permission to execute build scripts. */
export async function protectUncertainSources(
  manifest: ParsedManifest,
  text: string,
  ctx: ProviderContext,
): Promise<ParsedManifest> {
  const ecosystem = manifest.ecosystem;
  if (!['python', 'maven', 'gradle'].includes(ecosystem)) return manifest;
  const dirs = ancestorDirectories(
    path.dirname(manifest.path),
    ctx.workspaceRootFor(manifest.path),
  );
  const configuration = [repositoryConfiguration(text, ecosystem)];
  const files =
    ecosystem === 'python'
      ? ['pip.conf', 'pip.ini', 'uv.toml', 'pyproject.toml']
      : ecosystem === 'maven'
        ? ['pom.xml', '.mvn/settings.xml']
        : [
            'settings.gradle',
            'settings.gradle.kts',
            'build.gradle',
            'build.gradle.kts',
          ];
  for (const dir of dirs) {
    for (const file of files) {
      const at = path.join(dir, file);
      if (at === manifest.path) continue;
      configuration.push(await privateConfigurationAt(at, ecosystem, ctx));
    }
  }
  const userFiles =
    ecosystem === 'python'
      ? [
          path.join(os.homedir(), '.pip/pip.conf'),
          path.join(os.homedir(), '.config/pip/pip.conf'),
          path.join(os.homedir(), '.config/uv/uv.toml'),
          ...(process.env.XDG_CONFIG_HOME
            ? [
                path.join(process.env.XDG_CONFIG_HOME, 'pip/pip.conf'),
                path.join(process.env.XDG_CONFIG_HOME, 'uv/uv.toml'),
              ]
            : []),
          ...(process.env.APPDATA
            ? [
                path.join(process.env.APPDATA, 'pip/pip.ini'),
                path.join(process.env.APPDATA, 'uv/uv.toml'),
              ]
            : []),
          path.join(os.homedir(), 'pip/pip.ini'),
          process.env.PIP_CONFIG_FILE,
        ]
      : ecosystem === 'maven'
        ? [path.join(os.homedir(), '.m2/settings.xml')]
        : [];
  for (const file of userFiles) {
    if (!file) continue;
    configuration.push(await privateConfigurationAt(file, ecosystem, ctx));
  }
  const privatePythonEnvironment =
    ecosystem === 'python' &&
    [
      process.env.PIP_INDEX_URL,
      process.env.PIP_EXTRA_INDEX_URL,
      process.env.UV_INDEX_URL,
      process.env.UV_EXTRA_INDEX_URL,
      process.env.UV_DEFAULT_INDEX,
      process.env.UV_INDEX,
    ].some((value) =>
      value?.split(/\s+/).some((url) => {
        try {
          return new URL(url).hostname !== 'pypi.org';
        } catch {
          return true;
        }
      }),
    );
  const uncertain = privatePythonEnvironment || configuration.some(Boolean);
  if (uncertain) {
    for (const dep of manifest.dependencies) {
      if (!isRegistryPackage(dep)) continue;
      dep.source = 'private';
    }
  }
  return manifest;
}

/** Only the privacy decision is memoized, never registry credentials or raw configuration. */
async function privateConfigurationAt(
  file: string,
  ecosystem: string,
  ctx: ProviderContext,
): Promise<boolean> {
  const key = `privacy:${ecosystem}\0${file}`;
  const existing = ctx.lockfileMemo?.get(key) as Promise<boolean> | undefined;
  if (existing) return existing;
  const pending = ctx
    .readFile(file)
    .then((text) => !!text && repositoryConfiguration(text, ecosystem));
  ctx.lockfileMemo?.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    ctx.lockfileMemo?.delete(key);
    throw error;
  }
}
function repositoryConfiguration(content: string, ecosystem: string): boolean {
  switch (ecosystem) {
    case 'python':
      return /(?:^\s*-(?:i|f|r|c)\s*\S+|--requirement|--constraint|default-index\s*=|--(?:extra-)?index-url|--find-links|--no-index|--index\b|(?:extra-)?index-url\s*=|\[\[?tool\.(?:poetry\.source|uv\.index)|\[\[?index\b)/im.test(
        content,
      );
    case 'maven':
      return /<repositories\b|<mirrors\b/i.test(content);
    default:
      return /\bmaven\s*(?:\(|\{)|\bmavenLocal\s*\(|\bivy\s*(?:\(|\{)/.test(
        content,
      );
  }
}
