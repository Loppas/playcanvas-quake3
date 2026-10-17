import {
  ENTITYNUM_MAX_NORMAL,
  ENTITYNUM_NONE,
  MAX_CLIENTS,
  MAX_GENTITIES
} from '../net/protocol';
import { initBodyQue } from './body-queue';
import { createGameClient, type GameClient } from './client';
import { entityContact, setBrushModel } from './clip-trace';
import type { ClipMap } from './cm/cm-local';
import { TEAM } from './constants';
import { ET, createGameEntity, resetGameEntity, type GameEntity } from './game-entity';
import { NUM_ITEMS } from './items';
import { DEFAULT_ITEM_MATCH, type ItemMatch } from './item-touch';
import { ID_RULES, type Rules } from './rules';
import { ServerWorld } from './server-world';
import type { ShaderRemap } from './shader-remap';
import { createTeamGame, type TeamGame } from './team';
import { NO_CONTENTS, type PointContentsFn, type TraceFn, type TraceResult } from './types';
import { vec3, type Vec3 } from './vec3';

/**
 * The match: Quake 3's `level_locals_t` (`g_local.h:329–410`) and the frame that runs it
 * (`G_RunFrame`, `g_main.c:1785–1897`).
 *
 * **The level does not know its own tick rate.** {@link Level.runFrame} is handed the time it is
 * to advance to, exactly as Quake 3 hands `G_RunFrame` a `levelTime` that the server worked out
 * from `sv_fps`. The port's `sv_fps` is 125 by default rather than 20, so `level.time` steps by 8
 * rather than 50 — but that is the host's decision and nothing here depends on it. Anything
 * measured in milliseconds means the same at either rate; anything counting {@link Level.framenum}
 * does not, and there is nothing in this module that does.
 *
 * **The entity pool is part of the level.** Quake 3 keeps `g_entities[]` as a global that
 * `level.gentities` points at; the port keeps the one array. Slots below {@link MAX_CLIENTS} are
 * reserved for clients and {@link Level.spawnEntity} never returns one.
 *
 * The frame's own work is small: expire the events that have been seen, run each entity by its
 * kind, end each client's frame, and check the rules. What runs an entity of a given kind is not
 * here — a missile, an item and a mover each belong to their own part of the game — so the frame
 * takes them as {@link LevelHandlers} and does nothing where one is absent.
 */

/**
 * `EVENT_VALID_MSEC` (`bg_public.h:350`): how long an event stays on an entity before the frame
 * clears it.
 *
 * It is a duration rather than a count of frames, so the port's faster tick leaves it meaning the
 * same thing — 300 ms of wall clock either way, and a client that missed a snapshot still has
 * several more chances to see the event.
 */
export const EVENT_VALID_MSEC = 300;

/** Quake 3's own frame, at its `sv_fps` of 20, which {@link Level.q3FrameTime} counts. */
export const Q3_FRAME_MSEC = 50;

/**
 * `INTERMISSION_DELAY_TIME` (`g_local.h:42`): the wait between qualifying for the intermission
 * and going there, so the last frag can be watched.
 */
export const INTERMISSION_DELAY_TIME = 1000;

/**
 * How long after the level starts the allocator stops being lenient, and how recently a slot must
 * have been freed for it to be passed over (`G_Spawn`, `g_utils.c`).
 *
 * A freed slot is normally left alone for a second, so that a client still holding the old
 * entity's number does not see it come back as something else. The first two seconds of a level
 * are exempt, because a map's own spawning frees and allocates a great deal.
 */
const SPAWN_SETTLE_MSEC = 2000;
const SPAWN_REUSE_MSEC = 1000;

/** The trace of a level given no collision, which has no answer to give. */
function noTrace(): never {
  throw new Error('level: no trace handler');
}

