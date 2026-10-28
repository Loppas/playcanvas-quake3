import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MasterServer } from '../../master/master-server';
import { MASTER_ADR, masterPeer, oob, readList } from '../../master/master-test-fixtures';
import { CONFIGSTRING, SNAPFLAG } from '../net/commands';
import { CA, ClientConnection } from '../net/connection';
import type { CvarStore } from '../net/cvar';
import { infoPairs, infoValueForKey, MAX_INFO_STRING } from '../net/info';
import { MAX_MSGLEN, Message } from '../net/msg';
import { compareBaseAdr, isOutOfBand, NA, Net, netadr, stringToAdr } from '../net/net';
import { MemoryNetwork, testCvars } from '../net/net-test-fixtures';
import { FakeMaster, FakeRtc, fakePeer, settle } from '../net/peer-test-fixtures';
import {
  createNetUserCmd,
  createPlayerState,
  ENTITYNUM_NONE,
  ENTITYNUM_WORLD,
  type NetUserCmd,
  type PlayerState
} from '../net/protocol';
import { box, createBoxWorldTrace } from '../sim/box-world';
import { createGameClient } from '../sim/client';
import { loadMap } from '../sim/cm/cm-load';
import { areasConnected } from '../sim/cm/cm-test';
import {
  clipBsp,
  cubeBsp,
  STRIP_WIDTH,
  stripsBsp,
  type Strip
} from '../sim/cm/collision-test-fixtures';
import { Cvars } from '../settings/cvars';
import { CONTENTS, MASK, PERS, SURFACE_CLIP_EPSILON } from '../sim/constants';
import { ET, SVF, type GameEntity } from '../sim/game-entity';
import type { GameModule } from '../sim/game-module';
import { Level } from '../sim/level';
import { playerBounds, type PointContentsFn, type TraceFn } from '../sim/types';
import { traceShot } from '../sim/weapons/hitscan';
import { copy, vec3, type Vec3 } from '../sim/vec3';
import { CS, HOST_COMMANDS, Host, SS, type HostOptions } from './host';
import {
  connectLocal,
  connectRemote,
  drain,
  fixtureHost,
  fixtureNet,
  readPackets,
  runQueued,
  sendCommands,
  sendMove
} from './host-test-fixtures';

/** The cvars, which the host and the game module share one of. */
function store(initial: Record<string, string> = {}): CvarStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  const counts = new Map<string, number>();
  let total = 0;
  const set = (name: string, value: string) => {
    if ((values.get(name) ?? '') === value) return;
    values.set(name, value);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    total++;
  };
  return {
    values,
    get: (name) => values.get(name) ?? '',
    set,
    setServer: (name, value) => {
      set(name, value);
      return true;
    },
    modificationCount: (name) => counts.get(name) ?? 0,
    totalModifications: () => total
  };
}

/**
 * A game module that does as little as a game module can.
 *
 * It is the match from the previous stage with clients attached: a connecting client gets a player
 * state, a beginning client gets a body in the world, and a thinking client moves. That is enough
 * for the host to have something to send, and small enough that a failing test is about the host.
 */
class TestGame implements GameModule {
  readonly level = new Level({ maxclients: 4 });

  readonly calls: string[] = [];
  /** Each client command's arguments, as the host handed them over. */
  readonly commands: (readonly string[])[] = [];
  thinks = 0;
  frames = 0;

  private readonly host: Host;

  constructor(host: Host) {
    this.host = host;
  }

  init(levelTime: number, _randomSeed: number, restart: boolean): void {
    this.calls.push(`init ${levelTime} ${restart}`);
    this.level.time = levelTime;
  }

  shutdown(restart: boolean): void {
    this.calls.push(`shutdown ${restart}`);
  }

  clientConnect(clientNum: number, firstTime: boolean, isBot: boolean): string | null {
    this.calls.push(`connect ${clientNum} ${firstTime}${isBot ? ' bot' : ''}`);
    const client = createGameClient();
    client.ps.clientNum = clientNum;
    this.level.gentities[clientNum].client = client;
    return null;
  }

  clientBegin(clientNum: number): void {
    this.calls.push(`begin ${clientNum}`);
    const entity = this.level.gentities[clientNum];
    entity.inuse = true;
    entity.classname = 'player';
    entity.s.eType = ET.PLAYER;
    entity.s.clientNum = clientNum;
    this.host.linkEntity(entity);
  }

  clientUserinfoChanged(clientNum: number): void {
    this.calls.push(`userinfo ${clientNum}`);
  }

  clientDisconnect(clientNum: number): void {
    this.calls.push(`disconnect ${clientNum}`);
  }

  clientCommand(clientNum: number, argv: readonly string[]): void {
    this.calls.push(`command ${clientNum} ${argv.join(' ')}`);
    this.commands.push(argv);
  }

  clientThink(clientNum: number): void {
    this.thinks++;
    const cmd = this.host.getUserCmd(clientNum);
    const player = this.playerState(clientNum);
    player.commandTime = cmd.serverTime;
    player.origin.x += 1;
    this.level.gentities[clientNum].s.origin.x = player.origin.x;
  }

  /** Each game frame's time, and how many of {@link calls} had been made before it. */
  readonly frameLog: { time: number; calls: number }[] = [];

  runFrame(levelTime: number): void {
    this.frames++;
    this.frameLog.push({ time: levelTime, calls: this.calls.length });
    this.level.runFrame(levelTime);
  }

  consoleCommand(command: string): boolean {
    this.calls.push(`console ${command}`);
    return false;
  }

  /** The bots' frames: the time each was run at, and how many game frames had run before it. */
  readonly botFrames: { time: number; frames: number }[] = [];

  botAIStartFrame(time: number): void {
    this.botFrames.push({ time, frames: this.frames });
  }

  entity(number: number): GameEntity {
    return this.level.gentities[number];
  }

  numEntities(): number {
    return this.level.numEntities;
  }

  playerState(clientNum: number): PlayerState {
    const client = this.level.gentities[clientNum].client;
    if (client === null) throw new Error(`no player state for client ${clientNum}`);
    return client.ps;
  }

  /** The board, which a test sets. */
  board = 'scores 0 0 0';

  scoreboardMessage(): string {
    return this.board;
  }
}

interface Fixture {
  host: Host;
  game: TestGame;
  cvars: ReturnType<typeof store>;
}

function makeHost(
  options: Partial<Omit<HostOptions, 'game'>> = {},
  trace?: TraceFn,
  pointContents?: PointContentsFn
): Fixture {
  let game!: TestGame;
  const cvars = options.cvars ?? store();
  const host = new Host({
    ...options,
    cvars,
    maxclients: options.maxclients ?? 4,
    // A net the fixtures can move time on, so a message a client's rate paces drains.
    net: options.net ?? fixtureNet(cvars),
    game: (h) => {
      game = new TestGame(h);
      return game;
    }
  });
  host.spawnServer({ name: 'test', entities: '', trace, pointContents });
  return { host, game, cvars: cvars as ReturnType<typeof store> };
}

/** A frame long enough that a client is due its next snapshot, at its own rate. */
function snapshotFrame(host: Host, clientNum = 0): number {
  return host.clients[clientNum].snapshotMsec + host.frameMsec;
}

function moveCmd(serverTime: number): NetUserCmd {
  const cmd = createNetUserCmd();
  cmd.serverTime = serverTime;
  cmd.forwardmove = 127;
  return cmd;
}

function lastMessageSize(host: Host, clientNum = 0): number {
  const client = host.clients[clientNum];
  return client.frames[(client.netchan.outgoingSequence - 1) & 31].messageSize;
}

/** A box that holds every place the tests link anything. */
const EVERYWHERE = [vec3(-4000, -4000, -4000), vec3(4000, 4000, 4000)] as const;

/**
 * A cube of an entity, 15 each way, at `x` on the x axis, linked by the host.
 *
 * @param number - The entity, or a new one.
 * @returns its number
 */
function linkCube(host: Host, game: TestGame, x: number, number?: number): number {
  const entity = number === undefined ? game.level.spawnEntity() : game.level.gentities[number];
  entity.r.mins = vec3(-15, -15, -15);
  entity.r.maxs = vec3(15, 15, 15);
  entity.r.currentOrigin = vec3(x, 0, 0);
  host.linkEntity(entity);
  return entity.s.number;
}

/** A clip map of two areas, 0 up to x {@link STRIP_WIDTH} and 1 past it, a portal between. */
function portalMap() {
  const strips = [
    { cluster: 0, area: 0 },
    { cluster: 1, area: 1 }
  ];
  return loadMap(stripsBsp(strips), 'maps/q.bsp');
}

describe('the commands the game module asks the host for', () => {
  it('runs them at the start of the next frame, not in the one that asked', () => {
    const { host, game } = makeHost();

    host.sendConsoleCommand('map_restart 0\n');
    expect(host.commandQueue).toEqual(['map_restart 0']);
    expect(host.commandsPending).toBe(true);
    expect(game.calls).not.toContain('shutdown true');

    host.runFrame(8);

    expect(host.commandQueue).toEqual([]);
    expect(host.commandsPending).toBe(false);
    expect(game.calls).toContain('shutdown true');
  });

  it('runs each of those it has a console send it, whatever its case, and hands the game none', () => {
    const { host, game } = makeHost();

    for (const name of HOST_COMMANDS) host.sendConsoleCommand(`${name.toUpperCase()}\n`);
    host.runFrame(8);

    expect(game.calls.filter((call) => call.startsWith('console '))).toEqual([]);
  });

  it('hands one it has no answer for to the game module', () => {
    const { host, game } = makeHost();

    host.sendConsoleCommand('addbot sarge 3\n');
    host.runFrame(8);

    expect(game.calls).toContain('console addbot sarge 3');
  });

  it('runs a vstr in front of whatever was queued behind it', () => {
    const { host, game, cvars } = makeHost();
    cvars.set('d1', 'first');

    host.sendConsoleCommand('vstr d1\n');
    host.sendConsoleCommand('second\n');
    host.runFrame(8);

    expect(game.calls.filter((call) => call.startsWith('console '))).toEqual([
      'console first',
      'console second'
    ]);
  });

  it('leaves nextmap at the literal a map load sets it to, which is this map again', () => {
    const { cvars } = makeHost();

    expect(cvars.get('nextmap')).toBe('map_restart 0');
  });
});

describe('a map_restart', () => {
  it('waits five seconds when nobody said how long, and counts it down on the warmup string', () => {
    const { host } = makeHost();

    host.sendConsoleCommand('map_restart\n');
    host.runFrame(8);

    // Five seconds on from the clock's 400, where a match starts.
    expect(host.restartTime).toBe(5400);
    expect(host.getConfigstring(CONFIGSTRING.WARMUP)).toBe('5400');
  });

  it('empties the world for the game that starts again, where Quake 3 keeps the old slots', () => {
    const { host, game } = makeHost();
    linkCube(host, game, 0);

    host.mapRestart(0);

    expect(game.calls).toContain('shutdown true');
    expect(host.entitiesInBox(...EVERYWHERE)).toEqual([]);
  });

  it('drops the delay in a warmup, which is counting down to one of its own', () => {
    const { host, game } = makeHost({ cvars: store({ g_doWarmup: '1' }) });

    host.sendConsoleCommand('map_restart 5\n');
    host.runFrame(8);

    expect(host.restartTime).toBe(0);
    expect(game.calls).toContain('shutdown true');
  });

  it('is asked for by the frame the delay runs out in, and run by the frame after', () => {
    const { host, game } = makeHost();
    host.sendConsoleCommand('map_restart 5\n');
    host.runFrame(8);
    host.runFrame(5000);
    game.frames = 0;
    game.calls.length = 0;

    // The frame that finds the time has come does nothing else at all: the world it would run is
    // about to be replaced.
    host.runFrame(8);
    expect(host.restartTime).toBe(0);
    expect(host.commandQueue).toEqual(['map_restart 0']);
    expect(game.frames).toBe(0);

    host.runFrame(8);
    expect(game.calls).toContain('shutdown true');
  });

  it('connects everyone again without the first-time flag, and tells them it happened', () => {
    const { host, game } = makeHost();
    const clientNum = connectLocal(host);
    host.clientEnterWorld(clientNum, null);
    game.calls.length = 0;

    host.mapRestart(0);

    expect(game.calls).toEqual(['shutdown true', 'init 400 true', 'connect 0 false', 'begin 0']);
    expect(host.clients[clientNum].state).toBe(CS.ACTIVE);
    expect(host.clients[clientNum].reliableCommands).toContain('map_restart\n');
  });

  it('keeps the command a playing client was moving on and clears one still loading', () => {
    const { host } = makeHost();
    const playing = connectLocal(host);
    host.clientEnterWorld(playing, moveCmd(40));
    const loading = connectRemote(host, '\\name\\Grunt');
    host.clients[loading].lastUsercmd = moveCmd(99);

    host.mapRestart(0);

    expect(host.getUserCmd(playing)).toEqual(moveCmd(40));
    expect(host.getUserCmd(loading)).toEqual(createNetUserCmd());
  });

  it("keeps every configstring the game set, the shader swaps' among them", () => {
    const { host } = makeHost();
    host.setConfigstring(CONFIGSTRING.SHADERSTATE, 'a=b: 0.30@');

    host.mapRestart(0);
    expect(host.getConfigstring(CONFIGSTRING.SHADERSTATE)).toBe('a=b: 0.30@');
  });

  it('happens once however many were asked for in the same frame', () => {
    const { host, game } = makeHost();
    host.sendConsoleCommand('map_restart 0\n');
    host.sendConsoleCommand('map_restart 0\n');

    host.runFrame(8);

    expect(game.calls.filter((call) => call === 'shutdown true')).toHaveLength(1);
  });

  it('loads the map again instead when a latched cvar changed under the match', () => {
    const { host, game, cvars } = makeHost();
    cvars.set('g_gametype', '1');
    game.calls.length = 0;

    host.mapRestart(0);

    // A load, not a restart: the game module is told `restart` is false, which is what lets it
    // read the new value and start the warmup over.
    expect(game.calls).toEqual(['shutdown false', 'init 0 false']);
  });

  it("keeps the map's portals as they stand, and a load shuts them", () => {
    const { host, game, cvars } = makeHost();
    const clipMap = portalMap();
    host.spawnServer({ name: 'next', entities: '', clipMap });
    host.adjustAreaPortalState(game.entity(linkCube(host, game, STRIP_WIDTH)), true);

    host.mapRestart(0);
    expect(Array.from(clipMap.areaPortals)).toEqual([0, 1, 1, 0]);

    host.runFrame(8);
    cvars.set('g_gametype', '1');
    host.mapRestart(0);
    expect(Array.from(clipMap.areaPortals)).toEqual([0, 0, 0, 0]);
    expect(areasConnected(clipMap, 0, 1)).toBe(false);
  });

  it('sends no configstring across that load, because the gamestate carries them all', () => {
    const { host, cvars } = makeHost();
    const clientNum = connectLocal(host);
    host.clientEnterWorld(clientNum, null);
    const before = host.clients[clientNum].reliableSequence;

    cvars.set('g_gametype', '1');
    host.mapRestart(0);

    expect(host.clients[clientNum].reliableSequence).toBe(before);
    // The client waits for the gamestate rather than being put straight back in the world.
    expect(host.clients[clientNum].state).toBe(CS.CONNECTED);
  });

  it('takes up a larger sv_maxclients at that load', () => {
    const { host, cvars } = makeHost();
    cvars.set('sv_maxclients', '8');

    host.mapRestart(0);

    expect(host.maxclients).toBe(8);
    expect(host.clients).toHaveLength(8);
  });

  it('will not shrink below the slots that are in use', () => {
    const { host, cvars } = makeHost();
    for (const name of ['Sarge', 'Grunt', 'Major']) connectRemote(host, `\\name\\${name}`);
    cvars.set('sv_maxclients', '1');

    host.mapRestart(0);

    expect(host.maxclients).toBe(3);
    expect(cvars.get('sv_maxclients')).toBe('3');
  });
});

describe("a map load's wipe of the last map", () => {
  it('starts the clock again at 0, so each match starts 400 ms in, where svs.time runs on', () => {
    const { host, game } = makeHost();
    host.runFrame(1000);
    expect([host.time, host.svsTime]).toEqual([1400, 1400]);
    game.calls.length = 0;

    host.spawnServer({ name: 'next', entities: '' });

    expect(game.calls).toEqual(['shutdown false', 'init 0 false']);
    expect([host.time, host.svsTime]).toEqual([400, 1800]);
  });

  it('carries no part of a frame over from the last map', () => {
    const { host, game } = makeHost();
    host.runFrame(5);
    expect(host.residualMsec).toBe(5);

    host.spawnServer({ name: 'next', entities: '' });
    game.frames = 0;
    host.runFrame(5);

    expect(game.frames).toBe(0);
    expect(host.residualMsec).toBe(5);
  });

  it('drops a restart the last map was counting down to, and its warmup string', () => {
    const { host } = makeHost();
    host.mapRestart(5);
    expect(host.restartTime).toBe(5400);

    host.spawnServer({ name: 'next', entities: '' });

    expect(host.restartTime).toBe(0);
    expect(host.getConfigstring(CONFIGSTRING.WARMUP)).toBe('');
  });

  it('empties every configstring the last map set, the new one setting its own', () => {
    const { host } = makeHost();
    host.setConfigstring(CONFIGSTRING.SOUNDS + 5, 'sound/world/jumppad.wav');

    host.spawnServer({ name: 'next', entities: '' });

    expect(host.getConfigstring(CONFIGSTRING.SOUNDS + 5)).toBe('');
    expect(host.getConfigstring(CONFIGSTRING.SERVERINFO)).toContain('\\mapname\\next');
  });

  it("keeps a loading client on the old map's clock, until it has the new gamestate", () => {
    const { host } = makeHost();
    const clientNum = connectLocal(host);
    host.clientEnterWorld(clientNum, null);
    host.runFrame(1000);

    host.spawnServer({ name: 'next', entities: '' });

    expect(host.clients[clientNum].oldServerTime).toBe(1400);
  });

  it("empties the world, and carves the new one from the new map's model 0", () => {
    const { host, game } = makeHost();
    const east = linkCube(host, game, 1000);
    const west = linkCube(host, game, -3000);
    // A splat map's sectors all split y at 0, which both cross, so the newest link comes first.
    expect(host.entitiesInBox(...EVERYWHERE)).toEqual([west, east]);

    const cube = cubeBsp();
    const model = {
      ...cube.models[0],
      mins: [-3552, -3040, -736] as [number, number, number],
      maxs: [1344, 752, 912] as [number, number, number]
    };
    const clipMap = loadMap(cubeBsp({ models: [model, ...cube.models.slice(1)] }), 'maps/q.bsp');
    host.spawnServer({ name: 'next', entities: '', clipMap });
    expect(host.entitiesInBox(...EVERYWHERE)).toEqual([]);

    // The new map's first sector splits x at −1104, and the side past it comes first.
    linkCube(host, game, 1000, east);
    linkCube(host, game, -3000, west);
    expect(host.entitiesInBox(...EVERYWHERE)).toEqual([east, west]);
  });

  it("leaves the map's portals as they are for a door linked in one area", () => {
    const { host, game } = makeHost();
    const clipMap = loadMap(clipBsp(), 'maps/q.bsp');
    host.spawnServer({ name: 'next', entities: '', clipMap });
    const door = linkCube(host, game, 0);
    const before = Array.from(clipMap.areaPortals);
    host.adjustAreaPortalState(game.entity(door), true);
    host.adjustAreaPortalState(game.entity(door), false);
    host.adjustAreaPortalState(game.entity(door), false);
    expect(Array.from(clipMap.areaPortals)).toEqual(before);
  });

  it('opens the portal a door is linked across, and sees through it while it is open', () => {
    const { host, game } = makeHost();
    const clipMap = portalMap();
    host.spawnServer({ name: 'next', entities: '', clipMap });
    const door = game.entity(linkCube(host, game, STRIP_WIDTH));
    const [here, there] = [vec3(STRIP_WIDTH / 2, 0, 0), vec3(STRIP_WIDTH * 1.5, 0, 0)];

    expect(host.inPVS(here, there)).toBe(false);
    host.adjustAreaPortalState(door, true);
    expect(Array.from(clipMap.areaPortals)).toEqual([0, 1, 1, 0]);
    expect(host.inPVS(here, there)).toBe(true);
    host.adjustAreaPortalState(door, false);
    expect(host.inPVS(here, there)).toBe(false);
  });
});

