import { describe, expect, it } from 'vitest';

import { MST_PATCH, MST_TRIANGLE_SOUP, type BspDrawVerts, type BspSurface } from '../formats/bsp';
import {
  MAX_GRID_SIZE,
  SURF_NODRAW,
  fixSharedVertexLodError,
  gridIndexes,
  gridTables,
  loadPatchGrids,
  lodErrorForVolume,
  lodTables,
  parseMesh,
  stitchAllPatches,
  subdividePatchToGrid,
  wholeGrid,
  type GridTables,
  type Orientation,
  type PatchGrid
} from './world-curves';
import { surface, testBsp } from './world-test-fixtures';

const f = Math.fround;

/** Control points `width` by `height`, a row at a time, each where `at` puts it, white. */
function controlPoints(
  width: number,
  height: number,
  at: (column: number, row: number) => number[]
): BspDrawVerts {
  const count = width * height;
  const points: BspDrawVerts = {
    xyz: new Float32Array(count * 3),
    st: new Float32Array(count * 2),
    lightmap: new Float32Array(count * 2),
    normal: new Float32Array(count * 3),
    color: new Uint8Array(count * 4).fill(255)
  };
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) points.xyz.set(at(i, j), (j * width + i) * 3);
  }
  return points;
}

/** Three by three on a 64-unit square, flat but for the middle column, raised `z`. */
const bulge = (z: number) => controlPoints(3, 3, (i, j) => [64 * i, 64 * j, i === 1 ? z : 0]);

/** A field of each of a grid's points, `n` numbers a point. */
const each = (grid: PatchGrid, field: Float32Array | Uint8Array, n: number) =>
  Array.from({ length: grid.width * grid.height }, (_, k) =>
    Array.from(field.subarray(k * n, k * n + n))
  );

/** A grid's size and error tables. */
const shape = (grid: PatchGrid) => [
  grid.width,
  grid.height,
  Array.from(grid.widthLodError),
  Array.from(grid.heightLodError)
];

/**
 * A grid of these points as subdivision would leave one, in level-of-detail group `group`. Column
 * `i`'s error is `base + i` and row `j`'s `base + 10 + j`, so a stitch shows which it took.
 */
function gridOf(
  width: number,
  height: number,
  at: (column: number, row: number) => number[],
  base = 10,
  group = 0
): PatchGrid {
  return {
    width,
    height,
    verts: controlPoints(width, height, at),
    widthLodError: Float32Array.from({ length: width }, (_, i) => base + i),
    heightLodError: Float32Array.from({ length: height }, (_, j) => base + 10 + j),
    meshBounds: [
      [0, 0, 0],
      [0, 0, 0]
    ],
    localOrigin: [0, 0, 0],
    meshRadius: 0,
    lodOrigin: [group, 0, 0],
    lodRadius: 100
  };
}

/** `ZONEID`, the zone's trailer, as a float: what Q3 reads one past an error table's end. */
const ZONE_ID = new Float32Array(new Uint32Array([0x1d4a11]).buffer)[0];

