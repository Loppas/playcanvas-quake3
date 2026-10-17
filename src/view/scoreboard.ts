import { GT, RANK_TIED_FLAG, TEAM } from '../sim/constants';
import type { ClientInfo } from './client-info';
import { placeString } from './place-string';
import type { ModelSkin } from './player-model';
import { EMPTY_SCORES, type ScoreEntry, type Scores } from './scores';

/**
 * `CG_DrawOldScoreboard` (`cg_scoreboard.c:266–422`) and the key that works it
 * (`CG_ScoresDown_f`/`CG_ScoresUp_f`, `cg_consolecmds.c:87–116`): when the board shows, the lines
 * above it, and the rows the last `scores` command carried. Engine-free, so every rule is tested
 * without a device.
 *
 * The look is the port's own, in the menu's idiom; what it draws is Q3's data — the rows in
 * the order the server sent them, the place and score lines, and the READY bits. Q3's bar geometry
 * and its head and marker art are not reproduced, so the list is cut at the port's own row count
 * instead of Q3's seven.
 */

/** `FADE_TIME` (`cg_local.h:37`): how long the board takes to go after the key is let go. */
export const FADE_TIME = 200;

/** How stale the cache has to be before a press asks for fresh scores (`cg_consolecmds.c:92`). */
export const SCORES_REQUEST_TIME = 2000;

/** How many rows the port's board draws before it cuts the list short (port-native). */
export const MAX_ROWS = 16;

/** What the board remembers from frame to frame: `cg`'s own scoreboard fields. */
export interface ScoreboardState {
  /** `cg.showScores`: the scores key is held. */
  showScores: boolean;
  /** `cg.scoresRequestTime`: when the cache was last asked to be refreshed. */
  scoresRequestTime: number;
  /** `cg.scoreFadeTime`: when the key was let go, which the fade runs from. */
  scoreFadeTime: number;
  /** `cg.killerName`: who last fragged the player, for the line above the rows. */
  killerName: string;
  /** `cg.numScores = 0`: the cache was cleared and the fresh board has not arrived. */
  cleared: boolean;
  /** The board as it was when it was cleared, so that the fresh one is known by arriving. */
  clearedBoard: Scores;
  /** `cg.deferredPlayerLoading`: how many frames the board has been up. */
  deferredPlayerLoading: number;
}

/**
 * How many frames the board is up before the looks put off are loaded under it
 * (`cg_scoreboard.c:416–419`).
 */
export const DEFERRED_LOAD_FRAMES = 10;

/** A board nothing has been sent for: `cg.scores` before any `scores` command. */
export function createScoreboardState(): ScoreboardState {
  return {
    showScores: false,
    scoresRequestTime: 0,
    scoreFadeTime: 0,
    killerName: '',
    cleared: false,
    clearedBoard: EMPTY_SCORES,
    deferredPlayerLoading: 0
  };
}

/**
 * `CG_ScoresDown_f` (`cg_consolecmds.c:87–109`): the key went down.
 *
 * When the cache is over {@link SCORES_REQUEST_TIME} old it is asked to be refreshed, and a board
 * that was not already up is cleared so the stale rows are not shown while the fresh ones are on
 * their way. A press within the window shows the cache.
 *
 * @returns whether `score` should be sent to the server.
 */
export function scoresDown(state: ScoreboardState, time: number, board: Scores): boolean {
  if (state.scoresRequestTime + SCORES_REQUEST_TIME < time) {
    state.scoresRequestTime = time;
    if (!state.showScores) {
      state.showScores = true;
      state.cleared = true;
      state.clearedBoard = board;
    }
    return true;
  }
  state.showScores = true;
  return false;
}

/** `CG_ScoresUp_f` (`cg_consolecmds.c:111–116`): the key came up, and the fade starts. */
export function scoresUp(state: ScoreboardState, time: number): void {
  if (!state.showScores) return;
  state.showScores = false;
  state.scoreFadeTime = time;
}

