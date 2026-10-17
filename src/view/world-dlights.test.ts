import { describe, expect, it } from 'vitest';

import { projectLight, projectedLight } from './dynamic-lights';
import { ClipCache, dlightSpeedsLine, keptTriangles } from './world-dlights';

/** A light of radius 100 at the frame's origin. */
const atOrigin = () =>
  projectLight(
    { origin: { x: 0, y: 0, z: 0 }, radius: 100, color: [1, 1, 1], additive: false },
    0,
    0,
    0,
    projectedLight()
  );

describe('keptTriangles', () => {
  // Five points: under the light, then past its left, right, top and bottom edges.
  const positions = Float32Array.from([0, 0, 0, 60, 0, 0, -60, 0, 0, 0, 60, 0, 70, 1, 0]);

  it('keeps each triangle whose vertexes do not all lie past one edge, in order', () => {
    const indexes = Uint32Array.from([1, 4, 1, 0, 1, 4, 1, 2, 3]);
    const out = new Uint32Array(16).fill(99);
    const cache = new ClipCache(5);
    const written = keptTriangles(atOrigin(), positions, 3, 0, indexes, 0, 9, out, 2, cache);
    // The first lies wholly past the left edge; the last spans the image.
    expect(written).toBe(6);
    expect(Array.from(out.subarray(0, 10))).toEqual([99, 99, 0, 1, 4, 1, 2, 3, 99, 99]);
  });

  it('reads the vertexes at their stride, from where a batch starts', () => {
    // Each vertex's x, y and z after a word of something else.
    const strided = new Float32Array(5 * 4);
    for (let v = 0; v < 5; v++) strided.set(positions.subarray(v * 3, v * 3 + 3), v * 4 + 1);
    const indexes = Uint32Array.from([7, 7, 7, 1, 4, 1]);
    const out = new Uint32Array(3);
    const cache = new ClipCache(5);
    expect(keptTriangles(atOrigin(), strided, 4, 1, indexes, 3, 3, out, 0, cache)).toBe(0);
    // The same vertexes for a light further left: no longer all past one edge.
    const left = projectLight(
      { origin: { x: 60, y: 0, z: 0 }, radius: 100, color: [1, 1, 1], additive: false },
      60,
      0,
      0,
      projectedLight()
    );
    expect(keptTriangles(left, strided, 4, 1, indexes, 3, 3, out, 0, cache)).toBe(3);
  });
});

describe('dlightSpeedsLine', () => {
  it("prints r_speeds 4's line as Q3 does, and nothing where no vertex was projected", () => {
    expect(dlightSpeedsLine({ surfaces: 12, culled: 3, vertexes: 840, triangles: 96 })).toBe(
      'dlight srf:12  culled:3  verts:840  tris:96\n'
    );
    expect(dlightSpeedsLine({ surfaces: 2, culled: 1, vertexes: 0, triangles: 0 })).toBe('');
  });
});
