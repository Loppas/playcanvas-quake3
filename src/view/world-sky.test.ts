import { describe, expect, it } from 'vitest';

import type { RunIndexes } from './world-indexes';
import {
  SKY_POINTS,
  SKY_VERTICES,
  SkyIndexes,
  boxTexCoords,
  cloudTexCoords,
  skyBlocks,
  skyPoints,
  skyVec
} from './world-sky';

const f = Math.fround;

/** A point's coordinates in a cloud table: side, then t, then s, each from 0. */
function at(table: Float32Array, side: number, t: number, s: number): [number, number] {
  const i = ((side * SKY_POINTS + t) * SKY_POINTS + s) * 2;
  return [table[i], table[i + 1]];
}

/** A point's number among the sky's: side, then t, then s, each from 0. */
const point = (side: number, t: number, s: number) => (side * SKY_POINTS + t) * SKY_POINTS + s;

/** A vector with its negative zeros made positive, which `toEqual` would tell apart. */
const signless = (v: Iterable<number>) => Array.from(v, (x) => x + 0);

describe('skyVec', () => {
  it("puts each side's middle along an axis, the box's half-size the far plane over 1.75", () => {
    const middles = [0, 1, 2, 3, 4, 5].map((side) => signless(skyVec(0, 0, side, 1750)));
    expect(middles).toEqual([
      [1000, 0, 0],
      [-1000, 0, 0],
      [0, 1000, 0],
      [0, -1000, 0],
      [0, 0, 1000],
      [0, 0, -1000]
    ]);
  });

  it("runs each side's s and t as st_to_vec has them", () => {
    const corners = [0, 1, 2, 3, 4, 5].map((side) => signless(skyVec(1, 0.5, side, 1750)));
    expect(corners).toEqual([
      [1000, -1000, 500],
      [-1000, 1000, 500],
      [1000, 1000, 500],
      [-1000, -1000, 500],
      [-500, -1000, 1000],
      [500, -1000, -1000]
    ]);
    // Rounded to a float, as Q3's `boxSize` is.
    expect(skyVec(0, 0, 4, 1024)[2]).toBe(f(1024 / 1.75));
  });
});

describe('cloudTexCoords', () => {
  it('is a right angle off both axes straight up, at any height', () => {
    for (const height of [512, 384]) {
      expect(at(cloudTexCoords(height), 4, 4, 4)).toEqual([f(Math.PI / 2), f(Math.PI / 2)]);
    }
  });

  // Each as Q3's arithmetic gives it, in floats. A reckoning in doubles misses the first by a
  // little, and the rest move if the ray's length, its inverse or the root is taken otherwise.
  it("matches Q3's float arithmetic at 512", () => {
    const table = cloudTexCoords(512);
    expect(at(table, 0, 0, 4)).toEqual([f(0.105725184), f(1.57079637)]);
    expect(at(table, 0, 3, 4)).toEqual([f(0.794911981), f(1.57079637)]);
    expect(at(table, 0, 2, 4)).toEqual([f(0.455436319), f(1.57079637)]);
    expect(at(table, 0, 1, 1)).toEqual([f(0.710884154), f(0.96631062)]);
  });

  it("matches Q3's float arithmetic at 384", () => {
    const table = cloudTexCoords(384);
    expect(at(table, 0, 0, 4)).toEqual([f(0.0824134573), f(1.57079637)]);
    expect(at(table, 0, 3, 4)).toEqual([f(0.845801473), f(1.57079637)]);
    expect(at(table, 0, 0, 0)).toEqual([f(0.810805142), f(0.810805142)]);
    expect(at(table, 0, 0, 2)).toEqual([f(0.464049041), f(1.10724914)]);
  });

  it('holds all six sides, the bottom among them', () => {
    const table = cloudTexCoords(512);
    expect(table).toHaveLength(6 * 9 * 9 * 2);
    expect(table.every(Number.isFinite)).toBe(true);
    // Straight down meets the sphere at its bottom, under the eye.
    expect(at(table, 5, 4, 4)).toEqual([f(Math.PI / 2), f(Math.PI / 2)]);
  });
});

describe('skyPoints', () => {
  it("puts each side's corners where MakeSkyVec does, the sides meeting at their edges", () => {
    const points = skyPoints(1750);
    expect(points).toHaveLength(SKY_VERTICES * 3);
    const corner = (side: number, t: number, s: number) =>
      signless(points.subarray(point(side, t, s) * 3, point(side, t, s) * 3 + 3));
    expect(corner(4, 4, 4)).toEqual([0, 0, 1000]);
    expect(corner(0, 0, 0)).toEqual([1000, 1000, -1000]);
    expect(corner(0, 2, 8)).toEqual([1000, -1000, -500]);
    expect(corner(5, 8, 1)).toEqual([1000, 750, -1000]);
    // The right side's last column is the front's first.
    for (let t = 0; t < SKY_POINTS; t++) expect(corner(0, t, 8)).toEqual(corner(3, t, 0));
  });
});

