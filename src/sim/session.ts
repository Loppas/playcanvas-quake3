import type { CvarStore } from '../net/cvar';
import { infoValueForKey } from '../net/info';
import { SPECTATOR, type ClientSession } from './client';
import { GT, TEAM } from './constants';

/**
 * `g_session.c`: the one lifetime that survives a map change, and how.
 *
 * A game module is unloaded and loaded again between maps, so nothing in its memory crosses the
 * gap. Quake 3 gets a client's session across anyway by writing it into cvars — `session0`,
 * `session1`, one per slot — at shutdown, and reading it back when that slot connects again. The
 * cvars are the storage; this file is the two ends of it.
 *
 * That is also why the format is seven integers in a string rather than a struct: it has to
 * survive `Cvar_Set`, which only knows about strings.
 */

/** The cvar a slot's session lives in between maps. */
export function sessionCvar(clientNum: number): string {
  return `session${clientNum}`;
}

/**
 * `G_WriteClientSessionData` (`g_session.c:43–60`): put this client's session where a new map can
 * find it.
 *
 * @param cvars - The cvar store.
 * @param clientNum - The slot, which names the cvar.
 * @param sess - The session to write.
 */
export function writeClientSessionData(
  cvars: CvarStore,
  clientNum: number,
  sess: ClientSession
): void {
  const value = [
    sess.sessionTeam,
    sess.spectatorNum,
    sess.spectatorState,
    sess.spectatorClient,
    sess.wins,
    sess.losses,
    sess.teamLeader ? 1 : 0
  ].join(' ');

  cvars.set(sessionCvar(clientNum), value);
}

/**
 * `G_ReadSessionData` (`g_session.c:69–92`): read a session back on a reconnect.
 *
 * Quake 3 reads it with `sscanf`, which assigns only the fields it managed to match and leaves
 * the rest of the struct alone — so a cvar that was never written leaves the session at whatever
 * `G_InitSessionData` just put there. That is not an accident to be tidied up: it is how a
 * first-time connect survives reading a session that does not exist yet.
 *
 * @param cvars - The cvar store.
 * @param clientNum - The slot, which names the cvar.
 * @param sess - The session to read into, in place.
 */
export function readClientSessionData(
  cvars: CvarStore,
  clientNum: number,
  sess: ClientSession
): void {
  const fields = cvars
    .get(sessionCvar(clientNum))
    .split(/\s+/)
    .filter((field) => field.length > 0)
    .map((field) => Number.parseInt(field, 10));

  // `sscanf` stops at the first field it cannot match and leaves that one and every field after
  // it alone, so a truncated or corrupt cvar loses the tail rather than the whole session.
  const assign = (index: number, set: (value: number) => void): void => {
    if (index < fields.length && Number.isFinite(fields[index])) set(fields[index]);
    else fields.length = index;
  };

  assign(0, (value) => (sess.sessionTeam = value));
  assign(1, (value) => (sess.spectatorNum = value));
  assign(2, (value) => (sess.spectatorState = value));
  assign(3, (value) => (sess.spectatorClient = value));
  assign(4, (value) => (sess.wins = value));
  assign(5, (value) => (sess.losses = value));
  assign(6, (value) => (sess.teamLeader = value !== 0));
}

/** What `G_InitSessionData` needs to know about the match it is joining. */
export interface SessionInit {
  /** `g_gametype`. */
  gametype: number;
  /** `g_maxGameClients`: how many may play at once, or 0 for no limit. */
  maxGameClients: number;
  /** `level.numNonSpectatorClients` as it stands, which decides whether there is room. */
  numNonSpectatorClients: number;
  /** `pers.localClient`: this client shares the host's process. */
  localClient: boolean;
}

