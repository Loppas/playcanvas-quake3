import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CA } from '../net/connection';
import { CONTENTS } from '../sim/constants';
import type { UserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { ViewWorld, type ViewWorldOptions } from './view-test-fixtures';

/**
 * What the player feels over a round trip. The camera has to answer the keys on the frame they
 * go down, and the corrections the server sends have to stay under a tenth of a unit — at the
 * display rates the port is played at.
 *
 * The round trip is the port's own: `cl_packetdelay` and `sv_packetdelay` at 150 ms each way and
 * `net_dropsim` at 10%, all of which work on the loopback. The delay queue runs on the
 * clock the timers do, so the frames move it on.
 */

/** The display rates the acceptance names. */
const RATES = [60, 144, 240];

/** A frame's length in milliseconds for a display rate. */
const frameMsec = (rate: number): number => 1000 / rate;

/** A command holding nothing but a move, with the player's own angles. */
function cmd(forwardmove = 0): Omit<UserCmd, 'serverTime'> {
  return {
    forwardmove,
    rightmove: 0,
    upmove: 0,
    angles: vec3(),
    buttons: 0,
    weapon: WP.MACHINEGUN
  };
}

/** One frame of the world, with the clock the delays run on moved on with it. */
function frame(world: ViewWorld, rate: number, forwardmove = 0): void {
  vi.advanceTimersByTime(frameMsec(rate));
  world.view.advance(frameMsec(rate), cmd(forwardmove));
}

beforeEach(() => vi.useFakeTimers({ toFake: ['performance'] }));
afterEach(() => vi.useRealTimers());

/**
 * A world with the round trip set before the match starts, and its handshake run to the world.
 * The loss is turned on afterwards: the acceptance is about play, and a handshake packet lost to
 * the 3-second resend would only make the wait longer.
 */
function lagged(rate: number, loss = false, options: ViewWorldOptions = {}): ViewWorld {
  const world = new ViewWorld({
    ...options,
    cvars: { cl_packetdelay: '150', sv_packetdelay: '150' }
  });
  for (let i = 0; i < 400 && world.game.connection.state < CA.ACTIVE; i++) frame(world, rate);
  expect(world.game.connection.state).toBe(CA.ACTIVE);
  if (loss) world.cvars.set('net_dropsim', '10');
  return world;
}

describe('under a round trip', () => {
  it('moves the camera on the same frame the key goes down as with no delay', () => {
    /** The first frame of the key on which the drawn player moved at all. */
    const firstMove = (world: ViewWorld, rate: number): number => {
      const before = world.view.sample().origin.x;
      for (let frameNumber = 1; frameNumber <= 8; frameNumber++) {
        frame(world, rate, 127);
        if (world.view.sample().origin.x - before > 0.01) return frameNumber;
      }
      return Infinity;
    };
    for (const rate of RATES) {
      // The command is replayed before the server has heard of it, so the round trip adds no
      // frame: whatever step the frame lands in is the one that moves, as it is with none.
      expect(firstMove(lagged(rate), rate)).toBe(firstMove(new ViewWorld(), rate));
    }
  });

  it('keeps every correction under a tenth of a unit over the lag and loss', () => {
    for (const rate of RATES) {
      const world = lagged(rate, true);
      const { view } = world;
      const printed: string[] = [];
      view.console = { print: (text) => printed.push(text), clearNotify: () => {} };
      view.showMiss = 1;

      const before = view.sample().origin.x;
      for (let i = 0; i < 2 * rate; i++) frame(world, rate, 127);

      // The walk happened and no miss passed `cg_showmiss`'s threshold. A ring that runs dry
      // under the loss is Q3's "connection interrupted" freeze — the player is held, which is
      // not a correction, and the next snapshot lifts it.
      expect(view.sample().origin.x - before).toBeGreaterThan(100);
      expect(printed.filter((line) => line.includes('Prediction miss'))).toEqual([]);
    }
  });

  it("predicts a swim in the world's water as the server moves it, with no correction", () => {
    const pool = (point: { z: number }) => (point.z < 1000 ? CONTENTS.WATER : 0);
    const world = lagged(125, false, { origin: vec3(0, 0, 500), pointContents: pool });
    const { view } = world;
    const printed: string[] = [];
    view.console = { print: (text) => printed.push(text), clearNotify: () => {} };
    view.showMiss = 1;

    for (let i = 0; i < 250; i++) frame(world, 125, 127);

    expect(printed.filter((line) => line.includes('Prediction miss'))).toEqual([]);
    // Half the speed, as the swim's, and no fall.
    expect(world.state.velocity.x).toBe(160);
    expect(view.sample().origin.z).toBeGreaterThan(400);
  });

  it('draws the snapshots interpolation with cg_nopredict, and runs nothing ahead', () => {
    const world = lagged(60);
    const { view } = world;
    view.noPredict = true;
    const before = view.sample().origin.x;

    // One frame's command is on its way; with no prediction the player has not moved yet.
    frame(world, 60, 127);
    expect(view.sample().origin.x - before).toBeLessThan(0.1);

    // The round trip completes and the snapshots carry the move.
    for (let i = 0; i < 60; i++) frame(world, 60, 127);
    expect(view.sample().origin.x - before).toBeGreaterThan(0);
  });
});
