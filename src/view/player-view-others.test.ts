import { describe, expect, it } from 'vitest';

import { createNetUserCmd, TR, type NetUserCmd } from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import { damage } from '../sim/combat';
import {
  BUTTON_AFFIRMATIVE,
  BUTTON_ATTACK,
  CONTENTS,
  EF_PLAYER_EVENT,
  MASK,
  MOD,
  PMOVE_MSEC,
  STAT,
  SURFACE_CLIP_EPSILON
} from '../sim/constants';
import { EV } from '../sim/events';
import { ET, type GameEntity } from '../sim/game-entity';
import { recordingTrace } from '../sim/trace-test-fixtures';
import type { PointContentsFn, TraceFn, UserCmd } from '../sim/types';
import { copy, vec3, type Vec3 } from '../sim/vec3';
import { LIGHTNING_RANGE, MUZZLE_FORWARD, WP, type WeaponId } from '../sim/weapons/constants';
import { GRAPPLE_TYPES } from '../sim/weapons/grapple';
import type { WorldEffect } from './entity-events';
import type { EntitySound } from './other-player-events';
import { GURP1_SOUND, GURP2_SOUND, type PlayerSound } from './player-events';
import type { PlayerCentity } from './player-view';
import { BOT_SETTLED, CATCH_UP, ViewWorld } from './view-test-fixtures';

/**
 * Everyone else's events, as a client is sent them: a held bot, moved and fired by the commands
 * a test gives it, in a match on a real host, and what the player's client makes of what it does.
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

/** Where the bot stands, 200 units along +x from the player, facing away from them. */
const THERE = vec3(200, 0, 24);

/** The bot's slot: the next after the player's. */
const BOT = 1;

/**
 * A client in a match with a held bot in it, standing where it is put.
 *
 * @param cvars - Set before the map starts, where the match reads its settings.
 */
function withBot(trace?: TraceFn, cvars?: Record<string, string>): ViewWorld {
  const world = new ViewWorld({ spots: [THERE], trace, cvars });
  world.game.host.sendConsoleCommand('addbot grunt\n');
  for (let i = 0; i < BOT_SETTLED; i++) world.view.advance(PMOVE_MSEC, STILL);
  expect(world.level.gentities[BOT].client).not.toBeNull();
  // The player on their spot, and the bot on its own, out of each other's way.
  expect(world.state.origin).toEqual(vec3(0, 0, 24));
  expect(world.level.clients[BOT].ps.origin).toEqual(THERE);
  put(world, THERE);
  return world;
}

/** Stand a bot at `origin`, at rest, where the world and its entity state have it too. */
function put(world: ViewWorld, origin: Vec3, clientNum = BOT): void {
  const { ps } = world.level.clients[clientNum];
  ps.origin = copy(origin);
  ps.velocity = vec3();
  const entity = world.level.gentities[clientNum];
  entity.s.pos.trBase = copy(origin);
  entity.r.currentOrigin = copy(origin);
  world.game.host.linkEntity(entity);
}

/** Put a weapon in the bot's hand, loaded. */
function arm(world: ViewWorld, weapon: WeaponId): void {
  const { ps } = world.level.clients[BOT];
  ps.stats[STAT.WEAPONS] |= 1 << weapon;
  ps.ammo[weapon] = 50;
  ps.weapon = weapon;
}

/** Hold a command for the bot, which it runs every frame until it is given another. */
function hold(world: ViewWorld, input: Partial<NetUserCmd>): void {
  const cmd = createNetUserCmd();
  Object.assign(cmd, input, { serverTime: world.level.time + PMOVE_MSEC });
  world.game.host.botUserCommand(BOT, cmd);
}

/** Run whole ticks, and what everyone else sounded and the world showed across them. */
function ticks(
  world: ViewWorld,
  count: number,
  cmd = STILL
): { sounds: EntitySound[]; effects: WorldEffect[] } {
  const sounds: EntitySound[] = [];
  const effects: WorldEffect[] = [];
  for (let i = 0; i < count; i++) {
    world.view.advance(PMOVE_MSEC, cmd);
    sounds.push(...world.view.entitySounds);
    effects.push(...world.view.effects);
  }
  return { sounds, effects };
}

/** The bot, as the client draws it. */
function bot(world: ViewWorld): PlayerCentity {
  return world.view.players().find(({ state }) => state.number === BOT)!;
}

