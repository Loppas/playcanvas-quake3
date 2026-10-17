// The baseline's harness, shared by its scripts: an in-process Vite serving one build of the
// engine, headless Chromium on the real GPU with a kept profile (so a second launch finds the
// first one's caches), requestAnimationFrame paced to an emulated display, and a frame log the
// page fills without allocating while it records.
//
// The rules of a live check hold (testing.md): a free port, never 5173, 27950 or 27960; a
// throwaway fs_homepath; nothing written under src/ while a run is going. The server neither
// watches nor reloads, so an edit elsewhere cannot reload a page mid-measure.
import {
  closeSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(`${REPO}/package.json`);
const { chromium } = require('playwright');
const { createServer } = await import(pathToFileURL(`${REPO}/node_modules/vite/dist/node/index.js`).href);

/**
 * The engine's builds, by the condition that picks each from PlayCanvas's package exports. The
 * dev server's own default is the debug build's.
 */
export const BUILDS = {
  debug: ['module', 'browser', 'development'],
  profiler: ['module', 'browser', 'profiler'],
  release: ['module', 'browser', 'production']
};

/**
 * The reference display: a full-window canvas of 2560×1440 CSS pixels at a device pixel ratio of
 * 1.5. The engine caps its pixel ratio at 1 unless told otherwise, so that is also the size it
 * draws at.
 */
export const DISPLAY = { width: 2560, height: 1440, scale: 1.5 };

/** Real GPU, unpaced frames (the page paces them), unquantised GPU timers and a precise heap. */
export const CHROME_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-webgpu-developer-features',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--enable-precise-memory-info',
  '--autoplay-policy=no-user-gesture-required'
];

/** Console lines every run prints, which drown the ones worth reading (testing.md). */
export const KNOWN_NOISE = /favicon|powerPreference|stencil|Emissive|pak: skipped/;

