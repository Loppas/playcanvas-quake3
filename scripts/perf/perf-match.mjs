// The match's run: one boot of a match on q3dm11 on one build of the engine, on a cold or a warm
// browser profile, drawn at 2560×1440, with the player and three of the port's bots, which join a
// BSP map with no AI and stand where they are put.
//
//     node scripts/perf/perf-match.mjs \
//       <build> <cache> [out]
//
// `build` and `cache` as perf-render.mjs has them. The phases, in order, so each moment meets its
// first draws before anything else has drawn them:
//
// 1. **start** — the load, its warm-up, and the first seconds in the world, under a trace.
// 2. **moments** — two passes, at 240 Hz under a trace: a turn of 360° at a spot not yet seen; a
//    rocket at a wall, its light, its explosion and where its mark goes; a bot joining, then put in
//    front of the player; the player killed by their own rockets and respawned.
// 3. **join** — at 240 Hz under a trace, three bots joining, each in a look of its own, and put
//    where the fight has them.
// 4. **tour 240**, then **tour unpaced** — under a trace, the bots standing there: at each spot a
//    free-for-all spawns a human at, the player put there, and a turn of 360° through the mouse.
// 5. **fight 240**, then **fight unpaced** — under a trace and `pcq_god 1`, the bots put back in
//    front of the player: rockets, then plasma swept across them and the walls behind, then
//    rockets again.
//
// The page puts the player and the bots where they stand through its DEV handle (`pcqDev`'s
// `place`), as the port has no `setviewpos`. The start's floor judges its frames from the load
// screen's close. Writes result.json, with the places and every shader and pipeline made after
// the start, and a compact frame log per phase under logs/. The traces are read and deleted.
// Headless, on the real GPU; nothing opens on screen.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compact,
  floor,
  hitches,
  rounded,
  slice,
  summarise,
  traceOffset,
  traceWindow
} from './perf-analyse.mjs';
import {
  bootMatch,
  endTrace,
  fightPlaces,
  installAppProbe,
  installPageHarness,
  KNOWN_NOISE,
  launchChrome,
  place,
  readTrace,
  remove,
  run,
  servedEngine,
  startTrace,
  startVite,
  throwawayHome,
  tourPlaces
} from './perf-lib.mjs';

const BUILD = process.argv[2] ?? 'profiler';
const CACHE = process.argv[3] ?? 'cold';
const OUT = process.argv[4] ?? join(tmpdir(), 'pcq-perf-match', `${BUILD}-${CACHE}`);
/** One profile per build, apart from the others', so a warm run finds what its cold run left. */
const PROFILE = join(tmpdir(), 'pcq-perf-profiles', `match-${BUILD}`);
const MAP = 'q3dm11';
/** The display's rate the moments are judged at, and the tour's and the fight's rates in turn. */
const RATE = 240;
const RATES = [240, 0];
/** Frames the log holds: an unpaced tour runs at hundreds a second for most of a minute. */
const CAPACITY = 120000;
/** How long the player stays at a place before turning, and how fast the turn is. */
const PLACED_MS = 250;
const TURN_RATE = 180;
/** The bots, in the order they join, so each has the slot after the last: 1, 2 and 3. */
const BOTS = ['grunt', 'xaero', 'sarge'];
/** Quake 3 key codes: F11 holds the attack. */
const K_F11 = 155;
/** `PM_DEAD` (`bg_public.h`): the player's move type while dead. */
const PM_DEAD = 3;
/** As perf-render.mjs traces: collections, Dawn's compiles, presents and the marks. */
const TRACE_CATEGORIES = [
  'disabled-by-default-v8.gc',
  'disabled-by-default-gpu.dawn',
  'viz',
  'blink.user_timing'
].filter((category) => BUILD !== 'debug' || category !== 'disabled-by-default-gpu.dawn');
const keepEvent = ({ name = '' }) =>
  name.startsWith('V8.GC_') ||
  name.startsWith('perf:') ||
  name === 'SkiaOutputSurfaceImplOnGpu::SwapBuffers' ||
  name.startsWith('DeviceBase::APICreate');

