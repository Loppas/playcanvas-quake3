// The warm-up's check: what the device makes after a load's warm-up, through the moments a match
// meets, each pipeline named by the engine shader it was made for and the draw under way. One boot
// of garage_rats on one build of the engine, on a cold or a warm browser profile, drawn at
// 2560×1440 on a 240 Hz grid, each step under a trace.
//
//     node scripts/perf/perf-warm-check.mjs <build> <cache> [out]
//
// `build` and `cache` as perf-render.mjs takes them, on a profile of this script's own. The steps:
//
// 1. **load** — the boot, its warm-up and the load screen, then 25 s in the world, standing.
// 2. **turn** — four quarter turns, then a full turn looking up and one looking down.
// 3. **weapons** — each weapon selected and fired at the floor ahead: its shots, explosions, beams
//    and bolts.
// 4. **kill** — the player's death by `kill`, gibbed, and the respawn.
// 5. **bots** — two bots in looks nobody wears, each sought out with a full turn.
// 6. **corpses** — bots shot down, a railgun shot and then the machinegun so none is gibbed, each
//    corpse watched until it has sunk; then a bot kicked.
// 7. **scoreboard** — the board held up twice.
// 8. **powerups** — the player respawned at the centre spawn, and every powerup in the ring of
//    items around it taken once it has spawned in; then every gun held while they last.
// 9. **map** — the same map again: its own load and warm-up, then a full turn.
// 10. **menu** — the in-game menu, then Setup, its Player page and its Model page, each with its
//    player preview.
//
// Writes result.json and a compact frame log per step under logs/, and prints each step's findings.
// For each step: the pipelines made outside a warm-up, named; the warm-ups run in play (a look's)
// and what they made; the frames' summary and hitches, tagged by cause; and the trace's compiles,
// collections and presents over it. For the run: WebGPU's errors, and any viewport past the
// device's limit with the camera that set it. The traces are read and deleted. Headless, on the
// real GPU.
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
const OUT = process.argv[4] ?? join(tmpdir(), 'pcq-perf-warm-check', `${BUILD}-${CACHE}`);
/** One profile per build, so a warm run finds what its own build's cold run left. */
const PROFILE = join(tmpdir(), 'pcq-perf-warm-check-profiles', BUILD);
const MAP = 'garage_rats';
/** The display's rate the steps are drawn at. */
const RATE = 240;
/** The frame log's rows a step: the longest, the powerups', can wait a minute for them. */
const CAPACITY = 60000;
/** As perf-render.mjs traces: collections, Dawn's compiles (not on the debug build), presents. */
const TRACE_CATEGORIES = ['disabled-by-default-v8.gc', 'disabled-by-default-gpu.dawn', 'viz', 'blink.user_timing'].filter(
  (category) => BUILD !== 'debug' || category !== 'disabled-by-default-gpu.dawn'
);
const keepEvent = ({ name = '' }) =>
  name.startsWith('V8.GC_') ||
  name.startsWith('perf:') ||
  name === 'SkiaOutputSurfaceImplOnGpu::SwapBuffers' ||
  name.startsWith('DeviceBase::APICreate');
/** Quake 3 key codes: F10 and F11 hold a move and the attack; Enter uses a menu item. */
const K_F10 = 154;
const K_F11 = 155;
const K_ENTER = 13;
/** Every weapon in its slot: gauntlet to BFG. */
const WEAPONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const MACHINEGUN = 2;
const RAILGUN = 7;
/** `PM_DEAD` and `EF_DEAD` (`bg_public.h`). */
const PM_DEAD = 3;
const EF_DEAD = 1;
/** `MAX_CLIENTS`: entity numbers below it are players, at or above it corpses. */
const MAX_CLIENTS = 64;
/** `PERS_HITS`: the hits the player has landed. */
const PERS_HITS = 1;
/** The map's centre spawn, which the items' ring stands around (`zz-items.pk3`). */
const CENTRE = { x: -4, y: -4 };
/** The looks the bots join in: two nobody wears at the boot. */
const BOTS = ['grunt', 'xaero'];

