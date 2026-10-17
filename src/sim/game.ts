import { CONFIGSTRING, MAX_MODELS, MAX_SOUNDS } from '../net/commands';
import type { CvarStore } from '../net/cvar';
import { copyPlayerState } from '../net/delta';
import { infoValidate, infoValueForKey } from '../net/info';
import {
  createNetUserCmd,
  createPlayerState,
  ENTITYNUM_NONE,
  ENTITYNUM_WORLD,
  MAX_CLIENTS,
  type PlayerState
} from '../net/protocol';
import { SV_FPS, snapshotMsec } from '../net/snapshot-rate';
import type { InfoFile } from '../formats/arena';
import { atof } from '../formats/c-scan';
import { cleanStr } from '../formats/color-codes';
import { spawnString, type SpawnVars } from '../formats/entity-text';
import { tokenize } from '../formats/q3config';
import {
  clearClientForConnect,
  clearClientForSpawn,
  CON,
  copyNetUserCmd,
  isSpectator,
  MAX_NETNAME,
  NOT_SAVED,
  setClientViewAngle,
  shortAngle,
  SPECTATOR,
  TEAM_STATE,
  type GameClient
} from './client';
import {
  CA_LOADOUT,
  CA_ROUND_WARMUP,
  CA_TEAM_NAMES,
  CA_WIN_DELAY
} from './clan-arena';
import {
  BUTTON_AFFIRMATIVE,
  BUTTON_ATTACK,
  BUTTON_GESTURE,
  BUTTON_TALK,
  BUTTON_USE_HOLDABLE,
  CONTENTS,
  DF_NO_FOOTSTEPS,
  EF_AWARDS,
  EF_FIRING,
  EF_TALK,
  EF_TELEPORT_BIT,
  EF_VOTED,
  EF_TEAMVOTED,
  FL,
  GT,
  MASK,
  MOD,
  PERS,
  PM_DEAD,
  PM_FREEZE,
  PM_INTERMISSION,
  PM_SPECTATOR,
  PMF_DUCKED,
  PMF_FOLLOW,
  PMF_SCOREBOARD,
  PMOVE_MSEC,
  PMOVE_MSEC_MAX,
  PMOVE_MSEC_MIN,
  RANK_TIED_FLAG,
  SCORE_NOT_PRESENT,
  STAT,
  TEAM
} from './constants';
import { copyToBodyQue } from './body-queue';
import { botInfoByName, botUserinfo, BotSpawnQueue, loadBots, type BotRequest } from './bots';
import { EV } from './events';
import { copyVec, ET, playerStateToEntityState, SVF, type GameEntity } from './game-entity';
import type { GameModule, GameTraps } from './game-module';
import { INTERMISSION_DELAY_TIME, Level } from './level';
import {
  initClientSessionData,
  initWorldSession,
  readClientSessionData,
  writeClientSessionData,
  writeSessionData
} from './session';
import { clampViewPitchDelta, pmove } from './pmove';
import { CpmaPmove } from './pmove-cpma';
import { vectorToAngles } from './pmove-math';
import { checkWorldspawn, spawnEntitiesFromString, spawnEntityFromVars } from './spawn';
import { clearRegisteredItems, saveRegisteredItems } from './item-spawn';
import { tossClientItems } from './drops';
import { runItem } from './item-run';
import { runMover } from './mover-push';
import { WEAPON_RESPAWN_DEFAULT, WEAPON_TEAM_RESPAWN_DEFAULT } from './item-touch';
import { findItem, itemIndex, PW } from './items';
import { expirePowerups } from './powerups';
import { AIR_OUT_TIME, FRY_SOUND, PlayerLife, type DeathCounter } from './player-life';
import { RULE_CVARS, RuleCvars } from './rules';
import { smoothClient } from './smooth-clients';
import { findTeams, pickTarget, useTargets } from './targets';
import { sendPendingPredictableEvents, tempEntity } from './temp-entity';
import { initTeamGame, pickupTeam } from './team';
import { killBox, TELEFRAG_DAMAGE, teleportPlayer } from './teleport';
import { clientImpacts, touchTriggers } from './triggers';
import { playerBounds, type PointContentsFn, type TraceFn } from './types';
import { resetHistory, samplePing, storeHistory } from './unlagged';
import { add, copy, sub, vec3, type Vec3 } from './vec3';
import { WP } from './weapons/constants';
import { Grapple, GRAPPLE_TYPES, type GrappleMode } from './weapons/grapple';
import { runMissile } from './weapons/missile';
import { WeaponSystem } from './weapons/weapon-system';

/**
 * The game module: `g_main.c`'s exports and the client's life from connect to disconnect
 * (`g_client.c`).
 *
 * This is the far side of the seam the host calls across. It owns the match ({@link Level}), a
 * slot per client, and the six moments a client passes through — connect, begin, spawn, think,
 * respawn, disconnect — each of which is one of Quake 3's `GAME_*` entry points and none of which
 * the host knows anything about beyond calling it.
 *
 * **The match has states, and they are two functions.** {@link Game.checkTournament} decides
 * whether the match is waiting for players, counting down or being played, and
 * {@link Game.checkExitRules} decides whether it is over. Both run at the end of every frame, and
 * nothing else in the game module holds a state machine — which is why a match's state is
 * readable as `level.warmupTime` and `level.intermissiontime` rather than as a name.
 *
 * **A match that is over is still running.** The intermission is not a pause: the frame keeps
 * running, the clients keep sending commands, and what has changed is that nobody is in the world
 * to use them. {@link Game.moveClientToIntermission} is what takes them out of it, and
 * {@link Game.checkIntermissionExit} is the only thing that reads a command while they are gone.
 *
 * **The match's settings are cvars, and a map start is when they are read.** {@link GAME_CVARS}
 * is `gameCvarTable`, and {@link Game.registerCvars} runs down it at every {@link Game.init}. Two
 * of them are read there and nowhere else — `g_gametype` and `sv_maxclients` — and that is the
 * whole of what latching means: the console takes a new value at once, and the match keeps
 * the one it started with until a map load hands it over. The rest are read where they are used,
 * and {@link Game.updateCvars} announces the ones a match is run to as they change.
 *
 * **Quake 3 writes a game log and the port does not.** `G_LogPrintf` puts the warmup, the exit
 * and every final score into a file a server operator reads afterwards; there is nowhere here for
 * it to go, so {@link Game.logExit} keeps the effects the match depends on and drops the writing.
 *
 * **The player moves here.** {@link Game.clientThink} is `ClientThink_real`: the command becomes
 * the client's, the buttons are latched, the move runs over the client's own `playerState_t`
 * against the world the host traces, and the life around it — the landings that hurt, the drain,
 * the respawn — is {@link PlayerLife}'s, one per slot. What a client is sent is rebuilt from the
 * player state at the end of the frame, where `ClientEndFrame` rebuilds it.
 *
 * **A shot is fired here and hurts through `G_Damage`.** `ClientEvents`' `FireWeapon` is each
 * slot's {@link WeaponSystem}, and whatever a shot, a missile, a fall or a telefrag reaches is
 * hurt the same way, whoever it is. A player's death is their own, through the `player_die` their
 * spawn gave them.
 */

/**
 * `gameCvarTable` (`g_main.c:99–184`), reduced to the cvars the port's game module reads.
 *
 * `track` is Quake 3's `trackChange`: a change to one of these is announced to every client, so
 * that nobody has to wonder why the match just ended. The two that latch are the two that are not
 * announced, because a latched cvar is not yet what the match is being run to.
 */
export const GAME_CVARS: readonly { name: string; default: string; track: boolean }[] = [
  { name: 'g_gametype', default: '0', track: false },
  { name: 'sv_maxclients', default: '8', track: false },
  { name: 'g_maxGameClients', default: '0', track: false },
  { name: 'fraglimit', default: '20', track: true },
  { name: 'timelimit', default: '0', track: true },
  { name: 'capturelimit', default: '8', track: true },
  // Clan Arena's, under Quake Live's name: CPMA has one `limit` for every mode.
  { name: 'roundlimit', default: '5', track: true },
  // Announced, because a hit that suddenly hurts your own side is worth knowing about
  // (`g_main.c:122`).
  { name: 'g_friendlyFire', default: '0', track: true },
  // The two that decide a side, and neither is announced: joining one is the client's own doing
  // and the match says so itself (`g_main.c:124–125`).
  { name: 'g_teamAutoJoin', default: '0', track: false },
  { name: 'g_teamForceBalance', default: '0', track: false },
  { name: 'g_warmup', default: '20', track: true },
  { name: 'g_doWarmup', default: '0', track: true },
  { name: 'g_forcerespawn', default: '20', track: true },
  { name: 'g_inactivity', default: '0', track: true },
  { name: 'g_speed', default: '320', track: false },
  { name: 'g_gravity', default: '800', track: false },
  { name: 'pmove_msec', default: String(PMOVE_MSEC), track: false },
  // Q3 spells the first of these in lower case and withholds the capital from it (`g_main.c:145`).
  { name: 'g_weaponrespawn', default: String(WEAPON_RESPAWN_DEFAULT), track: false },
  { name: 'g_weaponTeamRespawn', default: String(WEAPON_TEAM_RESPAWN_DEFAULT), track: false },
  // The server's message of the day, which a client connecting from elsewhere reads as the map
  // loads (`g_main.c:152`).
  { name: 'g_motd', default: '', track: false },
  { name: 'g_allowGrapple', default: '1', track: false },
  // The name of the preset that last ran, which the preset writes and nothing reads to apply.
  { name: 'g_gamepreset', default: 'VQ3', track: false },
  { name: 'pcq_god', default: '0', track: false },
  // Q3's own spawn is the default, since the map's items hand weapons out. The aid is for
  // playing a map with no items and for the tests that want a gun with ammo in it.
  { name: 'pcq_spawnWeapons', default: '0', track: false },
  { name: 'pcq_spawnArmor', default: '0', track: false },
  { name: 'g_restarted', default: '0', track: false },
  { name: 'g_password', default: '', track: false },
  // Whether `g_password` is set, for the serverinfo; the match keeps it in step (`g_main.c:137`).
  { name: 'g_needpass', default: '0', track: false },
  // Players whose commands are a frame or two late slid on at the frame's end, as unlagged's and
  // Excessive Plus's servers do (`g_main.c:176`).
  { name: 'g_smoothClients', default: '1', track: false },
  // Excessive Plus's lag compensation: the hitscan weapons whose shots move everyone else back to
  // where the shooter drew them, every one at 1 and otherwise those with their `1 << weapon` bit.
  { name: 'xp_unlagged', default: '1', track: false },
  // Unlagged's too: the server's frames a second, which is the most snapshots a client is sent.
  { name: 'sv_fps', default: String(SV_FPS), track: false },
  // The rules of play, which are read through their own record rather than where they are used.
  ...RULE_CVARS
];

/** `MAX_SPAWN_POINTS` (`g_client.c:142`): how many the furthest-point search will keep. */
export const MAX_SPAWN_POINTS = 128;

/** `MAX_TEAM_SPAWN_POINTS` (`g_team.c:967`): how many of a side's own spots are looked at. */
export const MAX_TEAM_SPAWN_POINTS = 32;

/** A spawn stands the player 9 units above the spot itself (`g_client.c:246`, `:255`). */
export const SPAWN_LIFT = 9;

/** `spawnflags` bit 0 on a spawn spot: a local player's first spawn is here (`g_client.c:321`). */
export const SPAWNFLAG_INITIAL = 0x01;

/** A spawn's health starts this far over the limit and drains back to it (`g_client.c:1179`). */
export const SPAWN_HEALTH_BONUS = 25;

/** A spawn holds the player below full speed for this long (`g_client.c:1189–1191`). */
export const SPAWN_KNOCKBACK_TIME = 100;

/** What a spectator flies at: "faster than normal" (`SpectatorThink`, `g_active.c:332`). */
export const SPECTATOR_SPEED = 400;

/** How long a client must wait between team changes, in milliseconds (`g_cmds.c:720`). */
export const TEAM_SWITCH_TIME = 5000;

/** Where a client is put into the world: a spawn spot's origin, lifted, and its angles. */
export interface SpawnPoint {
  /** The spot itself, whose targets the spawn fires; null for a spectator's, which has none. */
  spot: GameEntity | null;
  origin: Vec3;
  /** Pitch, yaw and roll in degrees, as the map's `angles` or `angle` gave them. */
  angles: Vec3;
}

/** What a game module is started with. */
export interface GameOptions {
  /** The host, as the traps the game module calls it through. */
  traps: GameTraps;
  /** Where `session<slot>` and the game's own cvars live. */
  cvars: CvarStore;
  /**
   * What `g_gametype` is registered with, for a store that has not been told otherwise. A store
   * that already holds it wins, as it does over any default `Cvar_Get` offers.
   */
  gametype?: number;
  /** What `sv_maxclients` is registered with. */
  maxclients?: number;
  /** What `g_maxGameClients` is registered with: how many may play at once, or 0 for no limit. */
  maxGameClients?: number;
  /** What `g_inactivity` is registered with, in seconds; 0 for never. */
  inactivity?: number;
  /** `random()`. Left out, it is seeded from the host's `randomSeed` as `G_InitGame` seeds it. */
  random?: () => number;
  /**
   * `scripts/bots.txt` and the `scripts/*.bot` files, already read, which every map start loads
   * the bots from. Q3's game module reads them itself; the port's reads no files, and is handed
   * them as it is handed the map's entities.
   */
  botFiles?: readonly InfoFile[];
}

/**
 * The console commands the game module answers (`ConsoleCommand`, `g_svcmds.c:451–512`), as far
 * as the port has them. A console sends these to the host, whose command buffer offers them here.
 */
const GAME_COMMANDS: ReadonlySet<string> = new Set(['addbot']);

/**
 * Whether a console command is the game module's. Q3 matches a command's name without regard to
 * case.
 *
 * @param name - The command's first token.
 */
export function isGameCommand(name: string | undefined): boolean {
  return name !== undefined && GAME_COMMANDS.has(name.toLowerCase());
}

/**
 * CorkScrew's `g_allowGrapple` as a style: its server menu's numbering, where 0 is no hook at all
 * and anything it does not name is the same as 0.
 */
export function grappleMode(type: number): GrappleMode | null {
  return GRAPPLE_TYPES[type]?.mode ?? null;
}

export class Game implements GameModule {
  /** The match. A new one is built by every {@link Game.init}, as `level` is cleared per map. */
  level: Level;

  private readonly traps: GameTraps;
  private readonly cvars: CvarStore;
  /** `level.maxclients`, from `sv_maxclients`, which is latched and so read only at a map start. */
  private maxclients = 0;
  private maxGameClients = 0;
  /**
   * One life per slot, rebuilt with the level.
   *
   * A life holds nothing itself — what it touches lives on the entity and the client slot — so
   * these are a way of naming `g_active.c`'s and `g_combat.c`'s calls for one client rather than
   * a second place a client is kept.
   */
  lives: PlayerLife[] = [];

  /**
   * One weapon system per slot, rebuilt with the level.
   *
   * `FireWeapon` and `G_RunMissile` for that client: what its shots put in the world, and what
   * those things do afterwards. Like the lives, these name a set of calls for one client rather
   * than keeping anything of their own — a missile in flight is an entity in the level's pool.
   */
  private weapons: WeaponSystem[] = [];

  /**
   * One off-hand hook per slot, rebuilt with the level.
   *
   * `Weapon_GrapplingHook_Fire` and the release beside it, for that client. Like the lives and the
   * weapons it keeps only the style: the hook is an entity in the level's pool, and the pull it
   * sets up is two fields on the player state.
   */
  private grapples: Grapple[] = [];

  /** `player_die`'s static, which is the map's rather than any one client's. */
  private deaths: DeathCounter = { next: 0 };
  private readonly injectedRandom: (() => number) | undefined;

  private readonly botFiles: readonly InfoFile[];
  /** `g_botInfos`: every bot the bot files define, loaded again at each map start. */
  private botInfos: string[] = [];
  private readonly botSpawnQueue = new BotSpawnQueue();

  /** What each of {@link GAME_CVARS} is registered with, which an option may have replaced. */
  private readonly cvarDefaults: ReadonlyMap<string, string>;
  /** Each of {@link GAME_CVARS}' modification count as this game last read it. */
  private readonly cvarCounts = new Map<string, number>();
  /** The store's count of every change as {@link updateCvars} last read it, −1 before it has. */
  private cvarsTotal = -1;
  /** `g_password`'s modification count as {@link checkCvars} last read it, −1 before it has. */
  private passwordCount = -1;
  /** The rules of play, as their `vmCvar_t`s hold them. */
  private readonly ruleCvars: RuleCvars;
  /**
   * `g_gravity.value`, a C float, as the game last took it up: at registration, and at each frame.
   * So what a map's spawn reads is the gravity from before its world set its own.
   */
  private gravityValue = 0;

  /** `g_gametype`, which is latched and so cannot change under a running map. */
  gametype: number = GT.FFA;

  private randomState = 1;

  /** @param options - The traps, the cvars, and the defaults the match registers them with. */
  constructor(options: GameOptions) {
    this.traps = options.traps;
    this.cvars = options.cvars;
    this.ruleCvars = new RuleCvars(options.cvars);

    const defaults = new Map(GAME_CVARS.map((cvar) => [cvar.name, cvar.default]));
    const given: readonly [string, number | undefined][] = [
      ['g_gametype', options.gametype],
      ['sv_maxclients', options.maxclients],
      ['g_maxGameClients', options.maxGameClients],
      ['g_inactivity', options.inactivity]
    ];
    for (const [name, value] of given) if (value !== undefined) defaults.set(name, String(value));
    this.cvarDefaults = defaults;

    // Quake 3's game module does not exist before `G_InitGame`, and the port's does, so the cvars
    // are read here too rather than leaving a match behind that nothing has told how big it is.
    this.registerCvars();

    this.injectedRandom = options.random;
    this.botFiles = options.botFiles ?? [];

    this.level = this.newLevel(0);
  }

  // --- the seam -----------------------------------------------------------------------------

