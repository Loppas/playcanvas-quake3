import { describe, expect, it } from 'vitest';

import { MST_TRIANGLE_SOUP, type Bsp, type BspSurface } from '../formats/bsp';
import { WorldMarks } from './world-marks';
import { surface, testBsp, testSources } from './world-test-fixtures';
import { loadWorldShaders } from './world-shaders';

type Vec3 = [number, number, number];

const SCRIPTS = `
  textures/t/wall { { map t.tga } }
  textures/t/noimpact { surfaceparm noimpact { map t.tga } }
  textures/t/nomarks { surfaceparm nomarks { map t.tga } }
  textures/t/fog {
    surfaceparm fog
    fogparms ( 1 0 0 ) 128
  }
`;

/** A floor 128 square from the origin, its two triangles split along its diagonal. */
const FLOOR_XYZ = [0, 0, 0, 128, 0, 0, 128, 128, 0, 0, 128, 0];
const FLOOR_INDEXES = [0, 1, 2, 0, 2, 3];

/** A floor in the shader `shaderNum`, facing along `normal`, its points from `firstVert`. */
const floor = (shaderNum = 0, normal: Vec3 = [0, 0, 1], fields: Partial<BspSurface> = {}) =>
  surface({
    shaderNum,
    numVerts: 4,
    numIndexes: 6,
    lightmapVecs: [[0, 0, 0], [0, 0, 0], normal],
    ...fields
  });

/** Every surface in the leaf in front of a node at x −5,000, and none in the one behind it. */
function map(surfaces: BspSurface[], xyz: number[] = FLOOR_XYZ, drawIndexes = FLOOR_INDEXES): Bsp {
  return testBsp({
    shaders: ['textures/t/wall', 'textures/t/noimpact', 'textures/t/nomarks', 'textures/t/fog'],
    surfaces,
    xyz,
    drawIndexes,
    planes: [{ normal: [1, 0, 0], dist: -5000 }]
  });
}

function marksOf(bsp: Bsp): WorldMarks {
  return new WorldMarks(bsp, loadWorldShaders(bsp, testSources(SCRIPTS, ['t.tga'])), []);
}

/**
 * A square 32 across about (64, 64), wound as `CG_ImpactMark` winds one seen from above, thrown 20
 * units down.
 */
const SQUARE = [48, 48, 0, 48, 80, 0, 80, 80, 0, 80, 48, 0];
const DOWN = [0, 0, -20];

/** The fragments a call cuts: each a list of its points. */
function cut(world: WorldMarks, maxPoints = 384, maxFragments = 128): Vec3[][] {
  const points = new Float32Array(maxPoints * 3);
  const fragments = new Int32Array(maxFragments * 2);
  const n = world.markFragments(4, SQUARE, DOWN, maxPoints, points, maxFragments, fragments);
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: fragments[i * 2 + 1] }, (__, j): Vec3 => {
      const at = (fragments[i * 2] + j) * 3;
      return [points[at], points[at + 1], points[at + 2]];
    })
  );
}

/** A polygon's area seen from above. */
function area(points: Vec3[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    twice += x0 * y1 - x1 * y0;
  }
  return Math.abs(twice) / 2;
}

