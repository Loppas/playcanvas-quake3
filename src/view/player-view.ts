import type { Gender } from '../formats/animation-config';
import { atoi } from '../formats/c-scan';
import { tokenize } from '../formats/q3config';
import {
  CHAT_ESCAPE,
  CONFIGSTRING,
  MAX_CONFIGSTRINGS,
  MAX_SAY_TEXT,
  MAX_SOUNDS,
  SNAPFLAG
} from '../net/commands';
import { CMD_BACKUP, type UserCmdRing } from '../net/client-clock';
import { ServerDisconnect } from '../net/connection';
import { copyPlayerState, copyTrajectory } from '../net/delta';
import {
  MAX_CLIENTS,
  MAX_GENTITIES,
  TR,
  createPlayerState,
  createTrajectory,
  wireDrawnTime,
  type EntityState,
  type PlayerState,
  type Trajectory
} from '../net/protocol';
import { ANIM, ANIM_TOGGLEBIT } from '../sim/animations';
import { angleToShort, shortToAngle, toShort } from '../sim/client';
import { f } from '../sim/cm/q-math';
import {
  CROUCH_VIEWHEIGHT,
  DEFAULT_VIEWHEIGHT,
  EF_FIRING,
  EF_NODRAW,
  EF_TELEPORT_BIT,
  GT,
  MASK,
  PERS,
  PITCH_LIMIT_SHORT,
  PMF_DUCKED,
  PMF_FOLLOW,
  PM_INTERMISSION,
  PM_SPECTATOR,
  STAT,
  TEAM
} from '../sim/constants';
import { SOLID_BMODEL } from '../sim/entity-solid';
import { EV, eventNumber, isStepEvent, type Event } from '../sim/events';
import { ET } from '../sim/game-entity';
import { angleVectors } from '../sim/pmove-math';
import type { SysteminfoRules } from '../sim/rules';
import { evaluateTrajectory, qvmEvaluateTrajectory } from '../sim/trajectory';
import {
  NO_CONTENTS,
  NO_INLINE_MODELS,
  type InlineModels,
  type PointContentsFn,
  type TraceFn,
  type UserCmd
} from '../sim/types';
import { shotSeed } from '../sim/unlagged';
import { copy, lerp, madd, vec3, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import type { GrappleMode } from '../sim/weapons/grapple';
import { firingSolution } from '../sim/weapons/hitscan';
import {
  Announcer,
  type AnnouncerCue,
  type AnnouncerMatch,
  type LocalSoundState
} from './announcer';
import {
  FIGHT_CHAR_WIDTH,
  FIGHT_Y,
  USE_ITEM_CHAR_WIDTH,
  USE_ITEM_Y,
  type CenterPrintRequest
} from './center-print';
import {
  gamestateClients,
  keepClientInfo,
  loadClientInfo,
  newClientInfo,
  type ClientInfo,
  type GamestateClient
} from './client-info';
import {
  buildSolidList,
  clientPointContents,
  clientTrace,
  type ClientWorld,
  type SolidEntity
} from './client-trace';
import type { BrushModelPose } from './brush-models';
import type { DamageFeedback } from './damage-feedback';
import {
  delagReport,
  delagged,
  drawnEarly,
  earlyShotEffects,
  type AimedFrame
} from './early-shots';
import {
  lightningBolt,
  type DrawnLaser,
  type GrappleHook,
  type LightningBolt
} from './effects';
import {
  checkEntityEvents,
  createEntityEvents,
  transitionEntityEvents,
  type EntityEvents,
  type Players,
  type WorldEffect
} from './entity-events';
import {
  addPlayerWeapons,
  createEntityMemory,
  otherPlayerEvents,
  type EntityMemory,
  type EntitySound
} from './other-player-events';
import { Lagometer } from './lagometer';
import { adjustPositionForMover } from './mover-adjust';
import {
  checkPlayerstateEvents,
  createPlayerEvents,
  transitionPlayerEvents,
  type PlayerEvents,
  type PlayerSound
} from './player-events';
import { sameLook, type PlayerLook } from './player-model';
import { fragMessage, killerName, obituary } from './obituary';
import { Prediction, type PredictionFrame } from './prediction';
import { lerpAngle } from './q-math';
import { EMPTY_SCORES, parseScores, type Scores } from './scores';
import { serverInfo, type ServerInfo } from './server-info';
import { SnapshotPool, type ViewSnapshot } from './snapshot-pool';
import type { RewardState } from './rewards';
import type { FloatSprite } from './player-sprites';
import { LocalEntities } from './local-entities';
import { ScorePlums } from './score-plums';
import { addToTeamChat, createTeamChat, type TeamChatState } from './team-chat';
import { lastAttacker, tellAttackerCommand, type AttackerState } from './attacker';
import {
  createCrosshairPlayer,
  crosshairPlayer,
  scanForCrosshairEntity,
  type CrosshairPlayer
} from './crosshair-player';
import { thirdPersonView } from './third-person';
import { flashVisible } from './viewmodel';
import { OPEN_AREAS } from './world-vis';
import {
  createCameraFeel,
  firstPersonView,
  transitionCameraFeel,
  type CameraFeel,
  type FirstPersonView,
  type ViewSample
} from './camera-feel';

/**
 * Runs the program a frame at a time and produces a camera position for each rendered frame — the
 * seam between real time, which arrives in whatever slices the display gives us, and the
 * snapshots the server sends, which the client's clock reads in turn.
 *
 * This is cgame's side of that seam and nothing else. It does not run the world: it sends a user
 * command down the wire, and everything it knows afterwards it read out of the snapshot that came
 * back. The world is somebody else's — a host in this process or one across a network — and this
 * cannot tell the difference, which is the point.
 *
 * Everything here is engine-free, so the whole input-to-camera path can be tested headless. All
 * output is in Q3 units, Z-up; converting to the renderer's metres and Y-up is the caller's job.
 */

/** Shared empty result, so a view with nothing to show does not allocate on every frame. */
const EMPTY_STATES: readonly EntityState[] = [];

/**
 * A slot whose `CS_PLAYERS` string has not been read yet. It cannot be the empty string, because
 * that is a real one: "player just left".
 */
const UNREAD = '\u0000unread';

/**
 * Where the view's words go: the client's console, which cgame reaches by `trap_Print`.
 *
 * A restart's clearing of the notify lines is the client's too, done as the command is read and
 * before cgame is told (`cl_cgame.c:331–339`). So it comes through here, in its place among the
 * prints, and a print sent after the restart still shows.
 */
export interface ViewConsole {
  /** `CG_Printf`: its newlines and colour codes are the console's to read. */
  print(text: string): void;
  /** `Con_ClearNotify`. */
  clearNotify(): void;
}

/** Nowhere, for a view not yet told where its words go. */
const NO_CONSOLE: ViewConsole = { print: () => {}, clearNotify: () => {} };

/**
 * The program the view is a client of: `Com_Frame`'s two halves, as far as cgame can see them.
 *
 * It is declared here, and satisfied structurally, so that nothing in `src/view/` depends on how
 * the game is being run. What a client is given is a clock and the snapshots it has been sent,
 * which are all it knows of the world, plus the reliable commands it was sent in words.
 */
export interface GameSource {
  /**
   * One frame of the program: the commands out, the world's frame, and the snapshots back.
   *
   * @param msec - The real time since the last frame, in milliseconds and any fraction of one.
   * @param cmd - What the player is holding this frame, with its angles in degrees.
   */
  frame(msec: number, cmd: Omit<UserCmd, 'serverTime'>): void;

  /** `cl.serverTime`: the client's clock, which is the time the view draws. */
  readonly serverTime: number;

  /**
   * The frame just drawn, which the commands the next frame makes carry: the time it was drawn
   * at, and the two snapshots it drew other players between, the second the first again where
   * there was no next. Quake 3's cgame hands the engine what goes in its next commands the same
   * way (`trap_SetUserCmdValue`).
   */
  setDrawnFrame(time: number, snapTime: number, nextSnapTime: number): void;

  /** The message the last gamestate came in: a new one is a new world, read from its start. */
  readonly gamestateMessageNum: number;

  /** `trap_GetCurrentSnapshotNumber`: the newest snapshot's number. */
  currentSnapshotNumber(): number;

  /** `trap_GetCurrentSnapshotNumber`'s other answer: the newest snapshot's time. */
  readonly latestSnapshotTime: number;

  /** `trap_GetSnapshot`: a snapshot by number, or null for one that was lost or is too old. */
  snapshot(number: number): SourceSnapshot | null;

  /**
   * `trap_GetServerCommand` for every server command up to and including `upTo` not yet taken,
   * oldest first.
   */
  takeServerCommands(upTo: number): readonly string[];

  /**
   * One of the configstrings as the client has them now, which cgame copies at a gamestate and
   * keeps by the `cs` commands it runs after it.
   */
  configstring(index: number): string;

  /**
   * `cl.cmds` and `cl.cmdNumber`: the commands the client has made, which prediction replays
   * (`CG_PredictPlayerState`). A command is written over the next time round the ring, so one is
   * read as it is handed back.
   */
  readonly commands: UserCmdRing;

  /** The rules the client predicts with, as `CS_SYSTEMINFO` carried them. */
  readonly rules: Readonly<SysteminfoRules>;

  /** `pmove_msec` as the server clamps it: the tick prediction chops its commands into. */
  readonly pmoveMsec: number;

  /** `g_allowGrapple`'s style, or null for a client whose match has no hook. */
  readonly grappleMode: GrappleMode | null;

  /** `cg.clientNum`: the slot the gamestate gave this client, whoever it is watching. */
  readonly clientNum: number;

  /**
   * The gap between this client's snapshots as the server sends them, which Excessive Plus's
   * client takes as one server frame: how far it carries others on, and its missiles ahead.
   */
  readonly snapshotGap: number;

  /** `xp_unlagged`, as the systeminfo carried it: which weapons the server rewinds for. */
  readonly unlagged: number;

  /** `map_restart 0`: the match over again on the same map, at the next frame. */
  restart(): void;
}

/** `snapshot_t` (`cg_public.h:39–54`): a snapshot as cgame is handed one. */
export interface SourceSnapshot {
  snapFlags: number;
  /** How long the server took to answer the client's commands, as the client worked it out. */
  ping: number;
  /** The server's clock as the snapshot was taken, in milliseconds. */
  serverTime: number;
  /** `serverCommandSequence`: the server commands up to this one come before the snapshot. */
  serverCommandNum: number;
  /**
   * The areas closed to the player's view, a bit each, all `MAX_MAP_AREA_BYTES` of them: clear
   * past the bytes the server sent.
   */
  areamask: Uint8Array;
  ps: PlayerState;
  /** In increasing entity number. */
  entities: readonly EntityState[];
}

/**
 * A player the snapshot carried, as far as `CG_Player` reads its `centity_t`: the entity state,
 * and where it is drawn this frame.
 */
export interface PlayerCentity {
  /** `currentState`: the entity as the newest snapshot carried it. */
  state: EntityState;
  /** `lerpOrigin`: where it is drawn. */
  origin: Vec3;
  /** `lerpAngles`: which way it looks. */
  angles: Vec3;
  /**
   * `CG_ResetEntity`: it came into view, or teleported, during the last frame's ticks, so its body
   * starts afresh rather than turning from wherever it was.
   */
  reset: boolean;
  /** `cent->muzzleFlashTime`: when it last fired, which its gun's flash is drawn from. */
  flashTime: number;
  /** `cent->pe.railFireTime`: when its railgun last fired, for the glow's return. */
  railFireTime: number;
  /** `cent->pe.painTime` and `painDirection`, which twist its torso after a pain sound. */
  pain: { time: number; direction: number };
  /**
   * `CG_LightningBolt`: where its lightning bolt ends this frame, or `null` while its gun's flash
   * is not drawn. The bolt starts at the drawn gun's flash, which is the body's to know.
   */
  bolt: LightningBolt | null;
}

/**
 * An item the snapshot carried, as `CG_Item` draws it.
 *
 * Everything is on the entity state except one thing: when it last came back. `cent->miscTime` is
 * set by `EV_ITEM_RESPAWN` rather than sent continuously, and the scale-up runs from it for a
 * second — so the client keeps it per slot, as Q3 keeps it per `centity_t`.
 */
export interface ItemCentity {
  /** `currentState`: the entity as the newest snapshot carried it. */
  state: EntityState;
  /** `lerpOrigin`: where it stands, before the bob. */
  origin: Vec3;
  /**
   * `cent->miscTime`: when it last respawned, or 0 for one that has not since the client saw it.
   * The scale-up is `1` once a second has passed, which a zero is far past.
   */
  respawnTime: number;
}

/** A missile as `CG_Missile` draws it: the entity state, and where it is drawn this frame. */
export interface MissileCentity {
  /** The entity as the snapshot it is drawn from carried it, the next one's if it has come. */
  state: EntityState;
  /** `lerpOrigin`: where it is drawn, which the projectile nudge may put ahead of its path. */
  origin: Vec3;
  /**
   * `trailTime` as `CG_ResetEntity` left it as the missile came into view (`cg_snapshot.c:42`):
   * the time its smoke starts from at its first drawing.
   */
  trailTime: number;
}

/**
 * What `CG_EntityEffects` and `CG_Speaker` read of a packet entity that is neither a player nor a
 * missile, which have lists of their own: where its sounds are heard from, the loop it carries,
 * and a speaker's repeat.
 */
export interface SoundCentity {
  /** `s.number`. */
  number: number;
  /** `lerpOrigin`, in cgame's floats: where its loop is heard from. */
  readonly origin: Vec3;
  /**
   * Where its other sounds are heard from (`CG_SetEntitySoundPosition`): {@link origin}, or for a
   * brush model, that plus its model's midpoint.
   */
  readonly soundOrigin: Vec3;
  /** `s.loopSound`: the `CS_SOUNDS` slot of its loop, or 0 for none. */
  loopSound: number;
  /** `ET_SPEAKER`: its loop is a real one, and it repeats by itself. */
  speaker: boolean;
  /** `s.eventParm`: a speaker's sound. */
  eventParm: number;
  /** `s.frame`: a speaker's `wait`, in tenths of a second. */
  frame: number;
  /** `s.clientNum`: a speaker's `random`, in tenths of a second. */
  clientNum: number;
}

/** A `cs` for a `CS_SOUNDS` slot, as cgame read it. */
export interface SoundChange {
  /** The slot. */
  index: number;
  /** What it names now. */
  name: string;
}

export class PlayerView {
  /** The program this is a client of: where the commands go, and where the snapshots come from. */
  private readonly source: GameSource;
  /**
   * `cg.snap->ps`: the player state of the current snapshot, which the player is drawn from.
   *
   * A copy, so that the one before is still here as the next snapshot is made current, which is
   * what `CG_CheckPlayerstateEvents` compares against to learn that anything happened.
   */
  private readonly state = createPlayerState();
  /**
   * `cg.predictedPlayerState` and what prediction keeps across frames: the last frame's
   * prediction, the error that has not decayed, and which items it has already taken.
   */
  private readonly prediction = new Prediction();
  /** `cg.oldTime`: the last frame's clock, which a fresh prediction error is dated by. */
  private oldTime = 0;
  /**
   * `cg_triggerEntities` (`cg_predict.c:63–69`): the items, jump pads and teleporters a predicted
   * touch is tested against, in the snapshot's order, as the current snapshot has each.
   */
  private worldTriggers: readonly EntityState[] = EMPTY_STATES;
  /**
   * The map's collision, contents and inline models, and `cg.physicsTime`: all a client has of the
   * world but what it is sent.
   */
  private readonly map: ClientWorld;
  /**
   * The player-state transitions of snapshots this frame, held until prediction has run: a
   * command that moved carries them (the predicted state's diff against the last frame's catches
   * the same events), and a frame with nothing to replay — a local game whose loopback answers in
   * the same frame, or a paused client — falls back to the snapshots' own transitions.
   */
  private readonly pendingTransitions: Array<{
    ps: PlayerState;
    ops: PlayerState;
    snapTime: number;
  }> = [];
  /** The states {@link pendingTransitions} copies into, one for each it has held at once. */
  private readonly pendingStates: PlayerState[] = [];
  private feel: CameraFeel = createCameraFeel(DEFAULT_VIEWHEIGHT);

  /** `cg.time`: the time this frame is drawn at, on the server's clock. */
  private cgTime = 0;
  /** `cg.snap`: the snapshot the clock has most recently reached, or null before the first. */
  private snap: ViewSnapshot | null = null;
  /** `cg.nextSnap`: the one after it, which the frame is drawn toward, or null for none yet. */
  private nextSnap: ViewSnapshot | null = null;
  /** Where the snapshots read are copied, {@link snap} and {@link nextSnap} among them. */
  private readonly snapshots = new SnapshotPool();
  /** `cg.latestSnapshotNum`: the newest snapshot the client has. */
  private latestSnapshotNum = 0;
  /** `cg.latestSnapshotTime`: that snapshot's time. */
  private latestSnapshotTime = 0;
  /** `lagometer`: the frames' and snapshots' samples, which a new gamestate starts over. */
  private lagometerSamples = new Lagometer();
  /** `cgs.processedSnapshotNum`: the last snapshot read, whether or not it could be. */
  private processedSnapshotNum = 0;
  /** The gamestate the snapshots are counted from. */
  private gamestate: number;
  /**
   * `cent->interpolate`: the entities of the next snapshot that are drawn between it and the
   * current one, having been in both without teleporting.
   */
  private readonly interpolating = new Set<number>();
  /** `cg.nextFrameTeleport`: the player teleported between the two, so is not drawn between. */
  private nextFrameTeleport = false;
  /** The angles this frame's command carries, as shorts, which the camera turns by. */
  private look: readonly number[] | null = null;
  /** The player as this frame draws them: {@link sample}'s answer. */
  private drawn: ViewSample;
  /** `cg.mapRestart`: a restart was read, and the player state still has to hear of it. */
  private mapRestartPending = false;
  /**
   * `cgs.gameState`'s configstrings: the gamestate's, with each `cs` since run as the snapshot it
   * came before is made current, so what the view reads of the match is that snapshot's.
   */
  private readonly configstrings: string[] = new Array<string>(MAX_CONFIGSTRINGS).fill('');
  /** {@link serverInfo}'s parse, made only when the string changes. */
  private parsedServerInfo: ServerInfo = serverInfo('');
  /** `CS_SHADERSTATE` as cgame read it each time, oldest first, not yet taken. */
  private shaderStates: string[] = [];
  /** The entities of the current snapshot, which is the whole of what the client knows. */
  private world: readonly EntityState[] = EMPTY_STATES;
  private worldMissiles: readonly EntityState[] = EMPTY_STATES;
  /**
   * The missiles drawn this frame: the next snapshot's, once it has come, and the current one's
   * that the next has not taken over ({@link transitionedEarly}).
   */
  private drawnMissiles: readonly EntityState[] = EMPTY_STATES;
  /**
   * `cent->nextState.eType` per entity slot: the type each slot had in the last next snapshot it
   * was in, which unlagged's early transition reads. `ET_GENERAL`, 0, for a slot never in one.
   */
  private nextType = new Uint8Array(MAX_GENTITIES);
  private worldPlayers: readonly EntityState[] = EMPTY_STATES;
  private worldItems: readonly EntityState[] = EMPTY_STATES;
  /** The current snapshot's lasers, `ET_BEAM`. */
  private worldBeams: readonly EntityState[] = EMPTY_STATES;
  /** The current snapshot's movers, `ET_MOVER`. */
  private worldMovers: readonly EntityState[] = EMPTY_STATES;
  /** What {@link movers} hands out, each pose made once and written again each frame. */
  private readonly moverPoses: BrushModelPose[] = [];
  private readonly drawnMovers: BrushModelPose[] = [];
  /** Scratch for a mover's place. */
  private readonly moverOrigin = vec3();
  private readonly moverAngles = vec3();
  /**
   * The current snapshot's entities that {@link soundEntities} hands out: all but its players, its
   * missiles and its events.
   */
  private worldSounding: readonly EntityState[] = EMPTY_STATES;
  /** What {@link soundEntities} hands out, each made once and written again each frame. */
  private readonly soundPool: SoundCentity[] = [];
  private readonly sounding: SoundCentity[] = [];
  /**
   * `cgs.inlineModelMidpoints`: the middle of each inline model's box, worked out from the map as
   * the first snapshot naming it is read, and kept until the gamestate goes.
   */
  private readonly midpoints = new Map<number, Vec3>();
  /** Scratch for an inline model's box. */
  private readonly modelMins = vec3();
  private readonly modelMaxs = vec3();
  /** `CS_SOUNDS` as cgame read each `cs` for it, oldest first, not yet taken. */
  private soundChanges: SoundChange[] = [];
  /** `CS_MUSIC` as cgame last started the music from it, not yet taken. */
  private musicStart: string | null = null;
  /**
   * `cent->miscTime` per entity slot: when each item last respawned, for its scale-up. Zero is "not
   * since this client saw it", which is where Q3's `miscTime` starts too.
   */
  private itemRespawnTime = new Float64Array(MAX_GENTITIES);
  /**
   * `cg_solidEntities` (`cg_predict.c:71–74`): the entities a trace can hit, as the current
   * snapshot has each.
   */
  private solids: readonly EntityState[] = EMPTY_STATES;
  /** The numbers {@link buildSolidList} last put on the trigger list, which it is read from. */
  private readonly triggerNumbers: number[] = [];
  /** The numbers it last put on the solid list. */
  private readonly solidNumbers: number[] = [];
  /**
   * The last frame as it was drawn, which is where the player aimed this frame's shots: an early
   * shot is traced through its solids. Null before the first.
   */
  private aimed: AimedFrame | null = null;
  /**
   * The solids placed where a frame draws them, each list with its trace: two, so that the last
   * frame's, which {@link aimed} keeps, is never written over by this frame's.
   */
  private readonly placements: readonly [Placement, Placement];
  /** This frame's placement, or null until something asks for it. */
  private placement: Placement | null = null;
  /** The players brought into view afresh during the last {@link advance}, by entity number. */
  private readonly resets = new Set<number>();
  /**
   * Each slot's `trailTime` as `CG_ResetEntity` set it, at the time of the snapshot that last made
   * the missile there current with nothing to draw it between.
   */
  private readonly trailTimes = new Float64Array(MAX_GENTITIES);
  /**
   * Each client's `lerpOrigin` and `lerpAngles` as it was last drawn on this map, six numbers a
   * slot, which a grappling hook's rope starts from while its thrower is not sent; and whether it
   * has been drawn at all.
   */
  private readonly lastDrawn = new Float64Array(MAX_CLIENTS * 6);
  private readonly everDrawn = new Uint8Array(MAX_CLIENTS);
  /**
   * The `commandTime` of the step the player last took, or `-Infinity` before any: a step is a
   * teleport rather than motion, so the drawn position snaps to the step it reached while
   * the eye glides. Held rather than per-frame, so the snap lasts while the stair lies
   * between the two steps the frame blends — every frame that redraws the same pair above 125 Hz,
   * not only the frame that played the event.
   */
  private stepCommandTime = Number.NEGATIVE_INFINITY;
  /** `cgs.clientinfo`: who is in each slot, as their `CS_PLAYERS` string says. */
  private readonly infos: (ClientInfo | null)[] = new Array<ClientInfo | null>(MAX_CLIENTS).fill(
    null
  );
  /** The string each clientinfo was last read from, so that only a change is read again. */
  private readonly infoStrings: string[] = new Array<string>(MAX_CLIENTS).fill(UNREAD);
  /** The gametype those were read under, which decides what colours a look is worn in. */
  private infoGametype = -1;
  /** The gamestate whose clients were last registered, as `CG_Init` registers them. */
  private registeredGamestate = -1;
  /** `cg.scores` and `cg.numScores`: the board the last `scores` command carried. */
  private board: Scores = EMPTY_SCORES;
  /** `cgs.teamChatMsgs` and the ring they are kept in, which the team chat box draws. */
  private teamChatBox: TeamChatState = createTeamChat();
  /** `cg.crosshairClientNum` and `cg.crosshairClientTime`: who was last under the crosshair. */
  private crosshair: CrosshairPlayer = createCrosshairPlayer();
  /** `cg.killerName`: who killed the player during the last {@link advance}, or `null`. */
  private killedByThisFrame: string | null = null;

  private frameEffects: WorldEffect[] = [];
  private frameSounds: PlayerSound[] = [];
  private frameGibs: Vec3[] = [];
  private frameEntitySounds: EntitySound[] = [];
  private firedAt = Number.NEGATIVE_INFINITY;
  /** When the railgun last fired, for its glow's return. */
  private railFiredAt = Number.NEGATIVE_INFINITY;
  /** The client's side of the player's own events: the last hurt's feedback, and the pain. */
  private playerEvents: PlayerEvents = createPlayerEvents(this.state);
  /** `ET_INVISIBLE`: gibbed, so nothing of the body is left to draw until the respawn. */
  private invisible = false;
  /** `cg.mapRestart`: the game started over during the last {@link advance}. */
  private restarted = false;
  /** A new gamestate came during the last {@link advance}, which starts cgame over. */
  private newGamestate = false;
  /** The centre print raised during the last {@link advance}, or null for none. */
  private centerPrinted: CenterPrintRequest | null = null;
  /** The match's voices: what each snapshot has to say, and the ones waiting their turn. */
  private readonly announcer: Announcer;
  /** `CS_WARMUP` as last read, so that only a change of it is parsed. */
  private warmupString: string;
  /** The voices started during the last {@link advance}. */
  private frameVoices: AnnouncerCue[] = [];
  /** The score plums floating, which are cgame's local entities. */
  private readonly plums: ScorePlums;
  /** `PERS_SPAWN_COUNT` changed during the last {@link advance}, which is a respawn. */
  private respawnedThisFrame = false;
  /** `cg_entities[]`'s event memory: what each entity slot was last seen carrying. */
  private entityEvents: EntityEvents = createEntityEvents();
  /** `cg_entities[]`' `pe`: what each slot's events left, its flash and its pain among them. */
  private entityMemory: EntityMemory = createEntityMemory();

  /**
   * `cg_thirdPerson`: the camera behind the body rather than in its eyes. Death puts it
   * there whatever this says (`cg_view.c:804–805`).
   */
  thirdPerson = false;

  /** `cg_scorePlums`: whether a score this client makes floats its points where it happened. */
  scorePlums = true;

  /** `cg_teamChatsOnly`: in a team game, a `chat` line is neither printed nor heard. */
  teamChatsOnly = false;

  /** `cg_teamChatHeight`: how many team lines the box keeps, up to 8; 0 keeps none. */
  teamChatHeight = 0;

  /** `cg_teamChatTime`: how long a team line stays in the box, in milliseconds. */
  teamChatTime = 3000;

  /**
   * `cg_deferPlayers`: a look nobody loaded wears is put off until the scoreboard is up, and a
   * loaded client's worn meanwhile.
   */
  deferPlayers = true;

  /**
   * `cg_nopredict`: no local simulation, so the player is drawn as the snapshots have them and
   * the camera turns from the newest command (`CG_PredictPlayerState`'s second branch).
   */
  noPredict = false;

  /** `cg_errorDecay`: how long a correction takes to fade, in ms. Zero is at once. */
  errorDecay = 100;

  /** `cg_showmiss`: how much of the replay's diagnostics the console prints. */
  showMiss = 0;

  /** `cg_predictItems`: predict the pickup, as the same userinfo key tells the match to. */
  predictItems = true;

  /**
   * `cg_projectileNudge`: how many milliseconds further on than its own missiles the client draws
   * everyone else's, grenades aside, to show where they really are by now.
   */
  projectileNudge = 0;

  /**
   * `xp_delagWeapons`: which of the player's own hitscan shots are drawn as they are predicted,
   * a mask of 1 the machinegun, 2 the shotgun and 8 the railgun, rather than when the server's
   * events for them arrive.
   */
  delagWeapons = 0;

  /**
   * `cg_debugDelag`: each rail drawn early prints where the frame it was aimed in drew the player
   * it strikes, to set beside where the server's rewind put them.
   */
  debugDelag = false;

  /** Where this client's prints go: an obituary, and every `print` the server sends. */
  console: ViewConsole = NO_CONSOLE;

  /**
   * `ci->gender` for each slot, which only an obituary reads. Q3 takes it from the `animation.cfg`
   * of the model the clientinfo loaded, and here the models are the render layer's. Male until
   * told, as `CG_ParseAnimationFile` starts every model (`cg_players.c:123`).
   */
  gender: (clientNum: number) => Gender = () => 'male';

  /**
   * @param source - The program to play: where this client's commands go, and where its snapshots
   *   come from. It is expected to be connected and in the world already, as a client is by the
   *   time cgame is started.
   * @param trace - Swept-AABB trace against the map, which every trace a client makes goes
   *   through before its entities.
   * @param localEntities - The pool the score plums take their places in.
   * @param pointContents - What a point is inside of the map, which every ask of the client's
   *   contents starts from.
   * @param inlineModels - The map's inline models: the brush models' shapes, and the triggers' a
   *   predicted touch is tested on.
   */
  constructor(
    source: GameSource,
    trace: TraceFn,
    localEntities = new LocalEntities(),
    pointContents: PointContentsFn = NO_CONTENTS,
    inlineModels: InlineModels = NO_INLINE_MODELS
  ) {
    this.source = source;
    const { prediction } = this;
    this.map = {
      trace,
      pointContents,
      inlineModels,
      get physicsTime() {
        return prediction.physicsTime;
      }
    };
    this.placements = [placementFor(this.map), placementFor(this.map)];
    this.plums = new ScorePlums(localEntities);
    this.readConfigstrings();
    this.warmupString = this.configstring(CONFIGSTRING.WARMUP);
    this.announcer = new Announcer(atoi(this.warmupString));
    // `CG_Init`: the snapshots are counted from the gamestate's message, and the first frame reads
    // them, with the commands they carry. Until then the player is shown as the newest has them.
    this.gamestate = source.gamestateMessageNum;
    this.processedSnapshotNum = this.gamestate;
    const newest = source.snapshot(source.currentSnapshotNumber());
    if (newest !== null) {
      copyPlayerState(newest.ps, this.state);
      this.cgTime = newest.serverTime;
    }
    this.feel = createCameraFeel(this.state.viewheight);
    this.playerEvents = createPlayerEvents(this.state);
    this.drawn = this.interpolatePlayerState();
    this.registerClients();
  }

  /** The state being drawn: this client's copy of the last player state it was sent. */
  get player(): PlayerState {
    return this.activeState();
  }

  /**
   * Whether the view has a snapshot the player is in, `cg.snap`. Until it does there is no world to
   * draw the player in, and Quake 3 draws `CG_DrawInformation` instead (`cg_view.c:787–792`): a
   * client that has loaded its map is still a round trip from being put in it.
   */
  get inWorld(): boolean {
    return this.snap !== null;
  }

  /**
   * `CG_DrawDisconnect`'s test (`cg_draw.c:1596–1602`): the client's commands have outrun its
   * buffer. The oldest it still keeps is newer than the last the current snapshot answered, so the
   * server has run none of `CMD_BACKUP`'s worth; and not past this frame, as one made before a
   * `map_restart` can be.
   */
  get connectionInterrupted(): boolean {
    const { snap } = this;
    if (snap === null) return false;
    const { commands } = this.source;
    const oldest = commands.at(commands.cmdNumber - CMD_BACKUP + 1);
    return oldest.serverTime > snap.ps.commandTime && oldest.serverTime <= this.cgTime;
  }

  /** The lagometer's samples, taken as frames are drawn and snapshots read. */
  get lagometer(): Lagometer {
    return this.lagometerSamples;
  }

  /**
   * The state the client plays from this frame: the prediction when one replayed a command, and
   * the snapshot's own when there was nothing to replay, `cg_nopredict`, a follower or the first
   * frames. A local game's loopback answers in the same frame, so its snapshots are never behind
   * the newest command and it stays on the snapshots' interpolation.
   */
  private activeState(): PlayerState {
    return this.prediction.moved ? this.prediction.state : this.state;
  }

  /**
   * `cg.time`: the time this frame is drawn at, in milliseconds on the server's clock, and any
   * fraction of one. It is the client's clock, which runs a little behind the newest snapshot, so
   * that there is usually a snapshot on each side of it to draw between.
   */
  get time(): number {
    return this.cgTime;
  }

  /**
   * The camera's current landing dip: its depth, negative, and when it started, on
   * {@link time}'s clock. The gun sinks a quarter of it further, as Q3's does.
   */
  get landing(): Readonly<Pick<CameraFeel, 'landChange' | 'landTime'>> {
    return this.feel;
  }

  /**
   * What happened in the world during the last {@link advance} — impacts and beams — for the
   * presentation layer to draw and play.
   *
   * Read off the entities the snapshot carried rather than handed over by the simulation: an
   * impact is an entity that exists only to say where a shot landed, and this is a client reading
   * it.
   *
   * Valid until the next `advance`, which clears it. Frame-scoped on purpose: an effect is
   * something that just happened, and a renderer that misses one has missed the frame it
   * belonged to.
   */
  get effects(): readonly WorldEffect[] {
    return this.frameEffects;
  }

  /**
   * `CG_Respawn`: the player came back during the last {@link advance}.
   *
   * A respawn is not an event. Quake 3 reads it off `PERS_SPAWN_COUNT` going up
   * (`cg_playerstate.c:511–513`), which a client that missed the snapshot it happened on still
   * sees, where an event would already have been dropped. Frame-scoped, like {@link effects}.
   */
  get respawned(): boolean {
    return this.respawnedThisFrame;
  }

  /**
   * `cg.mapRestart`: the game started over during the last {@link advance}.
   *
   * Also not an event — Quake 3 sends `map_restart` as a server command, because a restart is
   * something the whole client has to act on rather than something that happened in the world.
   * Frame-scoped, like {@link effects}.
   */
  get mapRestart(): boolean {
    return this.restarted;
  }

  /**
   * A new gamestate came during the last {@link advance}: `CG_Init` ran again, and what cgame
   * timed on the last world's clock goes. Frame-scoped, like {@link mapRestart}.
   */
  get gamestateChanged(): boolean {
    return this.newGamestate;
  }

  /**
   * The centre print raised during the last {@link advance}, or null for none: the match's own
   * `cp`, "FIGHT!" at a restart, or "You fragged" at a kill. A later one replaces an earlier, as
   * `CG_CenterPrint` does.
   *
   * Quake 3's `cp` is a centre print from the server rather than from anything in the world
   * (`cg_servercmds.c:1006–1009`): a team change, a vote, a server's own notice. Each is raised
   * where every other centre print is, by whoever keeps `cg.centerPrint`. Frame-scoped, like
   * {@link mapRestart}.
   */
  get centerPrint(): CenterPrintRequest | null {
    return this.centerPrinted;
  }

  /**
   * The announcer's voices started during the last {@link advance}, oldest first: what the
   * snapshots had to say, and what its queue let out. Frame-scoped, like {@link effects}.
   */
  get voices(): readonly AnnouncerCue[] {
    return this.frameVoices;
  }

  /**
   * The score plums' digits this frame, as `CG_AddScorePlum` draws them, and letting go of any
   * whose time is up or that the view is inside.
   *
   * @param eye - `cg.refdef.vieworg`: the plums turn across it.
   */
  plumSprites(eye: Vec3): FloatSprite[] {
    return this.plums.sprites(this.time, eye);
  }

  /**
   * `cg.rewardStack` and its arrays: the rewards the snapshots have pushed, waiting for the HUD to
   * show them, which it does by moving this on.
   */
  get rewards(): RewardState {
    return this.announcer.rewards;
  }

  /**
   * `cgs.teamChatMsgs` and their ring: the team lines the server has sent, waiting for the HUD's
   * box to show them, which it does by moving this on.
   */
  get teamChat(): TeamChatState {
    return this.teamChatBox;
  }

  /**
   * What the player's own body sounded during the last {@link advance}: pain, deaths, falls,
   * jumps, footsteps and the gib. Frame-scoped, like {@link effects}.
   */
  get playerSounds(): readonly PlayerSound[] {
    return this.frameSounds;
  }

  /**
   * Where the player, or a corpse they left, went to pieces during the last {@link advance}, for
   * `CG_GibPlayer`. Frame-scoped, like {@link effects}.
   */
  get gibOrigins(): readonly Vec3[] {
    return this.frameGibs;
  }

  /**
   * What everyone else sounded during the last {@link advance}: other players' events, and the
   * splat of each corpse that went to pieces, each from its own entity. Frame-scoped, like
   * {@link effects}.
   */
  get entitySounds(): readonly EntitySound[] {
    return this.frameEntitySounds;
  }

  /** The view's reaction to the last hurt: its kick, the blood blob and the HUD head's flinch. */
  get damage(): Readonly<DamageFeedback> {
    return this.playerEvents.damage;
  }

  /** `cg.attackerTime`: when the last hurt came, which the HUD lets go as it would draw it. */
  get attacker(): AttackerState {
    return this.playerEvents.attacker;
  }

  /**
   * `CG_TellAttacker_f`: the command that tells the last attacker the words after
   * `tell_attacker`, or `null` with nobody to tell. A cut command is said to the console.
   *
   * @param argv - `tell_attacker` and its words.
   */
  tellAttacker(argv: readonly string[]): string | null {
    const attacker = this.snap?.ps.persistant[PERS.ATTACKER] ?? -1;
    return tellAttackerCommand(lastAttacker(this.playerEvents.attacker, attacker), argv, (text) =>
      this.console.print(text)
    );
  }

  /**
   * `CG_ScanForCrosshairEntity` from the view this frame is drawn from, with everyone where it
   * draws them: who is under the crosshair, kept for {@link crosshairPlayer}. Nothing is scanned
   * before the first snapshot.
   *
   * @param origin - `cg.refdef.vieworg`.
   * @param angles - The angles its axis is built from.
   */
  scanCrosshair(origin: Vec3, angles: Vec3): Readonly<CrosshairPlayer> {
    const { snap } = this;
    if (snap === null) return this.crosshair;
    const { trace, pointContents, currentState } = this;
    const { clientNum } = snap.ps;
    const scan = { trace, pointContents, currentState, origin, angles, clientNum };
    scanForCrosshairEntity(this.crosshair, scan, this.cgTime);
    return this.crosshair;
  }

  /** `CG_CrosshairPlayer`: who was under the crosshair in the last second, or −1 for nobody. */
  crosshairPlayer(): number {
    return crosshairPlayer(this.crosshair, this.cgTime);
  }

  /** `cent->pe.painTime` and `painDirection`, which twist the body's torso after a hurt. */
  get pain(): { time: number; direction: number } {
    return { time: this.playerEvents.painTime, direction: this.playerEvents.painDirection };
  }

  /** Whether nothing of the body is left to draw: gibbed, until the respawn (`ET_INVISIBLE`). */
  get gibbed(): boolean {
    return this.invisible;
  }

  /**
   * Whether there is a body at all to be drawn behind the camera, which is
   * `BG_PlayerStateToEntityState`'s choice of `ET_PLAYER` over `ET_INVISIBLE`
   * (`bg_misc.c:1574–1581`): a spectator flying free is nobody, and so is everyone at the
   * intermission. {@link gibbed} is the third of its cases.
   *
   * A spectator following somebody is wearing that player's state, so this reads what they read:
   * the body the camera sits behind is the one being followed.
   */
  get bodyDrawn(): boolean {
    const ps = this.activeState();
    return (
      !this.invisible &&
      ps.pmType !== PM_SPECTATOR &&
      ps.pmType !== PM_INTERMISSION
    );
  }

  /**
   * `cg.hyperspace`: the player is predicted inside a teleporter whose teleport the server has not
   * sent yet, so the frame shows a flickering grey for the world, under the gun and the 2D
   * (`cg_view.c:688–690, 815–821`).
   */
  get hyperspace(): boolean {
    return this.prediction.hyperspace;
  }

  /**
   * Simulation time of the most recent shot, in milliseconds, or `-Infinity` if the player
   * has not fired.
   *
   * On the same clock as {@link time}, because that is what the viewmodel compares it
   * against: `CG_MapTorsoToWeaponFrame` runs the recoil off elapsed time since the shot, so
   * the two must be the same clock or the animation plays at the wrong moment — or, with a
   * wall clock against a sim clock, drifts further out the longer the session runs.
   */
  get lastFireTime(): number {
    return this.firedAt;
  }

  /**
   * Simulation time of the railgun's last shot, or `-Infinity`, on the same clock as
   * {@link lastFireTime}: `cent->pe.railFireTime`, which brings the railgun's glow back
   * (`cg_weapons.c:1704–1706`).
   */
  get railFireTime(): number {
    return this.railFiredAt;
  }

  /**
   * The projectiles in flight, as `CG_Missile` draws each this frame: its entity state, and where
   * it is drawn.
   *
   * An entity state is all a client is ever sent about a missile, and all it needs: the trajectory
   * on it answers where the rocket is on any frame. Unlagged's projectile nudge, which Excessive
   * Plus keeps, draws each ahead of that: the player's own by a snapshot gap, and everyone else's
   * by that and `cg_projectileNudge` more, but for a grenade, whose bounce a guess would get
   * wrong, and the hook. One nudged into something is stopped where a trace from its trajectory's
   * point meets it, which is why a nudged rocket can seem to stick in a wall before it bursts.
   */
  missiles(): MissileCentity[] {
    const trace = this.drawnTrace();
    return this.drawnMissiles.map((state) => ({
      state,
      origin: this.placeMissile(state, trace),
      trailTime: this.trailTime(state)
    }));
  }

  /**
   * `cent->trailTime` as `CG_ResetEntity` sets it, at `cg.snap`'s time: the snapshot that made
   * the missile current, or, for one the early transition draws from the next snapshot with
   * nothing to draw it between, the current one, as unlagged's resets it there.
   */
  private trailTime(state: EntityState): number {
    const { snap, nextSnap } = this;
    const { number } = state;
    const early = snap !== null && nextSnap?.byNumber.get(number) === state;
    return early && !this.interpolating.has(number) ? snap.serverTime : this.trailTimes[number];
  }

  /**
   * `CG_CalcEntityLerpPositions`' projectile nudge (`cg_ents.c:1079–1123` in unlagged's), and the
   * ride on a mover after it.
   *
   * @param trace - `CG_Trace`, with everyone where they are drawn this frame.
   */
  private placeMissile(state: EntityState, trace: TraceFn): Vec3 {
    const shift = this.missileShift(state);
    let origin = evaluateTrajectory(state.pos, this.time + shift);
    if (shift !== 0) {
      // "don't let the projectile go through the floor"
      const from = evaluateTrajectory(state.pos, this.time);
      const stop = trace(from, vec3(), vec3(), origin, state.number, MASK.SHOT);
      if (stop.fraction < 1) origin = lerp(from, origin, stop.fraction);
    }
    this.rideMover(state, origin, vec3());
    return origin;
  }

  /** How far ahead of its trajectory a missile is drawn, in milliseconds. */
  private missileShift(state: EntityState): number {
    if (state.eType !== ET.MISSILE || state.weapon === WP.GRAPPLING_HOOK) return 0;
    const gap = this.source.snapshotGap;
    if (state.otherEntityNum === this.source.clientNum) return gap;
    return state.weapon === WP.GRENADE_LAUNCHER ? 0 : this.projectileNudge + gap;
  }

  /**
   * Unlagged's early transition (`CG_AddPacketEntities`), which Excessive Plus keeps: while there
   * is a next snapshot, a slot it last had as a missile or `ET_GENERAL` is drawn from it, or not
   * at all, and never from the current one. So a missile is drawn a snapshot early, one gone from
   * the next is gone a snapshot early, and an explosion goes off as its missile goes.
   */
  private transitionedEarly(number: number): boolean {
    if (this.nextSnap === null) return false;
    const type = this.nextType[number];
    return type === ET.MISSILE || type === ET.GENERAL;
  }

  /** The missiles {@link missiles} draws, read again as either snapshot changes. */
  private readDrawnMissiles(): void {
    const drawn: EntityState[] = [];
    for (const state of this.nextSnap?.entities ?? EMPTY_STATES) {
      if (state.eType === ET.MISSILE) drawn.push(state);
    }
    for (const state of this.worldMissiles) {
      if (!this.transitionedEarly(state.number)) drawn.push(state);
    }
    this.drawnMissiles = drawn.length === 0 ? EMPTY_STATES : drawn;
  }

  /**
   * Every item the snapshot carried, as `CG_Item` draws each: the table slot it carries, where it
   * stands, and when it last came back.
   *
   * An item the server has taken out of the world — one that has been picked up, or one a map's
   * `targetname` keeps hidden — is not in the snapshot at all, so it is not here either.
   */
  items(): ItemCentity[] {
    const items: ItemCentity[] = [];
    for (const state of this.worldItems) {
      // `EF_NODRAW` is how a predicted pickup is hidden from the frame it happens on, before the
      // server's next snapshot leaves the item out.
      if ((state.eFlags & EF_NODRAW) !== 0) continue;
      if (this.transitionedEarly(state.number)) continue;
      const origin = evaluateTrajectory(state.pos, this.time);
      this.rideMover(state, origin, vec3());
      items.push({ state, origin, respawnTime: this.itemRespawnTime[state.number] });
    }
    return items;
  }

  /**
   * Every laser the snapshot carried, as `CG_Beam` draws each (`cg_ents.c:605–622`): its entity's
   * number, and from where it stands to where its beam stopped, as the server last traced it.
   */
  lasers(): DrawnLaser[] {
    return this.worldBeams.map((state) => ({
      key: state.number,
      start: state.pos.trBase,
      end: state.origin2
    }));
  }

  /**
   * Every mover the snapshot carried, as `CG_Mover` hands each to the renderer
   * (`cg_ents.c:571-605`): its inline model where `CG_CalcEntityLerpPositions` puts it this frame,
   * in cgame's floats and carried along whatever it stands on, and its `model2` by the name
   * `CS_MODELS` gives it. One not linked as a brush model would be drawn as a game model, which no
   * game here sends, and is left out.
   *
   * The list and its poses are written again at each call.
   */
  movers(): readonly BrushModelPose[] {
    const { time, moverOrigin: origin, moverAngles: angles, moverPoses, drawnMovers } = this;
    let count = 0;
    for (const state of this.worldMovers) {
      if (state.solid !== SOLID_BMODEL) continue;
      qvmEvaluateTrajectory(state.pos, time, origin);
      qvmEvaluateTrajectory(state.apos, time, angles);
      this.rideMover(state, origin, angles);
      const pose = (moverPoses[count] ??= { model: 0, origin: [0, 0, 0], angles: [0, 0, 0] });
      pose.model = state.modelindex;
      pose.number = state.number;
      pose.origin[0] = origin.x;
      pose.origin[1] = origin.y;
      pose.origin[2] = origin.z;
      pose.angles[0] = angles.x;
      pose.angles[1] = angles.y;
      pose.angles[2] = angles.z;
      const { modelindex2 } = state;
      pose.model2 = modelindex2 ? this.configstring(CONFIGSTRING.MODELS + modelindex2) : undefined;
      pose.constantLight = state.constantLight;
      drawnMovers[count++] = pose;
    }
    drawnMovers.length = count;
    return drawnMovers;
  }

  /**
   * `cg.refdef.areamask` (`cg_view.c:837`): the areas closed to this frame's view, as the current
   * snapshot has them, whatever the camera; none before the first.
   */
  get areamask(): Uint8Array {
    return this.snap?.areamask ?? OPEN_AREAS;
  }

  /**
   * `CS_SHADERSTATE` each time cgame has read it since this was last asked, oldest first: at the
   * end of its load (`CG_Init`, `cg_main.c:1945`) and at each `cs` that changed it
   * (`cg_servercmds.c:366-368`). The world swaps as each lists (`CG_ShaderStateChanged`).
   */
  takeShaderStates(): string[] {
    const states = this.shaderStates;
    this.shaderStates = [];
    return states;
  }

  /**
   * Each `cs` for a `CS_SOUNDS` slot that cgame has read since this was last asked, oldest first:
   * `CG_ConfigStringModified` registers its sound (`cg_servercmds.c:347-350`). A gamestate's are
   * registered with the gamestate, and drop any not taken.
   */
  takeSoundChanges(): SoundChange[] {
    const changes = this.soundChanges;
    this.soundChanges = [];
    return changes;
  }

  /**
   * `CS_MUSIC` as cgame last started the music from it since this was last asked, or `null`:
   * `CG_StartMusic` runs at a `cs` for it (`cg_servercmds.c:303-304`) and at a `map_restart`
   * (`:479`). A gamestate's is started with the gamestate. Of several in a frame the last is
   * taken, since the frame's mix is the first to read what any of them opened.
   */
  takeMusicStart(): string | null {
    const start = this.musicStart;
    this.musicStart = null;
    return start;
  }

  /**
   * `CG_EntityEffects`' and `CG_Speaker`'s part of each packet entity that is neither a player nor
   * a missile (`cg_ents.c:104-138, 206-220`), as `CG_AddPacketEntities` places it this frame: in
   * cgame's floats, and carried along whatever it stands on, as a mover is drawn.
   *
   * The list and its records are written again at each call.
   */
  soundEntities(): readonly SoundCentity[] {
    const { time, moverOrigin: origin, moverAngles: angles, soundPool, sounding } = this;
    let count = 0;
    for (const state of this.worldSounding) {
      if (this.transitionedEarly(state.number)) continue;
      qvmEvaluateTrajectory(state.pos, time, origin);
      qvmEvaluateTrajectory(state.apos, time, angles);
      this.rideMover(state, origin, angles);
      const entity = (soundPool[count] ??= {
        number: 0,
        origin: vec3(),
        soundOrigin: vec3(),
        loopSound: 0,
        speaker: false,
        eventParm: 0,
        frame: 0,
        clientNum: 0
      });
      entity.number = state.number;
      copyInto(origin, entity.origin);
      copyInto(origin, entity.soundOrigin);
      const middle = state.solid === SOLID_BMODEL && this.midpoints.get(state.modelindex);
      if (middle) {
        const into = entity.soundOrigin;
        into.x = f(into.x + middle.x);
        into.y = f(into.y + middle.y);
        into.z = f(into.z + middle.z);
      }
      entity.loopSound = state.loopSound;
      entity.speaker = state.eType === ET.SPEAKER;
      entity.eventParm = state.eventParm;
      entity.frame = state.frame;
      entity.clientNum = state.clientNum;
      sounding[count++] = entity;
    }
    sounding.length = count;
    return sounding;
  }

  /**
   * `cgs.inlineModelMidpoints[modelindex]`: the middle of the inline model's box, in cgame's floats
   * (`cg_main.c:1036-1045`), from the map of the snapshot being read.
   */
  private midpoint(modelindex: number): Vec3 {
    let middle = this.midpoints.get(modelindex);
    if (!middle) {
      const { modelMins: mins, modelMaxs: maxs } = this;
      const { inlineModels } = this.map;
      inlineModels.modelBounds(inlineModels.inlineModel(modelindex), mins, maxs);
      middle = vec3(
        f(mins.x + f(0.5 * f(maxs.x - mins.x))),
        f(mins.y + f(0.5 * f(maxs.y - mins.y))),
        f(mins.z + f(0.5 * f(maxs.z - mins.z)))
      );
      this.midpoints.set(modelindex, middle);
    }
    return middle;
  }

  /**
   * `cgs.clientinfo[clientNum]`: who is in a slot, or `null` for one nobody is in.
   *
   * @param clientNum - The slot: a player's own entity number, or a corpse's `s.clientNum`.
   */
  clientInfo(clientNum: number): ClientInfo | null {
    return this.infos[clientNum] ?? null;
  }

  /** How many clients are drawn in a look: those whose look it is, and those put off in it. */
  wearers(look: PlayerLook): number {
    let count = 0;
    for (const info of this.infos) if (info && sameLook(info.look, look)) count++;
    return count;
  }

  /**
   * `CG_LoadClientInfo` (`cg_players.c:652–734`), as `CG_NewClientInfo` calls it when a client's
   * `CS_PLAYERS` string arrives during play, or `CG_LoadDeferredPlayers` once a look put off is
   * loaded: what they wear is read then, rather than when something first wants to draw them.
   * Reading it is engine work, so it is the renderer's to do — the view says whose look it is and
   * when. Nothing waits on it.
   */
  registerClient: (info: ClientInfo) => void = () => {};

  /**
   * `CG_RegisterClients` (`cg_main.c:1129–1150`), as `CG_Init` runs it under the load
   * (`cg.loading`): everyone the gamestate names, read afresh, the client's own slot first. Nobody
   * is deferred, and a look a client read before them wears is theirs too.
   *
   * @returns each of them in that order, and whether their look is to be loaded
   */
  registerClients(): (GamestateClient & { load: boolean })[] {
    const configstring = (index: number) => this.source.configstring(index);
    const { gametype } = serverInfo(configstring(CONFIGSTRING.SERVERINFO));
    this.registeredGamestate = this.source.gamestateMessageNum;
    this.infoGametype = gametype;
    this.infos.fill(null);
    for (let clientNum = 0; clientNum < MAX_CLIENTS; clientNum++) {
      this.infoStrings[clientNum] = configstring(CONFIGSTRING.PLAYERS + clientNum);
    }
    return gamestateClients(configstring, this.source.clientNum).map(({ clientNum, info }) => {
      const kept = keepClientInfo(info, this.infos, gametype, false);
      this.infos[clientNum] = kept.info;
      return { clientNum, ...kept };
    });
  }

  /**
   * `CG_LoadDeferredPlayers` (`cg_players.c:1075–1092`): everyone drawn in another's look meanwhile
   * is put in their own, and it is loaded. Run each frame the scoreboard has been up a while, and
   * on `loaddeferred`.
   */
  loadDeferredPlayers(): void {
    for (let clientNum = 0; clientNum < MAX_CLIENTS; clientNum++) {
      const info = this.infos[clientNum];
      if (!info?.deferred) continue;
      const loaded = loadClientInfo(info, this.infoGametype);
      this.infos[clientNum] = loaded;
      this.registerClient(loaded);
    }
  }

  /**
   * `cgs.clientinfo[ cg.snap->ps.clientNum ]` while the state on show is somebody else's: the
   * player the client is looking out of, or `null` while it is looking out of its own.
   *
   * A spectator following somebody is handed that player's whole state, with `PMF_FOLLOW` set on
   * the copy (`SpectatorClientEndFrame`, `g_active.c:1073–1080`), and the flag is how Quake 3
   * knows the state is not the viewer's own — `CG_DrawFollow` reads it, and takes the name it
   * draws from the state's `clientNum` rather than from the viewer (`cg_draw.c:2254–2270`).
   *
   * What the client wears, sounds like and is coloured by follows the same slot: `CG_Player`
   * dresses the body it draws from the state's own `clientNum`, "because a single client may
   * have multiple corpses on the level using the same clientinfo" (`cg_players.c:2259–2270`),
   * and the entity it draws for the player is the one built out of the player state. The status
   * bar's head is `cg.snap->ps.clientNum`'s as well (`cg_draw.c:468–469`).
   */
  get followed(): ClientInfo | null {
    if ((this.state.pmFlags & PMF_FOLLOW) === 0) return null;
    return this.clientInfo(this.state.clientNum);
  }

  /**
   * `cg.scores` and `cg.numScores`: the board the last `scores` command carried, or an empty one
   * before any has arrived. A row is joined to its name, team and look through
   * {@link clientInfo}, by the row's slot.
   */
  get scores(): Scores {
    return this.board;
  }

  /**
   * `cgs`' serverinfo, as `CG_ParseServerinfo` fills it (`cg_servercmds.c:155–174`): parsed with
   * the gamestate and again when a `cs` command changes the string (`:306`), not at each read.
   * Shared by every reader, so read-only.
   */
  get serverInfo(): ServerInfo {
    return this.parsedServerInfo;
  }

  /**
   * `cg.killerName`: the client who killed the player during the last {@link advance}, as the
   * scoreboard's "Fragged by" line reads it. Frame-scoped, like {@link effects} — the board's own
   * state keeps the name until its fade runs out, as `cg.killerName` does.
   */
  get killedBy(): string | null {
    return this.killedByThisFrame;
  }

  /**
   * Every player the snapshot carried, as `CG_Player` draws each this frame: other players, living
   * and dead, and every corpse, the player's own among them. The player's own entity is not in a
   * snapshot sent to them, so they are not here.
   *
   * A player is placed between the last two snapshots, as `CG_InterpolateEntityPosition` places
   * one (`cg_ents.c:760–830`), and by the same fraction as the player's own body is. One that has
   * only just come into view, or that teleported, has nowhere to come from, and a corpse, which
   * flies a trajectory of its own, is put wherever that trajectory has got to — as a rocket is.
   * What makes one a corpse rather than a player is what its entity state says: nothing here asks
   * the game module.
   *
   * Each carries what its events left on its slot: its flash, its railgun's glow and its pain.
   */
  players(): PlayerCentity[] {
    const trace = this.drawnTrace();
    const drawn = this.worldPlayers.filter((state) => !this.transitionedEarly(state.number));
    return drawn.map((state) => {
      const { origin, angles } = this.place(state);
      const { number } = state;
      if (number < MAX_CLIENTS) this.keepDrawn(number, origin, angles);
      const flashTime = this.entityMemory.muzzleFlashTime[number];
      const pain = this.entityMemory.pain[number];
      return {
        state,
        origin,
        angles,
        reset: this.resets.has(number),
        flashTime,
        railFireTime: this.entityMemory.railFireTime[number],
        pain: { time: pain.painTime, direction: pain.painDirection },
        bolt: this.playerBolt(state, origin, angles, flashTime, trace)
      };
    });
  }

  /** A client's place as it is drawn, kept in its slot for when it is not sent. */
  private keepDrawn(clientNum: number, origin: Vec3, angles: Vec3): void {
    const kept = this.lastDrawn;
    const at = clientNum * 6;
    kept[at] = origin.x;
    kept[at + 1] = origin.y;
    kept[at + 2] = origin.z;
    kept[at + 3] = angles.x;
    kept[at + 4] = angles.y;
    kept[at + 5] = angles.z;
    this.everDrawn[clientNum] = 1;
  }

  /**
   * Where an entity of the current snapshot is drawn this frame: `CG_CalcEntityLerpPositions`
   * (`cg_ents.c:796–830`).
   *
   * A player in both snapshots is drawn between them, each state where its own snapshot has it
   * (`CG_InterpolateEntityPosition`), sent as `TR_INTERPOLATE` or as `TR_LINEAR_STOP`. Anything
   * else is wherever its trajectory has got to on the frame's clock: a rocket, a corpse, and
   * another player with no next snapshot, whom unlagged's client, and Excessive Plus's, carry on
   * by the velocity the server sent for one snapshot gap, and then hold.
   */
  private place(state: EntityState): { origin: Vec3; angles: Vec3 } {
    const { snap, nextSnap } = this;
    const next = this.interpolating.has(state.number)
      ? nextSnap?.byNumber.get(state.number)
      : undefined;
    const { trType } = state.pos;
    const lerped =
      trType === TR.INTERPOLATE || (trType === TR.LINEAR_STOP && state.number < MAX_CLIENTS);
    if (snap !== null && nextSnap !== null && next !== undefined && lerped) {
      const f = this.frameInterpolation;
      const from = evaluateTrajectory(state.apos, snap.serverTime);
      const to = evaluateTrajectory(next.apos, nextSnap.serverTime);
      return {
        origin: lerp(
          evaluateTrajectory(state.pos, snap.serverTime),
          evaluateTrajectory(next.pos, nextSnap.serverTime),
          f
        ),
        angles: vec3(
          lerpAngle(from.x, to.x, f),
          lerpAngle(from.y, to.y, f),
          lerpAngle(from.z, to.z, f)
        )
      };
    }
    const runOn =
      snap !== null && state.number < MAX_CLIENTS && state.clientNum !== this.state.clientNum;
    const pos = runOn
      ? {
          ...state.pos,
          trType: TR.LINEAR_STOP,
          trTime: snap.serverTime,
          trDuration: this.source.snapshotGap
        }
      : state.pos;
    const placed = trajectoryPlace(state, pos, this.time);
    this.rideMover(state, placed.origin, placed.angles);
    return placed;
  }

  /**
   * `CG_CalcEntityLerpPositions`' last step (`cg_ents.c:824–829`): what its own trajectory placed
   * is carried along whatever mover it stands on, from the current snapshot's time to the frame's,
   * and turned with it.
   *
   * @param origin - Where its trajectory put it, carried in place.
   * @param angles - How it is turned, turned in place.
   */
  private rideMover(state: EntityState, origin: Vec3, angles: Vec3): void {
    const { snap } = this;
    if (snap === null) return;
    const { time, currentState } = this;
    const ground = state.groundEntityNum;
    const from = snap.serverTime;
    adjustPositionForMover(origin, ground, from, time, currentState, origin, angles, angles);
  }

  /** `cg_entities[ n ].currentState`: the current snapshot's entity of a number, if it has one. */
  private readonly currentState = (number: number): EntityState | undefined =>
    this.snap?.byNumber.get(number);

  /**
   * `cg.frameInterpolation` (`cg_ents.c:1055–1068`): how far the drawn time is from the current
   * snapshot toward the next, or 0 with no next one.
   */
  private get frameInterpolation(): number {
    const { snap, nextSnap } = this;
    if (snap === null || nextSnap === null) return 0;
    const delta = nextSnap.serverTime - snap.serverTime;
    return delta === 0 ? 0 : (this.drawnTime - snap.serverTime) / delta;
  }

  /**
   * The time other players are drawn at: the clock as the commands carry it, so the server's
   * rewind puts each where they were drawn.
   */
  private get drawnTime(): number {
    return wireDrawnTime(this.cgTime);
  }

  /**
   * Another player's lightning bolt, while their gun's flash is drawn: `CG_LightningBolt` for a
   * player the client does not predict (`cg_weapons.c:967–1047`).
   *
   * Traced from where they are drawn, at the eye height their legs say — 12 crouched and 26
   * otherwise — 14 units along their view, past themselves, so it stops at whoever else is in
   * the way.
   *
   * @param trace - `CG_Trace`, with everyone where they are drawn this frame.
   */
  private playerBolt(
    state: EntityState,
    origin: Vec3,
    angles: Vec3,
    flashTime: number,
    trace: TraceFn
  ): LightningBolt | null {
    if (state.weapon !== WP.LIGHTNING) return null;
    const firing = (state.eFlags & EF_FIRING) !== 0;
    if (!flashVisible(WP.LIGHTNING, firing, this.time - flashTime)) return null;
    const legs = state.legsAnim & ~ANIM_TOGGLEBIT;
    const crouched = legs === ANIM.LEGS_WALKCR || legs === ANIM.LEGS_IDLECR;
    const viewheight = crouched ? CROUCH_VIEWHEIGHT : DEFAULT_VIEWHEIGHT;
    return lightningBolt(origin, angles, viewheight, trace, state.number);
  }

  /**
   * The lightning bolt to draw this frame, or `null` — `CG_LightningBolt`, which
   * `CG_AddPlayerWeapon` reaches only when the gun's flash is drawn.
   *
   * Traced afresh every frame from the state the camera is drawn from, so the bolt stays on the
   * crosshair while the player moves. Q3 traces from the last server snapshot instead, so online
   * its far end trails. It stops at whoever is in the way, where they are drawn.
   */
  lightningBolt(): LightningBolt | null {
    const ps = this.activeState();
    if (ps.weapon !== WP.LIGHTNING) return null;
    const firing = (ps.eFlags & EF_FIRING) !== 0;
    if (!flashVisible(WP.LIGHTNING, firing, this.time - this.firedAt)) return null;
    const { origin, viewangles, viewheight } = this.sample();
    const trace = this.drawnTrace();
    return lightningBolt(origin, viewangles, viewheight, trace, ps.clientNum);
  }

  /**
   * `CG_Trace` (`cg_predict.c:145–155`) for this frame: the map, then everyone solid, a box where
   * it is drawn and a brush model as {@link clientTrace} stands one.
   */
  readonly trace: TraceFn = (start, mins, maxs, end, skipNumber, mask) =>
    this.placeSolids().trace(start, mins, maxs, end, skipNumber, mask);

  /**
   * `CG_PointContents` (`cg_predict.c:162–193`) for this frame: the map's contents, OR'd with
   * those of every solid brush model where it is drawn.
   */
  readonly pointContents: PointContentsFn = (point, passEntityNum) =>
    this.placeSolids().pointContents(point, passEntityNum);

  /** {@link trace}, as this frame's placement answers it. */
  private drawnTrace(): TraceFn {
    return this.placeSolids().trace;
  }

  /**
   * The solids, each where this frame draws it: placed at the first ask after the snapshots are
   * read, as nothing that places them moves until the next frame's are.
   */
  private placeSolids(): Placement {
    if (this.placement !== null) return this.placement;
    const [first, second] = this.placements;
    const placement = this.aimed?.solids === first.solids ? second : first;
    const { solids } = placement;
    solids.length = Math.min(solids.length, this.solids.length);
    this.solids.forEach((state, index) => {
      const { origin, angles } = this.place(state);
      if (index === solids.length) solids.push(solidEntity(state, origin, angles));
      else placeSolid(solids[index], state, origin, angles);
    });
    this.placement = placement;
    return placement;
  }

  /**
   * Every grappling hook to draw this frame, the player's own and anyone else's —
   * `CG_GrappleTrail`, which `CG_Missile` and `CG_Grapple` run for each hook entity, in flight
   * and once it has caught (`cg_ents.c:414, 524`).
   *
   * Found among the entities rather than asked of the simulation: a hook carries the client who
   * threw it in `s.otherEntityNum`, "use to match beam in client". A pointer starts at its
   * thrower's drawn gun's flash; for when there is none, each carries the player's own shot's
   * muzzle, from the state the camera is drawn from, or `CG_GrappleTrail`'s start on anyone
   * else: 26 up from where they are drawn and 6 down their up vector (`cg_weapons.c:569–572`), or
   * from where they were last drawn while they are not sent, as cgame's slot keeps it. A hook
   * whose thrower has not been drawn on the map starts at itself.
   */
  grappleHooks(): GrappleHook[] {
    const own = this.state.clientNum;
    return this.findHooks().map((hook) => {
      const owner = hook.otherEntityNum;
      const position = evaluateTrajectory(hook.pos, this.time);
      const muzzle = owner === own ? this.ownMuzzle() : this.grappleStart(owner, position);
      return { owner, position, muzzle };
    });
  }

  /** The player's own shot's muzzle point, from the state the camera is drawn from. */
  private ownMuzzle(): Vec3 {
    const { origin, viewangles, viewheight } = this.sample();
    return firingSolution(origin, viewangles, viewheight).muzzle;
  }

  /**
   * `CG_GrappleTrail`'s start on a thrower's body, drawn this frame or last drawn, or the hook
   * itself for one never drawn.
   */
  private grappleStart(owner: number, hook: Vec3): Vec3 {
    const state = this.worldPlayers.find(
      (player) => player.number === owner && !this.transitionedEarly(player.number)
    );
    let origin: Vec3;
    let angles: Vec3;
    if (state !== undefined) {
      ({ origin, angles } = this.place(state));
    } else if (owner >= 0 && owner < MAX_CLIENTS && this.everDrawn[owner]) {
      const kept = this.lastDrawn.subarray(owner * 6, owner * 6 + 6);
      origin = vec3(kept[0], kept[1], kept[2]);
      angles = vec3(kept[3], kept[4], kept[5]);
    } else {
      return hook;
    }
    const { up } = angleVectors(angles);
    return madd(vec3(origin.x, origin.y, origin.z + 26), -6, up);
  }

  /**
   * `map_restart 0`: the match over again on the same map, which is what the menu's Restart does.
   *
   * The command reaches the server, which runs it at the top of its next frame and tells every
   * client in words that it did — so what the view drew of the last game goes when {@link
   * mapRestart} says so, and not when this was called.
   */
  restart(): void {
    this.source.restart();
  }

  /**
   * One drawn frame: the program's, and then `CG_DrawActiveFrame` as far as the view goes
   * (`cg_view.c:761–878`).
   *
   * The program runs once for the frame's whole length, and the client's clock moves on with it.
   * The view then reads the snapshots that clock has reached, in turn, and draws the frame between
   * the last of them and the next.
   *
   * @param realMsec - Real time elapsed since the last call, in milliseconds and any fraction of
   *   one. A paused frame's is 0: nothing runs, and the frame is drawn where the last one was.
   * @param cmd - Input held this frame.
   * @returns The player's own events the frame's snapshots carried, oldest first.
   */
  advance(realMsec: number, cmd: Omit<UserCmd, 'serverTime'>): Event[] {
    const events: Event[] = [];
    this.frameEffects = [];
    this.frameSounds = [];
    this.frameGibs = [];
    this.frameEntitySounds = [];
    this.restarted = false;
    this.newGamestate = false;
    this.centerPrinted = null;
    this.respawnedThisFrame = false;
    this.killedByThisFrame = null;
    this.resets.clear();
    this.pendingTransitions.length = 0;
    // What the last frame read and let go of is written over by this frame's reads. The aimed
    // pair is still read by this frame's early shots, and what is drawn after a new gamestate
    // and before its first snapshot is the last world's, which that pair holds.
    const { aimed } = this;
    this.snapshots.release([this.snap, this.nextSnap, aimed?.snap, aimed?.nextSnap]);

    if (realMsec > 0) this.source.frame(realMsec, cmd);
    const { angles } = cmd;
    this.look = [angleToShort(angles.x), angleToShort(angles.y), angleToShort(angles.z)];

    this.oldTime = this.cgTime;
    this.cgTime = this.source.serverTime;
    this.processSnapshots(events);
    this.placement = null;

    // `CG_PredictPlayerState`, before the view is calculated and the player drawn. Its own
    // transition runs per predicted frame; when there was nothing to replay the snapshots'
    // transitions run instead, as they do with `cg_nopredict`.
    //
    // Its first line clears the teleporter's hyperspace, on every frame, one that predicts
    // nothing included, so a replayed touch is what sets it again.
    this.prediction.hyperspace = false;
    if (this.predicting() && this.prediction.predict(this.predictionFrame())) {
      this.transitionPredicted(events);
      this.pendingTransitions.length = 0;
    } else {
      // Nothing was predicted this frame — `cg_nopredict`, a follower, or no command to replay —
      // so the snapshots' transitions run, and nothing may be read as the prediction's.
      this.prediction.moved = false;
      for (const pending of this.pendingTransitions) {
        this.transitionPlayerState(pending.ps, pending.ops, pending.snapTime, events, false);
      }
      this.pendingTransitions.length = 0;
      // Keep the prediction's baseline on what the snapshots just showed, so a later replay
      // neither fires these events a second time nor takes them for already seen.
      copyPlayerState(this.state, this.prediction.state);
      this.prediction.stateTime = this.snap?.serverTime ?? this.cgTime;
    }
    this.drawn = this.interpolatePlayerState();

    // The early transition's events, as `CG_AddPacketEntities` fires them after the prediction:
    // the next snapshot's missiles and `ET_GENERAL` entities, at the current snapshot's time.
    const { snap: current, nextSnap: next } = this;
    if (current !== null && next !== null) {
      this.readWorld(next.entities.filter(isEarlyType), current.serverTime);
    }

    // `CG_PlayBufferedSounds`, once a frame and on the frame's clock (`cg_view.c:825`).
    this.announcer.play(this.time);
    this.frameVoices = this.announcer.take();

    const { snap, nextSnap } = this;
    if (snap !== null) {
      const time = this.drawnTime;
      this.source.setDrawnFrame(time, snap.serverTime, (nextSnap ?? snap).serverTime);
      this.aimed = {
        time,
        frac: this.frameInterpolation,
        snap,
        nextSnap,
        solids: this.placeSolids().solids,
        runOn: this.source.snapshotGap
      };
      // `CG_AddLagometerFrameInfo`, once a frame drawn in the world (`cg_view.c:845–853`).
      this.lagometerSamples.addFrame(this.cgTime - this.latestSnapshotTime);
    }
    return events;
  }

  /**
   * `CG_ProcessSnapshots` (`cg_snapshot.c:324–399`): read the snapshots the client has, oldest
   * first, until the clock sits between the current one and the next.
   *
   * Each snapshot the clock passes is made current in turn, and whatever it carries happens then,
   * so a frame after a stall plays several. With no next one yet, the current one is all there is
   * to draw.
   */
  private processSnapshots(events: Event[]): void {
    // A gamestate starts cgame over (`CL_InitCGame`): the snapshots are counted from its message,
    // and the last world's are never read as coming before them.
    const gamestate = this.source.gamestateMessageNum;
    if (gamestate !== this.gamestate) {
      this.gamestate = gamestate;
      this.processedSnapshotNum = gamestate;
      this.latestSnapshotNum = 0;
      this.lagometerSamples = new Lagometer();
      this.snap = null;
      this.nextSnap = null;
      this.prediction.reset();
      // The last world's solids are its map's inline models, which this one may not have, and so
      // are its sounds' midpoints.
      this.clearSolidList();
      this.midpoints.clear();
      this.worldSounding = EMPTY_STATES;
      this.readConfigstrings();
      // `CG_Init`'s memset of `cg` (`cg_main.c:1851`): what the last world timed on its clock, or
      // was told, goes with it, and its `CS_WARMUP` is taken without a word.
      this.warmupString = this.configstring(CONFIGSTRING.WARMUP);
      this.announcer.reset(atoi(this.warmupString));
      this.firedAt = Number.NEGATIVE_INFINITY;
      this.railFiredAt = Number.NEGATIVE_INFINITY;
      this.board = EMPTY_SCORES;
      this.crosshair = createCrosshairPlayer();
      // And its memset of `cgs`, the team chat box's lines among it.
      this.teamChatBox = createTeamChat();
      this.newGamestate = true;
      // The client's load has registered its clients already, where there is one.
      if (this.registeredGamestate !== gamestate) {
        for (const { info, load } of this.registerClients()) if (load) this.registerClient(info);
      }
    }

    const latest = this.source.currentSnapshotNumber();
    if (latest < this.latestSnapshotNum) {
      throw new Error('CG_ProcessSnapshots: n < cg.latestSnapshotNum');
    }
    this.latestSnapshotNum = latest;
    this.latestSnapshotTime = this.source.latestSnapshotTime;

    // The first snapshot the player is in. One that says they are not in yet is passed over.
    while (this.snap === null) {
      const snap = this.readNextSnapshot();
      if (snap === null) return;
      if ((snap.snapFlags & SNAPFLAG.NOT_ACTIVE) === 0) this.setInitialSnapshot(snap);
    }

    for (;;) {
      const { snap } = this;
      if (snap === null) throw new Error('CG_ProcessSnapshots: cg.snap == NULL');
      let next = this.nextSnap;
      if (next === null) {
        next = this.readNextSnapshot();
        if (next === null) break;
        this.setNextSnap(snap, next);
        if (next.serverTime < snap.serverTime) {
          throw new Error('CG_ProcessSnapshots: Server time went backwards');
        }
      }
      if (this.cgTime >= snap.serverTime && this.cgTime < next.serverTime) break;
      this.transitionSnapshot(snap, next, events);
    }

    // The clock never draws before the current snapshot: the first frame, whose clock has not
    // started yet, is drawn exactly on it.
    const { snap } = this;
    if (snap !== null && this.cgTime < snap.serverTime) this.cgTime = snap.serverTime;
  }

  /**
   * `CG_ReadNextSnapshot` (`cg_snapshot.c:256–302`): the oldest snapshot not yet read, copied into
   * the view's keeping, or null when there is none. One that was lost is passed over for good. The
   * lagometer takes each, read or lost.
   */
  private readNextSnapshot(): ViewSnapshot | null {
    if (this.latestSnapshotNum > this.processedSnapshotNum + 1000) {
      this.console.print(
        `WARNING: CG_ReadNextSnapshot: way out of range, ${this.latestSnapshotNum} > ` +
          `${this.processedSnapshotNum}\n`
      );
    }
    while (this.processedSnapshotNum < this.latestSnapshotNum) {
      this.processedSnapshotNum++;
      const snap = this.source.snapshot(this.processedSnapshotNum);
      this.lagometerSamples.addSnapshot(snap);
      if (snap !== null) return this.snapshots.copy(snap);
    }
    return null;
  }

  /**
   * `CG_SetInitialSnapshot` (`cg_snapshot.c:83–115`): the first snapshot of a world, which there is
   * nothing before to compare with. Its entities' events fire, and its player state's do not.
   *
   * What the view remembered of the entities goes with the last world, as a new cgame's does.
   */
  private setInitialSnapshot(snap: ViewSnapshot): void {
    this.snap = snap;
    copyPlayerState(snap.ps, this.state);
    this.feel = createCameraFeel(this.state.viewheight);
    this.playerEvents = createPlayerEvents(this.state);
    this.entityEvents = createEntityEvents();
    this.entityMemory = createEntityMemory();
    this.itemRespawnTime = new Float64Array(MAX_GENTITIES);
    this.nextType = new Uint8Array(MAX_GENTITIES);
    this.aimed = null;
    // Every entity of the first snapshot is reset, whatever the last world drew between its pair,
    // and nobody has yet been drawn on this map.
    this.interpolating.clear();
    this.everDrawn.fill(0);
    this.buildSolidLists();

    this.checkWarmup();
    this.executeServerCommands(snap.serverCommandNum);
    this.respawn();
    this.readEntities(snap);
    this.readWorld(this.world, snap.serverTime);
  }

  /**
   * `CG_SetNextSnap` (`cg_snapshot.c:196–243`): the snapshot the clock is heading for, which the
   * frame is drawn toward from the current one.
   *
   * An entity is drawn between the two only if it is in both and has not teleported between them.
   */
  private setNextSnap(snap: ViewSnapshot, next: ViewSnapshot): void {
    this.nextSnap = next;
    this.interpolating.clear();
    for (const state of next.entities) {
      this.nextType[state.number] = state.eType;
      const current = snap.byNumber.get(state.number);
      if (current !== undefined && ((current.eFlags ^ state.eFlags) & EF_TELEPORT_BIT) === 0) {
        this.interpolating.add(state.number);
      }
    }
    this.nextFrameTeleport =
      ((next.ps.eFlags ^ snap.ps.eFlags) & EF_TELEPORT_BIT) !== 0 ||
      // A spectator following somebody else now.
      next.ps.clientNum !== snap.ps.clientNum ||
      // A restart.
      ((next.snapFlags ^ snap.snapFlags) & SNAPFLAG.SERVERCOUNT) !== 0;
    this.readDrawnMissiles();
    this.buildSolidLists();
  }

  /**
   * `CG_BuildSolidList`, as a snapshot is made the first or read as the next: from the snapshot
   * prediction takes its base from, which is the next unless either frame teleports.
   *
   * Quake 3 builds the first snapshot's before that snapshot fills cgame's slots, so its lists
   * are empty until the next snapshot is read; the port's are the first snapshot's.
   */
  private buildSolidLists(): void {
    const { snap, nextSnap } = this;
    if (snap === null) return;
    const teleport = this.nextFrameTeleport || this.prediction.thisFrameTeleport;
    const from = nextSnap !== null && !teleport ? nextSnap : snap;
    buildSolidList(from.entities, snap, nextSnap, this.triggerNumbers, this.solidNumbers);
    this.resolveSolidList();
  }

  /** Both lists emptied, as a new cgame's are. */
  private clearSolidList(): void {
    this.triggerNumbers.length = 0;
    this.solidNumbers.length = 0;
    this.resolveSolidList();
  }

  /**
   * The lists' entities as the current snapshot has each, which is what a trace and a touch read:
   * after each build, and again as each snapshot is made current. A number the current snapshot
   * has not got is passed over.
   */
  private resolveSolidList(): void {
    const { snap } = this;
    const resolve = (numbers: readonly number[]): readonly EntityState[] => {
      const states: EntityState[] = [];
      for (const number of numbers) {
        const state = snap?.byNumber.get(number);
        if (state !== undefined) states.push(state);
      }
      return states.length === 0 ? EMPTY_STATES : states;
    };
    this.worldTriggers = resolve(this.triggerNumbers);
    this.solids = resolve(this.solidNumbers);
    this.placement = null;
  }

  /**
   * `CG_TransitionSnapshot` (`cg_snapshot.c:125–186`): the clock has reached the next snapshot, so
   * it becomes the current one, and everything it carries that the client has not seen happens
   * now — the server commands sent before it, then its entities' events, then the player's own.
   */
  private transitionSnapshot(snap: ViewSnapshot, next: ViewSnapshot, events: Event[]): void {
    // "execute any server string commands before transitioning entities".
    this.executeServerCommands(next.serverCommandNum);

    this.snap = next;
    this.nextSnap = null;
    copyPlayerState(next.ps, this.state);
    this.readEntities(next);
    this.interpolating.clear();
    this.readWorld(this.world, next.serverTime);

    // Teleport checks are irrespective of prediction (`cg_snapshot.c:174–176`): the flag is read
    // by the next replay, which clears the accumulated correction over the discontinuity.
    if (((next.ps.eFlags ^ snap.ps.eFlags) & EF_TELEPORT_BIT) !== 0) {
      this.prediction.thisFrameTeleport = true;
    }

    // With nothing predicted, the player's own events and view changes are the snapshot's, set
    // against the one it replaced. With a prediction running they are held until it has run:
    // a command that moved wins, and a frame with nothing to replay falls back to this.
    if (this.predicting()) {
      const { pendingStates } = this;
      const held = this.pendingTransitions.length;
      if (held === pendingStates.length) pendingStates.push(createPlayerState());
      const ps = copyPlayerState(this.state, pendingStates[held]);
      this.pendingTransitions.push({ ps, ops: snap.ps, snapTime: next.serverTime });
    } else {
      this.transitionPlayerState(this.state, snap.ps, next.serverTime, events, false);
    }
  }

  /**
   * `CG_ParseWarmup`, which `CG_ConfigStringModified` runs as the `cs` that changes `CS_WARMUP`
   * is run: before a `map_restart` sent after it, so a restart into a match played at once has
   * cleared the warmup by the time the restart asks whether to say "fight".
   */
  private checkWarmup(): void {
    const warmup = this.configstring(CONFIGSTRING.WARMUP);
    if (warmup === this.warmupString) return;
    this.warmupString = warmup;
    const { gametype } = this.match();
    if (this.announcer.parseWarmup(atoi(warmup), gametype)) this.centerPrintFight();
  }

  /**
   * `CG_ExecuteNewServerCommands` (`cg_servercmds.c:1126–1133`): the server commands sent before a
   * snapshot, run before it is made current. A restart is something the whole client acts on, so
   * it has to be known before anything is read out of the world it started over.
   */
  private executeServerCommands(upTo: number): void {
    for (const command of this.source.takeServerCommands(upTo)) {
      this.serverCommand(tokenize(command));
    }
  }

  /** `CG_Respawn` (`cg_playerstate.c:194–203`): the player is back, whole. */
  private respawn(): void {
    // "no error decay on player movement": the next replay starts clean, from the older base.
    this.prediction.thisFrameTeleport = true;
    this.respawnedThisFrame = true;
    this.invisible = false;
  }

  /**
   * `CG_TransitionPlayerState` (`cg_playerstate.c:497–536`): what the player's own state changed
   * between this state and the one it replaces.
   *
   * It is called once a predicted frame, with the prediction and the last frame's prediction, or
   * once a snapshot transition when nothing is predicted (`cg_snapshot.c:180–183`). Either way
   * the body is the same, so what differs is whose states go in and how often.
   *
   * @param ps - The state that is current now.
   * @param ops - The one it replaces.
   * @param snapTime - The current snapshot's time, which a hurt's kick is dated by.
   * @param smoothSteps - Whether a step up glides: it does on the predicted path, and not
   *   while the player is drawn between snapshots, which draw the step like the rest of the move.
   */
  private transitionPlayerState(
    ps: PlayerState,
    ops: PlayerState,
    snapTime: number,
    events: Event[],
    smoothSteps: boolean
  ): void {
    const { time } = this;
    // What `CG_CheckPlayerstateEvents` reads of `ops`: where the event sequence had got to before
    // this state, and the external event that was on it then. Everything past those two is new,
    // which is the whole of how a client learns that anything happened.
    const before = { eventSequence: ops.eventSequence, externalEvent: ops.externalEvent };
    let spawnCount = ops.persistant[PERS.SPAWN_COUNT];
    // Whose state this was, which changes when a spectator looks at somebody else.
    const watched = ops.clientNum;
    // And the counters and powerups, which is what `CG_CheckLocalSounds` reads of it.
    const counters: LocalSoundState = { persistant: ops.persistant, powerups: ops.powerups };

    // "check for changing follow mode", where Quake 3 answers `*ops = *ps` — the state before is
    // thrown away and this one put in its place, so that nothing of the last player watched is
    // read as something happening to this one (`cg_playerstate.c:498–503`). The port's `ops` is
    // these four: what the events are counted from, the hurt the feedback is drawn from, the spawn
    // a respawn is counted against — because whoever is being watched now has a spawn count of
    // their own, and reading it as the watcher's would make every change of view a respawn — and
    // what the announcer compares, whose every counter is somebody else's now.
    if (ps.clientNum !== watched) {
      before.eventSequence = ps.eventSequence;
      before.externalEvent = ps.externalEvent;
      this.playerEvents.health = ps.stats[STAT.HEALTH];
      this.playerEvents.damageEvent = ps.damageEvent;
      spawnCount = ps.persistant[PERS.SPAWN_COUNT];
      counters.persistant = ps.persistant;
      counters.powerups = ps.powerups;
      this.prediction.thisFrameTeleport = true;
    }

    if (ps.persistant[PERS.SPAWN_COUNT] !== spawnCount) this.respawn();
    if (this.mapRestartPending) {
      this.mapRestartPending = false;
      this.respawn();
    }

    // `CG_CheckLocalSounds`, which is asked only below the intermission and off the spectator
    // team (`cg_playerstate.c:519–522`).
    if (ps.pmType !== PM_INTERMISSION && ps.persistant[PERS.TEAM] !== TEAM.SPECTATOR) {
      this.announcer.checkLocalSounds(ps, counters, this.match(), time);
    }

    // `CG_CheckPlayerstateEvents`: everything this state carries that the client has to act on,
    // which is one list of events and the health behind them.
    const played = checkPlayerstateEvents(ps, before);
    if (played.some(({ event }) => isStepEvent(eventNumber(event)))) {
      this.stepCommandTime = ps.commandTime;
    }

    // "if we are interpolating, we don't need to smooth steps" (`cg_event.c:633–636`), which is
    // this flag's whole job: the predicted path glides a step, the interpolated one does not.
    transitionCameraFeel(this.feel, ps, played, time, smoothSteps);
    // The hurt's kick is timed from the snapshot, as `cg.damageTime` is (`cg_playerstate.c:181`).
    const out = transitionPlayerEvents(
      this.playerEvents,
      ps,
      played,
      time,
      snapTime,
      Math.random,
      this.pointContents
    );
    // `CG_FireWeapon`: the muzzle flash and the recoil are the player's own event, not something
    // the shot reports back.
    if (played.some(({ event }) => eventNumber(event) === EV.FIRE_WEAPON)) {
      this.firedAt = time;
      if (ps.weapon === WP.RAILGUN) this.railFiredAt = time;
    }
    for (const { event } of played) {
      if (eventNumber(event) === EV.FIRE_WEAPON) this.frameEffects.push(...this.earlyShot(ps));
    }
    this.frameSounds.push(...out.sounds);
    // The player's own jump pad puff, thrown where they are (`CG_EntityEvent`'s `EV_JUMP_PAD`).
    for (const puff of out.puffs) this.frameEffects.push({ type: 'puff', origin: puff });
    if (out.gibbed) {
      this.invisible = true;
      this.frameGibs.push(copy(ps.origin));
    }
    events.push(...played);
  }

  /**
   * Unlagged's `CG_PredictWeaponEffects`, which Excessive Plus keeps: the player's own hitscan shot
   * drawn as it is fired, when `xp_delagWeapons` asks for its weapon. Only the client's own player
   * fires one: a spectator sees the shots of whoever they follow when the server's events come.
   *
   * @param ps - The state that fired, the prediction's or the snapshot's.
   */
  private earlyShot(ps: PlayerState): WorldEffect[] {
    const { clientNum, unlagged } = this.source;
    if (ps.clientNum !== clientNum || !delagged(ps.weapon, this.delagWeapons, unlagged)) return [];
    const { hitscan, shotgun } = this.parsedServerInfo;
    const { aimed } = this;
    const solids = aimed?.solids ?? [];
    const shot = {
      ps,
      seed: this.firingSeed(ps.commandTime),
      trace: clientTrace(this.map, solids),
      hitscan,
      shotgun,
      players: this.eventPlayers(),
      pointContents: clientPointContents(this.map, solids)
    };
    if (this.debugDelag && ps.weapon === WP.RAILGUN && aimed !== null) {
      const report = delagReport(shot, aimed);
      if (report !== null) this.console.print(report);
    }
    return earlyShotEffects(shot);
  }

  /**
   * The seed the server draws a shot from: the drawn time of the command that fired it, the newest
   * whose step the state has reached, or 0 for one gone from the ring.
   *
   * @param commandTime - The firing state's `commandTime`.
   */
  private firingSeed(commandTime: number): number {
    const { commands, pmoveMsec: msec } = this.source;
    const oldest = Math.max(1, commands.cmdNumber - CMD_BACKUP + 1);
    for (let number = commands.cmdNumber; number >= oldest; number--) {
      const cmd = commands.at(number);
      // Rounded up to the step it ran to, as the prediction runs it.
      if (Math.trunc((cmd.serverTime + msec - 1) / msec) * msec <= commandTime) {
        return shotSeed(cmd);
      }
    }
    return 0;
  }

  /**
   * `CG_TransitionPlayerState` on the predicting path (`cg_predict.c:618`), once a frame that
   * replayed a command: against the last frame's prediction, so the respawn, the hurt and the
   * sounds react to the prediction as soon as it happens rather than when a snapshot arrives.
   */
  private transitionPredicted(events: Event[]): void {
    // The hurt's kick is still dated by the newest snapshot, as `cg.damageTime` is.
    this.transitionPlayerState(
      this.prediction.state,
      this.prediction.oldState,
      this.snap !== null ? this.snap.serverTime : this.cgTime,
      events,
      true
    );
  }

  /**
   * Whether this frame predicts: the player's own movement is simulated and drawn from it. A
   * spectator following somebody, and `cg_nopredict`, take the snapshots' interpolation instead
   * (`cg_predict.c:431–440`).
   */
  private predicting(): boolean {
    if (this.noPredict || this.snap === null) return false;
    return (this.snap.ps.pmFlags & PMF_FOLLOW) === 0;
  }

  /** This frame's inputs to `CG_PredictPlayerState`: the base, the ring and the rules. */
  private predictionFrame(): PredictionFrame {
    const { snap, nextSnap } = this;
    if (snap === null) throw new Error('predictionFrame: no snapshot');
    return {
      snap,
      nextSnap,
      nextFrameTeleport: this.nextFrameTeleport,
      cgTime: this.cgTime,
      oldTime: this.oldTime,
      commands: this.source.commands,
      trace: this.drawnTrace(),
      pointContents: this.pointContents,
      rules: this.source.rules,
      pmoveMsec: this.source.pmoveMsec,
      grappleMode: this.source.grappleMode,
      gametype: this.parsedServerInfo.gametype,
      predictItems: this.predictItems,
      showMiss: this.showMiss,
      errorDecay: this.errorDecay,
      triggers: this.worldTriggers,
      inlineModels: this.map.inlineModels,
      currentState: this.currentState,
      print: (text) => this.console.print(text)
    };
  }

  /**
   * The gamestate's configstrings, as the client has them, for cgame's own keeping; and its shader
   * state, which the last gamestate's swaps give way to.
   */
  private readConfigstrings(): void {
    for (let index = 0; index < MAX_CONFIGSTRINGS; index++) {
      this.configstrings[index] = this.source.configstring(index);
    }
    this.parsedServerInfo = serverInfo(this.configstring(CONFIGSTRING.SERVERINFO));
    this.shaderStates = [this.configstring(CONFIGSTRING.SHADERSTATE)];
    this.soundChanges = [];
    this.musicStart = null;
  }

  /** `CG_ConfigString`. */
  private configstring(index: number): string {
    return this.configstrings[index];
  }

  /** "FIGHT!", where `CG_MapRestart` puts it. */
  private centerPrintFight(): void {
    this.centerPrinted = { text: 'FIGHT!', y: FIGHT_Y, charWidth: FIGHT_CHAR_WIDTH };
  }

  /** `cgs`' view of the match, which the limits' warnings read: the mode, limits and scores. */
  private match(): AnnouncerMatch {
    const info = this.parsedServerInfo;
    return {
      gametype: info.gametype,
      fraglimit: info.fraglimit,
      timelimit: info.timelimit,
      levelStartTime: atoi(this.configstring(CONFIGSTRING.LEVEL_START_TIME)),
      scores1: atoi(this.configstring(CONFIGSTRING.SCORES1)),
      scores2: atoi(this.configstring(CONFIGSTRING.SCORES2))
    };
  }

  /**
   * `CG_ServerCommand` (`cg_servercmds.c:995–1115`), for the commands the port's server sends
   * that cgame acts on: a configstring, a restart, a print, a centre print, the scores, and chat
   * and team chat. A `disconnect` is the client's own, taken as cgame asks for it, so the `print`
   * before it is printed first; it ends the match (`CL_GetServerCommand`, `cl_cgame.c:290–297`).
   * Any other is printed as unknown, and one with no name passed over.
   *
   * @param argv - The command, split as `Cmd_TokenizeString` splits it.
   */
  private serverCommand(argv: readonly string[]): void {
    const cmd = argv[0] ?? '';
    switch (cmd) {
      case 'disconnect':
        throw new ServerDisconnect(argv);
      case 'cs': {
        // `CG_ConfigStringModified`: the client took its own copy's change as it handed the
        // command over (`cl_cgame.c:324–329`), and this is cgame's.
        const index = atoi(argv[1] ?? '');
        if (index < 0 || index >= MAX_CONFIGSTRINGS) break;
        this.configstrings[index] = argv.slice(2).join(' ');
        if (index === CONFIGSTRING.SERVERINFO) {
          this.parsedServerInfo = serverInfo(this.configstrings[index]);
        }
        if (index === CONFIGSTRING.WARMUP) this.checkWarmup();
        if (index === CONFIGSTRING.SHADERSTATE) this.shaderStates.push(this.configstrings[index]);
        if (index === CONFIGSTRING.MUSIC) this.musicStart = this.configstrings[index];
        const sound = index - CONFIGSTRING.SOUNDS;
        if (sound >= 0 && sound < MAX_SOUNDS) {
          this.soundChanges.push({ index: sound, name: this.configstrings[index] });
        }
        const player = index - CONFIGSTRING.PLAYERS;
        if (index === CONFIGSTRING.SERVERINFO || (player >= 0 && player < MAX_CLIENTS)) {
          this.readClientInfos();
        }
        break;
      }
      // `CG_LoadDeferredPlayers`, which the game sends when a bot is added mid-match beside a
      // client in its process, misspelt as it has always been.
      case 'loaddefered':
        this.loadDeferredPlayers();
        break;
      case 'map_restart':
        this.console.clearNotify();
        this.restarted = true;
        // `cg.mapRestart`, which the next player state hears of as a respawn.
        this.mapRestartPending = true;
        this.musicStart = this.configstring(CONFIGSTRING.MUSIC);
        // `CG_InitLocalEntities`: what the last game left floating goes with it.
        this.plums.clear();
        if (this.announcer.mapRestart()) this.centerPrintFight();
        break;
      case 'print':
        this.console.print(argv[1] ?? '');
        break;
      case 'cp':
        // Where `CG_UseItem` puts its own message.
        this.centerPrinted = { text: argv[1] ?? '', y: USE_ITEM_Y, charWidth: USE_ITEM_CHAR_WIDTH };
        break;
      case 'scores':
        this.board = parseScores(argv);
        break;
      case 'chat':
        // ioquake3's mute, in a team game alone; id's release mutes it in every game.
        if (this.parsedServerInfo.gametype >= GT.TEAM && this.teamChatsOnly) break;
        this.announcer.talk();
        this.console.print(`${chatText(argv[1] ?? '')}\n`);
        break;
      case 'tchat': {
        this.announcer.talk();
        const text = chatText(argv[1] ?? '');
        addToTeamChat(this.teamChatBox, text, this, this.cgTime);
        this.console.print(`${text}\n`);
        break;
      }
      // "server claimed the command"
      case '':
        break;
      default:
        this.console.print(`Unknown client game command: ${cmd}\n`);
    }
  }

  /**
   * The current snapshot's entities, sorted into the lists anything asks for, since the snapshot
   * is the only thing that moves them.
   *
   * A player or a missile that was not in the last snapshot, or whose teleport bit flipped, is
   * brought into view afresh, as `CG_TransitionEntity` resets one that was not drawn between the
   * two (`cg_snapshot.c:58–72`): a player's body starts over, and a missile's smoke from this
   * snapshot's time.
   */
  private readEntities(snap: ViewSnapshot): void {
    this.world = snap.entities;
    const missiles: EntityState[] = [];
    const players: EntityState[] = [];
    const items: EntityState[] = [];
    const beams: EntityState[] = [];
    const movers: EntityState[] = [];
    const sounding: EntityState[] = [];
    for (const state of this.world) {
      if (state.eType === ET.MISSILE) {
        missiles.push(state);
        if (!this.interpolating.has(state.number)) this.trailTimes[state.number] = snap.serverTime;
        continue;
      }
      if (state.eType === ET.PLAYER) {
        players.push(state);
        if (!this.interpolating.has(state.number)) this.resets.add(state.number);
        continue;
      }
      if (state.eType >= ET.EVENTS) continue;
      sounding.push(state);
      if (state.solid === SOLID_BMODEL) this.midpoint(state.modelindex);
      if (state.eType === ET.ITEM) {
        items.push(state);
      } else if (state.eType === ET.BEAM) {
        beams.push(state);
      } else if (state.eType === ET.MOVER) {
        movers.push(state);
      }
    }
    this.worldMissiles = missiles.length === 0 ? EMPTY_STATES : missiles;
    this.readDrawnMissiles();
    this.worldPlayers = players.length === 0 ? EMPTY_STATES : players;
    this.worldItems = items.length === 0 ? EMPTY_STATES : items;
    this.worldBeams = beams.length === 0 ? EMPTY_STATES : beams;
    this.worldMovers = movers.length === 0 ? EMPTY_STATES : movers;
    this.worldSounding = sounding.length === 0 ? EMPTY_STATES : sounding;
    this.resolveSolidList();
  }

  /**
   * `CG_NewClientInfo` (`cg_players.c:876–1062`) for every slot whose `CS_PLAYERS` string has
   * changed, as a `cs` command changes one during play: outside the load, so a look may be put off.
   */
  private readClientInfos(): void {
    // `cgs.gametype` decides what colours a look is worn in, so a match that changes it dresses
    // everyone again — the strings themselves need not have changed for the looks to.
    const { gametype } = this.parsedServerInfo;
    if (gametype !== this.infoGametype) {
      this.infoGametype = gametype;
      this.infoStrings.fill(UNREAD);
    }
    for (let clientNum = 0; clientNum < MAX_CLIENTS; clientNum++) {
      const configstring = this.configstring(CONFIGSTRING.PLAYERS + clientNum);
      if (configstring === this.infoStrings[clientNum]) continue;
      this.infoStrings[clientNum] = configstring;
      const info = newClientInfo(configstring, gametype);
      // An empty string is "player just left", which has nothing to read (`cg_players.c:886–890`).
      if (!info) {
        this.infos[clientNum] = null;
        continue;
      }
      const kept = keepClientInfo(info, this.infos, gametype, this.deferPlayers);
      this.infos[clientNum] = kept.info;
      if (kept.load) this.registerClient(kept.info);
    }
  }

  /**
   * `CG_CheckEvents` over everything the snapshot carried, and what each event means on screen.
   *
   * The client's own entity is not among them, because the server leaves it out: what happens to a
   * player reaches them on their player state, and reading it here as well would play it twice.
   *
   * Each event happens where its entity was as the snapshot was taken, and what it starts starts
   * on the frame's clock, as `cg.time` dates it. A shotgun's pellets are traced, and what a point
   * is inside of asked, with everyone where the snapshot has them; Quake 3's meet everyone where
   * the last frame drew them.
   *
   * @param entities - The entities whose events are read: a snapshot's, or the next one's that
   *   transition early.
   * @param snapTime - The current snapshot's server time, in milliseconds.
   */
  private readWorld(entities: readonly EntityState[], snapTime: number): void {
    const { time } = this;
    const happened = checkEntityEvents(this.entityEvents, entities, snapTime, (modelindex) =>
      this.midpoint(modelindex)
    );
    // `CG_EntityEvent`'s `EV_ITEM_RESPAWN`: the item is drawn scaling up from this moment.
    for (const { event, state } of happened) {
      if (event === EV.ITEM_RESPAWN && state.eType === ET.ITEM) {
        this.itemRespawnTime[state.number] = time;
      }
    }
    const solids = this.solids.map((state) => {
      const { origin, angles } = trajectoryPlace(state, state.pos, snapTime);
      return solidEntity(state, origin, angles);
    });
    const trace = clientTrace(this.map, solids);
    const pointContents = clientPointContents(this.map, solids);
    // The player's own shots that were drawn as they were fired are not drawn again.
    const { clientNum, unlagged } = this.source;
    const drawn = happened.filter(
      (happening) => !drawnEarly(happening, clientNum, this.delagWeapons, unlagged)
    );
    // A sound the match named, which an event carries as its `CS_SOUNDS` slot rather than as a
    // file name (`CG_EntityEvent`'s `EV_GENERAL_SOUND`).
    const gameSound = (index: number): string => this.configstring(CONFIGSTRING.SOUNDS + index);
    this.frameEffects.push(
      ...transitionEntityEvents(
        drawn,
        trace,
        this.eventPlayers(),
        gameSound,
        this.parsedServerInfo.shotgun,
        pointContents
      )
    );

    // Everyone else's events: other players', and a corpse's going to pieces, which is heard and
    // seen where the corpse lies rather than where the player is standing.
    const others = otherPlayerEvents(
      this.entityMemory,
      happened,
      this.state.clientNum,
      time,
      Math.random,
      gameSound,
      pointContents
    );
    this.frameEntitySounds.push(...others.sounds);
    this.frameGibs.push(...others.gibs);
    for (const puff of others.puffs) this.frameEffects.push({ type: 'puff', origin: puff });
    addPlayerWeapons(this.entityMemory, this.worldPlayers);

    // `CG_Obituary`, which is only words, and `EV_GLOBAL_TEAM_SOUND`, which is the announcer's.
    for (const { event, parm, state } of happened) {
      if (event === EV.GLOBAL_TEAM_SOUND) this.announcer.teamSound(parm, this.state);
      if (event === EV.SCOREPLUM) {
        const { otherEntityNum, pos } = state;
        const own = this.state.clientNum;
        this.plums.add(otherEntityNum, pos.trBase, state.time, time, own, this.scorePlums);
      }
      if (event !== EV.OBITUARY) continue;
      const line = obituary(
        parm,
        state.otherEntityNum,
        state.otherEntityNum2,
        (index) => this.configstring(index),
        this.gender
      );
      if (line !== null) this.console.print(line);

      const fragged = fragMessage(
        parm,
        state.otherEntityNum,
        state.otherEntityNum2,
        this.state.clientNum,
        (index) => this.configstring(index),
        this.infoGametype,
        this.state.persistant[PERS.RANK],
        this.state.persistant[PERS.SCORE]
      );
      if (fragged !== null) {
        this.centerPrinted = { text: fragged, y: USE_ITEM_Y, charWidth: USE_ITEM_CHAR_WIDTH };
      }

      // `CG_Obituary` keeps the killer's name for the dead player's scoreboard (`cg_event.c:243–245`).
      if (state.otherEntityNum === this.state.clientNum) {
        const killer = killerName(state.otherEntityNum2, (index) => this.configstring(index));
        if (killer !== null) this.killedByThisFrame = killer;
      }
    }
  }

  /** What an event reads of the players: who this client is, their colours, and who is one. */
  private eventPlayers(): Players {
    return {
      own: this.state.clientNum,
      // An empty slot's clientinfo is all zeroes, so a rail nobody's is black.
      color: (clientNum) => this.clientInfo(clientNum)?.color1 ?? [0, 0, 0],
      isPlayer: (number) => this.worldPlayers.some((state) => state.number === number)
    };
  }

  /**
   * Every hook drawn this frame, in flight or caught: `ET_MISSILE` while it flies and
   * `ET_GRAPPLE` once it has caught, which are the two types `CG_AddPacketEntities` draws the
   * cable from.
   */
  private findHooks(): EntityState[] {
    const isHook = (state: EntityState) => state.weapon === WP.GRAPPLING_HOOK;
    const flying = this.drawnMissiles.filter(isHook);
    const caught = this.world.filter(
      (state) =>
        state.eType === ET.GRAPPLE && isHook(state) && !this.transitionedEarly(state.number)
    );
    return [...flying, ...caught];
  }

  /** The player state to draw this frame, as {@link interpolatePlayerState} made it. */
  sample(): ViewSample {
    const { drawn } = this;
    return {
      ...drawn,
      origin: copy(drawn.origin),
      velocity: copy(drawn.velocity),
      viewangles: copy(drawn.viewangles)
    };
  }

  /**
   * `CG_InterpolatePlayerState` (`cg_predict.c:204–254`): the player as this frame draws them.
   *
   * The current snapshot's state, with its origin, velocity and bob carried toward the next
   * snapshot's by where the clock is between them. Nothing is drawn past the newest snapshot the
   * clock has reached, nor across a teleport before it is current. The angles are this frame's own,
   * turned by the delta angles the server set, so the view turns with the mouse at once; a
   * spectator following somebody looks through their angles, drawn between like the rest.
   */
  private interpolatePlayerState(): ViewSample {
    // A command replayed: the player is drawn from the prediction, whole steps blended.
    // Nothing replayed: the snapshots' interpolation carries the frame, as `cg_nopredict` does.
    if (this.prediction.moved) return this.predictedSample();
    const ps = this.state;
    const following = (ps.pmFlags & PMF_FOLLOW) !== 0;
    const { look, snap, nextSnap } = this;
    const drawn: ViewSample = {
      origin: copy(ps.origin),
      velocity: copy(ps.velocity),
      viewangles: !following && look !== null ? updateViewAngles(ps, look) : copy(ps.viewangles),
      viewheight: ps.viewheight,
      bobCycle: ps.bobCycle,
      ducked: (ps.pmFlags & PMF_DUCKED) !== 0
    };
    if (snap === null || nextSnap === null || this.nextFrameTeleport) return drawn;
    if (nextSnap.serverTime <= snap.serverTime) return drawn;

    const prev = snap.ps;
    const next = nextSnap.ps;
    const f = (this.cgTime - snap.serverTime) / (nextSnap.serverTime - snap.serverTime);
    // The bob counts in a byte, so a next one below this one has wrapped.
    const bob = next.bobCycle < prev.bobCycle ? next.bobCycle + 256 : next.bobCycle;
    drawn.bobCycle = Math.trunc(prev.bobCycle + f * (bob - prev.bobCycle));
    drawn.origin = lerp(prev.origin, next.origin, f);
    drawn.velocity = lerp(prev.velocity, next.velocity, f);
    if (following) {
      drawn.viewangles = vec3(
        lerpAngle(prev.viewangles.x, next.viewangles.x, f),
        lerpAngle(prev.viewangles.y, next.viewangles.y, f),
        lerpAngle(prev.viewangles.z, next.viewangles.z, f)
      );
    }
    return drawn;
  }

  /**
   * The player as the prediction draws them: the newest whole step's state, with its
   * position blended toward it from the step before by where the clock stands between the two.
   * Both ends are positions the move produced, so the drawn position is the one the physics has
   * for the instant drawn, and a step is answered by the camera's own glide.
   *
   * The angles are the mouse's — the replay turned the predicted state — and a teleport or a
   * respawn snaps rather than glides, because there is no motion between the two steps to blend.
   */
  private predictedSample(): ViewSample {
    const { state, previousStep, moverTurn } = this.prediction;
    const { look } = this;
    const drawn: ViewSample = {
      origin: copy(state.origin),
      velocity: copy(state.velocity),
      // The angles are the mouse's, fresh each frame. A frame that made no step has the
      // mouse in no command yet, so the drawn view turns from the frame's own command, as the
      // interpolated path does. The mover the player rides turns them on to the frame's time, as
      // it turned the predicted state's.
      viewangles:
        look !== null ? turned(updateViewAngles(state, look), moverTurn) : copy(state.viewangles),
      viewheight: state.viewheight,
      bobCycle: state.bobCycle,
      ducked: (state.pmFlags & PMF_DUCKED) !== 0
    };
    // A step is a teleport rather than motion: the position snaps to the step it reached
    // and the eye's own glide carries the rise. The stair lies between the two steps the
    // frame blends, so the pair is tested — as the teleport bit is just below — rather than the
    // frame's own events, which play on a single frame above 125 Hz and would let the blend cross
    // the stair on the frames that redraw the same pair.
    if (
      this.stepCommandTime > previousStep.commandTime &&
      this.stepCommandTime <= state.commandTime
    ) {
      return drawn;
    }
    const span = state.commandTime - previousStep.commandTime;
    if (span <= 0) return drawn;
    if (((previousStep.eFlags ^ state.eFlags) & EF_TELEPORT_BIT) !== 0) return drawn;
    const f = Math.min(Math.max((this.cgTime - previousStep.commandTime) / span, 0), 1);
    drawn.origin = lerp(previousStep.origin, state.origin, f);
    return drawn;
  }

  /**
   * Whether the camera is behind the body this frame rather than in its eyes:
   * `cg.renderingThirdPerson` (`cg_view.c:804–805`), never for a spectator, as ioquake3 has it.
   * The body then shows, and the view weapon does not.
   */
  get renderingThirdPerson(): boolean {
    if (this.state.persistant[PERS.TEAM] === TEAM.SPECTATOR) return false;
    return this.thirdPerson || this.dead;
  }

  /**
   * Dead, as the camera reads it: no health. A spectator's flight is the exception, since Clan
   * Arena's dead fly as spectators and carry their health into it; they look out of their own
   * eyes like any spectator.
   */
  private get dead(): boolean {
    const ps = this.activeState();
    return ps.stats[STAT.HEALTH] <= 0 && ps.pmType !== PM_SPECTATOR;
  }

  /**
   * Where to put the camera this frame, in Q3 units: in the player's eyes, kicked by the last
   * hurt, or behind them, facing the dead yaw once they are dead. At the intermission it is where
   * the state stands and looks, with nothing added, whoever is watching (`cg_view.c:641-646`).
   */
  view(): FirstPersonView {
    const sample = this.sample();
    if (this.activeState().pmType === PM_INTERMISSION) {
      return { origin: sample.origin, angles: sample.viewangles };
    }
    // `CG_CalcViewValues`: a prediction correction is added to the camera's origin only, before
    // the view's own offsets. The state and the drawn body never move with it.
    if (this.prediction.moved) {
      const offset = this.prediction.cameraOffset(this.cgTime, this.errorDecay);
      sample.origin = vec3(
        sample.origin.x + offset.x,
        sample.origin.y + offset.y,
        sample.origin.z + offset.z
      );
    }
    if (!this.renderingThirdPerson) {
      return firstPersonView(this.feel, sample, this.time, this.playerEvents.damage);
    }
    return thirdPersonView(
      {
        origin: sample.origin,
        viewangles: sample.viewangles,
        viewheight: sample.viewheight,
        deadYaw: this.dead ? this.activeState().stats[STAT.DEAD_YAW] : null,
        clientNum: this.activeState().clientNum
      },
      this.trace
    );
  }
}

/** A frame's solids, each where it is drawn, and `CG_Trace` and `CG_PointContents` through them. */
interface Placement {
  solids: SolidEntity[];
  trace: TraceFn;
  pointContents: PointContentsFn;
}

/** An empty placement, its trace and contents reading whatever its list holds when called. */
function placementFor(map: ClientWorld): Placement {
  const solids: SolidEntity[] = [];
  return {
    solids,
    trace: clientTrace(map, solids),
    pointContents: clientPointContents(map, solids)
  };
}

/**
 * Where an entity's trajectories have it at a time, `BG_EvaluateTrajectory` on `pos` and `apos`.
 * cgame's evaluator is a QVM's, so a mover is placed in its floats, where the server's put it.
 *
 * @param pos - The trajectory it is placed by: its own, or one it is run on by.
 */
function trajectoryPlace(
  state: EntityState,
  pos: Trajectory,
  time: number
): { origin: Vec3; angles: Vec3 } {
  if (state.eType !== ET.MOVER) {
    return { origin: evaluateTrajectory(pos, time), angles: evaluateTrajectory(state.apos, time) };
  }
  const origin = vec3();
  const angles = vec3();
  qvmEvaluateTrajectory(pos, time, origin);
  qvmEvaluateTrajectory(state.apos, time, angles);
  return { origin, angles };
}

/** A solid entity of its own, as a state has it, drawn at `origin` and turned by `angles`. */
function solidEntity(state: EntityState, origin: Vec3, angles: Vec3): SolidEntity {
  const solid: SolidEntity = {
    number: 0,
    solid: 0,
    modelindex: 0,
    pos: createTrajectory(),
    origin,
    angles
  };
  placeSolid(solid, state, origin, angles);
  return solid;
}

/** A solid entity written over with a state, drawn at `origin` and turned by `angles`. */
function placeSolid(solid: SolidEntity, state: EntityState, origin: Vec3, angles: Vec3): void {
  solid.number = state.number;
  solid.solid = state.solid;
  solid.modelindex = state.modelindex;
  copyTrajectory(state.pos, solid.pos);
  solid.origin = origin;
  solid.angles = angles;
}

/** Angles turned by a turn, in cgame's floats. */
function turned(angles: Vec3, turn: Vec3): Vec3 {
  return vec3(f(angles.x + turn.x), f(angles.y + turn.y), f(angles.z + turn.z));
}

/** `VectorCopy`. */
function copyInto(from: Vec3, to: Vec3): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}