  /**
   * `G_InitGame` (`g_main.c:522–650`): a map has loaded, so the match starts over.
   *
   * The map's own entities come last, read from the text the host hands over a token at a time.
   *
   * @param levelTime - The time the map starts at.
   * @param randomSeed - Seeds the spawn point choice, as `srand( randomSeed )` seeds Quake 3's.
   * @param restart - True for a `map_restart` rather than a fresh map.
   */
  init(levelTime: number, randomSeed: number, _restart: boolean): void {
    this.randomState = randomSeed >>> 0 || 1;
    // The cvars come first, because the match below is built out of what they say — and because
    // this is the moment a latched one has been waiting for.
    this.registerCvars();
    this.level = this.newLevel(levelTime);
    // The host's settle frames stamp it again as each ends; a level no frame has run yet times a
    // command from the map's start.
    this.level.frameStartTime = this.traps.milliseconds();
    // `G_InitGame`'s first sound (`g_main.c:428`), before any of the map's own.
    this.level.sndFry = this.soundIndex(FRY_SOUND);
    // `G_InitGame`'s globals, which an item reads long after it was spawned: the gametype and the
    // respawn cvars are read at the pickup rather than captured here, so an operator's change
    // lands on the next item taken.
    this.level.itemMatch = {
      gametype: () => this.gametype,
      random: () => this.random(),
      friendlyFire: () => this.cvarInt('g_friendlyFire'),
      weaponRespawn: () => this.cvarInt('g_weaponrespawn'),
      weaponTeamRespawn: () => this.cvarInt('g_weaponTeamRespawn'),
      gravity: () => this.gravityValue,
      print: (text) => this.traps.print(text),
      soundIndex: (name) => this.soundIndex(name),
      modelIndex: (name) => this.modelIndex(name),
      addScore: (target, origin, score) => this.addScore(target, origin, score),
      calculateRanks: () => this.calculateRanks(),
      pickupTeam: (flag, other) => pickupTeam(this.level, flag, other)
    };
    this.deaths = { next: 0 };
    // `G_InitGame` (`g_main.c:1226–1229`): every client slot's entity points at its slot from the
    // start, so an entity and the client in it are two views of one player before anybody joins.
    for (let i = 0; i < MAX_CLIENTS; i++) this.level.gentities[i].client = this.level.clients[i];
    this.lives = Array.from(
      { length: MAX_CLIENTS },
      (_unused, i) =>
        new PlayerLife({
          entity: this.level.gentities[i],
          level: this.level,
          deaths: this.deaths,
          spawnClient: () => this.clientSpawn(this.level.gentities[i]),
          // Read at the call rather than captured, because the weapons and the hooks are built
          // after the lives that reach them.
          fireWeapon: (state) => this.weapons[i].fire(state),
          freeHook: () => this.grapples[i].release(),
          // The teleporter's spot is the lifecycle's, as the spawn's is; read at the call, since
          // the lives are built with the rest.
          teleportPlayer: () => this.useTeleporter(this.level.gentities[i]),
          // In seconds, as Quake 3 writes it, and read at the death so a change lands at once.
          forceRespawn: () => this.cvarInt('g_forcerespawn') * 1000,
          respawnHeld: () => this.level.roundCount > 0,
          addScore: (target, origin, score) => this.addScore(target, origin, score),
          gametype: () => this.gametype,
          rules: this.ruleCvars.rules,
          sendScoreboard: (clientNum) => this.sendScoreboard(clientNum),
          // What the body leaves on the floor (`TossClientItems`), before the death clears the
          // powerups it reads.
          tossItems: () => tossClientItems(this.level, this.level.gentities[i])
        })
    );
    this.weapons = Array.from(
      { length: MAX_CLIENTS },
      (_unused, i) =>
        new WeaponSystem({
          level: this.level,
          owner: this.level.gentities[i],
          trace: this.trace,
          rules: this.ruleCvars.rules,
          unlagged: () => this.cvarInt('xp_unlagged')
        })
    );
    this.grapples = Array.from(
      { length: MAX_CLIENTS },
      (_unused, i) =>
        new Grapple({
          level: this.level,
          owner: this.level.gentities[i],
          mode: grappleMode(this.cvarInt('g_allowGrapple'))
        })
    );
    this.level.newSession = initWorldSession(this.cvars, this.gametype, (text) =>
      this.traps.print(text)
    );
    this.level.warmupModificationCount = this.cvars.modificationCount('g_warmup');

    // `G_InitGame`'s order (`g_main.c:482, 485, 488, 495`): the item registry starts with the two
    // weapons every player holds, the map's own entities spawn into it, the entities sharing a
    // `team` chain up, and what the map put in the world goes out as `CS_ITEMS`.
    clearRegisteredItems(this.level);

    // `G_SpawnEntitiesFromString` (`g_main.c:478`): the map's entities, the world's first.
    spawnEntitiesFromString(
      () => this.traps.getEntityToken(),
      (vars) => this.spawnWorld(vars),
      (vars) => spawnEntityFromVars(this.level, vars, this.gametype, (text) => this.traps.print(text))
    );

    findTeams(this.level, (text) => this.traps.print(text));

    // "Make sure we have flags for CTF, etc" (`g_main.c:490–493`).
    if (this.gametype >= GT.TEAM) this.checkTeamItems();

    this.traps.setConfigstring(
      CONFIGSTRING.ITEMS,
      saveRegisteredItems(this.level, (text) => this.traps.print(text))
    );

    // `G_InitBots` (`g_main.c:503–507`), without the AI's setup and its map, which need AAS. The
    // spawn queue is a static of Q3's game module, which a map start loads afresh.
    this.botSpawnQueue.clear();
    this.botInfos = loadBots(this.botFiles, (text) => this.traps.print(text));
  }

  /**
   * `SP_worldspawn` (`g_spawn.c:564–613`): what the map says of itself, and whether its match is
   * played at once.
   *
   * The name, the music and the message of the day go to every client, and the gravity to the
   * match. It is set on every map load, to the map's or to 800, so a `g_gravity` typed at the
   * console lasts until the next. Q3 also sends its version here, and the port has none.
   *
   * @throws with Q3's `G_Error` when the first entity is not the world
   */
  private spawnWorld(vars: SpawnVars): void {
    checkWorldspawn(vars);

    this.traps.setConfigstring(CONFIGSTRING.LEVEL_START_TIME, String(this.level.startTime));
    this.traps.setConfigstring(CONFIGSTRING.MUSIC, spawnString(vars, 'music', ''));
    this.traps.setConfigstring(CONFIGSTRING.MESSAGE, spawnString(vars, 'message', ''));
    this.traps.setConfigstring(CONFIGSTRING.MOTD, this.cvars.get('g_motd'));
    this.cvars.set('g_gravity', spawnString(vars, 'gravity', '800'));
    this.cvars.set('g_enableDust', spawnString(vars, 'enableDust', '0'));
    this.cvars.set('g_enableBreath', spawnString(vars, 'enableBreath', '0'));

    const world = this.level.gentities[ENTITYNUM_WORLD];
    world.r.ownerNum = ENTITYNUM_NONE;
    world.classname = 'worldspawn';
    const none = this.level.gentities[ENTITYNUM_NONE];
    none.r.ownerNum = ENTITYNUM_NONE;
    none.classname = 'nothing';

    // Whether this map is played straight away. The warmup ends in a restart, and `g_restarted` is
    // how the map that comes back knows not to warm up again: the flag is spent by reading it.
    this.traps.setConfigstring(CONFIGSTRING.WARMUP, '');
    if (this.cvarInt('g_restarted')) {
      this.cvars.set('g_restarted', '0');
      this.level.warmupTime = 0;
    } else if (this.cvarInt('g_doWarmup')) {
      this.level.warmupTime = -1;
      this.traps.setConfigstring(CONFIGSTRING.WARMUP, String(this.level.warmupTime));
    }
    // Clan Arena's rounds carry the same value once the match is under way, and it starts between
    // them: a restart into it is not one into play, and the fight is the first round's.
    if (this.gametype === GT.CA && !this.level.warmupTime) {
      this.traps.setConfigstring(CONFIGSTRING.WARMUP, String(this.level.roundTime));
    }
  }

  /**
   * `G_ShutdownGame` (`g_main.c:658–680`): write every connected client's session out, which is
   * the only way any of it reaches the next map.
   */
  shutdown(_restart: boolean): void {
    this.writeSessions();
  }

  /**
   * `ClientConnect` (`g_client.c:890–977`): someone is arriving in this slot.
   *
   * It runs again on every map change and tournament restart, with `firstTime` false — which is
   * the whole reason the three lifetimes exist. The client is cleared outright, so `pers` starts
   * over; the session is then read back out of its cvar, so `sess` appears to have survived.
   *
   * @param clientNum - The slot.
   * @param firstTime - False when this client is being carried over rather than newly arriving.
   * @param isBot - The client is a bot, which keeps it out of the counts humans belong in.
   * @returns Null to admit the client, or the reason it is being refused.
   */
  clientConnect(clientNum: number, firstTime: boolean, isBot: boolean): string | null {
    const entity = this.level.gentities[clientNum];
    const userinfo = this.traps.getUserinfo(clientNum);
    const ip = infoValueForKey(userinfo, 'ip');

    // A bot has no password and neither does a client in this process — Quake 3 recognises the
    // second by its `ip` being `localhost`, which is what a loopback connection sets.
    if (!isBot && ip !== 'localhost') {
      const password = this.cvars.get('g_password');
      if (password && password !== 'none' && password !== infoValueForKey(userinfo, 'password')) {
        return 'Invalid password';
      }
    }

    // A client that reconnects faster than its disconnect arrives would otherwise take over a
    // slot that still thinks it is occupied, so the disconnect is forced through first.
    if (entity.inuse) this.clientDisconnect(clientNum);

    const client = this.level.clients[clientNum];
    entity.client = client;
    clearClientForConnect(client);

    client.pers.connected = CON.CONNECTING;
    client.pers.localClient = ip === 'localhost';

    // `G_BotConnect` would set up the bot's AI, which refuses a map with no AAS and drops the bot.
    // With no AI there is nothing to set up, so the bot is let in.
    if (isBot) {
      entity.r.svFlags |= SVF.BOT;
      entity.inuse = true;
    }

    if (firstTime || this.level.newSession) {
      const joins = initClientSessionData(this.cvars, clientNum, client.sess, userinfo, {
        gametype: this.gametype,
        maxGameClients: this.maxGameClients,
        numNonSpectatorClients: this.level.numNonSpectatorClients,
        localClient: client.pers.localClient
      });
      // A team game's arrival that came with a side in mind, or one that arrived while
      // `g_teamAutoJoin` was on (`g_session.c:123–126`). Nothing is begun by it: the client is
      // still connecting, which is where `SetTeam` stops.
      if (joins !== null) this.setTeam(entity, joins);
      // "Add client to end of tournament queue" (`g_session.c:158`), which every arrival joins
      // whatever the gametype: a session that has never been in one starts at the back of it.
      this.addTournamentQueue(client);
      writeClientSessionData(this.cvars, clientNum, client.sess);
    }
    readClientSessionData(this.cvars, clientNum, client.sess);

    this.clientUserinfoChanged(clientNum);

    // A client carried over from the last map was never away, so it is not announced again.
    if (firstTime) {
      this.traps.sendServerCommand(null, `print "${client.pers.netname}^7 connected\n"`);
    }

    this.calculateRanks();
    return null;
  }

  /**
   * `ClientBegin` (`g_client.c:991–1030`): the client is in the world and wants a body.
   *
   * It happens on every map load and on a change of team, and never on a respawn — which is the
   * line between this and {@link Game.clientSpawn}.
   *
   * @param clientNum - The slot.
   */
  clientBegin(clientNum: number): void {
    const entity = this.level.gentities[clientNum];
    const client = this.level.clients[clientNum];

    if (entity.r.linked) this.traps.unlinkEntity(entity);
    // `G_InitGentity` gives the entity its slot's number back, which matters here and nowhere
    // else: a bot's entity is in use from the moment it connects, so a bot that waits out
    // `addbot`'s delay has ended frames as a client with no player state, and the entity state
    // built from those zeroes left it numbered 0.
    this.level.initEntity(entity, clientNum);
    entity.client = client;

    client.pers.connected = CON.CONNECTED;
    client.pers.enterTime = this.level.time;
    client.pers.teamState.state = TEAM_STATE.BEGIN;

    // The teleport bit is saved across the clearing: a team change reaches here with a live
    // entity, and losing the bit would let the client interpolate across the map to the new spot.
    const flags = client.ps.eFlags;
    copyPlayerState(createPlayerState(), client.ps);
    client.ps.eFlags = flags;

    this.clientSpawn(entity);

    if (client.sess.sessionTeam !== TEAM.SPECTATOR && this.gametype !== GT.TOURNAMENT) {
      this.traps.sendServerCommand(null, `print "${client.pers.netname}^7 entered the game\n"`);
    }

    this.calculateRanks();
  }

  /**
   * `ClientUserinfoChanged` (`g_client.c:703–867`): the client's settings have changed, so what
   * everyone else is told about it has to change with them.
   *
   * The output is a configstring rather than the userinfo: the userinfo is the client's own
   * business, and only the handful of keys another client needs to draw a scoreboard, pick a
   * model and play the right sounds go out.
   *
   * @param clientNum - The slot.
   */
  clientUserinfoChanged(clientNum: number): void {
    const entity = this.level.gentities[clientNum];
    const client = this.level.clients[clientNum];
    let userinfo = this.traps.getUserinfo(clientNum);

    if (!infoValidate(userinfo)) {
      userinfo = '\\name\\badinfo';
      this.traps.dropClient(clientNum, 'Invalid userinfo');
    }

    client.pers.predictItemPickup = Number.parseInt(
      infoValueForKey(userinfo, 'cg_predictItems'),
      10
    )
      ? true
      : false;
    // Unlagged takes the client's word for it; the port only where cheats are on.
    client.pers.debugDelag =
      this.cvarInt('sv_cheats') !== 0 &&
      !!Number.parseInt(infoValueForKey(userinfo, 'cg_debugDelag'), 10);

    const oldname = client.pers.netname;
    client.pers.netname = cleanName(infoValueForKey(userinfo, 'name'));

    if (
      client.sess.sessionTeam === TEAM.SPECTATOR &&
      client.sess.spectatorState === SPECTATOR.SCOREBOARD
    ) {
      client.pers.netname = 'scoreboard';
    }

    if (client.pers.connected === CON.CONNECTED && oldname !== client.pers.netname) {
      this.traps.sendServerCommand(
        null,
        `print "${oldname}^7 renamed to ${client.pers.netname}\n"`
      );
    }

    client.pers.maxHealth = handicapOf(userinfo);
    // What the server holds this client's snapshots apart by, worked out as the server works it.
    client.pers.snapshotMsec = snapshotMsec(
      infoValueForKey(userinfo, 'snaps'),
      this.cvarInt('sv_fps')
    );
    client.ps.stats[STAT.MAX_HEALTH] = client.pers.maxHealth;

    const team = this.gametype >= GT.TEAM;
    const model = infoValueForKey(userinfo, team ? 'team_model' : 'model');
    const headModel = infoValueForKey(userinfo, team ? 'team_headmodel' : 'headmodel');

    // The overlay is on unless the client explicitly said 0, so an absent key means yes.
    const overlay = infoValueForKey(userinfo, 'teamoverlay');
    client.pers.teamInfo = !overlay || Number.parseInt(overlay, 10) !== 0;

    const teamTask = Number.parseInt(infoValueForKey(userinfo, 'teamtask'), 10) || 0;
    const teamLeader = client.sess.teamLeader ? 1 : 0;
    const bot = (entity.r.svFlags & SVF.BOT) !== 0;

    const fields: string[] = [
      `n\\${client.pers.netname}`,
      `t\\${client.sess.sessionTeam}`,
      `model\\${model}`,
      `hmodel\\${headModel}`
    ];
    if (!bot) {
      fields.push(`g_redteam\\${infoValueForKey(userinfo, 'g_redteam')}`);
      fields.push(`g_blueteam\\${infoValueForKey(userinfo, 'g_blueteam')}`);
    }
    fields.push(`c1\\${infoValueForKey(userinfo, 'color1')}`);
    fields.push(`c2\\${infoValueForKey(userinfo, 'color2')}`);
    fields.push(`hc\\${client.pers.maxHealth}`);
    fields.push(`w\\${client.sess.wins}`);
    fields.push(`l\\${client.sess.losses}`);
    if (bot) fields.push(`skill\\${infoValueForKey(userinfo, 'skill')}`);
    fields.push(`tt\\${teamTask}`);
    fields.push(`tl\\${teamLeader}`);

    this.traps.setConfigstring(CONFIGSTRING.PLAYERS + clientNum, fields.join('\\'));
  }

  /**
   * `ClientDisconnect` (`g_client.c:1257–1335`): the client has gone.
   *
   * It is never called between maps — a client carried over is connected the whole way — so
   * anything cleared here is cleared because the player left, not because the map did.
   *
   * @param clientNum - The slot.
   */
  clientDisconnect(clientNum: number): void {
    // A bot kicked before its delay ran out must not begin afterwards.
    this.botSpawnQueue.remove(clientNum);

    const entity = this.level.gentities[clientNum];
    const client = entity.client;
    if (!client || client.pers.connected === CON.DISCONNECTED) return;

    // "Stop any following clients" (`g_client.c:1271–1278`): anyone riding this client's view is
    // let off it before the view stops existing, which is `StopFollowing`'s whole job. Their
    // `spectatorClient` is left where it was, as Quake 3 leaves it — the slot they were watching
    // is where the next cycle starts from.
    for (let i = 0; i < this.maxclients; i++) {
      const other = this.level.clients[i];
      if (
        isSpectator(other) &&
        other.sess.spectatorState === SPECTATOR.FOLLOW &&
        other.sess.spectatorClient === clientNum
      ) {
        this.stopFollowing(this.level.gentities[i]);
      }
    }

    // A tournament's loser is whoever leaves while the match is running, so the other player is
    // credited with the win they were about to get.
    if (
      this.gametype === GT.TOURNAMENT &&
      !this.level.intermissiontime &&
      !this.level.warmupTime &&
      this.level.sortedClients[1] === clientNum
    ) {
      this.level.clients[this.level.sortedClients[0]].sess.wins++;
      this.clientUserinfoChanged(this.level.sortedClients[0]);
    }

    // "send effect if they were completely connected" (`g_client.c:1281–1289`): a player who was
    // fully in the game, and not merely watching it, goes as a teleporter sends them, and "they
    // don't get to take powerups with them!", leaving what a death would.
    if (client.pers.connected === CON.CONNECTED && client.sess.sessionTeam !== TEAM.SPECTATOR) {
      const departure = tempEntity(this.level, client.ps.origin, EV.PLAYER_TELEPORT_OUT);
      departure.s.clientNum = entity.s.clientNum;
      tossClientItems(this.level, entity);
    }

    this.traps.unlinkEntity(entity);
    entity.s.modelindex = 0;
    entity.inuse = false;
    entity.classname = 'disconnected';
    client.pers.connected = CON.DISCONNECTED;
    client.ps.persistant[PERS.TEAM] = TEAM.FREE;
    client.sess.sessionTeam = TEAM.FREE;

    this.traps.setConfigstring(CONFIGSTRING.PLAYERS + clientNum, '');

    this.calculateRanks();
  }

