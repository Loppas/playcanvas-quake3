import { describe, expect, it } from 'vitest';
import { anglesToAxis, type Axis } from './hand-pose';
import { IDENTITY_AXIS, angleMod, angleSubtract, lerpAngle, matrixMultiply } from './q-math';

function expectAxis(actual: Axis, expected: Axis): void {
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      expect(actual[row][column], `[${row}][${column}]`).toBeCloseTo(expected[row][column], 6);
    }
  }
}

describe('angleMod', () => {
  it('wraps into 0..360', () => {
    expect(angleMod(-90)).toBe(270);
    expect(angleMod(360)).toBe(0);
    expect(angleMod(450)).toBe(90);
  });

  it("truncates to Q3's 65,536 steps, toward zero", () => {
    // 725° is 131,982.2 steps: 910 past two whole turns.
    expect(angleMod(725)).toBe((910 * 360) / 65536);
    expect(angleMod(0.005)).toBe(0);
    // −15° is −2,730.7 steps, truncated up to −2,730: a hair more than 345.
    expect(angleMod(-15)).toBe((62806 * 360) / 65536);
  });
});

describe('angleSubtract', () => {
  it('wraps the difference into −180..180, the ends included', () => {
    expect(angleSubtract(10, 350)).toBe(20);
    expect(angleSubtract(350, 10)).toBe(-20);
    expect(angleSubtract(190, 0)).toBe(-170);
    expect(angleSubtract(180, 0)).toBe(180);
    expect(angleSubtract(-180, 0)).toBe(-180);
    expect(angleSubtract(180, -180)).toBe(0);
  });
});

describe('lerpAngle', () => {
  it('goes the short way round, either way across 0', () => {
    expect(lerpAngle(350, 10, 0.5)).toBe(360);
    expect(lerpAngle(10, 350, 0.5)).toBe(0);
    expect(lerpAngle(90, 180, 0.25)).toBe(112.5);
  });

  it('wraps only the far end, so the answer can leave 0..360', () => {
    expect(lerpAngle(350, 10, 1)).toBe(370);
    expect(lerpAngle(10, 350, 1)).toBe(-10);
  });
});

describe('matrixMultiply', () => {
  it('composes turns, the identity changing nothing', () => {
    expectAxis(matrixMultiply(IDENTITY_AXIS, anglesToAxis(10, 20, 30)), anglesToAxis(10, 20, 30));
    expectAxis(matrixMultiply(anglesToAxis(0, 30, 0), anglesToAxis(0, 60, 0)), anglesToAxis(0, 90, 0));
  });

  it('takes the first axis into the second’s frame, so order matters', () => {
    const pitch = anglesToAxis(30, 0, 0);
    const yaw = anglesToAxis(0, 90, 0);
    // Pitched within a frame turned to +Y: forward is along +Y, and down.
    expect(matrixMultiply(pitch, yaw)[0][1]).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    // The other way round, the yawed forward is the pitched frame's left, which pitch leaves be.
    expect(matrixMultiply(yaw, pitch)[0]).toEqual([0, 1, 0].map((v) => expect.closeTo(v, 6)));
  });
});
