import { CONFIGSTRING } from '../net/commands';
import { MAX_CLIENTS } from '../net/protocol';
import { awardSprite } from './client';
import {
  EF_AWARD_ASSIST,
  EF_AWARD_CAP,
  EF_AWARD_DEFEND,
  FL,
  GT,
  PERS,
  PLAYEREVENT,
  TEAM
} from './constants';
import { EV, GTS } from './events';
import { SVF, type GameEntity } from './game-entity';
import { respawnItem } from './item-touch';
import { PW } from './items';
import type { Level } from './level';
import { tempEntity } from './temp-entity';
import { length, lengthSquared, sub, type Vec3 } from './vec3';

/**
 * The two sides and the flags they fight over: `g_team.c`.
 *
 * Quake 3 keeps one `teamgame_t` as a game-module global beside `level` (`g_team.c:27–39`). The
 * port hangs it off the level instead, because that is its lifetime — a map start clears it — and
 * because the things that write it are item callbacks, which are handed the level and nothing
 * else.
 *
 * Only Capture the Flag's half is here. One Flag CTF, Overload and Harvester are Team Arena's
 * (`g_team.c:1198–1495`), and nothing below reaches them.
 */

/** `flagStatus_t` (`q_shared.h:1399–1405`). */
export const FLAG = {
  ATBASE: 0,
  /** Somebody is carrying it. */
  TAKEN: 1,
  /** One Flag CTF's two, which the port does not play. */
  TAKEN_RED: 2,
  TAKEN_BLUE: 3,
  DROPPED: 4
} as const;

/**
 * `cl->ps.powerups[flag] = INT_MAX` (`g_team.c:815, 817`): "flags never expire".
 *
 * A carried flag is a powerup with a time on it like any other, and this is the time — far enough
 * away that nothing counts down to it. It is also what `TossClientItems` and the HUD read to tell
 * a flag from a quad.
 */
export const FLAG_NEVER_EXPIRES = 2_147_483_647;

/** `CTF_CAPTURE_BONUS` (`g_team.h:41`): what the carrier gets for a capture. */
export const CTF_CAPTURE_BONUS = 5;
/** `CTF_RECOVERY_BONUS` (`g_team.h:43`): what you get for returning your own flag. */
export const CTF_RECOVERY_BONUS = 1;
/** `CTF_RETURN_FLAG_ASSIST_BONUS` (`g_team.h:51`): a return that led straight to a capture. */
export const CTF_RETURN_FLAG_ASSIST_BONUS = 1;
/** `CTF_FRAG_CARRIER_ASSIST_BONUS` (`g_team.h:52`): a kill that led straight to a capture. */
export const CTF_FRAG_CARRIER_ASSIST_BONUS = 2;
/** `CTF_RETURN_FLAG_ASSIST_TIMEOUT` (`g_team.h:61`): how recent a return has to have been. */
export const CTF_RETURN_FLAG_ASSIST_TIMEOUT = 10_000;
/** `CTF_FRAG_CARRIER_ASSIST_TIMEOUT` (`g_team.h:60`): how recent the kill has to have been. */
export const CTF_FRAG_CARRIER_ASSIST_TIMEOUT = 10_000;
/** `CTF_FRAG_CARRIER_BONUS` (`g_team.h:45`): for killing whoever is carrying your flag. */
export const CTF_FRAG_CARRIER_BONUS = 2;
/** `CTF_CARRIER_DANGER_PROTECT_BONUS` (`g_team.h:48`): for killing someone who hurt yours. */
export const CTF_CARRIER_DANGER_PROTECT_BONUS = 2;
/** `CTF_CARRIER_PROTECT_BONUS` (`g_team.h:49`): for a kill near your own carrier. */
export const CTF_CARRIER_PROTECT_BONUS = 1;
/** `CTF_FLAG_DEFENSE_BONUS` (`g_team.h:50`): for a kill near your own flag. */
export const CTF_FLAG_DEFENSE_BONUS = 1;
/** `CTF_TARGET_PROTECT_RADIUS` (`g_team.h:56`): how near your flag a kill defends it. */
export const CTF_TARGET_PROTECT_RADIUS = 1000;
/** `CTF_ATTACKER_PROTECT_RADIUS` (`g_team.h:57`): the same, about your carrier. */
export const CTF_ATTACKER_PROTECT_RADIUS = 1000;
/** `CTF_CARRIER_DANGER_PROTECT_TIMEOUT` (`g_team.h:59`): how recent the hurt has to have been. */
export const CTF_CARRIER_DANGER_PROTECT_TIMEOUT = 8_000;

/**
 * `teamgame_t` (`g_team.c:27–37`), as far as the port keeps it.
 *
 * Team Arena's two obelisk times are left out with the mode that reads them.
 */