describe('boxTexCoords', () => {
  it('runs from 0 to 1 across each side, t turned over', () => {
    const coords = boxTexCoords();
    expect(coords).toHaveLength(SKY_VERTICES * 2);
    const st = (side: number, t: number, s: number) =>
      Array.from(coords.subarray(point(side, t, s) * 2, point(side, t, s) * 2 + 2));
    expect(st(0, 0, 0)).toEqual([0, 1]);
    expect(st(0, 8, 8)).toEqual([1, 0]);
    expect(st(5, 2, 6)).toEqual([0.75, 0.75]);
  });
});

type Point = [number, number, number];

/** Each side's blocks, as `[s0, t0, s1, t1]`, or `null` for a side with none. */
function sidesOf(blocks: Int8Array): ([number, number, number, number] | null)[] {
  return [0, 1, 2, 3, 4, 5].map((side) => {
    const [s0, t0, s1, t1] = blocks.subarray(side * 4, side * 4 + 4);
    return s0 === 0 && t0 === 0 && s1 === 0 && t1 === 0 ? null : [s0, t0, s1, t1];
  });
}

/** The blocks these triangles cover from `eye`. */
function blocksOf(triangles: Point[][], eye: Point = [0, 0, 0]) {
  const positions = Float32Array.from(triangles.flat(2));
  const indexes = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  const blocks = new Int8Array(24).fill(7);
  skyBlocks(indexes, 0, indexes.length, positions, Float32Array.from(eye), blocks);
  return sidesOf(blocks);
}

describe('skyBlocks', () => {
  /** Overhead, its s and t from 0.01 to 0.2 of the top. */
  const overhead: Point[] = [
    [-1, -1, 100],
    [-20, -1, 100],
    [-1, -20, 100]
  ];

  it('finds the blocks a triangle overhead covers, from wherever the eye is', () => {
    expect(blocksOf([overhead])).toEqual([null, null, null, null, [0, 0, 1, 1], null]);
    const eye: Point = [10, 20, -100];
    const moved = overhead.map((p) => p.map((x, k) => x + eye[k]) as Point);
    expect(blocksOf([moved], eye)).toEqual(blocksOf([overhead]));
  });

  it('cuts a triangle across two sides between them, each piece to its own', () => {
    const across: Point[] = [
      [100, 20, 0],
      [20, 100, 0],
      [100, 100, 40]
    ];
    // Whole, its points' sum would put it on the top.
    expect(blocksOf([across])).toEqual([[-4, 0, 0, 2], null, [0, 0, 4, 2], null, null, null]);
  });

  it('cuts a triangle across each plane between two sides, each piece to its own', () => {
    // A side facing each way, and its neighbour across each plane, in the planes' order.
    const pairs: [Point, Point, number, number][] = [
      [[1, 0, 0], [0, -1, 0], 0, 3],
      [[1, 0, 0], [0, 1, 0], 0, 2],
      [[0, 0, 1], [0, 1, 0], 2, 4],
      [[0, 0, 1], [0, -1, 0], 3, 4],
      [[0, 0, 1], [-1, 0, 0], 1, 4],
      [[0, 0, 1], [1, 0, 0], 0, 4]
    ];
    for (const [a, b, first, second] of pairs) {
      // A point deep in each side, and one over the edge between them, off along the third axis.
      const third = a.map((x, k) => (x || b[k] ? 0 : 1));
      const along = (inA: number, inB: number, off: number) =>
        a.map((x, k) => inA * x + inB * b[k] + off * third[k]) as Point;
      const sides = blocksOf([[along(100, 20, 0), along(20, 100, 0), along(100, 100, 40)]]);
      expect(sides.flatMap((rect, side) => (rect ? [side] : []))).toEqual([first, second]);
    }
  });

  it('takes every side, the bottom and those behind the view as much as any', () => {
    const behind: Point[] = [
      [-100, -10, -10],
      [-100, 10, -10],
      [-100, 0, 10]
    ];
    const below: Point[] = [
      [-10, -10, -100],
      [10, -10, -100],
      [0, 10, -100]
    ];
    expect(blocksOf([behind, below])).toEqual([
      null,
      [-1, -1, 1, 1],
      null,
      null,
      null,
      [-1, -1, 1, 1]
    ]);
  });

  it('takes a point within 0.1 of a plane as on it, and clamps the reach to the side', () => {
    const [onEdge, past]: Point[] = [
      [50, 50.05, 0],
      [50, 50.2, 0]
    ];
    const triangle = (third: Point): Point[] => [[100, 0, 0], [100, 0, 50], third];
    // The point's s, past −1, is clamped to the side's edge.
    expect(blocksOf([triangle(onEdge)])).toEqual([[-4, 0, 0, 2], null, null, null, null, null]);
    // Further past it, the plane cuts a sliver off for the side beyond.
    expect(blocksOf([triangle(past)])).toEqual([
      [-4, 0, 0, 2],
      null,
      [3, 0, 4, 1],
      null,
      null,
      null
    ]);
  });

  it('projects no point less than 0.001 in front of the eye', () => {
    // Projected, the first point would reach s = -2.
    const near: Point[] = [
      [0.0005, 0.001, 0],
      [100, -10, 0],
      [100, 10, 50]
    ];
    expect(blocksOf([near])).toEqual([[-1, 0, 1, 2], null, null, null, null, null]);
  });

  it('draws nothing of a side whose reach lies wholly past its edge', () => {
    // Within 0.1 of the plane between the right and the back, every projected point is just past
    // the right side's edge; the third point, too near to project, puts the piece on it.
    const sliver: Point[] = [
      [1000, 1000.0005, 0],
      [1000, 1000.0005, 10],
      [0.0009, -0.0009, 0]
    ];
    expect(blocksOf([sliver])).toEqual([null, null, null, null, null, null]);
  });

  it('starts each batch afresh, and finds nothing without triangles', () => {
    blocksOf([overhead]);
    expect(blocksOf([])).toEqual([null, null, null, null, null, null]);
  });
});

