#!/usr/bin/env node
/**
 * The reference capture: each map as Quake 3's own `opengl1` draws it, beside the port's preview of
 * the same view at the same time, and how far apart they are.
 *
 * Quake 3 runs from the install, read only, against a folder of its own that holds the retail paks
 * alone, linked from the install's `baseq3`. An install's `baseq3` collects third-party paks and
 * loose files that override the retail data, and neither side may read them. Q3 writes nothing but
 * into a home folder of its own. One run shoots every map: `devmap`, a spectator's first view at
 * 4:3, a screenshot, then the next, and quit.
 *
 * By default Q3 runs in fullscreen, as it is played, so the screen is Q3's for about a minute and
 * must be left alone: a fullscreen window that loses focus minimises. Its screenshots carry the
 * gamma ramp, and one that does not, because the display gave Q3 no ramp, stops the capture.
 *
 * Q3's console log gives the time each screenshot was drawn at, and the view's counts as
 * `r_speeds 1` and `r_speeds 5` print them. The port then draws each map's preview from the same
 * paks, in a headless Chromium of the same size, at the same settings, its stages set at that
 * time, and the two are compared texel by texel. The preview's counts are read beside Q3's.
 *
 * Usage:
 *   npm run reference
 *   npm run reference -- --maps q3dm1,q3dm17 --out <dir>
 *   npm run reference -- --window
 *   npm run reference -- --fullbright
 *   npm run reference -- --maps q3dm10 --entities
 *
 * `--window` runs Q3 in a window, where it has no overbright, against the port at
 * `r_overBrightBits 0`; `--fullbright` does the same under `r_fullbright 1`. With `--entities`
 * both sides draw the brush models too, and Quake 3 its items, which the port's preview has none
 * of. Each names its files: `<map>-window-…`, `<map>-entities-…`.
 *
 * It writes `<map>-q3.png`, `<map>-port.png` and `<map>-pair.png` (Q3, the port, and the difference
 * four times as bright) and `scores.json`, each map's scores with its time and both sides' counts,
 * under the OS's temp folder unless `--out` says where.
 * It prints each map's scores against its mode's pass mark (`PASS_MARKS`), and fails if one falls
 * below. It prints both sides' counts, and what they differ in, which fails nothing: Q3's game
 * can close an area the preview shows.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BASEGAME, fsBasepath } from './fs-basepath.mjs';
import { keepSocketsHere } from './perf/perf-lib.mjs';
import {
  CAPTURE_HEIGHT,
  CAPTURE_MAPS,
  CAPTURE_SCRIPT,
  CAPTURE_WIDTH,
  PASS_MARKS,
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

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
/** The install's ioquake3. */
const EXECUTABLE = 'ioquake3.x86_64.exe';
/** How long Q3 may take over one map, load and all. */
const Q3_TIMEOUT = 180000;

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const maps = option('maps')?.split(',') ?? CAPTURE_MAPS;
const entities = process.argv.includes('--entities');
const flags = ['window', 'fullbright'].filter((flag) => process.argv.includes(`--${flag}`));
if (flags.length > 1) {
  console.error('Take --window or --fullbright, not both.');
  process.exit(1);
}
/** @type {import('./q3-reference-lib.mjs').Mode} */
const mode = flags[0] ?? 'fullscreen';
const named = (map) =>
  [map, mode === 'fullscreen' ? '' : mode, entities ? 'entities' : ''].filter(Boolean).join('-');
const out = resolve(option('out') ?? mkdtempSync(join(tmpdir(), 'pcq-reference-')));
const install = fsBasepath(ROOT, 'development');

/**
 * Each map's screenshot, as Quake 3 draws it, all in one run, the time it was drawn at, and its
 * view's counts. Its console log is kept beside the pictures, as `<run>-qconsole.log`.
 */
