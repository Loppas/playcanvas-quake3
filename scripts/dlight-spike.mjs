// A spike: can the garage's 13.9M splats take Q3's world dynamic light, every frame, from a hook
// on the shared splat material?
//
// The hook is Q3's ProjectDlightTexture_scalar (tr_shade.c:407–556) with the blob of
// R_CreateDlightImage, evaluated per splat, and is injected into the running game: nothing under
// src/ changes. One backend per run:
//
//     node scripts/dlight-spike.mjs webgpu
//     node scripts/dlight-spike.mjs webgl2
//
// Per condition it records the GPU time of every pass (PlayCanvas's own profiler, on timestamp
// queries), the CPU frame interval, the engine's work-buffer copy counter, and whether the camera
// moved. The conditions: no hook; the hook with 0, 1, 8 and 32 moving lights; 32 stacked on one
// spot; 32 far from every splat; no hook again; and a positive control that forces a re-bake every
// frame, so a zero on the copy counter means something. Screenshots and pixel diffs against the
// first show whether the lights reached the shader, and the red channel's histogram over the lit
// floor checks the core against Q3's factor. Writes result.json and PNGs to the temp folder named
// at the end. Headless, so nothing opens on screen; Chromium gets the real GPU here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { keepSocketsHere } from './perf/perf-lib.mjs';

const DEVICE = process.argv[2] === 'webgl2' ? 'webgl2' : 'webgpu';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(tmpdir(), 'pcq-dlight-spike', DEVICE);
const require = createRequire(`${REPO}/package.json`);
const { chromium } = require('playwright');
const { createServer } = await import(pathToFileURL(`${REPO}/node_modules/vite/dist/node/index.js`).href);

const WARM_MS = 3000;
const SAMPLE_MS = 5000;
/** Q3's `MAX_DLIGHTS`. */
const MAX_DLIGHTS = 32;
/** The quad's light, 200 + (rand & 31), at its middle (`cg_players.c`). */
const RADIUS_UNITS = 216;
/** How far in front of the player the lights gather, in units. */
const FOCUS_UNITS = 128;
/** The view's pitch, degrees down, so the floor under the lights fills the screen. */
const PITCH = 35;

// Lights arrive in world metres, Y up: uDlightPos[i] = (centre, radius), uDlightColor[i] =
// (rgb, additive). Q3 projects along its Z, world Y here; the blob is symmetric in each horizontal
// axis, so their signs and order do not matter.
const GLSL = /* glsl */ `
uniform vec4 uDlightPos[${MAX_DLIGHTS}];
uniform vec4 uDlightColor[${MAX_DLIGHTS}];
uniform float uDlightCount;

// One texel of Q3's 16x16 dlight image: 4000 over the squared distance from the middle, 255 at
// most, 0 below 75.
float dlightTexel(vec2 t) {
    vec2 d = vec2(7.5) - t;
    float b = floor(4000.0 / dot(d, d));
    return b > 255.0 ? 255.0 : (b < 75.0 ? 0.0 : b);
}

// The image sampled as GL_LINEAR with GL_CLAMP_TO_EDGE samples it.
float dlightBlob(vec2 st) {
    vec2 u = st * 16.0 - 0.5;
    vec2 f = floor(u);
    vec2 w = u - f;
    vec2 t0 = clamp(f, 0.0, 15.0);
    vec2 t1 = clamp(f + 1.0, 0.0, 15.0);
    float top = mix(dlightTexel(t0), dlightTexel(vec2(t1.x, t0.y)), w.x);
    float bottom = mix(dlightTexel(vec2(t0.x, t1.y)), dlightTexel(t1), w.x);
    return mix(top, bottom, w.y) / 255.0;
}

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

void modifySplatColor(vec3 center, inout vec4 color) {
    int count = min(int(uDlightCount), ${MAX_DLIGHTS});
    for (int i = 0; i < ${MAX_DLIGHTS}; i++) {
        if (i >= count) break;
        vec4 light = uDlightPos[i];
        vec3 d = light.xyz - center;
        float radius = light.w;
        float h = abs(d.y);
        if (h > radius || abs(d.x) > 0.5 * radius || abs(d.z) > 0.5 * radius) continue;
        float m = h < 0.5 * radius ? 1.0 : 2.0 * (radius - h) / radius;
        vec4 tint = uDlightColor[i];
        vec3 src = dlightBlob(0.5 + d.xz / radius) * m * tint.rgb;
        if (tint.w > 0.5) {
            color.rgb += src;
        } else {
            color.rgb *= 1.0 + src;
        }
    }
}
`;

