import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultHomepath } from './default-homepath.mjs';
import { fsHomepath } from './fs-homepath.mjs';

describe('fsHomepath', () => {
  let root;
  let saved;

  beforeEach(() => {
    // A throwaway repo root, so neither a real `.env.local` nor the caller's environment leaks in.
    root = mkdtempSync(join(tmpdir(), 'pcq-homepath-'));
    saved = process.env.PCQ_FS_HOMEPATH;
    delete process.env.PCQ_FS_HOMEPATH;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.PCQ_FS_HOMEPATH;
    else process.env.PCQ_FS_HOMEPATH = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("is the OS's own place when PCQ_FS_HOMEPATH is unset", () => {
    expect(fsHomepath(root, 'development')).toBe(defaultHomepath());
  });

  it('takes PCQ_FS_HOMEPATH from .env.local, relative to the repo root', () => {
    writeFileSync(join(root, '.env.local'), 'PCQ_FS_HOMEPATH=home\n');
    expect(fsHomepath(root, 'development')).toBe(resolve(root, 'home'));
  });

  it('lets the environment override .env.local', () => {
    writeFileSync(join(root, '.env.local'), 'PCQ_FS_HOMEPATH=from-file\n');
    process.env.PCQ_FS_HOMEPATH = join(root, 'from-env');
    expect(fsHomepath(root, 'test')).toBe(join(root, 'from-env'));
  });
});