/**
 * What the frame needs from the rest of the game module, and the server's calls it makes.
 *
 * Each is one of the calls `G_RunFrame` makes by name, or a trap. They are optional because the
 * parts they belong to arrive separately, and a frame with none of them still keeps the clock and
 * expires the events. A level answers for itself the server's calls it is given none for, as the
 * server would: it links into a {@link ServerWorld} of its own, and makes brush models from its
 * clip map. A level that links for itself is handed the map's own {@link trace} and
 * {@link pointContents}, and meets its entities after them, as the server does; one the host links
 * for is handed the host's.
 */
export interface LevelHandlers {
  /** `G_UpdateCvars`: take up any cvar that changed, and announce the ones that are announced. */
  updateCvars?: (level: Level) => void;
  /** `G_RunMissile`. */
  runMissile?: (entity: GameEntity) => void;
  /** `G_RunItem`, which also runs anything else that falls and can be pushed. */
  runItem?: (entity: GameEntity) => void;
  /** `G_RunMover`. */
  runMover?: (entity: GameEntity) => void;
  /** `G_RunClient`, for an entity in a client's slot. */
  runClient?: (entity: GameEntity) => void;
  /** `ClientEndFrame`, once per client in a slot, after every entity has run. */
  endClientFrame?: (entity: GameEntity, clientNum: number) => void;
  /** The checks that close a frame: the tournament, the exit rules, the teams and the votes. */
  checkRules?: (level: Level) => void;
  /** `trap_LinkEntity`: put an entity into the server's world links, so clients hear of it. */
  linkEntity?: (entity: GameEntity) => void;
  /** `trap_UnlinkEntity`: take an entity out of the server's world links. */
  unlinkEntity?: (entity: GameEntity) => void;
  /** `trap_EntitiesInBox`: the number of every linked entity whose box touches this one. */
  entitiesInBox?: (mins: Vec3, maxs: Vec3) => number[];
  /**
   * `trap_SetConfigstring`: a string every client is kept up to date with. The flags' status is
   * written by an item callback, which is handed the level and nothing else.
   */
  setConfigstring?: (index: number, value: string) => void;
  /**
   * `trap_SendServerCommand`: a line to one client, or to everyone when the number is null —
   * which is what `PrintMsg`'s `NULL` entity means.
   */
  sendServerCommand?: (clientNum: number | null, text: string) => void;
  /**
   * `trap_Trace`: the world's collision, which a think that has to find the floor asks through
   * {@link Level.trace}; the map's alone on a level that links for itself. A level without one
   * throws at the ask, since a world with no collision is not an empty world but a missing one.
   */
  trace?: TraceFn;
  /**
   * `trap_PointContents`: what the world holds at a point, which a death, a body and an item's
   * landing ask of `CONTENTS_NODROP`; the map's alone on a level that links for itself. A level
   * without one has a map that holds nothing anywhere.
   */
  pointContents?: PointContentsFn;
  /** `trap_SetBrushModel`: make an entity one of the map's inline models, and link it. */
  setBrushModel?: (entity: GameEntity, name: string | null) => void;
  /** `trap_EntityContact`: whether a box in the world is in an entity at all. */
  entityContact?: (mins: Vec3, maxs: Vec3, entity: GameEntity) => boolean;
  /** `trap_AdjustAreaPortalState`: open or close the areaportal a door stands in. */
  adjustAreaPortalState?: (entity: GameEntity, open: boolean) => void;
  /** `trap_InPVS`: whether one point can see another, past the doors that are shut. */
  inPVS?: (p1: Vec3, p2: Vec3) => boolean;
}

/** What a level starts with. */
export interface LevelOptions {
  /** `level.time` the map started at. */
  startTime?: number;
  /** `sv_maxclients`, latched. Slots above it exist but are never filled. */
  maxclients?: number;
  /** The calls the frame makes into the rest of the game module. */
  handlers?: LevelHandlers;
  /** The rules of play. id's without them. */
  rules?: Readonly<Rules>;
  /**
   * The map's collision, which a level without the two brush handlers answers brush models and
   * contacts from, as the server would. Without it no `*N` is a model.
   */
  clipMap?: ClipMap;
}