describe('subdividePatchToGrid', () => {
  it('drops the colinear columns and rows of a flat patch, down to its corners', () => {
    const grid = subdividePatchToGrid(3, 3, controlPoints(3, 3, (i, j) => [64 * i, 64 * j, 0]), 4);
    expect(shape(grid)).toEqual([2, 2, [0, 0], [0, 0]]);
    expect(each(grid, grid.verts.xyz, 3)).toEqual([
      [0, 0, 0],
      [128, 0, 0],
      [0, 128, 0],
      [128, 128, 0]
    ]);
    expect(grid.meshBounds).toEqual([
      [0, 0, 0],
      [128, 128, 0]
    ]);
    expect(grid.localOrigin).toEqual([64, 64, 0]);
    expect(grid.meshRadius).toBe(f(Math.sqrt(8192)));
    // Until a patch's group is given it, the grid is its own.
    expect([grid.lodOrigin, grid.lodRadius]).toEqual([grid.localOrigin, grid.meshRadius]);
  });

  it('keeps a column whose curve stands 4 off its chord, one over that its error', () => {
    const grid = subdividePatchToGrid(3, 3, bulge(8), 4);
    expect(shape(grid)).toEqual([3, 2, [0, 0.25, 0], [0, 0]]);
    // The middle column put on the curve, half the control point's height.
    expect(each(grid, grid.verts.xyz, 3)).toEqual([
      [0, 0, 0],
      [64, 0, 4],
      [128, 0, 0],
      [0, 128, 0],
      [64, 128, 4],
      [128, 128, 0]
    ]);
  });

  it('subdivides a column standing farther off than r_subdivisions, and measures each half', () => {
    const grid = subdividePatchToGrid(3, 3, bulge(8.0625), 4);
    // The two halves measured in single precision, each a little differently.
    const errors = [0, 0.994214475, 0.248062015, 0.994214594, 0].map(f);
    expect(shape(grid)).toEqual([5, 2, errors, [0, 0]]);
    expect(each(grid, grid.verts.xyz, 3).slice(0, 5)).toEqual([
      [0, 0, 0],
      [32, 0, 3.0234375],
      [64, 0, 4.03125],
      [96, 0, 3.0234375],
      [128, 0, 0]
    ]);
    // Within a larger allowance it is not.
    expect(shape(subdividePatchToGrid(3, 3, bulge(8.0625), 5))).toEqual([
      3,
      2,
      [0, f(0.248062015), 0],
      [0, 0]
    ]);
  });

  it('measures in single precision, where 4.0039 off in doubles rounds to 4', () => {
    const high = controlPoints(3, 3, (i, j) => [64 * i, 64 * j, i === 1 ? 100008.0078125 : 100000]);
    expect(shape(subdividePatchToGrid(3, 3, high, 4))).toEqual([3, 2, [0, 0.25, 0], [0, 0]]);
  });

  it('drops a column standing less than 0.1 off its chord, and keeps one at 0.1', () => {
    expect(shape(subdividePatchToGrid(3, 3, bulge(0.18), 4))).toEqual([2, 2, [0, 0], [0, 0]]);
    expect(shape(subdividePatchToGrid(3, 3, bulge(0.2), 4))).toEqual([3, 2, [0, 10, 0], [0, 0]]);
  });

  it('stops subdividing at 65 points a side', () => {
    const zigzag = controlPoints(33, 3, (i, j) => [64 * i, 64 * j, i % 2 ? 1000 : 0]);
    const grid = subdividePatchToGrid(33, 3, zigzag, 4);
    expect([grid.width, grid.height]).toEqual([MAX_GRID_SIZE, 2]);
  });

  it('turns a grid taller than it is wide, its error tables with it', () => {
    // Curved along its rows, unevenly, and flat across them.
    const tall = controlPoints(3, 3, (i, j) => [64 * i, 64 * j, [0, 16, 4][j]]);
    const grid = subdividePatchToGrid(3, 3, tall, 4);
    expect(shape(grid)).toEqual([
      5,
      2,
      [0, 0.573169768, 0.142926872, 0.577051103, 0].map(f),
      [0, 0]
    ]);
    // The columns come out reversed, the last row first.
    expect(each(grid, grid.verts.xyz, 3).slice(0, 5)).toEqual([
      [0, 128, 4],
      [0, 96, 8.25],
      [0, 64, 9],
      [0, 32, 6.25],
      [0, 0, 0]
    ]);
  });

  describe("MakeMeshNormals' normals", () => {
    it("gives a flat patch its plane's", () => {
      const flat = controlPoints(3, 3, (i, j) => [64 * i, 64 * j, 0]);
      const grid = subdividePatchToGrid(3, 3, flat, 4);
      expect(each(grid, grid.verts.normal, 3)).toEqual(new Array(4).fill([0, 0, 1]));
    });

    it("sums the faces round each point, an edge's from its side alone", () => {
      const grid = subdividePatchToGrid(3, 3, bulge(8), 4);
      const tilted = [f(0.0623782873), 0, f(0.998052597)];
      const [x, y, z] = tilted;
      expect(each(grid, grid.verts.normal, 3)).toEqual([
        [-x, y, z],
        [0, 0, 1],
        [x, y, z],
        [-x, y, z],
        [0, 0, 1],
        [x, y, z]
      ]);
    });

    it("wraps no grid whose edges stand apart, however many rows it has", () => {
      // A dome: three rows and three columns, the middle raised, so nothing is dropped or turned.
      const dome = controlPoints(3, 3, (i, j) => [64 * i, 64 * j, i === 1 && j === 1 ? 8 : 0]);
      const grid = subdividePatchToGrid(3, 3, dome, 4);
      expect([grid.width, grid.height]).toEqual([3, 3]);
      const [c, cz] = [f(0.0156211853), f(0.999755859)];
      const [e, ez] = [f(0.0156154744), f(0.999878109)];
      expect(each(grid, grid.verts.normal, 3)).toEqual([
        [-c, -c, cz],
        [0, -e, ez],
        [c, -c, cz],
        [-e, 0, ez],
        [0, 0, f(0.99999994)],
        [e, 0, ez],
        [-c, c, cz],
        [0, e, ez],
        [c, c, cz]
      ]);
    });

    it('steps past a point on top of its neighbour to the next one out', () => {
      // The first column's curve doubles back to its first point at its middle row.
      const back = controlPoints(3, 3, (i, j) => [64 * i, [0, -64, 128][j], j === 1 ? 2 * i : 0]);
      const grid = subdividePatchToGrid(3, 3, back, 4);
      // Turned, so the column is the first row, backwards.
      expect(each(grid, grid.verts.xyz, 3).slice(0, 3)).toEqual([
        [0, 128, 0],
        [0, 0, 0],
        [0, 0, 0]
      ]);
      const normals = each(grid, grid.verts.normal, 3);
      expect(normals.slice(1, 3)).toEqual([
        [f(-0.0070082806), f(-0.441631138), f(0.897169292)],
        // Its neighbour on top of it, it takes the point beyond.
        [f(-0.0110471947), f(-0.707106709), f(0.707020462)]
      ]);
    });

    it('wraps round where a grid closes on itself', () => {
      // A loop round a square, its first and last columns at one point, the seam.
      const loop = [
        [64, 0],
        [64, 64],
        [0, 64],
        [-64, 64],
        [-64, 0],
        [-64, -64],
        [0, -64],
        [64, -64],
        [64, 0]
      ];
      const ring = controlPoints(9, 3, (i, j) => [loop[i][0], loop[i][1], 32 * j]);
      const grid = subdividePatchToGrid(9, 3, ring, 4);
      expect([grid.width, grid.height]).toEqual([33, 2]);
      const normals = each(grid, grid.verts.normal, 3);
      // Straight out at the seam, from either side.
      const seam = [1, 0, f(4.79397244e-10)];
      expect([normals[0], normals[32]]).toEqual([seam, seam]);
      expect([normals[1], normals[31]]).toEqual([
        [f(0.989261329), f(0.146158084), f(7.14467707e-10)],
        [f(0.989261329), f(-0.146158069), f(7.14467707e-10)]
      ]);
    });
  });
});

