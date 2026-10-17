#!/usr/bin/env node
/**
 * The scripted run: a player walking, jumping and falling on Quake 3's maps, as Quake 3 plays it,
 * held to the port's server playing the same commands.
 *
 * Quake 3 runs from the install, read only, against the retail paks alone and a home folder of its
 * own, as the reference capture runs it, in a 640×480 window: the screen is Q3's for a few seconds
 * a case. It records each case as a demo, and its console log gives every command's time and the
 * script's marks between them (`q3-play-lib.mjs`).
 *
 * The port reads each demo with its own wire, puts its player where Quake 3's first snapshot after
 * `setviewpos` has it, with `setviewpos`'s two events, and runs the same commands on the same map
 * under `vq3.cfg`, on Quake 3's clock (`src/scripted-run.ts`). Each of Quake 3's snapshots after
 * is held to the port's state after the frame of its time: the commands thought by then, the
 * origin within 1e-3 units, as the port's move works in doubles where Quake 3's rounds each
 * operation to a float, and every other field of the move exact. The health is held after each of
 * Quake 3's frames; and from the start, every mover in each snapshot, by number, both its
 * trajectories exact, and what each snapshot shows, its entities' numbers and its areamask.
 *
 * Usage:
 *   npm run q3-play
 *   npm run q3-play -- --cases q3dm1-drop --out <dir>
 *   npm run q3-play -- --from <dir>
 *
 * It writes each case's demo, `qconsole.log` and `results.json` under the OS's temp folder unless
 * `--out` says where. `--from` judges a run already in a folder again, without Quake 3. It prints
 * each case's result, and fails if one does not hold.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BASEGAME, fsBasepath } from './fs-basepath.mjs';
import {
  PLAY_CASES,
  PLAY_SCRIPT,
  caseCommands,
  casePaks,
  demoName,
  playArguments,
  playScript,
  readPlayLog,
  startSnapshot
} from './q3-play-lib.mjs';
import { RETAIL_PAKS, retailBasepath } from './q3-reference-lib.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
/** The install's ioquake3. */
const EXECUTABLE = 'ioquake3.x86_64.exe';
/** How long Q3 may take over one case, load and all. */
const Q3_TIMEOUT = 120000;
/** How many of a case's differences are printed. */
const SHOWN = 8;

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const named = option('cases')?.split(',');
const cases = named ? PLAY_CASES.filter(({ name }) => named.includes(name)) : PLAY_CASES;
if (named && cases.length !== named.length) {
  console.error(`No case of that name among ${PLAY_CASES.map(({ name }) => name).join(', ')}.`);
  process.exit(1);
}
const from = option('from');
const out = resolve(from ?? option('out') ?? mkdtempSync(join(tmpdir(), 'pcq-play-')));
const install = fsBasepath(ROOT, 'development');