/**
 * `G_InitSessionData` (`g_session.c:102–161`): what team a client starts on, the first time it
 * ever connects.
 *
 * The rule is the same shape in every gametype — spectate unless there is room to play — and only
 * the meaning of "room" changes: a tournament seats two, a free-for-all seats `g_maxGameClients`,
 * and a team game seats nobody until they pick a side. A client that asked for `s` in its
 * `teampref` is a willing spectator and is seated nowhere at all.
 *
 * The side itself is not decided here. Quake 3 calls `SetTeam` from inside this function, which
 * kills and respawns and announces; the port hands the word back to the match instead and lets it
 * make that call, as it already does with the tournament queue this ends on.
 *
 * @param cvars - The cvar store, which holds `g_localTeamPref` and `g_teamAutoJoin`.
 * @param clientNum - The slot, which names the session's own cvar.
 * @param sess - The session to fill in, in place.
 * @param userinfo - The client's userinfo, read for `teampref`.
 * @param init - The match this client is joining.
 * @returns The word to hand `SetTeam`, or null for a client that stays where this put them. An
 *   empty string is a word: it is what `g_teamAutoJoin` asks with, and it means whichever side is
 *   behind.
 */
export function initClientSessionData(
  cvars: CvarStore,
  clientNum: number,
  sess: ClientSession,
  userinfo: string,
  init: SessionInit
): string | null {
  let teamPref = infoValueForKey(userinfo, 'teampref');

  // The Start Server menu's team preference, which is spent the first time it is read so that it
  // does not follow the local client into every later connection.
  if (!teamPref && init.localClient) {
    const localPref = cvars.get('g_localTeamPref');
    if (localPref) {
      teamPref = localPref;
      cvars.set('g_localTeamPref', '');
    }
  }

  let joins: string | null = null;

  if (init.gametype >= GT.TEAM) {
    // A team game always starts a client spectating, because nobody can be put on a side until
    // they or `g_teamAutoJoin` say which.
    sess.sessionTeam = TEAM.SPECTATOR;
    sess.spectatorState = SPECTATOR.FREE;

    // "Mainly for bots": a bot is given its side in its userinfo, and `addbot` writes one for
    // every bot in a team game. A human asks through the menu, or is put on a side at once if
    // the match wants everyone playing (`g_session.c:123–126`).
    const autoJoin = Number.parseInt(cvars.get('g_teamAutoJoin'), 10) || 0;
    if (teamPref || autoJoin) joins = teamPref;
  } else if (teamPref.startsWith('s')) {
    // A willing spectator, rather than someone waiting in line for a place.
    sess.sessionTeam = TEAM.SPECTATOR;
    sess.spectatorState = SPECTATOR.FREE;
  } else {
    const full =
      init.gametype === GT.TOURNAMENT
        ? init.numNonSpectatorClients >= 2
        : init.maxGameClients > 0 && init.numNonSpectatorClients >= init.maxGameClients;

    sess.sessionTeam = full ? TEAM.SPECTATOR : TEAM.FREE;
    sess.spectatorState = SPECTATOR.FREE;
  }

  writeClientSessionData(cvars, clientNum, sess);
  return joins;
}

/**
 * `G_InitWorldSession` (`g_session.c:170–183`): decide whether the sessions left behind still
 * mean anything.
 *
 * They do not if the gametype changed, because a session holds a team and a tournament record,
 * and neither survives the match becoming a different game.
 *
 * @param cvars - The cvar store.
 * @param gametype - `g_gametype` as this map is starting.
 * @param print - `G_Printf`, which says so when they are started over.
 * @returns `level.newSession`: true if every client's session must be started over.
 */
export function initWorldSession(
  cvars: CvarStore,
  gametype: number,
  print: (text: string) => void
): boolean {
  // `atoi` on a cvar that was never set gives 0, which is `GT_FFA` — so a first ever run of a
  // free-for-all keeps the sessions it has no reason to distrust.
  const previous = Number.parseInt(cvars.get('session'), 10) || 0;
  if (previous === gametype) return false;
  print('Gametype changed, clearing session data.');
  return true;
}

/**
 * `G_WriteSessionData` (`g_session.c:191–201`): called as the game module shuts down, which is
 * what actually carries every connected client's session to the next map.
 *
 * @param cvars - The cvar store.
 * @param gametype - `g_gametype`, so the next map can tell whether it changed.
 * @param sessions - The session of each client to write, by slot; `null` for a slot to skip.
 */
export function writeSessionData(
  cvars: CvarStore,
  gametype: number,
  sessions: readonly (ClientSession | null)[]
): void {
  cvars.set('session', String(gametype));

  for (let i = 0; i < sessions.length; i++) {
    const sess = sessions[i];
    if (sess) writeClientSessionData(cvars, i, sess);
  }
}
