import { copyPlayerState } from '../net/delta';
import {
  createNetUserCmd,
  createPlayerState,
  type NetUserCmd,
  type PlayerState
} from '../net/protocol';
import { EF_AWARDS, REWARD_SPRITE_TIME, TEAM } from './constants';
import type { GameEntity } from './game-entity';
import { vec3, type Vec3 } from './vec3';

/**
 * `gclient_t` and the three lifetimes inside it (`g_local.h:216–320`).
 *
 * A client's data is not one thing with one lifetime; it is three nested ones, and every field
 * belongs to exactly one of them:
 *
 * 1. **The spawn.** Everything not named below is cleared by `ClientSpawn`, so a fresh life
 *    starts with no timers running, no damage owed and no buttons latched.
 * 2. **`pers`** ({@link ClientPersistant}) survives a respawn but not a connect: `ClientConnect`
 *    clears the whole client, so joining a map or being carried through a restart starts it over.
 *    Quake 3's own comment on the struct says `ClientBegin` clears it and the code disagrees —
 *    the clearing is `ClientConnect`'s `memset`, which `ClientBegin` never repeats.
 * 3. **`sess`** ({@link ClientSession}) survives even that, because it does not live in memory
 *    between maps at all: it is written out to `session<slot>` cvars and read back at the next
 *    connect. That is what carries a tournament's wins across a restart of the match.
 *
 * `ps` is outside all three. It is cleared with the spawn, except for `persistant[]`, which is
 * the one part of a player state a respawn keeps — the score, the rank and the spawn count.
 */

/** `MAX_NETNAME` (`g_local.h:230`): how long a name may be, colour codes included. */
export const MAX_NETNAME = 36;

/**
 * `clientConnected_t` (`g_local.h:180–184`): how far into the connection this client is, from the
 * game module's side.
 *
 * It is not the host's {@link import('../server/host').CS}, which counts the messages of a
 * handshake. This one has three states because the game module only cares about three things:
 * the slot is empty, someone is arriving, or someone is here.
 */
export const CON = {
  DISCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2
} as const;

/** `spectatorState_t` (`g_local.h:186–191`): what a spectator is looking at. */
export const SPECTATOR = {
  /** Not spectating at all. */
  NOT: 0,
  /** Flying free. */
  FREE: 1,
  /** Riding another client's view. */
  FOLLOW: 2,
  /** Watching the scoreboard, which sorts last and is named "scoreboard". */
  SCOREBOARD: 3
} as const;

/** `playerTeamStateState_t` (`g_local.h:193–196`). */
export const TEAM_STATE = {
  /** Beginning a team game, so spawn at the base. */
  BEGIN: 0,
  /** Playing. */
  ACTIVE: 1
} as const;

/**
 * `playerTeamState_t` (`g_local.h:198–213`): how this client is doing in a team game.
 *
 * Quake 3 carries the flag statistics here as well — captures, defences, assists and the times
 * behind the "carrier defended" awards. They arrive with the team games that count them; what is
 * here is what the lifecycle itself reads.
 */
export interface PlayerTeamState {
  /** One of {@link TEAM_STATE}. */
  state: number;
  /** Flags carried home. */
  captures: number;
  /** Kills made near your own flag. */
  basedefense: number;
  /** Kills made near your own carrier. */
  carrierdefense: number;
  /** Your own flag walked into while it lay on the floor. */
  flagrecovery: number;
  /** Carriers of your flag killed. */
  fragcarrier: number;
  /** Returns and carrier kills that led straight to a capture. */
  assists: number;
  /** `level.time` you last hurt the other side's carrier, which their killer is paid for. */
  lasthurtcarrier: number;
  /** `level.time` you last returned your own flag. */
  lastreturnedflag: number;
  /** `level.time` you picked up the flag you are carrying. */
  flagsince: number;
  /** `level.time` you last killed a carrier. */
  lastfraggedcarrier: number;
}

/**
 * A team state as `ClientConnect` leaves one.
 *
 * Quake 3's `location` is left out: `CheckTeamStatus` keeps it for the team overlay
 * (`g_team.c:1122–1157`), which the port doesn't draw.
 */
