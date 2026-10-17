import { describe, expect, it } from 'vitest';

import { PMOVE_MSEC } from '../sim/constants';
import type { UserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { CATCH_UP, ViewWorld } from './view-test-fixtures';

/**
 * The board as it reaches a client through the real loop: the server sends the `scores` command
 * down the wire, the view reads it in `CG_ServerCommand`, and what it holds afterwards is what
 * the scoreboard draws.
 */

/** A `scores` command carrying `rows`, each a client's fifteen numbers. */
function scoresCommand(rows: number[][], red = 0, blue = 0): string {
  return `scores ${rows.length} ${red} ${blue}${rows.map((row) => ` ${row.join(' ')}`).join('')}\n`;
}

/** Fifteen numbers for one client, with `over` spread over Q3's field order and the damage. */
function row(over: Partial<Record<number, number>> = {}): number[] {
  return Array.from({ length: 15 }, (_unused, i) => over[i] ?? 0);
}

function live(): ViewWorld {
  return new ViewWorld({ origin: vec3(0, 0, 24) });
}

/** One frame of holding nothing, which is one tick of the loop. */
function tick(world: ViewWorld): void {
  const cmd: Omit<UserCmd, 'serverTime'> = {
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
    angles: vec3(),
    buttons: 0,
    weapon: WP.MACHINEGUN
  };
  world.view.advance(PMOVE_MSEC, cmd);
}

/** The frames it takes a server command to be run: its snapshot has to be drawn. */
function settle(world: ViewWorld): void {
  for (let i = 0; i < 1 + CATCH_UP; i++) tick(world);
}

describe('the scores command', () => {
  it('fills the board, with the team scores and the rows in slot order', () => {
    const world = live();
    expect(world.view.scores.numScores).toBe(0);

    world.game.host.sendServerCommand(
      world.game.clientNum,
      scoresCommand([row({ 0: 1, 1: 9, 2: 55 }), row({ 0: 0, 1: 4, 2: 60 })], 0, 3)
    );
    settle(world);

    const { numScores, teamScores, scores } = world.view.scores;
    expect(numScores).toBe(2);
    expect(teamScores).toEqual([0, 3]);
    expect(scores[0]).toMatchObject({ client: 1, score: 9, ping: 55 });
    expect(scores[1]).toMatchObject({ client: 0, score: 4, ping: 60 });
  });

  it('is replaced by the next message, not added to', () => {
    const world = live();
    world.game.host.sendServerCommand(world.game.clientNum, scoresCommand([row(), row()]));
    settle(world);
    expect(world.view.scores.numScores).toBe(2);

    world.game.host.sendServerCommand(world.game.clientNum, scoresCommand([row({ 1: 1 })]));
    settle(world);

    const { numScores, scores } = world.view.scores;
    expect(numScores).toBe(1);
    expect(scores[1].score).toBe(0);
  });

  it("is dropped at a new gamestate, as CG_Init's memset drops cg.scores", () => {
    const world = live();
    world.game.host.sendServerCommand(world.game.clientNum, scoresCommand([row(), row()]));
    settle(world);
    expect(world.view.scores.numScores).toBe(2);

    world.load(() => tick(world));
    expect(world.view.scores.numScores).toBe(0);
  });

  it('is not read out of a print that happens to say the same words', () => {
    const world = live();
    world.game.host.sendServerCommand(world.game.clientNum, 'print "scores 1 0 0 0 5 0 0 0 0 0 0 0 0 0 0 0 0 0"\n');
    settle(world);

    // `CG_ServerCommand` tells the commands apart by the first word (`cg_servercmds.c:995–1000`).
    expect(world.view.scores.numScores).toBe(0);
  });
});