/** What the board reads this frame. */
export interface ScoreboardInput {
  /** `cg.time`. */
  time: number;
  /** `cg_paused`: the menu or the console is up, so the board never draws. */
  paused: boolean;
  /** `CS_WARMUP`: non-zero while the match waits. */
  warmup: number;
  /** `pm_type == PM_DEAD`. */
  dead: boolean;
  /** `pm_type == PM_INTERMISSION`. */
  intermission: boolean;
  /**
   * `PMF_SCOREBOARD` on a spectator: the board is this client's whole screen, which
   * `CG_DrawActive` draws in the world's place (`cg_draw.c:2636–2642`).
   */
  scoreboardSpectator: boolean;
  /** `g_gametype`, which picks the rows' order and the line above them. */
  gametype: number;
  /** `ps.clientNum`: the player's own slot. */
  clientNum: number;
  /** `PERS_RANK`, with `RANK_TIED_FLAG` for a tie. */
  rank: number;
  /** `PERS_SCORE`. */
  score: number;
  /** `PERS_TEAM`. */
  team: number;
  /** `cg.scores` and `cg.teamScores`: the last board the server sent. */
  scores: Scores;
  /** `STAT_CLIENTS_READY`: the intermission's ready bits, one per slot. */
  ready: number;
  /** `cgs.clientinfo`: who is in each slot. */
  clientInfo: (clientNum: number) => ClientInfo | null;
  /** The player's own death this frame: `CG_Obituary`'s killer, or `null` for none. */
  killedBy: string | null;
}

/** One client's row, as the board draws it. */
export interface ScoreboardRow {
  /** The slot the row belongs to. */
  client: number;
  /** `PERS_TEAM` as the client's own string has it, which the board blocks its rows by. */
  team: number;
  /** The name from `CS_PLAYERS`, colour codes and all. */
  name: string;
  /** The head they wear, which the row's portrait is drawn from; empty with no client info. */
  head: ModelSkin;
  /** Drawn in a loaded client's look meanwhile, which crosses the portrait out (`CG_DrawHead`). */
  deferred: boolean;
  /** The score column: the score, `SPECT` for a spectator, or `connecting`. */
  score: string;
  ping: string;
  time: string;
  /** The damage given, for Clan Arena's Dmg column; empty while connecting. */
  damage: string;
  spectator: boolean;
  /** Still joining: `ping == -1`. */
  connecting: boolean;
  /** The player's own row. */
  you: boolean;
  /** `STAT_CLIENTS_READY` has this row's bit: the intermission's marker. */
  ready: boolean;
  /** The marker column: a bot's skill, and the handicap below 100. */
  botSkill: number;
  handicap: number;
  /** The entity's powerup bits, which a carried flag reads. */
  powerups: number;
}

/** The board for a frame. */
export interface Scoreboard {
  /** 1 while it is held, dead or at the intermission; otherwise 1 down to 0 over the fade. */
  fade: number;
  /**
   * The own row's place for its fill, which is the colour it is drawn in
   * (`CG_DrawClientScore`, `cg_scoreboard.c:190–212`): `PERS_RANK` without the tie in a
   * free-for-all, or −1 where Q3 draws no place — a team game, or watching as a spectator.
   */
  rank: number;
  /** The lines above the rows: "Fragged by X", the place, or which team leads. */
  lines: string[];
  rows: ScoreboardRow[];
  /** The player's own row, when the list was cut short before it (`cg_scoreboard.c:406–414`). */
  foot: ScoreboardRow | null;
  /** Clan Arena's board, whose Dmg column stands between the time and the name (CPMA's). */
  damageColumn: boolean;
  /**
   * The board has been up long enough for the looks put off to be loaded under it, which it asks
   * for every frame from then on (`CG_LoadDeferredPlayers`, `cg_scoreboard.c:416–419`).
   */
  loadDeferred: boolean;
}

/**
 * The board for this frame, in `CG_DrawOldScoreboard`'s terms (`cg_scoreboard.c:266–305`).
 *
 * Never under the menu; in warmup only while the key is held; full while the key is held, while
 * dead or at the intermission; otherwise the fade the release started. When the fade runs out the
 * killer line is cleared, as Q3 clears it, "so the next time the board comes up it is not printed".
 * The frames it has been up are counted, and start again under the menu or once it has faded.
 *
 * Moves `state` on: the killer's name from the death's event, the cleared cache's end, and the
 * count.
 */