describe('parseMesh', () => {
  /** A map of one patch, 3 by 3, its control points `bulge(8)`'s, with these colours. */
  function patchMap(colors: number[][] = [], fields: Parameters<typeof surface>[0] = {}) {
    const bsp = testBsp({
      surfaces: [
        surface({ surfaceType: MST_PATCH, numVerts: 9, patchWidth: 3, patchHeight: 3, ...fields })
      ]
    });
    const points = bulge(8);
    bsp.drawVerts.xyz.set(points.xyz.subarray(0, bsp.drawVerts.xyz.length));
    colors.forEach((rgba, i) => bsp.drawVerts.color.set(rgba, i * 4));
    return bsp;
  }

  it("shifts the control points' colours as the light's, then halves them in integers", () => {
    // By column, the same in every row.
    const columns = [
      [3, 200, 1, 255],
      [0, 100, 1, 0],
      [0, 50, 2, 0]
    ];
    const grid = parseMesh(patchMap([...columns, ...columns, ...columns]), 0, 1, 4)!;
    expect(each(grid, grid.verts.color, 4).slice(0, 3)).toEqual([
      // 400 green, scaled back to 255 with the others.
      [3, 255, 1, 255],
      // Halved after the shift: before it, the green would come out 224.
      [0, 188, 2, 63],
      [0, 100, 4, 0]
    ]);
  });

  it('takes its level-of-detail group from the bounds in its lightmapVecs', () => {
    const lightmapVecs: BspSurface['lightmapVecs'] = [
      [-64, -32, 0],
      [64, 96, 16],
      [0, 0, 1]
    ];
    const grid = parseMesh(patchMap([], { lightmapVecs }), 0, 1, 4)!;
    expect(grid.lodOrigin).toEqual([0, 32, 8]);
    expect(grid.lodRadius).toBe(f(Math.sqrt(8256)));
    // Its own bounds are unchanged.
    expect(grid.localOrigin).toEqual([64, 64, 2]);
  });

  it('subdivides at r_subdivisions', () => {
    const points = bulge(8.0625);
    const bsp = patchMap();
    bsp.drawVerts.xyz.set(points.xyz);
    expect(parseMesh(bsp, 0, 1, 4)!.width).toBe(5);
    expect(parseMesh(bsp, 0, 1, 5)!.width).toBe(3);
  });

  it('makes no grid for a nodraw patch', () => {
    const bsp = patchMap();
    bsp.shaders[0].surfaceFlags = SURF_NODRAW;
    expect(parseMesh(bsp, 0, 1, 4)).toBeNull();
  });

  it("refuses a patch wider or taller than a grid holds, in the port's words", () => {
    const sized = (patchWidth: number, patchHeight: number) => {
      const numVerts = patchWidth * patchHeight;
      const patch = surface({ surfaceType: MST_PATCH, numVerts, patchWidth, patchHeight });
      return testBsp({ surfaces: [patch] });
    };
    expect(parseMesh(sized(65, 3), 0, 1, 4)).not.toBeNull();
    expect(() => parseMesh(sized(67, 3), 0, 1, 4)).toThrow(
      new Error('ParseMesh: patch 0 is 67 by 3, over MAX_GRID_SIZE (65)')
    );
    expect(() => parseMesh(sized(3, 67), 0, 1, 4)).toThrow(
      new Error('ParseMesh: patch 0 is 3 by 67, over MAX_GRID_SIZE (65)')
    );
    // Never subdivided, so never refused.
    const nodraw = sized(67, 3);
    nodraw.shaders[0].surfaceFlags = SURF_NODRAW;
    expect(parseMesh(nodraw, 0, 1, 4)).toBeNull();
  });
});

