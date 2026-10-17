import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  CAPTURE_HEIGHT,
  CAPTURE_MAPS,
  CAPTURE_SCRIPT,
  CAPTURE_WIDTH,
  PASS_MARKS,
  RETAIL_PAKS,
  TOLERANCE,
  captureScript,
  compare,
  portAddress,
  q3Arguments,
  ramped,
  readPng,
  readTga,
  retailBasepath,
  shotSpeeds,
  shotTimes,
  sideBySide,
  speedsDiffer,
  speedsLine,
  writePng
} from './q3-reference-lib.mjs';

/** A picture of these RGB texels, opaque, row by row. */
function picture(width, height, rgb) {
  const pixels = new Uint8Array(width * height * 4);
  rgb.forEach(([r, g, b], i) => pixels.set([r, g, b, 255], i * 4));
  return { width, height, pixels };
}

/** A PNG chunk, its CRC left 0, which the reader doesn't check. */
function chunk(type, body) {
  const out = new Uint8Array(12 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(Buffer.from(type, 'latin1'), 4);
  out.set(body, 8);
  return out;
}

describe("Quake 3's side", () => {
  /** A command line's `+set`s, by name. */
  const sets = (args) =>
    Object.fromEntries(
      args.flatMap((arg, i) => (arg === '+set' ? [[args[i + 1], args[i + 2]]] : []))
    );

  it('starts safe, sets everything, then runs its script of views', () => {
    const args = q3Arguments({ basepath: 'C:/clean', homepath: 'C:/home' });
    expect(args[0]).toBe('+safe');
    expect(sets(args)).toMatchObject({
      fs_basepath: 'C:/clean',
      fs_homepath: 'C:/home',
      cl_renderer: 'opengl1',
      r_fullscreen: '1',
      r_mode: '-1',
      r_customwidth: String(CAPTURE_WIDTH),
      r_customheight: String(CAPTURE_HEIGHT),
      r_overBrightBits: '1',
      r_mapOverBrightBits: '2',
      r_fullbright: '0',
      r_picmip: '0',
      r_drawentities: '0',
      cg_draw2D: '0',
      cg_fov: '90',
      cl_noprint: '1',
      logfile: '2'
    });
    // The sky drawn, at `r_fastsky`'s default.
    expect(sets(args)).not.toHaveProperty('r_fastsky');
    expect(args.slice(args.lastIndexOf('+set') + 3)).toEqual(['+exec', CAPTURE_SCRIPT]);
    // Q3 keeps 32 lines of a command line, the part before the first `+` among them.
    expect(args.filter((arg) => arg.startsWith('+')).length + 1).toBeLessThanOrEqual(32);
  });

  it('scripts each view, shot at a fixed step with its counts, and quits', () => {
    // The retail game module has no `g_localTeamPref`: the player joins, then spectates.
    const view = (map) => [
      `devmap ${map}`,
      'wait 400',
      'team spectator',
      'wait 400',
      'fixedtime 1',
      'cg_showmiss 2',
      'r_speeds 5',
      'wait 3',
      'r_speeds 1',
      'wait 10',
      `screenshot ${map}`,
      'wait 30',
      'fixedtime 0',
      'cg_showmiss 0',
      'r_speeds 0'
    ];
    expect(captureScript(['q3dm1', 'q3dm17']).split('\n')).toEqual([
      ...view('q3dm1'),
      ...view('q3dm17'),
      'quit',
      ''
    ]);
  });

  it('draws in a window for --window and --fullbright, unlit for --fullbright', () => {
    const run = (mode, entities) =>
      sets(q3Arguments({ basepath: 'b', homepath: 'h', mode, entities }));
    const windowed = { r_fullscreen: '0', in_nograb: '1' };
    expect(run('window')).toMatchObject({ ...windowed, r_fullbright: '0' });
    expect(run('fullbright')).toMatchObject({ ...windowed, r_fullbright: '1' });
    // ioquake3 drops a fullscreen that may not grab the mouse to a window.
    expect(run('fullscreen', true)).toMatchObject({
      r_fullscreen: '1',
      in_nograb: '0',
      r_drawentities: '1'
    });
  });

  it("reads each screenshot's time from the console: the last cg.time printed before it", () => {
    const log = [
      'Wrote screenshots/early.tga',
      '[9000 : 8990] [9001 : 8991] Wrote screenshots/q3dm1.tga',
      '[9002 : 8992] not moved',
      '----- Server Shutdown -----',
      '[13001 : 12996] [13002 : 12997] Wrote screenshots/q3dm17.tga',
      'Wrote screenshots/again.tga',
      ''
    ].join('\n');
    expect(shotTimes(log)).toEqual(
      new Map([
        ['q3dm1', 8991],
        ['q3dm17', 12997]
      ])
    );
  });

  it("reads each screenshot's counts from the console: the last r_speeds 1 and 5 before it", () => {
    const line = (shaders) =>
      `${shaders}/503 shaders/surfs 274 leafs 3880 verts 2765/1757 tris 21.97 mtex 0 dc`;
    const log = [
      `${line(1)}`,
      'Wrote screenshots/early.tga',
      'zFar: 1600',
      'zFar: 1598',
      `[9000 : 8990] ${line(56)}`,
      `[9001 : 8991] ${line(57)}`,
      'Wrote screenshots/q3dm1.tga',
      '----- Server Shutdown -----',
      'zFar: 4878',
      'Wrote screenshots/nocounts.tga',
      line(44),
      'Wrote screenshots/nozfar.tga',
      ''
    ].join('\n');
    const counts = {
      surfaces: 503,
      leafs: 274,
      vertexes: 3880,
      triangles: 2765,
      passTriangles: 1757,
      zFar: 1598
    };
    expect(shotSpeeds(log)).toEqual(new Map([['q3dm1', { shaders: 57, ...counts }]]));
    expect(speedsLine({ shaders: 57, ...counts })).toBe(
      '57/503 shaders/surfs 274 leafs 3880 verts 2765/1757 tris zFar: 1598'
    );
  });

  it("names the counts two views differ in, Q3's first", () => {
    const q3 = {
      shaders: 57,
      surfaces: 503,
      leafs: 274,
      vertexes: 1,
      triangles: 2,
      passTriangles: 3,
      zFar: 9
    };
    expect(speedsDiffer(q3, { ...q3 })).toEqual({});
    expect(speedsDiffer(q3, { ...q3, leafs: 280, zFar: 10 })).toEqual({
      leafs: [274, 280],
      zFar: [9, 10]
    });
  });

  it('tells a screenshot through the ramp by its bytes: all even, or 255', () => {
    expect(ramped(picture(2, 1, [[0, 2, 254], [255, 128, 100]]))).toBe(true);
    expect(ramped(picture(2, 1, [[0, 2, 254], [255, 127, 100]]))).toBe(false);
    // Alpha is no channel of the ramp's.
    const shot = picture(1, 1, [[2, 4, 6]]);
    shot.pixels[3] = 7;
    expect(ramped(shot)).toBe(true);
  });

  it('reads its screenshot, a bottom-up BGR TGA, top row first', () => {
    const header = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 24, 0];
    // The bottom row first: blue, then green; above them red, then white.
    const bytes = Uint8Array.from([...header, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    expect(readTga(bytes)).toEqual(
      picture(2, 2, [
        [255, 0, 0],
        [255, 255, 255],
        [0, 0, 255],
        [0, 255, 0]
      ])
    );
  });
});

describe("the port's side", () => {
  it("opens the map's preview as the capture views it, the overbright pair at its defaults", () => {
    const settings = (view) => {
      const address = new URL(portAddress('http://localhost:5555', 'q3dm11', view));
      return Object.fromEntries(address.searchParams);
    };
    expect(settings()).toEqual({
      map: 'q3dm11',
      pcq_preview: '1',
      r_picmip: '0',
      cg_fov: '90',
      r_drawentities: '0'
    });
    expect(settings({ mode: 'window' })).toEqual({
      map: 'q3dm11',
      pcq_preview: '1',
      r_overBrightBits: '0',
      r_picmip: '0',
      cg_fov: '90',
      r_drawentities: '0'
    });
    expect(settings({ time: 12345 })).toEqual({
      map: 'q3dm11',
      pcq_preview: '1',
      r_picmip: '0',
      cg_fov: '90',
      r_drawentities: '0',
      pcq_previewTime: '12345'
    });
    expect(settings({ mode: 'fullbright', entities: true })).toEqual({
      map: 'q3dm11',
      pcq_preview: '1',
      r_overBrightBits: '0',
      r_fullbright: '1',
      r_picmip: '0',
      cg_fov: '90',
      r_drawentities: '1'
    });
  });

  it('reads an RGB PNG through every filter', () => {
    // Worked by hand: Sub, Up, Average and Paeth rows of a 2×4 picture.
    const raw = Uint8Array.from([
      ...[1, 10, 20, 30, 5, 5, 5],
      ...[2, 2, 2, 2, 5, 5, 5],
      ...[3, 255, 250, 245, 250, 246, 242],
      ...[4, 2, 2, 2, 2, 2, 1]
    ]);
    const header = new Uint8Array(13);
    new DataView(header.buffer).setUint32(0, 2);
    new DataView(header.buffer).setUint32(4, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const bytes = Buffer.concat([
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array(0))
    ]);
    expect(readPng(bytes)).toEqual(
      picture(2, 4, [
        [10, 20, 30],
        [15, 25, 35],
        [12, 22, 32],
        [20, 30, 40],
        [5, 5, 5],
        [6, 7, 8],
        [7, 7, 7],
        [9, 9, 9]
      ])
    );
  });

  it('writes a PNG that reads back as it was', () => {
    const shot = picture(3, 2, [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10, 11, 12],
      [13, 14, 15],
      [255, 0, 128]
    ]);
    expect(readPng(writePng(shot))).toEqual(shot);
  });
});

describe('the comparison', () => {
  it('scores two pictures by their mean difference and the share within the tolerance', () => {
    const a = picture(2, 1, [
      [100, 100, 100],
      [100, 100, 100]
    ]);
    expect(compare(a, a)).toMatchObject({ mean: 0, within: 1 });
    const b = picture(2, 1, [
      [100 + TOLERANCE, 100, 100],
      [100 + TOLERANCE + 1, 100, 100]
    ]);
    const { mean, within, diff } = compare(a, b);
    expect(mean).toBeCloseTo((2 * TOLERANCE + 1) / 6);
    expect(within).toBe(0.5);
    expect([...diff.pixels.subarray(0, 4)]).toEqual([TOLERANCE * 4, 0, 0, 255]);
    expect(() => compare(a, picture(1, 1, [[0, 0, 0]]))).toThrow();
  });

  it('holds each map the capture shoots to a mark in every mode', () => {
    // q3tourney5's start is inside its fog.
    expect(CAPTURE_MAPS).toContain('q3tourney5');
    expect(Object.keys(PASS_MARKS)).toEqual(['fullscreen', 'window', 'fullbright']);
    for (const marks of Object.values(PASS_MARKS)) {
      expect(Object.keys(marks)).toEqual(CAPTURE_MAPS);
    }
  });

  it('lays pictures side by side', () => {
    const left = picture(1, 2, [
      [1, 1, 1],
      [2, 2, 2]
    ]);
    const right = picture(2, 2, [
      [3, 3, 3],
      [4, 4, 4],
      [5, 5, 5],
      [6, 6, 6]
    ]);
    expect(sideBySide([left, right])).toEqual(
      picture(3, 2, [
        [1, 1, 1],
        [3, 3, 3],
        [4, 4, 4],
        [2, 2, 2],
        [5, 5, 5],
        [6, 6, 6]
      ])
    );
  });
});

describe('retailBasepath', () => {
  /** An install's folder, its `baseq3` holding these files, removed after `body`. */
  function withInstall(names, body) {
    const install = mkdtempSync(join(tmpdir(), 'pcq-install-'));
    try {
      mkdirSync(join(install, 'baseq3'));
      for (const name of names) writeFileSync(join(install, 'baseq3', name), name);
      body(install);
    } finally {
      rmSync(install, { recursive: true, force: true });
    }
  }

  it("links the install's nine retail paks, in their own case, and nothing else", () => {
    const paks = RETAIL_PAKS.map((pak, i) => (i === 0 ? pak.toUpperCase() : pak));
    withInstall([...paks, 'zz-map.pk3', 'q3config.cfg'], (install) => {
      const base = retailBasepath(install);
      try {
        expect(readdirSync(join(base, 'baseq3')).sort()).toEqual([...paks].sort());
        expect(readFileSync(join(base, 'baseq3', 'PAK0.PK3'), 'utf8')).toBe('PAK0.PK3');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  it('refuses an install without one of them', () => {
    withInstall(
      RETAIL_PAKS.filter((pak) => pak !== 'pak5.pk3'),
      (install) => expect(() => retailBasepath(install)).toThrow('pak5.pk3 is not in')
    );
  });

  it('links the map paks a check names beside them, in their own case, or refuses', () => {
    withInstall([...RETAIL_PAKS, 'Map_CPM18.pk3', 'zz-map.pk3'], (install) => {
      const base = retailBasepath(install, ['map_cpm18.pk3']);
      try {
        expect(readdirSync(join(base, 'baseq3')).sort()).toEqual(
          [...RETAIL_PAKS, 'Map_CPM18.pk3'].sort()
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
      expect(() => retailBasepath(install, ['map_cpm19.pk3'])).toThrow('map_cpm19.pk3 is not in');
    });
  });
});
