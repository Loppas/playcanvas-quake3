import { describe, expect, it } from 'vitest';

import { CONTENTS, MASK, SURF } from '../constants';
import { clipBsp } from './collision-test-fixtures';
import { BOX_MODEL_HANDLE, CAPSULE_MODEL_HANDLE, newTrace, type ClipMap } from './cm-local';
import { loadMap, tempBoxModel } from './cm-load';
import { boxTrace, transformedBoxTrace } from './cm-trace';

const f = Math.fround;

/** The test map with its one node's two sides both leaf 0, so the world is the cube's leaf. */
function cubeMap(): ClipMap {
  const node = { ...clipBsp().nodes[0], children: [-1, -1] as [number, number] };
  return loadMap(clipBsp({ nodes: [node] }), 'maps/test.bsp');
}

/** A player's box. */
const MINS = [-15, -15, -24];
const MAXS = [15, 15, 32];

/** A trace of the world, made and returned. */
function world(
  cm: ClipMap,
  start: number[],
  end: number[],
  mins: number[] | null = null,
  maxs: number[] | null = null,
  mask: number = MASK.SOLID
) {
  const trace = newTrace();
  boxTrace(cm, trace, start, end, mins, maxs, 0, mask);
  return trace;
}

describe('boxTrace through the world', () => {
  it("stops SURFACE_CLIP_EPSILON short of a brush, and takes its side's plane and flags", () => {
    const trace = world(cubeMap(), [0, 0, 100], [0, 0, 0]);
    expect(trace.fraction).toBe(f(35.875 / 100));
    expect(trace.endpos[2]).toBeCloseTo(64.125, 5);
    expect(trace.plane).toEqual({ normal: [0, 0, 1], dist: 64, type: 2, signbits: 0 });
    expect(trace.surfaceFlags).toBe(SURF.SLICK | SURF.NOIMPACT);
    expect(trace.contents).toBe(CONTENTS.SOLID);
    expect([trace.startsolid, trace.allsolid, trace.entityNum]).toEqual([false, false, 0]);
  });

  it('stops a box where its corner meets the brush, the box made even about its centre', () => {
    // The box's centre is 4 up, so the trace runs from z 204 to 4, against a top pushed to 92.
    const trace = world(cubeMap(), [0, 0, 200], [0, 0, 0], MINS, MAXS);
    expect(trace.fraction).toBe(f(111.875 / 200));
    expect(trace.endpos[2] + MINS[2]).toBeCloseTo(64.125, 5);
  });

  it('goes the whole way past a brush its mask leaves out, to the end as floats', () => {
    const trace = world(cubeMap(), [0, 0, 100], [0.1, 0, 0], null, null, MASK.WATER);
    expect(trace.fraction).toBe(1);
    expect(trace.endpos).toEqual([f(0.1), 0, 0]);
    expect(trace.plane).toEqual({ normal: [0, 0, 0], dist: 0, type: 0, signbits: 0 });
  });

  it('starts solid inside a brush, and is all solid only if it ends inside too', () => {
    const inside = world(cubeMap(), [0, 0, 0], [0, 0, 10]);
    expect([inside.startsolid, inside.allsolid, inside.fraction]).toEqual([true, true, 0]);
    expect(inside.contents).toBe(CONTENTS.SOLID);
    expect(inside.endpos).toEqual([0, 0, 0]);

    const out = world(cubeMap(), [0, 0, 0], [0, 0, 100]);
    expect([out.startsolid, out.allsolid, out.fraction]).toEqual([true, false, 1]);
    expect(out.contents).toBe(0);
  });

  it('passes a brush it glides over within SURFACE_CLIP_EPSILON, though it runs into a side', () => {
    expect(world(cubeMap(), [100, 0, 64.0625], [0, 0, 64.0625]).fraction).toBe(1);
    expect(world(cubeMap(), [100, 0, 64.125], [0, 0, 64.125]).fraction).toBe(1);
    expect(world(cubeMap(), [100, 0, 63.9375], [0, 0, 63.9375]).fraction).toBe(f(35.875 / 100));
  });

  it('stops at its start a move into a side it begins within SURFACE_CLIP_EPSILON of', () => {
    // The fraction it enters at is (0.0625 − 0.125) / 0.03125, −2, which is taken as 0.
    const trace = world(cubeMap(), [0, 0, 64.0625], [0, 0, 64.03125]);
    expect([trace.fraction, trace.startsolid]).toEqual([0, false]);
    expect(trace.plane.normal).toEqual([0, 0, 1]);
  });

  it('passes an edge it crosses exactly, entering one side as it leaves the other', () => {
    expect(world(cubeMap(), [63, 0, 65], [65, 0, 63]).fraction).toBe(1);
    expect(world(cubeMap(), [63, 0, 65], [65, 0, 62.5]).fraction).toBe(f(0.875 / 2.5));
  });

  it("takes a side the trace ends exactly on as one it does not cross", () => {
    // Taken as crossed, the side would be left before the top is entered, and nothing hit.
    const trace = world(cubeMap(), [-63.875, 0, 100], [-64, 0, 0]);
    expect(trace.fraction).toBe(f(35.875 / 100));
    expect(trace.plane.normal).toEqual([0, 0, 1]);
  });

  it("meets only the brushes of the leaves the trace passes through", () => {
    // In the test map's own tree the cube is listed only in the leaf above z 64.
    const cm = loadMap(clipBsp(), 'maps/test.bsp');
    expect(world(cm, [0, 0, 0], [0, 0, 10]).startsolid).toBe(false);
    expect(world(cm, [0, 0, 100], [0, 0, 0]).fraction).toBe(f(35.875 / 100));
  });

  it('takes a box of no width but some height as a box, which reaches the leaves it pokes into', () => {
    // Its top, at z 72, is in the cube's leaf above z 64; a point at z 40 would never be.
    const cm = loadMap(clipBsp(), 'maps/test.bsp');
    const trace = world(cm, [100, 0, 40], [0, 0, 40], [0, 0, -24], [0, 0, 32]);
    expect(trace.fraction).toBe(f(35.875 / 100));
    expect(trace.plane.normal).toEqual([1, 0, 0]);
  });

  it('tests the position when the start is the end, as floats', () => {
    const cm = cubeMap();
    const held = world(cm, [0, 0, 10], [0, 0, 10 + 1e-12], MINS, MAXS);
    expect([held.startsolid, held.allsolid, held.fraction]).toEqual([true, true, 0]);
    expect(held.contents).toBe(CONTENTS.SOLID);

    const free = world(cm, [0, 0, 100], [0, 0, 100], MINS, MAXS);
    expect([free.startsolid, free.allsolid, free.fraction]).toEqual([false, false, 1]);
    expect(free.endpos).toEqual([0, 0, 100]);
  });

  it('copies its result out whole, so a start in the result is read before it is written', () => {
    const cm = cubeMap();
    const trace = world(cm, [0, 0, 100], [0, 0, 300]);
    trace.entityNum = 5;
    boxTrace(cm, trace, trace.endpos, [0, 0, 0], null, null, 0, MASK.SOLID);
    expect(trace.fraction).toBe(f(235.875 / 300));
    expect(trace.entityNum).toBe(0);
  });

  it("refuses a clip handle the map has not got, the capsule's among them, in Q3's words", () => {
    const cm = cubeMap();
    const trace = newTrace();
    expect(() => boxTrace(cm, trace, [0, 0, 0], [0, 0, 1], null, null, 2, MASK.ALL)).toThrow(
      'CM_ClipHandleToModel: bad handle 2 < 2 < 256'
    );
    expect(() =>
      boxTrace(cm, trace, [0, 0, 0], [0, 0, 1], null, null, CAPSULE_MODEL_HANDLE, MASK.ALL)
    ).toThrow('CM_ClipHandleToModel: bad handle 2 < 254 < 256');
  });
});

