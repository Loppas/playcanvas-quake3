import { describe, expect, it } from 'vitest';

import { entityTokens } from './formats/entity-text';
import {
  createEntityState,
  createPlayerState,
  ENTITYNUM_NONE,
  TR,
  type EntityState,
  type PlayerState
} from './net/protocol';
import { havePak, havePak0, openPak } from './pak/pak-test-fixtures';
import { PakFileSystem } from './pak/vfs';
import {
  compareHealth,
  compareMovers,
  compareMoves,
  compareSights,
  moveState,
  ORIGIN_BOUND,
  portPmFlags,
  q3MoveState,
  replay,
  vq3Config,
  type MoverState,
  type MoveState,
  type Q3Frame,
  type ReplayCommand,
  type Sight
} from './scripted-run';
import { hostMapFromData, readHostMapData } from './server/host-map';
import type { HostMap } from './server/host';
import { shortAngle } from './sim/client';
import { createFlatWorldTrace } from './sim/box-world';
import { createClipTrace } from './sim/clip-trace';
import { loadMap } from './sim/cm/cm-load';
import { boxesBsp, stripsBsp } from './sim/cm/collision-test-fixtures';
import {
  CONTENTS,
  EF_DEAD,
  EF_TELEPORT_BIT,
  PMF_BACKWARDS_JUMP,
  PMF_BACKWARDS_RUN,
  PMF_DUCKED,
  PMF_FOLLOW,
  PMF_GRAPPLE_PULL,
  PMF_JUMP_HELD,
  PMF_RESPAWNED,
  PMF_TIME_KNOCKBACK,
  PMF_TIME_LAND,
  PMF_TIME_WATERJUMP,
  PMF_USE_ITEM_HELD,
  GT,
  STAT
} from './sim/constants';
import { ET } from './sim/game-entity';
import { DEFAULT_ITEM_MATCH } from './sim/item-touch';
import { Level } from './sim/level';
import { mapOf, spawnSpot } from './sim/map-test-fixtures';
import { pmove } from './sim/pmove';
import { CpmaPmove } from './sim/pmove-cpma';
import { ID_RULES, RuleCvars } from './sim/rules';
import { spawnEntitiesFromString, spawnEntityFromVars } from './sim/spawn';
import { createUserCmd } from './sim/types';
import { vec3 } from './sim/vec3';

/** A move's state: a player standing still at the origin, facing along +y, with these changes. */
function move(changes: Partial<MoveState> = {}): MoveState {
  return {
    commandTime: 1000,
    pmType: 0,
    pmFlags: 0,
    pmTime: 0,
    origin: vec3(0, 0, 24),
    velocity: vec3(),
    viewangles: vec3(0, 90, 0),
    deltaAngles: vec3(0, 16384, 0),
    gravity: 800,
    speed: 320,
    groundEntityNum: ENTITYNUM_NONE,
    movementDir: 0,
    bobCycle: 0,
    viewheight: 26,
    teleportBit: 0,
    ...changes
  };
}

/**
 * Quake 3's checkpoints, each its player's state after a command, held to the port's after the
 * same command.
 */
function atCommands(checkpoints: readonly MoveState[], moves: ReadonlyMap<number, MoveState>) {
  const snapshots = checkpoints.map((state) => ({ serverTime: state.commandTime, state }));
  return compareMoves(snapshots, moves);
}

/** Commands every tick from `from` to `to`, holding these moves. */
function held(
  from: number,
  to: number,
  forwardmove = 0,
  upmove = 0,
  rightmove = 0
): ReplayCommand[] {
  const commands: ReplayCommand[] = [];
  for (let serverTime = from; serverTime <= to; serverTime += 8) {
    commands.push({ serverTime, forwardmove, rightmove, upmove });
  }
  return commands;
}

describe("Quake 3's state, in the port's numbers", () => {
  it("maps each of Quake 3's pm_flags to the port's own", () => {
    const pairs = [
      [1, PMF_DUCKED],
      [2, PMF_JUMP_HELD],
      [8, PMF_BACKWARDS_JUMP],
      [16, PMF_BACKWARDS_RUN],
      [32, PMF_TIME_LAND],
      [64, PMF_TIME_KNOCKBACK],
      [256, PMF_TIME_WATERJUMP],
      [512, PMF_RESPAWNED],
      [1024, PMF_USE_ITEM_HELD],
      [2048, PMF_GRAPPLE_PULL],
      [4096, PMF_FOLLOW]
    ];
    for (const [q3, port] of pairs) expect(portPmFlags(q3)).toBe(port);
    expect(portPmFlags(2 | 64)).toBe(PMF_JUMP_HELD | PMF_TIME_KNOCKBACK);
    expect(portPmFlags(0)).toBe(0);
  });

  it("refuses a flag the port has not got, as Team Arena's invulnerability sphere", () => {
    expect(() => portPmFlags(2 | 16384)).toThrow(
      "Quake 3's pm_flags 16384, which the port has no flag"
    );
  });

  it("takes the move's fields, flags mapped, and refuses a pm_type the port has not got", () => {
    const ps = createPlayerState();
    Object.assign(ps, { commandTime: 2712, pmFlags: 64, pmTime: 152, bobCycle: 7 });
    ps.origin = vec3(216, 1324.800048828125, 24.97439956665039);
    expect(q3MoveState(ps)).toEqual({
      ...moveState(ps),
      pmFlags: PMF_TIME_KNOCKBACK
    });
    expect(moveState(ps).origin).not.toBe(ps.origin);

    ps.pmType = 1;
    expect(() => q3MoveState(ps)).toThrow("Quake 3's pm_type 1, which the port has not got");
  });
});

describe('vq3Config', () => {
  it("puts vq3.cfg in force, which is id's rules", () => {
    const { cvars } = vq3Config();
    expect(cvars.get('g_gamepreset')).toBe('VQ3');
    expect(new RuleCvars(cvars).rules).toEqual(ID_RULES);
  });
});