describe('stitchAllPatches', () => {
  /** Three by two, its first row along y = 0 from x = 0 to 128, bowed out to y = 8 between. */
  const bowed = () =>
    gridOf(3, 2, (i, j) => (j === 0 ? [64 * i, i === 1 ? 8 : 0, 0] : [64 * i, 64, 0]));
  /** Two by two below it, its last row along y = 0 from x = 0 to 128, with nothing between. */
  const below = (group = 0) => gridOf(2, 2, (i, j) => [128 * i, 64 * j - 64, 0], 30, group);

  it('mends a crack with a column through the point a side has between two of the other', () => {
    const first = bowed();
    const second = below();
    const [left, right] = [
      [200, 100, 50, 255],
      [100, 51, 0, 255]
    ];
    second.verts.color.set([...left, ...right, ...left, ...right]);
    second.verts.st.set([0, 0, 1, 0, 0, 1, 1, 1]);
    const grids = [first, second];
    expect(stitchAllPatches(grids)).toBe(1);
    expect(grids[0]).toBe(first);
    const grid = grids[1]!;
    // The column's error is the first grid's for its point.
    expect(shape(grid)).toEqual([3, 2, [30, 11, 31], [40, 41]]);
    // The point where the crack was; on the other side, the midpoint, off the curve.
    expect(each(grid, grid.verts.xyz, 3)).toEqual([
      [0, -64, 0],
      [64, -64, 0],
      [128, -64, 0],
      [0, 0, 0],
      [64, 8, 0],
      [128, 0, 0]
    ]);
    const colors = each(grid, grid.verts.color, 4);
    expect([colors[1], colors[4]]).toEqual([
      [150, 75, 25, 255],
      [150, 75, 25, 255]
    ]);
    const st = each(grid, grid.verts.st, 2);
    expect([st[1], st[4]]).toEqual([
      [0.5, 0],
      [0.5, 1]
    ]);
    // Its normals made and its bounds taken again, its group kept.
    expect(each(grid, grid.verts.normal, 3)).toEqual(Array(6).fill([0, 0, 1]));
    expect(grid.meshBounds).toEqual([
      [0, -64, 0],
      [128, 8, 0]
    ]);
    expect([grid.lodOrigin, grid.lodRadius]).toEqual([[0, 0, 0], 100]);
  });

  it('mends it with a row where the side with the crack runs along its height', () => {
    const grids = [bowed(), gridOf(2, 2, (i, j) => [128 * j, 64 * i - 64, 0], 30)];
    expect(stitchAllPatches(grids)).toBe(1);
    const grid = grids[1]!;
    expect(shape(grid)).toEqual([2, 3, [30, 31], [40, 11, 41]]);
    expect(each(grid, grid.verts.xyz, 3)).toEqual([
      [0, -64, 0],
      [0, 0, 0],
      [64, -64, 0],
      [64, 8, 0],
      [128, -64, 0],
      [128, 0, 0]
    ]);
  });

  it("searches back along a side, the error after the point taken, past the table's end", () => {
    /** Five by two, its first row along y = 0 from x = 0 to 128. */
    const ruler = () => gridOf(5, 2, (i, j) => [32 * i, 64 * j, 0]);
    /** Two by two below it, its last row along y = 0 from x = `from` back to `to`. */
    const back = (from: number, to: number) =>
      gridOf(2, 2, (i, j) => [i ? to : from, 64 * j - 64, 0], 30);
    const lastRow = (grid: PatchGrid) => each(grid, grid.verts.xyz, 3).slice(3);

    const end = [ruler(), back(128, 64)];
    expect(stitchAllPatches(end)).toBe(1);
    expect(lastRow(end[1]!)).toEqual([
      [128, 0, 0],
      [96, 0, 0],
      [64, 0, 0]
    ]);
    // One past the first grid's table: the zone's trailer, a positive denormal.
    expect(shape(end[1]!)).toEqual([3, 2, [30, ZONE_ID, 31], [40, 41]]);
    expect(ZONE_ID).toBeGreaterThan(0);
    expect(ZONE_ID).toBeLessThan(2 ** -126);

    const within = [ruler(), back(64, 0)];
    expect(stitchAllPatches(within)).toBe(1);
    // The point at 32, the error the point's at 96.
    expect(lastRow(within[1]!)).toEqual([
      [64, 0, 0],
      [32, 0, 0],
      [0, 0, 0]
    ]);
    expect(shape(within[1]!)).toEqual([3, 2, [30, 13, 31], [40, 41]]);
  });

  it('stitches a grid into itself, where a side has a point between two of another side', () => {
    // Its first column climbs x = 0 through (0, 64); its first row goes straight to the top.
    const folded = gridOf(2, 3, (i, j) => (i === 0 ? [0, 64 * j, 0] : [64 * j, 128, 0]));
    const grids = [folded];
    expect(stitchAllPatches(grids)).toBe(1);
    const grid = grids[0]!;
    // A column, its error the row's its point stood in.
    expect(shape(grid)).toEqual([3, 3, [10, 21, 11], [20, 21, 22]]);
    expect(each(grid, grid.verts.xyz, 3)).toEqual([
      [0, 0, 0],
      [0, 64, 0],
      [0, 128, 0],
      [0, 64, 0],
      [32, 96, 0],
      [64, 128, 0],
      [0, 128, 0],
      [64, 128, 0],
      [128, 128, 0]
    ]);
  });

  it('searches forward along a side before back, where a side runs out and back', () => {
    // Its first row from the origin to (128, 0, 0) by y = 8, and back by y = -8.
    const ring = [
      [0, 0, 0],
      [64, 8, 0],
      [128, 0, 0],
      [64, -8, 0],
      [0, 0, 0]
    ];
    const first = gridOf(5, 2, (i, j) => (j === 0 ? ring[i] : [32 * i, 64, 0]));
    const grids = [first, below()];
    expect(stitchAllPatches(grids)).toBe(1);
    expect(each(grids[1]!, grids[1]!.verts.xyz, 3)[4]).toEqual([64, 8, 0]);
    expect(shape(grids[1]!)).toEqual([3, 2, [30, 11, 31], [40, 41]]);
  });

  it("searches a grid's rows before its columns, and its first of each before its last", () => {
    /** Where the second grid's last row has a point put in, stitched from this one. */
    const taken = (first: PatchGrid) => {
      const grids = [first, below()];
      stitchAllPatches(grids);
      return [each(grids[1]!, grids[1]!.verts.xyz, 3)[4], grids[1]!.widthLodError[1]];
    };
    const [ends, up, down] = [[[0, 0, 0], [128, 0, 0]], [64, 8, 0], [64, -8, 0]];
    // Folded on its diagonal: its first row and first column both run between the ends.
    const folded = gridOf(3, 3, (i, j) =>
      j === 0 ? [ends[0], up, ends[1]][i] : i === 0 ? [ends[0], down, ends[1]][j] : [64 * i, 192, j]
    );
    expect(taken(folded)).toEqual([up, 11]);
    // Its two rows meet at their ends.
    const lens = gridOf(3, 2, (i, j) => [ends[0], j === 0 ? up : down, ends[1]][i]);
    expect(taken(lens)).toEqual([up, 11]);
  });

  it("mends a grid's rows before its columns, and its first of each before its last", () => {
    // Folded: its first row and first column both run from the origin to (128, 0, 0), so it gains
    // a column and a row. Which went in first shows in the middle's colour, halved in integers.
    const folded = gridOf(2, 2, (i, j) => (i + j === 1 ? [128, 0, 0] : [0, 0, 128 * i]));
    [1, 0, 3, 0].forEach((red, k) => (folded.verts.color[k * 4] = red));
    const grids = [bowed(), folded];
    expect(stitchAllPatches(grids)).toBe(2);
    expect([grids[1]!.width, grids[1]!.height, grids[1]!.verts.color[4 * 4]]).toEqual([3, 3, 0]);
    // Both rows the same: the point goes in the first.
    const flat = gridOf(2, 2, (i) => [128 * i, 0, 0]);
    const both = [bowed(), flat];
    stitchAllPatches(both);
    expect(each(both[1]!, both[1]!.verts.xyz, 3).filter((_, k) => k % 3 === 1)).toEqual([
      [64, 8, 0],
      [64, 0, 0]
    ]);
  });

  it('tries again a grid stitched after its turn, until none is', () => {
    // The first gains a column from the second, and only then has a point the third lacks.
    const third = gridOf(2, 2, (i, j) => [128 * i, 64 * j - 128, 0], 50);
    const grids = [below(), bowed(), third];
    expect(stitchAllPatches(grids)).toBe(2);
    expect(shape(grids[2]!)).toEqual([3, 2, [50, 11, 51], [60, 61]]);
  });

  it('passes over a side two of whose points between its ends are within 0.1', () => {
    const stitched = (x: number) => {
      // Its first row's fourth point folded back on its second.
      const xs = [0, 32, 64, x, 128];
      const first = gridOf(5, 2, (i, j) => (j === 0 ? [xs[i], 0, 0] : [32 * i, 64, 0]));
      return stitchAllPatches([first, gridOf(2, 2, (i, j) => [64 * i, 64 * j - 64, 0], 30)]);
    };
    expect(stitched(32.09)).toBe(0);
    expect(stitched(32.11)).toBe(1);
  });

  it('leaves grids of different groups alone', () => {
    const apart = (second: PatchGrid) => stitchAllPatches([bowed(), second]);
    expect(apart(below(1))).toBe(0);
    const wider = below();
    wider.lodRadius = 101;
    expect(apart(wider)).toBe(0);
    expect(apart(below())).toBe(1);
  });

  it('puts no column into a grid 65 wide, nor a row into one 65 high', () => {
    const along = (width: number) => gridOf(width, 2, (i, j) => [128 * i, 64 * j - 64, 0], 30);
    const up = (height: number) => gridOf(2, height, (i, j) => [128 * j, 64 * i - 64, 0], 30);
    const stitched = (second: PatchGrid) => {
      const grids = [bowed(), second];
      return [stitchAllPatches(grids), grids[1]!.width, grids[1]!.height];
    };
    expect(stitched(along(MAX_GRID_SIZE - 1))).toEqual([1, 65, 2]);
    expect(stitched(along(MAX_GRID_SIZE))).toEqual([0, 65, 2]);
    expect(stitched(up(MAX_GRID_SIZE - 1))).toEqual([1, 2, 65]);
    expect(stitched(up(MAX_GRID_SIZE))).toEqual([0, 2, 65]);
    // 65 wide, the crack on its first column.
    const wide = gridOf(MAX_GRID_SIZE, 2, (i, j) => [128 * j, -8 * i, 0], 30);
    expect(stitched(wide)).toEqual([1, 65, 3]);
  });

  it('takes points within 0.1 on every axis for one, their difference in single precision', () => {
    const lifted = (z: number) =>
      stitchAllPatches([bowed(), gridOf(2, 2, (i, j) => [128 * i, 64 * j - 64, z], 30)]);
    expect(lifted(0.09)).toBe(1);
    expect(lifted(0.11)).toBe(0);
    const apart = (x: number) => {
      const first = bowed();
      first.verts.xyz[0] = 0.09999999404;
      const second = below();
      second.verts.xyz[6] = x;
      return stitchAllPatches([first, second]);
    };
    expect(apart(0)).toBe(1);
    // 0.099999994 less -0.000000004 is within 0.1 in doubles, and 0.1000000015 in single.
    expect(apart(-0.000000004)).toBe(0);
  });

  it('finds no crack between two points of a side within 0.01 on every axis', () => {
    const pinched = (z: number) => {
      // Each grid's side runs from the origin to `z` above it, the first's by way of (64, 0, 0).
      const first = gridOf(3, 2, (i, j) =>
        j === 0 ? [i === 1 ? 64 : 0, 0, i === 2 ? z : 0] : [64 * i, 64, 0]
      );
      const second = gridOf(2, 2, (i, j) => (j === 1 ? [0, 0, i * z] : [64 * i, -64, 0]), 30);
      return stitchAllPatches([first, second]);
    };
    expect(pinched(0.009)).toBe(0);
    expect(pinched(0.011)).toBe(1);
  });
});

