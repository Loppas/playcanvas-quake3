import { describe, expect, it } from 'vitest';

import { GT, RANK_TIED_FLAG, TEAM } from '../sim/constants';
import type { ClientInfo } from './client-info';
import { parseScores, type Scores } from './scores';
import {
  createScoreboardState,
  DEFERRED_LOAD_FRAMES,
  FADE_TIME,
  MAX_ROWS,
  scoreboardFrame,
  scoresDown,
  scoresUp,
  spectatorBoard,
  type ScoreboardInput,
  type ScoreboardState
} from './scoreboard';

/**
 * The board as `cg_scoreboard.c` decides it: when it shows, the lines above it, and the rows the
 * last `scores` command carried. Engine-free, so every rule is tested without a device.
 */

/** A `scores` command's board, through the real parser: `rows` are fifteen numbers each. */
function board(rows: number[][], red = 0, blue = 0): Scores {
  return parseScores(['scores', String(rows.length), String(red), String(blue), ...rows.flat().map(String)]);
}

/** Fifteen numbers for one client, with `over` spread over Q3's field order and the damage. */
function row(over: Partial<Record<number, number>> = {}): number[] {
  return Array.from({ length: 15 }, (_unused, i) => over[i] ?? 0);
}

/** A client as `CS_PLAYERS` would have given them. */
function info(over: Partial<ClientInfo> = {}): ClientInfo {
  const look = { body: { model: 'sarge', skin: 'default' }, head: { model: 'sarge', skin: 'default' } };
  return { name: 'Sarge', botSkill: 0, handicap: 100, team: TEAM.FREE, look, ...over } as ClientInfo;
}

/** What the board reads this frame, with everything unremarkable. */
function input(over: Partial<ScoreboardInput> = {}): ScoreboardInput {
  return {
    time: 10_000,
    paused: false,
    warmup: 0,
    dead: false,
    intermission: false,
    scoreboardSpectator: false,
    gametype: GT.FFA,
    clientNum: 0,
    rank: 0,
    score: 0,
    team: TEAM.FREE,
    scores: board([]),
    ready: 0,
    clientInfo: () => null,
    killedBy: null,
    ...over
  };
}

/** The frame for a state and an input, or the state's own board where the input carries none. */
function frame(state: ScoreboardState, over: Partial<ScoreboardInput> = {}) {
  return scoreboardFrame(state, input(over));
}

/** The board's content with the scores key held, which is how the lines and rows are read. */
function shown(over: Partial<ScoreboardInput> = {}) {
  const state = createScoreboardState();
  scoresDown(state, 10_000, board([]));
  return scoreboardFrame(state, input(over))!;
}

describe('CG_ScoresDown_f and CG_ScoresUp_f', () => {
  it('asks for fresh scores when the cache is over two seconds old, and clears it on the first press', () => {
    const state = createScoreboardState();
    const cached = board([row({ 0: 0, 1: 7 })]);

    expect(scoresDown(state, 10_000, cached)).toBe(true);
    expect(state.showScores).toBe(true);

    // "cg.numScores = 0": the cache is not shown while the fresh board is on its way.
    const waiting = scoreboardFrame(state, input({ scores: cached }));
    expect(waiting?.rows).toHaveLength(0);

    // The message arrives as a new board, and the rows are back.
    const fresh = board([row({ 0: 0, 1: 7 })]);
    const arrived = scoreboardFrame(state, input({ scores: fresh }));
    expect(arrived?.rows).toHaveLength(1);

    // A stale press while the board is already up asks again without clearing what it holds.
    expect(scoresDown(state, 12_100, fresh)).toBe(true);
    expect(scoreboardFrame(state, input({ scores: fresh }))?.rows).toHaveLength(1);
  });

  it('shows the cache without asking when a press comes within the two seconds', () => {
    const state = createScoreboardState();
    const cached = board([row({ 0: 0, 1: 7 })]);
    expect(scoresDown(state, 10_000, cached)).toBe(true);

    scoresUp(state, 10_050);
    // Inside the window the cache is shown as it stands; at the window's own edge it is fresh.
    expect(scoresDown(state, 11_500, cached)).toBe(false);
    expect(state.showScores).toBe(true);
    // The cache as a message would leave it: a board of its own, not the one that was cleared.
    const arrived = board([row({ 0: 0, 1: 7 })]);
    expect(scoreboardFrame(state, input({ time: 11_500, scores: arrived }))?.rows).toHaveLength(1);
    expect(scoresDown(state, 12_000, cached)).toBe(false);
    // Past it, the match is asked again.
    expect(scoresDown(state, 12_001, cached)).toBe(true);
    expect(state.showScores).toBe(true);
  });

  it('starts the fade at the release, and not for a release while it was not up', () => {
    const state = createScoreboardState();
    scoresUp(state, 10_000);
    expect(state.scoreFadeTime).toBe(0);

    scoresDown(state, 10_000, board([]));
    scoresUp(state, 10_100);
    expect(state.scoreFadeTime).toBe(10_100);
  });
});

