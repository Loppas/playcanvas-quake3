import {
  CLC,
  CONFIGSTRING,
  MAX_CONFIGSTRINGS,
  MAX_MAP_AREA_BYTES,
  MAX_PACKET_USERCMDS,
  MAX_RELIABLE_COMMANDS,
  MAX_SNAPSHOT_ENTITIES,
  PACKET_BACKUP,
  PACKET_MASK,
  SNAPFLAG,
  SVC
} from '../net/commands';
import {
  copyEntityState,
  copyPlayerState,
  readDeltaUserCmdKey,
  writeDeltaEntity
} from '../net/delta';
import { atoi } from '../formats/c-scan';
import { cleanStr, colorRuns } from '../formats/color-codes';
import { DEBUG_MODE } from '../config';
import { entityTokens, type EntityTokens } from '../formats/entity-text';
import { bspPath } from '../formats/map-kind';
import { commandLines, tokenize } from '../formats/q3config';
import type { CvarStore } from '../net/cvar';
import {
  infoPrintLines,
  infoSetValueForKey,
  infoSetValueForKeyBig,
  infoValueForKey,
  MAX_INFO_STRING
} from '../net/info';
import { MASTER_SLOTS, namedMasters } from '../net/masters';
import { hashKey, MAX_MSGLEN, Message } from '../net/msg';
import {
  adrToString,
  compareBaseAdr,
  HEARTBEAT_FOR_MASTER,
  isLANAddress,
  isLocalAddress,
  isOutOfBand,
  NA,
  Net,
  netadr,
  type NetAdr
} from '../net/net';
import { Netchan } from '../net/netchan';
import {
  createEntityState,
  createNetUserCmd,
  MAX_CLIENTS,
  MAX_GENTITIES,
  type EntityState,
  type NetUserCmd,
  type PlayerState
} from '../net/protocol';
import {
  createServerSnapshot,
  writeSnapshot,
  type ServerSnapshot,
  type SnapshotEntityRing
} from '../net/snapshot';
import { SV_FPS, frameMsec, snapshotMsec } from '../net/snapshot-rate';
import { entityContact, setBrushModel } from '../sim/clip-trace';
import { GT, PERS } from '../sim/constants';
import { HITSCAN_RULES, SYSTEMINFO_CVARS } from '../sim/rules';
import { SVF, type GameEntity } from '../sim/game-entity';
import { leafArea, leafCluster } from '../sim/cm/cm-load';
import type { ClipMap } from '../sim/cm/cm-local';
import {
  areasConnected,
  clusterPVS,
  floodAreaConnections,
  pointLeafnum,
  writeAreaBits
} from '../sim/cm/cm-test';
import type { GameModule } from '../sim/game-module';
import { MAX_ENT_CLUSTERS, ServerWorld, type WorldMap } from '../sim/server-world';
import {
  clearTrace,
  NO_CONTENTS,
  type PointContentsFn,
  type TraceFn,
  type TraceResult
} from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { versionString } from '../version';
import {
  ChallengeTable,
  LeakyBuckets,
  rateLimit,
  readConnectionless,
  type LeakyBucket
} from './connectionless';

/**
 * The host — Quake 3's `sv_*`, which owns the client slots and decides what each of them is told.
 *
 * Quake 3 is always a server with clients attached, and a single-player game is that arrangement
 * with one client in the same process. The host runs the game module on a clock of its own, keeps a
 * slot per client with the last snapshots it sent them, and answers the game module's questions
 * about who is connected. It never simulates anything: the game module does that, and the two meet
 * at a seam narrow enough to name — ten calls in, a handful of traps back.
 *
 * The port keeps that seam, and keeps the local client on the far side of it. What a local client
 * knows arrives as an encoded snapshot through the loopback, as it would over a wire.
 */

/** `serverState_t` (`server.h:63–67`): whether the host has a map running. */
export const SS = {
  /** No map loaded. */
  DEAD: 0,
  /** The map's entities are being spawned. */
  LOADING: 1,
  /** Running. */
  GAME: 2
} as const;

/**
 * `clientState_t` (`server.h:117–124`): where a client is between connecting and playing.
 *
 * The order is the order a connection goes through, and every step is one message: a slot is taken
 * (`CONNECTED`), the gamestate is sent (`PRIMED`), the first user command comes back (`ACTIVE`).
 * `ZOMBIE` is the pause after a disconnect that stops a slot being handed straight to someone else.
 */
export const CS = {
  FREE: 0,
  ZOMBIE: 1,
  CONNECTED: 2,
  PRIMED: 3,
  ACTIVE: 4
} as const;

/**
 * A map as `CM_LoadMap` gives it to the server: its entity text and its collision
 * (`sv_init.c:470`). A splat map's are its `.ent` and its octree (`map-format.md` §11); a BSP's
 * are its lump 0 and its clip map.
 */
export interface HostMap {
  /** The map's name, as `map <n>` takes it. It becomes `mapname`, which clients read. */
  name: string;
  /**
   * The map's entity text: a splat map's `maps/<n>.ent`, or a BSP's lump 0, as `CM_EntityString`
   * gives it. The game module reads it a token at a time, and refuses a map with none.
   */
  entities: string;
  /**
   * The map's collision, as a swept-box trace, which `SV_Trace` runs first. It has no entities of
   * its own to pass. A map given none is an empty world, in which nothing is solid and a player
   * falls.
   */
  trace?: TraceFn;
  /**
   * What a point is inside on the map, model 0's, which `SV_PointContents` asks first. A map given
   * none holds nothing anywhere.
   */
  pointContents?: PointContentsFn;
  /** A BSP's collision, as `CM_LoadMap` loaded it, which {@link trace} runs through. */
  clipMap?: ClipMap;
}

/**
 * Where the host finds maps to load, which the program answers.
 *
 * Q3 reads a map's files blocking, inside `SV_SpawnServer`. The port reads them asynchronously,
 * so the host asks for a map and runs no frame until the program hands it back, loaded, through
 * {@link Host.spawnServer}. A test's program can answer at once.
 */
export interface HostMaps {
  /**
   * Whether `map <n>` can go ahead: `SV_Map_f`'s `FS_ReadFile` (`sv_ccmds.c:165–171`), on the
   * map's splat or its BSP, whichever it ships.
   */
  exists(name: string): boolean;
  /**
   * Read a map's files, and hand them to {@link Host.spawnServer} once they are in.
   *
   * @param killBots - `SV_SpawnServer`'s flag: a `devmap` drops the bots rather than carrying them
   *   over (`sv_init.c:515–518`).
   * @param cheat - Whether the map was asked for with `devmap`, which leaves `sv_cheats` 1; `null`
   *   leaves the cvar as it stands.
   */
  load(name: string, killBots?: boolean, cheat?: boolean | null): void;
}

/**
 * The serverinfo cvars the port has, which `CS_SERVERINFO` carries and `getstatus` answers with
 * (`CVAR_SERVERINFO`: `common.c:2794–2797`, `sv_init.c:633–648`, `g_main.c:99–183`). A client
 * reads `mapname` from it to know what map it is on (`cl_cgame.c:723–725`).
 *
 * Q3's are in the order it makes them, the engine's and then the game module's, so the string
 * starts as Q3's does, and SERVER INFO's sixteen rows are Q3's. The port's own follow.
 */
const SERVERINFO_CVARS = [
  // The build, and which game and wire it speaks, for a server browser.
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
  'g_needpass',
  'roundlimit',
  'g_gamepreset',
  // The shotgun's pattern, which a client draws a blast by.
  'g_pellets_sg',
  'g_spread_sg',
  'g_pattern_sg',
  // The other hitscan numbers, which a client draws its own shots by before the server answers.
  ...HITSCAN_RULES,
  // How a client draws the plasma, and the BFG's impact.
  'g_plasmaSize',
  'g_plasmaMarkSize',
  'g_splashradius_bfg',
  // The ammo a client warns under, by weapon.
  'g_lowAmmo_mg',
  'g_lowAmmo_sg',
  'g_lowAmmo_gl',
  'g_lowAmmo_rl',
  'g_lowAmmo_lg',
  'g_lowAmmo_rg',
  'g_lowAmmo_pg',
  'g_lowAmmo_bfg'
] as const;

/**
 * The commands the host runs of its own, as far as the port has them: nine of those
 * `SV_AddOperatorCommands` registers (`sv_ccmds.c:1523–1542`).
 */
const HOST_COMMANDS: ReadonlySet<string> = new Set([
  'heartbeat',
  'map',
  'devmap',
  'map_restart',
  'kick',
  'clientkick',
  'kickbots',
  'status',
  'serverinfo'
]);

/**
 * Whether a console command is the host's, and so goes in its command buffer rather than to the
 * client's settings. Q3 matches a command's name without regard to case (`Cmd_ExecuteString`).
 *
 * @param name - The command's first token.
 */
export function isHostCommand(name: string | undefined): boolean {
  return name !== undefined && HOST_COMMANDS.has(name.toLowerCase());
}

/** The world of a map given no collision: nothing in it is solid. */
const emptyWorld: TraceFn = (_start, _mins, _maxs, end) => clearTrace(end);

/** `client_t` (`server.h:134–202`), carried at the size this stage reaches. */
export interface HostClient {
  /** One of {@link CS}. */
  state: number;
  /** The client's own settings, as a Quake 3 info string. */
  userinfo: string;
  name: string;
  /**
   * The channel to the client, whose address says what kind of client it is: a bot's is
   * `NA_BOT`, and has no connection behind it.
   */
  readonly netchan: Netchan;
  /**
   * `netchan_start_queue` (`server.h:134–202`): whole messages that waited for the part-sent one
   * to finish, so nothing goes out of order.
   */
  readonly queuedMessages: Uint8Array[];

  /** The entity this client is playing as, or null before it enters the world. */
  gentity: GameEntity | null;

  /** Commands the client must acknowledge, kept for retransmission until it does. */
  readonly reliableCommands: string[];
  /** The last command added. */
  reliableSequence: number;
  /** The last command the client says it has run. */
  reliableAcknowledge: number;
  /** The last command actually put in a message. */
  reliableSent: number;

  /** The last message of ours the client says it received. */
  messageAcknowledge: number;
  /** The sequence the gamestate went out on, which is how a dropped gamestate is noticed. */
  gamestateMessageNum: number;
  /**
   * `cl->csUpdated`: the configstrings changed while the client was primed, which reach it only
   * as it enters the world.
   */
  readonly csUpdated: Set<number>;

  /** The message the client wants the next snapshot delta'd against, or -1 for none. */
  deltaMessage: number;
  lastUsercmd: NetUserCmd;
  /** The last reliable command we accepted from the client. */
  lastClientCommand: number;
  lastClientCommandString: string;
  /** `svs.time` before which a dedicated server ignores the client's next command. */
  nextReliableTime: number;

  /** `svs.time` the last packet came, which the client is timed out by. */
  lastPacketTime: number;
  /** The frames in a row the client has been past its timeout, so a stall is not taken for one. */
  timeoutCount: number;

  /** Host time the last snapshot went out. */
  lastSnapshotTime: number;
  /** How often this client wants snapshots, from its `snaps` setting. */
  snapshotMsec: number;
  /** `cl->rate`: the bandwidth its userinfo asks for, which its messages are paced by. */
  rate: number;
  /** True when a snapshot was held back, which the client is told so it can account for the gap. */
  rateDelayed: boolean;

  /** The last 32 snapshots sent, to delta the next one against. */
  readonly frames: ServerSnapshot[];

  /** The server time the client was on before a restart, until it acknowledges the new one. */
  oldServerTime: number;

  /** `svs.time` at the last connect, which a repeated connect is measured against. */
  lastConnectTime: number;

  /** `cl->ping`: the round trip to the client, in milliseconds, as `status` and `getstatus` say. */
  ping: number;
}

export interface HostOptions {
  /**
   * The game module, built against this host.
   *
   * It arrives as a factory because the two know each other: the host calls the game module's
   * exports, and the game module calls the host's traps.
   */
  game: (host: Host) => GameModule;

  /** Where the cvars live. The host and the game module read the same ones. */
  cvars: CvarStore;

  /** What `sv_maxclients` is registered with, for a store that has never been told otherwise. */
  maxclients?: number;

  /**
   * Where maps are found and loaded, for `map <n>` and for a latched cvar's reload. A host given
   * none can load only the map it has, again, from what it was handed.
   */
  maps?: HostMaps;

  /** `Com_Printf`: where the host's and the game module's console lines go. */
  print?: (text: string) => void;

  /** The process's way out, which a client in the same process shares. One is made if not given. */
  net?: Net;

  /** `rand()`, which a challenge's number is drawn from. */
  random?: () => number;

  /**
   * Whether this is a dedicated server, with no player of its own beside it. Quake 3 holds a
   * client to a command a second only then, telling by whether its process runs a client
   * (`com_cl_running`, `sv_client.c:1634`).
   */
  dedicated?: boolean;

  /**
   * `DEBUG_MODE`: a parameter, so a test can turn it off. With it on, `sv_cheats` is 1 whatever the
   * map command.
   */
  debugMode?: boolean;
}

/** How Quake 3's `MSG_ReadDeltaUsercmdKey` corrects a command that was never sent. */
const NO_DELTA_MESSAGE = -1;

/** `UDPIP_HEADER_SIZE` (`sv_main.c:1175`): what a datagram carries besides its message. */
const UDPIP_HEADER_SIZE = 28;

/** `HEARTBEAT_MSEC` (`sv_main.c:244`): how often a server heartbeats when nothing asks it to. */
const HEARTBEAT_MSEC = 300 * 1000;

/**
 * The frames a map load and a restart run before the clients come back (`sv_init.c:498`,
 * `sv_ccmds.c:303`), and each one's length, which is Quake 3's own frame whatever `sv_fps` is.
 */