export function scoreboardFrame(state: ScoreboardState, input: ScoreboardInput): Scoreboard | null {
  if (input.killedBy !== null) state.killerName = input.killedBy;
  if (state.cleared && input.scores !== state.clearedBoard) state.cleared = false;

  if (input.paused) {
    state.deferredPlayerLoading = 0;
    return null;
  }
  // The scoreboard spectator's board is drawn before any of this, in the world's own place, so
  // nothing a match is doing takes it away — not even a warmup.
  if (input.warmup !== 0 && !state.showScores && !input.scoreboardSpectator) return null;

  let fade: number;
  if (state.showScores || input.dead || input.intermission || input.scoreboardSpectator) {
    fade = 1;
  } else {
    const elapsed = input.time - state.scoreFadeTime;
    if (state.scoreFadeTime === 0 || elapsed >= FADE_TIME) {
      state.deferredPlayerLoading = 0;
      state.killerName = '';
      return null;
    }
    fade = Math.min(1, (FADE_TIME - elapsed) / FADE_TIME);
  }

  const lines: string[] = [];
  if (state.killerName !== '') lines.push(`Fragged by ${state.killerName}`);
  if (input.gametype < GT.TEAM) {
    if (input.team !== TEAM.SPECTATOR) {
      lines.push(`${placeString(input.rank + 1)} place with ${input.score}`);
    }
  } else {
    const [red, blue] = input.scores.teamScores;
    if (red === blue) lines.push(`Teams are tied at ${red}`);
    else if (red > blue) lines.push(`Red leads ${red} to ${blue}`);
    else lines.push(`Blue leads ${blue} to ${red}`);
  }

  const ordered = state.cleared ? [] : orderRows(input);
  const rows = ordered.slice(0, MAX_ROWS);
  const own = ordered.find((entry) => entry.client === input.clientNum);
  const foot = own !== undefined && !rows.includes(own) ? row(own, input) : null;
  // The own row's fill reads no place in a team game, or as a spectator (`cg_scoreboard.c:190–195`).
  const rank =
    input.team === TEAM.SPECTATOR || input.gametype >= GT.TEAM ? -1 : input.rank & ~RANK_TIED_FLAG;
  return {
    fade,
    rank,
    lines,
    rows: rows.map((entry) => row(entry, input)),
    foot,
    damageColumn: input.gametype === GT.CA,
    loadDeferred: ++state.deferredPlayerLoading > DEFERRED_LOAD_FRAMES
  };
}

/**
 * The board as one who watches from outside the match sees it: a server's status in the server
 * browser, which carries the board a client would be sent. It is always up, with no row of the
 * watcher's own, no place line, and the leading team's line in a team game.
 *
 * @param gametype - The server's `g_gametype`.
 * @param clientInfo - Each slot's `CS_PLAYERS` string, read.
 */
export function spectatorBoard(
  gametype: number,
  scores: Scores,
  clientInfo: (clientNum: number) => ClientInfo | null
): Scoreboard {
  return scoreboardFrame(createScoreboardState(), {
    time: 0,
    paused: false,
    warmup: 0,
    dead: false,
    intermission: false,
    scoreboardSpectator: true,
    gametype,
    clientNum: -1,
    rank: 0,
    score: 0,
    team: TEAM.SPECTATOR,
    scores,
    ready: 0,
    clientInfo,
    killedBy: null
  })!;
}

/** The rows in Q3's order: the players by the sent order, then the spectators (`:396–404`). */
function orderRows(input: ScoreboardInput): ScoreEntry[] {
  const entries = input.scores.scores.slice(0, input.scores.numScores);
  const of = (team: number) =>
    entries.filter((entry) => (input.clientInfo(entry.client)?.team ?? TEAM.FREE) === team);

  if (input.gametype < GT.TEAM) return [...of(TEAM.FREE), ...of(TEAM.SPECTATOR)];

  // A team game leads with the leading team, red on a tie, then the other, then the spectators.
  const [red, blue] = input.scores.teamScores;
  const teams = red >= blue ? [TEAM.RED, TEAM.BLUE] : [TEAM.BLUE, TEAM.RED];
  return [...teams.flatMap((team) => of(team)), ...of(TEAM.SPECTATOR)];
}

/** One row, as `CG_DrawClientScore` writes its line (`cg_scoreboard.c:171–181`). */
function row(entry: ScoreEntry, input: ScoreboardInput): ScoreboardRow {
  const info = input.clientInfo(entry.client);
  const connecting = entry.ping === -1;
  const team = info?.team ?? TEAM.FREE;
  const spectator = team === TEAM.SPECTATOR;
  return {
    client: entry.client,
    team,
    name: info?.name ?? '',
    head: info?.look.head ?? { model: '', skin: '' },
    deferred: info?.deferred ?? false,
    score: connecting ? 'connecting' : spectator ? 'SPECT' : `${entry.score}`,
    ping: connecting ? '' : `${entry.ping}`,
    time: connecting ? '' : `${entry.time}`,
    damage: connecting ? '' : `${entry.damage}`,
    spectator,
    connecting,
    you: entry.client === input.clientNum,
    ready: (input.ready & (1 << entry.client)) !== 0,
    botSkill: info?.botSkill ?? 0,
    handicap: info?.handicap ?? 0,
    powerups: entry.powerups
  };
}