/** Each case's demo, and the console log, played by Quake 3 into `out`. */
function playQ3() {
  const base = retailBasepath(install, casePaks(cases));
  const home = mkdtempSync(join(tmpdir(), 'pcq-q3home-'));
  try {
    mkdirSync(join(home, BASEGAME));
    writeFileSync(join(home, BASEGAME, PLAY_SCRIPT), playScript(cases));
    const args = playArguments({ basepath: base, homepath: home });
    const run = spawnSync(join(install, EXECUTABLE), args, {
      cwd: install,
      timeout: Q3_TIMEOUT * cases.length,
      stdio: 'ignore',
      // Unelevated, whatever the exe's compatibility settings ask: it writes only to the folders
      // made for it, and a launch that wants elevation cannot start from here.
      env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' }
    });
    const log = join(home, BASEGAME, 'qconsole.log');
    if (!existsSync(log)) {
      throw new Error(`Quake 3 wrote no log (exit ${run.status}, ${run.error ?? 'no error'})`);
    }
    copyFileSync(log, join(out, 'qconsole.log'));
    const demos = join(home, BASEGAME, 'demos');
    for (const file of existsSync(demos) ? readdirSync(demos) : []) {
      copyFileSync(join(demos, file), join(out, file));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
}

/** The port's modules, through Vite, as the page has them. */
async function portModules() {
  const vite = pathToFileURL(join(ROOT, 'node_modules/vite/dist/node/index.js')).href;
  const { createServer } = await import(vite);
  const server = await createServer({
    root: ROOT,
    logLevel: 'warn',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false }
  });
  const load = (path) => server.ssrLoadModule(path);
  return {
    server,
    CONFIGSTRING: (await load('/src/net/commands.ts')).CONFIGSTRING,
    STAT: (await load('/src/sim/constants.ts')).STAT,
    ...(await load('/src/net/demo.ts')),
    ...(await load('/src/scripted-run.ts')),
    ...(await load('/src/server/host-map.ts')),
    ...(await load('/src/pak/vfs.ts')),
    ...(await load('/src/pak/zip.ts')),
    ...(await load('/src/pak/node-source.ts'))
  };
}

/** The install's retail paks and the cases' map paks, mounted as Quake 3 mounts them. */
async function retailPaks(port) {
  const fs = new port.PakFileSystem();
  const installed = readdirSync(join(install, BASEGAME));
  for (const pak of [...RETAIL_PAKS, ...casePaks(cases)]) {
    const found = installed.find((name) => name.toLowerCase() === pak.toLowerCase());
    fs.mount(await port.ZipArchive.open(port.nodeFileSource(join(install, BASEGAME, found))));
  }
  return fs;
}

/** A case judged: Quake 3's demo read, its commands run on the port, and the two held together. */
async function judge(port, fs, runs, playCase) {
  const run = runs.get(playCase.name);
  if (!run) throw new Error(`${playCase.name}: Quake 3's log has no run of it`);
  const prefix = `${demoName(playCase.name)}.dm_`;
  const file = readdirSync(out).find((name) => name.startsWith(prefix));
  if (!file) throw new Error(`${playCase.name}: Quake 3 recorded no demo`);
  const demo = port.readDemo(new Uint8Array(readFileSync(join(out, file))));
  const { snapshots } = demo;
  const first = startSnapshot(snapshots);
  const start = port.q3MoveState(snapshots[first].ps);
  const after = snapshots.slice(first + 1);
  const map = port.hostMapFromData(await port.readHostMapData(fs, playCase.map));
  const health = (ps) => ps.stats[port.STAT.HEALTH];
  const [x, y, z] = playCase.at;
  const left = snapshots[first - 1].ps.origin;
  const replayed = port.replay(map, start, caseCommands(playCase, run), {
    health: health(snapshots[first].ps),
    levelStartTime: Number(demo.configstrings[port.CONFIGSTRING.LEVEL_START_TIME]),
    frames: snapshots
      .slice(first)
      .map(({ serverTime, ps }) => ({ serverTime, commandTime: ps.commandTime })),
    teleport: { time: snapshots[first].serverTime, from: left, to: { x, y, z } }
  });
  const result = port.compareMoves(
    after.map(({ serverTime, ps }) => ({ serverTime, state: port.q3MoveState(ps) })),
    replayed.snapshots
  );
  const q3Health = after.map(({ serverTime, ps }) => ({ serverTime, health: health(ps) }));
  result.differences.push(...port.compareHealth(q3Health, replayed.health));
  const movers = port.compareMovers(snapshots.slice(first), replayed.movers);
  result.movers = movers.compared;
  result.differences.push(...movers.differences);
  const sights = port.compareSights(snapshots.slice(first), replayed.sights);
  result.sights = sights.compared;
  result.differences.push(...sights.differences);
  return result;
}

mkdirSync(out, { recursive: true });
if (!from) playQ3();
const port = await portModules();
const results = {};
let failed = false;
try {
  const fs = await retailPaks(port);
  const runs = readPlayLog(readFileSync(join(out, 'qconsole.log'), 'latin1'));
  for (const playCase of cases) {
    const result = await judge(port, fs, runs, playCase);
    results[playCase.name] = result;
    const holds = result.differences.length === 0;
    failed ||= !holds;
    console.log(
      `${playCase.name.padEnd(12)} ${result.compared} snapshots, ${result.exact} exact; ` +
        `origin off by ${result.originOff.toExponential(1)} at most; ${result.movers} movers, ` +
        `${result.sights} sights  ` +
        `${holds ? 'holds' : 'DIFFERS'}`
    );
    for (const { time, field, q3, port: ours } of result.differences.slice(0, SHOWN)) {
      console.log(`  ${time}: ${field} Q3 ${q3}, port ${ours ?? 'no state'}`);
    }
    if (result.differences.length > SHOWN) {
      console.log(`  and ${result.differences.length - SHOWN} more`);
    }
  }
} finally {
  await port.server.close();
}
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`Written to ${out}`);
if (failed) process.exitCode = 1;