const SETTLE_FRAMES = 3;
const SETTLE_MSEC = 100;

/**
 * The cvars a map is built around, which is why they latch.
 *
 * A match cannot take up either of them where it stands — one decides what game is being played
 * and the other how many slots there are to play it in — so a `map_restart` that finds one of them
 * changed loads the map again from the beginning instead of restarting it in place.
 */
const LATCHED_CVARS = ['sv_maxclients', 'g_gametype'] as const;

const f = Math.fround;

/** What the world is cleared over for a map: its collision, or an empty world for none. */
function worldMap(map: HostMap): WorldMap {
  return {
    clipMap: map.clipMap,
    trace: map.trace ?? emptyWorld,
    pointContents: map.pointContents ?? NO_CONTENTS
  };
}

export class Host {
  /** The loopback and the socket its clients' packets go through. */
  readonly net: Net;

  /** One of {@link SS}. */
  state: number = SS.DEAD;

  /** Changes on every map load, so a client can tell which map its messages belong to. */
  serverId = 0;
  /** The id before the last `map_restart`, which distinguishes a stale client from a lost one. */
  restartedServerId = 0;
  /** Part of the key that a client's user commands are scrambled with. */
  checksumFeed = 0;

  /** `sv.time`: the match's clock, restarted with the map. */
  time = 0;
  /** `svs.time`: strictly increasing across map changes, which is what a timeout is measured on. */
  svsTime = 0;

  /** `svs.nextHeartbeatTime`: when the next heartbeat is due, on {@link svsTime}. */
  private nextHeartbeatTime = 0;

  /** Time owed to the simulation that was not a whole frame. */
  timeResidual = 0;

  /** The map being played, as `CM_LoadMap` gave it: `sv_mapname`, its text and its collision. */
  map: HostMap = { name: '', entities: '' };

  /**
   * The map asked for and not yet handed back, or null. Q3's server runs nothing while it loads a
   * map, since the load blocks it; the port's runs no frame until the map is in.
   */
  loading: string | null = null;

  /** `sv.restartTime`: when a queued `map_restart` is due. */
  restartTime = 0;

  /**
   * `sv.restarting`: set while a `map_restart` is under way.
   *
   * The state says `SS_LOADING` through all of it, which is otherwise the host's way of saying
   * that nothing should be sent out yet. This is what tells a configstring apart: the clients are
   * still there and still playing, so a change made during the restart has to reach them.
   */
  restarting = false;

  /** `sv_maxclients`, taken up at a map load, since it is latched. */
  maxclients: number;

  readonly clients: HostClient[];
  readonly configstrings: string[] = new Array<string>(MAX_CONFIGSTRINGS).fill('');

  /**
   * Console commands the game module has asked for, in the order it asked, one to a line.
   *
   * Quake 3 keeps a command buffer of raw text and splits it as it runs it; nothing here adds
   * half a command, so the splitting happens on the way in and this holds the lines themselves.
   */
  readonly commandQueue: string[] = [];

  /** Counted so that two restarts asked for in one frame do not both happen. */
  private frameCount = 0;
  private lastRestartFrame = -1;

  /** What {@link LATCHED_CVARS} had been modified when this map was loaded. */
  private readonly latchedCounts = new Map<string, number>();

  /** What {@link SERVERINFO_CVARS} had been modified when `CS_SERVERINFO` was last written. */
  private readonly serverinfoCounts = new Map<string, number>();
  /** Each of {@link SYSTEMINFO_CVARS} as last written, and the server id beside them. */
  private readonly systeminfoCounts = new Map<string, number>();
  /** The store's count of every change as {@link updateServerinfo} last read it. */
  private serverinfoTotal = -1;
  /** The store's count of every change as {@link updateSysteminfo} last read it. */
  private systeminfoTotal = -1;

  /** Toggled on each map load, and sent in every snapshot so a client notices the change. */
  private snapFlagServerBit = 0;

  /** Bumped per snapshot built, so an entity cannot be added to the same one twice. */
  private snapshotCounter = 0;
  private readonly entityCounters = new Int32Array(MAX_GENTITIES);
  /** A snapshot's entity numbers, its eye, and a point it is seen from, kept between snapshots. */
  private readonly snapshotNumbers: number[] = [];
  private readonly eye = vec3(0, 0, 0);
  private readonly viewpoint = new Float32Array(3);

  /** Every entity state ever sent, in one ring shared by all clients. */
  private snapshotEntities: (EntityState | null)[];
  private numSnapshotEntities: number;
  private nextSnapshotEntities = 0;

  /** Each entity as it was when the map started, which a first sighting is delta'd from. */
  private readonly baselines: (EntityState | null)[] = new Array<EntityState | null>(
    MAX_GENTITIES
  ).fill(null);

  private readonly game: GameModule;
  private readonly cvars: CvarStore;
  private readonly random: () => number;
  private readonly challenges = new ChallengeTable();
  /** What each address has asked of the server from outside a connection, lately. */
  private readonly buckets = new LeakyBuckets();
  /** `outboundLeakyBucket`: all senders' requests together, which caps the answers. */
  private readonly outboundBucket: LeakyBucket = { lastTime: 0, burst: 0 };
  private readonly dedicated: boolean;
  private readonly debugMode: boolean;
  private readonly maps: HostMaps;
  private readonly printLine: (text: string) => void;

  /**
   * The message each gamestate and snapshot is written into, reused. What {@link sendMessageToClient}
   * hands the netchan is copied on its way out, so the buffer is free the moment the message has
   * gone.
   */
  private readonly outMessage = Message.write();

  /** `sv.entityParsePoint`: where the game module has read the entity text to. */
  private entityParsePoint: EntityTokens;

  /** The world the game module's entities are linked into, and traced through. */
  private readonly world = new ServerWorld(
    (number) => this.game.entity(number),
    worldMap(this.map)
  );

  constructor(options: HostOptions) {
    this.cvars = options.cvars;
    // `SV_Startup` (`sv_init.c:679–699`): the slots are the first thing there is, and how many of
    // them there are is the cvar's answer held to something a server can actually have.
    this.registerCvar('sv_maxclients', String(options.maxclients ?? 8));
    this.maxclients = this.boundMaxClients(1);
    this.maps = options.maps ?? {
      exists: (name) => name === this.map.name,
      load: () => this.spawnServer(this.reloaded(this.map))
    };
    this.printLine = options.print ?? console.log;
    this.random = options.random ?? Math.random;
    this.dedicated = options.dedicated ?? false;
    this.debugMode = options.debugMode ?? DEBUG_MODE;
    this.net = options.net ?? new Net({ cvars: this.cvars, print: this.printLine });
    this.registerCvar('sv_timeout', '200');
    this.registerCvar('sv_zombietime', '2');
    this.registerCvar('sv_reconnectlimit', '3');
    // `SV_Init` (`sv_init.c:643–685`): the rate knobs, of which the two bounds are serverinfo.
    this.registerCvar('sv_maxRate', '0');
    this.registerCvar('sv_minRate', '0');
    this.registerCvar('sv_lanForceRate', '1');
    // `SV_Init` (`sv_init.c:667`): the game's frame rate, which caps each client's snapshots too.
    this.registerCvar('sv_fps', String(SV_FPS));
    // `SV_Init` (`sv_init.c:651`): Q3's `sv_cheats`, read-only and in the systeminfo; `map` leaves
    // it 0 and `devmap` 1, and a DEBUG_MODE build always 1.
    this.registerCvar('sv_cheats', '1');
    // `Com_Init` (`common.c:2774`): Q3's `sv_paused`, which `SV_CheckPaused` keeps.
    this.registerCvar('sv_paused', '0');
    // `Com_Init` (`common.c:2777`): Q3's `sv_running`, read-only and 1 while a map runs.
    this.registerCvar('sv_running', '0');
    // `CL_Init` (`cl_main.c:3750`): Q3's `cl_running`, 1 where a client runs in this process.
    this.cvars.set('cl_running', this.dedicated ? '0' : '1');
    // `Com_Init` and `SV_Init` (`common.c:2794–2795`, `sv_init.c:640–648`). `version` is read-only,
    // so it is the build's whatever it held.
    this.cvars.set('version', versionString());
    this.registerCvar('sv_hostname', 'noname');
    this.registerCvar('sv_floodProtect', '1');
    this.entityParsePoint = entityTokens('');

    this.clients = Array.from({ length: this.maxclients }, () => createHostClient(this.net));
    this.numSnapshotEntities = this.maxclients * PACKET_BACKUP * MAX_SNAPSHOT_ENTITIES;
    this.snapshotEntities = new Array<EntityState | null>(this.numSnapshotEntities).fill(null);

    this.game = options.game(this);
  }

  /**
   * The map a host given no others loads again: the one it has, with its portals all shut, as
   * `CM_LoadMap` leaves a map it reads afresh.
   */
  private reloaded(map: HostMap): HostMap {
    if (map.clipMap) {
      map.clipMap.areaPortals.fill(0);
      floodAreaConnections(map.clipMap);
    }
    return map;
  }

  /**
   * `SV_SpawnServer` (`sv_init.c:398–600`), cut to what a map load means here, once the map's
   * files are in.
   *
   * The server id changes so that a client's messages can be dated, the snapshot flag is toggled so
   * a client notices the world restarted, and the baselines are taken after the game module has
   * spawned the map's entities — a baseline is what an entity looked like before anyone saw it.
   *
   * Before taking those baselines it runs three {@link settleFrame}s, so that whatever the map
   * dropped has landed and whatever it aims has aimed by the time anyone sees it, and one more once
   * the clients are back, "to allow things to look at all the players". A match starts 400 ms into
   * its clock.
   *
   * @param map - The map, loaded: what `CM_LoadMap` gives the server.
   * @param killBots - `SV_SpawnServer`'s flag: a `devmap` drops the bots rather than carrying them
   *   over (`sv_init.c:515–518`).
   * @param cheat - Whether the map was asked for with `devmap`, which leaves `sv_cheats` 1; `false`
   *   is a plain `map`, and `null` leaves the cvar as it stands, which is a `map_restart`'s reload
   *   (`sv_ccmds.c:263–273`).
   */
  spawnServer(map: HostMap, killBots = false, cheat: boolean | null = false): void {
    // `SV_ShutdownGameProgs`: the game that is running writes its sessions out before the map that
    // replaces it starts. Before the first map there is no game to ask, which is what dead means.
    if (this.state !== SS.DEAD) {
      this.game.shutdown(false);
      this.changeMaxClients();
    }

    // `CM_LoadMap` (`sv_init.c:470–473`): the map's collision and entity text, and its name,
    // which every client reads from the serverinfo.
    this.map = map;
    this.loading = null;
    this.cvars.set('mapname', map.name);
    // "Make sure we are not paused" (`sv_init.c:463–464`): a map load clears the pause.
    this.cvars.set('cl_paused', '0');

    this.state = SS.LOADING;
    this.serverId++;
    // The mark every restart after this is measured from. A map load moves it, because nothing
    // from before one is a client that is merely behind.
    this.restartedServerId = this.serverId;
    this.snapFlagServerBit ^= SNAPFLAG.SERVERCOUNT;
    this.snapshotCounter = 0;
    this.entityCounters.fill(0);
    this.baselines.fill(null);
    this.nextSnapshotEntities = 0;

    // `nextmap` is this map again unless the game or a server operator says otherwise. The
    // literal matters: it is what `ExitLevel` compares against to find a rotation (`sv_init.c:447`).
    this.cvars.set('nextmap', 'map_restart 0');

    // A client still loading is told what the clock now reads, so that when it arrives it does not
    // take the new time for the old one running backwards.
    for (const client of this.clients) {
      if (client.state >= CS.CONNECTED) client.oldServerTime = this.time;
    }

    // "Wipe the entire per-level structure" (`sv_init.c:457–461`).
    this.clearServer();

    this.initGame(false);

    // The map now runs on the values the latched cvars hold, so a `map_restart` from here is a
    // restart rather than another load (`sv_init.c:697`).
    for (const name of LATCHED_CVARS) {
      this.latchedCounts.set(name, this.cvars.modificationCount(name));
    }

    // "Run a few frames to allow everything to settle" (`sv_init.c:497–504`).
    for (let i = 0; i < SETTLE_FRAMES; i++) this.settleFrame(true);

    for (let number = 0; number < this.game.numEntities(); number++) {
      const entity = this.game.entity(number);
      if (!entity.r.linked) continue;
      this.baselines[number] = copyEntityState(entity.s, createEntityState(number));
    }

    // The serverinfo, as it stands once the game module has registered its cvars
    // (`sv_init.c:595`). A change during play is sent by {@link updateServerinfo}, as Q3 sends
    // one each frame it finds one.
    this.writeServerinfo();

    // `SV_Map_f`'s last word (`sv_ccmds.c:210–218`): `map` leaves `sv_cheats` 0, `devmap` 1, and a
    // DEBUG_MODE build says 1 whatever the command. Q3 sets it after the spawn and lets a
    // `cs` carry it; the port sets it before the systeminfo is written, because the client's own
    // application of that string would otherwise take the old value back into the one store they
    // share. A `map_restart`'s reload says nothing, so the value stands.
    if (cheat !== null) {
      this.cvars.set('sv_cheats', this.debugMode || cheat ? '1' : '0');
    }

    // The systeminfo carries the server id and the rules a client's prediction replays.
    // It is built here, once the game module has registered its cvars: before that every rule
    // would read as an empty string. A change during play is sent by {@link updateSysteminfo}.
    this.writeSysteminfo();

    this.state = SS.GAME;

    // Everyone who was here is connected to the new map. A client then waits, because a map load
    // is a new gamestate and a client is given that when it next asks rather than before. A bot
    // has nothing to be sent, and goes straight into the world (`sv_init.c:510–553`).
    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state < CS.CONNECTED) continue;