describe('fixSharedVertexLodError', () => {
  /** Three by two, its rows along y = `y` and `y + 64`, from x = 0 to 128. */
  const strip = (y: number, base: number, group = 0) =>
    gridOf(3, 2, (i, j) => [64 * i, y + 64 * j, 0], base, group);
  const errors = (grids: PatchGrid[]) =>
    grids.map((grid) => [Array.from(grid.widthLodError), Array.from(grid.heightLodError)]);

  it("gives a later grid the earlier's error for each point their sides share between ends", () => {
    const first = strip(0, 10);
    // Its last row on the first's first row; its ends not taken.
    const second = strip(-64, 30);
    // Its last column on it.
    const third = gridOf(2, 3, (i, j) => [64 * j, 64 * i - 64, 0], 50);
    const apart = strip(-64, 70, 1);
    fixSharedVertexLodError([first, second, third, apart]);
    expect(errors([first, second, third, apart])).toEqual([
      [
        [10, 11, 12],
        [20, 21]
      ],
      [
        [30, 11, 32],
        [40, 41]
      ],
      [
        [50, 51],
        [60, 11, 62]
      ],
      [
        [70, 71, 72],
        [80, 81]
      ]
    ]);
  });

  it('gives a point on a row and a column the column\'s error, its sides in Q3\'s order', () => {
    // Folded: the middle of its first row is the middle of its first column.
    const middle = [64, 0, 0];
    const first = gridOf(3, 3, (i, j) =>
      j === 0 ? [64 * i, 0, 0] : i === 0 ? [[0, 0, 0], middle, [0, 128, 0]][j] : [64 * i, 192, j]
    );
    const second = strip(-64, 30);
    fixSharedVertexLodError([first, second]);
    expect(Array.from(second.widthLodError)).toEqual([30, 21, 32]);
  });

  it("gives and takes no error at a side's ends", () => {
    // Its last row from -64 to 64 along the first's first row: its middle on the first's end, and
    // its end on the first's middle.
    const second = gridOf(3, 2, (i, j) => [64 * i - 64, 64 * j - 64, 0], 30);
    fixSharedVertexLodError([strip(0, 10), second]);
    expect(Array.from(second.widthLodError)).toEqual([30, 31, 32]);
  });

  it('passes errors on through a group from its first grid, each grid fixed once', () => {
    const first = strip(-64, 10);
    const second = strip(64, 30);
    // It shares a point with each, where the second shares none with the first.
    const third = strip(0, 50);
    fixSharedVertexLodError([first, second, third]);
    // The third takes the first's, and passes it back to the second.
    expect([first, second, third].map((grid) => Array.from(grid.widthLodError))).toEqual([
      [10, 11, 12],
      [30, 11, 32],
      [50, 11, 52]
    ]);
  });

  it('neither gives nor takes through a side two of whose points between its ends are one', () => {
    /** Five by two, its row `row` along y = 0 through these points, the other 64 away. */
    const five = (xs: number[], row: number, base: number) =>
      gridOf(5, 2, (i, j) => (j === row ? [xs[i], 0, 0] : [32 * i, 64 * (j - row), 0]), base);
    const given = (x: number) => {
      const second = strip(-64, 30);
      fixSharedVertexLodError([five([0, 32, 64, x, 128], 0, 10), second]);
      return Array.from(second.widthLodError);
    };
    expect(given(32.05)).toEqual([30, 31, 32]);
    expect(given(96)).toEqual([30, 12, 32]);
    // A point between the ends on top of an end is no merge.
    expect(given(0.05)).toEqual([30, 12, 32]);
    expect(given(127.95)).toEqual([30, 12, 32]);
    const taken = (x: number) => {
      const second = five([0, 64, 96, x, 128], 1, 30);
      fixSharedVertexLodError([strip(0, 10), second]);
      return Array.from(second.widthLodError);
    };
    expect(taken(64.05)).toEqual([30, 31, 32, 33, 34]);
    expect(taken(32)).toEqual([30, 11, 32, 33, 34]);
  });
});

