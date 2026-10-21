// Where can an item stand around the garage's centre spawn?
//
// The port's map carries no items, so the playtest pak has to place them itself. This probes the
// floor: for a ring of points around the centre spawn (-4 -4 43) it drops an item's box (radius
// 15, the same box `finishSpawningItem` traces) and reports where it would come to rest, whether
// the spot began in solid (where an item is freed rather than placed), and how flat the surface is.
// Nothing is written into the world; the answer is judged outside. Run it from the repo:
//
//     node scripts/items-probe.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { keepSocketsHere } from './perf/perf-lib.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(tmpdir(), 'pcq-items-probe');
const CENTRE = { x: -4, y: -4, z: 43 };
const RADII = [32, 64, 96, 128, 160, 192, 224, 256, 288, 320];
const STEPS = 12;
const HEIGHTS = [43, 55, 70, 90, 120];

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

const home = mkdtempSync(join(tmpdir(), 'pcq-home-'));
process.env.PCQ_FS_HOMEPATH = home;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const result = {};
const problems = [];
let page;
let browser;
let server;
try {
  const port = await freePort();
  result.port = port;
  server = await (await import(pathToFileURL(`${REPO}/node_modules/vite/dist/node/index.js`).href))
    .createServer({
      root: REPO,
      logLevel: 'warn',
      clearScreen: false,
      server: { host: 'localhost', port, strictPort: true, forwardConsole: false }
    });
  await server.listen();

  const { chromium } = createRequire(`${REPO}/package.json`)('playwright');
  browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await keepSocketsHere(context);
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto(`http://localhost:${port}/?map=garage_rats&g_doWarmup=0`);
  await page.waitForFunction(
    () => Boolean(window.pcq?.app && window.pcqController && window.pcqPlayers && window.pcqInput),
    null,
    { timeout: 240_000 }
  );
  await page.waitForTimeout(1500);

  result.spots = await page.evaluate(
    async ({ centre, radii, steps, heights }) => {
      const { MASK } = await import('/src/sim/constants.ts');
      const level = window.pcqController.game.game.level;
      const mins = { x: -15, y: -15, z: -15 };
      const maxs = { x: 15, y: 15, z: 15 };
      const out = [];
      for (const radius of radii) {
        for (let step = 0; step < steps; step++) {
          const angle = (step / steps) * Math.PI * 2;
          const x = centre.x + Math.cos(angle) * radius;
          const y = centre.y + Math.sin(angle) * radius;
          let spot = null;
          for (const height of heights) {
            // Entity 0 is the local player, standing on the centre spawn: skip them.
            const tr = level.trace(
              { x, y, z: height },
              mins,
              maxs,
              { x, y, z: height - 4096 },
              0,
              MASK.SOLID
            );
            if (tr.startsolid) continue;
            spot = {
              radius: Math.round(radius),
              angleDeg: Math.round((angle * 180) / Math.PI),
              from: height,
              x: Number(tr.endpos.x.toFixed(1)),
              y: Number(tr.endpos.y.toFixed(1)),
              z: Number(tr.endpos.z.toFixed(1)),
              normalZ: Number(tr.normal.z.toFixed(2)),
              fraction: Number(tr.fraction.toFixed(3)),
              entityNum: tr.entityNum,
              contents: tr.contents
            };
            break;
          }
          out.push(spot);
        }
      }
      return out;
    },
    { centre: CENTRE, radii: RADII, steps: STEPS, heights: HEIGHTS }
  );
} finally {
  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  result.problems = problems.slice(0, 20);
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}

const spots = result.spots ?? [];
for (const radius of RADII) {
  const ring = spots.filter((spot) => spot && spot.radius === radius);
  const line = ring
    .map((spot) => `${String(spot.angleDeg).padStart(3)}:${String(spot.z).padStart(6)}`)
    .join('  ');
  // eslint-disable-next-line no-console
  console.log(`${String(radius).padStart(3)} (${ring.length}/12)  ${line}`);
}
const walkable = spots.filter((spot) => spot && spot.normalZ >= 0.7);
// eslint-disable-next-line no-console
console.log(`\n${spots.filter(Boolean).length}/${spots.length} landed, ${walkable.length} walkable`);
// eslint-disable-next-line no-console
console.log(`problems: ${JSON.stringify(result.problems)}`);