export interface TeamGame {
  /** `level.time` of the last capture. */
  lastFlagCapture: number;
  /** Which side made it. */
  lastCaptureTeam: number;
  /** Where the red flag is, as `CS_FLAGSTATUS` says it. */
  redStatus: number;
  /** Where the blue flag is. */
  blueStatus: number;
  /**
   * When red last took a flag, which is the throttle {@link teamTakeFlagSound} keeps so that a
   * flag grabbed twice in ten seconds is only shouted about once.
   */
  redTakenTime: number;
  /** The same for blue. */
  blueTakenTime: number;
}

/** `memset(&teamgame, 0, sizeof teamgame)`: both flags home, which is status 0. */
export function createTeamGame(): TeamGame {
  return {
    lastFlagCapture: 0,
    lastCaptureTeam: 0,
    redStatus: FLAG.ATBASE,
    blueStatus: FLAG.ATBASE,
    redTakenTime: 0,
    blueTakenTime: 0
  };
}

/**
 * `ctfFlagStatusRemap` (`g_team.c:180`): the character each status is sent as.
 *
 * Two of the five are `*`, because they are One Flag CTF's and a CTF string can never hold them.
 */
const CTF_FLAG_STATUS_REMAP = ['0', '1', '*', '*', '2'];

/**
 * `PrintMsg` (`g_team.c:95–112`): a line of text, to one client or to everyone.
 *
 * Every double quote becomes a single one first — "double quotes are bad" — because the command
 * it travels in is itself quoted, and one inside would end it early.
 *
 * @param level - The match, which carries the trap.
 * @param clientNum - Who to tell, or null for everyone, which is Quake 3's `NULL` entity.
 * @param text - The line, ending in its own newline as Quake 3's format strings do.
 */
export function printMsg(level: Level, clientNum: number | null, text: string): void {
  level.sendServerCommand(clientNum, `print "${text.replaceAll('"', "'")}"`);
}

/**
 * `Team_SetFlagStatus` (`g_team.c:185–226`): where a flag is, told to every client.
 *
 * The string is both flags' statuses, red first, and it is written only when one of them changed —
 * which is what the "invalid to force update" in {@link initTeamGame} is working around.
 *
 * @param level - The match, whose flags are written and whose trap carries the string.
 * @param team - Whose flag moved: red or blue.
 * @param status - Where it is now.
 */
export function setFlagStatus(level: Level, team: number, status: number): void {
  const game = level.teamgame;
  let modified = false;
  if (team === TEAM.RED && game.redStatus !== status) {
    game.redStatus = status;
    modified = true;
  } else if (team === TEAM.BLUE && game.blueStatus !== status) {
    game.blueStatus = status;
    modified = true;
  }
  if (!modified) return;

  level.setConfigstring(
    CONFIGSTRING.FLAGSTATUS,
    CTF_FLAG_STATUS_REMAP[game.redStatus] + CTF_FLAG_STATUS_REMAP[game.blueStatus]
  );
}

/**
 * `Team_InitGame` (`g_team.c:45–63`): the match's flags are cleared, and in Capture the Flag every
 * client is told both are at their bases.
 *
 * Only CTF says it. Every other gametype clears the struct and stops, because `CS_FLAGSTATUS` is
 * the flags' own string and a match without flags has nothing to put in it.
 *
 * Each status goes to a value no flag can hold before it is set — Quake 3's "invalid to force
 * update" — because a cleared struct already reads `FLAG_ATBASE`, and without the lie
 * {@link setFlagStatus} would find nothing changed and write no string at all.
 *
 * @param level - The match, whose flags are cleared in place.
 * @param gametype - `g_gametype`.
 */
export function initTeamGame(level: Level, gametype: number): void {
  // The `memset` is every field and not only the two statuses: the take times throttle a sound,
  // and a restart that kept them would carry the dead match's clock into the new one.
  Object.assign(level.teamgame, createTeamGame());
  if (gametype !== GT.CTF) return;

  level.teamgame.redStatus = -1;
  setFlagStatus(level, TEAM.RED, FLAG.ATBASE);
  level.teamgame.blueStatus = -1;
  setFlagStatus(level, TEAM.BLUE, FLAG.ATBASE);
}

/**
 * `OtherTeam` (`g_team.c:66–72`): the side facing this one, and the side itself for anyone who is
 * on neither.
 *
 * @param team - A side.
 */
export function otherTeam(team: number): number {
  if (team === TEAM.RED) return TEAM.BLUE;
  if (team === TEAM.BLUE) return TEAM.RED;
  return team;
}

/**
 * `TeamName` (`g_team.c:74–82`): what a side is called in a message.
 *
 * @param team - A side.
 */
export function teamName(team: number): string {
  if (team === TEAM.RED) return 'RED';
  if (team === TEAM.BLUE) return 'BLUE';
  if (team === TEAM.SPECTATOR) return 'SPECTATOR';
  return 'FREE';
}