if (!['debug', 'profiler', 'release'].includes(BUILD) || !['cold', 'warm'].includes(CACHE)) {
  throw new Error('usage: perf-match.mjs <debug|profiler|release> <cold|warm> [out]');
}
remove(OUT);
mkdirSync(join(OUT, 'logs'), { recursive: true });
if (CACHE === 'cold') remove(PROFILE);

// Every weapon from the first spawn, and both master slots empty.
const home = throwawayHome('seta pcq_spawnWeapons 1\n');
const { server, port } = await startVite(BUILD);
const context = await launchChrome(PROFILE);
await installPageHarness(context, { rate: RATE, capacity: CAPACITY, record: true });
const page = context.pages()[0] ?? (await context.newPage());
const result = {
  build: BUILD,
  cache: CACHE,
  map: MAP,
  rate: RATE,
  port,
  problems: [],
  console: [],
  phases: {}
};
const started = Date.now();
page.on('console', (m) => {
  const text = m.text();
  if (result.console.length < 400) {
    const at = ((Date.now() - started) / 1000).toFixed(2);
    result.console.push(`${at} ${m.type()}: ${text.slice(0, 200)}`);
  }
  if ((m.type() === 'error' || m.type() === 'warning') && !KNOWN_NOISE.test(text)) {
    if (result.problems.length < 100) result.problems.push(`${m.type()}: ${text}`);
  }
});
page.on('pageerror', (e) => result.problems.push(`pageerror: ${e.message}`));
context.on('response', (r) => {
  if (r.status() >= 400 && !/favicon/.test(r.url())) {
    result.problems.push(`${r.status()} ${r.url()}`);
  }
});

const wait = (ms) => page.waitForTimeout(ms);
const mark = (name) => page.evaluate((n) => window.__perf.mark(n), name);

/** Holds the attack until `release`, as a player holds it down. */
async function hold() {
  await page.evaluate((k) => {
    window.pcqConfig.command(['bind', 'F11', '+attack']);
    window.pcqInput.keyDown(k);
  }, K_F11);
}
const release = () => page.evaluate((k) => window.pcqInput.keyUp(k), K_F11);

/** The difference of two angles, in (-180, 180]. */
const angleDelta = (a, b) => ((((b - a + 180) % 360) + 360) % 360) - 180;

const put = (client, origin, angles) => place(page, client, origin, angles);

/** The player at a place: its origin, the view height under its eye. */
const putPlayer = (p) => put(0, p.origin, p.angles);

/** The view's degrees per mouse count, yaw and pitch, measured by moving it and back. */
async function calibrate() {
  const angles = () => page.evaluate(() => ({ ...window.pcqController.viewAngles }));
  const a = await angles();
  await page.evaluate(() => window.pcqInput.mouseMove(200, 100));
  await wait(300);
  const b = await angles();
  const gains = { yawGain: angleDelta(a.y, b.y) / 200, pitchGain: angleDelta(a.x, b.x) / 100 };
  // A view that did not move would leave every turn waiting forever.
  if (gains.yawGain === 0 || gains.pitchGain === 0) {
    throw new Error(`the view did not turn: ${JSON.stringify(gains)}`);
  }
  await page.evaluate(() => window.pcqInput.mouseMove(-200, -100));
  await wait(300);
  await page.evaluate((g) => Object.assign(window.__perf.drive, g), gains);
  return gains;
}

/** Turns the view by `yaw` and `pitch` degrees at `rate` degrees a second, and waits it out. */
async function turn(yaw, pitch = 0, rate = TURN_RATE) {
  await page.evaluate(
    ([y, p, r]) =>
      Object.assign(window.__perf.drive, { yawLeft: y, pitchLeft: p, yawRate: r, pitchRate: r }),
    [yaw, pitch, rate]
  );
  await page.waitForFunction(
    () => window.__perf.drive.yawLeft === 0 && window.__perf.drive.pitchLeft === 0,
    null,
    { timeout: 60000, polling: 50 }
  );
}

