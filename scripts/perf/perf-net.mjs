// The latency baseline, on one machine, the profiler build, the display at 240 Hz.
//
//     node scripts/perf/perf-net.mjs [out]
//
// **A listen server.** Tab A hosts garage_rats with three bots. The worker's waits are timed by
// wrapping its setTimeout from outside; the tab's frame log gives the snapshots it reads and how
// far its view runs past the newest (the lagometer's offset); then the main thread is blocked for
// 150, 300 and 600 ms, and the offset is followed back.
//
// **A dedicated server.** A master and the port's dedicated server run in this process, as
// `npm run dedicated` runs it, set Internet (`sv_lanForceRate 0`), with three bots; tab B joins
// it through the master, `cl_lanForcePackets 0`, so both sides keep the Internet's rules. The
// bots stand still on this map, so tab C joins too, at 60 Hz, and walks in circles firing the
// plasma gun: the snapshots carry a moving player and a stream of missiles, as a match's do.
// Rounds of tab B's `snaps`, `cl_maxpackets` and `rate`, each measured from both ends:
// - the server loop's wakes;
// - each packet the server sends tab B: its size, and whether `rate` held a snapshot back;
// - the same packet at tab B, matched by its sequence number: when it arrived and when the frame
//   read it;
// - tab B's packets as the server receives them;
// - tab B's frame log.
// Then the blocks again, on tab B.
//
// Never on port 5173, 27950 or 27960: the master, the server's UDP port and Vite each take a free
// one. A throwaway fs_homepath. Writes result.json and the frame logs under logs/.
import { createSocket } from 'node:dgram';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { compact, rounded, slice, stats, summarise } from './perf-analyse.mjs';
import {
  bootMatch,
  freePort,
  installPageHarness,
  KNOWN_NOISE,
  launchChrome,
  REPO,
  remove,
  run,
  startVite,
  throwawayHome
} from './perf-lib.mjs';

const OUT = process.argv[2] ?? join(tmpdir(), 'pcq-perf-net');
const MAP = 'garage_rats';
const RATE = 240;
const BOTS = ['grunt', 'xaero', 'sarge'];
const BLOCKS = [150, 300, 600];
const ROUND_MS = 12000;
/** The rounds: id's defaults first, then the cycle's choices one at a time. */
const ROUNDS = [
  { snaps: 20, maxpackets: 30, rate: 25000 },
  { snaps: 125, maxpackets: 30, rate: 25000 },
  { snaps: 125, maxpackets: 125, rate: 25000 },
  { snaps: 125, maxpackets: 125, rate: 90000 }
];

const require = createRequire(`${REPO}/package.json`);
const { baseq3Dir } = await import(pathToFileURL(`${REPO}/scripts/fs-basepath.mjs`).href);
const nodeDataChannel = require('node-datachannel');
const { RTCPeerConnection } = require('node-datachannel/polyfill');

remove(OUT);
mkdirSync(join(OUT, 'logs'), { recursive: true });
const result = { problems: [], console: [], listen: {}, dedicated: { rounds: {} } };
const started = Date.now();
const save = () => writeFileSync(join(OUT, 'result.json'), JSON.stringify(rounded(result), null, 2));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const epoch = () => performance.timeOrigin + performance.now();

/** A UDP port nobody holds, away from Quake 3's own. */
function freeUdpPort() {
  return new Promise((done) => {
    const port = 28000 + Math.floor(Math.random() * 1000);
    const probe = createSocket('udp4');
    probe.once('error', () => done(freeUdpPort()));
    probe.bind(port, () => probe.close(() => done(port)));
  });
}

const masterPort = await freePort();
const MASTER_SLOT = `127.0.0.1:${masterPort}`;
// Both tabs reach the run's own master through both slots: a server on this machine is a LAN
// server, which a client reaches through the LAN's slot. And both keep the Internet's packet rules
// on localhost.
const home = throwawayHome(
  `seta sv_master1 "${MASTER_SLOT}"\nseta sv_master2 "${MASTER_SLOT}"\nseta cl_lanForcePackets 0\n`
);
const { server, port } = await startVite('profiler');
const load = (path) => server.ssrLoadModule(path);
const { startMaster } = await load('/master/node-master.ts');
const { startDedicatedServer } = await load('/src/server/dedicated.ts');
const { nodeServerNetwork } = await load('/src/server/node-network.ts');
const { mountArchives } = await load('/src/pak/mount.ts');
const { nodeFileSource } = await load('/src/pak/node-source.ts');
const { searchPath } = await load('/src/pak/vfs.ts');
const { GameConfig } = await load('/src/settings/game-config.ts');
const { diskHome } = await load('/src/settings/disk-home.ts');

