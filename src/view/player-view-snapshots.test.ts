import { describe, expect, it } from 'vitest';

import { CONFIGSTRING, SNAPFLAG } from '../net/commands';
import { ClientClock, UserCmdRing } from '../net/client-clock';
import { ServerDisconnect } from '../net/connection';
import {
  TR,
  createEntityState,
  createNetUserCmd,
  createPlayerState,
  type EntityState,
  type NetUserCmd,
  type PlayerState,
  type Trajectory
} from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import {
  createClipInlineModels,
  createClipPointContents,
  createClipTrace
} from '../sim/clip-trace';
import { boxesBsp } from '../sim/cm/collision-test-fixtures';
import { loadMap } from '../sim/cm/cm-load';
import {
  BUTTON_ATTACK,
  CONTENTS,
  EF_FIRING,
  EF_TELEPORT_BIT,
  GT,
  PERS,
  PMF_FOLLOW,
  PMOVE_MSEC,
  STAT,
  TEAM
} from '../sim/constants';
import { packSolid, SOLID_BMODEL } from '../sim/entity-solid';
import { EV, EV_EVENT_BIT1, eventNumber } from '../sim/events';
import { ET } from '../sim/game-entity';
import { findItem, itemIndex } from '../sim/items';
import { defaultRules } from '../sim/rules';
import {
  NO_INLINE_MODELS,
  createIdlePlayerState,
  playerBounds,
  type InlineModels,
  type UserCmd
} from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { PlayerView, type GameSource, type SourceSnapshot } from './player-view';

/**
 * `CG_ProcessSnapshots` and `CG_InterpolatePlayerState` against a program scripted a snapshot at a
 * time: which snapshot is current for a clock, what is passed over, when the server commands
 * before one run, and how the player is drawn between two.
 */

/** What a scripted snapshot carries. */
interface Sent {
  ps?: Partial<PlayerState>;
  flags?: number;
  /** The last server command that comes before it. */
  commands?: number;
  entities?: EntityState[];
  ping?: number;
  /** The first bytes of its areamask. */
  areamask?: number[];
}

/** A program whose clock, snapshots and server commands a test sets by hand. */
class Scripted implements GameSource {
  serverTime = 0;
  gamestateMessageNum = 10;
  private readonly snapshots = new Map<number, SourceSnapshot>();
  private latest = 0;
  private readonly serverCommands: { sequence: number; text: string }[] = [];
  /** The configstrings as the client has them. */
  readonly configstrings: string[] = [];
  /** The command ring prediction replays: empty unless a test makes commands. */
  readonly commands = new UserCmdRing();
  /** The rules prediction reads, at id's values unless a test changes them. */
  readonly rules = defaultRules();
  readonly pmoveMsec = PMOVE_MSEC;
  readonly grappleMode = null;
  clientNum = 0;
  /** The gap between the client's snapshots: 50 ms, as at `snaps` 20 and a 50 ms frame. */
  snapshotGap = 50;
  unlagged = 1;
  /** The frame the view last said it drew: its time and its two snapshots' times. */
  drawn: [number, number, number] | null = null;

  frame(): void {}

  setDrawnFrame(time: number, snapTime: number, nextSnapTime: number): void {
    this.drawn = [time, snapTime, nextSnapTime];
  }

  currentSnapshotNumber(): number {
    return this.latest;
  }

  get latestSnapshotTime(): number {
    return this.snapshots.get(this.latest)?.serverTime ?? 0;
  }

  snapshot(number: number): SourceSnapshot | null {
    return this.snapshots.get(number) ?? null;
  }

  takeServerCommands(upTo: number): string[] {
    const taken: string[] = [];
    while (this.serverCommands.length > 0 && this.serverCommands[0].sequence <= upTo) {
      taken.push(this.serverCommands[0].text);
      this.serverCommands.shift();
    }
    return taken;
  }

  configstring(index: number): string {
    return this.configstrings[index] ?? '';
  }

  restart(): void {}

  /**
   * A snapshot arrives: its message's number, the server's time, and what it carries, as far as a
   * test sets it.
   */
  send(number: number, serverTime: number, options: Sent = {}): void {
    const ps = Object.assign(createPlayerState(), options.ps);
    const areamask = new Uint8Array(32);
    areamask.set(options.areamask ?? []);
    this.snapshots.set(number, {
      snapFlags: options.flags ?? 0,
      ping: options.ping ?? 0,
      serverTime,
      serverCommandNum: options.commands ?? 0,
      areamask,
      ps,
      entities: options.entities ?? []
    });
    this.latest = number;
  }

  /** A server command arrives, as the reliable sequence numbers it. */
  say(sequence: number, text: string): void {
    this.serverCommands.push({ sequence, text });
  }
}

const STILL: Omit<UserCmd, 'serverTime'> = {
  forwardmove: 0,
  rightmove: 0,
  upmove: 0,
  angles: vec3(),
  buttons: 0,
  weapon: 0
};

/** At `x` along the map, which is how these tell one snapshot's player from another's. */
function at(x: number): Partial<PlayerState> {
  return { origin: vec3(x, 0, 0) };
}

/** A view of a program that has sent its first snapshot: 11, at 100 ms. */
function started(sent: Sent = { ps: at(1) }): { source: Scripted; view: PlayerView } {
  const source = new Scripted();
  source.send(11, 100, sent);
  return { source, view: new PlayerView(source, createFlatWorldTrace()) };
}

/** A frame drawn with the client's clock at `time`. */
function frame(source: Scripted, view: PlayerView, time: number, cmd = STILL): void {
  source.serverTime = time;
  view.advance(1, cmd);
}

/** What the view prints from now on. */
function listen(view: PlayerView): string[] {
  const heard: string[] = [];
  view.console = { print: (text) => heard.push(text), clearNotify: () => {} };
  return heard;
}

describe('snapshots read in turn', () => {
  it('makes one current exactly when the clock reaches its time', () => {
    const { source, view } = started();
    source.send(12, 108, { ps: at(2) });
    frame(source, view, 100);
    expect(view.player.origin.x).toBe(1);
    frame(source, view, 107.9);
    expect(view.player.origin.x).toBe(1);
    frame(source, view, 108);
    expect(view.player.origin.x).toBe(2);
  });

  it('passes over a snapshot that was lost, and goes on from the next', () => {
    const { source, view } = started();
    // 12 never arrived.
    source.send(13, 116, { ps: at(3) });
    frame(source, view, 116);
    expect(view.player.origin.x).toBe(3);
  });

  it('reads every snapshot the clock has passed, in turn, after a stall', () => {
    const { source, view } = started();
    const heard = listen(view);
    for (let n = 12; n <= 14; n++) {
      source.say(n, `print "${n}\n"`);
      source.send(n, 100 + 8 * (n - 11), { ps: at(n - 10), commands: n });
    }
    frame(source, view, 116);
    expect(heard).toEqual(['12\n', '13\n']);
    frame(source, view, 124);
    expect(heard).toEqual(['12\n', '13\n', '14\n']);
    expect(view.player.origin.x).toBe(4);
  });

  it("plays each passed snapshot's own events once, in turn, after a stall", () => {
    const { source, view } = started();
    frame(source, view, 100);
    const stepped = { eventSequence: 1, events: [EV.FOOTSTEP, 0], eventParms: [0, 0] };
    source.send(12, 108, { ps: stepped });
    source.send(13, 116, { ps: { ...stepped, eventSequence: 2, events: [EV.FOOTSTEP, EV.JUMP] } });
    source.serverTime = 116;
    const played = view.advance(1, STILL);
    expect(played.map(({ event }) => event)).toEqual([EV.FOOTSTEP, EV.JUMP]);
  });

  it('passes over the snapshots that say the player is not in yet', () => {
    const source = new Scripted();
    source.send(11, 100, { ps: at(1), flags: SNAPFLAG.NOT_ACTIVE });
    const view = new PlayerView(source, createFlatWorldTrace());
    source.send(12, 108, { ps: at(2) });
    frame(source, view, 104);
    expect(view.player.origin.x).toBe(2);
  });

  it('is in the world only from the first snapshot the player is in', () => {
    const source = new Scripted();
    source.send(11, 100, { ps: at(1), flags: SNAPFLAG.NOT_ACTIVE });
    const view = new PlayerView(source, createFlatWorldTrace());
    expect(view.inWorld).toBe(false);
    frame(source, view, 100);
    expect(view.inWorld).toBe(false);

    source.send(12, 108, { ps: at(2) });
    frame(source, view, 108);
    expect(view.inWorld).toBe(true);

    // A new gamestate puts the player back out until its world has them.
    source.gamestateMessageNum = 20;
    source.send(21, 300, { ps: at(3), flags: SNAPFLAG.NOT_ACTIVE });
    frame(source, view, 300);
    expect(view.inWorld).toBe(false);
  });

  it('never draws before the current snapshot: a clock behind it is brought up to it', () => {
    const { source, view } = started();
    frame(source, view, 90);
    expect(view.time).toBe(100);
  });

  it("throws when the server's time goes back", () => {
    const { source, view } = started();
    frame(source, view, 100);
    source.send(12, 96);
    expect(() => frame(source, view, 100)).toThrow('Server time went backwards');
  });

  it("starts over from a new gamestate's message, reading nothing of the last world", () => {
    const { source, view } = started();
    frame(source, view, 100);
    source.gamestateMessageNum = 20;
    // A new world's clock may be anywhere.
    source.send(21, 50, { ps: at(7) });
    frame(source, view, 50);
    expect(view.player.origin.x).toBe(7);
  });

  it("takes a new gamestate's warmup as it stands, saying nothing of it", () => {
    // `CG_SetConfigValues` (`cg_servercmds.c:230`): a map that opens on a countdown says no
    // "prepare", whatever the last one was playing.
    const { source, view } = started();
    frame(source, view, 100);
    source.gamestateMessageNum = 20;
    source.configstrings[CONFIGSTRING.WARMUP] = '30000';
    source.send(21, 50);
    frame(source, view, 50);
    expect(view.voices).toEqual([]);

    // And the countdown only moved after it says nothing either: it is read against the new one.
    source.say(1, `cs ${CONFIGSTRING.WARMUP} "31000"`);
    source.send(22, 58, { commands: 1 });
    const heard: string[] = [];
    for (const time of [54, 58, 62]) {
      frame(source, view, time);
      heard.push(...view.voices);
    }
    expect(heard).toEqual([]);
  });

  it("keeps the last world's players whole through a new gamestate's passed-over snapshots", () => {
    const player = (x: number): EntityState => {
      const state = createEntityState(1);
      state.eType = ET.PLAYER;
      state.pos.trBase = vec3(x, 0, 0);
      return state;
    };
    const { source, view } = started({ ps: at(1), entities: [player(100)] });
    source.send(12, 108, { ps: at(2), entities: [player(108)] });
    frame(source, view, 104);

    // Until the new world's first snapshot the player is in, the last world's are drawn.
    source.gamestateMessageNum = 20;
    const away = { flags: SNAPFLAG.NOT_ACTIVE, entities: [player(999)] };
    source.send(21, 300, away);
    frame(source, view, 300);
    for (let n = 22; n <= 24; n++) source.send(n, 300 + 8 * (n - 21), away);
    frame(source, view, 324);
    expect(view.players().map(({ state }) => state.pos.trBase.x)).toEqual([100]);
  });

  it("reads the new world's configstrings with its gamestate", () => {
    const { source, view } = started();
    frame(source, view, 100);
    source.configstrings[CONFIGSTRING.PLAYERS + 1] = 'n\\Sarge\\model\\sarge';
    source.gamestateMessageNum = 20;
    source.send(21, 50);
    frame(source, view, 50);
    expect(view.clientInfo(1)?.name).toBe('Sarge');
  });

  it('registers everyone afresh at a gamestate no load registered, putting nobody off', () => {
    const { source, view } = started();
    frame(source, view, 100);
    const read: string[] = [];
    view.registerClient = (info) => read.push(info.name);
    source.configstrings[CONFIGSTRING.PLAYERS + 1] = 'n\\Sarge\\model\\sarge';
    source.configstrings[CONFIGSTRING.PLAYERS + 2] = 'n\\Visor\\model\\visor';
    source.gamestateMessageNum = 20;
    source.send(21, 50);
    frame(source, view, 50);
    expect(read).toEqual(['Sarge', 'Visor']);
    expect(view.clientInfo(2)?.deferred).toBe(false);

    // The client's load registered the next one's, which leaves its first frame nothing to do.
    source.gamestateMessageNum = 30;
    view.registerClients();
    read.length = 0;
    source.send(31, 60);
    frame(source, view, 60);
    expect(read).toEqual([]);
  });
});

