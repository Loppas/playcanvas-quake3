// The preview's run: one boot of q3dm11's preview on one build of the engine, on a cold or a warm
// browser profile, drawn at 2560×1440 and flown on a tour, at 240 Hz and then unpaced.
//
//     node scripts/perf/perf-preview.mjs <build> <cache> [out] [settings]
//
// `build` and `cache` as perf-render.mjs has them; `settings`, cvars put in the page's address for
// a control run, as `r_novis=1&r_nocull=1` or `r_ext_multitexture=0`. The phases:
//
// 1. **start** — the load, its warm-up, and the first seconds at the start, under a trace.
// 2. **tour 240**, then **tour unpaced** — under a trace: five seconds standing at the start; then
//    at the start and at each spot a free-for-all spawns a human at, the camera placed there, a
//    turn of 360° through the mouse, and a flight along its facing through `+forward`, for 512
//    units or until a player's box would meet solid.
//
// Writes result.json, with the tour's places, and a compact frame log per phase under logs/. The
// traces are read and deleted. Headless, on the real GPU; nothing opens on screen.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compact, floor, hitches, rounded, slice, summarise, traceOffset, traceWindow } from './perf-analyse.mjs';
import {
  bootPreview,
  endTrace,
  installAppProbe,
  installPageHarness,
  KNOWN_NOISE,
  launchChrome,
  readTrace,
  remove,
  servedEngine,
  startTrace,
  startVite,
  throwawayHome,
  tourPlaces
} from './perf-lib.mjs';

const BUILD = process.argv[2] ?? 'profiler';
const CACHE = process.argv[3] ?? 'cold';
const OUT = process.argv[4] ?? join(tmpdir(), 'pcq-perf-preview', `${BUILD}-${CACHE}`);
const SETTINGS = process.argv[5] ?? '';
/** One profile per build, apart from the match's, so a warm run finds what its own cold run left. */
const PROFILE = join(tmpdir(), 'pcq-perf-profiles', `preview-${BUILD}`);
const MAP = 'q3dm11';
/** The display's rate the start is judged at, and the tour's rates in turn. */
const RATE = 240;
const TOUR_RATES = [240, 0];
/** Frames the log holds: the unpaced tour runs at hundreds a second for over a minute. */
const CAPACITY = 120000;
const START_MS = 3000;
const STAND_MS = 5000;
/** How long the camera stays at a place before it turns. */
const PLACED_MS = 250;
/** Degrees a second, as the match's turning scene turns. */
const TURN_RATE = 180;
/** The fly camera's speed at a full move: `g_speed`'s default (free-camera.ts). */
const FLY_SPEED = 320;
/** Quake 3's key code for F10, which holds the flight's `+forward`. */
const K_F10 = 154;
/** As perf-render.mjs traces: collections, Dawn's compiles, presents and the marks. */
const TRACE_CATEGORIES = ['disabled-by-default-v8.gc', 'disabled-by-default-gpu.dawn', 'viz', 'blink.user_timing'].filter(
  (category) => BUILD !== 'debug' || category !== 'disabled-by-default-gpu.dawn'
);
const keepEvent = ({ name = '' }) =>
  name.startsWith('V8.GC_') ||
  name.startsWith('perf:') ||
  name === 'SkiaOutputSurfaceImplOnGpu::SwapBuffers' ||
  name.startsWith('DeviceBase::APICreate');

if (!['debug', 'profiler', 'release'].includes(BUILD) || !['cold', 'warm'].includes(CACHE)) {
  throw new Error('usage: perf-preview.mjs <debug|profiler|release> <cold|warm> [out]');
}
remove(OUT);
mkdirSync(join(OUT, 'logs'), { recursive: true });
if (CACHE === 'cold') remove(PROFILE);

