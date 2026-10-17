import { describe, expect, it } from 'vitest';
import { vec3 } from '../sim/vec3';
import { anglesToAxis, handPose, type Axis } from './hand-pose';

const DEGREES = Math.PI / 180;
const NO_SWAY = { pitch: 0, yaw: 0, roll: 0 };

/** A direction measured along the view's axes, back in the world. */
function toWorld(view: Axis, [f, l, u]: Axis[number]): number[] {
  return [0, 1, 2].map((i) => f * view[0][i] + l * view[1][i] + u * view[2][i]);
}

describe('anglesToAxis', () => {
  it('looks down for a positive pitch', () => {
    const [forward] = anglesToAxis(10, 0, 0);
    expect(forward[0]).toBeCloseTo(Math.cos(10 * DEGREES), 12);
    expect(forward[2]).toBeCloseTo(-Math.sin(10 * DEGREES), 12);
  });

  it('turns left for a positive yaw', () => {
    const [forward] = anglesToAxis(0, 10, 0);
    expect(forward[1]).toBeCloseTo(Math.sin(10 * DEGREES), 12);
  });

  it('lowers the right side for a positive roll', () => {
    // The left side rises.
    const [, left] = anglesToAxis(0, 0, 10);
    expect(left[2]).toBeCloseTo(Math.sin(10 * DEGREES), 12);
  });

  it('writes the axis it is given, and returns it', () => {
    const kept = anglesToAxis(0, 0, 0);
    const rows = [...kept];
    expect(anglesToAxis(20, 30, 40, kept)).toBe(kept);
    expect(kept).toEqual(anglesToAxis(20, 30, 40));
    kept.forEach((row, i) => expect(row).toBe(rows[i]));
  });
});

describe('handPose', () => {
  it('is the sway alone at a level view, turning left for a positive yaw', () => {
    const pose = handPose(vec3(0, 0, 0), { pitch: 0, yaw: 10, roll: 0 }, 0, 0);
    expect(pose.axis[0][0]).toBeCloseTo(Math.cos(10 * DEGREES), 12);
    expect(pose.axis[0][1]).toBeCloseTo(Math.sin(10 * DEGREES), 12);
    expect(pose.axis[0][2]).toBeCloseTo(0, 12);
  });

  it("keeps the fov drop on the view's up whatever the sway, so the gun turns about it", () => {
    const pose = handPose(vec3(20, 45, 3), { pitch: 8, yaw: 16, roll: 8 }, -3.1, 0);
    expect(pose.origin[0]).toBeCloseTo(0, 12);
    expect(pose.origin[1]).toBeCloseTo(0, 12);
    expect(pose.origin[2]).toBeCloseTo(-3.1, 12);
  });

  it("adds the sway to the view's angles: looking down, a yaw sway turns about the world's up", () => {
    // Q3's yaw keeps the gun as far below the horizon as the view, and adds to its heading.
    const pose = handPose(vec3(60, 30, 0), { pitch: 0, yaw: 10, roll: 0 }, 0, 0);
    const forward = toWorld(anglesToAxis(60, 30, 0), pose.axis[0]);
    expect(forward[2]).toBeCloseTo(-Math.sin(60 * DEGREES), 12);
    expect(Math.atan2(forward[1], forward[0]) / DEGREES).toBeCloseTo(40, 10);
  });

  it("lowers the hand for a landing along the world's up, not the view's", () => {
    // Q3 adds the gun's dip to the eye's height, and the fov drop along the view's up after it.
    const view = anglesToAxis(60, 30, 0);
    const offset = toWorld(view, handPose(vec3(60, 30, 0), NO_SWAY, -3.1, -6).origin);
    const drop = toWorld(view, [0, 0, -3.1]);
    expect(offset[0] - drop[0]).toBeCloseTo(0, 12);
    expect(offset[1] - drop[1]).toBeCloseTo(0, 12);
    expect(offset[2] - drop[2]).toBeCloseTo(-6, 12);
  });

  it("is the view's own axis with no sway", () => {
    const pose = handPose(vec3(-35, 120, 4), NO_SWAY, 0, 0);
    pose.axis.forEach((row, i) =>
      row.forEach((value, j) => expect(value).toBeCloseTo(i === j ? 1 : 0, 12))
    );
  });
});
