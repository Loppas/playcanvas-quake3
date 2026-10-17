import { describe, expect, it } from 'vitest';

import { Digest, digestPatch } from './collision-test-fixtures';
import { generatePatchCollide } from './cm-patch';

/**
 * Hand-made patches (scratchpad `m0/gen-patches.py`), each control point's `x, y, z` row after
 * row. They reach what the retail maps' patches do not: a grid that wraps across and one that
 * wraps down, one that wraps within the epsilon, a degenerate column and a nearly degenerate one,
 * degenerate triangles, cells whose both triangles are degenerate, which Quake 3 warns of, and a
 * sliver standing exactly upright on a flat cell. The last five are random patches of the twin's
 * (`search2`, its 13th, 59th, 445th, 4489th and 4789th), each the first to reach a branch: a
 * corner within the epsilon of a border, a flat border, a bisecting one, a facet its borders do
 * not bound, and an edge too short to bevel.
 */
const PATCHES: Record<string, [number, number, number[]]> = {
  flat: [3, 3, [
     0, 0, 0, 32, 0, 0, 64, 0, 0, 0, 32, 0, 32, 32, 0, 64, 32, 0, 0, 64, 0, 32, 64, 0, 64, 64, 0
  ]],
  arch: [3, 3, [
     0, 0, 0, 64, 0, 128, 128, 0, 0, 0, 64, 0, 64, 64, 128, 128, 64, 0, 0, 128, 0, 64, 128, 128,
     128, 128, 0
  ]],
  bowl: [5, 5, [
     0, 0, 64, 32, 0, 40, 64, 0, 32, 96, 0, 40, 128, 0, 64, 0, 32, 40, 32, 32, 16, 64, 32, 8, 96,
     32, 16, 128, 32, 40, 0, 64, 32, 32, 64, 8, 64, 64, 0, 96, 64, 8, 128, 64, 32, 0, 96, 40, 32,
     96, 16, 64, 96, 8, 96, 96, 16, 128, 96, 40, 0, 128, 64, 32, 128, 40, 64, 128, 32, 96, 128, 40,
     128, 128, 64
  ]],
  ringAcross: [9, 3, [
     64, 0, 0, 64, 64, 0, 0, 64, 0, -64, 64, 0, -64, 0, 0, -64, -64, 0, 0, -64, 0, 64, -64, 0, 64,
     0, 0, 64, 0, 48, 64, 64, 48, 0, 64, 48, -64, 64, 48, -64, 0, 48, -64, -64, 48, 0, -64, 48, 64,
     -64, 48, 64, 0, 48, 64, 0, 96, 64, 64, 96, 0, 64, 96, -64, 64, 96, -64, 0, 96, -64, -64, 96,
     0, -64, 96, 64, -64, 96, 64, 0, 96
  ]],
  nearRing: [9, 3, [
     64, 0, 0, 64, 64, 0, 0, 64, 0, -64, 64, 0, -64, 0, 0, -64, -64, 0, 0, -64, 0, 64, -64, 0,
     64.0625, 0, 0, 64, 0, 48, 64, 64, 48, 0, 64, 48, -64, 64, 48, -64, 0, 48, -64, -64, 48, 0,
     -64, 48, 64, -64, 48, 64.0625, 0, 48, 64, 0, 96, 64, 64, 96, 0, 64, 96, -64, 64, 96, -64, 0,
     96, -64, -64, 96, 0, -64, 96, 64, -64, 96, 64.0625, 0, 96
  ]],
  ringDown: [3, 9, [
     64, 0, 0, 64, 0, 48, 64, 0, 96, 64, 64, 0, 64, 64, 48, 64, 64, 96, 0, 64, 0, 0, 64, 48, 0, 64,
     96, -64, 64, 0, -64, 64, 48, -64, 64, 96, -64, 0, 0, -64, 0, 48, -64, 0, 96, -64, -64, 0, -64,
     -64, 48, -64, -64, 96, 0, -64, 0, 0, -64, 48, 0, -64, 96, 64, -64, 0, 64, -64, 48, 64, -64,
     96, 64, 0, 0, 64, 0, 48, 64, 0, 96
  ]],
  degenerate: [5, 3, [
     0, 0, 0, 0, 0, 0, 0, 0, 0, 64, 0, 0, 128, 0, 0, 0, 32, 0, 0, 32, 0, 0, 32, 0, 64, 32, 0, 128,
     32, 0, 0, 64, 0, 0, 64, 0, 0, 64, 0, 64, 64, 0, 128, 64, 0
  ]],
  nearDegenerate: [5, 3, [
     0, 0, 0, 0, 0, 0, 0.0625, 0, 0, 64, 0, 0, 128, 0, 0, 0, 32, 0, 0, 32, 0, 0.0625, 32, 0, 64,
     32, 0, 128, 32, 0, 0, 64, 0, 0, 64, 0, 0.0625, 64, 0, 64, 64, 0, 128, 64, 0
  ]],
  collinear: [3, 3, [
     0, 0, 0, 32, 0, 0, 64, 0, 0, 128, 0, 0, 160, 0, 0, 192, 0, 0, 0, 64, 0, 32, 64, 0, 64, 64, 0
  ]],
  cone: [5, 3, [
     0, 0, 64, 0, 0, 64, 0, 0, 64, 0, 0, 64, 0, 0, 64, 32, 0, 32, 32, 32, 32, 0, 32, 32, -32, 32,
     32, -32, 0, 32, 64, 0, 0, 64, 64, 0, 0, 64, 0, -64, 64, 0, -64, 0, 0
  ]],
  bowtie: [3, 3, [
     0, 0, 0, 32, 0, 0, 64, 0, 0, 0, 32, 0, 16, 16, 0, 32, 0, 0, 0, 64, 0, 0, 32, 0, 0, 0, 0
  ]],
  sliver: [3, 5, [
     0, -32, 0, 16, -32, 0, 32, -32, 0, 0, -16, 0, 16, -16, 0, 32, -16, 0, 0, 0, 0, 16, 0, 0, 32,
     0, 0, 0.25, 0, 0.03125, 16.25, 0, 0.03125, 32.25, 0, 0.03125, 0.5, 0, 0.0625, 16.5, 0, 0.0625,
     32.5, 0, 0.0625
  ]],
  nearBorder: [5, 3, [
     59.8046875, 19.68359375, -35.91015625, 30.62109375, 16.31640625, -3.796875, 62.765625,
     -10.99609375, -62.02734375, -46.94140625, 37.37109375, 43.98046875, 42.91015625, -1.91796875,
     1.67578125, 34.51171875, -42.48046875, -29.64453125, 31.6875, -51.203125, -31.55859375,
     -27.796875, 41.6796875, -23.7109375, 34.5703125, -58.79296875, -19.83203125, -16.30859375,
     15.04296875, 54.1875, -38.08984375, -49.0390625, -38.75, 43.23046875, -48.0703125, -40.703125,
     -39.16796875, -16.33984375, 25.48828125, -12.84765625, 45.68359375, -5.94140625, 52.1015625,
     26.234375, 35.94140625
  ]],
  flatBorder: [3, 3, [
     -54.9921875, 10.60546875, -31.2421875, -54.9921875, 24.15625, -31.2421875, -21.73828125,
     28.8046875, -31.2421875, -21.73828125, 10.60546875, -57.9375, 2.33984375, 24.15625,
     63.6953125, -21.73828125, 28.8046875, -31.2421875, -54.9921875, 28.8046875, 63.6953125,
     -21.73828125, 28.8046875, -57.9375, 2.33984375, 10.60546875, 63.6953125
  ]],
  bisected: [5, 3, [
     -47.328125, 10.87890625, 32.359375, 14.3125, -57.66796875, -19.19140625, -10.04296875,
     -22.8359375, 14.62109375, 26.37890625, -17.65625, -34.21484375, -2.578125, 46.16796875,
     -36.96484375, 39.8828125, -45.1171875, -62.00390625, 3.80078125, 4.40625, -32.609375,
     -61.05078125, -21.34765625, 37.55859375, -24.41015625, 5.3515625, -48.14453125, -25.20703125,
     -55.63671875, 24.78515625, -10.07421875, -63.1875, -37.140625, -35.9296875, 37.6328125,
     -2.42578125, 24.46484375, -46.70703125, -14.015625, 44.27734375, -1.17578125, 49.77734375,
     60.25390625, -42.625, 51.8203125
  ]],
  unbounded: [5, 3, [
     28.40625, 33.6875, -41.54296875, 17.79296875, -17.6953125, -27.9296875, -44.21484375,
     9.51953125, 42.83203125, 16.14453125, 40.5625, 29.59765625, 13.44140625, -29.20703125,
     -59.62890625, -15.45703125, -17.1640625, 21.1640625, -25.96875, 43.125, -7.02734375,
     0.64453125, -16.37109375, -63.6484375, 27.05078125, 2.87890625, -5.51171875, -14.50390625,
     61.5234375, 33.75, 43.1875, 18.07421875, 54.09765625, -16.59375, -58.44140625, 11.84375,
     -4.28125, 46.234375, 0.67578125, 34.828125, 26.59765625, 52.87890625, 26.8671875, -6.7109375,
     -23.81640625
  ]],
  shortEdge: [5, 3, [
     -47.73046875, 28.09375, -35.94140625, 24.9609375, -21.76171875, 35.28125, 2.2265625, 10.46875,
     -48.67578125, -55.49609375, 30.359375, 35.08203125, -51.703125, 9.71875, -50.140625,
     56.8828125, 56.16796875, -21.875, -13.64453125, 25.1953125, -7.796875, 38.17578125,
     -42.25390625, -35.3984375, -60.08203125, 39.578125, 14.16796875, -5.078125, 41.078125,
     57.27734375, 34.01171875, 31.2421875, -48.296875, -4.515625, -20.08203125, 59.88671875,
     -1.9453125, 23.65234375, 62.78125, -33.56640625, -35.3515625, 52.4765625, -54.26171875,
     -60.28515625, -5.74609375
  ]],
};