describe('compareMoves', () => {
  /** Each state as Quake 3's snapshot after the frame 8 ms past its command carries it. */
  const snaps = (...states: MoveState[]) =>
    states.map((state) => ({ serverTime: state.commandTime + 8, state }));
  /** The port's states after its frames, each 8 ms past its command. */
  const port = (...states: MoveState[]) => new Map(states.map((s) => [s.commandTime + 8, s]));

  it('counts a state the same on every field as exact', () => {
    const result = compareMoves(snaps(move()), port(move()));
    expect(result).toEqual({ compared: 1, exact: 1, originOff: 0, differences: [] });
  });

  it("holds each snapshot to the port's frame at or after it, and its command time", () => {
    // A 50 ms frame's snapshot is the port's frame at or after it.
    const theirs = [{ serverTime: 1050, state: move({ commandTime: 1048 }) }];
    const ours = new Map([[1056, move({ commandTime: 1040 })]]);
    expect(compareMoves(theirs, ours).differences).toEqual([
      { time: 1050, field: 'commandTime', q3: 1048, port: 1040 }
    ]);
  });

  it('holds the origin within a thousandth of a unit', () => {
    expect(ORIGIN_BOUND).toBe(1e-3);
  });

  it('lets the origin off by the bound and no more, and says how far it was', () => {
    const near = move({ origin: vec3(0, 0, 24 + ORIGIN_BOUND / 2) });
    const far = move({ commandTime: 1008, origin: vec3(0, 2 * ORIGIN_BOUND, 24) });
    const result = compareMoves(snaps(near, far), port(move(), move({ commandTime: 1008 })));

    expect(result.exact).toBe(0);
    expect(result.originOff).toBeCloseTo(2 * ORIGIN_BOUND, 12);
    expect(result.differences).toEqual([
      { time: 1016, field: 'origin.y', q3: 2 * ORIGIN_BOUND, port: 0 }
    ]);
  });

  it('holds every other field exact', () => {
    const theirs = move({ velocity: vec3(0, -320, 1), pmFlags: PMF_JUMP_HELD, bobCycle: 4 });
    const ours = move({ velocity: vec3(0, -320, 0), pmFlags: 0, bobCycle: 4 });
    expect(compareMoves(snaps(theirs), port(ours)).differences).toEqual([
      { time: 1008, field: 'pmFlags', q3: PMF_JUMP_HELD, port: 0 },
      { time: 1008, field: 'velocity.z', q3: 1, port: 0 }
    ]);
  });

  it('holds the teleport bit, read from the flags, and starts the replay with it', () => {
    const ps = createPlayerState();
    ps.eFlags = EF_TELEPORT_BIT | EF_DEAD;
    expect(moveState(ps).teleportBit).toBe(EF_TELEPORT_BIT);
    const theirs = move({ teleportBit: EF_TELEPORT_BIT });
    expect(compareMoves(snaps(theirs), port(move())).differences).toEqual([
      { time: 1008, field: 'teleportBit', q3: EF_TELEPORT_BIT, port: 0 }
    ]);
  });

  it('matches a zero to a zero of either sign, as the wire sends a whole float', () => {
    const theirs = move({ velocity: vec3(0, 0, 0) });
    const ours = move({ velocity: vec3(0, 0, -0) });
    expect(compareMoves(snaps(theirs), port(ours)).exact).toBe(1);
  });

  it("says where the port has no state at a time of Quake 3's", () => {
    const theirs = [{ serverTime: 1020, state: move() }];
    expect(compareMoves(theirs, port(move())).differences).toEqual([
      { time: 1020, field: 'commandTime', q3: 1000, port: null }
    ]);
  });
});