/** Sets the pitch to `target` degrees, down positive, as Quake 3 has it. */
async function pitchTo(target) {
  const pitch = await page.evaluate(() => window.pcqController.viewAngles.x);
  await turn(0, target - pitch, 180);
}

/**
 * The bots in afresh, each in its slot, and the player at the fight's spot facing them where the
 * fight has them; then waits until all three are drawn there.
 */
async function joinBots(spots, at) {
  await run(page, 'kick allbots');
  await wait(1000);
  for (const bot of BOTS) {
    await mark(`join ${bot}`);
    await run(page, `addbot ${bot}`);
    await wait(1000);
  }
  await wait(2000);
  await mark('put');
  await putPlayer(at);
  for (let i = 0; i < BOTS.length; i++) await put(i + 1, spots.bots[i], spots.botAngles);
  // A body is drawn only for an entity in the snapshot, so all three show the slots they took.
  await page.waitForFunction(
    () => [1, 2, 3].every((n) => window.pcqPlayers.body(n) !== null),
    null,
    { timeout: 10000, polling: 100 }
  );
}

/**
 * Records a phase's frame log at `rate` under a trace, runs `body`, and reads it all back, with
 * what was made since the warm-up.
 */
async function phase(name, body, rate) {
  const cdp = await startTrace(page, TRACE_CATEGORIES);
  await page.evaluate(
    ([n, r]) => {
      window.__phase = n;
      window.__perf.setRate(r);
      window.__perf.record();
      window.__perf.mark('begin');
    },
    [name, rate]
  );
  const from = new Date().toISOString();
  await body();
  await mark('end');
  await wait(100);
  const log = await page.evaluate(() => {
    window.__phase = null;
    return window.__perf.take();
  });
  await finish(name, log, rate, cdp);
  result.phases[name].wall = { from, to: new Date().toISOString() };
  result.phases[name].madeSinceWarmUp = await page.evaluate(() => window.pcq.madeSinceWarmUp());
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}

/**
 * A phase's log and trace read into the result, with each stretch between marks on its own.
 *
 * @param {number} [judgedFrom] - The first row the floor judges: the start's frames in the world,
 *   its load screen gone.
 */
