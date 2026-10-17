import { describe, expect, it } from 'vitest';

import { CONFIGSTRING } from '../net/commands';
import { infoSetValueForKey } from '../net/info';
import { TR } from '../net/protocol';
import { EF_DEAD, EF_TELEPORT_BIT, GT, PMOVE_MSEC, TEAM } from '../sim/constants';
import { ET, type GameEntity } from '../sim/game-entity';
import { evaluateTrajectory } from '../sim/trajectory';
import type { UserCmd } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import type { PlayerCentity, PlayerView } from './player-view';
import { CATCH_UP, ViewWorld } from './view-test-fixtures';

/**
 * The other players a client is sent, and who each is: `CG_NewClientInfo` over the `CS_PLAYERS`
 * strings, and each `ET_PLAYER` placed as `CG_CalcEntityLerpPositions` places it, through a real
 * host and the wire.
 */

/** A frame's input: standing still. */
const STILL: Omit<UserCmd, 'serverTime'> = {
  forwardmove: 0,
  rightmove: 0,
  upmove: 0,
  angles: vec3(),
  buttons: 0,
  weapon: WP.MACHINEGUN
};

/** Run whole ticks. */
function ticks(view: PlayerView, count: number): void {
  for (let i = 0; i < count; i++) view.advance(PMOVE_MSEC, STILL);
}

/** Run frames of `msec` until the view draws one player, and return it as that frame drew it. */
function arrival(view: PlayerView, msec = PMOVE_MSEC): PlayerCentity {
  for (let i = 0; i < CATCH_UP + 3 && view.players().length === 0; i++) view.advance(msec, STILL);
  return drawn(view);
}

/**
 * Put a player in the world as the server would send one, in slot 1's look: `TR_INTERPOLATE`, as
 * `BG_PlayerStateToEntityState` writes every client's.
 */
function other(world: ViewWorld, origin: Vec3, yaw = 0): GameEntity {
  const entity = world.level.spawnEntity();
  entity.s.eType = ET.PLAYER;
  entity.s.clientNum = 1;
  entity.s.pos.trType = TR.INTERPOLATE;
  entity.s.pos.trBase = origin;
  entity.s.apos.trType = TR.INTERPOLATE;
  entity.s.apos.trBase = vec3(0, yaw, 0);
  world.level.linkEntity(entity);
  return entity;
}

/** The one player the view draws. */
function drawn(view: PlayerView): PlayerCentity {
  const players = view.players();
  expect(players).toHaveLength(1);
  return players[0];
}

describe('who is in each slot', () => {
  it('is read out of their CS_PLAYERS string, whenever it changes', () => {
    const world = new ViewWorld();
    const { host } = world.game;
    host.setConfigstring(
      CONFIGSTRING.PLAYERS + 1,
      'n\\Sarge\\t\\0\\model\\sarge/red\\hmodel\\major\\c1\\4\\c2\\5\\hc\\100\\w\\2\\l\\1\\skill\\4\\tt\\0\\tl\\0'
    );
    ticks(world.view, 1 + CATCH_UP);
    expect(world.view.clientInfo(1)).toMatchObject({
      name: 'Sarge',
      color1: [1, 0, 0],
      handicap: 100,
      botSkill: 4,
      named: { body: { model: 'sarge', skin: 'red' }, head: { model: 'major', skin: 'default' } }
    });

    host.setConfigstring(CONFIGSTRING.PLAYERS + 1, 'n\\Sarge\\model\\sarge/blue');
    ticks(world.view, 1 + CATCH_UP);
    expect(world.view.clientInfo(1)?.named.body).toEqual({ model: 'sarge', skin: 'blue' });

    // "Player just left."
    host.setConfigstring(CONFIGSTRING.PLAYERS + 1, '');
    ticks(world.view, 1 + CATCH_UP);
    expect(world.view.clientInfo(1)).toBeNull();
  });

  it("wears its side's colours in a team game, and is dressed again when the gametype changes", () => {
    const world = new ViewWorld();
    world.view.deferPlayers = false;
    const { host } = world.game;
    host.setConfigstring(
      CONFIGSTRING.PLAYERS + 1,
      `n\\Sarge\\t\\${TEAM.BLUE}\\model\\sarge/krusade\\hmodel\\sarge/krusade`
    );
    ticks(world.view, 1 + CATCH_UP);
    expect(world.view.clientInfo(1)?.look.body).toEqual({ model: 'sarge', skin: 'krusade' });

    // The string itself does not change when the match does; the look it is worn in does.
    host.setConfigstring(
      CONFIGSTRING.SERVERINFO,
      `\\g_gametype\\${GT.CTF}\\${host.getConfigstring(CONFIGSTRING.SERVERINFO).replace(/^\\/, '')}`
    );
    ticks(world.view, 1 + CATCH_UP);
    expect(world.view.clientInfo(1)?.look).toEqual({
      body: { model: 'sarge', skin: 'blue' },
      head: { model: 'sarge', skin: 'blue' }
    });
  });

  it('is handed to the renderer to read as their string arrives, and only when it changes', () => {
    const world = new ViewWorld();
    world.view.deferPlayers = false;
    // The player's own string is already in, and read as every other one is.
    ticks(world.view, 1);
    const read: string[] = [];
    world.view.registerClient = (info) =>
      read.push(`${info.look.body.model}/${info.look.body.skin}`);
    const { host } = world.game;

    host.setConfigstring(CONFIGSTRING.PLAYERS + 1, 'n\\Sarge\\model\\sarge/red\\hmodel\\major');
    ticks(world.view, 2 + CATCH_UP);
    expect(read).toEqual(['sarge/red']);

    host.setConfigstring(CONFIGSTRING.PLAYERS + 2, 'n\\Grunt\\model\\grunt');
    ticks(world.view, 2 + CATCH_UP);
    // "Player just left" has nothing to read (`CG_NewClientInfo`, `cg_players.c:886–890`).
    host.setConfigstring(CONFIGSTRING.PLAYERS + 1, '');
    ticks(world.view, 2 + CATCH_UP);

    expect(read).toEqual(['sarge/red', 'grunt/default']);
  });

  it("holds the player's own from the gamestate, and nobody in an empty slot", () => {
    const world = new ViewWorld();
    const own = world.view.clientInfo(world.game.clientNum);
    expect(own?.name).toBe(
      world.game.host.getConfigstring(CONFIGSTRING.PLAYERS + world.game.clientNum).split('\\')[1]
    );
    expect(world.view.clientInfo(5)).toBeNull();
  });
});