describe('replay', () => {
  /** Flat ground, with a spawn spot far from where the run puts the player. */
  const flat: HostMap = {
    name: 'flat',
    entities: mapOf(spawnSpot(vec3(512, 512, 16))),
    trace: createFlatWorldTrace()
  };

  /** The same commands through the move alone, from the same state. */
  function moved(start: MoveState, commands: readonly ReplayCommand[]): Map<number, MoveState> {
    const trace = createFlatWorldTrace();
    const ps: PlayerState = createPlayerState();
    Object.assign(ps, { ...start, origin: { ...start.origin }, velocity: { ...start.velocity } });
    ps.stats[STAT.HEALTH] = 100;
    const states = new Map<number, MoveState>();
    for (const command of commands) {
      if (command.serverTime <= start.commandTime) continue;
      const angles = vec3(
        shortAngle(ps.deltaAngles.x),
        shortAngle(ps.deltaAngles.y),
        shortAngle(ps.deltaAngles.z)
      );
      pmove(ps, createUserCmd({ ...command, angles }), trace, { core: CpmaPmove });
      states.set(ps.commandTime, moveState(ps));
    }
    return states;
  }

  it("runs the commands on the port's server as the move alone runs them", () => {
    // In the air, so the run lands, then walks, jumps on the walk, and stops.
    const start = move({ origin: vec3(0, 0, 64) });
    const commands = [
      ...held(1000, 1096),
      ...held(1104, 1496, 127),
      ...held(1504, 1520, 127, 127),
      ...held(1528, 1696, 127),
      ...held(1704, 2000)
    ];
    const states = replay(flat, start, commands).moves;

    expect([...states.keys()]).toEqual(commands.slice(1).map(({ serverTime }) => serverTime));
    expect(states).toEqual(moved(start, commands));
    // The port's spawn toggled its own bit; the run's start put Quake 3's back.
    expect(states.get(2000)!.teleportBit).toBe(0);
    // It went somewhere: it walked along +y and jumped.
    expect(states.get(2000)!.origin.y).toBeGreaterThan(150);
    expect([...states.values()].some((s) => s.velocity.z > 200)).toBe(true);
  });

  /** The flat ground in lava a unit deep about the origin, with the spawn spot clear of it. */
  const lava: HostMap = {
    ...flat,
    pointContents: (point) => (point.z < 10 && point.x < 100 ? CONTENTS.LAVA : 0)
  };

  /** Each fall of the health a run's frames show, by Quake 3's time, and how far it fell. */
  function burns(health: ReadonlyMap<number, number>): [number, number][] {
    const fell: [number, number][] = [];
    let last = 100;
    for (const [time, now] of [...health].sort(([a], [b]) => a - b)) {
      if (now !== last) fell.push([time, last - now]);
      last = now;
    }
    return fell;
  }

  it("starts Quake 3's player at its health, and puts its 50 ms frames on the port's", () => {
    const start = move({ groundEntityNum: 1022 });
    const { health } = replay(lava, start, held(1000, 2000), { health: 100, levelStartTime: 0 });

    // In the lava from the first command, at 1008: Quake 3's frames at 1050, 1750 and 1800,
    // each on the port's first frame in it.
    expect(burns(health)).toEqual([
      [1056, 30],
      [1752, 30],
      [1800, 30]
    ]);
  });

  it("runs each of Quake 3's frames once the commands before it are thought, then the rest", () => {
    const start = move({ groundEntityNum: 1022 });
    const frames = [
      { serverTime: 1050, commandTime: 1000 },
      { serverTime: 1100, commandTime: 1048 }
    ];
    const { health } = replay(lava, start, held(1000, 1400), {
      health: 100,
      levelStartTime: 0,
      frames
    });

    // The frame at 1050 runs before the first command, so the lava is found for 1100's.
    expect(burns(health)).toEqual([[1104, 30]]);
    const q3 = [
      { serverTime: 1050, health: 100 },
      { serverTime: 1100, health: 70 }
    ];
    expect(compareHealth(q3, health)).toEqual([]);

    // A frame whose snapshot shows the first command thought runs after it, and finds the lava.
    const after = replay(lava, start, held(1000, 1400), {
      health: 100,
      levelStartTime: 0,
      frames: [{ serverTime: 1050, commandTime: 1008 }]
    });
    expect(burns(after.health)).toEqual([[1056, 30]]);
  });

  it("runs the frames of Quake 3's snapshots after its last command", () => {
    const start = move({ groundEntityNum: 1022 });
    const frames = [{ serverTime: 1200, commandTime: 1096 }];
    const { snapshots } = replay(flat, start, held(1000, 1096), { frames });
    expect(snapshots.get(1200)?.commandTime).toBe(1096);
  });

  it("runs the map's movers, and the move's touches: a button walked into opens its door", () => {
    const cm = loadMap(
      boxesBsp([
        [
          [64, -16, 0],
          [72, 16, 48]
        ],
        [
          [200, -32, 0],
          [264, 32, 96]
        ]
      ]),
      'maps/boxes.bsp'
    );
    const boxes: HostMap = {
      name: 'boxes',
      entities: mapOf(
        spawnSpot(vec3(-512, 512, 16)),
        { classname: 'func_button', model: '*1', target: 'gate' },
        { classname: 'func_door', model: '*2', targetname: 'gate', angle: '-1' }
      ),
      clipMap: cm,
      trace: createClipTrace(cm)
    };
    // Facing the button along +x, on the floor.
    const start = move({
      origin: vec3(0, 0, 24.125),
      viewangles: vec3(),
      deltaAngles: vec3(),
      groundEntityNum: 1022
    });
    const { movers } = replay(boxes, start, held(1000, 1800, 127));

    // The spawn spot, then the button and the door, after the body queue's eight.
    const [button, door] = [73, 74];
    expect([...movers.get(1800)!.keys()]).toEqual([button, door]);
    const pressed = [...movers.values()].find((frame) => frame.get(button)!.pos.trType !== 0);
    const { trTime } = pressed!.get(button)!.pos;
    expect(trTime).toBeGreaterThan(1000);
    // The button's 150 ms out end on a frame, which fires the door 50 ms after it, and the door's
    // 225 ms up end on the first frame after.
    expect(movers.get(1600)!.get(door)!.pos).toMatchObject({ trType: 3, trTime: trTime + 200 });
    const top = Math.ceil((trTime + 200 + 225) / 8) * 8;
    expect(movers.get(1800)!.get(door)!.pos).toMatchObject({ trType: 0, trTime: top });
    expect(movers.get(1800)!.get(door)!.pos.trBase).toEqual(vec3(0, 0, 90));
  });

  /** Two shards hung in the air, at x 32 and 96, and a spawn spot far off at the first's side. */
  const shards = mapOf(
    spawnSpot(vec3(-512, 512, 16)),
    { classname: 'item_armor_shard', origin: '32 0 0', spawnflags: '1' },
    { classname: 'item_armor_shard', origin: '96 0 0', spawnflags: '1' }
  );

  it('takes what the host would send its player after each frame, the mask as kept', () => {
    // Two rooms either side of x 64, each its own area.
    const strips = [
      { cluster: 0, area: 0 },
      { cluster: 1, area: 1 }
    ];
    const cm = loadMap(stripsBsp(strips), 'maps/strips.bsp');
    const trace = createClipTrace(cm);
    const map: HostMap = { name: 'strips', entities: shards, clipMap: cm, trace };
    const start = move({ origin: vec3(16, 0, 0) });

    const near = replay(map, start, held(1000, 1096)).sights.get(1096)!;
    const both = replay({ ...flat, entities: shards }, start, held(1000, 1096)).sights.get(1096)!;

    expect(near.numbers).toHaveLength(1);
    expect(Array.from(near.areamask)).toEqual([0xfe, ...new Array<number>(31).fill(0)]);
    expect(both.numbers).toHaveLength(2);
    expect(both.numbers).toContain(near.numbers[0]);
    expect(Array.from(both.areamask)).toEqual(new Array<number>(32).fill(0));
  });

  it("makes setviewpos's two events just before the start's frame, for their 300 ms", () => {
    const start = move({ groundEntityNum: 1022 });
    const teleport = { time: 1000, from: vec3(512, 512, 16), to: vec3(0, 0, 23) };
    const { sights } = replay(flat, start, held(1000, 1400), { teleport });
    const events = (time: number) => {
      const before = new Set(sights.get(984)!.numbers);
      return sights.get(time)!.numbers.filter((number) => !before.has(number));
    };

    expect(events(992)).toEqual([]);
    const [out, into] = events(1000);
    expect(into).toBe(out + 1);
    // Freed by the first frame more than 300 ms after their time.
    expect(events(1288)).toEqual([out, into]);
    expect(events(1296)).toEqual([]);
    expect(replay(flat, start, held(1000, 1400)).sights.get(1000)).toEqual(sights.get(984));
  });

  it('refuses a teleport from before the player came into the world', () => {
    const start = move({ groundEntityNum: 1022 });
    const teleport = { time: 0, from: vec3(), to: vec3() };
    expect(() => replay(flat, start, held(1000, 1400), { teleport })).toThrow('too late');
  });
});

