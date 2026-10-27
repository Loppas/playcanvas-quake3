import { describe, expect, it, vi } from 'vitest';
import { LUMP_BRUSHES } from '../formats/bsp';
import { bspFile, buildBsp, int32s } from '../formats/bsp-test-fixtures';
import { LocalGame, type ClientMap } from '../local-game';
import { CONFIGSTRING } from '../net/commands';
import { CA, ClientConnection } from '../net/connection';
import { infoValueForKey } from '../net/info';
import { RETRY_MSEC } from '../net/masters';
import { NA, Net, netadr, stringToAdr, type NetPacket } from '../net/net';
import { MemoryNetwork, testCvars } from '../net/net-test-fixtures';
import { createNetUserCmd, ENTITYNUM_NONE, ENTITYNUM_WORLD } from '../net/protocol';
import { FakeMaster, FakeRtc, fakePeer, settle } from '../net/peer-test-fixtures';
import { Cvars } from '../settings/cvars';
import { GameConfig } from '../settings/game-config';
import { shippedCfg } from '../settings/presets';
import { createFlatWorldTrace } from '../sim/box-world';
import { cubeBsp, patchBsp } from '../sim/cm/collision-test-fixtures';
import { EF_TELEPORT_BIT, GT, PERS, PMOVE_MSEC, TEAM } from '../sim/constants';
import { Game } from '../sim/game';
import { mapOf, spawnSpot } from '../sim/map-test-fixtures';
import { packBin } from '../sim/octree-test-fixtures';
import { ID_RULES, isSysteminfoRecordKey, SYSTEMINFO_RULES } from '../sim/rules';
import { createUserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import type { VoxelOctreeHeader } from '../sim/voxel-svo';
import { serverInfo } from '../view/server-info';
import { RemoteChannel } from './channel';
import { Host } from './host';
import type { HostMapData } from './host-map';
import { ServerProgram } from './program';
import {
  WorkerChannel,
  type MapFiles,
  type WorkerChannelOptions,
  type WorkerLike
} from './worker-channel';
import type { PageToWorker, WorkerToPage } from './worker-messages';
import { startServerWorker } from './worker-server';

/**
 * The worker's boundary as the page and the program speak over it: a real client
 * plays a real match over the messages, and the side channels the one store carried cross them.
 *
 * A real `Worker` is the browser's, so the two ends are wired here by hand: what one posts is
 * queued for the other, and the test delivers when the event loop would have.
 */

/**
 * A one-block octree with an empty root: 4 voxels a side, none of them solid. Its cell 0 is sim
 * 0 run the other way (`SvoVoxelGrid`'s frame flip), so the spawn spot is inside it at negative
 * sim coordinates.
 */
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

/** A map as it crosses: its octree's files and a spawn spot inside it. */
function mapData(name: string): HostMapData {
  return {
    kind: 'splat',
    name,
    entities: mapOf(spawnSpot(vec3(-64, -64, -32))),
    header: HEADER,
    nodes: packBin([0], [0, 0])
  };
}

/** A BSP map as it crosses: the collision tests' cube, with a spawn spot above it. */
function cubeData(name: string): HostMapData {
  const entityString = `${mapOf(spawnSpot(vec3(0, 0, 100)))}\0`;
  return { kind: 'bsp', name, bsp: bspFile(cubeBsp({ entityString })).slice().buffer };
}

/**
 * The two ends of a worker's boundary in this process. The clock is the test's: frames run back
 * to back, and a real clock would leave the net's rate gates shut between them.
 *
 * @param channels - Whether the worker can take a data channel, as a current browser's can.
 */
function boundary(channels = true) {
  const toWorker: PageToWorker[] = [];
  const toPage: WorkerToPage[] = [];
  /** Every crossing, with the transfer list it moved in, for the tests that read one. */
  const moved: {
    from: 'page' | 'worker';
    message: PageToWorker | WorkerToPage;
    transfer: Transferable[] | undefined;
  }[] = [];
  let hearPage: ((message: WorkerToPage) => void) | null = null;
  let hearWorker: ((message: PageToWorker) => void) | null = null;
  let realtime = 0;
  let closed = false;
  const errors: Error[] = [];

  const program = startServerWorker({
    post: (message, transfer) => {
      toPage.push(message);
      moved.push({ from: 'worker', message, transfer });
    },
    onMessage: (listener) => (hearWorker = listener),
    now: () => realtime,
    close: () => (closed = true),
    channels,
    onError: (err) => errors.push(err)
  });
  const worker: WorkerLike = {
    postMessage: (message, transfer) => {
      toWorker.push(message as PageToWorker);
      moved.push({ from: 'page', message: message as PageToWorker, transfer });
      // A channel moved to a worker is the worker's from the task that moved it, and whatever it
      // receives after is the worker's to read, so it is handed over at once, in its turn.
      if ((message as PageToWorker).type !== 'channel') return;
      while (toWorker.length > 0) hearWorker?.(toWorker.shift()!);
    },
    onMessage: (listener) => (hearPage = listener as (message: WorkerToPage) => void)
  };

  /** Deliver everything waiting, both ways, the microtasks between, as the event loop does. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 12; turn++) {
      while (toWorker.length > 0) hearWorker?.(toWorker.shift()!);
      while (toPage.length > 0) hearPage?.(toPage.shift()!);
      await Promise.resolve();
    }
  };

  /** One frame each way, the worker's first, `msec` on the clock they share. */
  const step = async (game: LocalGame, msec = PMOVE_MSEC): Promise<void> => {
    await settle();
    realtime += msec;
    program.frame(msec);
    await settle();
    game.frame(msec, { ...createUserCmd(), forwardmove: 127 });
    await settle();
  };

  return {
    worker,
    settle,
    step,
    clock: () => realtime,
    closed: () => closed,
    errors,
    frameMsec: () => program.frameMsec,
    waitMsec: (spent: number) => program.waitMsec(spent),
    moved
  };
}

/**
 * The page: its store, its files, and a client whose world is its own load.
 *
 * @param data - Each map's files, as the page reads them; splat maps by default.
 */
function page(
  wire: ReturnType<typeof boundary>,
  setup: (cvars: Cvars) => void = () => {},
  peers?: WorkerChannelOptions['peers'],
  data: (name: string) => HostMapData = mapData
) {
  const cvars = new Cvars({ debugMode: true, print: () => {} });
  setup(cvars);
  const asked: string[] = [];
  const printed: string[] = [];
  const loaded: string[] = [];
  const maps: MapFiles = {
    names: () => ['garage', 'other', 'cube'],
    read: async (name) => {
      asked.push(name);
      return data(name);
    }
  };
  const clientLoader = {
    load: async (name: string): Promise<ClientMap> => {
      loaded.push(name);
      return { name };
    }
  };
  const channel = new WorkerChannel({
    cvars,
    maps,
    boot: { map: data('garage'), botFiles: [], debugMode: true },
    print: (text) => printed.push(text),
    now: () => wire.clock(),
    worker: wire.worker,
    peers
  });
  const game = new LocalGame({
    cvars,
    channel,
    clientLoader
  });
  return { game, channel, cvars, asked, printed, loaded };
}

/** Frames until the client is in the world, as a match's boot takes. */
async function enter(wire: ReturnType<typeof boundary>, game: LocalGame): Promise<void> {
  for (let i = 0; i < 60 && game.connection.state !== CA.ACTIVE; i++) await wire.step(game);
  expect(game.connection.state).toBe(CA.ACTIVE);
}

/** The cvars one end has told the other, in order. */
function cvarsTold(wire: ReturnType<typeof boundary>, from: 'page' | 'worker') {
  return wire.moved
    .filter((entry) => entry.from === from && entry.message.type === 'cvar')
    .map(({ message }) => message as { type: 'cvar'; name: string; value: string });
}

describe('the page and a worker, over the messages', () => {
  it('boots its map in the worker and plays it, the worker reading nothing more', async () => {
    const wire = boundary();
    const { game, asked } = page(wire);

    await enter(wire, game);

    // The boot carried the map: no read crossed for it. The gamestate came back over the
    // messages, and the client has a snapshot of the world the worker spawned.
    expect(asked).toEqual([]);
    expect(game.channel.svRunning).toBe(true);
    expect(infoValueForKey(game.configstring(CONFIGSTRING.SERVERINFO), 'mapname')).toBe('garage');
    expect(game.snapshot(game.currentSnapshotNumber())).not.toBeNull();
    expect(game.clientMap?.name).toBe('garage');
  });

  it("moves a packet's bytes across the boundary rather than copying them", async () => {
    const wire = boundary();
    const { game } = page(wire);
    await enter(wire, game);

    const packet = (from: 'page' | 'worker') =>
      wire.moved.find(
        (entry) => entry.from === from && (entry.message as { type: string }).type === 'packet'
      );
    const sent = packet('page');
    const arrived = packet('worker');
    expect(sent).toBeDefined();
    expect(arrived).toBeDefined();

    const sentData = (sent!.message as { data: Uint8Array }).data;
    expect(sent!.transfer).toHaveLength(1);
    expect(sent!.transfer?.[0]).toBe(sentData.buffer);

    const arrivedData = (arrived!.message as { data: Uint8Array }).data;
    expect(arrived!.transfer).toHaveLength(1);
    expect(arrived!.transfer?.[0]).toBe(arrivedData.buffer);
  });

  it("takes the page's store, at the boot and as it changes", async () => {
    const wire = boundary();
    // A value the page already holds when the worker is built: the boot hands its store over.
    const { game, cvars } = page(wire, (store) => store.set('sv_maxclients', '12'));

    await enter(wire, game);
    expect(serverInfo(game.configstring(CONFIGSTRING.SERVERINFO)).maxclients).toBe(12);

    // A change after the boot crosses too, and the serverinfo moves at the next frame.
    cvars.set('sv_maxclients', '16');
    for (let i = 0; i < 4; i++) await wire.step(game);
    expect(serverInfo(game.configstring(CONFIGSTRING.SERVERINFO)).maxclients).toBe(16);
    // The worker's store took it from the page, and does not tell it back.
    expect(cvarsTold(wire, 'worker')).not.toContainEqual({
      type: 'cvar',
      name: 'sv_maxclients',
      value: '16'
    });
  });

  it("waits one game frame between the worker's frames, as the page's sv_fps stands", async () => {
    const wire = boundary();
    // Before the boot there is no host, and the wait is the default frame.
    expect(wire.frameMsec()).toBe(8);
    const { game, cvars } = page(wire);
    await enter(wire, game);
    expect(wire.frameMsec()).toBe(8);

    cvars.set('sv_fps', '40');
    await wire.settle();
    expect(wire.frameMsec()).toBe(25);
  });

  it('waits only the rest of the frame, so a coarse timer keeps the cadence', async () => {
    const wire = boundary();
    const { game } = page(wire);
    await enter(wire, game);

    // A 10 ms frame against 8 ms frames leaves 2 ms on the accumulator: 6 to the next frame.
    await wire.step(game, 10);
    expect(wire.waitMsec(0)).toBe(6);
    // The time already spent running the next frame comes off too, so a late wake catches up.
    expect(wire.waitMsec(2.5)).toBe(3.5);
    // A frame that lands back on the grid waits the whole frame.
    await wire.step(game, 6);
    expect(wire.waitMsec(0)).toBe(8);
  });

  it("holds the world while the page's cl_paused says so, and lets it go", async () => {
    const wire = boundary();
    const { game, cvars } = page(wire);
    await enter(wire, game);

    cvars.set('cl_paused', '1');
    await wire.step(game);
    expect(game.channel.svPaused).toBe(true);

    const held = game.serverTime;
    for (let i = 0; i < 2; i++) await wire.step(game);
    expect(game.serverTime).toBe(held);

    cvars.set('cl_paused', '0');
    for (let i = 0; i < 3; i++) await wire.step(game);
    expect(game.serverTime).toBeGreaterThan(held);
  });

  it('runs a console line on the server and prints its answer back', async () => {
    const wire = boundary();
    const { game, printed, asked } = page(wire);
    await enter(wire, game);

    game.consoleCommand('map nope\n');
    for (let i = 0; i < 2; i++) await wire.step(game);

    // `SV_Map_f`'s check reads the listing the page handed over, and a typo prints — it
    // does not drop the match.
    expect(printed).toContain("Can't find map maps/nope.bsp");
    expect(asked).toEqual([]);
    expect(game.connection.state).toBe(CA.ACTIVE);
  });

  it("loads a BSP the console asks for, its file moved to the worker rather than copied", async () => {
    const wire = boundary();
    const { game, asked, loaded } = page(wire, undefined, undefined, (name) =>
      name === 'cube' ? cubeData(name) : mapData(name)
    );
    await enter(wire, game);

    game.consoleCommand('map cube\n');
    for (let i = 0; i < 60 && !loaded.includes('cube'); i++) await wire.step(game);
    for (let i = 0; i < 60 && game.connection.state !== CA.ACTIVE; i++) await wire.step(game);

    expect(asked).toEqual(['cube']);
    expect(infoValueForKey(game.configstring(CONFIGSTRING.SERVERINFO), 'mapname')).toBe('cube');
    expect(game.channel.failure).toBeNull();
    const answer = wire.moved.find((entry) => (entry.message as { type: string }).type === 'map');
    const { data } = answer!.message as { data: HostMapData };
    expect(data.kind).toBe('bsp');
    expect(answer!.transfer).toEqual([(data as { bsp: ArrayBuffer }).bsp]);
  });

  it("stops the server as it starts on a map collision refuses, in Q3's words", async () => {
    const wire = boundary();
    const refused = buildBsp({ [LUMP_BRUSHES]: int32s(0, 0, 3) });
    const { game } = page(wire, undefined, undefined, (name) => ({
      kind: 'bsp',
      name,
      bsp: refused.slice().buffer
    }));
    await wire.settle();

    expect(game.channel.failure?.message).toBe('CMod_LoadBrushes: bad shaderNum: 3');
  });

  it("stops the server on a map collision refuses mid-match, as the load's ERR_DROP", async () => {
    const wire = boundary();
    const refused = buildBsp({ [LUMP_BRUSHES]: int32s(0, 0, 3) });
    const { game } = page(wire, undefined, undefined, (name) =>
      name === 'cube' ? { kind: 'bsp', name, bsp: refused.slice().buffer } : mapData(name)
    );
    await enter(wire, game);

    game.consoleCommand('map cube\n');
    for (let i = 0; i < 60 && game.channel.failure === null; i++) await wire.step(game);
    expect(game.channel.failure?.message).toBe('CMod_LoadBrushes: bad shaderNum: 3');
  });

  it("builds a BSP with the page's collision cvars, and prints collision's warnings", async () => {
    const spot = `${mapOf(spawnSpot(vec3(32, 32, 40)))}\0`;
    const patch = (name: string): HostMapData => ({
      kind: 'bsp',
      name,
      bsp: bspFile(name === 'cube' ? bowtieBsp(spot) : patchBsp({ entityString: spot }))
        .slice()
        .buffer
    });
    /**
     * Where the player is a quarter of a second after entering, running forward over the patch as
     * every step of the harness runs.
     */
    const standing = async (noCurves: string) => {
      const wire = boundary();
      const { game, printed } = page(
        wire,
        (cvars) => cvars.load('cm_noCurves', noCurves),
        undefined,
        patch
      );
      await enter(wire, game);
      for (let i = 0; i < 30; i++) await wire.step(game);
      const { ps } = game.snapshot(game.currentSnapshotNumber())!;
      return { ps, game, wire, printed };
    };
    // The player lands on the patch; under `cm_noCurves`, the player falls through it. The patch is
    // slick, and a run on a slick floor rises a little each tick by the clip's overbounce.
    const on = (await standing('0')).ps;
    expect(on.groundEntityNum).toBe(ENTITYNUM_WORLD);
    expect(on.origin.z).toBeCloseTo(24.125, 2);
    const through = (await standing('1')).ps;
    expect(through.origin.z).toBeLessThan(24);
    expect(through.groundEntityNum).toBe(ENTITYNUM_NONE);

    const { game, wire, printed } = await standing('0');
    game.consoleCommand('map cube\n');
    for (let i = 0; i < 60 && !printed.some((line) => line.includes('CM_GridPlane')); i++) {
      await wire.step(game);
    }
    expect(printed.filter((line) => line.includes('CM_GridPlane'))).toHaveLength(4);
  });

  it('loads a map the console asks for on both sides, the page reading it', async () => {
    const wire = boundary();
    const { game, asked, loaded } = page(wire);
    await enter(wire, game);

    game.consoleCommand('map other\n');
    // The mirror the client's own frames wait on: the server's load, as the channel carries it,
    // and the promise that settles when the load is done.
    for (let i = 0; i < 20 && game.mapLoad === null; i++) await wire.step(game);
    const serverLoad = game.mapLoad;
    expect(serverLoad).not.toBeNull();

    for (let i = 0; i < 60 && !loaded.includes('other'); i++) await wire.step(game);

    // The worker asked, the page read it, and the client was given the new gamestate.
    expect(asked).toEqual(['other']);
    expect(loaded).toContain('other');
    for (let i = 0; i < 60 && game.connection.state !== CA.ACTIVE; i++) await wire.step(game);
    expect(infoValueForKey(game.configstring(CONFIGSTRING.SERVERINFO), 'mapname')).toBe('other');
    await serverLoad!;
    expect(game.mapLoad).toBeNull();
  });

  it("reads the worker's own state, which the mirrors cannot carry", async () => {
    const wire = boundary();
    const { game, channel } = page(wire);
    await enter(wire, game);

    const asked = channel.dev({ op: 'state' })!;
    await wire.settle();
    const state = await asked;
    expect(state.map).toBe('garage');
    expect(state.entities).toBeGreaterThan(0);
    expect(state.svRunning).toBe(true);
    expect(state.svPaused).toBe(false);
    expect(state.clients).toBeGreaterThan(0);

    // The host's clock is the worker's: a frame there moves it, and the page's own reads cannot
    // see it.
    await wire.step(game);
    const later = channel.dev({ op: 'state' })!;
    await wire.settle();
    expect((await later).hostTime).toBeGreaterThan(state.hostTime);
  });

  it('moves a cvar where the worker reads it, and the mirror follows', async () => {
    const wire = boundary();
    const { game, channel } = page(wire);
    await enter(wire, game);
    expect(game.channel.svRunning).toBe(true);

    // `sv_running` set in the worker's own store: the server's own reading, then the mirror the
    // menu's rows read.
    const asked = channel.dev({ op: 'cvar', name: 'sv_running', value: '0' })!;
    await wire.settle();
    expect((await asked).svRunning).toBe(false);

    await wire.step(game);
    expect(game.channel.svRunning).toBe(false);
  });

  it("holds what the worker's store sets itself, and sends none of it back", async () => {
    const wire = boundary();
    const { game, channel, cvars } = page(wire);
    await enter(wire, game);

    // The server's and the game's own writes as the map started: the page's store holds them, as
    // Quake 3's one store does, the worldspawn's gravity among them.
    expect(cvars.get('mapname')).toBe('garage');
    expect(cvars.get('sv_running')).toBe('1');
    expect(cvars.get('g_gravity')).toBe('800');
    // `sv_cheats` is the server's, and read-only to the page's console as the systeminfo makes it,
    // though the worker's store told it first.
    expect(cvars.set('sv_cheats', '0')).toBe(false);

    const asked = channel.dev({ op: 'cvar', name: 'g_gravity', value: '400' })!;
    await wire.settle();
    await asked;
    expect(cvars.get('g_gravity')).toBe('400');

    // None of it went back: the page never set it, so nothing named it on the way to the worker.
    await wire.step(game);
    expect(cvarsTold(wire, 'page').map(({ name }) => name)).not.toContain('g_gravity');
  });

  it("leaves the game's rules to the page's console, and predicts by them once sent", async () => {
    const wire = boundary();
    const { game, cvars } = page(wire);
    await enter(wire, game);
    expect(game.rules.pmove_JumpVelocity).toBe(270);

    // The game registered its rules in the worker's store, which the page now holds as Quake 3's
    // one store holds qagame's: the console's to set, a preset's `seta` among them, though the
    // systeminfo carries them.
    expect(cvars.get('pmove_JumpVelocity')).toBe('270');
    expect(cvars.set('pmove_JumpVelocity', '275', true)).toBe(true);
    expect(cvars.set('weapon_reload_rg', '1250', true)).toBe(true);

    for (let i = 0; i < 4; i++) await wire.step(game);
    const systeminfo = game.configstring(CONFIGSTRING.SYSTEMINFO);
    expect(infoValueForKey(systeminfo, 'pmove_JumpVelocity')).toBe('275');
    expect(infoValueForKey(systeminfo, 'weapon_reload_rg')).toBe('1250');
    // The client predicts by what its server sent back, as a client elsewhere does.
    expect(game.rules.pmove_JumpVelocity).toBe(275);
    expect(game.rules.weapon_reload_rg).toBe(1250);
    // The file keeps them as the game spells them.
    expect(cvars.archived()).toContainEqual({ name: 'pmove_JumpVelocity', value: '275' });
  });

  it('counts a page change to a cvar no setting names, and hears the answer', async () => {
    const wire = boundary();
    const { game, cvars } = page(wire);
    await enter(wire, game);
    expect(cvars.get('g_needpass')).toBe('0');

    // `CheckCvars` reads `g_password` by its count in the worker's store, and sets
    // `g_needpass` there, which the page's store then holds.
    cvars.set('g_password', 'secret');
    for (let i = 0; i < 2; i++) await wire.step(game);
    expect(cvars.get('g_needpass')).toBe('1');
  });

  it("asks for Start Server's side again once the game spent it, and is seated", async () => {
    const wire = boundary();
    // A team game as Start Server leaves one: the side asked for, then the map.
    const { game, cvars, loaded } = page(wire, (store) => {
      store.set('g_gametype', String(GT.TEAM));
      store.set('g_localTeamPref', 'red');
    });
    /** The client's team, once the server has seated it as it asked, or as it stands after. */
    const seated = async (team: number): Promise<number> => {
      for (let i = 0; i < 60 && game.connection.state !== CA.ACTIVE; i++) await wire.step(game);
      const current = () => game.snapshot(game.currentSnapshotNumber())!.ps.persistant[PERS.TEAM];
      for (let i = 0; i < 30 && current() !== team; i++) await wire.step(game);
      return current();
    };
    /** `map <n>`, and the frames until the client is loading it. */
    const map = async (name: string): Promise<void> => {
      const loads = loaded.length;
      game.consoleCommand(`map ${name}\n`);
      for (let i = 0; i < 60 && loaded.length === loads; i++) await wire.step(game);
    };

    expect(await seated(TEAM.RED)).toBe(TEAM.RED);
    // The game spent it in the worker's store, and the page's holds it spent.
    expect(cvars.get('g_localTeamPref')).toBe('');

    // A free-for-all between, so the next team game starts every session over (`g_session.c:180`).
    cvars.set('g_gametype', String(GT.FFA));
    await map('other');
    expect(await seated(TEAM.FREE)).toBe(TEAM.FREE);

    // The same side asked for again is a change on the page, so it reaches the game.
    cvars.set('g_gametype', String(GT.TEAM));
    cvars.set('g_localTeamPref', 'red');
    await map('garage');
    expect(await seated(TEAM.RED)).toBe(TEAM.RED);
  });

  it('puts a client where a live check asks, facing its way, with no jump drawn', async () => {
    const wire = boundary();
    const { game, channel } = page(wire, undefined, undefined, cubeData);
    await enter(wire, game);
    const bit = game.snapshot(game.currentSnapshotNumber())!.ps.eFlags & EF_TELEPORT_BIT;

    const asked = channel.dev({
      op: 'place',
      client: game.clientNum,
      origin: vec3(16, -16, 100),
      angles: vec3(0, 90, 0)
    })!;
    await wire.settle();
    await asked;
    let { ps } = game.snapshot(game.currentSnapshotNumber())!;
    for (let i = 0; i < 30 && (ps.eFlags & EF_TELEPORT_BIT) === bit; i++) {
      await wire.step(game);
      ({ ps } = game.snapshot(game.currentSnapshotNumber())!);
    }

    // The first snapshot after: the bit flipped, the view turned, and the player a frame's run
    // along it from where they were put.
    expect(ps.eFlags & EF_TELEPORT_BIT).not.toBe(bit);
    expect(ps.viewangles.y).toBe(90);
    expect(ps.origin.x).toBeCloseTo(16, 3);
    expect(ps.origin.y).toBeGreaterThanOrEqual(-16);
    expect(ps.origin.y).toBeLessThan(0);
  });

  it('stands where a frame throws, and tells the page as a failed load does', async () => {
    const wire = boundary();
    const { game, channel } = page(wire);
    await enter(wire, game);
    const runFrame = vi.spyOn(Game.prototype, 'runFrame').mockImplementationOnce(() => {
      throw new Error('boom');
    });

    try {
      await wire.step(game);
      expect(game.failure?.message).toBe('boom');
      expect(wire.errors.map((err) => err.message)).toEqual(['boom']);

      // The program runs no more frames, as the page drops the match.
      const calls = runFrame.mock.calls.length;
      const asked = channel.dev({ op: 'state' })!;
      await wire.settle();
      const { hostTime } = await asked;
      for (let i = 0; i < 3; i++) await wire.step(game);
      const later = channel.dev({ op: 'state' })!;
      await wire.settle();
      expect((await later).hostTime).toBe(hostTime);
      expect(runFrame.mock.calls.length).toBe(calls);
    } finally {
      runFrame.mockRestore();
    }
  });

  it('stops the program on shutdown, and the worker lets its scope go', async () => {
    const wire = boundary();
    const { game, printed } = page(wire);
    await enter(wire, game);

    game.shutdown('Server disconnected');
    await wire.settle();
    expect(wire.closed()).toBe(true);
    // The page's reason is the one the program's clients are told.
    expect(printed).toContain('----- Server Shutdown (Server disconnected) -----');

    await wire.step(game);
    expect(game.channel.svRunning).toBe(false);
  });
});

describe('the page hosting players elsewhere', () => {
  /**
   * A tab whose server is at 203.0.113.9 through the master on this machine, which both slots
   * name, and whose own client is in the world. The masters' frame runs when the test ticks.
   */
  async function hosting(channels = true, setup: (cvars: Cvars) => void = () => {}) {
    const wire = boundary(channels);
    const master = new FakeMaster('localhost');
    const rtc = new FakeRtc();
    const urls: string[] = [];
    let tick: (() => void) | null = null;
    const slots = (cvars: Cvars) => {
      cvars.set('sv_master1', 'localhost');
      cvars.set('sv_master2', 'localhost');
      setup(cvars);
    };
    const tab = page(wire, slots, {
      createPeerConnection: rtc.create,
      connect: (url) => {
        urls.push(url);
        return master.connect('203.0.113.9');
      },
      locks: null,
      schedule: (frame) => {
        tick = frame;
        return () => {};
      }
    });
    await enter(wire, tab.game);
    await settle();
    return { wire, master, rtc, urls, tick: () => tick?.(), ...tab };
  }

  /** A player at 198.51.100.4, at the same master, on the tab's clock. */
  async function player(rig: Awaited<ReturnType<typeof hosting>>) {
    const peer = fakePeer(rig.master, rig.rtc.create, '198.51.100.4', {
      dials: true,
      now: () => rig.wire.clock()
    });
    const cvars = testCvars({ net_qport: '7' });
    const now = () => rig.wire.clock();
    const net = new Net({ cvars, socket: peer.socket, now, print: () => {} });
    const connection = new ClientConnection(cvars);
    connection.userinfo = '\\name\\Visitor';
    await settle();
    /** A frame of the player's, then one of the tab's, and whatever was in flight landed. */
    const step = async () => {
      for (let p; (p = net.getPacket()) !== null; ) connection.packetEvent(p.from, p.data);
      connection.clock.realtime += PMOVE_MSEC;
      connection.setCGameTime();
      connection.sendCmd(createNetUserCmd());
      connection.checkForResend();
      await settle();
      await rig.wire.step(rig.game);
      await settle();
    };
    return { peer, net, connection, step };
  }

  it("registers the tab's server with its master, one connection for both slots", async () => {
    const { urls, printed } = await hosting();
    expect(urls).toEqual(['ws://localhost:27950']);
    expect(printed).toContain('Registered with localhost as 203.0.113.9:27960');
  });

  it('heartbeats as soon as its link opens again, when listed on the Internet', async () => {
    const rig = await hosting(true, (cvars) => cvars.set('dedicated', '2'));
    const heartbeats = () =>
      rig.master.datagrams.filter(({ data }) => text(data).endsWith('heartbeat DarkPlaces\n'));
    const before = heartbeats().length;
    expect(before).toBeGreaterThan(0);

    rig.master.restart();
    await settle();
    // The page tries the master again 3 s on, at its masters' next tick.
    for (let waited = 0; waited < RETRY_MSEC; waited += 100) await rig.wire.step(rig.game, 100);
    rig.tick();
    await settle();
    await rig.wire.step(rig.game);
    await settle();

    expect(rig.master.read('register')).toHaveLength(2);
    expect(heartbeats()).toHaveLength(before + 1);
  });

  it('lets a player elsewhere dial in and play, down a channel moved to the worker', async () => {
    const rig = await hosting();
    const { connection, net, step } = await player(rig);

    connection.connect(net, '203.0.113.9:27960', stringToAdr('203.0.113.9:27960')!);
    for (let i = 0; i < 300 && connection.state !== CA.ACTIVE; i++) await step();

    expect(connection.state).toBe(CA.ACTIVE);
    expect(connection.snapshots.snap.ps.clientNum).toBe(connection.clientNum);
    // The page answered the dial; the player's end and the tab's are the two connections.
    expect(rig.rtc.connections).toHaveLength(2);
    expect(rig.master.read('relay')).toHaveLength(0);
  });

  it('answers a query through the master as it lands in the worker, with no frame', async () => {
    const rig = await hosting();
    const { peer } = await player(rig);

    peer.socket.send(oob('getinfo abc'), netadr(NA.IP, '203.0.113.9', 27960));
    for (let i = 0; i < 4; i++) {
      await settle();
      await rig.wire.settle();
    }

    const answers = readAll(peer.socket).map((p) => text(p.data));
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatch(/^\xff\xff\xff\xffinfoResponse\n.*\\challenge\\abc/);
    expect(rig.rtc.connections).toEqual([]);
  });

  it("leaves the tab's own client for the worker's frame as a packet lands", async () => {
    const rig = await hosting();
    const { peer } = await player(rig);
    const packetEvent = vi.spyOn(Host.prototype, 'packetEvent');
    const handled = () => packetEvent.mock.calls.map(([from]) => from.type);

    try {
      for (let i = 0; i < 5; i++) rig.game.frame(PMOVE_MSEC, createUserCmd());
      await rig.wire.settle();
      peer.socket.send(oob('getinfo abc'), netadr(NA.IP, '203.0.113.9', 27960));
      for (let i = 0; i < 4; i++) {
        await settle();
        await rig.wire.settle();
      }
      expect(readAll(peer.socket)).toHaveLength(1);
      expect(handled()).toEqual([NA.IP]);

      await rig.wire.step(rig.game);
      expect(handled()).toContain(NA.LOOPBACK);
    } finally {
      packetEvent.mockRestore();
    }
  });

  it('stands where a packet that lands throws, as where a frame does', async () => {
    const rig = await hosting();
    const { peer } = await player(rig);
    const packetEvent = vi.spyOn(Host.prototype, 'packetEvent').mockImplementationOnce(() => {
      throw new Error('boom');
    });

    try {
      peer.socket.send(oob('getinfo abc'), netadr(NA.IP, '203.0.113.9', 27960));
      for (let i = 0; i < 4; i++) {
        await settle();
        await rig.wire.settle();
      }
    } finally {
      packetEvent.mockRestore();
    }
    expect(rig.game.failure?.message).toBe('boom');
    expect(rig.wire.errors.map((err) => err.message)).toEqual(['boom']);
  });

  it('tells a player elsewhere why the server went, before the page lets go', async () => {
    const rig = await hosting();
    const { connection, net, step } = await player(rig);
    connection.connect(net, '203.0.113.9:27960', stringToAdr('203.0.113.9:27960')!);
    for (let i = 0; i < 300 && connection.state !== CA.ACTIVE; i++) await step();
    while (connection.nextServerCommand() !== null);

    rig.game.shutdown('Server quit');
    await rig.wire.settle();
    await settle();

    for (let p; (p = net.getPacket()) !== null; ) connection.packetEvent(p.from, p.data);
    const heard: string[] = [];
    for (let c; (c = connection.nextServerCommand()) !== null; ) heard.push(c);
    expect(heard).toContain('disconnect "Server quit"');
    // Then the page let its connection go, and the player's went with the channel's close.
    expect(rig.rtc.connections.map((pc) => pc.connectionState)).toEqual(['closed', 'closed']);
  });

  it('tells a player elsewhere nothing when Com_Error ends the match', async () => {
    const rig = await hosting();
    const { connection, net, step } = await player(rig);
    connection.connect(net, '203.0.113.9:27960', stringToAdr('203.0.113.9:27960')!);
    for (let i = 0; i < 300 && connection.state !== CA.ACTIVE; i++) await step();
    while (connection.nextServerCommand() !== null);

    rig.game.shutdown('Server crashed: boom', true);
    await rig.wire.settle();
    await settle();

    for (let p; (p = net.getPacket()) !== null; ) connection.packetEvent(p.from, p.data);
    expect(connection.nextServerCommand()).toBeNull();
    expect(rig.printed).toContain('----- Server Shutdown (Server crashed: boom) -----');
  });

  it("lets another page's own client join, play, and hear why the server went", async () => {
    const rig = await hosting();
    const now = () => rig.wire.clock();
    const peer = fakePeer(rig.master, rig.rtc.create, '198.51.100.4', { dials: true, now });
    const cvars = new Cvars({ debugMode: true, print: () => {} });
    const net = new Net({ cvars, socket: peer.socket, now, print: () => {} });
    await settle();
    const game = new LocalGame({
      cvars,
      channel: new RemoteChannel(net),
      connect: { server: '203.0.113.9', address: stringToAdr('203.0.113.9')! },
      userinfo: '\\name\\Visitor'
    });
    /** A frame of the visitor's, then one of the tab's, and whatever was in flight landed. */
    const step = async () => {
      game.tick(createUserCmd());
      await settle();
      await rig.wire.step(rig.game);
      await settle();
    };
    for (let i = 0; i < 300 && game.connection.state !== CA.ACTIVE; i++) await step();
    expect(game.connection.state).toBe(CA.ACTIVE);
    expect(game.connection.snapshots.snap.ps.clientNum).toBe(game.clientNum);
    game.takeServerCommands();

    rig.game.shutdown('Server quit');
    await rig.wire.settle();
    await settle();
    game.tick(createUserCmd());
    expect(game.takeServerCommands()).toContain('disconnect "Server quit"');
  });

  it("closes the page's connection to a player who hangs up, as the worker lets go", async () => {
    const rig = await hosting();
    const { peer, connection, net, step } = await player(rig);
    connection.connect(net, '203.0.113.9:27960', stringToAdr('203.0.113.9:27960')!);
    for (let i = 0; i < 300 && connection.state !== CA.ACTIVE; i++) await step();
    const tab = rig.rtc.connections[1];
    expect(tab.connectionState).toBe('connected');

    peer.signalling.close();
    await settle();
    await rig.wire.settle();
    expect(tab.connectionState).toBe('closed');
  });

  it("opens nothing where the worker can't take a channel, and says so", async () => {
    const { urls, printed } = await hosting(false);
    expect(urls).toEqual([]);
    expect(printed.some((line) => line.startsWith("WARNING: this browser can't hand"))).toBe(true);
  });
});

describe('the page on a server elsewhere, then hosting its own', () => {
  it("predicts by each server's rules, and keeps the player's in its store and file", async () => {
    // A q3config.cfg that VQ3's preset saved, and the page's one store read from it.
    const vq3 = new GameConfig({ debugMode: true, print: () => {} });
    vq3.exec(shippedCfg('presets/vq3.cfg')!);
    const saved = vq3.text();
    // What the store warns of, and the warnings printed, a refused systeminfo key's among them.
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const print = (text: string) => {
      if (text.startsWith('WARNING')) warnings.push(text);
    };
    const config = new GameConfig({ config: saved, debugMode: true, print: warn });
    const held = () => SYSTEMINFO_RULES.map((name) => config.cvars.get(name));
    const own = held();
    /** The file's lines for what the systeminfo's record takes. */
    const ruleLines = (text: string) =>
      text.split('\n').filter((line) => isSysteminfoRecordKey(line.split(' ')[1] ?? ''));
    // Every rule, and the hook and the rewind, which are the player's settings too.
    expect(ruleLines(saved)).toHaveLength(SYSTEMINFO_RULES.length + 2);

    // A dedicated server elsewhere running CPM, with no hook, the preset run before its map.
    const network = new MemoryNetwork();
    const remote = new GameConfig({ debugMode: true, print: () => {} });
    remote.exec(shippedCfg('presets/cpm.cfg')!);
    remote.cvars.set('g_allowGrapple', '0');
    const now = () => network.now;
    const entities = mapOf(spawnSpot(vec3(0, 0, 16)));
    const program = new ServerProgram({
      cvars: remote.cvars,
      map: { name: 'garage', entities, trace: createFlatWorldTrace() },
      socket: network.socket('10.0.0.1'),
      random: () => 0,
      now
    });
    // The page joins it through its own socket, as `connect` does.
    const socket = network.socket('10.0.0.2');
    const net = new Net({ cvars: config.cvars, socket, now, print });
    const visit = new LocalGame({
      cvars: config.cvars,
      channel: new RemoteChannel(net),
      connect: { server: '10.0.0.1', address: stringToAdr('10.0.0.1')! }
    });
    for (let i = 0; i < 100 && visit.connection.state !== CA.ACTIVE; i++) {
      network.advance(PMOVE_MSEC);
      visit.tick(createUserCmd());
      program.runFrame(PMOVE_MSEC);
    }
    expect(visit.connection.state).toBe(CA.ACTIVE);
    expect(visit.rules.pmove_JumpVelocity).toBe(275);
    expect(visit.rules.pmove_AirControl).toBe(1);
    expect(visit.rules.weapon_reload_rg).toBe(1250);
    expect(visit.grappleMode).toBeNull();
    expect(held()).toEqual(own);
    expect(config.cvars.get('g_allowGrapple')).toBe('1');
    expect(warnings).toEqual([]);

    visit.shutdown('');
    expect(held()).toEqual(own);
    expect(ruleLines(config.text())).toEqual(ruleLines(saved));

    // Then the tab hosts, its worker booted from the same store, as each match on the page is.
    const wire = boundary();
    const channel = new WorkerChannel({
      cvars: config.cvars,
      maps: { names: () => ['garage'], read: async (name) => mapData(name) },
      boot: { map: mapData('garage'), botFiles: [], debugMode: true },
      print,
      now: () => wire.clock(),
      worker: wire.worker
    });
    const home = new LocalGame({
      cvars: config.cvars,
      channel,
      clientLoader: { load: async (name: string): Promise<ClientMap> => ({ name }) }
    });
    await enter(wire, home);
    const systeminfo = home.configstring(CONFIGSTRING.SYSTEMINFO);
    expect(infoValueForKey(systeminfo, 'pmove_JumpVelocity')).toBe('270');
    expect(home.rules).toMatchObject(
      Object.fromEntries(SYSTEMINFO_RULES.map((name) => [name, ID_RULES[name]]))
    );
    expect(home.grappleMode).not.toBeNull();
    expect(held()).toEqual(own);
    expect(ruleLines(config.text())).toEqual(ruleLines(saved));
    expect(warnings).toEqual([]);
  });
});

/** An out-of-band datagram. */
function oob(line: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(`\xff\xff\xff\xff${line}`, (c) => c.charCodeAt(0));
}

/** A datagram as text. */
function text(data: Uint8Array): string {
  return String.fromCharCode(...data);
}

/** Everything waiting at a socket. */
function readAll(socket: { receive(): NetPacket | null }): NetPacket[] {
  const packets: NetPacket[] = [];
  for (let p; (p = socket.receive()) !== null; ) packets.push(p);
  return packets;
}

/** The patch map with its points as a bowtie, whose cells' triangles have no plane. */
function bowtieBsp(entityString: string) {
  const bowtie = [0, 0, 0, 32, 0, 0, 64, 0, 0, 0, 32, 0, 16, 16, 0, 32, 0, 0, 0, 64, 0, 0, 32, 0];
  const bsp = patchBsp({ entityString });
  bsp.drawVerts.xyz = Float32Array.from([...bowtie, 0, 0, 0]);
  return bsp;
}