describe("a snapshot's sight", () => {
  /** A room of a row: one leaf of a cluster and an area. */
  const room = (cluster: number, area: number): Strip => ({ cluster, area });
  const SOLID = room(-1, -1);

  /** The middle of leaf `k` of a row. */
  const middle = (k: number) => vec3(STRIP_WIDTH * k + STRIP_WIDTH / 2, 0, 0);

  /** Rows of visibility, each cluster's seeing the clusters listed for it. */
  function rows(seen: readonly (readonly number[])[]) {
    const clusterBytes = (seen.length + 7) >> 3;
    const data = new Uint8Array(seen.length * clusterBytes);
    seen.forEach((row, cluster) => {
      for (const c of row) data[cluster * clusterBytes + (c >> 3)] |= 1 << (c & 7);
    });
    return { numClusters: seen.length, clusterBytes, data };
  }

  /** A host on a row of leaves, with these rows of visibility or none. */
  function stripsHost(strips: readonly Strip[], visibility: ReturnType<typeof rows> | null = null) {
    const fixture = makeHost();
    const clipMap = loadMap(stripsBsp(strips, [], visibility), 'maps/q.bsp');
    fixture.host.spawnServer({ name: 'strips', entities: '', clipMap });
    return { ...fixture, clipMap };
  }

  /** An entity linked over leaves `first` to `last` of a row, its box 8 inside each end. */
  function across(host: Host, game: TestGame, first: number, last: number): GameEntity {
    const entity = game.level.spawnEntity();
    entity.r.mins = vec3(STRIP_WIDTH * first + 8, -8, -8);
    entity.r.maxs = vec3(STRIP_WIDTH * (last + 1) - 8, 8, 8);
    host.linkEntity(entity);
    return entity;
  }

  /** What client 0 at the middle of leaf `k` is sent: the entities' numbers and the mask. */
  function sentFrom(host: Host, k: number, clientNum = 0) {
    const ps = createPlayerState();
    ps.clientNum = clientNum;
    ps.origin = middle(k);
    const numbers: number[] = [];
    const areabits = new Uint8Array(32);
    const areabytes = host.visibleEntities(ps, numbers, areabits);
    return { numbers, areabytes, mask: Array.from(areabits) };
  }

  /** A mask of 32 bytes: these, then every bit set. */
  const masked = (...bytes: number[]) => [
    ...bytes,
    ...new Array<number>(32 - bytes.length).fill(255)
  ];

  it("sends what the eye's row sees in the areas its own is joined to, and masks the rest", () => {
    const { host, game } = stripsHost(
      [room(0, 0), room(1, 0), room(2, 0), room(3, 1)],
      rows([[0, 1, 3], [1], [2], [3]])
    );
    const seen = linkCube(host, game, middle(1).x);
    linkCube(host, game, middle(2).x);
    linkCube(host, game, middle(3).x);

    // The third is in a cluster the row sees, but "blocked by a door".
    expect(sentFrom(host, 0)).toEqual({ numbers: [seen], areabytes: 1, mask: masked(0xfe) });
  });

  it('sends a door from either of its areas, and what is behind it while it is open', () => {
    const { host, game } = stripsHost(
      [room(0, 0), room(1, 0), room(2, 0), room(3, 1)],
      rows([[0], [1], [2], [1, 2, 3]])
    );
    const behind = linkCube(host, game, middle(1).x);
    const door = across(host, game, 2, 3);

    expect(sentFrom(host, 3)).toEqual({
      numbers: [door.s.number],
      areabytes: 1,
      mask: masked(0xfd)
    });
    host.adjustAreaPortalState(door, true);
    expect(sentFrom(host, 3)).toEqual({
      numbers: [behind, door.s.number],
      areabytes: 1,
      mask: masked(0xfc)
    });
  });

  it("never sends an entity in no cluster, though it is in the eye's area", () => {
    const { host, game } = stripsHost([room(0, 0), room(-1, 0)]);
    linkCube(host, game, middle(1).x);

    expect(sentFrom(host, 0).numbers).toEqual([]);
  });

  describe('an entity whose leaves held more clusters than it kept', () => {
    /** 20 rooms of one area, and a row for cluster 0 that sees these too. */
    function scanned(seen: number[], last = 19) {
      const strips = Array.from({ length: 20 }, (_, k) => room(k, 0));
      const seeing = strips.map((_, k) => (k ? [k] : [0, ...seen]));
      const { host, game } = stripsHost(strips, rows(seeing));
      return { host, number: across(host, game, 1, last).s.number };
    }

    it('is sent when the scan from its last kept cluster finds one seen short of the last', () => {
      const { host, number } = scanned([17]);
      expect(sentFrom(host, 0).numbers).toEqual([number]);
    });

    it('is sent when the scan finds nothing seen at all', () => {
      const { host, number } = scanned([]);
      expect(sentFrom(host, 0).numbers).toEqual([number]);
    });

    it('is dropped when the first cluster the scan finds seen is its last', () => {
      expect(sentFrom(scanned([19]).host, 0).numbers).toEqual([]);
    });

    it('is scanned when its sixteenth cluster is on its last leaf, and so sent unseen', () => {
      const { host, number } = scanned([], 16);
      expect(sentFrom(host, 0).numbers).toEqual([number]);
    });

    it('is not scanned when it has fewer clusters than it keeps', () => {
      const { host, number } = scanned([15], 15);
      expect(sentFrom(host, 0).numbers).toEqual([number]);
      expect(sentFrom(scanned([], 15).host, 0).numbers).toEqual([]);
    });

    it('is scanned from its last kept cluster, through clusters it does not reach', () => {
      // Rooms of the odd clusters 1 to 35: it keeps 1 to 31, and reaches 33 and 35.
      const odd = (seen: number[]) => {
        const strips = [room(0, 0), ...Array.from({ length: 18 }, (_, k) => room(2 * k + 1, 0))];
        const seeing = Array.from({ length: 36 }, (_, c) => (c ? [c] : [0, ...seen]));
        const { host, game } = stripsHost(strips, rows(seeing));
        return { host, number: across(host, game, 1, 18).s.number };
      };

      // 2 is before the scan starts, and 34 within it.
      expect(sentFrom(odd([2, 35]).host, 0).numbers).toEqual([]);
      const { host, number } = odd([34, 35]);
      expect(sentFrom(host, 0).numbers).toEqual([number]);
    });
  });

  it('sends an eye in solid the broadcasts alone, and shows it every area', () => {
    const { host, game } = stripsHost([room(0, 0), room(1, 1), SOLID]);
    linkCube(host, game, middle(0).x);
    const broadcast = game.entity(linkCube(host, game, middle(1).x));
    broadcast.r.svFlags = SVF.BROADCAST;

    expect(sentFrom(host, 2)).toEqual({
      numbers: [broadcast.s.number],
      areabytes: 1,
      mask: masked(0)
    });
  });

  it('drops an entity for its flags before its sight, and sends a broadcast past its sight', () => {
    const { host, game } = stripsHost([room(0, 0), room(1, 1)]);
    const flagged = (svFlags: number, singleClient = 0) => {
      const entity = game.entity(linkCube(host, game, middle(1).x));
      entity.r.svFlags = svFlags;
      entity.r.singleClient = singleClient;
      return entity.s.number;
    };
    const broadcast = flagged(SVF.BROADCAST);
    flagged(SVF.BROADCAST | SVF.NOCLIENT);
    flagged(SVF.BROADCAST | SVF.SINGLECLIENT, 1);
    const unlinked = game.entity(flagged(SVF.BROADCAST));
    host.unlinkEntity(unlinked);

    expect(sentFrom(host, 0).numbers).toEqual([broadcast]);

    // A mask of clients is read before the areas are, so it is wrong from anywhere.
    flagged(SVF.CLIENTMASK, ~0);
    expect(() => sentFrom(host, 0, 32)).toThrow('SVF_CLIENTMASK: clientNum >= 32');
  });

  describe('a portal', () => {
    /** A portal in room 1 whose camera is in room 3, behind a shut door. */
    function portal() {
      const fixture = stripsHost(
        [room(0, 0), room(1, 0), room(2, 1), room(3, 1)],
        rows([[0, 1], [1], [2, 3], [2, 3]])
      );
      const { host, game } = fixture;
      const far = linkCube(host, game, middle(2).x);
      const entity = game.entity(linkCube(host, game, middle(1).x));
      entity.r.svFlags = SVF.PORTAL;
      entity.s.origin = middle(1);
      entity.s.origin2 = middle(3);
      return { ...fixture, far, entity };
    }

    it("adds what its camera sees, sorted among the rest, and the camera's areas", () => {
      const { host, far, entity } = portal();

      expect(sentFrom(host, 0)).toEqual({
        numbers: [far, entity.s.number],
        areabytes: 1,
        mask: masked(0xfc)
      });
      entity.r.svFlags = 0;
      expect(sentFrom(host, 0)).toEqual({
        numbers: [entity.s.number],
        areabytes: 1,
        mask: masked(0xfe)
      });
    });

    it('looks through only for an eye within its range, the edge included', () => {
      const { host, far, entity } = portal();

      entity.s.generic1 = STRIP_WIDTH;
      expect(sentFrom(host, 0).numbers).toEqual([far, entity.s.number]);
      entity.s.generic1 = STRIP_WIDTH - 1;
      expect(sentFrom(host, 0)).toEqual({
        numbers: [entity.s.number],
        areabytes: 1,
        mask: masked(0xfe)
      });
    });

    it('measures its range from the eye, the view height over the origin', () => {
      const { host, far, entity } = portal();
      entity.s.origin = vec3(middle(1).x, 0, 26);
      entity.s.generic1 = STRIP_WIDTH;
      const ps = createPlayerState();
      ps.origin = middle(0);
      ps.viewheight = 26;
      const numbers: number[] = [];

      host.visibleEntities(ps, numbers, new Uint8Array(32));
      expect(numbers).toEqual([far, entity.s.number]);
    });

    it('adds no camera for a portal behind a shut door', () => {
      const { host, entity } = portal();
      entity.r.currentOrigin = middle(2);
      host.linkEntity(entity);

      expect(sentFrom(host, 0)).toEqual({ numbers: [], areabytes: 1, mask: masked(0xfe) });
    });

    it('stops at 256 entities, and adds the areas of a camera past them', () => {
      const { host, game } = stripsHost([room(0, 0), room(1, 1)]);
      const many = Array.from({ length: 256 }, () => linkCube(host, game, middle(0).x));
      const late = game.entity(linkCube(host, game, middle(0).x));
      late.r.svFlags = SVF.PORTAL;
      late.s.origin2 = middle(1);
      linkCube(host, game, middle(1).x);

      expect(sentFrom(host, 0)).toEqual({ numbers: many, areabytes: 1, mask: masked(0xfc) });
    });
  });

  it('inverts all 32 bytes, and sends as many as hold the map\'s areas', () => {
    const strips = Array.from({ length: 9 }, (_, k) => room(0, k));
    const { host } = stripsHost(strips);

    expect(sentFrom(host, 8)).toEqual({ numbers: [], areabytes: 2, mask: masked(0xff, 0xfe) });
  });

  it('sends a world without a clip map everything, and no mask', () => {
    const { host, game } = makeHost();
    const near = linkCube(host, game, 0);
    const far = linkCube(host, game, 3000);

    expect(sentFrom(host, 0)).toEqual({
      numbers: [near, far],
      areabytes: 0,
      mask: new Array<number>(32).fill(0)
    });
  });

  /** A client in the world of a host, at the origin, and a snapshot sent to it and read. */
  function playing(host: Host) {
    const connection = new ClientConnection(testCvars());
    const clientNum = connectLocal(host, connection);
    host.clientEnterWorld(clientNum, null);
    const exchange = () => {
      host.runFrame(snapshotFrame(host));
      drain(host, connection);
      const snap = connection.snapshots.snap;
      const numbers = connection.snapshots.entities().map(({ number }) => number);
      return { numbers, mask: Array.from(snap.areamask.subarray(0, 2)) };
    };
    return { connection, clientNum, exchange };
  }

  it('tells a client what its eye sees, and the mask of the areas it does not', () => {
    const { host, game } = stripsHost([room(0, 0), room(1, 1)]);
    const { exchange } = playing(host);
    const behind = linkCube(host, game, middle(1).x);
    const door = across(host, game, 0, 1);

    expect(exchange()).toEqual({ numbers: [door.s.number], mask: [0xfe, 0] });
    host.adjustAreaPortalState(door, true);
    expect(exchange()).toEqual({ numbers: [behind, door.s.number], mask: [0xfc, 0] });
  });

  it("sends a zombie every area bit clear, over its frame's last count of them", () => {
    const { host } = stripsHost([room(0, 0), room(1, 1)]);
    const { connection, clientNum, exchange } = playing(host);
    for (let i = 0; i < 32; i++) exchange();
    // Every frame has been sent once, and each is cleared before it is used again.
    expect(exchange().mask).toEqual([0xfe, 0]);
    const client = host.clients[clientNum];

    host.dropClient(clientNum, 'gone');
    host.runFrame(snapshotFrame(host));
    drain(host, connection);

    const frame = client.frames[(client.netchan.outgoingSequence - 1) & 31];
    expect([frame.areabytes, ...frame.areabits]).toEqual([1, ...new Array<number>(32).fill(0)]);
  });

  it("sends a splat match's snapshot as it sent it before the areas, to the byte", () => {
    const { host, game } = makeHost();
    const { clientNum, exchange } = playing(host);
    const item = game.entity(linkCube(host, game, 3000));
    item.s.eType = ET.ITEM;
    item.s.modelindex = 7;
    const broadcast = linkCube(host, game, -3000);
    game.entity(broadcast).r.svFlags = SVF.BROADCAST;
    const portal = game.entity(linkCube(host, game, 500));
    portal.r.svFlags = SVF.PORTAL;
    portal.s.origin2 = vec3(-2000, 100, 50);
    const sent = vi.spyOn(host.clients[clientNum].netchan, 'transmit');

    expect(exchange()).toEqual({
      numbers: [item.s.number, broadcast, portal.s.number],
      mask: [0, 0]
    });
    const bytes = Array.from(sent.mock.calls.at(-1)![0], (b) => b.toString(16).padStart(2, '0'));
    expect(bytes.join('')).toBe('aa7ffcad862ae0fb0400230100fc071fe15b3c00000080c9d42074a43f5901');
  });
});

