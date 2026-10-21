# Testing

How a change is proved in this repo. Written for whoever makes the next one: every rule below is
one that has already cost time to learn, and the end-to-end section is the one to read first,
because it is the only check that exercises the game a player actually gets.

**Boundary with [`code-standards.md`](code-standards.md):** that file
is binding on *what must exist* — a suite of unit and integration tests before a commit, mocks
only at the seam. This one is empirical: how the checks that work here are written, and which
trap eats an hour if you meet it fresh. Where they overlap, code-standards wins.

## Pick the check that can fail

| Question | Check | Cost |
|---|---|---|
| Does this function do what Quake 3's does? | Vitest unit test against a golden value | seconds |
| Do the pieces agree once wired? | Vitest integration test over the real sim | seconds |
| Do those tests actually bite? | A sabotage pass | ~50 s a break |
| Does it work in the real game — engine, renderer, menu, server loop? | **A headless live check** | ~2 min |
| Does it feel right? | A playtest by a person | their time |

**A green suite is not evidence that a change works.** Nothing above the sim — `src/App.ts`,
device creation, asset boot, the gsplat wiring, the frame loop — runs under Vitest, because jsdom
has neither WebGPU nor WebGL2. Land a change with a live check, or say plainly that it has none.

---

## End-to-end: drive the real game headless

A live check boots the app in a real Chromium against a real Vite dev server, presses keys at it,
reads the simulation out of the running page, and writes what it saw to a JSON file. It is the
only thing that catches a wiring break — a menu row bound to nothing, a command that never
reaches the server, an entity the renderer never draws.

### The harness

Both the dev server and the browser run **in this process**, because `spawn('npm')` fails on
Windows whatever the PATH is, and an in-process server closes cleanly at the end. Vite is
imported by file URL out of the repo's `node_modules`; Playwright comes through `createRequire`
against the repo's `package.json`. Write the script to the session scratchpad and run it with
`node`.