export class Level {
  // --- the clock -------------------------------------------------------------------------

  /**
   * How many frames have run. Under the port's 8 ms tick this counts ticks rather than Quake 3's
   * 50 ms frames, so it is not comparable with Quake 3's own and nothing should time by it.
   */
  framenum = 0;

  /** The match's time in milliseconds, which is what everything in the game module is timed by. */
  time = 0;

  /** The previous frame's {@link time}, so a mover blocked this frame can back up to it. */
  previousTime = 0;

  /**
   * Unlagged's `frameStartTime`: the real time the last frame ended, by `trap_Milliseconds`, which
   * a command between frames is timed from.
   */
  frameStartTime = 0;

  /** The {@link time} the map started at. */
  startTime = 0;

  // --- latched cvars ---------------------------------------------------------------------

  /** `sv_maxclients` as it was when the level started. */
  maxclients: number;

  // --- entities --------------------------------------------------------------------------

  /**
   * Every slot the world has, clients first. Quake 3's `g_entities[]`, which `level.gentities`
   * points at.
   */
  readonly gentities: GameEntity[];

  /**
   * One {@link GameClient} per client slot, which is Quake 3's `level.clients`.
   *
   * Quake 3 allocates {@link maxclients} of them and the port allocates the full
   * {@link MAX_CLIENTS}, as it does with the entities: a slot that can never be filled costs an
   * object and answers the question "is this slot connected" the same way an absent one would.
   */
  readonly clients: GameClient[];

  /**
   * How far into {@link gentities} the world reaches: `MAX_CLIENTS` at the start, and no more
   * than {@link ENTITYNUM_MAX_NORMAL}. The server reads it to know how many entities to consider.
   */
  numEntities = MAX_CLIENTS;

  // --- warmup ----------------------------------------------------------------------------

  /** The {@link time} the match restarts at, which is what a warmup counts down to. */
  warmupTime = 0;

  /** A copy of `g_warmup`'s modification count, for noticing that it changed mid-countdown. */
  warmupModificationCount = 0;

  // --- rounds ----------------------------------------------------------------------------

  /**
   * A round-based mode's state, in the warmup's own shape: −1 between rounds, the {@link time} a
   * round's countdown ends at, or 0 while a round is played.
   */
  roundTime = -1;

  /** When a round's result is read, once a side has been found with nobody left; 0 for none. */
  roundWinTime = 0;

  /**
   * The rounds begun this match, which only Clan Arena counts. From the first, its dead watch
   * rather than respawn.
   */
  roundCount = 0;

  // --- counts and ranks ------------------------------------------------------------------

  numConnectedClients = 0;
  /** Includes clients still connecting. */
  numNonSpectatorClients = 0;
  /** Connected and not spectating. */
  numPlayingClients = 0;
  /** Set by `CalculateRanks`. */
  numVotingClients = 0;

  /** Voters per team, red then blue, for the team votes that need a majority of one side. */
  readonly numteamVotingClients: number[] = [0, 0];

  /** Client numbers in score order. Only the first {@link numConnectedClients} mean anything. */
  readonly sortedClients: number[];

  /** Who a spectator follows by default. `CalculateRanks` sets both, to −1 when there is nobody. */
  follow1 = 0;
  follow2 = 0;

  // --- teams -----------------------------------------------------------------------------

  /** One score per {@link TEAM}. */
  readonly teamScores: number[];

  /** The last time the team overlay's locations were refreshed. */
  lastTeamLocationTime = 0;

  /**
   * Whether the map's `target_location`s have been numbered into `CS_LOCATIONS`, which the first
   * of them to think does for them all.
   */
  locationLinked = false;

  /** The last of the locations, which chain back to the first through `nextTrain`. */
  locationHead: GameEntity | null = null;

  /** `remappedShaders`: the shaders the level's entities have swapped, in the order first made. */
  readonly shaderRemaps: ShaderRemap[] = [];

  // --- restarts --------------------------------------------------------------------------