export function createPlayerTeamState(): PlayerTeamState {
  return {
    state: TEAM_STATE.BEGIN,
    captures: 0,
    basedefense: 0,
    carrierdefense: 0,
    flagrecovery: 0,
    fragcarrier: 0,
    assists: 0,
    lasthurtcarrier: 0,
    lastreturnedflag: 0,
    flagsince: 0,
    lastfraggedcarrier: 0
  };
}

/**
 * `clientSession_t` (`g_local.h:219–227`): the lifetime that outlives the map.
 *
 * Every field here has to survive a process that forgets everything else, so every field here is
 * written to a cvar and read back — see `session.ts`. Adding one means dealing with it in all
 * three of those functions, which is exactly what Quake 3's comment on the struct warns about.
 */
export interface ClientSession {
  /** One of {@link TEAM}. */
  sessionTeam: number;
  /** Position in the queue to play, which decides who is next on in a tournament. */
  spectatorNum: number;
  /** One of {@link SPECTATOR}. */
  spectatorState: number;
  /** Who this spectator is following, for the chase camera. */
  spectatorClient: number;
  /** Tournament record, which is the whole reason this lifetime exists. */
  wins: number;
  losses: number;
  teamLeader: boolean;
}

/** A session as a first-time connect starts one, before the gametype has had its say. */
export function createClientSession(): ClientSession {
  return {
    sessionTeam: TEAM.FREE,
    spectatorNum: 0,
    spectatorState: SPECTATOR.NOT,
    spectatorClient: 0,
    wins: 0,
    losses: 0,
    teamLeader: false
  };
}

/** `*to = *from`, so a session can be put aside across a spawn's clearing. */
export function copyClientSession(from: ClientSession, to: ClientSession): ClientSession {
  to.sessionTeam = from.sessionTeam;
  to.spectatorNum = from.spectatorNum;
  to.spectatorState = from.spectatorState;
  to.spectatorClient = from.spectatorClient;
  to.wins = from.wins;
  to.losses = from.losses;
  to.teamLeader = from.teamLeader;
  return to;
}

/**
 * Whether a client watches rather than plays: on the spectator team, or watching from a side
 * until the next round, as Clan Arena's dead do (CPMA's `IsSpec`).
 *
 * CPMA reads the spectator state for the second. The port keeps a flag of its own, because Quake
 * 3 starts every session in a spectator state, a player's included (`G_InitSessionData`).
 */
export function isSpectator(client: GameClient): boolean {
  return client.sess.sessionTeam === TEAM.SPECTATOR || client.pers.roundSpectator;
}

/**
 * `clientPersistant_t` (`g_local.h:235–248`): the lifetime that outlives a death.
 *
 * The name, the handicap and when the client entered are things about the player rather than
 * about the life they are living, so a respawn must not touch them.
 */
export interface ClientPersistant {
  /** One of {@link CON}. */
  connected: number;
  /**
   * The last command run. Quake 3 keeps it here with the comment "we would lose angles if not
   * persistant": a spawn clears the client, and the view angles have to come from somewhere.
   */
  cmd: NetUserCmd;
  /** The `ip` userinfo key is `localhost`, so this client shares the host's process. */
  localClient: boolean;
  /** The first spawn has happened, so later ones no longer get the good-looking spot. */
  initialSpawn: boolean;
  /** `cg_predictItems`: this client predicts its own pickups. */
  predictItemPickup: boolean;
  pmoveFixed: boolean;
  /** The name other clients see, cleaned of anything that would break a scoreboard. */
  netname: string;
  /** The handicap, 1–100, which is the health and armor limit. */
  maxHealth: number;
  /** `level.time` this client entered the game. */
  enterTime: number;
  teamState: PlayerTeamState;
  /** Votes called, so one client cannot call them endlessly. */
  voteCount: number;
  teamVoteCount: number;
  /** Send this client the team overlay. */
  teamInfo: boolean;
  /**
   * Watching the round from a side until the next one, as Clan Arena's dead and late arrivals do
   * (CPMA's temporary spectators). The spectator state says what they watch.
   */
  roundSpectator: boolean;
  /** What the server holds this client's snapshots apart by, from the userinfo's `snaps`. */
  snapshotMsec: number;
  /** Unlagged's true ping: what each of the last commands measured, oldest written over. */
  pingSamples: number[];
  /** Where the next of {@link pingSamples} goes. */
  sampleHead: number;
  /** Their mean, held at 0 or more: the ping the scoreboard shows. */
  realPing: number;
  /**
   * `cg_debugDelag`, taken only while cheats are on: each target a railgun shot of theirs rewinds
   * is printed to them.
   */
  debugDelag: boolean;
}