if (!['debug', 'profiler', 'release'].includes(BUILD) || !['cold', 'warm'].includes(CACHE)) {
  throw new Error('usage: perf-warm-check.mjs <debug|profiler|release> <cold|warm> [out]');
}
remove(OUT);
mkdirSync(join(OUT, 'logs'), { recursive: true });
if (CACHE === 'cold') remove(PROFILE);

/**
 * The page's naming, run before its scripts: every render and compute pipeline the device makes,
 * when, whether in a warm-up's render, and what for. The engine shader is the one whose module the
 * pipeline is being made with; the draw is the mesh instance the renderer is drawing, if any, so a
 * pass of the engine's own (a clear, the splat's work buffer) is named by its shader alone. A
 * warm-up's render is one called outside the app's frame. Also when the player is in the world, and
 * when the load screen shows, as each changes.
 */
function pageNaming() {
  const check = (window.__check = { made: [], warmRenders: [], world: [], screen: [], viewports: [] });
  const naming = { shader: null, draw: null, warming: false, camera: null };
  // A viewport past the device's limit is a validation error that drops the frame's commands:
  // each one kept, with the camera that set it and the clocks it was set by.
  const setViewport = GPURenderPassEncoder.prototype.setViewport;
  GPURenderPassEncoder.prototype.setViewport = function (x, y, w, h, near, far) {
    if ((w > 8192 || h > 8192) && check.viewports.length < 20) {
      const c = window.pcqController;
      check.viewports.push({
        t: performance.now(),
        viewport: [x, y, w, h],
        camera: naming.camera,
        warm: naming.warming,
        time: c?.time,
        powerupActive: c?.powerupActive,
        powerupTime: c?.powerupTime,
        itemPickupTime: c?.itemPickupTime,
        damageTime: c?.damage?.time
      });
    }
    return setViewport.call(this, x, y, w, h, near, far);
  };
  const proto = GPUDevice.prototype;
  for (const name of ['createRenderPipeline', 'createComputePipeline']) {
    const original = proto[name];
    proto[name] = function (descriptor) {
      const d = naming.draw;
      check.made.push({
        t: performance.now(),
        kind: name === 'createRenderPipeline' ? 'render' : 'compute',
        warm: naming.warming,
        shader: naming.shader,
        draw: d ? `${d.node?.parent?.name ?? ''}/${d.node?.name ?? ''}` : null
      });
      naming.shader = null;
      return original.call(this, descriptor);
    };
  }
  const nameShaders = (impl) => {
    const shaders = Object.getPrototypeOf(impl);
    if (shaders.__named) return;
    shaders.__named = true;
    for (const name of ['getVertexShaderModule', 'getComputeShaderModule']) {
      const original = shaders[name];
      shaders[name] = function () {
        // A variant's key follows its name; the name alone says what it is.
        naming.shader = this.shader?.name?.split(':')[0] ?? null;
        return original.call(this);
      };
    }
  };
  let handle;
  Object.defineProperty(window, 'pcq', {
    configurable: true,
    get: () => handle,
    set: (value) => {
      handle = value;
      const app = value.app;
      const device = app.graphicsDevice;
      const made = device.shaders.find((s) => s.impl);
      if (made) nameShaders(made.impl);
      const createShaderImpl = device.createShaderImpl;
      device.createShaderImpl = function (shader) {
        const impl = createShaderImpl.call(this, shader);
        nameShaders(impl);
        return impl;
      };
      const renderer = app.renderer;
      const setupViewport = renderer.setupViewport;
      renderer.setupViewport = function (camera, renderTarget) {
        const r = camera.rect;
        naming.camera = `${camera.node?.parent?.name ?? ''}/${camera.node?.name ?? ''} rect ${[r.x, r.y, r.z, r.w].map((v) => Math.round(v * 1000) / 1000).join(',')}`;
        return setupViewport.call(this, camera, renderTarget);
      };
      const matrices = renderer.setMeshInstanceMatrices;
      renderer.setMeshInstanceMatrices = function (meshInstance, ...rest) {
        naming.draw = meshInstance;
        return matrices.call(this, meshInstance, ...rest);
      };
      const draw = device.draw;
      device.draw = function (...args) {
        try {
          return draw.apply(this, args);
        } finally {
          naming.draw = null;
        }
      };
      const render = app.render;
      app.render = function () {
        const outside = !app._inFrameUpdate;
        const t = performance.now();
        if (outside) naming.warming = true;
        try {
          return render.call(app);
        } finally {
          if (outside) {
            naming.warming = false;
            check.warmRenders.push({ t, ms: performance.now() - t });
          }
        }
      };
    }
  });
  let inWorld = false;
  let screen = false;
  const watch = () => {
    const now = performance.now();
    const world = window.pcqController?.inWorld === true;
    if (world !== inWorld) check.world.push({ t: now, inWorld: (inWorld = world) });
    const shown = document.querySelector('.load-screen') !== null;
    if (shown !== screen) check.screen.push({ t: now, shown: (screen = shown) });
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

const home = throwawayHome('seta pcq_spawnWeapons 1\n');
const { server, port } = await startVite(BUILD);
const { ITEMS, IT } = await server.ssrLoadModule('/src/sim/items.ts');
/** The powerups' item numbers, which a powerup's entity carries as its `modelindex`. */
const POWERUPS = new Map(ITEMS.flatMap((item, i) => (item.giType === IT.POWERUP ? [[i, item.classname]] : [])));
const context = await launchChrome(PROFILE);
await installPageHarness(context, { rate: RATE, capacity: CAPACITY, record: true });
await context.addInitScript(pageNaming);
const page = context.pages()[0] ?? (await context.newPage());
const result = { build: BUILD, cache: CACHE, map: MAP, rate: RATE, port, problems: [], console: [], steps: {} };
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
const now = () => page.evaluate(() => performance.now());

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

const dead = () => page.evaluate((d) => window.pcqController.player.pmType === d, PM_DEAD);

/** Past Quake 3's 1.7 s, presses of the attack until the player is back, as a dead player asks. */
async function respawn() {
  for (let i = 0; i < 10 && (await dead()); i++) {
    await hold(K_F11, '+attack');
    await wait(200);
    await release(K_F11);
    await wait(300);
  }
}

/** Dies by `kill`, and comes back. */
async function killAndRespawn() {
  await run(page, 'kill');
  for (let i = 0; i < 30 && !(await dead()); i++) await wait(100);
  await wait(2000);
  await respawn();
  await wait(500);
}

/** The player's own client number, and every other player in the snapshot. */
const others = () =>
  page.evaluate((max) => {
    const c = window.pcqController;
    const own = c.player.clientNum;
    return c
      .players()
      .filter(({ state }) => state.number < max && state.clientNum !== own)
      .map(({ state }) => state.clientNum);
  }, MAX_CLIENTS);

/**
 * Turns onto a player's entity by the mouse, as far as one move takes it; their `eFlags` and how
 * far off the view was, or `null` while they are not in the snapshot.
 */
const aim = (number) =>
  page.evaluate(
    ({ number, gains }) => {
      const c = window.pcqController;
      const target = c.players().find(({ state }) => state.number === number);
      if (!target) return null;
      const ps = c.player;
      const dx = target.origin.x - ps.origin.x;
      const dy = target.origin.y - ps.origin.y;
      const dz = target.origin.z - (ps.origin.z + ps.viewheight);
      const norm = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
      const dyaw = norm((Math.atan2(dy, dx) * 180) / Math.PI - ps.viewangles.y);
      const dpitch = norm((-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI - ps.viewangles.x);
      window.pcqInput.mouseMove(dyaw / gains.yawGain, dpitch / gains.pitchGain);
      return { flags: target.state.eFlags, off: Math.hypot(dyaw, dpitch) };
    },
    { number, gains: result.gains }
  );
const hits = () => page.evaluate((i) => window.pcqController.player.persistant[i], PERS_HITS);

/**
 * Fires at a player while the view is on them, until `done` says so or no shot has landed for
 * `patience` tries a tenth of a second apart.
 *
 * @returns how it ended: 'done', 'missed' or 'gone'
 */
async function fireAt(number, done, patience) {
  await page.evaluate(() => window.pcqConfig.command(['bind', 'F11', '+attack']));
  let firing = false;
  let outcome = 'missed';
  let landed = await hits();
  let quiet = 0;
  for (let i = 0; i < 200 && quiet < patience; i++) {
    const aimed = await aim(number);
    if (aimed === null) {
      outcome = 'gone';
      break;
    }
    if (await done(aimed)) {
      outcome = 'done';
      break;
    }
    const on = aimed.off < 0.5;
    if (on !== firing) {
      firing = on;
      await page.evaluate(([k, down]) => window.pcqInput[down ? 'keyDown' : 'keyUp'](k), [K_F11, on]);
    }
    const h = await hits();
    if (h !== landed) {
      landed = h;
      quiet = 0;
    } else if (firing) {
      quiet++;
    }
    await wait(100);
  }
  await page.evaluate((k) => window.pcqInput.keyUp(k), K_F11);
  return outcome;
}

/**
 * Shoots a bot down without gibbing it: the railgun once, then the machinegun, whose rounds leave
 * a body whole.
 */
async function shootDown(number) {
  await run(page, `weapon ${RAILGUN}`);
  await wait(1200);
  const before = await hits();
  const railed = await fireAt(number, async () => (await hits()) !== before, 30);
  if (railed !== 'done') return `rail ${railed}`;
  await run(page, `weapon ${MACHINEGUN}`);
  await wait(800);
  const downed = await fireAt(number, async (aimed) => (aimed.flags & EF_DEAD) !== 0, 40);
  return downed === 'done' ? 'dead' : `machinegun ${downed}`;
}

/** Walks to a point on the floor, steering by the mouse; whether it got there. */
async function walkTo(x, y, ms = 6000) {
  await hold(K_F10, '+forward');
  let arrived = false;
  for (let i = 0; i < ms / 50; i++) {
    const off = await page.evaluate(
      ([x, y, gains]) => {
        const ps = window.pcqController.player;
        const dx = x - ps.origin.x;
        const dy = y - ps.origin.y;
        const norm = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
        window.pcqInput.mouseMove(norm((Math.atan2(dy, dx) * 180) / Math.PI - ps.viewangles.y) / gains.yawGain, 0);
        return Math.hypot(dx, dy);
      },
      [x, y, result.gains]
    );
    if (off < 20) {
      arrived = true;
      break;
    }
    await wait(50);
  }
  await release(K_F10);
  return arrived;
}

/** The player's distance from the centre spawn, across the floor and up. */
const fromCentre = () =>
  page.evaluate((c) => {
    const o = window.pcqController.player.origin;
    return Math.hypot(o.x - c.x, o.y - c.y) + Math.abs(o.z - 32);
  }, CENTRE);

/** The powerups standing in the snapshot: item number, where. */
const powerupsInWorld = () =>
  page.evaluate(
    (numbers) =>
      window.pcqController
        .items()
        .filter(({ state }) => numbers.includes(state.modelindex))
        .map(({ state, origin }) => ({ item: state.modelindex, x: origin.x, y: origin.y })),
    [...POWERUPS.keys()]
  );

/** Uses the item labelled `label` on the menu's page; whether there was one. */
const useItem = (label) =>
  page.evaluate(
    ([label, enter]) => {
      const menu = window.pcqMenu.menu;
      const at = menu.page?.items.findIndex((item) => item.label === label) ?? -1;
      if (at < 0) return false;
      menu.select(at);
      menu.key(enter);
      return true;
    },
    [label, K_ENTER]
  );

/** A pipeline as the check names it: its kind, its engine shader, and the draw under way. */
const pipelineName = (m) => `${m.kind === 'compute' ? 'compute ' : ''}${m.shader ?? '(unnamed)'} | ${m.draw ?? '-'}`;

/** Pipelines grouped by name, each with how many and when the first was made, ms from `from`. */
function named(made, from) {
  const groups = new Map();
  for (const m of made) {
    const name = pipelineName(m);
    const g = groups.get(name) ?? { name, n: 0, firstAt: m.t - from };
    g.n++;
    groups.set(name, g);
  }
  return [...groups.values()];
}

/**
 * A step's log and trace read into the result: its frames, its hitches by cause, the trace over it
 * and each stretch between its marks, and every pipeline made in it.
 */
async function finish(name, log, cdp, since) {
  const traceFile = join(OUT, `${name}.trace.json`);
  await endTrace(cdp, traceFile);
  const parsed = readTrace(traceFile, keepEvent);
  const offset = traceOffset(parsed, log.marks);
  const period = 1000 / RATE;
  const c = log.columns;
  const until = c.end[log.rows - 1];
  const check = await page.evaluate(
    ([from, to]) => ({
      made: window.__check.made.filter((m) => m.t > from && m.t <= to),
      warmRenders: window.__check.warmRenders.filter((w) => w.t > from && w.t <= to),
      world: window.__check.world,
      screen: window.__check.screen
    }),
    [since, until]
  );
  const s = summarise(log, RATE);
  const all = hitches(log, RATE, { trace: parsed, offset });
  const entry = {
    seconds: s.seconds,
    fps: s.fps,
    dt: s.dt,
    late: s.hitches,
    js: { p50: s.js.p50, max: s.js.max },
    heap: s.heap,
    longAnimationFrames: s.longAnimationFrames,
    made: {
      inPlay: named(check.made.filter((m) => !m.warm), c.start[0]),
      warmUps: check.warmRenders.map((w) => ({ at: w.t - c.start[0], ms: w.ms })),
      inWarmUps: check.made.filter((m) => m.warm).length
    },
    // The longest frames, with what may have held each, timed from the step's first.
    hitches: all
      .sort((a, b) => b.dt - a.dt)
      .slice(0, 12)
      .map((h) => ({ ...h, at: h.at - c.tick[0] })),
    over33: all.filter((h) => h.dt > 33.4).length,
    // Frames of five refreshes and more, and those of them nothing in the page or the trace held.
    over20: all.filter((h) => h.dt > 20.9).length,
    over20Untagged: all.filter((h) => h.dt > 20.9 && h.tags.length === 0).length,
    trace: offset !== null ? traceWindow(parsed, offset, c.start[0], until, period) : { error: 'no mark found in the trace' },
    parts: {}
  };
  // The GPU process compiles in the order the page made its pipelines, so where the counts agree
  // each compile is the page's pipeline of the same place: its longest, named.
  const compiles = entry.trace.compileList;
  if (compiles) {
    delete entry.trace.compileList;
    const made = [...check.made].sort((a, b) => a.t - b.t);
    if (compiles.length === made.length) {
      entry.compiles = compiles
        .map((x, i) => ({ name: pipelineName(made[i]), warm: made[i].warm, at: x.at - c.start[0], ms: x.ms }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 12);
    } else {
      entry.compiles = { unmatched: { gpu: compiles.length, page: made.length } };
    }
  }
  const marks = log.marks.filter((m) => m.name !== 'begin' && m.name !== 'end').sort((a, b) => a.row - b.row);
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].row;
    const to = i + 1 < marks.length ? marks[i + 1].row : log.rows;
    if (to - from < 2) continue;
    const part = slice(log, from, to);
    const ps = summarise(part, RATE);
    const pc = part.columns;
    const traced = offset !== null ? traceWindow(parsed, offset, pc.start[0], pc.end[part.rows - 1], period) : null;
    if (traced) delete traced.compileList;
    entry.parts[marks[i].name] = {
      rows: ps.rows,
      dtMax: ps.dt.max,
      late: ps.hitches.overOneAndAHalf,
      over33: ps.hitches.over33,
      js: { p50: ps.js.p50, max: ps.js.max },
      pipelines: ps.counters.pipelines?.total,
      inPlay: check.made.filter((m) => !m.warm && m.t >= pc.start[0] && m.t <= pc.end[part.rows - 1]).length,
      longAnimationFrames: ps.longAnimationFrames,
      trace: traced && { gc: traced.gc, compiles: traced.compiles, longestGap: traced.presents.longest[0] }
    };
  }
  writeFileSync(join(OUT, 'logs', `${name}.json`), JSON.stringify(compact(log)));
  rmSync(traceFile, { force: true });
  result.steps[name] = rounded(entry);
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  return check;
}

/** A step of play under a trace, its log begun afresh. */
async function step(name, body) {
  const cdp = await startTrace(page, TRACE_CATEGORIES);
  const since = await now();
  await page.evaluate(() => {
    window.__perf.record();
    window.__perf.mark('begin');
  });
  await body();
  await mark('end');
  await wait(100);
  const log = await page.evaluate(() => window.__perf.take());
  await finish(name, log, cdp, since);
}

/** A step's findings, a few lines a person reads. */
function report(name, entry) {
  const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
  const lines = [
    `${name}: ${f(entry.seconds)} s, frame p50 ${f(entry.dt.p50)} max ${f(entry.dt.max)} ms, ` +
      `${entry.over33} over 33 ms, ${entry.over20} over 20 (${entry.over20Untagged} untagged)`
  ];
  const inPlay = entry.made.inPlay.reduce((a, g) => a + g.n, 0);
  lines.push(`  made in play: ${inPlay}${inPlay ? '' : ' (none)'}`);
  for (const g of entry.made.inPlay) lines.push(`    ${g.n} × ${g.name} (at ${f(g.firstAt / 1000, 2)} s)`);
  if (entry.made.warmUps.length) {
    lines.push(`  warm-ups: ${entry.made.warmUps.length} renders (${entry.made.warmUps.map((w) => f(w.ms)).join(', ')} ms), ${entry.made.inWarmUps} pipelines`);
  }
  const t = entry.trace;
  if (t?.compiles) lines.push(`  GPU process: ${t.compiles.n} compiles, ${f(t.compiles.ms, 0)} ms, longest ${f(t.compiles.max, 0)}; longest gap between presents ${f(t.presents.longest[0]?.gap, 0)} ms`);
  if (Array.isArray(entry.compiles)) {
    for (const x of entry.compiles.filter((y) => y.ms >= 50).slice(0, 6)) {
      lines.push(`    compiled ${f(x.ms, 0)} ms${x.warm ? ' (warm-up)' : ''}: ${x.name}`);
    }
  } else if (entry.compiles) {
    lines.push(`  compiles not matched: ${JSON.stringify(entry.compiles.unmatched)}`);
  }
  for (const h of entry.hitches.filter((x) => x.dt > 33.4)) {
    lines.push(`  ${f(h.dt)} ms at ${f(h.at / 1000, 2)} s [${h.tags.join(',')}] js ${f(h.js)} gpuCompile ${f(h.gpuCompileMs)} gc ${f(h.gcMs)} ${h.scripts.join('; ')}`);
  }
  for (const [part, p] of Object.entries(entry.parts)) {
    lines.push(`  · ${part}: max ${f(p.dtMax)} ms, ${p.over33} over 33, made ${p.inPlay}${p.trace ? `, GPU compiles ${p.trace.compiles.n} / ${f(p.trace.compiles.ms, 0)} ms, gap ${f(p.trace.longestGap?.gap, 0)} ms` : ''}`);
  }
  return lines.join('\n');
}

try {
  // 1. The boot, its warm-up and the load screen, then 25 s standing in the world. The frame log
  // has run since the page opened.
  const loadCdp = await startTrace(page, TRACE_CATEGORIES);
  result.loadMs = await bootMatch(page, port, MAP);
  result.engine = servedEngine(server);
  result.app = await installAppProbe(page);
  await page.waitForFunction(
    () => window.__check.world.some((w) => w.inWorld) && document.querySelector('.load-screen') === null,
    null,
    { timeout: 300000, polling: 100 }
  );
  await wait(25000);
  await mark('end');
  await wait(100);
  {
    const log = await page.evaluate(() => window.__perf.take());
    const at = await page.evaluate(() => ({
      warm: window.__check.warmRenders[0]?.t ?? null,
      warmEnd: window.__check.warmRenders.at(-1) ? window.__check.warmRenders.at(-1).t + window.__check.warmRenders.at(-1).ms : null,
      world: window.__check.world.find((w) => w.inWorld)?.t ?? null,
      screenGone: window.__check.screen.find((s) => !s.shown)?.t ?? null
    }));
    result.load = rounded(at);
    const rowAt = (t) => (t === null ? -1 : log.columns.start.findIndex((s) => s >= t));
    const add = (name, t) => {
      const row = rowAt(t);
      if (row >= 0) log.marks.push({ name, row, time: log.columns.start[row] });
    };
    log.marks.push({ name: 'load', row: 0, time: log.columns.start[0] });
    add('warm-up', at.warm);
    add('after the warm-up', at.warmEnd);
    add('world', at.world);
    add('world after 2 s', at.world + 2000);
    add('world after 10 s', at.world + 10000);
    const check = await finish('load', log, loadCdp, 0);
    // What the device made before, in and after the boot's warm-up.
    const made = check.made;
    result.steps.load.made.boot = {
      beforeWarmUp: made.filter((m) => m.t < at.warm).length,
      inWarmUp: made.filter((m) => m.warm).length,
      afterWarmUpToWorld: named(made.filter((m) => !m.warm && m.t > at.warmEnd && m.t < at.world), at.warmEnd),
      inWorld: named(made.filter((m) => !m.warm && m.t >= at.world), at.world)
    };
    writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  }
  result.gains = await calibrate();
  await wait(1000);

  // 2. Turning to what has not been drawn.
  await step('turn', async () => {
    await mark('quarter turns');
    for (let i = 0; i < 4; i++) {
      await turn(90);
      await wait(500);
    }
    await mark('full turn up');
    await pitchTo(-40);
    await turn(360);
    await mark('full turn down');
    await pitchTo(40);
    await turn(360);
    await pitchTo(0);
    await wait(500);
  });

  // 3. Each weapon's first shot.
  await step('weapons', async () => {
    await pitchTo(30);
    for (const weapon of WEAPONS) {
      await mark(`switch ${weapon}`);
      await run(page, `weapon ${weapon}`);
      await wait(1000);
      await mark(`fire ${weapon}`);
      await hold(K_F11, '+attack');
      await wait(weapon === 6 ? 600 : 300);
      await release(K_F11);
      await wait(1500);
    }
    await pitchTo(0);
  });

  // 4. Death by the player's own hand, gibbed, and the respawn.
  await step('kill', async () => {
    await mark('kill');
    await run(page, 'kill');
    for (let i = 0; i < 30 && !(await dead()); i++) await wait(100);
    result.killed = await dead();
    await wait(2500);
    await mark('respawn');
    await respawn();
    await wait(2000);
  });

  // 5. Bots in looks nobody wears, each sought out.
  await step('bots', async () => {
    for (const bot of BOTS) {
      await mark(`addbot ${bot}`);
      await run(page, `addbot ${bot}`);
      await wait(3000);
      await mark(`seek ${bot}`);
      await turn(360, 0, 120);
    }
  });

  // 6. Corpses: each bot shot down, its corpse watched until it has sunk, from wherever the player
  // stands, or from another spawn if no bot can be reached; then a bot kicked.
  await page.evaluate(() => window.pcqDev({ op: 'cvar', name: 'g_forcerespawn', value: '1' }));
  result.corpses = [];
  await step('corpses', async () => {
    for (let spawn = 0; spawn < 4 && !result.corpses.some((c) => c.outcome === 'dead'); spawn++) {
      if (spawn > 0) {
        await mark(`respawn ${spawn}`);
        await killAndRespawn();
      }
      for (const number of await others()) {
        await mark(`shoot ${number}`);
        const outcome = await shootDown(number);
        const shot = { number, spawn, outcome };
        result.corpses.push(shot);
        if (outcome !== 'dead') continue;
        // Its corpse, laid as it comes back; watched until it has sunk and gone.
        shot.corpse = await page
          .waitForFunction(
            ([n, max]) => window.pcqController.players().some(({ state }) => state.number >= max && state.clientNum === n),
            [number, MAX_CLIENTS],
            { timeout: 6000, polling: 50 }
          )
          .then(() => true, () => false);
        await mark(`corpse ${number}`);
        await wait(9000);
      }
    }
    const [kicked] = await others();
    await mark(`kick ${kicked}`);
    await run(page, `clientkick ${kicked}`);
    await wait(3000);
  });

  // 7. The board, twice.
  await step('scoreboard', async () => {
    for (const n of [1, 2]) {
      await mark(`scores ${n}`);
      await hold(K_F11, '+scores');
      await wait(1500);
      await release(K_F11);
      await wait(1000);
    }
  });

  // 8. Every powerup taken. Quake 3 spawns them 30 to 60 s into the match (`FinishSpawningItem`),
  // in the ring around the centre spawn.
  result.powerups = { spawns: 0, taken: [] };
  await step('powerups', async () => {
    await mark('to the centre');
    for (let i = 0; i < 15 && (await fromCentre()) > 64; i++) {
      await killAndRespawn();
      result.powerups.spawns++;
    }
    await mark('waiting');
    for (let i = 0; i < 70 && (await powerupsInWorld()).length < POWERUPS.size; i++) await wait(1000);
    const standing = await powerupsInWorld();
    standing.sort((a, b) => Math.atan2(a.y - CENTRE.y, a.x - CENTRE.x) - Math.atan2(b.y - CENTRE.y, b.x - CENTRE.x));
    for (const { item, x, y } of standing) {
      await mark(`take ${POWERUPS.get(item)}`);
      const arrived = await walkTo(x, y);
      await wait(1500);
      result.powerups.taken.push({ item: POWERUPS.get(item), arrived });
    }
    result.powerups.active = await page.evaluate(() =>
      window.pcqController.player.powerups.flatMap((until, pw) => (until > 0 ? [pw] : []))
    );
    await mark('held');
    await wait(3000);
    // Every gun in the hand while they are held: each its shells.
    for (const weapon of WEAPONS) {
      await mark(`held ${weapon}`);
      await run(page, `weapon ${weapon}`);
      await wait(1000);
    }
  });

  // 9. The same map again: its own load and warm-up, then a full turn. Before the menu, which
  // pauses the match's server under it.
  await step('map', async () => {
    const renders = await page.evaluate(() => window.__check.warmRenders.length);
    await mark('map');
    await run(page, `map ${MAP}`);
    await page.waitForFunction(
      (n) =>
        window.__check.warmRenders.length > n &&
        window.pcqController?.inWorld === true &&
        document.querySelector('.load-screen') === null,
      renders,
      { timeout: 180000, polling: 100 }
    );
    await mark('world');
    await wait(5000);
    await mark('full turn');
    await turn(360, 0, 120);
  });

  // 10. The menu, and Setup's pages with a player preview.
  result.menu = {};
  await step('menu', async () => {
    await mark('in-game menu');
    await page.evaluate(() => window.pcqMenu.open());
    await wait(1500);
    await mark('setup');
    await page.evaluate(() => window.pcqMenu.setup());
    await wait(1000);
    await mark('player');
    result.menu.player = await useItem('PLAYER');
    await wait(1500);
    await mark('model');
    result.menu.model = await useItem('MODEL');
    await wait(1500);
    await mark('closed');
    await page.evaluate(() => window.pcqMenu.menu.forceOff());
    await wait(1000);
  });

  result.gpuErrors = await page.evaluate(() => window.__perf.gpuErrors);
  result.viewports = await page.evaluate(() => window.__check.viewports);
  result.totals = await page.evaluate(() => Object.fromEntries(window.__perf.counters.map((n, i) => [n, window.__perf.counts[i]])));
} catch (err) {
  result.error = String(err);
  result.stack = err?.stack;
} finally {
  await context.close().catch(() => {});
  await server.close();
  remove(home);
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
for (const [name, entry] of Object.entries(result.steps)) console.log(report(name, entry));
console.log(JSON.stringify({ load: result.load, boot: result.steps.load?.made.boot, killed: result.killed, corpses: result.corpses, powerups: result.powerups, menu: result.menu }, null, 1));
console.log(`problems ${result.problems.length}: ${JSON.stringify(result.problems.slice(0, 10))}`);
console.log(`gpuErrors ${result.gpuErrors?.length ?? '–'}: ${JSON.stringify([...new Set(result.gpuErrors ?? [])].slice(0, 3))}`);
console.log(`viewports past the limit: ${JSON.stringify(result.viewports ?? null)}`);
if (result.error) console.log(`error ${result.error}\n${result.stack}`);
console.log(`done ${OUT}`);