/** The entity types unlagged's early transition draws from the next snapshot at once. */
function isEarlyType(state: EntityState): boolean {
  return state.eType === ET.MISSILE || state.eType === ET.GENERAL;
}

/**
 * A chat line as cgame prints it: cut to `MAX_SAY_TEXT` less its NUL, markers and all, then the
 * markers taken out (`Q_strncpyz`, `CG_RemoveChatEscapeChar`; `cg_servercmds.c:975–985, 1036`).
 */
function chatText(line: string): string {
  return line.slice(0, MAX_SAY_TEXT - 1).replaceAll(CHAT_ESCAPE, '');
}

/**
 * `PM_UpdateViewAngles` (`bg_pmove.c:1796–1824`), on the client's copy of the state: the
 * command's angles turned by the delta angles the server set, the pitch held short of straight up
 * and down. Nobody turns at the intermission, and a dead player's view does not move at all.
 *
 * @param angles - The command's angles, as shorts.
 */
function updateViewAngles(ps: PlayerState, angles: readonly number[]): Vec3 {
  if (ps.pmType === PM_INTERMISSION) return copy(ps.viewangles);
  if (ps.pmType !== PM_SPECTATOR && ps.stats[STAT.HEALTH] <= 0) return copy(ps.viewangles);
  const { deltaAngles } = ps;
  const pitch = toShort(angles[0] + deltaAngles.x);
  return vec3(
    shortToAngle(Math.min(Math.max(pitch, -PITCH_LIMIT_SHORT), PITCH_LIMIT_SHORT)),
    shortToAngle(toShort(angles[1] + deltaAngles.y)),
    shortToAngle(toShort(angles[2] + deltaAngles.z))
  );
}
