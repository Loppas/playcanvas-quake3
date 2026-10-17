import { copyEntityState } from '../net/delta';
import {
  createEntityState,
  MAX_PS_EVENTS,
  TR,
  type EntityState,
  type PlayerState
} from '../net/protocol';
import type { GameClient } from './client';
import { qvmAngleVectors } from './cm/q-math';
import { GIB_HEALTH } from './combat';
import { nextEventField } from './events';
import type { GItem } from './items';
import { powerupMask } from './items';
import { EF_DEAD, PM_INTERMISSION, PM_SPECTATOR, STAT } from './constants';
import type { TraceResult } from './types';
import { copy, vec3, type Vec3 } from './vec3';

/**
 * `gentity_t` (`g_local.h`): one thing in the world, from the game module's side.
 *
 * An entity is in two halves and the split matters. `s` is the {@link EntityState} the server
 * sends to clients and nothing else; `r` is {@link EntityShared}, which the server reads but does
 * not transmit — where the entity is for collision, what it is linked into, and who may be told
 * about it. Everything after those two is the game module's alone and never leaves it.
 *
 * The port carries the fields the frame and the allocator touch. Quake 3's own struct is far
 * larger, because it carries the movers, the targets and the callbacks as well; those arrive with
 * the stages that need them.
 */

/** `entityType_t` (`bg_public.h`): what an entity is, and so how the frame runs it. */
export const ET = {
  GENERAL: 0,
  PLAYER: 1,
  ITEM: 2,
  MISSILE: 3,
  MOVER: 4,
  BEAM: 5,
  PORTAL: 6,
  SPEAKER: 7,
  PUSH_TRIGGER: 8,
  TELEPORT_TRIGGER: 9,
  INVISIBLE: 10,
  /** A grapple hooked on a wall. */
  GRAPPLE: 11,
  TEAM: 12,
  /**
   * Any `EV_*` event can stand on its own as `ET_EVENTS + eventNum`, which saves setting both
   * the flags and the event number.
   */
  EVENTS: 13
} as const;

/**
 * `moverState_t` (`g_local.h:56-61`): where a binary mover is, at rest at either end or on its
 * way between, which Quake 3 names `MOVER_POS1`, `MOVER_POS2`, `MOVER_1TO2` and `MOVER_2TO1`.
 */
export const MOVER = {
  POS1: 0,
  POS2: 1,
  ONE_TO_TWO: 2,
  TWO_TO_ONE: 3
} as const;

/**
 * `svFlags` (`g_public.h:28–48`): what the server cannot work out for itself.
 *
 * The server does not know how to read most of an entity state, so anything that changes who is
 * told about an entity has to be flagged here explicitly.
 */
export const SVF = {
  /** Never send this entity to a client, whatever else it does. */
  NOCLIENT: 0x00000001,
  /** {@link EntityShared.singleClient} is a bitmask of who to send to, not one client. */
  CLIENTMASK: 0x00000002,
  /** The entity is a bot, which is what keeps it out of the counts that only humans belong in. */
  BOT: 0x00000008,
  /** Send to every connected client, visible or not. */
  BROADCAST: 0x00000020,
  /** Merge a second visibility set, taken at `origin2`, into the snapshot. */
  PORTAL: 0x00000040,
  /** Link by `r.currentOrigin` rather than `s.origin` — what missiles and movers need. */
  USE_CURRENT_ORIGIN: 0x00000080,
  /** Send only to {@link EntityShared.singleClient}. */
  SINGLECLIENT: 0x00000100,
  /** Do not send server-info updates to this client. */
  NOSERVERINFO: 0x00000200,
  /** Collide as a capsule rather than a box. */
  CAPSULE: 0x00000400,
  /** Send to everyone except {@link EntityShared.singleClient}. */
  NOTSINGLECLIENT: 0x00000800
} as const;

