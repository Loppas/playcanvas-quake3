import { describe, expect, it } from 'vitest';
import type { Animation } from '../formats/animation-config';
import { ANIM } from '../sim/animations';
import { vec3 } from '../sim/vec3';
import { anglesToAxis, type Axis } from './hand-pose';
import {
  createPlayerEntity,
  painTwitch,
  playerAngles,
  playerAnimation,
  swingAngles,
  type PlayerAnglesInput
} from './player-animation';

/** Q3 keeps a swung angle on its 65,536-step circle, so compare to a few thousandths. */
function expectAxis(actual: Axis, expected: Axis): void {
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      expect(actual[row][column], `[${row}][${column}]`).toBeCloseTo(expected[row][column], 3);
    }
  }
}

/** A player standing idle, looking straight ahead along +X, one 16 ms frame in. */
function input(overrides: Partial<PlayerAnglesInput> = {}): PlayerAnglesInput {
  return {
    angles: vec3(0, 0, 0),
    legsAnim: ANIM.LEGS_IDLE,
    torsoAnim: ANIM.TORSO_STAND,
    movementDir: 0,
    dead: false,
    velocity: vec3(),
    time: 1000,
    frametime: 16,
    ...overrides
  };
}

const FREE = { fixedLegs: false, fixedTorso: false };
const IDENTITY = anglesToAxis(0, 0, 0);

describe('swingAngles', () => {
  it('stays put while the destination is within its tolerance', () => {
    expect(swingAngles(20, 25, 90, 0.3, 16, 0, false)).toEqual({ angle: 0, swinging: false });
  });

  it('starts past its tolerance, at double speed while still that far off', () => {
    const { angle, swinging } = swingAngles(30, 25, 90, 0.3, 10, 0, false);
    expect(angle).toBeCloseTo(6, 2); // 10 ms at 0.3°/ms, doubled
    expect(swinging).toBe(true);
  });

  it('slows to normal speed inside the tolerance, and to half inside half of it', () => {
    expect(swingAngles(20, 25, 90, 0.3, 10, 0, true).angle).toBeCloseTo(3, 2);
    expect(swingAngles(10, 25, 90, 0.3, 10, 0, true).angle).toBeCloseTo(1.5, 2);
  });

  it('stops on arriving', () => {
    const { angle, swinging } = swingAngles(30, 25, 90, 0.3, 1000, 0, true);
    expect(angle).toBeCloseTo(30, 2);
    expect(swinging).toBe(false);
  });

  it('swings the short way round, into 0..360', () => {
    expect(swingAngles(-30, 25, 90, 0.3, 10, 0, false).angle).toBeCloseTo(354, 2);
  });

  it('never lags by more than the clamp: past it, a degree inside', () => {
    expect(swingAngles(120, 25, 90, 0.3, 10, 0, false).angle).toBeCloseTo(31, 2);
  });
});

describe('painTwitch', () => {
  it('rolls 20° at the hurt, fading to nothing over 200 ms, to the pain side', () => {
    expect(painTwitch(1000, 1000, 1)).toBe(20);
    expect(painTwitch(1100, 1000, 1)).toBe(10);
    expect(painTwitch(1100, 1000, 0)).toBe(-10);
    expect(painTwitch(1200, 1000, 1)).toBe(0);
  });

  it('is still for a player who has never been hurt', () => {
    const { painTime, painDirection } = createPlayerEntity(vec3());
    expect(painTwitch(0, painTime, painDirection)).toBe(0);
  });
});