/** A port nobody else holds: 5173 may already be a dev server someone is using. */
export function freePort() {
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
 * A throwaway fs_homepath for the run, so it never touches a real q3config.cfg. Set before the
 * server starts, which reads it. Its config empties both master slots, so no server the run starts
 * registers with a master on this machine's 27950.
 *
 * @param {string} [lines] - more of the config, a line each
 * @returns {string} the folder, to remove at the end
 */
export function throwawayHome(lines = '') {
  const home = mkdtempSync(join(tmpdir(), 'pcq-perf-home-'));
  writeFileSync(join(home, 'q3config.cfg'), `seta sv_master1 ""\nseta sv_master2 ""\n${lines}`);
  process.env.PCQ_FS_HOMEPATH = home;
  return home;
}

/**
 * The repo's dev server, serving one build of the engine, from a dependency cache of its own.
 *
 * @param {keyof typeof BUILDS} build
 * @returns {Promise<{ server: import('vite').ViteDevServer, port: number }>}
 */
export async function startVite(build) {
  const port = await freePort();
  const server = await createServer({
    root: REPO,
    logLevel: 'warn',
    clearScreen: false,
    cacheDir: join(tmpdir(), `pcq-perf-vite-${build}`),
    resolve: { conditions: BUILDS[build] },
    server: { host: 'localhost', port, strictPort: true, forwardConsole: false, hmr: false, watch: null }
  });
  await server.listen();
  return { server, port };
}

/**
 * The engine file the server's dependency bundle was built from, once a page has asked for it: the
 * proof of which build a run measured.
 *
 * @param {import('vite').ViteDevServer} server
 * @returns {string | null}
 */
export function servedEngine(server) {
  const optimizer = server.environments?.client?.depsOptimizer ?? server._depsOptimizer;
  const entry = optimizer?.metadata?.optimized?.playcanvas;
  return entry ? `${entry.src}`.replace(/\\/g, '/').replace(/^.*node_modules\//, '') : null;
}

/**
 * Chromium on a profile kept in `profileDir`: an empty folder is a first visit, with every cache
 * cold; the same folder again is a return, with Chrome's and the page's caches as the last run
 * left them.
 *
 * @param {string} profileDir
 * @param {{ width: number, height: number, scale: number }} display
 */
export async function launchChrome(profileDir, display = DISPLAY) {
  mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    args: CHROME_ARGS,
    viewport: { width: display.width, height: display.height },
    deviceScaleFactor: display.scale
  });
  // Quake 3's own master and server ports on this machine are someone else's: a socket a page
  // opens to either is closed before it reaches them, whatever its config says. The route reaches
  // pages opened after it, so the page the profile opened with goes.
  await context.routeWebSocket(/^wss?:\/\/[^/]+:(27950|27960)\//, (ws) => ws.close());
  for (const page of context.pages()) await page.close();
  return context;
}

/**
 * The page's side of the harness, run before the page's own scripts. Self-contained, as Playwright
 * sends it as source.
 *
 * - **The display.** `requestAnimationFrame` is answered on a grid of `1000 / rate` ms, as vsync
 *   answers it: a frame that runs past a tick waits for the next, and the timestamp handed over is
 *   the newest tick, so the game's `dt` is a whole number of refreshes. Rate 0 leaves the browser's
 *   own pace. Either way at most two frames are in flight: a frame is not begun while the GPU still
 *   has two to finish, as a double-buffered display holds a game back. Headless Chromium holds
 *   nothing back for WebGPU's work, so without this a page whose GPU frame outlasts the refresh
 *   runs ahead of the GPU by seconds.
 * - **The GPU's objects.** Every pipeline, shader module, bind group, buffer, texture and sampler
 *   the WebGPU device creates is counted, with the time the page spends in `createRenderPipeline`.
 *   With `countDraws`, draws and pipeline switches too; off by default, as it touches every draw.
 * - **The frame log.** While recording, each frame writes one row of preallocated columns: the
 *   tick, when its callbacks started and ended, the heap, every counter's change, and the ticks
 *   the frame was held back for the GPU. From the first frame the app's handles exist, its own
 *   figures too (`installApp`).
 * - **Long animation frames**, with the scripts each one ran.
 * - **The turn driver**, which turns the view at a steady rate through the mouse.
 *
 * @param {{ rate: number, capacity: number, countDraws: boolean, gpuTimers: boolean,
 *   record: boolean }} options
 */
function pageHarness({ rate, capacity, countDraws, gpuTimers, record }) {
  /** The counters, cumulative. Their order is the frame log's counter columns'. */
  const COUNTERS = [
    'pipelines',
    'pipelineMs',
    'computePipelines',
    'shaderModules',
    'bindGroups',
    'bindGroupLayouts',
    'buffers',
    'textures',
    'samplers',
    'submits',
    'writeBufferBytes',
    'writeTextureBytes',
    'draws',
    'setPipelines',
    'shadersGenerated',
    'programLookups',
    'programLookupMs',
    'variantClears'
  ];
  /** Per-frame figures the app's probe writes, beside the counters. */
  const APP_COLUMNS = [
    'update',
    'render',
    'drawCalls',
    'triangles',
    'gsplats',
    'gsplatCopy',
    'gsplatSort',
    'gpuFrame',
    'cgTime',
    'lag',
    'snapshots',
    'moved',
    'stepped',
    'eyeX',
    'eyeY',
    'eyeZ',
    'pitch',
    'yaw'
  ];
  const counts = new Float64Array(COUNTERS.length);
  const before = new Float64Array(COUNTERS.length);
  const column = () => new Float64Array(capacity).fill(NaN);
  const cols = { tick: column(), start: column(), end: column(), heap: column(), gpuHeld: column() };
  for (const name of COUNTERS) cols[name] = column();
  for (const name of APP_COLUMNS) cols[name] = column();

  const perf = {
    rate,
    capacity,
    counters: COUNTERS,
    counts,
    cols,
    /** GPU time by pass name, a column each, made the first time a pass is seen. */
    passes: new Map(),
    column,
    /** The row being written, or -1 between frames and while not recording. */
    row: -1,
    rows: 0,
    recording: false,
    loaf: [],
    gpuErrors: [],
    marks: [],
    /** The display's rate from the next frame on; 0 for the browser's own pace. Set below. */
    setRate: null,
    /** Starts a log afresh. */
    record() {
      for (const name in cols) cols[name].fill(NaN);
      for (const col of perf.passes.values()) col.fill(NaN);
      perf.rows = 0;
      perf.loaf.length = 0;
      perf.marks.length = 0;
      perf.recording = true;
    },
    /** Notes a moment in the log, at the next frame's row, and in a trace as a user-timing mark. */
    mark(name) {
      const time = performance.now();
      performance.mark(`perf:${name}`);
      perf.marks.push({ name, row: perf.rows, time });
    },
    /**
     * What the turn driver is asked to do: degrees left to turn, at degrees a second, with the
     * view's degrees per mouse count, measured by `calibrate`.
     */
    drive: { yawLeft: 0, yawRate: 0, pitchLeft: 0, pitchRate: 0, yawGain: 0, pitchGain: 0 },
    /** The app's probe, once installed. */
    appProbe: null,
    /** The WebGPU device, once the page has one. */
    gpu: null,
    /** Stops the log and hands it over as plain arrays. */
    take() {
      perf.recording = false;
      const n = perf.rows;
      const out = { rows: n, columns: {}, passes: {}, loaf: perf.loaf.slice(), marks: perf.marks.slice() };
      for (const name in cols) out.columns[name] = Array.from(cols[name].subarray(0, n));
      for (const [name, col] of perf.passes) out.passes[name] = Array.from(col.subarray(0, n));
      out.totals = Object.fromEntries(COUNTERS.map((name, k) => [name, counts[k]]));
      return out;
    },
  };
  window.__perf = perf;
  const k = Object.fromEntries(COUNTERS.map((name, i) => [name, i]));
  if (record) perf.record();

  /**
   * The app's figures in the frame log: the engine's frame stats and GPU passes, shader variants
   * generated and looked up, material variants cleared, and the controller's clock, lagometer,
   * prediction and eye. Installed by the first frame that finds the app's handles.
   */
  function installApp() {
    const app = window.pcq.app;
    const device = app.graphicsDevice;
    const pc = window.pcEngine;
    device.on('shader:generate', () => {
      counts[k.shadersGenerated]++;
    });
    const getProgram = pc.ProgramLibrary.prototype.getProgram;
    pc.ProgramLibrary.prototype.getProgram = function (name, options, processing, material) {
      const t = performance.now();
      counts[k.programLookups]++;
      try {
        return getProgram.call(this, name, options, processing, material);
      } finally {
        counts[k.programLookupMs] += performance.now() - t;
      }
    };
    const clearVariants = pc.Material.prototype.clearVariants;
    pc.Material.prototype.clearVariants = function () {
      counts[k.variantClears]++;
      return clearVariants.call(this);
    };
    if (gpuTimers && device.gpuProfiler) device.gpuProfiler.enabled = true;

    // The turn driver, ahead of the next frame's look: the mouse counts that turn the view by
    // this frame's share of what is left.
    const drive = perf.drive;
    app.on('update', (dt) => {
      const input = window.pcqInput;
      if (!input) return;
      let dx = 0;
      let dy = 0;
      if (drive.yawLeft !== 0 && drive.yawGain !== 0) {
        const step = Math.sign(drive.yawLeft) * Math.min(Math.abs(drive.yawLeft), drive.yawRate * dt);
        drive.yawLeft -= step;
        dx = step / drive.yawGain;
      }
      if (drive.pitchLeft !== 0 && drive.pitchGain !== 0) {
        const step =
          Math.sign(drive.pitchLeft) * Math.min(Math.abs(drive.pitchLeft), drive.pitchRate * dt);
        drive.pitchLeft -= step;
        dy = step / drive.pitchGain;
      }
      if (dx !== 0 || dy !== 0) input.mouseMove(dx, dy);
    });

    let row = -1;
    const passTime = (ms, name) => {
      let col = perf.passes.get(name);
      if (!col) perf.passes.set(name, (col = column()));
      col[row] = ms;
    };
    let snapshotsBefore = 0;
    app.on('frameend', () => {
      // Snapshots are counted every frame, so a log's first row holds only its own.
      const controller = window.pcqController;
      const snapshots = controller ? controller.view.lagometerSamples.snapshotCount : 0;
      const newSnapshots = Math.max(0, snapshots - snapshotsBefore);
      snapshotsBefore = snapshots;
      row = perf.row;
      if (row < 0) return;
      const frame = app.stats.frame;
      cols.update[row] = frame.updateTime;
      cols.render[row] = frame.renderTime;
      cols.drawCalls[row] = app.stats.drawCalls.total;
      cols.triangles[row] = frame.triangles;
      cols.gsplats[row] = frame.gsplats;
      cols.gsplatCopy[row] = frame.gsplatBufferCopy;
      cols.gsplatSort[row] = frame.gsplatSort;
      if (gpuTimers && device.gpuProfiler) {
        cols.gpuFrame[row] = device.gpuProfiler._frameTime;
        app.stats.gpu.forEach(passTime);
      }
      if (!controller) return;
      const view = controller.view;
      cols.cgTime[row] = controller.time;
      cols.lag[row] = controller.lagometer.frame(0) ?? NaN;
      cols.snapshots[row] = newSnapshots;
      cols.moved[row] = view.prediction.moved ? 1 : 0;
      cols.stepped[row] = view.steppedThisFrame ? 1 : 0;
      const eye = controller.viewOrigin;
      const angles = controller.viewAngles;
      cols.eyeX[row] = eye.x;
      cols.eyeY[row] = eye.y;
      cols.eyeZ[row] = eye.z;
      cols.pitch[row] = angles.x;
      cols.yaw[row] = angles.y;
    });
    const info = device.gpuAdapter?.info;
    perf.appProbe = {
      canvas: [device.width, device.height],
      deviceType: window.pcq.deviceType,
      adapter: info ? `${info.vendor} ${info.architecture} ${info.description}` : null,
      gpuTimers: Boolean(gpuTimers && device.supportsTimestampQuery),
      engine: `${pc.version} ${pc.revision}`,
      installedAtRow: perf.rows
    };
  }

  // The GPU's objects. Fixed arities, so a counted call allocates nothing; a missing optional
  // argument passed as undefined takes its default, as WebIDL has it.
  const count1 = (proto, name, i) => {
    const original = proto?.[name];
    if (!original) return;
    proto[name] = function (a) {
      counts[i]++;
      return original.call(this, a);
    };
  };
  if (typeof GPUDevice !== 'undefined') {
    const device = GPUDevice.prototype;
    const createRenderPipeline = device.createRenderPipeline;
    device.createRenderPipeline = function (descriptor) {
      const t = performance.now();
      counts[k.pipelines]++;
      try {
        return createRenderPipeline.call(this, descriptor);
      } finally {
        counts[k.pipelineMs] += performance.now() - t;
      }
    };
    count1(device, 'createComputePipeline', k.computePipelines);
    count1(device, 'createShaderModule', k.shaderModules);
    count1(device, 'createBindGroup', k.bindGroups);
    count1(device, 'createBindGroupLayout', k.bindGroupLayouts);
    count1(device, 'createBuffer', k.buffers);
    count1(device, 'createTexture', k.textures);
    count1(device, 'createSampler', k.samplers);
    const queue = GPUQueue.prototype;
    const submit = queue.submit;
    queue.submit = function (buffers) {
      counts[k.submits]++;
      return submit.call(this, buffers);
    };
    const writeBuffer = queue.writeBuffer;
    queue.writeBuffer = function (buffer, offset, data, dataOffset, size) {
      counts[k.writeBufferBytes] +=
        size !== undefined ? size * (data.BYTES_PER_ELEMENT ?? 1) : data.byteLength ?? 0;
      return writeBuffer.call(this, buffer, offset, data, dataOffset, size);
    };
    const writeTexture = queue.writeTexture;
    queue.writeTexture = function (destination, data, layout, size) {
      counts[k.writeTextureBytes] += data.byteLength ?? 0;
      return writeTexture.call(this, destination, data, layout, size);
    };
    if (countDraws) {
      const pass = GPURenderPassEncoder.prototype;
      for (const name of ['draw', 'drawIndexed']) {
        const original = pass[name];
        pass[name] = function (a, b, c, d, e) {
          counts[k.draws]++;
          return original.call(this, a, b, c, d, e);
        };
      }
      for (const name of ['drawIndirect', 'drawIndexedIndirect']) {
        const original = pass[name];
        pass[name] = function (a, b) {
          counts[k.draws]++;
          return original.call(this, a, b);
        };
      }
      count1(pass, 'setPipeline', k.setPipelines);
    }
    const requestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (descriptor) {
      const gpu = await requestDevice.call(this, descriptor);
      perf.gpu = gpu;
      gpu.addEventListener('uncapturederror', (e) => {
        if (perf.gpuErrors.length < 50) perf.gpuErrors.push(String(e.error?.message ?? e));
      });
      return gpu;
    };
  }

  // The display. Headless Chromium answers an idle page's requestAnimationFrame about every 17 ms
  // and a timer here lands milliseconds late, so the grid is kept by a worker of its own, which
  // posts each tick in the page's clock; the page then asks for a frame, with a pixel nudged so
  // the browser answers at once. Rate 0 hands frames straight to the browser.
  const raf = window.requestAnimationFrame.bind(window);
  const VSYNC = `
    let period = 0;
    let next = 0;
    let offset = 0;
    const loop = new MessageChannel();
    onmessage = (e) => {
      period = e.data.rate > 0 ? 1000 / e.data.rate : 0;
      offset = performance.timeOrigin - e.data.timeOrigin;
      next = performance.now();
    };
    loop.port1.onmessage = () => {
      if (period > 0) {
        const now = performance.now();
        if (now >= next) {
          postMessage(next + offset);
          next += Math.max(1, Math.ceil((now - next) / period)) * period;
        }
      }
      loop.port2.postMessage(0);
    };
    loop.port2.postMessage(0);
  `;
  const vsync = new Worker(URL.createObjectURL(new Blob([VSYNC], { type: 'text/javascript' })));
  let nudge = null;
  let nudged = 0;
  let ids = [];
  let callbacks = [];
  let runningIds = [];
  let running = [];
  let nextId = 1;
  /** A browser frame has been asked for and not yet run. */
  let asked = false;
  /** The newest tick the worker has posted, in the page's clock. */
  let tick = performance.now();
  /** The last frame's time, which a frame's never falls behind. */
  let lastTime = 0;
  /** Frames whose GPU work has not finished, and the cap a display's two buffers put on them. */
  let inFlight = 0;
  const MAX_IN_FLIGHT = 2;
  /** Frames asked for and held back by the cap since the last frame ran. */
  let held = 0;
  const finished = () => {
    inFlight--;
    if (pending) {
      pending = false;
      ask();
    }
  };
  /** Unpaced, a frame was due while two were in flight: it goes as soon as one finishes. */
  let pending = false;
  const ask = () => {
    if (asked) return;
    if (inFlight >= MAX_IN_FLIGHT) {
      // On a grid the frame waits for the next tick, as vsync would make it; unpaced, it goes as
      // soon as the GPU has room.
      if (perf.rate === 0) pending = true;
      held++;
      return;
    }
    asked = true;
    if (perf.rate > 0) {
      if (!nudge && document.documentElement) {
        nudge = document.createElement('div');
        nudge.style.cssText =
          'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;will-change:transform';
        document.documentElement.appendChild(nudge);
      }
      if (nudge) nudge.style.transform = (nudged ^= 1) ? 'translateX(1px)' : 'none';
    }
    raf(pump);
  };
  vsync.onmessage = (e) => {
    tick = e.data;
    if (perf.rate > 0 && ids.length > 0) ask();
  };
  perf.setRate = (hz) => {
    perf.rate = hz;
    // A tick from before the change would hand the game a time seconds old.
    tick = performance.now();
    vsync.postMessage({ rate: hz, timeOrigin: performance.timeOrigin });
    if (hz === 0 && ids.length > 0) ask();
  };
  perf.setRate(rate);
  function pump(browserTime) {
    asked = false;
    if (!perf.appProbe && window.pcEngine && window.pcq?.app) installApp();
    const now = performance.now();
    const time = Math.max(lastTime, perf.rate > 0 ? tick : browserTime);
    lastTime = time;
    // Callbacks asked for while these run wait for the next tick, as the browser's do.
    const idle = runningIds;
    runningIds = ids;
    ids = idle;
    const spare = running;
    running = callbacks;
    callbacks = spare;
    const row = perf.recording && perf.rows < capacity ? perf.rows : -1;
    if (row >= 0) {
      perf.row = row;
      before.set(counts);
      cols.tick[row] = time;
      cols.start[row] = now;
      cols.gpuHeld[row] = held;
    }
    held = 0;
    for (let i = 0; i < running.length; i++) {
      try {
        running[i](time);
      } catch (e) {
        reportError(e);
      }
    }
    runningIds.length = 0;
    running.length = 0;
    if (perf.gpu) {
      inFlight++;
      perf.gpu.queue.onSubmittedWorkDone().then(finished, finished);
    }
    if (row >= 0) {
      cols.end[row] = performance.now();
      cols.heap[row] = performance.memory.usedJSHeapSize;
      for (let i = 0; i < counts.length; i++) cols[COUNTERS[i]][row] = counts[i] - before[i];
      perf.row = -1;
      perf.rows = row + 1;
    }
    if (perf.rate === 0 && ids.length > 0) ask();
  }
  window.requestAnimationFrame = function (callback) {
    ids.push(nextId);
    callbacks.push(callback);
    if (perf.rate === 0) ask();
    return nextId++;
  };
  window.cancelAnimationFrame = function (id) {
    const i = ids.indexOf(id);
    if (i < 0) return;
    ids.splice(i, 1);
    callbacks.splice(i, 1);
  };

  // Long animation frames, with what ran in them.
  try {
    new PerformanceObserver((list) => {
      if (!perf.recording) return;
      for (const e of list.getEntries()) {
        perf.loaf.push({
          start: e.startTime,
          duration: e.duration,
          blocking: e.blockingDuration,
          renderStart: e.renderStart,
          styleAndLayoutStart: e.styleAndLayoutStart,
          scripts: e.scripts
            .slice()
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 4)
            .map((s) => ({
              duration: s.duration,
              invoker: s.invoker,
              source: `${s.sourceURL.split('/').slice(-2).join('/')}:${s.sourceFunctionName}`,
              forcedLayout: s.forcedStyleAndLayoutDuration
            }))
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch {
    // An older Chromium: no long-animation-frame entries, and the log says so by having none.
  }
}

/**
 * Installs the page's side of the harness on a context, for every page it opens.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {{ rate?: number, capacity?: number, countDraws?: boolean, gpuTimers?: boolean,
 *   record?: boolean }} options - `record` starts the frame log with the page, so it covers the
 *   load and the first frames in the world
 */
export function installPageHarness(
  context,
  { rate = 240, capacity = 40000, countDraws = false, gpuTimers = true, record = false } = {}
) {
  return context.addInitScript(pageHarness, { rate, capacity, countDraws, gpuTimers, record });
}

/**
 * The app's probe, which the page installs itself on the first frame the app's handles exist.
 *
 * @param {import('playwright').Page} page
 */
export async function installAppProbe(page) {
  await page.waitForFunction(() => Boolean(window.__perf?.appProbe), null, { timeout: 60000 });
  return page.evaluate(() => window.__perf.appProbe);
}

/**
 * Boots straight into a match on `map` and waits out the load screen.
 *
 * @param {import('playwright').Page} page
 * @param {number} port
 * @param {string} map
 * @returns {Promise<number>} the load's wall time, ms
 */
export async function bootMatch(page, port, map) {
  const t = Date.now();
  await page.goto(`http://localhost:${port}/?map=${map}`);
  await page.waitForFunction(
    () => Boolean(window.pcq?.app && window.pcqInput && window.pcqController && window.pcqPlayers),
    null,
    { timeout: 300000, polling: 250 }
  );
  const loaded = Date.now() - t;
  // Stands in for the captured mouse, which a script cannot take, so synthetic keys land.
  await page.evaluate(() => {
    window.pcqInput.active = true;
  });
  return loaded;
}

/**
 * Boots straight into `map`'s preview, its world flown with no match, which `pcq_preview` opens,
 * and waits out the load and its warm-up.
 *
 * @param {import('playwright').Page} page
 * @param {number} port
 * @param {string} map
 * @param {string} [settings] - More of the query string: cvars, as `r_novis=1&r_nocull=1`.
 * @returns {Promise<number>} the load's wall time, ms
 */
export async function bootPreview(page, port, map, settings = '') {
  const t = Date.now();
  await page.goto(
    `http://localhost:${port}/?map=${map}&pcq_preview=1${settings ? `&${settings}` : ''}`
  );
  // `pcq` is set once the boot's load screen has closed, which can be after a quick map's preview
  // is in. A preview that fails to load drops to the main menu's error screen.
  await page.waitForFunction(
    (name) =>
      Boolean(window.pcq?.app && window.pcqInput) &&
      (window.pcqPreview?.()?.name === name || Boolean(window.pcqError?.())),
    map,
    { timeout: 300000, polling: 250 }
  );
  const error = await page.evaluate(() => window.pcqError?.() ?? null);
  if (error) throw new Error(`no preview of ${map}: ${error}`);
  const loaded = Date.now() - t;
  // Stands in for the captured mouse, as in a match.
  await page.evaluate(() => {
    window.pcqInput.active = true;
  });
  return loaded;
}

/** A tour's flight along a place's facing where nothing stops it. */
export const FLIGHT = 512;
/** How far short of solid a flight stops: a player's box's half-width, 15, and a unit spare. */
export const SHORT_OF_SOLID = 16;

/**
 * A map's BSP as the dev server's paks hold it, read through the port's own modules, with the
 * modules the reading took.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {string} map
 */
export async function readMapBsp(server, map) {
  const load = (path) => server.ssrLoadModule(path);
  const { parseBsp } = await load('/src/formats/bsp.ts');
  const { ZipArchive } = await load('/src/pak/zip.ts');
  const { nodeFileSource } = await load('/src/pak/node-source.ts');
  const { PakFileSystem } = await load('/src/pak/vfs.ts');
  const { baseq3Dir } = await import(pathToFileURL(join(REPO, 'scripts/fs-basepath.mjs')).href);

  const dir = baseq3Dir(REPO, 'development');
  const fs = new PakFileSystem();
  const paks = readdirSync(dir)
    .filter((name) => /\.pk3$/i.test(name))
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  for (const pak of paks) {
    // A pak that is not a zip is skipped, as the page skips it.
    const archive = await ZipArchive.open(nodeFileSource(join(dir, pak))).catch(() => null);
    if (archive) fs.mount(archive);
  }
  const path = `maps/${map}.bsp`;
  const bytes = await fs.readRequired(path);
  return { path, bytes, bsp: parseBsp(bytes, path), load };
}

/**
 * A tour's places: `start`, where one is given, then each spot a free-for-all spawns a human at,
 * in the map's order, the eye where a player spawned there has it (`SPAWN_LIFT` and the view
 * height over the spot). Each has its flight along its facing: `FLIGHT` units, or
 * `SHORT_OF_SOLID` short of the first point, a unit apart, in a solid leaf; `solidAt` is that
 * point's distance, or null.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {string} map
 * @param {{ eye: number[], angles: number[] } | null} start
 */
export async function tourPlaces(server, map, start) {
  const { bsp, load } = await readMapBsp(server, map);
  const { readEntities, spawnInt, spawnVar } = await load('/src/formats/entity-text.ts');
  const { placement } = await load('/src/view/brush-models.ts');
  const { inGametype } = await load('/src/sim/spawn.ts');
  const { DEFAULT_VIEWHEIGHT, GT } = await load('/src/sim/constants.ts');
  const { SPAWN_LIFT } = await load('/src/sim/game.ts');
  const { angleVectors } = await load('/src/sim/pmove-math.ts');

  // `R_PointInLeaf` (`tr_world.c:501-525`): in front where `d > 0`. A solid leaf has no cluster.
  const inSolid = (p) => {
    let n = 0;
    while (n >= 0) {
      const node = bsp.nodes[n];
      const { normal, dist } = bsp.planes[node.planeNum];
      const d = p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2] - dist;
      n = d > 0 ? node.children[0] : node.children[1];
    }
    return bsp.leafs[-1 - n].cluster === -1;
  };
  const place = (name, eye, angles) => {
    const { forward } = angleVectors({ x: angles[0], y: angles[1], z: angles[2] });
    let solidAt = null;
    for (let d = 1; d <= FLIGHT + SHORT_OF_SOLID && solidAt === null; d++) {
      const p = [eye[0] + forward.x * d, eye[1] + forward.y * d, eye[2] + forward.z * d];
      if (inSolid(p)) solidAt = d;
    }
    const flight = solidAt === null ? FLIGHT : Math.max(0, solidAt - SHORT_OF_SOLID);
    return { name, eye, angles, flight, solidAt, flown: {} };
  };

  const places = start ? [place('start', start.eye, start.angles)] : [];
  let spawn = 0;
  for (const vars of readEntities(bsp.entityString).slice(1)) {
    const classname = spawnVar(vars, 'classname');
    if (classname !== 'info_player_deathmatch' && classname !== 'info_player_start') continue;
    if (!inGametype(vars, GT.FFA) || spawnInt(vars, 'nohumans', '0')) continue;
    const { origin, angles } = placement(vars);
    const eye = [origin[0], origin[1], origin[2] + SPAWN_LIFT + DEFAULT_VIEWHEIGHT];
    places.push(place(`spawn ${++spawn}`, eye, angles));
  }
  return places;
}

/** Where a fight's bots stand: this far along the player's facing, and this far to each side. */
const BOT_AHEAD = 192;
const BOT_APART = 64;
/** A moment's wall: a place whose facing meets solid between these, at eye height. */
const WALL_NEAR = 160;
const WALL_FAR = 320;

/**
 * The places a match run needs beyond its tour's, from the map's collision: where a fight's three
 * bots stand, in front of the first place with a floor for all three, at the height it has there;
 * a place facing a wall; and the place furthest from both.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {string} map
 * @param {Awaited<ReturnType<typeof tourPlaces>>} places - Given each its `origin`, the eye less
 *   the view height.
 */
export async function fightPlaces(server, map, places) {
  const { path, bytes, load } = await readMapBsp(server, map);
  const { parseBspCollision } = await load('/src/formats/bsp.ts');
  const { loadMap } = await load('/src/sim/cm/cm-load.ts');
  const { boxTrace } = await load('/src/sim/cm/cm-trace.ts');
  const { newTrace } = await load('/src/sim/cm/cm-local.ts');
  const { DEFAULT_VIEWHEIGHT, MASK } = await load('/src/sim/constants.ts');
  const cm = loadMap(parseBspCollision(bytes, path), path, { print: () => {} });
  const tr = newTrace();
  const mins = [-15, -15, -24];
  const maxs = [15, 15, 32];

  for (const p of places) p.origin = [p.eye[0], p.eye[1], p.eye[2] - DEFAULT_VIEWHEIGHT];

  /** Where a player's box comes to rest dropped at (x, y) from a little over `z`, or null. */
  const standing = (x, y, z) => {
    boxTrace(cm, tr, [x, y, z + 32], [x, y, z - 128], mins, maxs, 0, MASK.PLAYERSOLID);
    if (tr.startsolid || tr.allsolid || tr.fraction === 1) return null;
    return [tr.endpos[0], tr.endpos[1], tr.endpos[2]];
  };
  /** Whether nothing solid is between two eyes. */
  const clear = (a, b) => {
    boxTrace(cm, tr, a, b, null, null, 0, MASK.SOLID);
    return tr.fraction === 1;
  };

  let fight = null;
  for (const p of places) {
    const yaw = (p.angles[1] * Math.PI) / 180;
    const forward = [Math.cos(yaw), Math.sin(yaw)];
    const left = [-Math.sin(yaw), Math.cos(yaw)];
    const feet = standing(p.origin[0], p.origin[1], p.origin[2]);
    if (!feet) continue;
    const bots = [0, BOT_APART, -BOT_APART].map((side) =>
      standing(
        p.origin[0] + forward[0] * BOT_AHEAD + left[0] * side,
        p.origin[1] + forward[1] * BOT_AHEAD + left[1] * side,
        feet[2]
      )
    );
    const level = (b) => b && Math.abs(b[2] - feet[2]) < 18;
    const seen = (b) => clear(p.eye, [b[0], b[1], b[2] + DEFAULT_VIEWHEIGHT]);
    // Clear of every spawn spot, so a respawn or a stop on the tour never lands in one.
    const apart = (b) => places.every((q) => Math.hypot(q.eye[0] - b[0], q.eye[1] - b[1]) > 64);
    if (bots.every((b) => level(b) && seen(b) && apart(b))) {
      fight = { at: p.name, bots, botAngles: [0, (p.angles[1] + 180) % 360, 0] };
      break;
    }
  }
  if (!fight) throw new Error('no spot has a floor ahead for the bots');
  const wall = places.find((p) => p.solidAt >= WALL_NEAR && p.solidAt <= WALL_FAR);
  if (!wall) throw new Error('no spot faces a wall');
  // The unseen turn's spot: the one furthest from both of those.
  const from = places.filter((p) => p.name === fight.at || p.name === wall.name);
  const apartXY = (p, q) => Math.hypot(q.eye[0] - p.eye[0], q.eye[1] - p.eye[1]);
  const distance = (p) => Math.min(...from.map((q) => apartXY(p, q)));
  const unseen = places.reduce((best, p) => (distance(p) > distance(best) ? p : best));
  return { ...fight, wall: wall.name, unseen: unseen.name };
}

/**
 * Puts a client at `origin`, facing `angles`, through the worker's DEV handle; for the player,
 * waits until the view stands there.
 *
 * @param {import('playwright').Page} page
 * @param {number} client
 * @param {number[]} origin
 * @param {number[]} angles
 */
export async function place(page, client, origin, angles) {
  const vector = (v) => ({ x: v[0], y: v[1], z: v[2] });
  const request = { op: 'place', client, origin: vector(origin), angles: vector(angles) };
  const state = await page.evaluate((r) => window.pcqDev(r), request);
  if (!state) throw new Error('no worker to put a client in');
  if (client !== 0) return;
  await page.waitForFunction(
    ([x, y]) => {
      const eye = window.pcqController.viewOrigin;
      return Math.hypot(eye.x - x, eye.y - y) < 1;
    },
    [origin[0], origin[1]],
    { timeout: 10000, polling: 20 }
  );
}

/** Quake 3's key code for F9, which commands are bound to and pressed through. */
const K_F9 = 153;

/**
 * Issues a game command as a player does: bound to a key, and the key pressed.
 *
 * @param {import('playwright').Page} page
 * @param {string} command
 */
export async function run(page, command) {
  await page.evaluate((c) => window.pcqConfig.command(['bind', 'F9', c]), command);
  await page.evaluate((key) => {
    window.pcqInput.keyDown(key);
    window.pcqInput.keyUp(key);
  }, K_F9);
}

/**
 * Tracing over CDP, which records every process: the page's main thread and its workers, the GPU
 * process, and V8's collections. Started before the moment it brackets, ended after.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} categories
 */
export async function startTrace(page, categories) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: { recordMode: 'recordContinuously', includedCategories: categories }
  });
  return cdp;
}

/**
 * Ends a trace and writes it to `file`.
 *
 * @param {import('playwright').CDPSession} cdp
 * @param {string} file
 */
export async function endTrace(cdp, file) {
  const complete = new Promise((done) => cdp.once('Tracing.tracingComplete', done));
  await cdp.send('Tracing.end');
  const { stream } = await complete;
  const out = createWriteStream(file);
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream, size: 1 << 20 });
    out.write(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  out.end();
  await finished(out);
  await cdp.detach();
}

/**
 * A trace's events, with the process and thread names its metadata gives them. The file is read a
 * chunk at a time and each event parsed on its own, so a trace of any size can be read: only the
 * events `keep` takes are held, and the metadata.
 *
 * @param {string} file
 * @param {(event: object) => boolean} [keep]
 */
export function readTrace(file, keep = () => true) {
  const events = [];
  const fd = openSync(file, 'r');
  const chunk = Buffer.alloc(1 << 22);
  // A byte scanner: strings and their escapes skipped, and every object one level inside the event
  // array cut out and parsed.
  let depth = 0;
  let eventDepth = -1;
  let inString = false;
  let escaped = false;
  let pieces = null;
  let pieceStart = 0;
  for (;;) {
    const n = readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) break;
    pieceStart = 0;
    for (let i = 0; i < n; i++) {
      const b = chunk[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (b === 0x5c) escaped = true;
        else if (b === 0x22) inString = false;
        continue;
      }
      if (b === 0x22) inString = true;
      else if (b === 0x7b || b === 0x5b) {
        // The events sit one level in: `[...]` alone, or `{"traceEvents":[...]}`.
        if (eventDepth < 0) eventDepth = b === 0x5b ? 1 : 2;
        if (b === 0x7b && depth === eventDepth) {
          pieces = [];
          pieceStart = i;
        }
        depth++;
      } else if (b === 0x7d || b === 0x5d) {
        depth--;
        if (b === 0x7d && depth === eventDepth && pieces) {
          pieces.push(chunk.subarray(pieceStart, i + 1));
          const event = JSON.parse(Buffer.concat(pieces).toString('utf8'));
          pieces = null;
          if (event.ph === 'M' || keep(event)) events.push(event);
        }
      }
    }
    if (pieces) {
      pieces.push(Buffer.from(chunk.subarray(pieceStart, n)));
    }
  }
  closeSync(fd);
  const processes = new Map();
  const threads = new Map();
  for (const e of events) {
    if (e.ph !== 'M') continue;
    if (e.name === 'process_name') processes.set(e.pid, e.args.name);
    if (e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name);
  }
  return {
    events,
    process: (e) => processes.get(e.pid) ?? String(e.pid),
    thread: (e) => threads.get(`${e.pid}:${e.tid}`) ?? String(e.tid)
  };
}

/** Removes a folder, tolerating Windows' brief holds on a file just closed. */
export function remove(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
