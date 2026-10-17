import { describe, expect, it } from 'vitest';

import { createNetUserCmd } from '../net/protocol';
import { awardSprite } from '../sim/client';
import { damage } from '../sim/combat';
import {
  BUTTON_TALK,
  EF_AWARD_IMPRESSIVE,
  EF_CONNECTION,
  GT,
  MOD,
  PMOVE_MSEC,
  REWARD_SPRITE_TIME,
  TEAM
} from '../sim/constants';
import { EV } from '../sim/events';
import { SVF } from '../sim/game-entity';
import { tempEntity } from '../sim/temp-entity';
import type { UserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { playerSprite } from './player-sprites';
import { BOT_SETTLED, CATCH_UP, ViewWorld } from './view-test-fixtures';

/**
 * What floats over the match, through the real loop: a score plum sent to its scorer alone, and a
 * player's award riding to everyone else in their entity flags.
 */

const STILL: Omit<UserCmd, 'serverTime'> = {
  forwardmove: 0,
  rightmove: 0,
  upmove: 0,
  angles: vec3(),
  buttons: 0,
  weapon: WP.MACHINEGUN
};

/** Where the bot stands, well away from the player. */
const THERE = vec3(200, 0, 24);
const BOT = 1;
/** Somewhere to look from that no plum is near. */
const EYE = vec3(0, -1000, 0);

function ticks(world: ViewWorld, count: number): void {
  for (let i = 0; i < count; i++) world.view.advance(PMOVE_MSEC, STILL);
}

/** A client in a match with a held bot, once both are in. */
function match(): ViewWorld {
  const world = new ViewWorld({ spots: [THERE] });
  world.game.host.sendConsoleCommand('addbot grunt\n');
  ticks(world, BOT_SETTLED);
  return world;
}

describe('the score plums through the wire', () => {
  it('shows the scorer the point where the kill happened', () => {
    const world = match();
    const bot = world.level.gentities[BOT];
    damage(world.level, bot, world.entity, world.entity, null, 200, 0, MOD.RAILGUN);
    ticks(world, 1 + CATCH_UP);

    const [digit] = world.view.plumSprites(EYE);
    expect(digit.shader).toBe('gfx/2d/numbers/one_32b');
    // Rising from 10 over where the bot died, and turned across the view.
    expect(digit.origin.z).toBeGreaterThan(THERE.z);
    expect(Math.abs(digit.origin.x - THERE.x)).toBeLessThan(20);
  });

  it('shows a suicide its minus one, in red', () => {
    const world = match();
    damage(world.level, world.entity, world.entity, world.entity, null, 100000, 0, MOD.SUICIDE);
    ticks(world, 1 + CATCH_UP);

    const digits = world.view.plumSprites(EYE);
    expect(digits.map(({ shader }) => shader)).toEqual([
      'gfx/2d/numbers/minus_32b',
      'gfx/2d/numbers/one_32b'
    ]);
    expect(digits[0].color.slice(0, 3)).toEqual([1, 0x11 / 255, 0x11 / 255]);
  });

  it('shows only a plum that names the player, however it reaches them', () => {
    const world = match();
    /** A plum sent to the player, naming `scorer`. */
    const sent = (scorer: number): void => {
      const plum = tempEntity(world.level, THERE, EV.SCOREPLUM);
      plum.r.svFlags |= SVF.SINGLECLIENT;
      plum.r.singleClient = world.entity.s.number;
      plum.s.otherEntityNum = scorer;
      plum.s.time = 1;
      ticks(world, 1 + CATCH_UP);
    };

    sent(BOT);
    expect(world.view.plumSprites(EYE)).toEqual([]);
    sent(world.entity.s.number);
    expect(world.view.plumSprites(EYE)).toHaveLength(1);
  });

  it('shows nobody the plum of a score that is somebody else’s', () => {
    const world = match();
    const bot = world.level.gentities[BOT];
    damage(world.level, world.entity, bot, bot, null, 200, 0, MOD.RAILGUN);
    ticks(world, 1 + CATCH_UP);
    expect(world.view.plumSprites(EYE)).toEqual([]);
  });

  it('shows none with cg_scorePlums off', () => {
    const world = match();
    world.view.scorePlums = false;
    const bot = world.level.gentities[BOT];
    damage(world.level, bot, world.entity, world.entity, null, 200, 0, MOD.RAILGUN);
    ticks(world, 1 + CATCH_UP);
    expect(world.view.plumSprites(EYE)).toEqual([]);
  });

  it('lets them go at a restart', () => {
    const world = match();
    const bot = world.level.gentities[BOT];
    damage(world.level, bot, world.entity, world.entity, null, 200, 0, MOD.RAILGUN);
    ticks(world, 1 + CATCH_UP);
    world.game.host.sendConsoleCommand('map_restart 0\n');
    // The restart moves the server's clock 400 ms on, and the client's closes the gap by halves, a
    // snapshot at a time: run until the view has drawn it.
    for (let i = 0; i < 20 && !world.view.mapRestart; i++) ticks(world, 1);
    expect(world.view.mapRestart).toBe(true);
    expect(world.view.plumSprites(EYE)).toEqual([]);
  });
});

describe('an award over somebody else', () => {
  it('reaches the client in their entity flags, floats their medal, and takes it down after', () => {
    const world = match();
    // Past 100 ms, when a bot short of commands would wear the connection sprite instead.
    ticks(world, 200 / PMOVE_MSEC);
    awardSprite(world.level.clients[BOT], EF_AWARD_IMPRESSIVE, world.level.time);
    ticks(world, 2 + CATCH_UP);

    const flags = (): number =>
      world.view.players().find(({ state }) => state.clientNum === BOT)!.state.eFlags;
    expect(flags() & EF_AWARD_IMPRESSIVE).toBe(EF_AWARD_IMPRESSIVE);
    expect(flags() & EF_CONNECTION).toBe(0);
    const viewer = { team: TEAM.FREE, gametype: GT.FFA, drawFriend: true };
    expect(playerSprite(flags(), TEAM.FREE, viewer)).toBe('medal_impressive');

    ticks(world, REWARD_SPRITE_TIME / PMOVE_MSEC + 2);
    expect(playerSprite(flags(), TEAM.FREE, viewer)).toBeNull();
  });

  it('floats the balloon over one holding the talk button', () => {
    const world = match();
    const cmd = createNetUserCmd();
    cmd.buttons = BUTTON_TALK;
    cmd.serverTime = world.level.time + PMOVE_MSEC;
    world.game.host.botUserCommand(BOT, cmd);
    ticks(world, 2 + CATCH_UP);

    const bot = world.view.players().find(({ state }) => state.clientNum === BOT)!;
    const viewer = { team: TEAM.FREE, gametype: GT.FFA, drawFriend: true };
    expect(playerSprite(bot.state.eFlags, TEAM.FREE, viewer)).toBe('sprites/balloon3');
  });
});
