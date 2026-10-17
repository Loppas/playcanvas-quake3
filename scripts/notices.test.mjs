import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import {
  banner,
  NOTICE_FILES,
  PUBLISHED_NOTICES,
  publishedName,
  THIRD_PARTY_NOTICES
} from './notices.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * A plugin that adds to `packages` the name of every package a chunk it sees bundles.
 *
 * @param {Set<string>} packages
 * @returns {import('vite').Plugin}
 */
function bundledPackages(packages) {
  return {
    name: 'bundled-packages',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds) {
          const path = id.replace(/\\/g, '/');
          if (id.startsWith('\0') || !path.includes('/node_modules/')) continue;
          const [scope, name] = path.split('/node_modules/').at(-1).split('/');
          packages.add(scope.startsWith('@') ? `${scope}/${name}` : scope);
        }
      }
    }
  };
}

describe('the web build', () => {
  it("carries the notices: each package bundled, the workers' too, and the repo's", async () => {
    const inWorkers = new Set();
    const result = await build({
      root,
      mode: 'production',
      logLevel: 'silent',
      build: { write: false },
      worker: { plugins: () => [bundledPackages(inWorkers)] }
    });
    const files = [result].flat().flatMap(({ output }) => output);

    const notices = String(files.find((file) => file.fileName === THIRD_PARTY_NOTICES)?.source);
    const sections = notices.split(/^## /m).slice(1);
    const listed = sections.map((section) => section.split(' - ')[0]);
    expect(listed).toEqual(expect.arrayContaining(['fflate', 'playcanvas']));
    // Each package's licence text, below its heading.
    for (const section of sections) expect(section.trim().split('\n').length).toBeGreaterThan(3);
    // Vite lists the main bundle's packages alone; the decode worker inflates with fflate.
    expect(inWorkers).toContain('fflate');
    expect([...inWorkers].filter((name) => !listed.includes(name))).toEqual([]);

    const scripts = files.filter((file) => file.fileName.endsWith('.js'));
    expect(scripts.some((file) => file.fileName.includes('decode-worker'))).toBe(true);
    for (const file of scripts) {
      const text = file.type === 'chunk' ? file.code : String(file.source);
      expect(text.startsWith(banner(root)), file.fileName).toBe(true);
    }

    // The repo's own notices go in beside them, each whole, by the name the page links it by.
    const published = new Map(files.map((file) => [file.fileName, file]));
    expect(PUBLISHED_NOTICES.filter((name) => !published.has(name))).toEqual([]);
    for (const file of NOTICE_FILES) {
      const source = published.get(publishedName(file))?.source ?? '';
      const repo = readFileSync(nodePath.join(root, file), 'utf8');
      expect(Buffer.from(source).toString(), file).toBe(repo);
    }
  }, 120_000);
});