describe('the server commands a snapshot comes after', () => {
  it('run as it is made current, and not before', () => {
    const { source, view } = started();
    const heard = listen(view);
    frame(source, view, 100);
    source.say(1, 'print "one\n"');
    source.send(12, 108, { commands: 1 });
    frame(source, view, 104);
    expect(heard).toEqual([]);
    frame(source, view, 108);
    expect(heard).toEqual(['one\n']);
  });

  it("run for the first snapshot as it is read, which the view's making does not do", () => {
    const source = new Scripted();
    source.say(1, 'print "hello\n"');
    source.send(11, 100, { commands: 1 });
    const view = new PlayerView(source, createFlatWorldTrace());
    const heard = listen(view);
    frame(source, view, 100);
    expect(heard).toEqual(['hello\n']);
  });

  it("end the match at the server's disconnect, with its reason, after the print before it", () => {
    const { source, view } = started();
    const heard = listen(view);
    frame(source, view, 100);
    source.say(1, 'print "Server quit\n"');
    source.say(2, 'disconnect "Server quit"');
    source.send(12, 108, { commands: 2 });

    let dropped: unknown = null;
    try {
      frame(source, view, 108);
    } catch (err) {
      dropped = err;
    }
    expect(dropped).toBeInstanceOf(ServerDisconnect);
    expect((dropped as Error).message).toBe('Server disconnected - Server quit');
    expect(heard).toEqual(['Server quit\n']);
    expect(new ServerDisconnect(['disconnect']).message).toBe('Server disconnected');
  });

  it('parse the serverinfo a cs command changes as it is made current, as the gamestate is', () => {
    const source = new Scripted();
    source.configstrings[CONFIGSTRING.SERVERINFO] = '\\g_gametype\\3\\fraglimit\\20';
    source.send(11, 100);
    const view = new PlayerView(source, createFlatWorldTrace());
    expect(view.serverInfo).toMatchObject({ gametype: 3, fraglimit: 20 });

    frame(source, view, 100);
    source.say(1, `cs ${CONFIGSTRING.SERVERINFO} "\\g_gametype\\4\\fraglimit\\5"`);
    source.send(12, 108, { commands: 1 });
    frame(source, view, 104);
    expect(view.serverInfo).toMatchObject({ gametype: 3, fraglimit: 20 });
    frame(source, view, 108);
    expect(view.serverInfo).toMatchObject({ gametype: 4, fraglimit: 5 });

    source.configstrings[CONFIGSTRING.SERVERINFO] = '\\fraglimit\\7';
    source.gamestateMessageNum = 20;
    source.send(21, 50);
    frame(source, view, 50);
    expect(view.serverInfo).toMatchObject({ gametype: 0, fraglimit: 7 });
  });

  it('parse the serverinfo once a change, not at each read', () => {
    const { source, view } = started();
    frame(source, view, 100);
    const parsed = view.serverInfo;
    source.say(1, `cs ${CONFIGSTRING.SCORES1} "3"`);
    source.send(12, 108, { commands: 1 });
    for (const time of [104, 108, 112]) frame(source, view, time);
    expect(view.serverInfo).toBe(parsed);

    source.say(2, `cs ${CONFIGSTRING.SERVERINFO} "\\fraglimit\\9"`);
    source.send(13, 116, { commands: 2 });
    frame(source, view, 116);
    expect(view.serverInfo).not.toBe(parsed);
    expect(view.serverInfo.fraglimit).toBe(9);
  });

  it("hand on each shader state cgame reads: its load's, then each cs's, oldest first", () => {
    const source = new Scripted();
    source.configstrings[CONFIGSTRING.SHADERSTATE] = 'a=b: 0.30@';
    source.send(11, 100);
    const view = new PlayerView(source, createFlatWorldTrace());
    frame(source, view, 100);
    source.say(1, `cs ${CONFIGSTRING.SHADERSTATE} "a=c: 1.24@"`);
    source.say(2, `cs ${CONFIGSTRING.SCORES1} "3"`);
    source.say(3, `cs ${CONFIGSTRING.SHADERSTATE} "a=c: 1.24@d=e: 1.30@"`);
    source.send(12, 108, { commands: 3 });
    frame(source, view, 108);
    expect(view.takeShaderStates()).toEqual(['a=b: 0.30@', 'a=c: 1.24@', 'a=c: 1.24@d=e: 1.30@']);
    expect(view.takeShaderStates()).toEqual([]);

    // A new gamestate's load hands on its own, and none of the last world's left untaken.
    source.say(4, `cs ${CONFIGSTRING.SHADERSTATE} "x=y: 2.00@"`);
    source.send(13, 116, { commands: 4 });
    frame(source, view, 116);
    source.configstrings[CONFIGSTRING.SHADERSTATE] = '';
    source.gamestateMessageNum = 20;
    source.send(21, 50);
    frame(source, view, 50);
    expect(view.takeShaderStates()).toEqual(['']);
  });

  it('start the music at a cs for CS_MUSIC and at a restart, the last of a frame taken', () => {
    // `CG_StartMusic`, from `CG_ConfigStringModified` and `CG_MapRestart`.
    const source = new Scripted();
    source.configstrings[CONFIGSTRING.MUSIC] = 'music/a.wav';
    source.send(11, 100);
    const view = new PlayerView(source, createFlatWorldTrace());
    frame(source, view, 100);
    // The gamestate's is started with its load.
    expect(view.takeMusicStart()).toBeNull();

    source.say(1, `cs ${CONFIGSTRING.MUSIC} "music/b.wav music/c.wav"`);
    source.send(12, 108, { commands: 1 });
    frame(source, view, 108);
    expect(view.takeMusicStart()).toBe('music/b.wav music/c.wav');
    expect(view.takeMusicStart()).toBeNull();

    source.say(2, 'map_restart');
    source.send(13, 116, { commands: 2 });
    frame(source, view, 116);
    expect(view.takeMusicStart()).toBe('music/b.wav music/c.wav');

    source.say(3, `cs ${CONFIGSTRING.MUSIC} "music/d.wav"`);
    source.say(4, `cs ${CONFIGSTRING.MUSIC} ""`);
    source.send(14, 124, { commands: 4 });
    frame(source, view, 124);
    expect(view.takeMusicStart()).toBe('');

    // A new gamestate's load drops one not taken.
    source.say(5, `cs ${CONFIGSTRING.MUSIC} "music/e.wav"`);
    source.send(15, 132, { commands: 5 });
    frame(source, view, 132);
    source.gamestateMessageNum = 20;
    source.send(21, 50);
    frame(source, view, 50);
    expect(view.takeMusicStart()).toBeNull();
  });

  it('respawn the player at a restart, whatever the spawn count says', () => {
    // `cg.mapRestart`, which `CG_TransitionPlayerState` answers with `CG_Respawn`.
    const { source, view } = started();
    frame(source, view, 100);
    source.say(1, 'map_restart');
    source.send(12, 108, { commands: 1 });
    frame(source, view, 108);
    expect(view.mapRestart).toBe(true);
    expect(view.respawned).toBe(true);
  });
});

