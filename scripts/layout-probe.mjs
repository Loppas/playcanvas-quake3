#!/usr/bin/env node
/**
 * The layout probe: every page of the menus measured against `.claude/conventions/menus.md`'s
 * rules, in a headless Chromium, at 16:9 and 4:3. A report names one page, and the same defect
 * stands on others, so the probe visits them all: the main tree, the server browser through its
 * states, the Server Information box, the in-game menu as a remote server's player and as the
 * host, the connect screen as a map loads, and the error screen.
 *
 * For each view it writes what menus.md asks to be measured: each bar's margin round its text, by
 * the elements' boxes and by the ink in a screenshot; each panel's padding round what it holds;
 * everything that crosses the panel's edge or the screen's, or overlaps another bar; and, across
 * the states of one page, anything that moved. It reads the page's internals (`window.pcqMenu`,
 * the renderer's entity names), so a rename there shows here as a run that stops or finds nothing.
 *
 * It needs an install the dev server can read, as the game does. It starts its own dev server and
 * master on free ports, with a home folder of its own, so it touches neither yours. Tab A hosts
 * garage_rats under a long coloured name with three bots, and tab B visits.
 *
 * Usage:
 *   npm run probe:layout
 *   npm run probe:layout -- --out <dir> --wide-only
 *
 * It writes `report.txt`, `result.json` and a screenshot of each view, under the OS's temp folder
 * unless `--out` says where, and prints the report.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  boxesOf,
  checkView,
  connectMoves,
  findings,
  inkInPage,
  inkMargins,
  inkSearch,
  measurePage,
  report,
  shifts
} from './layout-probe-lib.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WIDE = { width: 1280, height: 720 };
const SQUARE = { width: 960, height: 720 };
/** The map tab A hosts. */
const MAP = 'garage_rats';

/** q3's key numbers the probe presses. */
const K = { BACKSPACE: 127, DOWNARROW: 133, RIGHTARROW: 135, END: 144, MOUSE1: 178 };

/**
 * The main tree's pages, each by the labels pressed from the main menu to reach it. A label not on
 * the page, or one that opens nothing, is reported and its page skipped.
 */
const MAIN_TREE = [
  ['main', []],
  ['single', ['SINGLE PLAYER']],
  ['single-options', ['SINGLE PLAYER', 'NEXT']],
  ['single-botselect', ['SINGLE PLAYER', 'NEXT', { place: 'name 1' }]],
  ['debug', ['DEBUG']],
  ['exit', ['EXIT']]
];

/** Setup's pages, from Setup, which the main menu and the in-game menu share. */
const SETUP = [
  ['page', []],
  ['player', ['PLAYER']],
  ['model', ['PLAYER', 'MODEL']],
  ['controls-look', ['CONTROLS']],
  ['controls-move', ['CONTROLS', 'MOVE']],
  ['controls-shoot', ['CONTROLS', 'SHOOT']],
  ['controls-misc', ['CONTROLS', 'MISC']],
  ['system-graphics', ['SYSTEM']],
  ['system-display', ['SYSTEM', 'DISPLAY']],
  ['system-sound', ['SYSTEM', 'SOUND']],
  ['system-network', ['SYSTEM', 'NETWORK']],
  ['options', ['GAME OPTIONS']],
  ['gamedata', ['GAME DATA']],
  ['defaults', ['DEFAULTS']]
];

/** The in-game menu's pages for a remote server's player, and for the host. */
const REMOTE = [
  ['ingame', []],
  ['team', ['START']],
  ['serverinfo', ['SERVER INFO']],
  ['exit', ['EXIT GAME']]
];
const HOST = [
  ['ingame', []],
  ['addbots', ['ADD BOTS']],
  ['removebots', ['REMOVE BOTS']],
  ['serverinfo', ['SERVER INFO']],
  ['serveroptions', ['SERVER OPTIONS']],
  ['debug', ['DEBUG']],
  ['restart', ['RESTART ARENA']]
];

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run probe:layout -- [--out <dir>] [--wide-only]');
  process.exit(0);
}
const outAt = args.indexOf('--out');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = outAt >= 0 ? resolve(args[outAt + 1]) : join(tmpdir(), 'pcq-layout-probe', stamp);
const wideOnly = args.includes('--wide-only');

function freePort() {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.on('error', fail);
    probe.listen(0, 'localhost', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, ms, what) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
    await wait(100);
  }
}