/**
 * `OnSameTeam` (`g_team.c:165–183`): whether two entities are on the same side.
 *
 * Nobody is on anybody's team below `GT_TEAM`, so the answer is no in every free-for-all, and
 * anything that is not a client is on no side at all. The comparison is of the session's team
 * rather than the player state's, so it holds for a spectator and a player alike.
 *
 * Quake 3 reads `g_gametype` off its own global; the port is handed it, because every caller has
 * it to hand — the level's for `G_Damage`, and the life's own for `player_die`.
 *
 * @param gametype - `g_gametype`.
 * @param ent1 - One entity.
 * @param ent2 - The other.
 */
export function onSameTeam(gametype: number, ent1: GameEntity, ent2: GameEntity): boolean {
  if (!ent1.client || !ent2.client) return false;
  if (gametype < GT.TEAM) return false;
  return ent1.client.sess.sessionTeam === ent2.client.sess.sessionTeam;
}

/**
 * `Team_GetLocation` (`g_team.c:897–929`): the `target_location` nearest a player that their PVS
 * holds, or null. The chain is walked from its head, and a later one wins a tie.
 *
 * @param level - The match, whose locations are walked.
 * @param ent - The player.
 */
function teamGetLocation(level: Level, ent: GameEntity): GameEntity | null {
  const origin = ent.r.currentOrigin;
  let best: GameEntity | null = null;
  let bestlen = 3 * 8192 * 8192;
  for (let eloc = level.locationHead; eloc; eloc = eloc.nextTrain) {
    const len = lengthSquared(sub(origin, eloc.r.currentOrigin));
    if (len > bestlen) continue;
    if (!level.inPVS(origin, eloc.r.currentOrigin)) continue;
    bestlen = len;
    best = eloc;
  }
  return best;
}

/**
 * `Team_GetLocationMsg` (`g_team.c:936–958`): what team chat calls the place a player is, or null
 * where no location is near.
 *
 * A non-zero `count` colours it, held to 0–7 only once it was found non-zero, so a negative one
 * colours it black; white follows. It is written into a buffer of `size` bytes as `Com_sprintf`
 * writes, cut to fit with its complaint on the console.
 *
 * @param level - The match, whose locations are walked.
 * @param ent - The player.
 * @param size - The buffer's size, NUL and all.
 * @param print - Where `Com_Printf` goes.
 */
export function teamGetLocationMsg(
  level: Level,
  ent: GameEntity,
  size: number,
  print: (text: string) => void
): string | null {
  const best = teamGetLocation(level, ent);
  if (!best) return null;

  const message = best.message ?? '';
  const loc = best.count ? `^${Math.min(Math.max(best.count, 0), 7)}${message}^7` : message;
  if (loc.length < size) return loc;
  print(`Com_sprintf: Output length ${size} too short, require ${loc.length + 1} bytes.\n`);
  return loc.slice(0, size - 1);
}

/**
 * `AddTeamScore` (`g_team.c:121–163`): a side scores, and everyone hears what it did to the lead.
 *
 * This is the modes above `GT_TEAM` — a team deathmatch adds to the same array inside `AddScore`,
 * a frag at a time, and never comes here. The sound is chosen *before* the score lands, by asking
 * what the new total would do: level the match, take the lead, or neither. So the tie sound is
 * "that capture has tied it", not "it was tied already".
 *
 * @param level - The match, whose team scores are added to.
 * @param origin - Where it happened, which is where the temp entity carrying the sound stands.
 * @param team - Who scored.
 * @param score - How much.
 */
export function addTeamScore(level: Level, origin: Vec3, team: number, score: number): void {
  const te = tempEntity(level, origin, EV.GLOBAL_TEAM_SOUND);
  te.r.svFlags |= SVF.BROADCAST;

  // Quake 3 writes the two sides out separately and the halves are the same but for the sound
  // names. Anyone who is on neither side is scored as blue is, as the C's `else` has it.
  const red = team === TEAM.RED;
  const mine = level.teamScores[team];
  const theirs = level.teamScores[red ? TEAM.BLUE : TEAM.RED];

  if (mine + score === theirs) {
    te.s.eventParm = GTS.TEAMS_ARE_TIED;
  } else if (mine <= theirs && mine + score > theirs) {
    te.s.eventParm = red ? GTS.REDTEAM_TOOK_LEAD : GTS.BLUETEAM_TOOK_LEAD;
  } else {
    te.s.eventParm = red ? GTS.REDTEAM_SCORED : GTS.BLUETEAM_SCORED;
  }

  level.teamScores[team] += score;
}

/**
 * `Team_CheckDroppedItem` (`g_team.c:228–243`): a flag that has just hit the floor is a flag away
 * from home, and the HUD says so.
 *
 * @param level - The match.
 * @param dropped - The item that was thrown, which may be anything at all.
 */
export function teamCheckDroppedItem(level: Level, dropped: GameEntity): void {
  const tag = dropped.item?.giTag;
  if (tag === PW.REDFLAG) setFlagStatus(level, TEAM.RED, FLAG.DROPPED);
  else if (tag === PW.BLUEFLAG) setFlagStatus(level, TEAM.BLUE, FLAG.DROPPED);
}