describe('WorldMarks, R_MarkFragments', () => {
  it("cuts a square on a floor into its part of each of the floor's triangles", () => {
    const world = marksOf(map([floor()]));
    const fragments = cut(world);
    expect(world.listed).toBe(1);
    expect(fragments).toHaveLength(2);
    // To the floats the cuts' split points are worked in.
    expect(fragments.reduce((sum, points) => sum + area(points), 0)).toBeCloseTo(32 * 32, 2);
    for (const [x, y, z] of fragments.flat()) {
      expect(x).toBeGreaterThanOrEqual(48);
      expect(x).toBeLessThanOrEqual(80);
      expect(y).toBeGreaterThanOrEqual(48);
      expect(y).toBeLessThanOrEqual(80);
      expect(z).toBe(0);
    }
  });

  it('cuts a face turned against the throw by half or more, and passes one turned less', () => {
    // Its plane through the square's middle: 0.5 against the throw is enough, 0.49 is not.
    const at = [64, 64, 0, 128, 0, 0, 128, 128, 0, 0, 128, 0];
    expect(cut(marksOf(map([floor(0, [0, 0.866, 0.5])], at))).length).toBeGreaterThan(0);
    const turned = marksOf(map([floor(0, [0, 0.872, 0.49])], at));
    expect(cut(turned)).toEqual([]);
    expect(turned.listed).toBe(0);
    // Turned away from it altogether.
    expect(cut(marksOf(map([floor(0, [0, 0, -1])], at)))).toEqual([]);
  });

  it('passes over a face whose plane misses the box the throw sweeps', () => {
    // 20 units over and under the square, and the 20 of the throw: the box reaches z −20.
    const low = [0, 0, -21, 128, 0, -21, 128, 128, -21, 0, 128, -21];
    const world = marksOf(map([floor()], low));
    expect(cut(world)).toEqual([]);
    expect(world.listed).toBe(0);
  });

  it("never lists a surface its script gives noimpact, nomarks or fog", () => {
    for (const shaderNum of [1, 2, 3]) {
      const world = marksOf(map([floor(shaderNum)]));
      expect(cut(world), `shader ${shaderNum}`).toEqual([]);
      expect(world.listed).toBe(0);
    }
  });

  it('lists a soup, and cuts it only under r_marksOnTriangleMeshes', () => {
    const soup = floor(0, [0, 0, 1], { surfaceType: MST_TRIANGLE_SOUP });
    const world = marksOf(map([soup]));
    expect(cut(world)).toEqual([]);
    expect(world.listed).toBe(1);
    world.onTriangleMeshes = true;
    expect(cut(world)).toHaveLength(2);
  });

  it('drops a fragment past the points it may return, and stops at the fragments it may', () => {
    const world = marksOf(map([floor()]));
    // The first triangle's part, three points; the second's would pass four.
    expect(cut(world, 4).map((points) => points.length)).toEqual([3]);
    expect(cut(world, 384, 1)).toHaveLength(1);
  });

  it('lists the first 64 surfaces the walk reaches', () => {
    const world = marksOf(map(Array.from({ length: 70 }, () => floor())));
    expect(cut(world, 384, 128)).toHaveLength(128);
    expect(world.listed).toBe(64);
  });

  it('drops a fragment whose cut reaches 62 points, as the chop might overflow', () => {
    // One triangle under a polygon of `n` sides 300 across, wound as cgame winds one.
    const world = marksOf(map([floor(0, [0, 0, 1], { numIndexes: 3 })], [
      -5000, -5000, 0, 5000, -5000, 0, 0, 5000, 0, 0, 0, 0
    ], [0, 1, 2]));
    const polygon = (n: number) =>
      Array.from({ length: n }, (_, i) => {
        const angle = (-2 * Math.PI * i) / n;
        return [Math.fround(300 * Math.cos(angle)), Math.fround(300 * Math.sin(angle)), 0];
      }).flat();
    const cutOf = (n: number) => {
      const points = new Float32Array(384 * 3);
      const fragments = new Int32Array(128 * 2);
      const count = world.markFragments(n, polygon(n), DOWN, 384, points, 128, fragments);
      return Array.from({ length: count }, (_, i) => fragments[i * 2 + 1]);
    };
    // Its sides cut the triangle down to the polygon. Before the last side, the cut holds a point
    // more than the sides so far, so a 62-gon's reaches 62 there.
    expect(cutOf(56)).toEqual([56]);
    expect(cutOf(62)).toEqual([]);
  });

  it('cuts nothing of a polygon of no points', () => {
    const world = marksOf(map([floor()]));
    const out = new Float32Array(3);
    expect(world.markFragments(0, [], DOWN, 1, out, 1, new Int32Array(2))).toBe(0);
    expect(world.listed).toBe(0);
  });
});
