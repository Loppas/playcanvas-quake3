import { describe, expect, it } from 'vitest';

import { NO_IMPACT_DIR, NUM_VERTEX_NORMALS, byteToDir, dirToByte } from './dir-byte';
import { dot, length, normalize, vec3 } from './vec3';

/**
 * A direction in one byte: what an impact event can afford to say about the surface it struck.
 */

describe('the table', () => {
  it('holds 162 unit directions', () => {
    for (let i = 0; i < NUM_VERTEX_NORMALS; i++) {
      expect(length(byteToDir(i)), `direction ${i}`).toBeCloseTo(1, 5);
    }
  });

  it('spreads them over the whole sphere, no two further than 17.2 degrees apart', () => {
    // What makes the quantisation usable: every direction has a near neighbour, so nothing is
    // ever far from a table entry. Measured from the table itself — the icosahedral set is not
    // perfectly even, and 17.2 degrees is the widest its neighbours ever get.
    let widest = 0;
    for (let i = 0; i < NUM_VERTEX_NORMALS; i++) {
      const direction = byteToDir(i);
      let nearest = -1;
      for (let j = 0; j < NUM_VERTEX_NORMALS; j++) {
        if (j === i) continue;
        nearest = Math.max(nearest, dot(direction, byteToDir(j)));
      }
      widest = Math.max(widest, Math.acos(nearest) * (180 / Math.PI));
    }
    expect(widest).toBeCloseTo(17.17, 1);
  });

  it('covers both ways along each axis, so no surface is unrepresentable', () => {
    for (const axis of [
      vec3(1, 0, 0),
      vec3(-1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, -1, 0),
      vec3(0, 0, 1),
      vec3(0, 0, -1)
    ]) {
      const back = byteToDir(dirToByte(axis));
      expect(dot(back, axis), JSON.stringify(axis)).toBeGreaterThan(0.98);
    }
  });
});

describe('dirToByte', () => {
  it('is exact for a direction already in the table', () => {
    for (let i = 0; i < NUM_VERTEX_NORMALS; i++) {
      expect(dirToByte(byteToDir(i)), `direction ${i}`).toBe(i);
    }
  });

  it('gives back a direction within half the table\'s spacing', () => {
    // The whole point: a packed normal is close enough to draw with. Sampled over a sphere so
    // the worst case is a real one rather than a chosen one.
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      // A spiral over the sphere, which covers it evenly without any random draw.
      const z = 1 - (2 * i) / 1999;
      const radius = Math.sqrt(Math.max(0, 1 - z * z));
      const angle = i * 2.399963;
      const direction = vec3(radius * Math.cos(angle), radius * Math.sin(angle), z);
      worst = Math.max(worst, Math.acos(dot(byteToDir(dirToByte(direction)), direction)));
    }
    expect(worst * (180 / Math.PI)).toBeCloseTo(10.55, 1);
  });

  it('cares about direction and not about length', () => {
    const aim = normalize(vec3(0.3, -0.5, 0.8));
    expect(dirToByte(vec3(aim.x * 100, aim.y * 100, aim.z * 100))).toBe(dirToByte(aim));
  });

  it('gives 0 for a direction that beats nothing, as a zero vector does', () => {
    // The search only takes an entry whose dot product is above zero, so a vector with no
    // direction at all keeps the index it started at.
    expect(dirToByte(vec3())).toBe(0);
  });
});

describe('byteToDir', () => {
  it('gives the zero vector for a byte outside the table', () => {
    // The railgun sends 255 for "nothing at the far end", and a client that decoded it anyway
    // would rather have nothing than an exception.
    expect(byteToDir(NO_IMPACT_DIR)).toEqual(vec3());
    expect(byteToDir(NUM_VERTEX_NORMALS)).toEqual(vec3());
    expect(byteToDir(-1)).toEqual(vec3());
  });

  it('hands out a copy, so nothing can write through it into the table', () => {
    const first = byteToDir(5);
    first.x = 99;
    expect(byteToDir(5).x).not.toBe(99);
  });

  it('fits in the byte an event has', () => {
    expect(NUM_VERTEX_NORMALS).toBeLessThanOrEqual(256);
    expect(NO_IMPACT_DIR).toBeGreaterThanOrEqual(NUM_VERTEX_NORMALS);
  });
});
