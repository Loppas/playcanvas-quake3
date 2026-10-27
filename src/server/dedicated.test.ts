import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { MasterServer } from '../../master/master-server';
import { MASTER_ADR, masterPeer, oob, readList } from '../../master/master-test-fixtures';
import { bspFile } from '../formats/bsp-test-fixtures';
import { CA, ClientConnection } from '../net/connection';
import { CONFIGSTRING } from '../net/commands';
import type { CvarStore } from '../net/cvar';
import { RETRY_MSEC, ServerMasters } from '../net/masters';
import { MemoryNetwork, testCvars } from '../net/net-test-fixtures';
import { NA, Net, netadr, stringToAdr, type DatagramSocket } from '../net/net';
import { createPeerSocket } from '../net/peer-signalling';
import { FakeRtc, settle, webSocketPair, type FakeSocketEnd } from '../net/peer-test-fixtures';
import { createNetUserCmd, ENTITYNUM_NONE, ENTITYNUM_WORLD } from '../net/protocol';
import { CS, Host } from './host';
import { memorySource } from '../pak/byte-source';
import { nodeFileSource } from '../pak/node-source';
import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { ZipArchive } from '../pak/zip';
import { GameConfig } from '../settings/game-config';
import type { HomeFolder } from '../settings/home-folder';
import { cubeBsp, patchBsp } from '../sim/cm/collision-test-fixtures';
import { MASK } from '../sim/constants';
import { ET } from '../sim/game-entity';
import { mapOf, spawnSpot } from '../sim/map-test-fixtures';
import { packBin } from '../sim/octree-test-fixtures';
import { vec3 } from '../sim/vec3';
import type { VoxelOctreeHeader } from '../sim/voxel-svo';
import {
  commandsFromArgv,
  startDedicatedServer,
  type DedicatedServerOptions,
  type ServerNetwork
} from './dedicated';

/**
 * The dedicated server: Q3's `ioq3ded` shape — no map at boot, the command line's cvars
 * before anything reads one, the map spawned by the first frame's command buffer, the console on
 * stdin's lines, the dedicated clamp, and the `dedicated` latch.
 */

/** A one-block octree with an empty root: 4 voxels a side, none of them solid. */
const HEADER: VoxelOctreeHeader = {
  version: '1.1',
  gridBounds: { min: [0, 0, 0], max: [4, 4, 4] },
  sceneBounds: { min: [0, 0, 0], max: [4, 4, 4] },
  voxelResolution: 1,
  leafSize: 4,
  treeDepth: 0,
  numInteriorNodes: 0,
  numMixedLeaves: 1,
  nodeCount: 1,
  leafDataCount: 2
};

/** A map's entity text: one spawn spot inside the grid, which is the sims' −4..0. */
const entities = () => mapOf(spawnSpot(vec3(-64, -64, -32)));

const text = (value: string) => new TextEncoder().encode(value);

/**
 * A search path holding two maps, so a `map` has somewhere to go.
 *
 * @param extra - More files beside them, as a broken map's are.
 */
async function twoMaps(extra: Record<string, Uint8Array> = {}): Promise<PakFileSystem> {
  const files: Record<string, Uint8Array> = { ...extra };
  for (const name of ['room', 'other']) {
    // The splat is the map's marker (`SV_Map_f`'s check), which a server never reads.
    files[`maps/${name}.sog`] = new Uint8Array([0]);
    files[`maps/${name}.voxel.json`] = text(JSON.stringify(HEADER));
    files[`maps/${name}.voxel.bin`] = new Uint8Array(packBin([0], [0, 0]));
    files[`maps/${name}.ent`] = text(entities());
  }
  const fs = new PakFileSystem();
  fs.mount(await ZipArchive.open(memorySource('dedicated-test.pk3', zipSync(files))));
  return fs;
}

/** A home folder in memory: no cfgs of its own, so the port's presets answer `exec`. */
function memoryHome(files: Record<string, string> = {}): HomeFolder {
  return {
    read: async (path) => files[path],
    list: async () => [],
    write: async (path, text) => {
      files[path] = text;
      return true;
    }
  };
}

/** A dedicated server over the fixture maps, with its console's lines kept. */
async function start(
  options: {
    argv?: readonly string[];
    fs?: PakFileSystem;
    home?: HomeFolder;
    socket?: DatagramSocket | null;
    network?: DedicatedServerOptions['network'];
    now?: () => number;
    onError?: DedicatedServerOptions['onError'];
  } = {}
) {
  const lines: string[] = [];
  const warnings: string[] = [];
  const config = new GameConfig({ debugMode: true, print: (text) => warnings.push(text) });
  const { socket } = options;
  const server = await startDedicatedServer({
    config,
    fs: options.fs ?? (await twoMaps()),
    home: options.home ?? memoryHome(),
    print: (line) => lines.push(line),
    argv: options.argv,
    network:
      options.network ??
      (socket ? async () => ({ socket, frame: () => {}, close: () => {} }) : undefined),
    now: options.now,
    onError: options.onError
  });
  return { server, config, lines, warnings };
}

