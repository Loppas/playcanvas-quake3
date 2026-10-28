// The render baseline: one boot of garage_rats on one build of the engine, on a cold or a warm
// browser profile, drawn at 2560×1440 on a 240 Hz grid unless a scene says otherwise.
//
//     node scripts/perf/perf-render.mjs <build> <cache> [out]
//
// `build` is debug, profiler or release; `cache` is cold (the profile emptied first) or warm (the
// profile a cold run of the same build left). The phases, in order, so each moment meets its
// first draws before anything else has drawn them:
//
// 1. **start** — the load and the first seconds in the world, under a trace.
// 2. **turn** — two passes of turns: four quarter turns, then a full turn looking up and one
//    looking down, under a trace.
// 3. **weapons** — two passes over the weapons: each selected, then fired at the floor ahead,
//    under a trace.
// 4. **players** — under a trace: a bot with a look not yet loaded, then sought out with a full
//    turn; the player killed by their own rockets and respawned; a second new look; a bot with a
//    look already loaded; a second death and respawn.
// 5. **scenes** — still, turning, walking in a circle, and a fight with three bots, each at 240,
//    144 and 60 Hz and unpaced, five seconds apiece.
// 6. **splat** — the map's passes by view direction: eight yaws at three pitches, the view still.
//
// Writes result.json and a compact frame log per phase under logs/. The traces are read and
// deleted. Headless, on the real GPU; nothing opens on screen.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compact, hitches, rounded, slice, summarise, traceOffset, traceWindow } from './perf-analyse.mjs';
import {
  bootMatch,
  endTrace,
  installAppProbe,
  installPageHarness,
  KNOWN_NOISE,
  launchChrome,
  readTrace,
  remove,
  run,
  servedEngine,
  startTrace,
  startVite,
  throwawayHome
} from './perf-lib.mjs';

const BUILD = process.argv[2] ?? 'profiler';
const CACHE = process.argv[3] ?? 'cold';
const OUT = process.argv[4] ?? join(tmpdir(), 'pcq-perf-render', `${BUILD}-${CACHE}`);
/** One profile per build, so a warm run finds what its own build's cold run left. */
const PROFILE = join(tmpdir(), 'pcq-perf-profiles', BUILD);
const MAP = 'garage_rats';
/** The display's rate the moments are judged at. */
const RATE = 240;
const SCENE_RATES = [240, 144, 60, 0];
const SCENE_MS = 5000;
/**
 * V8's collection phases, Dawn's compiles, the GPU process's presents, and the marks. Not `v8`,
 * which records every call: twenty seconds of it is half a gigabyte.
 */
const TRACE_CATEGORIES = ['disabled-by-default-v8.gc', 'disabled-by-default-gpu.dawn', 'viz', 'blink.user_timing'].filter(
  // The debug build wraps every draw in a validation scope, and Dawn traces each one: a gigabyte a
  // phase. A compile in the GPU process costs the same under either build, so the profiler's runs
  // time them.
  (category) => BUILD !== 'debug' || category !== 'disabled-by-default-gpu.dawn'
);
/** The events the analysis reads: collections, compiles, presents and the marks. */
const keepEvent = ({ name = '' }) =>
  name.startsWith('V8.GC_') ||
  name.startsWith('perf:') ||
  name === 'SkiaOutputSurfaceImplOnGpu::SwapBuffers' ||
  name.startsWith('DeviceBase::APICreate');
/** Quake 3 key codes: F9 runs a command, F10 and F11 hold a move and the attack. */
const K_F10 = 154;
const K_F11 = 155;
/** The weapons in their slots: machinegun to BFG. */
const WEAPONS = [2, 3, 4, 5, 6, 7, 8, 9];
/** `PM_DEAD` (`bg_public.h`): the player's move type while dead. */
const PM_DEAD = 3;

if (!['debug', 'profiler', 'release'].includes(BUILD) || !['cold', 'warm'].includes(CACHE)) {
  throw new Error('usage: perf-render.mjs <debug|profiler|release> <cold|warm> [out]');
}
remove(OUT);
mkdirSync(join(OUT, 'logs'), { recursive: true });
if (CACHE === 'cold') remove(PROFILE);