describe('map <n>', () => {
  /** A program that reads maps asynchronously: it records each asked for and answers none. */
  function program(known: readonly string[]) {
    const asked: string[] = [];
    const printed: string[] = [];
    const options = {
      maps: {
        exists: (name: string) => known.includes(name),
        load: (name: string) => asked.push(name)
      },
      print: (text: string) => printed.push(text)
    };
    return { asked, printed, options };
  }

  it('looks for the map before anything changes, so a typo leaves the match running', () => {
    const { printed, options } = program(['backyard']);
    const { host, game } = makeHost(options);
    game.calls.length = 0;

    host.sendConsoleCommand('map bakyard\n');
    host.runFrame(8);

    expect(printed).toContain("Can't find map maps/bakyard.bsp");
    expect(game.calls).toEqual([]);
    expect(host.loading).toBeNull();
    expect(host.time).toBe(408);
  });

  it('asks the program for the map, and runs no frame until it is handed back', () => {
    const { asked, options } = program(['backyard']);
    const { host, game } = makeHost(options);

    host.sendConsoleCommand('map backyard\n');
    host.runFrame(8);
    const frames = game.frames;
    host.runFrame(16);

    expect(asked).toEqual(['backyard']);
    expect(host.loading).toBe('backyard');
    expect(game.frames).toBe(frames);
    expect(host.time).toBe(400);
  });

    it('spawns the map it is handed, named in the serverinfo every client reads', () => {
      const { options } = program(['backyard']);
      const { host, game, cvars } = makeHost(options);
      const connection = new ClientConnection(testCvars());
      const clientNum = connectLocal(host, connection);
      host.clientEnterWorld(clientNum, null);
      const serverId = host.serverId;
      host.sendConsoleCommand('map backyard\n');
      host.runFrame(8);
      game.calls.length = 0;

      host.spawnServer({ name: 'backyard', entities: '' });

      // A load, not a restart: the game module goes down and comes up with the new map's entities.
      expect(game.calls).toEqual(['shutdown false', 'init 0 false', 'connect 0 false']);
      expect(host.loading).toBeNull();
      expect(host.map.name).toBe('backyard');
      expect(host.serverId).toBe(serverId + 1);
      expect(cvars.get('mapname')).toBe('backyard');
      // The client waits for the new gamestate, whose serverinfo says which map it is.
      expect(host.clients[clientNum].state).toBe(CS.CONNECTED);
      host.sendClientGameState(host.clients[clientNum]);
      drain(host, connection);
      expect(connection.configstrings[CONFIGSTRING.SERVERINFO]).toContain('\\mapname\\backyard');
    });

    it('leaves sv_cheats 0 for a map and 1 for a devmap, and starts a devmap without the bots', () => {
      const { options } = program(['backyard']);
      const fixture = makeHost({ ...options, debugMode: false });
      const { host, cvars } = fixture;
      const bot = addBot(fixture, 'Grunt');

      // The boot's own map is a `map`, so cheats are off, and the change travels in the systeminfo.
      host.runFrame(8);
      expect(cvars.get('sv_cheats')).toBe('0');
      expect(host.getConfigstring(CONFIGSTRING.SYSTEMINFO)).toContain('\\sv_cheats\\0');

      host.sendConsoleCommand('devmap backyard\n');
      host.runFrame(8);
      host.spawnServer({ name: 'backyard', entities: '' }, true, true);
      expect(cvars.get('sv_cheats')).toBe('1');
      // `SV_SpawnServer`'s killBots: a devmap starts without them.
      expect(host.clients[bot].state).toBe(CS.FREE);
    });

    it('says sv_cheats 1 whatever the map command under DEBUG_MODE', () => {
      const { options } = program(['backyard']);
      const { host, cvars } = makeHost(options);
      host.sendConsoleCommand('map backyard\n');
      host.runFrame(8);
      host.spawnServer({ name: 'backyard', entities: '' }, false, false);
      expect(cvars.get('sv_cheats')).toBe('1');
    });

  it('sends the serverinfo again when a limit changed, and leaves it alone otherwise', () => {
    // `SV_Frame` (`sv_main.c:1103–1106`): a `CVAR_SERVERINFO` cvar given a new value goes out, so
    // a HUD drawing the limit is drawing the one the match is going by and not the map's.
    const { host, cvars } = makeHost();
    const at = () => host.getConfigstring(CONFIGSTRING.SERVERINFO);
    // The stub game module registers none of the match's cvars, so the limits start here.
    cvars.set('fraglimit', '20');
    cvars.set('capturelimit', '8');
    cvars.set('roundlimit', '5');

    host.runFrame(8);
    expect(at()).toContain('\\fraglimit\\20');

    cvars.set('fraglimit', '5');
    host.runFrame(8);
    expect(at()).toContain('\\fraglimit\\5');
    expect(at()).toContain('\\capturelimit\\8');
    expect(at()).toContain('\\roundlimit\\5');

    // A cvar the serverinfo does not carry moves nothing.
    const sent = at();
    cvars.set('g_forcerespawn', '3');
    host.runFrame(8);
    expect(at()).toBe(sent);
  });

  it('asks after no serverinfo or systeminfo cvar in a frame that changed none', () => {
    // Q3's frame asks `cvar_modifiedFlags` once, and walks no cvar when it is clear.
    const { host, cvars } = makeHost();
    host.runFrame(8);
    const asked = vi.spyOn(cvars, 'modificationCount');
    host.runFrame(8);
    host.runFrame(8);
    expect(asked.mock.calls.map(([name]) => name)).toEqual([]);

    cvars.set('fraglimit', '5');
    host.runFrame(8);
    expect(asked).toHaveBeenCalledWith('fraglimit');
    expect(host.getConfigstring(CONFIGSTRING.SERVERINFO)).toContain('\\fraglimit\\5');
  });

  it("carries the preset's label, and sends it again when a preset writes another", () => {
    const { host, cvars } = makeHost();
    const at = () => host.getConfigstring(CONFIGSTRING.SERVERINFO);
    cvars.set('g_gamepreset', 'VQ3');
    host.runFrame(8);
    expect(at()).toContain('\\g_gamepreset\\VQ3');

    cvars.set('g_gamepreset', 'CPM');
    host.runFrame(8);
    expect(at()).toContain('\\g_gamepreset\\CPM');
  });

  it('carries dmflags, which a client reads from it', () => {
    const { host, cvars } = makeHost();
    cvars.set('dmflags', '32');
    host.runFrame(8);
    expect(host.getConfigstring(CONFIGSTRING.SERVERINFO)).toContain('\\dmflags\\32');
  });

  it("carries the shotgun's pattern, which a client draws a blast by", () => {
    const { host, cvars } = makeHost();
    cvars.set('g_pattern_sg', '2');
    cvars.set('g_pellets_sg', '16');
    cvars.set('g_spread_sg', '650');
    host.runFrame(8);
    const info = host.getConfigstring(CONFIGSTRING.SERVERINFO);
    expect(info).toContain('\\g_pattern_sg\\2');
    expect(info).toContain('\\g_pellets_sg\\16');
    expect(info).toContain('\\g_spread_sg\\650');
  });

  it("carries the hitscan weapons' numbers, which a client draws its own shots by", () => {
    const { host, cvars } = makeHost();
    const numbers = {
      g_muzzleForward: '1',
      g_muzzleSnap: '0',
      g_spread_mg: '350',
      g_range_mg: '8192',
      g_range_rg: '4096',
      g_bulletImpactSnap: '0',
      g_railTrailOffset: '0'
    };
    for (const [name, value] of Object.entries(numbers)) cvars.set(name, value);
    host.runFrame(8);
    const info = host.getConfigstring(CONFIGSTRING.SERVERINFO);
    for (const [name, value] of Object.entries(numbers)) {
      expect(info).toContain(`\\${name}\\${value}`);
    }
  });

  it("carries the plasma's sizes and the BFG's blast, which a client draws the missiles by", () => {
    const { host, cvars } = makeHost();
    cvars.set('g_plasmaSize', '12');
    cvars.set('g_plasmaMarkSize', '8');
    cvars.set('g_splashradius_bfg', '0');
    host.runFrame(8);
    const info = host.getConfigstring(CONFIGSTRING.SERVERINFO);
    expect(info).toContain('\\g_plasmaSize\\12');
    expect(info).toContain('\\g_plasmaMarkSize\\8');
    expect(info).toContain('\\g_splashradius_bfg\\0');
  });

  it("carries the low-ammo marks, which a client's HUD warns by", () => {
    const { host, cvars } = makeHost();
    const weapons = ['mg', 'sg', 'gl', 'rl', 'lg', 'rg', 'pg', 'bfg'];
    for (const weapon of weapons) cvars.set(`g_lowAmmo_${weapon}`, '7');
    host.runFrame(8);
    const info = host.getConfigstring(CONFIGSTRING.SERVERINFO);
    for (const weapon of weapons) expect(info).toContain(`\\g_lowAmmo_${weapon}\\7`);
  });

  it("reloads the map from the program when a latched cvar changed: Q3's slow way", () => {
    const { asked, options } = program(['test']);
    const { host, cvars } = makeHost(options);
    cvars.set('g_gametype', '1');

    host.mapRestart(0);

    expect(asked).toEqual(['test']);
    expect(host.loading).toBe('test');
  });

  it('does nothing when no map is named', () => {
    const { asked, printed, options } = program(['backyard']);
    const { host } = makeHost(options);

    host.sendConsoleCommand('map\n');
    host.runFrame(8);

    expect(asked).toEqual([]);
    expect(printed).toEqual([]);
  });
});

