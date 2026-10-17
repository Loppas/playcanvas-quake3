import { describe, expect, it } from 'vitest';

import { createNetUserCmd } from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import { CON } from '../sim/client';
import { BUTTON_ATTACK, CONTENTS, PMOVE_MSEC } from '../sim/constants';
import type { PointContentsFn, UserCmd } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { WP, type WeaponId } from '../sim/weapons/constants';
import type { WorldEffect } from './entity-events';
import { ViewWorld } from './view-test-fixtures';

/**
 * The player's own hitscan shots drawn as they are fired, as the whole program plays them: the
 * packets held back 100 ms each way, so the server's events for a shot come back a round trip
 * after the prediction fired it.
 */

/** A wall 256 units ahead of the player, across the whole of their view. */
const WALL = createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]);

/** Both ways held back, so the prediction runs ahead of the snapshots. */
const DELAYED = { cl_packetdelay: '100', sv_packetdelay: '100' };

/** The player's slot, and a bot's, the next after it. */
const PLAYER = 0;
const BOT = 1;

/** Every weapon `xp_delagWeapons` draws early: the machinegun, the shotgun and the railgun. */
const ALL = 1 | 2 | 8;

/** Standing still, looking the spawn's way, with this weapon asked for. */
function still(weapon: WeaponId): Omit<UserCmd, 'serverTime'> {
  return { forwardmove: 0, rightmove: 0, upmove: 0, angles: vec3(), buttons: 0, weapon };
}

/** What a frame drew of shots: their impacts, blood and beams. */
function shots(effects: readonly WorldEffect[]): WorldEffect[] {
  return effects.filter(({ type }) => type === 'impact' || type === 'blood' || type === 'beam');
}

/**
 * A world with the wall ahead, the player in it, and a held bot standing at `bot` if asked for,
 * the delays on and the view drawing the weapons `delagWeapons` names early.
 */
function playing(
  delagWeapons: number,
  cvars: Record<string, string> = {},
  bot?: Vec3,
  pointContents?: PointContentsFn
): ViewWorld {
  const world = new ViewWorld({
    trace: WALL,
    pointContents,
    spots: bot ? [bot] : [],
    cvars: { ...DELAYED, ...cvars }
  });
  world.view.delagWeapons = delagWeapons;
  // The frames finish a handshake the delays hold back, and the bot is added once the player is
  // in, so that it takes the next slot.
  const inGame = () => world.level.clients[PLAYER].pers.connected === CON.CONNECTED;
  for (let i = 0; i < 100 && !inGame(); i++) world.view.advance(PMOVE_MSEC, still(WP.MACHINEGUN));
  if (bot) world.game.host.sendConsoleCommand('addbot grunt\n');
  for (let i = 0; i < 60; i++) world.view.advance(PMOVE_MSEC, still(WP.MACHINEGUN));
  if (bot) expect(world.level.clients[BOT].ps.origin).toEqual(bot);
  return world;
}

/**
 * Fire one shot and play on until the server's events for it have come back.
 *
 * @returns what each frame drew of shots, the firing frame's first
 */
function shoot(
  weapon: WeaponId,
  world: ViewWorld,
  keep: (effects: readonly WorldEffect[]) => WorldEffect[] = shots
): WorldEffect[][] {
  // Long enough for the switch to it to finish, so that it is ready to fire.
  world.state.weapon = weapon;
  for (let i = 0; i < 100; i++) world.view.advance(PMOVE_MSEC, still(weapon));
  expect(world.view.player.weaponTime).toBe(0);
  const frames: WorldEffect[][] = [];
  world.view.advance(PMOVE_MSEC, { ...still(weapon), buttons: BUTTON_ATTACK });
  frames.push(keep(world.view.effects));
  for (let i = 0; i < 60; i++) {
    world.view.advance(PMOVE_MSEC, still(weapon));
    frames.push(keep(world.view.effects));
  }
  return frames;
}

/** Every frame's shots in one list, a negative zero read as the zero the wire makes of it. */
function drawn(frames: readonly WorldEffect[][]): unknown {
  return JSON.parse(JSON.stringify(frames.flat()));
}