  /** Throw away any session data, because the gametype changed under it. */
  newSession = false;

  /**
   * A `map_restart` has been asked for and has not fired yet. The frame does nothing at all while
   * it is set, which is what stops half a frame running against a level about to be replaced.
   */
  restarted = false;

  // --- intermission ----------------------------------------------------------------------

  /**
   * The {@link time} the intermission qualified at, which is not when it starts: the match waits
   * {@link INTERMISSION_DELAY_TIME} so the last frag can be watched, and kills in that window do
   * not count.
   */
  intermissionQueued = 0;

  /** The {@link time} the intermission actually started at, or 0 if it has not. */
  intermissiontime = 0;

  /** The map to load on leaving, or null for `nextmap`'s own answer. */
  changemap: string | null = null;

  /** At least one client has asked to move on. */
  readyToExit = false;

  /** The {@link time} the intermission may be left at. */
  exitTime = 0;

  /** Where the intermission camera sits, which is also where a spectator spawns. */
  intermissionOrigin: Vec3 = vec3();
  intermissionAngle: Vec3 = vec3();

  /**
   * `bodyQue` (`g_local.h:389`): the eight slots the corpses on this map live in.
   *
   * A corpse is a thing in the world that anyone's blast can reach rather than a possession of the
   * client who left it, and the queue is shared by every client on the map — which is why it is
   * here. The slots are taken once, at the start, and never given back.
   */
  readonly bodyQue: GameEntity[];

  /** `bodyQueIndex` (`g_local.h:390`): which of them the next corpse takes. */
  bodyQueIndex = 0;

  // --- items -----------------------------------------------------------------------------

  /**
   * `itemRegistered[MAX_ITEMS]` (`g_items.c:717`): which items this map has put in the world, and
   * so which the clients are told to precache through `CS_ITEMS`.
   *
   * Quake 3 keeps it as a static of the game module, cleared and filled again on every map start.
   * The port keeps it on the level, so that a level built without a game module — a test's, or a
   * bot's own — has its own registry and one map's items cannot leak into another's.
   */
  readonly itemsRegistered: boolean[] = new Array<boolean>(NUM_ITEMS).fill(false);

  /**
   * What an item's callbacks read from the match around them: the gametype, the weapon respawn
   * cvars, `G_Printf` and the seeded random (`item-touch.ts`).
   *
   * Quake 3 keeps all four as game-module globals and an item reads them long after it was
   * spawned — on the pickup, and again on every respawn — so they cannot be captured from a map's
   * spawning when there is no match yet. They hang off the level for that reason, and a game
   * module sets the live ones at {@link Game.init}; a level without one gets Q3's own defaults.
   */
  itemMatch: ItemMatch = DEFAULT_ITEM_MATCH;

  /** When the powerups first appear, in seconds, once drawn for them all; null until then. */
  firstPowerupDelay: number | null = null;

  /**
   * `snd_fry` (`g_local.h:363`): the slot of the loop a player standing in lava or slime makes,
   * which `G_InitGame` registers before anything else. 0, no sound, until a game module does.
   */
  sndFry = 0;

  /**
   * The rules of play, which a hit reads as it lands. A game module hands the level its own record,
   * which it keeps in step with the cvars.
   */
  readonly rules: Readonly<Rules>;

  /**
   * Where the two flags are: Quake 3's `teamgame` (`g_team.c:39`), which is a game-module global
   * beside `level` rather than part of it.
   *
   * It is here because this is its lifetime — a map start clears it — and because what writes it
   * is a flag's own touch, which is an item callback and is handed the level and nothing else.
   */
  teamgame: TeamGame = createTeamGame();

  private readonly handlers: LevelHandlers;
  private readonly clipMap: ClipMap | undefined;

  /**
   * The server's world, which a level with no `linkEntity` handler links into, cleared over its
   * clip map as a map load clears the server's. The handlers' trace and contents are its map.
   */
  private readonly world: ServerWorld;