/** Unlagged's `NUM_PING_SAMPLES`: how many commands true ping is the mean of. */
export const NUM_PING_SAMPLES = 64;

/** `*to = *from`, so persistent data can be put aside across a spawn's clearing. */
export function copyClientPersistant(from: ClientPersistant, to: ClientPersistant): ClientPersistant {
  to.connected = from.connected;
  copyNetUserCmd(from.cmd, to.cmd);
  to.localClient = from.localClient;
  to.initialSpawn = from.initialSpawn;
  to.predictItemPickup = from.predictItemPickup;
  to.pmoveFixed = from.pmoveFixed;
  to.netname = from.netname;
  to.maxHealth = from.maxHealth;
  to.enterTime = from.enterTime;
  // Quake 3's `*to = *from` copies the whole team state, counters and clocks alike — and the one
  // thing this function does in the port is *clear* a slot, from a zeroed template. A copy of
  // `state` alone would leave the last player's captures and assists in the slot for whoever
  // connects into it next.
  Object.assign(to.teamState, from.teamState);
  to.voteCount = from.voteCount;
  to.teamVoteCount = from.teamVoteCount;
  to.teamInfo = from.teamInfo;
  to.roundSpectator = from.roundSpectator;
  to.snapshotMsec = from.snapshotMsec;
  for (let i = 0; i < NUM_PING_SAMPLES; i++) to.pingSamples[i] = from.pingSamples[i];
  to.sampleHead = from.sampleHead;
  to.realPing = from.realPing;
  to.debugDelag = from.debugDelag;
  return to;
}

/** `*to = *from` for a user command, whose angles are an array and so survive no spread. */
export function copyNetUserCmd(from: NetUserCmd, to: NetUserCmd): NetUserCmd {
  to.serverTime = from.serverTime;
  to.angles[0] = from.angles[0];
  to.angles[1] = from.angles[1];
  to.angles[2] = from.angles[2];
  to.buttons = from.buttons;
  to.weapon = from.weapon;
  to.forwardmove = from.forwardmove;
  to.rightmove = from.rightmove;
  to.upmove = from.upmove;
  to.drawnTime = from.drawnTime;
  to.drawnSnapTime = from.drawnSnapTime;
  to.drawnNextSnapTime = from.drawnNextSnapTime;
  return to;
}

/** Persistent data as `ClientConnect`'s clearing leaves it. */
export function createClientPersistant(): ClientPersistant {
  return {
    connected: CON.DISCONNECTED,
    cmd: createNetUserCmd(),
    localClient: false,
    initialSpawn: false,
    predictItemPickup: false,
    pmoveFixed: false,
    netname: '',
    maxHealth: 0,
    enterTime: 0,
    teamState: createPlayerTeamState(),
    voteCount: 0,
    teamVoteCount: 0,
    teamInfo: false,
    roundSpectator: false,
    snapshotMsec: 0,
    pingSamples: new Array<number>(NUM_PING_SAMPLES).fill(0),
    sampleHead: 0,
    realPing: 0,
    debugDelag: false
  };
}

/**
 * unlagged's `clientHistory_t`: where a client stood at a frame's end, in what box, and the frame's
 * `level.time`.
 */
export interface HistoryRecord {
  origin: Vec3;
  mins: Vec3;
  maxs: Vec3;
  time: number;
}

/**
 * Where a rewind found a client, to put them back: the record, and the box the world finds them
 * by, which the think links round their snapped origin while the traces use the exact one.
 */
export interface SavedPosition extends HistoryRecord {
  absmin: Vec3;
  absmax: Vec3;
}

/**
 * {@link SavedPosition.time} while nothing is saved. unlagged's is 0, which a level started at 0
 * would read as saved.
 */
export const NOT_SAVED = -1;

/** A record of nothing, as a cleared client holds. */
export function createHistoryRecord(): HistoryRecord {
  return { origin: vec3(), mins: vec3(), maxs: vec3(), time: 0 };
}