describe('when the board shows', () => {
  it('draws nothing under the menu', () => {
    const state = createScoreboardState();
    scoresDown(state, 10_000, board([]));
    expect(frame(state, { paused: true })).toBeNull();
  });

  it('draws nothing in warmup while the key is not held, and draws while it is', () => {
    const state = createScoreboardState();
    // Dead or not, a warmup the key is not held through shows no board.
    expect(frame(state, { warmup: 5_000 })).toBeNull();
    expect(frame(state, { warmup: 5_000, dead: true })).toBeNull();

    scoresDown(state, 10_000, board([]));
    expect(frame(state, { warmup: 5_000 })).not.toBeNull();
    expect(frame(state, { warmup: 5_000, dead: true })).not.toBeNull();
  });

  it('is full while the key is held, while dead, and at the intermission', () => {
    const held = createScoreboardState();
    scoresDown(held, 10_000, board([]));
    expect(frame(held, { time: 10_050 })?.fade).toBe(1);

    const dead = createScoreboardState();
    expect(frame(dead, { dead: true })?.fade).toBe(1);

    const intermission = createScoreboardState();
    expect(frame(intermission, { intermission: true })?.fade).toBe(1);
  });

  it('fades over the two hundred milliseconds after the key is let go, then goes', () => {
    const state = createScoreboardState();
    scoresDown(state, 10_000, board([]));
    scoresUp(state, 10_000);

    expect(frame(state, { time: 10_000 })?.fade).toBe(1);
    expect(frame(state, { time: 10_000 + FADE_TIME / 2 })?.fade).toBeCloseTo(0.5);
    expect(frame(state, { time: 10_000 + FADE_TIME - 1 })?.fade).toBeGreaterThan(0);
    expect(frame(state, { time: 10_000 + FADE_TIME })).toBeNull();
  });

  it('keeps the killer line while it is up and clears it when the fade is over', () => {
    const state = createScoreboardState();
    scoresDown(state, 10_000, board([]));
    scoreboardFrame(state, input({ killedBy: 'Visor' }));
    expect(state.killerName).toBe('Visor');

    // Dead: the board stays up, and the line with it.
    scoresUp(state, 10_050);
    expect(frame(state, { time: 10_100, dead: true })?.lines).toContain('Fragged by Visor');
    expect(state.killerName).toBe('Visor');

    // Alive and let go: the fade runs out, and the line goes with it.
    expect(frame(state, { time: 10_050 + FADE_TIME })).toBeNull();
    expect(state.killerName).toBe('');
  });
});