  /** @param options - The start time, the latched client count, and the frame's handlers. */
  constructor(options: LevelOptions = {}) {
    this.startTime = options.startTime ?? 0;
    this.time = this.startTime;
    this.previousTime = this.startTime;
    this.maxclients = options.maxclients ?? MAX_CLIENTS;
    this.handlers = options.handlers ?? {};
    this.rules = options.rules ?? ID_RULES;
    this.clipMap = options.clipMap;

    this.gentities = Array.from({ length: MAX_GENTITIES }, createGameEntity);
    for (let i = 0; i < MAX_GENTITIES; i++) this.gentities[i].s.number = i;
    this.world = new ServerWorld((number) => this.gentities[number], {
      clipMap: this.clipMap,
      trace: this.handlers.trace ?? noTrace,
      pointContents: this.handlers.pointContents ?? NO_CONTENTS
    });

    this.clients = Array.from({ length: MAX_CLIENTS }, createGameClient);
    this.sortedClients = new Array<number>(MAX_CLIENTS).fill(0);
    this.teamScores = new Array<number>(TEAM.NUM_TEAMS).fill(0);

    // `G_InitGame` calls `InitBodyQue` the moment the level exists, and this is that moment: the
    // eight slots are the first entities any map has, before whatever the map itself places.
    this.bodyQue = initBodyQue(this);
  }

  /**
   * `G_RunFrame` (`g_main.c:1785–1897`): advance the match to a new time and run everything in it.
   *
   * The order is the whole of it. The clock moves first, so that everything below sees the new
   * time; then every entity in turn, each by its kind; then each client's end-of-frame, which
   * needs every entity to have moved already; then the rules, which need the scores the frame
   * produced.
   *
   * @param levelTime - The time to advance to, in milliseconds. The caller owns the cadence.
   */
  runFrame(levelTime: number): void {
    // A restart is pending, so this level is about to be replaced and running it would be work
    // thrown away — or worse, a half-frame against state the restart is going to clear.
    if (this.restarted) return;

    this.framenum++;
    this.previousTime = this.time;
    this.time = levelTime;

    this.handlers.updateCvars?.(this);

    for (let i = 0; i < this.numEntities; i++) {
      const entity = this.gentities[i];
      if (!entity.inuse) continue;

      // An event has been on the entity long enough for every client to have seen it.
      if (this.time - entity.eventTime > EVENT_VALID_MSEC) {
        if (entity.s.event) {
          entity.s.event = 0;
          if (entity.client) entity.client.ps.externalEvent = 0;
        }
        if (entity.freeAfterEvent) {
          this.freeEntity(entity);
          continue;
        }
        if (entity.unlinkAfterEvent) {
          entity.unlinkAfterEvent = false;
          this.unlinkEntity(entity);
        }
      }

      // Still carrying an event nobody has had time to see, so it does nothing else this frame.
      if (entity.freeAfterEvent) continue;
      if (!entity.r.linked && entity.neverFree) continue;

      if (entity.s.eType === ET.MISSILE) {
        this.handlers.runMissile?.(entity);
        continue;
      }
      if (entity.s.eType === ET.ITEM || entity.physicsObject) {
        this.handlers.runItem?.(entity);
        continue;
      }
      if (entity.s.eType === ET.MOVER) {
        this.handlers.runMover?.(entity);
        continue;
      }
      if (i < MAX_CLIENTS) {
        this.handlers.runClient?.(entity);
        continue;
      }
      this.runThink(entity);
    }

    for (let i = 0; i < this.maxclients; i++) {
      const entity = this.gentities[i];
      if (entity.inuse) this.handlers.endClientFrame?.(entity, i);
    }

    this.handlers.checkRules?.(this);
  }

  /**
   * The time of the Quake 3 frame this one falls in, counting {@link Q3_FRAME_MSEC} from the
   * level's start.
   *
   * What Quake 3 re-arms at `level.time` plus a delay is late by up to a frame at any tick, so a
   * finer tick than Quake 3's runs it less often: lava, a hurt and a laser would. Each of those is
   * timed by this instead, which keeps Quake 3's rhythm at any `sv_fps`.
   */
  q3FrameTime(): number {
    return this.time - ((this.time - this.startTime) % Q3_FRAME_MSEC);
  }

