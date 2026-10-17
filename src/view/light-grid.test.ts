import { describe, expect, it } from 'vitest';

import { keptEntityLight } from './entity-light';
import {
  DEFAULT_GRID_SIZE,
  loadLightGrid,
  normalize,
  sampleLightGrid,
  worldGridSize,
  type LightGrid
} from './light-grid';

/** A worldspawn's entity text with these key-value pairs, and a second entity after it. */
function worldspawn(pairs: string): string {
  const later = '{\n"classname" "info_null"\n"gridsize" "8 8 8"\n}\n';
  return `{\n"classname" "worldspawn"\n${pairs}\n}\n${later}\0`;
}

/** The size read, and the warnings given. */
function sizeOf(text: string): { size: number[]; warnings: string[] } {
  const warnings: string[] = [];
  return { size: worldGridSize(text, (line) => warnings.push(line)), warnings };
}

describe("worldGridSize (R_LoadEntities' read of the worldspawn)", () => {
  it('is 64 64 128 where the worldspawn names none, and never reads a later entity', () => {
    expect(sizeOf(worldspawn('"message" "hello"')).size).toEqual([...DEFAULT_GRID_SIZE]);
    expect(sizeOf('').size).toEqual([64, 64, 128]);
  });

  it("reads gridsize in any case, as sscanf's numbers over the defaults", () => {
    expect(sizeOf(worldspawn('"gridsize" "32 32 64"')).size).toEqual([32, 32, 64]);
    expect(sizeOf(worldspawn('"GridSize" "100 50.5 200"')).size).toEqual([100, 50.5, 200]);
    // sscanf stops at the first number it cannot read, and leaves the rest.
    expect(sizeOf(worldspawn('"gridsize" "96 x 256"')).size).toEqual([96, 64, 128]);
    // In floats, as `lightGridSize` holds them.
    expect(sizeOf(worldspawn('"gridsize" "38.336 38.336 38.336"')).size).toEqual(
      Array(3).fill(Math.fround(38.336))
    );
  });

  it('stops at a remapshader with no semicolon, warned of, and loses a gridsize after it', () => {
    const { size, warnings } = sizeOf(worldspawn('"remapshader1" "a/b"\n"gridsize" "32 32 64"'));
    expect(size).toEqual([64, 64, 128]);
    expect(warnings).toEqual(["WARNING: no semi colon in shaderremap 'a/b'\n"]);
    const vertex = sizeOf(worldspawn('"vertexremapshader" "c"\n"gridsize" "32 32 64"'));
    expect(vertex.warnings).toEqual(["WARNING: no semi colon in vertexshaderremap 'c'\n"]);
    // With one, it reads on; the swap itself is not made.
    const swapped = worldspawn('"remapshader" "a;b"\n"gridsize" "32 32 64"');
    expect(sizeOf(swapped).size).toEqual([32, 32, 64]);
    // The prefixes are matched in their own case, as `Q_strncmp` matches them.
    const cased = worldspawn('"RemapShader" "a/b"\n"gridsize" "32 32 64"');
    expect(sizeOf(cased).size).toEqual([32, 32, 64]);
  });

  it('stops at a value starting with a closing brace', () => {
    expect(sizeOf('{ "a" "}b" "gridsize" "32 32 64" }').size).toEqual([64, 64, 128]);
  });
});

/** A grid lump of `points` points, each its index's bytes and then the given six. */
function lump(points: number, bytes: readonly number[]): Uint8Array {
  const out = new Uint8Array(points * 8);
  for (let i = 0; i < points; i++) out.set(bytes, i * 8);
  return out;
}

