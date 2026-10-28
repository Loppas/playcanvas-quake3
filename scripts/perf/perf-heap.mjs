// Where the page's main thread allocates, by site: V8's sampling heap profiler, objects already
// collected included, on the profiler build, at 1280x720 unpaced. Per frame: the bytes sampled,
// by the port's file, by the nearest port frame above the allocation, by the port's call path and
// by leaf (engine functions named by class). An ArrayBuffer's backing store is not on V8's heap,
// so a packet's bytes are not counted here.
//
// garage_rats' match by default, in two scenes: standing still 8 s after the spawn, then a fight
// with three bots (god mode). Given a BSP map, its preview instead, in three: standing still 8 s
// after the warm-up, turning by the mouse, and flying a circle on `+forward` while it turns.
// Given a BSP map and `match`, its match, in three: standing still 8 s after the spawn, then
// perf-match.mjs's fight, as a BSP map's bots have no AI: three bots put in front of the player
// (god mode), rockets held at them, then plasma swept across them and the walls behind.
//
//     node scripts/perf/perf-heap.mjs \
//       <out.json> [seconds] [intervalBytes] [map] [match]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  REPO,
  bootMatch,
  bootPreview,
  fightPlaces,
  freePort,
  launchChrome,
  place,
  remove,
  run,
  servedEngine,
  throwawayHome,
  tourPlaces
} from './perf-lib.mjs';

const { createServer } = await import(pathToFileURL(`${REPO}/node_modules/vite/dist/node/index.js`).href);

