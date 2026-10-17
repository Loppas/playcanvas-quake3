import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SHELL_FILE, installOf, keepInstall, keptInstall } from './basepath.mjs';

let root;
let install;
let home;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pcq-basepath-'));
  install = join(root, 'ioquake');
  mkdirSync(join(install, 'baseq3'), { recursive: true });
  writeFileSync(join(install, 'baseq3', 'pak0.pk3'), 'PK');
  home = join(root, 'home');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('installOf', () => {
  it('takes the folder that holds baseq3', async () => {
    expect(await installOf(install)).toBe(install);
  });

  it('takes the folder above a picked baseq3', async () => {
    expect(await installOf(join(install, 'baseq3'))).toBe(install);
  });

  it('refuses a folder with no paks', async () => {
    mkdirSync(join(root, 'empty', 'baseq3'), { recursive: true });
    expect(await installOf(join(root, 'empty'))).toBeUndefined();
    expect(await installOf(join(root, 'empty', 'baseq3'))).toBeUndefined();
    expect(await installOf(join(root, 'missing'))).toBeUndefined();
  });
});

describe('keptInstall', () => {
  it('resolves the install kept in fs_homepath', async () => {
    // A first run has none, and the player picks.
    expect(await keptInstall(home)).toBeUndefined();
    await keepInstall(home, install);
    expect(await keptInstall(home)).toBe(install);
    // Nothing is left beside it.
    expect(readdirSync(home)).toEqual([SHELL_FILE]);
  });

  it('lets a kept install go once it holds no pak', async () => {
    await keepInstall(home, install);
    rmSync(join(install, 'baseq3', 'pak0.pk3'));
    expect(await keptInstall(home)).toBeUndefined();
  });

  it('passes over a file it cannot use', async () => {
    mkdirSync(home, { recursive: true });
    for (const text of ['not json', 'null', '{ "fs_basepath": 3 }']) {
      writeFileSync(join(home, SHELL_FILE), text);
      expect(await keptInstall(home), text).toBeUndefined();
    }
  });
});