      const isBot = client.netchan.remoteAddress.type === NA.BOT;
      // `SV_SpawnServer`'s `killBots` (`sv_init.c:514–518`): a `devmap` starts without them.
      if (isBot && killBots) {
        this.dropClient(clientNum, '');
        continue;
      }

      const denied = this.game.clientConnect(clientNum, false, isBot);
      if (denied !== null) {
        this.dropClient(clientNum, denied);
        continue;
      }
      if (isBot) {
        this.clientEnterWorld(clientNum, client.lastUsercmd);
      } else {
        client.state = CS.CONNECTED;
        client.gentity = null;
      }
    }

    // "Run another frame to allow things to look at all the players" (`sv_init.c:556–560`).
    this.settleFrame(true);

    // "Send a heartbeat now so the master will get up to date info" (`sv_init.c:603–604`).
    this.heartbeat();

    // `SV_SpawnServer`'s last word (`sv_init.c:286`): the server is running, which the in-game
    // menu reads to know it is the host's.
    this.cvars.set('sv_running', '1');
  }

  /**
   * `SV_ClearServer` (`sv_init.c:364–373`) and the configstrings' reset after it (`:458–461`): what
   * belongs to one map goes with it. The clock starts again at 0, a restart the last map asked for
   * is dropped, and every configstring is empty until the new map's game and the host set it. The
   * server id and the baselines, which Quake 3's wipe takes too, are the load's own to set.
   */
  private clearServer(): void {
    this.time = 0;
    this.timeResidual = 0;
    this.restartTime = 0;
    this.restarting = false;
    this.configstrings.fill('');
  }

  /**
   * `SV_Shutdown` (`sv_init.c:742–777`): the clients are told why, and so are the masters, and the
   * server stops. `sv_running` says so: the in-game menu greys the host's items on a client whose
   * match is not its own. A server that is not running has nothing to shut down.
   *
   * @param finalMessage - Why, in Quake 3's words for whatever stopped it.
   * @param error - `com_errorEntered`: a shutdown inside `Com_Error` tells no client why
   *   (`sv_init.c:751`), and they are left to time out.
   */
  shutdown(finalMessage: string, error = false): void {
    if (this.cvarInt('sv_running') === 0) return;

    this.print(`----- Server Shutdown (${finalMessage}) -----`);
    if (!error) this.finalMessage(finalMessage);
    this.masterShutdown();

    this.cvars.set('sv_running', '0');
    this.state = SS.DEAD;
    this.print('---------------------------');
  }

  /**
   * `SV_FinalMessage` (`sv_init.c:712–731`): every client that is connected told why the server
   * went, twice, each time with a snapshot sent past its rate to carry it, since the server sends
   * nothing after. A client on the loopback is told nothing: it goes with the server.
   */
  private finalMessage(message: string): void {
    for (let pass = 0; pass < 2; pass++) {
      for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
        const client = this.clients[clientNum];
        if (client.state < CS.CONNECTED) continue;
        if (client.netchan.remoteAddress.type !== NA.LOOPBACK) {
          this.sendServerCommand(clientNum, `print "${message}\n"\n`);
          this.sendServerCommand(clientNum, `disconnect "${message}"`);
        }
        client.lastSnapshotTime = 0;
        this.sendClientSnapshot(client, clientNum);
      }
    }
  }

  /**
   * `SV_Heartbeat_f` (`sv_ccmds.c:1376–1378`): a heartbeat at the end of the next frame that runs,
   * whatever the time. The `heartbeat` command asks for one, and so do a map's spawn, a `connect`
   * that takes the first or the last slot, and the last client leaving.
   */
  private heartbeat(): void {
    this.nextHeartbeatTime = -9999999;
  }

  /**
   * A master has granted the server's registration, on a connection to it that has just opened. A
   * master unlists a server whose connection closes and lists it again only by a heartbeat, so one
   * goes at the end of the next frame, not when the next falls due, up to {@link HEARTBEAT_MSEC}
   * later. The port's own: Quake 3's UDP has no connection to lose.
   */
  masterRegistered(): void {
    this.heartbeat();
  }

  /**
   * `SV_MasterHeartbeat` (`sv_main.c:246–332`): on `dedicated 2`, `heartbeat` to every master the
   * slots name, every {@link HEARTBEAT_MSEC} or sooner when asked. Each master answers with a
   * `getinfo`, and lists the server by its `infoResponse`.
   */
  private masterHeartbeat(): void {
    if (this.cvarInt('dedicated') !== 2) return;
    if (this.svsTime < this.nextHeartbeatTime) return;
    this.nextHeartbeatTime = this.svsTime + HEARTBEAT_MSEC;

    const slots = MASTER_SLOTS.map((slot) => this.cvars.get(slot));
    for (const { at, name } of namedMasters(slots)) {
      this.print(`Sending heartbeat to ${name}`);
      this.net.outOfBandPrint('server', at.adr, `heartbeat ${HEARTBEAT_FOR_MASTER}\n`);
    }
  }

  /**
   * `SV_MasterShutdown` (`sv_main.c:341–352`): two heartbeats at once, to minimize the chance of a
   * drop, whose `getinfo`s the server will not be there to answer.
   */
  private masterShutdown(): void {
    this.nextHeartbeatTime = -9999;
    this.masterHeartbeat();
    this.nextHeartbeatTime = -9999;
    this.masterHeartbeat();
  }

  /**
   * `SV_InitGameVM` (`sv_game.c:874–892`): start the game module, reading the map's entity text
   * from its start, as a restart reads it again.
   *
   * The world is cleared first: a map load's `SV_ClearWorld` (`sv_init.c:484`). A restart's game
   * module starts its entities afresh too, so the port clears it then as well, where Quake 3 leaves
   * the old slots listed, unseen but at the origin, until each is linked again.
   */
  private initGame(restart: boolean): void {
    this.world.clear(worldMap(this.map));
    this.entityParsePoint = entityTokens(this.map.entities);
    this.game.init(this.time, this.serverId, restart);
  }

  /**
   * `SV_MapRestart_f` (`sv_ccmds.c:1084–1211`): the same map, with the match started over.
   *
   * Nothing is loaded again. The game module is shut down and started up in place, which clears
   * the world and the scores, and every client is connected again without the first-time flag —
   * that is what carries the sessions across and leaves everything else behind.
   *
   * @param delay - Seconds to wait first, which the console's bare `map_restart` makes 5. A warmup
   *   has a countdown of its own, so a delay is dropped rather than added to it.
   */
  mapRestart(delay: number): void {
    // Quake 3 stamps the server id with the frame time, so a second restart in the same frame
    // finds its own mark and does nothing. The port counts its frames instead, because its server
    // id counts maps rather than milliseconds.
    if (this.frameCount === this.lastRestartFrame) return;
    if (this.state !== SS.GAME) return;
    if (this.restartTime) return;

    if (delay && !this.cvarInt('g_doWarmup')) {
      this.restartTime = this.time + delay * 1000;
      this.setConfigstring(CONFIGSTRING.WARMUP, String(this.restartTime));
      return;
    }

    // A latched cvar changed under the match, and neither of them is one a match can take up where
    // it stands, so the map is loaded again from the beginning instead: "the slow way",
    // `SV_SpawnServer` on `mapname`, which reads its files again (`sv_ccmds.c:263–273`).
    if (this.latchedChanged()) {
      // The reload is Q3's `SV_SpawnServer` from `map_restart`, which says nothing of cheats.
      this.loadMap(this.map.name, false, null);
      return;
    }

    this.lastRestartFrame = this.frameCount;
    this.snapFlagServerBit ^= SNAPFLAG.SERVERCOUNT;
    this.serverId++;
    // `restartedServerId` is deliberately left where the last map load put it, so that a client
    // several restarts behind is caught by the whole range rather than only by the last one.
    this.writeSysteminfo();

    // A client still loading is given the clock the restart was due at, which by now is zero: the
    // frame clears it before queueing the command that gets here.
    for (const client of this.clients) {
      if (client.state === CS.PRIMED) client.oldServerTime = this.restartTime;
    }

    this.state = SS.LOADING;
    this.restarting = true;

    // `SV_RestartGameProgs`: down and up again with `restart` set, which is the game module's
    // signal to keep the sessions and skip the warmup it has already run.
    this.game.shutdown(true);
    this.initGame(true);

    // "Run a few frames to allow everything to settle" (`sv_ccmds.c:302–308`), without the bots'.
    for (let i = 0; i < SETTLE_FRAMES; i++) this.settleFrame(false);

    this.state = SS.GAME;
    this.restarting = false;

    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state < CS.CONNECTED) continue;

      this.sendServerCommand(clientNum, 'map_restart\n');

      const isBot = client.netchan.remoteAddress.type === NA.BOT;
      const denied = this.game.clientConnect(clientNum, false, isBot);
      if (denied !== null) {
        this.dropClient(clientNum, denied);
        continue;
      }

      // A client that was playing keeps the command it was last moving on; one that was still
      // loading has none belonging to this world, and a stale one would leave it stuck.
      this.clientEnterWorld(clientNum, client.state === CS.ACTIVE ? client.lastUsercmd : null);
    }

    // "Run another frame to allow things to look at all the players" (`sv_ccmds.c:352–355`).
    this.settleFrame(false);
  }

  /**
   * One of the game frames a map load and a restart run before play, "to allow everything to
   * settle": Quake 3's 100 ms whatever `sv_fps` is, at the time the clock reads, which then moves
   * on. A map load's run the bots' frame after each.
   *
   * @param bots - Whether the bots' frame runs too.
   */
  private settleFrame(bots: boolean): void {
    this.game.runFrame(this.time);
    if (bots) this.game.botAIStartFrame(this.time);
    this.time += SETTLE_MSEC;
    this.svsTime += SETTLE_MSEC;
  }

  /**
   * `Cbuf_Execute` (`cmd.c:172–249`): run what the game module has asked the host for.
   *
   * Quake 3 runs one command buffer for the whole program, just before the server's frame
   * (`common.c:3174`). The port has only the server's half of it, because the game module is the
   * only thing putting anything in.
   */
  executeCommands(): void {
    // A command may put another in front of itself — `vstr` does — so the queue is read down to
    // nothing rather than copied and walked.
    while (this.commandQueue.length > 0) {
      this.executeCommand(this.commandQueue.shift()!);
    }
  }

  /**
   * `SV_ChangeMaxClients` (`sv_init.c:611–672`): take up a new `sv_maxclients`, which is latched
   * and so can only change at a map load.
   *
   * The slots in use keep their numbers, and the count never drops below the highest of them: a
   * client is not disconnected by somebody typing a smaller number.
   */
  private changeMaxClients(): void {
    let highest = 0;
    for (let i = 0; i < this.maxclients; i++) {
      if (this.clients[i].state >= CS.CONNECTED && i > highest) highest = i;
    }

    const before = this.maxclients;
    const wanted = this.boundMaxClients(highest + 1);
    if (wanted === before) return;

    if (wanted > before) {
      for (let i = before; i < wanted; i++) this.clients.push(createHostClient(this.net));
    } else {
      this.clients.length = wanted;
    }
    this.maxclients = wanted;

    this.numSnapshotEntities = wanted * PACKET_BACKUP * MAX_SNAPSHOT_ENTITIES;
    this.snapshotEntities = new Array<EntityState | null>(this.numSnapshotEntities).fill(null);
  }

  /**
   * `SV_BoundMaxClients` (`sv_init.c:589–603`): the cvar held to a number of slots that can
   * actually exist, and written back so that what the console reports is what the server has.
   */
  private boundMaxClients(minimum: number): number {
    const wanted = Number.parseInt(this.registerCvar('sv_maxclients', '8'), 10) || 0;
    const bounded = Math.min(MAX_CLIENTS, Math.max(minimum, wanted));
    if (bounded !== wanted) this.cvars.set('sv_maxclients', String(bounded));
    return bounded;
  }

  /**
   * `SV_Frame`'s serverinfo check (`sv_main.c:1103–1106`): a `CVAR_SERVERINFO` cvar that has been
   * given a new value is sent out, so a client reads the limits the match is actually going by.
   *
   * Quake 3 asks `cvar_modifiedFlags`, which is set by any write and cleared here; the port asks
   * the store's count of every change whether anything moved, and each cvar's count which. The
   * match itself reads the cvars where it stands and needs none of this — it is the HUD that
   * would otherwise be drawing the limit the map was loaded with.
   */
  private updateServerinfo(): void {
    const total = this.cvars.totalModifications();
    if (total === this.serverinfoTotal) return;
    this.serverinfoTotal = total;
    if (!SERVERINFO_CVARS.some((name) => this.cvars.modificationCount(name) !== this.serverinfoCounts.get(name))) {
      return;
    }
    this.writeServerinfo();
  }

  /** `CS_SERVERINFO` set from the cvars, with what each had been modified when it was. */
  private writeServerinfo(): void {
    for (const name of SERVERINFO_CVARS) {
      this.serverinfoCounts.set(name, this.cvars.modificationCount(name));
    }
    this.setConfigstring(CONFIGSTRING.SERVERINFO, this.serverinfo());
  }

  /**
   * `Cvar_InfoString(CVAR_SERVERINFO)` (`cvar.c:1236–1250`): the serverinfo cvars as they are.
   * Each key goes on the front, so the list is read from its end and comes out in its own order,
   * as Quake 3's comes out in the order its cvars were made.
   */
  private serverinfo(): string {
    let info = '';
    for (const name of [...SERVERINFO_CVARS].reverse()) {
      info = infoSetValueForKey(info, name, this.cvars.get(name));
    }
    return info;
  }

  /**
   * `SV_Frame`'s systeminfo check, as {@link updateServerinfo} does for the serverinfo: a rule a
   * client's prediction reads, or the server id, that has been given a new value is sent out.
   *
   * Q3 asks `cvar_modifiedFlags`; the port asks the store's count of every change, then each
   * cvar's count, and holds the server id beside them because it is the host's own number rather
   * than a cvar.
   */
  private updateSysteminfo(): void {
    const serverIdMoved = this.systeminfoCounts.get('sv_serverid') !== this.serverId;
    const total = this.cvars.totalModifications();
    if (!serverIdMoved && total === this.systeminfoTotal) return;
    this.systeminfoTotal = total;
    const moved = SYSTEMINFO_CVARS.some(
      (name) => this.cvars.modificationCount(name) !== this.systeminfoCounts.get(name)
    );
    if (!serverIdMoved && !moved) return;
    this.writeSysteminfo();
  }

  /** `CS_SYSTEMINFO` set from the cvars, with what each had been modified when it was. */
  private writeSysteminfo(): void {
    for (const name of SYSTEMINFO_CVARS) {
      this.systeminfoCounts.set(name, this.cvars.modificationCount(name));
    }
    this.systeminfoCounts.set('sv_serverid', this.serverId);
    this.setConfigstring(CONFIGSTRING.SYSTEMINFO, this.systeminfo());
  }

  /**
   * `Cvar_InfoString_Big(CVAR_SYSTEMINFO)` (`cvar.c:1254–1270`): the systeminfo cvars as they
   * are, in the list's order, with the server id in front. Every rule is small, but there are
   * enough of them that the string outgrows `MAX_INFO_STRING`, which is what the big size is for.
   */
  private systeminfo(): string {
    let info = '';
    for (const name of [...SYSTEMINFO_CVARS].reverse()) {
      info = infoSetValueForKeyBig(info, name, this.cvars.get(name));
    }
    return infoSetValueForKeyBig(info, 'sv_serverid', String(this.serverId));
  }

  /** Whether a cvar the map was built around has been given a new value since it was loaded. */
  private latchedChanged(): boolean {
    return LATCHED_CVARS.some(
      (name) => this.cvars.modificationCount(name) !== this.latchedCounts.get(name)
    );
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

  /** `sv_fps`, set to 10 first if it is under 1, as `SV_Frame` sets it (`sv_main.c:1083–1085`). */
  private svFps(): number {
    if (this.cvarInt('sv_fps') < 1) this.cvars.set('sv_fps', '10');
    return this.cvarInt('sv_fps');
  }

  /**
   * `Cmd_ExecuteString` (`cmd.c:800–850`), reduced to the commands a host has of its own.
   *
   * Quake 3 tries the registered commands, then the cvars, then the game module. The port's cvars
   * are set through the console the settings own, so what is left here is the first and the last.
   */
  private executeCommand(line: string): void {
    const argv = tokenize(line);
    if (argv.length === 0) return;

    switch (argv[0].toLowerCase()) {
      case 'heartbeat':
        this.heartbeat();
        return;
      case 'map':
        this.mapCommand(argv[1], false);
        return;
      case 'devmap':
        this.mapCommand(argv[1], true);
        return;
      case 'map_restart':
        this.mapRestart(argv.length > 1 ? Number.parseInt(argv[1], 10) || 0 : 5);
        return;
      case 'kick':
        this.kick(argv);
        return;
      case 'clientkick':
        this.clientKick(argv);
        return;
      case 'kickbots':
        this.kickBots();
        return;
      case 'status':
        this.statusCommand();
        return;
      case 'serverinfo':
        this.serverinfoCommand();
        return;
      case 'vstr':
        // `Cmd_Vstr_f` (`cmd.c:700–712`): a cvar run as a command, and run in front of whatever
        // is queued behind it — which is what lets `vstr nextmap` reach the map first.
        if (argv.length === 2) this.commandQueue.unshift(...commandLines(this.cvars.get(argv[1])));
        return;
      default:
        // `SV_GameCommand` (`sv_game.c:452–458`), which answers nothing while no map is running.
        if (this.state === SS.GAME) this.game.consoleCommand(line);
    }
  }

  /**
   * `SV_Map_f` (`sv_ccmds.c:153–219`): change to a map by name, the plain `map` or the `devmap`
   * that leaves `sv_cheats` 1 and starts without the bots.
   *
   * The map is looked for before anything changes, so that a typo leaves the match running. Q3's
   * `spmap` and `spdevmap` are single-player, and the port has none.
   *
   * @param name - The map's name, or nothing, which does nothing.
   * @param cheat - Whether this was `devmap`.
   */
  private mapCommand(name: string | undefined, cheat: boolean): void {
    if (!name) return;
    if (!this.maps.exists(name)) {
      this.printLine(`Can't find map ${bspPath(name)}`);
      return;
    }
    this.loadMap(name, cheat, cheat);
  }

  /**
   * `SV_Kick_f` (`sv_ccmds.c:367–417`): drop a client by its slot or its name. When no client
   * goes by the name, `kick all` drops every client but the one in this process, and
   * `kick allbots` every bot.
   */
  private kick(argv: readonly string[]): void {
    if (this.state === SS.DEAD) {
      this.printLine('Server is not running.');
      return;
    }
    if (argv.length !== 2) {
      this.printLine('Usage: kick <player name>');
      this.printLine('kick all = kick everyone');
      this.printLine('kick allbots = kick all bots');
      return;
    }

    const clientNum = this.playerByHandle(argv[1]);
    if (clientNum === null) {
      const which = argv[1].toLowerCase();
      if (which === 'all') {
        this.kickWhere((client) => client.netchan.remoteAddress.type !== NA.LOOPBACK);
      } else if (which === 'allbots') {
        this.kickWhere((client) => client.netchan.remoteAddress.type === NA.BOT);
      }
      return;
    }
    this.kickClient(clientNum);
  }

  /** `SV_KickNum_f` (`sv_ccmds.c:487–512`): drop a client by its slot. */
  private clientKick(argv: readonly string[]): void {
    if (this.state === SS.DEAD) {
      this.printLine('Server is not running.');
      return;
    }
    if (argv.length !== 2) {
      this.printLine(`Usage: ${argv[0]} <client number>`);
      return;
    }
    const clientNum = this.playerByNum(argv[1]);
    if (clientNum !== null) this.kickClient(clientNum);
  }

  /** `SV_KickBots_f` (`sv_ccmds.c:426–448`): drop every bot. */
  private kickBots(): void {
    if (this.state === SS.DEAD) {
      this.printLine('Server is not running.');
      return;
    }
    this.kickWhere((client) => client.netchan.remoteAddress.type === NA.BOT);
  }

  /** Drop this client, unless it is the one in this process, which nothing may kick. */
  private kickClient(clientNum: number): void {
    if (this.clients[clientNum].netchan.remoteAddress.type === NA.LOOPBACK) {
      this.printLine('Cannot kick host player');
      return;
    }
    this.dropKicked(clientNum);
  }

  /** Drop every client in a slot that this picks. */
  private kickWhere(picked: (client: HostClient) => boolean): void {
    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state === CS.FREE || !picked(client)) continue;
      this.dropKicked(clientNum);
    }
  }

  /**
   * A kick's drop. The zombie's wait is counted from now, not from the client's last packet, so a
   * client that had gone quiet does not have its slot freed at once (`sv_ccmds.c:393`).
   */
  private dropKicked(clientNum: number): void {
    this.dropClient(clientNum, 'was kicked');
    this.clients[clientNum].lastPacketTime = this.svsTime;
  }

  /**
   * `SV_Status_f` (`sv_ccmds.c:1163–1227`): every slot in use, with its score, ping, name,
   * address and rate.
   *
   * A client still connecting has `CON` for its ping, and one leaving `ZMB`, a character narrower
   * than a ping, so the rest of its row sits a column left, as ioquake3's does. The row ends with
   * the client's `rate`, the bandwidth its messages are paced by.
   */
  private statusCommand(): void {
    if (this.state === SS.DEAD) {
      this.printLine('Server is not running.');
      return;
    }

    this.printLine(`map: ${this.cvars.get('mapname')}`);
    this.printLine('cl score ping name            address                                 rate ');
    this.printLine('-- ----- ---- --------------- --------------------------------------- -----');
    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state === CS.FREE) continue;

      const score = this.game.playerState(clientNum).persistant[PERS.SCORE];
      let ping = `${String(Math.min(client.ping, 9999)).padStart(4)} `;
      if (client.state === CS.CONNECTED) ping = 'CON ';
      else if (client.state === CS.ZOMBIE) ping = 'ZMB ';
      // A name is padded by what it shows, so its colour codes are not counted (`SV_Strlen`).
      const shown = colorRuns(client.name).reduce((length, run) => length + run.text.length, 0);
      const address = adrToString(client.netchan.remoteAddress);

      this.printLine(
        `${String(clientNum).padStart(2)} ${String(score).padStart(5)} ${ping}` +
          `${client.name}${' '.repeat(Math.max(16 - shown, 1))}` +
          `^7${address}${' '.repeat(Math.max(39 - address.length, 1))}` +
          ` ${String(client.rate).padStart(5)}`
      );
    }
    this.printLine('');
  }

  /** `SV_Serverinfo_f` (`sv_ccmds.c:1388–1400`): the serverinfo cvars as they stand. */
  private serverinfoCommand(): void {
    if (this.state === SS.DEAD) {
      this.printLine('Server is not running.');
      return;
    }
    this.printLine('Server info settings:');
    for (const line of infoPrintLines(this.serverinfo())) this.printLine(line);
  }

  /**
   * `SV_GetPlayerByHandle` (`sv_ccmds.c:42–96`): a client by its slot, if the handle is all
   * digits and the slot is taken, and otherwise by its name, with or without its colours.
   *
   * @returns the slot, or null, having said so
   */
  private playerByHandle(handle: string): number | null {
    if (/^[0-9]*$/.test(handle)) {
      const clientNum = Number.parseInt(handle, 10) || 0;
      const taken = clientNum < this.maxclients && this.clients[clientNum].state !== CS.FREE;
      if (taken) return clientNum;
    }

    const wanted = handle.toLowerCase();
    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state === CS.FREE) continue;
      if (client.name.toLowerCase() === wanted) return clientNum;
      if (cleanStr(client.name).toLowerCase() === wanted) return clientNum;
    }

    this.printLine(`Player ${handle} is not on the server`);
    return null;
  }

  /**
   * `SV_GetPlayerByNum` (`sv_ccmds.c:105–141`): a client by its slot.
   *
   * @returns the slot, or null, having said why
   */
  private playerByNum(handle: string): number | null {
    if (!/^[0-9]*$/.test(handle)) {
      this.printLine(`Bad slot number: ${handle}`);
      return null;
    }
    const clientNum = Number.parseInt(handle, 10) || 0;
    if (clientNum >= this.maxclients) {
      this.printLine(`Bad client slot: ${clientNum}`);
      return null;
    }
    if (this.clients[clientNum].state === CS.FREE) {
      this.printLine(`Client ${clientNum} is not active`);
      return null;
    }
    return clientNum;
  }

  /**
   * Ask the program for a map, and run no frame until it is handed back to {@link spawnServer}.
   * A program that answers at once has spawned it by the time this returns.
   */
  private loadMap(name: string, killBots = false, cheat: boolean | null = false): void {
    this.loading = name;
    this.maps.load(name, killBots, cheat);
  }

  /** An entity's baseline, which is a zeroed state for anything the map did not place. */
  baseline(number: number): EntityState {
    return this.baselines[number] ?? createEntityState(number);
  }

  /**
   * `SV_PacketEvent` (`sv_main.c:833`): a packet that reached the server, matched to its client by
   * address and qport.
   *
   * The qport is there because a router can change a client's port mid-game. Two clients behind
   * one address are told apart by it, and a client whose port has moved is followed to the new one.
   */
  packetEvent(from: NetAdr, data: Uint8Array): void {
    if (isOutOfBand(data)) {
      this.connectionlessPacket(from, data);
      return;
    }

    const header = Message.read(data);
    header.beginReading(true);
    header.readLong();
    const qport = header.readShort() & 0xffff;

    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state === CS.FREE) continue;
      const { netchan } = client;
      if (!compareBaseAdr(from, netchan.remoteAddress) || netchan.qport !== qport) continue;

      if (netchan.remoteAddress.port !== from.port) {
        this.print('SV_PacketEvent: fixing up a translated port');
        netchan.remoteAddress.port = from.port;
      }

      // A zombie's packets still go through its netchan, which keeps the sequence current, but
      // nothing in them is acted on, nor keeps its slot from being freed.
      const message = netchan.process(data);
      if (message !== null && client.state !== CS.ZOMBIE) {
        client.lastPacketTime = this.svsTime;
        this.executeClientMessage(client, clientNum, message.data);
      }
      return;
    }
  }

  /**
   * `SV_ConnectionlessPacket` (`sv_main.c:785–824`): a packet from outside any connection, which
   * is one line of words.
   */
  private connectionlessPacket(from: NetAdr, data: Uint8Array): void {
    const argv = readConnectionless(data);
    switch ((argv[0] ?? '').toLowerCase()) {
      case 'getstatus':
        this.getStatus(from, argv);
        return;
      case 'getinfo':
        this.getInfo(from, argv);
        return;
      case 'getchallenge':
        this.getChallenge(from, argv);
        return;
      case 'connect':
        this.directConnect(from, argv);
        return;
      // A client that has just started a server of its own sends its old one a `disconnect`,
      // which is ignored rather than taken for anything (`sv_main.c:816–819`).
    }
  }

  /**
   * `SVC_Status` (`sv_main.c:533–591`): the serverinfo and the players, for anyone who asks, with
   * the asker's challenge in the serverinfo so it can tell the answer is to its question.
   *
   * Quake 3's players are a line each, `<score> <ping> "<name>"`, and a blank line ends them for
   * its reader. The port goes on past it with what a client in the match reads of the board: the
   * `scores` command, then each player's `CS_PLAYERS` as the `cs` command that sets it. It all
   * goes as one datagram, stopping short of `MAX_MSGLEN` as Quake 3's players do.
   */
  private getStatus(from: NetAdr, argv: readonly string[]): void {
    if (this.singlePlayer() || this.overRateLimit(from)) return;
    const challenge = argv[1] ?? '';
    if (challenge.length > 128) return;

    const infostring = infoSetValueForKey(this.serverinfo(), 'challenge', challenge);
    let status = '';
    const add = (line: string): boolean => {
      if (status.length + line.length >= MAX_MSGLEN) return false;
      status += line;
      return true;
    };

    let full = false;
    for (let clientNum = 0; clientNum < this.maxclients && !full; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state < CS.CONNECTED) continue;
      const score = this.game.playerState(clientNum).persistant[PERS.SCORE];
      full = !add(`${score} ${client.ping} "${client.name}"\n`);
    }

    if (!full && add('\n') && add(`${this.game.scoreboardMessage()}\n`)) {
      for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
        const index = CONFIGSTRING.PLAYERS + clientNum;
        const player = this.configstrings[index];
        if (player !== '' && !add(`cs ${index} "${player}"\n`)) break;
      }
    }

    this.net.outOfBandPrint('server', from, `statusResponse\n${infostring}\n${status}`);
  }

  /**
   * `SVC_Info` (`sv_main.c:601–688`): the few keys a server browser lists a server by.
   *
   * Bots count among the clients, and not among the humans. The port checks nobody's paks, so no
   * server of its is pure.
   */
  private getInfo(from: NetAdr, argv: readonly string[]): void {
    if (this.singlePlayer() || this.overRateLimit(from)) return;
    const challenge = argv[1] ?? '';
    if (challenge.length > 128) return;

    let count = 0;
    let humans = 0;
    for (const client of this.clients) {
      if (client.state < CS.CONNECTED) continue;
      count++;
      if (client.netchan.remoteAddress.type !== NA.BOT) humans++;
    }

    // Each key goes on the front, so they arrive in the reverse of this order, as Quake 3's do.
    const keys: [string, string][] = [
      ['challenge', challenge],
      ['gamename', this.net.gamename],
      ['protocol', String(this.net.protocol)],
      ['hostname', this.cvars.get('sv_hostname')],
      ['mapname', this.cvars.get('mapname')],
      ['clients', String(count)],
      ['g_humanplayers', String(humans)],
      ['sv_maxclients', String(this.maxclients)],
      ['gametype', String(this.cvarInt('g_gametype'))],
      ['pure', '0'],
      ['g_needpass', String(this.cvarInt('g_needpass'))]
    ];
    let info = '';
    for (const [key, value] of keys) info = infoSetValueForKey(info, key, value);
    this.net.outOfBandPrint('server', from, `infoResponse\n${info}`);
  }

  /**
   * A single-player match takes nobody from outside, and answers nothing from there
   * (`sv_main.c:544`, `sv_client.c:66`).
   */
  private singlePlayer(): boolean {
    return (
      this.cvarInt('g_gametype') === GT.SINGLE_PLAYER || this.cvarInt('ui_singlePlayerActive') !== 0
    );
  }

  /**
   * The limits on what is answered outside a connection (`sv_main.c:548–560`): ten a second to one
   * address, so the server is no use for multiplying a flood at someone else, and ten every 100 ms
   * to everyone, so a flood from many addresses costs no more to answer than that.
   */
  private overRateLimit(from: NetAdr): boolean {
    const now = Math.floor(this.net.now());
    if (this.buckets.rateLimitAddress(from, 10, 1000, now)) return true;
    return rateLimit(this.outboundBucket, 10, 100, now);
  }

  /**
   * `SV_GetChallenge` (`sv_client.c:53–202`): a number the client must send back with its
   * `connect`, which proves the address it gave is where it is.
   */
  private getChallenge(from: NetAdr, argv: readonly string[]): void {
    if (this.singlePlayer() || this.overRateLimit(from)) return;

    const { net } = this;
    const gameName = argv[2] ?? '';
    if (gameName !== net.gamename) {
      const mismatch = `print\nGame mismatch: This is a ${net.gamename} server\n`;
      net.outOfBandPrint('server', from, mismatch);
      return;
    }

    const clientChallenge = atoi(argv[1] ?? '');
    const entry = this.challenges.issue(from, clientChallenge, this.svsTime, this.random);
    net.outOfBandPrint(
      'server',
      entry.adr,
      `challengeResponse ${entry.challenge} ${clientChallenge} ${net.protocol}`
    );
  }

  /**
   * `SV_DirectConnect` (`sv_client.c:322–599`): a `connect`, answered with a slot or a reason.
   *
   * The client is only connected by this: it has a slot and a channel, and the gamestate goes in
   * answer to its first sequenced packet, which the `connectResponse` asks for.
   */
  private directConnect(from: NetAdr, argv: readonly string[]): void {
    const { net } = this;
    // `Q_strncpyz` into `MAX_INFO_STRING`.
    let userinfo = (argv[1] ?? '').slice(0, MAX_INFO_STRING - 1);

    const version = atoi(infoValueForKey(userinfo, 'protocol'));
    if (version !== net.protocol) {
      net.outOfBandPrint(
        'server',
        from,
        `print\nServer uses protocol version ${net.protocol} (yours is ${version}).\n`
      );
      return;
    }

    const challenge = atoi(infoValueForKey(userinfo, 'challenge'));
    const qport = atoi(infoValueForKey(userinfo, 'qport'));

    // A client that connected a moment ago is sending its connect again, and is not answered.
    const limit = this.cvarInt('sv_reconnectlimit') * 1000;
    const known = this.clients.find(
      (client) => client.state !== CS.FREE && isSameClient(client, from, qport)
    );
    if (known !== undefined && this.svsTime - known.lastConnectTime < limit) return;

    // The address the game module checks a password and a ban by, which the client does not get
    // to state.
    const ip = isLocalAddress(from) ? 'localhost' : adrToString(from);
    if (ip.length + userinfo.length + 4 >= MAX_INFO_STRING) {
      net.outOfBandPrint(
        'server',
        from,
        'print\nUserinfo string length exceeded.  Try removing setu cvars from your config.\n'
      );
      return;
    }
    userinfo = infoSetValueForKey(userinfo, 'ip', ip);

    // The loopback needs no challenge: nothing outside the process can send from it.
    if (!isLocalAddress(from)) {
      const found = this.challenges.find(from, challenge);
      if (found === null) {
        net.outOfBandPrint('server', from, 'print\nNo or bad challenge for your address.\n');
        return;
      }
      // Refused already, so the answer that went then stays on the client's screen.
      if (found.entry.wasrefused) return;
      const ping = this.svsTime - found.entry.pingTime;
      this.print(`Client ${found.index} connecting with ${ping} challenge ping`);
      found.entry.connected = true;
    }

    // The same client connecting again takes its own slot back, without a disconnect.
    let clientNum = this.clients.findIndex(
      (client) => client.state !== CS.FREE && isSameClient(client, from, qport)
    );
    if (clientNum !== -1) {
      this.print(`${adrToString(from)}:reconnect`);
    } else {
      clientNum = this.clients.findIndex((client) => client.state === CS.FREE);
    }

    if (clientNum === -1) {
      if (!isLocalAddress(from)) {
        net.outOfBandPrint('server', from, 'print\nServer is full\n');
        return;
      }
      // The player at the keyboard is never shut out by bots: the last of them makes way.
      const bots = this.clients.filter((client) => client.netchan.remoteAddress.type === NA.BOT);
      if (bots.length < this.maxclients) throw new Error('server is full on local connect');
      clientNum = this.maxclients - 1;
      this.dropClient(clientNum, 'only bots on server');
    }

    const client = this.clients[clientNum];
    resetHostClient(client);
    client.netchan.setup('server', from, qport, challenge);
    client.userinfo = userinfo;

    const denied = this.game.clientConnect(clientNum, true, false);
    if (denied !== null) {
      net.outOfBandPrint('server', from, `print\n${denied}\n`);
      return;
    }

    this.userinfoChanged(clientNum);

    net.outOfBandPrint('server', from, `connectResponse ${challenge}`);

    client.state = CS.CONNECTED;
    client.lastSnapshotTime = 0;
    client.lastPacketTime = this.svsTime;
    client.lastConnectTime = this.svsTime;
    // Below anything the client can acknowledge, so its first packet brings the gamestate.
    client.gamestateMessageNum = -1;

    // The first client, or the last slot, changes what the master lists (`sv_client.c:588–598`).
    const count = this.clients.filter(({ state }) => state >= CS.CONNECTED).length;
    if (count === 1 || count === this.maxclients) this.heartbeat();
  }

  /**
   * `SV_DropClient` (`sv_client.c:636–707`).
   *
   * A client's slot becomes a zombie rather than free, so that nothing arriving late is taken for
   * a new connection. A bot has no connection for anything to arrive on, and its slot is free at
   * once.
   */
  dropClient(clientNum: number, reason: string): void {
    const client = this.clients[clientNum];
    if (client.state === CS.FREE || client.state === CS.ZOMBIE) return;

    const isBot = client.netchan.remoteAddress.type === NA.BOT;
    // A client that comes back has to ask for a challenge again.
    if (!isBot) this.challenges.clear(client.netchan.remoteAddress);

    // Both of these stop the drop dropping the client again. Winding the sequence back to what the
    // client has acknowledged leaves room in the ring for the two commands about to be sent, and a
    // gamestate number of -1 means the overflow test cannot fire a second time whatever happens.
    client.reliableSequence = client.reliableAcknowledge;
    client.gamestateMessageNum = -1;

    this.sendServerCommand(null, `print "${client.name}^7 ${reason}\n"`);

    this.game.clientDisconnect(clientNum);

    this.sendServerCommand(clientNum, `disconnect "${reason}"`);

    if (isBot) {
      this.botFreeClient(clientNum);
    } else {
      client.state = CS.ZOMBIE;
    }
    client.gentity = null;
    this.setUserinfo(clientNum, '');

    // "If this was the last client on the server, send a heartbeat to the master so it is known
    // the server is empty" (`sv_client.c:695–706`).
    if (!this.clients.some(({ state }) => state >= CS.CONNECTED)) this.heartbeat();
  }

  /**
   * `SV_SendClientGameState` (`sv_client.c:720–785`): everything a client needs before it can play.
   *
   * It is one message: the configstrings the map and the match have set, then every entity the map
   * placed, each written in full. After it the client is primed — it has the world but has not yet
   * told the host anything, and the first user command it sends is what puts it in.
   */
  sendClientGameState(client: HostClient): void {
    client.state = CS.PRIMED;
    client.gamestateMessageNum = client.netchan.outgoingSequence;

    const msg = this.outMessage;
    msg.clear();
    msg.writeLong(client.lastClientCommand);
    this.updateServerCommandsToClient(client, msg);

    msg.writeByte(SVC.GAMESTATE);
    msg.writeLong(client.reliableSequence);

    for (let index = 0; index < MAX_CONFIGSTRINGS; index++) {
      if (this.configstrings[index] === '') continue;
      msg.writeByte(SVC.CONFIGSTRING);
      msg.writeShort(index);
      msg.writeBigString(this.configstrings[index]);
    }

    const nullstate = createEntityState();
    for (let number = 0; number < MAX_GENTITIES; number++) {
      const base = this.baselines[number];
      // Quake 3 skips a baseline whose number is zero, which also skips entity zero: in practice
      // that is the world, which is never sent.
      if (base === null || base.number === 0) continue;
      msg.writeByte(SVC.BASELINE);
      writeDeltaEntity(msg, nullstate, base, true);
    }

    msg.writeByte(SVC.EOF);
    msg.writeLong(this.clients.indexOf(client));
    msg.writeLong(this.checksumFeed);

    this.sendMessageToClient(msg, client);
  }

  /**
   * `SV_ClientEnterWorld` (`sv_client.c:790–815`): the client is playing.
   *
   * This is where the slot gets a body, and where the next snapshot is made a full one — the client
   * has nothing to delta against yet. The configstrings changed since its gamestate went out come
   * first, since none is sent to a primed client (`SV_UpdateConfigstrings`, `sv_init.c:81–98`).
   */
  clientEnterWorld(clientNum: number, cmd: NetUserCmd | null): void {
    const client = this.clients[clientNum];
    client.state = CS.ACTIVE;

    for (let index = 0; index < MAX_CONFIGSTRINGS; index++) {
      if (!client.csUpdated.delete(index)) continue;
      this.sendServerCommand(clientNum, `cs ${index} "${this.configstrings[index]}"`);
    }

    const entity = this.game.entity(clientNum);
    entity.s.number = clientNum;
    client.gentity = entity;

    client.deltaMessage = NO_DELTA_MESSAGE;
    client.lastSnapshotTime = 0;

    client.lastUsercmd = cmd === null ? createNetUserCmd() : copyUserCmd(cmd);

    this.game.clientBegin(clientNum);
  }

  /**
   * `SV_ExecuteClientMessage` (`sv_client.c:1910–2023`): one message from a client, acted on.
   *
   * The three numbers at the front are what the connection runs on: which map the client thinks it
   * is playing, the last message it saw, and the last reliable command it ran. A client that is
   * still on the previous map is ignored rather than corrected, because its user commands belong to
   * a world that no longer exists.
   */
  private executeClientMessage(client: HostClient, clientNum: number, data: Uint8Array): void {
    const msg = Message.read(data);

    const serverId = msg.readLong();
    client.messageAcknowledge = msg.readLong();
    if (client.messageAcknowledge < 0) return;

    client.reliableAcknowledge = msg.readLong();
    if (
      client.reliableSequence - client.reliableAcknowledge >= MAX_RELIABLE_COMMANDS ||
      client.reliableSequence - client.reliableAcknowledge < 0
    ) {
      client.reliableAcknowledge = client.reliableSequence;
      return;
    }

    if (serverId !== this.serverId) {
      if (serverId >= this.restartedServerId && serverId < this.serverId) return;
      if (client.state !== CS.ACTIVE && client.messageAcknowledge > client.gamestateMessageNum) {
        this.sendClientGameState(client);
      }
      return;
    }

    if (client.oldServerTime !== 0) client.oldServerTime = 0;

    let command: number;
    for (;;) {
      command = msg.readByte();
      if (command !== CLC.CLIENT_COMMAND) break;
      if (!this.clientCommand(client, clientNum, msg)) return;
      if (client.state === CS.ZOMBIE) return;
    }

    if (command === CLC.MOVE) {
      this.userMove(client, clientNum, msg, true);
    } else if (command === CLC.MOVE_NO_DELTA) {
      this.userMove(client, clientNum, msg, false);
    } else if (command !== CLC.EOF) {
      this.print(`WARNING: bad command byte for client ${clientNum}`);
    }
  }

  /** One game frame, {@link frameMsec}, read where it is used, so a change takes the next frame. */
  get frameMsec(): number {
    return frameMsec(this.svFps());
  }

  /**
   * The real time not yet run as whole frames, less than one frame. The loops take it off the
   * frame's length for their wait, so a coarse timer holds the cadence (`SV_FrameMsec`).
   */
  get residualMsec(): number {
    return this.timeResidual;
  }

  /**
   * `SV_Frame` (`sv_main.c:1055–1165`): the game runs in frames of {@link frameMsec} however
   * often this is called, and each client is sent a snapshot at its own rate, which `sv_fps` caps
   * ({@link sendClientMessages}).
   */
  runFrame(msec: number): void {
    this.frameCount++;

    // `SV_SendQueuedPackets` (`sv_main.c:1226`), which `Com_Frame` runs while the server waits:
    // what a client's rate did not let go with the message it belonged to goes now.
    this.sendQueuedMessages();

    // Quake 3 runs the command buffer in `Com_Frame` just before the server's own frame, so
    // whatever the game module asked for last frame is what happens at the start of this one.
    this.executeCommands();

    // A map being loaded stops the server where it stands, as Q3's blocking load does.
    if (this.state !== SS.GAME || this.loading !== null) return;

    // `SV_CheckPaused` (`sv_main.c:1077–1080`): a paused frame runs nothing — no serverinfo or
    // systeminfo refresh, no bots, no pings, no simulation, no timeouts, no snapshots. The queued
    // fragments still went, as `Com_Frame` sends them while the server waits.
    if (this.checkPaused()) return;

    const frameMsec = this.frameMsec;

    this.updateServerinfo();
    this.updateSysteminfo();

    this.timeResidual += msec;

    // `SV_BotFrame` (`sv_bot.c:434–439`): the bots' commands, at the time the frames below are to
    // reach, so that the frames run them.
    this.game.botAIStartFrame(this.time + this.timeResidual);

    // A restart was asked for with a delay and its time has come. Nothing else happens this frame:
    // the command goes in the queue, and the frame after this is what runs it.
    if (this.restartTime && this.time >= this.restartTime) {
      this.restartTime = 0;
      this.sendConsoleCommand('map_restart 0\n');
      return;
    }

    this.calcPings();

    while (this.timeResidual >= frameMsec) {
      this.timeResidual -= frameMsec;
      this.svsTime += frameMsec;
      this.time += frameMsec;
      this.game.runFrame(this.time);
    }

    this.checkTimeouts();

    this.sendClientMessages();

    this.masterHeartbeat();
  }

  /**
   * `SV_CheckPaused` (`sv_main.c:990–1022`): whether this frame is paused — `cl_paused` set with
   * at most one human connected, which is the single-player arrangement. `sv_paused` says so for
   * the client's own gates; a second human clears it and the frame runs. Q3's early return leaves
   * `sv_paused` standing when the pause ends, which nothing reads.
   */
  private checkPaused(): boolean {
    if (this.cvarInt('cl_paused') === 0) return false;
    let count = 0;
    for (const client of this.clients) {
      if (client.state >= CS.CONNECTED && client.netchan.remoteAddress.type !== NA.BOT) count++;
    }
    if (count > 1) {
      if (this.cvarInt('sv_paused') !== 0) this.cvars.set('sv_paused', '0');
      return false;
    }
    if (this.cvarInt('sv_paused') === 0) this.cvars.set('sv_paused', '1');
    return true;
  }

  /**
   * `SV_CalcPings` (`sv_main.c:894–939`): each client's ping, the mean round trip of the messages
   * it has acknowledged of the last 32, which the game module is told as `ps.ping`.
   *
   * A message is stamped each time a packet acknowledges it, so it is the last acknowledgement that
   * counts, and a client that sends faster than it is sent to reads higher than its wire.
   */
  private calcPings(): void {
    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state !== CS.ACTIVE || client.gentity === null) {
        client.ping = 999;
        continue;
      }
      if ((client.gentity.r.svFlags & SVF.BOT) !== 0) {
        client.ping = 0;
        continue;
      }

      let total = 0;
      let count = 0;
      for (const frame of client.frames) {
        if (frame.messageAcked <= 0) continue;
        total += frame.messageAcked - frame.messageSent;
        count++;
      }
      client.ping = count === 0 ? 999 : Math.min(Math.trunc(total / count), 999);

      this.game.playerState(clientNum).ping = client.ping;
    }
  }

  /**
   * `SV_CheckTimeouts` (`sv_main.c:954–987`): a client silent for `sv_timeout` seconds is dropped,
   * and a zombie's slot is freed `sv_zombietime` seconds after its last packet.
   *
   * It runs on `svs.time`, which stands still while the host does, so a host that stalls drops
   * nobody for it. A client must also be past its time for six frames running before it goes.
   */
  private checkTimeouts(): void {
    const droppoint = this.svsTime - 1000 * this.cvarInt('sv_timeout');
    const zombiepoint = this.svsTime - 1000 * this.cvarInt('sv_zombietime');

    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state === CS.ZOMBIE && client.lastPacketTime < zombiepoint) {
        client.state = CS.FREE;
        continue;
      }
      if (client.state >= CS.CONNECTED && client.lastPacketTime < droppoint) {
        if (++client.timeoutCount > 5) {
          this.dropClient(clientNum, 'timed out');
          // Nobody is listening for the drop, so the slot needs no zombie's wait.
          client.state = CS.FREE;
        }
      } else {
        client.timeoutCount = 0;
      }
    }
  }

  /**
   * `SV_SendClientMessages` (`sv_snapshot.c:640–690`): who gets a snapshot this time round.
   *
   * A client asks for snapshots at a rate of its own, and it is not given them faster. A snapshot
   * is also held back — and the flags say so — while a part-sent or queued message is still on its
   * way, or while a remote client's `rate` would not carry it. A loopback client, and a LAN one
   * under `sv_lanForceRate`, skip the rate check, as Q3's do.
   */
  sendClientMessages(): void {
    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      // A client that has just connected is not sent the periodic snapshot. Quake 3 sends it a
      // not-active one, but this client cannot decode it before its gamestate, and a worker's
      // loopback holds only sixteen: a page busy at its boot drops the oldest, the
      // `connectResponse` among them, and the client's `connect` is then retransmitted into a
      // `loopback:reconnect`. The zombie is kept: its final disconnect rides a snapshot out.
      if (client.state === CS.FREE || client.state === CS.CONNECTED) continue;
      if (this.svsTime - client.lastSnapshotTime < client.snapshotMsec) continue;

      if (client.netchan.unsentFragments || client.queuedMessages.length > 0) {
        client.rateDelayed = true;
        continue;
      }

      const adr = client.netchan.remoteAddress;
      const lan =
        isLocalAddress(adr) || (this.cvarInt('sv_lanForceRate') !== 0 && isLANAddress(adr));
      if (!lan && this.rateMsec(client) > 0) {
        client.rateDelayed = true;
        continue;
      }

      this.sendClientSnapshot(client, clientNum);
      client.lastSnapshotTime = this.svsTime;
      client.rateDelayed = false;
    }
  }

  /**
   * `SV_SendQueuedMessages` (`sv_client.c:1146–1168`), which `Com_Frame` reaches through
   * `SV_SendQueuedPackets` (`sv_main.c:1226–1293`) while the server waits: one round of fragments
   * and queued messages, each client's only when its rate allows one. The port runs it with the
   * server's frame, since its frame is the wait.
   */
  sendQueuedMessages(): void {
    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state === CS.FREE) continue;
      if (this.rateMsec(client) !== 0) continue;
      this.transmitNextQueued(client);
    }
  }

  /**
   * `SV_Netchan_TransmitNextFragment` (`sv_net_chan.c:196–210`): the next fragment of a part-sent
   * message, or the next whole message waiting behind it.
   */
  private transmitNextQueued(client: HostClient): void {
    if (client.netchan.unsentFragments) {
      client.netchan.transmitNextFragment();
      return;
    }
    const next = client.queuedMessages.shift();
    if (next !== undefined) client.netchan.transmit(next);
  }

  /**
   * `SV_RateMsec` (`sv_main.c:1178–1214`): the msec until another message may go to this client,
   * or 0 when one may go now. The rate is its own, held between `sv_minRate` and `sv_maxRate`
   * where those say so, and the message is taken as the last one plus a UDP/IP header.
   */
  private rateMsec(client: HostClient): number {
    let rate = client.rate;
    let maxRate = this.cvarInt('sv_maxRate');
    if (maxRate !== 0) {
      if (maxRate < 1000) {
        this.cvars.set('sv_maxRate', '1000');
        maxRate = 1000;
      }
      if (maxRate < rate) rate = maxRate;
    }
    let minRate = this.cvarInt('sv_minRate');
    if (minRate !== 0) {
      if (minRate < 1000) {
        this.cvars.set('sv_minRate', '1000');
        minRate = 1000;
      }
      if (minRate > rate) rate = minRate;
    }

    const messageSize = client.netchan.lastSentSize + UDPIP_HEADER_SIZE;
    const rateMsec = Math.trunc((messageSize * 1000) / rate);
    const elapsed = this.net.now() - client.netchan.lastSentTime;
    return elapsed > rateMsec ? 0 : rateMsec - elapsed;
  }

  /** `SV_SendClientSnapshot` (`sv_snapshot.c:597–635`): build one snapshot and send it. */
  sendClientSnapshot(client: HostClient, clientNum: number): void {
    this.buildClientSnapshot(client, clientNum);

    // A bot's snapshot is built but never sent: the bot reads it where it stands.
    if (client.gentity !== null && (client.gentity.r.svFlags & SVF.BOT) !== 0) return;

    const msg = this.outMessage;
    msg.clear();
    msg.writeLong(client.lastClientCommand);
    this.updateServerCommandsToClient(client, msg);
    this.writeSnapshotToClient(client, msg);
    this.sendMessageToClient(msg, client);
  }

  /**
   * `SV_SendServerCommand` (`sv_main.c:250–300`): a reliable command to one client, or to all.
   *
   * Reliable means held until acknowledged: every message to a client carries the commands it has
   * not confirmed yet, so one is delivered however many packets are lost.
   */
  sendServerCommand(clientNum: number | null, text: string): void {
    if (clientNum === null) {
      for (let i = 0; i < this.maxclients; i++) {
        if (this.clients[i].state < CS.PRIMED) continue;
        this.sendServerCommand(i, text);
      }
      return;
    }

    const client = this.clients[clientNum];
    client.reliableSequence++;

    // Quake 3 drops a client whose unacknowledged commands have overflowed the ring, because the
    // one about to be overwritten can never now be delivered.
    if (client.reliableSequence - client.reliableAcknowledge > MAX_RELIABLE_COMMANDS) {
      this.dropClient(clientNum, 'Server command overflow');
      return;
    }

    client.reliableCommands[client.reliableSequence & (MAX_RELIABLE_COMMANDS - 1)] = text;
  }

  /**
   * `trap_SendConsoleCommand` (`g_syscalls.c`), which is `Cbuf_AddText` on the host's side: the
   * game module asking for something only the host can do.
   *
   * It is asked for a restart and for the next map, and never for anything at once: a command
   * waits in the queue until {@link executeCommands} reaches it, because the game module is in the
   * middle of a frame and the host is about to take its world away.
   */
  sendConsoleCommand(text: string): void {
    this.commandQueue.push(...commandLines(text).filter((line) => line.trim() !== ''));
  }

  /** Whether commands are waiting for the top of the next frame. */
  get commandsPending(): boolean {
    return this.commandQueue.length > 0;
  }

  /**
   * `SV_SetConfigstring` (`sv_init.c:106–146`): a shared string every active client is told, and a
   * primed one is told as it enters the world.
   */
  setConfigstring(index: number, value: string): void {
    if (index < 0 || index >= MAX_CONFIGSTRINGS) {
      throw new Error(`host: bad configstring index ${index}`);
    }
    if (this.configstrings[index] === value) return;
    this.configstrings[index] = value;

    // A map being loaded sends nothing, because the gamestate the clients are about to be given
    // carries every configstring anyway. A `map_restart` sends them, because there is no gamestate
    // coming: the clients keep the one they have and are told what changed.
    if (this.state !== SS.GAME && !this.restarting) return;
    for (let clientNum = 0; clientNum < this.maxclients; clientNum++) {
      const client = this.clients[clientNum];
      if (client.state < CS.ACTIVE) {
        if (client.state === CS.PRIMED) client.csUpdated.add(index);
        continue;
      }
      this.sendServerCommand(clientNum, `cs ${index} "${value}"`);
    }
  }

  getConfigstring(index: number): string {
    if (index < 0 || index >= MAX_CONFIGSTRINGS) {
      throw new Error(`host: bad configstring index ${index}`);
    }
    return this.configstrings[index];
  }

  /** `trap_Milliseconds`: `Sys_Milliseconds`, the clock the net reads, in whole milliseconds. */
  milliseconds(): number {
    return Math.floor(this.net.now());
  }

  /** `trap_GetUsercmd` (`g_syscalls.c`): the command the game module is about to run. */
  getUserCmd(clientNum: number): NetUserCmd {
    return this.clients[clientNum].lastUsercmd;
  }

  /** `trap_GetUserinfo`. */
  getUserinfo(clientNum: number): string {
    return this.clients[clientNum].userinfo;
  }

  /**
   * `trap_SetUserinfo`, which is `SV_SetUserinfo` (`sv_init.c:176–187`): the name is kept beside
   * it, for the host's own messages.
   */
  setUserinfo(clientNum: number, userinfo: string): void {
    const client = this.clients[clientNum];
    client.userinfo = userinfo;
    client.name = infoValueForKey(userinfo, 'name');
  }

  /**
   * `trap_BotAllocateClient`, which is `SV_BotAllocateClient` (`sv_bot.c:47–70`): the first free
   * slot, straight to active, since a bot has no gamestate to be sent.
   *
   * The slot is cleared first, as a connection's is. Q3 leaves a bot the slot as its last client
   * left it.
   *
   * @returns the slot, or −1 if every one is taken
   */
  botAllocateClient(): number {
    const clientNum = this.clients.findIndex((client) => client.state === CS.FREE);
    if (clientNum === -1) return -1;

    const client = this.clients[clientNum];
    resetHostClient(client);
    const entity = this.game.entity(clientNum);
    entity.s.number = clientNum;
    client.gentity = entity;
    client.state = CS.ACTIVE;
    client.lastPacketTime = this.svsTime;
    client.netchan.remoteAddress = netadr(NA.BOT);
    client.rate = 16384;
    return clientNum;
  }

  /** `trap_BotFreeClient`, which is `SV_BotFreeClient` (`sv_bot.c:77–89`). */
  botFreeClient(clientNum: number): void {
    const client = this.clients[clientNum];
    client.state = CS.FREE;
    client.name = '';
    if (client.gentity) client.gentity.r.svFlags &= ~SVF.BOT;
  }

  /** `trap_BotUserCommand` (`sv_game.c:467–474`): a bot's command, through `SV_ClientThink`. */
  botUserCommand(clientNum: number, cmd: NetUserCmd): void {
    this.clientThink(this.clients[clientNum], clientNum, cmd);
  }

  /**
   * `trap_BotGetServerCommand`, which is `SV_BotGetConsoleMessage` (`sv_bot.c:574–595`): the next
   * command, acknowledged by being read.
   *
   * Asking is what keeps a bot from timing out, since it sends no packets. A bot the game has
   * stopped reading for, under `bot_pause`, times out as a silent client would.
   */
  botGetServerCommand(clientNum: number): string | null {
    const client = this.clients[clientNum];
    client.lastPacketTime = this.svsTime;
    if (client.reliableAcknowledge === client.reliableSequence) return null;
    client.reliableAcknowledge++;
    const command =
      client.reliableCommands[client.reliableAcknowledge & (MAX_RELIABLE_COMMANDS - 1)];
    return command === '' ? null : command;
  }

  /** `SV_Trace`: see {@link ServerWorld.trace}. */
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

  /** `SV_PointContents`: see {@link ServerWorld.pointContents}. */
  pointContents(point: Vec3, passEntityNum: number): number {
    return this.world.pointContents(point, passEntityNum);
  }

  /**
   * `SV_SetBrushModel` (`sv_game.c:111–135`): an entity made the map's inline model `*N`, from the
   * server's own collision. A splat map has none, so any `*N` is a model it has not got.
   */
  setBrushModel(entity: GameEntity, name: string | null): void {
    setBrushModel(this.map.clipMap, entity, name, (linked) => this.linkEntity(linked));
  }

  /** `SV_EntityContact` (`sv_game.c:217–231`): whether a box is in an entity's clip handle. */
  entityContact(mins: Vec3, maxs: Vec3, entity: GameEntity): boolean {
    return entityContact(this.map.clipMap, entity, mins, maxs);
  }

  /** `SV_LinkEntity`: see {@link ServerWorld.link}. */
  linkEntity(entity: GameEntity): void {
    this.world.link(entity);
  }

  /** `SV_UnlinkEntity`: see {@link ServerWorld.unlink}. */
  unlinkEntity(entity: GameEntity): void {
    this.world.unlink(entity);
  }

  /** `SV_GentityNum` (`sv_game.c:40-46`): the game's entity by number. */
  gentityNum(number: number): GameEntity {
    return this.game.entity(number);
  }

  /** `trap_EntitiesInBox`, which is `SV_AreaEntities`: see {@link ServerWorld.areaEntities}. */
  entitiesInBox(mins: Vec3, maxs: Vec3): number[] {
    return this.world.areaEntities(mins, maxs);
  }

  /** `SV_AdjustAreaPortalState`: see {@link ServerWorld.adjustAreaPortalState}. */
  adjustAreaPortalState(entity: GameEntity, open: boolean): void {
    this.world.adjustAreaPortalState(entity, open);
  }

  /** `SV_inPVS`: see {@link ServerWorld.inPVS}. */
  inPVS(p1: Vec3, p2: Vec3): boolean {
    return this.world.inPVS(p1, p2);
  }

  /**
   * `trap_GetEntityToken` (`sv_game.c:408–419`): the next token of the map's entity text, or null
   * once it has run out.
   */
  getEntityToken(): string | null {
    return this.entityParsePoint();
  }

  /** `trap_Print`: a line for the console. */
  print(text: string): void {
    this.printLine(text);
  }

  /**
   * `SV_UserinfoChanged` (`sv_client.c:1403–1495`), for the fields the port reads: the host's own
   * view of a userinfo, which the game module is told of separately.
   */
  private userinfoChanged(clientNum: number): void {
    const client = this.clients[clientNum];
    client.name = infoValueForKey(client.userinfo, 'name');

    // `rate`: a client on the server's own network is not choked, whatever it asked for, unless the
    // server is a public one on the Internet (`com_dedicated != 2`).
    const rate = infoValueForKey(client.userinfo, 'rate');
    if (
      isLANAddress(client.netchan.remoteAddress) &&
      this.cvarInt('dedicated') !== 2 &&
      this.cvarInt('sv_lanForceRate') === 1
    ) {
      client.rate = 99999;
    } else if (rate !== '') {
      client.rate = Math.min(Math.max(atoi(rate), 1000), 90000);
    } else {
      client.rate = 3000;
    }

    const msec = snapshotMsec(infoValueForKey(client.userinfo, 'snaps'), this.svFps());
    if (msec !== client.snapshotMsec) {
      // Reset the last send so the new rate starts from now rather than from the old cadence.
      client.lastSnapshotTime = 0;
      client.snapshotMsec = msec;
    }

    // The address goes back in whatever the client sent, since a password and a ban are checked
    // by it.
    const adr = client.netchan.remoteAddress;
    const ip = isLocalAddress(adr) ? 'localhost' : adrToString(adr);
    const old = infoValueForKey(client.userinfo, 'ip');
    const length =
      old !== ''
        ? ip.length - old.length + client.userinfo.length
        : ip.length + 4 + client.userinfo.length;
    if (length >= MAX_INFO_STRING) {
      this.dropClient(clientNum, 'userinfo string length exceeded');
    } else {
      client.userinfo = infoSetValueForKey(client.userinfo, 'ip', ip);
    }
  }

  /**
   * `SV_ClientCommand` (`sv_client.c:1604–1652`).
   *
   * Under `sv_floodProtect`, a dedicated server passes the game module one command a second from a
   * playing client, and ignores the rest, though the host's own are still run. Every command pushes
   * the second back, so a client that keeps sending has nothing more run until it stops for one.
   */
  private clientCommand(client: HostClient, clientNum: number, msg: Message): boolean {
    const sequence = msg.readLong();
    const text = msg.readString();

    // Already run, which is normal: a client resends a command until it is acknowledged.
    if (client.lastClientCommand >= sequence) return true;

    // A gap means a command was lost for good, and the connection cannot be repaired.
    if (sequence > client.lastClientCommand + 1) {
      this.print(
        `Client ${client.name} lost ${sequence - client.lastClientCommand + 1} clientCommands`
      );
      this.dropClient(clientNum, 'Lost reliable commands');
      return false;
    }

    const flooding =
      this.dedicated &&
      client.state >= CS.ACTIVE &&
      this.cvarInt('sv_floodProtect') !== 0 &&
      this.svsTime < client.nextReliableTime;
    client.nextReliableTime = this.svsTime + 1000;

    this.executeClientCommand(client, clientNum, text, !flooding);

    client.lastClientCommand = sequence;
    client.lastClientCommandString = text;
    return true;
  }

  /**
   * `SV_ExecuteClientCommand` (`sv_client.c:1573–1597`): the handful of commands the server answers
   * itself (`ucmds`), then the game module's, which only a client with a gamestate may send.
   *
   * @param clientOk - False for a command flood protection holds back from the game module.
   */
  private executeClientCommand(
    client: HostClient,
    clientNum: number,
    text: string,
    clientOk: boolean
  ): void {
    const argv = tokenize(text);
    switch (argv[0]) {
      case 'userinfo':
        // `SV_UpdateUserinfo_f`: the whole of how a client's own settings — its name, its model
        // and its handicap — reach the match.
        client.userinfo = (argv[1] ?? '').slice(0, MAX_INFO_STRING - 1);
        this.userinfoChanged(clientNum);
        this.game.clientUserinfoChanged(clientNum);
        return;
      case 'disconnect':
        // `SV_Disconnect_f`.
        this.dropClient(clientNum, 'disconnected');
        return;
    }

    if (!clientOk) return;
    if (this.state === SS.GAME && (client.state === CS.ACTIVE || client.state === CS.PRIMED)) {
      this.game.clientCommand(clientNum, text);
    }
  }

  /**
   * `SV_UserMove` (`sv_client.c:1687–1790`): the user commands in one message.
   *
   * A message carries the commands from the last few packets, so a lost one costs nothing: the
   * commands in it arrive again in the next. That is why they are filtered by time rather than
   * counted — anything already run, or from before a restart, is dropped here.
   */
  private userMove(client: HostClient, clientNum: number, msg: Message, delta: boolean): void {
    client.deltaMessage = delta ? client.messageAcknowledge : NO_DELTA_MESSAGE;

    const count = msg.readByte();
    if (count < 1 || count > MAX_PACKET_USERCMDS) return;

    // The key is what stops a command lifted off one connection being replayed on another: it is
    // built from things only these two ends know.
    let key = this.checksumFeed;
    key ^= client.messageAcknowledge;
    key ^= hashKey(
      client.reliableCommands[client.reliableAcknowledge & (MAX_RELIABLE_COMMANDS - 1)],
      32
    );

    const cmds: NetUserCmd[] = [];
    let oldcmd = createNetUserCmd();
    for (let i = 0; i < count; i++) {
      const cmd = readDeltaUserCmdKey(msg, key, oldcmd, createNetUserCmd());
      cmds.push(cmd);
      oldcmd = cmd;
    }

    client.frames[client.messageAcknowledge & PACKET_MASK].messageAcked = this.svsTime;

    if (client.state === CS.PRIMED) {
      this.clientEnterWorld(clientNum, cmds[0]);
    }

    if (client.state !== CS.ACTIVE) {
      client.deltaMessage = NO_DELTA_MESSAGE;
      return;
    }

    for (const cmd of cmds) {
      // From before a map restart: its time is ahead of the newest command in the same message.
      if (cmd.serverTime > cmds[count - 1].serverTime) continue;
      // Already run. A client repeats commands deliberately, so most of these are duplicates.
      if (cmd.serverTime <= client.lastUsercmd.serverTime) continue;
      this.clientThink(client, clientNum, cmd);
    }
  }

  /** `SV_ClientThink` (`sv_client.c:1665–1676`). */
  private clientThink(client: HostClient, clientNum: number, cmd: NetUserCmd): void {
    client.lastUsercmd = copyUserCmd(cmd);
    if (client.state !== CS.ACTIVE) return;
    this.game.clientThink(clientNum);
  }

  /** `SV_UpdateServerCommandsToClient` (`sv_snapshot.c:210–225`). */
  private updateServerCommandsToClient(client: HostClient, msg: Message): void {
    for (let i = client.reliableAcknowledge + 1; i <= client.reliableSequence; i++) {
      msg.writeByte(SVC.SERVER_COMMAND);
      msg.writeLong(i);
      // Big: a `cs` for the systeminfo carries every rule cvar and outgrows an ordinary string
      // (`sv_init.c:68` writes the value into the command).
      msg.writeBigString(client.reliableCommands[i & (MAX_RELIABLE_COMMANDS - 1)]);
    }
    client.reliableSent = client.reliableSequence;
  }

  /**
   * `SV_WriteSnapshotToClient` (`sv_snapshot.c:115–200`): pick what to delta against, then write.
   *
   * Three things rule out the frame a client asked for — it asked for none, it has been silent
   * long enough that the frame is nearly out of the ring, or its entities have already gone from
   * the shared ring. Any of them means a full snapshot instead, which is larger but always
   * readable.
   */
  private writeSnapshotToClient(client: HostClient, msg: Message): void {
    const frame = client.frames[client.netchan.outgoingSequence & PACKET_MASK];

    let oldFrame: ServerSnapshot | null = null;
    let lastFrame = 0;

    if (client.deltaMessage <= 0 || client.state !== CS.ACTIVE) {
      // The client asked for a full snapshot.
    } else if (client.netchan.outgoingSequence - client.deltaMessage >= PACKET_BACKUP - 3) {
      // Nothing has got through for a long time.
    } else {
      const candidate = client.frames[client.deltaMessage & PACKET_MASK];
      if (candidate.firstEntity <= this.nextSnapshotEntities - this.numSnapshotEntities) {
        // Its entities have rolled out of the ring.
      } else {
        oldFrame = candidate;
        lastFrame = client.netchan.outgoingSequence - client.deltaMessage;
      }
    }

    let snapFlags = this.snapFlagServerBit;
    if (client.rateDelayed) snapFlags |= SNAPFLAG.RATE_DELAYED;
    if (client.state !== CS.ACTIVE) snapFlags |= SNAPFLAG.NOT_ACTIVE;

    writeSnapshot(msg, {
      // A client that has not acknowledged a restart is told the time it still thinks it is, since
      // correcting it while it is loading would only make it hang.
      serverTime: client.oldServerTime !== 0 ? this.time + client.oldServerTime : this.time,
      lastFrame,
      snapFlags,
      frame,
      oldFrame,
      entities: this.entityRing,
      baseline: (number) => this.baseline(number)
    });
  }

  /**
   * `SV_BuildClientSnapshot` (`sv_snapshot.c:442–521`): decide what one client is told, and copy
   * out the states of the entities it is sent.
   *
   * A zombie's snapshot carries its disconnect out with every area bit clear and no entity, and
   * `areabytes` left as its frame had it, as Q3 leaves it.
   */
  private buildClientSnapshot(client: HostClient, clientNum: number): void {
    const frame = client.frames[client.netchan.outgoingSequence & PACKET_MASK];
    frame.numEntities = 0;

    if (client.gentity === null || client.state === CS.ZOMBIE) {
      frame.areabits.fill(0);
      return;
    }

    copyPlayerState(this.game.playerState(clientNum), frame.ps);

    const numbers = this.snapshotNumbers;
    frame.areabytes = this.visibleEntities(frame.ps, numbers, frame.areabits);

    frame.firstEntity = this.nextSnapshotEntities;
    for (const number of numbers) {
      const entity = this.game.entity(number);
      copyEntityState(entity.s, this.entityRing.at(this.nextSnapshotEntities));
      this.nextSnapshotEntities++;
      frame.numEntities++;
    }
  }

  /**
   * `SV_BuildClientSnapshot`'s choice (`sv_snapshot.c:454–505`): the entities a player is sent,
   * and the areas it is not shown, as seen from its eye.
   *
   * Its own entity is never sent, as everything about it is in the player state already. The rest
   * are sorted, which the delta needs, since it walks two snapshots' lists in step. The bits of the
   * areas seen, from the eye and through every portal, are inverted into a mask of those hidden.
   * A world with no clip map sends no mask.
   *
   * @param ps - The player's state, whose eye at `origin` plus `viewheight`, in floats, it is.
   * @param numbers - Given the entities' numbers, in increasing order.
   * @param areabits - Given the mask, all {@link MAX_MAP_AREA_BYTES} of it.
   * @returns `areabytes`, how much of the mask the client is sent.
   * @throws in Q3's words for a player state of no entity's number
   */
  visibleEntities(ps: PlayerState, numbers: number[], areabits: Uint8Array): number {
    // "Bump the counter used to prevent double adding."
    this.snapshotCounter++;
    numbers.length = 0;
    areabits.fill(0);

    const own = ps.clientNum;
    if (own < 0 || own >= MAX_GENTITIES) throw new Error('SV_SvEntityForGentity: bad gEnt');
    this.entityCounters[own] = this.snapshotCounter;

    const eye = this.eye;
    eye.x = f(ps.origin.x);
    eye.y = f(ps.origin.y);
    eye.z = f(f(ps.origin.z) + ps.viewheight);

    const areabytes = this.addEntitiesVisibleFromPoint(eye, ps.clientNum, numbers, areabits);
    numbers.sort((a, b) => a - b);

    if (this.map.clipMap) {
      for (let i = 0; i < MAX_MAP_AREA_BYTES; i++) areabits[i] ^= 0xff;
    }
    return areabytes;
  }

  /**
   * `SV_AddEntitiesVisibleFromPoint` (`sv_snapshot.c:292–427`): every entity seen from `origin`,
   * by an ordered test, in Quake 3's order, with the bits of the areas seen from it OR'd in.
   *
   * An entity is dropped for not being in the world, then for the flags that say who may know of
   * it, then for being in no area the point's portals join, where a door's second area counts too,
   * and in no cluster its row sees. A broadcast is sent past the areas and clusters.
   *
   * An entity whose leaves held more clusters than it kept is tested again by a scan of the row
   * from its last kept cluster to `lastCluster`, and dropped only when the first cluster seen is
   * `lastCluster` itself, so it is sent from nearly anywhere.
   *
   * A portal entity that passes adds everything seen from its camera at `origin2`, unless it has a
   * range and the point is beyond it, and does so past the cap too, where nothing more is sent but
   * the camera's areas are still shown. A world with no clip map is one area and one cluster, and
   * writes no bits.
   *
   * Quake 3's own version takes a `portal` argument it never reads.
   *
   * @param origin - In floats.
   * @returns `areabytes`, from `CM_WriteAreaBits`.
   */
  private addEntitiesVisibleFromPoint(
    origin: Vec3,
    clientNum: number,
    numbers: number[],
    areabits: Uint8Array
  ): number {
    // "During an error shutdown message we may need to transmit the shutdown message after the
    // server has shutdown."
    if (this.state === SS.DEAD) return 0;

    const cm = this.map.clipMap;
    const world = this.world;
    let areabytes = 0;
    let clientarea = 0;
    let row = 0;
    if (cm) {
      const point = this.viewpoint;
      point[0] = origin.x;
      point[1] = origin.y;
      point[2] = origin.z;
      const leafnum = pointLeafnum(cm, point);
      clientarea = leafArea(cm, leafnum);
      // "Calculate the visible areas."
      areabytes = writeAreaBits(cm, areabits, clientarea);
      row = clusterPVS(cm, leafCluster(cm, leafnum));
    }

    for (let e = 0; e < this.game.numEntities(); e++) {
      const entity = this.game.entity(e);

      if (!entity.r.linked) continue;

      // Quake 3 repairs a mismatch rather than trusting it, and prints when it does.
      if (entity.s.number !== e) entity.s.number = e;

      if ((entity.r.svFlags & SVF.NOCLIENT) !== 0) continue;

      if ((entity.r.svFlags & SVF.SINGLECLIENT) !== 0) {
        if (entity.r.singleClient !== clientNum) continue;
      }
      if ((entity.r.svFlags & SVF.NOTSINGLECLIENT) !== 0) {
        if (entity.r.singleClient === clientNum) continue;
      }
      if ((entity.r.svFlags & SVF.CLIENTMASK) !== 0) {
        if (clientNum >= 32) throw new Error('SVF_CLIENTMASK: clientNum >= 32');
        if ((~entity.r.singleClient & (1 << clientNum)) !== 0) continue;
      }

      // "Don't double add an entity through portals."
      if (this.entityCounters[e] === this.snapshotCounter) continue;

      if ((entity.r.svFlags & SVF.BROADCAST) !== 0) {
        this.addEntToSnapshot(e, numbers);
        continue;
      }

      if (cm) {
        if (
          !areasConnected(cm, clientarea, world.areanum[e]) &&
          !areasConnected(cm, clientarea, world.areanum2[e])
        ) {
          continue; // "blocked by a door"
        }

        const count = world.numClusters[e];
        if (!count) continue;
        const vis = cm.visibility;
        const first = e * MAX_ENT_CLUSTERS;
        let l = 0;
        let i = 0;
        for (; i < count; i++) {
          l = world.clusternums[first + i];
          if (vis[row + (l >> 3)] & (1 << (l & 7))) break;
        }

        if (i === count) {
          const last = world.lastCluster[e];
          if (!last) continue;
          for (; l <= last; l++) {
            if (vis[row + (l >> 3)] & (1 << (l & 7))) break;
          }
          if (l === last) continue; // "not visible"
        }
      }

      this.addEntToSnapshot(e, numbers);

      if ((entity.r.svFlags & SVF.PORTAL) !== 0) {
        const range = entity.s.generic1;
        if (range !== 0) {
          const { origin: at } = entity.s;
          const x = f(f(at.x) - origin.x);
          const y = f(f(at.y) - origin.y);
          const z = f(f(at.z) - origin.z);
          if (f(f(f(x * x) + f(y * y)) + f(z * z)) > f(range * range)) continue;
        }
        const camera = entity.s.origin2;
        const view = vec3(f(camera.x), f(camera.y), f(camera.z));
        areabytes = this.addEntitiesVisibleFromPoint(view, clientNum, numbers, areabits);
      }
    }
    return areabytes;
  }

  /** `SV_AddEntToSnapshot` (`sv_snapshot.c:270–285`). */
  private addEntToSnapshot(number: number, numbers: number[]): void {
    if (this.entityCounters[number] === this.snapshotCounter) return;
    this.entityCounters[number] = this.snapshotCounter;

    // Quake 3 discards silently past this point rather than truncating the snapshot.
    if (numbers.length === MAX_SNAPSHOT_ENTITIES) return;

    numbers.push(number);
  }

  /**
   * `SV_SendMessageToClient` (`sv_snapshot.c:577`): a message to a client, noted in the frame it
   * goes out as, then `SV_Netchan_Transmit` (`sv_net_chan.c:224–255`), which ends it with
   * `svc_EOF`.
   *
   * A message that arrives while the client's channel still has one part sent is queued whole and
   * goes out when that one has finished, as Q3's `netchan_start_queue` holds it.
   */
  private sendMessageToClient(msg: Message, client: HostClient): void {
    const frame = client.frames[client.netchan.outgoingSequence & PACKET_MASK];
    frame.messageSize = msg.curSize;
    frame.messageSent = this.svsTime;
    frame.messageAcked = -1;

    msg.writeByte(SVC.EOF);
    if (client.netchan.unsentFragments || client.queuedMessages.length > 0) {
      // `MSG_Copy`: the message is kept whole, since the channel's own buffer is busy.
      client.queuedMessages.push(msg.written.slice());
      return;
    }
    client.netchan.transmit(msg.written);
  }

  private readonly entityRing: SnapshotEntityRing = {
    at: (index: number): EntityState => {
      const slot = index % this.numSnapshotEntities;
      const state = this.snapshotEntities[slot];
      if (state !== null) return state;
      const created = createEntityState();
      this.snapshotEntities[slot] = created;
      return created;
    }
  };
}