/**
 * The twin's patch collision for each (scratchpad `m0/patches-out.txt`): ioquake3's own
 * `CM_GeneratePatchCollide`, compiled and run over the same points. Its facets, its planes, a
 * digest of its bounds, planes and facets as bits, and how many messages it printed.
 */
const TWIN: Record<string, [number, number, string, number]> = {
  flat: [1, 5, '68415227', 0],
  arch: [4, 17, 'b2fdbd96', 0],
  bowl: [4, 28, 'c39ffa27', 0],
  ringAcross: [8, 20, '7abbf76e', 0],
  nearRing: [8, 21, '0a965036', 0],
  ringDown: [8, 20, 'a41d7fd7', 0],
  degenerate: [1, 5, '61f26fa4', 0],
  nearDegenerate: [1, 5, '61f26fa4', 0],
  collinear: [4, 21, '795257a0', 0],
  cone: [4, 35, '06f506b2', 0],
  bowtie: [0, 0, '9127e81d', 4],
  sliver: [1, 6, '60a8463e', 0],
  nearBorder: [23, 223, '761f03bd', 0],
  flatBorder: [6, 65, '0d93928f', 0],
  bisected: [15, 180, '00cd080f', 0],
  unbounded: [14, 162, 'd8240099', 0],
  shortEdge: [16, 164, '86a5983a', 0],
  bumpy45: [727, 1345, 'c4e87a05', 0],
};