/**
 * `Team_ForceGesture` (`g_team.c:245–260`): every player on the side that just captured taunts,
 * wherever they are and whatever they were doing.
 *
 * The flag is set on the entity rather than the client, and `ClientThink_real` turns it into a
 * `BUTTON_GESTURE` on the next command it runs (`g_active.c:873–876`) — so the taunt is played
 * by the ordinary animation path and is predicted like any other.
 *
 * @param level - The match.
 * @param team - The side that captured.
 */
export function teamForceGesture(level: Level, team: number): void {
  // `MAX_CLIENTS`, not `level.maxclients`: Quake 3 walks every client slot there could be.
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const entity = level.gentities[i];
    if (!entity.inuse) continue;
    if (!entity.client) continue;
    if (entity.client.sess.sessionTeam !== team) continue;
    entity.flags |= FL.FORCE_GESTURE;
  }
}

/**
 * `Team_ResetFlag` (`g_team.c:508–538`): put a side's flag back on its stand.
 *
 * Every entity of the classname is visited, because there may be two of them: the one the map
 * placed, which is respawned, and the one a carrier dropped, which is freed. The map's is what
 * comes back, and what the caller is handed so it has somewhere to play a sound from.
 *
 * @param level - The match.
 * @param team - Whose flag.
 * @returns the flag the map placed, or null for a side that has none
 */
export function teamResetFlag(level: Level, team: number): GameEntity | null {
  let classname: string;
  if (team === TEAM.RED) classname = 'team_CTF_redflag';
  else if (team === TEAM.BLUE) classname = 'team_CTF_blueflag';
  else return null;

  let rent: GameEntity | null = null;
  for (
    let ent = level.find(null, 'classname', classname);
    ent;
    ent = level.find(ent, 'classname', classname)
  ) {
    // A freed slot keeps its number, so the walk goes on from it exactly as the C's does.
    if (ent.flags & FL.DROPPED_ITEM) level.freeEntity(ent);
    else {
      rent = ent;
      respawnItem(level, ent);
    }
  }

  setFlagStatus(level, team, FLAG.ATBASE);
  return rent;
}

/**
 * `Team_ResetFlags` (`g_team.c:541–551`): both flags home, which is what a capture ends with.
 *
 * @param level - The match.
 * @param gametype - `g_gametype`. Only Capture the Flag has two flags to reset.
 */
export function teamResetFlags(level: Level, gametype: number): void {
  if (gametype !== GT.CTF) return;
  teamResetFlag(level, TEAM.RED);
  teamResetFlag(level, TEAM.BLUE);
}

/**
 * `Team_ReturnFlagSound` (`g_team.c:553–569`): a flag is back on its stand.
 *
 * The sound is named for the side that gets the good news rather than for the flag: the *blue*
 * flag coming home is `GTS_RED_RETURN`, which the red team hears as "your team". That reads as
 * very likely an id slip, though nobody has listened to check.
 *
 * @param level - The match.
 * @param ent - The flag, or null when there was none to reset, which Quake 3 warns about.
 * @param team - Whose flag came back.
 */
export function teamReturnFlagSound(level: Level, ent: GameEntity | null, team: number): void {
  if (!ent) {
    level.itemMatch.print('Warning:  NULL passed to Team_ReturnFlagSound\n');
    return;
  }
  const te = tempEntity(level, ent.s.pos.trBase, EV.GLOBAL_TEAM_SOUND);
  te.s.eventParm = team === TEAM.BLUE ? GTS.RED_RETURN : GTS.BLUE_RETURN;
  te.r.svFlags |= SVF.BROADCAST;
}

/**
 * `Team_TakeFlagSound` (`g_team.c:571–607`): somebody has the other side's flag.
 *
 * "Only play sound when the flag was at the base or not picked up the last 10 seconds", so that a
 * flag snatched back and forth in a doorway does not shout every time. The throttle reads the
 * *other* flag's status and the taker's own last time — Quake 3's own crossing, kept: this
 * function is called after {@link setFlagStatus} has already marked the taken flag, so reading its
 * own status would answer "not at base" every single time and throttle every grab.
 *
 * @param level - The match.
 * @param ent - The flag, or null, which Quake 3 warns about.
 * @param team - Whose flag was taken; the sound is named for whoever took it.
 */
export function teamTakeFlagSound(level: Level, ent: GameEntity | null, team: number): void {
  if (!ent) {
    level.itemMatch.print('Warning:  NULL passed to Team_TakeFlagSound\n');
    return;
  }

  const game = level.teamgame;
  if (team === TEAM.RED) {
    if (game.blueStatus !== FLAG.ATBASE && game.blueTakenTime > level.time - 10_000) return;
    game.blueTakenTime = level.time;
  } else if (team === TEAM.BLUE) {
    if (game.redStatus !== FLAG.ATBASE && game.redTakenTime > level.time - 10_000) return;
    game.redTakenTime = level.time;
  }

  const te = tempEntity(level, ent.s.pos.trBase, EV.GLOBAL_TEAM_SOUND);
  te.s.eventParm = team === TEAM.BLUE ? GTS.RED_TAKEN : GTS.BLUE_TAKEN;
  te.r.svFlags |= SVF.BROADCAST;
}