describe('compareSights', () => {
  /** A sight of these numbers and this mask's first bytes. */
  const sight = (numbers: number[], ...bytes: number[]): Sight => {
    const areamask = new Uint8Array(32);
    areamask.set(bytes);
    return { numbers, areamask };
  };
  const q3 = (serverTime: number, numbers: number[], ...bytes: number[]) => ({
    serverTime,
    entities: numbers.map((number) => ({ number })),
    areamask: sight([], ...bytes).areamask
  });

  it("holds each snapshot's numbers and whole mask to the port's after its frame", () => {
    const port = new Map([[1056, sight([70, 81], 0xfe, 0xff)]]);
    expect(compareSights([q3(1050, [70, 81], 0xfe, 0xff)], port)).toEqual({
      compared: 1,
      differences: []
    });
  });

  it('says which entity one side sent and the other did not, and each byte that differs', () => {
    const port = new Map([[1000, sight([70, 82], 0xfc)]]);
    expect(compareSights([q3(1000, [70, 81], 0xfe, 0xff)], port).differences).toEqual([
      { time: 1000, field: 'entity 81', q3: 1, port: 0 },
      { time: 1000, field: 'entity 82', q3: 0, port: 1 },
      { time: 1000, field: 'areamask[0]', q3: 0xfe, port: 0xfc },
      { time: 1000, field: 'areamask[1]', q3: 0xff, port: 0 }
    ]);
  });

  it('says where the port has no sight', () => {
    expect(compareSights([q3(2000, [70])], new Map()).differences).toEqual([
      { time: 2000, field: 'sight', q3: 1, port: null }
    ]);
  });
});

describe('compareMovers', () => {
  /** A mover's entity state at rest at a point, its clock at 100. */
  function mover(number: number, x: number): EntityState {
    const s = createEntityState();
    s.number = number;
    s.eType = ET.MOVER;
    s.pos.trTime = 100;
    s.pos.trBase = vec3(x, 0, 0);
    return s;
  }
  const ours = (s: EntityState): MoverState => ({ pos: { ...s.pos }, apos: { ...s.apos } });

  it("holds each of Quake 3's movers to the port's after the frame of its time", () => {
    const door = mover(80, 64);
    const port = new Map([[1056, new Map([[80, ours(door)]])]]);
    // A 50 ms frame's snapshot is the port's frame at or after it.
    expect(compareMovers([{ serverTime: 1050, entities: [door] }], port)).toEqual({
      compared: 1,
      differences: []
    });
  });

  it('holds every field exact, a zero of either sign matching, and the rest set aside', () => {
    const theirs = mover(80, 64);
    theirs.pos.trDelta = vec3(-0, 400, 0);
    const mine = ours(mover(80, 64));
    mine.pos.trDelta = vec3(0, 400.0000305175781, 0);
    mine.apos.trTime = 7;
    const item = createEntityState();
    item.number = 81;
    item.eType = ET.ITEM;
    const port = new Map([[1000, new Map([[80, mine]])]]);
    expect(compareMovers([{ serverTime: 1000, entities: [theirs, item] }], port)).toEqual({
      compared: 1,
      differences: [
        { time: 1000, field: '80.pos.trDelta.y', q3: 400, port: 400.0000305175781 },
        { time: 1000, field: '80.apos.trTime', q3: 0, port: 7 }
      ]
    });
  });

  it('says where the port has no such mover', () => {
    const port = new Map([[1000, new Map<number, MoverState>()]]);
    const { differences } = compareMovers([{ serverTime: 1000, entities: [mover(80, 64)] }], port);
    expect(differences).toEqual([{ time: 1000, field: '80', q3: 80, port: null }]);
  });
});

describe('compareHealth', () => {
  it("holds Quake 3's health after each frame to the port's after its first frame since", () => {
    const port = new Map([
      [1048, 100],
      [1056, 70],
      [1064, 70]
    ]);
    expect(compareHealth([{ serverTime: 1050, health: 70 }], port)).toEqual([]);
    expect(compareHealth([{ serverTime: 1048, health: 70 }], port)).toEqual([
      { time: 1048, field: 'health', q3: 70, port: 100 }
    ]);
    expect(compareHealth([{ serverTime: 2000, health: 70 }], port)).toEqual([
      { time: 2000, field: 'health', q3: 70, port: null }
    ]);
  });
});