describe('loadPatchGrids', () => {
  it('stitches the grids of a group, then gives the later the earlier errors', () => {
    const patch = { surfaceType: MST_PATCH, numVerts: 9, patchWidth: 3, patchHeight: 3 };
    const bsp = testBsp({ surfaces: [surface(patch), surface({ ...patch, firstVert: 9 })] });
    bsp.drawVerts.xyz.set(bulge(8).xyz);
    // Flat, below the bulge's first row, its last row running back along it.
    const flat = controlPoints(3, 3, (i, j) => [128 - 64 * i, 64 * j - 128, 0]);
    bsp.drawVerts.xyz.set(flat.xyz, 27);
    const [bulged, stitched] = loadPatchGrids(bsp, 1, 4);
    expect(shape(bulged!)).toEqual([3, 2, [0, 0.25, 0], [0, 0]]);
    expect(each(stitched!, stitched!.verts.xyz, 3).slice(3)).toEqual([
      [128, 0, 0],
      [64, 0, 4],
      [0, 0, 0]
    ]);
    // Stitched from back along the bulge's row, past its table's end; then fixed.
    expect(shape(stitched!)).toEqual([3, 2, [0, 0.25, 0], [0, 0]]);
  });

  it('makes a grid for each patch drawn, in lump order, and none for the rest', () => {
    const patch = { surfaceType: MST_PATCH, numVerts: 9, patchWidth: 3, patchHeight: 3 };
    const bsp = testBsp({
      shaders: ['textures/test/wall', 'textures/test/clip'],
      surfaces: [
        surface(),
        surface(patch),
        surface({ surfaceType: MST_TRIANGLE_SOUP }),
        surface({ ...patch, shaderNum: 1 })
      ]
    });
    bsp.shaders[1].surfaceFlags = SURF_NODRAW;
    const sizes = loadPatchGrids(bsp, 1, 4).map((grid) => grid && [grid.width, grid.height]);
    expect(sizes).toEqual([null, [2, 2], null, null]);
  });
});