describe('the host', () => {
  let game: TestGame;
  let host: Host;
  let connection: ClientConnection;

  beforeEach(() => {
    ({ host, game } = makeHost());
    connection = new ClientConnection(testCvars());
  });

  describe('a map load', () => {
    it('leaves the host running and the game initialised', () => {
      expect(host.state).toBe(SS.GAME);
      expect(game.calls).toContain('init 0 false');
    });

    it('publishes a server id the client stamps its messages with', () => {
      connectLocal(host, connection);

      expect(connection.serverId).toBe(host.serverId);
      expect(host.getConfigstring(CONFIGSTRING.SYSTEMINFO)).toContain('sv_serverid');
    });

    it('publishes the rules a client predicts with, and sends one again when it changed', () => {
      // `CS_SYSTEMINFO` carries the move's rules, as Q3's `CVAR_SYSTEMINFO` cvars do.
      const { host, cvars } = makeHost();
      const at = () => host.getConfigstring(CONFIGSTRING.SYSTEMINFO);
      cvars.set('pmove_JumpVelocity', '300');
      cvars.set('pmove_msec', '8');
      host.runFrame(8);
      expect(at()).toContain('\\pmove_JumpVelocity\\300');
      expect(at()).toContain('\\pmove_msec\\8');
      expect(at()).toContain('\\sv_serverid\\1');
      // And the frame, for a client to work out the gap between its snapshots.
      expect(at()).toContain('\\sv_fps\\125');

      cvars.set('pmove_JumpVelocity', '250');
      cvars.set('sv_fps', '20');
      host.runFrame(8);
      expect(at()).toContain('\\pmove_JumpVelocity\\250');
      expect(at()).toContain('\\sv_fps\\20');

      // A cvar the systeminfo does not carry moves nothing.
      const sent = at();
      cvars.set('g_forcerespawn', '3');
      host.runFrame(8);
      expect(at()).toBe(sent);
    });

    it('takes the rules from the gamestate, and a change from the cs that follows', () => {
      const { host, cvars } = makeHost();
      cvars.set('pmove_JumpVelocity', '300');
      host.runFrame(8);
      const client = testCvars();
      const connected = new ClientConnection(client);
      connectLocal(host, connected);
      expect(connected.rules.pmove_JumpVelocity).toBe(300);
      // Into the world, so the host has a slot a configstring is sent to.
      sendMove(host, connected, [moveCmd(8)]);

      cvars.set('pmove_JumpVelocity', '333');
      cvars.set('pmove_msec', '16');
      host.runFrame(snapshotFrame(host));
      drain(host, connected);
      for (
        let command = connected.nextServerCommand();
        command !== null;
        command = connected.nextServerCommand()
      ) {
        // Run them as the view's `takeServerCommands` does, so the `cs` reaches the client.
      }

      expect(connected.rules.pmove_JumpVelocity).toBe(333);
      // The rules are the record's alone; Quake 3's own systeminfo cvars are still set.
      expect(client.get('pmove_JumpVelocity')).toBe('');
      expect(client.get('pmove_msec')).toBe('16');
    });

    it("leaves the player's own rules alone, for a preset to set and the file to keep", () => {
      // A server with a store of its own, as one elsewhere is, playing other rules.
      const { host, cvars } = makeHost();
      cvars.set('pmove_JumpVelocity', '275');
      cvars.set('g_allowGrapple', '3');
      cvars.set('xp_unlagged', '0');
      cvars.set('sv_fps', '40');
      host.runFrame(8);
      const print = vi.fn();
      const client = new Cvars({ debugMode: true, print });
      const connected = new ClientConnection(client);
      connectLocal(host, connected);
      expect(connected.rules).toMatchObject({
        pmove_JumpVelocity: 275,
        g_allowGrapple: 3,
        xp_unlagged: 0,
        sv_fps: 40
      });

      // None of the server's rules is the client's to hold read-only or write to its file.
      expect(client.set('pmove_JumpVelocity', '290', true)).toBe(true);
      expect(client.archived()).toContainEqual({ name: 'pmove_JumpVelocity', value: '290' });
      expect(client.archived().map((cvar) => cvar.name)).not.toContain('pmove_WalkAccel');
      // The grapple style, the rewind and the frame rate the player set stay the player's.
      const own = new Cvars({ debugMode: true, print: () => {} });
      for (const name of ['g_allowGrapple', 'xp_unlagged', 'sv_fps']) {
        expect(client.get(name)).toBe(own.get(name));
      }
      expect(client.archived()).not.toContainEqual({ name: 'g_allowGrapple', value: '3' });
      expect(print).not.toHaveBeenCalled();
      expect(connected.rules.pmove_JumpVelocity).toBe(275);
    });

    it("puts a client's cheat cvars back when the systeminfo says sv_cheats 0", () => {
      const { host } = makeHost({ debugMode: false });
      // Let the spawn's `sv_cheats` change reach the systeminfo, as Q3's cvar change does.
      host.runFrame(8);
      const client = new Cvars({ debugMode: true, print: () => {} });
      client.set('pcq_god', '1');
      const connected = new ClientConnection(client);
      connectLocal(host, connected);

      // The systeminfo carried the server's `sv_cheats`, and the client put the cvar back.
      expect(client.get('sv_cheats')).toBe('0');
      expect(client.get('pcq_god')).toBe('0');
    });

    it('carries a systeminfo past MAX_INFO_STRING, in the gamestate and in a cs', () => {
      // The rule list outgrows an ordinary string, so both the gamestate and a `cs` must take a
      // big one and the client must read it back whole.
      const long = 'x'.repeat(1500);
      const cvars = store({ pmove_JumpVelocity: long });
      const { host } = makeHost({ cvars });
      const client = testCvars();
      const connected = new ClientConnection(client);
      connectLocal(host, connected);
      sendMove(host, connected, [moveCmd(8)]);

      const systemInfo = () => connected.configstrings[CONFIGSTRING.SYSTEMINFO];
      expect(systemInfo().length).toBeGreaterThan(MAX_INFO_STRING);
      expect(infoValueForKey(systemInfo(), 'pmove_JumpVelocity')).toBe(long);

      const longer = 'y'.repeat(1800);
      cvars.set('pmove_JumpVelocity', longer);
      host.runFrame(snapshotFrame(host));
      // The change travels in a message of its own, in fragments the rate paces: give them time.
      for (let i = 0; i < 10; i++) {
        runQueued(host);
        drain(host, connected);
      }
      for (
        let command = connected.nextServerCommand();
        command !== null;
        command = connected.nextServerCommand()
      ) {
        // As above, but for the change that keeps the string big.
      }
      expect(infoValueForKey(systemInfo(), 'pmove_JumpVelocity')).toBe(longer);
    });
  });

  describe('the pause', () => {
    it('pauses a one-human match: no simulation, no snapshots, and sv_paused says so', () => {
      const { host, game, cvars } = makeHost();
      const connection = new ClientConnection(testCvars());
      connectLocal(host, connection);
      sendMove(host, connection, [moveCmd(8)]);
      drain(host, connection);
      const time = host.time;
      const calls = game.calls.length;
      const thinks = game.thinks;

      cvars.set('cl_paused', '1');
      host.runFrame(8);

      expect(cvars.get('sv_paused')).toBe('1');
      expect(host.time).toBe(time);
      expect(game.calls.length).toBe(calls);
      expect(game.thinks).toBe(thinks);
      // Nothing went out either: `SV_SendClientMessages` was skipped, so no snapshot.
      expect(drain(host, connection)).toBe(0);
    });

    it('runs with a second human, clearing sv_paused', () => {
      const { host, cvars } = makeHost();
      connectLocal(host, new ClientConnection(testCvars()));
      connectRemote(host, '\\name\\Visitor');
      cvars.set('sv_paused', '1');
      cvars.set('cl_paused', '1');
      const time = host.time;

      host.runFrame(8);

      expect(cvars.get('sv_paused')).toBe('0');
      expect(host.time).toBeGreaterThan(time);
    });

    it('does not count a bot as a human', () => {
      const fixture = makeHost();
      const { host, cvars } = fixture;
      connectLocal(host, new ClientConnection(testCvars()));
      addBot(fixture, 'Grunt');
      cvars.set('cl_paused', '1');

      host.runFrame(8);

      expect(cvars.get('sv_paused')).toBe('1');
    });

    it('a map load clears the pause, as SV_SpawnServer does', () => {
      const { host, cvars } = makeHost();
      cvars.set('cl_paused', '1');

      host.spawnServer({ name: 'test', entities: '' });

      expect(cvars.get('cl_paused')).toBe('0');
    });
  });

  describe('sv_running', () => {
    it('says a map is running, and says so no more once the server stops', () => {
      const { host, cvars } = makeHost();
      expect(cvars.get('sv_running')).toBe('1');

      host.shutdown('Server disconnected');

      expect(cvars.get('sv_running')).toBe('0');
    });
  });

  describe('cl_running', () => {
    it('says a client runs beside the server, unless the server is dedicated', () => {
      expect(makeHost().cvars.get('cl_running')).toBe('1');
      expect(makeHost({ dedicated: true }).cvars.get('cl_running')).toBe('0');
    });
  });

  describe('a client connecting', () => {
    it('takes a free slot and is primed by the gamestate', () => {
      const clientNum = connectLocal(host, connection, '\\name\\Sarge');

      expect(clientNum).toBe(0);
      expect(host.clients[0].state).toBe(CS.PRIMED);
      expect(host.clients[0].name).toBe('Sarge');
      // The game module reads the userinfo inside its own connect, so the host tells it no more.
      expect(game.calls).toEqual(['init 0 false', 'connect 0 true']);
    });

    it('sends a gamestate the client can read itself out of', () => {
      connectLocal(host, connection);

      expect(connection.gameStateReceived).toBe(true);
      expect(connection.clientNum).toBe(0);
    });

    it('enters the world on the first user command, and not before', () => {
      connectLocal(host, connection);

      expect(host.clients[0].state).toBe(CS.PRIMED);
      expect(game.calls).not.toContain('begin 0');

      sendMove(host, connection, [moveCmd(8)]);

      expect(host.clients[0].state).toBe(CS.ACTIVE);
      expect(game.calls).toContain('begin 0');
    });

    it('refuses to hand out a slot that does not exist', () => {
      for (let i = 0; i < 4; i++) connectRemote(host);
      expect(() => connectRemote(host)).toThrow(/full/);
    });
  });

  describe('user commands', () => {
    let clientNum: number;

    beforeEach(() => {
      clientNum = connectLocal(host, connection);
      sendMove(host, connection, [moveCmd(8)]);
    });

    it('runs each command once, in order', () => {
      game.thinks = 0;
      sendMove(host, connection, [moveCmd(16), moveCmd(24), moveCmd(32)]);

      expect(game.thinks).toBe(3);
      expect(game.playerState(clientNum).commandTime).toBe(32);
    });

    it('drops the duplicates a client sends on purpose', () => {
      sendMove(host, connection, [moveCmd(16), moveCmd(24)]);
      game.thinks = 0;

      // The same two again, as a client repeats them in case the last packet was lost.
      sendMove(host, connection, [moveCmd(16), moveCmd(24), moveCmd(32)]);

      expect(game.thinks).toBe(1);
    });

    it('ignores a message stamped with a map that is no longer running', () => {
      const stale = connection.writeMovePacket([moveCmd(999)]);
      host.mapRestart(0);
      game.thinks = 0;

      connection.transmit(stale);
      readPackets(host);

      expect(game.thinks).toBe(0);
    });

    it('hears a client again once it has run the `cs` that tells it of the restart', () => {
      host.mapRestart(0);
      // A restart sends no gamestate: the new id reaches the client as a server command, carried
      // by the next snapshot.
      for (let i = 0; i < 8 && drain(host, connection) === 0; i++) host.runFrame(8);
      expect(connection.serverId).not.toBe(host.serverId);

      const commands: string[] = [];
      for (let command; (command = connection.nextServerCommand()) !== null; ) {
        commands.push(command);
      }
      expect(commands).toContain('map_restart\n');
      expect(connection.serverId).toBe(host.serverId);
      expect(connection.configstrings[CONFIGSTRING.SYSTEMINFO]).toBe(
        host.getConfigstring(CONFIGSTRING.SYSTEMINFO)
      );

      game.thinks = 0;
      sendMove(host, connection, [moveCmd(host.time + 8)]);
      expect(game.thinks).toBe(1);
    });

    it('leaves the mark a map load set, so a run of restarts is one run of ids behind', () => {
      const loaded = host.serverId;

      host.mapRestart(0);
      host.runFrame(8);
      host.mapRestart(0);

      // Every id from the load to the one now running belongs to a client that is merely behind,
      // which is what tells it apart from one that has arrived at the wrong server altogether.
      expect(host.serverId).toBe(loaded + 2);
      expect(host.restartedServerId).toBe(loaded);
    });

    it('survives the trip through the keyed delta unchanged', () => {
      const cmd = moveCmd(40);
      cmd.angles = [1000, 2000, 3000];
      cmd.buttons = 3;
      cmd.weapon = 7;
      cmd.rightmove = -127;
      cmd.upmove = 127;

      sendMove(host, connection, [cmd]);

      expect(host.getUserCmd(clientNum)).toEqual(cmd);
    });
  });

  describe('the two clocks', () => {
    it("runs the game at sv_fps and sends snapshots at the client's own rate", () => {
      connectLocal(host, connection);
      sendMove(host, connection, [moveCmd(0)]);

      const before = host.clients[0].netchan.outgoingSequence;
      game.frames = 0;
      for (let i = 0; i < 50; i++) host.runFrame(8);

      // Fifty frames of the match and eight snapshots over the same 400 ms, the clock going from
      // the 400 a match starts at to 800: the frame is `sv_fps`'s 8 ms, and a client that names no
      // `snaps` is sent one every 50, the first at once, since it has been sent none.
      expect(game.frames).toBe(50);
      expect(host.time).toBe(800);
      expect(host.clients[0].netchan.outgoingSequence - before).toBe(8);
    });

    it('runs frames of 1000 / sv_fps, read each frame, with the residue carried over', () => {
      const { host, game, cvars } = makeHost();
      expect(cvars.get('sv_fps')).toBe('125');
      expect(host.frameMsec).toBe(8);
      game.frames = 0;

      // A match starts 400 ms into its clock.
      cvars.set('sv_fps', '20');
      host.runFrame(100);
      expect(game.frames).toBe(2);
      expect(host.time).toBe(500);

      host.runFrame(30);
      expect(game.frames).toBe(2);
      // 40 a second is 25 ms, and the 30 already owed counts towards it.
      cvars.set('sv_fps', '40');
      host.runFrame(30);
      expect(game.frames).toBe(4);
      expect(host.time).toBe(550);
      expect(host.timeResidual).toBe(10);
    });

    it('sets an sv_fps under 1 to 10, and holds a frame under 1 ms at 1', () => {
      const { host, cvars } = makeHost();
      cvars.set('sv_fps', '0');
      expect(host.frameMsec).toBe(100);
      expect(cvars.get('sv_fps')).toBe('10');

      cvars.set('sv_fps', '2000');
      expect(host.frameMsec).toBe(1);
    });

    it("caps a client's snaps at sv_fps as it stands when the client's userinfo changes", () => {
      const { host, cvars } = makeHost();
      cvars.set('sv_fps', '20');
      const capped = connectRemote(host, '\\snaps\\40');
      expect(host.clients[capped].snapshotMsec).toBe(50);

      // A later change leaves the client's rate alone until its userinfo changes again.
      cvars.set('sv_fps', '125');
      expect(host.clients[capped].snapshotMsec).toBe(50);
    });

    it("tells the game module the net's clock, in whole milliseconds", () => {
      const cvars = store();
      const { host } = makeHost({ cvars, net: new Net({ cvars, now: () => 1234.75 }) });

      expect(host.milliseconds()).toBe(1234);
    });

    it('holds the residue of a partial frame rather than dropping it', () => {
      game.frames = 0;
      host.runFrame(5);
      expect(game.frames).toBe(0);

      host.runFrame(5);
      expect(game.frames).toBe(1);
      expect(host.time).toBe(408);
      expect(host.timeResidual).toBe(2);
    });

    it('gives a client the snapshot rate it asks for, up to the rate the host runs at', () => {
      connectLocal(host, connection, '\\snaps\\10');
      expect(host.clients[0].snapshotMsec).toBe(100);

      // Held to `sv_fps`'s 125 a second.
      connectRemote(host, '\\snaps\\1000');
      expect(host.clients[1].snapshotMsec).toBe(8);
    });

    it('reads a client rate from its userinfo, and leaves a LAN client alone', () => {
      const { host, cvars } = makeHost({ maxclients: 8 });
      const local = new ClientConnection(testCvars());
      const localNum = connectLocal(host, local, '\\rate\\5000');
      // The loopback is on the server's own machine, so its rate is not its userinfo's.
      expect(host.clients[localNum].rate).toBe(99999);

      const own = connectRemote(host, '\\rate\\5000');
      expect(host.clients[own].rate).toBe(5000);

      const low = connectRemote(host, '\\rate\\500');
      expect(host.clients[low].rate).toBe(1000);

      const high = connectRemote(host, '\\rate\\100000');
      expect(host.clients[high].rate).toBe(90000);

      // An empty rate is 3000, as Q3's `SV_UserinfoChanged` has it.
      const silent = connectRemote(host);
      expect(host.clients[silent].rate).toBe(3000);

      // A remote client on a private address is not choked either.
      const lan = connectRemote(host, '\\rate\\5000', '10.1.2.3');
      expect(host.clients[lan].rate).toBe(99999);

      // With `sv_lanForceRate` off, even a LAN client keeps its own rate.
      cvars.set('sv_lanForceRate', '0');
      const lanOff = connectRemote(host, '\\rate\\5000', '10.1.2.4');
      expect(host.clients[lanOff].rate).toBe(5000);
    });

    it('holds a LAN client to its own rate on a public server, as dedicated 2 is', () => {
      const { host } = makeHost({ cvars: store({ dedicated: '2' }) });
      const lan = connectRemote(host, '\\rate\\5000', '10.1.2.3');
      expect(host.clients[lan].rate).toBe(5000);
    });
  });

  describe('a snapshot', () => {
    let clientNum: number;
    let commandTime: number;

    beforeEach(() => {
      clientNum = connectLocal(host, connection);
      commandTime = 0;
      sendMove(host, connection, [moveCmd(commandTime)]);
    });

    /**
     * One round trip: the client sends a command, the host runs long enough to send a snapshot,
     * and the client reads it.
     *
     * The command matters even when the test does not care about it. It is what acknowledges the
     * last message, and without one every snapshot would be a full one.
     */
    function exchange(): void {
      commandTime += 8;
      sendMove(host, connection, [moveCmd(commandTime)]);
      host.runFrame(snapshotFrame(host));
      drain(host, connection);
    }

    it('carries the player state the game had, decoded field for field', () => {
      exchange();

      const snap = connection.snapshots.snap;
      expect(snap.valid).toBe(true);
      expect(snap.ps.clientNum).toBe(0);
      expect(snap.ps.commandTime).toBe(commandTime);
      expect(snap.ps.origin.x).toBe(game.playerState(clientNum).origin.x);
    });

    it('never carries the client its own entity, which the player state already holds', () => {
      exchange();

      expect(connection.snapshots.entities().map((state) => state.number)).not.toContain(clientNum);
    });

    it('carries another entity once it is linked into the world', () => {
      const entity = game.level.spawnEntity();
      entity.s.eType = ET.ITEM;
      entity.s.modelindex = 12;
      host.linkEntity(entity);

      exchange();

      const seen = connection.snapshots.entities();
      expect(seen.map((state) => state.number)).toEqual([entity.s.number]);
      expect(seen[0].modelindex).toBe(12);
    });

    it('leaves out an entity that is not linked, or is flagged away from clients', () => {
      const unlinked = game.level.spawnEntity();

      const hidden = game.level.spawnEntity();
      hidden.r.svFlags = SVF.NOCLIENT;
      host.linkEntity(hidden);

      exchange();

      const numbers = connection.snapshots.entities().map((state) => state.number);
      expect(numbers).not.toContain(unlinked.s.number);
      expect(numbers).not.toContain(hidden.s.number);
    });

    it('sends a single-client entity to that client alone', () => {
      const mine = game.level.spawnEntity();
      mine.r.svFlags = SVF.SINGLECLIENT;
      mine.r.singleClient = clientNum;
      host.linkEntity(mine);

      const theirs = game.level.spawnEntity();
      theirs.r.svFlags = SVF.SINGLECLIENT;
      theirs.r.singleClient = clientNum + 1;
      host.linkEntity(theirs);

      exchange();

      const numbers = connection.snapshots.entities().map((state) => state.number);
      expect(numbers).toContain(mine.s.number);
      expect(numbers).not.toContain(theirs.s.number);
    });

    it('sends a not-single-client entity to everyone but that client', () => {
      const entity = game.level.spawnEntity();
      entity.r.svFlags = SVF.NOTSINGLECLIENT;
      entity.r.singleClient = clientNum;
      host.linkEntity(entity);

      exchange();

      expect(connection.snapshots.entities().map((state) => state.number)).not.toContain(
        entity.s.number
      );
    });

    it('costs nothing to send an entity that has not changed', () => {
      const entity = game.level.spawnEntity();
      entity.s.eType = ET.ITEM;
      entity.s.modelindex = 3;
      host.linkEntity(entity);

      exchange();
      const withTheEntity = lastMessageSize(host);

      exchange();
      const withoutIt = lastMessageSize(host);

      expect(connection.snapshots.entities()).toHaveLength(1);
      expect(withoutIt).toBeLessThan(withTheEntity);
    });

    it('starts at the front of the message the gamestate filled', () => {
      // `connectLocal` sent the gamestate, the longest message the host writes. The next message
      // is a snapshot of its own, with nothing of the gamestate left behind it.
      const gamestateSize = lastMessageSize(host);

      exchange();

      expect(connection.snapshots.snap.valid).toBe(true);
      expect(lastMessageSize(host)).toBeLessThan(gamestateSize);
    });

    it('starts a gamestate at the front, whatever was written before it', () => {
      const gamestateSize = lastMessageSize(host);

      exchange();
      host.sendClientGameState(host.clients[clientNum]);
      drain(host, connection);

      // The resent gamestate is no longer than the first; left in the buffer, the snapshot's
      // bytes would be sent behind it.
      expect(lastMessageSize(host)).toBeLessThanOrEqual(gamestateSize);
    });

    it('writes the gamestate and every snapshot into one message, made once', () => {
      const made = vi.spyOn(Message, 'write');
      try {
        exchange();
        host.sendClientGameState(host.clients[clientNum]);
        drain(host, connection);

        expect(made).not.toHaveBeenCalled();
      } finally {
        made.mockRestore();
      }
    });

    it('works out the box it links an entity with, which is how anything finds it by where', () => {
      // `SV_LinkEntity` records where an entity is as well as that it is there, a unit bigger
      // each way than its bounds, because a move stops an epsilon short of what it hits. A blast
      // measures to this box, and an entity the host had only flagged as linked is a point.
      const entity = game.level.spawnEntity();
      entity.r.mins = vec3(-15, -15, -24);
      entity.r.maxs = vec3(15, 15, 32);
      entity.r.currentOrigin = vec3(100, 0, 24);

      host.linkEntity(entity);

      expect(entity.r.absmin).toEqual(vec3(84, -16, -1));
      expect(entity.r.absmax).toEqual(vec3(116, 16, 57));
    });

    it('finds the linked entities whose box touches a box, edges included', () => {
      const entity = game.level.spawnEntity();
      entity.r.mins = vec3(-15, -15, -24);
      entity.r.maxs = vec3(15, 15, 32);
      entity.r.currentOrigin = vec3(100, 0, 24);
      host.linkEntity(entity);
      const unlinked = game.level.spawnEntity();
      unlinked.r.absmin = vec3(-1000, -1000, -1000);
      unlinked.r.absmax = vec3(1000, 1000, 1000);

      // The linked box runs from 84 to 116 across, a unit wider than the bounds each way.
      expect(host.entitiesInBox(vec3(116, 0, 0), vec3(130, 1, 1))).toEqual([entity.s.number]);
      expect(host.entitiesInBox(vec3(70, 0, 0), vec3(84, 1, 1))).toEqual([entity.s.number]);
      expect(host.entitiesInBox(vec3(116.5, 0, 0), vec3(130, 1, 1))).toEqual([]);
      expect(host.entitiesInBox(vec3(100, 0, 58), vec3(100, 0, 60))).toEqual([]);
    });

    it('removes an entity from the client when the game lets it go', () => {
      const entity = game.level.spawnEntity();
      entity.s.eType = ET.ITEM;
      host.linkEntity(entity);
      exchange();
      expect(connection.snapshots.entities()).toHaveLength(1);

      host.unlinkEntity(entity);
      game.level.freeEntity(entity);
      exchange();

      expect(connection.snapshots.entities()).toHaveLength(0);
    });
  });

  describe('a client that is not playing yet', () => {
    it('is sent snapshots, and told they are not playable ones', () => {
      const network = new MemoryNetwork();
      const cvars = store();
      const net = new Net({ cvars, socket: network.socket('10.0.0.1') });
      const { host } = makeHost({ cvars, net });
      const remote = new Net({ cvars: testCvars(), socket: network.socket('10.0.0.2:27961') });
      const watcher = new ClientConnection(testCvars());
      const receive = () => {
        for (let p; (p = remote.getPacket()) !== null; ) watcher.packetEvent(p.from, p.data);
      };

      // The challenge, the connect, and the first packet, which the gamestate answers, each round
      // a frame of the client's.
      watcher.connect(remote, '10.0.0.1', stringToAdr('10.0.0.1')!);
      for (let i = 0; i < 3; i++) {
        watcher.clock.realtime += 100;
        watcher.sendCmd(createNetUserCmd());
        watcher.checkForResend();
        readPackets(host);
        receive();
      }
      host.runFrame(snapshotFrame(host, watcher.clientNum));
      receive();

      expect(host.clients[watcher.clientNum].state).toBe(CS.PRIMED);
      expect(watcher.gameStateReceived).toBe(true);
      expect(watcher.snapshots.snap.snapFlags & SNAPFLAG.NOT_ACTIVE).toBe(SNAPFLAG.NOT_ACTIVE);
      // Which is no start for its clock.
      watcher.setCGameTime();
      expect(watcher.state).toBe(CA.PRIMED);
    });
  });

  describe('reliable commands', () => {
    it('reach the client in order and are handed over once', () => {
      const clientNum = connectLocal(host, connection);

      // A gamestate marks where the command sequence stands, so anything said before it was sent
      // is already behind the client. These two go out with the next message instead.
      host.sendServerCommand(clientNum, 'print "one"');
      host.sendServerCommand(clientNum, 'print "two"');
      host.runFrame(snapshotFrame(host));
      drain(host, connection);

      expect(connection.nextServerCommand()).toBe('print "one"');
      expect(connection.nextServerCommand()).toBe('print "two"');
      expect(connection.nextServerCommand()).toBeNull();
    });

    it('keep being sent until the client acknowledges them', () => {
      const clientNum = connectLocal(host, connection);

      host.sendServerCommand(clientNum, 'cp "warmup"');
      host.runFrame(snapshotFrame(host));
      host.runFrame(snapshotFrame(host));

      // Two snapshots went out and neither was acknowledged, so the command was in both.
      expect(drain(host, connection, 1)).toBe(1);
      expect(connection.nextServerCommand()).toBe('cp "warmup"');
      expect(drain(host, connection, 1)).toBe(1);
      expect(connection.nextServerCommand()).toBeNull();
    });

    it('carry a client command to the game module', () => {
      connectLocal(host, connection);

      connection.addReliableCommand('say hello');
      sendMove(host, connection, [moveCmd(8)]);

      expect(game.calls).toContain('command 0 say hello');
    });

    it('clean the arguments after the name before the game module reads them', () => {
      connectLocal(host, connection);

      // `Cmd_Args_Sanitize` (`cmd.c:469–485`): line breaks and semicolons made spaces, and each
      // argument cut to 255 bytes, `MAX_CVAR_VALUE_STRING` less its NUL.
      const [kept, cut] = ['x'.repeat(255), 'y'.repeat(256)];
      connection.addReliableCommand(`"a;b" "c;d" "e\nf\rg" ${kept} ${cut}`);
      sendMove(host, connection, [moveCmd(8)]);

      expect(game.commands).toEqual([['a;b', 'c d', 'e f g', kept, 'y'.repeat(255)]]);
    });
  });

  describe('dropping a client', () => {
    it('leaves the slot a zombie and tells the game module', () => {
      const clientNum = connectLocal(host, connection);

      host.dropClient(clientNum, 'timed out');

      expect(host.clients[clientNum].state).toBe(CS.ZOMBIE);
      expect(host.clients[clientNum].gentity).toBeNull();
      expect(game.calls).toContain('disconnect 0');
    });

    it('does not drop the same client twice', () => {
      const clientNum = connectLocal(host, connection);
      host.dropClient(clientNum, 'first');
      host.dropClient(clientNum, 'second');

      expect(game.calls.filter((call) => call === 'disconnect 0')).toHaveLength(1);
    });

    it('can still send the disconnect that overflowing the command ring caused', () => {
      const clientNum = connectLocal(host, connection);
      for (let i = 0; i < 200; i++) host.sendServerCommand(clientNum, `print "${i}"`);

      expect(host.clients[clientNum].state).toBe(CS.ZOMBIE);
      expect(game.calls.filter((call) => call === 'disconnect 0')).toHaveLength(1);

      host.runFrame(snapshotFrame(host));
      // The message with the disconnect may go in fragments the rate paces: give them time.
      for (let i = 0; i < 10; i++) {
        runQueued(host);
        drain(host, connection);
      }
      const commands: string[] = [];
      for (;;) {
        const command = connection.nextServerCommand();
        if (command === null) break;
        commands.push(command);
      }
      expect(commands.some((command) => command.startsWith('disconnect'))).toBe(true);
    });
  });
});

/**
 * A host at 10.0.0.1, and a socket at 10.0.0.2 the test speaks for a client through: packets
 * out of band, and the answers read back as text.
 *
 * @param at - Where the two are instead, written as a player would type them.
 */
function handshake(
  options: Partial<Omit<HostOptions, 'game'>> = {},
  at = { host: '10.0.0.1', probe: '10.0.0.2' }
) {
  const network = new MemoryNetwork();
  const now = () => network.now;
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);
  const cvars = store();
  const net = new Net({ cvars, socket: network.socket(at.host), now, print });
  const fixture = makeHost({ cvars, net, print, ...options });
  // A challenge is dated by the host's clock, and one dated 0 is an empty slot's.
  fixture.host.runFrame(fixture.host.frameMsec);
  const probe = new Net({ cvars: testCvars(), socket: network.socket(at.probe), now });
  const server = stringToAdr(at.host)!;

  /** The out-of-band answers that have come back, as text. */
  const answers = (): string[] => {
    const texts: string[] = [];
    for (let p; (p = probe.getPacket()) !== null; ) {
      if (isOutOfBand(p.data)) texts.push(String.fromCharCode(...p.data.subarray(4)));
    }
    return texts;
  };
  const ask = (text: string): string[] => {
    probe.outOfBandPrint('client', server, text);
    readPackets(fixture.host);
    return answers();
  };
  const connect = (userinfo: string): string[] => {
    probe.outOfBandData('client', server, `connect "${userinfo}"`);
    readPackets(fixture.host);
    return answers();
  };
  /** A challenge for the probe's address. */
  const challenge = (): number => {
    const [answer] = ask('getchallenge 1234 PlayCanvasQuake');
    return Number.parseInt(answer.split(' ')[1], 10);
  };
  /** Move the host's clock on, as frames do. */
  const wait = (msec: number) => fixture.host.runFrame(msec);
  return { ...fixture, network, lines, ask, connect, challenge, wait };
}