/**
 * `gclient_t` (`g_local.h:252–320`): one client's slot, from the game module's side.
 *
 * `ps` comes first in Quake 3's struct with a comment saying it must, because the server is
 * handed a pointer to the client and reads the player state off the front of it. The port asks
 * for it through {@link import('./game-module').GameModule.playerState} instead, so the order
 * here means nothing — but the field is the same field, and it is the one the wire carries.
 *
 * Everything from `readyToExit` down is cleared by each spawn. What is not cleared is `pers`,
 * `sess`, `ps.persistant[]`, the accuracy counts and the ping, and the reason each is spared is
 * in {@link clearClientForSpawn}.
 */
export interface GameClient {
  /** `playerState_t`: what the server sends about this client, and what `pmove` runs on. */
  ps: PlayerState;

  /** Survives a respawn. */
  pers: ClientPersistant;
  /** Survives a map change. */
  sess: ClientSession;

  /** This client wishes to leave the intermission. */
  readyToExit: boolean;
  noclip: boolean;

  /**
   * `level.time` when the last command ran, which decides whether the client is slid on at the
   * frame's end or shows the connection-trouble sprite. It is not `pers.cmd.serverTime`, which is
   * the client's clock. A spawn zeroes it, so a respawned client shows the sprite until their
   * next command.
   */
  lastUpdateTime: number;
  /** Unlagged's `frameOffset`: how long after the last frame ended the last command ran. */
  frameOffset: number;

  buttons: number;
  oldbuttons: number;
  /** Buttons pressed since the last time anything looked, so a tap between frames is not lost. */
  latchedButtons: number;

  /** Where the client was before this frame's move. */
  oldOrigin: Vec3;

  /**
   * A frame's damage, summed so that a shotgun's pellets give one kick rather than eleven.
   * `ClientEndFrame` turns them into the feedback the client sees and clears them.
   */
  damageArmor: number;
  damageBlood: number;
  damageKnockback: number;
  damageFrom: Vec3;
  /** The hurt has no direction, so the blood is centred rather than aimed. */
  damageFromWorld: boolean;

  /** Hits in a row, for the "impressive" reward. */
  accurateCount: number;
  /** Survives a spawn, because accuracy is measured over the match rather than the life. */
  accuracyShots: number;
  accuracyHits: number;
  /** CPMA's damage given, which Clan Arena's board shows; a match's, as the accuracy is. */
  damageGiven: number;

  lastkilledClient: number;
  lasthurtClient: number;
  lasthurtMod: number;

  /** May respawn once `level.time` passes this, and is forced to after `g_forcerespawn`. */
  respawnTime: number;
  /** Kicked once `level.time` passes this. */
  inactivityTime: number;
  inactivityWarning: boolean;
  /** The reward sprites are cleared once `level.time` passes this. */
  rewardTime: number;
  airOutTime: number;
  /** For the multiple-kill rewards. */
  lastKillTime: number;

  /** The grapple's fire button is still held. */
  fireHeld: boolean;
  /** The entity number of the grapple hook out, or −1 for none. */
  hook: number;

  switchTeamTime: number;

  /** Sim time towards the next once-a-second action: the health drain. */
  timeResidual: number;
  /** Sim time towards the armour's next point of drain, on its tier's clock. */
  armorResidual: number;

  /**
   * Where the client has stood, a record a frame, the oldest written over (unlagged's `history`).
   * How many there are follows the frame's length.
   */
  history: HistoryRecord[];
  /** The newest of {@link history}. */
  historyHead: number;
  /** Where a rewind found the client, stamped with the frame it happened in. */
  saved: SavedPosition;
}

