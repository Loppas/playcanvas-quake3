import { atoi } from '../formats/c-scan';
import { MAX_CLIENTS } from '../net/protocol';

/**
 * `CG_ParseScores` (`cg_servercmds.c:57–108`): the board the server last sent, read out of the
 * `scores` command's words.
 *
 * The numbers are Q3's own and in Q3's order — fourteen per client, the first at `CG_Argv(4)` —
 * and then the port's fifteenth, the damage given. The list is cleared on every message, so a
 * client never reads a row the server has stopped sending. A name, a team and a look come from
 * `CS_PLAYERS`; this is only what the board carries.
 */

/** `score_t` (`cg_local.h:283–299`): one client's row, as the server sent it. */
export interface ScoreEntry {
  /** The slot, which is how the row is joined to its `CS_PLAYERS` string. */
  client: number;
  /** `PERS_SCORE`. */
  score: number;
  /** −1 while connecting, otherwise the measured ping capped at 999. */
  ping: number;
  /** Whole minutes since the client entered. */
  time: number;
  /** Always 0, as the server writes it. */
  scoreFlags: number;
  /** The entity's powerup bits, which the board reads the flag icons from. */
  powerups: number;
  /** Hits as a percentage of shots, or 0 with no shots. */
  accuracy: number;
  impressiveCount: number;
  excellentCount: number;
  gauntletCount: number;
  defendCount: number;
  assistCount: number;
  /** 1 for the first place with no deaths. */
  perfect: number;
  captures: number;
  /** The damage given, which Clan Arena's board shows: the port's own number, after Q3's. */
  damage: number;
}

/** One `scores` command's content: the rows, and the two team scores above them. */
export interface Scores {
  /** How many of {@link scores} the server sent; the rest are zeroed. */
  numScores: number;
  /** `cg.teamScores`: red then blue, as `CG_Argv(2)` and `CG_Argv(3)`. */
  teamScores: [number, number];
  /** One row per client slot, `MAX_CLIENTS` of them, cleared where the server sent none. */
  scores: ScoreEntry[];
}

/** A row with nothing on it, which is what `memset( cg.scores, 0, … )` leaves. */
function zeroScore(): ScoreEntry {
  return {
    client: 0,
    score: 0,
    ping: 0,
    time: 0,
    scoreFlags: 0,
    powerups: 0,
    accuracy: 0,
    impressiveCount: 0,
    excellentCount: 0,
    gauntletCount: 0,
    defendCount: 0,
    assistCount: 0,
    perfect: 0,
    captures: 0,
    damage: 0
  };
}

/** The board before one has been sent: the slots cleared, as a static `cg.scores` starts. */
export const EMPTY_SCORES: Scores = {
  numScores: 0,
  teamScores: [0, 0],
  scores: Array.from({ length: MAX_CLIENTS }, zeroScore)
};

/** How many numbers one row carries, which is the stride the rows are read at. */
const NUM_SCORE_FIELDS = 15;

/**
 * Read a `scores` command, as `CG_ParseScores` reads one.
 *
 * @param argv - The command, split as `Cmd_TokenizeString` splits it, `argv[0]` being `scores`.
 * @returns the rows it carried, the count and the team scores.
 */
export function parseScores(argv: readonly string[]): Scores {
  // "cg.numScores = atoi( CG_Argv( 1 ) )" (`:61–64`): never more rows than there are slots.
  const numScores = Math.min(atoi(argv[1] ?? ''), MAX_CLIENTS);
  const scores = Array.from({ length: MAX_CLIENTS }, zeroScore);

  for (let i = 0; i < numScores; i++) {
    const base = i * NUM_SCORE_FIELDS + 4;
    const at = (offset: number): number => atoi(argv[base + offset] ?? '');
    const score = scores[i];

    // "cg.scores[i].client = atoi( CG_Argv( i * 14 + 4 ) )" (`:68`), at the port's stride of 15,
    // and a slot that is not one is
    // read as the first rather than left to point outside the list (`:85–87`).
    score.client = at(0);
    if (score.client < 0 || score.client >= MAX_CLIENTS) score.client = 0;
    score.score = at(1);
    score.ping = at(2);
    score.time = at(3);
    score.scoreFlags = at(4);
    score.powerups = at(5);
    score.accuracy = at(6);
    score.impressiveCount = at(7);
    score.excellentCount = at(8);
    score.gauntletCount = at(9);
    score.defendCount = at(10);
    score.assistCount = at(11);
    score.perfect = at(12);
    score.captures = at(13);
    score.damage = at(14);
  }

  return { numScores, teamScores: [atoi(argv[2] ?? ''), atoi(argv[3] ?? '')], scores };
}