describe('a look put off, with cg_deferPlayers on', () => {
  /** A world a while into its match, its looks read as the renderer is handed them. */
  function joined(): { world: ViewWorld; read: string[] } {
    const world = new ViewWorld();
    ticks(world.view, 1);
    const read: string[] = [];
    world.view.registerClient = (info) => read.push(info.look.body.model);
    return { world, read };
  }

  it("draws a newcomer in a loaded client's look until the looks put off are loaded", () => {
    const { world, read } = joined();
    const { host } = world.game;
    host.setConfigstring(CONFIGSTRING.PLAYERS + 1, 'n\\Sarge\\model\\sarge/red\\hmodel\\major');
    ticks(world.view, 2 + CATCH_UP);
    const own = world.view.clientInfo(world.game.clientNum)!;
    expect(world.view.clientInfo(1)).toMatchObject({ look: own.look, deferred: true });
    expect(read).toEqual([]);

    world.view.loadDeferredPlayers();
    expect(world.view.clientInfo(1)).toMatchObject({
      look: { body: { model: 'sarge', skin: 'red' }, head: { model: 'major', skin: 'default' } },
      deferred: false
    });
    expect(read).toEqual(['sarge']);
    // Nobody is left to load.
    world.view.loadDeferredPlayers();
    expect(read).toEqual(['sarge']);
  });

  it('counts who is drawn in a look, those put off in it among them', () => {
    const { world } = joined();
    const { host } = world.game;
    host.setConfigstring(CONFIGSTRING.PLAYERS + 1, 'n\\Sarge\\model\\sarge/red\\hmodel\\major');
    ticks(world.view, 2 + CATCH_UP);
    const own = world.view.clientInfo(world.game.clientNum)!.look;
    expect(world.view.wearers(own)).toBe(2);

    world.view.loadDeferredPlayers();
    expect(world.view.wearers(own)).toBe(1);
    expect(world.view.wearers(world.view.clientInfo(1)!.look)).toBe(1);
  });

  it("puts the player's own new look off as anyone's", () => {
    const { world, read } = joined();
    const { host } = world.game;
    const slot = CONFIGSTRING.PLAYERS + world.game.clientNum;
    const before = world.view.clientInfo(world.game.clientNum)!.look;
    const visor = infoSetValueForKey(host.getConfigstring(slot), 'model', 'visor');
    host.setConfigstring(slot, infoSetValueForKey(visor, 'hmodel', 'visor'));
    ticks(world.view, 2 + CATCH_UP);
    expect(world.view.clientInfo(world.game.clientNum)).toMatchObject({
      look: before,
      deferred: true
    });
    expect(read).toEqual([]);
  });

  it('puts off a bot added as the match begins, and loads one added a second into it', () => {
    const { world } = joined();
    world.game.host.sendConsoleCommand('addbot grunt\n');
    ticks(world.view, 40);
    expect(world.view.clientInfo(1)?.deferred).toBe(true);

    // The game says so as it adds a bot beside a client in its process (`g_bot.c:798–803`).
    ticks(world.view, 125);
    world.game.host.sendConsoleCommand('addbot grunt\n');
    ticks(world.view, 40);
    expect(world.view.clientInfo(2)).toMatchObject({
      look: { body: { model: 'grunt', skin: 'default' } },
      deferred: false
    });
    // And every look put off with it.
    expect(world.view.clientInfo(1)?.deferred).toBe(false);
  });

  it('registers everyone a gamestate names for its load, own first, putting nobody off', () => {
    const { world } = joined();
    const { host } = world.game;
    host.setConfigstring(CONFIGSTRING.PLAYERS + 2, 'n\\Visor\\model\\visor');
    host.setConfigstring(CONFIGSTRING.PLAYERS + 1, 'n\\Visor\\model\\visor');
    ticks(world.view, 2 + CATCH_UP);

    const registered = world.view.registerClients();
    expect(registered.map(({ clientNum, load }) => [clientNum, load])).toEqual([
      [world.game.clientNum, true],
      [1, true],
      // The look slot 1 loaded just now.
      [2, false]
    ]);
    expect(registered.every(({ info }) => !info.deferred)).toBe(true);
    expect(world.view.clientInfo(2)?.look.body.model).toBe('visor');
  });
});