describe('gridIndexes', () => {
  const grid = { width: 3, height: 3 };

  it("lists two triangles a quad, in Q3's order and winding, after the grid's base", () => {
    const out = new Uint32Array(26);
    expect(gridIndexes(grid, wholeGrid(grid), 0, 3, 100, out, 1)).toBe(25);
    expect(Array.from(out.subarray(1, 25))).toEqual([
      ...[100, 103, 101, 101, 103, 104],
      ...[101, 104, 102, 102, 104, 105],
      ...[103, 106, 104, 104, 106, 107],
      ...[104, 107, 105, 105, 107, 108]
    ]);
  });

  it('lists the rows asked for, from the first, and only the columns and rows kept', () => {
    const out = new Uint32Array(12);
    expect(gridIndexes(grid, wholeGrid(grid), 1, 2, 0, out, 0)).toBe(12);
    expect(Array.from(out)).toEqual([3, 6, 4, 4, 6, 7, 4, 7, 5, 5, 7, 8]);
    // The corners alone, the tables' later entries left over from before.
    const corners = wholeGrid(grid);
    corners.widthTable.set([0, 2]);
    corners.heightTable.set([0, 2]);
    corners.lodWidth = 2;
    corners.lodHeight = 2;
    expect(gridIndexes(grid, corners, 0, 2, 0, out, 0)).toBe(6);
    expect(Array.from(out.subarray(0, 6))).toEqual([0, 6, 2, 2, 6, 8]);
  });
});

