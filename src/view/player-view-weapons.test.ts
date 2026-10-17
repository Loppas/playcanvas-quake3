import { describe, expect, it } from 'vitest';

import type { PlayerState } from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import { BUTTON_ATTACK, PMOVE_MSEC } from '../sim/constants';
import { EV, eventNumber } from '../sim/events';
import type { UserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { MISSILE_PRESTEP_TIME, WP, type WeaponId } from '../sim/weapons/constants';
import { evaluateTrajectory } from '../sim/trajectory';
import type { WorldEffect } from './entity-events';
import type { PlayerView } from './player-view';
import { CATCH_UP, ViewWorld } from './view-test-fixtures';

/**
 * Firing through the frame loop — the seam between `PM_Weapon` and the renderer.
 *
 * The sim's own tests drive `pmove` and `WeaponSystem` tick by tick. What is new here is that a
 * *rendered frame* is not a tick: these tests are about which frame a shot is drawn on, how it is
 * dated, and whether what it did comes back with it.
 */

const flat = createFlatWorldTrace();

/** A 60 Hz frame covers two 8 ms ticks with 0.67 ms left over. */
const FRAME_MSEC = 1000 / 60;

let world: ViewWorld;
let state: PlayerState;
let view: PlayerView;
/** The clock the player was armed on, which every golden below is measured from. */
let armedAt: number;

/**
 * Arm the player and drive them through a real match.
 *
 * The spawn hands out every weapon with infinite ammo, so arming is only a matter of choosing
 * which one is in hand; the view angles are the spawn point's, and the client holds its own
 * command angles at zero throughout.
 *
 * @param weapon - Weapon in hand.
 * @param pitch - Q3 view pitch; positive looks **down**.
 */
function arm(
  weapon: WeaponId,
  pitch = 0,
  trace = flat,
  cvars: Record<string, string> = {}
): void {
  world = new ViewWorld({ origin: vec3(0, 0, 24), pitch, trace, cvars });
  state = world.state;
  state.weapon = weapon;
  view = world.view;
  // "Don't allow attack until all buttons are up" (`bg_pmove.c:1543–1546`): a spawn sets
  // `PMF_RESPAWNED` and one tick with nothing held is what clears it, as the tick between
  // spawning and reaching for the trigger does in a game.
  view.advance(PMOVE_MSEC, cmd(false));
  armedAt = view.time;
}

/**
 * One frame's input.
 *
 * `weapon` matches what is held, because a `cmd.weapon` that disagrees with `ps.weapon` is a
 * *switch request* — leaving it at 0 would put the player into a 450 ms weapon change instead
 * of firing. The angles stay at zero: where the player is looking is the spawn's, and it reaches
 * the move as `delta_angles` rather than as anything the client sends.
 *
 * @param attack - Whether the attack button is held.
 */
function cmd(attack: boolean): Omit<UserCmd, 'serverTime'> {
  return {
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
    angles: vec3(),
    buttons: attack ? BUTTON_ATTACK : 0,
    weapon: state.weapon
  };
}

/**
 * Run frames of held input, and then the frames it takes the last of them to be drawn, and count
 * the shots, which are the move's own events.
 */
function fireFor(msec: number, frameMsec = FRAME_MSEC): number {
  const shots = (attack: boolean): number =>
    view
      .advance(frameMsec, cmd(attack))
      .filter(({ event }) => eventNumber(event) === EV.FIRE_WEAPON).length;
  let fired = 0;
  for (let elapsed = 0; elapsed < msec; elapsed += frameMsec) fired += shots(true);
  for (let frame = 0; frame < CATCH_UP; frame++) fired += shots(false);
  return fired;
}

/** Run 8 ms frames of `attack` until the view says `done`, as many as a snapshot takes. */
function until(done: () => boolean, attack = false): void {
  for (let frame = 0; frame < CATCH_UP + 3 && !done(); frame++) {
    view.advance(PMOVE_MSEC, cmd(attack));
  }
  expect(done()).toBe(true);
}

describe('beam weapons', () => {
  /** A wall across the view 256 units ahead, inside both the rail's and the lightning's range. */
  const walled = createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]);

  /** Fire until the frame the shot's own effects arrive on, and return them. */
  function fireOnce(weapon: WeaponId, cvars: Record<string, string> = {}): readonly WorldEffect[] {
    arm(weapon, 0, walled, cvars);
    for (let frame = 0; frame < 30; frame++) {
      view.advance(FRAME_MSEC, cmd(true));
      if (view.effects.length > 0) return view.effects;
    }
    throw new Error('nothing was fired');
  }

  it('draw the rail beam and the impact at its far end as two things', () => {
    // `EV_RAILTRAIL` carries both: the line, from the muzzle to where the trace stopped, and the
    // surface it stopped on, packed into the event's one byte.
    const effects = fireOnce(WP.RAILGUN);

    const beam = effects.find((effect) => effect.type === 'beam');
    expect(beam).toMatchObject({ weapon: WP.RAILGUN, hit: true });
    expect(beam!.end.x).toBeGreaterThan(250);

    const impact = effects.find((effect) => effect.type === 'impact');
    expect(impact!.weapon).toBe(WP.RAILGUN);
    // Within the 162 directions a byte can name: the wall faces back down the shot.
    expect(impact!.normal.x).toBeLessThan(-0.98);
  });

  it('draw nothing for the lightning gun but the impact, which its beam already shows', () => {
    // `Weapon_LightningFire` sends no beam: the bolt is redrawn client-side every frame from
    // `EF_FIRING`, and all that reaches the wire is where it ends.
    const effects = fireOnce(WP.LIGHTNING);

    expect(effects.some((effect) => effect.type === 'beam')).toBe(false);
    const impact = effects.find((effect) => effect.type === 'impact');
    // The event names no weapon, and `CG_MissileHitWall`'s default case is the lightning gun's.
    expect(impact!.weapon).toBe(WP.LIGHTNING);
    expect(impact!.normal.x).toBeLessThan(-0.98);
  });

  it('scatter eleven shotgun pellets the client traces for itself', () => {
    // One event carrying a seed and the aim, from which the client works out the same pattern
    // the server traced — so eleven marks appear for the price of one event.
    const effects = fireOnce(WP.SHOTGUN);

    const pellets = effects.filter((effect) => effect.type === 'impact');
    expect(pellets).toHaveLength(11);
    expect(pellets.every((pellet) => pellet.weapon === WP.SHOTGUN)).toBe(true);
    // Scattered, not eleven copies of one point.
    expect(new Set(pellets.map((pellet) => pellet.origin.y)).size).toBeGreaterThan(1);
  });

  it("scatter CPMA's sixteen where the serverinfo names its pattern", () => {
    const effects = fireOnce(WP.SHOTGUN, { g_pattern_sg: '1', g_pellets_sg: '16' });

    const pellets = effects.filter((effect) => effect.type === 'impact');
    expect(pellets).toHaveLength(16);
    // The table's offsets, the widest seven times the narrowest.
    const offsets = pellets.map((pellet) => Math.abs(pellet.origin.y));
    expect(Math.max(...offsets) / Math.min(...offsets)).toBeCloseTo(7, 2);
  });
});