describe('the handshake', () => {
  it("answers a getchallenge with a challenge, the asker's own number, and the protocol", () => {
    const { ask } = handshake();
    expect(ask('getchallenge -77 PlayCanvasQuake')).toEqual([
      expect.stringMatching(/^challengeResponse -?\d+ -77 2$/)
    ]);
  });

  it('tells a client of another game, or of none, what game this is', () => {
    const { ask } = handshake();
    const mismatch = 'print\nGame mismatch: This is a PlayCanvasQuake server\n';
    expect(ask('getchallenge 1 Quake3Arena')).toEqual([mismatch]);
    expect(ask('getchallenge 1')).toEqual([mismatch]);
  });

  it('answers nobody during a single-player match', () => {
    const { ask, cvars } = handshake();
    cvars.set('g_gametype', '2');
    expect(ask('getchallenge 1 PlayCanvasQuake')).toEqual([]);
  });

  it('takes a connect that carries its challenge: a slot, and the address in the userinfo', () => {
    const { host, game, lines, connect, challenge } = handshake();
    const number = challenge();

    const answer = connect(
      `\\name\\Visitor\\ip\\1.2.3.4\\protocol\\2\\qport\\5\\challenge\\${number}`
    );

    expect(answer).toEqual([`connectResponse ${number}`]);
    const client = host.clients[0];
    expect(client.state).toBe(CS.CONNECTED);
    // The gamestate waits for the client's first packet, which acknowledges nothing yet.
    expect(client.gamestateMessageNum).toBe(-1);
    expect(client.name).toBe('Visitor');
    expect(infoValueForKey(client.userinfo, 'ip')).toBe('10.0.0.2');
    expect(game.calls).toContain('connect 0 true');
    expect(lines).toContain('Client 0 connecting with 0 challenge ping');
  });

  it('sends a snapshot to a primed client, and none to one whose gamestate is still to come', () => {
    const { host, connect, challenge, wait } = handshake();
    connect(`\\protocol\\2\\qport\\5\\challenge\\${challenge()}`);
    const client = host.clients[0];
    expect(client.state).toBe(CS.CONNECTED);

    // A connecting client is sent nothing periodic, so a worker's loopback cannot overflow and drop
    // the `connectResponse` before the page reads it.
    wait(snapshotFrame(host));
    expect(client.lastSnapshotTime).toBe(0);

    // Primed, it is due a snapshot at its rate.
    host.sendClientGameState(client);
    expect(client.state).toBe(CS.PRIMED);
    const sent = client.netchan.outgoingSequence;
    wait(snapshotFrame(host));
    expect(client.netchan.outgoingSequence).toBeGreaterThan(sent);
  });

  it('takes a connect from an IPv6 address, which the userinfo names bare', () => {
    const { host, connect, challenge } = handshake(
      {},
      { host: '[2001:db8::1]', probe: '[2001:db8::2]:27961' }
    );
    const number = challenge();

    const answer = connect(`\\name\\Visitor\\protocol\\2\\qport\\5\\challenge\\${number}`);

    expect(answer).toEqual([`connectResponse ${number}`]);
    expect(host.clients[0].state).toBe(CS.CONNECTED);
    expect(host.clients[0].netchan.remoteAddress).toEqual(netadr(NA.IP6, '2001:db8::2', 27961));
    expect(infoValueForKey(host.clients[0].userinfo, 'ip')).toBe('2001:db8::2');
  });

  it("keeps an address's earlier challenges good, each asking a new one", () => {
    const { connect, challenge } = handshake();
    const first = challenge();
    const second = challenge();

    expect(second).not.toBe(first);
    expect(connect(`\\protocol\\2\\qport\\5\\challenge\\${first}`)).toEqual([
      `connectResponse ${first}`
    ]);
  });

  it('refuses a connect without the challenge its address was given', () => {
    const { host, connect } = handshake();
    expect(connect('\\protocol\\2\\qport\\5\\challenge\\999')).toEqual([
      'print\nNo or bad challenge for your address.\n'
    ]);
    expect(host.clients[0].state).toBe(CS.FREE);
  });

  it('refuses a client on another protocol', () => {
    const { connect, challenge } = handshake();
    expect(connect(`\\protocol\\71\\qport\\5\\challenge\\${challenge()}`)).toEqual([
      'print\nServer uses protocol version 2 (yours is 71).\n'
    ]);
  });

  it('refuses a connect when every slot is taken', () => {
    const { host, connect, challenge } = handshake();
    for (let i = 0; i < 4; i++) host.botAllocateClient();
    expect(connect(`\\protocol\\2\\qport\\5\\challenge\\${challenge()}`)).toEqual([
      'print\nServer is full\n'
    ]);
  });

  it("passes on the game module's refusal, and leaves the slot free", () => {
    const { host, game, connect, challenge } = handshake();
    game.clientConnect = () => 'Banned.';
    expect(connect(`\\protocol\\2\\qport\\5\\challenge\\${challenge()}`)).toEqual([
      'print\nBanned.\n'
    ]);
    expect(host.clients[0].state).toBe(CS.FREE);
  });

  it('ignores the same connect again for sv_reconnectlimit, then gives the slot back', () => {
    const { host, game, lines, connect, challenge, wait } = handshake();
    const userinfo = `\\protocol\\2\\qport\\5\\challenge\\${challenge()}`;
    connect(userinfo);

    wait(2992);
    expect(connect(userinfo)).toEqual([]);

    wait(8);
    expect(connect(userinfo)).toEqual([expect.stringMatching(/^connectResponse/)]);
    expect(lines).toContain('10.0.0.2:reconnect');
    expect(host.clients.filter((client) => client.state !== CS.FREE)).toHaveLength(1);
    expect(game.calls).not.toContain('disconnect 0');
  });

  it("forgets a dropped client's challenge, so it has to ask again", () => {
    const { host, connect, challenge, wait } = handshake();
    const userinfo = `\\protocol\\2\\qport\\5\\challenge\\${challenge()}`;
    connect(userinfo);

    host.dropClient(0, 'was kicked');
    wait(3000);

    expect(connect(userinfo)).toEqual(['print\nNo or bad challenge for your address.\n']);
  });

  it('makes the last bot give way to the player in this process, and no one else', () => {
    const { host, game } = makeHost();
    for (let i = 0; i < 4; i++) host.botAllocateClient();

    expect(connectLocal(host)).toBe(3);
    expect(host.clients[3].netchan.remoteAddress.type).toBe(NA.LOOPBACK);
    expect(game.calls).toContain('disconnect 3');
  });

  it('drops a client that says it is leaving', () => {
    const { host, game } = makeHost();
    const connection = new ClientConnection(testCvars());
    connectLocal(host, connection);

    connection.disconnect();
    readPackets(host);

    expect(connection.state).toBe(CA.DISCONNECTED);
    expect(host.clients[0].state).toBe(CS.ZOMBIE);
    expect(game.calls.filter((call) => call === 'disconnect 0')).toHaveLength(1);
  });

  it('puts the address back into a userinfo the client changes', () => {
    const { host, game } = makeHost();
    const connection = new ClientConnection(testCvars());
    connectLocal(host, connection, '\\name\\Sarge');

    connection.addReliableCommand('userinfo "\\name\\Grunt"');
    sendMove(host, connection, [moveCmd(8)]);

    expect(host.clients[0].name).toBe('Grunt');
    expect(infoValueForKey(host.clients[0].userinfo, 'ip')).toBe('localhost');
    expect(game.calls).toContain('userinfo 0');
  });

  it("reads a userinfo as it came, as only the game module's commands are cleaned", () => {
    const { host } = makeHost();
    const connection = new ClientConnection(testCvars());
    connectLocal(host, connection, '\\name\\Sarge');

    connection.addReliableCommand('userinfo "\\name\\Gr;unt"');
    sendMove(host, connection, [moveCmd(8)]);

    expect(host.clients[0].name).toBe('Gr;unt');
  });
});

/** A bot in the next free slot, joined as `G_AddBot` joins one. */
function addBot({ host, game }: Fixture, name: string): number {
  const clientNum = host.botAllocateClient();
  host.setUserinfo(clientNum, `\\name\\${name}`);
  game.clientConnect(clientNum, true, true);
  game.clientBegin(clientNum);
  game.entity(clientNum).r.svFlags |= SVF.BOT;
  return clientNum;
}

describe('what a server says of itself', () => {
  /** A connect from the probe's address, answered with a slot the gamestate has not reached. */
  function visit({ connect, challenge }: ReturnType<typeof handshake>, name: string): void {
    connect(`\\name\\${name}\\protocol\\2\\qport\\5\\challenge\\${challenge()}`);
  }

  it('answers getinfo with the keys a browser lists, the last first as Quake 3 has them', () => {
    const fixture = handshake();
    const { cvars, ask } = fixture;
    cvars.set('sv_hostname', 'Arena');
    cvars.set('g_needpass', '1');
    visit(fixture, 'Visitor');
    addBot(fixture, 'Sarge');

    expect(ask('getinfo xyz')).toEqual([
      'infoResponse\n' +
        '\\g_needpass\\1\\pure\\0\\gametype\\0\\sv_maxclients\\4\\g_humanplayers\\1\\clients\\2' +
        '\\mapname\\test\\hostname\\Arena\\protocol\\2\\gamename\\PlayCanvasQuake\\challenge\\xyz'
    ]);
  });

  it('leaves the challenge out when none was sent, and answers nothing to one over 128', () => {
    const { ask } = handshake();
    expect(ask('getinfo')).toEqual([expect.not.stringContaining('\\challenge\\')]);
    expect(ask(`getinfo ${'x'.repeat(128)}`)).toHaveLength(1);
    expect(ask(`getinfo ${'x'.repeat(129)}`)).toEqual([]);
    expect(ask(`getstatus ${'x'.repeat(129)}`)).toEqual([]);
  });

  it('answers neither during a single-player match', () => {
    const { ask, cvars } = handshake();
    cvars.set('g_gametype', '2');
    expect(ask('getinfo 1')).toEqual([]);
    expect(ask('getstatus 1')).toEqual([]);
  });

  it("answers getstatus with the serverinfo, Quake 3's players, then a client's board", () => {
    const fixture = handshake();
    const { host, game, ask } = fixture;
    visit(fixture, 'Visitor');
    const bot = addBot(fixture, 'Sarge');
    game.playerState(0).persistant[PERS.SCORE] = 7;
    game.playerState(bot).persistant[PERS.SCORE] = -1;
    host.clients[0].ping = 48;
    game.board = 'scores 1 0 0 0 7';
    host.setConfigstring(CONFIGSTRING.PLAYERS + 0, 'n\\Visitor\\t\\0');
    host.setConfigstring(CONFIGSTRING.PLAYERS + bot, 'n\\Sarge\\t\\0\\skill\\4');

    const [answer] = ask('getstatus abc');

    expect(answer.split('\n')).toEqual([
      'statusResponse',
      `\\challenge\\abc${host.configstrings[CONFIGSTRING.SERVERINFO]}`,
      '7 48 "Visitor"',
      '-1 0 "Sarge"',
      // Where Quake 3's reader stops.
      '',
      'scores 1 0 0 0 7',
      'cs 544 "n\\Visitor\\t\\0"',
      'cs 545 "n\\Sarge\\t\\0\\skill\\4"',
      ''
    ]);
  });

  it('ends an empty server\'s players at once', () => {
    const { host, ask } = handshake();
    expect(ask('getstatus')).toEqual([
      `statusResponse\n${host.configstrings[CONFIGSTRING.SERVERINFO]}\n\nscores 0 0 0\n`
    ]);
  });

  it('lists no slot that is being left', () => {
    const fixture = handshake();
    visit(fixture, 'Visitor');
    fixture.host.dropClient(0, 'was kicked');
    expect(fixture.host.clients[0].state).toBe(CS.ZOMBIE);

    const [answer] = fixture.ask('getstatus');
    expect(answer.split('\n').slice(2, 4)).toEqual(['', 'scores 0 0 0']);
  });

  it('stops short of the largest message, since the answer is one datagram', () => {
    const { host, ask } = handshake();
    for (let i = 0; i < 4; i++) host.setConfigstring(CONFIGSTRING.PLAYERS + i, 'x'.repeat(6000));

    const [answer] = ask('getstatus');

    expect(answer.split('\n').filter((line) => line.startsWith('cs '))).toHaveLength(2);
    expect(answer.length).toBeLessThan(MAX_MSGLEN);
  });

  it("carries the build, the game, the wire and the server's name in the serverinfo", () => {
    const { host, cvars } = makeHost({ cvars: store({ version: 'old', sv_hostname: 'Arena' }) });
    const info = () => host.configstrings[CONFIGSTRING.SERVERINFO];

    // `version` is read-only, so the build's replaces whatever was there. It comes first, as the
    // first cvar Quake 3 makes.
    expect(infoValueForKey(info(), 'version')).toMatch(/^PlayCanvasQuake \S+ node /);
    expect(info()).toMatch(/^\\version\\/);
    expect(infoValueForKey(info(), 'com_gamename')).toBe('PlayCanvasQuake');
    expect(infoValueForKey(info(), 'com_protocol')).toBe('2');
    expect(infoValueForKey(info(), 'sv_hostname')).toBe('Arena');
    expect(infoValueForKey(info(), 'sv_floodProtect')).toBe('1');

    cvars.set('g_needpass', '1');
    host.runFrame(host.frameMsec);
    expect(infoValueForKey(info(), 'g_needpass')).toBe('1');
  });

  it("starts its serverinfo as Q3's does, so SERVER INFO's sixteen rows are Q3's", () => {
    // The game module's, which a test's store has only where it is given them.
    const game = { dmflags: '0', fraglimit: '20', timelimit: '0', g_gametype: '0' };
    const more = { capturelimit: '8', g_needpass: '0', roundlimit: '5' };
    const { host } = makeHost({
      cvars: store({ com_gamename: 'g', com_protocol: '1', ...game, ...more })
    });
    const keys = infoPairs(host.configstrings[CONFIGSTRING.SERVERINFO]).map(([key]) => key);
    // In the order Q3 makes them: `common.c:2795–2797`, `sv_init.c:633–648`, `g_main.c:118, 137`.
    expect(keys.slice(0, 15)).toEqual([
      'version',
      'com_gamename',
      'com_protocol',
      'dmflags',
      'fraglimit',
      'timelimit',
      'g_gametype',
      'mapname',
      'sv_hostname',
      'sv_maxclients',
      'sv_minRate',
      'sv_maxRate',
      'sv_floodProtect',
      'capturelimit',
      'g_needpass'
    ]);
  });

  it('names a server noname until it is given a name', () => {
    const { host } = makeHost();
    expect(infoValueForKey(host.configstrings[CONFIGSTRING.SERVERINFO], 'sv_hostname')).toBe(
      'noname'
    );
  });

  it('prints status: each slot in use, with its score, ping, name, address and rate', () => {
    const fixture = handshake();
    const { host, game, lines } = fixture;
    visit(fixture, 'Visitor');
    connectLocal(host, new ClientConnection(testCvars()), '\\name\\Player');
    const bot = addBot(fixture, '^1Crash');
    game.playerState(bot).persistant[PERS.SCORE] = 12;
    host.clients[1].ping = 42;
    lines.length = 0;

    host.sendConsoleCommand('status\n');
    host.runFrame(host.frameMsec);

    expect(lines).toEqual([
      'map: test',
      'cl score ping name            address                                 rate ',
      '-- ----- ---- --------------- --------------------------------------- -----',
      // Still connecting, which is a column narrower than a ping. The rate is the LAN one for a
      // client on a private address and the loopback, and a bot's 16384, as Q3 gives it.
      ' 0     0 CON Visitor         ^710.0.0.2                                99999',
      ' 1     0   42 Player          ^7loopback                                99999',
      // Padded by the name as it shows, its colour code left out.
      ' 2    12    0 ^1Crash           ^7bot                                     16384',
      ''
    ]);

    host.dropClient(0, 'was kicked');
    host.sendConsoleCommand('status\n');
    host.runFrame(host.frameMsec);
    // A dropped client's userinfo is cleared, and its name with it (`sv_client.c:692–693`).
    expect(lines).toContain(
      ` 0     0 ZMB ${' '.repeat(16)}^710.0.0.2                                99999`
    );
  });

  it('prints serverinfo: the serverinfo cvars, each key to twenty characters', () => {
    const lines: string[] = [];
    const { host } = makeHost({ print: (line) => lines.push(line) });

    host.sendConsoleCommand('serverinfo\n');
    host.runFrame(host.frameMsec);

    const pairs = host.configstrings[CONFIGSTRING.SERVERINFO].split('\\').length / 2;
    expect(lines).toHaveLength(1 + Math.floor(pairs));
    expect(lines[0]).toBe('Server info settings:');
    expect(lines).toContain(`${'mapname'.padEnd(20)} test`);
    expect(lines).toContain(`${'sv_hostname'.padEnd(20)} noname`);
  });

  it('prints neither with no map running', () => {
    const lines: string[] = [];
    const host = fixtureHost({
      cvars: store(),
      print: (line) => lines.push(line),
      game: (h) => new TestGame(h)
    });

    host.sendConsoleCommand('status\nserverinfo\n');
    host.runFrame(8);

    expect(lines).toEqual(['Server is not running.', 'Server is not running.']);
  });
});