  /**
   * `G_RunThink` (`g_main.c:1770–1783`): call an entity's think if its time has come.
   *
   * The think time is cleared before the call, so a think that wants to run again must say so
   * itself. A think time of zero means never, which is why an entity that has just thought stops.
   *
   * @param entity - The entity to run.
   */
  runThink(entity: GameEntity): void {
    const thinktime = entity.nextthink;
    if (thinktime <= 0) return;
    if (thinktime > this.time) return;

    entity.nextthink = 0;
    if (!entity.think) throw new Error(`level: entity ${entity.s.number} has no think`);
    entity.think(entity);
  }

  /**
   * `G_Spawn` (`g_utils.c`): take a free slot above the clients' reserved ones.
   *
   * A slot freed within the last second is passed over, so that a client still holding the old
   * entity's number does not see it come back as something else — unless nothing else is
   * available, in which case the second pass takes it anyway. The level's first two seconds are
   * exempt, because a map's own spawning frees and allocates a great deal.
   *
   * @returns The entity, initialised and in use.
   */
  spawnEntity(): GameEntity {
    for (let force = 0; force < 2; force++) {
      for (let i = MAX_CLIENTS; i < this.numEntities; i++) {
        const entity = this.gentities[i];
        if (entity.inuse) continue;
        if (
          !force &&
          entity.freetime > this.startTime + SPAWN_SETTLE_MSEC &&
          this.time - entity.freetime < SPAWN_REUSE_MSEC
        ) {
          continue;
        }
        return this.initEntity(entity, i);
      }
      // Only bother with the second, unfussy pass when there is no room to grow into.
      if (this.numEntities < ENTITYNUM_MAX_NORMAL) break;
    }

    if (this.numEntities === ENTITYNUM_MAX_NORMAL) {
      throw new Error('level: no free entities');
    }

    // Open a new slot. The server reads `numEntities` directly, where Quake 3 has to tell it
    // through `trap_LocateGameData`.
    const number = this.numEntities;
    const entity = this.gentities[number];
    this.numEntities++;
    return this.initEntity(entity, number);
  }

  /**
   * `G_FreeEntity` (`g_utils.c`): unlink an entity and give its slot back.
   *
   * An entity marked {@link GameEntity.neverFree} is only unlinked — the body queue owns its
   * corpses for the whole map and must not have them taken.
   *
   * @param entity - The entity to free.
   */
  freeEntity(entity: GameEntity): void {
    this.unlinkEntity(entity);
    if (entity.neverFree) return;

    // Quake 3's memset takes `s.number` with everything else and `G_InitGentity` puts it back on
    // the next allocation. The port keeps it, because it is the slot's identity rather than the
    // entity's, and a slot that forgets which one it is has nothing to gain by it. That is not a
    // reason to leave it out of {@link Level.initEntity}, which is the one place a number written
    // over by `BG_PlayerStateToEntityState` is ever put right.
    const { number } = entity.s;
    resetGameEntity(entity);
    entity.s.number = number;
    entity.classname = 'freed';
    entity.freetime = this.time;
    entity.inuse = false;
  }

  /**
   * `trap_LinkEntity` (`SV_LinkEntity`, `sv_world.c:205–355`): put an entity where the server can
   * find it.
   *
   * An entity nothing has linked reaches nobody, whatever else is true of it, so anything that
   * has just been put somewhere has to say so. What linking actually does belongs to the server
   * rather than to the game module, which is why it is a handler; a level with none links into a
   * world of its own.
   *
   * @param entity - The entity to link.
   */
  linkEntity(entity: GameEntity): void {
    if (this.handlers.linkEntity) this.handlers.linkEntity(entity);
    else this.world.link(entity);
  }