describe.skipIf(!havePak0)("Quake 3's own run on q3dm1, held without running Quake 3", () => {
  // From `npm run q3-play`'s q3dm1-drop: Quake 3's player as `setviewpos` threw it, then its
  // states as the demo recorded them, in Quake 3's numbers.
  const q3 = (changes: Partial<PlayerState>): MoveState => {
    const ps = createPlayerState();
    Object.assign(ps, {
      deltaAngles: vec3(0, 49152, 0),
      viewangles: vec3(0, -90, 0),
      gravity: 800,
      speed: 320,
      viewheight: 26,
      ...changes
    });
    return q3MoveState(ps);
  };
  const start = q3({
    commandTime: 2712,
    pmFlags: 64,
    pmTime: 152,
    origin: vec3(216, 1324.800048828125, 24.97439956665039),
    velocity: vec3(0, -400, -6),
    groundEntityNum: ENTITYNUM_NONE
  });
  const checkpoints = [
    // Thrown, landed, and still sliding to a stop.
    q3({
      commandTime: 3040,
      origin: vec3(216, 1223.779541015625, 24.12735939025879),
      velocity: vec3(0, -129, 0),
      groundEntityNum: 1022
    }),
    // Up on the walk's jump, over a step.
    q3({
      commandTime: 4024,
      origin: vec3(216, 959.810546875, 72.65535736083984),
      velocity: vec3(0, -320, 0),
      groundEntityNum: ENTITYNUM_NONE,
      bobCycle: 180
    }),
    // The jump landed hard.
    q3({
      commandTime: 4384,
      pmFlags: 32,
      pmTime: 250,
      origin: vec3(216, 935.06005859375, 24.125),
      groundEntityNum: 1022,
      bobCycle: 3
    }),
    // Down the 40 units to the hall's floor, landed hard.
    q3({
      commandTime: 5320,
      pmFlags: 32,
      pmTime: 250,
      origin: vec3(216, 655.2291870117188, -15.875),
      velocity: vec3(0, -320, 0),
      groundEntityNum: 1022,
      bobCycle: 3
    }),
    // And stopped.
    q3({ commandTime: 6936, origin: vec3(216, 604.8468017578125, -15.875), groundEntityNum: 1022 })
  ];

  it('reaches every checkpoint of the walk, the jump and the drop', async () => {
    const fs = new PakFileSystem();
    fs.mount(await openPak('pak0.pk3'));
    const map = hostMapFromData(await readHostMapData(fs, 'q3dm1'));
    const commands = [
      ...held(2720, 3184),
      ...held(3192, 3664, 127),
      ...held(3672, 3744, 127, 127),
      ...held(3752, 5344, 127),
      ...held(5352, 6944)
    ];

    const result = atCommands(checkpoints, replay(map, start, commands).moves);
    expect(result.differences).toEqual([]);
    expect(result.originOff).toBeLessThan(ORIGIN_BOUND);
  }, 30000);
});

describe.skipIf(!havePak0)("Quake 3's own swim on q3dm12, held without running Quake 3", () => {
  // From `npm run q3-play`'s q3dm12-swim, facing east, as the q3dm1 case's are taken.
  const q3 = (changes: Partial<PlayerState>): MoveState => {
    const ps = createPlayerState();
    Object.assign(ps, { gravity: 800, speed: 320, viewheight: 26, ...changes });
    return q3MoveState(ps);
  };
  const start = q3({
    commandTime: 2736,
    pmFlags: 64,
    pmTime: 152,
    origin: vec3(43.20000076293945, -700, -231.875),
    velocity: vec3(400, 0, 0),
    groundEntityNum: 1022
  });
  const checkpoints = [
    // Thrown into the water, and swimming under it at half the speed.
    q3({
      commandTime: 3440,
      origin: vec3(279.8116760253906, -700, -316.0967102050781),
      velocity: vec3(168, 0, -106),
      groundEntityNum: ENTITYNUM_NONE
    }),
    // Risen along the wall to the waist, and thrown out by the water jump.
    q3({
      commandTime: 4808,
      pmFlags: 256,
      pmTime: 2000,
      origin: vec3(304.8734130859375, -700, -272.60723876953125),
      velocity: vec3(200, 0, 337),
      groundEntityNum: ENTITYNUM_NONE
    }),
    // Coming down, so the jump is over.
    q3({
      commandTime: 5016,
      origin: vec3(304.8734130859375, -700, -236.97686767578125),
      velocity: vec3(200, 0, -1),
      groundEntityNum: ENTITYNUM_NONE
    }),
    // Stepped onto the walkway.
    q3({
      commandTime: 5024,
      origin: vec3(306.4734191894531, -700, -231.875),
      velocity: vec3(200, 0, 0),
      groundEntityNum: 1022
    }),
    // And stopped.
    q3({
      commandTime: 5632,
      origin: vec3(330.06829833984375, -700, -231.875),
      groundEntityNum: 1022
    })
  ];

  it('reaches every checkpoint of the swim, the water jump and the step out', async () => {
    const fs = new PakFileSystem();
    fs.mount(await openPak('pak0.pk3'));
    const map = hostMapFromData(await readHostMapData(fs, 'q3dm12'));
    const commands = [
      ...held(2744, 3208),
      ...held(3216, 4008, 127),
      ...held(4016, 4840, 127, 127),
      ...held(4848, 5640)
    ];

    const result = atCommands(checkpoints, replay(map, start, commands).moves);
    expect(result.differences).toEqual([]);
    expect(result.originOff).toBeLessThan(ORIGIN_BOUND);
  }, 30000);
});