/** A client slot with nothing in it, as `ClientConnect`'s `memset` leaves one. */
export function createGameClient(): GameClient {
  return {
    ps: createPlayerState(),
    pers: createClientPersistant(),
    sess: createClientSession(),
    readyToExit: false,
    noclip: false,
    lastUpdateTime: 0,
    frameOffset: 0,
    buttons: 0,
    oldbuttons: 0,
    latchedButtons: 0,
    oldOrigin: vec3(),
    damageArmor: 0,
    damageBlood: 0,
    damageKnockback: 0,
    damageFrom: vec3(),
    damageFromWorld: false,
    accurateCount: 0,
    accuracyShots: 0,
    accuracyHits: 0,
    damageGiven: 0,
    lastkilledClient: 0,
    lasthurtClient: 0,
    lasthurtMod: 0,
    respawnTime: 0,
    inactivityTime: 0,
    inactivityWarning: false,
    rewardTime: 0,
    airOutTime: 0,
    lastKillTime: 0,
    fireHeld: false,
    hook: -1,
    switchTeamTime: 0,
    timeResidual: 0,
    armorResidual: 0,
    history: [],
    historyHead: 0,
    saved: { ...createHistoryRecord(), absmin: vec3(), absmax: vec3(), time: NOT_SAVED }
  };
}

/**
 * `ClientSpawn`'s opening (`g_client.c:1107–1136`): clear the client, and put back the few things
 * a new life is not allowed to forget.
 *
 * Quake 3 writes this as save, `memset`, restore — which is the only way to say "everything
 * except" in C, and which is also why the exceptions are worth reading as a list rather than as
 * code. They are:
 *
 * - **`pers` and `sess`**, the two outer lifetimes.
 * - **`ps.persistant[]`**, the score, the rank and the spawn count. A death must not reset a
 *   scoreboard.
 * - **`ps.ping`**, which the server measures and the game module only passes on.
 * - **`ps.eventSequence`**, because a client that has seen events 0–5 must not be sent a fresh
 *   event 0; the sequence only ever goes up.
 * - **the accuracy counts** and the damage given, which are the match's statistics rather than
 *   the life's.
 *
 * `lastkilledClient` is then set to −1 rather than cleared, since 0 is a real client.
 *
 * @param client - The client to clear, in place, so references to it and to its `ps` stay good.
 */
export function clearClientForSpawn(client: GameClient): void {
  const { ping, eventSequence } = client.ps;
  const persistant = [...client.ps.persistant];
  const { accuracyHits, accuracyShots, damageGiven } = client;

  resetGameClient(client, { pers: false, sess: false });

  client.ps.ping = ping;
  client.ps.eventSequence = eventSequence;
  for (let i = 0; i < persistant.length; i++) client.ps.persistant[i] = persistant[i];
  client.accuracyHits = accuracyHits;
  client.accuracyShots = accuracyShots;
  client.damageGiven = damageGiven;
  client.lastkilledClient = -1;
}

/**
 * `ClientConnect`'s `memset( client, 0, sizeof(*client) )` (`g_client.c:930`): everything goes,
 * including both of the inner lifetimes.
 *
 * The session is read back from its cvars immediately afterwards, which is what makes it look
 * like it survived. `pers` has nowhere to be read back from, and so does not.
 *
 * @param client - The client to clear, in place.
 */
export function clearClientForConnect(client: GameClient): void {
  resetGameClient(client, { pers: true, sess: true });
}

/** Read-only templates to clear from, so clearing a client allocates nothing lasting. */
const ZERO_PLAYER_STATE = createPlayerState();
const ZERO_PERSISTANT = createClientPersistant();
const ZERO_SESSION = createClientSession();

/**
 * `Com_Memset` on a client already in `level.clients[]`: every field goes back to zero and every
 * object stays the object it was, because an entity, a snapshot and a test may all be holding it.
 *
 * @param client - The client to clear, in place.
 * @param clear - Which of the outer lifetimes go with it.
 */