/** The first frame that drew anything of a shot. */
function firstDrawn(frames: readonly WorldEffect[][]): number {
  return frames.findIndex((drawn) => drawn.length > 0);
}

describe("the player's own shots, drawn early, 100 ms each way", () => {
  it.each([WP.MACHINEGUN, WP.SHOTGUN, WP.RAILGUN])(
    'draws weapon %i as it fires, where its events would have drawn it a round trip later',
    (weapon) => {
      const early = shoot(weapon, playing(ALL));
      const late = shoot(weapon, playing(0));

      expect(firstDrawn(early)).toBe(0);
      expect(firstDrawn(late)).toBeGreaterThan(20);
      // Once, and the same: the server's events for it were left out.
      expect(drawn(early)).toEqual(drawn(late));
    }
  );

  it("leaves a blast's bubbles under water, early as its event would have", () => {
    const flooded: PointContentsFn = () => CONTENTS.WATER;
    const bubbles = (effects: readonly WorldEffect[]) =>
      effects.filter(({ type }) => type === 'bubbles');
    const early = shoot(WP.SHOTGUN, playing(ALL, {}, undefined, flooded), bubbles);
    const late = shoot(WP.SHOTGUN, playing(0, {}, undefined, flooded), bubbles);

    expect(early[0]).toHaveLength(11);
    expect(firstDrawn(late)).toBeGreaterThan(20);
    expect(drawn(early)).toEqual(drawn(late));
  });

  it('bleeds a player in the way where the last frame drew them, as the event would have', () => {
    const early = shoot(WP.MACHINEGUN, playing(ALL, {}, vec3(128, 0, 24)));
    const late = shoot(WP.MACHINEGUN, playing(0, {}, vec3(128, 0, 24)));

    // On the firing frame, just short of the face of the box the bot was drawn in.
    const [blood, ...more] = early[0];
    expect(more).toEqual([]);
    expect(blood.type === 'blood' && blood.origin.x).toBe(128 - 15 - 1);
    expect(drawn(early)).toEqual(drawn(late));
  });

  it.each([WP.MACHINEGUN, WP.SHOTGUN, WP.RAILGUN])(
    "draws weapon %i by the serverinfo's hitscan rules where they are not id's",
    (weapon) => {
      const cpm = {
        g_muzzleForward: '1',
        g_muzzleSnap: '0',
        g_bulletImpactSnap: '0',
        g_railTrailOffset: '0'
      };
      const early = shoot(weapon, playing(ALL, cpm));
      const late = shoot(weapon, playing(0, cpm));

      expect(firstDrawn(early)).toBe(0);
      expect(drawn(early)).toEqual(drawn(late));
    }
  );

  it('bleeds a running player where the last frame drew them, not where this one does', () => {
    const fire = (delagWeapons: number) => {
      const world = playing(delagWeapons, {}, vec3(48, 0, 24));
      world.state.weapon = WP.MACHINEGUN;
      for (let i = 0; i < 100; i++) world.view.advance(PMOVE_MSEC, still(WP.MACHINEGUN));
      const cmd = createNetUserCmd();
      Object.assign(cmd, { forwardmove: 127, serverTime: world.level.time + PMOVE_MSEC });
      world.game.host.botUserCommand(BOT, cmd);
      for (let i = 0; i < 30; i++) world.view.advance(PMOVE_MSEC, still(WP.MACHINEGUN));

      const aimedAt = world.view.players()[0].origin.x;
      world.view.advance(PMOVE_MSEC, { ...still(WP.MACHINEGUN), buttons: BUTTON_ATTACK });
      const frames = [shots(world.view.effects)];
      const drawnAt = world.view.players()[0].origin.x;
      for (let i = 0; i < 60; i++) {
        world.view.advance(PMOVE_MSEC, still(WP.MACHINEGUN));
        frames.push(shots(world.view.effects));
      }
      return { frames, moved: drawnAt - aimedAt };
    };
    const early = fire(ALL);
    const late = fire(0);

    // Drawn on the move: the frame that fired drew them further on than the one they were aimed in.
    expect(early.moved).toBeGreaterThan(1);
    expect(early.frames[0].map(({ type }) => type)).toEqual(['blood']);
    expect(drawn(early.frames)).toEqual(drawn(late.frames));
  });

  it('draws nothing early, and holds nothing back, where xp_unlagged does not rewind', () => {
    const unrewound = { xp_unlagged: '0' };
    const asked = shoot(WP.MACHINEGUN, playing(ALL, unrewound));
    const late = shoot(WP.MACHINEGUN, playing(0, unrewound));

    expect(firstDrawn(late)).toBeGreaterThan(20);
    expect(asked).toEqual(late);
  });
});