describe('the player drawn between two snapshots', () => {
  it('carries the origin, the velocity and the bob by where the clock is between them', () => {
    const { source, view } = started({ ps: { ...at(0), velocity: vec3(), bobCycle: 250 } });
    // The bob counts in a byte, so 4 after 250 has gone round: 10 on, not 246 back.
    source.send(12, 108, { ps: { ...at(8), velocity: vec3(100, 0, 0), bobCycle: 4 } });
    frame(source, view, 102);
    const drawn = view.sample();
    expect(drawn.origin.x).toBeCloseTo(2, 6);
    expect(drawn.velocity.x).toBeCloseTo(25, 6);
    expect(drawn.bobCycle).toBe(252);
  });

  it('holds the current one across a restart, rather than drawing the way between', () => {
    const { source, view } = started({ ps: at(0) });
    source.send(12, 108, { ps: at(8), flags: SNAPFLAG.SERVERCOUNT });
    frame(source, view, 104);
    expect(view.sample().origin.x).toBe(0);
  });

  it("turns with the frame's own command, by the delta angles the server set", () => {
    const alive = createPlayerState();
    alive.stats[STAT.HEALTH] = 100;
    // A quarter turn, as a spawn facing 90 sets it under a command facing 0.
    alive.deltaAngles = vec3(0, 0x4000, 0);
    const { source, view } = started({ ps: alive });
    frame(source, view, 100, { ...STILL, angles: vec3(0, 10, 0) });
    expect(view.sample().viewangles.y).toBeCloseTo(100, 1);
  });

  it("looks through a followed player's angles, drawn between as the rest is", () => {
    const followed = (yaw: number) => ({ pmFlags: PMF_FOLLOW, viewangles: vec3(0, yaw, 0) });
    const { source, view } = started({ ps: followed(350) });
    source.send(12, 108, { ps: followed(10) });
    frame(source, view, 104, { ...STILL, angles: vec3(0, 90, 0) });
    // Half of the 20 degrees through 360, and nothing of the command's own.
    expect(view.sample().viewangles.y).toBeCloseTo(360, 6);
  });

  it("holds a dead player's view still, whatever the mouse does", () => {
    const dead = createPlayerState();
    dead.stats[STAT.HEALTH] = 0;
    dead.viewangles = vec3(0, 45, 0);
    const { source, view } = started({ ps: dead });
    frame(source, view, 100, { ...STILL, angles: vec3(0, 10, 0) });
    expect(view.sample().viewangles.y).toBe(45);
  });
});

describe('the frame the view tells the program it drew', () => {
  it('is its time and the two snapshots it drew between, for the commands made next', () => {
    const { source, view } = started();
    // A clock behind the first snapshot is drawn on it, and with no next one, the one is both.
    frame(source, view, 90);
    expect(source.drawn).toEqual([100, 100, 100]);

    source.send(12, 150);
    frame(source, view, 112.5);
    expect(source.drawn).toEqual([112.5, 100, 150]);

    frame(source, view, 151);
    expect(source.drawn).toEqual([151, 150, 150]);
  });

  it('is nothing before the first snapshot the player is in', () => {
    const source = new Scripted();
    const view = new PlayerView(source, createFlatWorldTrace());
    frame(source, view, 100);
    expect(source.drawn).toBeNull();
  });
});

describe('the world drawn between two snapshots', () => {
  it('draws a player sent to run on between the two all the same', () => {
    const runner = (serverTime: number, x: number): EntityState => {
      const state = createEntityState(1);
      state.eType = ET.PLAYER;
      state.pos.trType = TR.LINEAR_STOP;
      state.pos.trBase = vec3(x, 0, 0);
      state.pos.trTime = serverTime;
      state.pos.trDuration = 50;
      return state;
    };
    const { source, view } = started({ entities: [runner(100, 0)] });
    source.send(12, 108, { entities: [runner(108, 8)] });
    frame(source, view, 104);
    expect(view.players()[0].origin.x).toBeCloseTo(4, 6);
  });

  it("fires an entity's event where it was as the snapshot was taken, not as it is drawn", () => {
    const rocket = (event: number): EntityState => {
      const state = createEntityState(70);
      state.eType = ET.MISSILE;
      state.weapon = WP.ROCKET_LAUNCHER;
      state.event = event;
      state.pos.trType = TR.LINEAR;
      state.pos.trTime = 100;
      state.pos.trDelta = vec3(1000, 0, 0);
      return state;
    };
    const { source, view } = started({ entities: [rocket(0)] });
    source.send(12, 108, { entities: [rocket(EV.MISSILE_MISS | EV_EVENT_BIT1)] });
    frame(source, view, 110);
    const impacts = view.effects.filter((effect) => effect.type === 'impact');
    // 8 ms of flight at 1000 ups, where the frame's clock would have 10.
    expect(impacts.map(({ origin }) => origin.x)).toEqual([8]);
  });

  it("scales an item up from the frame that reads its respawn, as `cg.time` dates it", () => {
    const item = (event: number): EntityState => {
      const state = createEntityState(80);
      state.eType = ET.ITEM;
      state.event = event;
      return state;
    };
    const { source, view } = started({ entities: [item(0)] });
    source.send(12, 108, { entities: [item(EV.ITEM_RESPAWN | EV_EVENT_BIT1)] });
    frame(source, view, 110);
    expect(view.items()[0].respawnTime).toBe(110);
  });
});

describe('the areamask the world is drawn by', () => {
  /** The first bytes of the frame's mask. */
  const mask = (view: PlayerView, bytes = 2) => Array.from(view.areamask.subarray(0, bytes));

  it('closes nothing before the first snapshot', () => {
    const view = new PlayerView(new Scripted(), createFlatWorldTrace());
    expect(Array.from(view.areamask)).toEqual(new Array<number>(32).fill(0));
  });

  it("is the current snapshot's, and not the next's, until the next is current", () => {
    const { source, view } = started({ areamask: [0xfb, 0xff] });
    source.send(12, 150, { areamask: [0xeb, 0xff] });
    frame(source, view, 120);
    expect(mask(view)).toEqual([0xfb, 0xff]);
    frame(source, view, 150);
    expect(mask(view)).toEqual([0xeb, 0xff]);
  });

  it("is the view's own, which the client's ring may write over", () => {
    const { source, view } = started({ areamask: [0xfb] });
    frame(source, view, 120);
    source.snapshot(11)!.areamask.fill(0);
    expect(mask(view, 1)).toEqual([0xfb]);
  });

  it('closes nothing again in a new world until its first snapshot', () => {
    const { source, view } = started({ areamask: [0xfb] });
    frame(source, view, 120);
    source.gamestateMessageNum = 20;
    frame(source, view, 130);
    expect(view.inWorld).toBe(false);
    expect(mask(view, 32)).toEqual(new Array<number>(32).fill(0));
  });
});

describe('another player past the newest snapshot', () => {
  /** A player in slot `number`, at the origin, sent running at 320 along x. */
  const running = (number = 1): EntityState => {
    const state = createEntityState(number);
    state.eType = ET.PLAYER;
    state.clientNum = number;
    state.pos.trType = TR.INTERPOLATE;
    state.pos.trTime = 100;
    state.pos.trDelta = vec3(320, 0, 0);
    return state;
  };

  it('is carried on by the velocity the server sent, for a snapshot gap, and held', () => {
    const { source, view } = started({ entities: [running()] });
    frame(source, view, 120);
    expect(view.players()[0].origin.x).toBeCloseTo(320 * 0.02, 6);
    frame(source, view, 200);
    expect(view.players()[0].origin.x).toBeCloseTo(320 * 0.05, 6);
  });

  it("is carried on for the client's own gap between snapshots", () => {
    const { source, view } = started({ entities: [running()] });
    source.snapshotGap = 8;
    frame(source, view, 200);
    expect(view.players()[0].origin.x).toBeCloseTo(320 * 0.008, 6);
  });

  it("holds a corpse, and the player the view is showing, where the snapshot has them", () => {
    const { source, view } = started({ ps: at(1), entities: [running(0), running(70)] });
    frame(source, view, 200);
    expect(view.players().map(({ origin }) => origin.x)).toEqual([0, 0]);
  });
});

/**
 * A missile in slot `number`, fired by slot `owner` at 100 ms from (0, 0, 24), flying 1000 ups
 * along x.
 */
function flying(owner: number, weapon: number = WP.ROCKET_LAUNCHER, number = 70): EntityState {
  const state = createEntityState(number);
  state.eType = ET.MISSILE;
  state.weapon = weapon;
  state.otherEntityNum = owner;
  state.pos.trType = TR.LINEAR;
  state.pos.trTime = 100;
  state.pos.trBase = vec3(0, 0, 24);
  state.pos.trDelta = vec3(1000, 0, 0);
  return state;
}

/** Where each missile is drawn along x. */
function drawnX(view: PlayerView): number[] {
  return view.missiles().map(({ origin }) => origin.x);
}