describe('playerAngles', () => {
  it('turns the head alone for a look within the torso’s 25°', () => {
    const entity = createPlayerEntity(vec3());
    const axes = playerAngles(entity, FREE, input({ angles: vec3(0, 20, 0) }));
    expectAxis(axes.legs, IDENTITY);
    expectAxis(axes.torso, IDENTITY);
    expectAxis(axes.head, anglesToAxis(0, 20, 0));
    expect(entity.torso.yawing).toBe(false);
  });

  it('starts the torso after a look past 25°, and the legs only past 40°', () => {
    const entity = createPlayerEntity(vec3());
    playerAngles(entity, FREE, input({ angles: vec3(0, 30, 0) }));
    expect(entity.torso.yawAngle).toBeCloseTo(9.6, 1); // 16 ms at double speed
    expect(entity.torso.yawing).toBe(true);
    expect(entity.legs.yawAngle).toBe(0);
    expect(entity.legs.yawing).toBe(false);
  });

  it('keeps every part on the view while doing anything but standing idle', () => {
    const entity = createPlayerEntity(vec3());
    const axes = playerAngles(
      entity,
      FREE,
      input({ angles: vec3(0, 10, 0), legsAnim: ANIM.LEGS_RUN, frametime: 1000 })
    );
    expectAxis(axes.legs, anglesToAxis(0, 10, 0));
    expectAxis(axes.torso, IDENTITY);
    expectAxis(axes.head, IDENTITY);
  });

  it('turns the legs toward a strafe, and the torso a quarter of the way', () => {
    // movementDir 2 is left: the legs point 45° left of the view, the torso 11.25°.
    const entity = createPlayerEntity(vec3());
    const axes = playerAngles(
      entity,
      FREE,
      input({ legsAnim: ANIM.LEGS_RUN, movementDir: 2, frametime: 1000 })
    );
    expectAxis(axes.legs, anglesToAxis(0, 45, 0));
    expectAxis(axes.torso, anglesToAxis(0, -33.75, 0));
    expectAxis(axes.head, anglesToAxis(0, -11.25, 0));
  });

  it('gives the torso three quarters of the pitch, and the head the rest', () => {
    const down = playerAngles(
      createPlayerEntity(vec3()),
      FREE,
      input({ angles: vec3(40, 0, 0), legsAnim: ANIM.LEGS_RUN, frametime: 1000 })
    );
    expectAxis(down.torso, anglesToAxis(30, 0, 0));
    expectAxis(down.head, anglesToAxis(10, 0, 0));
    // Up, written either way round.
    for (const pitch of [-20, 340]) {
      const up = playerAngles(
        createPlayerEntity(vec3()),
        FREE,
        input({ angles: vec3(pitch, 0, 0), legsAnim: ANIM.LEGS_RUN, frametime: 1000 })
      );
      expectAxis(up.torso, anglesToAxis(-15, 0, 0));
      expectAxis(up.head, anglesToAxis(-5, 0, 0));
    }
  });

  it('leans the legs 16° into a 320 ups strafe, and 16° forward into a run', () => {
    const strafing = playerAngles(
      createPlayerEntity(vec3()),
      FREE,
      input({ legsAnim: ANIM.LEGS_RUN, velocity: vec3(0, -320, 0), frametime: 1000 })
    );
    expectAxis(strafing.legs, anglesToAxis(0, 0, 16));
    const running = playerAngles(
      createPlayerEntity(vec3()),
      FREE,
      input({ legsAnim: ANIM.LEGS_RUN, velocity: vec3(320, 0, 0), frametime: 1000 })
    );
    expectAxis(running.legs, anglesToAxis(16, 0, 0));
  });

  it('lets a dead body lie without the turn for the way it was going', () => {
    const axes = playerAngles(
      createPlayerEntity(vec3()),
      FREE,
      input({ legsAnim: ANIM.BOTH_DEAD1, torsoAnim: ANIM.BOTH_DEAD1, movementDir: 9, dead: true })
    );
    expectAxis(axes.legs, IDENTITY);
    expect(() =>
      playerAngles(createPlayerEntity(vec3()), FREE, input({ movementDir: 9 }))
    ).toThrow('Bad player movement angle');
  });

  it('holds fixedlegs to the torso’s yaw with no lean, and fixedtorso level', () => {
    const axes = playerAngles(
      createPlayerEntity(vec3()),
      { fixedLegs: true, fixedTorso: true },
      input({
        angles: vec3(40, 0, 0),
        legsAnim: ANIM.LEGS_RUN,
        movementDir: 2,
        velocity: vec3(0, -320, 0),
        frametime: 1000
      })
    );
    expectAxis(axes.legs, anglesToAxis(0, 11.25, 0));
    expectAxis(axes.torso, IDENTITY);
    expectAxis(axes.head, anglesToAxis(40, -11.25, 0));
  });

  it('twists the torso at a hurt, which the head takes back out', () => {
    const entity = createPlayerEntity(vec3());
    entity.painTime = 1000;
    entity.painDirection = 1;
    const axes = playerAngles(entity, FREE, input({ time: 1000 }));
    expectAxis(axes.torso, anglesToAxis(0, 0, 20));
    expectAxis(axes.head, anglesToAxis(0, 0, -20));
  });
});

