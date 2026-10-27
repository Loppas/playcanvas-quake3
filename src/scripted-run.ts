import { configCommands } from './formats/q3config';
import { LocalGame } from './local-game';
import { MAX_MAP_AREA_BYTES } from './net/commands';
import { CA } from './net/connection';
import {
  createNetUserCmd,
  MAX_CLIENTS,
  type EntityState,
  type PlayerState,
  type Trajectory
} from './net/protocol';
import { InProcessHost } from './server/channel';
import type { Host, HostMap } from './server/host';
import { GameConfig } from './settings/game-config';
import { shippedCfg } from './settings/presets';
import {
  EF_TELEPORT_BIT,
  PM_DEAD,
  PM_FREEZE,
  PM_INTERMISSION,
  PM_NORMAL,
  PM_SPECTATOR,
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
  PMOVE_MSEC,
  STAT
} from './sim/constants';
import { ET } from './sim/game-entity';
import type { Level } from './sim/level';
import { teleportEvents } from './sim/teleport';
import { createUserCmd } from './sim/types';
import { copy, type Vec3 } from './sim/vec3';

/**
 * The port's half of the scripted run: a player's commands, as Quake 3 ran them on a map, run
 * again on the port's server on the same map, and the states they reach held to Quake 3's.
 *
 * Quake 3 records the run as a demo, and its log gives each command's time and keys
 * (`scripts/q3-play.mjs`). The port's player is given the state Quake 3's had at the run's first
 * snapshot, then each command through `SV_ClientThink`, as Quake 3's server took it, with the
 * server's frames between. The game runs under the shipped `vq3.cfg`, the rules Quake 3's own game
 * module plays by.
 */

/** The fields of a player's state that the move reads and writes, which the run holds. */
export interface MoveState {
  commandTime: number;
  pmType: number;
  pmFlags: number;
  pmTime: number;
  origin: Vec3;
  velocity: Vec3;
  viewangles: Vec3;
  deltaAngles: Vec3;
  gravity: number;
  speed: number;
  groundEntityNum: number;
  movementDir: number;
  bobCycle: number;
  viewheight: number;
  /** `eFlags`' `EF_TELEPORT_BIT`, which a teleport toggles. */
  teleportBit: number;
}

/** The {@link MoveState} fields that are a player state's own numbers, and its vectors. */
const SCALARS = [
  'pmType',
  'pmFlags',
  'pmTime',
  'gravity',
  'speed',
  'groundEntityNum',
  'movementDir',
  'bobCycle',
  'viewheight'
] as const;
const VECTORS = ['origin', 'velocity', 'viewangles', 'deltaAngles'] as const;

/** Every number the run holds: the state's own, and its teleport bit. */
const HELD = [...SCALARS, 'teleportBit'] as const;

/**
 * Quake 3's `PMF_*` (`bg_public.h:148-160`), each with the port's own number for it. The port
 * numbers its flags for itself, so a state from Quake 3's wire is read through this.
 */