describe('missiles as the view draws them', () => {
  it("draws the player's own a snapshot gap ahead of its trajectory, and no nudge more", () => {
    const { source, view } = started({ entities: [flying(0)] });
    view.projectileNudge = 30;
    frame(source, view, 120);
    // 20 ms of flight, and the gap's 50 more.
    expect(drawnX(view)[0]).toBeCloseTo(70, 6);
  });

  it("draws everyone else's further on by cg_projectileNudge as well", () => {
    const { source, view } = started({ entities: [flying(1)] });
    view.projectileNudge = 30;
    frame(source, view, 120);
    expect(drawnX(view)[0]).toBeCloseTo(100, 6);
  });

  it("leaves another's grenade and every hook on their trajectory, but not its own grenade", () => {
    const { source, view } = started({
      entities: [
        flying(1, WP.GRENADE_LAUNCHER, 70),
        flying(0, WP.GRAPPLING_HOOK, 71),
        flying(0, WP.GRENADE_LAUNCHER, 72)
      ]
    });
    frame(source, view, 120);
    const [grenade, hook, own] = drawnX(view);
    expect(grenade).toBeCloseTo(20, 6);
    expect(hook).toBeCloseTo(20, 6);
    expect(own).toBeCloseTo(70, 6);
  });

  it('starts the smoke of one in the first snapshot from that snapshot', () => {
    const { source, view } = started({ entities: [flying(1)] });
    frame(source, view, 120);
    expect(view.missiles().map(({ trailTime }) => trailTime)).toEqual([100]);
  });

  it('starts it from the snapshot that brought it, though the frame passed more', () => {
    const { source, view } = started({ entities: [] });
    source.send(12, 108, { entities: [flying(1)] });
    source.send(13, 116, { entities: [flying(1)] });
    frame(source, view, 120);
    expect(view.missiles().map(({ trailTime }) => trailTime)).toEqual([108]);
  });

  it('starts it again from the snapshot that brings it back into view', () => {
    const { source, view } = started({ entities: [flying(1)] });
    source.send(12, 108, { entities: [] });
    frame(source, view, 110);
    expect(view.missiles()).toEqual([]);
    source.send(13, 116, { entities: [flying(1)] });
    frame(source, view, 120);
    expect(view.missiles().map(({ trailTime }) => trailTime)).toEqual([116]);
  });

  it("starts it from a new world's first snapshot, whatever the last drew between", () => {
    const { source, view } = started({ entities: [flying(1)] });
    source.send(12, 150, { entities: [flying(1)] });
    frame(source, view, 120);
    source.gamestateMessageNum = 20;
    source.send(21, 50, { entities: [flying(1)] });
    frame(source, view, 60);
    expect(view.missiles().map(({ trailTime }) => trailTime)).toEqual([50]);
  });

  it('stops one nudged into a wall where a trace from its trajectory meets the wall', () => {
    const source = new Scripted();
    source.send(11, 100, { entities: [flying(0)] });
    const view = new PlayerView(source, createFlatWorldTrace([box(50, -500, 0, 60, 500, 200)]));
    frame(source, view, 120);
    expect(drawnX(view)[0]).toBeCloseTo(50, 0);
  });
});

describe("another's grappling hook's rope", () => {
  /** Player 1, standing at (100, 0, 24) and looking along x. */
  const thrower = (): EntityState => {
    const state = createEntityState(1);
    state.eType = ET.PLAYER;
    state.clientNum = 1;
    state.pos.trType = TR.STATIONARY;
    state.pos.trBase = vec3(100, 0, 24);
    return state;
  };
  const hook = () => flying(1, WP.GRAPPLING_HOOK, 71);
  /** Where each hook's rope starts, as the view hands it to be drawn. */
  const starts = (view: PlayerView) => view.grappleHooks().map(({ muzzle }) => muzzle);

  it('starts 26 up from its thrower where they are drawn, and 6 down their up', () => {
    const { source, view } = started({ entities: [thrower(), hook()] });
    frame(source, view, 120);
    expect(starts(view)).toEqual([vec3(100, 0, 44)]);
  });

  it('starts where its thrower was last drawn while they are not sent', () => {
    const { source, view } = started({ entities: [thrower(), hook()] });
    frame(source, view, 104);
    view.players();
    source.send(12, 108, { entities: [hook()] });
    frame(source, view, 120);
    expect(view.players()).toEqual([]);
    expect(starts(view)).toEqual([vec3(100, 0, 44)]);
  });

  it('starts at the hook, and so is not drawn, for a thrower never drawn on the map', () => {
    const { source, view } = started({ entities: [thrower(), hook()] });
    frame(source, view, 104);
    view.players();
    source.gamestateMessageNum = 20;
    source.send(21, 50, { entities: [hook()] });
    frame(source, view, 60);
    const [{ position, muzzle }] = view.grappleHooks();
    expect(muzzle).toEqual(position);
  });
});

describe('the next snapshot, read early', () => {
  /** Another player, standing in slot `number`. */
  const standing = (number = 1): EntityState => {
    const state = createEntityState(number);
    state.eType = ET.PLAYER;
    state.clientNum = number;
    state.pos.trType = TR.INTERPOLATE;
    return state;
  };

  /** An item standing in slot `number`. */
  const lying = (number = 80): EntityState => {
    const state = createEntityState(number);
    state.eType = ET.ITEM;
    state.pos.trType = TR.STATIONARY;
    return state;
  };

  it("draws a missile from it at once, a snapshot before it is current", () => {
    const { source, view } = started({ entities: [] });
    source.send(12, 150, { entities: [flying(1)] });
    frame(source, view, 120);
    expect(view.missiles().map(({ state }) => state.number)).toEqual([70]);
  });

  it("starts that missile's smoke from the current snapshot, as unlagged's reset has it", () => {
    const { source, view } = started({ entities: [] });
    source.send(12, 150, { entities: [flying(1)] });
    frame(source, view, 120);
    expect(view.missiles().map(({ trailTime }) => trailTime)).toEqual([100]);
  });

  it("draws the player's own hook from it at once, as it draws a missile", () => {
    const { source, view } = started({ entities: [] });
    source.send(12, 150, { entities: [flying(0, WP.GRAPPLING_HOOK, 71)] });
    frame(source, view, 120);
    // 20 ms of flight at 1000 ups: a hook is drawn on its trajectory.
    expect(view.grappleHooks()[0]?.position.x).toBeCloseTo(20, 6);
  });

  it('stops drawing an item whose slot it has as a missile, a snapshot early', () => {
    const { source, view } = started({ entities: [lying(70)] });
    source.send(12, 150, { entities: [flying(1, WP.ROCKET_LAUNCHER, 70)] });
    frame(source, view, 120);
    expect(view.items()).toEqual([]);
    expect(view.missiles().map(({ state }) => state.number)).toEqual([70]);
  });

  it('fires its early events where their entities were at the current snapshot', () => {
    const burst = flying(1);
    burst.eType = ET.GENERAL;
    burst.event = EV.MISSILE_MISS | EV_EVENT_BIT1;
    burst.pos.trTime = 90;
    const { source, view } = started({ entities: [] });
    source.send(12, 150, { entities: [burst] });
    frame(source, view, 120);
    const impacts = view.effects.filter((effect) => effect.type === 'impact');
    // 10 ms of flight at 1000 ups, to the current snapshot at 100, and not the next's 60.
    expect(impacts.map((effect) => 'origin' in effect && effect.origin.x)).toEqual([10]);
  });

  it("forgets with a new gamestate what each slot was in the last world's next snapshots", () => {
    const { source, view } = started({ entities: [lying()] });
    source.send(12, 150, { entities: [lying()] });
    frame(source, view, 120);
    expect(view.items()).toHaveLength(1);

    // A new cgame's slots have never been in a next snapshot, which reads as `ET_GENERAL`: drawn
    // from the next one or not at all.
    source.gamestateMessageNum = 20;
    source.send(21, 50, { entities: [lying()] });
    source.send(22, 100, { entities: [] });
    frame(source, view, 60);
    expect(view.items()).toEqual([]);
  });

  it('stops drawing a missile it has not got, a snapshot early, where a player stays', () => {
    const { source, view } = started({ entities: [standing(), flying(1)] });
    source.send(12, 150, { entities: [standing(), flying(1)] });
    frame(source, view, 160);
    source.send(13, 200, { entities: [] });
    frame(source, view, 170);
    expect(view.missiles()).toEqual([]);
    expect(view.players()).toHaveLength(1);
  });

  it("sets off its missile's explosion as the missile goes, and once", () => {
    const burst = flying(1);
    burst.eType = ET.GENERAL;
    burst.event = EV.MISSILE_MISS | EV_EVENT_BIT1;
    burst.pos.trType = TR.STATIONARY;
    burst.pos.trBase = vec3(40, 0, 24);
    const impacts = (view: PlayerView) => view.effects.filter(({ type }) => type === 'impact');

    const { source, view } = started({ entities: [flying(1)] });
    source.send(12, 150, { entities: [burst] });
    frame(source, view, 120);
    expect(view.missiles()).toEqual([]);
    expect(impacts(view).map((effect) => 'origin' in effect && effect.origin)).toEqual([
      vec3(40, 0, 24)
    ]);

    frame(source, view, 160);
    expect(impacts(view)).toEqual([]);
  });

  it('stops drawing a player it turned ET_GENERAL, as an intermission does, early', () => {
    const general = standing();
    general.eType = ET.GENERAL;
    const { source, view } = started({ entities: [standing()] });
    source.send(12, 150, { entities: [standing()] });
    frame(source, view, 160);
    source.send(13, 200, { entities: [general] });
    frame(source, view, 170);
    expect(view.players()).toEqual([]);
  });
});