describe("a slot's life", () => {
  /** Run the host's frames until `svs.time` reaches `time`. */
  function runUntil(host: Host, time: number): void {
    while (host.svsTime < time) host.runFrame(host.frameMsec);
  }

  it('drops a client silent for sv_timeout, six frames after, and frees its slot at once', () => {
    const { host, game, cvars } = makeHost();
    cvars.set('sv_timeout', '1');
    const clientNum = connectRemote(host, '\\name\\Remote');
    const last = host.clients[clientNum].lastPacketTime;

    // Past the line from the first frame after a second, and dropped on the sixth.
    runUntil(host, last + 1000 + 5 * host.frameMsec);
    expect(host.clients[clientNum].state).not.toBe(CS.FREE);
    host.runFrame(host.frameMsec);

    expect(host.clients[clientNum].state).toBe(CS.FREE);
    expect(game.calls).toContain(`disconnect ${clientNum}`);
  });

  it('waits 200 seconds for a silent client, and 2 for a zombie', () => {
    const { cvars } = makeHost();
    expect(cvars.get('sv_timeout')).toBe('200');
    expect(cvars.get('sv_zombietime')).toBe('2');
  });

  it('starts the six frames again for a client that sends within them', () => {
    const { host, cvars } = makeHost();
    cvars.set('sv_timeout', '1');
    const connection = new ClientConnection(testCvars());
    const clientNum = connectLocal(host, connection);

    // Past its time for three frames, twice over.
    for (let round = 0; round < 2; round++) {
      runUntil(host, host.clients[clientNum].lastPacketTime + 1000 + 3 * host.frameMsec);
      sendMove(host, connection, [moveCmd(host.time)]);
    }

    expect(host.clients[clientNum].state).toBe(CS.ACTIVE);
  });

  it('gives a client that has just connected the whole of sv_timeout to send', () => {
    const { host, cvars, connect, challenge } = handshake();
    cvars.set('sv_timeout', '1');
    runUntil(host, 2000);

    connect(`\\protocol\\2\\qport\\5\\challenge\\${challenge()}`);
    runUntil(host, host.svsTime + 1000);
    expect(host.clients[0].state).toBe(CS.CONNECTED);
    runUntil(host, host.svsTime + 100);

    expect(host.clients[0].state).toBe(CS.FREE);
  });

  it('counts from the last packet, so a client that goes on sending is never dropped', () => {
    const { host, cvars } = makeHost();
    cvars.set('sv_timeout', '1');
    const connection = new ClientConnection(testCvars());
    const clientNum = connectLocal(host, connection);

    for (let i = 1; i <= 500; i++) {
      host.runFrame(host.frameMsec);
      if (i % 100 === 0) sendMove(host, connection, [moveCmd(host.time)]);
    }

    expect(host.clients[clientNum].state).toBe(CS.ACTIVE);
  });

  it("frees a zombie's slot sv_zombietime after its last packet, for the next to take", () => {
    const { host } = makeHost({ maxclients: 1 });
    const connection = new ClientConnection(testCvars());
    const clientNum = connectLocal(host, connection);
    // 80 ms into a match, which starts 400 ms into its clock.
    runUntil(host, 480);
    connection.disconnect();
    readPackets(host);
    expect(host.clients[clientNum].state).toBe(CS.ZOMBIE);

    runUntil(host, 480 + 2000);
    expect(host.clients[clientNum].state).toBe(CS.ZOMBIE);
    expect(() => connectRemote(host)).toThrow('Server is full');
    host.runFrame(host.frameMsec);

    expect(host.clients[clientNum].state).toBe(CS.FREE);
    expect(connectRemote(host)).toBe(clientNum);
  });

  it("counts a kicked client's wait from the kick, however long it had been quiet", () => {
    const { host } = makeHost();
    const clientNum = connectRemote(host, '\\name\\Remote');
    runUntil(host, 3000);

    host.sendConsoleCommand('kick Remote\n');
    host.runFrame(host.frameMsec);
    host.runFrame(host.frameMsec);
    expect(host.clients[clientNum].state).toBe(CS.ZOMBIE);

    runUntil(host, host.svsTime + 2000);
    expect(host.clients[clientNum].state).toBe(CS.FREE);
  });

  it('keeps a bot the game reads for, and times out one it stops reading for', () => {
    const fixture = makeHost();
    const { host, game, cvars } = fixture;
    cvars.set('sv_timeout', '1');
    runUntil(host, 2000);
    const reading = addBot(fixture, 'Sarge');
    const idle = addBot(fixture, 'Grunt');
    game.botAIStartFrame = () => {
      host.botGetServerCommand(reading);
    };

    // A bot is timed from when it came in, as a client is from its connect.
    runUntil(host, 3000);
    expect(host.clients[idle].state).toBe(CS.ACTIVE);
    runUntil(host, 3100);

    expect(host.clients[reading].state).toBe(CS.ACTIVE);
    expect(host.clients[idle].state).toBe(CS.FREE);
  });

  it('measures a ping from when a message went to when it was acknowledged, into ps.ping', () => {
    const { host, game } = makeHost();
    const connection = new ClientConnection(testCvars());
    const clientNum = connectLocal(host, connection);
    // Into the world, acknowledging the gamestate in the same instant it went: a round trip of 0.
    sendMove(host, connection, [moveCmd(8)]);
    host.runFrame(host.frameMsec);
    expect(host.clients[clientNum].ping).toBe(0);

    // The next snapshot, read at once and acknowledged 32 ms after it went: the mean of the two.
    while (drain(host, connection) === 0) host.runFrame(host.frameMsec);
    for (let i = 0; i < 4; i++) host.runFrame(host.frameMsec);
    sendMove(host, connection, [moveCmd(host.time)]);
    host.runFrame(host.frameMsec);

    expect(host.clients[clientNum].ping).toBe(16);
    expect(game.playerState(clientNum).ping).toBe(16);
  });

  it("starts a slot's next client with none of the last one's round trips", () => {
    const { host, cvars } = makeHost();
    cvars.set('sv_reconnectlimit', '0');
    const first = new ClientConnection(testCvars());
    const clientNum = connectLocal(host, first);
    // The gamestate acknowledged as it went, and a snapshot 32 ms after: a mean of 16.
    sendMove(host, first, [moveCmd(8)]);
    while (drain(host, first) === 0) host.runFrame(host.frameMsec);
    for (let i = 0; i < 4; i++) host.runFrame(host.frameMsec);
    sendMove(host, first, [moveCmd(host.time)]);
    host.runFrame(host.frameMsec);
    expect(host.clients[clientNum].ping).toBe(16);

    // The same address connecting again, which takes its own slot back, and acknowledges the
    // gamestate as soon as it is sent.
    const second = new ClientConnection(testCvars());
    expect(connectLocal(host, second)).toBe(clientNum);
    sendMove(host, second, [moveCmd(host.time)]);
    host.runFrame(host.frameMsec);

    expect(host.clients[clientNum].ping).toBe(0);
  });

  it('gives a bot a ping of 0, and a client not yet playing 999', () => {
    const fixture = makeHost();
    const { host } = fixture;
    const bot = addBot(fixture, 'Sarge');
    const remote = connectRemote(host, '\\name\\Remote');

    host.runFrame(host.frameMsec);

    expect(host.clients[bot].ping).toBe(0);
    expect(host.clients[remote].ping).toBe(999);
  });

  it('answers ten requests a second from one address, and drops the rest until one drains', () => {
    const { ask, network } = handshake();
    const answered = (text: string) => ask(text).length;

    for (let i = 0; i < 4; i++) expect(answered('getinfo')).toBe(1);
    for (let i = 0; i < 3; i++) expect(answered('getstatus')).toBe(1);
    for (let i = 0; i < 3; i++) expect(answered('getchallenge 1 PlayCanvasQuake')).toBe(1);
    expect(answered('getinfo')).toBe(0);
    expect(answered('getchallenge 1 PlayCanvasQuake')).toBe(0);

    network.advance(999);
    expect(answered('getstatus')).toBe(0);
    network.advance(1);
    expect(answered('getstatus')).toBe(1);
  });

  it('answers ten every 100 ms however many addresses ask', () => {
    const { host, network } = handshake();
    const server = stringToAdr('10.0.0.1')!;
    const now = () => network.now;
    const asks = Array.from({ length: 11 }, (_, i) => {
      const net = new Net({ cvars: testCvars(), socket: network.socket(`10.0.1.${i}`), now });
      return (): boolean => {
        net.outOfBandPrint('client', server, 'getinfo');
        readPackets(host);
        return net.getPacket() !== null;
      };
    });

    expect(asks.map((ask) => ask())).toEqual([...new Array<boolean>(10).fill(true), false]);
    network.advance(100);
    expect(asks[10]()).toBe(true);
  });

  describe('client commands', () => {
    /** A client in the world, and a way to send it a command in a packet of its own. */
    function playing(options: Partial<Omit<HostOptions, 'game'>> = {}) {
      const fixture = makeHost(options);
      const connection = new ClientConnection(testCvars());
      connectLocal(fixture.host, connection);
      const send = (text: string): void => {
        connection.addReliableCommand(text);
        sendMove(fixture.host, connection, [moveCmd(fixture.host.time)]);
      };
      /** What the game module was told the client said. */
      const said = (): string[] => {
        const says = fixture.game.calls.filter((call) => call.startsWith('command 0 say '));
        return says.map((call) => call.slice('command 0 say '.length));
      };
      return { ...fixture, connection, send, said };
    }

    it('pass the game one a second on a dedicated server, each one putting the next off', () => {
      const { host, send, said } = playing({ dedicated: true });
      send('say one');
      host.runFrame(496);
      send('say two');
      host.runFrame(504);
      send('say three');
      host.runFrame(1000);
      send('say four');

      expect(said()).toEqual(['one', 'four']);
    });

    it("still run the host's own on a dedicated server, as a userinfo", () => {
      const { host, send, said } = playing({ dedicated: true });
      send('say one');
      send('userinfo "\\name\\Grunt"');

      expect(host.clients[0].name).toBe('Grunt');
      expect(said()).toEqual(['one']);
    });

    it('all go to the game from a client not yet playing, or on a listen server', () => {
      const dedicated = makeHost({ dedicated: true });
      const connection = new ClientConnection(testCvars());
      connectLocal(dedicated.host, connection);
      for (const text of ['say one', 'say two']) {
        connection.addReliableCommand(text);
        sendMove(dedicated.host, connection, []);
      }
      expect(dedicated.game.calls).toContain('command 0 say two');

      const { send, said } = playing();
      send('say one');
      send('say two');
      expect(said()).toEqual(['one', 'two']);
    });

    it('are not held back with sv_floodProtect 0', () => {
      const { cvars, send, said } = playing({ dedicated: true });
      cvars.set('sv_floodProtect', '0');
      send('say one');
      send('say two');
      expect(said()).toEqual(['one', 'two']);
    });
  });
});

describe('clients across a network', () => {
  /**
   * A host at 10.0.0.1 and two players elsewhere, each a process of its own, on a network 30 to 50
   * ms each way. Every 8 ms each player reads what has landed and sends its last three commands,
   * so that one lost packet costs nothing, and then the host reads and runs a frame.
   */
  function lan() {
    const network = new MemoryNetwork({ latency: 30, jitter: 20 });
    const now = () => network.now;
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    const cvars = store({ showdrop: '1' });
    const serverNet = new Net({ cvars, socket: network.socket('10.0.0.1'), now, print });
    const { host, game } = makeHost({ cvars, net: serverNet, print });

    const players = ['10.0.0.2', '10.0.0.3'].map((address, i) => {
      const net = new Net({
        cvars: testCvars({ net_qport: String(i + 1), showdrop: '1' }),
        socket: network.socket(address),
        now,
        print
      });
      const connection = new ClientConnection(testCvars());
      connection.userinfo = `\\name\\Player${i}`;
      connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
      const cmds: NetUserCmd[] = [];
      return {
        net,
        connection,
        cmds,
        get clientNum() {
          return connection.clientNum;
        }
      };
    });

    const frame = () => {
      network.advance(host.frameMsec);
      for (const player of players) {
        for (let p; (p = player.net.getPacket()) !== null; ) {
          player.connection.packetEvent(p.from, p.data);
        }
        player.cmds.push(moveCmd(host.time + host.frameMsec));
        sendCommands(player.connection, player.cmds.slice(-3));
        player.connection.checkForResend();
      }
      readPackets(host);
      host.runFrame(host.frameMsec);
    };

    return { network, host, game, players, frame, lines };
  }

  it('plays two remote clients at once, through latency, reordering and loss', () => {
    const { network, host, game, players, frame, lines } = lan();

    // The handshakes and the gamestates cross, and the first commands come back, before the
    // network turns bad.
    for (let i = 0; i < 60; i++) frame();
    for (const { clientNum } of players) expect(host.clients[clientNum].state).toBe(CS.ACTIVE);

    network.loss = 0.1;
    for (const { connection, clientNum } of players) {
      connection.addReliableCommand(`say ${clientNum}`);
      host.sendServerCommand(clientNum, `print "to ${clientNum}"`);
    }
    for (let i = 0; i < 250; i++) frame();

    for (const { connection, clientNum } of players) {
      // Each one's commands ran, until moments ago.
      expect(game.playerState(clientNum).commandTime).toBeGreaterThan(host.time - 100);
      // Each one's snapshots are current, and its own.
      expect(connection.snapshots.snap.ps.clientNum).toBe(clientNum);
      expect(connection.snapshots.snap.serverTime).toBeGreaterThan(host.time - 150);
      // Each one's reliable command reached the match once, and the host's reached it once.
      const said = game.calls.filter((call) => call === `command ${clientNum} say ${clientNum}`);
      expect(said).toHaveLength(1);
      const heard: string[] = [];
      for (let c; (c = connection.nextServerCommand()) !== null; ) heard.push(c);
      expect(heard.filter((c) => c === `print "to ${clientNum}"`)).toHaveLength(1);
    }

    // And the network was as bad as it was meant to be.
    expect(network.lost).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes('Out of order packet'))).toBe(true);
  });

  it("measures each one's ping from the round trips, and tells the game", () => {
    const { host, game, players, frame } = lan();
    for (let i = 0; i < 200; i++) frame();

    for (const { clientNum } of players) {
      const { ping } = host.clients[clientNum];
      // 30 to 50 ms each way, and a message is dated by the last packet to acknowledge it, which
      // can come a snapshot interval after the first.
      expect(ping).toBeGreaterThan(60);
      expect(ping).toBeLessThan(100 + host.clients[clientNum].snapshotMsec + 2 * host.frameMsec);
      expect(game.playerState(clientNum).ping).toBe(ping);
    }
  });
});

describe('a client over data channels', () => {
  it('connects, takes the gamestate and plays, over a socket of peer connections', async () => {
    const master = new FakeMaster();
    const rtc = new FakeRtc();
    let time = 0;
    const now = () => time;
    const server = fakePeer(master, rtc.create, '203.0.113.9', { dials: false, now });
    server.link.register(27960);
    const client = fakePeer(master, rtc.create, '198.51.100.4', { dials: true, now });
    await settle();

    const cvars = store();
    const serverNet = new Net({ cvars, socket: server.socket, now, print: () => {} });
    const { host } = makeHost({ cvars, net: serverNet, print: () => {} });
    // A message of the day the compression can do little with, so the gamestate needs fragments.
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const motd = Array.from({ length: 2400 }, (_, i) => letters[(i * 7919 + i * i * 31) % 62]);
    host.setConfigstring(CONFIGSTRING.MOTD, motd.join(''));
    const clientCvars = testCvars({ net_qport: '1' });
    const net = new Net({ cvars: clientCvars, socket: client.socket, now, print: () => {} });
    const connection = new ClientConnection(clientCvars);
    connection.userinfo = '\\name\\Player';
    connection.connect(net, '203.0.113.9:27960', stringToAdr('203.0.113.9:27960')!);

    for (let i = 0; i < 500 && connection.state !== CA.ACTIVE; i++) {
      time += host.frameMsec;
      for (let p; (p = net.getPacket()) !== null; ) connection.packetEvent(p.from, p.data);
      connection.clock.realtime += host.frameMsec;
      connection.setCGameTime();
      connection.sendCmd(createNetUserCmd());
      connection.checkForResend();
      readPackets(host);
      host.runFrame(host.frameMsec);
      await settle();
    }

    expect(connection.state).toBe(CA.ACTIVE);
    expect(connection.snapshots.snap.ps.clientNum).toBe(connection.clientNum);
    // The host knows the client by the address the master gave it.
    expect(host.clients[connection.clientNum].netchan.remoteAddress).toEqual(client.link.address);
    // The gamestate took more than one datagram, and each fitted one SCTP packet.
    const sizes = rtc.connections[1].channels[0].sent.map((data) => data.length);
    expect(Math.max(...sizes)).toBe(1112);
  });
});

describe('a server at the master', () => {
  it.each([
    ['down the channel the master dials', true],
    ['down its own link, at a master that dials nobody', false]
  ])('answers the getinfo its heartbeat earns, %s', async (_, dials) => {
    const rtc = new FakeRtc();
    const now = () => 0;
    const master = new MasterServer({
      createPeerConnection: dials ? rtc.create : undefined,
      now,
      lookup: async () => [],
      print: () => {}
    });
    const server = masterPeer(master, rtc.create, '203.0.113.9', { dials: false, now });
    server.link.register(27960);
    await settle();
    const cvars = store();
    const serverNet = new Net({ cvars, socket: server.socket, now, print: () => {} });
    const { host } = makeHost({ cvars, net: serverNet, print: () => {} });

    serverNet.outOfBandPrint('server', MASTER_ADR, 'heartbeat DarkPlaces\n');
    await settle();
    readPackets(host);
    await settle();
    master.frame();

    const client = masterPeer(master, rtc.create, '198.51.100.4', { dials: true, now });
    await settle();
    client.socket.send(oob('getservers PlayCanvasQuake 2 empty'), MASTER_ADR);
    await settle();
    const replies = [];
    for (let p; (p = client.socket.receive()) !== null; ) replies.push(readList(p.data));
    expect(replies).toEqual([['203.0.113.9:27960']]);
    expect(rtc.connections).toHaveLength(dials ? 2 : 0);
  });
});

/** A host at 203.0.113.9 on a network in memory, with these cvars set. */
function onNetwork(values: Record<string, string>) {
  const network = new MemoryNetwork();
  const now = () => network.now;
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);
  const cvars = store(values);
  const net = new Net({ cvars, socket: network.socket('203.0.113.9'), now, print });
  return { ...makeHost({ cvars, net, print }), network, lines };
}

/** What has reached a socket, as the text behind the out-of-band marker. */
function landed(socket: { receive(): { data: Uint8Array } | null }): string[] {
  const texts: string[] = [];
  for (let p; (p = socket.receive()) !== null; ) {
    texts.push(String.fromCharCode(...p.data.subarray(4)));
  }
  return texts;
}

describe('the heartbeat', () => {
  /** A public server, and the Internet's master and the LAN's, as their sockets on the network. */
  function publicServer(cvars: Record<string, string> = {}) {
    const fixture = onNetwork({
      dedicated: '2',
      sv_master1: 'master.test',
      sv_master2: 'lan.test',
      ...cvars
    });
    const master = fixture.network.socket('master.test:27950');
    const lan = fixture.network.socket('lan.test:27950');
    return { ...fixture, heartbeats: () => landed(master), lan: () => landed(lan) };
  }

  it('goes at the end of the first frame after a spawn, and 300 s after that', () => {
    const { host, heartbeats, lines } = publicServer();
    expect(heartbeats()).toEqual([]);

    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual(['heartbeat DarkPlaces\n']);
    expect(lines).toContain('Sending heartbeat to master.test');

    host.runFrame(300000 - host.frameMsec);
    expect(heartbeats()).toEqual([]);
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual(['heartbeat DarkPlaces\n']);
  });

  it('goes to every master the slots name, and once to a master two of them name', () => {
    const sending = (lines: string[]) => lines.filter((line) => line.startsWith('Sending'));
    const { host, heartbeats, lan, lines } = publicServer();
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual(['heartbeat DarkPlaces\n']);
    expect(lan()).toEqual(['heartbeat DarkPlaces\n']);
    expect(sending(lines)).toEqual([
      'Sending heartbeat to master.test',
      'Sending heartbeat to lan.test'
    ]);

    const shared = publicServer({ sv_master2: 'master.test:27950' });
    shared.host.runFrame(shared.host.frameMsec);
    expect(shared.heartbeats()).toEqual(['heartbeat DarkPlaces\n']);
    expect(sending(shared.lines)).toEqual(['Sending heartbeat to master.test']);
  });

  it('is sent only by a public server, dedicated 2, and only to masters the slots name', () => {
    for (const dedicated of ['0', '1', '']) {
      const { host, heartbeats, lan } = publicServer({ dedicated });
      host.runFrame(host.frameMsec);
      expect([...heartbeats(), ...lan()]).toEqual([]);
    }
    const { host, heartbeats, lan, lines } = publicServer({ sv_master1: '' });
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual([]);
    expect(lan()).toEqual(['heartbeat DarkPlaces\n']);
    expect(lines.filter((line) => line.startsWith('Sending heartbeat'))).toEqual([
      'Sending heartbeat to lan.test'
    ]);
  });

  it('is not sent from a paused frame, which runs nothing', () => {
    const { host, heartbeats, cvars } = publicServer();
    connectLocal(host);
    cvars.set('cl_paused', '1');
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual([]);

    cvars.set('cl_paused', '0');
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual(['heartbeat DarkPlaces\n']);
  });

  it('is asked for by a map spawn, as a map change shows', () => {
    const { host, heartbeats } = publicServer();
    host.runFrame(host.frameMsec);
    heartbeats();
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual([]);

    host.spawnServer({ name: 'test', entities: '' });
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual(['heartbeat DarkPlaces\n']);
  });

  it('is asked for by the heartbeat command, at the end of the next frame', () => {
    const { host, heartbeats } = publicServer();
    host.runFrame(host.frameMsec);
    heartbeats();

    host.sendConsoleCommand('heartbeat');
    expect(heartbeats()).toEqual([]);
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual(['heartbeat DarkPlaces\n']);
  });

  it('is asked for by a master granting a registration, at the end of the next frame', () => {
    const { host, heartbeats, lan } = publicServer();
    host.runFrame(host.frameMsec);
    heartbeats();
    lan();

    host.masterRegistered();
    expect(heartbeats()).toEqual([]);
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual(['heartbeat DarkPlaces\n']);
    expect(lan()).toEqual(['heartbeat DarkPlaces\n']);
  });

  it('is asked for by the first client, and by a connect that fills the server', () => {
    const first = publicServer();
    first.host.runFrame(first.host.frameMsec);
    first.heartbeats();
    connectLocal(first.host);
    first.host.runFrame(first.host.frameMsec);
    expect(first.heartbeats()).toEqual(['heartbeat DarkPlaces\n']);

    // A bot joining asks for none, but counts: the connect behind it fills the server.
    const full = publicServer();
    full.host.runFrame(full.host.frameMsec);
    full.heartbeats();
    for (let i = 0; i < full.host.maxclients - 1; i++) addBot(full, `Bot${i}`);
    full.host.runFrame(full.host.frameMsec);
    expect(full.heartbeats()).toEqual([]);
    connectLocal(full.host);
    full.host.runFrame(full.host.frameMsec);
    expect(full.heartbeats()).toEqual(['heartbeat DarkPlaces\n']);
  });

  it('is asked for when the last client leaves, bots counted', () => {
    const fixture = publicServer();
    const { host, heartbeats } = fixture;
    const player = connectLocal(host);
    const bot = addBot(fixture, 'Sarge');
    host.runFrame(host.frameMsec);
    heartbeats();

    host.dropClient(player, 'left');
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual([]);
    host.dropClient(bot, 'left');
    host.runFrame(host.frameMsec);
    expect(heartbeats()).toEqual(['heartbeat DarkPlaces\n']);
  });
});