```js
// check.mjs — a live check, end to end.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '<absolute path to the repo>';
const OUT = '<absolute path in the session scratchpad>';
const require = createRequire(`${REPO}/package.json`);
const { chromium } = require('playwright');
const { createServer } = await import(
  pathToFileURL(`${REPO}/node_modules/vite/dist/node/index.js`).href
);
const { keepSocketsHere } = await import(
  pathToFileURL(`${REPO}/scripts/perf/perf-lib.mjs`).href
);

/** A port nobody else holds: 5173 may already be a dev server someone is using. */
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

// A throwaway fs_homepath, so the run never touches the real q3config.cfg.
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
  args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required']
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await keepSocketsHere(context);
const problems = [];
const result = { port, samples: [] };
let page;

const K_F9 = 153; // Quake 3 key codes, not browser ones.

/** Issue a game command the way a player does: bind it to a key, press the key. */
async function run(command, wait = 400) {
  await page.evaluate((c) => window.pcqConfig.command(['bind', 'F9', c]), command);
  await page.evaluate((key) => {
    window.pcqInput.keyDown(key);
    window.pcqInput.keyUp(key);
  }, K_F9);
  await page.waitForTimeout(wait);
}

/** One sample of everything worth knowing: the worker's server, and the client as it draws. */
const look = () =>
  page.evaluate(async () => {
    const server = await window.pcqDev({ op: 'state' });
    const ps = window.pcqController.player;
    return {
      time: window.pcqController.time,
      hostTime: server.hostTime,
      health: ps.stats[0],
      origin: { ...ps.origin },
      drawn: window.pcqPlayers?.body(1)?.model ?? null,
      sent: window.pcqController.players().map((p) => p.state.number)
    };
  });

try {
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  // `?map=` boots straight into a match, or with `pcq_preview=1` a preview for a map with a BSP
  // and no splat; with none, the page lands on the main menu.
  await page.goto(`http://localhost:${port}/?map=garage_rats`);

  // The load screen holds the game while it reads the install: minutes on a cold cache.
  await page.waitForFunction(
    () => Boolean(window.pcq?.app && window.pcqInput && window.pcqController && window.pcqPlayers),
    null,
    { timeout: 240000 }
  );
  // Stands in for the captured mouse, which a script cannot take, so synthetic keys land.
  await page.evaluate(() => {
    window.pcqInput.active = true;
  });

  await run('addbot grunt', 3000);
  result.samples.push(await look());
  await page.screenshot({ path: join(OUT, 'shot.png') });
} catch (err) {
  result.error = String(err);
  result.stack = err?.stack;
} finally {
  result.problems = problems.filter(
    (l) => !/favicon|powerPreference|stencil|Emissive|pak: skipped/.test(l)
  );
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await server.close();
  rmSync(home, { recursive: true, force: true });
}
console.log('done');
```

### The handles

All are registered under `import.meta.env.DEV` only, so a live check runs the **dev server**,
never the built `dist/`.

| Handle | Is | Good for |
|---|---|---|
| `window.pcq` | the app handle | `deviceType`, `splatCount` (0 with no map), `viewpos()` (null with no match or preview), `arenas`; its existence means the app booted |
| `window.pcqConfig` | `GameConfig` | `command(['bind', 'F9', '…'])`, `command(['cg_fov', '100'])` — any console command |
| `window.pcqInput` | the key input | `active = true`, `keyDown(k)` / `keyUp(k)` |
| `window.pcqController` | the current match's player controller, or null with none | the client's side: `players()`, `clientInfo(n)`, the view. The page's server runs in a worker, so `.game.game` and `.game.host` throw there; reach it through `pcqDev` |
| `window.pcqDev` | `(request) => Promise<DevState> \| null` | the worker's server: `{ op: 'state' }` reads its clock, map and slots; `{ op: 'cvar', name, value }` sets one where it reads it; `{ op: 'place', client, origin, angles }` puts a client there, still and facing its way, linked, with no effect or telefrag |
| `window.pcqConsole` | `(line) => void` | runs a console line through the command buffer, as a script cannot type one: `map garage_cats`, `disconnect`, `wait 3; addbot grunt` |
| `window.pcqMenu` | `{ menu, open, setup }` | `open()` opens the menu (a script cannot press Escape for the browser); `setup()` opens Setup's pages where q3_ui puts them; `menu.key(k)` presses inside it |
| `window.pcqPlayers` | `PlayerEntities` | `body(n)` — who is drawn, in what look, where |
| `window.pcqSound` | the sound bus | `mixer`, Quake 3's base mixer as the frame left it: its 96 `channels`, its `loopSounds` by entity, the merge's first `numLoopChannels` of `loopChannels`, and the `listener`; each voice's two gains (`channelVoices[i]`, `loopVoices` by sound, `dopplerVoices` by entity), each an ear's volume over 256; `volume`, `s_volume`; and `loops`, the merge's channels. The match's sounds: `gameSounds`, `cgs.gameSounds` (a slot's sound, `null` for handle 0, the hit), and `gameSoundNames`; `speakers.miscTime`, each speaker's next time. The music: `music.queued`, each read the queue holds and has not yet played through (its file's `name`, `start` and `frames` on the context's clock, and `pos`, its first byte in the file's data), `music.rawend`, where the next read goes, and `music.playing`; `musicQueue.gain`, the music's gain, its volume over 256; and `musicBuffers`, the buffers its queue has made. `pcqController.soundEntities()` is what the frame handed it. The automation pane plays nothing that can be heard, so a sound check reads these |
| `window.pcqMap` | `() => map` | the map being played, or null with no match, and what freeing it gives back; a BSP map's `world` gives `speeds()` as `pcqPreview`'s does, `dlightSpeeds()` as Q3's `r_speeds 4` prints it, `lightPasses`, the frame's dynamic light passes, and `polyDraws`, its polys' draws |
| `window.pcqLights` | `SceneLights` | the frame's dynamic lights, `lights`, in the order cgame added them; `added` keeps them under `r_dynamiclight 0` too |
| `window.pcqMarks` | `{ marks, polys }` | cgame's marks kept (`marks.count`), and the frame's polys (`polys.count`, `points`, `dropped`, each one's `shaders[i].name`) |
| `window.pcqPreview` | `() => BspWorld \| null` | a map's preview once it is in and drawn, or null: what a check on a preview waits on, as one on a match waits on `pcqController`; its `speeds()` gives the last view's counts as Q3's `r_speeds 1` and `5` print them |
| `window.pcqFlyer` | the fly camera | `start({ origin, angles })` places it and `view()` reads it, in Q3's frame and angles: a preview's camera, or a match's while it flies |
| `window.pcqError` | `() => string \| null` | the message a dropped match left for the main menu's error screen, until a key clears it |
| `window.pcqAssets` | the asset library | what actually came out of the paks |
| `window.pcqLoading` | the load screen | timing the load steps |
| `window.pcEngine` | the app's own `playcanvas` module | must be this one — Vite pre-bundles playcanvas, so a fresh dynamic import yields different classes whose entities have no app |

### Driving it

- **Read what the page receives.** The page's server runs in the worker, so nothing on the page
  holds the game's entities: a check reads the snapshots, the player's state, the events, the
  sounds, the marks and the lights, and asks the worker through `pcqDev` for its clock, map and
  slots. What only the server holds is read by running the port's client and server in
  one Node process, loaded through Vite's `ssrLoadModule`, as the teleport's walk, the online
  prediction run and the areas' costs were.
- **Time a check by the game's clock, and wait for a match by its gamestate.** A headless page's
  frames fall behind the wall's, so a mark's fade read by the wall's clock was missed. The
  page keeps one `pcqController` from match to match, so a check that waits for a new match waits
  on the view's gamestate number, not the handle. `map_restart` with no argument waits 5 s,
  as Quake 3's does, so a check sends `map_restart 0`.
- **A player put still above a floor bounces, as Quake 3's does.** `PM_WalkMove` gives a velocity
  clipped to the ground its speed back, so one put 9 units up, where `SelectSpawnPoint` puts one,
  kicks off for about a second, and one under a unit up for good: read where they rest after it. A
  spot that ends somewhere odd is dropped through ioquake3's own `Pmove`, compiled on the map's
  collision, before it is called the port's: 122 of a sweep's 133 odd spots ended where the C ended
  them, and the rest sit over pads or teleporters the C's harness has not got.
- **Issue game commands by pressing a bound key.** `pcqConfig.command` sets the bind directly;
  the key press is what carries the command through the client into the server's buffer, which is
  the path a player uses. Reaching past it proves less.
- **The menu pauses the whole game.** `controller.update(menu.isOpen ? 0 : dt)` — a command
  issued with the menu open does not run until play resumes. This is not Quake 3, whose server
  runs under its UI, and it has already cost one check: a menu button appeared to do nothing
  because the buffer never drained. Resume after every command issued from a menu.
- **Place an entity in three places, then link it.** Writing `ps.origin` alone moves nothing the
  world can find: set `ps.origin`, `entity.s.pos.trBase` and `entity.r.currentOrigin`, then call
  `host.linkEntity(entity)`. Without the link nothing traces against it. On the page, whose server
  is the worker's, `pcqDev({ op: 'place', … })` does it for a client (`placePlayer`).
- **Sample on a timer and break on the flip.** One `look()` returning a flat object, called in a
  loop with a `waitForTimeout`, beats a single reading after a fixed wait — it shows *when* the
  thing happened, which is usually the finding.
- **Kill through the damage, turn through the input.** `die()` alone leaves `STAT_HEALTH` whole,
  and the next think revives the player: zero the stat too, as `G_Damage` does, or call
  `damage()`. Writing `ps.viewangles` does not stick, because the view angles are the input's:
  turn through `pcqInput.mouseMove`. Opening the menu takes the keys from the script's binds, so
  hand them back afterwards, as a click on the view does.

### Reading it

Write `result.json` and screenshots to the scratchpad and read the file. Do not print a run to
stdout: it is large, and a shell that shortens long output can make a failure look like a pass. Do
not assert inside the script either — a live check is a measurement, and the judgement belongs in
the reading of it.

**Read a frame where it ends, and judge it by the twin where there is one.** At `frameend` the
canvas and the state the frame left (the bus's voices and gains, the frame's lights and passes,
the marks kept) are one frame's, so a 20 ms muzzle flash is read with the light it cast. The app
fires `frameend` and no `postupdate`, which only its systems fire, as `postUpdate`. Replay each
frame read through the C twin: 124 frames of the mixer and 108 of the world's
sounds matched it channel for channel, once the replay started a shot as it had begun.

Filter the console noise or it drowns the real error. The known-harmless set:
`favicon`, `powerPreference`, `stencil`, `Emissive`, `pak: skipped`, and the engine's own
`PlayCanvas` / `WebGPU` banners.

### Traps, each one paid for

- **Never write anything under `src/` while a check is running.** The dev server is watching;
  HMR reloads the page and every `window.pcq*` handle vanishes mid-run. The symptom is
  `Cannot read properties of undefined (reading 'game')` partway through a good run.
- **Set `PCQ_FS_HOMEPATH` to a temp dir.** Otherwise the run rewrites the real `q3config.cfg`.
  (`PCQ_FS_BASEPATH`, from the environment or `.env.local`, is the install the server reads.)
- **Take a free port.** 5173 may already be a dev server someone is using.
- **Keep the page's sockets on this machine.** A match registers with the masters its
  `sv_master` slots name, and `sv_master1` names the public one by default, so a check's tab
  would be listed for anyone to see. `keepSocketsHere(context)` from `scripts/perf/perf-lib.mjs`
  closes every WebSocket a page opens off this machine, or to 27950 and 27960 on it.
- **A dedicated server on the same machine is reached at `[::1]`.** `connect localhost` is the
  page's own loopback, as Quake 3's is.
- **Use Playwright, not the in-app Browser pane, for anything that must draw or load a map.** A
  hidden pane renders nothing, so its screenshots come out blank, and a pane reload logs WebGPU 0×0
  errors. Its range reads of the port's map paks come back 256 bytes long, so it cannot play a
  splat map. The pane is fine for reading a page.
- **Playwright's bundled Chromium can fall behind the `playwright` package.** Ask before
  downloading a new one.
- **Allow minutes for the first load.** The load screen holds the game until the install is read;
  240 s is the timeout that has always been enough.
- **Look from the player's own view.** First person draws the gun on a path of its own: a check
  made in third person missed that no powerup put its shell on the view weapon.
- **Hide the splat map in a pixel comparison.** The splats differ from one load to the next (about
  740 pixels on WebGL2, up to 9 levels; about 50 on WebGPU, up to 17), so compare models with the
  map hidden. Set the tolerance by breaking shader constants and counting what is caught: one level
  caught 28 of 28 breaks, where two levels missed two.

### Measuring GPU cost

A cost question is a live check too, such as whether a hook, a pass or an effect slows the frame,
and the engine can time it. [`dlight-spike.mjs`](../scripts/dlight-spike.mjs) is the pattern.

- **Headless Chromium gets the real GPU here**, on both backends, with GPU timers.
  - The spike launched with `--enable-gpu --ignore-gpu-blocklist`, plus
    `--enable-webgpu-developer-features` for unquantised timestamps and `--disable-gpu-vsync
    --disable-frame-rate-limit` so frames are not paced.
  - WebGPU is exposed only to a secure page, so probe from the dev server, not `about:blank`.
- **Time passes with PlayCanvas's own profiler.**
  - Set `app.graphicsDevice.gpuProfiler.enabled = true`, then read `app.stats.gpu` (pass name to
    ms) at each `frameend`.
  - WebGPU names every pass (`GSplatProjector`, `Forward`, …); WebGL2 gives one figure for the
    whole frame.
  - Compare medians over seconds, and judge by the pass the change touches. Whole-frame totals
    drift more between runs than a small change moves them.
- **Measure on the profiler build**, the release build's code with its timings kept: `npx vite
  --mode profiler` serves it (`scripts/engine-build.mjs`). `npm run dev` serves the debug build,
  whose checks around every draw add to the frame, and `npm run play` the release build.
- **Force WebGL2** with an init script that hides `navigator.gpu`. `createGraphicsDevice` then falls
  back as it would on a browser without WebGPU. Or ask for it as a player does: `seta r_glDriver
  "webgl2"` in the home's `q3config.cfg`. A query string picks no backend; read `pcq.deviceType`.
- **A zero needs a control.** A counter reading 0 proves nothing until a condition that must move
  it does. The spike's forced re-bake is the example.

### When a defect is visual

`npm run record` opens a headed Chromium, captures the session while it is played, and brackets
the moment with F8. It writes a labelled contact sheet an agent can read, plus full-resolution
frames behind it. See the README's *Recording a play session*. Use it when the sentence
describing the defect keeps failing — "the rocket shrinks when I strafe" took four rounds of
prose and two wrong hypotheses before a sheet settled it.

---

## Measuring performance

The performance harness lives in [`scripts/perf/`](../scripts/perf/), and its rules hold wherever
it is reused. It answers what a unit test cannot: where a frame's time
and bytes go, and what the load and the moments between loads cost.

| Script | Measures |
|---|---|
| `perf-lib.mjs` | the core: a throwaway `fs_homepath`, a free port (never 5173, 27950 or 27960), a kept Chrome profile per build (cold empties it first, warm is what a cold run left), a vsync worker pacing rAF (an idle headless rAF answers only every ~17 ms), the frame log, WebGPU object counts, long-animation frames, and CDP traces of V8's GC, Dawn's compiles and the GPU process's presents |
| `perf-render.mjs <build> <cache> [out]` | one boot of a map on one engine build: the load and first seconds, the four moments twice, four scenes at 240/144/60 Hz and unpaced, the splat passes by view direction, draw counts |
| `perf-preview.mjs <build> <cache> [out] [settings]` | a map's preview: the load and its warm-up, then a tour of q3dm11 at 240 Hz and unpaced (the start standing; at it and each spawn, a turn of 360° and a flight along its facing), draw counts, and each paced phase's floor (`perf-analyse.mjs`'s `floor`: a late frame fails where its own work made it). `settings` puts cvars in the page's address for a control run, as `r_novis=1&r_nocull=1` |
| `perf-match.mjs <build> <cache> [out]` | a match on q3dm11 with three AI-less bots, the player and the bots put where they stand through `pcqDev`: the load, then at 240 Hz the moments twice (a turn at a spot not yet seen, a rocket at a wall, a bot joining and put in view, a death and respawn), the bots' join, the preview's spawn spots toured at 240 Hz and unpaced (a turn of 360° at each), and a fight under `pcq_god 1` at both; each paced phase's floor, the start's from the load screen's close, and every shader and pipeline made after the start, named |
| `perf-net.mjs [out]` | the latency: a listen server, then a dedicated one with tabs joining, moving and firing; rounds of `snaps`, `cl_maxpackets` and `rate`; blocks of the main thread |
| `perf-report.mjs <run>…` | the render runs side by side as Markdown tables |
| `perf-keep.mjs <run> <out.json.gz>` | a run's `result.json` and frame logs as one gzipped JSON, small enough to keep beside the run it is compared with |
| `perf-warm-check.mjs` | the warm-up's check: shaders and pipelines made in play, each named; the assertion is zero after the warm-up |
| `perf-heap.mjs <out.json> [seconds] [intervalBytes] [map] [match]` | the page's allocation by site, standing still and in a fight (V8's sampling heap profiler); given a BSP map, its preview standing, turning and flying, or with `match` a match on it, standing, then `perf-match.mjs`'s fight with rockets and with plasma |
| `perf-profile.mjs` | a CPU profile of the frame, engine time by class |

Rules the harness paid for:

- **Cold is the judge; report warm beside it.** A new player and every Chrome update meet an empty
  profile, so the cold run decides; the warm run names what only a cold cache costs.
- **Numbers are the profiler build's.** The release build is what a player gets, and `npm run play`
  serves it; `npm run dev` serves the debug build, whose checks around every draw add to the frame;
  `npx vite --mode profiler` serves the release code with its timings kept
  (`scripts/engine-build.mjs`).
- **The display is the judge's**: Chrome on WebGPU on a desktop, the canvas at 2560×1440 CSS
  pixels, PlayCanvas capping its pixel ratio at 1. WebGL2, the shell and weaker machines are not
  what a fix is judged on, though their tests still run.
- **Never write under `src/` while a run is going.** The dev server watches it, HMR reloads the
  page, and every handle vanishes mid-run.
- **A zero needs a control**, as above: a counter reading nothing proves nothing until a case that
  must move it does.
- **A late frame fails a floor only where the page's own work made it**. At 240 Hz a light
  frame lets the GPU clock down, and its signal that a frame is done runs past a refresh: 26 to 217
  late frames a pass on q3dm11's tour, with the script under 2.4 ms. V8's full collections
  pause the page 2 to 14 ms about every 6 s, whatever the frame makes. Each is tagged, `gpu
  wait` or a collection, and counted beside the floor against a baseline; a compile, or a frame
  whose own script or GPU time passes 1.5 refreshes, fails it. A burst of late frames just after a
  heap drop of 100 MB or more is a major collection: a match run has 2 to 4, each holding back up
  to 41 frames by 8 ms or more.
- **A failing frame is found by its mark, and named before it is judged.** A frame log's marks say
  what the script was doing, and its columns what the frame made: q3dm11's first death doubles the
  draws and makes 29 buffers, and its arrival allocates 13.5 MB in one frame. A frame that
  comes in every run fails only where it lands in a judged phase or runs long, so read it in every
  run, not only the run that failed it.
- **A before-and-after is pairs run back to back, each with a control.** The before tree runs from
  a git worktree with `.env.local` copied and `public/` linked in, or its runs time out at the
  boot; while it stands, Vitest from the root collects its copy of the tests, so run `--dir src`,
  and take the links out before the worktree. A match run's rates swing as much
  between runs of one tree as across trees, the unpaced fight 603 to 855 fps over six runs,
  so judge by update and render over several pairs. A phase the change leaves alone is the pair's
  control: where it moves, the machine was busy, and the pair is set aside.

The **four moments** are what a player feels, scripted and run twice: the first shot or explosion;
a player or bot joining, respawning or first coming into view; the first seconds after the map
loads; and turning to face geometry not yet seen.

---

## Against Quake 3 itself: the reference capture

**What the port draws of a map is judged against ioquake3's own screenshots, texel by texel:
`npm run reference`.** `scripts/q3-reference.mjs` runs `opengl1` and the port's preview at one view
and scores each pair as the share of texels within 16 of Q3's on every channel. Its
rules, each one paid for:

- **Quake 3 runs so it can change nothing:** `+safe`, a throwaway `fs_homepath`, and an
  `fs_basepath` holding pak0–pak8 alone, linked from the install. An exe marked to run elevated
  starts unelevated under `__COMPAT_LAYER=RunAsInvoker`.
- **The shared view is the spectator's start.** The retail game module has no `g_localTeamPref`,
  so Q3 joins, then sends `team spectator`; `setviewpos` would drift it about 80 units.
  Another view is a copy of the map in a scratch pak, its intermission point moved.
- **Both clocks stand at Q3's time.** `fixedtime 1` steps Q3 a millisecond a frame, `cg_showmiss 2`
  prints cgame's time, and `pcq_previewTime` holds the port there.
- **Three modes, as overbright differs:** fullscreen against the port's defaults, a window against
  `r_overBrightBits 0`, and `r_fullbright 1`. A fullscreen shot with an odd byte under 255
  missed the ramp and stops the run; Q3 drops to a window unless `in_nograb 0`.
- **The views go in a cfg**, since Q3 keeps 32 command-line lines and runs the rest as one, `quit`
  among them; `cl_noprint 1` keeps the console off the picture.
- **Q3's console is an oracle.** Its `stitched <n> LoD cracks` and `r_speeds 1` and `5` lines give
  counts the port matches exactly, at a view facing a shut door too, its game's
  areamask closing what lies past it.
- **Quake 3's `entitylist` and `configstrings` hold the game's spawn and its strings.** `devmap`
  the map in Quake 3, take `entitylist` two seconds in and ioquake3's `configstrings`, and hold the
  port's local game on the same map to them. The 36 retail maps and `cpma3` kept Quake 3's entities
  in its order, numbers and prints, once the comparison had found two lines the port left out,
and `tig_gng`'s and `tig_bz`'s shader swaps came in Quake 3's order.
- **A mark is the measured share less two points**, pinned again whenever a stage moves it, and
  every difference left is named: a later stage's, a frame of time, or the edges' rasterisation.
- **A match needs a control, as a zero does.** With the fog's dimming taken out by a transform in
  the run's own Vite server, 2,504 and 6,442 texels of q3tourney5's flames fell outside tolerance,
  where dimmed every one was within it.

---

## Against Quake 3 itself: the scripted run

**How a player moves on a map is judged against ioquake3 playing the same keys from the same
place: `npm run q3-play`.** `scripts/q3-play.mjs` has Quake 3 record each case as a demo, and the
port's server replay its commands from Quake 3's state after `setviewpos` (`src/scripted-run.ts`).
Its rules, each paid for:

- **Quake 3 runs as the capture does**, in a 640×480 window: `+safe`, a throwaway home, pak0–pak8
  alone, unelevated. Two runs recorded the same states, snapshot for snapshot. A case on a map that
  is not retail names its pak, which both sides read beside the retail ones, as `cpm18`'s does.
- **A case is found on the port first.** Probe the map's contents and play the case's phases on the
  port's own `replay`, then let Quake 3 judge it. Choose a spot clear of what the port does not have
  yet: `cpm18`'s slick trench ends in a push trigger, so its case slides the other way. Probe what a
  player can reach, not what a brush holds: no retail slime is reachable, under grates and clip or
  sealed in, so lava's case is on `q3dm7`.
- **Quake 3's server runs at the port's tick, unless the case names its own `sv_fps`**, as lava's
  does to burn on Quake 3's own 50 ms frames. `snaps` is held to it by the server.
- **The record is a demo, read with the port's own wire.** `viewpos` prints the eye in whole units
  and is no use. A demo's states are Quake 3's numbering, though: its `PMF_*` are mapped to the
  port's.
- **The commands come from Quake 3's log**: `cg_showmiss 2` prints each frame's command time, and
  the script echoes a mark wherever its keys change. `fixedtime 8` and `pmove_fixed 1` make each
  frame one tick of the port's.
- **A held key is pressed again every frame.** `CL_KeyState` counts a held key in real
  milliseconds, so a frame that took none made a command without it, 21 times in one walk.
- **The port plays under `vq3.cfg`, checked**, as Quake 3's own game module plays.
- **The origin is held within 1e-3 units, and the rest of the move exactly.** The port's move works
  in doubles where the QVM rounds each operation to a float: up to 4.6e-5 units apart, in the air,
  in water and sliding on a slick floor. A zero matches either sign, as the wire sends a whole float
  as an integer.
- **The health is held after each of Quake 3's frames**, from `give health`'s 100, where nothing
  drains it. The port runs each of Quake 3's frames once the commands its snapshot shows are
  thought, and before the rest: Quake 3 thinks a command as its packet arrives, 16 ms behind its
  frame at `sv_fps 125` and 52 to 66 at 20. Its 50 ms frames, counted from
  `CS_LEVEL_START_TIME`, are put on the port's count of them.
- **The run is on Quake 3's clock.** Both levels start at 0 and step from 400 after the settle
  frames, so the port's player is put in Quake 3's state as it comes into the world and waits there
  while the server's frames run up to the first command. Shifting Quake 3's times instead would put
  every bobber out of phase.
- **Each snapshot is held to the port's state after the frame of its time.** Quake 3's snapshot
  carries the player the frame left, a mover's push in it; held after the command, a plat's rider
  was a frame behind. Every `ET_MOVER` is held by number, `trType`, `trTime` and `trDuration`
  exact and `trBase` and `trDelta` as Quake 3's floats, and so are each snapshot's entity numbers
  and its 32 bytes of areamask, the replay making the two events `setviewpos` makes.
- **A recorded run holds more than its cases asked.** Every demo carries each snapshot's entities
  and areamask, so the snapshot's cull was checked on the thirteen cases recorded before it: Quake
  3's rule, worked out on the port's own state, gave Quake 3's mask on all 5,998 snapshots, and
  showed the overflow scan was needed, before a case was added.
- **`--from <dir>` judges a recorded run again**, with no Quake 3 on the screen; a sabotage pass
  uses it. `scripted-run.test.ts` holds q3dm1's, q3dm12's, q3dm17's, q3dm7's and q3dm19's cases to
  Quake 3's own checkpoints whenever pak0 is installed, q3dm17's pads to the velocities Quake 3
  sent, and `cpma3`'s plat whenever its pak is.

---

## Unit and integration: Vitest

```bash
npx vitest run --dir src
```

`npm test` runs everything including `scripts/*.test.mjs`; `--dir src` is the fast inner loop and
what the sabotage runner uses. `npm run test:watch` watches.

The suite is two Vitest projects (`vite.config.ts`): `node`, everything above, and `workerd`, the
master's Worker (`master/cloudflare/`) in Cloudflare's runtime through
`@cloudflare/vitest-plugin`. `--dir` and `--exclude` reach the Node project alone, so the
Worker's file runs whatever they say; `--project workerd` runs it alone. Its files run one at a
time, after the Node project's, since a Durable Object's WebSockets need storage shared across
them. Every fetch the Worker makes is answered by the tests' own DNS over HTTPS
(`master/cloudflare/vitest.config.ts`), so none reaches the network.

- Tests are colocated as `*.test.ts` and import from `vitest` explicitly — no globals.
- A file needing a DOM opts in at its top: `// @vitest-environment jsdom` (50 files do).
- **Mock only what cannot run here.** One of 336 test files calls `vi.mock`. Forty call
  `createTestApp()` from `render/engine-test-fixtures.ts`, which is a *real* PlayCanvas app on the
  engine's `NullGraphicsDevice`: `app.render()` runs composition, culling and every layer's
  render step with only the device calls stubbed, so draw order measured there is the engine's
  own. A test that mostly asserts against mocks is not coverage.
- **Shader chunks on the null device.** After `app.render()`, a material's `variants` hold the
  shaders the engine assembled, in `definition.vshader` and `fshader`: preprocessed, never
  compiled. With the device's `isWebGPU` set true before the first render, it assembles WGSL
  instead (`render/model-chunks.test.ts`). `assembledShaders()` does both for a material on a
  triangle, and `expectInOrder()` checks parts of one come in order. Only a live run proves they
  compile and draw right.

### The fixtures, and what each saves you

| Fixture | Gives |
|---|---|
| `sim/life-test-fixtures.ts` | `spawnClient()` — a client standing at a known place with a fresh life, linked, without `Game` choosing a spawn point |
| `sim/map-test-fixtures.ts` | entity text and spawn spots, for a level to be built from |
| `sim/trace-test-fixtures.ts` | a recording trace, so a test can assert *which* traces were asked for |
| `sim/octree-test-fixtures.ts` | the `.voxel.bin` packer, and the real bake when it is present |
| `sim/box-world.ts` (a sim module, not a fixture) | `box()`, `floorBox()`, `createFlatWorldTrace()` — a world with a floor and nothing else to trace against |
| `render/engine-test-fixtures.ts` | the null-device PlayCanvas app, and the shaders it assembles for a material |
| `render/player-test-fixtures.ts` | player models and skins without an install |
| `pak/pak-test-fixtures.ts` | the retail paks, guarded (below) |
| `view/world-test-fixtures.ts` | maps built as records rather than bytes — `testBsp()` with its `surface()`, `leaf()`, `node()` and `model()`, and fogs from `fogParts()` — and `testSources()`, a world's shaders from script text |
| `formats/bsp-test-fixtures.ts` | `buildBsp()` — a BSP from the lumps a test gives, over the smallest map Quake 3 loads — and `retailMaps()`, the 36 retail maps read once (below) |

### Tests that need a local install

The Quake 3 data is never committed. Tests that need it guard on a probe and skip without it, so
a clean checkout still runs green:

```ts
describe.skipIf(!haveFullSet)('readEntities against the 36 retail maps', () => { … });
```

The probes are `havePak(name)` and `havePak0` from `pak/pak-test-fixtures.ts`, and `haveRealBake`
from `sim/octree-test-fixtures.ts`. A file needing the whole set builds its own from the shared
probe, which is the idiom to copy:

```ts
const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);
```

Follow the pattern for anything new that reads an install or the 185 MB map pk3 — and never
commit the data to make a test pass.

**Read the retail maps once a file.** `retailMaps(read)` mounts the nine paks and inflates all 36
BSPs on every call, so call it from a `beforeAll` with a timeout of its own (60 s), keeping only
what `read` makes of each map, rather than from each `it` under the 5 s default.

**Take any slow first step in a hook.** A test that times out is abandoned, not stopped: what it
awaited runs on into the next test. A file whose first `import()` transforms a large graph, as
`main.test.ts`'s does, takes it in a `beforeAll` with a timeout of its own.

**Real sockets** (`node-network`, the datachannel tests):
- fixed ports go below those the system hands a socket bound to port 0, from 32768 on Linux and
  49152 on Windows and macOS, as the peer connections of other files, run alongside, take those;
- what needs IPv6 skips where the machine binds none, as a CI runner may not;
- a file that waits on the network gives its tests a timeout past its waits' own (`WAITING`).

**Real data catches what a built fixture cannot.** The renderer's tests build their own asset
library, so a shader, texture, icon or sound missing from `asset-manifest.ts` shows only live, as a
white square, a white silhouette or silence: the blood sprite and the powerup shells' textures were
both found that way. Pin each addition with the guarded retail-pak test, as reading all 36 retail
maps confirmed the entity reader.

### Writing an assertion that means something

- **Golden values are measured from the port, then pinned — never computed from a formula and
  asserted.** A prediction of a 45.56u jump apex from `v²/2g` met a measured 48.53u, and the port
  was right. See [`conventions/porting.md`](conventions/porting.md), *Measurement over
  derivation*.
- **When a test disagrees with the port, suspect the expectation first.** Four of the first
  milestone's assertions were wrong rather than the code.
- **Frame counts are arithmetic, not a guess.** `sv_fps` is 125 by default, so the game frame
  (`host.frameMsec`) is 8 ms, the same as `PMOVE_MSEC`. Twenty-three seconds is 2,875 frames, not
  230 — a repro that waited 1.8 s for a 20 s timer looked like a passing test of nothing.
- **Constants that diverge from `bg_pmove.c` need a pinning test and a logged decision.**
- **Hold a port of Q3's float arithmetic to a twin of the C.** Either the function written again
  in numpy's float32 straight from the C, or ioquake3's own functions copied out and compiled, run
  over seeded inputs, every value pinned to the bit. In doubles, 150 to 234
  of the cloud table's 972 values differ. Pick the inputs from the twin, where a break moves a
  value. A shader chunk is held to the same twin on the GPU.
- **Build the twin as the code it stands for is built.** The engine's C is ioquake3's x86-64 gcc
  build, whose `math.h` has a double `M_PI`; MSVC has none unasked, so `q_shared.h` falls back to
  a float and `AngleVectors` turns otherwise, and the twin is built with `/D_USE_MATH_DEFINES`.
The game module's and cgame's C is q3lcc's, so its twin takes float literals and the float
  `M_PI`. A generator copies the functions unchanged, by name, from ioquake3's
  files, each substitution marked.
- **Draw a corpus that reaches what it is for.** Pick from an LCG's high bits: its low bits cycle
  in a few draws, which once tied a corpus's picks together so that no point trace met a patch
  until the sabotage pass showed it. Inputs on a grid a float holds exactly keep every sum exact, so a
  rounding made twice never shows there, and a hand case holds it. Pin each kind as a count
  and a digest of every result's bits, and sweep the install once against the twin, unpinned.
- **A digest must not round what it is handed, and a hand case's answer is the twin's.** A digest
  that stored through `setFloat32` rounded `vectorLength`'s missing last rounding back in, so no
  digest saw it; `Digest.float` now refuses a value that is not already a float. Every hand
  case is run through the twin rather than reasoned: the C corrected one queued case, a trace to
  z 1e-12 being a sweep and not a position test.
- **Write a test's Quake 3 text as Quake 3's files lay it out.** Q3 reads a directive's line to its
  end, a `}` among it, so a shader written on one line runs on into the next, in Q3 and in the
  port. Tests did that four times, and each time the test was wrong.
- **A test that rolls through `Math.random` is not deterministic.** `player-view-prediction.test.ts`
  rolls its 10% packet loss through it, and missed by 10.6 units now and then under the full
  suite's load, passing alone. PlayCanvas draws each entity's guid from `Math.random`,
  so a mock of it is held only for the frame under test: held across an entity's making, it breaks
  the scene's teardown.
- **Vitest hides `console.log`.** To trace a run, write the trace to a file from inside the test.
- **`host.cvars` and friends are private.** Hoist a `let` in the describe's `beforeEach` rather
  than reaching through a private and taking a TS2341.
- **Test the real path.** A default is tested only by a test that sets nothing: one that hands the
  fixture a value never reads the cvar's default or its registration. A parameter the real caller
  never passes hides the gap: `PlayerLife`'s tests passed a gametype `Game` never supplied, so a
  team kill scored +1 in real matches. A fixture whose fallback happens to give the expected answer
  proves nothing, and each golden pins what it is named for: a "rocket start" golden was really the
  muzzle. A claim the research only inferred is confirmed at the source before it is tested.
- **Test at the layer that owns the behaviour.** The host repairs a snapshot's entity number, as
  Quake 3's does, so a test driven through `Host` still passed with the game's own number fix
  sabotaged; that test belongs at the game module. The host owns other things, the restart's
  order and each client's commands among them, so match flow runs through the real `Host`. A
  restart or a map change is tested through to the next move: after one, the client once kept the
  old `sv_serverid` and every move was dropped, and the tests had never moved afterwards.
- **A level's first seconds are not a clean sheet.** Quake 3's clocks start at 0: a first kill in
  the first 3 s is an Excellent (`lastKillTime` starts at 0), a capture in the first 10 s pays
  every team mate two assists, and clients arriving on one spawn spot telefrag each other and
  score. Run the match past about 10 s, and give each test client its own spot (`nohumans`),
  before checking scores or awards. The host runs Quake 3's settle frames, so a match's first frame
  is at 400 ms, and a change to them moves every golden timed from the start: 24 tests' times
  moved, each checked to be theirs. In the first two seconds `G_Spawn` takes a freed
  slot again at once, and the client takes a new event in a slot it saw within an event window for
  the old one, so a temp entity can go unheard: the view's fixtures wait it out (`BOT_SETTLED`).

### Geometry and helpers

**Do not reshape test geometry to make numbers come out round.** Q3 bands a step rise to the
*nearest* of four events (`EV_STEP_4/8/12/16`) by fixed thresholds — `delta < 7 → 4`, `< 11 → 8`,
`< 15 → 12`, else 16 (`bg_slidemove.c` `PM_StepSlideMove`) — **not** by rounding up to the next
multiple of 4. So any rise within ~2 units of a 4-unit band glides away almost exactly, and the
residual on an off-band rise (the test room's 12.8-unit stairs band to 12, an isolated ~0.8-unit
undershoot) is the honest behaviour. Keep the geometry as authored and pin the residual; a
separate 16-unit case covers the canonical stair. *(An earlier reading recorded this as "rounds
up to the next multiple of 4, so only 16-unit stairs cancel" — wrong on both counts; corrected
against ioq3 source, log 2026-07-26.)*

**Trace fixtures fail at their degenerate cases.** Exact surface contact reported as `startsolid`
once made every surface flypaper. Test rooms need headroom to stand up in and pits wider than the
18-unit step height, or the geometry silently tests nothing.

**Author grid dimensions from integer counts, not accumulated floats.** `6 × 12.8` lands at
`76.80000000000001` and claims an extra voxel; a ramp step count computed by division landed at
`48.00000000000001` and built 49 steps.

**Test helpers must reset the state they mutate.** A `stepUp` helper that leaked state between
calls quietly ran each case from atop the previous step.

---

## Proving the tests bite: the sabotage pass

A suite that passes when the code is broken is not protecting anything. Before a change is
committed, break each piece of it in turn and confirm a test fails. This is the standing check
for new behaviour, and it has repeatedly found real holes.

The runner: a Python file listing `(name, path, old, new)` breaks, plus a reusable tail that
checks every pattern, then applies one break at a time, runs the suite, and restores.

```python
"""Break each piece of <the change>, one at a time, and check a test fails."""
import subprocess, sys, time

ROOT = '<absolute path to the repo>'
PL = 'src/sim/player-life.ts'

SABOTAGES_ALL = [
    ('pl: the cvar is ignored', PL, 'const after = this.forceRespawn();',
     'const after = FORCE_RESPAWN;'),
    ('pl: zero forces at once', PL, 'const forced = after > 0 && time - this.client.respawnTime > after;',
     'const forced = time - this.client.respawnTime > after;'),
]


def write(path, text):
    # Windows can hold a file a moment after a test run reads it, so a write is tried again.
    for attempt in range(40):
        try:
            with open(path, 'w', encoding='utf-8', newline='') as f:
                f.write(text)
            return
        except OSError:
            time.sleep(0.5)
    raise OSError(f'could not write {path}')


def run_tests():
    # A break can make a test wait for ever, so a run that outlasts the limit counts as caught.
    # A timeout stops npx alone, whose node workers would hold a pipe open, so they are given none
    # and the whole tree is killed.
    proc = subprocess.Popen(['npx.cmd', 'vitest', 'run', '--dir', 'src'], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        return proc.wait(timeout=600)
    except subprocess.TimeoutExpired:
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)], capture_output=True)
        proc.wait()
        return 'timeout'


args = [a for a in sys.argv[1:] if a != '--check']
only = [line.strip() for line in open(args[0], encoding='utf-8')] if args else []
SABOTAGES = [s for s in SABOTAGES_ALL if not only or s[0] in only]

# Check every pattern first, so a bad one costs nothing.
bad = []
for name, path, old, new in SABOTAGES:
    text = open(f'{ROOT}/{path}', encoding='utf-8', newline='').read()
    if text.count(old) != 1:
        bad.append(f'{name} (pattern x{text.count(old)})')
if bad:
    for b in bad:
        print('BAD:', b)
    sys.exit(2)
if '--check' in sys.argv:
    print(f'{len(SABOTAGES)} patterns ok')
    sys.exit(0)

missed = []
for name, path, old, new in SABOTAGES:
    full = f'{ROOT}/{path}'
    original = open(full, encoding='utf-8', newline='').read()
    write(full, original.replace(old, new))
    try:
        code = run_tests()
    finally:
        write(full, original)
    status = 'MISSED' if code == 0 else 'caught (timed out)' if code == 'timeout' else 'caught'
    print(f'{status}: {name}', flush=True)
    if code == 0:
        missed.append(name)

print(f'{len(SABOTAGES) - len(missed)}/{len(SABOTAGES)} caught')
for name in missed:
    print('  missed:', name)
sys.exit(1 if missed else 0)
```

The rules that make it work:

- **Every break must be caught.** A miss names a test you do not have. Write it, then rerun only
  the missed names by passing a file of them as the argument.
- **Scope each break to the tests over its file**, `vitest related` on it or its module's test
  files: seconds a break, where the full suite costs about 50 s. A call only `App.ts` makes is the
  live check's to see.
- **A break no input can show is equivalent, not a miss: prove it, and record it.** `t − 1/32` in
  doubles is exact for each of the floats it can meet, so no test of it can fail; write none.
- **Run `--check` first.** It verifies each `old` appears exactly once and exits, so a typo in a
  pattern costs seconds rather than the whole pass.
- **Read and write with `newline=''` and explicit UTF-8.** Some sources are CRLF; a rewrite that
  normalises line endings sabotages the entire file and every test fails for the wrong reason.
- **Restore in a `finally`.** A crashed run must not leave broken source behind.
- **Bound every wait.** A test that waits for a condition, such as a landing, gives up after a
  limit and throws, and each run has a timeout. Two tests once waited for a fall with no bound, and
  a break that left gravity at nothing hung the pass rather than failing it.
- **Kill the whole tree on a timeout.** On Windows a timeout stops `npx` alone, and its node
  workers hold the pipes open, so the pass hangs, as it did on a break that split a patch column
  for ever. The runner kills the tree with `taskkill /T` at its limit, and counts the run as
  caught. A runner stopped from outside leaves its break in the source: restore it before anything
  else runs.
- **Break behaviour, not syntax.** Swap a constant, drop a guard, invert a comparison, delete a
  call — each break should be something a careless edit could plausibly do.
- **Write the script with a file tool, not a heredoc.** Python and Node heredocs lose
  backslashes here, and a long one arrives truncated. Keep the tail in its own file and
  concatenate a per-change head onto it.

### The blind spots it keeps finding

- **An input where right and wrong agree.** The most common reason a break goes uncaught: a 4:3
  screen where both anchors land on the same x, a camera looking straight down −Z, a value of 0, a
  player standing still, two players where an order only shows with three, a guard an earlier rule
  already stops. Pick an input the break would change.
- **A constant asserted against its own import.** `expect(DELAY_STEP).toBe(DELAY_STEP)` passes
  whatever the value is. Assert the literal: `expect(DELAY_STEP).toBe(1500)`. This has been
  missed twice.
- **A branch the UI can never reach.** Menu paging guards were never exercised because the menu
  skips greyed items, so no test could reach them through the UI. Call the guard directly.
- **A break a corpus misses is searched for, not argued.** Run the port with and without the break
  over a large set, seeded or the install's own, and pin the first input it moves with the twin's
  answer: eight traces on `pro-q3dm13`'s patches, the first of 20,000 seeded patches to reach each
  branch, two turned boxes and a curve's axes, and the inputs where floats and doubles part for the
  mixer, the WAV reader and the music. What no search reaches is
  argued, and recorded as argued rather than proved.

---

## Typecheck, and the one thing never to run

```bash
npm run typecheck
```

Covers the page, the shell's main process and the master's Worker (`tsc --noEmit` three times).
Run it with the suite; a change is not green without both.

**Never run a formatter on this repo.** There is no Prettier config and no Prettier dependency,
so `npx prettier --write` applies Prettier's own defaults — double quotes, trailing commas — and
rewrites whole files against the house style. `--check` is no safer: its output gets summarised
and reads like a pass. Match the formatting of the file you are editing, by hand.

---

## What only a person can accept

Some accepts are a sentence about feel, and no script settles them: whether a weapon reads right
in the hand, whether a respawn is annoying, whether a menu is where the hand expects it. Those go
to a playtest, and the finding comes back as prose.

Prepare for one rather than lean on it:

- Run the scripted check first and record what it measured, so the playtest is about feel and not
  about whether the thing works at all.
- Never hang an accept on manual work that is new to the player. Offer a scripted substitute
  built from data already there.
- A report from a playtest is a symptom, not a diagnosis. "The bot stops respawning after two
  deaths" turned out to be five successful respawns landing at the spawn spots furthest from the
  death — Quake 3's own rule, working exactly as written. Reproduce the report headlessly before
  changing anything.

### When a pak does not offer what the check needs

**The override pak adds anything the game reads from the paks that a pak did not ship.** Items,
movers, spawn points, a shader, a texture — a check that wants any of them should not edit the map
pak. `public/maps/*.pk3` mount in ioq3's order, and within an order the last name wins —
`zz-mod.pk3` over `pak8` over `pak0` (`mount.ts:101`) — so a small `zz-*.pk3` beside the map pak
adds a file, or takes one by path: read the original out of the map pak, change it, write it back
under the same path, and the game reads your version. Delete the override and the map is as it
shipped. The port's map paks sit at the bottom of the search path, so an override wins against
them, not against the retail install's paks. It serves a scripted live check the same way it serves
a playtest.

It is a **debugging measure, not a home.** The override is how a new feature or enhancement is
tried while it is still moving; once it is settled, the content belongs in the pak that ships it —
the map's own, as its pipeline builds it, or the install — so a player gets it with no `zz-*`
beside the map.

A splat map's world content lives in its entity text, `maps/<map>.ent`, and the port's own map
ships spawn points and nothing else, so that file is the one to append to: items, a mover, a spawn
point of your own.
(A bot is not a pak file — `addbot` adds it.) The pattern is
[`scripts/items-pak.mjs`](../scripts/items-pak.mjs), written for the items' playtest: it
reads `maps/garage_rats.ent`, appends a ring of 21 items around the centre spawn, writes
`public/maps/zz-items.pk3`, then boots the match and reads every item back — where it stands,
whether it is in the world, whether the client draws it. Two things it paid for:

- **Place against the floor, not a guessed height.** Drops are measured with
  [`scripts/items-probe.mjs`](../scripts/items-probe.mjs): an item's own box
  (radius 15, the box `finishSpawningItem` traces) at a ring of points, reporting where each comes
  to rest, whether it began in solid (an item there is freed, not placed) and how flat the
  surface is.
- **Some entities wait.** The six powerups first appear at `45 + crandom() * 15` s
  (`g_items.c:704`), so a read-back taken at once sees 15 of 21 and has to force the rest.
  Whatever you add, check whether the game delays or hides it before judging a read-back.

**A BSP map's entities are its own lump's.** A `.ent` in an override serves a splat map alone, so a
check that adds to a BSP map puts a copy of its `.bsp`, the entity lump rewritten, in the override,
as the capture moves an intermission point. An install map's override goes in a
throwaway `PCQ_FS_BASEPATH` that links the install's paks beside the `zz-*.pk3`, since the port's
own map paks sit below them in the search path.

The pak is gitignored with the rest of `public/maps/`; regenerate it when the map's entity text
changes, and tell a playtest which pak is loaded.