describe('cg_debugDelag, 100 ms each way', () => {
  /**
   * A rail at a bot running away down the line of fire, by a player asking for the report: what
   * the console printed, the client's lines and the server's.
   */
  function reported(): { client: string[]; server: string[] } {
    const world = playing(8, {}, vec3(48, 0, 24));
    world.view.debugDelag = true;
    world.game.setUserinfo('\\name\\Sarge\\cg_debugDelag\\1');
    const printed: string[] = [];
    world.view.console = { print: (text) => printed.push(text), clearNotify: () => {} };
    world.state.weapon = WP.RAILGUN;
    for (let i = 0; i < 100; i++) world.view.advance(PMOVE_MSEC, still(WP.RAILGUN));

    const cmd = createNetUserCmd();
    Object.assign(cmd, { forwardmove: 127, serverTime: world.level.time + PMOVE_MSEC });
    world.game.host.botUserCommand(BOT, cmd);
    for (let i = 0; i < 30; i++) world.view.advance(PMOVE_MSEC, still(WP.RAILGUN));
    world.view.advance(PMOVE_MSEC, { ...still(WP.RAILGUN), buttons: BUTTON_ATTACK });
    for (let i = 0; i < 60; i++) world.view.advance(PMOVE_MSEC, still(WP.RAILGUN));

    return {
      client: printed.filter((text) => text.startsWith('^3')),
      server: printed.filter((text) => text.startsWith('^1'))
    };
  }

  it("prints the drawn target field for field as the server's rewind put it", () => {
    const { client, server } = reported();
    expect(client).toHaveLength(1);
    expect(server).toHaveLength(1);

    const [int, intFrac] = client[0].split('\n');
    const [rec, recFrac] = server[0].split('\n');
    expect(int).toMatch(/^\^3Int: time: \d+, j: \d+, k: \d+, origin: /);
    expect(int.slice('^3Int'.length)).toBe(rec.slice('^1Rec'.length));
    expect(intFrac.slice('^5'.length)).toBe(recFrac.slice('^2'.length));
    // The bot was drawn on the move, between two snapshots that had it in different places.
    expect(intFrac).not.toMatch(/frac: 0\.0000/);
  });
});

describe('a spectator following a player who fires', () => {
  /** What each frame drew of the bot's shots, as the player follows it. */
  function watched(delagWeapons: number): WorldEffect[][] {
    const world = playing(delagWeapons, {}, vec3(0, 64, 24));
    world.game.sendClientCommand('team spectator');
    for (let i = 0; i < 40; i++) world.view.advance(PMOVE_MSEC, still(WP.MACHINEGUN));
    world.game.sendClientCommand('follow 1');
    for (let i = 0; i < 100 && world.view.player.clientNum !== BOT; i++) {
      world.view.advance(PMOVE_MSEC, still(WP.MACHINEGUN));
    }
    expect(world.view.player.clientNum).toBe(BOT);

    // It runs the command at every frame until it is given another, firing as it can.
    world.level.clients[BOT].ps.weapon = WP.MACHINEGUN;
    const cmd = createNetUserCmd();
    Object.assign(cmd, {
      buttons: BUTTON_ATTACK,
      weapon: WP.MACHINEGUN,
      serverTime: world.level.time + PMOVE_MSEC
    });
    world.game.host.botUserCommand(BOT, cmd);
    const frames: WorldEffect[][] = [];
    for (let i = 0; i < 60; i++) {
      world.view.advance(PMOVE_MSEC, still(WP.MACHINEGUN));
      frames.push(shots(world.view.effects));
    }
    return frames;
  }

  it("draws them as the server's events come, whatever xp_delagWeapons asks", () => {
    const late = watched(0);
    expect(late.flat().length).toBeGreaterThan(1);
    expect(watched(ALL)).toEqual(late);
  });
});