describe("the prediction's own inputs", () => {
  /** A standing player, alive, with the match's own numbers. */
  function alive(overrides: Partial<PlayerState> = {}): PlayerState {
    return createIdlePlayerState({ origin: vec3(0, 0, 24), ...overrides });
  }

  /** A command the client has made, on the ring the prediction replays. */
  function command(source: Scripted, serverTime: number, input: Partial<NetUserCmd> = {}): void {
    const clock = new ClientClock();
    clock.serverTime = serverTime;
    clock.jumped = true;
    const cmd = createNetUserCmd();
    Object.assign(cmd, input);
    source.commands.createNewCommands(cmd, clock, true, PMOVE_MSEC);
  }

  it('predicts nothing for a follower, whose movement is not theirs', () => {
    const { source, view } = started({ ps: { ...alive(), pmFlags: PMF_FOLLOW } });
    command(source, 108, { forwardmove: 127 });

    frame(source, view, 108, { ...STILL, forwardmove: 127 });

    // The snapshot's own state is drawn, and the command has not moved it.
    expect(view.player.origin.x).toBe(0);
  });

  it('corrects the camera over cg_errorDecay, and not at all at zero', () => {
    const miss = (errorDecay: number): number => {
      const { source, view } = started({ ps: alive() });
      view.errorDecay = errorDecay;
      // Two frames of commands, so last frame's prediction is a state the server can answer:
      // a miss is only measured when the base's clock is the one the prediction reached.
      command(source, 100);
      frame(source, view, 100);
      command(source, 108);
      frame(source, view, 108);

      // The server answers five units from where the prediction had the player, at the clock
      // the prediction reached — which is what makes the miss measurable.
      const answered = view.player.commandTime;
      source.send(12, 116, { ps: { ...alive(), origin: vec3(5, 0, 24), commandTime: answered } });
      command(source, 116);
      frame(source, view, 116);
      return view.view().origin.x;
    };

    expect(miss(0)).toBeCloseTo(5, 3);
    // Eight of the hundred milliseconds have gone by, so 92% of the 5 is still owed.
    expect(miss(100)).toBeCloseTo(5 - 5 * 0.92, 3);
  });

  it("decays a miss over the view's own cg_errorDecay, not a fixed one", () => {
    const { source, view } = started({ ps: alive() });
    view.errorDecay = 200;
    command(source, 100);
    frame(source, view, 100);
    command(source, 108);
    frame(source, view, 108);

    // The first miss: the server answers 5 at the clock the prediction reached.
    source.send(12, 116, {
      ps: { ...alive(), origin: vec3(5, 0, 24), commandTime: view.player.commandTime }
    });
    command(source, 116);
    frame(source, view, 116);

    // A second miss 16 ms later: the first has 92% of its 200 ms left, and the second's 2 is
    // added to what remains. A fixed hundred would have left 84%.
    source.send(13, 124, {
      ps: { ...alive(), origin: vec3(7, 0, 24), commandTime: view.player.commandTime }
    });
    command(source, 124);
    frame(source, view, 124);

    // One frame on, the camera still owes 92% of the 6.6 the two misses left — the error is
    // dated to the frame before the one that measured it, so sixteen of the 200 ms have gone.
    command(source, 132);
    frame(source, view, 132);
    expect(view.view().origin.x).toBeCloseTo(7 - (5 * 0.92 + 2) * 0.92, 3);
  });

  it('leaves the pickup to the snapshot when cg_predictItems is off', () => {
    const pickups = (predictItems: boolean): number[] => {
      const item = createEntityState(7);
      item.eType = ET.ITEM;
      item.pos.trType = TR.STATIONARY;
      item.pos.trBase = vec3(1, 0, 24);
      item.modelindex = itemIndex(findItem('weapon_rocketlauncher')!);
      const { source, view } = started({ ps: alive(), entities: [item] });
      view.predictItems = predictItems;
      command(source, 108);

      source.serverTime = 108;
      return view
        .advance(1, STILL)
        .map(({ event }) => eventNumber(event))
        .filter((event) => event === EV.ITEM_PICKUP);
    };

    expect(pickups(true)).toHaveLength(1);
    expect(pickups(false)).toHaveLength(0);
  });

  it('predicts a jump pad by its brush, on the inline models the view was given', () => {
    const launches = (models: InlineModels): number[] => {
      const pad = createEntityState(7);
      pad.eType = ET.PUSH_TRIGGER;
      pad.solid = SOLID_BMODEL;
      pad.modelindex = 1;
      pad.origin2 = vec3(0, 0, 300);
      const source = new Scripted();
      source.send(11, 100, { ps: alive(), entities: [pad] });
      const view = new PlayerView(source, createFlatWorldTrace(), undefined, undefined, models);
      command(source, 108);

      source.serverTime = 108;
      return view
        .advance(1, STILL)
        .map(({ event }) => eventNumber(event))
        .filter((event) => event === EV.JUMP_PAD);
    };

    const inside: InlineModels = {
      ...NO_INLINE_MODELS,
      inlineModel: (index) => index,
      contact: () => true,
      modelBounds: () => {}
    };
    expect(launches(inside)).toHaveLength(1);
    expect(launches({ ...inside, contact: () => false })).toHaveLength(0);
  });

  it('is in hyperspace on a frame whose replay touches a teleporter, and out of it after', () => {
    const teleporter = createEntityState(7);
    teleporter.eType = ET.TELEPORT_TRIGGER;
    teleporter.solid = SOLID_BMODEL;
    teleporter.modelindex = 1;
    const inside: InlineModels = {
      ...NO_INLINE_MODELS,
      inlineModel: (index) => index,
      contact: () => true,
      modelBounds: () => {}
    };
    const source = new Scripted();
    source.send(11, 100, { ps: alive(), entities: [teleporter] });
    const view = new PlayerView(source, createFlatWorldTrace(), undefined, undefined, inside);
    expect(view.hyperspace).toBe(false);

    command(source, 108);
    frame(source, view, 108);
    expect(view.hyperspace).toBe(true);
    // Every frame replays what the server has not answered, and walks into it again.
    frame(source, view, 108);
    expect(view.hyperspace).toBe(true);

    // Answered, there is nothing to replay, and the frame clears it, as `CG_PredictPlayerState`'s
    // first line does.
    const answered = source.commands.at(source.commands.cmdNumber).serverTime;
    source.send(12, 108, { ps: { ...alive(), commandTime: answered }, entities: [teleporter] });
    frame(source, view, 108);
    expect(view.hyperspace).toBe(false);

    // And so does a frame that predicts nothing at all.
    command(source, 116);
    frame(source, view, 116);
    expect(view.hyperspace).toBe(true);
    view.noPredict = true;
    frame(source, view, 116);
    expect(view.hyperspace).toBe(false);
  });

  it("grabs a flag by the serverinfo's gametype: the other side's in CTF, none outside it", () => {
    const pickups = (gametype: number): number[] => {
      const flag = createEntityState(7);
      flag.eType = ET.ITEM;
      flag.pos.trType = TR.STATIONARY;
      flag.pos.trBase = vec3(1, 0, 24);
      flag.modelindex = itemIndex(findItem('team_CTF_blueflag')!);
      const ps = alive();
      ps.persistant[PERS.TEAM] = TEAM.RED;
      const source = new Scripted();
      source.configstrings[CONFIGSTRING.SERVERINFO] = `\\g_gametype\\${gametype}`;
      source.send(11, 100, { ps, entities: [flag] });
      const view = new PlayerView(source, createFlatWorldTrace());
      command(source, 108);

      source.serverTime = 108;
      return view
        .advance(1, STILL)
        .map(({ event }) => eventNumber(event))
        .filter((event) => event === EV.ITEM_PICKUP);
    };

    expect(pickups(GT.CTF)).toHaveLength(1);
    expect(pickups(GT.FFA)).toHaveLength(0);
  });

  it('traces the prediction against everyone where they are drawn', () => {
    const bot = createEntityState(1);
    bot.eType = ET.PLAYER;
    const { mins, maxs } = playerBounds(false);
    bot.solid = packSolid({ bmodel: false, contents: CONTENTS.BODY, mins, maxs });
    bot.pos.trType = TR.STATIONARY;
    bot.pos.trBase = vec3(100, 0, 24);
    const { source, view } = started({ ps: alive(), entities: [bot] });

    // Fifty steps of running at the bot, all replayed in one frame.
    const clock = new ClientClock();
    const input = createNetUserCmd();
    input.forwardmove = 127;
    for (let time = 8; time <= 400; time += 8) {
      clock.serverTime = time;
      clock.jumped = true;
      source.commands.createNewCommands(input, clock, true, PMOVE_MSEC);
    }
    frame(source, view, 400);

    // Stopped at the bot's box, a radius of 15 either side of the 100 it stands at.
    expect(view.player.origin.x).toBeGreaterThan(50);
    expect(view.player.origin.x).toBeLessThan(80);
  });
});