  /**
   * `ClientCommand` (`g_cmds.c:1709–1822`), for the client commands the game module answers:
   * `score`, which asks for the board (`Cmd_Score_f`, `:105–107`), then `kill`, `team` and the
   * follow commands. A command's name is matched without regard to case, as `Q_stricmp` matches it.
   *
   * "Not fully in game yet" clients are passed over, as Q3 passes them (`:1714–1724`): a client
   * that has connected but not begun has no board to be shown. At the intermission the board is
   * all that is answered (`:1776–1780`); Quake 3 says any other command as chat, which the port
   * has none of.
   *
   * @param clientNum - Which client sent it.
   * @param command - The command, as it arrived.
   */
  clientCommand(clientNum: number, command: string): void {
    if (this.level.clients[clientNum].pers.connected !== CON.CONNECTED) return;

    const entity = this.level.gentities[clientNum];
    const argv = tokenize(command);
    const name = argv[0]?.toLowerCase();
    if (name === 'score') {
      this.sendScoreboard(clientNum);
      return;
    }
    if (this.level.intermissiontime) return;

    switch (name) {
      case 'kill':
        this.cmdKill(entity);
        break;
      case 'team':
        this.cmdTeam(entity, argv);
        break;
      case 'follow':
        this.cmdFollow(entity, argv);
        break;
      case 'follownext':
        this.followCycle(entity, 1);
        break;
      case 'followprev':
        this.followCycle(entity, -1);
        break;
    }
  }

  /**
   * `ClientThink` (`g_active.c:1027–1040`): a command has arrived for this client.
   *
   * An ordinary client moves on it now. A bot moves when the frame comes round instead, in
   * `G_RunClient`, whatever time its command was stamped with.
   *
   * @param clientNum - The slot.
   */
  clientThink(clientNum: number): void {
    const entity = this.level.gentities[clientNum];
    const client = this.level.clients[clientNum];
    copyNetUserCmd(this.traps.getUserCmd(clientNum), client.pers.cmd);
    if (!(entity.r.svFlags & SVF.BOT)) this.clientThinkReal(entity);
  }

  /**
   * `ClientThink_real` (`g_active.c:754–1018`): run the client's command, `pers.cmd`.
   *
   * The command becomes the client's, the buttons are latched so a press between frames is not
   * lost, and the move runs. Around it is the life: the move type follows the health, the
   * landings that hurt are the move's own events, and the once-a-second drain and the respawn
   * close it.
   *
   * The command's angles are the wire's sixteenths of a degree plus whatever the server has
   * turned the client by; they become degrees here, at the seam, and the move clamps the pitch
   * where `PM_UpdateViewAngles` clamps it.
   *
   * @param entity - The client's entity.
   */
  private clientThinkReal(entity: GameEntity): void {
    const clientNum = entity.s.number;
    const client = this.level.clients[clientNum];
    const life = this.lives[clientNum];
    const cmd = client.pers.cmd;

    // "Don't think if the client is not yet connected (and thus not yet spawned in)"
    // (`g_active.c:823–825`): the first thing Quake 3 asks, before even the intermission.
    if (client.pers.connected !== CON.CONNECTED) return;

    // Unlagged's `frameOffset`, true ping and smoothing anchor, which every command of a connected
    // client is measured for before anything else can turn it away. A bot's command runs inside
    // the frame, so its anchor is never behind it.
    client.frameOffset = this.traps.milliseconds() - this.level.frameStartTime;
    samplePing(this.level, client);
    client.lastUpdateTime = this.level.time;

    // Nobody moves at the intermission, so the command is read for one thing only.
    if (this.level.intermissiontime) {
      this.clientIntermissionThink(client);
      return;
    }

    // A command from too far ahead or too far behind is held to something a frame can use,
    // whatever the clock it was stamped on (`g_active.c:823–829`). It is worked out before the
    // spectator's branch because Quake 3 corrects the command itself, and a spectator's move
    // runs on the same corrected time.
    let serverTime = Math.min(
      Math.max(cmd.serverTime, this.level.time - 1000),
      this.level.time + 200
    );

    // "Following others may result in bad times, but we still want to check for follow toggles"
    // (`g_active.c:780–788`): a command that moves the clock nowhere is dropped, think and all,
    // unless it is a follower's.
    const elapsed = serverTime - client.ps.commandTime;
    if (elapsed < 1 && client.sess.spectatorState !== SPECTATOR.FOLLOW) return;
    const msec = Math.min(elapsed, 200);

    // Every move is chopped into `pmove_msec` ticks, as Quake 3's are under `pmove_fixed`, and a
    // command's time is rounded up to a whole number of them (`g_active.c:799–803`). So a tick
    // longer than the frame moves on every other command, and the one between is dropped above.
    const tick = this.pmoveMsec();
    serverTime = Math.trunc((serverTime + tick - 1) / tick) * tick;

    // "Spectators don't do much" (`g_active.c:812–819`): the scoreboard spectator does not even
    // read the command, and everyone else makes the spectator's own move. It comes before the
    // latch below because `SpectatorThink` keeps the buttons itself, and the attack that cycles
    // the view is an edge that a latch here would have flattened.
    if (isSpectator(client)) {
      if (client.sess.spectatorState !== SPECTATOR.SCOREBOARD) {
        this.spectatorThink(entity, serverTime);
      }
      return;
    }

    // "check for inactivity timer, but never drop the local client of a non-dedicated server"
    // (`g_active.c:822–825`).
    if (!this.inactivityTimer(clientNum)) return;

    // "clear the rewards if time" (`g_active.c:827–830`): the award's sprite comes off the head.
    if (this.level.time > client.rewardTime) client.ps.eFlags &= ~EF_AWARDS;

    client.oldbuttons = client.buttons;
    client.buttons = cmd.buttons;
    client.latchedButtons |= client.buttons & ~client.oldbuttons;

    client.oldOrigin.x = client.ps.origin.x;
    client.oldOrigin.y = client.ps.origin.y;
    client.oldOrigin.z = client.ps.origin.z;

    life.beginTick();

    // The two numbers a move is run at come from the cvars at every think, which is what makes
    // `g_speed` and `g_gravity` live (`g_active.c:869–884`). Haste comes after the read, as its
    // own line does (`:851–853`), so a hasted player runs at `g_hasteFactor` × whatever `g_speed`
    // says. The speed is an int, and the VM makes the product in single precision.
    client.ps.speed = this.cvarInt('g_speed');
    if (client.ps.powerups[PW.HASTE]) {
      const factor = Math.fround(this.ruleCvars.rules.g_hasteFactor);
      client.ps.speed = Math.trunc(Math.fround(client.ps.speed * factor));
    }
    client.ps.gravity = this.cvarInt('g_gravity');
    // `pcq_god` is Quake 3's `god` cheat kept as a setting, and read here for the same reason the
    // two above are: what it does happens at the next hit rather than when it was typed.
    life.god = this.cvarInt('pcq_god') !== 0;

    clampViewPitchDelta(client.ps, client.pers.cmd.angles);

    // CorkScrew's `g_allowGrapple`, read at the think beside those two so that it is live as they
    // are. A style swapped while a hook is out waits for it to come back.
    const grapple = this.grapples[clientNum];
    const mode = grappleMode(this.cvarInt('g_allowGrapple'));
    if (mode !== grapple.mode) grapple.configure({ mode });

    // "Let go of the hook if we aren't firing" (`g_active.c:855–859`). Quake 3's grapple is the
    // weapon in hand and reads `BUTTON_ATTACK`; CorkScrew's is off-hand on `+button5`, which is
    // bit 5 of the same number. Before the move, so the tick a key comes up has no pull in it.
    const hookHeld = (cmd.buttons & BUTTON_AFFIRMATIVE) !== 0;
    grapple.checkRelease(hookHeld);

    // `pm.tracemask` (`g_active.c:906–915`): a dead player moves through the living, and a bot is
    // kept out of the bot clip as well.
    let tracemask: number = MASK.PLAYERSOLID;
    if (client.ps.pmType === PM_DEAD) tracemask = MASK.PLAYERSOLID & ~CONTENTS.BODY;
    else if (entity.r.svFlags & SVF.BOT) tracemask = MASK.PLAYERSOLID | CONTENTS.BOTCLIP;

    // Where the reader of the move's events has to start from. `ClientEvents` is told this
    // rather than handed a list, because the ring the move fills is two deep and only the
    // sequence says which two of them are new (`g_active.c:857, 970`).
    const oldEventSequence = client.ps.eventSequence;

    // "Check for the hit-scan gauntlet, don't let the action go through as an attack unless it
    // actually hits something" (`g_active.c:866–871`). id's punch lands here, before the move.
    // `g_countdownHold` holds it with the trigger while a round counts down.
    const countdown = this.level.roundTime > 0;
    let gauntletHit = false;
    if (
      !(this.ruleCvars.rules.g_countdownHold && countdown) &&
      client.ps.weapon === WP.GAUNTLET &&
      !(cmd.buttons & BUTTON_TALK) &&
      cmd.buttons & BUTTON_ATTACK &&
      client.ps.weaponTime <= 0
    ) {
      gauntletHit = this.weapons[clientNum].checkGauntletAttack(client.ps);
    }

    // `Team_ForceGesture`'s taunt (`g_active.c:873–876`): the flag is spent by reading it,
    // and the button goes on the command rather than on `client.buttons`, which was latched
    // above — so the move plays the taunt and nothing downstream thinks the key was pressed.
    if (entity.flags & FL.FORCE_GESTURE) {
      entity.flags &= ~FL.FORCE_GESTURE;
      cmd.buttons |= BUTTON_GESTURE;
    }

    const moved = pmove(
      client.ps,
      {
        serverTime,
        forwardmove: cmd.forwardmove,
        rightmove: cmd.rightmove,
        upmove: cmd.upmove,
        buttons: cmd.buttons,
        weapon: cmd.weapon,
        angles: vec3(
          shortAngle(cmd.angles[0] + client.ps.deltaAngles.x),
          shortAngle(cmd.angles[1] + client.ps.deltaAngles.y),
          shortAngle(cmd.angles[2] + client.ps.deltaAngles.z)
        )
      },
      this.trace,
      {
        ...grapple.pmoveOptions,
        tracemask,
        gauntletHit,
        pmoveMsec: tick,
        core: CpmaPmove,
        pointContents: this.pointContents,
        rules: this.ruleCvars.rules,
        noFootsteps: (this.ruleCvars.rules.dmflags & DF_NO_FOOTSTEPS) !== 0,
        // Clan Arena spends no ammo until a round is under way.
        freeAmmo: this.gametype === GT.CA && this.level.roundTime !== 0,
        countdown
      }
    );
    // The Q2 winch hard-sets the velocity after the move, where `CTFGrapplePull` runs. Its sag is
    // one frame's gravity, and the frame is the move that just ran.
    grapple.applyPostMove(client.ps, msec / 1000);

    // "Save results of pmove" (`g_active.c:945–964`). An event the move raised is fresh, so the
    // frame does not take it off the entity before a client has seen it. Everyone else's picture of
    // the player is rebuilt from the move at once, which puts the first of its events on the
    // entity, and the next goes out on its own. `ClientEndFrame` does both again, for whatever a
    // hurt or a third event leaves.
    if (client.ps.eventSequence !== oldEventSequence) entity.eventTime = this.level.time;
    playerStateToEntityState(client.ps, entity.s, true);
    sendPendingPredictableEvents(this.level, client.ps);
    // "Use the snapped origin for linking so it matches client predicted versions"
    // (`g_active.c:960–961`): whole units, as the entity state carries it.
    copyVec(entity.s.pos.trBase, entity.r.currentOrigin);
    // The box the move ended in is the one the world has, so a crouching player is shot at
    // crouching height and a dead one at a corpse's. The move keeps its box to itself, so it is
    // worked out again from the stance the move's last tick worked it out from (`PM_CheckDuck`).
    const box = playerBounds((client.ps.pmFlags & PMF_DUCKED) !== 0, client.ps.pmType === PM_DEAD);
    entity.r.mins = box.mins;
    entity.r.maxs = box.maxs;
    entity.waterlevel = moved.waterlevel;
    entity.watertype = moved.watertype;

    life.clientEvents(oldEventSequence);
    // `Weapon_GrapplingHook_Fire`, which `FireWeapon` reaches from the same place. The hook is
    // off-hand here, so its own key stands in for the fire event the weapon in hand raises.
    grapple.fire(hookHeld);

    // "Link entity now, after any personal teleporters have been used" (`g_active.c:972–975`),
    // then `G_TouchTriggers` over the world the move left behind — where a weapon under the player
    // is taken and a pad under them is stepped on — and then "copy the exact origin over otherwise
    // clients can be snapped into solid" (`:978–979`). So the world finds the player by a box round
    // their snapped origin, a blast measures to that box, and a trace or a blast's push starts from
    // where they really are.
    this.traps.linkEntity(entity);
    if (!client.noclip) touchTriggers(this.level, entity);
    copyVec(client.ps.origin, entity.r.currentOrigin);

    // "Touch other objects" (`g_active.c:984–985`): a plat or a button the move met. Then "save
    // results of triggers and client events" (`:987–990`), so an event a touch raised, a jump
    // pad's, is not taken off the entity before a client has seen it.
    clientImpacts(this.level, entity, moved.touchents);
    if (client.ps.eventSequence !== oldEventSequence) entity.eventTime = this.level.time;

    life.endTick(cmd, msec);
    this.checkRoundSpectator(entity);
  }

  /**
   * CPMA's Clan Arena dead: once a match's first round has begun, a player dead past their respawn
   * time is not respawned but left watching from their own side, their body left behind, until
   * the next round's respawn brings them back. No button is needed, and while a side is empty and
   * the match waits they watch too.
   *
   * @param entity - The client's entity.
   */
  private checkRoundSpectator(entity: GameEntity): void {
    const client = entity.client!;
    if (!this.level.roundCount) return;
    if (client.ps.stats[STAT.HEALTH] > 0 || this.level.time <= client.respawnTime) return;
    copyToBodyQue(this.level, entity);
    client.pers.roundSpectator = true;
    client.sess.spectatorState = SPECTATOR.FREE;
  }

  /**
   * `ClientInactivityTimer` (`g_active.c:371–394`): a player who neither moves nor attacks for
   * `g_inactivity` seconds is dropped, told ten seconds before. At 0 nobody is, and everyone is
   * kept a minute ahead, "so if the operator sets g_inactivity during gameplay, everyone isn't
   * kicked". The player at a listen server's own screen never is.
   *
   * @returns Whether the player is still here.
   */
  private inactivityTimer(clientNum: number): boolean {
    const client = this.level.clients[clientNum];
    const { cmd } = client.pers;
    const inactivity = this.cvarInt('g_inactivity');
    if (inactivity === 0) {
      client.inactivityTime = this.level.time + 60 * 1000;
      client.inactivityWarning = false;
    } else if (
      cmd.forwardmove !== 0 ||
      cmd.rightmove !== 0 ||
      cmd.upmove !== 0 ||
      (cmd.buttons & BUTTON_ATTACK) !== 0
    ) {
      client.inactivityTime = this.level.time + inactivity * 1000;
      client.inactivityWarning = false;
    } else if (!client.pers.localClient) {
      if (this.level.time > client.inactivityTime) {
        this.traps.dropClient(clientNum, 'Dropped due to inactivity');
        return false;
      }
      if (this.level.time > client.inactivityTime - 10000 && !client.inactivityWarning) {
        client.inactivityWarning = true;
        this.traps.sendServerCommand(clientNum, 'cp "Ten seconds until inactivity drop!\n"');
      }
    }
    return true;
  }

  /**
   * `SpectatorThink` (`g_active.c:317–360`): a spectator's whole frame.
   *
   * A free spectator flies, and anybody else is frozen: a follower's view is copied from whoever
   * they are watching at the end of the frame ({@link spectatorClientEndFrame}), so there is
   * nothing here to move. Either way the entity is *unlinked* afterwards — a spectator is not in
   * the world, cannot be shot and cannot be walked into — and their triggers pass is nearly empty
   * (`triggers.ts`).
   *
   * Quake 3 picks `PM_NOCLIP` here for a client with `noclip` set; nothing in the port sets it,
   * so the branch is not written.
   *
   * @param entity - The spectator's entity.
   * @param serverTime - The command's time, already held to what this frame can use.
   */
  private spectatorThink(entity: GameEntity, serverTime: number): void {
    const client = this.level.clients[entity.s.number];
    const cmd = client.pers.cmd;

    const following =
      client.sess.spectatorState === SPECTATOR.FOLLOW && (client.ps.pmFlags & PMF_FOLLOW) !== 0;
    if (!following) {
      client.ps.pmType =
        client.sess.spectatorState === SPECTATOR.FREE ? PM_SPECTATOR : PM_FREEZE;
      // "Faster than normal" (`g_active.c:332`), and set every command, so a spectator keeps it
      // whatever the body they had was running at.
      client.ps.speed = SPECTATOR_SPEED;

      clampViewPitchDelta(client.ps, client.pers.cmd.angles);

      pmove(
        client.ps,
        {
          serverTime,
          forwardmove: cmd.forwardmove,
          rightmove: cmd.rightmove,
          upmove: cmd.upmove,
          buttons: cmd.buttons,
          weapon: cmd.weapon,
          angles: vec3(
            shortAngle(cmd.angles[0] + client.ps.deltaAngles.x),
            shortAngle(cmd.angles[1] + client.ps.deltaAngles.y),
            shortAngle(cmd.angles[2] + client.ps.deltaAngles.z)
          )
        },
        this.trace,
        {
          // "Spectators can fly through bodies" (`g_active.c:336`).
          tracemask: MASK.PLAYERSOLID & ~CONTENTS.BODY,
          core: CpmaPmove,
          pointContents: this.pointContents,
          rules: this.ruleCvars.rules
        }
      );

      copyVec(client.ps.origin, entity.s.origin);
      touchTriggers(this.level, entity);
      this.traps.unlinkEntity(entity);
    }

    client.oldbuttons = client.buttons;
    client.buttons = cmd.buttons;

    // "Attack button cycles through spectators" (`:356–359`), on the press rather than the hold.
    if (client.buttons & BUTTON_ATTACK && !(client.oldbuttons & BUTTON_ATTACK)) {
      this.followCycle(entity, 1);
    }
  }

