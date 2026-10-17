import { describe, expect, it } from 'vitest';

import { DEFAULT_VIEWHEIGHT } from '../sim/constants';
import { vectorToAngles } from '../sim/pmove-math';
import { vec3, type Vec3 } from '../sim/vec3';
import { createCameraFeel, firstPersonView } from './camera-feel';
import {
  DAMAGE_DEFLECT_TIME,
  DAMAGE_RETURN_TIME,
  DAMAGE_TIME,
  createDamageFeedback,
  damageBlob,
  damageFeedback,
  damageKick
} from './damage-feedback';

/** A hurt's direction of travel as the bytes `P_DamageFeedback` sends (`g_active.c:64–66`). */
function bytes(travel: Vec3): { yaw: number; pitch: number } {
  const angles = vectorToAngles(travel);
  const byte = (degrees: number) => Math.trunc((degrees / 360) * 256) & 255;
  return { yaw: byte(angles.y), pitch: byte(angles.x) };
}

/** Feedback from a hurt travelling along `travel`, looking along +x, landing at 1000 ms. */
function hurtFrom(travel: Vec3, damage: number, health: number) {
  const feedback = createDamageFeedback();
  const { yaw, pitch } = bytes(travel);
  damageFeedback(feedback, yaw, pitch, damage, health, vec3(), 1000);
  return feedback;
}

describe('damageFeedback', () => {
  it('kicks a fall back by 5 at full health, and marks the centre', () => {
    const feedback = createDamageFeedback();
    damageFeedback(feedback, 255, 255, 10, 115, vec3(), 1000);
    // 10 × 40/115 is 3.5, held up to 5.
    expect(feedback).toEqual({ time: 1000, x: 0, y: 0, value: 5, pitch: -5, roll: 0 });
  });

  it('kicks by the damage itself at 40 health or less, held to 10', () => {
    const kick = (damage: number, health: number) => {
      const feedback = createDamageFeedback();
      damageFeedback(feedback, 255, 255, damage, health, vec3(), 0);
      return feedback.value;
    };
    expect(kick(8, 30)).toBe(8);
    expect(kick(40, 30)).toBe(10);
    // 30 × 40/80.
    expect(kick(12, 80)).toBe(6);
  });

  it('tips the view back from a hurt ahead', () => {
    const feedback = hurtFrom(vec3(-1, 0, 0), 20, 30);
    expect(feedback.pitch).toBeCloseTo(-10, 2);
    expect(Math.abs(feedback.roll)).toBeLessThan(0.2);
    expect(Math.abs(feedback.x)).toBeLessThan(0.02);
    expect(feedback.y).toBe(0);
  });

  it('rolls the view from a hurt on the left, and marks the left edge', () => {
    const feedback = hurtFrom(vec3(0, -1, 0), 20, 30);
    expect(feedback.roll).toBeCloseTo(10, 1);
    expect(feedback.x).toBe(-1);
    expect(feedback.y).toBe(0);
  });

  it('marks the top for a hurt from above', () => {
    const feedback = hurtFrom(vec3(0, 0, -1), 20, 30);
    expect(feedback.y).toBe(1);
    expect(feedback.x).toBeCloseTo(0, 6);
  });
});

describe('damageKick', () => {
  it('is nothing before any hurt', () => {
    expect(damageKick(createDamageFeedback(), 0)).toEqual({ pitch: 0, roll: 0 });
  });

  it('goes in over 100 ms and comes back over 400', () => {
    const feedback = createDamageFeedback();
    damageFeedback(feedback, 255, 255, 10, 115, vec3(), 1000);
    expect(damageKick(feedback, 1000).pitch).toBeCloseTo(0, 6);
    expect(damageKick(feedback, 1000 + DAMAGE_DEFLECT_TIME / 2).pitch).toBeCloseTo(-2.5, 6);
    expect(damageKick(feedback, 1000 + DAMAGE_DEFLECT_TIME).pitch).toBeCloseTo(-5, 6);
    expect(damageKick(feedback, 1000 + DAMAGE_DEFLECT_TIME + DAMAGE_RETURN_TIME / 2).pitch).toBeCloseTo(-2.5, 6);
    expect(damageKick(feedback, 1000 + DAMAGE_DEFLECT_TIME + DAMAGE_RETURN_TIME)).toEqual({ pitch: 0, roll: 0 });
  });

  it('tips the first-person view', () => {
    const feedback = createDamageFeedback();
    damageFeedback(feedback, 255, 255, 10, 115, vec3(), 1000);
    const sample = {
      origin: vec3(),
      velocity: vec3(),
      viewangles: vec3(),
      viewheight: DEFAULT_VIEWHEIGHT,
      bobCycle: 0,
      ducked: false
    };
    const feel = createCameraFeel(DEFAULT_VIEWHEIGHT);
    const time = 1000 + DAMAGE_DEFLECT_TIME;
    const still = firstPersonView(feel, sample, time).angles.x;
    expect(firstPersonView(feel, sample, time, feedback).angles.x).toBeCloseTo(still - 5, 6);
  });
});

describe('damageBlob', () => {
  it('is nothing before any hurt', () => {
    expect(damageBlob(createDamageFeedback(), 0)).toBeNull();
  });

  it('sits 8 ahead toward the hurt, three units across per degree, and fades over 500 ms', () => {
    const feedback = hurtFrom(vec3(0, -1, 0), 20, 30);
    expect(damageBlob(feedback, 1000)).toBeNull();
    expect(damageBlob(feedback, 1000 + DAMAGE_TIME / 2)).toEqual({
      forward: 8,
      left: 8,
      up: 0,
      radius: 30,
      alpha: 100 / 255
    });
    expect(damageBlob(feedback, 1000 + DAMAGE_TIME)).toBeNull();
  });
});
