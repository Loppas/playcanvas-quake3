import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configResponse, isSameOrigin, keptFile, readBody } from './q3config-route.mjs';

describe('keptFile', () => {
  it('names the files the game keeps in fs_homepath, and nothing below it', () => {
    expect(keptFile('/homepath/q3config.cfg')).toBe('q3config.cfg');
    expect(keptFile('/homepath/favorites.txt')).toBe('favorites.txt');
    for (const path of ['/homepath/presets/q3config.cfg', '/homepath/other.txt', '/favorites.txt']) {
      expect(keptFile(path), path).toBeUndefined();
    }
  });

  it('names a file by its whole path, not a longer one that starts with it', () => {
    const paths = [
      '/homepath/q3config.cfg.1.tmp',
      '/homepath/q3config.cfg/other.cfg',
      '/homepath/favorites.txt.bak'
    ];
    for (const path of paths) expect(keptFile(path), path).toBeUndefined();
  });
});

describe('isSameOrigin', () => {
  it("answers only the page's own origin", () => {
    expect(isSameOrigin({ 'sec-fetch-site': 'same-origin' })).toBe(true);
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(isSameOrigin({ 'sec-fetch-site': site }), site).toBe(false);
    }
    // No browser marked it.
    expect(isSameOrigin({})).toBe(false);
  });
});

describe('configResponse', () => {
  let home;
  let file;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pcq-q3config-'));
    file = join(home, 'playcanvas-quake3', 'q3config.cfg');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('answers 204 and nothing before there is a file, as on a first run', async () => {
    const answer = await configResponse('GET', undefined, file);
    expect(answer.status).toBe(204);
    expect(answer.body).toBeUndefined();
  });

  it('writes the file, making its folder, and reads it back', async () => {
    const text = 'unbindall\nseta cg_fov "100"\n';
    expect(await configResponse('PUT', text, file)).toMatchObject({ status: 204 });
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(await configResponse('GET', undefined, file)).toMatchObject({
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      body: text
    });
    // Nothing is left beside it.
    expect(readdirSync(join(home, 'playcanvas-quake3'))).toEqual(['q3config.cfg']);
  });

  it('answers HEAD without the body', async () => {
    await configResponse('PUT', 'unbindall\n', file);
    const answer = await configResponse('HEAD', undefined, file);
    expect(answer.status).toBe(200);
    expect(answer.body).toBeUndefined();
  });

  it('refuses any other method', async () => {
    expect(await configResponse('DELETE', undefined, file)).toMatchObject({
      status: 405,
      headers: { Allow: 'GET, HEAD, PUT' }
    });
    expect(existsSync(file)).toBe(false);
  });
});

describe('readBody', () => {
  it('reads a body up to the limit', async () => {
    expect(await readBody(Readable.from([Buffer.from('seta '), Buffer.from('a "1"')]), 10)).toBe(
      'seta a "1"'
    );
  });

  it('refuses a body past the limit', async () => {
    expect(await readBody(Readable.from([Buffer.alloc(11)]), 10)).toBeNull();
  });
});