/**
 * `Team_CaptureFlagSound` (`g_team.c:609–625`): a flag was carried home.
 *
 * @param level - The match.
 * @param ent - The flag that was standing at the base, or null, which Quake 3 warns about.
 * @param team - Whose base it happened at, which is the side that captured.
 */
export function teamCaptureFlagSound(level: Level, ent: GameEntity | null, team: number): void {
  if (!ent) {
    level.itemMatch.print('Warning:  NULL passed to Team_CaptureFlagSound\n');
    return;
  }
  const te = tempEntity(level, ent.s.pos.trBase, EV.GLOBAL_TEAM_SOUND);
  te.s.eventParm = team === TEAM.BLUE ? GTS.BLUE_CAPTURE : GTS.RED_CAPTURE;
  te.r.svFlags |= SVF.BROADCAST;
}

/**
 * `Team_ReturnFlag` (`g_team.c:627–635`): a flag goes home without anybody having touched it.
 *
 * This is what a dropped flag's timer runs into, and what a carrier's suicide does with the flag
 * they were holding.
 *
 * @param level - The match.
 * @param team - Whose flag.
 */
export function teamReturnFlag(level: Level, team: number): void {
  teamReturnFlagSound(level, teamResetFlag(level, team), team);
  printMsg(level, null, `The ${teamName(team)} flag has returned!\n`);
}

/**
 * `Team_FreeEntity` (`g_team.c:637–647`): a flag lost in `CONTENTS_NODROP` goes home. It frees
 * nothing itself; the return frees a dropped flag on its way through.
 *
 * @param level - The match.
 * @param ent - The flag.
 */
export function teamFreeEntity(level: Level, ent: GameEntity): void {
  if (ent.item?.giTag === PW.REDFLAG) teamReturnFlag(level, TEAM.RED);
  else if (ent.item?.giTag === PW.BLUEFLAG) teamReturnFlag(level, TEAM.BLUE);
}

/**
 * `Team_DroppedFlagThink` (`g_team.c:658–679`): the flag on the floor has waited long enough.
 *
 * `LaunchItem` hangs this on any flag that is thrown (`g_items.c:597–601`), which is what makes a
 * flag unlike every other dropped item: the rest simply vanish after their thirty seconds, and a
 * flag has a stand somewhere that has to have it back.
 *
 * @param level - The match.
 * @param ent - The dropped flag, which {@link teamResetFlag} frees on its way through.
 */
export function teamDroppedFlagThink(level: Level, ent: GameEntity): void {
  let team: number = TEAM.FREE;
  if (ent.item?.giTag === PW.REDFLAG) team = TEAM.RED;
  else if (ent.item?.giTag === PW.BLUEFLAG) team = TEAM.BLUE;

  teamReturnFlagSound(level, teamResetFlag(level, team), team);
  // "Reset Flag will delete this entity".
}

/**
 * `Team_TouchOurFlag` (`g_team.c:681–796`): a player walked into their own side's flag.
 *
 * Two quite different things can be happening. If the flag is on the floor somebody dropped it,
 * and walking into it sends it home for a small bonus — the *return*, which is most of what a
 * defender does. If it is standing on its base, the touch is only interesting when the player is
 * carrying the other side's flag, and then they have just captured.
 *
 * The capture's player loop is the assists: anyone on the capturing side who returned a flag or
 * killed a carrier within the last ten seconds is paid for it, and everyone on the other side has
 * their "recently hurt the carrier" clock pushed far into the past so that the next kill cannot
 * claim a defence against a capture that has already happened.
 *
 * @param level - The match.
 * @param ent - The flag that was touched.
 * @param other - The player who touched it.
 * @param team - Whose flag it is, which here is also the player's own side.
 * @returns 0 always: a flag never comes back on the item system's own timer.
 */