describe('playerAnimation', () => {
  const animations: Animation[] = Array.from({ length: ANIM.MAX_TOTALANIMATIONS }, (_, i) => ({
    firstFrame: i * 10,
    numFrames: 1,
    loopFrames: 0,
    frameLerp: 50,
    initialLerp: 50,
    reversed: false,
    flipflop: false
  }));

  it('shuffles the feet with LEGS_TURN while idle legs swing after the view', () => {
    const entity = createPlayerEntity(vec3());
    playerAngles(entity, FREE, input({ angles: vec3(0, 60, 0) }));
    expect(entity.legs.yawing).toBe(true);
    const { legs, torso } = playerAnimation(
      entity,
      animations,
      ANIM.LEGS_IDLE,
      ANIM.TORSO_STAND,
      1000
    );
    expect(entity.legs.animationNumber).toBe(ANIM.LEGS_TURN);
    expect(legs.frame).toBe(ANIM.LEGS_TURN * 10);
    expect(torso.frame).toBe(ANIM.TORSO_STAND * 10);

    // Caught up, the legs go back to idling.
    playerAngles(entity, FREE, input({ angles: vec3(0, 60, 0), frametime: 1000 }));
    expect(entity.legs.yawing).toBe(false);
    playerAnimation(entity, animations, ANIM.LEGS_IDLE, ANIM.TORSO_STAND, 1100);
    expect(entity.legs.animationNumber).toBe(ANIM.LEGS_IDLE);
  });

  it('plays the legs’ own animation while they are not turning on the spot', () => {
    const entity = createPlayerEntity(vec3());
    entity.legs.yawing = true;
    playerAnimation(entity, animations, ANIM.LEGS_RUN, ANIM.TORSO_STAND, 1000);
    expect(entity.legs.animationNumber).toBe(ANIM.LEGS_RUN);
  });

  it('plays both parts half again as fast under haste', () => {
    const many: Animation[] = Array.from({ length: ANIM.MAX_TOTALANIMATIONS }, () => ({
      firstFrame: 0,
      numFrames: 40,
      loopFrames: 40,
      frameLerp: 100,
      initialLerp: 0,
      reversed: false,
      flipflop: false
    }));
    const slow = createPlayerEntity(vec3());
    const quick = createPlayerEntity(vec3());
    for (const entity of [slow, quick]) {
      playerAnimation(entity, many, ANIM.LEGS_RUN, ANIM.TORSO_STAND, 1000);
    }
    // `CG_PlayerAnimation` hands 1.5 to both `CG_RunLerpFrame` calls (`cg_players.c:1251–1270`).
    const one = playerAnimation(slow, many, ANIM.LEGS_RUN, ANIM.TORSO_STAND, 1100);
    const fast = playerAnimation(quick, many, ANIM.LEGS_RUN, ANIM.TORSO_STAND, 1100, 1.5);
    expect(one.legs.frame).toBe(11);
    expect(one.torso.frame).toBe(11);
    expect(fast.legs.frame).toBe(16);
    expect(fast.torso.frame).toBe(16);
  });
});