describe('loadLightGrid (R_LoadLightGrid)', () => {
  const warned: string[] = [];
  const warn = (line: string) => warned.push(line);

  it("lays the grid over the world model's bounds, on its size's multiples inside them", () => {
    // x: ceil(-100 / 64) = -1 and floor(300 / 64) = 4, so -64 to 256, six points. y: -2 to 0,
    // three. z: 0 to floor(500 / 128) = 3, four.
    const points = lump(6 * 3 * 4, [1, 2, 3, 4, 5, 6, 7, 8]);
    const grid = loadLightGrid(points, [-100, -128, 0], [300, 0, 500], [64, 64, 128], 0, warn)!;
    expect(grid.origin).toEqual([-64, -128, 0]);
    expect(grid.bounds).toEqual([6, 3, 4]);
    expect(grid.inverseSize).toEqual([1 / 64, 1 / 64, 1 / 128]);
    expect([...grid.data.subarray(0, 8)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("is Quake 3's light grid mismatch, and no grid, for a lump of any other length", () => {
    warned.length = 0;
    // Two points a side.
    const load = (points: Uint8Array) =>
      loadLightGrid(points, [0, 0, 0], [64, 64, 128], [64, 64, 128], 0, warn);
    expect(load(lump(7, [1, 1, 1, 1, 1, 1, 0, 0]))).toBeNull();
    expect(load(lump(9, [1, 1, 1, 1, 1, 1, 0, 0]))).toBeNull();
    expect(load(new Uint8Array(0))).toBeNull();
    expect(warned).toEqual(Array(3).fill('WARNING: light grid mismatch\n'));
    expect(load(lump(8, [1, 1, 1, 1, 1, 1, 0, 0]))).not.toBeNull();
  });

  it("counts its points in floats, as mxl_school's gridsize of 38.336 shows", () => {
    // 33 points' span over the size is 33 in floats, a hair short of it in doubles, so 1,266
    // units hold 34 points where doubles would count 33.
    const size = Array(3).fill(Math.fround(38.336));
    const points = lump(34 * 2 * 2, [1, 1, 1, 1, 1, 1, 0, 0]);
    const grid = loadLightGrid(points, [0, 0, 0], [1266, 64, 64], size, 0, warn);
    expect(grid?.bounds).toEqual([34, 2, 2]);
  });

  it('shifts each colour as the lightmaps are, keeping its hue, and leaves the direction', () => {
    const raw = lump(8, [100, 50, 10, 200, 100, 50, 77, 99]);
    const grid = loadLightGrid(raw, [0, 0, 0], [64, 64, 128], [64, 64, 128], 1, warn)!;
    // 200 100 20 as it is; 400 200 100 scaled by 255/400, in integers.
    expect([...grid.data.subarray(0, 8)]).toEqual([200, 100, 20, 255, 127, 63, 77, 99]);
    // The lump is left as it was.
    expect([...raw.subarray(0, 8)]).toEqual([100, 50, 10, 200, 100, 50, 77, 99]);
  });
});

/** A grid 64 units apart and 128 up from the origin, of `bounds` points, each as `point` has it. */
function grid(
  bounds: [number, number, number],
  point: (x: number, y: number, z: number) => number[]
): LightGrid {
  const data = new Uint8Array(bounds[0] * bounds[1] * bounds[2] * 8);
  for (let z = 0; z < bounds[2]; z++) {
    for (let y = 0; y < bounds[1]; y++) {
      for (let x = 0; x < bounds[0]; x++) {
        data.set(point(x, y, z), ((z * bounds[1] + y) * bounds[0] + x) * 8);
      }
    }
  }
  return { inverseSize: [1 / 64, 1 / 64, 1 / 128], origin: [0, 0, 0], bounds, data };
}

/** The light at a point, at the scales of 1 so the grid's own sums show. */
function sample(at: LightGrid, x: number, y: number, z: number) {
  const out = keptEntityLight();
  sampleLightGrid(at, { x, y, z }, 1, 1, out);
  return out;
}

describe('sampleLightGrid (R_SetupEntityLightingGrid)', () => {
  // Along x, an ambient of 100 then 200; the directed light 50 everywhere, lit from straight up.
  const ramp = grid([2, 2, 2], (x) => [...Array(3).fill(100 * (x + 1)), 50, 50, 50, 0, 0]);

  it("takes a point's own light on it, and blends between points by how near each is", () => {
    expect(sample(ramp, 0, 0, 0).ambient).toEqual([100, 100, 100]);
    expect(sample(ramp, 64, 0, 0).ambient).toEqual([200, 200, 200]);
    expect(sample(ramp, 16, 30, 70).ambient[0]).toBeCloseTo(125, 4);
    expect(sample(ramp, 16, 30, 70).directed[0]).toBeCloseTo(50, 4);
  });

  it('scales the ambient and directed light by the scene\'s scales', () => {
    const out = keptEntityLight();
    sampleLightGrid(ramp, { x: 0, y: 0, z: 0 }, 0.6, 2, out);
    // 0.6 is a float's, so the 60 is a hair over.
    expect(out.ambient).toEqual(Array(3).fill(Math.fround(100 * Math.fround(0.6))));
    expect(out.directed).toEqual([100, 100, 100]);
  });

  it('takes its share of the first points by how far below the grid it is', () => {
    // A quarter of a cell below, as if three quarters into the first: a quarter of the first
    // point's light, and three of the second's.
    expect(sample(ramp, -16, 0, 0).ambient[0]).toBeCloseTo(175, 4);
  });

  it("takes the edge's points alone past the grid's top, as ioquake3 skips those past it", () => {
    expect(sample(ramp, 64 + 32, 0, 0).ambient[0]).toBeCloseTo(200, 4);
    expect(sample(ramp, 1000, 1000, 1000).ambient[0]).toBeCloseTo(200, 4);
  });

  it('skips a point with no ambient light, whatever its directed, and weighs the rest up', () => {
    // The x = 1 points are in a wall: only the x = 0 points are taken, at 0.75, made whole.
    const wall = grid([2, 2, 2], (x) =>
      x === 0 ? [100, 100, 100, 50, 50, 50, 0, 0] : [0, 0, 0, 90, 90, 90, 0, 0]
    );
    expect(sample(wall, 16, 0, 0).ambient[0]).toBeCloseTo(100, 4);
    expect(sample(wall, 16, 0, 0).directed[0]).toBeCloseTo(50, 4);
    // Short of 0.99 alone: a total of 0.995 is left as it is.
    expect(sample(wall, 0.32, 0, 0).ambient[0]).toBeCloseTo(99.5, 4);
  });

  it('is nothing, and points nowhere, where every point about it is in a wall', () => {
    const dark = grid([2, 2, 2], () => [0, 0, 0, 90, 90, 90, 0, 0]);
    const light = sample(dark, 10, 10, 10);
    expect([...light.ambient, ...light.directed, ...light.direction]).toEqual(Array(9).fill(0));
  });

  it('points toward the light its points give, by their longitude and latitude bytes', () => {
    // Longitude 0 is straight up; 64, a quarter turn, is level, and latitude turns it about z.
    const up = grid([2, 2, 2], () => [10, 10, 10, 50, 50, 50, 0, 0]);
    expect(sample(up, 10, 10, 10).direction).toEqual([0, 0, 1].map((v) => expect.closeTo(v, 6)));
    const east = grid([2, 2, 2], () => [10, 10, 10, 50, 50, 50, 64, 0]);
    const [x, y, z] = sample(east, 10, 10, 10).direction;
    expect([x, y]).toEqual([1, 0].map((v) => expect.closeTo(v, 4)));
    expect(Math.abs(z)).toBeLessThan(0.01);
    const north = grid([2, 2, 2], () => [10, 10, 10, 50, 50, 50, 64, 64]);
    expect(sample(north, 10, 10, 10).direction[1]).toBeCloseTo(1, 4);
  });

  it('weighs each point\'s direction by its share alone, not by how bright it is', () => {
    const mixed = grid([2, 2, 2], (x) =>
      x === 0 ? [10, 10, 10, 250, 250, 250, 0, 0] : [10, 10, 10, 1, 1, 1, 64, 0]
    );
    // Halfway: up and east alike, however unlike their lights.
    const [x, , z] = sample(mixed, 32, 0, 0).direction;
    expect(x).toBeCloseTo(z, 2);
  });
});

describe('normalize (VectorNormalize2)', () => {
  it('makes a triple unit in floats, through the inverse of its length, and gives it', () => {
    const out: [number, number, number] = [0, 0, 0];
    expect(normalize(3, 0, 4, out)).toBe(5);
    expect(out).toEqual([0.6, 0, 0.8].map(Math.fround));
  });

  it('leaves nothing as nothing', () => {
    const out: [number, number, number] = [1, 2, 3];
    expect(normalize(0, 0, 0, out)).toBe(0);
    expect(out).toEqual([0, 0, 0]);
  });

  it("keeps the signs of nothing's zeros as VectorNormalize does, and VectorNormalize2 not", () => {
    // A unit direction scaled by no light keeps its signs, and a dot product with it shows them.
    const out: [number, number, number] = [1, 2, 3];
    normalize(-0, 0, -0, out);
    expect(out.map((v) => Object.is(v, -0))).toEqual([true, false, true]);
    normalize(-0, 0, -0, out, true);
    expect(out.map((v) => Object.is(v, -0))).toEqual([false, false, false]);
  });
});
