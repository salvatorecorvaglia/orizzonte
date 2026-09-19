/**
 * Locating a declaration inside a manifest.
 *
 * The failure this guards against is subtle: "Open manifest" landing on a
 * repository URL, a comment, or a longer package whose name starts with the
 * one being looked for.
 */

import { describe, expect, it } from 'vitest';
import { findDeclaration } from '../../src/core/findDeclaration.js';

/** The 1-based line the offset falls on, which is what the caret shows. */
function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

describe('findDeclaration', () => {
  it('skips a repository URL that mentions the package first', () => {
    const manifest = `{
  "name": "my-app",
  "repository": "https://github.com/facebook/react",
  "dependencies": {
    "react": "^18.0.0"
  }
}`;
    expect(lineOf(manifest, findDeclaration(manifest, 'react'))).toBe(5);
  });

  it('does not match a longer name that starts with the same text', () => {
    const manifest = `{
  "dependencies": {
    "react-dom": "^18.0.0",
    "react": "^18.0.0"
  }
}`;
    expect(lineOf(manifest, findDeclaration(manifest, 'react'))).toBe(4);
  });

  it('finds a TOML key in a Cargo manifest', () => {
    const manifest = `[package]
name = "my-crate"

[dependencies]
serde = "1.0"`;
    expect(lineOf(manifest, findDeclaration(manifest, 'serde'))).toBe(5);
  });

  it('finds a Poetry table entry', () => {
    const manifest = `[tool.poetry]
name = "app"

[tool.poetry.dependencies]
requests = "^2.31"`;
    expect(lineOf(manifest, findDeclaration(manifest, 'requests'))).toBe(5);
  });

  it('finds a Maven artifact by the second half of the coordinate', () => {
    const manifest = `<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
    </dependency>
  </dependencies>
</project>`;
    const offset = findDeclaration(manifest, 'com.google.guava:guava');
    expect(lineOf(manifest, offset)).toBe(5);
  });

  it('finds a Gradle coordinate inside quotes', () => {
    const manifest = `dependencies {
    implementation 'com.google.guava:guava:32.0.0-jre'
}`;
    const offset = findDeclaration(manifest, 'com.google.guava:guava');
    expect(lineOf(manifest, offset)).toBe(2);
  });

  it('finds a requirements.txt pin, past a comment naming it', () => {
    const manifest = `# flask is pinned because of a bug
django==4.2
flask==3.0`;
    expect(lineOf(manifest, findDeclaration(manifest, 'flask'))).toBe(3);
  });

  it('finds a go.mod requirement', () => {
    const manifest = `module example.com/app

require (
\tgithub.com/spf13/cobra v1.8.0
)`;
    const offset = findDeclaration(manifest, 'github.com/spf13/cobra');
    expect(lineOf(manifest, offset)).toBe(4);
  });

  it('points at the name itself, not the quote before it', () => {
    const manifest = `{"dependencies":{"react":"^18.0.0"}}`;
    const offset = findDeclaration(manifest, 'react');
    expect(manifest.slice(offset, offset + 5)).toBe('react');
  });

  it('reports -1 when the package is genuinely absent', () => {
    expect(findDeclaration('{"dependencies":{}}', 'react')).toBe(-1);
  });

  it('treats a name with regex metacharacters literally', () => {
    // Dots are common in Go module paths and Maven groups.
    const manifest = `{
  "dependencies": {
    "a.b.c": "1.0.0"
  }
}`;
    expect(findDeclaration(manifest, 'a.b.c')).toBeGreaterThan(0);
    expect(findDeclaration(manifest, 'axbxc')).toBe(-1);
  });
});