/**
 * `entityShared_t` (`g_public.h:55–90`): the part of an entity the server reads and the game
 * writes, which is not itself transmitted.
 *
 * Quake 3's struct opens with a spare `entityState_t` that a comment admits was "put here
 * accidentally" and kept as padding for compatibility. Nothing reads it, so it is not here.
 */
export interface EntityShared {
  /** False if the entity is in no cluster, and so reaches nobody. */
  linked: boolean;
  linkcount: number;

  /** A mask of {@link SVF} flags. */
  svFlags: number;

  /** Who to send to under `SVF_SINGLECLIENT`, or a bitmask of who under `SVF_CLIENTMASK`. */
  singleClient: number;

  /** True for a brush model, whose bounds come from the map rather than from mins and maxs. */
  bmodel: boolean;
  mins: Vec3;
  maxs: Vec3;

  /** `CONTENTS_*`: what this entity is made of. Zero for something nothing can touch. */
  contents: number;

  /** The bounds in world space, worked out from the box and the origin. */
  absmin: Vec3;
  absmax: Vec3;

  /**
   * Where the entity is for collision and for linking into the world.
   *
   * It is not always where the trajectory says it should be at this instant: entities are moved
   * one at a time after the clock advances, so that two of them cannot collide simultaneously.
   */
  currentOrigin: Vec3;
  currentAngles: Vec3;

  /**
   * Who owns this entity. A trace that passes an entity number also passes anything owned by it,
   * and anything owned by that thing's owner — which is how a rocket misses the player who fired
   * it and the other rockets they fired.
   */
  ownerNum: number;
}

/** Shared state for an entity that is nowhere and touches nothing. */
export function createEntityShared(): EntityShared {
  return {
    linked: false,
    linkcount: 0,
    svFlags: 0,
    singleClient: 0,
    bmodel: false,
    mins: vec3(),
    maxs: vec3(),
    contents: 0,
    absmin: vec3(),
    absmax: vec3(),
    currentOrigin: vec3(),
    currentAngles: vec3(),
    ownerNum: 0
  };
}

/** `gentity_t`, reduced to what the frame and the allocator reach. */
export interface GameEntity {
  /** What the server sends to clients about this entity. */
  s: EntityState;
  /** What the server reads but does not send. */
  r: EntityShared;

  /**
   * The client's slot, when this entity is a client, and null when it is not.
   *
   * Quake 3's `gentity_t.client` points into `level.clients[]`, so an entity in a client's slot
   * and that client's own data are two views of one player. The player state is reached through
   * it, as `entity.client.ps`.
   */
  client: GameClient | null;

  /** Whether the slot holds an entity at all. */
  inuse: boolean;

  /** `FL_*`: god, and whether the killing hit has stopped this one being pushed about. */
  flags: number;

  /** Whether a hit does anything at all. A gibbed body is past hurting (`GibEntity`). */
  takedamage: boolean;

  /**
   * `CONTENTS_*` this entity's own traces stop at: a missile's flight and a corpse's fall. Not
   * what it is made of, which is `r.contents`.
   */
  clipmask: number;

  /**
   * `health`: what is left of this entity before whatever it does when it dies.
   *
   * A client's health is on their player state, which is where every part of the port reads it;
   * Quake 3 keeps the authority here and mirrors it there, and its own comment on the line asks
   * for the second copy to be got rid of. What is left needing this is a corpse, which has no
   * player state to keep it on — and, because a corpse's slot is never freed, keeps the health of
   * the corpse before it, as Quake 3's does.
   */
  health: number;

  /** `timestamp`: `level.time` this became what it now is. A corpse counts its sinking from it. */
  timestamp: number;

  /** `level.time` before which another hurt plays no pain sound. A spawn leaves it alone. */
  painDebounceTime: number;

  /**
   * {@link painDebounceTime} as lava and slime alone set it, on the times of Quake 3's 50 ms
   * frames, so they hurt in Quake 3's rhythm at any frame length. A spawn leaves it alone.
   */
  sizzleDebounceTime: number;

