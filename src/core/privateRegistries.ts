/**
 * Recognising packages a project gets from a private registry, from the
 * configuration its own tools already read.
 *
 * A private package's name is internal information. Looking it up on the
 * public registry, the Go module proxy or OSV discloses that name to a third
 * party — and the answer is about whoever holds the same name there, if
 * anyone. Go's `GOPRIVATE` and npm's per-scope registries are how projects say
 * which names those are; Orizzonte honours the same settings rather than a
 * parallel list of its own.
 *
 * Kept free of `vscode` so the matching rules can be tested directly.
 */

/**
 * The module-path patterns Go treats as private: `GOPRIVATE`, plus
 * `GONOPROXY`, which names modules that must not go through a proxy.
 */
export function goPrivatePatterns(env: NodeJS.ProcessEnv): string[] {
  return [env.GOPRIVATE, env.GONOPROXY]
    .flatMap((value) => (value ?? '').split(','))
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '' && pattern !== 'off');
}

/**
 * Whether `modulePath` matches one of `patterns`, the way Go matches them
 * (`go help private`): each pattern is a glob over whole path elements, and
 * matches any module whose path *begins* with elements it matches — so
 * `*.corp.example.com` covers `git.corp.example.com/team/repo`.
 */
export function matchesGoPrivate(
  modulePath: string,
  patterns: string[],
): boolean {
  const elements = modulePath.split('/');
  return patterns.some((pattern) => {
    const patternElements = pattern.replace(/\/+$/, '').split('/');
    if (patternElements.length > elements.length) return false;
    return patternElements.every((element, index) =>
      globElement(element).test(elements[index]),
    );
  });
}

/** One path element of a Go glob: `*` and `?` never cross a `/`. */
function globElement(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) {
        source += '\\[';
        continue;
      }
      // Go and regular expressions both spell negation `[^...]`.
      source += `[${pattern.slice(i + 1, end)}]`;
      i = end;
    } else source += char.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** The public npm registry, which a scope mapping may point at explicitly. */
const PUBLIC_NPM = /^https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/?$/i;

/**
 * The scopes an `.npmrc` sends to a registry other than the public one:
 * `@acme:registry=https://npm.acme.internal/`.
 *
 * Only the mapping is read. The file may also hold auth tokens; those are
 * never read or used here.
 */
export function privateNpmScopes(npmrc: string): Set<string> {
  const scopes = new Set<string>();
  for (const rawLine of npmrc.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^(@[^:\s]+):registry\s*=\s*(\S+)/.exec(line);
    if (match && !PUBLIC_NPM.test(match[2])) scopes.add(match[1]);
  }
  return scopes;
}

/** The scope of a scoped npm name (`@acme/utils` -> `@acme`), if it has one. */
export function npmScopeOf(name: string): string | undefined {
  return name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined;
}