describe('another player, placed', () => {
  it('between the two snapshots the clock is between, by where it is, the short way round', () => {
    const world = new ViewWorld();
    const entity = other(world, vec3(100, 0, 24), 350);
    ticks(world.view, 2 + CATCH_UP);

    entity.s.pos.trBase = vec3(108, 4, 24);
    entity.s.apos.trBase = vec3(0, 10, 0);
    // Frames of a millisecond, until one is drawn part of the way from the one to the other.
    let between = drawn(world.view);
    for (let i = 0; i < 40 && !(between.origin.x > 100 && between.origin.x < 108); i++) {
      world.view.advance(1, STILL);
      between = drawn(world.view);
    }
    const f = (between.origin.x - 100) / 8;
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(1);
    expect(between.origin.y).toBeCloseTo(4 * f, 6);
    // From 350 to 10 is 20 degrees, through 360, not 340 back through 180 (`LerpAngle`).
    expect(between.angles.y).toBeCloseTo(350 + 20 * f, 6);
    expect(between.reset).toBe(false);
  });

  it('where it is when it has only just come into view, brought in afresh', () => {
    const world = new ViewWorld();
    ticks(world.view, 1);
    other(world, vec3(100, 0, 24), 90);
    const arrived = arrival(world.view, PMOVE_MSEC * 1.5);
    expect(arrived.reset).toBe(true);
    expect(arrived.origin).toEqual(vec3(100, 0, 24));
    expect(arrived.angles).toEqual(vec3(0, 90, 0));

    // Only the frame it arrived in.
    world.view.advance(PMOVE_MSEC, STILL);
    expect(drawn(world.view).reset).toBe(false);
  });

  it('brought in afresh even when the frame ran on past its arrival', () => {
    // A display slower than the tick reads several snapshots in a frame: by the frame's end the
    // player is in two of them and placed between, and still has to arrive rather than turn.
    const world = new ViewWorld();
    ticks(world.view, 1);
    other(world, vec3(100, 0, 24), 90);
    const arrived = arrival(world.view, PMOVE_MSEC * 3.5);
    expect(arrived.reset).toBe(true);
    expect(arrived.origin).toEqual(vec3(100, 0, 24));
  });

  it('where it arrived when it teleported, brought in afresh', () => {
    // A respawn flips `EF_TELEPORT_BIT`, which is how a client knows not to slide a player across
    // the map from where they died.
    const world = new ViewWorld();
    const entity = other(world, vec3(100, 0, 24));
    ticks(world.view, 2 + CATCH_UP);

    entity.s.pos.trBase = vec3(500, 0, 24);
    entity.s.eFlags ^= EF_TELEPORT_BIT;
    // Where it was until the snapshot that moved it is current, and never on the way.
    let arrived = drawn(world.view);
    for (let i = 0; i < CATCH_UP + 3 && arrived.origin.x !== 500; i++) {
      ticks(world.view, 1);
      arrived = drawn(world.view);
      expect([100, 500]).toContain(arrived.origin.x);
    }
    expect(arrived.reset).toBe(true);
    expect(arrived.origin).toEqual(vec3(500, 0, 24));
  });

  it('as a corpse, wherever its own trajectory has got to', () => {
    // A body copied off a player who died in the air is still falling, and where it is on any
    // frame is its own trajectory's answer: the same one a rocket's position comes from.
    const world = new ViewWorld();
    const body = other(world, vec3(64, 0, 200));
    body.s.eFlags = EF_DEAD;
    body.s.pos.trType = TR.GRAVITY;
    body.s.pos.trTime = world.level.time;
    body.s.pos.trDelta = vec3(100, 0, 0);
    ticks(world.view, 3);
    world.view.advance(PMOVE_MSEC / 2, STILL);

    const corpse = drawn(world.view);
    expect(corpse.origin).toEqual(evaluateTrajectory(corpse.state.pos, world.view.time));
    expect(corpse.origin.x).toBeGreaterThan(64);
  });
});