  /**
   * `SpectatorClientEndFrame` (`g_active.c:1056–1097`): a follower is shown what they are
   * following.
   *
   * The followed client's *whole* player state is copied over the follower's, which is what
   * carries the view, the weapon, the HUD and — because it carries `clientNum` as well — makes
   * everything downstream draw that client instead. The two vote flags are the follower's own and
   * are kept over the copy. A follower whose target has gone is put back on their feet by
   * `ClientBegin`, as free as they were before, unless they are a dedicated camera, which waits
   * for somebody to watch. A target who has started watching has gone too.
   *
   * A follower watching from a side is let off where the view was instead, still on the side: a
   * begin would put them back in the round, which only the next round's respawn does (CPMA).
   *
   * @param entity - The spectator's entity.
   */
  private spectatorClientEndFrame(entity: GameEntity): void {
    const client = this.level.clients[entity.s.number];

    if (client.sess.spectatorState === SPECTATOR.FOLLOW) {
      // The two dedicated cameras go to whoever is playing, which `CalculateRanks` decides.
      let clientNum = client.sess.spectatorClient;
      if (clientNum === -1) clientNum = this.level.follow1;
      else if (clientNum === -2) clientNum = this.level.follow2;

      if (clientNum >= 0) {
        const followed = this.level.clients[clientNum];
        if (followed.pers.connected === CON.CONNECTED && !isSpectator(followed)) {
          const flags =
            (followed.ps.eFlags & ~(EF_VOTED | EF_TEAMVOTED)) |
            (client.ps.eFlags & (EF_VOTED | EF_TEAMVOTED));
          copyPlayerState(followed.ps, client.ps);
          client.ps.pmFlags |= PMF_FOLLOW;
          client.ps.eFlags = flags;
          return;
        }
      }

      if (client.ps.pmFlags & PMF_FOLLOW) {
        if (client.sess.sessionTeam !== TEAM.SPECTATOR) {
          this.stopFollowing(entity);
        } else {
          // "Drop them to free spectators unless they are dedicated camera followers."
          if (client.sess.spectatorClient >= 0) client.sess.spectatorState = SPECTATOR.FREE;
          this.clientBegin(entity.s.number);
        }
      }
    }

    if (client.sess.spectatorState === SPECTATOR.SCOREBOARD) {
      client.ps.pmFlags |= PMF_SCOREBOARD;
    } else {
      client.ps.pmFlags &= ~PMF_SCOREBOARD;
    }
  }

  /**
   * `SetTeam` (`g_cmds.c:515–660`): put a client on a team, or among the spectators.
   *
   * The word asked for decides the team and, for a spectator, what sort: free, following one of
   * the two dedicated cameras, or watching the scoreboard. The match then overrides it — a
   * tournament seats two and no more, and `g_maxGameClients` caps any mode — so asking to play a
   * full match is how a client ends up in the queue.
   *
   * The change itself kills whoever was playing, "makes sure he loses flags, etc", puts a
   * spectator at the back of the tournament queue, and ends in `ClientBegin`, which is what gives
   * them a body in their new place.
   *
   * @param entity - The client's entity.
   * @param request - Quake 3's own word: `s`/`spectator`, `follow1`, `follow2`,
   *   `scoreboard`/`score`, `red`/`r` or `blue`/`b` in a game of sides, or anything else for the
   *   side that is behind — the free team in a game without them.
   */
  setTeam(entity: GameEntity, request: string): void {
    const clientNum = this.clientSlot(entity);
    const client = this.level.clients[clientNum];

    let team: number;
    let specState: number = SPECTATOR.NOT;
    let specClient = 0;

    const asked = request.toLowerCase();
    if (asked === 'scoreboard' || asked === 'score') {
      team = TEAM.SPECTATOR;
      specState = SPECTATOR.SCOREBOARD;
    } else if (asked === 'follow1') {
      team = TEAM.SPECTATOR;
      specState = SPECTATOR.FOLLOW;
      specClient = -1;
    } else if (asked === 'follow2') {
      team = TEAM.SPECTATOR;
      specState = SPECTATOR.FOLLOW;
      specClient = -2;
    } else if (asked === 'spectator' || asked === 's') {
      team = TEAM.SPECTATOR;
      specState = SPECTATOR.FREE;
    } else if (this.gametype >= GT.TEAM) {
      // "If running a team game, assign player to one of the teams" (`g_cmds.c:545–555`). A word
      // that names neither side takes whichever side is behind — and the empty word is one, which
      // is how `g_teamAutoJoin` seats an arrival that asked for nothing in particular.
      specState = SPECTATOR.NOT;
      if (asked === 'red' || asked === 'r') team = TEAM.RED;
      else if (asked === 'blue' || asked === 'b') team = TEAM.BLUE;
      else team = this.pickTeam(clientNum);

      // `g_teamForceBalance` (`:557–575`): a side may be one ahead but not two. The local client
      // and the bots are never held to it, because the operator's own seat and a bot filling a
      // side are the two ways a match is meant to go lopsided.
      if (
        this.cvarInt('g_teamForceBalance') &&
        !client.pers.localClient &&
        !(entity.r.svFlags & SVF.BOT)
      ) {
        const blue = this.teamCount(TEAM.BLUE, clientNum);
        const red = this.teamCount(TEAM.RED, clientNum);
        if (team === TEAM.RED && red - blue > 1) {
          this.traps.sendServerCommand(clientNum, 'cp "Red team has too many players.\n"');
          return;
        }
        if (team === TEAM.BLUE && blue - red > 1) {
          this.traps.sendServerCommand(clientNum, 'cp "Blue team has too many players.\n"');
          return;
        }
      }
    } else {
      // "Force them to spectators if there aren't any spots free" — which is what the override
      // below does; every other word is the free team a game without sides has (`:578–581`).
      team = TEAM.FREE;
    }

    // "Override decision if limiting the players": a tournament plays two, and
    // `g_maxGameClients` caps the rest (`:604–611`).
    if (this.gametype === GT.TOURNAMENT && this.level.numNonSpectatorClients >= 2) {
      team = TEAM.SPECTATOR;
    } else if (
      this.maxGameClients > 0 &&
      this.level.numNonSpectatorClients >= this.maxGameClients
    ) {
      team = TEAM.SPECTATOR;
    }

    // Asking for the team already held changes nothing — except among the spectators, where the
    // sort of spectator can change without the team doing so.
    const oldTeam = client.sess.sessionTeam;
    if (team === oldTeam && team !== TEAM.SPECTATOR) return;

    // "If the player was dead leave the body, but only if they're actually in game." Whoever
    // watches from a side left theirs when they started watching.
    const watching = isSpectator(client);
    if (
      client.ps.stats[STAT.HEALTH] <= 0 &&
      client.pers.connected === CON.CONNECTED &&
      !watching
    ) {
      copyToBodyQue(this.level, entity);
    }

    client.pers.teamState.state = TEAM_STATE.BEGIN;
    if (!watching) {
      // "Kill him (makes sure he loses flags, etc)": `player_die` outright rather than damage, so
      // neither god mode nor armour can save a player from leaving the game.
      entity.flags &= ~FL.GODMODE;
      client.ps.stats[STAT.HEALTH] = 0;
      entity.health = 0;
      entity.die?.(entity, entity, entity, TELEFRAG_DAMAGE, MOD.SUICIDE);
    }

    // "They go to the end of the line for tournements."
    if (team === TEAM.SPECTATOR && oldTeam !== team) this.addTournamentQueue(client);

    // Clan Arena's round is played out by the sides it began with (CPMA): whoever joins one while
    // it is played watches from it until the next, and is told so rather than announced.
    const waits =
      this.gametype === GT.CA &&
      this.level.roundTime === 0 &&
      (team === TEAM.RED || team === TEAM.BLUE);

    client.sess.sessionTeam = team;
    client.pers.roundSpectator = waits;
    client.sess.spectatorState = waits ? SPECTATOR.FREE : specState;
    client.sess.spectatorClient = specClient;
    // The team leader is the sides' bookkeeping, and arrives with them.
    client.sess.teamLeader = false;

    this.clientUserinfoChanged(clientNum);

    // "Client hasn't spawned yet, they sent an early team command": nothing to begin.
    if (client.pers.connected !== CON.CONNECTED) return;

    if (waits) {
      this.traps.sendServerCommand(
        clientNum,
        `cp "You will join ${CA_TEAM_NAMES[team]} next round\n"`
      );
    } else {
      this.broadcastTeamChange(client, oldTeam);
    }
    this.clientBegin(clientNum);
  }

  /**
   * `BroadcastTeamChange` (`g_cmds.c:493–508`): everyone is told, in the middle of the screen.
   *
   * Joining the spectators is only announced by somebody who was playing, so a spectator moving
   * between free flight, a camera and the scoreboard says nothing.
   *
   * @param client - Whoever changed.
   * @param oldTeam - The team they were on.
   */
  private broadcastTeamChange(client: GameClient, oldTeam: number): void {
    const name = `${client.pers.netname}^7`;
    let text: string | null = null;
    if (client.sess.sessionTeam === TEAM.RED) text = `${name} joined the red team.`;
    else if (client.sess.sessionTeam === TEAM.BLUE) text = `${name} joined the blue team.`;
    else if (client.sess.sessionTeam === TEAM.SPECTATOR && oldTeam !== TEAM.SPECTATOR) {
      text = `${name} joined the spectators.`;
    } else if (client.sess.sessionTeam === TEAM.FREE) text = `${name} joined the battle.`;
    if (text !== null) this.traps.sendServerCommand(null, `cp "${text}\n"`);
  }

  /**
   * `AddTournamentPlayer` (`g_main.c:581–622`): the spectator who has waited longest comes on.
   *
   * Nobody is seated into a match that already has its two, nor at an intermission, where the
   * scoreboard is up and the next round is on its way. The two dedicated cameras and the
   * scoreboard spectator are passed over — "never select the dedicated follow or scoreboard
   * clients" — because those are ways of watching rather than places in a queue.
   *
   * The wait is longest where {@link addTournamentQueue}'s number is highest, and a tie is taken
   * by the lower slot, which is the first one the loop meets.
   *
   * `level.warmupTime` goes back to −1 before the seating, so that the countdown starts again
   * from the moment the match is whole rather than carrying on from where it was.
   *
   * **The second count is the port's**. Quake 3 asks `numPlayingClients` here and
   * {@link setTeam} asks `numNonSpectatorClients` when it decides whether to allow the seat, and
   * the two disagree about a client that has connected but not yet begun: `CalculateRanks` counts
   * it among the non-spectators and not among the playing. So a bot waiting out `addbot`'s delay
   * leaves a seat that looks empty here and full there, and the spectator at the front of the
   * queue is seated and refused once every game frame for as long as the wait lasts — each
   * refusal a whole `ClientBegin`, which respawns them and pins their view to the spawn's facing.
   * Quake 3 does this too; at 125 frames a second the port does it six times as fast. Asking the
   * question `SetTeam` will answer leaves the seat for the client already on its way to it.
   */
  private addTournamentPlayer(): void {
    const level = this.level;
    if (level.numPlayingClients >= 2) return;
    if (level.numNonSpectatorClients >= 2) return;
    if (level.intermissiontime) return;

    let nextInLine: GameClient | null = null;
    let nextSlot = -1;
    for (let i = 0; i < this.maxclients; i++) {
      const client = level.clients[i];
      if (client.pers.connected !== CON.CONNECTED) continue;
      if (client.sess.sessionTeam !== TEAM.SPECTATOR) continue;
      if (client.sess.spectatorState === SPECTATOR.SCOREBOARD) continue;
      if (client.sess.spectatorClient < 0) continue;

      if (!nextInLine || client.sess.spectatorNum > nextInLine.sess.spectatorNum) {
        nextInLine = client;
        nextSlot = i;
      }
    }

    if (!nextInLine) return;

    level.warmupTime = -1;
    this.setTeam(level.gentities[nextSlot], 'f');
  }

  /**
   * `RemoveTournamentLoser` (`g_main.c:659–673`): whoever came second goes to the back of the
   * line, which is what makes the queue move.
   *
   * It reads the ranking rather than the scores, so a draw is settled by {@link sortRanks} — the
   * earlier arrival keeps the seat — and only a match of exactly two has a loser to remove.
   *
   * Quake 3's `RemoveTournamentWinner` beside it is dead code in baseq3: nothing calls it, so it
   * is not ported.
   */
  private removeTournamentLoser(): void {
    const level = this.level;
    if (level.numPlayingClients !== 2) return;

    const clientNum = level.sortedClients[1];
    if (level.clients[clientNum].pers.connected !== CON.CONNECTED) return;

    this.setTeam(level.gentities[clientNum], 's');
  }

  /**
   * `AddTournamentQueue` (`g_main.c:633–653`): this client goes to the front of the queue, and
   * every other spectator moves one back.
   *
   * The number is how long somebody has been waiting rather than where they stand, so the
   * *highest* is next on — which is what {@link addTournamentPlayer} reads.
   *
   * @param client - The client joining the queue.
   */
  private addTournamentQueue(client: GameClient): void {
    for (let i = 0; i < this.maxclients; i++) {
      const other = this.level.clients[i];
      if (other.pers.connected === CON.DISCONNECTED) continue;
      if (other === client) other.sess.spectatorNum = 0;
      else if (other.sess.sessionTeam === TEAM.SPECTATOR) other.sess.spectatorNum++;
    }
  }

  /**
   * `ClientNumberFromString` (`g_cmds.c:44–80`), with Quake 3's two ways of naming a client: the
   * slot number, and the name with its colours taken off.
   *
   * @param to - Who asked, and who is told when nobody answers.
   * @param name - The slot or the name.
   * @returns The slot, or −1.
   */
  private clientNumberFromString(to: number, name: string): number {
    if (/^\d+$/.test(name)) {
      const slot = Number(name);
      if (slot >= 0 && slot < this.maxclients) {
        if (this.level.clients[slot].pers.connected === CON.CONNECTED) return slot;
      }
    }

    for (let i = 0; i < this.maxclients; i++) {
      const client = this.level.clients[i];
      if (client.pers.connected !== CON.CONNECTED) continue;
      if (cleanStr(client.pers.netname).toLowerCase() === name.toLowerCase()) return i;
    }

    this.traps.sendServerCommand(to, `print "User ${name} is not on the server\n"`);
    return -1;
  }

  /**
   * `Cmd_Kill_f` (`g_cmds.c:474–484`): the `kill` command, a death by the player's own hand.
   *
   * Spectators and the dead are passed over; a Clan Arena player watching from a side is a
   * spectator here as everywhere. Anyone else loses god mode and goes to −999 health, then dies as
   * a suicide, which `player_die` always gibs and scores a point down.
   *
   * @param entity - The client's entity.
   */
  private cmdKill(entity: GameEntity): void {
    const client = entity.client!;
    if (isSpectator(client)) return;
    if (client.ps.stats[STAT.HEALTH] <= 0) return;
    entity.flags &= ~FL.GODMODE;
    client.ps.stats[STAT.HEALTH] = entity.health = -999;
    entity.die?.(entity, entity, entity, TELEFRAG_DAMAGE, MOD.SUICIDE);
  }

  /**
   * `Cmd_Team_f` (`g_cmds.c:682–721`): the `team` command, which is how a client asks to play or
   * to watch.
   *
   * With no argument it says which team the client is on. With one it is `SetTeam`, behind a
   * five-second gate so that a client cannot flicker between teams, and at the cost of a
   * tournament loss to a player who walks out of a match.
   *
   * @param entity - The client's entity.
   * @param argv - The command, tokenized.
   */
  private cmdTeam(entity: GameEntity, argv: readonly string[]): void {
    const clientNum = entity.s.number;
    const client = this.level.clients[clientNum];

    if (argv.length !== 2) {
      const named: Record<number, string> = {
        [TEAM.BLUE]: 'Blue team',
        [TEAM.RED]: 'Red team',
        [TEAM.FREE]: 'Free team',
        [TEAM.SPECTATOR]: 'Spectator team'
      };
      const name = named[client.sess.sessionTeam];
      if (name) this.traps.sendServerCommand(clientNum, `print "${name}\n"`);
      return;
    }

    if (client.switchTeamTime > this.level.time) {
      this.traps.sendServerCommand(
        clientNum,
        'print "May not switch teams more than once per 5 seconds.\n"'
      );
      return;
    }

    this.countTournamentWalkout(client);
    this.setTeam(entity, argv[1]);
    client.switchTeamTime = this.level.time + TEAM_SWITCH_TIME;
  }

  /**
   * `Cmd_Follow_f` (`g_cmds.c:729–768`): watch a client by name or by slot.
   *
   * With no argument it is the way off a view being followed. A spectator cannot be followed, nor
   * can the client asking, and a player who asks stops playing to do it. Whoever already watches
   * from a side stays on it.
   *
   * @param entity - The client's entity.
   * @param argv - The command, tokenized.
   */
  private cmdFollow(entity: GameEntity, argv: readonly string[]): void {
    const clientNum = entity.s.number;
    const client = this.level.clients[clientNum];

    if (argv.length !== 2) {
      if (client.sess.spectatorState === SPECTATOR.FOLLOW) this.stopFollowing(entity);
      return;
    }

    const watched = this.clientNumberFromString(clientNum, argv[1]);
    if (watched === -1) return;
    if (watched === clientNum) return;
    if (isSpectator(this.level.clients[watched])) return;

    this.countTournamentWalkout(client);
    if (!isSpectator(client)) this.setTeam(entity, 'spectator');

    client.sess.spectatorState = SPECTATOR.FOLLOW;
    client.sess.spectatorClient = watched;
  }

  /**
   * The loss a tournament counts against a player who stops playing of their own accord
   * (`g_cmds.c:710–714, 754–758, 782–786`), which `team`, `follow` and the follow cycle all do.
   *
   * @param client - Whoever is about to leave the match.
   */
  private countTournamentWalkout(client: GameClient): void {
    if (this.gametype === GT.TOURNAMENT && client.sess.sessionTeam === TEAM.FREE) {
      client.sess.losses++;
    }
  }

  /**
   * `Cmd_FollowCycle_f` (`g_cmds.c:776–831`): watch the next client this spectator can watch.
   *
   * A dedicated camera switches between the two rather than walking the slots. Everyone else
   * steps through the clients in `dir`, over everyone who is not connected and everyone who is
   * spectating too, and stops where it started if it finds nobody — "leave it where it was".
   *
   * @param entity - The spectator's entity.
   * @param dir - 1 for the next client, −1 for the previous.
   */
  followCycle(entity: GameEntity, dir: number): void {
    const client = this.level.clients[entity.s.number];

    // A player who cycles the view stops playing to do it, and pays a tournament's price for it.
    this.countTournamentWalkout(client);
    if (client.sess.spectatorState === SPECTATOR.NOT) this.setTeam(entity, 'spectator');

    if (client.sess.spectatorClient < 0) {
      if (client.sess.spectatorClient === -1) client.sess.spectatorClient = -2;
      else if (client.sess.spectatorClient === -2) client.sess.spectatorClient = -1;
      return;
    }

    let clientNum = client.sess.spectatorClient;
    const original = clientNum;
    do {
      clientNum += dir;
      if (clientNum >= this.maxclients) clientNum = 0;
      if (clientNum < 0) clientNum = this.maxclients - 1;

      const other = this.level.clients[clientNum];
      if (other.pers.connected !== CON.CONNECTED) continue;
      if (isSpectator(other)) continue;

      client.sess.spectatorClient = clientNum;
      client.sess.spectatorState = SPECTATOR.FOLLOW;
      return;
    } while (clientNum !== original);
  }

