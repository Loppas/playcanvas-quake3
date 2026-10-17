import { describe, expect, it } from 'vitest';

import { MAX_PITCH_CHANGE, applyLookDelta, clientLook, mouseLook, wrapDegrees } from './look';
import { PITCH_LIMIT_DEGREES } from '../sim/constants';

const SENSITIVITY = 0.15;
const level = { yaw: 0, pitch: 0 };

describe('wrapDegrees', () => {
  it('leaves angles already in range untouched', () => {
    expect(wrapDegrees(0)).toBe(0);
    expect(wrapDegrees(359.9)).toBeCloseTo(359.9);
  });

  it('wraps past a full turn in both directions', () => {
    expect(wrapDegrees(360)).toBe(0);
    expect(wrapDegrees(370)).toBeCloseTo(10);
    expect(wrapDegrees(-10)).toBeCloseTo(350);
  });

  it('wraps angles many turns out of range', () => {
    expect(wrapDegrees(45 + 360 * 7)).toBeCloseTo(45);
    expect(wrapDegrees(45 - 360 * 7)).toBeCloseTo(45);
  });
});

describe('applyLookDelta', () => {
  it('does not move on a zero delta', () => {
    expect(applyLookDelta({ yaw: 30, pitch: -10 }, 0, 0, SENSITIVITY)).toEqual({
      yaw: 30,
      pitch: -10
    });
  });

  it('does not mutate the angles it is given', () => {
    const angles = { yaw: 30, pitch: -10 };
    applyLookDelta(angles, 100, 100, SENSITIVITY);
    expect(angles).toEqual({ yaw: 30, pitch: -10 });
  });

  it('scales rotation by sensitivity', () => {
    expect(applyLookDelta(level, -100, 0, 0.15).yaw).toBeCloseTo(15);
    expect(applyLookDelta(level, -100, 0, 0.3).yaw).toBeCloseTo(30);
  });

  it('inverts both axes so +dx looks right and +dy looks down', () => {
    expect(applyLookDelta(level, 100, 0, SENSITIVITY).yaw).toBeCloseTo(345);
    expect(applyLookDelta(level, 0, 100, SENSITIVITY).pitch).toBeCloseTo(-15);
  });

  it('wraps yaw rather than letting it accumulate', () => {
    const spun = applyLookDelta({ yaw: 350, pitch: 0 }, -100, 0, SENSITIVITY);
    expect(spun.yaw).toBeCloseTo(5);
  });

  it('clamps pitch at the limit instead of flipping over the top', () => {
    // 10000 px of upward movement is far past vertical at this sensitivity.
    expect(applyLookDelta(level, 0, -10000, SENSITIVITY).pitch).toBe(PITCH_LIMIT_DEGREES);
    expect(applyLookDelta(level, 0, 10000, SENSITIVITY).pitch).toBe(-PITCH_LIMIT_DEGREES);
  });

  it('keeps clamped pitch stable under further movement in the same direction', () => {
    let angles = applyLookDelta(level, 0, -10000, SENSITIVITY);
    angles = applyLookDelta(angles, 0, -10000, SENSITIVITY);
    expect(angles.pitch).toBe(PITCH_LIMIT_DEGREES);
  });

  it('releases from the clamp as soon as movement reverses', () => {
    const pinned = applyLookDelta(level, 0, -10000, SENSITIVITY);
    const released = applyLookDelta(pinned, 0, 100, SENSITIVITY);
    expect(released.pitch).toBeCloseTo(PITCH_LIMIT_DEGREES - 15);
  });

  it('stops short of vertical, so the view basis never degenerates', () => {
    expect(PITCH_LIMIT_DEGREES).toBeLessThan(90);
  });

  it('honours a caller-supplied pitch limit', () => {
    expect(applyLookDelta(level, 0, -10000, SENSITIVITY, 45).pitch).toBe(45);
  });

  it('yaws without touching pitch, and pitches without touching yaw', () => {
    expect(applyLookDelta({ yaw: 90, pitch: 20 }, 100, 0, SENSITIVITY).pitch).toBe(20);
    expect(applyLookDelta({ yaw: 90, pitch: 20 }, 0, 100, SENSITIVITY).yaw).toBe(90);
  });
});

describe('mouseLook', () => {
  /** Q3's own defaults (`cl_main.c:3592, 3622–3623`). */
  const Q3 = { sensitivity: 5, mYaw: 0.022, mPitch: 0.022 };

  it('turns sensitivity × m_yaw degrees a count side to side, and × m_pitch up and down, as CL_MouseMove does', () => {
    expect(mouseLook(level, 100, 0, Q3).yaw).toBeCloseTo(360 - 11);
    expect(mouseLook(level, 0, -100, Q3).pitch).toBeCloseTo(11);
    expect(mouseLook(level, 0, 100, { ...Q3, mPitch: 0.044 }).pitch).toBeCloseTo(-22);
  });

  it('inverts the mouse with a negative m_pitch', () => {
    expect(mouseLook(level, 0, 100, { ...Q3, mPitch: -0.022 }).pitch).toBeCloseTo(11);
  });

  it("turns 0.1496° a count at the port's default sensitivity of 6.8", () => {
    const turned = 360 - mouseLook(level, 1000, 0, { ...Q3, sensitivity: 6.8 }).yaw;
    expect(turned).toBeCloseTo(149.6, 6);
  });

  it('clamps pitch at the limit', () => {
    expect(mouseLook(level, 0, -100000, Q3).pitch).toBe(PITCH_LIMIT_DEGREES);
  });

  it('writes the turn into the angles it is given, which may be those it turns', () => {
    const look = { yaw: 10, pitch: 5 };
    const turned = mouseLook(look, 100, -100, Q3);
    expect(mouseLook(look, 100, -100, Q3, PITCH_LIMIT_DEGREES, look)).toBe(look);
    expect(look).toEqual(turned);
  });
});

describe('clientLook', () => {
  /** Q3's own defaults (`cl_main.c:3592, 3622–3623`). */
  const Q3 = { sensitivity: 5, mYaw: 0.022, mPitch: 0.022 };

  it('turns as mouseLook does within the limit', () => {
    for (const [dx, dy] of [[100, 0], [0, -100], [-37, 250]]) {
      expect(clientLook(level, dx, dy, Q3)).toEqual(mouseLook(level, dx, dy, Q3));
    }
  });

  it('puts no bound on the pitch, as Q3 puts none on cl.viewangles', () => {
    // The server holds the view within the limit by moving `delta_angles`; a spawn leaves these
    // wherever the player was holding them.
    let angles = { yaw: 0, pitch: -80 };
    angles = clientLook(angles, 0, 200, Q3);
    expect(angles.pitch).toBeCloseTo(-102);
    angles = clientLook(angles, 0, 200, Q3);
    expect(angles.pitch).toBeCloseTo(-124);
  });

  it('moves the pitch at most 90° in one frame, either way, as CL_CreateCmd does', () => {
    expect(clientLook(level, 0, 100000, Q3).pitch).toBe(-MAX_PITCH_CHANGE);
    expect(clientLook(level, 0, -100000, Q3).pitch).toBe(MAX_PITCH_CHANGE);
    expect(clientLook({ yaw: 0, pitch: -150 }, 0, -100000, Q3).pitch).toBe(-60);
    // The yaw has no such cap.
    expect(clientLook(level, 100000, 0, Q3).yaw).toBeCloseTo(wrapDegrees(-11000));
  });
});