  /**
   * `waterlevel` and `watertype`: how deep in a liquid a player's last move left them, 0 to 3, and
   * the `CONTENTS_*` at their feet, as the move worked them out (`g_active.c:966–967`).
   */
  waterlevel: number;
  watertype: number;

  /** What the entity is, by name. `"freed"` for a slot waiting to be reused. */
  classname: string;

  /** `spawnflags`: the map's flags for this entity. A spawn spot's bit 0 marks it initial. */
  spawnflags: number;

  /**
   * `item` (`g_local.h`): which entry of the item table (`items.ts`) this entity is, or null for
   * anything that is not an item. The table slot is on the entity state as `s.modelindex` once it
   * is finished.
   */
  item: GItem | null;

  /** `wait`: an item's own respawn delay, from the map, or 0 for the table's. */
  wait: number;

  /** `random`: how much the map lets an item's respawn wander about its `wait`. */
  random: number;

  /** `count`: an item's quantity, when the map overrides what the table carries. */
  count: number;

  /** The ammo a dropped item carries as a pack, by weapon, or null for none. */
  pack: number[] | null;

  /** `speed`: a powerup's `noglobalsound`, or whatever else a map set `speed` to. */
  speed: number;

  /** `team`: the group this entity belongs to, or null. Item groups and mover groups use it. */
  team: string | null;

  /** `target`: the `targetname` this entity fires or faces, or null for none. */
  target: string | null;

  /** `targetname`: the name another entity's `target` finds this one by, or null for none. */
  targetname: string | null;

  /** `model`: a brush model's `*N`, or a model's path; null for none. */
  model: string | null;

  /** `model2`: a second model, which a mover draws beside its brushes; null for none. */
  model2: string | null;

  /** `message`: the text a target prints, or the location a `target_location` names. */
  message: string | null;

  /** `targetShaderName` and `targetShaderNewName`: the shader a use swaps, and what for. */
  targetShaderName: string | null;
  targetShaderNewName: string | null;

  /**
   * `movedir` (`g_local.h:182`): the direction `G_SetMovedir` made of the map's angles, which a
   * mover moves along and a trigger keeps, its angles cleared.
   */
  movedir: Vec3;

  /** `noise_index`: the slot in `CS_SOUNDS` of the sound this entity plays. */
  noiseIndex: number;

  /** `moverState`: one of {@link MOVER}, for a binary mover. */
  moverState: number;

  /** `pos1` and `pos2`: a binary mover's two ends, at rest and activated. */
  pos1: Vec3;
  pos2: Vec3;

  /**
   * `sound1to2`, `sound2to1`, `soundPos1`, `soundPos2` and `soundLoop`: the `CS_SOUNDS` slots a
   * mover plays as it leaves either end, as it reaches either end, and while it moves.
   */
  sound1to2: number;
  sound2to1: number;
  soundPos1: number;
  soundPos2: number;
  soundLoop: number;

  /**
   * {@link painDebounceTime} as a crusher's damage alone sets it, on the times of Quake 3's 50 ms
   * frames, so a crusher hurts in Quake 3's rhythm at any frame length.
   */
  crushDebounceTime: number;

  /**
   * `fly_sound_debounce_time`: the `level.time` before which a `target_push` does not play its
   * sound for this player again.
   */
  flySoundDebounceTime: number;

  /**
   * `teammaster` and `teamchain` (`g_local.h`): the chain `G_FindTeams` builds out of the entities
   * sharing a `team`, and the head of it. Null for anything not in a team.
   */
  teammaster: GameEntity | null;
  teamchain: GameEntity | null;

  /** Freeing this entity only unlinks it. The body queue relies on it. */
  neverFree: boolean;

  /** `level.time` the slot was freed at, which decides how soon it may be taken again. */
  freetime: number;

  /**
   * Who is answerable for what this entity does: a missile's is whoever fired it.
   *
   * Not the same as `r.ownerNum`, which is the number a trace passes through. They are the same
   * entity for a missile, and Quake 3 keeps both because one is the server's and one is the
   * game's.
   */
  parent: GameEntity | null;

