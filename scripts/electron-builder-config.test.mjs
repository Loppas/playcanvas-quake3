import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import config from '../electron-builder.config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const IMPORT =
  /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

/**
 * Every module the main process loads, from `package.json`'s `main` through its static imports:
 * the files as repo paths with forward slashes, and the bare specifiers.
 */
function mainProcessImports() {
  const { main } = JSON.parse(readFileSync(nodePath.join(root, 'package.json'), 'utf8'));
  const files = new Set();
  const bare = new Set();
  /** @param {string} file */
  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(nodePath.join(root, file), 'utf8');
    for (const [, from, sideEffect] of source.matchAll(IMPORT)) {
      const spec = from ?? sideEffect;
      if (!spec.startsWith('.')) bare.add(spec);
      else visit(nodePath.posix.join(nodePath.posix.dirname(file), spec));
    }
  };
  visit(main);
  return { files: [...files], bare: [...bare] };
}

/**
 * Whether the build packs a file: the last of `files`' patterns to match it decides, and a `!`
 * pattern leaves it out.
 *
 * @param {string} file
 */
function packed(file) {
  let kept = false;
  for (const pattern of /** @type {string[]} */ (config.files)) {
    const negated = pattern.startsWith('!');
    if (nodePath.posix.matchesGlob(file, negated ? pattern.slice(1) : pattern)) kept = !negated;
  }
  return kept;
}

describe('the desktop build', () => {
  it("is named as the package, its id under the project site's domain", () => {
    const { name } = JSON.parse(readFileSync(nodePath.join(root, 'package.json'), 'utf8'));
    expect(name).toBe('playcanvas-quake3');
    expect(config.productName).toBe(name);
    expect(config.appId).toBe(`io.github.loppas.${name}`);
  });

  it('packs every module the main process imports', () => {
    const { files } = mainProcessImports();
    expect(files).toContain('scripts/home-cfg-route.mjs');
    expect(files.filter((file) => !packed(file))).toEqual([]);
    expect(packed('electron/main.test.mjs')).toBe(false);
  });

  it('imports no package, as it leaves node_modules out', () => {
    const { bare } = mainProcessImports();
    expect(bare).toContain('electron');
    expect(bare.filter((spec) => !spec.startsWith('node:') && spec !== 'electron')).toEqual([]);
  });

  it('puts the licence and the notices beside the exe', () => {
    expect(config.extraFiles).toEqual([
      'LICENSE',
      'NOTICE',
      'CREDITS.md',
      { from: 'dist/THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md' }
    ]);
    for (const file of ['LICENSE', 'NOTICE', 'CREDITS.md']) {
      expect(existsSync(nodePath.join(root, file)), file).toBe(true);
    }
  });
});