const home = throwawayHome();
const { server, port } = await startVite(BUILD);
const context = await launchChrome(PROFILE);
await installPageHarness(context, { rate: RATE, capacity: CAPACITY, record: true });
const page = context.pages()[0] ?? (await context.newPage());
const result = { build: BUILD, cache: CACHE, map: MAP, settings: SETTINGS, rate: RATE, port, problems: [], console: [], phases: {} };
const started = Date.now();
page.on('console', (m) => {
  const text = m.text();
  if (result.console.length < 400) result.console.push(`${((Date.now() - started) / 1000).toFixed(2)} ${m.type()}: ${text.slice(0, 200)}`);
  if ((m.type() === 'error' || m.type() === 'warning') && !KNOWN_NOISE.test(text)) {
    if (result.problems.length < 100) result.problems.push(`${m.type()}: ${text}`);
  }
});
page.on('pageerror', (e) => result.problems.push(`pageerror: ${e.message}`));
context.on('response', (r) => {
  if (r.status() >= 400 && !/favicon/.test(r.url())) result.problems.push(`${r.status()} ${r.url()}`);
});

const wait = (ms) => page.waitForTimeout(ms);
const mark = (name) => page.evaluate((n) => window.__perf.mark(n), name);

/** The difference of two angles, in (-180, 180]. */
const angleDelta = (a, b) => ((((b - a + 180) % 360) + 360) % 360) - 180;

/** The fly camera's eye, and its angles as Quake 3 has them, pitch positive looking down. */
const flyerView = () =>
  page.evaluate(() => {
    const { origin, angles } = window.pcqFlyer.view();
    return { eye: [origin.x, origin.y, origin.z], angles: [angles.x, angles.y, angles.z] };
  });

/** Puts the camera at a place, looking along its facing. */
const placeAt = ({ eye, angles }) =>
  page.evaluate(
    ([e, a]) => window.pcqFlyer.start({ origin: { x: e[0], y: e[1], z: e[2] }, angles: { x: a[0], y: a[1], z: a[2] } }),
    [eye, angles]
  );

/** The view's degrees per mouse count, yaw and pitch, measured by moving it and back. */
async function calibrate() {
  const a = await flyerView();
  await page.evaluate(() => window.pcqInput.mouseMove(200, 100));
  await wait(300);
  const b = await flyerView();
  const gains = { yawGain: angleDelta(a.angles[1], b.angles[1]) / 200, pitchGain: angleDelta(a.angles[0], b.angles[0]) / 100 };
  // A view that did not move would leave every turn waiting forever.
  if (gains.yawGain === 0 || gains.pitchGain === 0) throw new Error(`the view did not turn: ${JSON.stringify(gains)}`);
  await page.evaluate(() => window.pcqInput.mouseMove(-200, -100));
  await wait(300);
  await page.evaluate((g) => Object.assign(window.__perf.drive, g), gains);
  return gains;
}

/** Turns the view by `yaw` degrees at `TURN_RATE` degrees a second, through the harness's driver. */
async function turn(yaw) {
  await page.evaluate(([y, r]) => Object.assign(window.__perf.drive, { yawLeft: y, pitchLeft: 0, yawRate: r, pitchRate: r }), [yaw, TURN_RATE]);
  await page.waitForFunction(() => window.__perf.drive.yawLeft === 0, null, { timeout: 60000, polling: 50 });
}

/**
 * The flight's driver, after each frame's move: `+forward` pressed the frame a flight is asked for,
 * so the camera moves from the next, `FLY_SPEED` a second; and let go before the frame that would
 * carry it past the flight's end.
 */
function installFlight() {
  return page.evaluate(
    ([key, speed]) => {
      const flight = (window.__flight = { left: 0, asked: false, flying: false });
      window.pcqConfig.command(['bind', 'F10', '+forward']);
      window.pcq.app.on('update', (dt) => {
        if (flight.flying) {
          flight.left -= speed * dt;
          if (flight.left < speed * dt) {
            window.pcqInput.keyUp(key);
            flight.flying = false;
          }
        }
        if (flight.asked) {
          flight.asked = false;
          flight.flying = true;
          window.pcqInput.keyDown(key);
        }
      });
    },
    [K_F10, FLY_SPEED]
  );
}