  /**
   * `trap_UnlinkEntity` (`SV_UnlinkEntity`, `sv_world.c:167–195`): take an entity out of the
   * world.
   *
   * A corpse that has sunk away and a player who has just died are both unlinked rather than
   * freed, which is what stops either being sent to anybody while the slot is still theirs.
   *
   * @param entity - The entity to unlink.
   */
  unlinkEntity(entity: GameEntity): void {
    if (this.handlers.unlinkEntity) this.handlers.unlinkEntity(entity);
    else this.world.unlink(entity);
  }

  /**
   * `trap_SetConfigstring` (`g_syscalls.c:186–188`): tell every client a string has changed.
   *
   * A level with no server behind it writes nowhere, as one with no `trap_LinkEntity` links
   * nowhere: the game module still keeps its own copy of whatever the string was made from.
   *
   * @param index - One of `CONFIGSTRING`.
   * @param value - The string.
   */
  setConfigstring(index: number, value: string): void {
    this.handlers.setConfigstring?.(index, value);
  }

  /**
   * `trap_SendServerCommand` (`g_syscalls.c:56–58`): a reliable line to a client.
   *
   * @param clientNum - Who to tell, or null for everyone, which Quake 3 sends as −1.
   * @param text - The command, already quoted as the client expects it.
   */
  sendServerCommand(clientNum: number | null, text: string): void {
    this.handlers.sendServerCommand?.(clientNum, text);
  }

  /**
   * `trap_Trace` (`SV_Trace`, `sv_world.c:596–644`): a sweep through the world and the entities
   * in it, for a think that has to find the floor — an item standing up is the first to ask.
   *
   * The handler answers, and a level that links for itself then sweeps its own entities, as the
   * server does after the map; one the host links for has none. Unlike the links there is no
   * fallback for the map. A level with no collision cannot answer where anything lands, and
   * pretending the world is empty would put an item under the floor rather than fail where a map's
   * own start can see it.
   *
   * @throws when the level has no collision handler
   */
  trace(
    start: Vec3,
    mins: Vec3,
    maxs: Vec3,
    end: Vec3,
    passEntityNum: number,
    contentmask: number
  ): TraceResult {
    return this.world.trace(start, mins, maxs, end, passEntityNum, contentmask);
  }

  /**
   * `trap_PointContents` (`SV_PointContents`, `sv_world.c:653–685`): the `CONTENTS_*` at a point,
   * the map's with every linked entity's but the pass entity's, a brush model's by its brushes and
   * anything else's as a body. The handler answers, and a level that links for itself then asks
   * its own entities.
   *
   * @param passEntityNum - The entity left out, or −1 for none, as the game's own asks pass.
   */
  pointContents(point: Vec3, passEntityNum: number): number {
    return this.world.pointContents(point, passEntityNum);
  }

  /**
   * `trap_SetBrushModel` (`SV_SetBrushModel`, `sv_game.c:111–135`): make an entity the map's
   * inline model `*N`, which is what a trigger's shape is, with its bounds and linked.
   *
   * The server answers it on the real path. A level with no server answers from the clip map it
   * was given, as the server would.
   *
   * @param name - The entity's `model` key, or null for none.
   * @throws in Q3's words for no name, a name that is not a brush model's, and a model the map has
   *   not got
   */
  setBrushModel(entity: GameEntity, name: string | null): void {
    if (this.handlers.setBrushModel) {
      this.handlers.setBrushModel(entity, name);
      return;
    }
    setBrushModel(this.clipMap, entity, name, (linked) => this.linkEntity(linked));
  }

  /**
   * `trap_EntityContact` (`SV_EntityContact`, `sv_game.c:217–231`): whether a box is inside
   * another entity's at all, for the touch pass to decide whether the player really reached what
   * the search found.
   *
   * A zero-length trace of the box through the entity: a brush model by its own brushes, so a
   * slanted trigger is touched at its slant rather than at its bounds, and anything else by its
   * bounds, edges counting. The server answers it on the real path, and a level with no server
   * from the clip map it was given.
   *
   * @param mins - The query box's lower corner, in the world.
   * @param maxs - Its upper corner.
   * @param entity - What the query is against.
   */
  entityContact(mins: Vec3, maxs: Vec3, entity: GameEntity): boolean {
    if (this.handlers.entityContact) return this.handlers.entityContact(mins, maxs, entity);
    return entityContact(this.clipMap, entity, mins, maxs);
  }