describe('the solids each frame traces through', () => {
  /** A standing player in slot `number` at x = `x`, facing +x, its lightning gun firing or not. */
  function standing(number: number, x: number, firing = false): EntityState {
    const state = createEntityState(number);
    state.eType = ET.PLAYER;
    state.clientNum = number;
    const { mins, maxs } = playerBounds(false);
    state.solid = packSolid({ bmodel: false, contents: CONTENTS.BODY, mins, maxs });
    state.pos.trBase = vec3(x, 0, 24);
    if (firing) {
      state.weapon = WP.LIGHTNING;
      state.eFlags = EF_FIRING;
    }
    return state;
  }

  /** The player at the origin, facing +x, the lightning gun firing. */
  const FIRING = createIdlePlayerState({
    origin: vec3(0, 0, 24),
    weapon: WP.LIGHTNING,
    eFlags: EF_FIRING
  });

  it('lets a player gone from the snapshot stop nothing, however many frames on', () => {
    const { source, view } = started({ ps: FIRING, entities: [standing(1, 100)] });
    frame(source, view, 100);
    expect(view.lightningBolt()).toMatchObject({ hit: true });

    source.send(12, 150, { ps: FIRING });
    for (const time of [150, 160, 170]) {
      frame(source, view, time);
      expect(view.lightningBolt()).toMatchObject({ hit: false });
    }
  });

  it("stops another player's bolt at whoever is in the way, whoever was there before", () => {
    const { source, view } = started({ entities: [standing(2, 500), standing(3, 600)] });
    frame(source, view, 100);

    // Slot 2 turned back toward slot 1, who has come in where slot 2 was in the list. The spawn's
    // teleport builds the lists from the current snapshot until a replay clears it, and this
    // client replays nothing, so they are this one's once the next is read.
    const shooter = standing(2, 300, true);
    shooter.apos.trBase = vec3(0, 180, 0);
    source.send(12, 150, { entities: [standing(1, 100), shooter] });
    source.send(13, 200, { entities: [standing(1, 100), shooter] });
    for (const time of [150, 160, 170]) {
      frame(source, view, time);
      const bolt = view.players().find(({ state }) => state.number === 2)?.bolt;
      expect(bolt).toMatchObject({ hit: true });
    }
  });
});

describe('an interrupted connection', () => {
  /** `count` commands the client has made, a step apart from `from`. */
  function commands(source: Scripted, from: number, count: number): void {
    const clock = new ClientClock();
    for (let n = 0; n < count; n++) {
      clock.serverTime = from + PMOVE_MSEC * n;
      clock.jumped = true;
      source.commands.createNewCommands(createNetUserCmd(), clock, true, PMOVE_MSEC);
    }
  }

  it('is once the oldest command the ring keeps is past what the snapshot answered', () => {
    // The snapshot has answered up to 100, and nothing since.
    const { source, view } = started({ ps: { commandTime: 100 } });
    commands(source, 104, 63);
    frame(source, view, 600);
    // The ring still holds the slot from before them.
    expect(view.connectionInterrupted).toBe(false);
    commands(source, 608, 1);
    frame(source, view, 608);
    expect(view.connectionInterrupted).toBe(true);
  });

  it('is not once a snapshot answers the oldest', () => {
    const { source, view } = started({ ps: { commandTime: 100 } });
    commands(source, 104, 64);
    frame(source, view, 608);
    expect(view.connectionInterrupted).toBe(true);
    source.send(12, 616, { ps: { commandTime: 104 } });
    frame(source, view, 616);
    expect(view.connectionInterrupted).toBe(false);
  });

  it("is not while the oldest is ahead of the clock, as a map_restart's leftovers are", () => {
    const { source, view } = started({ ps: { commandTime: 0 } });
    commands(source, 1000, 64);
    frame(source, view, 999);
    expect(view.connectionInterrupted).toBe(false);
    frame(source, view, 1000);
    expect(view.connectionInterrupted).toBe(true);
  });

  it('is not before the player is in the world', () => {
    const source = new Scripted();
    source.send(11, 100, { flags: SNAPFLAG.NOT_ACTIVE });
    const view = new PlayerView(source, createFlatWorldTrace());
    commands(source, 104, 64);
    frame(source, view, 608);
    expect(view.inWorld).toBe(false);
    expect(view.connectionInterrupted).toBe(false);
  });
});