/** Flies `distance` units along the view, and waits it out. */
async function fly(distance) {
  await page.evaluate((d) => Object.assign(window.__flight, { left: d, asked: true }), distance);
  await page.waitForFunction(() => !window.__flight.asked && !window.__flight.flying, null, { timeout: 60000, polling: 50 });
}

/** The tour at the rate its phase records at. */
async function tour(places, rate) {
  await placeAt(places[0]);
  await mark('standing');
  await wait(STAND_MS);
  for (const p of places) {
    await mark(`place ${p.name}`);
    await placeAt(p);
    await wait(PLACED_MS);
    await mark(`turn ${p.name}`);
    await turn(360);
    await mark(`fly ${p.name}`);
    // Back on its facing exactly, whatever the turn's rounding left.
    await placeAt(p);
    if (p.flight >= 1) await fly(p.flight);
    const { eye } = await flyerView();
    p.flown[rate || 'unpaced'] = Math.round(Math.hypot(eye[0] - p.eye[0], eye[1] - p.eye[1], eye[2] - p.eye[2]));
  }
}

/** Records a phase's frame log at `rate` under a trace, runs `body`, and reads it all back. */
async function phase(name, body, rate) {
  const cdp = await startTrace(page, TRACE_CATEGORIES);
  await page.evaluate((r) => {
    window.__perf.setRate(r);
    window.__perf.record();
    window.__perf.mark('begin');
  }, rate);
  const from = new Date().toISOString();
  await body();
  await mark('end');
  await wait(100);
  const log = await page.evaluate(() => window.__perf.take());
  await finish(name, log, rate, cdp);
  // The phase's span in the machine's clock, to set it beside what samples the GPU from outside.
  result.phases[name].wall = { from, to: new Date().toISOString() };
}

/** A phase's log and trace read into the result, with each stretch between marks on its own. */
async function finish(name, log, rate, cdp) {
  let traceFile = null;
  let parsed = null;
  let offset = null;
  if (cdp) {
    traceFile = join(OUT, `${name}.trace.json`);
    await endTrace(cdp, traceFile);
    parsed = readTrace(traceFile, keepEvent);
    offset = traceOffset(parsed, log.marks);
  }
  const period = rate > 0 ? 1000 / rate : 4;
  const entry = { rate, summary: summarise(log, rate), hitches: hitches(log, rate, { trace: parsed, offset }) };
  // The floor a paced phase is held to: its late frames, by whether the page's own work made them.
  if (rate > 0) entry.floor = floor(log, entry.hitches, rate);
  // A full log has lost the phase's end, and its last parts with it.
  if (log.rows >= CAPACITY) entry.full = true;
  if (parsed && offset !== null && log.rows > 0) {
    entry.trace = traceWindow(parsed, offset, log.columns.start[0], log.columns.end[log.rows - 1], period);
    delete entry.trace.compileList;
  } else if (cdp) {
    entry.trace = { error: 'no mark found in the trace' };
  }
  const marks = log.marks.filter((m) => m.name !== 'begin' && m.name !== 'end');
  entry.parts = {};
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].row;
    const to = i + 1 < marks.length ? marks[i + 1].row : log.rows;
    if (to - from < 2) continue;
    const s = summarise(slice(log, from, to), rate);
    entry.parts[marks[i].name] = {
      rows: s.rows,
      dt: { p50: s.dt.p50, p99: s.dt.p99, max: s.dt.max },
      hitches: s.hitches,
      js: { p50: s.js.p50, p99: s.js.p99, max: s.js.max },
      gpuFrame: { p50: s.gpuFrame.p50, p99: s.gpuFrame.p99 },
      drawCalls: { p50: s.drawCalls.p50, max: s.drawCalls.max },
      triangles: { p50: s.triangles.p50, max: s.triangles.max },
      pipelines: s.counters.pipelines?.total,
      shaders: s.counters.shadersGenerated?.total,
      longAnimationFrames: s.longAnimationFrames
    };
  }
  writeFileSync(join(OUT, 'logs', `${name}.json`), JSON.stringify(compact(log)));
  if (traceFile) rmSync(traceFile, { force: true });
  result.phases[name] = rounded(entry);
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}

