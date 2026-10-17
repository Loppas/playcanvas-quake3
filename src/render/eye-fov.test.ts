// @vitest-environment jsdom
import { ASPECT_AUTO, ASPECT_MANUAL } from 'playcanvas';
import { afterEach, describe, expect, it } from 'vitest';

import { CONTENTS } from '../sim/constants';
import { horizontalFov, verticalFov } from '../view/fov';
import { createTestApp } from './engine-test-fixtures';
import { setEyeFov } from './eye-fov';

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

describe("the eye's angles", () => {
  const { camera } = createTestApp();
  const lens = camera.camera!;

  afterEach(() => {
    lens.aspectRatioMode = ASPECT_AUTO;
  });

  it("are cg_fov's out of a liquid, the aspect the screen's", () => {
    lens.aspectRatioMode = ASPECT_MANUAL;
    lens.aspectRatio = 3;
    setEyeFov(lens, 89.2, 16 / 9, 0, 625);
    expect(lens.fov).toBe(verticalFov(89.2));
    expect(lens.aspectRatioMode).toBe(ASPECT_AUTO);
    setEyeFov(lens, 110, 16 / 9, CONTENTS.SOLID | CONTENTS.FOG, 625);
    expect(lens.fov).toBe(verticalFov(110));
    expect(lens.aspectRatioMode).toBe(ASPECT_AUTO);
  });

  it('are warped in water, wider across and narrower up and down', () => {
    // A quarter of the way round the 2.5 s cycle: a whole degree.
    setEyeFov(lens, 89.2, 16 / 9, CONTENTS.WATER, 625);
    expect(lens.fov).toBeCloseTo(verticalFov(89.2) - 1, 10);
    expect(lens.aspectRatioMode).toBe(ASPECT_MANUAL);
    // The projection's two half-angles: `1 / tan` on its diagonal.
    const projection = lens.projectionMatrix.data;
    const across = horizontalFov(89.2, 16 / 9) + 1;
    expect(1 / projection[0]).toBeCloseTo(Math.tan(toRadians(across) / 2), 6);
    expect(1 / projection[5]).toBeCloseTo(Math.tan(toRadians(verticalFov(89.2) - 1) / 2), 6);
  });

  it('are warped the other way half a cycle on, and in slime and lava too', () => {
    setEyeFov(lens, 89.2, 4 / 3, CONTENTS.SLIME, 1875);
    expect(lens.fov).toBeCloseTo(verticalFov(89.2) + 1, 10);
    const projection = lens.projectionMatrix.data;
    expect(1 / projection[0]).toBeCloseTo(Math.tan(toRadians(89.2 - 1) / 2), 6);
    setEyeFov(lens, 89.2, 4 / 3, CONTENTS.LAVA, 625);
    expect(lens.fov).toBeCloseTo(verticalFov(89.2) - 1, 10);
  });
});