describe('lodErrorForVolume', () => {
  /** A group centred at `origin`, of this radius. */
  const group = (origin: [number, number, number], lodRadius: number) => ({
    lodOrigin: origin,
    lodRadius
  });
  const ahead = { x: 1, y: 0, z: 0 };

  it("is r_lodCurveError over the group's depth along the view, less its radius", () => {
    const centre = group([0, 0, 0], 10);
    expect(lodErrorForVolume(centre, null, { x: -1010, y: 0, z: 0 }, ahead, 250)).toBe(0.25);
    // Behind the eye as in front of it.
    expect(lodErrorForVolume(centre, null, { x: 1010, y: 0, z: 0 }, ahead, 250)).toBe(0.25);
    // Only the depth along the view counts.
    expect(lodErrorForVolume(centre, null, { x: -1010, y: 500, z: -70 }, ahead, 250)).toBe(0.25);
    expect(lodErrorForVolume(centre, null, { x: -260, y: 0, z: 0 }, ahead, 500)).toBe(2);
  });

  it('takes a depth within the radius, or less than 1 beyond it, as 1', () => {
    const centre = group([0, 0, 0], 10);
    expect(lodErrorForVolume(centre, null, { x: -5, y: 0, z: 0 }, ahead, 250)).toBe(250);
    expect(lodErrorForVolume(centre, null, { x: 0, y: 900, z: 0 }, ahead, 250)).toBe(250);
    expect(lodErrorForVolume(centre, null, { x: -10.5, y: 0, z: 0 }, ahead, 250)).toBe(250);
    expect(lodErrorForVolume(centre, null, { x: -12, y: 0, z: 0 }, ahead, 250)).toBe(125);
  });

  it('is 0 for an r_lodCurveError below 0, and at 0', () => {
    const centre = group([0, 0, 0], 10);
    for (const eye of [{ x: -5, y: 0, z: 0 }, { x: -1010, y: 0, z: 0 }]) {
      expect(lodErrorForVolume(centre, null, eye, ahead, -1)).toBe(0);
      expect(lodErrorForVolume(centre, null, eye, ahead, 0)).toBe(0);
    }
  });

  it("takes a brush model's group through its origin and axes", () => {
    // Turned a quarter to the left, and moved 100 along x: the group's local x is the world's y.
    const turned: Orientation = {
      origin: [100, 0, 0],
      axis: [
        [0, 1, 0],
        [-1, 0, 0],
        [0, 0, 1]
      ]
    };
    const centre = group([10, 20, 30], 0);
    const along = (x: number, y: number, z: number) => ({ x, y, z });
    // The centre stands at (80, 10, 30).
    expect(lodErrorForVolume(centre, turned, along(-920, 0, 0), ahead, 250)).toBe(0.25);
    expect(lodErrorForVolume(centre, turned, along(0, -990, 0), along(0, 1, 0), 250)).toBe(0.25);
    expect(lodErrorForVolume(centre, turned, along(0, 0, -970), along(0, 0, 1), 250)).toBe(0.25);
    expect(lodErrorForVolume(centre, null, along(-920, 0, 0), ahead, 250)).not.toBe(0.25);
  });

  it('works in floats, as Q3 does', () => {
    const centre = group([100, 200, 30], 40);
    const eye = { x: -900.3, y: 213.7, z: 61.1 };
    const lodError = lodErrorForVolume(centre, null, eye, { x: 0.6, y: 0.8, z: 0 }, 250);
    // In doubles it comes to 0.45519099...
    expect(lodError).toBe(f(0.4551910161972046));
    expect(lodErrorForVolume(centre, null, eye, ahead, 250)).toBe(f(250 / f(f(1000.3) - 40)));
    // The depth summed in floats: in doubles it comes to 0.54123115...
    const across = lodErrorForVolume(
      group([-127, -122, 492], 6),
      null,
      { x: 1861.9, y: 1362.6, z: 119.2 },
      { x: -0.746, y: 0.632, z: -0.208 },
      250
    );
    expect(across).toBe(f(0.5412312746047974));
  });
});

describe('lodTables', () => {
  /** A grid with these error tables. */
  const tabled = (widthLodError: number[], heightLodError: number[]) => ({
    width: widthLodError.length,
    height: heightLodError.length,
    widthLodError: Float32Array.from(widthLodError),
    heightLodError: Float32Array.from(heightLodError)
  });
  const kept = (tables: GridTables) => [
    Array.from(tables.widthTable.subarray(0, tables.lodWidth)),
    Array.from(tables.heightTable.subarray(0, tables.lodHeight))
  ];

  it('keeps the columns and rows whose error is within the allowance, and the ends', () => {
    const grid = tabled([0, 5, 1, 3, 0], [0, 2, 0.5, 0]);
    expect(kept(lodTables(grid, 3))).toEqual([
      [0, 2, 3, 4],
      [0, 1, 2, 3]
    ]);
    expect(kept(lodTables(grid, 1))).toEqual([
      [0, 2, 4],
      [0, 2, 3]
    ]);
    expect(kept(lodTables(grid, 0))).toEqual([
      [0, 4],
      [0, 3]
    ]);
  });

  it('keeps the ends whatever their errors', () => {
    expect(kept(lodTables(tabled([7, 1, 7], [9, 9]), 0))).toEqual([
      [0, 2],
      [0, 1]
    ]);
  });

  it('fills the tables it is given, as wholeGrid does', () => {
    const grid = tabled([0, 5, 1, 3, 0], [0, 2, 0.5, 0]);
    const tables = gridTables();
    expect(lodTables(grid, 1, tables)).toBe(tables);
    expect(kept(tables)).toEqual([
      [0, 2, 4],
      [0, 2, 3]
    ]);
    expect(wholeGrid(grid, tables)).toBe(tables);
    expect(kept(tables)).toEqual([
      [0, 1, 2, 3, 4],
      [0, 1, 2, 3]
    ]);
    expect([tables.widthTable.length, tables.heightTable.length]).toEqual([
      MAX_GRID_SIZE,
      MAX_GRID_SIZE
    ]);
  });
});
