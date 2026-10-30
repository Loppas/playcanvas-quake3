import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { diskHome } from './disk-home';

describe('the home folder on a disk', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pcq-disk-home-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a file, making the folders it is in, which it reads back', async () => {
    const home = diskHome(join(root, 'home'));
    expect(await home.write('mine.cfg', 'seta a "1"\n')).toBe(true);
    expect(await home.write('sub/deeper/server.cfg', 'seta b "2"\n')).toBe(true);
    expect(readFileSync(join(root, 'home', 'sub', 'deeper', 'server.cfg'), 'utf8')).toBe('seta b "2"\n');
    expect(await home.read('mine.cfg')).toBe('seta a "1"\n');
    expect(await home.list('', '.cfg')).toEqual(['mine.cfg']);
    expect(await home.list('sub/deeper', '.cfg')).toEqual(['server.cfg']);
  });

  it('lists the files with an extension, in any case, directly in a folder', async () => {
    const home = diskHome(root);
    for (const name of ['a.cfg', 'B.CFG', 'dump.txt', 'Notes.TXT', 'cfg', 'sub/c.cfg']) {
      await home.write(name, '');
    }
    mkdirSync(join(root, 'folder.txt'));
    expect(await home.list('', '.cfg')).toEqual(['B.CFG', 'a.cfg']);
    expect(await home.list('', '.txt')).toEqual(['Notes.TXT', 'dump.txt']);
    expect(await home.list('missing', '.txt')).toEqual([]);
  });

  it("writes nothing where a file can't be written", async () => {
    writeFileSync(join(root, 'taken'), '');
    // A file stands where its folder would be.
    expect(await diskHome(root).write('taken/mine.cfg', '')).toBe(false);
    mkdirSync(join(root, 'folder.cfg'));
    expect(await diskHome(root).write('folder.cfg', '')).toBe(false);
  });
});