function createHostClient(net: Net): HostClient {
  return {
    state: CS.FREE,
    userinfo: '',
    name: '',
    netchan: new Netchan(net),
    queuedMessages: [],
    gentity: null,
    reliableCommands: new Array<string>(MAX_RELIABLE_COMMANDS).fill(''),
    reliableSequence: 0,
    reliableAcknowledge: 0,
    reliableSent: 0,
    messageAcknowledge: 0,
    gamestateMessageNum: 0,
    csUpdated: new Set(),
    deltaMessage: NO_DELTA_MESSAGE,
    lastUsercmd: createNetUserCmd(),
    lastClientCommand: 0,
    lastClientCommandString: '',
    nextReliableTime: 0,
    lastPacketTime: 0,
    timeoutCount: 0,
    lastSnapshotTime: 0,
    snapshotMsec: 50,
    rate: 3000,
    rateDelayed: false,
    frames: Array.from({ length: PACKET_BACKUP }, () => createServerSnapshot()),
    oldServerTime: 0,
    lastConnectTime: 0,
    ping: 0
  };
}

function resetHostClient(client: HostClient): void {
  client.state = CS.FREE;
  client.userinfo = '';
  client.name = '';
  client.netchan.setup('server', netadr(NA.BAD), 0, 0);
  client.queuedMessages.length = 0;
  client.gentity = null;
  client.reliableCommands.fill('');
  client.reliableSequence = 0;
  client.reliableAcknowledge = 0;
  client.reliableSent = 0;
  client.messageAcknowledge = 0;
  client.gamestateMessageNum = 0;
  client.csUpdated.clear();
  client.deltaMessage = NO_DELTA_MESSAGE;
  client.lastUsercmd = createNetUserCmd();
  client.lastClientCommand = 0;
  client.lastClientCommandString = '';
  client.nextReliableTime = 0;
  client.lastPacketTime = 0;
  client.timeoutCount = 0;
  client.lastSnapshotTime = 0;
  client.snapshotMsec = 50;
  client.rate = 3000;
  client.rateDelayed = false;
  // So the slot's last client's round trips are not counted in this one's ping.
  for (const frame of client.frames) {
    frame.messageSent = 0;
    frame.messageAcked = 0;
    frame.messageSize = 0;
  }
  client.oldServerTime = 0;
  client.lastConnectTime = 0;
  client.ping = 0;
}

/**
 * `SV_DirectConnect`'s test for a client it has already (`sv_client.c:378–379`): the same host, and
 * the same qport or the same port.
 */
function isSameClient(client: HostClient, from: NetAdr, qport: number): boolean {
  const { netchan } = client;
  return (
    compareBaseAdr(from, netchan.remoteAddress) &&
    (netchan.qport === qport || from.port === netchan.remoteAddress.port)
  );
}

function copyUserCmd(cmd: NetUserCmd): NetUserCmd {
  return { ...cmd, angles: [cmd.angles[0], cmd.angles[1], cmd.angles[2]] };
}