describe.skipIf(!havePak0)("Quake 3's own leap from a q3dm17 pad, held without Quake 3", () => {
  // From `npm run q3-play`'s q3dm17-pad, facing north-west, as the q3dm1 case's are taken.
  const q3 = (changes: Partial<PlayerState>): MoveState => {
    const ps = createPlayerState();
    Object.assign(ps, {
      deltaAngles: vec3(0, 24576, 0),
      viewangles: vec3(0, 135, 0),
      gravity: 800,
      speed: 320,
      viewheight: 26,
      ...changes
    });
    return q3MoveState(ps);
  };
  const start = q3({
    commandTime: 2720,
    pmFlags: 64,
    pmTime: 152,
    origin: vec3(117.73725891113281, 650.2627563476562, 352.9743957519531),
    velocity: vec3(-283, 283, -6),
    groundEntityNum: ENTITYNUM_NONE
  });
  const checkpoints = [
    // Thrown, landed, and walking north-west across the platform.
    q3({
      commandTime: 3120,
      origin: vec3(41.011356353759766, 726.988525390625, 352.1274719238281),
      velocity: vec3(-59, 59, 0),
      groundEntityNum: 1022
    }),
    // Up on the pad's step, its disc's cut edge a step away.
    q3({
      commandTime: 3328,
      origin: vec3(17.9051513671875, 750.0947265625, 360.125),
      velocity: vec3(-226, 226, 0),
      groundEntityNum: 1022,
      bobCycle: 51
    }),
    // Touched by the brush, not its bounds, and launched at the QVM's floats.
    q3({
      commandTime: 3336,
      origin: vec3(16.09495735168457, 751.9049072265625, 360.125),
      velocity: vec3(-56.71340560913086, 52.662445068359375, 789.9367065429688),
      groundEntityNum: 1022,
      bobCycle: 54
    }),
    // Over the top of the leap.
    q3({
      commandTime: 4392,
      origin: vec3(-86.82926177978516, 849.557373046875, 775.9772338867188),
      velocity: vec3(-101, 96, -2),
      groundEntityNum: ENTITYNUM_NONE,
      bobCycle: 54
    }),
    // Down on the ledge beyond.
    q3({
      commandTime: 5080,
      pmFlags: 32,
      pmTime: 250,
      origin: vec3(-156.31715393066406, 915.6058349609375, 600.125),
      velocity: vec3(-101, 96, 1),
      groundEntityNum: 1022
    }),
    // And stopped.
    q3({
      commandTime: 5504,
      origin: vec3(-167.1272430419922, 925.87890625, 600.125),
      groundEntityNum: 1022
    })
  ];

  /** `q3dm17`, as the server loads it from pak0. */
  async function q3dm17(): Promise<HostMap> {
    const fs = new PakFileSystem();
    fs.mount(await openPak('pak0.pk3'));
    return hostMapFromData(await readHostMapData(fs, 'q3dm17'));
  }

  it('reaches every checkpoint of the walk, the pad and the leap', async () => {
    const commands = [...held(2728, 3192), ...held(3200, 3512, 127), ...held(3520, 5512)];

    const result = atCommands(checkpoints, replay(await q3dm17(), start, commands).moves);
    expect(result.differences).toEqual([]);
    expect(result.originOff).toBeLessThan(ORIGIN_BOUND);
  }, 30000);

  it("aims every pad as Quake 3 did, by ioquake3's normalize where the two part", async () => {
    // Each pad's `origin2` as Quake 3 sent it, by its brush model.
    const Q3_PADS: Record<number, [number, number, number]> = {
      4: [-961.4476928710938, 115.50961303710938, 941.9129638671875],
      5: [-52.662445068359375, -56.71340560913086, 789.9367065429688],
      9: [0, -788.0069580078125, 587.8120727539062],
      10: [0, 790.9588012695312, 589.4207763671875],
      11: [356.29840087890625, 0, 1150.0887451171875],
      12: [579.04541015625, 0, 978.16162109375],
      13: [-56.71340560913086, 52.662445068359375, 789.9367065429688],
      14: [0, 0.0001817194715840742, 1074.80224609375],
      15: [-299.0990295410156, 0, 1326.649658203125],
      16: [0, 206.21762084960938, 946.57275390625],
      17: [205.41140747070312, 0, 919.1300659179688],
      18: [0, -206.2174072265625, 946.57275390625],
      19: [-961.4476928710938, -115.50961303710938, 941.9129638671875]
    };
    // Where ioquake3's `VectorNormalize`, by the inverse length, rounds the length otherwise than
    // id's, by the root, which the retail game module runs. The port's is ioquake3's.
    const IOQ3_PADS: Record<number, [number, number, number]> = {
      4: [-961.4476318359375, 115.50960540771484, 941.9129638671875],
      10: [0, 790.9588623046875, 589.4207763671875],
      16: [0, 206.2176055908203, 946.57275390625],
      19: [-961.4476318359375, -115.50960540771484, 941.9129638671875]
    };
    const map = await q3dm17();
    const level = new Level({ clipMap: map.clipMap });
    level.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => 0, gravity: () => 800 };
    spawnEntitiesFromString(
      entityTokens(map.entities),
      () => {},
      (vars) => spawnEntityFromVars(level, vars, GT.FFA, () => {})
    );

    const aimed: Record<number, [number, number, number]> = {};
    for (const pad of level.gentities.filter((entity) => entity.s.eType === ET.PUSH_TRIGGER)) {
      pad.think!(pad);
      // The wire sends a whole float as an integer, so a zero's sign is not Quake 3's to say.
      const { x, y, z } = pad.s.origin2;
      aimed[pad.s.modelindex] = [x || 0, y || 0, z || 0];
    }
    expect(aimed).toEqual({ ...Q3_PADS, ...IOQ3_PADS });
  }, 30000);
});

