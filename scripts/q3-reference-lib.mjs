/**
 * The reference capture's pieces: the retail paks Quake 3 runs on, its command line for the maps'
 * views, the time each was drawn at, the port's address for each, the pictures both sides write,
 * and how two pictures of one view compare. No engine and no browser, so the tests run them as they
 * are (`q3-reference-lib.test.mjs`).
 */

import { linkSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import { BASEGAME } from './fs-basepath.mjs';

/** The capture's size: 4:3, where Q3's `cg_fov` and the port's, Quake Live's, agree. */
export const CAPTURE_WIDTH = 1024;
export const CAPTURE_HEIGHT = 768;

/** The retail paks, all Q3 reads for a clean capture. */
export const RETAIL_PAKS = Array.from({ length: 9 }, (_, i) => `pak${i}.pk3`);

/**
 * A folder of the install's retail paks alone, linked, as Quake 3's `fs_basepath`. An install's
 * `baseq3` collects third-party paks and loose files that override the retail data, and neither
 * side of a comparison may read them, but for the map paks a check names. The caller removes it.
 *
 * @param install - The install's folder.
 * @param maps - Third-party paks to link beside the retail ones, each a map a check plays on.
 * @returns The folder.
 * @throws for a pak the install has not got
 */
export function retailBasepath(install, maps = []) {
  const base = mkdtempSync(join(tmpdir(), 'pcq-base-'));
  mkdirSync(join(base, BASEGAME));
  const installed = readdirSync(join(install, BASEGAME));
  for (const pak of [...RETAIL_PAKS, ...maps]) {
    const found = installed.find((name) => name.toLowerCase() === pak.toLowerCase());
    if (!found) throw new Error(`${pak} is not in ${join(install, BASEGAME)}`);
    linkSync(join(install, BASEGAME, found), join(base, BASEGAME, found));
  }
  return base;
}

/**
 * The maps the capture shoots: between them every kind of surface, sky and brush model, and fog
 * seen from outside it and from within.
 */
export const CAPTURE_MAPS = ['q3dm1', 'q3dm4', 'q3dm9', 'q3dm10', 'q3dm11', 'q3dm17', 'q3tourney5'];

/** How far apart two texels may be on every channel and still count as the same. */
export const TOLERANCE = 16;

/**
 * How the two sides draw:
 * - **`fullscreen`**, as Q3 is played: `opengl1` at `r_overBrightBits 1`, its screenshot passed
 *   through the gamma ramp as the screen shows it (`R_GammaCorrect`, `tr_init.c:440-442`), against
 *   the port at its defaults.
 * - **`window`**: Q3 in a window, where it never overbrights, against the port at
 *   `r_overBrightBits 0`.
 * - **`fullbright`**: both in a window under `r_fullbright 1`, the world unlit.
 *
 * @typedef {'fullscreen' | 'window' | 'fullbright'} Mode
 */

/**
 * The share of each view's texels each map must keep within {@link TOLERANCE} of Quake 3's, by
 * mode: what it reached when the marks were set, on 2026-10-09, less two points, since a run's
 * picture can fall a frame or two from the time Q3 printed for it.
 *
 * @type {Record<Mode, Record<string, number>>}
 */
export const PASS_MARKS = {
  fullscreen: {
    q3dm1: 0.98,
    q3dm4: 0.98,
    q3dm9: 0.98,
    q3dm10: 0.979,
    q3dm11: 0.979,
    q3dm17: 0.979,
    q3tourney5: 0.98
  },
  window: {
    q3dm1: 0.98,
    q3dm4: 0.98,
    q3dm9: 0.98,
    q3dm10: 0.98,
    q3dm11: 0.979,
    q3dm17: 0.98,
    q3tourney5: 0.98
  },
  fullbright: {
    q3dm1: 0.98,
    q3dm4: 0.98,
    q3dm9: 0.98,
    q3dm10: 0.979,
    q3dm11: 0.979,
    q3dm17: 0.98,
    q3tourney5: 0.98
  }
};

/**
 * The frames Q3 waits after `devmap` before it joins the spectators, and again before its
 * screenshot: long enough for the map, cgame and the first snapshots to load, and for the view to
 * have stood still a while, since `screenshot` reads the frame before its own.
 */
const SETTLE_FRAMES = 400;

/**
 * The frames Q3 steps a millisecond at a time before its screenshot, so that the frame it reads,
 * whichever the driver keeps, was drawn a millisecond or two from the time printed last.
 */
const FIXED_FRAMES = 10;

/** The script of views Quake 3 runs, written into its home folder's `baseq3`. */
export const CAPTURE_SCRIPT = 'pcq-capture.cfg';

/**
 * Quake 3's command line for a capture: its settings, then {@link CAPTURE_SCRIPT}. The views go in
 * the script because Q3 keeps at most 32 of the command line's lines (`MAX_CONSOLE_LINES`,
 * `common.c:413`), and runs the rest as one.
 *
 * Every `+set` is applied before the renderer starts (`Com_StartupVariable`), so the latched and
 * cheat-protected ones hold; `devmap` keeps cheats on. `+safe` reads no `q3config.cfg` or
 * `autoexec.cfg`. `logfile 2` keeps all it prints in `qconsole.log`.
 *
 * @param {{ basepath: string, homepath: string, mode?: Mode, entities?: boolean }} run - With
 *   `entities`, the brush models and items are drawn too, `r_drawentities 1`.
 * @returns {string[]}
 */
export function q3Arguments({ basepath, homepath, mode = 'fullscreen', entities = false }) {
  const sets = {
    fs_basepath: basepath,
    fs_homepath: homepath,
    cl_renderer: 'opengl1',
    r_fullscreen: mode === 'fullscreen' ? '1' : '0',
    r_mode: '-1',
    r_customwidth: String(CAPTURE_WIDTH),
    r_customheight: String(CAPTURE_HEIGHT),
    r_noborder: '0',
    s_initsound: '0',
    // A window leaves the mouse free; fullscreen must take it, or ioquake3 drops to a window
    // (`sdl_glimp.c:861-867`).
    in_nograb: mode === 'fullscreen' ? '0' : '1',
    r_overBrightBits: '1',
    r_mapOverBrightBits: '2',
    r_fullbright: mode === 'fullbright' ? '1' : '0',
    r_picmip: '0',
    r_drawentities: entities ? '1' : '0',
    cg_draw2D: '0',
    cg_fov: '90',
    // Nothing printed reaches the console, so none is drawn over a view: `con_notifytime 0` still
    // draws a line printed in the frame drawn (`cl_console.c:600`). The log has it all.
    cl_noprint: '1',
    logfile: '2'
  };
  return [
    '+safe',
    ...Object.entries(sets).flatMap(([name, value]) => ['+set', name, value]),
    '+exec',
    CAPTURE_SCRIPT
  ];
}

/**
 * {@link CAPTURE_SCRIPT}: each map as a spectator first sees it, then a screenshot, and after the
 * last, quit. One run changes the display's mode once, however many maps it shoots.
 *
 * The player joins, then `team spectator` respawns them at the intermission point, since the
 * retail game module has no `g_localTeamPref`. Before the screenshot, `fixedtime 1` steps Q3's
 * clock a millisecond a frame, and `cg_showmiss 2` has cgame print its time each frame
 * ({@link shotTimes}). `r_speeds 5` prints the far plane a few frames, then `r_speeds 1` the
 * view's counts each frame ({@link shotSpeeds}). Each is a cheat `devmap` allows, and goes back to
 * 0 after. The wait after each screenshot lets it be written before the next map loads.
 *
 * @param {string[]} maps
 * @returns {string}
 */
export function captureScript(maps) {
  const views = maps.flatMap((map) => [
    `devmap ${map}`,
    `wait ${SETTLE_FRAMES}`,
    'team spectator',
    `wait ${SETTLE_FRAMES}`,
    'fixedtime 1',
    'cg_showmiss 2',
    'r_speeds 5',
    'wait 3',
    'r_speeds 1',
    `wait ${FIXED_FRAMES}`,
    `screenshot ${map}`,
    'wait 30',
    'fixedtime 0',
    'cg_showmiss 0',
    'r_speeds 0'
  ]);
  return [...views, 'quit', ''].join('\n');
}

/** What Q3's console says of a frame's time under `cg_showmiss 2`, and of a screenshot written. */
const CONSOLE_TIMES = /\[-?\d+ : (-?\d+)\] |Wrote screenshots\/(\S+)\.tga/g;

/**
 * Each screenshot's time, by its name, from Quake 3's console log: the `cg.time` that cgame printed
 * last before it, as `[<command's time> : <cg.time>] ` (`cg_predict.c:595-597`). `screenshot`
 * prints as it runs, before its frame is drawn (`tr_init.c:689-692`), so the time is the frame's
 * before, which it reads. A screenshot with no time printed since the one before has none.
 *
 * @param {string} log
 * @returns {Map<string, number>} In milliseconds.
 */
export function shotTimes(log) {
  const times = new Map();
  let time;
  for (const [, printed, shot] of log.matchAll(CONSOLE_TIMES)) {
    if (printed !== undefined) {
      time = Number(printed);
      continue;
    }
    if (time !== undefined) times.set(shot, time);
    time = undefined;
  }
  return times;
}

/**
 * What `r_speeds 1` prints of a frame (`R_PerformanceCounters`, `tr_cmds.c:37-41`), what
 * `r_speeds 5` prints, and a screenshot written. A line may follow `cg_showmiss`'s on its line.
 */
const CONSOLE_SPEEDS = new RegExp(
  [
    String.raw`(\d+)/(\d+) shaders/surfs (\d+) leafs (\d+) verts (\d+)/(\d+) tris`,
    String.raw`zFar: (\d+)`,
    String.raw`Wrote screenshots/(\S+)\.tga`
  ].join('|'),
  'g'
);

/**
 * A view's counts, as `r_speeds 1` and `r_speeds 5` print them: the batches, the surfaces added,
 * the leafs reached, the batches' vertexes, their triangles, those once a pass, and the far plane.
 *
 * @typedef {{ shaders: number, surfaces: number, leafs: number, vertexes: number,
 *   triangles: number, passTriangles: number, zFar: number }} Speeds
 */

/**
 * Each screenshot's view's counts, by its name, from Quake 3's console log: the `r_speeds 1` line
 * and the `zFar` line printed last before it. Each frame prints its own, of a view that has stood
 * still. A screenshot with either missing since the one before has none.
 *
 * @param {string} log
 * @returns {Map<string, Speeds>}
 */
export function shotSpeeds(log) {
  const speeds = new Map();
  let counts;
  let zFar;
  for (const match of log.matchAll(CONSOLE_SPEEDS)) {
    const [, shaders, surfaces, leafs, vertexes, triangles, passes, far, shot] = match;
    if (shaders !== undefined) {
      counts = {
        shaders: Number(shaders),
        surfaces: Number(surfaces),
        leafs: Number(leafs),
        vertexes: Number(vertexes),
        triangles: Number(triangles),
        passTriangles: Number(passes)
      };
    } else if (far !== undefined) {
      zFar = Number(far);
    } else {
      if (counts !== undefined && zFar !== undefined) speeds.set(shot, { ...counts, zFar });
      counts = undefined;
      zFar = undefined;
    }
  }
  return speeds;
}

/**
 * A view's counts as `r_speeds 1` and `r_speeds 5` print them, on one line.
 *
 * @param {Speeds} speeds
 */
export function speedsLine({ shaders, surfaces, leafs, vertexes, triangles, passTriangles, zFar }) {
  return (
    `${shaders}/${surfaces} shaders/surfs ${leafs} leafs ${vertexes} verts ` +
    `${triangles}/${passTriangles} tris zFar: ${zFar}`
  );
}

/**
 * The counts two views differ in, each as `[Q3's, the port's]`.
 *
 * @param {Speeds} q3
 * @param {Speeds} port
 * @returns {Partial<Record<keyof Speeds, [number, number]>>}
 */
export function speedsDiffer(q3, port) {
  return Object.fromEntries(
    Object.keys(q3)
      .filter((name) => q3[name] !== port[name])
      .map((name) => [name, [q3[name], port[name]]])
  );
}

/**
 * The port's address for the same view: the map's preview, which `pcq_preview` opens on the
 * spectator's start, with its settings put where Q3's capture puts its own. In `fullscreen` the
 * overbright pair is left at its defaults.
 *
 * @param {string} origin - The dev server, `http://localhost:<port>`.
 * @param {string} map
 * @param {{ mode?: Mode, entities?: boolean, time?: number }} [view] - With `entities`, the brush
 *   models too; with `time`, the stages set at Q3's `cg.time`, in milliseconds.
 */
export function portAddress(origin, map, { mode = 'fullscreen', entities = false, time } = {}) {
  const settings = new URLSearchParams({ map, pcq_preview: '1' });
  if (mode !== 'fullscreen') settings.set('r_overBrightBits', '0');
  if (mode === 'fullbright') settings.set('r_fullbright', '1');
  settings.set('r_picmip', '0');
  settings.set('cg_fov', '90');
  settings.set('r_drawentities', entities ? '1' : '0');
  if (time !== undefined) settings.set('pcq_previewTime', String(time));
  return `${origin}/?${settings}`;
}

/**
 * Whether a screenshot has been through the ramp at one overbright bit: every byte even, or 255
 * where it clamped, as `i << 1` leaves them.
 *
 * @param {Picture} picture
 */
export function ramped({ pixels }) {
  for (let i = 0; i < pixels.length; i++) {
    if (i % 4 !== 3 && pixels[i] % 2 === 1 && pixels[i] !== 255) return false;
  }
  return true;
}

/**
 * @typedef {{ width: number, height: number, pixels: Uint8Array }} Picture
 * RGBA, four bytes a texel, the top row first.
 */

/**
 * A screenshot Q3 writes (`RB_TakeScreenshot`, `tr_init.c:406-412`): an uncompressed true-colour
 * TGA, BGR or BGRA, its rows from the bottom unless its descriptor says otherwise.
 *
 * @param {Uint8Array} bytes
 * @returns {Picture}
 */
export function readTga(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[2] !== 2) throw new Error(`tga: image type ${bytes[2]}, not uncompressed true colour`);
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const step = bytes[16] / 8;
  const top = (bytes[17] & 0x20) !== 0;
  const start = 18 + bytes[0];
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = top ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const at = start + (row * width + x) * step;
      const out = (y * width + x) * 4;
      pixels[out] = bytes[at + 2];
      pixels[out + 1] = bytes[at + 1];
      pixels[out + 2] = bytes[at];
      pixels[out + 3] = step === 4 ? bytes[at + 3] : 255;
    }
  }
  return { width, height, pixels };
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The PNG filters' predictor (`Paeth`). */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * A PNG of 8-bit RGB or RGBA, not interlaced: what a browser's screenshot is.
 *
 * @param {Uint8Array} bytes
 * @returns {Picture}
 */