/** Just what each sound was, and whose, from whom. */
function what(sounds: readonly EntitySound[]) {
  return sounds.map(({ number, voice, sound }) => ({ number, voice, sound }));
}

describe("another player's move", () => {
  it('is heard from them, a jump and a shot of one move both, the shot sent on its own', () => {
    const world = withBot();
    hold(world, { upmove: 127, buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
    const { sounds } = ticks(world, 1 + CATCH_UP);
    hold(world, { weapon: WP.MACHINEGUN });

    expect(what(sounds)).toEqual([
      { number: BOT, voice: BOT, sound: { type: 'custom', name: 'jump1' } },
      { number: BOT, voice: BOT, sound: { type: 'fire', weapon: WP.MACHINEGUN } }
    ]);
    // Both heard from where the move left the bot, in whole units: 2 up into its jump.
    expect(sounds[0].origin).toEqual(vec3(THERE.x, THERE.y, THERE.z + 2));
    expect(sounds[1].origin).toEqual(sounds[0].origin);
    // The shot came on an entity of its own, which Q3 flashes nobody's gun for.
    expect(bot(world).flashTime).toBe(Number.NEGATIVE_INFINITY);
  });

  it('flashes their gun at a shot that was all their move did', () => {
    const world = withBot();
    hold(world, { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
    const { sounds } = ticks(world, 1 + CATCH_UP);
    hold(world, { weapon: WP.MACHINEGUN });

    expect(what(sounds)).toEqual([
      { number: BOT, voice: BOT, sound: { type: 'fire', weapon: WP.MACHINEGUN } }
    ]);
    expect(bot(world).flashTime).toBe(world.view.time);
    // A flash, and no lightning bolt, which only the lightning gun's flash draws.
    expect(bot(world).bolt).toBeNull();
  });

  it("draws their rail from their own muzzle, in their colour, and dims their gun's glow", () => {
    const world = withBot();
    arm(world, WP.RAILGUN);
    hold(world, { buttons: BUTTON_ATTACK, weapon: WP.RAILGUN });
    const { effects } = ticks(world, 1 + CATCH_UP);
    hold(world, { weapon: WP.RAILGUN });

    const [beam] = effects.filter((effect) => effect.type === 'beam');
    expect(beam).toMatchObject({
      own: false,
      color: world.view.clientInfo(BOT)!.color1,
      hit: false
    });
    // From the shot's own muzzle, beside the bot, and not from the player's gun.
    expect(beam.type === 'beam' && beam.start.x).toBeGreaterThan(THERE.x);
    expect(bot(world).railFireTime).toBe(world.view.time);
  });

  it("sounds the lightning gun at a burst's first shot, then leaves it to the firing loop", () => {
    const world = withBot();
    arm(world, WP.LIGHTNING);
    hold(world, { buttons: BUTTON_ATTACK, weapon: WP.LIGHTNING });
    // Six shots, one every 50 ms.
    const { sounds } = ticks(world, 40);

    expect(what(sounds).filter(({ sound }) => sound.type === 'fire')).toEqual([
      { number: BOT, voice: BOT, sound: { type: 'fire', weapon: WP.LIGHTNING } }
    ]);
  });

  it('never plays the player their own move a second time', () => {
    // The player's own second event goes out on its own to everyone but them. Turned away from
    // the bot, so that nothing it does is heard either.
    const world = withBot();
    const away = { ...STILL, angles: world.aim(vec3(0, 180, 0)) };
    ticks(world, 10, away);
    const own: PlayerSound[] = [];
    const { sounds } = ticks(world, 1, { ...away, upmove: 127, buttons: BUTTON_ATTACK });
    own.push(...world.view.playerSounds);
    for (let tick = 0; tick < CATCH_UP; tick++) {
      sounds.push(...ticks(world, 1, away).sounds);
      own.push(...world.view.playerSounds);
    }

    const sent = world.level.gentities.filter(
      (entity) =>
        entity.inuse &&
        entity.s.eFlags & EF_PLAYER_EVENT &&
        entity.s.otherEntityNum === world.game.clientNum
    );
    expect(sent).toHaveLength(1);
    expect(own).toContainEqual({ type: 'custom', name: 'jump1' });
    expect(sounds).toEqual([]);
  });
});

describe('another player as the server sends them', () => {
  it('is sent and read as TR_INTERPOLATE, whatever g_smoothClients says', () => {
    const world = withBot();
    expect(world.level.gentities[BOT].s.pos.trType).toBe(TR.INTERPOLATE);
    expect(bot(world).state.pos.trType).toBe(TR.INTERPOLATE);

    world.cvars.set('g_smoothClients', '0');
    ticks(world, 1 + CATCH_UP);
    expect(world.level.gentities[BOT].s.pos.trType).toBe(TR.INTERPOLATE);
    expect(bot(world).state.pos.trType).toBe(TR.INTERPOLATE);
  });
});

describe('another player hurt', () => {
  it('grunts in their own sounds for the health they have left, and twitches', () => {
    const world = withBot();
    const entity = world.level.gentities[BOT];
    damage(world.level, entity, null, null, null, 60, 0, MOD.FALLING);
    const { sounds } = ticks(world, 1 + CATCH_UP);

    expect(what(sounds)).toEqual([
      { number: BOT, voice: BOT, sound: { type: 'custom', name: 'pain75_1' } }
    ]);
    expect(bot(world).pain).toEqual({ time: world.view.time, direction: 1 });
  });

  it('dies aloud, from where they fell', () => {
    const world = withBot();
    // Five past their health, which kills without gibbing.
    const entity = world.level.gentities[BOT];
    const health = world.level.clients[BOT].ps.stats[STAT.HEALTH];
    damage(world.level, entity, null, null, null, health + 5, 0, MOD.FALLING);
    const { sounds } = ticks(world, 1 + CATCH_UP);

    expect(what(sounds)).toEqual([
      { number: BOT, voice: BOT, sound: { type: 'custom', name: 'death1' } }
    ]);
  });

  it("gurgles and drowns where the client's contents hold their head under", () => {
    const water: PointContentsFn = (point) => (point.z < 100 ? CONTENTS.WATER : 0);
    const world = new ViewWorld({ spots: [THERE], pointContents: water });
    world.game.host.sendConsoleCommand('addbot grunt\n');
    for (let i = 0; i < BOT_SETTLED; i++) world.view.advance(PMOVE_MSEC, STILL);
    put(world, THERE);
    const entity = world.level.gentities[BOT];
    damage(world.level, entity, null, null, null, 20, 0, MOD.FALLING);
    const hurt = what(ticks(world, 1 + CATCH_UP).sounds);
    expect(hurt).toHaveLength(1);
    const [{ number, sound }] = hurt;
    expect(number).toBe(BOT);
    expect(sound.type === 'shared' && [GURP1_SOUND, GURP2_SOUND].includes(sound.path)).toBe(true);

    const health = world.level.clients[BOT].ps.stats[STAT.HEALTH];
    damage(world.level, entity, null, null, null, health + 5, 0, MOD.FALLING);
    expect(what(ticks(world, 1 + CATCH_UP).sounds)).toEqual([
      { number: BOT, voice: BOT, sound: { type: 'custom', name: 'drown' } }
    ]);
  });

  it('goes to pieces from where they were, with the splat from there', () => {
    const world = withBot();
    const entity = world.level.gentities[BOT];
    damage(world.level, entity, null, null, null, 200, 0, MOD.FALLING);
    const { sounds } = ticks(world, 1 + CATCH_UP);

    expect(what(sounds)).toEqual([
      { number: BOT, voice: BOT, sound: { type: 'shared', path: 'sound/player/gibsplt1.wav' } }
    ]);
    expect(world.view.gibOrigins).toEqual([THERE]);
  });
});

describe("another player's lightning bolt", () => {
  it('runs from their eyes, along their view, past them, while they hold the trigger', () => {
    const { trace, asked } = recordingTrace(createFlatWorldTrace());
    const world = withBot(trace);
    arm(world, WP.LIGHTNING);
    hold(world, { buttons: BUTTON_ATTACK, weapon: WP.LIGHTNING });
    ticks(world, 2 + CATCH_UP);
    asked.length = 0;

    // Standing: 26 above their origin, 14 along their view, and 768 on (`CG_LightningBolt`).
    expect(bot(world).bolt).toEqual({
      end: vec3(THERE.x + MUZZLE_FORWARD + LIGHTNING_RANGE, 0, THERE.z + 26),
      hit: false
    });
    // Traced past the one firing it, and stopped by what stops a shot.
    expect(asked).toEqual([{ passEntityNum: BOT, contentmask: MASK.SHOT }]);
  });

  it('runs from where they are drawn, between snapshots, as they run', () => {
    // `CG_LightningBolt` starts at `lerpOrigin`, which a frame ending between ticks has partway.
    const world = withBot();
    arm(world, WP.LIGHTNING);
    hold(world, { forwardmove: 127, buttons: BUTTON_ATTACK, weapon: WP.LIGHTNING });
    ticks(world, 20);
    world.view.advance(PMOVE_MSEC / 2, STILL);

    const running = bot(world);
    expect(running.origin.x).not.toBe(running.state.pos.trBase.x);
    expect(running.bolt?.end.x).toBeCloseTo(
      running.origin.x + MUZZLE_FORWARD + LIGHTNING_RANGE,
      6
    );
  });

  it('runs from where a crouching player sees, standing or walking', () => {
    const world = withBot();
    arm(world, WP.LIGHTNING);
    hold(world, { upmove: -127, buttons: BUTTON_ATTACK, weapon: WP.LIGHTNING });
    ticks(world, 10);
    expect(bot(world).bolt?.end.z).toBe(THERE.z + 12);

    hold(world, { upmove: -127, forwardmove: 127, buttons: BUTTON_ATTACK, weapon: WP.LIGHTNING });
    ticks(world, 20);
    expect(bot(world).bolt?.end.z).toBe(THERE.z + 12);
  });

  it('is not drawn once they let go', () => {
    const world = withBot();
    arm(world, WP.LIGHTNING);
    hold(world, { buttons: BUTTON_ATTACK, weapon: WP.LIGHTNING });
    ticks(world, 2 + CATCH_UP);
    hold(world, { weapon: WP.LIGHTNING });
    ticks(world, 2 + CATCH_UP);

    expect(bot(world).bolt).toBeNull();
  });

  it('stops at anyone else in its way', () => {
    // A second bot, on a spot of its own, then stood 100 units on past the first.
    const world = new ViewWorld({ spots: [THERE, vec3(0, 200, 24)] });
    for (const name of ['grunt', 'sarge']) {
      world.game.host.sendConsoleCommand(`addbot ${name}\n`);
      ticks(world, 40);
    }
    put(world, THERE);
    put(world, vec3(300, 0, 24), BOT + 1);
    arm(world, WP.LIGHTNING);
    hold(world, { buttons: BUTTON_ATTACK, weapon: WP.LIGHTNING });
    ticks(world, 2 + CATCH_UP);

    expect(bot(world).bolt).toMatchObject({ hit: true });
    expect(bot(world).bolt!.end.x).toBeCloseTo(faceOf(300), 6);
  });

  it('goes through the player, whose own entity a snapshot never carries', () => {
    // Turned to face the player, 200 units off: Q3's client has no box for itself to stop at.
    const world = withBot();
    arm(world, WP.LIGHTNING);
    hold(world, { buttons: BUTTON_ATTACK, weapon: WP.LIGHTNING, angles: [0, 0x8000, 0] });
    ticks(world, 2 + CATCH_UP);

    expect(bot(world).bolt).toMatchObject({ hit: false });
    expect(bot(world).bolt!.end.x).toBeCloseTo(THERE.x - MUZZLE_FORWARD - LIGHTNING_RANGE, 6);
  });
});

describe("another player's grapple", () => {
  /** A wall ahead of the bot, its near face at 700, and Quake III's pulling hook allowed. */
  function hooking(): ViewWorld {
    const wall = createFlatWorldTrace([box(700, -400, 0, 720, 400, 600)]);
    const q3pull = GRAPPLE_TYPES.findIndex((type) => type.mode === 'q3pull');
    return withBot(wall, { g_allowGrapple: String(q3pull) });
  }

  it('is drawn for the client watching, in flight and once caught, from the thrower', () => {
    const world = hooking();
    hold(world, { buttons: BUTTON_AFFIRMATIVE, weapon: WP.MACHINEGUN });
    ticks(world, 2 + CATCH_UP);
    const [flying] = world.view.grappleHooks();
    expect(flying.owner).toBe(BOT);
    expect(flying.position.x).toBeGreaterThan(THERE.x);
    // `CG_GrappleTrail`'s start: 26 up from where the thrower is drawn and 6 down their up
    // vector, which looking level is straight down.
    expect(flying.muzzle).toEqual(vec3(THERE.x, THERE.y, THERE.z + 20));

    ticks(world, 120);
    const [caught] = world.view.grappleHooks();
    expect(caught.owner).toBe(BOT);
    expect(caught.position.x).toBeCloseTo(699, 0);
  });

  it("is drawn beside the player's own, each with its thrower", () => {
    const world = hooking();
    hold(world, { buttons: BUTTON_AFFIRMATIVE, weapon: WP.MACHINEGUN });
    ticks(world, 2 + CATCH_UP, { ...STILL, buttons: BUTTON_AFFIRMATIVE });
    const owners = world.view.grappleHooks().map(({ owner }) => owner);
    expect(owners.sort()).toEqual([world.state.clientNum, BOT]);
  });

  it('is not drawn once they let go', () => {
    const world = hooking();
    hold(world, { buttons: BUTTON_AFFIRMATIVE, weapon: WP.MACHINEGUN });
    ticks(world, 2 + CATCH_UP);
    hold(world, { weapon: WP.MACHINEGUN });
    ticks(world, 2 + CATCH_UP);
    expect(world.view.grappleHooks()).toEqual([]);
  });
});

/** Put a weapon in the player's hand, loaded, and the input that fires it. */
function wield(world: ViewWorld, weapon: WeaponId): Omit<UserCmd, 'serverTime'> {
  const ps = world.state;
  ps.stats[STAT.WEAPONS] |= 1 << weapon;
  ps.ammo[weapon] = 50;
  ps.weapon = weapon;
  return { ...STILL, weapon, buttons: BUTTON_ATTACK };
}

/** Where a shot along +x at the player's eye meets a standing player's box at `x`. */
function faceOf(x: number): number {
  return x - 15 - SURFACE_CLIP_EPSILON;
}

describe("the client's traces, which meet the other players", () => {
  it("stop the player's own bolt at whoever is in the way", () => {
    const world = withBot();
    ticks(world, 2 + CATCH_UP, wield(world, WP.LIGHTNING));

    const bolt = world.view.lightningBolt()!;
    expect(bolt.hit).toBe(true);
    expect(bolt.end.x).toBeCloseTo(faceOf(THERE.x), 6);
  });

  it('meet them where they are drawn, between snapshots, as they run', () => {
    // Backing toward the player, and drawn partway between two snapshots.
    const world = withBot();
    hold(world, { forwardmove: -127 });
    ticks(world, 20);
    const firing = wield(world, WP.LIGHTNING);
    ticks(world, 2 + CATCH_UP, firing);
    world.view.advance(PMOVE_MSEC / 2, firing);

    const running = bot(world);
    expect(running.origin.x).not.toBe(running.state.pos.trBase.x);
    expect(world.view.lightningBolt()!.end.x).toBeCloseTo(faceOf(running.origin.x), 6);
  });

  it("go over a crouching player's lower box", () => {
    const world = withBot();
    hold(world, { upmove: -127 });
    ticks(world, 10);
    ticks(world, 2 + CATCH_UP, wield(world, WP.LIGHTNING));

    expect(world.view.lightningBolt()).toMatchObject({ hit: false });
  });

  it("meet a shotgun's pellets with everyone where the snapshot carrying it has them", () => {
    // The bot is moved in the very tick the player fires, so the snapshot before has it where it
    // was, and this one 64 units off, where a blast puts all eleven pellets in its box. The
    // blast's knockback moves it on a little before the snapshot is taken, since a bot thinks in
    // the frame and the player before it.
    const world = withBot();
    const firing = wield(world, WP.SHOTGUN);
    put(world, vec3(64, 0, 24));
    const { effects } = ticks(world, 1 + CATCH_UP, firing);

    const there = bot(world).state.pos.trBase.x;
    expect(there).toBeGreaterThan(64);
    const blood = effects.filter((effect) => effect.type === 'blood');
    expect(blood).toHaveLength(11);
    for (const spurt of blood) expect(spurt.origin.x).toBeCloseTo(faceOf(there), 6);
    expect(effects.filter((effect) => effect.type === 'impact')).toEqual([]);
  });
});

/** The flesh hits the server sent this frame, which name whom each struck. */
function fleshHits(world: ViewWorld): GameEntity[] {
  return world.level.gentities.filter(
    (entity) => entity.inuse && entity.s.eType === ET.EVENTS + EV.BULLET_HIT_FLESH
  );
}

describe('another player struck', () => {
  it("bleeds where the player's machinegun round struck them", () => {
    const world = withBot();
    const { effects } = ticks(world, 1 + CATCH_UP, wield(world, WP.MACHINEGUN));

    const [hit] = fleshHits(world);
    expect(hit.s.eventParm).toBe(BOT);
    // The wire sends a whole float as an integer, so a negative zero arrives as a zero.
    const { x, y, z } = hit.s.pos.trBase;
    expect(effects).toEqual([{ type: 'blood', origin: vec3(x + 0, y + 0, z + 0) }]);
    // The bot's face, snapped a whole unit toward the muzzle.
    expect(hit.s.pos.trBase.x).toBe(Math.trunc(faceOf(THERE.x)));
  });

  it("bleeds where the player's lightning struck them", () => {
    const world = withBot();
    const { effects } = ticks(world, 1 + CATCH_UP, wield(world, WP.LIGHTNING));

    expect(effects.map(({ type }) => type)).toEqual(['blood']);
  });

  it('never shows the player their own blood', () => {
    // The bot's machinegun, turned on the player.
    const world = withBot();
    hold(world, { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN, angles: [0, 0x8000, 0] });
    const { effects } = ticks(world, 1 + CATCH_UP);
    hold(world, { weapon: WP.MACHINEGUN, angles: [0, 0x8000, 0] });

    expect(fleshHits(world).map((hit) => hit.s.eventParm)).toEqual([world.game.clientNum]);
    expect(effects.filter((effect) => effect.type === 'blood')).toEqual([]);
  });
});

/** Everything the client prints from now on, and where it clears the notify lines. */
function listen(world: ViewWorld): string[] {
  const heard: string[] = [];
  world.view.console = {
    print: (text) => heard.push(text),
    clearNotify: () => heard.push('<clear>')
  };
  return heard;
}

describe('what the client prints', () => {
  it('prints what the server sends, as it arrives', () => {
    const world = new ViewWorld({ spots: [THERE] });
    const heard = listen(world);
    world.game.host.sendConsoleCommand('addbot grunt\n');
    ticks(world, 40);
    expect(heard).toEqual([
      'UnnamedPlayer^7 entered the game\n',
      'Grunt^7 connected\n',
      'Grunt^7 entered the game\n'
    ]);
  });

  it("prints the obituary of a death at the player's hand, naming them both", () => {
    const world = withBot();
    const heard = listen(world);
    const entity = world.level.gentities[BOT];
    damage(world.level, entity, world.entity, world.entity, null, 200, 0, MOD.RAILGUN);
    ticks(world, 1 + CATCH_UP);
    expect(heard).toEqual(['Grunt^7 was railed by UnnamedPlayer^7\n']);
  });

  it("keeps the killer's name when the player is the one who died, and only for that frame", () => {
    const world = withBot();
    expect(world.view.killedBy).toBeNull();

    damage(world.level, world.entity, world.level.gentities[BOT], world.level.gentities[BOT], null, 200, 0, MOD.RAILGUN);
    ticks(world, 1 + CATCH_UP);
    expect(world.view.killedBy).toBe('Grunt^7');

    // Frame-scoped: the next frame has no death of the player's own in it.
    ticks(world, 1);
    expect(world.view.killedBy).toBeNull();
  });

  it('keeps no killer for a death at someone else\'s hand', () => {
    const world = withBot();
    damage(world.level, world.level.gentities[BOT], world.entity, world.entity, null, 200, 0, MOD.RAILGUN);
    ticks(world, 1 + CATCH_UP);
    expect(world.view.killedBy).toBeNull();
  });

  it('tells a death by their own hand in the gender it is given for them', () => {
    const world = withBot();
    const heard = listen(world);
    const asked: number[] = [];
    world.view.gender = (clientNum) => {
      asked.push(clientNum);
      return 'female';
    };
    const entity = world.level.gentities[BOT];
    // Their own blast hurts them by half.
    damage(world.level, entity, entity, entity, null, 1000, 0, MOD.ROCKET_SPLASH);
    ticks(world, 1 + CATCH_UP);
    expect(heard).toEqual(['Grunt^7 blew herself up.\n']);
    expect(asked).toEqual([BOT]);
  });

  it('clears the notify lines at a restart, before what is printed after it', () => {
    const world = withBot();
    const heard = listen(world);
    world.game.host.sendConsoleCommand('map_restart 0\n');
    ticks(world, 20);
    // Every client begins again and says so, which would be lost if the clear came after.
    expect(heard).toEqual([
      '<clear>',
      'UnnamedPlayer^7 entered the game\n',
      'Grunt^7 entered the game\n'
    ]);
  });
});
