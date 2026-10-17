import { describe, expect, it } from 'vitest';

import { EV, eventNumber } from './events';
import { ET, type GameEntity } from './game-entity';
import { findItemForWeapon, itemIndex } from './items';
import type { Level } from './level';
import { SHOOTER_TARGET_DELAY } from './shooters';
import { clientAt, runUntil, spawnedLevel } from './trigger-test-fixtures';
import { vec3 } from './vec3';
import { WP } from './weapons/constants';

/**
 * Shooters (`g_misc.c:240–337`). The scatter is ioquake3's C in q3lcc's floats, compiled and
 * printed (scratchpad `m3c/twin.c`), at the draws given.
 */

/** The first entity of a classname in a level. */
function first(world: Level, classname: string): GameEntity {
  return world.find(null, 'classname', classname)!;
}

/** The missiles in a level. */
function missiles(world: Level): GameEntity[] {
  return world.gentities.filter((e) => e.inuse && e.s.eType === ET.MISSILE);
}

/** A shooter of a class at (10.5 20 30), with these keys besides, and the draws it scatters by. */
function shooterOf(classname: string, keys: Record<string, string> = {}, ...draws: number[]) {
  let drawn = 0;
  const random = () => (draws.length ? draws[drawn++ % draws.length] : 0.5);
  const world = spawnedLevel([{ classname, origin: '10.5 20 30', ...keys }], undefined, random);
  return { world, shooter: first(world, classname) };
}

describe('spawning a shooter', () => {
  it.each([
    ['shooter_rocket', WP.ROCKET_LAUNCHER],
    ['shooter_grenade', WP.GRENADE_LAUNCHER],
    ['shooter_plasma', WP.PLASMAGUN]
  ])('makes a %s a point in the world with its weapon, registered for the clients', (name, wp) => {
    const { world, shooter } = shooterOf(name);
    expect(shooter.s.weapon).toBe(wp);
    expect(shooter.s.eType).toBe(ET.GENERAL);
    expect(shooter.r.linked).toBe(true);
    expect(world.itemsRegistered[itemIndex(findItemForWeapon(wp))]).toBe(true);
  });

  it.each([
    [undefined, 0.017452405765652657],
    ['50', 0.76604443788528442],
    ['3', 0.052335958927869797],
    ['0.5', 0.008726535364985466],
    ['45', 0.70710676908493042],
    ['90', 1]
  ])('scatters by the sine of a random of %s degrees, as the QVM: %f', (random, sine) => {
    const keys: Record<string, string> = random === undefined ? {} : { random };
    expect(shooterOf('shooter_rocket', keys).shooter.random).toBe(sine);
  });

  it('aims along its angles, which it clears', () => {
    const { shooter } = shooterOf('shooter_rocket', { angles: '-90 0 0' });
    expect(shooter.s.angles).toEqual(vec3());
    expect(shooter.movedir.z).toBe(1);
  });

  it('finds its target half a second in, once', () => {
    const { world, shooter } = shooterOf('shooter_rocket', { target: 'mark' });
    const mark = world.spawnEntity();
    mark.targetname = 'mark';
    expect(shooter.nextthink).toBe(SHOOTER_TARGET_DELAY);
    expect(SHOOTER_TARGET_DELAY).toBe(500);
    runUntil(world, 504);
    expect(shooter.enemy).toBe(mark);
    expect(shooter.think).toBeNull();
    expect(shooter.nextthink).toBe(0);
  });
});

describe('firing a shooter', () => {
  it('fires its weapon’s missile from where it stands, kept whole, and is seen to', () => {
    const { world, shooter } = shooterOf('shooter_rocket', { angle: '0' });
    shooter.use!(shooter, shooter, shooter);
    const [rocket] = missiles(world);
    expect(rocket.s.weapon).toBe(WP.ROCKET_LAUNCHER);
    expect(rocket.s.pos.trBase).toEqual(vec3(10.5, 20, 30));
    expect(rocket.r.ownerNum).toBe(shooter.s.number);
    expect(rocket.parent).toBe(shooter);
    // Draws of 0.5 scatter it not at all.
    expect(rocket.s.pos.trDelta.x).toBe(900);
    expect(eventNumber(shooter.s.event)).toBe(EV.FIRE_WEAPON);
  });

  it('scatters its shot as the QVM does, by two draws across a perpendicular', () => {
    // Twin: a random of 50 and draws of 0.75 then 0.125 turn (1 0 0) to (0.82288658618927002,
    // 0.3151838481426239, 0.47277578711509705).
    const keys = { angle: '0', random: '50' };
    const { world, shooter } = shooterOf('shooter_rocket', keys, 0.75, 0.125);
    shooter.use!(shooter, shooter, shooter);
    expect(missiles(world)[0].s.pos.trDelta).toEqual(vec3(740, 283, 425));
  });

  it('lobs no grenade: the lift is the launcher’s, not the missile’s', () => {
    const { world, shooter } = shooterOf('shooter_grenade', { angle: '0' });
    shooter.use!(shooter, shooter, shooter);
    const { trDelta } = missiles(world)[0].s.pos;
    expect(trDelta.x).toBe(700);
    expect(Math.abs(trDelta.z)).toBe(0);
  });

  it('fires at its target where the target is now', () => {
    const { world, shooter } = shooterOf('shooter_plasma', { target: 'mark' });
    const mark = clientAt(world, 0, vec3(10.5, 20, 30));
    mark.targetname = 'mark';
    runUntil(world, 504);
    mark.r.currentOrigin = vec3(10.5, 2020, 30);
    shooter.use!(shooter, shooter, shooter);
    const { trDelta } = missiles(world)[0].s.pos;
    expect(trDelta.x).toBe(0);
    expect(trDelta.y).toBe(2000);
  });
});