describe('firing through a frame', () => {
  it('puts a rocket in the world, which is the whole of what a shot leaves behind', () => {
    arm(WP.ROCKET_LAUNCHER);
    const events = view.advance(FRAME_MSEC, cmd(true));
    for (let frame = 0; frame < CATCH_UP; frame++) {
      events.push(...view.advance(FRAME_MSEC, cmd(false)));
    }

    expect(events.map(({ event }) => eventNumber(event))).toContain(EV.FIRE_WEAPON);
    expect(world.missiles()).toHaveLength(1);
    // Nothing has been hit yet, so there is nothing to draw but the missile itself.
    expect(view.effects).toEqual([]);
  });

  it('dates a shot to the frame that draws it, as `cg.time` does', () => {
    // `CG_FireWeapon`'s `muzzleFlashTime = cg.time`: the flash and the recoil run from when the
    // client learns of the shot, on the clock they are drawn on.
    arm(WP.ROCKET_LAUNCHER);
    view.advance(PMOVE_MSEC, cmd(true));
    until(() => view.lastFireTime > Number.NEGATIVE_INFINITY);
    expect(view.lastFireTime).toBe(view.time);
    expect(view.lastFireTime).toBeGreaterThan(armedAt);
  });

  it("stamps the railgun's own shot, which is what brings its glow back", () => {
    // `cent->pe.railFireTime` (`cg_weapons.c:1704-1706`): the glow returns from the moment the
    // railgun fired, so it is kept apart from the shot that times the flash and the recoil.
    arm(WP.RAILGUN);
    view.advance(PMOVE_MSEC, cmd(true));
    until(() => view.railFireTime > Number.NEGATIVE_INFINITY);
    expect(view.railFireTime).toBe(view.time);

    arm(WP.MACHINEGUN);
    view.advance(PMOVE_MSEC, cmd(true));
    until(() => view.lastFireTime > Number.NEGATIVE_INFINITY);
    expect(view.railFireTime).toBe(Number.NEGATIVE_INFINITY);
  });

  it("forgets the last world's shots at a new gamestate, whose clock starts again", () => {
    // The flash, the recoil and the rail's glow would wait on the new clock for the old stamps.
    arm(WP.RAILGUN);
    view.advance(PMOVE_MSEC, cmd(true));
    until(() => view.railFireTime > Number.NEGATIVE_INFINITY);

    world.load(() => view.advance(FRAME_MSEC, cmd(false)));
    expect([view.lastFireTime, view.railFireTime]).toEqual([
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    ]);
  });

  it('clears effects each frame, so nothing is drawn twice', () => {
    // Into a wall, so there is an impact to draw at all.
    arm(WP.MACHINEGUN, 0, createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]));
    view.advance(PMOVE_MSEC, cmd(true));
    until(() => view.effects.length > 0);
    const fired = view.lastFireTime;

    view.advance(FRAME_MSEC, cmd(false));
    expect(view.effects).toEqual([]);
    // The shot itself is not forgotten — the viewmodel still times its recoil from it.
    expect(view.lastFireTime).toBe(fired);
  });

  it('carries the attack button all the way to PM_Weapon at the right cadence', () => {
    arm(WP.MACHINEGUN);
    // Measured, not derived: the first shot goes off on the first tick, before any interval
    // has had to elapse, so a second of held fire is 1 + 10 rather than the round 10 the
    // 100 ms figure suggests. The 50 ms more keep the count off the second's edge, which the
    // client's clock settling in behind the snapshots moves by a tick.
    expect(fireFor(1050)).toBe(11);
  });

  it('holds the rocket launcher to its own much slower cadence', () => {
    arm(WP.ROCKET_LAUNCHER);
    // Same free first shot, then one more at 808 ms.
    expect(fireFor(1000)).toBe(2);
  });

  it('stops firing when the button is released', () => {
    arm(WP.MACHINEGUN);
    fireFor(1000);
    let shots = 0;
    for (let i = 0; i < 60; i++) {
      shots += view
        .advance(FRAME_MSEC, cmd(false))
        .filter(({ event }) => eventNumber(event) === EV.FIRE_WEAPON).length;
    }
    expect(shots).toBe(0);
  });
});

