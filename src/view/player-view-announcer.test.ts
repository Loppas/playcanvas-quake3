import { describe, expect, it } from 'vitest';

import { CA_ROUND_WARMUP } from '../sim/clan-arena';
import { damage } from '../sim/combat';
import { CARNAGE_REWARD_TIME } from '../sim/player-life';
import { GT, MOD, PERS, PMOVE_MSEC, PM_INTERMISSION, TEAM } from '../sim/constants';
import { EV, GTS } from '../sim/events';
import { SVF } from '../sim/game-entity';
import { tempEntity } from '../sim/temp-entity';
import type { UserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import type { AnnouncerCue } from './announcer';
import type { CenterPrintRequest } from './center-print';
import { BOT_SETTLED, CATCH_UP, ViewWorld } from './view-test-fixtures';

/**
 * The announcer through the real loop: what the match does reaches the client in its snapshots,
 * its configstrings and its commands, and what the client says of it is the view's voices and its
 * centre print.
 */

/** The player's input: standing still, the machinegun in hand. */
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

/** The bot's slot: the next after the player's. */
const BOT = 1;

/** What a run of frames said, and the centre prints it raised, in order. */
interface Heard {
  voices: AnnouncerCue[];
  prints: CenterPrintRequest[];
}

/** Run `count` frames of one tick each, keeping everything said. */
function ticks(world: ViewWorld, count: number): Heard {
  const heard: Heard = { voices: [], prints: [] };
  for (let i = 0; i < count; i++) {
    world.view.advance(PMOVE_MSEC, STILL);
    heard.voices.push(...world.view.voices);
    if (world.view.centerPrint) heard.prints.push(world.view.centerPrint);
  }
  return heard;
}

/** A client in a match, with a held bot in it unless told otherwise, once both are in. */
function match(cvars: Record<string, string> = {}, bot = true): ViewWorld {
  const world = new ViewWorld({ spots: [THERE], cvars });
  if (bot) world.game.host.sendConsoleCommand('addbot grunt\n');
  ticks(world, BOT_SETTLED);
  return world;
}

/**
 * Run the match on past the excellent's window from the level's start: `lastKillTime` starts at 0,
 * so a first kill inside it is an excellent, and a reward holds the lead's news back.
 */
function pastTheStart(world: ViewWorld): void {
  while (world.level.time <= CARNAGE_REWARD_TIME) ticks(world, 10);
  ticks(world, 100);
}

describe('the match through the announcer', () => {
  it('says the lead as a bot joins and ties it, and as the player takes it', () => {
    const world = new ViewWorld({ spots: [THERE] });
    world.game.host.sendConsoleCommand('addbot grunt\n');
    expect(ticks(world, 40).voices).toEqual(['tiedLead']);
    pastTheStart(world);

    damage(world.level, world.level.gentities[BOT], world.entity, world.entity, null, 200, 0, MOD.RAILGUN);
    // The shot's hit beep at once, and the lead's news through the queue, whose last voice was
    // the tie's a moment ago and has its 750 ms.
    const heard = ticks(world, 100);
    expect(heard.voices).toEqual(['hit', 'takenLead']);
  });

  it('holds the lead back when a reward comes in the same snapshot', () => {
    // Inside the excellent's window from the start: the kill is a reward as well as the lead.
    const world = match();
    const bot = world.level.gentities[BOT];
    damage(world.level, bot, world.entity, world.entity, null, 200, 0, MOD.RAILGUN);
    expect(ticks(world, 100).voices).toEqual(['hit']);
    expect(world.view.rewards.stack).toBe(1);
    expect(world.view.rewards.rewards[1]).toEqual({
      sound: 'excellent',
      medal: 'excellent',
      count: 1
    });
  });

  it('tells the killer whom they fragged, and their place, where a used item is told', () => {
    const world = match();
    damage(world.level, world.level.gentities[BOT], world.entity, world.entity, null, 200, 0, MOD.RAILGUN);
    expect(ticks(world, 1 + CATCH_UP).prints).toEqual([
      { text: 'You fragged Grunt^7\n^41st^7 place with 1', y: 144, charWidth: 16 }
    ]);
  });

  it('tells the one a gauntlet killed of their humiliation, at once', () => {
    const world = match();
    const bot = world.level.gentities[BOT];
    damage(world.level, world.entity, bot, bot, null, 200, 0, MOD.GAUNTLET);
    expect(ticks(world, 1 + CATCH_UP).voices).toEqual(['humiliation']);
  });

  it('tells the one killed nothing of the kind', () => {
    const world = match();
    const bot = world.level.gentities[BOT];
    damage(world.level, world.entity, bot, bot, null, 200, 0, MOD.RAILGUN);
    expect(ticks(world, 1 + CATCH_UP).prints).toEqual([]);
  });

  it('counts the frag limit down, measured on the top score', () => {
    const world = match({ fraglimit: '3' });
    pastTheStart(world);
    const bot = world.level.gentities[BOT];
    damage(world.level, bot, world.entity, world.entity, null, 200, 0, MOD.RAILGUN);
    // Two frags left: the lead and then the limit, 750 ms apart.
    expect(ticks(world, 250).voices).toEqual(['hit', 'takenLead', 'twoFrag']);
  });

  it('says fight at a restart into play, with FIGHT! in giant letters', () => {
    const world = match();
    world.game.host.sendConsoleCommand('map_restart 0\n');
    const heard = ticks(world, 20);
    expect(heard.voices).toContain('countFight');
    expect(heard.prints[0]).toEqual({ text: 'FIGHT!', y: 120, charWidth: 64 });
  });

  it('says prepare as a warmup begins, and fight as the countdown ends in play', () => {
    const world = match({ g_doWarmup: '1', g_warmup: '3' }, false);
    world.game.host.sendConsoleCommand('addbot grunt\n');
    const heard = ticks(world, Math.ceil(5000 / PMOVE_MSEC));
    expect(heard.voices[0]).toBe('countPrepare');
    expect(heard.voices).toContain('countFight');
    expect(heard.prints.map(({ text }) => text)).toContain('FIGHT!');
  });

  it("says prepare as a Clan Arena round is counted down, and fight as it starts", () => {
    const world = new ViewWorld({ spots: [THERE], cvars: { g_gametype: String(GT.CA) } });
    ticks(world, 5);
    world.game.sendClientCommand('team red');
    world.game.host.sendConsoleCommand('addbot grunt 4 blue\n');

    const heard = ticks(world, Math.ceil((CA_ROUND_WARMUP + 1000) / PMOVE_MSEC));

    expect(heard.voices).toEqual(['countPrepare', 'countFight']);
    // After the team changes' own centre prints.
    expect(heard.prints.at(-1)).toEqual({ text: 'FIGHT!', y: 120, charWidth: 64 });
    expect(heard.prints.filter(({ text }) => text === 'FIGHT!')).toHaveLength(1);
  });

  it('tells the team scores to everyone, as the match broadcasts them', () => {
    const world = match();
    const te = tempEntity(world.level, vec3(), EV.GLOBAL_TEAM_SOUND);
    te.r.svFlags |= SVF.BROADCAST;
    te.s.eventParm = GTS.REDTEAM_TOOK_LEAD;
    expect(ticks(world, 100).voices).toEqual(['redLeads']);
  });

  it('goes to sudden death when the time runs out on a tie', () => {
    const world = match({ timelimit: '1' });
    // A minute is left from the first snapshot of a one-minute match.
    const heard = ticks(world, Math.ceil(63_000 / PMOVE_MSEC)).voices;
    expect(heard).toContain('suddenDeath');
  });

  it('says nothing more once the match has gone to its intermission', () => {
    // Alone, so the time runs out on nobody's tie, and the match ends a second after it.
    const world = match({ timelimit: '1' }, false);
    const heard = ticks(world, Math.ceil(63_000 / PMOVE_MSEC)).voices;
    expect(world.view.player.pmType).toBe(PM_INTERMISSION);
    expect(heard).not.toContain('suddenDeath');
  });

  it('warns a player of the time, and not a spectator', () => {
    const watching = new ViewWorld({ spots: [THERE] });
    watching.game.sendClientCommand('team spectator');
    ticks(watching, 10);
    expect(watching.view.player.persistant[PERS.TEAM]).toBe(TEAM.SPECTATOR);
    watching.cvars.set('timelimit', '1');
    expect(ticks(watching, 40).voices).toEqual([]);

    // The same, playing: the warning is the time's, not the view's joining.
    const late = new ViewWorld({ spots: [THERE] });
    ticks(late, 10);
    late.cvars.set('timelimit', '1');
    expect(ticks(late, 40).voices).toEqual(['oneMinute']);
  });
});