describe.skipIf(!havePak0)("Quake 3's own teleport on q3dm17, held without Quake 3", () => {
  // From `npm run q3-play`'s q3dm17-teleport: north-west up the channel into the northern
  // teleporter, and out on the eastern ledge facing west.
  const q3 = (changes: Partial<PlayerState>): MoveState => {
    const ps = createPlayerState();
    Object.assign(ps, {
      deltaAngles: vec3(0, 24576, 0),
      viewangles: vec3(0, 135, 0),
      gravity: 800,
      speed: 320,
      viewheight: 26,
      ...changes
    });
    return q3MoveState(ps);
  };
  /** Through the teleporter: facing its destination's west, and the teleport bit toggled. */
  const west = (changes: Partial<PlayerState>): MoveState =>
    q3({ deltaAngles: vec3(0, 32768, 0), viewangles: vec3(0, -180, 0), eFlags: 4, ...changes });
  const start = q3({
    commandTime: 2712,
    pmFlags: 64,
    pmTime: 152,
    origin: vec3(327.73724365234375, 848.2627563476562, 352.9743957519531),
    velocity: vec3(-283, 283, -6),
    groundEntityNum: ENTITYNUM_NONE
  });
  const checkpoints = [
    // Thrown, landed, and walking north-west along the platform.
    q3({
      commandTime: 3112,
      origin: vec3(251.01148986816406, 924.988525390625, 352.1274719238281),
      velocity: vec3(-59, 59, 0),
      groundEntityNum: 1022
    }),
    // Up the step into the channel.
    q3({
      commandTime: 3600,
      origin: vec3(164.54844665527344, 1011.4510498046875, 366.125),
      velocity: vec3(-226, 226, 0),
      groundEntityNum: 1022,
      bobCycle: 156
    }),
    // The last step outside the chamfered brush, well inside its bounds.
    q3({
      commandTime: 3696,
      origin: vec3(143.6618194580078, 1032.3375244140625, 366.125),
      velocity: vec3(-186, 186, 0),
      groundEntityNum: 1022,
      bobCycle: 180
    }),
    // Touched: a unit over the destination, thrown west along the game module's float cosine,
    // facing it, the ground the move left untouched.
    west({
      commandTime: 3704,
      pmFlags: 64,
      pmTime: 160,
      origin: vec3(816, 64, 349),
      velocity: vec3(-400, -3.496911085676402e-5, 0),
      viewangles: vec3(0, 180, 0),
      groundEntityNum: 1022,
      bobCycle: 180
    }),
    // Down on the ledge under the knockback window.
    west({
      commandTime: 3752,
      pmFlags: 64,
      pmTime: 112,
      origin: vec3(796.7999267578125, 64, 348.12640380859375),
      velocity: vec3(-400, 0, -36),
      groundEntityNum: 1022,
      bobCycle: 180
    }),
    // And stopped, short of the ledge's western drop.
    west({
      commandTime: 4856,
      origin: vec3(699.5245361328125, 64, 348.1274719238281),
      groundEntityNum: 1022
    })
  ];

  it('reaches every checkpoint of the walk, the teleport and the slide', async () => {
    const fs = new PakFileSystem();
    fs.mount(await openPak('pak0.pk3'));
    const map = hostMapFromData(await readHostMapData(fs, 'q3dm17'));
    const commands = [...held(2720, 3184), ...held(3192, 3664, 127), ...held(3672, 4864)];

    const result = atCommands(checkpoints, replay(map, start, commands).moves);
    expect(result.differences).toEqual([]);
    expect(result.originOff).toBe(0);
  }, 30000);
});

describe.skipIf(!havePak0)("Quake 3's own burn in q3dm7's lava, held without Quake 3", () => {
  // From `npm run q3-play`'s q3dm7-lava, Quake 3 at its own `sv_fps` of 20, facing east.
  const ps = createPlayerState();
  Object.assign(ps, {
    commandTime: 2688,
    pmFlags: 64,
    pmTime: 128,
    origin: vec3(212.79998779296875, -800, -299.3904113769531),
    velocity: vec3(400, 0, -24),
    gravity: 800,
    speed: 320,
    viewheight: 26
  });
  const start = q3MoveState(ps);

  // Quake 3's frames after the start, every 50 ms from 2800, each with the last command thought
  // before it: the commands came a few at a time, so how far behind it varies.
  const THOUGHT = [
    2736, 2784, 2840, 2888, 2936, 2984, 3040, 3088, 3136, 3184, 3248, 3288, 3336, 3384,
    3440, 3488, 3536, 3584, 3640, 3688, 3736, 3784, 3848, 3888, 3936, 3984, 4040, 4088,
    4136, 4184, 4240, 4288, 4336, 4384, 4448, 4488, 4536, 4584, 4640, 4688, 4736, 4784
  ];
  const frames = THOUGHT.map((commandTime, i) => ({ serverTime: 2800 + 50 * i, commandTime }));
  // It burned 30 at 3200, as the player landed, at 3900 and at 3950.
  const BURNED = [3200, 3900, 3950];
  const q3Health = frames.map(({ serverTime }) => ({
    serverTime,
    health: 100 - 30 * BURNED.filter((time) => time <= serverTime).length
  }));

  it('burns on the frames Quake 3 burned on, and no more once stepped out', async () => {
    const fs = new PakFileSystem();
    fs.mount(await openPak('pak0.pk3'));
    const map = hostMapFromData(await readHostMapData(fs, 'q3dm7'));
    const commands = [...held(2696, 3856), ...held(3864, 4328, 127), ...held(4336, 4808)];

    const { moves, health } = replay(map, start, commands, {
      health: 100,
      levelStartTime: 0,
      frames
    });

    expect(compareHealth(q3Health, health)).toEqual([]);
    // Out on the step, 14 units above the lava's floor, before the fourth would have killed.
    expect(moves.get(4784)!.origin.z).toBe(-369.875);
  }, 30000);
});

const haveCpma3 = havePak('map_cpma3.pk3');