  /**
   * `enemy`: whoever this entity is set against. The last to hurt it, once it has died of it; for a
   * hook that caught a player, the player it is following; and for a taken megahealth, its taker.
   */
  enemy: GameEntity | null;

  /**
   * `activator`: who set this entity off, kept for what it fires later — a trigger after its
   * wait, a delay, a timer, a laser's hits.
   */
  activator: GameEntity | null;

  /**
   * `nextTrain`: the next in a chain the entity is part of: the corner a train runs to next, the
   * corner after a corner, or the next of the locations.
   */
  nextTrain: GameEntity | null;

  /** What a direct hit from this costs. */
  damage: number;

  /** What its blast costs at the centre, and how far that reaches. */
  splashDamage: number;
  splashRadius: number;

  /** `methodOfDeath` and `splashMethodOfDeath`: the `MOD_*` its hit and its blast carry. */
  methodOfDeath: number;
  splashMethodOfDeath: number;

  /** `level.time` the current event was set at; the frame clears it 300 ms later. */
  eventTime: number;

  /** Free the entity once its event has been seen. */
  freeAfterEvent: boolean;

  /** Unlink the entity once its event has been seen, but keep it. */
  unlinkAfterEvent: boolean;

  /** Movers can push it and it falls off edges. Every item is one. */
  physicsObject: boolean;

  /**
   * `physicsBounce`: how much of its speed a bounce off the floor keeps. An item keeps half
   * (`G_SpawnItem`), a corpse none (`CopyToBodyQue`), and a missile has its own.
   */
  physicsBounce: number;

  /** `level.time` to call {@link think} at, or 0 for never. */
  nextthink: number;

  /** What to do at {@link nextthink}. */
  think: ((self: GameEntity) => void) | null;

  /** `reached` (`g_local.h:133`): what a mover does when `G_MoverTeam` finds its move over. */
  reached: ((self: GameEntity) => void) | null;

  /**
   * `blocked` (`g_local.h:134`): what a mover team's master does when something stops its move,
   * `other` being what did.
   */
  blocked: ((self: GameEntity, other: GameEntity) => void) | null;

  /**
   * `use` (`g_local.h:136`): what this entity does when another fires it by its `targetname`.
   *
   * `other` is the entity whose target it was, and `activator` whoever set that off, or null for no
   * one, as a train's corner fires its targets. Null for an entity nothing can fire.
   */
  use: ((self: GameEntity, other: GameEntity, activator: GameEntity | null) => void) | null;

  /**
   * `touch` (`g_local.h:135`): what this entity does when something walks into it, which is how
   * an item is picked up and how a trigger fires.
   *
   * `other` is what walked in, and the trace is the zeroed one `G_TouchTriggers` hands over: what
   * a touch carried back is the caller's to read, and a pickup ignores it. Null for an entity
   * nothing can walk into.
   */
  touch: ((self: GameEntity, other: GameEntity, trace: TraceResult) => void) | null;

  /**
   * `die` (`g_local.h:138`): what this entity does when `G_Damage` takes its health to nothing.
   *
   * `inflictor` is what did it and `attacker` who answers for it: a rocket and its owner, or the
   * world's entity for a fall. `damage` is the last hit's, after the armor. A player's is
   * `player_die`, which gives it `body_die` for the corpse it leaves; a corpse in the queue has
   * `body_die` too.
   */
  die:
    | ((
        self: GameEntity,
        inflictor: GameEntity,
        attacker: GameEntity,
        damage: number,
        mod: number
      ) => void)
    | null;
}

