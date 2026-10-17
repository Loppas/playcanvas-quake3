import { describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, type EntityState } from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import { damage } from '../sim/combat';
import {
  BUTTON_AFFIRMATIVE,
  CONTENTS,
  MASK,
  MOD,
  BUTTON_ATTACK,
  EF_DEAD,
  PM_DEAD,
  PM_INTERMISSION,
  PM_SPECTATOR,
  PMF_GRAPPLE_PULL,
  PMOVE_MSEC,
  STAT
} from '../sim/constants';
import { EV, eventNumber } from '../sim/events';
import { ET } from '../sim/game-entity';
import { FALL_DAMAGE_FAR } from '../sim/player-life';
import type { PointContentsFn, TraceFn, UserCmd } from '../sim/types';
import { distinctAsks, recordingTrace } from '../sim/trace-test-fixtures';
import { evaluateTrajectory } from '../sim/trajectory';
import { vec3, copy, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { GRAPPLE_TYPES, type GrappleMode } from '../sim/weapons/grapple';
import { GURP1_SOUND, GURP2_SOUND, type PlayerSound } from './player-events';
import type { PlayerView } from './player-view';
import { CATCH_UP, ViewWorld } from './view-test-fixtures';

/**
 * The player's world inside the real loop, with the weapons hurting through
 * the same client. The rocket-jump goldens of `rocket-jump.test.ts` must survive the hurt.
 *
 * And the view of it: the camera behind the dead, the hurt's kick, and what the body sounds and
 * throws.
 */

const flat = createFlatWorldTrace();

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = 24;

/**
 * How many ticks a fall is given to reach the floor before the test gives up on it: three and a
 * bit seconds, against the second or so the longest drop here takes. A bound rather than a wait,
 * so a player who can never land fails the test instead of hanging the run.
 */
const LANDING_TICKS = 400;

/**
 * The corpses a client draws: the players it was sent that are flagged dead. The player's own
 * entity is not in their snapshot, so with nobody else playing these are the body queue's.
 */
function corpses(view: PlayerView): EntityState[] {
  return view
    .players()
    .map(({ state }) => state)
    .filter((state) => (state.eFlags & EF_DEAD) !== 0);
}

/** `g_allowGrapple`'s value for a style, as CorkScrew's server menu numbers them. */
function grappleType(mode: GrappleMode | null): number {
  return GRAPPLE_TYPES.findIndex((type) => type.mode === mode);
}

/**
 * Spawn a player facing yaw 90, in a match with the settings asked for.
 *
 * Every one of them is a cvar, because that is where the game module reads them: god at the next
 * hit, the spawn armor at the next spawn, and the grapple type at the next think.
 */
function live(
  options: {
    origin?: Vec3;
    trace?: TraceFn;
    grapple?: GrappleMode | null;
    god?: boolean;
    spawnArmor?: number;
  } = {}
): ViewWorld {
  return new ViewWorld({
    origin: options.origin ?? vec3(0, 0, GROUND_Z),
    yaw: 90,
    trace: options.trace ?? flat,
    cvars: {
      g_allowGrapple: String(grappleType(options.grapple ?? null)),
      pcq_god: options.god ? '1' : '0',
      pcq_spawnArmor: String(options.spawnArmor ?? 0)
    }
  });
}

/** Fill in a frame's input. */
function cmd(input: Partial<UserCmd> = {}): Omit<UserCmd, 'serverTime'> {
  return {
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
    angles: vec3(),
    buttons: 0,
    weapon: WP.MACHINEGUN,
    ...input
  };
}

/**
 * Run whole ticks, one to a frame, collecting the `EV_*` events they played.
 *
 * What comes back is what a client would have to go on: the move's own events and the world's
 * alike, because they are on the same player state and there is no other channel out.
 */
function ticks(view: PlayerView, count: number, input: Partial<UserCmd> = {}): number[] {
  const played: number[] = [];
  for (let i = 0; i < count; i++) {
    // `CG_EntityEvent`'s first move: the counter in the top two bits is what tells two of the
    // same event apart, and is no part of which event it is.
    played.push(...view.advance(PMOVE_MSEC, cmd(input)).map(({ event }) => eventNumber(event)));
  }
  return played;
}

/** The grapple key held down: CorkScrew's `+button5`, which is bit 5 of a command's buttons. */
const HOOK = { buttons: BUTTON_AFFIRMATIVE };

/**
 * The rocket launcher aimed at the floor.
 *
 * The yaw is zero because a command's angles are the client's own: the spawn's yaw of 90 reaches
 * the move as `delta_angles`, and sending 90 as well would face the player the other way.
 */
const AIM = { angles: vec3(90, 0, 0), weapon: WP.ROCKET_LAUNCHER };
const FIRE = { ...AIM, buttons: BUTTON_ATTACK };

/** A player with the rocket launcher, past the spawn's 100 ms hold, attack let go. */
function rocketeer(options: { god?: boolean; spawnArmor?: number } = {}): ViewWorld {
  const world = live(options);
  world.state.weapon = WP.ROCKET_LAUNCHER;
  ticks(world.view, 20, AIM);
  return world;
}

/**
 * Fire the rocket at the floor, which goes off on the same tick, and run the ticks it takes the
 * view to draw it.
 *
 * One tick of the shot, because the command runs before the frame rather than inside it: the shot
 * puts the rocket in the world, and the frame that follows it in the same {@link LocalGame.tick}
 * is what moves the rocket — over its 50 ms prestep, which is already enough to reach the floor.
 * The view reads that snapshot {@link CATCH_UP} ticks on, so what the blast did is what the last
 * tick drew.
 */
function fire(view: PlayerView): number[] {
  return [...ticks(view, 1, FIRE), ...ticks(view, CATCH_UP, AIM)];
}

/**
 * The same shot, collecting what the body sounded over its ticks: the frame-scoped outputs are
 * read a tick at a time, because the prediction can raise them a frame before the snapshot's
 * transition would have.
 */
function fireSounds(view: PlayerView): PlayerSound[] {
  const heard: PlayerSound[] = [];
  for (let tick = 0; tick < 1 + CATCH_UP; tick++) {
    view.advance(PMOVE_MSEC, cmd(tick === 0 ? FIRE : AIM));
    heard.push(...view.playerSounds);
  }
  return heard;
}

/**
 * Run ticks until the view says `done`, as many as it takes a snapshot to be drawn and a few, or
 * as many as `limit` gives it.
 */
function until(
  view: PlayerView,
  done: () => boolean,
  input: Partial<UserCmd> = {},
  limit = CATCH_UP + 3
): void {
  for (let tick = 0; tick < limit && !done(); tick++) ticks(view, 1, input);
  expect(done()).toBe(true);
}

/** Kill a rocketeer with their own rocket, returning the tick time of the death. */
function suicide(world: ViewWorld): number {
  world.state.stats[STAT.HEALTH] = 30;
  expect(fire(world.view)).toContain(EV.DEATH1);
  return world.view.player.commandTime;
}

describe('self-damage through the loop', () => {
  it('costs half of a rocket at the feet, and leaves the rocket jump as it was', () => {
    const world = rocketeer();
    const { view } = world;
    // The spawn's think runs to the client's own command time, as Q3's does, and when that lands
    // 8 ms short of its hundred the knockback window's tail leaves a small upward velocity behind.
    // The rocket inherits whatever the player has, so the golden is measured from Q3's own clean
    // state: no velocity at all.
    world.state.velocity = vec3();
    const startZ = view.player.origin.z;
    fire(view);
    expect(view.player.stats[STAT.HEALTH]).toBe(125 - 50);

    let apex = 0;
    for (let i = 0; i < 200; i++) {
      ticks(view, 1, AIM);
      apex = Math.max(apex, view.player.origin.z - startZ);
    }
    // The golden of `rocket-jump.test.ts`.
    expect(apex).toBeCloseTo(165.87, 1);
  });

  it('pushes a player in god mode tick for tick the same, and does not hurt them', () => {
    const hurt = rocketeer();
    const immune = rocketeer({ god: true });

    for (let tick = 0; tick < 150; tick++) {
      const input = tick === 0 ? FIRE : AIM;
      ticks(hurt.view, 1, input);
      ticks(immune.view, 1, input);
      // The rocket flies on the tick after the shot, so the blast lands on the second, and is
      // drawn two after that.
      if (tick === 1 + CATCH_UP) {
        expect(hurt.view.player.stats[STAT.HEALTH]).toBe(75);
        expect(immune.view.player.stats[STAT.HEALTH]).toBe(125);
      }
      expect(immune.view.player.origin).toEqual(hurt.view.player.origin);
      expect(immune.view.player.velocity).toEqual(hurt.view.player.velocity);
    }
  });

  it('lets armor soak two thirds of it', () => {
    const { view } = rocketeer({ spawnArmor: 100 });
    fire(view);
    expect(view.player.stats[STAT.ARMOR]).toBe(67);
    expect(view.player.stats[STAT.HEALTH]).toBe(108);
  });
});

describe('falls through the loop', () => {
  it('cost 10 for a far one, with no pain sound and the blood centred', () => {
    const { view } = live({ origin: vec3(0, 0, GROUND_Z + 450) });
    ticks(view, 1 + CATCH_UP);

    // The tick the health drops on is the landing's: the prediction can draw the landing a frame
    // before the damage reaches the state.
    let before = view.player.stats[STAT.HEALTH];
    let played: number[] = [];
    for (let tick = 0; view.player.groundEntityNum === ENTITYNUM_NONE; tick++) {
      if (tick >= LANDING_TICKS) throw new Error('the player never landed');
      before = view.player.stats[STAT.HEALTH];
      played = ticks(view, 1);
    }
    for (let tick = 0; tick < 2 && before - view.player.stats[STAT.HEALTH] === 0; tick++) {
      played = ticks(view, 1);
    }
    expect(before - view.player.stats[STAT.HEALTH]).toBe(FALL_DAMAGE_FAR);
    expect(played).not.toContain(EV.PAIN);
    expect([view.player.damagePitch, view.player.damageYaw]).toEqual([255, 255]);
  });
});

describe('a restart through the loop', () => {
  /** Level: a rocket fired this way flies on over the floor, along the spawn's own yaw. */
  const LEVEL = { angles: vec3(), weapon: WP.ROCKET_LAUNCHER };

  /**
   * The ticks a restart is given to be drawn. It moves the server's clock 400 ms on, and the
   * client's clock closes the gap by halves, a snapshot at a time: a handful of ticks more than a
   * snapshot of the same match takes.
   */
  const RESTART_TICKS = 12;

  it('clears the projectiles and the hook at the next tick, and spawns the player afresh', () => {
    const world = live({ grapple: 'corkscrew' });
    const { view } = world;
    world.state.weapon = WP.ROCKET_LAUNCHER;
    ticks(view, 20, LEVEL);
    ticks(view, 1, { ...LEVEL, buttons: BUTTON_ATTACK });
    ticks(view, 10, { ...LEVEL, ...HOOK });
    world.state.stats[STAT.HEALTH] = 40;
    // Two: the rocket, and the hook flying level over an open floor with nothing to catch —
    // which is a missile like the rocket and drawn from the same list.
    expect(view.missiles()).toHaveLength(2);
    expect(world.hookPhase()).toBe('flying');

    view.restart();
    expect(view.missiles()).toHaveLength(2);
    until(view, () => view.mapRestart, LEVEL, RESTART_TICKS);
    // A restart is not an event but a server command, because it is something the whole client
    // has to act on rather than something that happened in the world. It is not a respawn either:
    // a respawn is `PERS_SPAWN_COUNT` going up, and a restart starts everybody's count over.
    expect(view.mapRestart).toBe(true);
    expect(view.missiles()).toHaveLength(0);
    expect(world.hookPhase()).toBe('idle');
    expect(view.player.stats[STAT.HEALTH]).toBe(125);
    expect([view.player.origin.x, view.player.origin.y]).toEqual([0, 0]);
  });

  it('leaves the player able to move, on the server id the restart sent', () => {
    // The id comes in a `cs`, since a restart in place sends no gamestate. A client that kept the
    // old one had every move dropped, and hung where the spawn put it.
    const world = live();
    world.view.restart();
    ticks(world.view, 1);
    const start = world.view.player.origin.y;

    ticks(world.view, 20, { forwardmove: 127 });
    expect(world.view.player.origin.y).toBeGreaterThan(start + 1);
  });

  it('is the word `map_restart` and not any word the server says', () => {
    // The host has more to say to a client than a restart, and `CG_ServerCommand` tells them
    // apart by the first token of the command rather than by one having arrived at all.
    const world = live();
    world.game.host.sendServerCommand(world.game.clientNum, 'print "map_restart is a word\n"');
    ticks(world.view, 1);
    expect(world.view.mapRestart).toBe(false);
  });

  it('loads the map again when a latched setting changed, and comes back into it', () => {
    // `sv_maxclients` is one of the two the match is built around, and neither can be taken up
    // where the match stands, so the restart is a map load rather than a restart in place. The
    // client is left holding a world that no longer exists: it is given a new gamestate, and the
    // command it sends against that is what puts it back in.
    const world = live();
    ticks(world.view, 20, { forwardmove: 127 });
    expect(world.view.player.origin.y).toBeGreaterThan(1);

    world.cvars.set('sv_maxclients', '4');
    world.view.restart();
    // The new gamestate goes in fragments, which the frames carry: the command the client
    // sends against it is what puts it back in, a few frames on.
    for (let i = 0; i < 10 && world.view.player.origin.y !== 0; i++) ticks(world.view, 1);

    expect(world.view.player.stats[STAT.HEALTH]).toBe(125);
    expect([world.view.player.origin.x, world.view.player.origin.y]).toEqual([0, 0]);
  });

  it('empties the body queue', () => {
    const world = rocketeer();
    suicide(world);
    let respawned = false;
    for (let tick = 0; tick < 400 && !respawned; tick++) {
      ticks(world.view, 1, FIRE);
      respawned = world.view.respawned;
    }
    expect(corpses(world.view)).toHaveLength(1);

    world.view.restart();
    until(world.view, () => world.view.mapRestart, AIM, RESTART_TICKS);
    expect(corpses(world.view)).toHaveLength(0);
  });
});

describe('death through the loop', () => {
  it('lets go of the hook, and throws no other while dead', () => {
    // A wall along +y, which the spawn faces: the hook is thrown before the move reads the
    // input's angles, so its first tick throws along the spawn's yaw.
    const wall = createFlatWorldTrace([box(-256, 200, 0, 256, 232, 512)]);
    const world = live({ trace: wall, grapple: 'corkscrew' });
    const { view } = world;
    for (let tick = 0; tick < 60 && world.hookPhase() !== 'attached'; tick++) {
      ticks(view, 1, HOOK);
    }
    expect(world.hookPhase()).toBe('attached');

    world.state.stats[STAT.HEALTH] = 5;
    damage(world.level, world.entity, null, null, null, 10, 0, MOD.FALLING);
    ticks(view, 1 + CATCH_UP, HOOK);
    expect(view.player.pmType).toBe(PM_DEAD);
    expect(world.hookPhase()).toBe('idle');
    expect(view.player.pmFlags & PMF_GRAPPLE_PULL).toBe(0);

    ticks(view, 20, { angles: vec3(20, 300, 0), ...HOOK });
    expect(world.hookPhase()).toBe('idle');
  });

  it('turns the view to the spawn yaw and holds it while the mouse moves', () => {
    const world = rocketeer();
    suicide(world);
    ticks(world.view, 20, { angles: vec3(20, 300, 0) });
    expect(world.view.player.viewangles).toEqual(vec3(0, 90, 0));
    expect(world.view.player.weapon).toBe(WP.NONE);
  });
});

describe('respawn through the loop', () => {
  it('comes on the click 1712 ms after the death, at the 8 ms tick', () => {
    const world = rocketeer();
    const died = suicide(world);

    let respawned = 0;
    for (let tick = 0; tick < 400 && !respawned; tick++) {
      ticks(world.view, 1, FIRE);
      if (world.view.respawned) {
        respawned = world.view.player.commandTime;
      }
    }
    // 1700 ms from the frame the rocket went off in, as `player_die` stamps it, at the first 8 ms
    // frame past it, and a spawn sets the command clock to that frame's. The rocket went off in the
    // frame after the command that fired it, whose time `died` is.
    expect(respawned - died).toBe(PMOVE_MSEC + 1704);
    expect(corpses(world.view)).toHaveLength(1);
  });

  it('is forced 21.7 s after the frame of the death with nothing pressed', () => {
    const world = rocketeer();
    const died = suicide(world);

    let respawned = 0;
    for (let tick = 0; tick < 3000 && !respawned; tick++) {
      ticks(world.view, 1, AIM);
      if (world.view.respawned) {
        respawned = world.view.player.commandTime;
      }
    }
    expect(respawned - died).toBe(PMOVE_MSEC + 21_704);
  });

  it('does not fire on the click that respawned, until attack is let go', () => {
    const world = rocketeer();
    suicide(world);
    ticks(world.view, 214, FIRE);
    expect(world.view.player.pmType).not.toBe(PM_DEAD);

    const held = { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN };
    for (let tick = 0; tick < 50; tick++) {
      expect(ticks(world.view, 1, held)).not.toContain(EV.FIRE_WEAPON);
    }

    ticks(world.view, 1, { weapon: WP.MACHINEGUN });
    expect(ticks(world.view, 1 + CATCH_UP, held)).toContain(EV.FIRE_WEAPON);
  });

  it('is a teleport, drawn at the spawn with nothing to interpolate from', () => {
    const world = rocketeer();
    suicide(world);
    // The body well away from the spawn, so that anything drawn between the two would show.
    world.state.origin = vec3(300, 0, GROUND_Z);
    ticks(world.view, 210, FIRE);

    for (let frame = 0; frame < 30 && !world.view.respawned; frame++) {
      world.view.advance(PMOVE_MSEC / 2, cmd(FIRE));
      expect([300, 0]).toContain(world.view.sample().origin.x);
    }
    expect(world.view.respawned).toBe(true);
    expect(world.view.sample().origin).toEqual(vec3(0, 0, GROUND_Z));
  });

  it('faces the spawn, whatever angles the click was held at', () => {
    const world = rocketeer();
    suicide(world);
    ticks(world.view, 210, FIRE);

    // Looking along yaw 0 as the click lands: the spawn moves `delta_angles` under it. The yaw is
    // the spawn's; the pitch keeps whatever `PM_UpdateViewAngles`'s fix-up left on the delta as
    // the replay turned the held commands, which is Q3's own arithmetic.
    until(world.view, () => world.view.respawned, { buttons: BUTTON_ATTACK, angles: vec3() });
    expect(world.view.player.viewangles.y).toBe(90);
    expect(world.view.sample().viewangles.y).toBe(90);
  });
});

/** Run whole ticks, collecting what the player's body sounded. */
function heard(view: PlayerView, count: number, input: Partial<UserCmd> = {}): PlayerSound[] {
  const sounds: PlayerSound[] = [];
  for (let i = 0; i < count; i++) {
    view.advance(PMOVE_MSEC, cmd(input));
    sounds.push(...view.playerSounds);
  }
  return sounds;
}

describe('the view of a death', () => {
  it("looks out of a spectator's eyes, though a dead player's health flies there", () => {
    const world = rocketeer();
    suicide(world);
    const { view } = world;
    view.player.pmType = PM_SPECTATOR;

    expect(view.renderingThirdPerson).toBe(false);
    expect(view.bodyDrawn).toBe(false);
  });

  it('shows the dead player from behind, looking along the dead yaw', () => {
    const world = rocketeer();
    suicide(world);
    const { view } = world;
    expect(view.renderingThirdPerson).toBe(true);

    const sample = view.sample();
    const camera = view.view();
    const yaw = view.player.stats[STAT.DEAD_YAW];
    expect(camera.angles.y).toBe(yaw);
    // Behind the eye along the dead yaw, and 8 above it: nothing in the open air is in the way.
    const radians = (yaw * Math.PI) / 180;
    expect(camera.origin.x).toBeCloseTo(sample.origin.x - 40 * Math.cos(radians), 6);
    expect(camera.origin.y).toBeCloseTo(sample.origin.y - 40 * Math.sin(radians), 6);
    expect(camera.origin.z).toBeCloseTo(sample.origin.z + sample.viewheight + 8, 6);
  });

  it('looks from the intermission as the state stands, ahead of the third person', () => {
    const world = rocketeer();
    suicide(world);
    const { view } = world;
    view.thirdPerson = true;
    view.player.pmType = PM_INTERMISSION;

    const sample = view.sample();
    // No eye height, no offset and no trace: the state's own origin and angles.
    expect(view.view()).toEqual({ origin: sample.origin, angles: sample.viewangles });
  });

  it("traces the camera past the view's own player", () => {
    const { trace, asked } = recordingTrace(flat);
    const world = live({ trace });
    world.view.thirdPerson = true;
    ticks(world.view, 5);

    asked.length = 0;
    world.view.view();

    expect(distinctAsks(asked)).toEqual([
      { passEntityNum: world.game.clientNum, contentmask: MASK.SOLID }
    ]);
  });

  it('puts the camera behind a living player too with cg_thirdPerson', () => {
    const { view } = live();
    view.thirdPerson = true;
    ticks(view, 5);
    expect(view.renderingThirdPerson).toBe(true);

    const sample = view.sample();
    const camera = view.view();
    expect(camera.origin.x).toBeCloseTo(sample.origin.x, 6);
    expect(camera.origin.y).toBeCloseTo(sample.origin.y - 40, 6);
    expect(camera.origin.z).toBeCloseTo(sample.origin.z + sample.viewheight + 8, 6);
    expect(camera.angles.y).toBe(90);
  });
});

describe('the feedback of a hurt', () => {
  it('kicks the view back from a blast at the feet of a downward look, as hard as it goes', () => {
    const world = rocketeer();
    // Run the shot until the hurt's feedback is raised, which the prediction can do a frame
    // before the snapshot's transition would.
    let raised = world.view.time;
    for (let tick = 0; tick < CATCH_UP + 3 && world.view.damage.value === 0; tick++) {
      world.view.advance(PMOVE_MSEC, cmd(tick === 0 ? FIRE : AIM));
      raised = world.view.time;
    }
    const { damage } = world.view;
    // Timed by the snapshot it came in, `cg.snap->serverTime`, which is on the server's 8 ms
    // frames and within a frame or so of the clock it was raised on.
    expect(damage.time % PMOVE_MSEC).toBe(0);
    expect(Math.abs(raised - damage.time)).toBeLessThan(2 * PMOVE_MSEC);
    // 50 at 75 health: 40/75 of it is 26.7, held to 10.
    expect(damage.value).toBe(10);
    expect(damage.pitch).toBeLessThan(-9);
  });

  it("plays the pain of a hurt, and times the torso's twitch from it", () => {
    const world = rocketeer();
    const heard: PlayerSound[] = [];
    let painAt = 0;
    for (let tick = 0; tick < 1 + CATCH_UP; tick++) {
      world.view.advance(PMOVE_MSEC, cmd(tick === 0 ? FIRE : AIM));
      heard.push(...world.view.playerSounds);
      if (world.view.playerSounds.length > 0) painAt = world.view.time;
    }
    expect(heard).toEqual<PlayerSound[]>([{ type: 'custom', name: 'pain100_1' }]);
    // On the frame's clock, as `cg.time` dates it.
    expect(world.view.pain).toEqual({ time: painAt, direction: 1 });
  });
});

describe("the body's sounds", () => {
  it('plays the death, and no pain, for the hurt that kills', () => {
    const world = rocketeer();
    world.state.stats[STAT.HEALTH] = 30;
    expect(fireSounds(world.view)).toEqual<PlayerSound[]>([{ type: 'custom', name: 'death1' }]);
  });

  it("gurgles a hurt and drowns the death where the client's contents hold the head under", () => {
    const water: PointContentsFn = (point) => (point.z < 100 ? CONTENTS.WATER : 0);
    const world = new ViewWorld({ trace: flat, pointContents: water });
    ticks(world.view, 20);
    damage(world.level, world.entity, null, null, null, 20, 0, MOD.FALLING);
    const hurt = heard(world.view, 1 + CATCH_UP);
    expect(hurt).toHaveLength(1);
    expect(hurt[0].type === 'shared' && [GURP1_SOUND, GURP2_SOUND].includes(hurt[0].path)).toBe(
      true
    );

    const health = world.state.stats[STAT.HEALTH];
    damage(world.level, world.entity, null, null, null, health + 5, 0, MOD.FALLING);
    expect(heard(world.view, 1 + CATCH_UP)).toEqual<PlayerSound[]>([
      { type: 'custom', name: 'drown' }
    ]);
  });

  it("plays a far fall's own sound, and no pain in the half second after", () => {
    const { view } = live({ origin: vec3(0, 0, GROUND_Z + 450) });
    const sounds = heard(view, 1 + CATCH_UP);
    for (let tick = 0; view.player.groundEntityNum === ENTITYNUM_NONE; tick++) {
      if (tick >= LANDING_TICKS) throw new Error('the player never landed');
      sounds.push(...heard(view, 1));
    }
    sounds.push(...heard(view, 63));
    expect(sounds).toEqual<PlayerSound[]>([{ type: 'custom', name: 'fall1' }]);
  });

  it('jumps with jump1', () => {
    const { view } = live();
    ticks(view, 20);
    const sounds = [...heard(view, 1, { upmove: 127 }), ...heard(view, CATCH_UP)];
    expect(sounds).toContainEqual({ type: 'custom', name: 'jump1' });
  });
});

describe('the gibs', () => {
  it('throws them where the player went to pieces, and shows no body until the respawn', () => {
    const world = rocketeer();
    world.state.stats[STAT.HEALTH] = 10;
    const gibs: Vec3[] = [];
    const heard: PlayerSound[] = [];
    const played: number[] = [];
    let gibAt: Vec3 | null = null;
    for (let tick = 0; tick < 1 + CATCH_UP; tick++) {
      played.push(
        ...world.view
          .advance(PMOVE_MSEC, cmd(tick === 0 ? FIRE : AIM))
          .map(({ event }) => eventNumber(event))
      );
      if (world.view.gibOrigins.length > 0) gibAt = copy(world.view.player.origin);
      gibs.push(...world.view.gibOrigins);
      heard.push(...world.view.playerSounds);
    }
    expect(played).toContain(EV.GIB_PLAYER);
    expect(gibs).toEqual([gibAt]);
    expect(heard).toEqual<PlayerSound[]>([
      { type: 'shared', path: 'sound/player/gibsplt1.wav' }
    ]);
    expect(world.view.gibbed).toBe(true);
    expect(world.view.bodyDrawn).toBe(false);

    ticks(world.view, 250, FIRE);
    expect(world.view.gibbed).toBe(false);
    expect(world.view.bodyDrawn).toBe(true);
  });
});

describe('what a client draws as a player', () => {
  it('is every ET_PLAYER in the world, a corpse being one flagged dead', () => {
    // `ET_PLAYER` is the whole reading a client makes, and `EF_DEAD` what lays one out on the
    // floor. Anything else in the world is drawn by something else, or not at all.
    const world = live();
    const { view } = world;
    const other = world.level.spawnEntity();
    other.s.eType = ET.PLAYER;
    world.level.linkEntity(other);
    const missile = world.level.spawnEntity();
    missile.s.eType = ET.MISSILE;
    world.level.linkEntity(missile);
    ticks(view, 1 + CATCH_UP);
    expect(view.players().map(({ state }) => state.number)).toEqual([other.s.number]);
    expect(corpses(view)).toHaveLength(0);

    other.s.eFlags |= EF_DEAD;
    ticks(view, 1 + CATCH_UP);
    expect(corpses(view).map((body) => body.number)).toEqual([other.s.number]);
  });
});

describe('a corpse in a blast', () => {
  it('goes to pieces where it lay, with its splat from there, and leaves the player whole', () => {
    const world = rocketeer();
    suicide(world);
    let respawned = false;
    for (let tick = 0; tick < 400 && !respawned; tick++) {
      ticks(world.view, 1, FIRE);
      respawned = world.view.respawned;
    }
    const [body] = corpses(world.view);
    expect(body.eType).toBe(ET.PLAYER);
    const slot = body.number;

    // The rocket launcher again, attack let go, then a rocket at the feet, which stand where the
    // corpse came down: the spawn. The spawn turned the view level under the angles the click was
    // held at, so looking down again is the client's own move to make.
    world.state.weapon = WP.ROCKET_LAUNCHER;
    const down = { angles: world.aim(vec3(85, 90, 0)), weapon: WP.ROCKET_LAUNCHER };
    ticks(world.view, 20, down);
    // The corpse's gib is on the corpse, so it reaches the view as its own entity's event and
    // not as one of the player's — which is what puts the splat where the body lies.
    const played = [
      ...ticks(world.view, 1, { ...down, buttons: BUTTON_ATTACK }),
      ...ticks(world.view, CATCH_UP, down)
    ];
    const where = evaluateTrajectory(body.pos, world.view.player.commandTime);
    expect(played).not.toContain(EV.GIB_PLAYER);
    expect(world.view.entitySounds).toEqual([
      {
        number: slot,
        origin: where,
        voice: world.game.clientNum,
        sound: { type: 'shared', path: 'sound/player/gibsplt1.wav' }
      }
    ]);
    // Nothing left to draw, so it is out of the list a client draws corpses from.
    expect(corpses(world.view)).toHaveLength(0);
    expect(world.view.gibOrigins).toEqual([where]);
    expect(world.view.player.stats[STAT.HEALTH]).toBe(125 - 50);
    expect(world.view.gibbed).toBe(false);
  });
});
