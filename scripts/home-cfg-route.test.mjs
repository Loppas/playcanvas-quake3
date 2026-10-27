import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { homeCfgResponse, isHomePath } from './home-cfg-route.mjs';

describe('isHomePath', () => {
  it('takes names joined by slashes, and nothing that could leave the folder', () => {
    expect(isHomePath('autoexec.cfg')).toBe(true);
    expect(isHomePath('presets/cpm.cfg')).toBe(true);
    for (const path of [
      '',
      '../secret.cfg',
      'presets/../../secret.cfg',
      './a.cfg',
      '/etc/a.cfg',
      'presets//a.cfg',
      'presets\\..\\secret.cfg',
      'C:/a.cfg',
      'a.cfg:stream'
    ]) {
      expect(isHomePath(path), path).toBe(false);
    }
  });
});

describe('homeCfgResponse', () => {
  let root;
  let home;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pcq-home-cfg-'));
    home = join(root, 'home');
    mkdirSync(join(home, 'presets', 'old'), { recursive: true });
    mkdirSync(join(home, 'presets', 'folder.cfg'));
    writeFileSync(join(home, 'autoexec.cfg'), 'seta cg_fov "100"\n');
    writeFileSync(join(home, 'presets', 'cpm.cfg'), 'seta g_gamepreset "CPM"\n');
    writeFileSync(join(home, 'presets', 'Mine.CFG'), 'seta g_gamepreset "MINE"\n');
    writeFileSync(join(home, 'presets', 'notes.txt'), 'not a cfg');
    writeFileSync(join(home, 'presets', 'old', 'vq3.cfg'), 'seta g_gamepreset "VQ3"\n');
    writeFileSync(join(root, 'secret.cfg'), 'outside');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("answers a cfg's text, in a folder or at the top", async () => {
    expect(await homeCfgResponse('GET', 'presets/cpm.cfg', home)).toEqual({
      status: 200,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      body: 'seta g_gamepreset "CPM"\n'
    });
    expect((await homeCfgResponse('GET', 'autoexec.cfg', home)).body).toBe('seta cg_fov "100"\n');
    // Decoded as a URL's path is.
    expect((await homeCfgResponse('GET', 'presets%2FMine.CFG', home)).body).toBe('seta g_gamepreset "MINE"\n');
  });

  it('answers HEAD without the body', async () => {
    const answer = await homeCfgResponse('HEAD', 'presets/cpm.cfg', home);
    expect(answer.status).toBe(200);
    expect(answer.body).toBeUndefined();
  });

  it('answers 404 for a cfg there is none of, and for anything but a cfg in the folder', async () => {
    for (const path of [
      'presets/pmc.cfg',
      'presets/notes.txt',
      'presets/folder.cfg',
      '..%2Fsecret.cfg',
      'presets/..%2F..%2Fsecret.cfg',
      '..%5Csecret.cfg',
      encodeURIComponent(join(root, 'secret.cfg')),
      '%2Fsecret.cfg',
      '%E0.cfg'
    ]) {
      expect((await homeCfgResponse('GET', path, home)).status, path).toBe(404);
    }
  });

  it('lists the cfgs directly in a folder, and none for a folder there is none of', async () => {
    const answer = await homeCfgResponse('GET', 'presets/', home);
    expect(answer.status).toBe(200);
    expect(answer.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(answer.body)).toEqual(['Mine.CFG', 'cpm.cfg']);

    expect(JSON.parse((await homeCfgResponse('GET', '', home)).body)).toEqual(['autoexec.cfg']);
    expect(JSON.parse((await homeCfgResponse('GET', 'presets/old/', home)).body)).toEqual(['vq3.cfg']);
    expect(JSON.parse((await homeCfgResponse('GET', 'missing/', home)).body)).toEqual([]);
    expect((await homeCfgResponse('HEAD', 'presets/', home)).body).toBeUndefined();
  });

  it('lists no folder outside the home folder', async () => {
    for (const path of ['../', '..%2F', 'presets/../../', '%2F', '..%5C/']) {
      expect((await homeCfgResponse('GET', path, home)).status, path).toBe(404);
    }
  });

  it('writes a cfg or a .txt, making its folders, and replaces one that is there', async () => {
    expect(await homeCfgResponse('PUT', 'mine.cfg', home, 'seta a "1"\n')).toEqual({
      status: 204,
      headers: { 'Cache-Control': 'no-store' }
    });
    expect(readFileSync(join(home, 'mine.cfg'), 'utf8')).toBe('seta a "1"\n');
    expect((await homeCfgResponse('PUT', 'sub%2Fdeeper/Dump.TXT', home, 'one\r\n\r\n')).status).toBe(204);
    expect(readFileSync(join(home, 'sub', 'deeper', 'Dump.TXT'), 'utf8')).toBe('one\r\n\r\n');
    expect((await homeCfgResponse('PUT', 'presets/cpm.cfg', home, 'replaced\n')).status).toBe(204);
    expect((await homeCfgResponse('GET', 'presets/cpm.cfg', home)).body).toBe('replaced\n');
    // Nothing is left beside the files.
    expect(readdirSync(join(home, 'presets')).sort()).toEqual(['Mine.CFG', 'cpm.cfg', 'folder.cfg', 'notes.txt', 'old']);
    // A .txt is written, and still not read.
    expect((await homeCfgResponse('GET', 'sub/deeper/Dump.TXT', home)).status).toBe(404);
  });

  it('writes nothing but a cfg or a .txt in the folder', async () => {
    for (const path of ['notes.md', 'presets/', '', '..%2Fsecret.cfg', '..%5Csecret.txt', '%2Fsecret.cfg', 'a%3Ab.cfg']) {
      expect((await homeCfgResponse('PUT', path, home, 'x')).status, path).toBe(404);
    }
    expect(readFileSync(join(root, 'secret.cfg'), 'utf8')).toBe('outside');
    expect(existsSync(join(home, 'notes.md'))).toBe(false);
  });

  it('answers no other method', async () => {
    expect(await homeCfgResponse('DELETE', 'presets/cpm.cfg', home)).toMatchObject({
      status: 405,
      headers: { Allow: 'GET, HEAD, PUT' }
    });
  });
});