function resetGameClient(client: GameClient, clear: { pers: boolean; sess: boolean }): void {
  copyPlayerState(ZERO_PLAYER_STATE, client.ps);
  if (clear.pers) copyClientPersistant(ZERO_PERSISTANT, client.pers);
  if (clear.sess) copyClientSession(ZERO_SESSION, client.sess);

  client.readyToExit = false;
  client.noclip = false;
  client.lastUpdateTime = 0;
  client.frameOffset = 0;
  client.buttons = 0;
  client.oldbuttons = 0;
  client.latchedButtons = 0;
  client.oldOrigin.x = 0;
  client.oldOrigin.y = 0;
  client.oldOrigin.z = 0;
  client.damageArmor = 0;
  client.damageBlood = 0;
  client.damageKnockback = 0;
  client.damageFrom.x = 0;
  client.damageFrom.y = 0;
  client.damageFrom.z = 0;
  client.damageFromWorld = false;
  client.accurateCount = 0;
  client.accuracyShots = 0;
  client.accuracyHits = 0;
  client.damageGiven = 0;
  client.lastkilledClient = 0;
  client.lasthurtClient = 0;
  client.lasthurtMod = 0;
  client.respawnTime = 0;
  client.inactivityTime = 0;
  client.inactivityWarning = false;
  client.rewardTime = 0;
  client.airOutTime = 0;
  client.lastKillTime = 0;
  client.fireHeld = false;
  client.hook = -1;
  client.switchTeamTime = 0;
  client.timeResidual = 0;
  client.armorResidual = 0;
  // The records are zeroed where they are, as the `memset` leaves them, rather than dropped: until
  // the history fills again, a rewind past its newest records interpolates from these zeros, as
  // unlagged's does after a spawn.
  for (const record of client.history) clearHistoryRecord(record);
  client.historyHead = 0;
  clearHistoryRecord(client.saved);
  clearVec(client.saved.absmin);
  clearVec(client.saved.absmax);
  client.saved.time = NOT_SAVED;
}

/** A record back to nothing, in place. */
function clearHistoryRecord(record: HistoryRecord): void {
  clearVec(record.origin);
  clearVec(record.mins);
  clearVec(record.maxs);
  record.time = 0;
}

/** `VectorClear`. */
function clearVec(v: Vec3): void {
  v.x = 0;
  v.y = 0;
  v.z = 0;
}

/**
 * The sprite over a client's head for an award just earned, as each award sets it (the first is
 * `g_combat.c:518–521`): any other comes off, and this one stays for {@link REWARD_SPRITE_TIME}.
 *
 * @param award - One of the `EF_AWARD_*` flags.
 * @param time - `level.time`.
 */
export function awardSprite(client: GameClient, award: number, time: number): void {
  client.ps.eFlags = (client.ps.eFlags & ~EF_AWARDS) | award;
  client.rewardTime = time + REWARD_SPRITE_TIME;
}

/**
 * `SetClientViewAngle` (`g_client.c:511–528`): point the client's view, and mean it.
 *
 * A client sends where it is looking and the server cannot simply overwrite that, because the
 * next command would put it back. So the delta angles are set to the difference instead: the
 * client keeps sending the same angles and they now add up to somewhere else.
 *
 * @param entity - The client's entity.
 * @param angles - Where to look, in degrees.
 */
export function setClientViewAngle(entity: GameEntity, angles: Vec3): void {
  const client = entity.client;
  if (!client) return;

  client.ps.deltaAngles.x = angleToShort(angles.x) - client.pers.cmd.angles[0];
  client.ps.deltaAngles.y = angleToShort(angles.y) - client.pers.cmd.angles[1];
  client.ps.deltaAngles.z = angleToShort(angles.z) - client.pers.cmd.angles[2];

  entity.s.angles.x = angles.x;
  entity.s.angles.y = angles.y;
  entity.s.angles.z = angles.z;
  client.ps.viewangles.x = angles.x;
  client.ps.viewangles.y = angles.y;
  client.ps.viewangles.z = angles.z;
}

/**
 * `ANGLE2SHORT` (`q_shared.h:1072`): an angle as the sixteen-bit number a user command carries it
 * in. The cast to `int` truncates towards zero before the mask, which is why this is not a round.
 */
export function angleToShort(degrees: number): number {
  return Math.trunc((degrees * 65536) / 360) & 0xffff;
}

/** `SHORT2ANGLE` (`q_shared.h:1073`): the reverse of {@link angleToShort}. */
export function shortToAngle(value: number): number {
  return value * (360 / 65536);
}

/**
 * What a C `short` would hold of a sum of two: sixteen bits, signed.
 *
 * The sum is signed because a `short` is: a pitch of ten degrees up is −1820, not 63,716, and both
 * the pitch clamp and the move want it that way round.
 */
export function toShort(value: number): number {
  return ((value & 0xffff) << 16) >> 16;
}

/** `SHORT2ANGLE` on a sum that may have run past sixteen bits. */
export function shortAngle(value: number): number {
  return toShort(value) * (360 / 65536);
}