describe('movers', () => {
  /**
   * A map with a floor at z 0 and three inline models, each about its origin: `*1` a plat 128
   * square and 32 high, `*2` a pillar 32 square and 64 high, and `*3` a pool of water 128 square
   * and 256 deep.
   */
  const cm = loadMap(
    (() => {
      const bsp = boxesBsp([
        [
          [-64, -64, 0],
          [64, 64, 32]
        ],
        [
          [-16, -16, 0],
          [16, 16, 64]
        ],
        [
          [-64, -64, 0],
          [64, 64, 256]
        ]
      ]);
      // The pool's brush is the fixture's third shader's, water.
      bsp.brushes[3] = { ...bsp.brushes[3], shaderNum: 2 };
      return bsp;
    })(),
    'maps/test.bsp'
  );

  /** A view of the map, which has sent its first snapshot: 11, at 100 ms unless told. */
  function onMap(sent: Sent, serverTime = 100): { source: Scripted; view: PlayerView } {
    const source = new Scripted();
    source.send(11, serverTime, sent);
    const models = createClipInlineModels(cm);
    const view = new PlayerView(
      source,
      createClipTrace(cm),
      undefined,
      createClipPointContents(cm),
      models
    );
    return { source, view };
  }

  /** Mover `number`, inline model `modelindex`, on the trajectories given. */
  function mover(
    number: number,
    modelindex: number,
    pos: Partial<Trajectory>,
    apos: Partial<Trajectory> = {}
  ): EntityState {
    const state = createEntityState(number);
    state.eType = ET.MOVER;
    state.solid = SOLID_BMODEL;
    state.modelindex = modelindex;
    Object.assign(state.pos, pos);
    Object.assign(state.apos, apos);
    return state;
  }

  /** The plat, entity 40, sliding along +x at 100 a second from the origin at 0 ms. */
  const sliding = () => mover(40, 1, { trType: TR.LINEAR, trDelta: vec3(100, 0, 0) });
  /** The plat, entity 40, turning about z at 36 a second. */
  const turning = () => mover(40, 1, {}, { trType: TR.LINEAR, trDelta: vec3(0, 36, 0) });

  /** A living player at `origin`, their last command at 100. */
  function alive(origin: Vec3, overrides: Partial<PlayerState> = {}): PlayerState {
    return createIdlePlayerState({ origin, commandTime: 100, ...overrides });
  }

  /** Commands the client has made at each of `times`, held as `input`. */
  function commands(source: Scripted, times: number[], input: Partial<NetUserCmd> = {}): void {
    const clock = new ClientClock();
    for (const time of times) {
      clock.serverTime = time;
      clock.jumped = true;
      const cmd = createNetUserCmd();
      Object.assign(cmd, input);
      source.commands.createNewCommands(cmd, clock, true, PMOVE_MSEC);
    }
  }

  /** The times from `from` to `to`, a step apart. */
  const steps = (from: number, to: number) =>
    Array.from({ length: (to - from) / PMOVE_MSEC + 1 }, (_, i) => from + i * PMOVE_MSEC);

  it('carries an item that rides one, from the snapshot to the frame', () => {
    const item = createEntityState(41);
    item.eType = ET.ITEM;
    item.modelindex = itemIndex(findItem('item_armor_shard')!);
    item.pos.trBase = vec3(10, 0, 48);
    item.groundEntityNum = 40;
    const { source, view } = onMap({ ps: alive(vec3(-500, 0, 24)), entities: [sliding(), item] });
    frame(source, view, 100);
    expect(view.items()[0].origin).toEqual(vec3(10, 0, 48));
    // From the snapshot, however many frames have been drawn since.
    frame(source, view, 120);
    frame(source, view, 130);
    expect(view.items()[0].origin.x).toBeCloseTo(13, 5);
  });

  it('turns a corpse that lies on a turning one round it, and turns it with it', () => {
    const corpse = createEntityState(70);
    corpse.eType = ET.PLAYER;
    corpse.pos.trBase = vec3(32, 0, 56);
    corpse.apos.trBase = vec3(0, 10, 0);
    corpse.groundEntityNum = 40;
    const { source, view } = onMap({ ps: alive(vec3(-500, 0, 24)), entities: [turning(), corpse] });
    frame(source, view, 100);
    // A quarter turn is 2.5 s at 36 a second.
    frame(source, view, 2600);
    const [drawn] = view.players();
    expect(drawn.origin.x).toBeCloseTo(0, 3);
    expect(drawn.origin.y).toBeCloseTo(32, 3);
    expect(drawn.angles.y).toBeCloseTo(100, 3);
  });

  it('stops the predicted run at one sent in the way, by its own brushes', () => {
    const pillar = mover(40, 2, { trBase: vec3(50, 0, 0) });
    const { source, view } = onMap({ ps: alive(vec3(-50, 0, 24)), entities: [pillar] });
    frame(source, view, 100);
    commands(source, steps(108, 600), { forwardmove: 127 });
    frame(source, view, 600);
    // The pillar's face at 34, and the player's box 15 short of it.
    expect(view.player.origin.x).toBeCloseTo(19, 0);
  });

  it('stops the third-person camera at one behind the player', () => {
    const pillar = mover(40, 2, { trBase: vec3(0, 0, 0) });
    const { source, view } = onMap({ ps: alive(vec3(40, 0, 24)), entities: [pillar] });
    view.thirdPerson = true;
    frame(source, view, 100);
    // Backed off 40 from the eye, it would stand in the pillar; its box stops 4 short of the face.
    expect(view.view().origin.x).toBeGreaterThan(19);
  });

  it('turns one by the angles this frame draws it at, frame after frame', () => {
    // The pillar turning 45 a second: its corner reaches x 17.2 from its middle at 4.5, and
    // 22.6 at 49.5.
    const spinning = mover(40, 2, {}, { trType: TR.LINEAR, trDelta: vec3(0, 45, 0) });
    const { source, view } = onMap({ ps: alive(vec3(-500, 0, 24)), entities: [spinning] });
    const at = vec3(21, 0, 32);
    frame(source, view, 100);
    expect(view.pointContents(at, -1)).toBe(0);
    frame(source, view, 600);
    frame(source, view, 1100);
    expect(view.pointContents(at, -1)).toBe(CONTENTS.SOLID);
  });

  it("leaves the player's early blast's bubbles in the water one carries", () => {
    const blast = (entities: EntityState[]) => {
      const ps = alive(vec3(0, 0, 128), { weapon: WP.SHOTGUN });
      ps.stats[STAT.WEAPONS] = 1 << WP.SHOTGUN;
      ps.ammo[WP.SHOTGUN] = 10;
      const { source, view } = onMap({ ps, entities });
      view.delagWeapons = 2;
      frame(source, view, 100);
      commands(source, [108], { buttons: BUTTON_ATTACK, weapon: WP.SHOTGUN });
      frame(source, view, 108);
      return view.effects.filter(({ type }) => type === 'bubbles').length;
    };
    expect(blast([])).toBe(0);
    expect(blast([mover(40, 3, {})])).toBeGreaterThan(0);
  });

  it('carries the player standing on one to the frame, on its number', () => {
    const { source, view } = onMap({ ps: alive(vec3(0, 0, 56)), entities: [sliding()] });
    frame(source, view, 100);
    commands(source, [108]);
    frame(source, view, 120);
    // The replay met the plat where the snapshot at 100 had it, and it is 2 on by 120.
    expect(view.player.groundEntityNum).toBe(40);
    expect(view.player.origin.x).toBeCloseTo(2, 4);
    expect(view.sample().origin.x).toBeCloseTo(2, 4);
  });

  it('turns the view drawn with the one the player rides, beside the mouse', () => {
    const { source, view } = onMap({ ps: alive(vec3(32, 0, 56)), entities: [turning()] });
    frame(source, view, 100);
    commands(source, [108]);
    frame(source, view, 120);
    expect(view.sample().viewangles.y).toBeCloseTo(0.72, 4);
    expect(view.player.viewangles.y).toBeCloseTo(0.72, 4);
  });

  it("takes no miss for the mover's own motion after a frame that drew the snapshot", () => {
    const { source, view } = onMap({
      ps: alive(vec3(0, 0, 56), { groundEntityNum: 40 }),
      entities: [sliding()]
    });
    const heard = listen(view);
    view.showMiss = 2;
    commands(source, [108]);
    frame(source, view, 108);
    // The server answers the command, made for 112, at 116, the player carried on by the plat;
    // a frame then has nothing to replay and draws the snapshot.
    const answered = source.commands.at(source.commands.cmdNumber).serverTime;
    const ps = alive(vec3(1.6, 0, 56), { commandTime: answered, groundEntityNum: 40 });
    source.send(12, 116, { ps, entities: [sliding()] });
    frame(source, view, 124);
    commands(source, [132]);
    frame(source, view, 140);
    expect(heard.filter((line) => line.startsWith('['))).toEqual(['[112 : 108] ', '[136 : 140] ']);
    expect(heard.join('')).not.toContain('Prediction miss');
  });

  it("stands one where cgame's floats have it, which doubles miss by ten minutes", () => {
    // q3dm19's *1's bob, on the pillar: at 605 s the floats put its top at 537.774, and doubles
    // at 537.762.
    const bob = { trType: TR.SINE, trTime: 4000, trDuration: 8000, trDelta: vec3(0, 0, 670) };
    const sent = { ps: alive(vec3(-500, 0, 24)), entities: [mover(40, 2, bob)] };
    const { source, view } = onMap(sent, 605000);
    frame(source, view, 605000);
    expect(view.pointContents(vec3(0, 0, 537.77), -1)).toBe(CONTENTS.SOLID);
  });

  it('carries a grenade at rest on one, as anything else riding it', () => {
    const grenade = createEntityState(42);
    grenade.eType = ET.MISSILE;
    grenade.weapon = WP.GRENADE_LAUNCHER;
    grenade.otherEntityNum = 5;
    grenade.pos.trBase = vec3(10, 0, 36);
    grenade.groundEntityNum = 40;
    const sent = { ps: alive(vec3(-500, 0, 24)), entities: [sliding(), grenade] };
    const { source, view } = onMap(sent);
    frame(source, view, 130);
    expect(view.missiles()[0].origin.x).toBeCloseTo(13, 5);
  });

  it('predicts the move in the water one carries, as CG_PointContents finds it', () => {
    const sinking = (entities: EntityState[]) => {
      const { source, view } = onMap({ ps: alive(vec3(0, 0, 128)), entities });
      frame(source, view, 100);
      commands(source, [108]);
      frame(source, view, 108);
      return view.player.velocity.z;
    };
    const pool = mover(40, 3, {});
    // In the air the step falls; in the pool it sinks no faster than water lets it.
    expect(sinking([])).toBeLessThan(-6);
    expect(sinking([pool])).toBeGreaterThan(-6);
  });

  it("gurgles another player's pain in the water one carries", () => {
    const pained = (entities: EntityState[]) => {
      const diver = createEntityState(1);
      diver.eType = ET.PLAYER;
      diver.clientNum = 1;
      diver.pos.trBase = vec3(0, 0, 128);
      diver.event = EV.PAIN | EV_EVENT_BIT1;
      diver.eventParm = 50;
      const sent = { ps: alive(vec3(-500, 0, 24)), entities: [diver, ...entities] };
      const { source, view } = onMap(sent);
      frame(source, view, 100);
      return view.entitySounds.find(({ number }) => number === 1)?.sound.type;
    };
    expect(pained([])).toBe('custom');
    expect(pained([mover(40, 3, {})])).toBe('shared');
  });

  it("lets a gamestate's solids go with it, before the next world's first snapshot", () => {
    let gone = false;
    const real = createClipInlineModels(cm);
    const models = {
      ...real,
      // The next map has no `*2`.
      inlineModel: (index: number) => {
        if (gone && index > 0) throw new Error('CM_InlineModel: bad number');
        return real.inlineModel(index);
      }
    };
    const source = new Scripted();
    source.send(11, 100, { ps: alive(vec3(-500, 0, 24)), entities: [mover(40, 2, {})] });
    const view = new PlayerView(source, createClipTrace(cm), undefined, undefined, models);
    frame(source, view, 100);
    gone = true;
    source.gamestateMessageNum = 20;
    frame(source, view, 108);
    expect(view.pointContents(vec3(0, 0, 32), -1)).toBe(0);
  });

  it("asks a new gamestate's hurt how deep the player is in its world, not the last one's", () => {
    let gone = false;
    const real = createClipInlineModels(cm);
    const models = {
      ...real,
      inlineModel: (index: number) => {
        if (gone && index > 0) throw new Error('CM_InlineModel: bad number');
        return real.inlineModel(index);
      }
    };
    const source = new Scripted();
    source.send(11, 100, { ps: alive(vec3(-500, 0, 24)), entities: [mover(40, 2, {})] });
    const view = new PlayerView(source, createClipTrace(cm), undefined, undefined, models);
    // Without a prediction, a snapshot's hurt is heard as it is made current.
    view.noPredict = true;
    frame(source, view, 100);
    gone = true;
    source.gamestateMessageNum = 20;
    source.send(21, 1000, { ps: alive(vec3(-500, 0, 24)) });
    // The player's own hurt is heard in their health.
    const hurt = alive(vec3(-500, 0, 24));
    hurt.stats[STAT.HEALTH] = 50;
    source.send(22, 1008, { ps: hurt });
    frame(source, view, 1008);
    expect(view.playerSounds).toEqual([{ type: 'custom', name: 'pain75_1' }]);
  });

  it("is in one's brushes where it is drawn, but for the one passed", () => {
    const pillar = mover(40, 2, { trBase: vec3(100, 0, 0) });
    const { source, view } = onMap({ ps: alive(vec3(-500, 0, 24)), entities: [pillar] });
    frame(source, view, 100);
    expect(view.pointContents(vec3(100, 0, 32), -1)).toBe(CONTENTS.SOLID);
    expect(view.pointContents(vec3(100, 0, 32), 40)).toBe(0);
    expect(view.pointContents(vec3(100, 0, -8), 40)).toBe(CONTENTS.SOLID);
  });

  describe('the lists, from the snapshot prediction takes its base from', () => {
    /** Another player standing in slot 1 at x = 36, in the way of a run along +x. */
    function blocker(): EntityState {
      const state = createEntityState(1);
      state.eType = ET.PLAYER;
      state.clientNum = 1;
      const { mins, maxs } = playerBounds(false);
      state.solid = packSolid({ bmodel: false, contents: CONTENTS.BODY, mins, maxs });
      state.pos.trBase = vec3(36, 0, 24);
      return state;
    }

    /**
     * A run along +x from the origin, the next snapshot without the player in the way, and the
     * next teleporting the player or not.
     */
    function runPast(clearTeleport: boolean, teleportNext = false): number {
      const { source, view } = onMap({ ps: alive(vec3(0, 0, 24)), entities: [blocker()] });
      if (clearTeleport) {
        commands(source, [108]);
        frame(source, view, 108);
      }
      const eFlags = teleportNext ? EF_TELEPORT_BIT : 0;
      source.send(12, 300, { ps: alive(vec3(0, 0, 24), { eFlags }) });
      commands(source, steps(116, 196), { forwardmove: 127 });
      frame(source, view, 196);
      return view.player.origin.x;
    }

    // The run makes 11 units, and the player in the way stops it at 6.
    it('are the next snapshot once a replay has cleared the spawn, so one gone is gone', () => {
      expect(runPast(true)).toBeGreaterThan(9);
    });

    it("are the current one's while the spawn's teleport stands, so one gone still stops", () => {
      expect(runPast(false)).toBeLessThan(6);
    });

    it("are the current one's when the next teleports the player", () => {
      expect(runPast(true, true)).toBeLessThan(6);
    });
  });

  describe('drawn', () => {
    it('hands each in as CG_Mover adds it, where the frame places it, by entity number', () => {
      const pillar = mover(41, 2, { trBase: vec3(50, 0, 0) }, { trBase: vec3(0, 45, 0) });
      const sent = { ps: alive(vec3(-500, 0, 24)), entities: [sliding(), pillar] };
      const { source, view } = onMap(sent);
      frame(source, view, 130);
      const [plat, drawnPillar] = view.movers();
      expect(view.movers()).toHaveLength(2);
      expect(plat).toMatchObject({ model: 1, angles: [0, 0, 0] });
      expect(plat.origin[0]).toBeCloseTo(13, 5);
      expect(drawnPillar).toEqual({
        model: 2,
        number: 41,
        origin: [50, 0, 0],
        angles: [0, 45, 0],
        constantLight: 0
      });
      frame(source, view, 150);
      expect(view.movers()[0].origin[0]).toBeCloseTo(15, 5);
    });

    it('hands in its constantLight, which cgame adds a light for', () => {
      const lamp = mover(41, 2, { trBase: vec3(50, 0, 0) });
      lamp.constantLight = 0x20ff8040;
      const { source, view } = onMap({ ps: alive(vec3(-500, 0, 24)), entities: [lamp] });
      frame(source, view, 130);
      expect(view.movers()[0].constantLight).toBe(0x20ff8040);
    });

    it('turns one on its own trajectory', () => {
      const { source, view } = onMap({ ps: alive(vec3(-500, 0, 24)), entities: [turning()] });
      // A quarter turn is 2.5 s at 36 a second.
      frame(source, view, 2500);
      expect(view.movers()[0].angles[1]).toBeCloseTo(90, 4);
    });

    it("stands one where cgame's floats have it", () => {
      // As the solid list's case: the pillar's top at 537.774 in floats, 537.762 in doubles.
      const bob = { trType: TR.SINE, trTime: 4000, trDuration: 8000, trDelta: vec3(0, 0, 670) };
      const sent = { ps: alive(vec3(-500, 0, 24)), entities: [mover(40, 2, bob)] };
      const { source, view } = onMap(sent, 605000);
      frame(source, view, 605000);
      expect(view.movers()[0].origin[2]).toBeCloseTo(537.774 - 64, 2);
    });

    it('carries one that rides another, as everything else the view places', () => {
      const riding = mover(41, 2, { trBase: vec3(10, 0, 32) });
      riding.groundEntityNum = 40;
      const sent = { ps: alive(vec3(-500, 0, 24)), entities: [sliding(), riding] };
      const { source, view } = onMap(sent);
      frame(source, view, 100);
      frame(source, view, 130);
      expect(view.movers()[1].origin[0]).toBeCloseTo(13, 5);
    });

    it('names its model2 by CS_MODELS, and leaves out one not linked as a brush model', () => {
      const source = new Scripted();
      source.configstrings[CONFIGSTRING.MODELS + 3] = 'models/mapobjects/fan.md3';
      const fan = mover(41, 2, {});
      fan.modelindex2 = 3;
      const boxed = mover(42, 3, {});
      boxed.solid = 0x102020;
      source.send(11, 100, { ps: alive(vec3(-500, 0, 24)), entities: [sliding(), fan, boxed] });
      const contents = createClipPointContents(cm);
      const models = createClipInlineModels(cm);
      const view = new PlayerView(source, createClipTrace(cm), undefined, contents, models);
      frame(source, view, 100);
      const [plat, drawnFan] = view.movers();
      expect(view.movers()).toHaveLength(2);
      expect(plat.model2).toBeUndefined();
      expect(drawnFan).toMatchObject({ model: 2, model2: 'models/mapobjects/fan.md3' });
      // Its model2 gone from the next snapshot, it is gone from the pose it is handed in by.
      const bare = mover(41, 2, {});
      source.send(12, 116, { ps: alive(vec3(-500, 0, 24)), entities: [sliding(), bare] });
      frame(source, view, 124);
      expect(view.movers()[1]).toBe(drawnFan);
      expect(drawnFan.model2).toBeUndefined();
    });

    it("hands the bus each one where it is drawn, its events heard from its box's middle", () => {
      const plat = sliding();
      plat.loopSound = 3;
      const pillar = mover(41, 2, { trBase: vec3(50, 0, 0) });
      const sent = { ps: alive(vec3(-500, 0, 24)), entities: [plat, pillar] };
      const { source, view } = onMap(sent);
      frame(source, view, 130);
      const [drawnPlat, drawnPillar] = view.movers();
      // The plat's box is 32 high, and the pillar's 64, each about its origin.
      expect(view.soundEntities()).toEqual([
        expect.objectContaining({
          number: 40,
          origin: vec3(...drawnPlat.origin),
          soundOrigin: vec3(drawnPlat.origin[0], drawnPlat.origin[1], drawnPlat.origin[2] + 16),
          loopSound: 3,
          speaker: false
        }),
        expect.objectContaining({
          number: 41,
          origin: vec3(...drawnPillar.origin),
          soundOrigin: vec3(50, 0, 32),
          loopSound: 0
        })
      ]);
    });

    it("works its model's middle out again from a new gamestate's map", () => {
      // The next map's plat is 96 high.
      const next = loadMap(
        boxesBsp([
          [
            [-64, -64, 0],
            [64, 64, 96]
          ]
        ]),
        'maps/next.bsp'
      );
      const maps = { models: createClipInlineModels(cm) };
      const models: InlineModels = {
        inlineModel: (index) => maps.models.inlineModel(index),
        contact: (...args) => maps.models.contact(...args),
        transformedBoxTrace: (...args) => maps.models.transformedBoxTrace(...args),
        transformedPointContents: (...args) => maps.models.transformedPointContents(...args),
        modelBounds: (...args) => maps.models.modelBounds(...args)
      };
      const source = new Scripted();
      const sent = { ps: alive(vec3(-500, 0, 24)), entities: [mover(40, 1, {})] };
      source.send(11, 100, sent);
      const view = new PlayerView(source, createClipTrace(cm), undefined, undefined, models);
      frame(source, view, 100);
      expect(view.soundEntities()[0].soundOrigin).toEqual(vec3(0, 0, 16));

      maps.models = createClipInlineModels(next);
      source.gamestateMessageNum = 20;
      source.send(21, 300, sent);
      frame(source, view, 300);
      expect(view.soundEntities()[0].soundOrigin).toEqual(vec3(0, 0, 48));
    });

    it('writes the same list and poses again each frame, and drops one the snapshot lost', () => {
      const pillar = mover(41, 2, { trBase: vec3(50, 0, 0) });
      const sent = { ps: alive(vec3(-500, 0, 24)), entities: [sliding(), pillar] };
      const { source, view } = onMap(sent);
      frame(source, view, 100);
      const list = view.movers();
      const [first] = list;
      frame(source, view, 108);
      expect(view.movers()).toBe(list);
      expect(view.movers()[0]).toBe(first);
      source.send(12, 116, { ps: alive(vec3(-500, 0, 24)), entities: [pillar] });
      frame(source, view, 124);
      expect(view.movers()).toEqual([
        { model: 2, number: 41, origin: [50, 0, 0], angles: [0, 0, 0], constantLight: 0 }
      ]);
    });
  });
});