function teamTouchOurFlag(level: Level, ent: GameEntity, other: GameEntity, team: number): number {
  const cl = other.client!;
  const enemyFlag = cl.sess.sessionTeam === TEAM.RED ? PW.BLUEFLAG : PW.REDFLAG;

  if (ent.flags & FL.DROPPED_ITEM) {
    // "hey, it's not home. return it by teleporting it back".
    printMsg(level, null, `${cl.pers.netname}^7 returned the ${teamName(team)} flag!\n`);
    level.itemMatch.addScore(other, ent.r.currentOrigin, CTF_RECOVERY_BONUS);
    cl.pers.teamState.flagrecovery++;
    cl.pers.teamState.lastreturnedflag = level.time;
    // "ResetFlag will remove this entity! We must return zero".
    teamReturnFlagSound(level, teamResetFlag(level, team), team);
    return 0;
  }

  // "the flag is at home base. if the player has the enemy flag, he's just won!"
  if (!cl.ps.powerups[enemyFlag]) return 0;

  printMsg(level, null, `${cl.pers.netname}^7 captured the ${teamName(otherTeam(team))} flag!\n`);
  cl.ps.powerups[enemyFlag] = 0;

  level.teamgame.lastFlagCapture = level.time;
  level.teamgame.lastCaptureTeam = team;

  addTeamScore(level, ent.s.pos.trBase, cl.sess.sessionTeam, 1);
  teamForceGesture(level, cl.sess.sessionTeam);

  cl.pers.teamState.captures++;
  awardSprite(cl, EF_AWARD_CAP, level.time);
  cl.ps.persistant[PERS.CAPTURES]++;

  // "other gets another 10 frag bonus" — the comment kept id's Team Arena number; baseq3's is 5.
  level.itemMatch.addScore(other, ent.r.currentOrigin, CTF_CAPTURE_BONUS);

  teamCaptureFlagSound(level, ent, team);

  // "Ok, let's do the player loop, hand out the bonuses".
  for (let i = 0; i < level.maxclients; i++) {
    const player = level.gentities[i];
    // "also make sure we don't award assist bonuses to the flag carrier himself". Quake 3 reads
    // the client straight off the entity, since every slot below `maxclients` that is in use has
    // one; the port asks, because the field can be null in its own types.
    if (!player.inuse || player === other || !player.client) continue;
    const pc = player.client;

    if (pc.sess.sessionTeam !== cl.sess.sessionTeam) {
      pc.pers.teamState.lasthurtcarrier = -5;
      continue;
    }

    // Team Arena pays every team mate `CTF_TEAM_BONUS` here; baseq3's is 0 and the call is
    // inside the `MISSIONPACK` block, so there is nothing to port.
    if (pc.pers.teamState.lastreturnedflag + CTF_RETURN_FLAG_ASSIST_TIMEOUT > level.time) {
      level.itemMatch.addScore(player, ent.r.currentOrigin, CTF_RETURN_FLAG_ASSIST_BONUS);
      // The *capturer's* assist count goes up, not the assister's. Quake 3 writes `other` in
      // both branches; the number the scoreboard shows is `PERS_ASSIST_COUNT` below it.
      cl.pers.teamState.assists++;
      pc.ps.persistant[PERS.ASSIST_COUNT]++;
      awardSprite(pc, EF_AWARD_ASSIST, level.time);
    }
    if (pc.pers.teamState.lastfraggedcarrier + CTF_FRAG_CARRIER_ASSIST_TIMEOUT > level.time) {
      level.itemMatch.addScore(player, ent.r.currentOrigin, CTF_FRAG_CARRIER_ASSIST_BONUS);
      cl.pers.teamState.assists++;
      pc.ps.persistant[PERS.ASSIST_COUNT]++;
      awardSprite(pc, EF_AWARD_ASSIST, level.time);
    }
  }

  teamResetFlags(level, level.itemMatch.gametype());
  level.itemMatch.calculateRanks();

  return 0; // "Do not respawn this automatically".
}

/**
 * `Team_TouchEnemyFlag` (`g_team.c:798–834`): a player walked into the other side's flag and is
 * now carrying it.
 *
 * The flag becomes a powerup on the player, held until a time nothing counts down to, which is
 * how everything downstream knows they have it: the HUD, the carrier's light, and
 * `TossClientItems`, which drops it when they die.
 *
 * @param level - The match.
 * @param ent - The flag that was touched.
 * @param other - The player who took it.
 * @param team - Whose flag it is, which is not the player's side.
 * @returns −1: never respawn it, but do free it if it was the dropped one.
 */
function teamTouchEnemyFlag(
  level: Level,
  ent: GameEntity,
  other: GameEntity,
  team: number
): number {
  const cl = other.client!;
  printMsg(level, null, `${cl.pers.netname}^7 got the ${teamName(team)} flag!\n`);

  if (team === TEAM.RED) cl.ps.powerups[PW.REDFLAG] = FLAG_NEVER_EXPIRES;
  else cl.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;

  setFlagStatus(level, team, FLAG.TAKEN);

  // Team Arena pays `CTF_FLAG_BONUS` for the grab; baseq3's is 0 and the call is not compiled.
  cl.pers.teamState.flagsince = level.time;
  teamTakeFlagSound(level, ent, team);

  return -1;
}

/**
 * `Team_CheckHurtCarrier` (`g_team.c:478–505`): remember whoever hurts the other side's carrier,
 * so that killing them a moment later is worth something.
 *
 * `G_Damage` calls it on every hit in CTF (`g_combat.c:1010–1017`). The clock it writes is read
 * by {@link teamFragBonuses}, and cleared the moment the carrier dies.
 *
 * @param level - The match.
 * @param targ - Who was hit.
 * @param attacker - Who hit them.
 */