describe('resolution inside the tick loop', () => {
  it('lets a rocket jump lift the player on the snapshot that carries the blast', () => {
    // Looking straight down. The muzzle sits 14 units along `forward` from the eye, and the
    // 50 ms prestep puts the rocket 45 units further on before its first step — under the
    // floor, so it detonates immediately.
    arm(WP.ROCKET_LAUNCHER, 90);
    view.advance(PMOVE_MSEC, cmd(true));
    until(() => view.effects.some((effect) => effect.type === 'impact'));
    // The blast is drawn from the next snapshot as soon as it comes, and the player state that
    // snapshot carries is the player's when its frame does.
    view.advance(PMOVE_MSEC, cmd(false));

    // Resolving after the tick instead of inside it would leave this at the tick's -6.4
    // (one tick of gravity) and put the jump a snapshot after the blast.
    expect(view.player.velocity.z).toBeGreaterThan(300);
    // The blast came after the move in its frame, so the next move is the one that lifts them.
    view.advance(PMOVE_MSEC, cmd(false));
    expect(view.player.origin.z).toBeGreaterThan(24);
  });

  it('carries projectiles forward on the simulation clock, not the frame clock', () => {
    arm(WP.ROCKET_LAUNCHER);
    view.advance(PMOVE_MSEC, cmd(true));
    const missile = world.missiles()[0];
    // The muzzle the rocket was created at, not where it already is: `G_RunFrame` runs the
    // missile on the same frame the command that fired it ran on, so the 50 ms prestep is already
    // behind it by the time anything can look.
    const launchX = missile.s.pos.trBase.x;

    view.advance(10 * PMOVE_MSEC, cmd(false));

    // Traced to the last completed frame — not to `view.time`, which runs ahead by whatever real
    // time is still unsimulated, and not left at the muzzle. Where collision thinks it is and
    // where the trajectory puts it are the same point, because nothing was in the way.
    const now = world.level.time;
    expect(missile.r.currentOrigin).toEqual(evaluateTrajectory(missile.s.pos, now));
    // 900 ups over the ticks it has flown, plus the 50 ms prestep that is already on its clock
    // when it is created, plus the one tick between the command and the frame: a think runs
    // against the world as the last frame left it, so the shot is stamped with that frame's clock
    // and the frame that follows moves the rocket over the whole of it.
    expect(missile.r.currentOrigin.x - launchX).toBeCloseTo(
      0.9 * (11 * PMOVE_MSEC + MISSILE_PRESTEP_TIME),
      6
    );
  });
});
