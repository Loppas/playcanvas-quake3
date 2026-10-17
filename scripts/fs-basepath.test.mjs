import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BASEGAME, baseq3Dir, fsBasepath } from './fs-basepath.mjs';

describe('baseq3Dir', () => {
  let root;
  let saved;

  beforeEach(() => {
    // A throwaway repo root, so neither a real `.env.local` nor the caller's environment leaks in.
    root = mkdtempSync(join(tmpdir(), 'pcq-basepath-'));
    saved = process.env.PCQ_FS_BASEPATH;
    delete process.env.PCQ_FS_BASEPATH;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.PCQ_FS_BASEPATH;
    else process.env.PCQ_FS_BASEPATH = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("is the repo's own baseq3 when PCQ_FS_BASEPATH is unset", () => {
    expect(baseq3Dir(root, 'development')).toBe(resolve(root, 'baseq3'));
  });

  it('takes the folder holding baseq3 from .env.local, as ioq3 takes fs_basepath', () => {
    const install = join(root, 'Games', 'ioquake');
    writeFileSync(join(root, '.env.local'), `PCQ_FS_BASEPATH=${install}\n`);
    expect(baseq3Dir(root, 'development')).toBe(join(install, BASEGAME));
    // The tests read the same folder as the dev server.
    expect(baseq3Dir(root, 'test')).toBe(join(install, BASEGAME));
  });

  it('lets the environment override .env.local', () => {
    writeFileSync(join(root, '.env.local'), 'PCQ_FS_BASEPATH=from-file\n');
    process.env.PCQ_FS_BASEPATH = join(root, 'from-env');
    expect(fsBasepath(root, 'test')).toBe(join(root, 'from-env'));
  });

  it('resolves a relative path against the repo root', () => {
    process.env.PCQ_FS_BASEPATH = '../install';
    expect(fsBasepath(root, 'test')).toBe(resolve(root, '../install'));
  });
});
