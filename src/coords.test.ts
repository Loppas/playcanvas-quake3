import { describe, expect, it } from 'vitest';
import { simToOctree, simToWorld, worldToSim, UNITS_PER_METRE } from './coords';
import { vec3 } from './sim/vec3';

/** Normalise signed zero so `-0` compares equal to `0`. */
function norm(t: [number, number, number]): [number, number, number] {
  return [t[0] + 0, t[1] + 0, t[2] + 0];
}

describe('simToWorld', () => {
  it('scales by 32 units per metre', () => {
    expect(UNITS_PER_METRE).toBe(32);
    expect(norm(simToWorld(vec3(32, 0, 0)))).toEqual([1, 0, 0]);
  });

  it('maps Quake up (Z) to world up (Y)', () => {
    expect(norm(simToWorld(vec3(0, 0, 64)))).toEqual([0, 2, 0]);
  });

  it('maps Quake left (Y) to world -Z, keeping the frame right-handed', () => {
    expect(norm(simToWorld(vec3(0, 32, 0)))).toEqual([0, 0, -1]);
  });

  it('writes into the triple it is given', () => {
    const into: [number, number, number] = [9, 9, 9];
    expect(simToWorld(vec3(32, 64, 96), into)).toBe(into);
    expect(into).toEqual([1, 3, -2]);
  });

  it('is right-handed: forward x left = up (world)', () => {
    // Quake forward (+X) -> world +X; Quake left (+Y) -> world -Z; their cross must be world up.
    const fwd = simToWorld(vec3(1, 0, 0)); // [1,0,0]
    const left = simToWorld(vec3(0, 1, 0)); // [0,0,-1/32]
    // cross(fwd, left) = (0*(-1/32)-0*0, 0*0-1*(-1/32), 1*0-0*0) = (0, 1/32, 0) -> +Y (up).
    const cross = [
      fwd[1] * left[2] - fwd[2] * left[1],
      fwd[2] * left[0] - fwd[0] * left[2],
      fwd[0] * left[1] - fwd[1] * left[0]
    ];
    expect(cross[1]).toBeGreaterThan(0);
    expect(cross[0]).toBeCloseTo(0);
    expect(cross[2]).toBeCloseTo(0);
  });
});

describe('simToOctree', () => {
  it('is simToWorld under the ST_FRAME flip (negate world X and Y)', () => {
    const v = vec3(64, -96, 128);
    const [wx, wy, wz] = simToWorld(v);
    expect(simToOctree(v)).toEqual([-wx, -wy, wz]);
  });

  it('keeps the floor below the player: Quake up maps to smaller octree Y', () => {
    // Two sim points, one higher than the other in Q3 (bigger z). Under ST_FRAME the vertical
    // axis inverts, so the higher point must have the smaller octree Y (matches the bake, where
    // the carved void sits at lower Y than the floor).
    const low = simToOctree(vec3(0, 0, 0));
    const high = simToOctree(vec3(0, 0, 64));
    expect(high[1]).toBeLessThan(low[1]);
  });
});

describe('worldToSim', () => {
  it('undoes simToWorld exactly', () => {
    for (const point of [vec3(0, 0, 0), vec3(100, -250, 64), vec3(-3.5, 0.25, -1024)]) {
      const [x, y, z] = simToWorld(point);
      const back = worldToSim(x, y, z);
      expect(back.x).toBeCloseTo(point.x, 10);
      expect(back.y).toBeCloseTo(point.y, 10);
      expect(back.z).toBeCloseTo(point.z, 10);
    }
  });

  it('maps world up onto Quake up, in units', () => {
    const up = worldToSim(0, 1, 0);
    // Component-wise: negating a zero gives `-0`, which `toEqual` treats as a difference.
    expect([up.x + 0, up.y + 0, up.z]).toEqual([0, 0, UNITS_PER_METRE]);
  });
});