/** The cube's world with a seventh side, x + y ≤ 16, cutting a corner off it. */
function cutCube(): ClipMap {
  const base = clipBsp();
  return loadMap(
    clipBsp({
      nodes: [{ ...base.nodes[0], children: [-1, -1] as [number, number] }],
      planes: [...base.planes, { normal: [1, 1, 0], dist: 16 }],
      brushSides: [...base.brushSides, { planeNum: 7, shaderNum: 1 }],
      brushes: [{ firstSide: 0, numSides: 7, shaderNum: 0 }, base.brushes[1]]
    }),
    'maps/test.bsp'
  );
}

describe('position tests', () => {
  const BOX = [
    [-32, -32, -32],
    [32, 32, 32]
  ];

  /** Whether the box at `x` on the x axis is held by the temp box from x 64 to 128. */
  function held(x: number): boolean {
    const cm = cubeMap();
    tempBoxModel(cm, [64, -8, -8], [128, 8, 8]);
    const trace = newTrace();
    boxTrace(cm, trace, [x, 0, 0], [x, 0, 0], BOX[0], BOX[1], BOX_MODEL_HANDLE, MASK.ALL);
    return trace.allsolid;
  }

  it("holds a box that only touches a brush's bounds", () => {
    expect([held(160), held(160.125), held(32), held(31.875)]).toEqual([true, false, true, false]);
  });

  it('takes the first six sides by the bounds, which a rounded corner can reach', () => {
    // 32 − 2⁻¹⁹ + 32 rounds to 64, touching; as a plane, the −x side would leave it 2⁻¹⁹ out.
    const x = 32 - 2 ** -19;
    expect(f(x)).toBe(x);
    expect(held(x)).toBe(true);
  });

  it('holds a point on a slanted side, and stops a sweep at it', () => {
    const cm = cutCube();
    expect(world(cm, [8, 8, 0], [8, 8, 0]).allsolid).toBe(true);
    expect(world(cm, [8, 8.125, 0], [8, 8.125, 0]).allsolid).toBe(false);
    const trace = world(cm, [40, 40, 0], [0, 0, 0]);
    expect(trace.fraction).toBe(f(63.875 / 80));
    expect(trace.plane.normal).toEqual([1, 1, 0]);
  });
});