describe('a shutdown', () => {
  /** A public server with a player at 198.51.100.2 in the world, and the local one beside it. */
  function withPlayers() {
    const fixture = onNetwork({ dedicated: '2', sv_master1: 'master.test' });
    const { host, network } = fixture;
    const master = network.socket('master.test:27950');
    const clientCvars = testCvars({ net_qport: '1' });
    const net = new Net({
      cvars: clientCvars,
      socket: network.socket('198.51.100.2'),
      now: () => network.now,
      print: () => {}
    });
    const remote = new ClientConnection(clientCvars);
    remote.userinfo = '\\name\\Remote';
    remote.connect(net, '203.0.113.9', stringToAdr('203.0.113.9')!);
    for (let i = 0; i < 200 && remote.state !== CA.ACTIVE; i++) {
      network.advance(host.frameMsec);
      for (let p; (p = net.getPacket()) !== null; ) remote.packetEvent(p.from, p.data);
      remote.clock.realtime += host.frameMsec;
      remote.setCGameTime();
      remote.sendCmd(createNetUserCmd());
      remote.checkForResend();
      readPackets(host);
      host.runFrame(host.frameMsec);
    }
    expect(remote.state).toBe(CA.ACTIVE);
    /** The server commands a client has been sent since it was last asked. */
    const heard = (connection: ClientConnection): string[] => {
      const commands: string[] = [];
      for (let c; (c = connection.nextServerCommand()) !== null; ) commands.push(c);
      return commands;
    };

    const local = new ClientConnection(testCvars());
    connectLocal(host, local);
    landed(master);
    drain(host, local);
    for (let p; (p = net.getPacket()) !== null; ) remote.packetEvent(p.from, p.data);
    heard(remote);
    return { ...fixture, master, net, remote, local, heard };
  }

  it('tells each remote client why, twice, with a snapshot, and the local one nothing', () => {
    const { host, network, net, remote, local, heard } = withPlayers();
    const before = network.sent.length;

    host.shutdown('Server quit');

    const toRemote = network.sent.slice(before).filter(({ to }) => to.ip === '198.51.100.2');
    expect(toRemote).toHaveLength(2);
    for (let p; (p = net.getPacket()) !== null; ) remote.packetEvent(p.from, p.data);
    // Each pass adds both commands again, and a snapshot carries every one not acknowledged.
    const told = ['print "Server quit\n"\n', 'disconnect "Server quit"'];
    expect(heard(remote)).toEqual([...told, ...told]);

    // The local client is sent the snapshots, and none of the commands: it goes with the server.
    expect(drain(host, local)).toBe(2);
    expect(heard(local)).toEqual([]);
  });

  it('tells no client anything when Com_Error shuts it down, and still tells the master', () => {
    const { host, network, net, remote, local, heard, lines, master } = withPlayers();
    const before = network.sent.length;
    lines.length = 0;

    host.shutdown('Server crashed: boom', true);

    const toRemote = network.sent.slice(before).filter(({ to }) => to.ip === '198.51.100.2');
    expect(toRemote).toEqual([]);
    for (let p; (p = net.getPacket()) !== null; ) remote.packetEvent(p.from, p.data);
    expect(heard(remote)).toEqual([]);
    expect(drain(host, local)).toBe(0);
    expect(lines[0]).toBe('----- Server Shutdown (Server crashed: boom) -----');
    expect(landed(master)).toEqual(['heartbeat DarkPlaces\n', 'heartbeat DarkPlaces\n']);
  });

  it("prints Q3's banner, says the server is not running, and tells the master twice", () => {
    const { host, cvars, lines, master } = withPlayers();
    lines.length = 0;

    host.shutdown('dedicated set to 0');

    expect(lines).toEqual([
      '----- Server Shutdown (dedicated set to 0) -----',
      'Sending heartbeat to master.test',
      'Sending heartbeat to master.test',
      '---------------------------'
    ]);
    expect(landed(master)).toEqual(['heartbeat DarkPlaces\n', 'heartbeat DarkPlaces\n']);
    expect(cvars.get('sv_running')).toBe('0');
    expect(host.state).toBe(SS.DEAD);
  });

  it('tells a dropped client nothing more, since its slot is only waiting to be freed', () => {
    const { host, network, remote } = withPlayers();
    host.dropClient(remote.clientNum, 'was kicked');
    const before = network.sent.length;

    host.shutdown('Server quit');

    const toRemote = network.sent.slice(before).filter(({ to }) => to.ip === '198.51.100.2');
    expect(toRemote).toEqual([]);
  });

  it('does nothing to a server that is not running', () => {
    const { host, network, lines } = withPlayers();
    host.shutdown('Server quit');
    const sent = network.sent.length;
    lines.length = 0;

    host.shutdown('Server quit');

    expect(network.sent.length).toBe(sent);
    expect(lines).toEqual([]);
  });
});

describe("a client's rate", () => {
  /**
   * A host at 198.51.100.1 and one player at 198.51.100.2 — not on a private address, so the
   * LAN rule leaves its rate alone — on a network the test moves by hand. Its userinfo asks for
   * `rate`, and its frames run as the program's do, so it keeps sending commands and reading
   * snapshots while the host's own frames run.
   */
  function remote(rate: string) {
    const network = new MemoryNetwork();
    const now = () => network.now;
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    const cvars = store();
    const serverNet = new Net({ cvars, socket: network.socket('198.51.100.1'), now, print });
    const { host, game } = makeHost({ cvars, net: serverNet, print });

    const clientCvars = testCvars({ net_qport: '1' });
    const net = new Net({ cvars: clientCvars, socket: network.socket('198.51.100.2'), now, print });
    const connection = new ClientConnection(clientCvars);
    connection.userinfo = `\\name\\Player\\rate\\${rate}`;
    connection.connect(net, '198.51.100.1', stringToAdr('198.51.100.1')!);

    const frame = (): void => {
      network.advance(host.frameMsec);
      for (let p; (p = net.getPacket()) !== null; ) connection.packetEvent(p.from, p.data);
      connection.clock.realtime += host.frameMsec;
      connection.setCGameTime();
      connection.sendCmd(createNetUserCmd());
      connection.checkForResend();
      readPackets(host);
      host.runFrame(host.frameMsec);
    };

    /** A second of frames, and the snapshots it brought and how many were held back. */
    const second = (): { snapshots: number; flagged: number } => {
      let snapshots = 0;
      let flagged = 0;
      let last = -1;
      for (let i = 0; i < 125; i++) {
        frame();
        const snap = connection.snapshots.snap;
        if (snap.serverTime === last) continue;
        snapshots++;
        last = snap.serverTime;
        if ((snap.snapFlags & SNAPFLAG.RATE_DELAYED) !== 0) flagged++;
      }
      return { snapshots, flagged };
    };

    // Into the world: the gamestate may go in fragments, which the rate paces.
    for (let i = 0; i < 500 && connection.state !== CA.ACTIVE; i++) frame();
    expect(connection.state).toBe(CA.ACTIVE);

    return { network, host, game, net, connection, cvars, frame, second, lines };
  }

  it('brings a client snapshots at its own rate', () => {
    const { connection, frame, second } = remote('25000');
    // The first snapshot came due as the gamestate went, and the rate held it behind that: the
    // second of frames is counted from the snapshot after.
    const entered = connection.snapshots.snap.serverTime;
    for (let i = 0; i < 125 && connection.snapshots.snap.serverTime === entered; i++) frame();
    // A message of a few hundred bytes at 25000 is a handful of milliseconds, under the 50 ms
    // cadence: a second of frames brings about twenty snapshots and holds none.
    const { snapshots, flagged } = second();
    expect(snapshots).toBeGreaterThanOrEqual(18);
    expect(snapshots).toBeLessThanOrEqual(22);
    expect(flagged).toBe(0);
    expect(connection.snapshots.snap.ps.clientNum).toBe(connection.clientNum);
  });

  it("holds a slow client's snapshots back, and says so in the flags", () => {
    const { network, host, connection } = remote('1000');
    const clientNum = connection.clientNum;
    // A long command that stays unacknowledged, so every message carries it and the rate has
    // something to hold back.
    host.sendServerCommand(clientNum, `print "${'x'.repeat(900)}"`);
    const client = host.clients[clientNum];
    const before = client.netchan.outgoingSequence;
    for (let i = 0; i < 125; i++) {
      network.advance(host.frameMsec);
      host.runFrame(host.frameMsec);
    }

    // A second of frames: at 1000, a ~950-byte message takes about a second to go, so one or two
    // snapshots rather than twenty.
    const sent = client.netchan.outgoingSequence - before;
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(sent).toBeLessThanOrEqual(3);
    expect(client.rateDelayed).toBe(true);
  });

  it('holds a client to the bounds sv_maxRate and sv_minRate set', () => {
    const slow = remote('25000');
    slow.cvars.set('sv_maxRate', '1000');
    const slowClient = slow.host.clients[slow.connection.clientNum];
    slow.host.sendServerCommand(slow.connection.clientNum, `print "${'x'.repeat(900)}"`);
    const slowBefore = slowClient.netchan.outgoingSequence;
    for (let i = 0; i < 125; i++) {
      slow.network.advance(slow.host.frameMsec);
      slow.host.runFrame(slow.host.frameMsec);
    }
    // Its own rate says 25000, but the bound holds it to 1000.
    expect(slowClient.netchan.outgoingSequence - slowBefore).toBeLessThanOrEqual(3);

    const fast = remote('1000');
    fast.cvars.set('sv_minRate', '90000');
    const fastClient = fast.host.clients[fast.connection.clientNum];
    const fastBefore = fastClient.netchan.outgoingSequence;
    for (let i = 0; i < 125; i++) {
      fast.network.advance(fast.host.frameMsec);
      fast.host.runFrame(fast.host.frameMsec);
    }
    // Its own rate says 1000, but the bound lifts it to 90000: the cadence alone, about twenty.
    expect(fastClient.netchan.outgoingSequence - fastBefore).toBeGreaterThanOrEqual(18);
  });

  it('paces a long message a fragment at a time, and holds the next snapshot behind it', () => {
    const { network, host, connection } = remote('25000');
    const clientNum = connection.clientNum;
    // A command far past one datagram.
    host.sendServerCommand(clientNum, `print "${'x'.repeat(4000)}"`);
    const client = host.clients[clientNum];

    // The message is far past one datagram: the first fragment goes and the rest wait.
    network.advance(snapshotFrame(host, clientNum));
    host.runFrame(snapshotFrame(host, clientNum));
    expect(client.netchan.unsentFragments).toBe(true);

    // The next snapshot is held behind them, and the flags say so.
    network.advance(snapshotFrame(host, clientNum));
    host.runFrame(snapshotFrame(host, clientNum));
    expect(client.rateDelayed).toBe(true);

    // A message that comes while the fragments are still going waits behind them, whole, rather
    // than being transmitted over the part-sent one.
    host.sendClientGameState(client);
    expect(client.queuedMessages).toHaveLength(1);
    expect(client.netchan.unsentFragments).toBe(true);

    // Time, and the queued sends, carry the rest over the frames, in order. A fragmented message
    // keeps one sequence number, so the fragments are counted on the wire.
    const before = network.sent.length;
    for (let i = 0; i < 100 && client.netchan.unsentFragments; i++) {
      network.advance(50);
      host.sendQueuedMessages();
    }
    expect(client.netchan.unsentFragments).toBe(false);
    expect(network.sent.length - before).toBeGreaterThan(1);

    // And the queued message went after them.
    for (let i = 0; i < 100 && client.queuedMessages.length > 0; i++) {
      network.advance(50);
      host.sendQueuedMessages();
    }
    expect(client.queuedMessages).toHaveLength(0);
  });

  it('still paces the loopback, which its LAN rate does not hold back', () => {
    const { host } = makeHost();
    const local = new ClientConnection(testCvars());
    const clientNum = connectLocal(host, local);
    expect(host.clients[clientNum].rate).toBe(99999);

    // The loopback's own long message goes a fragment at a time too.
    host.sendServerCommand(clientNum, `print "${'x'.repeat(4000)}"`);
    host.runFrame(snapshotFrame(host));
    expect(host.clients[clientNum].netchan.unsentFragments).toBe(true);
    // And it drains with the host's frames.
    for (let i = 0; i < 100 && host.clients[clientNum].netchan.unsentFragments; i++) {
      runQueued(host);
    }
    expect(host.clients[clientNum].netchan.unsentFragments).toBe(false);
  });
});

describe("a client's own commands across a network", () => {
  /**
   * A host at 198.51.100.1 and a player at 198.51.100.2, 20 ms each way, running its frames as the
   * program runs the local one's: the clock set, the commands made, a packet if one is due, and
   * then the host's frame. What the match ran is kept by each command's time. The addresses are
   * outside every private range, so `cl_maxpackets` paces the client rather than the LAN rule.
   */
  function remote(settings: Record<string, string> = {}, server = '198.51.100.1') {
    const network = new MemoryNetwork({ latency: 20 });
    const now = () => network.now;
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    const hostCvars = store();
    const serverNet = new Net({ cvars: hostCvars, socket: network.socket(server), now, print });
    const { host, game } = makeHost({ cvars: hostCvars, net: serverNet, print });

    const cvars = testCvars({ net_qport: '1', ...settings });
    const net = new Net({ cvars, socket: network.socket('198.51.100.2'), now, print });
    const connection = new ClientConnection(cvars);
    connection.userinfo = '\\rate\\25000';
    connection.connect(net, server, stringToAdr(server)!);
    const address = stringToAdr('198.51.100.2')!;

    const ran: number[] = [];
    const think = game.clientThink.bind(game);
    game.clientThink = (clientNum) => {
      ran.push(host.getUserCmd(clientNum).serverTime);
      think(clientNum);
    };

    const frame = (msec = 8): void => {
      network.advance(msec);
      for (let p; (p = net.getPacket()) !== null; ) connection.packetEvent(p.from, p.data);
      connection.clock.realtime += msec;
      connection.setCGameTime();
      connection.sendCmd(createNetUserCmd());
      connection.checkForResend();
      readPackets(host);
      host.runFrame(msec);
    };
    /** How many sequenced packets the player has put on the wire. */
    const packets = (): number =>
      network.sent.filter(
        ({ packet }) => compareBaseAdr(packet.from, address) && !isOutOfBand(packet.data)
      ).length;

    // Connected, in the world, and a second into its commands.
    for (let i = 0; i < 125; i++) frame();
    expect(connection.state).toBe(CA.ACTIVE);
    ran.length = 0;

    return { network, cvars, hostCvars, connection, frame, ran, packets, lines, address };
  }

  /** Whether every step's command ran, once and in order. */
  const everyStep = (times: readonly number[]): boolean =>
    times.every((time, i) => i === 0 || time - times[i - 1] === 8);

  it('makes one command a step, and sends them cl_maxpackets a second', () => {
    const { frame, ran, packets } = remote();
    const sent = packets();
    for (let i = 0; i < 250; i++) frame();

    // 125 a second is one every 8 ms frame, the port's default: a packet each frame.
    expect(packets() - sent).toBe(250);
    // Two seconds of steps, give or take the ones held for the next packet or on the wire.
    expect(Math.abs(ran.length - 250)).toBeLessThanOrEqual(8);
    expect(everyStep(ran)).toBe(true);
  });

  it("makes a command a step of the server's pmove_msec, so the server runs every one", () => {
    const { hostCvars, cvars, connection, frame, ran } = remote();
    hostCvars.set('pmove_msec', '16');
    // The systeminfo's `cs` brings it over, once the client takes its server commands, as the
    // view does each frame.
    for (let i = 0; i < 25; i++) {
      frame();
      while (connection.nextServerCommand() !== null) continue;
    }
    expect(cvars.get('pmove_msec')).toBe('16');
    ran.length = 0;

    for (let i = 0; i < 250; i++) frame();
    // Every command is on the server's grid, a step after the last, so none is thrown away.
    const onGrid = ran.every((time, i) => time % 16 === 0 && (i === 0 || time - ran[i - 1] === 16));
    expect(onGrid).toBe(true);
    expect(Math.abs(ran.length - 125)).toBeLessThanOrEqual(4);
  });

  it('holds cl_maxpackets to between 15 and 125, and cl_packetdup to between 0 and 5', () => {
    const { cvars, frame } = remote();
    cvars.set('cl_maxpackets', '5');
    cvars.set('cl_packetdup', '-1');
    for (let i = 0; i < 10; i++) frame();
    expect(cvars.get('cl_maxpackets')).toBe('15');
    expect(cvars.get('cl_packetdup')).toBe('0');

    cvars.set('cl_maxpackets', '500');
    cvars.set('cl_packetdup', '9');
    for (let i = 0; i < 10; i++) frame();
    expect(cvars.get('cl_maxpackets')).toBe('125');
    expect(cvars.get('cl_packetdup')).toBe('5');
  });

  it('sends every frame to a LAN server, as the loopback does, unless told not to', () => {
    // The server is on a private address, so `cl_lanForcePackets` (1) skips `cl_maxpackets`.
    const lan = remote({}, '10.0.0.1');
    const sent = lan.packets();
    for (let i = 0; i < 50; i++) lan.frame();
    expect(lan.packets() - sent).toBe(50);

    // With it off, the client is paced like any other: 30 a second is 33 ms apart, which 8 ms
    // frames reach every fourth or fifth.
    const paced = remote({ cl_lanForcePackets: '0', cl_maxpackets: '30' }, '10.0.0.1');
    const before = paced.packets();
    for (let i = 0; i < 50; i++) paced.frame();
    expect(paced.packets() - before).toBe(10);
  });

  it("loses no command with a packet while cl_packetdup's repeat of it gets through", () => {
    const { network, frame, ran, address } = remote();
    let drop = true;
    network.filter = ({ from, data }) => {
      if (!compareBaseAdr(from, address) || isOutOfBand(data) || !drop) return true;
      drop = false;
      return false;
    };
    for (let i = 0; i < 50; i++) frame();

    expect(drop).toBe(false);
    expect(everyStep(ran)).toBe(true);
  });

  it('loses the commands of a lost packet with cl_packetdup 0', () => {
    const { network, cvars, frame, ran, address } = remote({ cl_packetdup: '0', cl_maxpackets: '30' });
    let drop = true;
    network.filter = ({ from, data }) => {
      if (!compareBaseAdr(from, address) || isOutOfBand(data) || !drop) return true;
      drop = false;
      return false;
    };
    for (let i = 0; i < 50; i++) frame();

    expect(cvars.get('cl_packetdup')).toBe('0');
    const gaps = ran.slice(1).map((time, i) => time - ran[i]);
    // A packet's worth of steps, five 8 ms frames, went with it.
    expect(gaps.filter((gap) => gap !== 8)).toEqual([48]);
  });

  it('carries no more than 32 commands in a packet, and says so', () => {
    const { frame, ran, lines } = remote({ cl_maxpackets: '15', cl_packetdup: '5' });
    for (let i = 0; i < 100; i++) frame();

    expect(lines).toContain('MAX_PACKET_USERCMDS');
    expect(everyStep(ran)).toBe(true);
  });
});