const WGSL = /* wgsl */ `
uniform uDlightPos: array<vec4f, ${MAX_DLIGHTS}>;
uniform uDlightColor: array<vec4f, ${MAX_DLIGHTS}>;
uniform uDlightCount: f32;

fn dlightTexel(t: vec2f) -> f32 {
    let d = vec2f(7.5) - t;
    let b = floor(4000.0 / dot(d, d));
    return select(select(b, 0.0, b < 75.0), 255.0, b > 255.0);
}

fn dlightBlob(st: vec2f) -> f32 {
    let u = st * 16.0 - 0.5;
    let f = floor(u);
    let w = u - f;
    let t0 = clamp(f, vec2f(0.0), vec2f(15.0));
    let t1 = clamp(f + 1.0, vec2f(0.0), vec2f(15.0));
    let top = mix(dlightTexel(t0), dlightTexel(vec2f(t1.x, t0.y)), w.x);
    let bottom = mix(dlightTexel(vec2f(t0.x, t1.y)), dlightTexel(t1), w.x);
    return mix(top, bottom, w.y) / 255.0;
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let count = min(i32(uniform.uDlightCount), ${MAX_DLIGHTS});
    var rgb = (*color).rgb;
    for (var i: i32 = 0; i < count; i++) {
        let light = uniform.uDlightPos[i];
        let d = light.xyz - center;
        let radius = light.w;
        let h = abs(d.y);
        if (h > radius || abs(d.x) > 0.5 * radius || abs(d.z) > 0.5 * radius) {
            continue;
        }
        let m = select(2.0 * (radius - h) / radius, 1.0, h < 0.5 * radius);
        let tint = uniform.uDlightColor[i];
        let src = dlightBlob(0.5 + d.xz / radius) * m * tint.rgb;
        if (tint.w > 0.5) {
            rgb = rgb + src;
        } else {
            rgb = rgb * (1.0 + src);
        }
    }
    *color = vec4f(rgb, (*color).a);
}
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, 'localhost', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sortedCopy = (xs) => [...xs].sort((a, b) => a - b);
const pct = (xs, p) => (xs.length ? sortedCopy(xs)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null);
const round = (x, n = 3) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);

/** One condition's frames, reduced to medians and 90th percentiles. */
function summarise(frames) {
  const intervals = [];
  for (let i = 1; i < frames.length; i++) intervals.push(frames[i].t - frames[i - 1].t);
  const passes = {};
  for (const f of frames) {
    for (const [name, ms] of Object.entries(f.gpu)) (passes[name] ??= []).push(ms);
  }
  const gpu = {};
  for (const [name, xs] of Object.entries(passes)) gpu[name] = { p50: round(pct(xs, 0.5)), p90: round(pct(xs, 0.9)) };
  const gpuFrames = frames.map((f) => f.gpuFrame);
  const cam0 = frames[0]?.cam ?? [0, 0, 0];
  const camMoved = Math.max(0, ...frames.map((f) => Math.hypot(f.cam[0] - cam0[0], f.cam[1] - cam0[1], f.cam[2] - cam0[2])));
  const copies = frames.map((f) => f.copy);
  return {
    frames: frames.length,
    frameIntervalMs: { p50: round(pct(intervals, 0.5)), p90: round(pct(intervals, 0.9)) },
    gpuFrameMs: { p50: round(pct(gpuFrames, 0.5)), p90: round(pct(gpuFrames, 0.9)) },
    gpu,
    bufferCopy: { max: Math.max(0, ...copies), framesNonZero: copies.filter((c) => c > 0).length },
    splatsDrawn: pct(frames.map((f) => f.gsplats), 0.5),
    cameraMovedMetres: round(camMoved, 6)
  };
}

const home = mkdtempSync(join(tmpdir(), 'pcq-home-'));
process.env.PCQ_FS_HOMEPATH = home;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const port = await freePort();
const server = await createServer({
  root: REPO,
  logLevel: 'warn',
  clearScreen: false,
  server: { host: 'localhost', port, strictPort: true, forwardConsole: false }
});
await server.listen();

const browser = await chromium.launch({
  channel: 'chromium',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    // Full-precision timestamps rather than Chrome's 100 µs quantisation.
    '--enable-webgpu-developer-features',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    '--autoplay-policy=no-user-gesture-required'
  ]
});
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await keepSocketsHere(context);
if (DEVICE === 'webgl2') {
  // No navigator.gpu, so createGraphicsDevice falls back to WebGL2 as on a browser without WebGPU.
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
  });
}
const problems = [];
const result = { device: DEVICE, conditions: {}, diffs: {} };
let page;

const shots = {};
async function shot(name) {
  shots[name] = (await page.screenshot({ path: join(OUT, `${name}.png`) })).toString('base64');
}

/**
 * Two shots compared: pixels changed, turned bluer or warmer; and over the floor the light
 * brightened, the histogram of the red channel's ratio where 1.2x cannot clip.
 */
async function diff(a, b) {
  return page.evaluate(
    async ([sa, sb]) => {
      const load = async (s) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
      const [ia, ib] = await Promise.all([load(sa), load(sb)]);
      const w = ia.width;
      const h = ia.height;
      const g = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
      g.drawImage(ia, 0, 0);
      const da = g.getImageData(0, 0, w, h).data;
      g.drawImage(ib, 0, 0);
      const db = g.getImageData(0, 0, w, h).data;
      let changed = 0;
      let bluer = 0;
      let warmer = 0;
      for (let i = 0; i < da.length; i += 4) {
        const dr = db[i] - da[i];
        const dg = db[i + 1] - da[i + 1];
        const dbl = db[i + 2] - da[i + 2];
        if (Math.max(Math.abs(dr), Math.abs(dg), Math.abs(dbl)) > 8) changed++;
        if (dbl > 8 && dbl > dr && dbl > dg) bluer++;
        if (dr > 8 && dr >= dg && dr > dbl) warmer++;
      }
      // The floor between the item row and the gun, where the light brightened it.
      const BIN = 0.02;
      const bins = new Map();
      let counted = 0;
      for (let y = 380; y < 860; y++) {
        for (let x = 200; x < 1700; x++) {
          const i = (y * w + x) * 4;
          if (db[i + 2] - da[i + 2] < 12 && db[i] - da[i] < 12) continue;
          if (da[i] < 40 || da[i] > 210) continue;
          const bin = Math.round(db[i] / da[i] / BIN);
          bins.set(bin, (bins.get(bin) ?? 0) + 1);
          counted++;
        }
      }
      const redRatio = {};
      for (const [bin, c] of [...bins].sort((p, q) => p[0] - q[0])) {
        const r = bin * BIN;
        if (r >= 0.99 && r <= 1.31) redRatio[r.toFixed(2)] = c;
      }
      return { changed, bluer, warmer, litFloorPixels: counted, redRatio };
    },
    [shots[a], shots[b]]
  );
}

async function measure(name, { hook, count = 0, layout = 'spread', rebake = false }) {
  await page.evaluate(([h, c, l, r]) => window.__dl.set(h, c, l, r), [hook, count, layout, rebake]);
  await page.waitForTimeout(WARM_MS);
  await page.evaluate(() => window.__dl.start());
  await page.waitForTimeout(SAMPLE_MS);
  const frames = await page.evaluate(() => window.__dl.stop());
  result.conditions[name] = { hook, count, layout, rebake, ...summarise(frames) };
}

try {
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${port}/`);

  // The load screen holds the game while it reads the install: minutes on a cold cache.
  await page.waitForFunction(
    () => Boolean(window.pcq?.app && window.pcqInput && window.pcqController && window.pcqPlayers),
    null,
    { timeout: 240000 }
  );
  await page.evaluate(() => {
    window.pcqInput.active = true;
  });
  // Let the player land.
  await page.waitForTimeout(3000);

  // Tilt the view down to the floor in front of the player.
  for (let i = 0; i < 60; i++) {
    const pitch = await page.evaluate(() => window.pcqController.viewAngles.x);
    if (Math.abs(pitch - PITCH) < 0.5) break;
    await page.evaluate((dy) => window.pcqInput.mouseMove(0, dy), (PITCH - pitch) * 2);
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(1500);

  result.env = await page.evaluate(() => {
    const device = window.pcq.app.graphicsDevice;
    const env = {
      deviceType: window.pcq.deviceType,
      splatCount: window.pcq.splatCount,
      canvas: [device.width, device.height],
      viewAngles: { ...window.pcqController.viewAngles },
      playerOrigin: { ...window.pcqController.game.game.level.clients[0].ps.origin }
    };
    if (device.isWebGPU) {
      const info = device.gpuAdapter?.info;
      env.adapter = info ? `${info.vendor} ${info.architecture} ${info.description}` : null;
      env.gpuTimers = !!device.supportsTimestampQuery;
    } else {
      const gl = device.gl;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      env.adapter = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      env.gpuTimers = !!device._extDisjointTimerQuery;
    }
    return env;
  });

  // The spike's frame hooks: the lights laid out and uploaded each update, a sample at each
  // frame's end.
  await page.evaluate(
    ([glsl, wgsl, max, radiusUnits, focusUnits]) => {
      const app = window.pcq.app;
      const device = app.graphicsDevice;
      device.gpuProfiler.enabled = true;
      const lang = device.isWebGPU ? 'wgsl' : 'glsl';
      const material = app.scene.gsplat.material;
      const camera = app.root.findByName('camera');
      const mapEntity = app.root.findByName('map');
      const pos = new Float32Array(max * 4);
      const col = new Float32Array(max * 4);
      const state = { hooked: false, count: 0, layout: 'spread', rebake: false, tick: 0, samples: null };
      const t0 = performance.now();

      // The lights gather on the floor in front of the player, at the height of the player's
      // origin, where Q3 puts a powerup's light. Q3 → world: (x, z, -y) / 32.
      const origin = window.pcqController.game.game.level.clients[0].ps.origin;
      const yaw = (window.pcqController.viewAngles.y * Math.PI) / 180;
      const focus = [
        (origin.x + Math.cos(yaw) * focusUnits) / 32,
        origin.z / 32,
        -(origin.y + Math.sin(yaw) * focusUnits) / 32
      ];
      const radius = radiusUnits / 32;

      function layout(time) {
        const n = state.count;
        for (let i = 0; i < n; i++) {
          const phase = time + (i * 2 * Math.PI) / Math.max(n, 1);
          let x;
          let z;
          if (state.layout === 'stack') {
            x = focus[0] + Math.cos(time) * 0.5;
            z = focus[2] + Math.sin(time) * 0.5;
          } else if (state.layout === 'far') {
            x = focus[0] + 300 + Math.cos(phase);
            z = focus[2] + 300 + Math.sin(phase);
          } else {
            // One light circles the focus at 1 m; more sit on three rings of 2, 4 and 6 m.
            const ring = n === 1 ? 1 : 2 + 2 * (i % 3);
            x = focus[0] + Math.cos(phase) * ring;
            z = focus[2] + Math.sin(phase) * ring;
          }
          pos.set([x, focus[1], z, radius], i * 4);
          // The quad's blue and the rocket's orange, alternately.
          col.set(i % 2 === 0 ? [0.2, 0.2, 1, 0] : [1, 0.75, 0, 0], i * 4);
        }
      }

      app.on('update', () => {
        // The positive control: a per-component parameter set every frame marks the component
        // dirty (component.js:401–405), as a work-buffer modifier fed by setParameter would.
        if (state.rebake) mapEntity.gsplat.setParameter('uSpikeTick', state.tick++);
        if (!state.hooked) return;
        layout((performance.now() - t0) / 1000);
        material.setParameter('uDlightPos[0]', pos);
        material.setParameter('uDlightColor[0]', col);
        material.setParameter('uDlightCount', state.count);
        material.update();
      });
      app.on('frameend', () => {
        if (!state.samples) return;
        const p = camera.getPosition();
        const gpu = {};
        for (const [k, v] of app.stats.gpu) gpu[k] = v;
        state.samples.push({
          t: performance.now(),
          copy: app.stats.frame.gsplatBufferCopy,
          gsplats: app.stats.frame.gsplats,
          gpu,
          gpuFrame: device.gpuProfiler._frameTime,
          cam: [p.x, p.y, p.z]
        });
      });

      window.__dl = {
        focus,
        set(hooked, count, layoutName, rebake) {
          if (hooked !== state.hooked) {
            const chunks = material.getShaderChunks(lang);
            if (hooked) chunks.set('gsplatModifyVS', lang === 'wgsl' ? wgsl : glsl);
            else chunks.delete('gsplatModifyVS');
            state.hooked = hooked;
            material.update();
          }
          if (!rebake && state.rebake) mapEntity.gsplat.deleteParameter('uSpikeTick');
          state.rebake = rebake;
          state.count = count;
          state.layout = layoutName;
        },
        start() {
          state.samples = [];
        },
        stop() {
          const s = state.samples;
          state.samples = null;
          return s;
        }
      };
    },
    [GLSL, WGSL, MAX_DLIGHTS, RADIUS_UNITS, FOCUS_UNITS]
  );
  result.focusWorld = await page.evaluate(() => window.__dl.focus);

  const CONDITIONS = [
    ['base', { hook: false }],
    ['hook0', { hook: true, count: 0 }],
    ['hook1', { hook: true, count: 1 }],
    ['hook8', { hook: true, count: 8 }],
    ['hook32', { hook: true, count: 32 }],
    ['hook32stack', { hook: true, count: 32, layout: 'stack' }],
    ['hook32far', { hook: true, count: 32, layout: 'far' }],
    ['base2', { hook: false }]
  ];
  for (const [name, condition] of CONDITIONS) {
    await measure(name, condition);
    await shot(name);
  }
  await measure('rebakeControl', { hook: false, rebake: true });

  for (const [name] of CONDITIONS.slice(1)) result.diffs[`base→${name}`] = await diff('base', name);
} catch (err) {
  result.error = String(err);
  result.stack = err?.stack;
} finally {
  result.problems = problems.filter((l) => !/favicon|powerPreference|stencil|Emissive|pak: skipped/.test(l));
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await server.close();
  rmSync(home, { recursive: true, force: true });
}
console.log(`done: ${OUT}`);