describe('boxTrace through a model', () => {
  it('meets an inline model where it stands in the world, by its own leaf', () => {
    const trace = newTrace();
    boxTrace(cubeMap(), trace, [200, 0, 0], [0, 0, 0], null, null, 1, MASK.WATER);
    expect(trace.fraction).toBe(f(135.875 / 200));
    expect(trace.contents).toBe(CONTENTS.WATER);
    expect(trace.plane.normal).toEqual([1, 0, 0]);
  });

  it("meets the temp box, a brush of CONTENTS_BODY whose planes are the box's sides", () => {
    const cm = cubeMap();
    expect(tempBoxModel(cm, [-8, -8, -8], [8, 8, 8])).toBe(BOX_MODEL_HANDLE);
    const trace = newTrace();
    boxTrace(cm, trace, [-100, 0, 0], [0, 0, 0], null, null, BOX_MODEL_HANDLE, MASK.SHOT);
    expect(trace.fraction).toBe(f(91.875 / 100));
    expect(trace.contents).toBe(CONTENTS.BODY);
    expect(trace.surfaceFlags).toBe(0);
    // The box's negative planes are typed 3 and on.
    expect(trace.plane).toEqual({ normal: [-1, 0, 0], dist: 8, type: 3, signbits: 1 });

    boxTrace(cm, trace, [0, 0, 0], [0, 0, 0], MINS, MAXS, BOX_MODEL_HANDLE, MASK.SHOT);
    expect([trace.allsolid, trace.contents]).toEqual([true, CONTENTS.BODY]);
  });
});

/** A trace of inline model 1's patch, flat at z 0 over x and y from 0 to 64, its brush left out. */
function patch(
  cm: ClipMap,
  start: number[],
  end: number[],
  mins: number[] | null = null,
  maxs: number[] | null = null
) {
  const trace = newTrace();
  boxTrace(cm, trace, start, end, mins, maxs, 1, MASK.SOLID);
  return trace;
}