try {
  // 1. The load, its warm-up and the first seconds. The log has run since the page opened.
  const startCdp = await startTrace(page, TRACE_CATEGORIES);
  result.loadMs = await bootPreview(page, port, MAP, SETTINGS);
  result.bootedAt = (Date.now() - started) / 1000;
  result.engine = servedEngine(server);
  result.app = await installAppProbe(page);
  await mark('in the preview');
  await wait(START_MS);
  await mark('end');
  {
    const log = await page.evaluate(() => window.__perf.take());
    log.marks.unshift({ name: 'load', row: 0, time: log.columns.start[0] });
    await finish('start', log, RATE, startCdp);
  }
  result.madeAfterStart = await page.evaluate(() => window.pcq.madeSinceWarmUp());
  // What the start's view draws, as `r_speeds` counts it.
  result.startSpeeds = await page.evaluate(() => window.pcqPreview().speeds());

  const start = await flyerView();
  // The start as the preview opened on it, then the spawn spots.
  result.places = await tourPlaces(server, MAP, start);
  result.gains = await calibrate();
  await installFlight();
  await wait(500);

  // 2. The tour, paced then not.
  for (const rate of TOUR_RATES) {
    const name = `tour ${rate || 'unpaced'}`;
    await phase(name, () => tour(result.places, rate), rate);
    result.phases[name].madeSinceWarmUp = await page.evaluate(() => window.pcq.madeSinceWarmUp());
  }

  result.gpuErrors = await page.evaluate(() => window.__perf.gpuErrors);
  result.totals = await page.evaluate(() => Object.fromEntries(window.__perf.counters.map((n, i) => [n, window.__perf.counts[i]])));
} catch (err) {
  result.error = String(err);
  result.stack = err?.stack;
} finally {
  await context.close().catch(() => {});
  await server.close();
  remove(home);
  // Chrome's caches as the run left them, which the warm run reads.
  const sizes = {};
  for (const dir of ['Default/DawnWebGPUCache', 'Default/DawnGraphiteCache', 'Default/GPUCache', 'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache']) {
    try {
      sizes[dir] = readdirSync(join(PROFILE, dir)).reduce((a, f) => a + statSync(join(PROFILE, dir, f)).size, 0);
    } catch {
      // Not made by this Chromium.
    }
  }
  result.profileCaches = sizes;
  result.problems = [...new Set(result.problems)];
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}
for (const [name, p] of Object.entries(result.phases)) {
  const s = p.summary;
  if (p.full) console.log(`${name}: the frame log filled, and its last parts are missing`);
  const made = p.madeSinceWarmUp ? `; made since the warm-up ${p.madeSinceWarmUp.shaders} shaders, ${p.madeSinceWarmUp.pipelines} pipelines` : '';
  const judged = p.floor ? `; the floor: ${p.floor.failing.length} failing, beside ${JSON.stringify(p.floor.beside)}` : '';
  console.log(
    `${name}: ${s.fps.toFixed(0)} fps; frame p50/p99/max ${s.dt.p50}/${s.dt.p99}/${s.dt.max} ms, ` +
      `${s.hitches.overOneAndAHalf} over 1.5 refreshes; JS p50/p99 ${s.js.p50}/${s.js.p99}; ` +
      `GPU p50/p99 ${s.gpuFrame.p50}/${s.gpuFrame.p99}; draws p50/max ${s.drawCalls.p50}/${s.drawCalls.max}${made}${judged}`
  );
}
if (result.error) console.log(`error: ${result.error}`);
console.log(`done ${OUT}`);