/** An entity in a free slot: every field zeroed, as `Com_Memset` leaves one. */
export function createGameEntity(): GameEntity {
  return {
    s: createEntityState(),
    r: createEntityShared(),
    client: null,
    inuse: false,
    flags: 0,
    takedamage: false,
    clipmask: 0,
    health: 0,
    timestamp: 0,
    painDebounceTime: 0,
    sizzleDebounceTime: 0,
    waterlevel: 0,
    watertype: 0,
    classname: '',
    spawnflags: 0,
    item: null,
    wait: 0,
    random: 0,
    count: 0,
    pack: null,
    speed: 0,
    team: null,
    target: null,
    targetname: null,
    model: null,
    model2: null,
    message: null,
    targetShaderName: null,
    targetShaderNewName: null,
    movedir: vec3(),
    noiseIndex: 0,
    moverState: MOVER.POS1,
    pos1: vec3(),
    pos2: vec3(),
    sound1to2: 0,
    sound2to1: 0,
    soundPos1: 0,
    soundPos2: 0,
    soundLoop: 0,
    crushDebounceTime: 0,
    flySoundDebounceTime: 0,
    teammaster: null,
    teamchain: null,
    neverFree: false,
    freetime: 0,
    parent: null,
    enemy: null,
    activator: null,
    nextTrain: null,
    damage: 0,
    splashDamage: 0,
    splashRadius: 0,
    methodOfDeath: 0,
    splashMethodOfDeath: 0,
    eventTime: 0,
    freeAfterEvent: false,
    unlinkAfterEvent: false,
    physicsObject: false,
    physicsBounce: 0,
    nextthink: 0,
    think: null,
    reached: null,
    blocked: null,
    use: null,
    touch: null,
    die: null
  };
}

/** Read-only templates to zero an entity from, so freeing one allocates nothing. */
const ZERO_STATE = createEntityState();
const ZERO_SHARED = createEntityShared();

/**
 * `Com_Memset(ed, 0, sizeof(*ed))` on an entity already in the pool: the slot keeps its identity
 * and its object, and everything in it goes.
 *
 * @param entity - The entity to clear, in place.
 */
export function resetGameEntity(entity: GameEntity): void {
  copyEntityState(ZERO_STATE, entity.s);
  copyEntityShared(ZERO_SHARED, entity.r);
  entity.client = null;
  entity.inuse = false;
  entity.flags = 0;
  entity.takedamage = false;
  entity.clipmask = 0;
  entity.health = 0;
  entity.timestamp = 0;
  entity.painDebounceTime = 0;
  entity.sizzleDebounceTime = 0;
  entity.waterlevel = 0;
  entity.watertype = 0;
  entity.classname = '';
  entity.spawnflags = 0;
  entity.item = null;
  entity.wait = 0;
  entity.random = 0;
  entity.count = 0;
  entity.pack = null;
  entity.speed = 0;
  entity.team = null;
  entity.target = null;
  entity.targetname = null;
  entity.model = null;
  entity.model2 = null;
  entity.message = null;
  entity.targetShaderName = null;
  entity.targetShaderNewName = null;
  copyVec(ZERO_STATE.origin, entity.movedir);
  entity.noiseIndex = 0;
  entity.moverState = MOVER.POS1;
  copyVec(ZERO_STATE.origin, entity.pos1);
  copyVec(ZERO_STATE.origin, entity.pos2);
  entity.sound1to2 = 0;
  entity.sound2to1 = 0;
  entity.soundPos1 = 0;
  entity.soundPos2 = 0;
  entity.soundLoop = 0;
  entity.crushDebounceTime = 0;
  entity.flySoundDebounceTime = 0;
  entity.teammaster = null;
  entity.teamchain = null;
  entity.neverFree = false;
  entity.freetime = 0;
  entity.parent = null;
  entity.enemy = null;
  entity.activator = null;
  entity.nextTrain = null;
  entity.damage = 0;
  entity.splashDamage = 0;
  entity.splashRadius = 0;
  entity.methodOfDeath = 0;
  entity.splashMethodOfDeath = 0;
  entity.eventTime = 0;
  entity.freeAfterEvent = false;
  entity.unlinkAfterEvent = false;
  entity.physicsObject = false;
  entity.physicsBounce = 0;
  entity.nextthink = 0;
  entity.think = null;
  entity.reached = null;
  entity.blocked = null;
  entity.use = null;
  entity.touch = null;
  entity.die = null;
}