  /**
   * `ClientEndFrame` (`g_active.c:1085–1155`): the frame's last word on one client.
   *
   * What the rest of it does is the life's ({@link PlayerLife.endFrame}); what is here is the
   * things the lifecycle decides — that the expired powerups are turned off, which Q3 does before
   * it returns for the intermission, that a client at the intermission gets none of the rest,
   * because `ClientEndFrame` returns before any of it, and that the frame's last words are
   * unlagged's: the smoothing and its connection-trouble sprite ({@link smoothClient}), then the
   * history a rewind reads (`G_StoreHistory`), run for neither a spectator nor anyone at the
   * intermission.
   *
   * @param entity - The client's entity.
   * @param clientNum - The slot, which Quake 3 has in `ent->client` and the port takes from the
   *   frame's own loop. It is not `entity.s.number`: that is written over by the entity state a
   *   client with no state of its own builds, and the life wanted here is the slot's.
   */
  clientEndFrame(entity: GameEntity, clientNum: number): void {
    const client = entity.client;
    if (!client) return;

    // A spectator's end of frame is its own and stops there: no powerups, no feedback, no entity
    // state — and for a follower, the state it is handed is somebody else's (`g_active.c:1110`).
    if (isSpectator(client)) {
      this.spectatorClientEndFrame(entity);
      return;
    }

    expirePowerups(client.ps, this.level.time);
    // Nothing else about a client is rebuilt at the intermission: `ClientEndFrame` returns before
    // the feedback and the entity state, so what the camera was moved to is what everyone goes on
    // being shown.
    if (this.level.intermissiontime) return;
    this.lives[clientNum].endFrame();
    // Once the player is in the game (a bot is in use while it connects): slid on if their
    // commands are late, then recorded where a snapshot shows them, for a later shot to rewind to.
    if (client.pers.connected === CON.CONNECTED) {
      const gravity = Number.parseFloat(this.cvars.get('g_gravity')) || 0;
      smoothClient(this.level, entity, this.cvarInt('g_smoothClients') !== 0, gravity);
      storeHistory(this.level, entity);
    }
  }

  /**
   * `G_RunFrame` (`g_main.c:1785–1897`), which the match itself runs, and unlagged's last line of
   * it: when the frame ended. A frame a restart turns away stamps nothing.
   */
  runFrame(levelTime: number): void {
    if (this.level.restarted) return;
    this.level.runFrame(levelTime);
    this.level.frameStartTime = this.traps.milliseconds();
  }

  /**
   * `ConsoleCommand` (`g_svcmds.c:451–512`): a command from the console, which the host offers
   * here when it is none of its own.
   *
   * @returns whether it was the game module's
   */
  consoleCommand(command: string): boolean {
    const argv = tokenize(command);
    if (!isGameCommand(argv[0])) return false;
    this.addBotCommand(argv);
    return true;
  }

  /**
   * `Svcmd_AddBot_f` (`g_bot.c:752–804`): `addbot <name> [skill 1-5] [team] [msec delay]
   * [altname]`.
   *
   * @param argv - The command, tokenised.
   */
  private addBotCommand(argv: readonly string[]): void {
    const [, name, skill, team, delay, altname] = argv;
    if (!name) {
      this.traps.print('Usage: Addbot <botname> [skill 1-5] [team] [msec delay] [altname]');
      return;
    }
    this.addBot(
      name,
      {
        skill: skill ? Math.min(5, Math.max(1, Number.parseFloat(skill) || 0)) : 4,
        team: team ?? '',
        altname: altname ?? ''
      },
      delay ? Number.parseInt(delay, 10) || 0 : 0
    );
    // "if this was issued during gameplay and we are playing locally, go ahead and load the bot's
    // media immediately" (`g_bot.c:798–803`), in the command's spelling.
    if (this.level.time - this.level.startTime > 1000 && this.cvarInt('cl_running') !== 0) {
      this.traps.sendServerCommand(null, 'loaddefered\n');
    }
  }

  /**
   * `G_AddBot` (`g_bot.c:583–744`): a bot takes a slot, joins as a client would, and begins now
   * or after its delay.
   *
   * @param name - The bot's `name` in the bot files.
   * @param request - Its skill, team and name; a team of `''` is chosen here.
   * @param delay - Milliseconds before it begins.
   */
  addBot(name: string, request: BotRequest, delay: number): void {
    const clientNum = this.traps.botAllocateClient();
    if (clientNum === -1) {
      this.traps.print('Unable to add bot. All player slots are in use.');
      this.traps.print(
        "Start server with more 'open' slots (or check setting of sv_maxclients cvar)."
      );
      return;
    }

    let { team } = request;
    if (!team) {
      if (this.gametype >= GT.TEAM) team = this.pickTeam(clientNum) === TEAM.RED ? 'red' : 'blue';
      else team = 'free';
    }

    const botinfo = botInfoByName(this.botInfos, name);
    if (!botinfo) {
      this.traps.print(`Error: Bot '${name}' not defined`);
      this.traps.botFreeClient(clientNum);
      return;
    }

    const built = botUserinfo(botinfo, { ...request, team });
    if ('error' in built) {
      this.traps.print(built.error);
      this.traps.botFreeClient(clientNum);
      return;
    }
    this.traps.setUserinfo(clientNum, built.userinfo);

    if (this.clientConnect(clientNum, true, true) !== null) return;

    if (delay === 0) {
      this.clientBegin(clientNum);
    } else if (!this.botSpawnQueue.add(clientNum, this.level.time + delay)) {
      this.traps.print('Unable to delay spawn');
      this.clientBegin(clientNum);
    }
  }

  /**
   * Which slot a client's entity is, as Quake 3's `clientNum = client - level.clients`
   * (`g_cmds.c:527–528`).
   *
   * Not `s.number`, although a client's entity carries its slot there for nearly all of its life:
   * `BG_PlayerStateToEntityState` writes a zeroed player state's `clientNum` over it while a
   * client is connected without having begun, and `ClientConnect` — which is where a team
   * preference joins a side — is inside that window.
   *
   * @param entity - A client's entity.
   */
  private clientSlot(entity: GameEntity): number {
    const { client } = entity;
    return client ? this.level.clients.indexOf(client) : entity.s.number;
  }

  /**
   * `G_CheckTeamItems` (`g_items.c:723–745`): the flags start at their bases, and a map that
   * should have two and has not is complained about.
   *
   * The warning is all Quake 3 does: a CTF map with no flags is playable and unwinnable, and
   * saying so on the console is the whole remedy.
   */
  private checkTeamItems(): void {
    initTeamGame(this.level, this.gametype);
    if (this.gametype !== GT.CTF) return;

    for (const classname of ['team_CTF_redflag', 'team_CTF_blueflag']) {
      const item = findItem(classname);
      if (!item || !this.level.itemsRegistered[itemIndex(item)]) {
        this.traps.print(`^3WARNING: No ${classname} in map\n`);
      }
    }
  }

  /**
   * `SelectRandomTeamSpawnPoint` (`g_team.c:968–1013`): one of a side's own spots, at random.
   *
   * Which spots those are depends on why the player is arriving: a side starts a match at its
   * `player` spots and comes back to its `spawn` spots, which is what lets a map put both teams
   * in their own bases at the whistle and scatter them afterwards. Nobody who is on neither side
   * has any.
   *
   * A spot somebody is standing on is passed over; when that leaves none, the first spot of the
   * kind is taken anyway and the telefrag clears it.
   *
   * @param teamstate - `pers.teamState.state`: `TEAM_BEGIN` for a match starting.
   * @param team - The side arriving.
   * @returns the spot, or null for a side with none of that kind
   */
  private selectRandomTeamSpawnPoint(teamstate: number, team: number): GameEntity | null {
    let classname: string;
    if (teamstate === TEAM_STATE.BEGIN) {
      if (team === TEAM.RED) classname = 'team_CTF_redplayer';
      else if (team === TEAM.BLUE) classname = 'team_CTF_blueplayer';
      else return null;
    } else if (team === TEAM.RED) classname = 'team_CTF_redspawn';
    else if (team === TEAM.BLUE) classname = 'team_CTF_bluespawn';
    else return null;

    const spots: GameEntity[] = [];
    for (
      let spot = this.level.find(null, 'classname', classname);
      spot;
      spot = this.level.find(spot, 'classname', classname)
    ) {
      if (this.spotWouldTelefrag(spot)) continue;
      spots.push(spot);
      if (spots.length === MAX_TEAM_SPAWN_POINTS) break;
    }

    // "No spots that won't telefrag."
    if (spots.length === 0) return this.level.find(null, 'classname', classname);

    return spots[Math.floor(this.random() * spots.length)];
  }

  /**
   * `SelectCTFSpawnPoint` (`g_team.c:1018–1033`): where a side's player arrives.
   *
   * A map with no spots for this side falls back to the ordinary search, measured from the map's
   * origin rather than from where the player was — so a CTF map that forgot its team spots plays
   * like a free-for-all rather than not at all.
   *
   * @param team - The side arriving.
   * @param teamstate - `pers.teamState.state`.
   * @param isbot - The player is a bot, for the spots closed to bots or to humans.
   */
  private selectCTFSpawnPoint(team: number, teamstate: number, isbot: boolean): SpawnPoint {
    const spot = this.selectRandomTeamSpawnPoint(teamstate, team);
    if (!spot) return this.selectSpawnPoint(vec3(), isbot);
    return spawnAt(spot);
  }

  /**
   * `PickTeam` (`g_client.c:592–609`): the team with fewer players, or on a tie the one behind.
   *
   * @param ignoreClientNum - A client not to count, being the one choosing.
   */
  private pickTeam(ignoreClientNum: number): number {
    const blue = this.teamCount(TEAM.BLUE, ignoreClientNum);
    const red = this.teamCount(TEAM.RED, ignoreClientNum);
    if (blue > red) return TEAM.RED;
    if (red > blue) return TEAM.BLUE;
    const { teamScores } = this.level;
    return teamScores[TEAM.BLUE] > teamScores[TEAM.RED] ? TEAM.RED : TEAM.BLUE;
  }

  /**
   * `BotAIStartFrame` (`ai_main.c:1401–1587`) for bots that never think, having no AAS to think
   * about: the bots waiting out a delay begin, and each bot is sent its command, as Q3 sends every
   * bot's each frame, so none goes a second without one and wears the connection sprite.
   *
   * With no think to rewrite it, a bot's command is the last it was sent, as Q3's `lastucmd` is
   * between thinks. A bot's server commands are read in its think, so they are read here instead,
   * unless `bot_pause` is on: otherwise the host drops a bot once 64 are unread.
   *
   * @param time - The time the game's frames are about to reach.
   */
  botAIStartFrame(time: number): void {
    // `G_CheckBotSpawn` (`g_bot.c:490–511`).
    for (const clientNum of this.botSpawnQueue.due(this.level.time)) this.clientBegin(clientNum);

    const bots: number[] = [];
    for (let i = 0; i < MAX_CLIENTS; i++) {
      const entity = this.level.gentities[i];
      if (!entity.inuse || !(entity.r.svFlags & SVF.BOT)) continue;
      if (this.level.clients[i].pers.connected !== CON.CONNECTED) continue;
      bots.push(i);
    }

    // `bot_pause` (`ai_main.c:1429–1446`) reads a bot nothing and stills its command.
    const paused = this.cvarInt('bot_pause') !== 0;
    for (const clientNum of bots) {
      if (!paused) while (this.traps.botGetServerCommand(clientNum) !== null);

      const cmd = createNetUserCmd();
      copyNetUserCmd(this.traps.getUserCmd(clientNum), cmd);
      if (paused) {
        cmd.forwardmove = 0;
        cmd.rightmove = 0;
        cmd.upmove = 0;
        cmd.buttons = 0;
      }
      cmd.serverTime = time;
      this.traps.botUserCommand(clientNum, cmd);
    }
  }

  entity(number: number): GameEntity {
    return this.level.gentities[number];
  }

  numEntities(): number {
    return this.level.numEntities;
  }

  playerState(clientNum: number): PlayerState {
    return this.level.clients[clientNum].ps;
  }

  // --- the client's life --------------------------------------------------------------------

  /**
   * `ClientSpawn` (`g_client.c:1043–1240`): put a client into the world with a fresh life.
   *
   * It runs after the first {@link Game.clientBegin} and after every respawn, and everything it
   * touches is the life's rather than the player's: the client is cleared apart from the two
   * outer lifetimes, given a spawn point, and handed the loadout Quake 3 hands out — every weapon
   * it starts with, the machinegun in hand, health 25 over the limit and draining back down.
   *
   * What the player arrives *with* is {@link PlayerLife.spawn}'s, because it is the life rather
   * than the lifecycle: the loadout, the health that drains back to the limit, and a body that
   * can be hurt again. What is here is where they appear and what the rest of the match is told.
   *
   * Where they appear is one of four choices (`g_client.c:1069–1096`). A spectator starts at the
   * intermission camera, and so does a player watching from a side, whom nothing links. A local
   * player's first spawn goes to the spot the map marked for it. Every other spawn goes as far
   * from where the client was as the map allows. The fourth is CTF's, where a side arrives at its
   * own base. Clan Arena's side arrives at its own spawn spots, and where the map has none, as team
   * deathmatch's does.
   *
   * The 100 ms think "to drop exactly to the floor" is at the end of a spawn, as Q3's is.
   *
   * @param entity - The client's entity, which must be out of the world, as Quake 3's always is:
   *   a spot it was standing on would be taken for somebody else's, and the telefrag would find it.
   */
  clientSpawn(entity: GameEntity): void {
    const index = entity.s.number;
    const client = this.level.clients[index];

    // The spawn point is chosen before the health goes back up, so that the furthest-away search
    // is not measuring against this client's own corpse.
    const isbot = (entity.r.svFlags & SVF.BOT) !== 0;
    const spectating = isSpectator(client);
    let spawnPoint: SpawnPoint;
    const arenaSpot =
      this.gametype === GT.CA && !spectating
        ? this.selectRandomTeamSpawnPoint(TEAM_STATE.ACTIVE, client.sess.sessionTeam)
        : null;
    if (spectating) {
      spawnPoint = this.selectSpectatorSpawnPoint();
    } else if (arenaSpot) {
      spawnPoint = spawnAt(arenaSpot);
    } else if (this.gametype >= GT.CTF && this.gametype !== GT.CA) {
      // "All base oriented team games use the CTF spawn points" (`g_client.c:1072–1078`), which
      // is one test and covers every mode with bases in it.
      spawnPoint = this.selectCTFSpawnPoint(
        client.sess.sessionTeam,
        client.pers.teamState.state,
        isbot
      );
    } else if (!client.pers.initialSpawn && client.pers.localClient) {
      // "The first spawn should be at a good looking spot."
      client.pers.initialSpawn = true;
      spawnPoint = this.selectInitialSpawnPoint(isbot);
    } else {
      // "Don't spawn near existing origin if possible."
      spawnPoint = this.selectSpawnPoint(client.ps.origin, isbot);
    }
    client.pers.teamState.state = TEAM_STATE.ACTIVE;

    // The teleport bit says "do not interpolate to where I now am"; the two vote flags are never
    // cleared, because a respawn must not give a client its vote back.
    let flags = client.ps.eFlags & (EF_TELEPORT_BIT | EF_VOTED | EF_TEAMVOTED);
    flags ^= EF_TELEPORT_BIT;

    // "we don't want players being backward-reconciled to the place they died" (unlagged's). The
    // clearing just below zeroes both again, in unlagged and Excessive Plus alike.
    resetHistory(this.level, entity);
    client.saved.time = NOT_SAVED;

    clearClientForSpawn(client);

    // The spawn count is the life's (`PlayerLife.spawn`), where `ClientSpawn`'s other half is:
    // every spawn goes through it, and counting one here as well would count each twice.
    client.ps.persistant[PERS.TEAM] = client.sess.sessionTeam;
    client.airOutTime = this.level.time + AIR_OUT_TIME;

    client.pers.maxHealth = handicapOf(this.traps.getUserinfo(index));
    client.ps.stats[STAT.MAX_HEALTH] = client.pers.maxHealth;
    client.ps.eFlags = flags;

    entity.s.groundEntityNum = ENTITYNUM_NONE;
    entity.client = client;
    entity.inuse = true;
    entity.classname = 'player';
    entity.r.contents = CONTENTS.BODY;
    entity.clipmask = MASK.PLAYERSOLID;
    entity.waterlevel = 0;
    entity.watertype = 0;

    client.ps.clientNum = index;

    // What the player arrives with, and the life they arrive in: the loadout, health 25 over the
    // max, and a body that can be hurt again. The ammo bonus is tourney's and CTF's once the match
    // is live, as CPMA gives it in its duel and flag modes.
    const bonusMode = this.gametype === GT.TOURNAMENT || this.gametype === GT.CTF;
    this.lives[index].spawn(
      this.gametype === GT.CA
        ? { arena: CA_LOADOUT }
        : {
            armor: this.cvarInt('pcq_spawnArmor'),
            weapons: this.cvarInt('pcq_spawnWeapons') !== 0,
            ammoBonus: bonusMode && !this.level.warmupTime
          }
    );
    if (this.gametype === GT.TEAM) client.ps.ammo[WP.MACHINEGUN] = 50;

    setOrigin(entity, spawnPoint.origin);
    client.ps.origin.x = spawnPoint.origin.x;
    client.ps.origin.y = spawnPoint.origin.y;
    client.ps.origin.z = spawnPoint.origin.z;

    copyNetUserCmd(this.traps.getUserCmd(index), client.pers.cmd);
    setClientViewAngle(entity, spawnPoint.angles);

    client.inactivityTime = this.level.time + this.cvarInt('g_inactivity') * 1000;
    client.latchedButtons = 0;

    if (this.level.intermissiontime) {
      // A spawn that happens while the match is being watched goes to the camera instead, which
      // is what puts a client arriving in the middle of an intermission where everyone else is.
      this.moveClientToIntermission(entity);
    } else if (!spectating) {
      killBox(this.level, entity);
      // The spot's own targets fire with the player as the one who set them off, which is how a
      // map hands a weapon out at a spawn. Quake 3 raises the highest weapon owned after this, so
      // the one handed out comes up in hand; the port's life raises it before, which is the same
      // while nothing a target fires can hand one out.
      useTargets(this.level, spawnPoint.spot, entity, (text) => this.traps.print(text));
      // Linked from the player state's own origin, so a client whose command times are strange is
      // still somewhere rather than nowhere.
      entity.r.currentOrigin.x = client.ps.origin.x;
      entity.r.currentOrigin.y = client.ps.origin.y;
      entity.r.currentOrigin.z = client.ps.origin.z;
      // The arrival's effect, at every spawn into the world: ioquake3's, where id's raised it
      // after a respawn and after `ClientBegin` instead (`g_client.c:1221–1222`).
      const arrival = tempEntity(this.level, client.ps.origin, EV.PLAYER_TELEPORT_IN);
      arrival.s.clientNum = entity.s.clientNum;
      this.traps.linkEntity(entity);
    }

    // Quake 3 sets the clock back 100 ms and runs the spawn's think on it, "to drop exactly to
    // the floor" (`g_client.c:1230–1242`). The think reads the client's own command, as
    // `ClientThink` does, so a respawn's gets the span since its last. A client coming into the
    // world sends its first commands stamped 0, having no snapshot to time them by, so past the
    // level's first 100 ms, where the settle frames always leave it, its think moves nothing and
    // its first command does the dropping. Where the think moves, it leaves `commandTime` on the
    // move's grid, `viewheight` and the ground state set, and the spawn's triggers touched —
    // before any snapshot carries the state to anyone, the player's own client included.
    //
    // The move's own numbers are set first: a think whose command is too old to move still
    // leaves a state a client can predict from, rather than a zero speed.
    client.ps.speed = this.cvarInt('g_speed');
    client.ps.gravity = this.cvarInt('g_gravity');
    client.ps.commandTime = this.level.time - 100;
    this.clientThink(index);

    // The pre-send, which Q3 skips for a follower: what it sets is somebody else's state.
    // Then the entity state, with the events cleared, as `ClientSpawn`'s last line has it.
    if (client.sess.spectatorState !== SPECTATOR.FOLLOW) {
      this.clientEndFrame(entity, index);
    }
    playerStateToEntityState(client.ps, entity.s, true);
  }

