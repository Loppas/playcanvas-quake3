import { describe, expect, it } from 'vitest';

import { MST_PATCH, MST_TRIANGLE_SOUP, type Bsp } from '../formats/bsp';
import type { BrushModelPose } from './brush-models';
import type { WorldRun } from './world-batches';
import { gridIndexes, wholeGrid, type PatchGrid } from './world-curves';
import {
  WorldIndexes,
  gridBases,
  viewSpeeds,
  worldPositions,
  type SeenSurfaces
} from './world-indexes';
import { model, surface, testBsp } from './world-test-fixtures';

/**
 * A grid of this size with these error tables, its group centred on the origin with no radius, its
 * points bounded by `bounds`.
 */
function grid(
  widthLodError: number[],
  heightLodError: number[],
  bounds: [number[], number[]] = [
    [-8, -8, 0],
    [8, 8, 4]
  ]
): PatchGrid {
  const width = widthLodError.length;
  const height = heightLodError.length;
  const count = width * height;
  return {
    width,
    height,
    verts: {
      xyz: new Float32Array(count * 3),
      st: new Float32Array(count * 2),
      lightmap: new Float32Array(count * 2),
      normal: new Float32Array(count * 3),
      color: new Uint8Array(count * 4)
    },
    widthLodError: Float32Array.from(widthLodError),
    heightLodError: Float32Array.from(heightLodError),
    meshBounds: bounds as PatchGrid['meshBounds'],
    localOrigin: [0, 0, 0],
    meshRadius: 0,
    lodOrigin: [0, 0, 0],
    lodRadius: 0
  };
}

/** A run of the world's, of these surfaces. */
const run = (surfaces: number[], entity = 0): WorldRun => ({
  shader: 0,
  entity,
  model: 0,
  fog: 0,
  surfaces
});

/**
 * What a view added: these surfaces, the first `worldCount` by the world's tree, and the light's
 * bit in each one's key where given.
 */
const seen = (surfaces: number[], worldCount = surfaces.length, lit?: number[]): SeenSurfaces => ({
  surfaces: Int32Array.from(surfaces),
  count: surfaces.length,
  worldCount,
  lit: lit && Uint8Array.from(lit)
});

/** Faces of these points each, their indexes in turn. */
const faces = (...numVerts: number[]) =>
  testBsp({ surfaces: numVerts.map((n, i) => surface({ numVerts: n, firstIndex: 3 * i })) });

const patch = surface({ surfaceType: MST_PATCH, numVerts: 0, numIndexes: 0 });
const ahead = { x: 1, y: 0, z: 0 };
/** An eye `depth` before the origin, looking at it. */
const before = (depth: number) => ({ x: -depth, y: 0, z: 0 });

/** The indexes, batches and use of each run. */
const written = (detail: WorldIndexes) =>
  detail.runs.map(({ base, used, batches }) => ({
    base,
    used,
    batches: batches.map((batch) => [batch.base, batch.count]),
    indexes: Array.from(detail.indexes.subarray(base, base + used))
  }));

/** Each run a view writes again. */
function view(detail: WorldIndexes, depth: number, added: SeenSurfaces, lodCurveError = 250) {
  const rewritten: number[] = [];
  detail.view(added, before(depth), ahead, lodCurveError, (r) => rewritten.push(r));
  return rewritten;
}