async function finish(name, log, rate, cdp, judgedFrom = 0) {
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
  const entry = {
    rate,
    summary: summarise(log, rate),
    hitches: hitches(log, rate, { trace: parsed, offset })
  };
  // The floor a paced phase is held to: its late frames, by whether the page's own work made them.
  // A late frame is the row before the one that found it.
  const judged = entry.hitches.filter((h) => h.row - 1 >= judgedFrom);
  if (rate > 0) entry.floor = floor(log, judged, rate);
  // A full log has lost the phase's end, and its last parts with it.
  if (log.rows >= CAPACITY) entry.full = true;
  const c = log.columns;
  if (parsed && offset !== null && log.rows > 0) {
    entry.trace = traceWindow(parsed, offset, c.start[0], c.end[log.rows - 1], period);
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

/** One pass of the moments. */
async function moments(pass, places, fight) {
  const named = (name) => places.find((p) => p.name === name);
  const at = named(fight.at);

  // A turn where the player has not been.
  await mark(`unseen ${pass}`);
  await putPlayer(named(fight.unseen));
  await wait(PLACED_MS);
  await turn(360);

  // A rocket at a wall: its flight, light and explosion, and where its mark goes.
  await putPlayer(named(fight.wall));
  await run(page, 'weapon 5');
  await wait(1000);
  await mark(`rocket ${pass}`);
  await hold();
  await wait(300);
  await release();
  await wait(2500);

  // A bot joining, wherever its spawn puts it; then put in front of the player.
  await putPlayer(at);
  await mark(`addbot ${pass}`);
  await run(page, `addbot ${BOTS[0]}`);
  await wait(3000);
  await mark(`bot seen ${pass}`);
  await put(1, fight.bots[0], fight.botAngles);
  await wait(2000);

  // Rockets at the player's own feet until they die; then, past Quake 3's 1.7 s, a press of the
  // attack, which is how a dead player asks to respawn.
  const dead = () => page.evaluate((d) => window.pcqController.player.pmType === d, PM_DEAD);
  await mark(`die ${pass}`);
  await pitchTo(89);
  await hold();
  for (let i = 0; i < 100 && !(await dead()); i++) await wait(100);
  await release();
  await wait(2500);
  await mark(`respawn ${pass}`);
  for (let i = 0; i < 10 && (await dead()); i++) {
    await hold();
    await wait(200);
    await release();
    await wait(300);
  }
  await wait(2000);
  await pitchTo(0);
  await run(page, 'kick allbots');
  await wait(1000);
}

/** The tour: each spawn spot, the player put there and turned through 360°. */
async function tour(places) {
  for (const p of places) {
    await mark(`place ${p.name}`);
    await putPlayer(p);
    await wait(PLACED_MS);
    await mark(`turn ${p.name}`);
    await turn(360);
  }
}

/** The fight: rockets at the bots, plasma swept across them and the walls, rockets again. */
async function fight() {
  await mark('rockets');
  await hold();
  await wait(3000);
  await release();
  await run(page, 'weapon 8');
  await wait(600);
  await mark('plasma');
  await hold();
  await turn(30, 0, 15);
  await turn(-30, 0, 15);
  await release();
  await run(page, 'weapon 5');
  await wait(600);
  await mark('rockets again');
  await hold();
  await wait(2500);
  await release();
  await wait(1000);
}

try {
  // 1. The load and the first seconds in the world. The log has run since the page opened.
  const startCdp = await startTrace(page, TRACE_CATEGORIES);
  result.loadMs = await bootMatch(page, port, MAP);
  result.bootedAt = (Date.now() - started) / 1000;
  result.engine = servedEngine(server);
  result.app = await installAppProbe(page);
  // The player in the world, its load screen gone: on a cold profile the GPU process compiles the
  // load's warm-up first, for seconds, and the frames wait on it.
  await page.waitForFunction(
    () => window.pcqController?.inWorld === true && window.pcqScreens?.top === null,
    null,
    { timeout: 300000, polling: 100 }
  );
  result.inWorldAt = (Date.now() - started) / 1000;
  await mark('in the world');
  await wait(8000);
  await mark('end');
  {
    const log = await page.evaluate(() => window.__perf.take());
    // The load screen's rows, the warm-up's under it, then the world's: the probe installs on the
    // match's first frame. The floor judges the world's.
    const world = result.app.installedAtRow;
    log.marks.unshift({ name: 'load', row: 0, time: log.columns.start[0] });
    log.marks.push({ name: 'warm-up', row: world, time: log.columns.start[world] });
    log.marks.sort((a, b) => a.row - b.row);
    const inWorld = log.marks.find((m) => m.name === 'in the world').row;
    await finish('start', log, RATE, startCdp, inWorld);
  }
  result.madeAfterStart = await page.evaluate(() => window.pcq.madeSinceWarmUp());
  // What is made from here on, by name, with the mark it came after.
  await page.evaluate(() => {
    const made = (window.__made = []);
    const after = () =>
      `${window.__phase ?? 'between phases'}: ${window.__perf.marks.at(-1)?.name ?? ''}`;
    const device = window.pcq.app.graphicsDevice;
    const push = device.shaders.push;
    device.shaders.push = function (...shaders) {
      for (const s of shaders) made.push({ at: after(), shader: s.label ?? s.name ?? null });
      return push.apply(this, shaders);
    };
    const gpu = window.__perf.gpu;
    if (gpu) {
      const create = gpu.createRenderPipeline;
      gpu.createRenderPipeline = function (descriptor) {
        const label = descriptor.label ?? descriptor.vertex?.module?.label ?? null;
        made.push({ at: after(), pipeline: label });
        return create.call(this, descriptor);
      };
    }
  });
  result.spawnedAt = await page.evaluate(() => {
    const { x, y, z } = window.pcqController.viewOrigin;
    return [x, y, z];
  });

  // The spawn spots alone: the preview's start is its own camera's, where no player stands.
  const places = await tourPlaces(server, MAP, null);
  const fightAt = await fightPlaces(server, MAP, places);
  result.places = places;
  result.fight = fightAt;
  result.gains = await calibrate();
  await wait(1000);

  // 2. The moments, twice.
  await phase(
    'moments',
    async () => {
      for (const pass of [1, 2]) await moments(pass, places, fightAt);
    },
    RATE
  );

  // 3. The bots joining, then the tour, paced then not, with them standing where the fight has
  // them.
  const fightPlace = places.find((p) => p.name === fightAt.at);
  await phase('join', () => joinBots(fightAt, fightPlace), RATE);
  for (const rate of RATES) {
    await phase(`tour ${rate || 'unpaced'}`, () => tour(places), rate);
  }

  // 4. The fight, paced then not, each from the same start.
  await run(page, 'pcq_god 1');
  for (const rate of RATES) {
    await joinBots(fightAt, fightPlace);
    await run(page, 'weapon 5');
    await wait(1000);
    await phase(`fight ${rate || 'unpaced'}`, fight, rate);
  }
  await run(page, 'pcq_god 0');

  result.made = await page.evaluate(() => window.__made);
  result.gpuErrors = await page.evaluate(() => window.__perf.gpuErrors);
  result.totals = await page.evaluate(() =>
    Object.fromEntries(window.__perf.counters.map((n, i) => [n, window.__perf.counts[i]]))
  );
} catch (err) {
  result.error = String(err);
  result.stack = err?.stack;
} finally {
  await context.close().catch(() => {});
  await server.close();
  remove(home);
  // Chrome's caches as the run left them, which the warm run reads.
  const sizes = {};
  const caches = [
    'Default/DawnWebGPUCache',
    'Default/DawnGraphiteCache',
    'Default/GPUCache',
    'GrShaderCache',
    'GraphiteDawnCache',
    'ShaderCache'
  ];
  for (const dir of caches) {
    try {
      sizes[dir] = readdirSync(join(PROFILE, dir)).reduce(
        (a, f) => a + statSync(join(PROFILE, dir, f)).size,
        0
      );
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
  const made = p.madeSinceWarmUp
    ? `; made since the warm-up ${p.madeSinceWarmUp.shaders} shaders, ` +
      `${p.madeSinceWarmUp.pipelines} pipelines`
    : '';
  const judged = p.floor
    ? `; the floor: ${p.floor.failing.length} failing, beside ${JSON.stringify(p.floor.beside)}`
    : '';
  console.log(
    `${name}: ${s.fps.toFixed(0)} fps; frame p50/p99/max ${s.dt.p50}/${s.dt.p99}/${s.dt.max} ms, ` +
      `${s.hitches.overOneAndAHalf} over 1.5 refreshes; JS p50/p99 ${s.js.p50}/${s.js.p99}; ` +
      `GPU p50/p99 ${s.gpuFrame.p50}/${s.gpuFrame.p99}; ` +
      `draws p50/max ${s.drawCalls.p50}/${s.drawCalls.max}${made}${judged}`
  );
}
for (const made of result.made ?? []) console.log(`made after the start: ${JSON.stringify(made)}`);
if (result.error) console.log(`error: ${result.error}`);
console.log(`done ${OUT}`);