  /**
   * `ClientRespawn` (`g_client.c:530–534`): leave the body where it fell, and spawn afresh.
   *
   * Leaving the body takes the client out of the world, which is what the spawn needs before it
   * looks for a free spot and telefrags whoever is on it. The life's own respawn is the same two
   * calls, made from inside the life.
   *
   * @param entity - The client's entity.
   */
  clientRespawn(entity: GameEntity): void {
    copyToBodyQue(this.level, entity);
    this.clientSpawn(entity);
  }

  /**
   * The personal teleporter (`ClientEvents`, `g_active.c:578–628`): a spawn spot, chosen as a
   * respawn's is, away from where the player stands, which is what throws them across the map,
   * and {@link teleportPlayer} to it. The spot they are standing on is passed over, since they
   * hold it until the move unlinks them.
   *
   * ioquake3 chooses it as for a human whatever the player is, so a bot may land on a spot the map
   * closes to bots.
   *
   * @param entity - The client using it, which must be in the world: the effects are placed
   *   around it, and the spot it stands on is skipped.
   */
  useTeleporter(entity: GameEntity): void {
    const client = entity.client;
    if (!client) return;
    const point = this.selectSpawnPoint(client.ps.origin, false);
    teleportPlayer(this.level, entity, point.origin, point.angles);
  }

  /**
   * `SelectRandomFurthestSpawnPoint` (`g_client.c:183–259`), which is all `SelectSpawnPoint` is:
   * pick a spawn spot away from where the player just was.
   *
   * The map's spots are ranked by how far each is from the point to avoid, and one of the furthest
   * half is taken at random, so a respawn is unpredictable without being anywhere near the place
   * that just killed the player. The spawn stands the player {@link SPAWN_LIFT} above the spot.
   *
   * A spot somebody is standing on is passed over, and so is one closed to this kind of player.
   * When that leaves none, the map's first spot is taken whoever is on it, and the telefrag clears
   * it.
   *
   * @param avoid - Where not to spawn near: the player state's origin, so the place they died.
   * @param isbot - The player is a bot, for the spots closed to bots or to humans.
   * @throws with Q3's `G_Error` for a map with no spawn spot at all
   */
  selectSpawnPoint(avoid: Vec3, isbot: boolean): SpawnPoint {
    // The list is kept in order as it is built, furthest first, and a full one gives up its
    // nearest to make room.
    const spots: GameEntity[] = [];
    const dists: number[] = [];
    for (let spot = this.findSpawnSpot(null); spot; spot = this.findSpawnSpot(spot)) {
      if (this.spotWouldTelefrag(spot)) continue;
      if (spotClosedTo(spot, isbot)) continue;

      const dist = distance(spot.s.origin, avoid);
      let i = 0;
      for (; i < spots.length; i++) {
        if (dist > dists[i]) {
          if (spots.length >= MAX_SPAWN_POINTS) {
            spots.length = MAX_SPAWN_POINTS - 1;
            dists.length = MAX_SPAWN_POINTS - 1;
          }
          spots.splice(i, 0, spot);
          dists.splice(i, 0, dist);
          break;
        }
      }
      if (i >= spots.length && spots.length < MAX_SPAWN_POINTS) {
        spots.push(spot);
        dists.push(dist);
      }
    }

    if (spots.length === 0) {
      const spot = this.findSpawnSpot(null);
      if (!spot) throw new Error("Couldn't find a spawn point");
      return spawnAt(spot);
    }

    return spawnAt(spots[Math.floor(this.random() * Math.floor(spots.length / 2))]);
  }

  /**
   * `SelectInitialSpawnPoint` (`g_client.c:308–333`): a local player's first spawn, at the spot the
   * map marked for it.
   *
   * The first spot open to this player with {@link SPAWNFLAG_INITIAL} set is the one. Without one,
   * or with somebody standing on it, the spawn is an ordinary one measured from the map's origin.
   *
   * @param isbot - The player is a bot, for the spots closed to bots or to humans.
   */
  private selectInitialSpawnPoint(isbot: boolean): SpawnPoint {
    let spot = this.findSpawnSpot(null);
    for (; spot; spot = this.findSpawnSpot(spot)) {
      if (spotClosedTo(spot, isbot)) continue;
      if (spot.spawnflags & SPAWNFLAG_INITIAL) break;
    }

    if (!spot || this.spotWouldTelefrag(spot)) return this.selectSpawnPoint(vec3(), isbot);
    return spawnAt(spot);
  }

  /**
   * `SelectSpectatorSpawnPoint` (`g_client.c:341–348`): a spectator starts where the intermission
   * camera sits, looking where it looks, and at no spot at all.
   */
  private selectSpectatorSpawnPoint(): SpawnPoint {
    this.findIntermissionPoint();
    return {
      spot: null,
      origin: copy(this.level.intermissionOrigin),
      angles: copy(this.level.intermissionAngle)
    };
  }

  /**
   * `SpotWouldTelefrag` (`g_client.c:81–101`): whether a client is in the box a player would take
   * up at this spot.
   *
   * The box is a standing player's about the spot itself, not about the nine units above it a
   * spawn is lifted to. Any client counts, living or dead: Quake 3's health test is commented out,
   * so a player lying where they died still holds the spot until they respawn.
   */
  private spotWouldTelefrag(spot: GameEntity): boolean {
    const { mins, maxs } = playerBounds(false);
    const touch = this.traps.entitiesInBox(add(spot.s.origin, mins), add(spot.s.origin, maxs));
    return touch.some((number) => this.level.gentities[number].client !== null);
  }

  /**
   * `AddScore` (`g_combat.c:52–67`): add to a client's score, and to their team's in a team game.
   *
   * Three refusals, in Quake 3's order: an entity with no client scores nothing, and a score during
   * the warmup scores nothing, because a warmup is not played. A real score is shown to its scorer
   * alone as a plum where it happened (`ScorePlum`, `g_combat.c:33–42`), and ends in
   * {@link calculateRanks}, which is what makes the scoreboard and the exit rules notice at once.
   *
   * @param entity - Who is credited, which must be a client.
   * @param origin - Where it happened, where the plum pops from.
   * @param score - How much, negative for the suicide and the teamkill.
   */
  addScore(entity: GameEntity, origin: Vec3, score: number): void {
    if (!entity.client) return;
    if (this.level.warmupTime) return;

    const plum = tempEntity(this.level, origin, EV.SCOREPLUM);
    plum.r.svFlags |= SVF.SINGLECLIENT;
    plum.r.singleClient = entity.s.number;
    plum.s.otherEntityNum = entity.s.number;
    plum.s.time = score;

    entity.client.ps.persistant[PERS.SCORE] += score;
    if (this.gametype === GT.TEAM) {
      this.level.teamScores[entity.client.ps.persistant[PERS.TEAM]] += score;
    }
    this.calculateRanks();
  }

  /**
   * `DeathmatchScoreboardMessage` (`g_cmds.c:35–95`): the whole board, as one server command. A bot
   * is sent nothing, because a bot does not parse it.
   *
   * @param clientNum - Which client to send it to.
   */
  sendScoreboard(clientNum: number): void {
    const entity = this.level.gentities[clientNum];
    if (entity.r.svFlags & SVF.BOT) return;
    this.traps.sendServerCommand(clientNum, `${this.scoreboardMessage()}\n`);
  }

  /**
   * The command {@link sendScoreboard} sends, which is the same for everyone.
   *
   * The line is `scores <count> <red> <blue>`, then fourteen numbers per client in
   * {@link Level.sortedClients}' order: its slot, score, ping, minutes played, score flags, the
   * entity's powerup bits, accuracy, the four award counters, perfect and captures. The port adds a
   * fifteenth, the damage given, which Clan Arena's board shows as CPMA's does.
   *
   * Three of Q3's own rules are here: a connecting client's ping is −1; the string stops before it
   * would pass 1000 bytes, so a full server's board is short rather than split; and the count sent
   * is the entries that fit, not the clients there are, so a client reads a short board rather than
   * a truncated one. The ping is unlagged's true ping, as Excessive Plus's board shows it.
   */
  scoreboardMessage(): string {
    const level = this.level;
    const numSorted = level.numConnectedClients;

    let string = '';
    let sent = 0;
    for (let i = 0; i < numSorted; i++) {
      const slot = level.sortedClients[i];
      const client = level.clients[slot];

      const ping =
        client.pers.connected === CON.CONNECTING ? -1 : Math.min(client.pers.realPing, 999);
      const accuracy = client.accuracyShots
        ? Math.trunc((client.accuracyHits * 100) / client.accuracyShots)
        : 0;
      const perfect =
        client.ps.persistant[PERS.RANK] === 0 && client.ps.persistant[PERS.KILLED] === 0 ? 1 : 0;

      const entry =
        ` ${slot} ${client.ps.persistant[PERS.SCORE]} ${ping}` +
        ` ${Math.trunc((level.time - client.pers.enterTime) / 60_000)}` +
        ` 0 ${level.gentities[slot].s.powerups} ${accuracy}` +
        ` ${client.ps.persistant[PERS.IMPRESSIVE_COUNT]}` +
        ` ${client.ps.persistant[PERS.EXCELLENT_COUNT]}` +
        ` ${client.ps.persistant[PERS.GAUNTLET_FRAG_COUNT]}` +
        ` ${client.ps.persistant[PERS.DEFEND_COUNT]}` +
        ` ${client.ps.persistant[PERS.ASSIST_COUNT]}` +
        ` ${perfect} ${client.ps.persistant[PERS.CAPTURES]} ${client.damageGiven}`;

      if (string.length + entry.length >= 1000) break;
      string += entry;
      sent++;
    }

    return `scores ${sent} ${level.teamScores[TEAM.RED]} ${level.teamScores[TEAM.BLUE]}${string}`;
  }

  /** `SendScoreboardMessageToAllClients` (`g_main.c:913–921`): to every connected client. */
  sendScoreboardToAllClients(): void {
    for (let i = 0; i < this.maxclients; i++) {
      if (this.level.clients[i].pers.connected !== CON.CONNECTED) continue;
      this.sendScoreboard(i);
    }
  }

  /** `G_Find( from, FOFS( classname ), "info_player_deathmatch" )`: the next spawn spot. */
  private findSpawnSpot(from: GameEntity | null): GameEntity | null {
    return this.level.find(from, 'classname', 'info_player_deathmatch');
  }

  /**
   * `CalculateRanks` (`g_main.c:787–895`): count who is here, sort them, and rank them.
   *
   * It runs after anything that could change the answer — a connect, a begin, a disconnect, a
   * score — because half the match's rules are asked in terms of these counts, and the scoreboard
   * every client draws is two configstrings this sets.
   *
   * It ends by checking the exit rules, because a score that just changed may have been the one
   * that ends the match. Quake 3 also resends the scoreboard while at the intermission, where
   * nothing else would; the scoreboard message itself arrives with the scoreboard.
   */
  calculateRanks(): void {
    const level = this.level;

    level.follow1 = -1;
    level.follow2 = -1;
    level.numConnectedClients = 0;
    level.numNonSpectatorClients = 0;
    level.numPlayingClients = 0;
    level.numVotingClients = 0;
    level.numteamVotingClients[0] = 0;
    level.numteamVotingClients[1] = 0;

    for (let i = 0; i < this.maxclients; i++) {
      const client = level.clients[i];
      if (client.pers.connected === CON.DISCONNECTED) continue;

      level.sortedClients[level.numConnectedClients] = i;
      level.numConnectedClients++;
      if (client.sess.sessionTeam === TEAM.SPECTATOR) continue;

      level.numNonSpectatorClients++;
      if (client.pers.connected !== CON.CONNECTED) continue;

      level.numPlayingClients++;
      if (!(level.gentities[i].r.svFlags & SVF.BOT)) {
        // Bots do not vote, which is why this is not simply the playing count.
        level.numVotingClients++;
        if (client.sess.sessionTeam === TEAM.RED) level.numteamVotingClients[0]++;
        else if (client.sess.sessionTeam === TEAM.BLUE) level.numteamVotingClients[1]++;
      }
      if (level.follow1 === -1) level.follow1 = i;
      else if (level.follow2 === -1) level.follow2 = i;
    }

    const sorted = level.sortedClients.slice(0, level.numConnectedClients);
    sorted.sort((a, b) => this.sortRanks(a, b));
    for (let i = 0; i < sorted.length; i++) level.sortedClients[i] = sorted[i];

    if (this.gametype >= GT.TEAM) {
      // A team game ranks the teams rather than the players: 0 red, 1 blue, 2 tied.
      const red = level.teamScores[TEAM.RED];
      const blue = level.teamScores[TEAM.BLUE];
      const rank = red === blue ? 2 : red > blue ? 0 : 1;
      for (let i = 0; i < level.numConnectedClients; i++) {
        level.clients[level.sortedClients[i]].ps.persistant[PERS.RANK] = rank;
      }
    } else {
      let rank = -1;
      let score = 0;
      for (let i = 0; i < level.numPlayingClients; i++) {
        const client = level.clients[level.sortedClients[i]];
        const newScore = client.ps.persistant[PERS.SCORE];
        if (i === 0 || newScore !== score) {
          rank = i;
          // Assume no tie until the next client says otherwise.
          client.ps.persistant[PERS.RANK] = rank;
        } else {
          const previous = level.clients[level.sortedClients[i - 1]];
          previous.ps.persistant[PERS.RANK] = rank | RANK_TIED_FLAG;
          client.ps.persistant[PERS.RANK] = rank | RANK_TIED_FLAG;
        }
        score = newScore;
      }
    }

    if (this.gametype >= GT.TEAM) {
      this.traps.setConfigstring(CONFIGSTRING.SCORES1, String(level.teamScores[TEAM.RED]));
      this.traps.setConfigstring(CONFIGSTRING.SCORES2, String(level.teamScores[TEAM.BLUE]));
    } else {
      const scoreAt = (place: number): number =>
        level.numConnectedClients > place
          ? level.clients[level.sortedClients[place]].ps.persistant[PERS.SCORE]
          : SCORE_NOT_PRESENT;
      this.traps.setConfigstring(CONFIGSTRING.SCORES1, String(scoreAt(0)));
      this.traps.setConfigstring(CONFIGSTRING.SCORES2, String(scoreAt(1)));
    }

    // "Do this at BeginIntermission time and whenever ranks are recalculated due to
    // enters/exits/forced team changes" (`g_main.c:909–910`): while the intermission is up the
    // board is the only thing on screen, so a rank that moved is sent again rather than waiting
    // for the key that will never be pressed.
    if (level.intermissiontime) this.sendScoreboardToAllClients();

    this.checkExitRules();
  }

  /**
   * `SortRanks` (`g_main.c:726–785`): the scoreboard's order, which is not simply by score.
   *
   * Everything that is not a player playing is pushed below everyone who is, in the order a
   * scoreboard wants to read them: the players by score, then the spectators by their place in
   * the queue, then whoever is still connecting, then the scoreboard watchers.
   */
  private sortRanks(a: number, b: number): number {
    const ca = this.level.clients[a];
    const cb = this.level.clients[b];

    const special = (c: GameClient): boolean =>
      c.sess.spectatorState === SPECTATOR.SCOREBOARD || c.sess.spectatorClient < 0;
    if (special(ca)) return 1;
    if (special(cb)) return -1;

    if (ca.pers.connected === CON.CONNECTING) return 1;
    if (cb.pers.connected === CON.CONNECTING) return -1;

    const specA = ca.sess.sessionTeam === TEAM.SPECTATOR;
    const specB = cb.sess.sessionTeam === TEAM.SPECTATOR;
    if (specA && specB) {
      // Among spectators, whoever has waited longest is nearest the front of the queue.
      if (ca.sess.spectatorNum > cb.sess.spectatorNum) return -1;
      if (ca.sess.spectatorNum < cb.sess.spectatorNum) return 1;
      return 0;
    }
    if (specA) return 1;
    if (specB) return -1;

    return cb.ps.persistant[PERS.SCORE] - ca.ps.persistant[PERS.SCORE];
  }

  // --- the match's states -------------------------------------------------------------------

  /**
   * `CheckTournament` (`g_main.c:1460–1573`): is the match waiting for players, counting down, or
   * being played?
   *
   * The whole state is one number. `level.warmupTime` is −1 while the match is waiting, a time to
   * count down to once there are enough players, and 0 once play has begun; `CS_WARMUP` carries
   * the same number to every client, which is how each of them knows what to draw.
   *
   * Tournament and everything else differ in one place only, and it is the order of two tests.
   * Tournament asks how many are playing before it asks whether play has begun, so losing a
   * player takes it back to waiting; every other type asks the other way round, so once it is
   * being played it stays that way however few are left.
   */
  checkTournament(): void {
    const level = this.level;

    // A `map_restart` runs three game frames before the clients are connected again, so an empty
    // match is a match mid-restart rather than one nobody wants.
    if (level.numPlayingClients === 0) return;

    if (this.gametype === GT.TOURNAMENT) {
      // An empty seat is filled from the queue before anything else is asked, so that a match
      // one player short is whole again on the same frame.
      if (level.numPlayingClients < 2) this.addTournamentPlayer();

      // Two players are the match, so a tournament un-starts when one of them goes.
      if (level.numPlayingClients !== 2) {
        this.waitForPlayers();
        return;
      }
      if (level.warmupTime === 0) return;

      this.runWarmupCountdown();
      return;
    }

    // Single Player never warms up, and the rest stop warming up for good once play has begun.
    if (this.gametype === GT.SINGLE_PLAYER || level.warmupTime === 0) return;

    // A team game wants somebody on each side rather than two players anywhere.
    const notEnough =
      this.gametype >= GT.TEAM
        ? this.teamCount(TEAM.RED) < 1 || this.teamCount(TEAM.BLUE) < 1
        : level.numPlayingClients < 2;
    if (notEnough) {
      this.waitForPlayers();
      return;
    }

    this.runWarmupCountdown();
  }