/** `*to = *from` for the shared half. */
export function copyEntityShared(from: EntityShared, to: EntityShared): EntityShared {
  to.linked = from.linked;
  to.linkcount = from.linkcount;
  to.svFlags = from.svFlags;
  to.singleClient = from.singleClient;
  to.bmodel = from.bmodel;
  copyVec(from.mins, to.mins);
  copyVec(from.maxs, to.maxs);
  to.contents = from.contents;
  copyVec(from.absmin, to.absmin);
  copyVec(from.absmax, to.absmax);
  copyVec(from.currentOrigin, to.currentOrigin);
  copyVec(from.currentAngles, to.currentAngles);
  to.ownerNum = from.ownerNum;
  return to;
}

/** `VectorCopy`: into a vector that is kept, rather than replaced. */
export function copyVec(from: Vec3, to: Vec3): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}

/**
 * `BG_PlayerStateToEntityState` (`bg_misc.c:1573–1638`): build what other clients are told about
 * a player out of the player state only they own.
 *
 * A player is two things on the wire — the player state their own client reads, and an entity
 * state everyone else's does — and this is the one place the second is derived from the first.
 * Nothing else may write a client's entity state, or the two would drift.
 *
 * The event handling is the interesting part. A player state carries a ring of events with a
 * sequence that only ever rises; an entity state carries one event at a time. So this drains one
 * event per call and remembers how far it got, and the low two bits of the sequence ride along in
 * the event's high bits so that the same event twice running is still seen twice.
 *
 * @param ps - The player state to read. Its `entityEventSequence` advances.
 * @param s - The entity state to write, in place.
 * @param snap - Round the origin and angles to whole units, as a spawn does.
 */
export function playerStateToEntityState(ps: PlayerState, s: EntityState, snap: boolean): void {
  if (ps.pmType === PM_INTERMISSION || ps.pmType === PM_SPECTATOR) {
    s.eType = ET.INVISIBLE;
  } else if (ps.stats[STAT.HEALTH] <= GIB_HEALTH) {
    s.eType = ET.INVISIBLE;
  } else {
    s.eType = ET.PLAYER;
  }

  s.number = ps.clientNum;

  s.pos.trType = TR.INTERPOLATE;
  copyVec(ps.origin, s.pos.trBase);
  if (snap) snapVec(s.pos.trBase);
  // The velocity rides along so a carried flag knows which way to stream.
  copyVec(ps.velocity, s.pos.trDelta);

  s.apos.trType = TR.INTERPOLATE;
  copyVec(ps.viewangles, s.apos.trBase);
  if (snap) snapVec(s.apos.trBase);

  s.angles2.y = ps.movementDir;
  s.legsAnim = ps.legsAnim;
  s.torsoAnim = ps.torsoAnim;
  // A player is looked up by `clientNum` rather than by `number`, so that a corpse left behind in
  // another slot can still point at the player it came from.
  s.clientNum = ps.clientNum;

  s.eFlags = ps.eFlags;
  if (ps.stats[STAT.HEALTH] <= 0) s.eFlags |= EF_DEAD;
  else s.eFlags &= ~EF_DEAD;

  if (ps.externalEvent) {
    s.event = ps.externalEvent;
    s.eventParm = ps.externalEventParm;
  } else if (ps.entityEventSequence < ps.eventSequence) {
    // Further behind than the ring is deep, so the events in between are gone and the best that
    // can be done is to start from the oldest one still there.
    if (ps.entityEventSequence < ps.eventSequence - MAX_PS_EVENTS) {
      ps.entityEventSequence = ps.eventSequence - MAX_PS_EVENTS;
    }
    const seq = ps.entityEventSequence & (MAX_PS_EVENTS - 1);
    s.event = ps.events[seq] | ((ps.entityEventSequence & 3) << 8);
    s.eventParm = ps.eventParms[seq];
    ps.entityEventSequence++;
  }

  s.weapon = ps.weapon;
  s.groundEntityNum = ps.groundEntityNum;

  s.powerups = powerupMask(ps.powerups);

  s.loopSound = ps.loopSound;
  s.generic1 = ps.generic1;
}