/** A patch's collision, and what it printed. */
function generate(name: string) {
  const [width, height, points] = PATCHES[name];
  const printed: string[] = [];
  const pc = generatePatchCollide(width, height, points, (text) => printed.push(text));
  return { pc, printed };
}

/**
 * A bumpy patch's control points, `width × height`, 16 units apart, at the heights `z` gives,
 * each curve bent too little to need splitting, so every approximating column collapses.
 */
function bumpy(width: number, height: number, z: (i: number, j: number) => number): number[] {
  const points: number[] = [];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) points.push(16 * i, 16 * j, z(i, j));
  }
  return points;
}

/** A flat patch's control points, `width × height`, 32 units apart. */
function flat(width: number, height: number): number[] {
  const points: number[] = [];
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) points.push(32 * i, 32 * j, 0);
  return points;
}

describe('generatePatchCollide', () => {
  it("makes each hand-made patch's facets and planes as Quake 3's code does, to the bit", () => {
    for (const name of Object.keys(TWIN).filter((n) => n in PATCHES)) {
      const { pc, printed } = generate(name);
      const digest = new Digest();
      digestPatch(digest, 0, pc);
      expect([pc.numFacets, pc.numPlanes, digest.hex(), printed.length], name).toEqual(TWIN[name]);
    }
  });

  it('makes a flat square one facet, four planes round it and its own turned for a back', () => {
    const { pc } = generate('flat');
    expect(pc.bounds).toEqual([
      [-1, -1, -1],
      [65, 65, 1]
    ]);
    expect(pc.planes).toEqual([
      { plane: [0, 0, 1, 0], signbits: 0 },
      { plane: [-1, 0, 0, 0], signbits: 1 },
      { plane: [1, 0, 0, 64], signbits: 0 },
      { plane: [0, -1, 0, 0], signbits: 2 },
      { plane: [0, 1, 0, 64], signbits: 0 }
    ]);
    expect(pc.facets).toHaveLength(1);
    const [facet] = pc.facets;
    expect(facet.surfacePlane).toBe(0);
    expect(Array.from(facet.borderPlanes.subarray(0, facet.numBorders))).toEqual([1, 4, 2, 3, 0]);
    expect(Array.from(facet.borderInward.subarray(0, facet.numBorders))).toEqual([0, 0, 0, 0, 1]);
  });

  it('makes a large bumpy patch as Quake 3 does, to the bit', () => {
    const points = bumpy(45, 45, (i, j) => ((i * 7 + j * 13) % 8) * 4);
    const pc = generatePatchCollide(45, 45, points, () => {});
    const digest = new Digest();
    digestPatch(digest, 0, pc);
    expect([pc.numFacets, pc.numPlanes, digest.hex(), 0]).toEqual(TWIN.bumpy45);
  });

  it("refuses more than 1024 facets, or 4096 planes, in one patch, in Quake 3's words", () => {
    const print = () => {};
    // Each just past its limit and short of twice it: 32² cells, and 48² cells of two planes.
    const bumps = bumpy(65, 65, (i, j) => ((i * 7 + j * 13) % 8) * 4);
    expect(() => generatePatchCollide(65, 65, bumps, print)).toThrow('MAX_FACETS');
    const rough = bumpy(97, 97, (i, j) => (i * i * 7 + j * j * 13 + i * j * 5) % 29);
    expect(() => generatePatchCollide(97, 97, rough, print)).toThrow('MAX_PATCH_PLANES');
  });

  it("warns in Quake 3's words of a cell whose triangles both have no plane", () => {
    const { pc, printed } = generate('bowtie');
    expect(pc.numFacets).toBe(0);
    expect(printed).toEqual(new Array(4).fill('WARNING: CM_GridPlane unresolvable\n'));
  });

  it("refuses a size Quake 3 refuses, in its words", () => {
    const print = () => {};
    for (const [width, height] of [
      [4, 3],
      [3, 4]
    ]) {
      expect(() => generatePatchCollide(width, height, flat(width, height), print)).toThrow(
        'CM_GeneratePatchFacets: even sizes are invalid for quadratic meshes'
      );
    }
    expect(() => generatePatchCollide(131, 3, flat(131, 3), print)).toThrow(
      'CM_GeneratePatchFacets: source is > MAX_GRID_SIZE'
    );
    expect(() => generatePatchCollide(3, 2, flat(3, 2), print)).toThrow(
      'CM_GeneratePatchFacets: bad parameters: (3, 2)'
    );
    expect(() => generatePatchCollide(129, 3, flat(129, 3), print)).not.toThrow();
  });

  it("refuses a grid that subdivides past C's room for it, in the port's words", () => {
    // A zigzag 129 points across, each curve bent far enough to be split again and again.
    const zigzag: number[] = [];
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 129; i++) zigzag.push(8 * i, 32 * j, i % 2 ? 4096 : 0);
    }
    expect(() => generatePatchCollide(129, 3, zigzag, () => {})).toThrow(
      'CM_GeneratePatchCollide: the grid outgrew its 129² points'
    );
  });
});