/** A sky run of these batches, each `[base, count]` among the world's indexes. */
const skyRun = (...batches: [number, number][]): Pick<RunIndexes, 'batches'> => ({
  batches: batches.map(([base, count]) => ({
    base,
    count,
    vertexes: 0,
    first: 0,
    lightFirst: 0,
    lightCount: 0
  }))
});

/** GL's triangles of a strip: each three points in turn, every second with its first two turned. */
const stripTriangles = (strip: number[]) =>
  strip
    .slice(2)
    .flatMap((_, i) =>
      i % 2 ? [strip[i + 1], strip[i], strip[i + 2]] : [strip[i], strip[i + 1], strip[i + 2]]
    );

/** A side's row `t` as `DrawSkySide` sends it: each column's point, then the one below it. */
const row = (side: number, t: number, s0: number, s1: number) =>
  Array.from({ length: s1 - s0 + 1 }, (_, i) => [
    point(side, t, s0 + i),
    point(side, t + 1, s0 + i)
  ]).flat();

/** A block's quad as `FillCloudySkySide` adds it. */
const quad = (side: number, t: number, s: number) => [
  point(side, t, s),
  point(side, t + 1, s),
  point(side, t, s + 1),
  point(side, t + 1, s),
  point(side, t + 1, s + 1),
  point(side, t, s + 1)
];