let master = null;
/** The master's lines, which name each address it hands out. */
const masterLines = [];
let masterLoop = null;
let dedicated = null;
let dedicatedTimer = null;
const contexts = [];

/** A tab on its own profile, its console and errors kept. */
async function tab(name) {
  const context = await launchChrome(join(tmpdir(), 'pcq-perf-profiles', `net-${name}`));
  contexts.push(context);
  await installPageHarness(context, { rate: RATE });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => {
    const text = m.text();
    if (result.console.length < 400) {
      result.console.push(`${((Date.now() - started) / 1000).toFixed(2)} ${name} ${m.type()}: ${text.slice(0, 200)}`);
    }
    if ((m.type() === 'error' || m.type() === 'warning') && !KNOWN_NOISE.test(text)) {
      result.problems.push(`${name} ${m.type()}: ${text}`);
    }
  });
  page.on('pageerror', (e) => result.problems.push(`${name} pageerror: ${e.message}`));
  return page;
}

/** Records the frame log while `body` runs, and hands it back. */
async function record(page, body) {
  await page.evaluate(() => {
    window.__perf.record();
    window.__perf.mark('begin');
  });
  await body();
  return page.evaluate(() => window.__perf.take());
}

/**
 * Blocks the page's main thread for each of `BLOCKS` ms, and follows the view's offset from the
 * newest snapshot back: its usual value over the second before, the furthest it went, and how
 * long until it stayed within 10 ms of the usual for half a second. The offset wanders by about
 * 6 ms either way unblocked, which a tighter test would never see settle.
 */
async function blocks(page, label) {
  const out = {};
  for (const ms of BLOCKS) {
    const log = await record(page, async () => {
      await page.waitForTimeout(2000);
      await page.evaluate(() => window.__perf.mark('block'));
      await page.evaluate((h) => {
        const t = performance.now();
        while (performance.now() - t < h);
      }, ms);
      await page.waitForTimeout(8000);
    });
    writeFileSync(join(OUT, 'logs', `${label} block ${ms}.json`), JSON.stringify(compact(log)));
    const { tick, lag } = log.columns;
    const at = log.marks.find((m) => m.name === 'block').row;
    const usual = stats(lag.slice(Math.max(0, at - RATE), at)).p50;
    const after = [];
    for (let i = at; i < log.rows; i++) after.push({ t: tick[i] - tick[at], lag: lag[i] });
    let settled = null;
    for (let i = 0; i < after.length; i++) {
      const rest = after.slice(i).filter((s) => s.t <= after[i].t + 500);
      if (after[i].t + 500 > after[after.length - 1].t) break;
      if (rest.every((s) => Math.abs(s.lag - usual) <= 10)) {
        settled = after[i].t;
        break;
      }
    }
    const worst = after.reduce((w, s) => (Math.abs(s.lag - usual) > Math.abs(w.lag - usual) ? s : w), after[0]);
    out[ms] = {
      usualLag: usual,
      worstLag: worst.lag,
      worstAt: worst.t,
      settledAfterMs: settled,
      // The offset every quarter second after the block.
      trail: after.filter((s, i) => i === 0 || Math.floor(s.t / 250) !== Math.floor(after[i - 1].t / 250)).map((s) => [s.t, s.lag]),
      frame: summarise(slice(log, at, log.rows), RATE).dt
    };
  }
  return out;
}

const cleanup = async () => {
  for (const context of contexts) await context.close().catch(() => {});
  clearTimeout(dedicatedTimer);
  try {
    dedicated?.stop('Server quit');
  } catch {}
  clearInterval(masterLoop);
  try {
    master?.close();
  } catch {}
  await Promise.race([server.close(), sleep(15000)]).catch(() => {});
  try {
    nodeDataChannel.cleanup();
  } catch {}
  remove(home);
};
const watchdog = setTimeout(async () => {
  result.error = 'watchdog: the run took over 15 minutes';
  save();
  await cleanup();
  process.exit(3);
}, 15 * 60 * 1000);

