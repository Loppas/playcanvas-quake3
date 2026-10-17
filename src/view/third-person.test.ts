import { describe, expect, it } from 'vitest';

import { box, createFlatWorldTrace } from '../sim/box-world';
import { DEFAULT_VIEWHEIGHT, MASK } from '../sim/constants';
import { distinctAsks, recordingTrace } from '../sim/trace-test-fixtures';
import { vec3, type Vec3 } from '../sim/vec3';
import {
  BLOCKED_CLIMB,
  CAMERA_RISE,
  FOCUS_DISTANCE,
  THIRD_PERSON_RANGE,
  thirdPersonView,
  type ThirdPersonInput
} from './third-person';

/**
 * `CG_OffsetThirdPersonView` against Q3's numbers: the camera 40 back and 8 up, aimed at a point
 * 512 ahead, its box stopping at a wall and ducking under a ceiling.
 */

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = 24;
const EYE_Z = GROUND_Z + DEFAULT_VIEWHEIGHT;

const open = createFlatWorldTrace();

/** A wall whose face is 20 units behind a player at the origin facing +x. */
const WALL_BEHIND = box(-64, -256, 0, -20, 256, 512);

/** @param overrides - Fields to change on a living player at the origin, looking along +x. */
function input(overrides: Partial<ThirdPersonInput> = {}): ThirdPersonInput {
  return {
    origin: vec3(0, 0, GROUND_Z),
    viewangles: vec3(),
    viewheight: DEFAULT_VIEWHEIGHT,
    deadYaw: null,
    clientNum: 0,
    ...overrides
  };
}

/** The pitch that aims from `from` at `to`, as `cg_view.c:288–293` works it out. */
function aimPitch(from: Vec3, to: Vec3): number {
  const flat = Math.max(Math.hypot(to.x - from.x, to.y - from.y), 1);
  return (-180 / Math.PI) * Math.atan2(to.z - from.z, flat);
}

describe('thirdPersonView', () => {
  it('sits 40 back and 8 above the eye, aimed at a point 512 ahead', () => {
    const view = thirdPersonView(input(), open);
    expect(view.origin.x).toBeCloseTo(-THIRD_PERSON_RANGE, 6);
    expect(view.origin.y).toBeCloseTo(0, 6);
    expect(view.origin.z).toBeCloseTo(EYE_Z + CAMERA_RISE, 6);
    // 8 units of drop over 552: just under a degree down.
    expect(view.angles.x).toBeCloseTo(aimPitch(view.origin, vec3(FOCUS_DISTANCE, 0, EYE_Z)), 6);
    expect(view.angles.x).toBeCloseTo(0.83, 2);
    expect(view.angles.y).toBe(0);
  });

  it('backs off along half the pitch, and keeps its aim no more than 45° below level', () => {
    const view = thirdPersonView(input({ viewangles: vec3(60, 0, 0) }), open);
    // Backed off along a forward pitched 30° down, so it rises behind the player.
    const half = (30 * Math.PI) / 180;
    expect(view.origin.x).toBeCloseTo(-THIRD_PERSON_RANGE * Math.cos(half), 6);
    expect(view.origin.z).toBeCloseTo(EYE_Z + CAMERA_RISE + THIRD_PERSON_RANGE * Math.sin(half), 6);
    const limit = (45 * Math.PI) / 180;
    const focus = vec3(
      FOCUS_DISTANCE * Math.cos(limit),
      0,
      EYE_Z - FOCUS_DISTANCE * Math.sin(limit)
    );
    expect(view.angles.x).toBeCloseTo(aimPitch(view.origin, focus), 6);
  });

  it('stops its box at a wall behind, then climbs by the share of the way the wall cost it', () => {
    const wall = createFlatWorldTrace([WALL_BEHIND]);
    const eye = vec3(0, 0, EYE_Z);
    const planned = vec3(-THIRD_PERSON_RANGE, 0, EYE_Z + CAMERA_RISE);
    const hit = wall(eye, vec3(-4, -4, -4), vec3(4, 4, 4), planned, 0, MASK.SOLID);
    // The box's back meets the wall 16 units out, two fifths of the way.
    expect(hit.fraction).toBeCloseTo(16 / THIRD_PERSON_RANGE, 2);

    const view = thirdPersonView(input(), wall);
    expect(view.origin.x).toBeCloseTo(hit.endpos.x, 6);
    expect(view.origin.z).toBeCloseTo(hit.endpos.z + (1 - hit.fraction) * BLOCKED_CLIMB, 6);
    expect(view.origin.x - 4).toBeGreaterThanOrEqual(-20);
  });

  it('keeps under a low ceiling that the climb would push it through', () => {
    const ceiling = 72;
    const tunnel = createFlatWorldTrace([WALL_BEHIND, box(-256, -256, ceiling, 256, 256, 512)]);
    const view = thirdPersonView(input(), tunnel);
    // The climb alone would have taken it to 72.4; the second trace stops its box at the ceiling.
    expect(view.origin.z + 4).toBeLessThanOrEqual(ceiling);
    expect(view.origin.z).toBeGreaterThan(EYE_Z + CAMERA_RISE);
    expect(view.origin.x - 4).toBeGreaterThanOrEqual(-20);
  });

  it('looks along the dead yaw while the player is dead, whatever they looked at', () => {
    const view = thirdPersonView(input({ viewangles: vec3(0, 30, 0), deadYaw: 90 }), open);
    expect(view.angles.y).toBe(90);
    // Behind, along yaw 90: toward −y.
    expect(view.origin.x).toBeCloseTo(0, 6);
    expect(view.origin.y).toBeCloseTo(-THIRD_PERSON_RANGE, 6);
  });

  it('orbits round to the left by cg_thirdPersonAngle, facing back at the player', () => {
    const view = thirdPersonView(input(), open, THIRD_PERSON_RANGE, 90);
    expect(view.origin.x).toBeCloseTo(0, 6);
    expect(view.origin.y).toBeCloseTo(THIRD_PERSON_RANGE, 6);
    expect(view.angles.y).toBe(-90);
  });
});

describe("the camera's trace", () => {
  it('passes the player and stops at what is solid, as CG_OffsetThirdPersonView traces', () => {
    const { trace, asked } = recordingTrace(createFlatWorldTrace([WALL_BEHIND]));

    thirdPersonView(input({ clientNum: 2 }), trace);

    expect(distinctAsks(asked)).toEqual([{ passEntityNum: 2, contentmask: MASK.SOLID }]);
  });
});