/** `SnapVector`: each component cast to an int, which truncates towards zero. */
function snapVec(v: Vec3): void {
  v.x = Math.trunc(v.x);
  v.y = Math.trunc(v.y);
  v.z = Math.trunc(v.z);
}

/**
 * `G_SetOrigin` (`g_utils.c:721–731`): put an entity somewhere and stop it moving.
 *
 * It writes both halves — the trajectory the wire carries and the origin collision reads — which
 * is the point of it: setting one and not the other is how an entity ends up in two places.
 *
 * @param entity - The entity to place.
 * @param origin - Where to put it.
 */
export function setEntityOrigin(entity: GameEntity, origin: Vec3): void {
  entity.s.pos.trType = TR.STATIONARY;
  entity.s.pos.trTime = 0;
  entity.s.pos.trDuration = 0;
  entity.s.pos.trBase = copy(origin);
  entity.s.pos.trDelta = vec3();
  entity.r.currentOrigin = copy(origin);
  entity.s.origin = copy(origin);
}

/** `AngleVectors`' forward, which {@link setMovedir} takes. */
const movedirScratch = [0, 0, 0];

/**
 * `G_SetMovedir` (`g_utils.c:328-342`): the direction a map's angles name. "The editor only
 * specifies a single value for angles (yaw)", so a yaw of −1 is straight up and −2 straight down,
 * and any other angles are their forward, in the game module's floats. The angles are cleared,
 * "because it is being used to represent a direction instead of an orientation".
 *
 * @param angles - Pitch, yaw and roll, in degrees; cleared in place.
 * @param movedir - The direction, written in place.
 */
export function setMovedir(angles: Vec3, movedir: Vec3): void {
  if (angles.x === 0 && angles.y === -1 && angles.z === 0) {
    movedir.x = 0;
    movedir.y = 0;
    movedir.z = 1;
  } else if (angles.x === 0 && angles.y === -2 && angles.z === 0) {
    movedir.x = 0;
    movedir.y = 0;
    movedir.z = -1;
  } else {
    qvmAngleVectors([angles.x, angles.y, angles.z], movedirScratch, null, null);
    movedir.x = movedirScratch[0];
    movedir.y = movedirScratch[1];
    movedir.z = movedirScratch[2];
  }
  angles.x = 0;
  angles.y = 0;
  angles.z = 0;
}

/**
 * `G_AddEvent` (`g_utils.c:571–600`): raise an event on an entity, wherever that entity keeps
 * its events.
 *
 * A client's events go on the player state rather than the entity state, because a client is
 * sent its own player state at full rate and only ever sees its entity state through everybody
 * else's eyes. `BG_PlayerStateToEntityState` copies the external event across so that the rest
 * of the server's clients see it too, which is why nothing writes `s.event` on a client here.
 *
 * The counter in the top two bits moves on with every call, so the same event twice running
 * still reads as two.
 *
 * @param entity - The entity the event happened to.
 * @param event - One of {@link EV}. Zero is not an event and is ignored, as Quake 3 ignores it.
 * @param parm - The event's argument, or zero for the ones that take none.
 * @param time - `level.time`, which is when the frame stops carrying the event 300 ms later.
 */
export function addEvent(entity: GameEntity, event: number, parm: number, time: number): void {
  if (!event) return;

  if (entity.client) {
    entity.client.ps.externalEvent = nextEventField(entity.client.ps.externalEvent, event);
    entity.client.ps.externalEventParm = parm;
    entity.client.ps.externalEventTime = time;
  } else {
    entity.s.event = nextEventField(entity.s.event, event);
    entity.s.eventParm = parm;
  }

  entity.eventTime = time;
}