// Every weapon from the first spawn, and both master slots empty.
const home = throwawayHome('seta pcq_spawnWeapons 1\n');
const { server, port } = await startVite(BUILD);
const context = await launchChrome(PROFILE);
await installPageHarness(context, { rate: RATE, record: true });
const page = context.pages()[0] ?? (await context.newPage());
const result = { build: BUILD, cache: CACHE, map: MAP, rate: RATE, port, problems: [], console: [], phases: {} };
const started = Date.now();
page.on('console', (m) => {
  const text = m.text();
  // The game's own lines, timed from the launch, so a hitch can be put beside what it printed.
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

/** Holds a command on a key until `release`, as a player holds one down. */
async function hold(key, command) {
  await page.evaluate(([k, c]) => {
    window.pcqConfig.command(['bind', k === 154 ? 'F10' : 'F11', c]);
    window.pcqInput.keyDown(k);
  }, [key, command]);
}
const release = (key) => page.evaluate((k) => window.pcqInput.keyUp(k), key);

/** The difference of two angles, in (-180, 180]. */
const angleDelta = (a, b) => ((((b - a + 180) % 360) + 360) % 360) - 180;

/** The view's degrees per mouse count, yaw and pitch, measured by moving it and back. */
async function calibrate() {
  const angles = () => page.evaluate(() => ({ ...window.pcqController.viewAngles }));
  const a = await angles();
  await page.evaluate(() => window.pcqInput.mouseMove(200, 100));
  await wait(300);
  const b = await angles();
  const gains = { yawGain: angleDelta(a.y, b.y) / 200, pitchGain: angleDelta(a.x, b.x) / 100 };
  // A view that did not move would leave every turn waiting forever.
  if (gains.yawGain === 0 || gains.pitchGain === 0) throw new Error(`the view did not turn: ${JSON.stringify(gains)}`);
  await page.evaluate(() => window.pcqInput.mouseMove(-200, -100));
  await wait(300);
  await page.evaluate((g) => Object.assign(window.__perf.drive, g), gains);
  return gains;
}

/** Turns the view by `yaw` and `pitch` degrees at `rate` degrees a second, and waits it out. */
async function turn(yaw, pitch = 0, rate = 360) {
  await page.evaluate(
    ([y, p, r]) => Object.assign(window.__perf.drive, { yawLeft: y, pitchLeft: p, yawRate: r, pitchRate: r }),
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

/** Faces an absolute yaw and pitch, so a scene starts from the same view wherever it stands. */
async function face(yaw, pitch) {
  const angles = await page.evaluate(() => ({ ...window.pcqController.viewAngles }));
  await turn(angleDelta(angles.y, yaw), pitch - angles.x, 180);
}

/**
 * Records a phase's frame log at `rate`, optionally under a trace, runs `body`, and reads back the
 * log, its summary, its hitches, and the trace over it. Sub-moments are the marks `body` makes.
 */
async function phase(name, body, { rate = RATE, trace = false } = {}) {
  const cdp = trace ? await startTrace(page, TRACE_CATEGORIES) : null;
  await page.evaluate((r) => {
    window.__perf.setRate(r);
    window.__perf.record();
    window.__perf.mark('begin');
  }, rate);
  await body();
  await mark('end');
  await wait(100);
  const log = await page.evaluate(() => window.__perf.take());
  return finish(name, log, rate, cdp);
}

/** A phase's log and trace read into the result. */
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
  // Where the phase began: a respawn puts the player at any of the map's spawn points.
  const c = log.columns;
  if (log.rows > 0) entry.where = { origin: [c.eyeX[0], c.eyeY[0], c.eyeZ[0]], yaw: c.yaw[0], pitch: c.pitch[0] };
  if (parsed && offset !== null && log.rows > 0) {
    entry.trace = traceWindow(parsed, offset, log.columns.start[0], log.columns.end[log.rows - 1], period);
  } else if (cdp) {
    entry.trace = { error: 'no mark found in the trace' };
  }
  // Each stretch between marks, summarised on its own.
  const marks = log.marks.filter((m) => m.name !== 'begin' && m.name !== 'end');
  entry.parts = {};
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].row;
    const to = i + 1 < marks.length ? marks[i + 1].row : log.rows;
    if (to - from < 2) continue;
    const part = slice(log, from, to);
    const s = summarise(part, rate);
    entry.parts[marks[i].name] = {
      rows: s.rows,
      dtMax: s.dt.max,
      hitches: s.hitches,
      js: { p50: s.js.p50, max: s.js.max },
      pipelines: s.counters.pipelines?.total,
      shaders: s.counters.shadersGenerated?.total,
      textures: s.counters.textures?.total,
      buffers: s.counters.buffers?.total,
      longAnimationFrames: s.longAnimationFrames,
      trace:
        parsed && offset !== null
          ? traceWindow(parsed, offset, part.columns.start[0], part.columns.end[part.rows - 1], period)
          : undefined
    };
    if (entry.parts[marks[i].name].trace) delete entry.parts[marks[i].name].trace.compileList;
  }
  if (entry.trace) delete entry.trace.compileList;
  writeFileSync(join(OUT, 'logs', `${name}.json`), JSON.stringify(compact(log)));
  if (traceFile) rmSync(traceFile, { force: true });
  result.phases[name] = rounded(entry);
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
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
  await page.evaluate(() => window.__perf.mark('settled'));
  await wait(8000);
  await mark('end');
  {
    const log = await page.evaluate(() => window.__perf.take());
    // The load screen's rows, then the world's: the probe installs on the first frame of the match.
    log.marks.unshift({ name: 'load', row: 0, time: log.columns.start[0] });
    log.marks.push({ name: 'world', row: result.app.installedAtRow, time: log.columns.start[result.app.installedAtRow] });
    log.marks.sort((a, b) => a.row - b.row);
    // The world's first 2 s, then the rest.
    const twoSeconds = log.columns.tick.findIndex((t) => t > log.columns.tick[result.app.installedAtRow] + 2000);
    if (twoSeconds > 0) log.marks.push({ name: 'world after 2 s', row: twoSeconds, time: log.columns.start[twoSeconds] });
    log.marks = log.marks.filter((m) => m.name !== 'settled').sort((a, b) => a.row - b.row);
    await finish('start', log, RATE, startCdp);
  }
  result.gains = await calibrate();
  await wait(1000);

  // 2. Turning to what has not been drawn.
  await phase(
    'turn',
    async () => {
      for (const pass of [1, 2]) {
        await mark(`quarter turns ${pass}`);
        for (let i = 0; i < 4; i++) {
          await turn(90);
          await wait(500);
        }
        await mark(`full turn up ${pass}`);
        await pitchTo(-40);
        await turn(360);
        await mark(`full turn down ${pass}`);
        await pitchTo(40);
        await turn(360);
        await pitchTo(0);
        await wait(500);
      }
    },
    { trace: true }
  );

  // 3. Each weapon's first shot, and its second.
  await phase(
    'weapons',
    async () => {
      await pitchTo(30);
      for (const pass of [1, 2]) {
        for (const weapon of WEAPONS) {
          await mark(`switch ${weapon} pass ${pass}`);
          await run(page, `weapon ${weapon}`);
          await wait(1000);
          await mark(`fire ${weapon} pass ${pass}`);
          await hold(K_F11, '+attack');
          await wait(300);
          await release(K_F11);
          await wait(1500);
        }
      }
      await pitchTo(0);
    },
    { trace: true }
  );

  // 4. Players: a new look joining and first seen, a death and a respawn, another look, a known one.
  // Rockets at the player's own feet until they die; then, past Quake 3's 1.7 s, a press of the
  // attack, which is how a dead player asks to respawn.
  const dead = () => page.evaluate((d) => window.pcqController.player.pmType === d, PM_DEAD);
  const die = async (n) => {
    await mark(`die ${n}`);
    await run(page, 'weapon 5');
    await pitchTo(89);
    await wait(800);
    await hold(K_F11, '+attack');
    for (let i = 0; i < 100 && !(await dead()); i++) await wait(100);
    await release(K_F11);
    await wait(2500);
    await mark(`respawn ${n}`);
    for (let i = 0; i < 10 && (await dead()); i++) {
      await hold(K_F11, '+attack');
      await wait(200);
      await release(K_F11);
      await wait(300);
    }
    await wait(2000);
    await pitchTo(0);
  };
  const joinBot = async (bot, label) => {
    await mark(`addbot ${label}`);
    await run(page, `addbot ${bot}`);
    await wait(3000);
    await mark(`seek ${label}`);
    await turn(360, 0, 120);
  };
  await phase(
    'players',
    async () => {
      await joinBot('grunt', 'grunt');
      await die(1);
      await joinBot('xaero', 'xaero');
      await joinBot('grunt', 'grunt again');
      await die(2);
    },
    { trace: true }
  );
  await run(page, 'kick allbots');
  await wait(2000);

  // 5. The four scenes, at each display rate.
  for (const scene of ['still', 'turning', 'walking', 'combat']) {
    if (scene === 'combat') {
      await run(page, 'pcq_god 1');
      for (const bot of ['grunt', 'xaero', 'sarge']) {
        await run(page, `addbot ${bot}`);
        await wait(500);
      }
      await wait(5000);
    }
    for (const rate of SCENE_RATES) {
      await face(0, 0);
      await phase(
        `${scene} ${rate || 'unpaced'}`,
        async () => {
          if (scene === 'turning') await page.evaluate(() => Object.assign(window.__perf.drive, { yawLeft: 1e9, yawRate: 180 }));
          if (scene === 'walking') {
            await page.evaluate(() => Object.assign(window.__perf.drive, { yawLeft: 1e9, yawRate: 60 }));
            await hold(K_F10, '+forward');
          }
          await wait(SCENE_MS);
          await page.evaluate(() => Object.assign(window.__perf.drive, { yawLeft: 0, pitchLeft: 0 }));
          if (scene === 'walking') await release(K_F10);
        },
        { rate, trace: true }
      );
    }
  }
  await run(page, 'kick allbots');
  await run(page, 'pcq_god 0');
  await wait(2000);

  // 6. The map's passes by view direction.
  await face(0, 0);
  await phase('splat', async () => {
    for (const pitch of [0, -30, 30]) {
      await pitchTo(pitch);
      for (let i = 0; i < 8; i++) {
        await turn(45);
        await wait(500);
        await mark(`yaw ${i * 45 + 45} pitch ${pitch}`);
        await wait(500);
      }
    }
  }, { trace: true });
  result.splat = {};
  for (const [name, part] of Object.entries(result.phases.splat.parts)) result.splat[name] = part;

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
console.log(`done ${OUT}`);