describe('WorldIndexes', () => {
  /** A face, a curve 5 by 3, and a face, in one run; the curve's points after the faces' 6. */
  function oneRun(): { bsp: Bsp; curve: PatchGrid; detail: WorldIndexes } {
    const bsp = testBsp({ surfaces: [surface(), patch, surface({ firstVert: 3, firstIndex: 3 })] });
    const curve = grid([0, 0.5, 0.1, 0.5, 0], [0, 0.2, 0]);
    const grids = [null, curve, null];
    const detail = new WorldIndexes(bsp, [run([0, 1, 2])], grids, new Map([[1, 6]]), []);
    return { bsp, curve, detail };
  }
  const everything = seen([0, 1, 2]);

  it("writes each run's indexes in its place, all its surfaces with its curves whole", () => {
    const { curve, detail } = oneRun();
    const whole = new Uint32Array(48);
    gridIndexes(curve, wholeGrid(curve), 0, 3, 6, whole, 0);
    expect(written(detail)).toEqual([
      {
        base: 0,
        used: 54,
        batches: [
          [0, 54],
          [0, 0]
        ],
        indexes: [0, 1, 2, ...whole, 3, 4, 5]
      }
    ]);
    const [{ surfaces, count }] = detail.runs;
    expect(Array.from(surfaces.subarray(0, count))).toEqual([0, 1, 2]);
  });

  it('keeps the rows a view allows, and writes the run again in its place', () => {
    const { detail } = oneRun();
    // At 1000 the allowance is 0.25: the curve's third column and second row stay.
    expect(view(detail, 1000, everything)).toEqual([0]);
    expect(written(detail)[0]).toEqual({
      base: 0,
      used: 30,
      batches: [
        [0, 30],
        [0, 0]
      ],
      indexes: [
        ...[0, 1, 2],
        ...[6, 11, 8, 8, 11, 13],
        ...[8, 13, 10, 10, 13, 15],
        ...[11, 16, 13, 13, 16, 18],
        ...[13, 18, 15, 15, 18, 20],
        ...[3, 4, 5]
      ]
    });
    // At 2000, the third column alone; the rows change, and the columns do not.
    expect(view(detail, 2000, everything)).toEqual([0]);
    expect(written(detail)[0].indexes).toEqual([
      ...[0, 1, 2],
      ...[6, 16, 8, 8, 16, 18],
      ...[8, 18, 10, 10, 18, 20],
      ...[3, 4, 5]
    ]);
    // Further off, none of them.
    expect(view(detail, 5000, everything)).toEqual([0]);
    expect(written(detail)[0].indexes).toEqual([0, 1, 2, 6, 16, 10, 10, 16, 20, 3, 4, 5]);
    // At no allowance, none either.
    expect(view(detail, 10, everything, -1)).toEqual([]);
  });

  it('writes nothing while the view holds, or while no curve keeps other rows', () => {
    const { detail } = oneRun();
    // Near enough, every row stays, as the whole cut has them.
    expect(view(detail, 400, everything)).toEqual([]);
    expect(view(detail, 1000, everything)).toEqual([0]);
    expect(view(detail, 1000, everything)).toEqual([]);
    // Another allowance that keeps the same rows.
    expect(view(detail, 1001, everything)).toEqual([]);
    expect(view(detail, 400, everything)).toEqual([0]);
    expect(written(detail)[0].used).toBe(54);
  });

  it("draws each run's seen surfaces in the order the view added them", () => {
    // Faces 0 to 2 in one run, 3 and 4 in another, each its own three points.
    const own = (i: number) => surface({ firstVert: 3 * i, firstIndex: 3 * i });
    const bsp = testBsp({ surfaces: Array.from({ length: 5 }, (_, i) => own(i)) });
    const detail = new WorldIndexes(bsp, [run([0, 1, 2]), run([3, 4])], [], new Map(), []);
    const shown = () => written(detail).map(({ indexes }) => indexes);
    expect(view(detail, 0, seen([2, 0, 3, 4]))).toEqual([0]);
    expect(shown()).toEqual([
      [6, 7, 8, 0, 1, 2],
      [9, 10, 11, 12, 13, 14]
    ]);
    expect(view(detail, 0, seen([2, 0, 3, 4]))).toEqual([]);
    expect(view(detail, 0, seen([0, 4, 2, 3]))).toEqual([0, 1]);
    expect(shown()).toEqual([
      [0, 1, 2, 6, 7, 8],
      [12, 13, 14, 9, 10, 11]
    ]);
    // One run seeing nothing draws nothing.
    expect(view(detail, 0, seen([4]))).toEqual([0, 1]);
    expect(written(detail)[0]).toEqual({
      base: 0,
      used: 0,
      batches: [
        [0, 0],
        [0, 0]
      ],
      indexes: []
    });
    expect(detail.runs.map(({ count }) => count)).toEqual([0, 1]);
  });

  describe('the light', () => {
    /** Faces 0 to 2 in one run, each its own three points. */
    const lit = () => {
      const own = (i: number) => surface({ firstVert: 3 * i, firstIndex: 3 * i });
      const bsp = testBsp({ surfaces: Array.from({ length: 3 }, (_, i) => own(i)) });
      return new WorldIndexes(bsp, [run([0, 1, 2])], [], new Map(), []);
    };
    const keyed = (detail: WorldIndexes) => {
      const [{ surfaces, count, unlit, litBatch }] = detail.runs;
      return { surfaces: Array.from(surfaces.subarray(0, count)), unlit, litBatch };
    };

    it("draws a run's surfaces a light touches after the rest, in batches of their own", () => {
      const detail = lit();
      expect(view(detail, 0, seen([0, 1, 2], 3, [0, 1, 0]))).toEqual([0]);
      expect(keyed(detail)).toEqual({ surfaces: [0, 2, 1], unlit: 2, litBatch: 1 });
      expect(written(detail)[0].batches).toEqual([
        [0, 6],
        [6, 3]
      ]);
      expect(written(detail)[0].indexes).toEqual([0, 1, 2, 6, 7, 8, 3, 4, 5]);
    });

    it('cuts the run again as the light comes and goes, and not while it holds', () => {
      const detail = lit();
      expect(view(detail, 0, seen([0, 1, 2], 3, [0, 1, 0]))).toEqual([0]);
      expect(view(detail, 0, seen([0, 1, 2], 3, [0, 1, 0]))).toEqual([]);
      // The same surfaces, but one more lit: they take the same places, cut otherwise.
      expect(view(detail, 0, seen([0, 2, 1], 3, [0, 1, 1]))).toEqual([0]);
      expect(keyed(detail)).toEqual({ surfaces: [0, 2, 1], unlit: 1, litBatch: 1 });
      expect(view(detail, 0, seen([0, 1, 2], 3, [1, 1, 1]))).toEqual([0]);
      expect(keyed(detail)).toEqual({ surfaces: [0, 1, 2], unlit: 0, litBatch: 0 });
      expect(written(detail)[0].batches.map(([, count]) => count)).toEqual([9, 0]);
      expect(view(detail, 0, seen([0, 1, 2]))).toEqual([0]);
      expect(keyed(detail)).toEqual({ surfaces: [0, 1, 2], unlit: 3, litBatch: 1 });
    });

    it("ORs each batch's lights from the surfaces whose functions OR them into it", () => {
      // A face of 994 points, then a soup that does not fit, which ORs its lights in first, then a
      // face: the soup's lights go with the first batch.
      const bsp = testBsp({
        surfaces: [
          surface({ numVerts: 994 }),
          surface({ surfaceType: MST_TRIANGLE_SOUP, numVerts: 10, firstIndex: 3 }),
          surface({ firstIndex: 6 })
        ]
      });
      const detail = new WorldIndexes(bsp, [run([0, 1, 2])], [], new Map(), []);
      const bits = Int32Array.from([0b001, 0b010, 0b100]);
      expect([0, 1].map((k) => detail.dlightBits(0, k, bits))).toEqual([0b011, 0b100]);
      // A batch with no surfaces takes none.
      expect(detail.dlightBits(0, 2, bits)).toBe(0);
    });
  });

  it("draws a surface the tree added in the world's run, and a brush model's in its own", () => {
    // `*1` placed twice: its face is added once a view, by the first.
    const bsp = testBsp({
      surfaces: [surface(), surface({ firstVert: 3 })],
      models: [model(0, 1), model(1, 1)]
    });
    const pose: BrushModelPose = { model: 1, origin: [0, 0, 0], angles: [0, 0, 0] };
    const runs = [run([1], 0), run([1], 1), run([0], 2)];
    const detail = new WorldIndexes(bsp, runs, [], new Map(), [pose, pose]);
    expect(view(detail, 0, seen([0, 1], 1))).toEqual([1]);
    expect(detail.runs.map(({ count }) => count)).toEqual([1, 0, 1]);
    // Added by the tree, the model's face has no run.
    expect(view(detail, 0, seen([0, 1], 2))).toEqual([0]);
    expect(detail.runs.map(({ count }) => count)).toEqual([0, 0, 1]);
  });

  it('chooses a curve its rows only while it is seen', () => {
    const { detail } = oneRun();
    expect(view(detail, 1000, seen([0, 2]))).toEqual([0]);
    expect(written(detail)[0].indexes).toEqual([0, 1, 2, 3, 4, 5]);
    // Further off the unseen curve would keep fewer rows, and nothing it draws changes.
    expect(view(detail, 5000, seen([0, 2]))).toEqual([]);
    // Seen again, its rows are chosen for the view.
    expect(view(detail, 5000, everything)).toEqual([0]);
    expect(written(detail)[0].indexes).toEqual([0, 1, 2, 6, 16, 10, 10, 16, 20, 3, 4, 5]);
  });

  it('has the batches next-fit can need, and cuts a seen order into more than the whole', () => {
    const bsp = faces(600, 300, 600, 300);
    const detail = new WorldIndexes(bsp, [run([0, 1, 2, 3])], [], new Map(), []);
    expect(written(detail)[0].batches).toEqual([
      [0, 6],
      [6, 6],
      [0, 0],
      [0, 0]
    ]);
    expect(view(detail, 0, seen([0, 2, 1, 3]))).toEqual([0]);
    expect(written(detail)[0].batches).toEqual([
      [0, 3],
      [3, 6],
      [9, 3],
      [0, 0]
    ]);
  });

  it('throws where a cut passes the batches its run has', () => {
    const bsp = faces(3, 3, 3);
    const detail = new WorldIndexes(bsp, [run([0, 1, 2])], [], new Map(), []);
    expect(detail.runs[0].batches).toHaveLength(2);
    // Grown past the room the run was bounded by.
    for (const face of bsp.surfaces) face.numVerts = 600;
    expect(() => view(detail, 0, seen([1, 0, 2]))).toThrow(
      new Error('A run was cut into more batches than next-fit can need')
    );
  });

  it('cuts a run into fewer batches when its curves keep fewer, the rest drawing nothing', () => {
    // A face of 994 points leaves room for two rows of 3, one of them spare: whole, the curve
    // begins a batch. Two columns wide, it fits. A third batch is spare.
    const bsp = testBsp({ surfaces: [surface({ numVerts: 994 }), patch] });
    const curve = grid([0, 0.25, 0], [0, 0]);
    const detail = new WorldIndexes(bsp, [run([0, 1])], [null, curve], new Map([[1, 994]]), []);
    expect(written(detail)[0].batches).toEqual([
      [0, 3],
      [3, 12],
      [0, 0],
      [0, 0]
    ]);
    expect(view(detail, 2000, seen([0, 1]))).toEqual([0]);
    expect(written(detail)[0]).toEqual({
      base: 0,
      used: 9,
      batches: [
        [0, 9],
        [3, 0],
        [0, 0],
        [0, 0]
      ],
      indexes: [0, 1, 2, 994, 997, 996, 996, 997, 999]
    });
  });

  it("holds each batch's vertexes as the tessellator counts them, a lone row among them", () => {
    const { detail } = oneRun();
    // Whole: the faces' 3 points each and the curve's 5 by 3.
    const vertexes = () => detail.runs[0].batches.map((batch) => batch.vertexes);
    expect(vertexes()).toEqual([21, 0]);
    // At 1000, three columns and three rows; at 5000, two of each.
    view(detail, 1000, everything);
    expect(vertexes()).toEqual([15, 0]);
    view(detail, 5000, everything);
    expect(vertexes()).toEqual([10, 0]);
    // A row alone takes its room and draws nothing; a batch the cut has no use for holds none.
    const bsp = testBsp({ surfaces: [surface({ numVerts: 994 }), patch] });
    const curve = grid([0, 0.25, 0], [0, 0]);
    const cut = new WorldIndexes(bsp, [run([0, 1])], [null, curve], new Map([[1, 994]]), []);
    expect(cut.runs[0].batches.map((batch) => batch.vertexes)).toEqual([997, 6, 0, 0]);
    view(cut, 2000, seen([0, 1]));
    expect(cut.runs[0].batches.map((batch) => batch.vertexes)).toEqual([998, 0, 0, 0]);
  });

  it('puts every run back to all its surfaces, every curve whole, until the next view', () => {
    const { curve, detail } = oneRun();
    view(detail, 1000, seen([2, 1]));
    const rewritten: number[] = [];
    detail.whole((r) => rewritten.push(r));
    expect(rewritten).toEqual([0]);
    const whole = new Uint32Array(48);
    gridIndexes(curve, wholeGrid(curve), 0, 3, 6, whole, 0);
    expect(written(detail)[0].indexes).toEqual([0, 1, 2, ...whole, 3, 4, 5]);
    detail.whole(() => rewritten.push(-1));
    expect(rewritten).toEqual([0]);
    // The next view chooses the rows again, though its surfaces are as whole.
    expect(view(detail, 1000, everything)).toEqual([0]);
    // Its first surface alone seen, every row whole: only how many it has tells it from whole.
    view(detail, 400, everything);
    view(detail, 400, seen([0]));
    const told: number[] = [];
    detail.whole((r) => told.push(r));
    expect(told).toEqual([0]);
    expect(written(detail)[0].used).toBe(54);
  });

  describe('a tessellated run', () => {
    /** Each batch's first vertex and vertexes, and the vertexes listed for it. */
    const listed = (detail: WorldIndexes, r = 0) =>
      detail.runs[r].batches.map(({ first, vertexes }) => [
        first,
        vertexes,
        Array.from(detail.runs[r].tess!.subarray(first, first + vertexes))
      ]);

    it("numbers each batch's vertexes from its first, as the tessellator holds them, and lists them", () => {
      const bsp = testBsp({ surfaces: [surface(), patch, surface({ firstVert: 3, firstIndex: 3 })] });
      const curve = grid([0, 0.5, 0.1, 0.5, 0], [0, 0.2, 0]);
      const detail = new WorldIndexes(bsp, [run([0, 1, 2])], [null, curve, null], new Map([[1, 6]]), [], [true]);
      // Whole, the curve's 15 points follow the face's 3 in the batch, as a grid from 3 would be.
      const whole = new Uint32Array(48);
      gridIndexes(curve, wholeGrid(curve), 0, 3, 3, whole, 0);
      expect(written(detail)[0].indexes).toEqual([0, 1, 2, ...whole, 18, 19, 20]);
      const points = Array.from({ length: 15 }, (_, i) => 6 + i);
      expect(listed(detail)).toEqual([
        [0, 21, [0, 1, 2, ...points, 3, 4, 5]],
        [21, 0, []]
      ]);
      // At 1000 the curve keeps three columns of three rows, listed and numbered so.
      view(detail, 1000, everything);
      expect(written(detail)[0].indexes).toEqual([
        ...[0, 1, 2],
        ...[3, 6, 4, 4, 6, 7],
        ...[4, 7, 5, 5, 7, 8],
        ...[6, 9, 7, 7, 9, 10],
        ...[7, 10, 8, 8, 10, 11],
        ...[12, 13, 14]
      ]);
      expect(listed(detail)).toEqual([
        [0, 15, [0, 1, 2, 6, 8, 10, 11, 13, 15, 16, 18, 20, 3, 4, 5]],
        [15, 0, []]
      ]);
      // Room for its surfaces whole, and a row of its curve again in the batch its lit surfaces
      // may start.
      expect(detail.runs[0].tess).toHaveLength(21 + 5);
    });

    it('lists a row lent to the next batch in both, and each row alone where it takes room', () => {
      // A soup of 5900 indexes leaves room for 3 rows of 5, then a row alone 195 times, until the
      // vertexes run out; the next batch begins at the last row drawn.
      const bsp = testBsp({
        surfaces: [surface({ surfaceType: MST_TRIANGLE_SOUP, numIndexes: 5900 }), patch, surface({ firstVert: 3 })]
      });
      const curve = grid([0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const detail = new WorldIndexes(bsp, [run([0, 1, 2])], [null, curve, null], new Map([[1, 6]]), [], [true]);
      const rows = (first: number, count: number) =>
        Array.from({ length: count * 5 }, (_, i) => 6 + (first + Math.floor(i / 5)) * 5 + (i % 5));
      const alone = Array.from({ length: 195 }, () => rows(2, 1)).flat();
      expect(listed(detail)).toEqual([
        [0, 993, [0, 1, 2, ...rows(0, 3), ...alone]],
        [993, 38, [...rows(2, 7), 3, 4, 5]],
        [1031, 0, []],
        [1031, 0, []]
      ]);
      // Room for its surfaces whole, a row for each cut and a batch of rows alone: its indexes
      // can come near the tessellator's room once.
      expect(detail.runs[0].tess).toHaveLength(51 + 3 * 5 + 999);
      // The second batch's triangles from its first vertex, its face's after the curve's 35.
      const [, second] = detail.runs[0].batches;
      const indexes = Array.from(detail.indexes.subarray(second.base, second.base + second.count));
      expect(indexes.slice(0, 6)).toEqual([0, 5, 1, 1, 5, 6]);
      expect(indexes.slice(-3)).toEqual([35, 36, 37]);
    });

    it("has room for its faces' vertexes alone, and the other runs list none", () => {
      const bsp = faces(3, 4, 5);
      const detail = new WorldIndexes(bsp, [run([0, 1]), run([2])], [], new Map(), [], [true, false]);
      expect(detail.runs.map(({ tess }) => tess?.length ?? null)).toEqual([7, null]);
      expect(written(detail)[1].indexes).toEqual([0, 1, 2]);
    });
  });

  it("takes a brush model's curves through its pose, and leaves the other runs be", () => {
    const bsp = testBsp({ surfaces: [surface(), patch], models: [model(0, 1), model(1, 1)] });
    const curve = grid([0, 0.3, 0], [0, 0]);
    const runs = [run([1], 0), run([0], 1)];
    const pose: BrushModelPose = { model: 1, origin: [-1000, 0, 0], angles: [0, 0, 0] };
    const detail = new WorldIndexes(bsp, runs, [null, curve], new Map([[1, 3]]), [pose]);
    // Its group's centre stands at (-1000, 0, 0), 10 from the eye: every row stays, where at the
    // world's origin the column would go.
    const both = seen([0, 1], 1);
    expect(view(detail, 1010, both)).toEqual([]);
    expect(view(detail, 3000, both)).toEqual([0]);
    // The second run's place follows the room the first has with its curve whole.
    expect(written(detail).map((r) => [r.base, r.used])).toEqual([
      [0, 6],
      [12, 3]
    ]);
  });

  it("takes a brush model's curves through where it is placed again", () => {
    const bsp = testBsp({ surfaces: [surface(), patch], models: [model(0, 1), model(1, 1)] });
    // Its group's centre 990 along the model's forward.
    const curve: PatchGrid = { ...grid([0, 0.3, 0], [0, 0]), lodOrigin: [990, 0, 0] };
    const runs = [run([1], 0), run([0], 1)];
    const pose: BrushModelPose = { model: 1, origin: [0, 0, 0], angles: [0, 0, 0] };
    const detail = new WorldIndexes(bsp, runs, [null, curve], new Map([[1, 3]]), [pose]);
    const both = seen([0, 1], 1);
    // At the world's origin, the centre 2000 from the eye: the column goes.
    expect(view(detail, 1010, both)).toEqual([0]);
    expect(written(detail)[0].used).toBe(6);
    // Placed so the centre is at the eye, every row stays.
    detail.orient(0, { origin: [-2000, 0, 0], angles: [0, 0, 0] });
    expect(view(detail, 1010, both)).toEqual([0]);
    expect(written(detail)[0].used).toBe(12);
    // Back at the origin turned half round, the centre is 20 from the eye: they stay.
    detail.orient(0, { origin: [0, 0, 0], angles: [0, 180, 0] });
    expect(view(detail, 1010, both)).toEqual([]);
    // And unturned, it goes again.
    detail.orient(0, pose);
    expect(view(detail, 1010, both)).toEqual([0]);
    expect(written(detail)[0].used).toBe(6);
  });

  it("takes a brush model's curves through its axes in floats", () => {
    // Found by search: the middle column's error is the one this view gives through the axes in
    // floats, as `AnglesToAxis` holds them; through the axes in doubles it gives a hair less, and
    // the column would go.
    const bsp = testBsp({ surfaces: [surface(), patch], models: [model(0, 1), model(1, 1)] });
    const error = 0.3017527759075165;
    const curve: PatchGrid = { ...grid([0, error, 0], [0, 0]), lodOrigin: [305, -368, 0] };
    const runs = [run([1], 0), run([0], 1)];
    const pose: BrushModelPose = { model: 1, origin: [0, 0, 0], angles: [0, 0, 0] };
    const detail = new WorldIndexes(bsp, runs, [null, curve], new Map([[1, 3]]), [pose]);
    detail.orient(0, { origin: [-8, 0, 0], angles: [0, 297.9, 0] });
    expect(view(detail, 1019, seen([0, 1], 1))).toEqual([]);
    expect(written(detail)[0].used).toBe(12);
  });
});

describe('viewSpeeds', () => {
  it('counts a view as r_speeds 1 prints it: each batch with indexes, once a pass', () => {
    // Four faces of a two-pass shader, cut into three batches in the view's order, and a fifth of
    // a one-pass shader; the first run's spare batch has nothing to draw.
    const bsp = faces(600, 300, 600, 300, 3);
    const detail = new WorldIndexes(bsp, [run([0, 1, 2, 3]), run([4])], [], new Map(), []);
    view(detail, 0, seen([0, 2, 1, 3, 4]));
    expect(detail.runs[0].batches.map((batch) => batch.count)).toEqual([3, 6, 3, 0]);
    const added = { count: 9, leafs: 7, zFar: 1234.4 };
    expect(viewSpeeds(added, detail.runs, [2, 1])).toEqual({
      shaders: 4,
      surfaces: 9,
      leafs: 7,
      vertexes: 600 + 900 + 300 + 3,
      triangles: 5,
      passTriangles: (12 * 2 + 3) / 3,
      zFar: 1234
    });
    // Seeing none of the first run's, it counts none of its batches.
    view(detail, 0, seen([4]));
    expect(viewSpeeds(added, detail.runs, [2, 1])).toMatchObject({ shaders: 1, vertexes: 3 });
    // The lights' passes' triangles count as passes' too.
    expect(viewSpeeds(added, detail.runs, [2, 1], 6)).toMatchObject({ passTriangles: 3 });
  });
});

describe('worldPositions', () => {
  it("holds the map's points, then each drawn grid's from its base", () => {
    const bsp = testBsp({ surfaces: [surface({ numVerts: 2 }), patch, patch] });
    const [undrawn, drawn] = [grid([0, 0], [0, 0]), grid([0, 0], [0, 0])];
    drawn.verts.xyz.set(Array.from({ length: 12 }, (_, i) => 100 + i));
    const positions = worldPositions(bsp, [null, undrawn, drawn], new Map([[2, 2]]));
    // The map's points are at (i, 2i, 3i).
    expect(Array.from(positions)).toEqual([
      ...[0, 0, 0, 1, 2, 3],
      ...Array.from({ length: 12 }, (_, i) => 100 + i)
    ]);
  });
});

describe('gridBases', () => {
  it("puts each drawn grid's points after the map's own, in lump order", () => {
    const bsp = testBsp({ surfaces: [surface({ numVerts: 7 }), patch, patch, patch, patch] });
    const [threeByTwo, twoByFour, twoByTwo] = [
      grid([0, 0, 0], [0, 0]),
      grid([0, 0], [0, 0, 0, 0]),
      grid([0, 0], [0, 0])
    ];
    const grids = [null, threeByTwo, null, twoByFour, twoByTwo];
    expect(gridBases(bsp, grids, new Set([0, 1, 3]))).toEqual(
      new Map([
        [1, 7],
        [3, 13]
      ])
    );
  });
});