  /**
   * `CheckExitRules` (`g_main.c:1330–1441`): is the match over?
   *
   * Eight questions in an order that is the whole of it. The intermission's two come first
   * because once the match has ended nothing can end it again. Then the tie, which is not a limit
   * but a veto over every limit below it: no limit ends a match whose leaders are level, so past
   * the time limit the match runs on until a frag breaks the tie, and that is all sudden death
   * is. Then the limits themselves, in the order the cvars were added to the game.
   *
   * Nothing here ends a match for want of players. One player alone cannot tie, so the limits
   * apply to them as they would to a full server; only a tournament falls back to waiting.
   */
  checkExitRules(): void {
    const level = this.level;

    // Already there, so the only question left is when to leave.
    if (level.intermissiontime) {
      this.checkIntermissionExit();
      return;
    }

    // Qualified, but not yet gone: the delay is so the last frag can be watched.
    if (level.intermissionQueued) {
      if (level.time - level.intermissionQueued >= INTERMISSION_DELAY_TIME) {
        level.intermissionQueued = 0;
        this.beginIntermission();
      }
      return;
    }

    if (this.scoreIsTied()) return;

    const timelimit = this.limitCvar('timelimit');
    if (timelimit && !level.warmupTime) {
      if (level.time - level.startTime >= timelimit * 60_000) {
        this.traps.sendServerCommand(null, 'print "Timelimit hit.\n"');
        this.logExit('Timelimit hit.');
        return;
      }
    }

    const fraglimit = this.limitCvar('fraglimit');
    if (this.gametype < GT.CTF && fraglimit) {
      if (level.teamScores[TEAM.RED] >= fraglimit) {
        this.traps.sendServerCommand(null, 'print "Red hit the fraglimit.\n"');
        this.logExit('Fraglimit hit.');
        return;
      }
      if (level.teamScores[TEAM.BLUE] >= fraglimit) {
        this.traps.sendServerCommand(null, 'print "Blue hit the fraglimit.\n"');
        this.logExit('Fraglimit hit.');
        return;
      }

      for (let i = 0; i < this.maxclients; i++) {
        const client = level.clients[i];
        if (client.pers.connected !== CON.CONNECTED) continue;
        // A team game's players are on a side, so only a free-for-all reaches this at all.
        if (client.sess.sessionTeam !== TEAM.FREE) continue;
        if (client.ps.persistant[PERS.SCORE] < fraglimit) continue;

        // The one rule that logs before it prints, which is Quake 3's order and not a tidier one.
        this.logExit('Fraglimit hit.');
        this.traps.sendServerCommand(
          null,
          `print "${client.pers.netname}^7 hit the fraglimit.\n"`
        );
        return;
      }
    }

    const capturelimit = this.limitCvar('capturelimit');
    if (this.gametype >= GT.CTF && this.gametype !== GT.CA && capturelimit) {
      if (level.teamScores[TEAM.RED] >= capturelimit) {
        this.traps.sendServerCommand(null, 'print "Red hit the capturelimit.\n"');
        this.logExit('Capturelimit hit.');
        return;
      }
      if (level.teamScores[TEAM.BLUE] >= capturelimit) {
        this.traps.sendServerCommand(null, 'print "Blue hit the capturelimit.\n"');
        this.logExit('Capturelimit hit.');
        return;
      }
    }

    // Clan Arena's team score is its rounds won.
    const roundlimit = this.limitCvar('roundlimit');
    if (this.gametype === GT.CA && roundlimit) {
      if (level.teamScores[TEAM.RED] >= roundlimit) {
        this.traps.sendServerCommand(null, 'print "Red hit the roundlimit.\n"');
        this.logExit('Roundlimit hit.');
        return;
      }
      if (level.teamScores[TEAM.BLUE] >= roundlimit) {
        this.traps.sendServerCommand(null, 'print "Blue hit the roundlimit.\n"');
        this.logExit('Roundlimit hit.');
        return;
      }
    }
  }

  /** Whether Clan Arena's rounds are being played: past Quake 3's own warmup, and not yet over. */
  private roundsRun(): boolean {
    const level = this.level;
    return (
      this.gametype === GT.CA &&
      !level.warmupTime &&
      !level.intermissionQueued &&
      !level.intermissiontime
    );
  }

  /**
   * CPMA's round end: while a round is played, has a side run out of players?
   *
   * The first frame a side has nobody left in the round starts the win delay, and the result is
   * read when it runs out: the side still standing takes the round, and with neither it is a draw.
   * A win is scored through `CalculateRanks`, which asks the exit rules at once, so the round that
   * reaches the limit has queued the intermission before another can begin.
   */
  private checkRoundEnd(): void {
    const level = this.level;
    if (!this.roundsRun() || level.roundTime !== 0) return;

    const red = this.inRoundCount(TEAM.RED);
    const blue = this.inRoundCount(TEAM.BLUE);
    if ((!red || !blue) && !level.roundWinTime) level.roundWinTime = level.time + CA_WIN_DELAY;
    if (!level.roundWinTime || level.time <= level.roundWinTime) return;

    level.roundWinTime = 0;
    level.roundTime = -1;
    const winner = red && !blue ? TEAM.RED : blue && !red ? TEAM.BLUE : TEAM.FREE;
    if (winner === TEAM.FREE) {
      this.traps.sendServerCommand(null, 'cp "The round is a draw!"');
      return;
    }
    level.teamScores[winner]++;
    this.traps.sendServerCommand(null, `cp "${CA_TEAM_NAMES[winner]} has won the round"`);
    this.calculateRanks();
  }

  /**
   * CPMA's round flow: between rounds, count the next one down once both sides have a player, and
   * start it when the countdown is over.
   *
   * A side with nobody on it sends the match back to waiting, whatever was being played. The
   * countdown respawns everyone on a side at its start, and anyone who dies in it at once. The
   * round's state goes out as `CS_WARMUP`, which the client draws and voices as a warmup.
   */
  private checkRoundStart(): void {
    const level = this.level;
    if (!this.roundsRun()) return;

    if (this.teamCount(TEAM.RED) < 1 || this.teamCount(TEAM.BLUE) < 1) {
      level.roundTime = -1;
      level.roundWinTime = 0;
    } else if (level.roundTime === -1) {
      level.roundTime = level.time + CA_ROUND_WARMUP;
      this.respawnSides(false);
    } else if (level.roundTime > 0) {
      if (level.time > level.roundTime) {
        level.roundTime = 0;
        level.roundCount++;
      } else {
        this.respawnSides(true);
      }
    }

    const warmup = String(level.roundTime);
    if (this.traps.getConfigstring(CONFIGSTRING.WARMUP) !== warmup) {
      this.traps.setConfigstring(CONFIGSTRING.WARMUP, warmup);
    }
  }

  /**
   * The players on a side still in the round, which is what a round is played out to: everyone
   * not watching it. CPMA reads no health, so a player just killed counts until they start to
   * watch, at their respawn time.
   */
  private inRoundCount(team: number): number {
    let count = 0;
    for (let i = 0; i < this.maxclients; i++) {
      const client = this.level.clients[i];
      if (client.pers.connected !== CON.CONNECTED || client.sess.sessionTeam !== team) continue;
      if (!isSpectator(client)) count++;
    }
    return count;
  }

  /**
   * A round's respawn: everyone on a side comes back with the mode's loadout, the dead leaving
   * their bodies and the watching stopping, whose bodies are left already. The spawn gives a
   * follower their own view back. All are out of the world before any is placed, so nobody is
   * telefragged by where somebody stood in the round before.
   *
   * @param deadOnly - Only the dead, as the countdown brings back a telefrag's victim.
   */
  private respawnSides(deadOnly: boolean): void {
    const sided: GameEntity[] = [];
    for (let i = 0; i < this.maxclients; i++) {
      const client = this.level.clients[i];
      if (client.pers.connected !== CON.CONNECTED) continue;
      if (client.sess.sessionTeam !== TEAM.RED && client.sess.sessionTeam !== TEAM.BLUE) continue;
      if (deadOnly && client.ps.stats[STAT.HEALTH] > 0) continue;
      sided.push(this.level.gentities[i]);
    }
    for (const entity of sided) {
      const client = entity.client!;
      this.grapples[entity.s.number].release();
      if (isSpectator(client)) {
        client.pers.roundSpectator = false;
        client.sess.spectatorState = SPECTATOR.NOT;
        this.traps.unlinkEntity(entity);
      } else if (client.ps.stats[STAT.HEALTH] <= 0) {
        copyToBodyQue(this.level, entity);
      } else {
        this.traps.unlinkEntity(entity);
      }
    }
    for (const entity of sided) this.clientSpawn(entity);
  }

  /**
   * `ScoreIsTied` (`g_main.c:1308–1326`): are the leaders level?
   *
   * It takes two to tie, so a lone player never is — which is what lets a limit end a match with
   * one player in it.
   */
  scoreIsTied(): boolean {
    const level = this.level;
    if (level.numPlayingClients < 2) return false;

    if (this.gametype >= GT.TEAM) {
      return level.teamScores[TEAM.RED] === level.teamScores[TEAM.BLUE];
    }

    // The top two of the scoreboard's own order, which `CalculateRanks` has already sorted.
    const first = level.clients[level.sortedClients[0]].ps.persistant[PERS.SCORE];
    const second = level.clients[level.sortedClients[1]].ps.persistant[PERS.SCORE];
    return first === second;
  }

  /**
   * `LogExit` (`g_main.c:1145–1213`): the match has been won, so queue the intermission.
   *
   * The clients are told the match is over now rather than when the intermission starts, so that
   * a voice line begun in the last second is not cut off half way through — which is why the
   * configstring goes out a second before anyone is moved anywhere.
   *
   * @param _reason - Why the match ended. Quake 3 writes it and the final scores to the game log,
   *   and the port has no log to write them to.
   */
  logExit(_reason: string): void {
    this.level.intermissionQueued = this.level.time;
    this.traps.setConfigstring(CONFIGSTRING.INTERMISSION, '1');
  }

  /**
   * `BeginIntermission` (`g_main.c:988–1031`): the match is over and everyone goes to watch.
   *
   * Anyone who was dead respawns first, so that what stands at the camera is a live body and what
   * is left on the ground is the corpse. Every client then leaves the world proper, which is
   * {@link Game.moveClientToIntermission}'s doing.
   *
   * Two things Quake 3 does here belong to stages of their own: the final scoreboard is the
   * scoreboard's, and Single Player's podium is the modes'.
   */
  beginIntermission(): void {
    const level = this.level;
    if (level.intermissiontime) return;

    if (this.gametype === GT.TOURNAMENT) this.adjustTournamentScores();

    level.intermissiontime = level.time;

    // `SendScoreboardMessageToAllClients` at `BeginIntermission` (`g_main.c:1029`): the board the
    // match ended on, sent before anyone is moved to the camera.
    this.sendScoreboardToAllClients();

    for (let i = 0; i < this.maxclients; i++) {
      const entity = level.gentities[i];
      const client = entity.client;
      if (!entity.inuse || !client) continue;

      // Quake 3 asks `ent->health`, which is a copy of this; the port has only the one.
      if (client.ps.stats[STAT.HEALTH] <= 0) this.clientRespawn(entity);
      this.moveClientToIntermission(entity);
    }
  }

  /**
   * `AdjustTournamentScores` (`g_main.c:703–718`): the win and the loss a duel just produced.
   *
   * The scoreboard's own order decides them — first has won and second has lost — which is why
   * this is asked once at the end rather than at every frag.
   */
  private adjustTournamentScores(): void {
    const level = this.level;

    const winner = level.sortedClients[0];
    if (level.clients[winner].pers.connected === CON.CONNECTED) {
      level.clients[winner].sess.wins++;
      this.clientUserinfoChanged(winner);
    }

    const loser = level.sortedClients[1];
    if (level.clients[loser].pers.connected === CON.CONNECTED) {
      level.clients[loser].sess.losses++;
      this.clientUserinfoChanged(loser);
    }
  }

  /**
   * `MoveClientToIntermission` (`g_main.c:931–954`): take a client out of the world and stand it
   * at the camera.
   *
   * What leaves is the body: no model, no contents, no looping sound and no event, so there is
   * nothing left to see, hear or hit. What stays is a view held at the intermission point, which
   * is the whole of what `PM_INTERMISSION` means — and the powerups go with the body, so a match
   * that ended under quad does not end with a glow standing at the camera.
   *
   * @param entity - The client's entity.
   */
  moveClientToIntermission(entity: GameEntity): void {
    const client = entity.client;
    if (!client) return;

    // A spectator riding somebody's view has to be let off it before it stops being a view.
    if (client.sess.spectatorState === SPECTATOR.FOLLOW) this.stopFollowing(entity);

    this.findIntermissionPoint();

    const level = this.level;
    entity.s.origin.x = level.intermissionOrigin.x;
    entity.s.origin.y = level.intermissionOrigin.y;
    entity.s.origin.z = level.intermissionOrigin.z;
    client.ps.origin.x = level.intermissionOrigin.x;
    client.ps.origin.y = level.intermissionOrigin.y;
    client.ps.origin.z = level.intermissionOrigin.z;
    client.ps.viewangles.x = level.intermissionAngle.x;
    client.ps.viewangles.y = level.intermissionAngle.y;
    client.ps.viewangles.z = level.intermissionAngle.z;
    client.ps.pmType = PM_INTERMISSION;

    client.ps.powerups.fill(0);

    client.ps.eFlags = 0;
    entity.s.eFlags = 0;
    entity.s.eType = ET.GENERAL;
    entity.s.modelindex = 0;
    entity.s.loopSound = 0;
    entity.s.event = 0;
    entity.r.contents = 0;
  }

  /**
   * `FindIntermissionPoint` (`g_main.c:963–984`): where the camera sits, which is also where a
   * spectator spawns.
   *
   * It is the map's first `info_player_intermission`, faced at what it targets if it targets
   * anything, and otherwise turned the way its own angles say. A map whose creator "forgot to put
   * in an intermission point" gets an ordinary spawn point instead, chosen as a human's would be
   * from the map's origin.
   *
   * It is asked once per client rather than once per intermission, so two clients may be sent to
   * different places: by the fallback's random choice, or by a point that targets several things
   * and faces one of them at random. That is Quake 3's own.
   */
  findIntermissionPoint(): void {
    const level = this.level;
    const point = level.find(null, 'classname', 'info_player_intermission');
    if (!point) {
      const spot = this.selectSpawnPoint(vec3(), false);
      copyVec(spot.origin, level.intermissionOrigin);
      copyVec(spot.angles, level.intermissionAngle);
      return;
    }

    copyVec(point.s.origin, level.intermissionOrigin);
    copyVec(point.s.angles, level.intermissionAngle);
    if (point.target !== null) {
      const print = (text: string) => this.traps.print(text);
      const target = pickTarget(level, point.target, () => this.random(), print);
      if (target) {
        const dir = sub(target.s.origin, level.intermissionOrigin);
        copyVec(vectorToAngles(dir), level.intermissionAngle);
      }
    }
  }

  /**
   * `StopFollowing` (`g_cmds.c:661–675`): let a spectator off the view it is riding.
   *
   * A follower is shown the followed client's player state as though it were its own, down to the
   * client number and the health. Getting off means taking all of that back — and being alive
   * enough to own a view, which is what the floor of one health is for.
   *
   * The follower keeps their own team, as CPMA's does. Quake 3 puts them on the spectator team,
   * which is where every one of its followers already is; a player watching from a side stays on
   * it.
   *
   * @param entity - The spectator's entity.
   */
  stopFollowing(entity: GameEntity): void {
    const client = entity.client;
    if (!client) return;

    client.ps.persistant[PERS.TEAM] = client.sess.sessionTeam;
    client.sess.spectatorState = SPECTATOR.FREE;
    client.ps.pmFlags &= ~PMF_FOLLOW;
    // The followed client's flags came across with its state, and one of them may have been this.
    entity.r.svFlags &= ~SVF.BOT;
    client.ps.clientNum = entity.s.number;

    setClientViewAngle(entity, client.ps.viewangles);

    if (client.ps.stats[STAT.HEALTH] <= 0) client.ps.stats[STAT.HEALTH] = 1;
  }

  /**
   * `ClientIntermissionThink` (`g_active.c:513–526`): the only thing a client does while it
   * watches.
   *
   * A fresh press of attack or the holdable key says ready, and once said it sticks — Quake 3's
   * own comment records that it used to toggle and does not any more. Fresh is the point: the
   * buttons are swapped and compared here because the move that normally does it is not running.
   *
   * @param client - The client's slot.
   */
  clientIntermissionThink(client: GameClient): void {
    client.ps.eFlags &= ~EF_TALK;
    client.ps.eFlags &= ~EF_FIRING;

    client.oldbuttons = client.buttons;
    client.buttons = client.pers.cmd.buttons;
    const pressed = client.buttons & ~client.oldbuttons;
    if (pressed & (BUTTON_ATTACK | BUTTON_USE_HOLDABLE)) client.readyToExit = true;
  }

  /**
   * `CheckIntermissionExit` (`g_main.c:1218–1304`): is everybody ready to move on?
   *
   * Three answers, and their order is the whole of it. Nobody leaves inside the first five
   * seconds, however fast they press. After that a match with humans in it leaves when all of
   * them are ready and waits when none of them is. Everything else — some ready and some not, or
   * nobody human at all — falls through to the ten-second timer the first ready starts, which is
   * why a match of bots leaves fifteen seconds in with nobody having pressed anything.
   *
   * Bots are not counted either way, so they neither hold the match here nor release it.
   */
  checkIntermissionExit(): void {
    // Single Player leaves by its own postgame menu, which is the modes' to build.
    if (this.gametype === GT.SINGLE_PLAYER) return;

    const level = this.level;
    let ready = 0;
    let notReady = 0;
    let playerCount = 0;
    let readyMask = 0;

    for (let i = 0; i < this.maxclients; i++) {
      const client = level.clients[i];
      if (client.pers.connected !== CON.CONNECTED) continue;
      if (level.gentities[i].r.svFlags & SVF.BOT) continue;

      playerCount++;
      if (client.readyToExit) {
        ready++;
        // The mask is one bit per slot in a stat sixteen bits wide, so it reaches only that far.
        if (i < 16) readyMask |= 1 << i;
      } else {
        notReady++;
      }
    }

    // Everyone is told who is ready, which is the READY a scoreboard draws beside a name.
    for (let i = 0; i < this.maxclients; i++) {
      const client = level.clients[i];
      if (client.pers.connected !== CON.CONNECTED) continue;
      client.ps.stats[STAT.CLIENTS_READY] = readyMask;
    }

    // Never inside five seconds, so that the last frag is still on the screen when it ends.
    if (level.time < level.intermissiontime + 5000) return;

    if (playerCount > 0) {
      // Nobody wants to go, so the timer somebody else started is not left running.
      if (!ready) {
        level.readyToExit = false;
        return;
      }
      if (!notReady) {
        this.exitLevel();
        return;
      }
    }

    if (!level.readyToExit) {
      level.readyToExit = true;
      level.exitTime = level.time;
    }

    if (level.time < level.exitTime + 10_000) return;

    this.exitLevel();
  }