describe('the looks put off, loaded under the board', () => {
  /** Whether each of `count` frames up asked for the looks put off. */
  const asks = (state: ScoreboardState, count: number, over: Partial<ScoreboardInput> = {}) =>
    Array.from({ length: count }, () => frame(state, { dead: true, ...over })?.loadDeferred);

  it('are asked for from the eleventh frame it is up, and on every frame after', () => {
    const state = createScoreboardState();
    const asked = asks(state, DEFERRED_LOAD_FRAMES + 2);
    expect(asked.indexOf(true)).toBe(DEFERRED_LOAD_FRAMES);
    expect(asked.slice(DEFERRED_LOAD_FRAMES)).toEqual([true, true]);
  });

  it('are counted again from nothing after the menu, or once the board has faded', () => {
    const paused = createScoreboardState();
    asks(paused, DEFERRED_LOAD_FRAMES);
    expect(frame(paused, { paused: true })).toBeNull();
    expect(asks(paused, DEFERRED_LOAD_FRAMES)).not.toContain(true);

    const faded = createScoreboardState();
    asks(faded, DEFERRED_LOAD_FRAMES);
    expect(frame(faded)).toBeNull();
    expect(asks(faded, DEFERRED_LOAD_FRAMES)).not.toContain(true);
  });

  it('keep their count through a warmup that hides the board', () => {
    const state = createScoreboardState();
    asks(state, DEFERRED_LOAD_FRAMES);
    expect(frame(state, { warmup: 5_000 })).toBeNull();
    expect(asks(state, 1)).toEqual([true]);
  });

  it("cross out the row of a client drawn in another's look", () => {
    const deferred = info({ deferred: true });
    const scores = board([row({ 0: 0 }), row({ 0: 1 })]);
    const { rows } = shown({ scores, clientInfo: (n) => (n === 1 ? deferred : info()) });
    expect(rows.map((drawn) => drawn.deferred)).toEqual([false, true]);
  });
});

describe('the scoreboard spectator', () => {
  it('has the board up for good, with nothing else on the screen to take it away', () => {
    const state = createScoreboardState();

    const board = scoreboardFrame(state, input({ scoreboardSpectator: true }));

    expect(board).not.toBeNull();
    expect(board!.fade).toBe(1);
  });

  it('keeps it through a warmup, which hides everybody else\'s', () => {
    const state = createScoreboardState();
    expect(scoreboardFrame(state, input({ warmup: -1 }))).toBeNull();

    const board = scoreboardFrame(state, input({ warmup: -1, scoreboardSpectator: true }));

    expect(board).not.toBeNull();
  });
});

describe('the lines above the rows', () => {
  it('says who fragged the player', () => {
    expect(shown({ killedBy: 'Visor' }).lines[0]).toBe('Fragged by Visor');
  });

  it('says the player place and score, with Q3\'s ties and suffixes', () => {
    // The place carries Q3's colour escapes, as `CG_PlaceString` writes them.
    expect(shown({ rank: 0, score: 12 }).lines[0]).toBe('^41st^7 place with 12');
    expect(shown({ rank: 1, score: 9 }).lines[0]).toBe('^12nd^7 place with 9');
    expect(shown({ rank: 3, score: 4 }).lines[0]).toBe('4th place with 4');
    expect(shown({ rank: RANK_TIED_FLAG, score: 7 }).lines[0]).toBe('Tied for ^41st^7 place with 7');
  });

  it('draws no place line for a spectator', () => {
    expect(shown({ team: TEAM.SPECTATOR, rank: 0, score: 0 }).lines).toHaveLength(0);
  });

  it('says which team leads, or that they are tied', () => {
    const team = (red: number, blue: number) =>
      shown({ gametype: GT.TEAM, scores: board([], red, blue) }).lines[0];

    expect(team(4, 4)).toBe('Teams are tied at 4');
    expect(team(5, 3)).toBe('Red leads 5 to 3');
    expect(team(2, 6)).toBe('Blue leads 6 to 2');
  });
});