describe("the lagometer's samples", () => {
  it('take each snapshot read, its ping and flags, and one lost as −1', () => {
    const { source, view } = started({ ps: at(1), ping: 40 });
    // 12 never arrived; 13 was held back for the rate.
    source.send(13, 116, { ps: at(3), ping: 55, flags: SNAPFLAG.RATE_DELAYED });
    frame(source, view, 116);
    const { lagometer } = view;
    expect(lagometer.snapshot(0)).toEqual({ ping: 55, snapFlags: SNAPFLAG.RATE_DELAYED });
    expect(lagometer.snapshot(1)?.ping).toBe(-1);
    expect(lagometer.snapshot(2)).toEqual({ ping: 40, snapFlags: 0 });
    expect(lagometer.snapshot(3)).toBeNull();
  });

  it("take each frame drawn, its clock less the newest snapshot's time", () => {
    const { source, view } = started();
    source.send(12, 108, { ps: at(2) });
    frame(source, view, 104);
    // Past the newest, as a frame drawn with no snapshot ahead is.
    frame(source, view, 112.5);
    expect([view.lagometer.frame(0), view.lagometer.frame(1)]).toEqual([4.5, -4]);
    // A frame with no snapshot read takes a frame's sample all the same.
    frame(source, view, 113);
    expect(view.lagometer.frame(0)).toBe(5);
    expect(view.lagometer.snapshot(2)).toBeNull();
  });

  it('take no frame before the player is in the world', () => {
    const source = new Scripted();
    source.send(11, 100, { flags: SNAPFLAG.NOT_ACTIVE });
    const view = new PlayerView(source, createFlatWorldTrace());
    frame(source, view, 100);
    expect(view.lagometer.frame(0)).toBeNull();
    // The snapshot was read all the same.
    expect(view.lagometer.snapshot(0)).toEqual({ ping: 0, snapFlags: SNAPFLAG.NOT_ACTIVE });
  });

  it("start over with a new gamestate, as a new cgame's do", () => {
    const { source, view } = started({ ps: at(1), ping: 40 });
    frame(source, view, 100);
    source.gamestateMessageNum = 20;
    source.send(21, 50, { ps: at(7), ping: 70 });
    frame(source, view, 50);
    expect(view.lagometer.snapshot(0)?.ping).toBe(70);
    expect(view.lagometer.snapshot(1)).toBeNull();
    expect(view.lagometer.frame(0)).toBe(0);
    expect(view.lagometer.frame(1)).toBeNull();
  });
});