try {
  master = await startMaster({
    createPeerConnection: (iceServers) => new RTCPeerConnection({ iceServers }),
    iceServers: [],
    print: (line) => masterLines.push(line),
    port: masterPort
  });
  masterLoop = setInterval(() => master.frame(), 50);

  // --- A listen server -----------------------------------------------------------------------
  {
    const page = await tab('a');
    await bootMatch(page, port, MAP);
    await run(page, 'pcq_god 1');
    for (const bot of BOTS) {
      await run(page, `addbot ${bot}`);
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(8000);
    const worker = page.workers().find((w) => /server\/worker/.test(w.url()));
    if (!worker) throw new Error('no server worker');
    // Each wait the server loop asks for, and when it came back.
    await worker.evaluate(() => {
      const set = self.setTimeout;
      self.__waits = [];
      self.setTimeout = function (callback, ms, ...rest) {
        const asked = performance.now();
        return set.call(self, () => {
          if (self.__waits.length < 20000) self.__waits.push([asked, ms, performance.now()]);
          callback();
        }, ms, ...rest);
      };
    });
    const log = await record(page, () => page.waitForTimeout(10000));
    writeFileSync(join(OUT, 'logs', 'listen.json'), JSON.stringify(compact(log)));
    const waits = await worker.evaluate(() => self.__waits.splice(0));
    const frames = waits.filter((w) => w[1] === 8);
    result.listen.workerWake = {
      interval: stats(frames.slice(1).map((w, i) => w[2] - frames[i][2])),
      late: stats(frames.map((w) => w[2] - w[0] - w[1]))
    };
    result.listen.frames = summarise(log, RATE);
    result.listen.blocks = await blocks(page, 'listen');
    save();
    await contexts.pop().close();
  }

  // --- A dedicated server --------------------------------------------------------------------
  // The search path src/dedicated.ts builds: the port's maps under the install's baseq3, whose
  // scripts/bots.txt the bots come from.
  const paksIn = (folder) =>
    readdirSync(folder)
      .filter((name) => /\.pk3$/i.test(name))
      .sort()
      .map((name) => nodeFileSource(join(folder, name), name));
  const fs = searchPath([
    await mountArchives(paksIn(join(REPO, 'public', 'maps')), { onSkip: () => {} }),
    await mountArchives(paksIn(baseq3Dir(REPO, 'development')), { onSkip: () => {} })
  ]);
  const printed = [];
  const print = (text) => {
    if (printed.length < 2000) printed.push(text.replace(/\n$/, ''));
  };
  const udpPort = await freeUdpPort();
  const linesBefore = masterLines.length;
  dedicated = await startDedicatedServer({
    config: new GameConfig({ debugMode: true }),
    fs,
    home: diskHome(home),
    print,
    argv: [
      '+set', 'dedicated', '2',
      '+set', 'sv_master1', MASTER_SLOT,
      '+set', 'sv_master2', '',
      '+set', 'net_port', String(udpPort),
      '+set', 'sv_lanForceRate', '0',
      '+set', 'pcq_spawnWeapons', '1',
      '+map', MAP
    ],
    debugMode: true,
    network: (cvars) => nodeServerNetwork(cvars, print),
    onError: (err) => result.problems.push(`dedicated: ${err.stack}`)
  });
  // The loop `src/dedicated.ts` runs, each wake kept.
  const wakes = [];
  let last = performance.now();
  const frameLoop = () => {
    dedicatedTimer = setTimeout(() => {
      if (dedicated.stopped) return;
      const now = performance.now();
      if (wakes.length < 50000) wakes.push(now);
      dedicated.frame(now - last);
      last = now;
      frameLoop();
    }, dedicated.frameMsec);
  };
  frameLoop();
  // The address the master hands the server is the one tab B connects to: the first registration
  // since the server started, as tab A's own went before.
  const serverAddress = await (async () => {
    for (let i = 0; i < 600; i++) {
      for (const line of masterLines.slice(linesBefore)) {
        const m = /registered as (\S+)$/.exec(line);
        if (m) return m[1];
      }
      await sleep(100);
    }
    throw new Error('the dedicated server never registered');
  })();
  result.dedicated.address = serverAddress;
  result.dedicated.printed = printed.slice(0, 40);
  // The master hears from the server before its map is in, and a command run during the load is
  // lost: the bots go in once the map is running, and are waited for.
  for (let i = 0; i < 300 && !(dedicated.program.svRunning && dedicated.program.host.loading === null); i++) {
    await sleep(100);
  }
  await sleep(1000);
  for (const bot of BOTS) dedicated.consoleLine(`addbot ${bot}`);
  dedicated.consoleLine('pcq_god 1');
  const bots = () => dedicated.program.host.clients.filter((c) => c.state !== 0).length;
  for (let i = 0; i < 100 && bots() < BOTS.length; i++) await sleep(100);
  result.dedicated.bots = bots();

  // What the server sends and hears, and whether `rate` held tab B's snapshots back.
  const { host } = dedicated.program;
  const socket = host.net.socket;
  let sent = [];
  let heard = [];
  let snapshotTurns = { sent: 0, delayed: 0 };
  const seq = (d) => d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24);
  const key = (adr) => `${adr.type}:${adr.ip}:${adr.port}`;
  const send = socket.send.bind(socket);
  socket.send = (data, to) => {
    sent.push([epoch(), data.byteLength, seq(data), key(to)]);
    return send(data, to);
  };
  const receive = socket.receive.bind(socket);
  socket.receive = () => {
    const packet = receive();
    if (packet) heard.push([epoch(), packet.data.byteLength, key(packet.from)]);
    return packet;
  };
  /** A human's address on the server, by the name they play under. */
  const addressOf = (name) => {
    const named = (c) => /\\name\\([^\\]*)/.exec(c.userinfo ?? '')?.[1];
    const n = host.clients.findIndex((c) => c.state >= 2 && named(c) === name);
    return n < 0 ? null : key(host.clients[n].netchan.remoteAddress);
  };
  const sendClientMessages = host.sendClientMessages.bind(host);
  // A human's snapshot turn: sent, or held back. `CS.FREE` is 0 and `SVF.BOT` 8.
  host.sendClientMessages = () => {
    const due = host.clients.map((c) => c.state !== 0 && host.svsTime - c.lastSnapshotTime >= c.snapshotMsec);
    sendClientMessages();
    host.clients.forEach((client, n) => {
      if (!due[n] || (client.gentity && (client.gentity.r.svFlags & 8) !== 0)) return;
      if (client.lastSnapshotTime === host.svsTime) snapshotTurns.sent++;
      else if (client.rateDelayed) snapshotTurns.delayed++;
    });
  };

  const page = await tab('b');
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => Boolean(window.pcqConsole && window.pcq?.app), null, { timeout: 300000 });
  await page.evaluate((address) => window.pcqConsole(`connect ${address}`), serverAddress);
  // `CA_ACTIVE` is 8: in the game, and taking snapshots.
  await page.waitForFunction(() => window.pcqController?.game.connection.state === 8, null, {
    timeout: 120000
  });
  await page.evaluate(() => {
    window.pcqInput.active = true;
  });
  await page.waitForTimeout(8000);
  // Tab C: renamed, paced at 60 Hz to leave the GPU to tab B, walking in circles and firing.
  const mover = await tab('c');
  await mover.goto(`http://localhost:${port}/`);
  await mover.waitForFunction(() => Boolean(window.pcqConsole && window.pcq?.app), null, { timeout: 300000 });
  await mover.evaluate(() => {
    window.__perf.setRate(60);
    window.pcqConsole('name Mover');
  });
  await mover.evaluate((address) => window.pcqConsole(`connect ${address}`), serverAddress);
  await mover.waitForFunction(() => window.pcqController?.game.connection.state === 8, null, {
    timeout: 120000
  });
  await mover.waitForTimeout(3000);
  await mover.evaluate(() => {
    window.pcqInput.active = true;
    window.pcqConsole('weapon 8');
    window.pcqConfig.command(['bind', 'F10', '+forward']);
    window.pcqConfig.command(['bind', 'F11', '+attack']);
    window.pcqInput.keyDown(154);
    window.pcqInput.keyDown(155);
    // A steady turn, about 75° a second at the default sensitivity.
    setInterval(() => window.pcqInput.mouseMove(8, 0), 16);
  });
  await mover.waitForTimeout(2000);
  const tabB = addressOf('UnnamedPlayer');
  const tabC = addressOf('Mover');
  result.dedicated.addresses = { tabB, tabC };

  // Each packet tab B reads: when it arrived, when the frame read it, its size and its sequence.
  await page.evaluate(() => {
    const connection = window.pcqController.game.connection;
    const packetEvent = connection.packetEvent.bind(connection);
    window.__heard = [];
    connection.packetEvent = (from, data, time) => {
      if (window.__heard.length < 20000) {
        window.__heard.push([
          performance.timeOrigin + (time ?? performance.now()),
          performance.timeOrigin + performance.now(),
          data.byteLength,
          data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)
        ]);
      }
      return packetEvent(from, data, time);
    };
  });

  for (const round of ROUNDS) {
    const label = `snaps ${round.snaps}, cl_maxpackets ${round.maxpackets}, rate ${round.rate}`;
    // A change of `snaps` alone sends the server no userinfo; one of `rate` does, and carries it.
    // The two changes of `rate` a frame or more apart, as the client compares values per frame.
    await page.evaluate((r) => {
      window.pcqConsole(`snaps ${r.snaps}`);
      window.pcqConsole(`cl_maxpackets ${r.maxpackets}`);
      window.pcqConsole(`rate ${r.rate + 1}`);
    }, round);
    await page.waitForTimeout(300);
    await page.evaluate((r) => window.pcqConsole(`rate ${r.rate}`), round);
    await page.waitForTimeout(3000);
    sent = [];
    heard = [];
    snapshotTurns = { sent: 0, delayed: 0 };
    const wakeFrom = wakes.length;
    await page.evaluate(() => window.__heard.splice(0));
    const log = await record(page, () => page.waitForTimeout(ROUND_MS));
    writeFileSync(join(OUT, 'logs', `${label}.json`), JSON.stringify(compact(log)));
    const atTab = await page.evaluate(() => window.__heard.splice(0));
    const toC = sent.filter((s) => s[3] === tabC);
    const fromC = heard.filter((h) => h[2] === tabC);
    sent = sent.filter((s) => s[3] === tabB);
    heard = heard.filter((h) => h[2] === tabB);
    const bySeq = new Map(atTab.map((h) => [h[3], h]));
    const matched = sent.filter((s) => bySeq.has(s[2])).map((s) => [s, bySeq.get(s[2])]);
    const seconds = ROUND_MS / 1000;
    const wakeTimes = wakes.slice(wakeFrom);
    // What the server made of tab B's userinfo: the snapshot interval and the rate it holds it to.
    const human = host.clients.find((c) => c.state >= 2 && !(c.gentity && (c.gentity.r.svFlags & 8) !== 0));
    result.dedicated.rounds[label] = {
      atServer: { snapshotMsec: human?.snapshotMsec, rate: human?.rate },
      serverWake: stats(wakeTimes.slice(1).map((t, i) => t - wakeTimes[i])),
      down: {
        packetsPerSecond: sent.length / seconds,
        bytesPerSecond: sent.reduce((a, s) => a + s[1], 0) / seconds,
        size: stats(sent.map((s) => s[1])),
        over1100: sent.filter((s) => s[1] >= 1100).length,
        gap: stats(sent.slice(1).map((s, i) => s[0] - sent[i][0])),
        snapshotTurns: { ...snapshotTurns }
      },
      arrival: {
        matched: matched.length,
        oneWay: stats(matched.map(([s, h]) => h[0] - s[0])),
        waitForFrame: stats(atTab.map((h) => h[1] - h[0])),
        sendToRead: stats(matched.map(([s, h]) => h[1] - s[0])),
        gap: stats(atTab.slice(1).map((h, i) => h[0] - atTab[i][0]))
      },
      up: {
        packetsPerSecond: heard.length / seconds,
        gap: stats(heard.slice(1).map((h, i) => h[0] - heard[i][0])),
        size: stats(heard.map((h) => h[1]))
      },
      frames: summarise(log, RATE),
      // What tab C, moving and firing at 60 Hz with id's defaults, was sent and sent.
      mover: {
        downPacketsPerSecond: toC.length / seconds,
        downBytesPerSecond: toC.reduce((a, s) => a + s[1], 0) / seconds,
        downSize: stats(toC.map((s) => s[1])),
        upPacketsPerSecond: fromC.length / seconds
      }
    };
    save();
  }
  // The blocks at id's defaults.
  await page.evaluate(() => {
    window.pcqConsole('snaps 20');
    window.pcqConsole('cl_maxpackets 30');
    window.pcqConsole('rate 25001');
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.pcqConsole('rate 25000'));
  await page.waitForTimeout(3000);
  result.dedicated.blocks = await blocks(page, 'remote');
  result.dedicated.status = printed.filter((l) => /rate|snaps|ping/i.test(l)).slice(-20);
} catch (err) {
  result.error = String(err?.stack ?? err);
} finally {
  clearTimeout(watchdog);
  save();
  await cleanup();
}
console.log(`done ${OUT}`);
process.exit(0);