describe('the rows', () => {
  it('is one row per client the server sent, in its order, with the name and the numbers', () => {
    const drawn = shown({
      scores: board([row({ 0: 1, 1: 9, 2: 55, 3: 3 }), row({ 0: 0, 1: 4, 2: 60, 3: 1 })]),
      clientInfo: (client) => info({ name: client === 1 ? 'Visor' : 'Sarge' })
    });

    expect(drawn.rows.map((r) => [r.client, r.name, r.score, r.ping, r.time])).toEqual([
      [1, 'Visor', '9', '55', '3'],
      [0, 'Sarge', '4', '60', '1']
    ]);
    expect(drawn.rows[0]).toMatchObject({ spectator: false, connecting: false, you: false });
  });

  it('reads SPECT in a spectator\'s score place, and connecting for a client still joining', () => {
    const drawn = shown({
      scores: board([row({ 0: 1, 2: -1, 3: 0 }), row({ 0: 0, 1: 5, 2: 40, 3: 2 })]),
      clientInfo: (client) => info({ name: client === 1 ? 'Visor' : 'Sarge', team: TEAM.SPECTATOR })
    });

    expect(drawn.rows[0]).toMatchObject({ connecting: true, score: 'connecting', ping: '', time: '' });
    expect(drawn.rows[1]).toMatchObject({ spectator: true, score: 'SPECT', ping: '40' });
  });

  it("carries each client's damage given, and a Dmg column on Clan Arena's board alone", () => {
    const scores = board([row({ 0: 1, 14: 640 }), row({ 0: 0, 2: -1, 14: 5 })]);
    const arena = shown({ scores, gametype: GT.CA, clientInfo: () => info({ team: TEAM.RED }) });

    expect(arena.damageColumn).toBe(true);
    expect(arena.rows.map((r) => r.damage)).toEqual(['640', '']);
    expect(shown({ scores, gametype: GT.TEAM }).damageColumn).toBe(false);
    expect(shown({ scores }).damageColumn).toBe(false);
  });

  it('marks the row of a client whose READY bit is set', () => {
    const drawn = shown({
      scores: board([row({ 0: 2 }), row({ 0: 5 })]),
      ready: (1 << 2) | (1 << 7),
      clientInfo: () => info()
    });

    expect(drawn.rows.map((r) => r.ready)).toEqual([true, false]);
  });

  it('marks the player\'s own row', () => {
    const drawn = shown({
      scores: board([row({ 0: 1 }), row({ 0: 0 })]),
      clientNum: 1,
      clientInfo: () => info()
    });
    expect(drawn.rows.map((r) => r.you)).toEqual([true, false]);
  });

  it('reads a row whose slot has no clientinfo as an empty free client', () => {
    const drawn = shown({ scores: board([row({ 0: 5, 1: 3 })]) });
    expect(drawn.rows[0]).toMatchObject({ client: 5, name: '', head: { model: '', skin: '' }, score: '3' });
  });

  it("carries each client's head, which the row's portrait is drawn from", () => {
    const drawn = shown({
      scores: board([row({ 0: 1 })]),
      clientInfo: () =>
        info({ look: { body: { model: 'xaero', skin: 'red' }, head: { model: 'xaero', skin: 'red' } } })
    });
    expect(drawn.rows[0].head).toEqual({ model: 'xaero', skin: 'red' });
  });

  it('draws the players before the spectators', () => {
    const drawn = shown({
      scores: board([row({ 0: 3 }), row({ 0: 0 }), row({ 0: 1 })]),
      clientInfo: (client) =>
        info({ name: `C${client}`, team: client === 3 ? TEAM.SPECTATOR : TEAM.FREE })
    });
    expect(drawn.rows.map((r) => r.client)).toEqual([0, 1, 3]);
  });

  it('leads with the leading team, then the other, then the spectators', () => {
    const drawn = shown({
      gametype: GT.TEAM,
      scores: board([row({ 0: 2 }), row({ 0: 1 }), row({ 0: 0 }), row({ 0: 3 })], 5, 3),
      clientInfo: (client) =>
        info({ name: `C${client}`, team: [TEAM.FREE, TEAM.BLUE, TEAM.RED, TEAM.SPECTATOR][client] })
    });

    // Red leads, so its rows come first, then blue's, then the spectator's; the free client is
    // in no team block and is not drawn at all (`CG_TeamScoreboard` filters by team).
    expect(drawn.rows.map((r) => r.client)).toEqual([2, 1, 3]);
    // Each row carries its own side, which is what the board blocks and bands them by.
    expect(drawn.rows.map((r) => r.team)).toEqual([TEAM.RED, TEAM.BLUE, TEAM.SPECTATOR]);
  });

  it('cuts the list at the port\'s rows, with the player\'s own row at the foot when it was cut', () => {
    const entries = Array.from({ length: MAX_ROWS + 1 }, (_unused, i) =>
      row({ 0: i, 1: MAX_ROWS - i })
    );
    const drawn = shown({
      scores: board(entries),
      clientNum: MAX_ROWS,
      clientInfo: (client) => info({ name: `C${client}` })
    });

    expect(drawn.rows).toHaveLength(MAX_ROWS);
    expect(drawn.rows.some((r) => r.you)).toBe(false);
    expect(drawn.foot).toMatchObject({ client: MAX_ROWS, you: true });
  });

  it('draws no foot row when the player\'s own row is among them', () => {
    const entries = Array.from({ length: MAX_ROWS + 1 }, (_unused, i) => row({ 0: i }));
    const drawn = shown({
      scores: board(entries),
      clientNum: 3,
      clientInfo: (client) => info({ name: `C${client}` })
    });

    expect(drawn.rows.some((r) => r.you)).toBe(true);
    expect(drawn.foot).toBeNull();
  });
});