const Q3_PM_FLAGS: readonly (readonly [q3: number, port: number])[] = [
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

/** The `pm_type`s the port has, which Quake 3 numbers the same (`bg_public.h:130-138`). */
const PM_TYPES: ReadonlySet<number> = new Set([
  PM_NORMAL,
  PM_SPECTATOR,
  PM_DEAD,
  PM_FREEZE,
  PM_INTERMISSION
]);

/**
 * Quake 3's `pm_flags` in the port's numbers.
 *
 * @throws for a flag the port has not got, as Team Arena's `PMF_INVULEXPAND`
 */
export function portPmFlags(q3: number): number {
  let flags = 0;
  let left = q3;
  for (const [theirs, ours] of Q3_PM_FLAGS) {
    if (!(q3 & theirs)) continue;
    flags |= ours;
    left &= ~theirs;
  }
  if (left !== 0) {
    throw new Error(`scripted run: Quake 3's pm_flags ${left}, which the port has no flag for`);
  }
  return flags;
}

/** The move's fields of a port's player state. */
export function moveState(ps: PlayerState): MoveState {
  return {
    commandTime: ps.commandTime,
    pmType: ps.pmType,
    pmFlags: ps.pmFlags,
    pmTime: ps.pmTime,
    origin: copy(ps.origin),
    velocity: copy(ps.velocity),
    viewangles: copy(ps.viewangles),
    deltaAngles: copy(ps.deltaAngles),
    gravity: ps.gravity,
    speed: ps.speed,
    groundEntityNum: ps.groundEntityNum,
    movementDir: ps.movementDir,
    bobCycle: ps.bobCycle,
    viewheight: ps.viewheight,
    teleportBit: ps.eFlags & EF_TELEPORT_BIT
  };
}

/**
 * The move's fields of a player state from Quake 3's wire, in the port's numbers.
 *
 * @throws for a flag or a `pm_type` the port has not got
 */
export function q3MoveState(ps: PlayerState): MoveState {
  if (!PM_TYPES.has(ps.pmType)) {
    throw new Error(`scripted run: Quake 3's pm_type ${ps.pmType}, which the port has not got`);
  }
  return { ...moveState(ps), pmFlags: portPmFlags(ps.pmFlags) };
}

/** A command as Quake 3's client made it: its time, and the keys' moves. Its angles are none. */
export interface ReplayCommand {
  serverTime: number;
  forwardmove: number;
  rightmove: number;
  upmove: number;
}

/** One of Quake 3's frames, as the snapshot taken after it tells it. */
export interface Q3Frame {
  serverTime: number;
  /** The last command thought before the frame ran. */
  commandTime: number;
}

/** What else of Quake 3's run the port's takes. */
export interface ReplayOptions {
  /** Quake 3's player's health at the start. */
  health?: number;
  /**
   * `CS_LEVEL_START_TIME`, which Quake 3's clock is put on the port's by, so its level's times
   * are the port's; 0 when not given, as both levels start.
   */
  levelStartTime?: number;
  /**
   * Quake 3's frames from the start's on, each run once the commands before it are thought and
   * before any after it.
   */
  frames?: readonly Q3Frame[];
  /**
   * `setviewpos`, which put Quake 3's player at the start: the time of the start's snapshot, and
   * from where and to where. Its two events are made as `TeleportPlayer` makes them, just before
   * the port's frame of that time, the last place between Quake 3's two frames the command could
   * fall, so their slots are Quake 3's and their 300 ms end on Quake 3's frames.
   */
  teleport?: { time: number; from: Vec3; to: Vec3 };
}

/** A mover's two trajectories, as its entity state carries them. */
export interface MoverState {
  pos: Trajectory;
  apos: Trajectory;
}

/** What a snapshot would show the player: the entities' numbers, and the areamask it gets. */
export interface Sight {
  numbers: number[];
  /** All 32 bytes, clear past those sent, as the client keeps them. */
  areamask: Uint8Array;
}

/** The port's run. */
export interface Replay {
  /** The move's state after each command, by Quake 3's command time. */
  moves: Map<number, MoveState>;
  /**
   * The move's state after each of the server's frames, by Quake 3's time: what a snapshot taken
   * after the frame carries, a mover's push in the frame included.
   */
  snapshots: Map<number, MoveState>;
  /** The player's health after each of the server's frames, by Quake 3's time. */
  health: Map<number, number>;
  /** Each mover after each of the server's frames, by Quake 3's time, then by its number. */
  movers: Map<number, Map<number, MoverState>>;
  /**
   * What a snapshot would show the player after each of the server's frames, by Quake 3's time,
   * worked out as the host's are, since the host sends its own on a schedule of its own.
   */
  sights: Map<number, Sight>;
}

/** A trajectory, copied. */
function copyTrajectory(tr: Trajectory): Trajectory {
  return { ...tr, trBase: copy(tr.trBase), trDelta: copy(tr.trDelta) };
}

/** Every mover in a level, by its number. */
function moverStates(level: Level): Map<number, MoverState> {
  const movers = new Map<number, MoverState>();
  for (let i = MAX_CLIENTS; i < level.numEntities; i++) {
    const { inuse, s } = level.gentities[i];
    if (!inuse || s.eType !== ET.MOVER) continue;
    movers.set(i, { pos: copyTrajectory(s.pos), apos: copyTrajectory(s.apos) });
  }
  return movers;
}

/** The preset Quake 3's own game module plays by. */
const VQ3 = 'presets/vq3.cfg';

/** The most frames the player is given to come into the world: a map's gamestate is fragments. */
const BOOT_FRAMES = 250;

/**
 * The settings under `vq3.cfg`, each of its values read back from the store.
 *
 * @throws for a line the store did not take
 */
export function vq3Config(): GameConfig {
  const text = shippedCfg(VQ3);
  if (text === undefined) throw new Error(`scripted run: the port ships no ${VQ3}`);
  const refused: string[] = [];
  const config = new GameConfig({ print: (text) => refused.push(text.trimEnd()) });
  config.exec(text);
  for (const [command, name, value] of configCommands(text)) {
    if (command === 'seta' && config.cvars.get(name) !== value) {
      refused.push(`${name} is "${config.cvars.get(name)}", not "${value}"`);
    }
  }
  if (refused.length > 0) {
    throw new Error(`scripted run: ${VQ3} is not in force: ${refused.join('; ')}`);
  }
  return config;
}

/**
 * Run Quake 3's commands on the port's server.
 *
 * Quake 3's clock is the port's, its level's start put on the port's level's: both run their first
 * frames at 100, 200 and 300 and step from 400, so a mover is where Quake 3's was at any time, and
 * lava burns on the same 50 ms frames. The port's player is put in the state Quake 3's had as soon
 * as it is in the world, and waits there for the run's first command while the server's frames
 * run up to it. Each command is thought for after the server's frames have reached its time, as
 * Quake 3's server thinks for a command it has just received, and after each of Quake 3's frames
 * whose snapshot came before it; the frames of the snapshots after the last command run after it.
 * `setviewpos`'s events are made just before the frame of the start's snapshot.
 *
 * @param map - The map, as the server loads it.
 * @param start - Quake 3's player at the run's start, in the port's numbers.
 * @param commands - Quake 3's commands. Those at or before the start's time are passed over.
 * @param options - Quake 3's health, level start, frames and `setviewpos`.
 * @throws where the player never comes into the world, or does so after Quake 3's run started
 */
export function replay(
  map: HostMap,
  start: MoveState,
  commands: readonly ReplayCommand[],
  options: ReplayOptions = {}
): Replay {
  const { cvars } = vq3Config();
  let game: LocalGame | null = null;
  const channel = new InProcessHost({
    cvars,
    map,
    random: () => 0,
    // The server's console is not the run's.
    print: () => {},
    // The frames are the port's clock, as a local game's own server takes them.
    now: () => game?.connection.clock.realtime ?? 0
  });
  game = new LocalGame({ cvars, channel });
  try {
    for (let i = 0; i < BOOT_FRAMES && game.connection.state !== CA.ACTIVE; i++) {
      game.tick(createUserCmd());
    }
    if (game.connection.state !== CA.ACTIVE) {
      throw new Error('scripted run: the player never came into the world');
    }
    const { host } = game;
    const { level } = game.game;
    const { clientNum } = game.connection;
    const client = level.clients[clientNum];
    const entity = level.gentities[clientNum];

    const shift = level.startTime - (options.levelStartTime ?? 0);
    const { teleport } = options;
    if (
      host.time + PMOVE_MSEC > start.commandTime + shift ||
      (teleport !== undefined && host.time + PMOVE_MSEC > teleport.time + shift)
    ) {
      const arrived = host.time - shift;
      throw new Error(`scripted run: the player came into the world at ${arrived}, too late`);
    }
    putMoveState(client.ps, { ...start, commandTime: start.commandTime + shift });
    if (options.health !== undefined) {
      client.ps.stats[STAT.HEALTH] = options.health;
      entity.health = options.health;
    }
    client.oldOrigin = copy(start.origin);
    entity.r.currentOrigin = copy(start.origin);
    host.linkEntity(entity);

    const states = new Map<number, MoveState>();
    const snapshots = new Map<number, MoveState>();
    const health = new Map<number, number>();
    const movers = new Map<number, Map<number, MoverState>>();
    const sights = new Map<number, Sight>();
    let pending = teleport ?? null;
    const runFrame = (): void => {
      // `setviewpos` is a command, which runs between frames.
      if (pending !== null && host.time + PMOVE_MSEC >= pending.time + shift) {
        teleportEvents(level, entity, pending.from, pending.to);
        pending = null;
      }
      host.runFrame(PMOVE_MSEC);
      const state = moveState(client.ps);
      state.commandTime -= shift;
      snapshots.set(host.time - shift, state);
      health.set(host.time - shift, client.ps.stats[STAT.HEALTH]);
      movers.set(host.time - shift, moverStates(level));
      sights.set(host.time - shift, sight(host, client.ps));
    };
    const frames = options.frames ?? [];
    let frame = 0;
    for (const command of commands) {
      if (command.serverTime <= start.commandTime) continue;
      for (; frame < frames.length && frames[frame].commandTime < command.serverTime; frame++) {
        while (host.time < frames[frame].serverTime + shift) runFrame();
      }
      const time = command.serverTime + shift;
      while (host.time < time) runFrame();
      const cmd = createNetUserCmd();
      cmd.serverTime = time;
      cmd.forwardmove = command.forwardmove;
      cmd.rightmove = command.rightmove;
      cmd.upmove = command.upmove;
      cmd.weapon = client.ps.weapon;
      // `trap_BotUserCommand` is `SV_ClientThink`, which is how Quake 3's server takes any
      // client's command.
      host.botUserCommand(clientNum, cmd);
      const state = moveState(client.ps);
      state.commandTime -= shift;
      states.set(state.commandTime, state);
    }
    for (; frame < frames.length; frame++) {
      while (host.time < frames[frame].serverTime + shift) runFrame();
    }
    return { moves: states, snapshots, health, movers, sights };
  } finally {
    game.shutdown('Server quit');
  }
}

/** What the host would send a player state's eye now. */
function sight(host: Host, ps: PlayerState): Sight {
  const numbers: number[] = [];
  const areabits = new Uint8Array(MAX_MAP_AREA_BYTES);
  const areabytes = host.visibleEntities(ps, numbers, areabits);
  const areamask = new Uint8Array(MAX_MAP_AREA_BYTES);
  areamask.set(areabits.subarray(0, areabytes));
  return { numbers, areamask };
}

/** Put a move's fields on a player state. */
function putMoveState(ps: PlayerState, state: MoveState): void {
  for (const field of SCALARS) ps[field] = state[field];
  for (const field of VECTORS) ps[field] = copy(state[field]);
  ps.commandTime = state.commandTime;
  ps.eFlags = (ps.eFlags & ~EF_TELEPORT_BIT) | state.teleportBit;
}

/** How far each axis of the port's origin may be from Quake 3's, in units. */
export const ORIGIN_BOUND = 1e-3;

/** A field of one of Quake 3's states that the port's did not match. */
export interface MoveDifference {
  /** The time of Quake 3's frame its snapshot was taken after. */
  time: number;
  /** The field, an axis named as `origin.z`, or `commandTime` for a state the port never had. */
  field: string;
  q3: number;
  port: number | null;
}

export interface MoveComparison {
  /** How many of Quake 3's states were held to the port's. */
  compared: number;
  /** How many matched on every field, the origin too. */
  exact: number;
  /** The furthest any axis of the origin was off. */
  originOff: number;
  /** Every field past {@link ORIGIN_BOUND} for the origin, or off at all for the rest. */
  differences: MoveDifference[];
}

/** One of Quake 3's snapshots: the frame it was taken after, and its player's move. */
export interface Q3MoveSnapshot {
  serverTime: number;
  state: MoveState;
}

/**
 * Hold Quake 3's snapshots to the port's state after the port's frame that ran the same time, the
 * first at or after it: the commands thought by then, by the command time, and the move's fields,
 * the origin within {@link ORIGIN_BOUND}, as the port's move works in doubles where Quake 3's
 * rounds each operation to a float, and every other field exact. A zero matches a zero of either
 * sign, as the wire sends a whole float as an integer (`MSG_WriteDeltaPlayerstate`,
 * `msg.c:1165-1178`).
 *
 * @param q3 - Quake 3's snapshots, their states in the port's numbers.
 * @param port - The port's states after its frames, as {@link replay} gives them.
 */
export function compareMoves(
  q3: readonly Q3MoveSnapshot[],
  port: ReadonlyMap<number, MoveState>
): MoveComparison {
  const result: MoveComparison = { compared: 0, exact: 0, originOff: 0, differences: [] };
  for (const { serverTime: time, state: theirs } of q3) {
    result.compared++;
    const ours = port.get(Math.ceil(time / PMOVE_MSEC) * PMOVE_MSEC);
    if (ours === undefined) {
      result.differences.push({ time, field: 'commandTime', q3: theirs.commandTime, port: null });
      continue;
    }
    let exact = true;
    for (const field of ['commandTime', ...HELD] as const) {
      if (theirs[field] === ours[field]) continue;
      exact = false;
      result.differences.push({ time, field, q3: theirs[field], port: ours[field] });
    }
    for (const field of VECTORS) {
      for (const axis of ['x', 'y', 'z'] as const) {
        const a = theirs[field][axis];
        const b = ours[field][axis];
        if (a === b) continue;
        exact = false;
        if (field === 'origin') {
          const off = Math.abs(a - b);
          result.originOff = Math.max(result.originOff, off);
          if (off <= ORIGIN_BOUND) continue;
        }
        result.differences.push({ time, field: `${field}.${axis}`, q3: a, port: b });
      }
    }
    if (exact) result.exact++;
  }
  return result;
}

/** A player's health in one of Quake 3's snapshots, and the frame it was taken after. */
export interface Q3Health {
  serverTime: number;
  health: number;
}

/**
 * Hold Quake 3's health after each of its frames to the port's after the port's frame that ran
 * the same 50 ms of lava and slime: the first at or after it.
 *
 * @param q3 - Quake 3's, from its snapshots.
 * @param port - The port's, as {@link replay} gives it.
 * @returns Each frame at which the two differ.
 */
export function compareHealth(
  q3: readonly Q3Health[],
  port: ReadonlyMap<number, number>
): MoveDifference[] {
  const differences: MoveDifference[] = [];
  for (const { serverTime, health } of q3) {
    const ours = port.get(Math.ceil(serverTime / PMOVE_MSEC) * PMOVE_MSEC) ?? null;
    if (ours === health) continue;
    differences.push({ time: serverTime, field: 'health', q3: health, port: ours });
  }
  return differences;
}

/** One of Quake 3's snapshots, as far as its entities. */
export interface Q3Snapshot {
  serverTime: number;
  entities: readonly EntityState[];
}

/** The fields of a trajectory the run holds, its two vectors by axis. */
const TRAJECTORY_SCALARS = ['trType', 'trTime', 'trDuration'] as const;
const TRAJECTORY_VECTORS = ['trBase', 'trDelta'] as const;

export interface MoverComparison {
  /** How many of Quake 3's movers were held to the port's, a snapshot's each. */
  compared: number;
  /** Every field off at all, or a mover the port had not got. */
  differences: MoveDifference[];
}

/**
 * Hold every mover in Quake 3's snapshots to the port's after the port's frame that ran the same
 * time, the first at or after it: both trajectories, every field exact, the vectors as Quake 3's
 * floats. A zero matches a zero of either sign, as the wire sends a whole float as an integer.
 *
 * @param q3 - Quake 3's snapshots.
 * @param port - The port's movers, as {@link replay} gives them.
 */
export function compareMovers(
  q3: readonly Q3Snapshot[],
  port: ReadonlyMap<number, ReadonlyMap<number, MoverState>>
): MoverComparison {
  const result: MoverComparison = { compared: 0, differences: [] };
  for (const { serverTime, entities } of q3) {
    const frame = port.get(Math.ceil(serverTime / PMOVE_MSEC) * PMOVE_MSEC);
    for (const entity of entities) {
      if (entity.eType !== ET.MOVER) continue;
      result.compared++;
      const time = serverTime;
      const ours = frame?.get(entity.number);
      if (ours === undefined) {
        result.differences.push({ time, field: `${entity.number}`, q3: entity.number, port: null });
        continue;
      }
      for (const kind of ['pos', 'apos'] as const) {
        const theirs = entity[kind];
        const mine = ours[kind];
        const field = (name: string) => `${entity.number}.${kind}.${name}`;
        for (const name of TRAJECTORY_SCALARS) {
          if (theirs[name] === mine[name]) continue;
          result.differences.push({ time, field: field(name), q3: theirs[name], port: mine[name] });
        }
        for (const name of TRAJECTORY_VECTORS) {
          for (const axis of ['x', 'y', 'z'] as const) {
            const a = theirs[name][axis];
            const b = mine[name][axis];
            if (a === b) continue;
            result.differences.push({ time, field: field(`${name}.${axis}`), q3: a, port: b });
          }
        }
      }
    }
  }
  return result;
}

/** One of Quake 3's snapshots, as far as what it shows. */
export interface Q3Sight {
  serverTime: number;
  entities: readonly { number: number }[];
  areamask: Uint8Array;
}

export interface SightComparison {
  /** How many of Quake 3's snapshots were held to the port's sight. */
  compared: number;
  /**
   * Each entity one sends and the other not, as `entity <n>` with 1 for sent and 0 for not, and
   * each byte of the mask that differs, as `areamask[i]`.
   */
  differences: MoveDifference[];
}

/**
 * Hold what each of Quake 3's snapshots shows to the port's sight after the port's frame that ran
 * the same time, the first at or after it, as the movers are held: the entities' numbers, and all
 * 32 bytes of the areamask.
 *
 * @param q3 - Quake 3's snapshots.
 * @param port - The port's sights, as {@link replay} gives them.
 */
export function compareSights(
  q3: readonly Q3Sight[],
  port: ReadonlyMap<number, Sight>
): SightComparison {
  const result: SightComparison = { compared: 0, differences: [] };
  for (const { serverTime: time, entities, areamask } of q3) {
    result.compared++;
    const ours = port.get(Math.ceil(time / PMOVE_MSEC) * PMOVE_MSEC);
    if (ours === undefined) {
      result.differences.push({ time, field: 'sight', q3: entities.length, port: null });
      continue;
    }
    const theirs = new Set(entities.map(({ number }) => number));
    const mine = new Set(ours.numbers);
    for (const number of new Set([...theirs, ...mine])) {
      if (theirs.has(number) === mine.has(number)) continue;
      const q3 = Number(theirs.has(number));
      result.differences.push({ time, field: `entity ${number}`, q3, port: 1 - q3 });
    }
    for (let i = 0; i < MAX_MAP_AREA_BYTES; i++) {
      const [q3, mask] = [areamask[i], ours.areamask[i]];
      if (q3 !== mask) result.differences.push({ time, field: `areamask[${i}]`, q3, port: mask });
    }
  }
  return result;
}