function captureQ3(base) {
  const shots = new Map();
  let times = new Map();
  let speeds = new Map();
  const home = mkdtempSync(join(tmpdir(), 'pcq-q3home-'));
  try {
    mkdirSync(join(home, BASEGAME));
    writeFileSync(join(home, BASEGAME, CAPTURE_SCRIPT), captureScript(maps));
    const args = q3Arguments({ basepath: base, homepath: home, mode, entities });
    const run = spawnSync(join(install, EXECUTABLE), args, {
      cwd: install,
      timeout: Q3_TIMEOUT * maps.length,
      stdio: 'ignore',
      // Unelevated, whatever the exe's compatibility settings ask: it writes only to the
      // folders made for it, and a launch that wants elevation cannot start from here.
      env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' }
    });
    const log = join(home, BASEGAME, 'qconsole.log');
    if (existsSync(log)) {
      copyFileSync(log, join(out, `${named('run')}-qconsole.log`));
      const text = readFileSync(log, 'latin1');
      times = shotTimes(text);
      speeds = shotSpeeds(text);
    }
    for (const map of maps) {
      const shot = join(home, BASEGAME, 'screenshots', `${map}.tga`);
      if (!existsSync(shot)) {
        const why = `exit ${run.status}, ${run.error ?? 'no error'}`;
        throw new Error(`Quake 3 wrote no screenshot of ${map} (${why})`);
      }
      if (!times.has(map)) {
        throw new Error(`Quake 3's console gave no time for its screenshot of ${map}`);
      }
      const picture = readTga(readFileSync(shot));
      writeFileSync(join(out, `${named(map)}-q3.png`), writePng(picture));
      shots.set(map, picture);
    }
    // Without the ramp, Q3 drew without overbright, and the pairs would compare nothing. Its
    // console's `GAMMA:` line says whether the display gave it one.
    const flat = maps.filter((map) => !ramped(shots.get(map)));
    if (mode === 'fullscreen' && flat.length > 0) {
      throw new Error(`Quake 3's screenshots of ${flat.join(', ')} carry no gamma ramp`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return { shots, times, speeds };
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.on('error', fail);
    probe.listen(0, 'localhost', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

/**
 * Each map's preview at its start and Q3's time, as the port draws it from the same paks, and its
 * view's counts.
 */
async function capturePort(base, times) {
  process.env.PCQ_FS_BASEPATH = base;
  const home = mkdtempSync(join(tmpdir(), 'pcq-home-'));
  process.env.PCQ_FS_HOMEPATH = home;
  const require = createRequire(join(ROOT, 'package.json'));
  const { chromium } = require('playwright');
  const vite = pathToFileURL(join(ROOT, 'node_modules/vite/dist/node/index.js')).href;
  const { createServer } = await import(vite);
  const port = await freePort();
  const server = await createServer({
    root: ROOT,
    logLevel: 'warn',
    clearScreen: false,
    server: { host: 'localhost', port, strictPort: true, forwardConsole: false }
  });
  await server.listen();
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required']
  });
  const shots = new Map();
  const speeds = new Map();
  try {
    const viewport = { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT };
    const context = await browser.newContext({ viewport });
    await keepSocketsHere(context);
    const page = await context.newPage();
    for (const map of maps) {
      const view = { mode, entities, time: times.get(map) };
      await page.goto(portAddress(`http://localhost:${port}`, map, view));
      // `pcq` is set once the boot's load screen has closed, which can be after a quick map's
      // preview is in.
      await page.waitForFunction(
        (name) => window.pcq !== undefined && window.pcqPreview?.()?.name === name,
        map,
        { timeout: 240000 }
      );
      // A few frames drawn at the start.
      await page.waitForTimeout(500);
      shots.set(map, readPng(await page.screenshot()));
      speeds.set(map, await page.evaluate(() => window.pcqPreview().speeds()));
    }
  } finally {
    await browser.close();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
  return { shots, speeds };
}

mkdirSync(out, { recursive: true });
const base = retailBasepath(install);
try {
  const { shots: q3, times, speeds: q3Speeds } = captureQ3(base);
  const { shots: port, speeds: portSpeeds } = await capturePort(base, times);
  const scores = {};
  for (const map of maps) {
    const { mean, within, diff } = compare(q3.get(map), port.get(map));
    const time = times.get(map);
    const speeds = { q3: q3Speeds.get(map) ?? null, port: portSpeeds.get(map) };
    scores[map] = {
      mean: Number(mean.toFixed(2)),
      within: Number(within.toFixed(4)),
      time,
      speeds
    };
    writeFileSync(join(out, `${named(map)}-port.png`), writePng(port.get(map)));
    const pair = sideBySide([q3.get(map), port.get(map), diff]);
    writeFileSync(join(out, `${named(map)}-pair.png`), writePng(pair));
  }
  writeFileSync(join(out, `${named('scores')}.json`), JSON.stringify(scores, null, 2));
  console.log(`Written to ${out}`);
  let below = false;
  for (const [map, { mean, within }] of Object.entries(scores)) {
    const share = `${(within * 100).toFixed(1)}%`;
    // A view drawn with entities shows Q3's items, which the preview hasn't got: no mark holds.
    const mark = entities ? undefined : PASS_MARKS[mode][map];
    const verdict = mark === undefined ? '' : within >= mark ? '  pass' : `  BELOW ${mark * 100}%`;
    below ||= mark !== undefined && within < mark;
    console.log(`${map.padEnd(8)} mean ${String(mean).padStart(6)}  within ${share}${verdict}`);
  }
  for (const [map, { speeds }] of Object.entries(scores)) {
    console.log(`${map}`);
    console.log(`  Q3    ${speeds.q3 ? speedsLine(speeds.q3) : 'printed no counts'}`);
    console.log(`  port  ${speedsLine(speeds.port)}`);
    if (speeds.q3) {
      const differ = Object.entries(speedsDiffer(speeds.q3, speeds.port));
      const said = differ.map(([name, [a, b]]) => `${name} ${a} against ${b}`).join(', ');
      console.log(`  ${differ.length === 0 ? 'the same' : `differ: ${said}`}`);
    }
  }
  if (below) process.exitCode = 1;
} finally {
  rmSync(base, { recursive: true, force: true });
}