describe.skipIf(!haveCpma3)("Quake 3's own ride on cpma3's plat, held without Quake 3", () => {
  // From `npm run q3-play`'s cpma3-plat, facing east: onto the plat at its bottom and into its
  // trigger, up 290 on it, south off at the top, and the plat down again a second after.
  const q3 = (changes: Partial<PlayerState>): MoveState => {
    const ps = createPlayerState();
    Object.assign(ps, { gravity: 800, speed: 320, viewheight: 26, ...changes });
    return q3MoveState(ps);
  };
  const start = q3({
    commandTime: 2552,
    pmFlags: 64,
    pmTime: 152,
    origin: vec3(2223.199951171875, -836, -317.0256042480469),
    velocity: vec3(400, 0, -6),
    groundEntityNum: 1023
  });
  // Each of Quake 3's frames ran after the command 16 ms before it.
  const frames: Q3Frame[] = [];
  for (let serverTime = 2576; serverTime <= 5992; serverTime += 8) {
    frames.push({ serverTime, commandTime: serverTime - 16 });
  }
  // The player after Quake 3's frames: on the plat at its bottom, into its trigger, ridden up, at
  // its top, off it, and stopped on the floor beside it.
  const at = (serverTime: number, changes: Partial<PlayerState>) => ({
    serverTime,
    state: q3({ commandTime: serverTime - 16, ...changes })
  });
  const checkpoints = [
    at(2848, {
      origin: vec3(2317.15869140625, -836, -313.875),
      velocity: vec3(174, 0, 0),
      groundEntityNum: 305
    }),
    at(2992, {
      origin: vec3(2350.82080078125, -836, -313.875),
      velocity: vec3(320, 0, 0),
      groundEntityNum: 305,
      bobCycle: 42
    }),
    at(3232, {
      origin: vec3(2417.07421875, -836, -194.99302673339844),
      velocity: vec3(161, 0, 0),
      groundEntityNum: 305,
      bobCycle: 90
    }),
    at(3520, { origin: vec3(2434.483642578125, -836, -23.875015258789062), groundEntityNum: 305 }),
    at(4192, {
      origin: vec3(2434.483642578125, -903.35107421875, -23.875015258789062),
      velocity: vec3(0, -320, 0),
      groundEntityNum: 1023,
      bobCycle: 99,
      movementDir: 6
    }),
    at(5992, {
      origin: vec3(2434.483642578125, -969.4706420898438, -25.832998275756836),
      groundEntityNum: 1022,
      movementDir: 7
    })
  ];
  // The plat, Quake 3's 305, after the same frames: at rest at its bottom; set going 50 ms after
  // the trigger; at its top; down again; and at rest at its bottom.
  const plat = [
    [2848, 0, 0, -290, 174000],
    [2992, 3, 3034, -290, 600.4140625],
    [3520, 0, 3520, 0, 600.4140625],
    [5184, 3, 5184, 0, -600.4140625],
    [5992, 0, 5672, -290, -600.4140625]
  ];

  it('rides the plat as Quake 3 rode it, pushed on the same frames, and moves it so', async () => {
    const fs = new PakFileSystem();
    fs.mount(await openPak('map_cpma3.pk3'));
    const map = hostMapFromData(await readHostMapData(fs, 'cpma3'));
    const commands = [
      ...held(2560, 2864),
      ...held(2872, 3104, 127),
      ...held(3112, 3904),
      ...held(3912, 4224, 0, 0, 127),
      ...held(4232, 5984)
    ];

    const run = replay(map, start, commands, { health: 100, levelStartTime: 0, frames });
    expect(compareMoves(checkpoints, run.snapshots).differences).toEqual([]);
    const pos = plat.map(([time]) => run.movers.get(time)!.get(305)!.pos);
    expect(pos.map((tr) => [tr.trType, tr.trTime, tr.trBase.z, tr.trDelta.z])).toEqual(
      plat.map(([, ...rest]) => rest)
    );
    expect(pos.every((tr) => tr.trDuration === 483)).toBe(true);
  }, 30000);
});

describe.skipIf(!havePak0)("Quake 3's own ride on q3dm19's bobber, held without Quake 3", () => {
  // From `npm run q3-play`'s q3dm19-bob, facing south-west: dropped onto the platform as it rises
  // to meet the player, and ridden up to its peak, down to its foot and up again.
  const q3 = (changes: Partial<PlayerState>): MoveState => {
    const ps = createPlayerState();
    Object.assign(ps, {
      gravity: 800,
      speed: 320,
      viewheight: 26,
      viewangles: vec3(0, -135, 0),
      deltaAngles: vec3(0, 40960, 0),
      ...changes
    });
    return q3MoveState(ps);
  };
  const start = q3({
    commandTime: 2720,
    pmFlags: 64,
    pmTime: 152,
    origin: vec3(-42.26274108886719, 533.7372436523438, 525.9744262695312),
    velocity: vec3(-283, -283, -6),
    groundEntityNum: 1023
  });
  // Each of Quake 3's frames ran after the command 16 ms before it.
  const frames: Q3Frame[] = [];
  for (let serverTime = 2744; serverTime <= 9600; serverTime += 8) {
    frames.push({ serverTime, commandTime: serverTime - 16 });
  }
  // The player after Quake 3's frames: on the platform as it meets them, and carried with it.
  const at = (serverTime: number, z: number) => ({
    serverTime,
    state: q3({
      commandTime: serverTime - 16,
      origin: vec3(-152.33975219726562, 423.6601867675781, z),
      groundEntityNum: 80
    })
  });
  const checkpoints = [
    {
      serverTime: 2984,
      state: q3({
        commandTime: 2968,
        origin: vec3(-112.44673919677734, 463.55328369140625, 503.71044921875),
        velocity: vec3(-283, -283, 0),
        groundEntityNum: 80
      })
    },
    at(3944, 510.2486267089844),
    at(5144, 82.911865234375),
    at(6344, -248.7742919921875),
    at(7544, -26.430633544921875),
    at(8744, 442.6711120605469),
    at(9600, 553.931884765625)
  ];

  it('rides the platform as Quake 3 rode it, the bob on the wire as Quake 3 sent it', async () => {
    const fs = new PakFileSystem();
    fs.mount(await openPak('pak0.pk3'));
    const map = hostMapFromData(await readHostMapData(fs, 'q3dm19'));

    const run = replay(map, start, held(2728, 9592), { health: 100, levelStartTime: 0, frames });
    const result = compareMoves(checkpoints, run.snapshots);
    expect(result.differences).toEqual([]);
    expect(result.originOff).toBeLessThan(ORIGIN_BOUND);
    expect(run.movers.get(9600)!.get(80)!.pos).toEqual({
      trType: TR.SINE,
      trTime: 1980,
      trDuration: 6000,
      trBase: vec3(),
      trDelta: vec3(0, 0, 405)
    });
  }, 30000);
});