describe("the own row's fill", () => {
  it("reads the player's place without the tie, as the highlight does", () => {
    expect(shown({ rank: RANK_TIED_FLAG | 2 }).rank).toBe(2);
    expect(shown({ rank: 0 }).rank).toBe(0);
  });

  it('has no place to read in a team game, or watching as a spectator', () => {
    expect(shown({ gametype: GT.TEAM, rank: 1 }).rank).toBe(-1);
    expect(shown({ team: TEAM.SPECTATOR, rank: 1 }).rank).toBe(-1);
  });
});

describe("a server's board, as the browser shows it", () => {
  it('stands up, with no own row, place or foot, the rows in the order sent', () => {
    const infos = [info({ name: 'Visor' }), info({ name: 'Sarge' })];
    const drawn = spectatorBoard(
      GT.FFA,
      board([row({ 0: 1, 1: 12 }), row({ 0: 0, 1: 7 })]),
      (client) => infos[client] ?? null
    );
    expect(drawn.fade).toBe(1);
    expect(drawn.lines).toEqual([]);
    expect(drawn.rank).toBe(-1);
    expect(drawn.foot).toBeNull();
    expect(drawn.rows.map((r) => [r.name, r.score, r.you])).toEqual([
      ['Sarge', '12', false],
      ['Visor', '7', false]
    ]);
  });

  it("leads a team game's board with the leading side, and Clan Arena's with its Dmg", () => {
    const teams = [info({ name: 'Red', team: TEAM.RED }), info({ name: 'Blue', team: TEAM.BLUE })];
    const clientInfo = (client: number) => teams[client] ?? null;
    const rows = board([row({ 0: 0 }), row({ 0: 1 })], 1, 3);
    const drawn = spectatorBoard(GT.TEAM, rows, clientInfo);
    expect(drawn.lines).toEqual(['Blue leads 3 to 1']);
    expect(drawn.rows.map((r) => r.name)).toEqual(['Blue', 'Red']);
    expect(spectatorBoard(GT.CA, rows, clientInfo).damageColumn).toBe(true);
  });
});