export function readPng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(`png: depth ${depth}, colour type ${colour}, interlace ${interlace}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels] : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter];
      rows[y * stride + x] = (line[x] + predicted) & 0xff;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) pixels[i * 4 + c] = rows[i * channels + c];
    pixels[i * 4 + 3] = channels === 4 ? rows[i * channels + 3] : 255;
  }
  return { width, height, pixels };
}

/** The CRC each PNG chunk ends with. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(Buffer.from(type, 'latin1'), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/**
 * A picture as an RGBA PNG, every row unfiltered.
 *
 * @param {Picture} picture
 * @returns {Uint8Array}
 */
export function writePng({ width, height, pixels }) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0))
  ]);
}

/**
 * How two pictures of one view differ, colour alone: the mean difference of a channel, from 0 to
 * 255, the share of texels within {@link TOLERANCE} on every channel, and a picture of the
 * difference, four times as bright.
 *
 * @param {Picture} a
 * @param {Picture} b
 * @returns {{ mean: number, within: number, diff: Picture }}
 */
export function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`compare: ${a.width}×${a.height} against ${b.width}×${b.height}`);
  }
  const count = a.width * a.height;
  const diff = new Uint8Array(count * 4);
  let total = 0;
  let within = 0;
  for (let i = 0; i < count; i++) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.pixels[i * 4 + c] - b.pixels[i * 4 + c]);
      total += d;
      worst = Math.max(worst, d);
      diff[i * 4 + c] = Math.min(255, d * 4);
    }
    diff[i * 4 + 3] = 255;
    if (worst <= TOLERANCE) within++;
  }
  return {
    mean: total / (count * 3),
    within: within / count,
    diff: { width: a.width, height: a.height, pixels: diff }
  };
}

/**
 * Pictures of one height side by side, left to right.
 *
 * @param {Picture[]} pictures
 * @returns {Picture}
 */
export function sideBySide(pictures) {
  const height = pictures[0].height;
  const width = pictures.reduce((sum, picture) => sum + picture.width, 0);
  const pixels = new Uint8Array(width * height * 4);
  let left = 0;
  for (const picture of pictures) {
    for (let y = 0; y < height; y++) {
      pixels.set(
        picture.pixels.subarray(y * picture.width * 4, (y + 1) * picture.width * 4),
        (y * width + left) * 4
      );
    }
    left += picture.width;
  }
  return { width, height, pixels };
}