describe('a bot', () => {
  it('takes the first free slot, playing at once, with nothing to send it', () => {
    const { host, game } = makeHost();
    connectLocal(host);

    const clientNum = host.botAllocateClient();

    expect(clientNum).toBe(1);
    const client = host.clients[1];
    expect(client.state).toBe(CS.ACTIVE);
    expect(client.netchan.remoteAddress.type).toBe(NA.BOT);
    expect(client.gentity).toBe(game.entity(1));
    expect(game.entity(1).s.number).toBe(1);
    expect(host.clients[0].netchan.remoteAddress.type).toBe(NA.LOOPBACK);

    expect(host.botAllocateClient()).toBe(2);
    expect(host.botAllocateClient()).toBe(3);
    expect(host.botAllocateClient()).toBe(-1);
  });

  it('is named by its userinfo, as any client is', () => {
    const { host } = makeHost();
    const clientNum = host.botAllocateClient();
    host.setUserinfo(clientNum, '\\name\\^1Crash\\model\\crash');
    expect(host.clients[clientNum].name).toBe('^1Crash');
  });

  it('reads the commands it is sent, each read one acknowledged', () => {
    const fixture = makeHost();
    const clientNum = addBot(fixture, 'Sarge');
    const { host } = fixture;
    host.sendServerCommand(null, 'print "one"');
    host.sendServerCommand(clientNum, 'print "two"');

    expect(host.botGetServerCommand(clientNum)).toBe('print "one"');
    expect(host.botGetServerCommand(clientNum)).toBe('print "two"');
    expect(host.botGetServerCommand(clientNum)).toBeNull();
    const client = host.clients[clientNum];
    expect(client.reliableAcknowledge).toBe(client.reliableSequence);
  });

  it('is dropped once 64 commands go unread, as a client is, and its slot is free at once', () => {
    const fixture = makeHost();
    const clientNum = addBot(fixture, 'Sarge');
    const { host, game } = fixture;

    for (let i = 0; i < 64; i++) host.sendServerCommand(clientNum, `print "${i}"`);
    expect(host.clients[clientNum].state).toBe(CS.ACTIVE);
    host.sendServerCommand(clientNum, 'print "one too many"');

    expect(game.calls).toContain(`disconnect ${clientNum}`);
    expect(host.clients[clientNum].state).toBe(CS.FREE);
  });

  it("settles a map load: three 100 ms frames with the bots', and one after the clients", () => {
    const fixture = makeHost();
    const { host, game } = fixture;
    expect(game.frameLog.map(({ time }) => time)).toEqual([0, 100, 200, 300]);
    expect(game.botFrames).toEqual([
      { time: 0, frames: 1 },
      { time: 100, frames: 2 },
      { time: 200, frames: 3 },
      { time: 300, frames: 4 }
    ]);
    expect([host.time, host.svsTime]).toEqual([400, 400]);

    // The last of a load's frames comes once the clients are back, a bot in the world with them.
    addBot(fixture, 'Sarge');
    game.calls.length = 0;
    game.frameLog.length = 0;
    host.spawnServer({ name: 'test', entities: '' });
    const begun = game.calls.indexOf('begin 0');
    expect(begun).toBeGreaterThan(0);
    expect(game.frameLog.map(({ calls }) => calls > begun)).toEqual([false, false, false, true]);
  });

  it('settles a restart the same way, but for the bots, from the clock as it stands', () => {
    const fixture = makeHost();
    const { host, game } = fixture;
    addBot(fixture, 'Sarge');
    game.calls.length = 0;
    game.frameLog.length = 0;
    game.botFrames.length = 0;

    host.mapRestart(0);

    expect(game.frameLog.map(({ time }) => time)).toEqual([400, 500, 600, 700]);
    const begun = game.calls.indexOf('begin 0');
    expect(game.frameLog.map(({ calls }) => calls > begun)).toEqual([false, false, false, true]);
    expect(game.botFrames).toEqual([]);
    expect(host.time).toBe(800);
  });

  it("runs the bots' frame before the game's, at the time those frames are to reach", () => {
    const { host, game } = makeHost();
    // A map load's own settle frames run the bots' frame after the game's: they are left out.
    game.botFrames.length = 0;
    game.frames = 0;

    host.runFrame(20);
    host.runFrame(8);

    // 20 runs two frames of 8 and leaves 4; 8 more makes 12, which runs one and leaves 4 again.
    // A match starts 400 ms into its clock.
    expect(game.botFrames).toEqual([
      { time: 420, frames: 0 },
      { time: 428, frames: 2 }
    ]);
    expect(game.frames).toBe(3);
  });

  it("runs a bot's command as a client's is run", () => {
    const fixture = makeHost();
    const clientNum = addBot(fixture, 'Sarge');
    const { host, game } = fixture;

    host.botUserCommand(clientNum, moveCmd(40));

    expect(game.thinks).toBe(1);
    expect(host.getUserCmd(clientNum).serverTime).toBe(40);
  });

  it('frees a dropped bot at once, where a dropped client waits as a zombie', () => {
    const fixture = makeHost();
    const bot = addBot(fixture, 'Sarge');
    const { host, game } = fixture;
    const remote = connectRemote(host, '\\name\\Remote');

    host.dropClient(bot, 'was kicked');
    host.dropClient(remote, 'was kicked');

    expect(host.clients[bot].state).toBe(CS.FREE);
    expect(host.clients[bot].name).toBe('');
    expect(game.entity(bot).r.svFlags & SVF.BOT).toBe(0);
    expect(host.clients[remote].state).toBe(CS.ZOMBIE);
    expect(host.botAllocateClient()).toBe(bot);
  });

  it('tells everyone in the world who left and why, white after the name', () => {
    const fixture = makeHost();
    const { host } = fixture;
    const playing = connectLocal(host);
    host.clientEnterWorld(playing, null);
    const bot = addBot(fixture, 'Sarge');

    host.dropClient(bot, 'was kicked');

    expect(host.clients[playing].reliableCommands).toContain('print "Sarge^7 was kicked\n"');
  });

  it('is kept across a map load, and goes straight back into the world', () => {
    const fixture = makeHost();
    const { host, game } = fixture;
    connectLocal(host);
    const clientNum = addBot(fixture, 'Sarge');
    game.calls.length = 0;

    host.spawnServer({ name: 'next', entities: '' });

    expect(game.calls).toEqual([
      'shutdown false',
      'init 0 false',
      'connect 0 false',
      `connect ${clientNum} false bot`,
      `begin ${clientNum}`
    ]);
    expect(host.clients[0].state).toBe(CS.CONNECTED);
    expect(host.clients[clientNum].state).toBe(CS.ACTIVE);
    expect(host.clients[clientNum].gentity).toBe(game.entity(clientNum));
  });

  it('is told it is a bot when the match restarts', () => {
    const fixture = makeHost();
    const clientNum = addBot(fixture, 'Sarge');
    fixture.game.calls.length = 0;

    fixture.host.mapRestart(0);

    expect(fixture.game.calls).toContain(`connect ${clientNum} false bot`);
  });

  describe('kicked', () => {
    let fixture: Fixture;
    let lines: string[];

    beforeEach(() => {
      lines = [];
      fixture = makeHost({ print: (text) => lines.push(text), maxclients: 5 });
      connectLocal(fixture.host, undefined, '\\name\\Me');
      addBot(fixture, '^1Sarge');
      addBot(fixture, 'Grunt');
      connectRemote(fixture.host, '\\name\\Remote');
      // What connecting printed.
      lines.length = 0;
    });

    /** Run a console command, and say who is left in each slot. */
    function run(command: string): string[] {
      fixture.host.sendConsoleCommand(`${command}\n`);
      fixture.host.executeCommands();
      return fixture.host.clients.map((client) => (client.state === CS.FREE ? '-' : client.name));
    }

    it('by name, with or without its colours, or by slot', () => {
      expect(run('kick sarge')).toEqual(['Me', '-', 'Grunt', 'Remote', '-']);
      expect(run('kick 2')).toEqual(['Me', '-', '-', 'Remote', '-']);
      run('kick REMOTE');
      expect(fixture.host.clients[3].state).toBe(CS.ZOMBIE);
      expect(fixture.game.calls.filter((call) => call.startsWith('disconnect'))).toEqual([
        'disconnect 1',
        'disconnect 2',
        'disconnect 3'
      ]);
    });

    it('never the client in this process', () => {
      expect(run('kick Me')).toEqual(['Me', '^1Sarge', 'Grunt', 'Remote', '-']);
      expect(run('clientkick 0')).toEqual(['Me', '^1Sarge', 'Grunt', 'Remote', '-']);
      expect(lines).toEqual(['Cannot kick host player', 'Cannot kick host player']);
    });

    it('all bots, two ways', () => {
      expect(run('kickbots')).toEqual(['Me', '-', '-', 'Remote', '-']);
      addBot(fixture, 'Sarge');
      expect(run('kick allbots')).toEqual(['Me', '-', '-', 'Remote', '-']);
      // `kick all` and `kick allbots` are what a kick falls back to when nobody has that name.
      expect(lines).toEqual(['Player allbots is not on the server']);
    });

    it('everyone but the client in this process, with kick all', () => {
      run('kick all');
      // The client here has been sent its gamestate and has not answered, so it is only primed.
      expect(fixture.host.clients.map((client) => client.state)).toEqual([
        CS.PRIMED,
        CS.FREE,
        CS.FREE,
        CS.ZOMBIE,
        CS.FREE
      ]);
    });

    it('by slot alone with clientkick, which says what is wrong with one', () => {
      expect(run('clientkick 2')).toEqual(['Me', '^1Sarge', '-', 'Remote', '-']);
      run('clientkick grunt');
      run('clientkick 9');
      run('clientkick 4');
      run('clientkick');
      expect(lines).toEqual([
        'Bad slot number: grunt',
        'Bad client slot: 9',
        'Client 4 is not active',
        'Usage: clientkick <client number>'
      ]);
    });

    it('says who it cannot find, and how it is used', () => {
      run('kick nobody');
      run('kick');
      expect(lines).toEqual([
        'Player nobody is not on the server',
        'Usage: kick <player name>',
        'kick all = kick everyone',
        'kick allbots = kick all bots'
      ]);
    });
  });
});

describe('a trace', () => {
  /** The map: a wall whose near face is at x = 200. */
  const WALL = createBoxWorldTrace([box(200, -512, -512, 216, 512, 512)]);
  const POINT = vec3();
  const { mins, maxs } = playerBounds(false);

  let fixture: Fixture;
  beforeEach(() => {
    fixture = makeHost({}, WALL);
  });

  /** A standing player's box at `origin`, made of `contents` and owned by `ownerNum`, linked. */
  function place(
    origin: Vec3,
    contents: number = CONTENTS.BODY,
    ownerNum: number = ENTITYNUM_NONE
  ): GameEntity {
    const entity = fixture.game.level.spawnEntity();
    entity.r.mins = copy(mins);
    entity.r.maxs = copy(maxs);
    entity.r.currentOrigin = copy(origin);
    entity.r.contents = contents;
    entity.r.ownerNum = ownerNum;
    fixture.host.linkEntity(entity);
    return entity;
  }

  /** A shot along +x from the origin, as far as `x`. */
  function shot(x: number, passEntityNum = ENTITYNUM_NONE, contentmask: number = MASK.SHOT) {
    return fixture.host.trace(vec3(), POINT, POINT, vec3(x, 0, 0), passEntityNum, contentmask);
  }

  it('stops at the box of an entity in the way, and names it', () => {
    const player = place(vec3(100, 0, 0));

    const result = shot(300);

    expect(result.entityNum).toBe(player.s.number);
    expect(result.contents).toBe(CONTENTS.BODY);
    expect(result.normal).toEqual(vec3(-1, 0, 0));
    expect(result.endpos.x).toBeCloseTo(100 + mins.x - SURFACE_CLIP_EPSILON, 9);
  });

  it('stops at an entity in the way of a sweep back along an axis', () => {
    const player = place(vec3(100, 0, 0));

    const { host } = fixture;
    const result = host.trace(vec3(150, 0, 0), POINT, POINT, vec3(), ENTITYNUM_NONE, MASK.SHOT);

    expect(result.entityNum).toBe(player.s.number);
    expect(result.endpos.x).toBeCloseTo(100 + maxs.x + SURFACE_CLIP_EPSILON, 9);
  });

  it('names the world when the world is nearer, and nothing when nothing is in the way', () => {
    place(vec3(250, 0, 0));

    expect(shot(300)).toMatchObject({ entityNum: ENTITYNUM_WORLD, contents: CONTENTS.SOLID });
    expect(shot(150)).toMatchObject({ entityNum: ENTITYNUM_NONE, contents: 0, fraction: 1 });
  });

  it('stops a moving player an epsilon short of another', () => {
    const mover = place(vec3());
    const other = place(vec3(100, 0, 0));

    const { host } = fixture;
    const end = vec3(150, 0, 0);
    const result = host.trace(vec3(), mins, maxs, end, mover.s.number, MASK.PLAYERSOLID);

    expect(result.entityNum).toBe(other.s.number);
    expect(result.endpos.x + maxs.x).toBeCloseTo(100 + mins.x - SURFACE_CLIP_EPSILON, 9);
  });

  it('passes the pass entity, and whatever it owns', () => {
    const shooter = place(vec3(100, 0, 0));
    place(vec3(150, 0, 0), CONTENTS.BODY, shooter.s.number);

    expect(shot(300, shooter.s.number).entityNum).toBe(ENTITYNUM_WORLD);
  });

  it("passes whatever the pass entity's owner owns too, but not the owner", () => {
    const owner = place(vec3(150, 0, 0));
    const rocket = place(vec3(0, 300, 0), CONTENTS.BODY, owner.s.number);
    place(vec3(100, 0, 0), CONTENTS.BODY, owner.s.number);

    expect(shot(300, rocket.s.number).entityNum).toBe(owner.s.number);
  });

  it('passes nobody when the pass entity is none', () => {
    const shooter = place(vec3(150, 0, 0));
    const owned = place(vec3(100, 0, 0), CONTENTS.BODY, shooter.s.number);

    expect(shot(300).entityNum).toBe(owned.s.number);
  });

  it('goes through an entity made of nothing its mask names', () => {
    const corpse = place(vec3(100, 0, 0), CONTENTS.CORPSE);

    expect(shot(300, ENTITYNUM_NONE, MASK.PLAYERSOLID).entityNum).toBe(ENTITYNUM_WORLD);
    expect(shot(300, ENTITYNUM_NONE, MASK.SHOT).entityNum).toBe(corpse.s.number);
  });

  it('goes through the map with a mask that does not name what the map is made of', () => {
    const behind = place(vec3(250, 0, 0));

    expect(shot(300, ENTITYNUM_NONE, CONTENTS.BODY).entityNum).toBe(behind.s.number);
  });

  it('does not see an entity taken out of the world', () => {
    const player = place(vec3(100, 0, 0));
    fixture.host.unlinkEntity(player);

    expect(shot(300).entityNum).toBe(ENTITYNUM_WORLD);
  });

  it('asks no entity once the map has stopped it where it started', () => {
    // The sweep gets out of the wall but never out of the player, who would make it allsolid.
    place(vec3(208, 0, 0));

    const { host } = fixture;
    const inWall = vec3(208, 0, 0);
    const result = host.trace(inWall, POINT, POINT, vec3(220, 0, 0), ENTITYNUM_NONE, MASK.SHOT);

    expect(result).toMatchObject({ fraction: 0, allsolid: false, entityNum: ENTITYNUM_WORLD });
  });

  it('lets a sweep that starts in an entity and gets out go, saying only that it started', () => {
    place(vec3(100, 0, 0));

    const { host } = fixture;
    const from = vec3(100, 0, 0);
    const result = host.trace(from, POINT, POINT, vec3(150, 0, 0), ENTITYNUM_NONE, MASK.SHOT);

    expect(result).toMatchObject({
      startsolid: true,
      allsolid: false,
      fraction: 1,
      entityNum: ENTITYNUM_NONE
    });
  });

  it('keeps having started inside one entity when another stops the sweep', () => {
    // Linked last, so listed first: the world lists the newest link first.
    const further = place(vec3(150, 0, 0));
    place(vec3(100, 0, 0));

    const { host } = fixture;
    const from = vec3(100, 0, 0);
    const result = host.trace(from, POINT, POINT, vec3(190, 0, 0), ENTITYNUM_NONE, MASK.SHOT);

    expect(result).toMatchObject({ startsolid: true, entityNum: further.s.number });
    expect(result.fraction).toBeLessThan(1);
  });

  it('lets a shot fired from inside a player go on past them, as Bullet_Fire reads it', () => {
    place(vec3(100, 0, 0));

    const { host } = fixture;
    const shotFrom = vec3(100, 0, 0);
    const result = traceShot(host.trace.bind(host), shotFrom, vec3(300, 0, 0), ENTITYNUM_NONE);

    expect(result).toMatchObject({ hit: true, entityNum: ENTITYNUM_WORLD });
    expect(result.endpos.x).toBeCloseTo(200 - SURFACE_CLIP_EPSILON, 2);
  });

  it('names an entity a box cannot get out of', () => {
    const player = place(vec3(100, 0, 0));

    const { host } = fixture;
    const at = vec3(110, 0, 0);
    const result = host.trace(at, mins, maxs, at, ENTITYNUM_NONE, MASK.PLAYERSOLID);

    expect(result).toMatchObject({ allsolid: true, fraction: 0, entityNum: player.s.number });
  });
});

describe("a point's contents", () => {
  /** The map: water below z = 0. */
  const POOL: PointContentsFn = (point) => (point.z < 0 ? CONTENTS.WATER : 0);
  const { mins, maxs } = playerBounds(false);

  let fixture: Fixture;
  beforeEach(() => {
    fixture = makeHost({}, undefined, POOL);
  });

  /** A standing player's box at `origin`, made of `contents`, linked. */
  function place(origin: Vec3, contents: number = CONTENTS.BODY): GameEntity {
    const entity = fixture.game.level.spawnEntity();
    entity.r.mins = copy(mins);
    entity.r.maxs = copy(maxs);
    entity.r.currentOrigin = copy(origin);
    entity.r.contents = contents;
    fixture.host.linkEntity(entity);
    return entity;
  }

  const at = (point: Vec3, passEntityNum = ENTITYNUM_NONE) =>
    fixture.host.pointContents(point, passEntityNum);

  it("is the map's, with each entity there as a body, whatever it is made of", () => {
    place(vec3(100, 0, 0));
    place(vec3(300, 0, 0), CONTENTS.TRIGGER);

    expect(at(vec3(100, 0, -10))).toBe(CONTENTS.WATER | CONTENTS.BODY);
    expect(at(vec3(300, 0, 10))).toBe(CONTENTS.BODY);
    expect(at(vec3(200, 0, -10))).toBe(CONTENTS.WATER);
    expect(at(vec3(200, 0, 10))).toBe(0);
  });

  it("holds a point on a box's face and none past it, though it is linked a unit bigger", () => {
    place(vec3(100, 0, 0));

    expect(at(vec3(115, 0, 32))).toBe(CONTENTS.BODY);
    expect(at(vec3(115.5, 0, 0))).toBe(0);
    expect(at(vec3(100, 0, 32.5))).toBe(0);
  });

  it('leaves out the pass entity, and an entity taken out of the world', () => {
    const mover = place(vec3(100, 0, 0));
    const gone = place(vec3(300, 0, 0));
    fixture.host.unlinkEntity(gone);

    expect(at(vec3(100, 0, 10), mover.s.number)).toBe(0);
    expect(at(vec3(300, 0, 10))).toBe(0);
  });

  it('holds nothing on a map given none', () => {
    fixture = makeHost();
    expect(at(vec3(0, 0, -10))).toBe(0);
  });
});
