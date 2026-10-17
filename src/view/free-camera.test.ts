import { describe, expect, it } from 'vitest';

import { DEFAULT_SPEED } from '../sim/constants';
import { vec3 } from '../sim/vec3';
import { FreeCamera } from './free-camera';

/** The fly camera, headless. */

const STILL = { forwardmove: 0, rightmove: 0, upmove: 0 };
const NO_MOUSE = { dx: 0, dy: 0 };
const MOUSE = { sensitivity: 6.8, mYaw: 0.022, mPitch: 0.022 };

/** A camera taken off from (100, 200, 300), facing yaw 90, which is +y. */
function takenOff(yaw = 90, pitch = 0): FreeCamera {
  const camera = new FreeCamera();
  camera.start({ origin: vec3(100, 200, 300), angles: vec3(pitch, yaw, 0) });
  return camera;
}

describe('FreeCamera', () => {
  it('takes off from the view it is given', () => {
    expect(takenOff(45, -10).view()).toEqual({ origin: vec3(100, 200, 300), angles: vec3(-10, 45, 0) });
  });

  it('flies along the view at g_speed for a full move, and stays put for none', () => {
    const camera = takenOff();
    camera.fly(STILL, NO_MOUSE, MOUSE, 1);
    expect(camera.view().origin).toEqual(vec3(100, 200, 300));
    camera.fly({ ...STILL, forwardmove: 127 }, NO_MOUSE, MOUSE, 0.5);
    const { origin } = camera.view();
    expect([origin.x, origin.y, origin.z].map((v) => Math.round(v * 1000) / 1000)).toEqual([
      100,
      200 + DEFAULT_SPEED / 2,
      300
    ]);
  });

  it('climbs straight up for the up move, and goes no faster on a diagonal', () => {
    const camera = takenOff();
    camera.fly({ forwardmove: 127, rightmove: 127, upmove: 0 }, NO_MOUSE, MOUSE, 1);
    const { origin } = camera.view();
    expect(Math.hypot(origin.x - 100, origin.y - 200)).toBeCloseTo(DEFAULT_SPEED);
    camera.fly({ ...STILL, upmove: 127 }, NO_MOUSE, MOUSE, 1);
    expect(camera.view().origin.z).toBeCloseTo(300 + DEFAULT_SPEED);
  });

  it("flies along its pitch, down where Q3's pitch is positive", () => {
    const camera = takenOff(90, 30);
    camera.fly({ ...STILL, forwardmove: 127 }, NO_MOUSE, MOUSE, 1);
    const { origin } = camera.view();
    expect(origin.z).toBeCloseTo(300 - DEFAULT_SPEED * Math.sin(Math.PI / 6));
    expect(origin.y).toBeCloseTo(200 + DEFAULT_SPEED * Math.cos(Math.PI / 6));
  });

  it('writes its view again in one object, so a frame asking makes nothing', () => {
    const camera = takenOff();
    const view = camera.view();
    camera.fly({ ...STILL, forwardmove: 127 }, { dx: 100, dy: 0 }, MOUSE, 1);
    expect(camera.view()).toBe(view);
    expect(view.angles.y).toBeCloseTo(90 - 100 * 6.8 * 0.022);
    expect(view.origin.z).toBe(300);
  });

  it('turns with the mouse as the player turns', () => {
    const camera = takenOff();
    camera.fly(STILL, { dx: 100, dy: 0 }, MOUSE, 1 / 60);
    expect(camera.view().angles.y).toBeCloseTo(90 - 100 * 6.8 * 0.022);
  });
});