  /**
   * `ExitLevel` (`g_main.c:1036–1100`): the intermission is over, so hand the match on.
   *
   * What comes next is not decided here. A tournament restarts the same map with the loser sent
   * to the back of the queue; everything else runs `nextmap`, which the server sets to the literal
   * `map_restart 0` on every map load — so by default the map comes round again either way.
   * Both leave as console commands, because loading a map is the host's and not the game's.
   *
   * The scores are zeroed on the way out "so we don't enter the intermission again": the exit
   * rules would otherwise find the match still won the moment the next one starts. The sessions
   * are written before anyone is marked as connecting, because the connect that follows is what
   * reads them back.
   */
  exitLevel(): void {
    const level = this.level;

    if (this.gametype === GT.TOURNAMENT) {
      if (level.restarted) return;

      // The loser becomes a spectator, so the restart comes back a player short and
      // `CheckTournament` seats whoever has waited longest in the seat they left.
      this.removeTournamentLoser();
      this.traps.sendConsoleCommand('map_restart 0\n');
      level.restarted = true;
      level.changemap = null;
      level.intermissiontime = 0;
      return;
    }

    const nextmap = this.cvars.get('nextmap');
    const d1 = this.cvars.get('d1');
    if (nextmap.toLowerCase() === 'map_restart 0' && d1 !== '') {
      // A rotation has been set up, so the restart `nextmap` still holds is not what runs: `d1`
      // goes now and `d2` is left in `nextmap` to go after it.
      this.cvars.set('nextmap', 'vstr d2');
      this.traps.sendConsoleCommand('vstr d1\n');
    } else {
      this.traps.sendConsoleCommand('vstr nextmap\n');
    }

    level.changemap = null;
    level.intermissiontime = 0;

    level.teamScores[TEAM.RED] = 0;
    level.teamScores[TEAM.BLUE] = 0;
    for (let i = 0; i < this.maxclients; i++) {
      const client = level.clients[i];
      if (client.pers.connected !== CON.CONNECTED) continue;
      client.ps.persistant[PERS.SCORE] = 0;
    }

    this.writeSessions();

    // Connecting rather than connected, so that whoever reaches the next map first can tell that
    // the others have not finished arriving.
    for (let i = 0; i < this.maxclients; i++) {
      const client = level.clients[i];
      if (client.pers.connected === CON.CONNECTED) client.pers.connected = CON.CONNECTING;
    }
  }

  /**
   * `TeamCount` (`g_client.c:543–560`): how many clients are on a team.
   *
   * It counts anyone not disconnected, so a client still connecting already holds a place on the
   * side it is joining.
   *
   * @param team - One of {@link TEAM}.
   * @param ignoreClientNum - A slot to leave out, for asking what a team would look like without
   *   the client that is about to leave it.
   */
  teamCount(team: number, ignoreClientNum = -1): number {
    let count = 0;
    for (let i = 0; i < this.maxclients; i++) {
      if (i === ignoreClientNum) continue;
      const client = this.level.clients[i];
      if (client.pers.connected === CON.DISCONNECTED) continue;
      if (client.sess.sessionTeam === team) count++;
    }
    return count;
  }

  /** Back to "waiting for players", and tell the clients so — unless that is where it already is. */
  private waitForPlayers(): void {
    if (this.level.warmupTime === -1) return;
    this.level.warmupTime = -1;
    this.traps.setConfigstring(CONFIGSTRING.WARMUP, String(this.level.warmupTime));
  }

  /**
   * The countdown both branches of `CheckTournament` end in, which Quake 3 writes out twice.
   *
   * Reached only with enough players and a warmup still running, so there are three things left
   * to decide: whether the countdown is out of date, whether it has yet to start, and whether it
   * has run out.
   */
  private runWarmupCountdown(): void {
    const level = this.level;

    // `g_warmup` was changed at the console, so whatever is counting down is counting to the
    // wrong time and the countdown starts again from the new one.
    const modificationCount = this.cvars.modificationCount('g_warmup');
    if (modificationCount !== level.warmupModificationCount) {
      level.warmupModificationCount = modificationCount;
      level.warmupTime = -1;
    }

    if (level.warmupTime < 0) {
      const warmup = this.cvarInt('g_warmup');
      // "fudge by -1 to account for extra delays". A warmup of a second or less is not worth a
      // restart, so play begins where the countdown would have been.
      level.warmupTime = warmup > 1 ? level.time + (warmup - 1) * 1000 : 0;
      this.traps.setConfigstring(CONFIGSTRING.WARMUP, String(level.warmupTime));
      return;
    }

    if (level.time <= level.warmupTime) return;

    // Play begins with a restart, so nothing the warmup did is carried into the match. The ten
    // seconds added are a guard: they stop a second restart being asked for while the first is
    // still on its way, and the map that comes back has its own warmup time anyway.
    level.warmupTime += 10_000;
    this.cvars.set('g_restarted', '1');
    this.traps.sendConsoleCommand('map_restart 0\n');
    level.restarted = true;
  }

  // --- helpers ------------------------------------------------------------------------------

  /**
   * `G_WriteSessionData` (`g_session.c:191–201`): every connected client's session to its cvar.
   *
   * It runs at the shutdown and again on the way out of a level, because a session is only ever
   * read back by a connect and both of those are followed by one.
   */
  private writeSessions(): void {
    writeSessionData(
      this.cvars,
      this.gametype,
      this.level.clients.map((client, i) =>
        i < this.maxclients && client.pers.connected === CON.CONNECTED ? client.sess : null
      )
    );
  }

  /**
   * `G_RegisterCvars` (`g_main.c:337–367`): ask for every cvar the match needs, and take up the
   * ones only a map start may change.
   *
   * It runs at each {@link init}, which is what makes `g_gametype` and `sv_maxclients` latched:
   * they are read here and read nowhere else, so a new value sits in the cvar until the map that
   * takes it up comes round.
   */
  private registerCvars(): void {
    for (const cvar of GAME_CVARS) this.registerCvar(cvar.name, this.cvarDefaults.get(cvar.name)!);

    this.gametype = this.cvarInt('g_gametype');
    if (this.gametype < 0 || this.gametype >= GT.MAX_GAME_TYPE) {
      this.gametype = GT.FFA;
      this.cvars.set('g_gametype', '0');
    }
    this.maxclients = this.cvarInt('sv_maxclients');
    this.maxGameClients = this.cvarInt('g_maxGameClients');
    this.gravityValue = Math.fround(atof(this.cvars.get('g_gravity')));

    for (const cvar of GAME_CVARS) {
      this.cvarCounts.set(cvar.name, this.cvars.modificationCount(cvar.name));
    }
    this.ruleCvars.update();
  }

  /**
   * `G_UpdateCvars` (`g_main.c:374–400`): say what changed, to everyone.
   *
   * The announcement is the only part of this a client can see, and it is deliberately not every
   * cvar. The ones that carry it are the ones a match is run to, so that a limit moving under a
   * match is something the players are told rather than something they work out.
   */
  private updateCvars(): void {
    this.ruleCvars.update();
    this.gravityValue = Math.fround(atof(this.cvars.get('g_gravity')));
    const total = this.cvars.totalModifications();
    if (total === this.cvarsTotal) return;
    this.cvarsTotal = total;
    for (const cvar of GAME_CVARS) {
      const count = this.cvars.modificationCount(cvar.name);
      if (count === this.cvarCounts.get(cvar.name)) continue;
      this.cvarCounts.set(cvar.name, count);
      if (!cvar.track) continue;
      this.traps.sendServerCommand(
        null,
        `print "Server: ${cvar.name} changed to ${this.cvars.get(cvar.name)}\n"`
      );
    }
  }

  /**
   * `CheckCvars` (`g_main.c:1740–1751`): `g_needpass` set from `g_password`, which a server's
   * browsers read rather than the password. A password of `none` is none.
   */
  private checkCvars(): void {
    const count = this.cvars.modificationCount('g_password');
    if (count === this.passwordCount) return;
    this.passwordCount = count;
    const password = this.cvars.get('g_password');
    this.cvars.set('g_needpass', password !== '' && password.toLowerCase() !== 'none' ? '1' : '0');
  }

  /** `Cvar_Get`: the cvar's value, with the default put there first if it has none. */
  private registerCvar(name: string, fallback: string): string {
    if (this.cvars.get(name) === '') this.cvars.set(name, fallback);
    return this.cvars.get(name);
  }

  /** A cvar as `atoi` reads it: the number it starts with, and 0 for anything that is not one. */
  private cvarInt(name: string): number {
    return Number.parseInt(this.cvars.get(name), 10) || 0;
  }

  /** `pmove_msec`, set back into its range when it is read outside it (`g_active.c:790–797`). */
  private pmoveMsec(): number {
    const msec = this.cvarInt('pmove_msec');
    const held = Math.min(Math.max(msec, PMOVE_MSEC_MIN), PMOVE_MSEC_MAX);
    if (held !== msec) this.cvars.set('pmove_msec', String(held));
    return held;
  }

  /**
   * `G_SoundIndex` (`g_utils.c:120–122`): a sound's slot in the `CS_SOUNDS` block, which is the
   * number an event carries instead of a file name.
   *
   * @throws with Q3's `G_Error` when the block is full
   */
  soundIndex(name: string): number {
    return this.findConfigstringIndex(name, CONFIGSTRING.SOUNDS, MAX_SOUNDS);
  }

  /**
   * `G_ModelIndex` (`g_utils.c:116–118`): a model's slot in the `CS_MODELS` block, which a mover's
   * `s.modelindex2` carries.
   *
   * @throws with Q3's `G_Error` when the block is full
   */
  modelIndex(name: string): number {
    return this.findConfigstringIndex(name, CONFIGSTRING.MODELS, MAX_MODELS);
  }

  /**
   * `G_FindConfigstringIndex` (`g_utils.c:84–113`): a name's slot in a block of configstrings,
   * given one if it has none.
   *
   * The configstrings are the list — Quake 3 looks a name up by reading them back, and so does
   * this, so the two ends cannot disagree about a slot. Slot 0 is nothing at all, an empty name
   * answers it, and entries start at 1.
   *
   * @throws with Q3's `G_Error` when the block is full
   */
  private findConfigstringIndex(name: string, start: number, max: number): number {
    if (!name) return 0;
    for (let i = 1; i < max; i++) {
      const existing = this.traps.getConfigstring(start + i);
      if (!existing) {
        this.traps.setConfigstring(start + i, name);
        return i;
      }
      if (existing === name) return i;
    }
    throw new Error('G_FindConfigstringIndex: overflow');
  }

  /**
   * One of the match limits, with a negative one written back as zero.
   *
   * Quake 3 corrects the cvar rather than only ignoring it, so that what the console reports is
   * what the match is actually running to. ioquake3 also clamps the time limit's upper end, which
   * guards a multiplication that overflows a 32-bit int; there is nothing here to overflow.
   */
  private limitCvar(name: string): number {
    const value = this.cvarInt(name);
    if (value >= 0) return value;
    this.cvars.set(name, '0');
    return 0;
  }

  /** A level with this game's handlers, as `level` is built fresh for each map. */
  private newLevel(startTime: number): Level {
    return new Level({
      startTime,
      maxclients: this.maxclients,
      rules: this.ruleCvars.rules,
      handlers: {
        // `G_RunClient` returns at once unless the client is a bot or `g_synchronousClients` is
        // set: an ordinary client thinks when its command arrives, not when the frame comes round.
        runClient: (entity) => {
          if (!(entity.r.svFlags & SVF.BOT)) return;
          entity.client!.pers.cmd.serverTime = this.level.time;
          this.clientThinkReal(entity);
        },
        updateCvars: () => this.updateCvars(),
        // `G_RunItem`, which the frame reaches for anything that falls: a corpse, a map item a
        // mover pushed, and a dropped weapon's own fall.
        runItem: (entity) => runItem(this.level, entity, this.trace),
        endClientFrame: (entity, clientNum) => this.clientEndFrame(entity, clientNum),
        // Quake 3 closes a frame with the tournament, the exit rules, the team overlay, the two
        // kinds of vote and `CheckCvars`; the overlay and the votes arrive with the parts that
        // own them.
        checkRules: () => {
          this.checkTournament();
          this.checkExitRules();
          this.checkRoundEnd();
          this.checkRoundStart();
          this.checkCvars();
        },
        // `G_RunMissile`: what its blast is worth, and whose it is, are on the missile.
        runMissile: (missile) => runMissile(this.level, missile, this.trace, this.ruleCvars.rules),
        runMover: (mover) => runMover(this.level, mover),
        linkEntity: (entity) => this.traps.linkEntity(entity),
        unlinkEntity: (entity) => this.traps.unlinkEntity(entity),
        entitiesInBox: (mins, maxs) => this.traps.entitiesInBox(mins, maxs),
        setBrushModel: (entity, name) => this.traps.setBrushModel(entity, name),
        entityContact: (mins, maxs, entity) => this.traps.entityContact(mins, maxs, entity),
        adjustAreaPortalState: (entity, open) => this.traps.adjustAreaPortalState(entity, open),
        inPVS: (p1, p2) => this.traps.inPVS(p1, p2),
        // What a flag writes when it moves, and what it says about it: both are reached
        // from an item callback, which is handed the level and nothing else.
        setConfigstring: (index, value) => this.traps.setConfigstring(index, value),
        sendServerCommand: (clientNum, text) => this.traps.sendServerCommand(clientNum, text),
        // `trap_Trace`, which an item's finishing asks for on the frame it stands up.
        trace: this.trace,
        pointContents: this.pointContents
      }
    });
  }

  /** `trap_Trace` as `pmove` wants it, so the move traces without knowing what answers. */
  private readonly trace: TraceFn = (start, mins, maxs, end, passEntityNum, contentmask) =>
    this.traps.trace(start, mins, maxs, end, passEntityNum, contentmask);

  /** `trap_PointContents`, as `pmove` wants it. */
  private readonly pointContents: PointContentsFn = (point, passEntityNum) =>
    this.traps.pointContents(point, passEntityNum);

  /**
   * `random()` — a number in [0, 1).
   *
   * Quake 3 seeds `rand` from the host's `randomSeed` at `G_InitGame`, so that two hosts given
   * the same seed spawn the same way. The port keeps a generator of its own rather than borrowing
   * the runtime's, for the same reason: the choice has to be reproducible.
   */
  private random(): number {
    if (this.injectedRandom) return this.injectedRandom();
    // xorshift32, which is enough for choosing a spawn point and is the same every run.
    let x = this.randomState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randomState = x >>> 0;
    return this.randomState / 0x100000000;
  }
}

/**
 * `ClientCleanName` (`g_client.c:625–697`): a name another client can be shown.
 *
 * A name is drawn into a scoreboard beside other names, so it cannot run away with the width, sit
 * in a colour that vanishes against a dark background, or be nothing at all.
 *
 * @param name - The `name` key from the client's userinfo.
 */
export function cleanName(name: string): string {
  let out = '';
  let spaces = 0;
  let colorlessLen = 0;

  let i = 0;
  while (i < name.length && name[i] === ' ') i++;

  for (; i < name.length && out.length < MAX_NETNAME - 1; i++) {
    const ch = name[i];

    if (ch === ' ') {
      // A run of spaces is a way of pushing a name across a scoreboard, so the run is capped.
      if (spaces > 2) continue;
      spaces++;
      out += ch;
      colorlessLen++;
      continue;
    }

    if (out.length > 0 && out[out.length - 1] === '^') {
      if (ch !== '^') {
        colorlessLen--;
        // Black is not allowed, because a black name is invisible against a dark background.
        if (colorIndex(ch) === 0) {
          out = out.slice(0, -1);
          continue;
        }
      } else {
        spaces = 0;
        colorlessLen++;
      }
      out += ch;
      continue;
    }

    spaces = 0;
    colorlessLen++;
    out += ch;
  }

  // A name that is only colour codes is no name at all.
  if (out.length === 0 || colorlessLen === 0) return 'UnnamedPlayer';
  return out;
}

/** `ColorIndex`: which of the eight colours a `^x` escape names. */
function colorIndex(ch: string): number {
  return (ch.charCodeAt(0) - 0x30) & 7;
}

/**
 * The `handicap` userinfo key as a health limit: 1 to 100, with anything else counting as 100
 * (`g_client.c:782–787`).
 */
function handicapOf(userinfo: string): number {
  const health = Number.parseInt(infoValueForKey(userinfo, 'handicap'), 10);
  return health >= 1 && health <= 100 ? health : 100;
}

/** Where a spawn from this spot puts a player: {@link SPAWN_LIFT} above it, facing its way. */
function spawnAt(spot: GameEntity): SpawnPoint {
  return {
    spot,
    origin: vec3(spot.s.origin.x, spot.s.origin.y, spot.s.origin.z + SPAWN_LIFT),
    angles: vec3(spot.s.angles.x, spot.s.angles.y, spot.s.angles.z)
  };
}

/**
 * Whether a spawn spot is closed to this kind of player: `nobots` shuts bots out and `nohumans`
 * shuts humans out (`g_client.c:199–204`).
 */
function spotClosedTo(spot: GameEntity, isbot: boolean): boolean {
  return isbot ? (spot.flags & FL.NO_BOTS) !== 0 : (spot.flags & FL.NO_HUMANS) !== 0;
}

/**
 * `G_SetOrigin` (`g_utils.c:626–634`): put an entity somewhere and stop it moving. The entity
 * state's `origin` is left as it was, which the body queue's nodrop test reads.
 */
function setOrigin(entity: GameEntity, origin: Vec3): void {
  entity.s.pos.trBase.x = origin.x;
  entity.s.pos.trBase.y = origin.y;
  entity.s.pos.trBase.z = origin.z;
  entity.s.pos.trType = 0;
  entity.s.pos.trTime = 0;
  entity.s.pos.trDuration = 0;
  entity.s.pos.trDelta.x = 0;
  entity.s.pos.trDelta.y = 0;
  entity.s.pos.trDelta.z = 0;

  entity.r.currentOrigin.x = origin.x;
  entity.r.currentOrigin.y = origin.y;
  entity.r.currentOrigin.z = origin.z;
}

/** How far apart two points are. */
function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