  /**
   * `trap_AdjustAreaPortalState` (`SV_AdjustAreaPortalState`, `sv_game.c:201–209`): open or close
   * the areaportal between the two areas a door was last linked across.
   *
   * The server answers it on the real path, and a level with no server from its own world, whose
   * portals are its clip map's.
   *
   * @param open - Open it, or close it again: each open is undone by one close.
   * @throws in Q3's words for a portal closed more often than opened
   */
  adjustAreaPortalState(entity: GameEntity, open: boolean): void {
    if (this.handlers.adjustAreaPortalState) this.handlers.adjustAreaPortalState(entity, open);
    else this.world.adjustAreaPortalState(entity, open);
  }

  /**
   * `trap_InPVS` (`SV_inPVS`, `sv_game.c:146–166`): whether `p2` is in a cluster `p1`'s can see,
   * in an area no shut door parts from `p1`'s.
   *
   * The server answers it on the real path, and a level with no server from its own world.
   */
  inPVS(p1: Vec3, p2: Vec3): boolean {
    if (this.handlers.inPVS) return this.handlers.inPVS(p1, p2);
    return this.world.inPVS(p1, p2);
  }

  /**
   * `trap_EntitiesInBox` (`SV_AreaEntities`, `sv_world.c:381–438`): the number of every linked
   * entity whose box touches this one, in the world's order. A blast finds what it reaches this
   * way.
   *
   * The server answers it on the real path, and a level with no server from its own world.
   *
   * @param mins - The box's lower corner, in the world.
   * @param maxs - Its upper corner.
   */
  entitiesInBox(mins: Vec3, maxs: Vec3): number[] {
    if (this.handlers.entitiesInBox) return this.handlers.entitiesInBox(mins, maxs);
    return this.world.areaEntities(mins, maxs);
  }

  /**
   * `G_Find` (`g_utils.c:159–181`): the next entity in use after `from` whose field matches,
   * without regard to case.
   *
   * @param from - Where the last search stopped, or null to start at the first entity.
   * @param field - The field to match: Q3's `FOFS( classname )` or `FOFS( targetname )`.
   * @returns the entity, or null when there are no more
   */
  find(from: GameEntity | null, field: 'classname' | 'targetname', match: string): GameEntity | null {
    const wanted = match.toLowerCase();
    for (let i = from ? from.s.number + 1 : 0; i < this.numEntities; i++) {
      const entity = this.gentities[i];
      if (!entity.inuse) continue;
      const value = entity[field];
      if (value !== null && value.toLowerCase() === wanted) return entity;
    }
    return null;
  }

  /**
   * `G_InitGentity` (`g_utils.c:367–372`): a slot taken, with nothing in it yet.
   *
   * Quake 3's `e->s.number = e - g_entities` is here as the slot the caller took, and it is not
   * the formality it looks. The number is the slot's own, which is why {@link Level.freeEntity}
   * keeps it over the clearing — but `BG_PlayerStateToEntityState` writes a player state's
   * `clientNum` over it, and a client that has connected without yet beginning has a player state
   * of zeroes. A bot's entity is in use from the moment it connects (`ClientConnect`), so the
   * first frame of its wait ends with its entity numbered 0, and nothing but this puts it back.
   *
   * @param entity - The slot's entity.
   * @param number - The slot, which is Quake 3's `e - g_entities`.
   */
  initEntity(entity: GameEntity, number: number): GameEntity {
    entity.inuse = true;
    entity.classname = 'noclass';
    entity.s.number = number;
    entity.r.ownerNum = ENTITYNUM_NONE;
    return entity;
  }
}