/** A server booted, with the command line's map in: one frame runs the command, then the read. */
async function booted(argv: readonly string[] = ['+map', 'room']) {
  const rig = await start({ argv });
  rig.server.frame(1);
  await rig.server.program.mapLoad;
  return rig;
}

describe('commandsFromArgv', () => {
  it("takes each +word as a command, with the words behind it, as Q3's command line does", () => {
    expect(commandsFromArgv(['+set', 'dedicated', '1', '+map', 'room'])).toEqual([
      ['set', 'dedicated', '1'],
      ['map', 'room']
    ]);
  });

  it('leaves the flags alone, and closes a command at the next +word', () => {
    expect(commandsFromArgv(['-nocrashdialog', '+map', 'room', 'extra', '+exec', 'vq3'])).toEqual([
      ['map', 'room', 'extra'],
      ['exec', 'vq3']
    ]);
    expect(commandsFromArgv([])).toEqual([]);
  });
});

describe('the dedicated server', () => {
  it("boots with no map, and the command line's map spawns the world on its first frame", async () => {
    const { server, config } = await start({ argv: ['+set', 'dedicated', '1', '+map', 'room'] });

    // `ioq3ded +map` waits for the first `Com_Frame` to run the command buffer.
    expect(server.program.svRunning).toBe(false);
    expect(config.cvars.get('mapname')).toBe('');
    expect(config.cvars.get('dedicated')).toBe('1');

    server.frame(1);
    await server.program.mapLoad;

    expect(server.program.svRunning).toBe(true);
    expect(config.cvars.get('mapname')).toBe('room');
  });

  it("answers the console's status: nothing running, then the map and the players", async () => {
    const { server, lines } = await start({ argv: ['+map', 'room'] });

    server.consoleLine('status');
    server.frame(1);
    expect(lines).toContain('Server is not running.');
    await server.program.mapLoad;

    server.consoleLine('status');
    server.frame(1);
    expect(lines).toContain('map: room');
    expect(lines.some((line) => line.startsWith('cl score ping'))).toBe(true);
  });

  it('says nothing of a command nothing takes with no map running, as ioq3ded says nothing', async () => {
    const { server, lines, warnings } = await start();
    lines.length = 0;

    server.consoleLine('nosuch');
    server.consoleLine('+nosuch');
    server.consoleLine('-nosuch');
    server.consoleLine('wait');
    server.consoleLine('nosuch');
    server.frame(1);
    await server.router.settled();

    expect(lines).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("sends the server the game module's commands, and no other", async () => {
    const { server } = await start();
    server.consoleLine('nosuch');
    expect(server.program.host.commandsPending).toBe(false);
    server.consoleLine('AddBot');
    expect(server.program.host.commandsPending).toBe(true);
  });

  it('runs a preset off the command line, where a console would', async () => {
    const { server, config, lines } = await start({ argv: ['+exec', 'presets/vq3'] });
    await server.router.settled();

    expect(lines).toContain('execing presets/vq3.cfg\n');
    expect(config.cvars.get('g_gamepreset')).toBe('VQ3');
  });

  it("has cmd.c's and common.c's commands, and none of the client's, as ioq3ded", async () => {
    const { server, lines } = await start();
    server.consoleLine('cmdlist');
    for (const name of ['cmdlist', 'exec', 'execq', 'vstr', 'echo', 'wait', 'quit', 'writeconfig', 'map', 'set']) {
      expect(lines).toContain(`${name}\n`);
    }
    for (const name of ['clear', 'condump', 'cmd', 'vid_restart', 'connect', 'kill']) {
      expect(lines).not.toContain(`${name}\n`);
    }
    expect(lines.at(-1)).toMatch(/^\d+ commands\n$/);
  });

  it("runs a cvar's string with vstr, a map's change among it", async () => {
    const { server, config, lines } = await booted();
    server.consoleLine('set rotation "echo next; map other"');
    server.consoleLine('vstr rotation');
    server.frame(1);
    await server.program.mapLoad;
    expect(lines).toContain('next\n');
    expect(config.cvars.get('mapname')).toBe('other');
  });

  it("takes the command line's cvars before the server is built, as Com_StartupVariable does", async () => {
    const { server, config } = await start({
      argv: ['+set', 'sv_fps', '20', '+set', 'sv_maxclients', '4']
    });

    expect(server.frameMsec).toBe(50);
    expect(server.program.host.clients).toHaveLength(4);
    expect(config.cvars.get('sv_fps')).toBe('20');
  });

  it('waits one game frame between frames, as sv_fps stands each time', async () => {
    const { server } = await booted();
    expect(server.frameMsec).toBe(8);
    server.consoleLine('sv_fps 40');
    expect(server.frameMsec).toBe(25);
  });

  it('waits only the rest of the frame, as SV_FrameMsec, off the accumulator', async () => {
    const { server } = await booted();
    // 8 ms frames: a 10 ms frame leaves 2 ms, so 6 to the next, less what the frame has spent.
    server.frame(10);
    expect(server.waitMsec(0)).toBe(6);
    expect(server.waitMsec(2.5)).toBe(3.5);
    // A frame back on the grid waits the whole frame.
    server.frame(6);
    expect(server.waitMsec(0)).toBe(8);
  });

  it('reports a hitch over 500, and clamps a dedicated frame at 5000', async () => {
    const { server, lines } = await booted();
    expect(lines.filter((line) => line.startsWith('Hitch warning'))).toEqual([]);

    const before = server.program.host.time;
    server.frame(7000);
    expect(server.program.host.time - before).toBe(5000);
    expect(lines.some((line) => line.startsWith('Hitch warning: 7000 msec frame time'))).toBe(true);

    server.frame(600);
    expect(lines.some((line) => line.startsWith('Hitch warning: 600 msec frame time'))).toBe(true);
  });

  it('warns of nothing while no server is running', async () => {
    const { server, lines } = await start();
    server.frame(7000);
    expect(lines.filter((line) => line.startsWith('Hitch warning'))).toEqual([]);
  });

  it("opens its network once the command line's sets and cfgs are in", async () => {
    const seen: string[] = [];
    await start({
      argv: ['+set', 'net_port', '27970', '+exec', 'server'],
      home: memoryHome({ 'server.cfg': 'set sv_runMaster 1\n' }),
      network: async (cvars) => {
        seen.push(cvars.get('net_port'), cvars.get('sv_runMaster'));
        return null;
      }
    });
    expect(seen).toEqual(['27970', '1']);
  });

  it('gives its network a turn each frame, and lets it go as it stops', async () => {
    let frames = 0;
    let closes = 0;
    const network: ServerNetwork = {
      socket: null,
      frame: () => frames++,
      close: () => closes++
    };
    const { server } = await start({ network: async () => network });
    server.frame(1);
    server.frame(1);
    expect([frames, closes, server.stopped]).toEqual([2, 0, false]);

    server.consoleLine('quit');
    expect([frames, closes, server.stopped]).toEqual([2, 1, true]);
  });

  it('answers nobody before its map is in, nor once it is shut down', async () => {
    const network = new MemoryNetwork();
    const { server } = await start({
      socket: network.socket('10.0.0.1'),
      now: () => network.now,
      argv: ['+map', 'room']
    });
    const probe = new Net({
      cvars: testCvars(),
      socket: network.socket('10.0.0.2'),
      now: () => network.now
    });
    const { net } = server.program.host;
    /** Whether a `getinfo` from each side, the socket's and the loopback's, is answered. */
    const answered = (): [boolean, boolean] => {
      // Past the rate limit's second.
      network.advance(1000);
      probe.outOfBandPrint('client', stringToAdr('10.0.0.1')!, 'getinfo 1');
      net.outOfBandPrint('client', netadr(NA.LOOPBACK), 'getinfo 2');
      server.frame(1);
      return [probe.getPacket() !== null, net.getLoopPacket('client') !== null];
    };

    // The first frame runs `+map`, whose read has not come back.
    expect(answered()).toEqual([false, false]);
    await server.program.mapLoad;
    expect(answered()).toEqual([true, true]);
    server.stop('Server quit');
    expect(answered()).toEqual([false, false]);
  });

  it("holds dedicated write protected once its command line has run, as ioq3ded's CVAR_INIT", async () => {
    const { server, config, warnings } = await booted();
    server.consoleLine('set dedicated 0');
    server.consoleLine('dedicated 2');
    server.frame(1);
    expect(warnings).toEqual(['dedicated is write protected.\n', 'dedicated is write protected.\n']);
    expect(config.cvars.get('dedicated')).toBe('1');
    expect(server.program.svRunning).toBe(true);

    const set = await start({ argv: ['+set', 'dedicated', '2'] });
    expect(set.config.cvars.get('dedicated')).toBe('2');
  });

  it('quits, the rest of the line the reason its clients are given, and runs nothing after it', async () => {
    const { server, config, lines } = await booted();
    server.consoleLine('quit');
    server.consoleLine('set after 1');
    expect(server.program.svRunning).toBe(false);
    expect([server.stopped, server.exitCode]).toEqual([true, 0]);
    expect(lines).toContain('----- Server Shutdown (Server quit) -----');
    expect(config.cvars.get('after')).toBe('');

    const reason = await booted();
    reason.server.consoleLine('quit "back soon"  folks');
    expect(reason.lines).toContain('----- Server Shutdown (back soon folks) -----');
  });

  it("writes ioq3ded's file with writeconfig, the archived cvars and no binds, which exec reads back", async () => {
    const files: Record<string, string> = {};
    const { server, config, lines } = await start({ home: memoryHome(files) });
    server.consoleLine('seta sv_hostname Rats');
    server.consoleLine('writeconfig server\\rats');
    server.consoleLine('sv_hostname other');
    server.consoleLine('exec server/rats');
    await server.router.settled();

    expect(lines).toEqual(['Writing server\\rats.cfg.\n', 'execing server/rats.cfg\n']);
    const written = files['server/rats.cfg'].split('\n');
    expect(written[0]).toBe('// generated by playcanvas-quake3, do not modify');
    expect(written).toContain('seta sv_hostname "Rats"');
    expect(written.some((line) => /^(unbindall|bind )/.test(line))).toBe(false);
    expect(config.cvars.get('sv_hostname')).toBe('Rats');
  });

  it("prints Q3's words for a map that is not there, and lets the match run on", async () => {
    const { server, config, lines } = await booted();

    server.consoleLine('map nope');
    server.frame(1);

    expect(lines).toContain("Can't find map maps/nope.bsp");
    expect(config.cvars.get('mapname')).toBe('room');
    expect(server.program.svRunning).toBe(true);
  });

  it('finds and loads a map that ships a BSP and no splat, and traces through its brushes', async () => {
    // The collision tests' cube, its top at z 64, with a spawn spot above it.
    const cube = cubeBsp({ entityString: `${mapOf(spawnSpot(vec3(0, 0, 100)))}\0` });
    const fs = await twoMaps({ 'maps/cube.bsp': bspFile(cube) });
    const { server, config } = await start({ fs, argv: ['+map', 'cube'] });
    server.frame(1);
    await server.program.mapLoad;

    expect(server.program.svRunning).toBe(true);
    expect(config.cvars.get('mapname')).toBe('cube');
    const fall = server.program.host.trace(
      vec3(0, 0, 200),
      vec3(-15, -15, -24),
      vec3(15, 15, 32),
      vec3(0, 0, 0),
      ENTITYNUM_NONE,
      MASK.PLAYERSOLID
    );
    expect(fall.endpos.z - 24).toBeCloseTo(64.125, 4);
    expect(fall.entityNum).toBe(ENTITYNUM_WORLD);
  });

  it("loads a BSP with the console's collision cvars, and prints collision's warnings", async () => {
    const spot = `${mapOf(spawnSpot(vec3(32, 32, 100)))}\0`;
    const fs = await twoMaps({
      'maps/patch.bsp': bspFile(patchBsp({ entityString: spot })),
      'maps/bowtie.bsp': bspFile(bowtieBsp(spot))
    });
    // `devmap`, which leaves cheats on for the console's `set`.
    const { server, lines } = await start({ fs, argv: ['+devmap', 'patch'] });
    server.frame(1);
    await server.program.mapLoad;
    const point = () =>
      server.program.host.trace(vec3(16, 16, 50), vec3(), vec3(), vec3(16, 16, -50), 0, MASK.SOLID);
    expect(point().fraction).toBeLessThan(1);
    server.consoleLine('set cm_playerCurveClip 0');
    server.frame(1);
    expect(point().fraction).toBe(1);

    server.consoleLine('map bowtie');
    server.frame(1);
    await server.program.mapLoad;
    expect(lines.filter((line) => line.includes('CM_GridPlane'))).toHaveLength(4);
  });

  it('loads another map the console names, through the server\'s own read', async () => {
    const { server, config } = await booted();

    server.consoleLine('map other');
    server.frame(1);
    await server.program.mapLoad;

    expect(config.cvars.get('mapname')).toBe('other');
  });
});

/** `Com_Error`'s banner, as `ERR_DROP` prints it. */
const banner = (message: string) =>
  `********************\nERROR: ${message}\n********************\n`;

/**
 * A remote player at 10.0.0.2 in the world of a server at 10.0.0.1, both on one network in
 * memory, and the frames that keep the two going.
 */
async function withPlayer(world: { fs?: PakFileSystem; map: string } = { map: 'room' }) {
  const network = new MemoryNetwork();
  const errors: Error[] = [];
  const rig = await start({
    fs: world.fs,
    socket: network.socket('10.0.0.1'),
    now: () => network.now,
    argv: ['+map', world.map],
    onError: (err) => errors.push(err)
  });
  rig.server.frame(1);
  await rig.server.program.mapLoad;

  // `cl_lanForcePackets`, Q3's default: a client on the server's network sends every frame.
  const cvars = testCvars({ cl_lanForcePackets: '1' });
  const net = new Net({ cvars, socket: network.socket('10.0.0.2'), now: () => network.now });
  const connection = new ClientConnection(cvars);
  connection.userinfo = '\\name\\Tester';
  connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
  connection.checkForResend();
  /** A frame of the player's, then the server's, and what the server sent read. */
  const step = () => {
    network.advance(8);
    connection.clock.realtime += 8;
    connection.setCGameTime();
    connection.sendCmd(createNetUserCmd());
    connection.checkForResend();
    rig.server.frame(8);
    for (let packet; (packet = net.getPacket()) !== null; ) {
      connection.packetEvent(packet.from, packet.data);
    }
  };
  for (let i = 0; i < 60 && connection.state !== CA.ACTIVE; i++) step();
  expect(connection.state).toBe(CA.ACTIVE);
  /** The server commands the player has been sent since it was last asked. */
  const heard = (): string[] => {
    const commands: string[] = [];
    for (let c; (c = connection.nextServerCommand()) !== null; ) commands.push(c);
    return commands;
  };
  heard();
  return { ...rig, network, net, connection, step, heard, errors };
}

describe("an error in the dedicated server's frame", () => {
  it("ends the match as Com_Error's drop does, and waits for the console's next map", async () => {
    const { server, config, lines, errors } = await withPlayer();
    const { game } = server.program;
    vi.spyOn(game, 'runFrame').mockImplementationOnce(() => {
      throw new Error('boom');
    });

    server.frame(8);

    expect(lines).toContain(banner('boom'));
    expect(lines).toContain('----- Server Shutdown (Server crashed: boom) -----');
    expect(errors.map((err) => err.message)).toEqual(['boom']);
    expect(server.program.svRunning).toBe(false);
    expect([server.stopped, server.exitCode]).toEqual([false, 0]);

    server.consoleLine('map other');
    server.frame(1);
    await server.program.mapLoad;
    expect(server.program.svRunning).toBe(true);
    expect(config.cvars.get('mapname')).toBe('other');
  });

  it('tells its players nothing, and the next map starts with none of them in it', async () => {
    const { server, net, connection, step, heard } = await withPlayer();
    vi.spyOn(server.program.game, 'runFrame').mockImplementationOnce(() => {
      throw new Error('boom');
    });

    step();
    expect(heard()).toEqual([]);

    // The player knows nothing of it, and goes on sending to a server that no longer has it.
    server.consoleLine('map other');
    server.frame(1);
    await server.program.mapLoad;
    for (let i = 0; i < 10; i++) step();
    expect(server.program.host.clients.every((client) => client.state === CS.FREE)).toBe(true);
    expect(heard()).toEqual([]);
    expect(connection.state).toBe(CA.ACTIVE);

    // The new server is on the same network, for the player to join again.
    connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
    connection.checkForResend();
    for (let i = 0; i < 60 && connection.state !== CA.ACTIVE; i++) step();
    expect(connection.state).toBe(CA.ACTIVE);
    expect(server.program.host.clients[0].state).toBe(CS.ACTIVE);
  });

  it('takes a map that fails to load the same way, and runs the next', async () => {
    // A splat with nothing beside it: `SV_Map_f`'s check passes, and the read does not.
    const fs = await twoMaps({ 'maps/broken.sog': new Uint8Array([0]) });
    const { server, config, lines } = await start({ fs, argv: ['+map', 'room'] });
    server.frame(1);
    await server.program.mapLoad;

    server.consoleLine('map broken');
    server.frame(1);
    await server.program.mapLoad;
    server.frame(1);

    const error = lines.find((line) => line.startsWith('*'));
    expect(error).toMatch(/^\*+\nERROR: .*maps\/broken/);
    const shutdown = /^----- Server Shutdown \(Server crashed: .*broken/;
    expect(lines.some((line) => shutdown.test(line))).toBe(true);
    expect(server.program.svRunning).toBe(false);

    server.consoleLine('map room');
    server.frame(1);
    await server.program.mapLoad;
    expect(server.program.svRunning).toBe(true);
    expect(config.cvars.get('mapname')).toBe('room');
  });

  it("prints only the banner for a boot's map that fails, with nothing to shut down", async () => {
    const fs = await twoMaps({ 'maps/broken.sog': new Uint8Array([0]) });
    const { server, lines } = await start({ fs, argv: ['+map', 'broken'] });
    server.frame(1);
    await server.program.mapLoad;
    lines.length = 0;

    server.frame(1);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\*+\nERROR: /);
    expect(server.stopped).toBe(false);
  });

  /** A server whose network throws in every frame's turn, on a clock the test moves. */
  async function throwing() {
    let clock = 1000;
    let closes = 0;
    const network: ServerNetwork = {
      socket: null,
      frame: () => {
        throw new Error('boom');
      },
      close: () => closes++
    };
    const rig = await start({ network: async () => network, now: () => clock });
    return { ...rig, closes: () => closes, advance: (msec: number) => (clock += msec) };
  }

  it('is fatal at the fourth in a row under 100 ms apart, and ends the process', async () => {
    const { server, lines, closes, advance } = await throwing();

    for (let i = 0; i < 4; i++) {
      server.frame(8);
      advance(99);
    }
    expect(lines.filter((line) => line === banner('boom'))).toHaveLength(4);
    expect([server.stopped, server.exitCode]).toEqual([false, 0]);

    server.frame(8);

    expect(lines.filter((line) => line === banner('boom'))).toHaveLength(4);
    expect(lines.at(-1)).toBe('boom\n');
    expect([server.stopped, server.exitCode, closes()]).toEqual([true, 3, 1]);
  });

  it('starts the count over at an error 100 ms or more after the last', async () => {
    const { server, lines, advance } = await throwing();

    for (const gap of [99, 99, 99, 100, 99, 99, 99, 100]) {
      server.frame(8);
      advance(gap);
    }

    expect(lines.filter((line) => line === banner('boom'))).toHaveLength(8);
    expect([server.stopped, server.exitCode]).toEqual([false, 0]);
  });

  it('shuts a running server down as fatally crashed, at the last of the stream', async () => {
    const { server, lines } = await start({ now: () => 1000 });
    for (let i = 0; i < 5; i++) {
      // A drop leaves a server with no map, so each error comes from a map of its own.
      server.consoleLine('map room');
      server.frame(1);
      await server.program.mapLoad;
      vi.spyOn(server.program.game, 'runFrame').mockImplementationOnce(() => {
        throw new Error('boom');
      });
      server.frame(8);
    }

    expect(lines.filter((line) => line === banner('boom'))).toHaveLength(4);
    expect(lines).toContain('----- Server Shutdown (Server fatal crashed: boom) -----');
    expect(lines.at(-1)).toBe('boom\n');
    expect(server.exitCode).toBe(3);
  });

  it('ends the process as a recursive error when the drop itself throws', async () => {
    const { server, lines, errors } = await withPlayer();
    vi.spyOn(server.program.game, 'runFrame').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    vi.spyOn(server.program, 'shutdown').mockImplementationOnce(() => {
      throw new Error('again');
    });

    server.frame(8);

    expect(lines.at(-1)).toBe('recursive error after: boom\n');
    expect(errors.map((err) => err.message)).toEqual(['boom', 'again']);
    expect([server.stopped, server.exitCode]).toEqual([true, 3]);
  });
});

/** The port's own map pk3, which a checkout only has when its maps were generated locally. */
describe("what lands between the dedicated server's frames", () => {
  /** The next datagram waiting at a probe, as text behind its marker, or null. */
  const answer = (probe: Net): string | null => {
    const packet = probe.getPacket();
    return packet === null ? null : new TextDecoder().decode(packet.data.subarray(4));
  };

  it('answers a query as it lands, once its map is in and until it stops', async () => {
    const network = new MemoryNetwork();
    const socket: DatagramSocket = network.socket('10.0.0.1');
    const { server } = await start({ socket, now: () => network.now, argv: ['+map', 'room'] });
    const probe = new Net({
      cvars: testCvars(),
      socket: network.socket('10.0.0.2'),
      now: () => network.now
    });
    /** A `getinfo` sent, and the server woken as it lands. */
    const ask = (challenge: string) => {
      probe.outOfBandPrint('client', stringToAdr('10.0.0.1')!, `getinfo ${challenge}`);
      socket.onArrival?.();
    };

    // Before the map is in, what lands is nobody's.
    ask('early');
    server.frame(1);
    await server.program.mapLoad;
    expect(answer(probe)).toBeNull();

    ask('now');
    expect(answer(probe)).toMatch(/^infoResponse\n.*\\challenge\\now/);

    server.stop('Server quit');
    expect(socket.onArrival).toBeNull();
  });

  it("runs a player's packets as they land, so unlagged times each from the frame", async () => {
    const { server, network, connection } = await withPlayer();
    const { clientNum } = connection;
    const { netchan } = server.program.host.clients[clientNum];
    const before = netchan.incomingSequence;
    const offsets: number[] = [];
    for (const msec of [3, 2]) {
      network.advance(msec);
      connection.clock.realtime += msec;
      connection.setCGameTime();
      connection.sendCmd(createNetUserCmd());
      server.program.host.net.socket?.onArrival?.();
      offsets.push(server.program.game.level.clients[clientNum].frameOffset);
    }

    expect(netchan.incomingSequence).toBe(before + 2);
    expect(netchan.dropped).toBe(0);
    // Unlagged's `frameOffset`: the first move ran 3 ms after the frame ended, not at the next.
    expect(offsets[0]).toBe(3);
  });

  it("drops the match as Com_Error's when what lands throws", async () => {
    const { server, net, lines, errors } = await withPlayer();
    const old = server.program;
    const packetEvent = vi.spyOn(Host.prototype, 'packetEvent').mockImplementation(() => {
      throw new Error('boom');
    });

    try {
      net.outOfBandPrint('client', stringToAdr('10.0.0.1')!, 'getinfo 1');
      server.program.host.net.socket?.onArrival?.();
    } finally {
      packetEvent.mockRestore();
    }
    expect(lines).toContain(banner('boom'));
    expect(errors.map((err) => err.message)).toEqual(['boom']);
    expect(server.program).not.toBe(old);
    expect(server.program.svRunning).toBe(false);
  });
});

describe('the dedicated server on its master', () => {
  /**
   * A server at 203.0.113.9 whose `sv_master1` is a master in memory, which checks a server down
   * the server's own link, all on a clock the test moves; and a client at 198.51.100.4 asking the
   * master for its list. The master's end of each of the server's links is kept, for a test to drop.
   */
  async function atMaster(dedicated: string) {
    let clock = 0;
    const rtc = new FakeRtc();
    const master = new MasterServer({ now: () => clock, lookup: async () => [], print: () => {} });
    const ends: FakeSocketEnd[] = [];
    const registered: string[] = [];
    const network = async (cvars: CvarStore): Promise<ServerNetwork> => {
      const { socket, signalling } = createPeerSocket({
        links: [],
        createPeerConnection: rtc.create,
        dials: false
      });
      const masters = new ServerMasters({
        cvars,
        signalling,
        connect: () => {
          const { client, server } = webSocketPair();
          master.connect(server, '203.0.113.9', 50000 + ends.length);
          ends.push(server);
          return client;
        },
        now: () => clock,
        print: (line) => registered.push(line)
      });
      const opened: ServerNetwork = {
        socket,
        frame: () => masters.frame(),
        close: () => masters.close()
      };
      masters.onRegistered = () => opened.onRegistered?.();
      return opened;
    };
    const rig = await start({
      argv: [
        '+set', 'dedicated', dedicated,
        '+set', 'sv_master1', 'master.test',
        '+set', 'sv_master2', '',
        '+map', 'room'
      ],
      network,
      now: () => clock
    });
    const client = masterPeer(master, rtc.create, '198.51.100.4', { dials: true });

    /** A frame this much later, and whatever it set going landed. */
    const step = async (msec: number) => {
      clock += msec;
      rig.server.frame(msec);
      await settle();
    };
    /** The master's end of the server's link dropped, and the server's next try made. */
    const dropped = async () => {
      ends[0].close();
      await settle();
      for (let waited = 0; waited < RETRY_MSEC; waited += 100) await step(100);
    };
    /** The master's list, as the client is sent it. */
    const listed = async () => {
      client.socket.send(oob('getservers PlayCanvasQuake 2 empty'), MASTER_ADR);
      await settle();
      return readList(client.socket.receive()!.data);
    };
    const heartbeats = () => rig.lines.filter((line) => line.startsWith('Sending heartbeat'));

    await step(1);
    await rig.server.program.mapLoad;
    await step(8);
    return { ...rig, ends, registered, dropped, step, listed, heartbeats };
  }

  it('is listed again as soon as its link opens again, at dedicated 2', async () => {
    const { ends, dropped, step, listed, heartbeats } = await atMaster('2');
    expect(await listed()).toEqual(['203.0.113.9:27960']);
    expect(heartbeats()).toHaveLength(1);

    await dropped();
    expect(ends).toHaveLength(2);
    // The master forgot the server with its link, and hears from it again 3 s on, not 300.
    await step(8);
    expect(heartbeats()).toHaveLength(2);
    expect(await listed()).toEqual(['203.0.113.9:27960']);
  });

  it('sends no heartbeat on reconnecting at dedicated 1, which sends none', async () => {
    const { ends, registered, dropped, step, listed, heartbeats } = await atMaster('1');
    await dropped();
    await step(8);

    expect(ends).toHaveLength(2);
    expect(registered).toEqual([
      'Registered with master.test as 203.0.113.9:27960',
      'Registered with master.test as 203.0.113.9:27960'
    ]);
    expect(heartbeats()).toEqual([]);
    expect(await listed()).toEqual([]);
  });
});

const MAP_PAK = resolve(import.meta.dirname, '../../public/maps/map-garage_rats.pk3');

describe.skipIf(!existsSync(MAP_PAK))('a real map, and a client over a socket', () => {
  it('lets a client connect and play on it, as a remote client would', async () => {
    const fs = new PakFileSystem();
    fs.mount(await ZipArchive.open(nodeFileSource(MAP_PAK)));

    const network = new MemoryNetwork();
    const { server } = await start({
      fs,
      socket: network.socket('10.0.0.1'),
      now: () => network.now,
      argv: ['+set', 'dedicated', '1', '+map', 'garage_rats']
    });
    server.frame(1);
    await server.program.mapLoad;
    expect(server.program.svRunning).toBe(true);

    // The client's side of the wire: a real `ClientConnection` over the same in-memory network.
    // `cl_lanForcePackets` is Q3's default, and it is what lets a client on the server's own
    // network send every frame rather than asking once a second until the world arrives.
    const cvars = testCvars({ cl_lanForcePackets: '1' });
    const net = new Net({ cvars, socket: network.socket('10.0.0.2'), now: () => network.now });
    const connection = new ClientConnection(cvars);
    connection.userinfo = '\\name\\Tester';
    // A remote client asks for a challenge first; `mapLoading` is the loopback's own path.
    connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
    connection.checkForResend();

    for (let i = 0; i < 60 && connection.state !== CA.ACTIVE; i++) {
      network.advance(8);
      connection.clock.realtime += 8;
      connection.checkTimeout();
      // `CL_SetCGameTime`: the previous frame's snapshots, then this frame's commands.
      connection.setCGameTime();
      connection.sendCmd(createNetUserCmd());
      connection.checkForResend();
      server.frame(8);
      for (let packet; (packet = net.getPacket()) !== null; ) {
        connection.packetEvent(packet.from, packet.data);
      }
    }

    expect(connection.state).toBe(CA.ACTIVE);
    expect(connection.clientNum).toBe(0);
    expect(connection.snapshots.snap.valid).toBe(true);
    // The world is the server's map, and the player it spawned is in it.
    expect(connection.configstrings[CONFIGSTRING.SERVERINFO]).toContain('garage_rats');
    expect(server.program.game.level.clients[0]).toBeDefined();
  });
});

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('a match on a retail BSP map, from the paks', () => {
  /** pak0 to pak8, as the dedicated server's search path mounts the install's. */
  async function retail(): Promise<PakFileSystem> {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    return fs;
  }

  for (const map of ['q3dm1', 'q3dm17']) {
    it(`spawns a player on ${map}, who falls to its floor and stands there`, async () => {
      const { server, config, step } = await withPlayer({ fs: await retail(), map });
      expect(config.cvars.get('mapname')).toBe(map);
      const { game } = server.program;
      // Two seconds, for the spawn's drop to land and the items' to finish (`FinishSpawningItem`).
      for (let i = 0; i < 250; i++) step();
      // Every item the map placed dropped to the floor beneath it, but those it hangs in the air
      // (`SUSPENDED`, as q3dm17's armour over its jumps).
      const items = game.level.gentities.filter((e) => e.inuse && e.s.eType === ET.ITEM);
      expect(items.length).toBeGreaterThan(10);
      const dropped = items.filter((e) => !(e.spawnflags & 1));
      expect(dropped.filter((e) => e.s.groundEntityNum !== ENTITYNUM_WORLD)).toEqual([]);
      const standing = game.playerState(0);
      const z = standing.origin.z;
      for (let i = 0; i < 25; i++) step();

      const still = game.playerState(0);
      expect(still.groundEntityNum).toBe(ENTITYNUM_WORLD);
      expect(still.origin.z).toBe(z);
      expect(still.velocity.z).toBe(0);
    }, 30000);
  }
});

/** The patch map with its points as a bowtie, whose cells' triangles have no plane. */
function bowtieBsp(entityString: string) {
  const bowtie = [0, 0, 0, 32, 0, 0, 64, 0, 0, 0, 32, 0, 16, 16, 0, 32, 0, 0, 0, 64, 0, 0, 32, 0];
  const bsp = patchBsp({ entityString });
  bsp.drawVerts.xyz = Float32Array.from([...bowtie, 0, 0, 0]);
  return bsp;
}
