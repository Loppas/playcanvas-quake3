import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import nodeDataChannel from 'node-datachannel';

import { DEBUG_MODE } from './config';
import { mountArchives } from './pak/mount';
import { nodeFileSource } from './pak/node-source';
import { searchPath } from './pak/vfs';
import { baseq3Dir } from '../scripts/fs-basepath.mjs';
import { fsHomepath } from '../scripts/fs-homepath.mjs';
import { Q3CONFIG_CFG } from '../scripts/q3config-route.mjs';
import { startDedicatedServer } from './server/dedicated';
import { nodeServerNetwork } from './server/node-network';
import { GameConfig } from './settings/game-config';
import { diskHome } from './settings/disk-home';
import { versionString } from './version';

/**
 * The Node dedicated server: `ioq3ded` for the port.
 *
 * Everything it runs is the same server half a listen server's worker runs
 * (`src/server/dedicated.ts`); this file is only the process around it — the command line, the
 * disk, stdin, and the loop:
 *
 * ```
 * npm run dedicated -- +set dedicated 1 +map garage_rats
 * ```
 *
 * The search path is `fs_basepath`'s `baseq3` and the port's own `public/maps`, the same folders
 * the page's build reads, resolved the same way (`scripts/fs-basepath.mjs`); the home folder is
 * `fs_homepath`, where `exec` finds cfgs and where `q3config.cfg` is read, never written.
 *
 * The bundle sits in `build/`, so the repo is one folder up — that is the root those folders are
 * taken from. Players reach it through its masters, by node-datachannel's peer connections on one
 * UDP port (`server/node-network.ts`), and `+set sv_runMaster 1` runs a master inside it.
 */

/** The repo root: `build/dedicated.js` runs from the build's folder. */
const ROOT = resolve(import.meta.dirname, '..');

/** Vite's mode, which the `.env` files are read for; a build's by default. */
const MODE = process.env.NODE_ENV ?? 'production';

/**
 * `Com_Printf`, and the console's own lines: everything goes to stdout. Quake 3's text carries its
 * newline and the host's lines do not, so a line that has none is ended here.
 */
const print = (text: string) => {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
};

/** Every pak directly in a folder, in name order, read where it sits. */
function pakSources(folder: string) {
  try {
    return readdirSync(folder)
      .filter((name) => /\.pk3$/i.test(name))
      .sort()
      .map((name) => nodeFileSource(join(folder, name), name));
  } catch {
    return [];
  }
}

/**
 * Boot, in Q3's order: the paks, the cvars, and then the server, whose `+map` is what spawns the
 * first world. A failure prints and sets the exit code — Q3's `Sys_Error` without the dialog.
 */
try {
  const baseq3 = baseq3Dir(ROOT, MODE);
  // The port's own map pk3s are the bottom of the search path, under the player's paks.
  const fs = searchPath([
    await mountArchives(pakSources(join(ROOT, 'public', 'maps')), {
      onSkip: (label, err) => print(`WARNING: ${label}: ${err instanceof Error ? err.message : err}\n`)
    }).catch(() => undefined),
    await mountArchives(pakSources(baseq3), {
      onSkip: (label, err) => print(`WARNING: ${label}: ${err instanceof Error ? err.message : err}\n`)
    }).catch(() => undefined)
  ]);

  const home = diskHome(fsHomepath(ROOT, MODE));
  const config = new GameConfig({
    config: await home.read(Q3CONFIG_CFG),
    debugMode: DEBUG_MODE,
    print
  });
  const server = await startDedicatedServer({
    config,
    fs,
    home,
    print,
    argv: process.argv.slice(2),
    debugMode: DEBUG_MODE,
    network: (cvars) => nodeServerNetwork(cvars, print),
    onError: (err) => console.error(err)
  });
  print(`${versionString()}\n`);

  // `Sys_ConsoleInput` (`sys_main.c:785–899`, `con_tty.c:333`): a line of stdin is a console line,
  // and Q3 polls them every frame. Here they go in as they arrive; the router queues them.
  process.stdin.setEncoding('utf8');
  let pending = '';
  process.stdin.on('data', (chunk: string) => {
    pending += chunk;
    for (;;) {
      const at = pending.indexOf('\n');
      if (at === -1) break;
      server.consoleLine(pending.slice(0, at));
      pending = pending.slice(at + 1);
    }
  });
  // `Sys_SigHandler` (`sys_main.c:760–778`): the signal's number is the final message.
  process.on('SIGINT', () => server.stop('Received signal 2'));

  // `while (1) Com_Frame()` (`sys_main.c:137–140`), paced by `SV_FrameMsec` — and the msec that
  // reaches the server is the real time that passed, so the server's own clock keeps up whether
  // the timer is late or not. A server that has stopped, by a signal, by `dedicated 0` or by a
  // fatal error, ends the process with its code, and node-datachannel holds it open until its
  // threads are let go.
  let last = performance.now();
  const loop = () => {
    if (server.stopped) {
      nodeDataChannel.cleanup();
      process.exit(server.exitCode);
    }
    const started = performance.now();
    server.frame(started - last);
    last = started;
    setTimeout(loop, server.waitMsec(performance.now() - started));
  };
  loop();
} catch (err) {
  print(`${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
}