describe('boxTrace through a patch', () => {
  it("stops a point at the front of a facet, with the patch's flags", () => {
    const trace = patch(cubeMap(), [16, 16, 50], [16, 16, -50]);
    expect(trace.fraction).toBe(f(49.875 / 100));
    expect(trace.plane.normal).toEqual([0, 0, 1]);
    expect(trace.plane.dist).toBe(0);
    expect(trace.surfaceFlags).toBe(SURF.SLICK | SURF.NOIMPACT);
    expect(trace.contents).toBe(CONTENTS.SOLID);
  });

  it('lets a point through from behind, and everywhere under cm_playerCurveClip 0', () => {
    const cm = cubeMap();
    expect(patch(cm, [16, 16, -50], [16, 16, 50]).fraction).toBe(1);
    cm.cvars.playerCurveClip = 0;
    expect(patch(cm, [16, 16, 50], [16, 16, -50]).fraction).toBe(1);
  });

  it('stops a box by its corner, from the front', () => {
    const trace = patch(cubeMap(), [16, 16, 50], [16, 16, -50], MINS, MAXS);
    expect(trace.fraction).toBe(f((50 + 4 - 28 - 0.125) / 100));
    expect(trace.plane.normal).toEqual([0, 0, 1]);
    expect(trace.plane.dist).toBe(28);
  });

  it("meets a point exactly at a facet's borders, as the C does", () => {
    const cm = cubeMap();
    const hit = f(49.875 / 100);
    const cases: [number[], number[], number][] = [
      // From on an inner border, in it, and in the patch's own edge.
      [[32, 16, 50], [16, 16, -50], hit],
      [[32, 16, 50], [32, 16, -50], hit],
      [[0, 16, 50], [0, 16, -50], hit],
      // Crossing exactly at an inner edge, the outer edges, and a corner.
      [[40, 16, 50], [24, 16, -50], hit],
      [[-16, 16, 50], [16, 16, -50], hit],
      [[80, 16, 50], [48, 16, -50], hit],
      [[-16, -16, 50], [16, 16, -50], hit],
      // Ending exactly on the surface.
      [[16, 16, 50], [16, 16, 0], f(49.875 / 50)]
    ];
    for (const [start, end, fraction] of cases) {
      expect([start, end, patch(cm, start, end).fraction]).toEqual([start, end, fraction]);
    }
  });

  it("meets a box exactly at a facet's planes, as the C does", () => {
    const cm = cubeMap();
    const unit: [number[], number[]] = [
      [-1, -1, -1],
      [1, 1, 1]
    ];
    const eight: [number[], number[]] = [
      [-8, -8, -8],
      [8, 8, 8]
    ];
    // Gliding within SURFACE_CLIP_EPSILON of the surface, it passes the patch's edge.
    expect(patch(cm, [-50, 16, 8.0625], [100, 16, 8.0625], ...eight).fraction).toBe(1);
    // Crossing the edge, entering the surface as it leaves the border, it passes.
    expect(patch(cm, [64, 16, 2], [66, 16, 0], ...unit).fraction).toBe(1);
    expect(patch(cm, [64, 16, 2], [66, 16, -0.5], ...unit).fraction).toBe(f(0.875 / 2.5));
    const down = patch(cm, [16, 16, 50], [16, 16, -50], ...unit);
    expect([down.fraction, down.plane.dist]).toEqual([f(48.875 / 100), 1]);
    expect(patch(cm, [16, 16, -50], [16, 16, 50], ...unit).fraction).toBe(1);
  });

  it('lets everything through under cm_noCurves', () => {
    const cm = cubeMap();
    cm.cvars.noCurves = 1;
    expect(patch(cm, [16, 16, 50], [16, 16, -50]).fraction).toBe(1);
    expect(patch(cm, [16, 16, 50], [16, 16, -50], MINS, MAXS).fraction).toBe(1);
    expect(patch(cm, [16, 16, 0], [16, 16, 0]).allsolid).toBe(false);
  });

  it('holds a point on a facet in a position test, which tests a point as a box', () => {
    const cm = cubeMap();
    expect(patch(cm, [16, 16, 0], [16, 16, 0]).allsolid).toBe(true);
    // A start and end that are one float are a position test; a sweep never holds a point.
    expect(patch(cm, [16, 16, 0], [16 + 1e-12, 16, 0]).allsolid).toBe(true);
    expect(patch(cm, [16, 16, 0], [16, 16, 1e-12]).allsolid).toBe(false);
    expect(patch(cm, [16, 16, 0.0625], [16, 16, 0.0625]).allsolid).toBe(false);
    expect(patch(cm, [16, 16, -0.0625], [16, 16, -0.0625]).allsolid).toBe(false);
  });
});

/** A point's trace of a model at `origin`, turned by `angles`, made and returned. */
function moved(
  cm: ClipMap,
  start: number[],
  end: number[],
  model: number,
  origin: number[],
  angles: number[]
) {
  const trace = newTrace();
  transformedBoxTrace(cm, trace, start, end, null, null, model, MASK.ALL, origin, angles);
  return trace;
}

describe('transformedBoxTrace', () => {
  it('takes the trace to where the model stands, and its distance stays in the frame', () => {
    const trace = moved(cubeMap(), [1200, 0, 0], [1000, 0, 0], 1, [1000, 0, 0], [0, 0, 0]);
    expect(trace.fraction).toBe(f(135.875 / 200));
    expect(trace.endpos[0]).toBeCloseTo(1064.125, 3);
    expect(trace.plane.normal).toEqual([1, 0, 0]);
    expect(trace.plane.dist).toBe(64);
    expect(trace.contents).toBe(CONTENTS.WATER);
  });

  it("turns the trace into a turned model's frame, and the normal back out", () => {
    const trace = moved(cubeMap(), [0, 200, 0], [0, 0, 0], 1, [0, 0, 0], [0, 90, 0]);
    expect(trace.fraction).toBeCloseTo(135.875 / 200, 6);
    expect(trace.plane.normal[0]).toBeCloseTo(0, 6);
    expect(trace.plane.normal[1]).toBeCloseTo(1, 6);
    expect(trace.plane.dist).toBe(64);
  });

  it('never turns the temp box', () => {
    const cm = cubeMap();
    tempBoxModel(cm, [-8, -8, -8], [8, 8, 8]);
    const trace = moved(cm, [0, 100, 0], [0, 0, 0], BOX_MODEL_HANDLE, [0, 0, 0], [0, 45, 0]);
    expect(trace.fraction).toBe(f(91.875 / 100));
    expect(trace.plane.normal).toEqual([0, 1, 0]);
  });
});
