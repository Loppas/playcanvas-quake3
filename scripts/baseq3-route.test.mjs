import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isPakName, listPaks, rangeResponse, resolveInside } from './baseq3-route.mjs';

const { posix, win32 } = nodePath;

describe('resolveInside', () => {
  describe('with Windows paths', () => {
    const root = 'C:\\repo\\baseq3';

    it('serves a pak in the root — the request a hard-coded `/` refused', () => {
      expect(resolveInside(root, 'pak0.pk3', win32)).toBe('C:\\repo\\baseq3\\pak0.pk3');
    });

    it('serves a file below the root whichever slash the request used', () => {
      expect(resolveInside(root, 'maps/pak0.pk3', win32)).toBe('C:\\repo\\baseq3\\maps\\pak0.pk3');
      expect(resolveInside(root, 'maps\\pak0.pk3', win32)).toBe('C:\\repo\\baseq3\\maps\\pak0.pk3');
    });

    it('refuses a climb out, in either slash style', () => {
      expect(resolveInside(root, '../package.json', win32)).toBeNull();
      expect(resolveInside(root, '..\\package.json', win32)).toBeNull();
      expect(resolveInside(root, 'maps\\..\\..\\package.json', win32)).toBeNull();
    });

    it('refuses a sibling that only starts with the root name', () => {
      expect(resolveInside(root, '..\\baseq3-other\\pak0.pk3', win32)).toBeNull();
    });

    it('refuses the root itself', () => {
      expect(resolveInside(root, '', win32)).toBeNull();
    });
  });

  describe('with POSIX paths', () => {
    const root = '/repo/baseq3';

    it('serves a pak in the root', () => {
      expect(resolveInside(root, 'pak0.pk3', posix)).toBe('/repo/baseq3/pak0.pk3');
    });

    it('refuses a climb out', () => {
      expect(resolveInside(root, '../package.json', posix)).toBeNull();
      expect(resolveInside(root, 'maps/../../package.json', posix)).toBeNull();
    });

    it('refuses a sibling that only starts with the root name', () => {
      expect(resolveInside(root, '../baseq3-other/pak0.pk3', posix)).toBeNull();
    });
  });
});

describe('isPakName', () => {
  it('takes a pk3 directly in the folder, in any case', () => {
    for (const name of ['pak0.pk3', 'PAK0.PK3', 'xccc_dm3.pk3', 'my pak.pk3']) {
      expect(isPakName(name), name).toBe(true);
    }
  });

  it('refuses other files, subfolders, climbs, and drive or stream colons', () => {
    for (const name of [
      'readme.txt',
      'padshop.pk3.tmp',
      'maps/pak0.pk3',
      'maps\\pak0.pk3',
      '../pak0.pk3',
      '..\\pak0.pk3',
      'C:pak0.pk3',
      'pak0.pk3:stream.pk3',
      '.pk3'
    ]) {
      expect(isPakName(name), name).toBe(false);
    }
  });
});

describe('listPaks', () => {
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(nodePath.join(tmpdir(), 'pcq-listpaks-'));
    writeFileSync(nodePath.join(dir, 'pak0.pk3'), Buffer.alloc(10));
    writeFileSync(nodePath.join(dir, 'PAK1.PK3'), Buffer.alloc(3));
    writeFileSync(nodePath.join(dir, 'readme.txt'), 'not a pak');
    writeFileSync(nodePath.join(dir, 'padshop.pk3.tmp'), Buffer.alloc(1));
    // A folder named like a pak, and a pak inside a subfolder: neither is served.
    mkdirSync(nodePath.join(dir, 'folder.pk3'));
    mkdirSync(nodePath.join(dir, 'maps'));
    writeFileSync(nodePath.join(dir, 'maps', 'pak9.pk3'), Buffer.alloc(5));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lists only the pk3 files directly in the folder, with their sizes', async () => {
    expect(await listPaks(dir)).toEqual([
      { name: 'PAK1.PK3', size: 3 },
      { name: 'pak0.pk3', size: 10 }
    ]);
  });

  it('rejects for a folder that does not exist', async () => {
    await expect(listPaks(nodePath.join(dir, 'missing'))).rejects.toThrow();
  });
});

describe('rangeResponse', () => {
  const size = 1000;
  const partial = (start, end) => ({
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1)
    },
    start,
    end
  });

  it('answers bytes=a-b with exactly that range', () => {
    expect(rangeResponse('bytes=0-99', size)).toEqual(partial(0, 99));
    expect(rangeResponse('bytes=500-500', size)).toEqual(partial(500, 500));
  });

  it('answers bytes=a- with the rest of the file', () => {
    expect(rangeResponse('bytes=900-', size)).toEqual(partial(900, 999));
  });

  it('answers bytes=-n with the last n bytes', () => {
    // How a zip reader asks for an end record: the last 22 bytes.
    expect(rangeResponse('bytes=-22', size)).toEqual(partial(978, 999));
  });

  it('clips a range that runs past the end, and a suffix longer than the file', () => {
    expect(rangeResponse('bytes=990-2000', size)).toEqual(partial(990, 999));
    expect(rangeResponse('bytes=-5000', size)).toEqual(partial(0, 999));
  });

  it('answers 416 for a start at or past the end', () => {
    expect(rangeResponse('bytes=1000-1100', size)).toEqual({
      status: 416,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes */1000', 'Content-Length': '0' }
    });
    expect(rangeResponse('bytes=5000-', size).status).toBe(416);
    // A zero-length suffix, and any range of an empty file, can never be satisfied.
    expect(rangeResponse('bytes=-0', size).status).toBe(416);
    expect(rangeResponse('bytes=0-0', 0).status).toBe(416);
  });

  it('answers 200 with the whole file without a header, or with one it does not handle', () => {
    const whole = { status: 200, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '1000' } };
    expect(rangeResponse(undefined, size)).toEqual(whole);
    expect(rangeResponse(null, size)).toEqual(whole);
    for (const header of ['bytes=0-1,5-9', 'items=0-9', 'bytes=-', 'bytes=9-0', 'bytes=abc']) {
      expect(rangeResponse(header, size), header).toEqual(whole);
    }
  });
});
