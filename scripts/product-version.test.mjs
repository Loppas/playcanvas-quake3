import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { productSource } from './product-version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { homepage } = JSON.parse(readFileSync(nodePath.join(root, 'package.json'), 'utf8'));

describe('productSource', () => {
  it('is the repository at the commit built', () => {
    const commit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
    expect(productSource(root)).toBe(`${homepage}/tree/${commit}`);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is the repository alone in a tree with no git to ask', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'pcq-source-'));
    try {
      writeFileSync(nodePath.join(dir, 'package.json'), JSON.stringify({ homepage }));
      expect(productSource(dir)).toBe(homepage);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