mkdirSync(OUT, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'pcq-probe-home-'));
process.env.PCQ_FS_HOMEPATH = home;

const result = {
  out: OUT,
  views: [],
  shifts: [],
  connect: [],
  skipped: [],
  problems: [],
  error: null
};
const boxes = {};
const started = Date.now();
const say = (line) => console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${line}`);

const { createServer } = await import('vite');
const { chromium } = await import('playwright');
const { default: nodeDataChannel } = await import('node-datachannel');
const { RTCPeerConnection } = await import('node-datachannel/polyfill');

const port = await freePort();
const masterPort = await freePort();
const server = await createServer({
  root: REPO_ROOT,
  logLevel: 'warn',
  clearScreen: false,
  server: { host: 'localhost', port, strictPort: true, forwardConsole: false }
});
await server.listen();
const { startMaster } = await server.ssrLoadModule('/master/node-master.ts');
const masterLines = [];
let master = null;
let loop = null;
let browser = null;

try {
  master = await startMaster({
    createPeerConnection: (iceServers) => new RTCPeerConnection({ iceServers }),
    iceServers: [],
    print: (line) => masterLines.push(line),
    port: masterPort
  });
  loop = setInterval(() => master.frame(), 50);
  // Both slots at the probe's own master, the Internet's and the LAN's, so none reaches for yours.
  const at = encodeURIComponent(`ws://localhost:${masterPort}`);
  const query = `sv_master1=${at}&sv_master2=${at}`;

  browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext({ viewport: WIDE });
  context.on('response', (r) => {
    if (r.status() >= 400) result.problems.push(`http ${r.status()}: ${r.url()}`);
  });
  const open = async (name, url) => {
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        result.problems.push(`${name} ${m.type()}: ${m.text()}`);
      }
    });
    page.on('pageerror', (e) => result.problems.push(`${name} pageerror: ${e.message}`));
    await page.goto(url);
    return page;
  };
  const playing = (page) => page.evaluate(() => window.pcqController?.game.connection?.state === 8);

  /** Press an item of the page shown, by its label or `{ place }`; say whether a page opened. */
  const press = (page, which, key = K.MOUSE1) =>
    page.evaluate(
      ([w, k]) => {
        const { menu } = window.pcqMenu;
        const before = menu.page;
        const index = menu.page.items.findIndex((item) =>
          typeof w === 'string' ? item.label === w : item.place === w.place
        );
        if (index < 0) return 'missing';
        menu.hover(index, { x: 0.5 });
        menu.key(k);
        return menu.page !== before ? 'opened' : 'stayed';
      },
      [which, key]
    );
  const typeInto = (page, label, text) =>
    page.evaluate(
      ([l, t, end, backspace]) => {
        const { menu } = window.pcqMenu;
        const index = menu.page.items.findIndex((item) => item.label === l);
        if (index < 0) return false;
        menu.select(index);
        menu.key(end);
        for (let n = 0; n < 90; n++) menu.key(backspace);
        for (const ch of t) menu.char(ch);
        return true;
      },
      [label, text, K.END, K.BACKSPACE]
    );
  const toMain = (page) =>
    page.evaluate(() => {
      const { menu } = window.pcqMenu;
      while (menu.page && menu.page.id !== 'main') menu.pop();
    });
  const inGame = (page) =>
    page.evaluate(() => {
      window.pcqMenu.menu.forceOff();
      window.pcqMenu.open();
    });
  const refreshed = (page) =>
    until(
      () => page.evaluate(() => window.pcqMenu.menu.page?.status === ''),
      30000,
      'the refresh over'
    );

  /** One view measured: its rules checked, its ink read from its screenshot, its boxes kept. */
  async function measured(page, name, suffix) {
    const view = await page.evaluate(measurePage);
    const png = await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`) });
    const texts = view.shown.filter((s) => s.isText);
    const search = texts.map((s) => inkSearch(s, view.unit));
    const inks = await page.evaluate(inkInPage, [png.toString('base64'), search]);
    const check = checkView(view);
    const ink = inkMargins(view, inks);
    return {
      boxes: boxesOf(view),
      record: {
        name,
        page: view.page,
        placement: view.placement,
        popup: view.popup,
        viewport: view.viewport,
        cursor: view.cursor,
        frame: view.frame,
        ...check,
        ink,
        findings: findings(view, check, ink)
      }
    };
  }
  /** A view at 16:9, then at 4:3 unless asked not to. */
  async function view(page, name, { square = !wideOnly } = {}) {
    await wait(150);
    const wide = await measured(page, name, '16x9');
    boxes[name] = wide.boxes;
    result.views.push(wide.record);
    if (!square) return;
    await page.setViewportSize(SQUARE);
    await wait(400);
    result.views.push((await measured(page, name, '4x3')).record);
    await page.setViewportSize(WIDE);
    await wait(400);
  }
  const moved = (from, to) =>
    result.shifts.push({ from, to, moved: shifts(boxes[from], boxes[to]) });

  /** Pages, each reached from `start` by its labels; one not reached is said, not measured. */
  async function tour(page, prefix, pages, start) {
    for (const [name, path] of pages) {
      await start();
      let reached = true;
      for (const which of path) {
        const pressed = await press(page, which);
        if (pressed !== 'opened') {
          result.skipped.push(`${prefix}${name}: ${JSON.stringify(which)} ${pressed}`);
          reached = false;
          break;
        }
        await wait(150);
      }
      if (reached) await view(page, `${prefix}${name}`);
    }
  }

  // Tab A hosts, listed, under a name longer than the list's column, with three bots for the board.
  const registered = () => masterLines.filter((l) => / registered as /.test(l)).length;
  const a = await open('A', `http://localhost:${port}/?map=${MAP}&${query}`);
  await a.waitForFunction(() => Boolean(window.pcq?.app && window.pcqController), null, {
    timeout: 240000
  });
  await until(() => registered() > 0, 30000, 'A registered with the master');
  await until(() => playing(a), 60000, 'A playing');
  await a.evaluate(() =>
    window.pcqConsole(
      'set dedicated 2; set sv_hostname "^1A Very ^2Long ^3Server ^7Name For The Probe"; ' +
        'addbot sarge 3; addbot visor 3; addbot anarki 3'
    )
  );
  await wait(4000);

  const b = await open('B', `http://localhost:${port}/?${query}`);
  await b.waitForFunction(
    () => Boolean(window.pcq?.app && window.pcqMenu?.menu.page?.id === 'main'),
    null,
    { timeout: 240000 }
  );
  await b.bringToFront();
  await wait(1500);
  say('the main tree');
  await tour(b, '', MAIN_TREE, () => toMain(b));
  await tour(b, 'setup-', SETUP, async () => {
    await toMain(b);
    await press(b, 'SETUP');
  });
  await toMain(b);
  await press(b, 'SETUP');
  await press(b, 'PLAYER');
  await typeInto(b, 'Name', 'WWWWWWWWWWWWWWWWWWWW');
  await view(b, 'setup-player-long', { square: false });
  moved('setup-player', 'setup-player-long');

  say('the server browser');
  await toMain(b);
  await press(b, 'MULTIPLAYER');
  await view(b, 'servers-refreshing', { square: false });
  await refreshed(b);
  await view(b, 'servers-listed', { square: false });
  await wait(3500);
  await view(b, 'servers-answered');
  moved('servers-refreshing', 'servers-listed');
  moved('servers-listed', 'servers-answered');
  await press(b, 'SERVER INFO');
  await wait(1000);
  await view(b, 'serverinfo-box');
  await press(b, 'REFRESH');
  await wait(1000);
  await view(b, 'serverinfo-refreshed', { square: false });
  moved('serverinfo-box', 'serverinfo-refreshed');
  await press(b, 'CLOSE');
  await wait(300);
  await view(b, 'servers-closed', { square: false });
  moved('servers-answered', 'servers-closed');

  await press(b, 'SPECIFY');
  await wait(300);
  await view(b, 'specify-empty');
  await typeInto(b, 'Address', '203.0.113.99');
  await typeInto(b, 'Name', 'A Favourite Named At Its Longest');
  await view(b, 'specify-filled', { square: false });
  await typeInto(b, 'Address', 'A.NAME.LONG.ENOUGH.TO.SCROLL.ITS.FIELD.WWWWWWWWWW.EXAMPLE.ORG');
  await view(b, 'specify-scrolled', { square: false });
  moved('specify-empty', 'specify-filled');
  moved('specify-empty', 'specify-scrolled');
  await typeInto(b, 'Address', '203.0.113.99');
  await press(b, 'ADD TO FAVORITES');
  await b.evaluate(() => window.pcqMenu.menu.pop());
  await wait(300);
  await press(b, 'Servers', K.RIGHTARROW);
  await view(b, 'favorites-standing', { square: false });
  await refreshed(b);
  await view(b, 'favorites');
  await b.evaluate((down) => {
    const { menu } = window.pcqMenu;
    menu.select(menu.page.items.findIndex((item) => item.list));
    menu.key(down);
  }, K.DOWNARROW);
  await view(b, 'favorites-dead-chosen', { square: false });
  await press(b, 'Servers', K.RIGHTARROW);
  await refreshed(b);
  await view(b, 'local');
  moved('servers-answered', 'favorites-standing');
  moved('favorites-standing', 'favorites');
  moved('favorites', 'favorites-dead-chosen');
  moved('servers-answered', 'local');

  say('CREATE');
  await press(b, 'CREATE');
  await wait(500);
  await view(b, 'create');
  await press(b, 'NEXT');
  await wait(300);
  await view(b, 'create-options');
  await typeInto(b, 'Hostname', 'THE WIDEST HOSTNAME WE COULD TYPE WWWWWWWWWWWWWWWWWWWWWWWW');
  await typeInto(b, 'Time limit', '999');
  await view(b, 'create-options-long', { square: false });
  moved('create-options', 'create-options-long');
  await b.evaluate(() => window.pcqMenu.menu.pop());
  for (let n = 0; n < 6; n++) {
    const type = await b.evaluate(
      () => window.pcqMenu.menu.page.items.find((item) => item.label === 'Game type')?.value
    );
    if (type === 'Team Deathmatch') break;
    await press(b, 'Game type', K.RIGHTARROW);
  }
  await press(b, 'NEXT');
  await wait(300);
  await view(b, 'create-options-team');

  say('the connect screen, and the in-game menu on a remote server');
  await toMain(b);
  const address = masterLines.filter((l) => / registered as /.test(l))[0].split(' ').at(-1);
  const samples = [];
  const sampling = { on: true };
  const sampler = (async () => {
    while (sampling.on) {
      const sample = await b
        .evaluate(() => {
          const panel = document.querySelector('.load-screen .load-panel');
          if (!panel) return null;
          const box = (e) => {
            const r = e.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height].map(Math.round);
          };
          const parts = [...panel.children].map((part) => ({
            name: part.className,
            box: box(part)
          }));
          return { panel: box(panel), parts };
        })
        .catch(() => null);
      if (sample) samples.push(sample);
      await wait(30);
    }
  })();
  await b.evaluate((adr) => window.pcqConsole(`connect ${adr}`), address);
  await until(() => playing(b), 60000, 'B on A');
  await wait(1000);
  sampling.on = false;
  await sampler;
  result.connect = connectMoves(samples);
  say(`the connect screen sampled ${samples.length} times`);

  await tour(b, 'remote-', REMOTE, () => inGame(b));
  await tour(b, 'remote-setup-', SETUP, async () => {
    await inGame(b);
    await press(b, 'SETUP');
  });
  await b.evaluate(() => window.pcqMenu.menu.forceOff());

  say("the host's in-game menu");
  await a.bringToFront();
  await wait(500);
  await tour(a, 'host-', HOST, () => inGame(a));
  await a.evaluate(() => window.pcqMenu.menu.forceOff());

  say('the error screen');
  const client = await b.evaluate(() => window.pcqController?.game.connection?.clientNum ?? null);
  await a.evaluate((n) => window.pcqConsole(`clientkick ${n}`), client);
  await b.bringToFront();
  await until(
    () => b.evaluate(() => window.pcqMenu.menu.page?.id === 'error'),
    20000,
    'the error screen'
  );
  await wait(500);
  await view(b, 'error');
} catch (error) {
  result.error = String(error?.stack ?? error);
} finally {
  if (loop) clearInterval(loop);
  master?.close();
  // The engine's own warnings, and Chromium's request for a favicon, which logs a 404 with no URL:
  // a 404 that matters comes through the responses, with its URL.
  const noise = /favicon|powerPreference|stencil|Emissive|pak: skipped|Failed to load resource/;
  result.problems = result.problems.filter((line) => !noise.test(line));
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  const text = report(result);
  writeFileSync(join(OUT, 'report.txt'), `${text}\n`);
  console.log(text);
  await browser?.close();
  await server.close();
  nodeDataChannel.cleanup();
  rmSync(home, { recursive: true, force: true });
}
process.exit(result.error ? 1 : 0);