const OUT = process.argv[2];
const SECONDS = Number(process.argv[3] ?? 4);
const INTERVAL = Number(process.argv[4] ?? 4096);
const MAP = process.argv[5];
const MATCH = MAP !== undefined && process.argv[6] === 'match';
const PREVIEW = MATCH ? undefined : MAP;
/** Mouse counts a frame for the preview's turn, and Quake 3's key code for F10, which flies it. */
const TURN_COUNTS = 8;
const K_F10 = 154;
/** The fight's bots, in the order they join, so each has the slot after the last: 1, 2 and 3. */
const BOTS = ['grunt', 'xaero', 'sarge'];
/** Quake 3's key code for F11, which holds the attack. */
const K_F11 = 155;
/** Mouse counts a frame for the plasma's sweep, and the frames of each way. */
const SWEEP_COUNTS = 2;
const SWEEP_FRAMES = 90;
if (!OUT) {
  throw new Error('usage: perf-heap.mjs <out.json> [seconds] [intervalBytes] [map] [match]');
}
// A BSP match's fight needs its weapons from the spawn.
const home = throwawayHome(MATCH ? 'seta pcq_spawnWeapons 1\n' : '');
const cacheDir = mkdtempSync(join(tmpdir(), 'pcq-heap-vite-'));
const profile = mkdtempSync(join(tmpdir(), 'pcq-heap-profile-'));
const port = await freePort();
const server = await createServer({
  root: REPO,
  mode: 'profiler',
  logLevel: 'warn',
  clearScreen: false,
  cacheDir,
  server: { host: 'localhost', port, strictPort: true, forwardConsole: false, hmr: false, watch: null }
});
await server.listen();
const context = await launchChrome(profile, { width: 1280, height: 720, scale: 1 });
const page = await context.newPage();
const result = {
  port,
  map: MAP ?? 'garage_rats',
  match: !PREVIEW,
  seconds: SECONDS,
  interval: INTERVAL,
  scenes: {},
  errors: []
};
page.on('pageerror', (err) => result.errors.push(String(err)));
page.on('console', (message) => {
  if (message.type() === 'error') result.errors.push(message.text());
});
try {
  if (PREVIEW) {
    result.loadMs = await bootPreview(page, port, PREVIEW);
  } else {
    result.loadMs = await bootMatch(page, port, MAP ?? 'garage_rats');
  }
  result.engine = servedEngine(server);
  if (!PREVIEW) {
    await page.waitForFunction(() => window.pcqController?.player !== undefined, null, { timeout: 30000 });
  }
  if (MATCH) {
    // A BSP map's load screen stays over its warm-up, seconds on a cold GPU cache.
    await page.waitForFunction(
      () =>
        window.pcqController?.inWorld === true && window.pcqScreens?.top === null,
      null,
      { timeout: 300000, polling: 100 }
    );
  }
  await page.waitForTimeout(8000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');

  // The bundled engine as the page loaded it, to name the class of any engine function.
  const deps = readFileSync(join(cacheDir, 'deps', 'playcanvas.js'), 'utf8').split('\n');
  const classAt = (line) => {
    for (let k = line; k >= 0; k--) {
      const m = /^\s*(?:var |let |const )?(?:class (\w+)|(\w+) = class)/.exec(deps[k]);
      if (m) return m[1] ?? m[2];
    }
    return '?';
  };
  const isEngine = (f) => f.url.includes('/deps/playcanvas.js');
  const isPort = (f) => f.url.includes('/src/');
  const file = (f) => (f.url.split('/').pop() ?? '').split('?')[0];
  // Lines are the served module's, which Vite's transform may have moved from the source's.
  const label = (f) => {
    if (isEngine(f)) return `${classAt(f.lineNumber)}.${f.functionName || '(anonymous)'}`;
    if (!f.url) return `${f.functionName || '(root)'} (native)`;
    return `${f.functionName || '(anonymous)'} ${file(f)}:${f.lineNumber + 1}`;
  };

  const sample = async (name) => {
    const frames0 = await page.evaluate(() => window.pcq.app.frame);
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval: INTERVAL,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true
    });
    await page.waitForTimeout(SECONDS * 1000);
    const { profile: p } = await cdp.send('HeapProfiler.stopSampling');
    const frames = (await page.evaluate(() => window.pcq.app.frame)) - frames0;
    const byFile = new Map();
    const byPort = new Map();
    const byPath = new Map();
    const byLeaf = new Map();
    let total = 0;
    const walk = (node, chain) => {
      const here = [...chain, node.callFrame];
      if (node.selfSize > 0) {
        total += node.selfSize;
        const add = (map, key) => map.set(key, (map.get(key) ?? 0) + node.selfSize);
        const portFrames = here.filter(isPort);
        const nearest = portFrames.at(-1);
        add(byFile, nearest ? file(nearest) : '(no port frame)');
        add(byPort, nearest ? label(nearest) : '(no port frame)');
        // The innermost four port frames, to tell a function's callers apart.
        const names = portFrames.slice(-4).map((f) => f.functionName || '?');
        add(byPath, names.length ? names.join(' > ') : '(no port frame)');
        add(byLeaf, label(node.callFrame));
      }
      for (const c of node.children ?? []) walk(c, here);
    };
    walk(p.head, []);
    const top = (map, n) =>
      [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, bytes]) => `${(bytes / frames / 1024).toFixed(2)} KB  ${((100 * bytes) / total).toFixed(1)}%  ${k}`);
    result.scenes[name] = {
      frames,
      fps: +(frames / SECONDS).toFixed(1),
      kbPerFrame: +(total / frames / 1024).toFixed(1),
      byFile: top(byFile, 25),
      byPort: top(byPort, 45),
      byPath: top(byPath, 45),
      byLeaf: top(byLeaf, 30)
    };
    console.log(`${name}: ${frames} frames, ${(total / frames / 1024).toFixed(1)} KB a frame`);
  };

  await sample('still');
  if (PREVIEW) {
    // The turn moves the mouse after each frame, so the next takes it as a player's would.
    await page.evaluate((counts) => {
      window.pcq.app.on('update', () => window.pcqInput.mouseMove(counts, 0));
    }, TURN_COUNTS);
    await sample('turning');
    await page.evaluate((key) => {
      window.pcqConfig.command(['bind', 'F10', '+forward']);
      window.pcqInput.keyDown(key);
    }, K_F10);
    await sample('flying');
    result.madeSinceWarmUp = await page.evaluate(() => window.pcq.madeSinceWarmUp());
  } else if (MATCH) {
    const places = await tourPlaces(server, MAP, null);
    const fight = await fightPlaces(server, MAP, places);
    result.fight = fight;
    await run(page, 'pcq_god 1');
    for (const bot of BOTS) {
      await run(page, `addbot ${bot}`);
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);
    const at = places.find((p) => p.name === fight.at);
    await place(page, 0, at.origin, at.angles);
    for (let i = 0; i < BOTS.length; i++) await place(page, i + 1, fight.bots[i], fight.botAngles);
    // A body is drawn only for an entity in the snapshot, so all three show the slots they took.
    await page.waitForFunction(
      () => [1, 2, 3].every((n) => window.pcqPlayers.body(n) !== null),
      null,
      { timeout: 10000, polling: 100 }
    );
    await run(page, 'weapon 5');
    await page.waitForTimeout(1000);
    await page.evaluate((key) => {
      window.pcqConfig.command(['bind', 'F11', '+attack']);
      window.pcqInput.keyDown(key);
    }, K_F11);
    await sample('rockets');
    await run(page, 'weapon 8');
    await page.waitForTimeout(600);
    // Swept left then right about the bots, as perf-match.mjs sweeps it, after each frame.
    await page.evaluate(
      ([counts, frames]) => {
        let frame = 0;
        window.pcq.app.on('update', () => {
          const way = Math.floor(frame++ / frames) % 2 === 0 ? 1 : -1;
          window.pcqInput.mouseMove(way * counts, 0);
        });
      },
      [SWEEP_COUNTS, SWEEP_FRAMES]
    );
    await sample('plasma');
    await page.evaluate((key) => window.pcqInput.keyUp(key), K_F11);
    result.madeSinceWarmUp = await page.evaluate(() => window.pcq.madeSinceWarmUp());
  } else {
    await run(page, 'pcq_god 1');
    for (const bot of ['grunt', 'xaero', 'sarge']) {
      await run(page, `addbot ${bot}`);
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(8000);
    await sample('fight');
  }
} catch (err) {
  result.error = String(err);
  result.stack = err?.stack;
} finally {
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  await context.close().catch(() => {});
  await server.close();
  remove(profile);
  remove(cacheDir);
  remove(home);
}
console.log('done');
