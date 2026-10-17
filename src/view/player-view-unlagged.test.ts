import { describe, expect, it, vi } from 'vitest';

import { createNetUserCmd } from '../net/protocol';
import { CON } from '../sim/client';
import { BUTTON_ATTACK, PERS, PLAYER_WIDTH, PMOVE_MSEC } from '../sim/constants';
import type { UserCmd } from '../sim/types';
import { copy, vec3, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { ViewWorld } from './view-test-fixtures';

/**
 * A shot at another player where the view drew them, as the whole program plays it: the packets
 * held back 100 ms each way, a held bot strafing across the player's view, and a rail fired at the
 * bot as the last frame drew it. By the time the command reaches the server the bot has moved on,
 * and the server finds it where the frame drew it.
 *
 * The player asks for 30 snapshots a second, which the host sends 40 ms apart, five frames, so the
 * view draws the bot between two of them as it draws a remote player.
 */

/** Where the bot begins: 400 units ahead of the player and 200 to their left, facing away. */
const THERE = vec3(400, 200, 24);

/** The player's slot, and the bot's, the next after it. */
const PLAYER = 0;
const BOT = 1;

/** The player's input: standing still, the railgun in hand, looking the spawn's way. */
const STILL: Omit<UserCmd, 'serverTime'> = {
  forwardmove: 0,
  rightmove: 0,
  upmove: 0,
  angles: vec3(),
  buttons: 0,
  weapon: WP.RAILGUN
};

/**
 * The player, and the bot strafing across their view from left to right, at the first frame that
 * draws the bot within 30 units of straight ahead.
 *
 * @returns the world, and where that frame drew the bot
 */
function strafing(cvars: Record<string, string> = {}): { world: ViewWorld; drawn: Vec3 } {
  const world = new ViewWorld({
    spots: [THERE],
    cvars: { cl_packetdelay: '100', sv_packetdelay: '100', snaps: '30', ...cvars }
  });
  // The frames finish a handshake the delays hold back, and the bot is added once the player is
  // in, so that it takes the next slot.
  const inGame = () => world.level.clients[PLAYER].pers.connected === CON.CONNECTED;
  for (let i = 0; i < 100 && !inGame(); i++) world.view.advance(PMOVE_MSEC, STILL);
  world.game.host.sendConsoleCommand('addbot grunt\n');
  for (let i = 0; i < 60; i++) world.view.advance(PMOVE_MSEC, STILL);
  expect(world.level.clients[BOT].ps.origin).toEqual(THERE);
  world.state.weapon = WP.RAILGUN;

  // Facing away from the player, the bot's right is the player's right too. It runs the command
  // at every frame until it is given another.
  const cmd = createNetUserCmd();
  Object.assign(cmd, { rightmove: 127, serverTime: world.level.time + PMOVE_MSEC });
  world.game.host.botUserCommand(BOT, cmd);
  const drawnBot = () => world.view.players().find(({ state }) => state.number === BOT)!.origin;
  const frames = vi.spyOn(world.game, 'setDrawnFrame');
  for (let i = 0; i < 200 && drawnBot().y > 30; i++) world.view.advance(PMOVE_MSEC, STILL);
  expect(drawnBot().y).toBeLessThanOrEqual(30);
  // Drawn between two snapshots, so the server has the fraction to follow as well as the times.
  const [time, snapTime, nextSnapTime] = frames.mock.lastCall!;
  expect(snapTime).toBeLessThan(time);
  expect(time).toBeLessThan(nextSnapTime);
  return { world, drawn: copy(drawnBot()) };
}

/**
 * Fire one rail level, through the point `across` units to the left of where the bot was drawn,
 * and run on until the command has reached the server.
 *
 * @returns the players the server counted it hitting
 */
function fireAcross(world: ViewWorld, drawn: Vec3, across: number): number {
  const yaw = (Math.atan2(drawn.y + across, drawn.x) * 180) / Math.PI;
  const angles = world.aim(vec3(0, yaw, 0));
  world.view.advance(PMOVE_MSEC, { ...STILL, angles, buttons: BUTTON_ATTACK });
  for (let i = 0; i < 20; i++) world.view.advance(PMOVE_MSEC, STILL);
  return world.state.persistant[PERS.HITS];
}

describe('a rail at a strafing player, 100 ms each way', () => {
  it.each([0, PLAYER_WIDTH - 3, -(PLAYER_WIDTH - 3)])(
    'hits them where the view drew them, %i units across, though they have moved on',
    (across) => {
      const { world, drawn } = strafing();
      // Already clear of the box they were drawn in, before the command has even left.
      expect(world.level.clients[BOT].ps.origin.y).toBeLessThan(drawn.y - 2 * PLAYER_WIDTH);

      expect(fireAcross(world, drawn, across)).toBe(1);
    }
  );

  it.each([PLAYER_WIDTH + 5, -(PLAYER_WIDTH + 5)])(
    'misses %i units across, past the edge of the box they were drawn in',
    (across) => {
      const { world, drawn } = strafing();
      expect(fireAcross(world, drawn, across)).toBe(0);
    }
  );

  it('misses them with xp_unlagged 0, which finds them only a snapshot gap back', () => {
    const { world, drawn } = strafing({ xp_unlagged: '0' });
    expect(fireAcross(world, drawn, 0)).toBe(0);
  });
});