describe('SkyIndexes', () => {
  /** Overhead, its s and t from 0.01 to 0.45 of the top: its first two blocks each way. */
  const overhead = [-1, -1, 100, -45, -1, 100, -1, -45, 100];
  /** Before the right side, its s and t from 0.1 to 0.2. */
  const ahead = [100, -10, 10, 100, -20, 10, 100, -10, 20];

  /** A sky of one run of one batch, of the first triangle; and what each view writes again. */
  function oneBatch() {
    const triangles = Uint32Array.from([0, 1, 2, 3, 4, 5]);
    const run = skyRun([0, 3]);
    const sky = new SkyIndexes(triangles, Float32Array.from([...overhead, ...ahead]), [run]);
    const view = (x: number, y = 0, z = 0) => {
      const told: number[][] = [];
      sky.view({ x, y, z }, (r, k) => told.push([r, k]));
      return told;
    };
    return { sky, run, view };
  }

  /** A range's indexes. */
  const indexesOf = (sky: SkyIndexes, { base, count }: { base: number; count: number }) =>
    Array.from(sky.indexes.subarray(base, base + count));

  it('writes the box in strips and the clouds in quads, over the blocks covered', () => {
    const { sky, view } = oneBatch();
    expect(view(0)).toEqual([[0, 0]]);
    const [batch] = sky.runs[0];
    expect(sidesOf(batch.blocks)).toEqual([null, null, null, null, [0, 0, 2, 2], null]);
    expect(batch.box.map(({ count }) => count)).toEqual([0, 0, 0, 0, 24, 0]);
    expect(indexesOf(sky, batch.box[4])).toEqual([
      ...stripTriangles(row(4, 4, 4, 6)),
      ...stripTriangles(row(4, 5, 4, 6))
    ]);
    expect(indexesOf(sky, batch.clouds)).toEqual([
      ...quad(4, 4, 4),
      ...quad(4, 4, 5),
      ...quad(4, 5, 4),
      ...quad(4, 5, 5)
    ]);
  });

  it('writes again only where the blocks change', () => {
    const { sky, view } = oneBatch();
    view(0);
    // The eye held; then moved, the same blocks covered.
    expect(view(0)).toEqual([]);
    expect(view(0, 0, 1)).toEqual([]);
    // To the side, the triangle reaches back over the top's middle.
    expect(view(-20)).toEqual([[0, 0]]);
    expect(sidesOf(sky.runs[0][0].blocks)[4]).toEqual([0, -1, 2, 1]);
  });

  it('writes again where the bottom alone changes', () => {
    // Under the eye, 100 down.
    const below = [-1, -1, -100, 45, -1, -100, -1, 45, -100];
    const run = skyRun([0, 3]);
    const sky = new SkyIndexes(Uint32Array.from([0, 1, 2]), Float32Array.from(below), [run]);
    const told: number[][] = [];
    const bottom = (x: number, y: number) => {
      sky.view({ x, y, z: 0 }, (r, k) => told.push([r, k]));
      return sidesOf(sky.runs[0][0].blocks);
    };
    expect(bottom(0, 0)).toEqual([null, null, null, null, null, [-2, -1, 1, 2]]);
    expect(bottom(20, 20)).toEqual([null, null, null, null, null, [-1, -1, 1, 1]]);
    expect(told).toEqual([
      [0, 0],
      [0, 0]
    ]);
  });

  it('takes the eye in floats, so one moved by less than a float holds', () => {
    const { run, view } = oneBatch();
    view(0.1);
    // Its batch now holds the second triangle, unseen until the blocks are found again.
    run.batches[0].base = 3;
    expect(view(0.1)).toEqual([]);
    expect(view(0.1 + 1e-12)).toEqual([]);
    expect(view(0.2)).toEqual([[0, 0]]);
  });

  it('finds a run cut again its blocks again, though the eye holds', () => {
    const { sky, run, view } = oneBatch();
    view(0);
    // Its batch now holds the second triangle, as a cut would leave it.
    run.batches[0].base = 3;
    expect(view(0)).toEqual([]);
    sky.cut(0);
    expect(view(0)).toEqual([[0, 0]]);
    expect(sidesOf(sky.runs[0][0].blocks)).toEqual([[0, 0, 1, 1], null, null, null, null, null]);
    expect(view(0)).toEqual([]);
  });

  it('draws the whole box, and the clouds over all but its bottom, until the next view', () => {
    const { sky, view } = oneBatch();
    const told: number[][] = [];
    sky.whole((r, k) => told.push([r, k]));
    expect(told).toEqual([[0, 0]]);
    const [batch] = sky.runs[0];
    expect(batch.box.map(({ count }) => count)).toEqual([384, 384, 384, 384, 384, 384]);
    expect(batch.clouds.count).toBe(5 * 384);
    expect(indexesOf(sky, batch.clouds).slice(-6)).toEqual(quad(4, 7, 7));
    // Whole already, nothing is written.
    sky.whole(() => told.push([-1]));
    expect(told).toHaveLength(1);
    // The next view finds the blocks from the same eye again.
    view(0);
    expect(view(0)).toEqual([]);
    sky.whole(() => {});
    expect(view(0)).toEqual([[0, 0]]);
  });

  it("puts each batch's room in turn, and finds no blocks for one with no triangles", () => {
    const triangles = Uint32Array.from([0, 1, 2]);
    const runs = [skyRun([0, 3], [3, 0]), skyRun([0, 3])];
    const sky = new SkyIndexes(triangles, Float32Array.from(overhead), runs);
    const told: number[][] = [];
    sky.view({ x: 0, y: 0, z: 0 }, (r, k) => told.push([r, k]));
    expect(told).toEqual([
      [0, 0],
      [1, 0]
    ]);
    const bases = sky.runs
      .flat()
      .map(({ box, clouds }) => [box.map(({ base }) => base), clouds.base]);
    expect(bases).toEqual([
      [[0, 384, 768, 1152, 1536, 1920], 2304],
      [[4224, 4608, 4992, 5376, 5760, 6144], 6528],
      [[8448, 8832, 9216, 9600, 9984, 10368], 10752]
    ]);
    expect(sky.indexes).toHaveLength(3 * 11 * 384);
    expect(sidesOf(sky.runs[0][1].blocks)).toEqual([null, null, null, null, null, null]);
  });
});