export function teamCheckHurtCarrier(level: Level, targ: GameEntity, attacker: GameEntity): void {
  if (!targ.client || !attacker.client) return;

  const flag = targ.client.sess.sessionTeam === TEAM.RED ? PW.BLUEFLAG : PW.REDFLAG;
  const sides = targ.client.sess.sessionTeam !== attacker.client.sess.sessionTeam;
  // Team Arena's skull carrier is the second half of the C and has no baseq3 item.
  if (targ.client.ps.powerups[flag] && sides) {
    attacker.client.pers.teamState.lasthurtcarrier = level.time;
  }
}

/**
 * `CheckAlmostCapture` (`g_combat.c:348–395`): a carrier killed within 200 units of their own flag,
 * with it at home, was a step from a capture — "holy shit", to them and to whoever killed them.
 *
 * The flag at home is found by its classname, passing over one lying where it was dropped, and is
 * at home while clients are sent it: a taken flag is hidden (`SVF_NOCLIENT`). Team Arena's neutral
 * flag is the third powerup Quake 3 looks for.
 *
 * @param self - Who is dying.
 * @param attacker - Who killed them, or the world's entity.
 */
export function checkAlmostCapture(level: Level, self: GameEntity, attacker: GameEntity): void {
  const client = self.client;
  if (!client || level.itemMatch.gametype() !== GT.CTF) return;
  if (!client.ps.powerups[PW.REDFLAG] && !client.ps.powerups[PW.BLUEFLAG]) return;

  const classname =
    client.sess.sessionTeam === TEAM.BLUE ? 'team_CTF_blueflag' : 'team_CTF_redflag';
  let flag = level.find(null, 'classname', classname);
  while (flag && flag.flags & FL.DROPPED_ITEM) flag = level.find(flag, 'classname', classname);
  if (!flag || flag.r.svFlags & SVF.NOCLIENT) return;

  if (length(sub(client.ps.origin, flag.s.origin)) < 200) {
    client.ps.persistant[PERS.PLAYEREVENTS] ^= PLAYEREVENT.HOLYSHIT;
    if (attacker.client) attacker.client.ps.persistant[PERS.PLAYEREVENTS] ^= PLAYEREVENT.HOLYSHIT;
  }
}

/**
 * `Team_FragBonuses` (`g_team.c:271–468`): what a kill in Capture the Flag is worth beyond the
 * frag itself.
 *
 * "Note that bonuses are not cumulative. You get one, they are in importance order" — and the
 * order is the whole of it: killing the carrier, then killing whoever has just hurt *your*
 * carrier, then a kill near your own flag, then a kill near your own carrier. Each one returns.
 *
 * Quake 3 takes an `inflictor` it never reads in baseq3, so the port does not ask for one.
 *
 * @param level - The match.
 * @param targ - Who died.
 * @param attacker - Who killed them.
 */
export function teamFragBonuses(level: Level, targ: GameEntity, attacker: GameEntity): void {
  // "No bonus for fragging yourself or team mates." The first of those is belt and braces:
  // you are on your own team, so `OnSameTeam` answers for a suicide in any team game, and below
  // `GT_TEAM` the side lookup a few lines down returns before anything is paid.
  const gametype = level.itemMatch.gametype();
  if (!targ.client || !attacker.client) return;
  if (targ === attacker || onSameTeam(gametype, targ, attacker)) return;

  const team = targ.client.sess.sessionTeam;
  const other = otherTeam(team);
  const flagPw = team === TEAM.RED ? PW.REDFLAG : PW.BLUEFLAG;
  const enemyFlagPw = team === TEAM.RED ? PW.BLUEFLAG : PW.REDFLAG;
  const aState = attacker.client.pers.teamState;

  // "Did the attacker frag the flag carrier?"
  if (targ.client.ps.powerups[enemyFlagPw]) {
    aState.lastfraggedcarrier = level.time;
    level.itemMatch.addScore(attacker, targ.r.currentOrigin, CTF_FRAG_CARRIER_BONUS);
    aState.fragcarrier++;
    printMsg(
      level,
      null,
      `${attacker.client.pers.netname}^7 fragged ${teamName(team)}'s flag carrier!\n`
    );

    // "The target had the flag, clear the hurt carrier field on the other team": the danger is
    // over, so nobody may still be paid for having been near it.
    for (let i = 0; i < level.maxclients; i++) {
      const ent = level.gentities[i];
      if (ent.inuse && ent.client && ent.client.sess.sessionTeam === other) {
        ent.client.pers.teamState.lasthurtcarrier = 0;
      }
    }
    return;
  }

  // Killing somebody who has just hurt your own carrier — but not while you are carrying a flag
  // yourself, since then you are the one being defended.
  if (
    targ.client.pers.teamState.lasthurtcarrier &&
    level.time - targ.client.pers.teamState.lasthurtcarrier < CTF_CARRIER_DANGER_PROTECT_TIMEOUT &&
    !attacker.client.ps.powerups[flagPw]
  ) {
    level.itemMatch.addScore(attacker, targ.r.currentOrigin, CTF_CARRIER_DANGER_PROTECT_BONUS);
    aState.carrierdefense++;
    targ.client.pers.teamState.lasthurtcarrier = 0;
    attacker.client.ps.persistant[PERS.DEFEND_COUNT]++;
    awardSprite(attacker.client, EF_AWARD_DEFEND, level.time);
    return;
  }

  // "Flag and flag carrier area defense bonuses. We have to find the flag and carrier entities."
  let classname: string;
  if (attacker.client.sess.sessionTeam === TEAM.RED) classname = 'team_CTF_redflag';
  else if (attacker.client.sess.sessionTeam === TEAM.BLUE) classname = 'team_CTF_blueflag';
  else return;

  // "Find attacker's team's flag carrier". Quake 3 walks every client and takes the first that
  // holds it, so a side with two of them — which cannot happen — would defend only the first.
  let carrier: GameEntity | null = null;
  for (let i = 0; i < level.maxclients; i++) {
    const ent = level.gentities[i];
    if (ent.inuse && ent.client && ent.client.ps.powerups[flagPw]) {
      carrier = ent;
      break;
    }
  }

  // The flag on its stand, not one lying on the floor: a dropped flag defends nothing.
  let flag: GameEntity | null = null;
  for (
    let found = level.find(null, 'classname', classname);
    found;
    found = level.find(found, 'classname', classname)
  ) {
    if (!(found.flags & FL.DROPPED_ITEM)) {
      flag = found;
      break;
    }
  }
  if (!flag) return; // "Can't find attacker's flag."

  // "Check to see if we are defending the base's flag": near enough, and in sight of it, counts
  // whether it was the killer or the killed who was there. Quake 3 also asks here that the two are
  // on different sides, which the `OnSameTeam` at the top has already settled — the same test
  // twice.
  const nearFlag =
    (length(sub(targ.r.currentOrigin, flag.r.currentOrigin)) < CTF_TARGET_PROTECT_RADIUS &&
      level.inPVS(flag.r.currentOrigin, targ.r.currentOrigin)) ||
    (length(sub(attacker.r.currentOrigin, flag.r.currentOrigin)) < CTF_TARGET_PROTECT_RADIUS &&
      level.inPVS(flag.r.currentOrigin, attacker.r.currentOrigin));
  if (nearFlag) {
    level.itemMatch.addScore(attacker, targ.r.currentOrigin, CTF_FLAG_DEFENSE_BONUS);
    aState.basedefense++;
    attacker.client.ps.persistant[PERS.DEFEND_COUNT]++;
    awardSprite(attacker.client, EF_AWARD_DEFEND, level.time);
    return;
  }

  if (carrier && carrier !== attacker && carrier.client) {
    const nearCarrier =
      (length(sub(targ.r.currentOrigin, carrier.r.currentOrigin)) < CTF_ATTACKER_PROTECT_RADIUS &&
        level.inPVS(carrier.r.currentOrigin, targ.r.currentOrigin)) ||
      (length(sub(attacker.r.currentOrigin, carrier.r.currentOrigin)) <
        CTF_ATTACKER_PROTECT_RADIUS &&
        level.inPVS(carrier.r.currentOrigin, attacker.r.currentOrigin));
    if (nearCarrier) {
      level.itemMatch.addScore(attacker, targ.r.currentOrigin, CTF_CARRIER_PROTECT_BONUS);
      aState.carrierdefense++;
      attacker.client.ps.persistant[PERS.DEFEND_COUNT]++;
      awardSprite(attacker.client, EF_AWARD_DEFEND, level.time);
    }
  }
}

/**
 * `Pickup_Team` (`g_team.c:836–895`): the flags' own pickup, which is unlike every other item's.
 *
 * It is here rather than in `item-touch.ts` because it is `g_team.c`'s, and the item half reaches
 * it through {@link import('./item-touch').ItemMatch} so the two files stay one way round —
 * Quake 3's `g_items.c` and `g_team.c` call each other, which a module cannot.
 *
 * The flag's own team decides which of the two touches runs, and a classname that is neither is
 * told to the player rather than the console, because it means the map is wrong.
 *
 * @param level - The match.
 * @param ent - The flag.
 * @param other - The player who touched it.
 * @returns what `Touch_Item` should do with the flag: 0 to leave it alone, −1 to remove it.
 */
export function pickupTeam(level: Level, ent: GameEntity, other: GameEntity): number {
  const cl = other.client!;

  let team: number;
  if (ent.classname === 'team_CTF_redflag') team = TEAM.RED;
  else if (ent.classname === 'team_CTF_blueflag') team = TEAM.BLUE;
  else {
    printMsg(level, other.s.number, "Don't know what team the flag is on.\n");
    return 0;
  }

  if (team === cl.sess.sessionTeam) return teamTouchOurFlag(level, ent, other, team);
  return teamTouchEnemyFlag(level, ent, other, team);
}
