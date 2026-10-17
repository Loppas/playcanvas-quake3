import { describe, expect, it } from 'vitest';

import { MST_FLARE, MST_PATCH, MST_TRIANGLE_SOUP, type Bsp } from '../formats/bsp';
import {
  SHADER_MAX_INDEXES,
  SHADER_MAX_VERTEXES,
  batchBound,
  cutRun,
  treeOrder,
  worldBatches,
  worldRuns,
  type GridSize,
  type WorldBatch
} from './world-batches';
import {
  fogParts,
  leaf,
  model,
  node,
  surface,
  testBsp,
  testSources
} from './world-test-fixtures';
import { loadWorldShaders } from './world-shaders';

/** Each batch's surfaces, in order. */
const surfacesOf = (batch: WorldBatch) => batch.pieces.map((piece) => piece.surface);

/** Each batch's shader name, entity and surfaces. */
function summary(batches: WorldBatch[], shaderNames: string[]): [string, number, number[]][] {
  return batches.map((batch) => [shaderNames[batch.shader], batch.entity, surfacesOf(batch)]);
}

/** No surface with a grid. */
const noGrids = (bsp: Bsp) => bsp.surfaces.map(() => null);

describe('treeOrder', () => {
  it("walks the front child first, and takes each surface at the first leaf that holds it", () => {
    // Node 0 splits into node 1 (front) and leaf 2; node 1 into leaf 1 and leaf 0.
    const bsp = testBsp({
      surfaces: Array.from({ length: 5 }, () => surface()),
      nodes: [node(1, -3), node(-2, -1)],
      leafs: [leaf(0, 2), leaf(2, 2), leaf(4, 2)],
      // Surface 4 is in no leaf, and surface 3 in two.
      leafSurfaces: [0, 3, 2, 1, 3, 1]
    });
    expect(treeOrder(bsp)).toEqual([2, 1, 0, 3]);
  });
});

describe('worldBatches', () => {
  const scripts = `
    textures/s/glass { { map g.tga blendFunc add } }
    textures/s/sky { skyparms - 512 - { map $lightmap } }
    textures/s/fog { surfaceparm fog }
    textures/s/night { skyparms env/night - - }
  `;
  const shaderLump = ['wall', 'glass', 'floor', 'sky', 'fog', 'night'].map(
    (name) => `textures/s/${name}`
  );
  const images = ['g.tga', 'textures/s/wall.tga', 'textures/s/floor.tga'];
  /** One fog, for the surfaces in it. */
  const oneFog = fogParts([{ mins: [0, 0, 0], maxs: [64, 64, 64], shader: 'textures/s/fog' }]);

  it('orders by shader, then brush models before the world, then fog, keeping the rest', () => {
    const surfaces = [
      surface({ shaderNum: 1 }), // 0: glass, world
      surface({ shaderNum: 0, fogNum: 0 }), // 1: wall, world, fogged
      surface({ shaderNum: 2 }), // 2: floor, world
      surface({ shaderNum: 0 }), // 3: wall, world
      surface({ shaderNum: 0 }), // 4: wall, model 1
      surface({ shaderNum: 2 }), // 5: floor, model 2
      surface({ shaderNum: 0 }) // 6: wall, model 2
    ];
    const bsp = testBsp({
      shaders: shaderLump,
      surfaces,
      models: [model(0, 4), model(4, 1), model(5, 2)],
      leafSurfaces: [3, 2, 1, 0],
      ...oneFog
    });
    const shaders = loadWorldShaders(bsp, testSources(scripts, images));
    const names = shaders.shaders.map((shader) => shader.name.slice('textures/s/'.length));
    // Model 2 is drawn by the entity numbered first; the world comes after both.
    const batches = worldBatches(bsp, shaders, [2, 1], noGrids(bsp));
    expect(summary(batches, names)).toEqual([
      ['wall', 0, [6]],
      ['wall', 1, [4]],
      ['wall', 2, [3]],
      ['wall', 2, [1]],
      ['floor', 0, [5]],
      ['floor', 2, [2]],
      ['glass', 2, [0]]
    ]);
    expect(batches.map((batch) => [batch.model, batch.fog])).toEqual([
      [2, 0],
      [1, 0],
      [0, 0],
      [0, 1],
      [2, 0],
      [0, 0],
      [0, 0]
    ]);
  });

  it("batches faces, triangle soups and curves with grids, skies, and a fog's faces", () => {
    const surfaces = [
      surface({ shaderNum: 0 }),
      surface({ shaderNum: 0, surfaceType: MST_PATCH }),
      surface({ shaderNum: 0, surfaceType: MST_FLARE }),
      surface({ shaderNum: 3 }),
      // A fog's face with no stages, out of the fog.
      surface({ shaderNum: 4 }),
      surface({ shaderNum: 0, surfaceType: MST_TRIANGLE_SOUP }),
      // A nodraw curve, which has no grid.
      surface({ shaderNum: 0, surfaceType: MST_PATCH }),
      surface({ shaderNum: 3, surfaceType: MST_PATCH }),
      // A sky with no stages.
      surface({ shaderNum: 5 }),
      // The fog's face in its fog.
      surface({ shaderNum: 4, fogNum: 0 })
    ];
    const bsp = testBsp({
      shaders: shaderLump,
      surfaces,
      ...oneFog
    });
    // Under `r_fullbright`, so the face, the curve and the soup ask for one shader.
    const shaders = loadWorldShaders(bsp, testSources(scripts, images), true);
    const grid = { width: 3, height: 3 };
    const grids = [null, grid, null, null, null, null, null, grid, null, null];
    const batches = worldBatches(bsp, shaders, [], grids);
    // The skies first, at their sort, and the fog's faces last, at theirs.
    expect(batches.map((batch) => batch.pieces)).toEqual([
      [{ surface: 3 }, { surface: 7, rows: { first: 0, count: 3 } }],
      [{ surface: 8 }],
      [{ surface: 0 }, { surface: 1, rows: { first: 0, count: 3 } }, { surface: 5 }],
      [{ surface: 4 }],
      [{ surface: 9 }]
    ]);
    expect(batches.map((batch) => batch.fog)).toEqual([0, 0, 0, 0, 1]);
    // A face's 3, the grid's 9 points, the soup's 3; and its four quads' 24 indexes.
    expect([batches[2].numVerts, batches[2].numIndexes]).toEqual([15, 30]);
  });

  it('cuts a batch where the next surface would reach 1000 vertexes or 6000 indexes', () => {
    const bsp = testBsp({
      surfaces: [
        // Triangle soups, which take more than a face's 64 points.
        surface({ surfaceType: MST_TRIANGLE_SOUP, numVerts: 600, numIndexes: 3 }),
        surface({ surfaceType: MST_TRIANGLE_SOUP, numVerts: 399, numIndexes: 3 }),
        // 999 so far: one more vertex reaches the tessellator's 1000.
        surface({ numVerts: 1, numIndexes: 3 }),
        surface({ numVerts: 3, numIndexes: 5994 }),
        // 5997 so far: three more indexes reach its 6000.
        surface({ numVerts: 3, numIndexes: 3 })
      ]
    });
    // Under `r_fullbright`, so the faces and the soups ask for one shader.
    const shaders = loadWorldShaders(bsp, testSources('', ['textures/test/wall.tga']), true);
    const batches = worldBatches(bsp, shaders, [], noGrids(bsp));
    const cuts = batches.map((batch) => [surfacesOf(batch), batch.numVerts, batch.numIndexes]);
    expect(cuts).toEqual([
      [[0, 1], 999, 6],
      [[2, 3], 4, 5997],
      [[4], 3, 3]
    ]);
  });

  describe("a curve's rows, cut as RB_SurfaceGrid cuts them", () => {
    /** A soup of these counts, then a curve with a grid of this size, then a face, in one run. */
    function cut(soup: { numVerts: number; numIndexes: number }, width: number, height: number) {
      const bsp = testBsp({
        surfaces: [
          surface({ surfaceType: MST_TRIANGLE_SOUP, ...soup }),
          surface({ surfaceType: MST_PATCH }),
          surface()
        ]
      });
      // Under `r_fullbright`, so all three ask for one shader.
      const shaders = loadWorldShaders(bsp, testSources('', ['textures/test/wall.tga']), true);
      const batches = worldBatches(bsp, shaders, [], [null, { width, height }, null]);
      return batches.map((batch) => [batch.pieces, batch.numVerts, batch.numIndexes]);
    }

    it('takes the rows the vertexes have room for, less one, and draws the last again', () => {
      // 100 vertexes of room is 11 rows of 9; 10 are taken, and the 10th begins the next batch.
      expect(cut({ numVerts: 900, numIndexes: 3 }, 9, 33)).toEqual([
        [[{ surface: 0 }, { surface: 1, rows: { first: 0, count: 10 } }], 990, 3 + 9 * 8 * 6],
        // The face follows the grid into its last batch.
        [
          [{ surface: 1, rows: { first: 9, count: 24 } }, { surface: 2 }],
          24 * 9 + 3,
          23 * 8 * 6 + 3
        ]
      ]);
    });

    it('takes as many rows as the indexes have room for strips, and rows alone after', () => {
      // 100 indexes of room is 3 strips of 5 points, which take 3 rows: 2 strips. One strip's
      // room is left, a row at a time, each drawing nothing, until the vertexes run out.
      expect(cut({ numVerts: 3, numIndexes: 5900 }, 5, 9)).toEqual([
        [[{ surface: 0 }, { surface: 1, rows: { first: 0, count: 3 } }], 3 + 15 + 5 * 195, 5948],
        [[{ surface: 1, rows: { first: 2, count: 7 } }, { surface: 2 }], 38, 147]
      ]);
    });

    it('begins a batch when not one strip fits', () => {
      // 20 vertexes of room is 2 rows of 9, whose 1 is a row alone; then 11 is room for 1.
      expect(cut({ numVerts: 980, numIndexes: 3 }, 9, 5)).toEqual([
        [[{ surface: 0 }], 989, 3],
        [[{ surface: 1, rows: { first: 0, count: 5 } }, { surface: 2 }], 48, 195]
      ]);
    });
  });

  it('gathers each run of one shader, entity and fog, in the order the batches draw', () => {
    const bsp = testBsp({
      shaders: shaderLump,
      surfaces: [
        surface({ shaderNum: 0 }),
        surface({ shaderNum: 2 }),
        surface({ shaderNum: 0 }),
        surface({ shaderNum: 0, fogNum: 0 }),
        surface({ shaderNum: 0 })
      ],
      models: [model(0, 4), model(4, 1)],
      ...oneFog
    });
    const shaders = loadWorldShaders(bsp, testSources(scripts, images));
    const runs = worldRuns(bsp, shaders, [1], noGrids(bsp));
    expect(runs.map(({ entity, model, fog, surfaces }) => [entity, model, fog, surfaces])).toEqual([
      [0, 1, 0, [4]],
      [1, 0, 0, [0, 2]],
      [1, 0, 1, [3]],
      [1, 0, 0, [1]]
    ]);
    expect(new Set(runs.slice(0, 3).map((run) => run.shader)).size).toBe(1);
  });

  it('tells a cut each batch and what goes in it, in order', () => {
    const bsp = testBsp({
      surfaces: [
        surface({ surfaceType: MST_TRIANGLE_SOUP, numVerts: 3, numIndexes: 5900 }),
        surface({ surfaceType: MST_PATCH }),
        surface()
      ]
    });
    const told: unknown[][] = [];
    // A fourth surface past the count is left out.
    cutRun(bsp, [0, 1, 2, 0], 3, [null, { lodWidth: 5, lodHeight: 9 }, null, null], {
      begin: () => told.push(['begin']),
      surface: (at) => told.push(['surface', at]),
      rows: (at, first, count) => told.push(['rows', at, first, count]),
      end: (numVerts, numIndexes) => told.push(['end', numVerts, numIndexes])
    });
    expect(told).toEqual([
      ['begin'],
      ['surface', 0],
      ['rows', 1, 0, 3],
      ['end', 3 + 15 + 5 * 195, 5948],
      ['begin'],
      ['rows', 1, 2, 7],
      ['surface', 2],
      ['end', 38, 147]
    ]);
  });

  it('tells a cut that takes them each row alone, where it takes room and draws nothing', () => {
    const bsp = testBsp({
      surfaces: [
        surface({ surfaceType: MST_TRIANGLE_SOUP, numVerts: 3, numIndexes: 5900 }),
        surface({ surfaceType: MST_PATCH }),
        surface()
      ]
    });
    const alone: number[][] = [];
    const ignored = () => {};
    cutRun(bsp, [0, 1, 2], 3, [null, { lodWidth: 5, lodHeight: 9 }, null], {
      begin: ignored,
      surface: ignored,
      rows: ignored,
      row: (at, row) => alone.push([at, row]),
      end: ignored
    });
    // The last row the strips drew, again and again until the vertexes run out.
    expect(alone).toEqual(Array.from({ length: 195 }, () => [1, 2]));
  });

  it('tells a cut where each surface ORs in its lights: a face once it fits, others before', () => {
    const bsp = testBsp({
      surfaces: [
        surface({ numVerts: 994 }),
        surface({ surfaceType: MST_TRIANGLE_SOUP, numVerts: 10 }),
        surface(),
        surface({ surfaceType: MST_PATCH })
      ]
    });
    const told: unknown[][] = [];
    const cut = {
      begin: () => told.push(['begin']),
      surface: (at: number) => told.push(['surface', at]),
      rows: (at: number, first: number, count: number) => told.push(['rows', at, first, count]),
      light: (at: number) => told.push(['light', at]),
      end: (numVerts: number, numIndexes: number) => told.push(['end', numVerts, numIndexes])
    };
    // The soup does not fit after the large face, and gives its lights to the batch it leaves.
    cutRun(bsp, [0, 1, 2], 3, [null, null, null], cut);
    expect(told).toEqual([
      ['begin'],
      ['light', 0],
      ['surface', 0],
      ['light', 1],
      ['end', 994, 3],
      ['begin'],
      ['surface', 1],
      ['light', 2],
      ['surface', 2],
      ['end', 13, 6]
    ]);
    // Nor does a strip of the curve, which gives its lights to that batch too; and a cut told
    // where to start leaves out what is before it.
    told.length = 0;
    cutRun(bsp, [2, 0, 3], 3, [null, null, { lodWidth: 5, lodHeight: 9 }], cut, 1);
    expect(told).toEqual([
      ['begin'],
      ['light', 1],
      ['surface', 1],
      ['light', 2],
      ['end', 994, 3],
      ['begin'],
      ['rows', 2, 0, 9],
      ['end', 45, 192]
    ]);
  });

  /** How many batches a cut of these surfaces makes, at these sizes. */
  const batchesOf = (bsp: Bsp, surfaces: number[], sizes: (GridSize | null)[]) => {
    let count = 0;
    const cut = { begin: () => count++, surface: () => {}, rows: () => {}, end: () => {} };
    cutRun(bsp, surfaces, surfaces.length, sizes, cut);
    return count;
  };

  it('can cut some of a run, in another order, into more batches than all of it', () => {
    // Taken in turn, each large face shares a batch with a small one; the large ones together, each
    // needs its own.
    const bsp = testBsp({
      surfaces: [600, 300, 600, 300].map((numVerts) => surface({ numVerts }))
    });
    const faces = [null, null, null, null];
    expect(batchesOf(bsp, [0, 1, 2, 3], faces)).toBe(2);
    expect(batchesOf(bsp, [0, 2, 1, 3], faces)).toBe(3);
    // 1,800 points are one batch's room once over: two batches in a row, and one.
    expect(batchBound(bsp, [0, 1, 2, 3], noGrids(bsp))).toBe(3);
  });

  it('bounds the batches any of a run can be cut into, in any order and at any detail', () => {
    // Runs of faces and curves at random, near a batch's room or far from it, each face a fan of
    // triangles over its points; then some of each, shuffled, every curve at fewer columns and
    // rows.
    let seed = 7;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 16) % n;
    };
    let reached = 0;
    for (let trial = 0; trial < 4000; trial++) {
      const large = random(2) === 0;
      const surfaces = Array.from({ length: 1 + random(12) }, () => {
        if (random(3) === 0) return surface({ surfaceType: MST_PATCH });
        const numVerts = 3 + random(large ? 990 : 300);
        return surface({ numVerts, numIndexes: 3 * (numVerts - 2) });
      });
      const bsp = testBsp({ surfaces });
      const grids = surfaces.map((s) =>
        s.surfaceType === MST_PATCH ? { width: 2 + random(64), height: 2 + random(64) } : null
      );
      const all = Array.from(surfaces.keys());
      const bound = batchBound(bsp, all, grids);
      for (let pick = 0; pick < 8; pick++) {
        const some = all.filter(() => random(4) > 0);
        for (let i = some.length - 1; i > 0; i--) {
          const j = random(i + 1);
          [some[i], some[j]] = [some[j], some[i]];
        }
        const sizes = some.map((s) => {
          const grid = grids[s];
          if (!grid) return null;
          return { lodWidth: 2 + random(grid.width - 1), lodHeight: 2 + random(grid.height - 1) };
        });
        const batches = batchesOf(bsp, some, sizes);
        expect(batches).toBeLessThanOrEqual(bound);
        if (batches === bound && bound > 1) reached++;
      }
    }
    // Not so loose that no cut comes to it.
    expect(reached).toBeGreaterThan(0);
  });

  it("refuses a surface too big for a batch of its own, in RB_CheckOverflow's words", () => {
    const shaders = (bsp: ReturnType<typeof testBsp>) =>
      loadWorldShaders(bsp, testSources('', ['textures/test/wall.tga']));
    const soup = surface({ surfaceType: MST_TRIANGLE_SOUP, numVerts: SHADER_MAX_VERTEXES });
    const big = testBsp({ surfaces: [soup] });
    expect(() => worldBatches(big, shaders(big), [], noGrids(big))).toThrow(
      new Error('RB_CheckOverflow: verts > MAX (1000 > 1000)')
    );
    const many = testBsp({ surfaces: [surface({ numIndexes: SHADER_MAX_INDEXES })] });
    expect(() => worldBatches(many, shaders(many), [], noGrids(many))).toThrow(
      new Error('RB_CheckOverflow: indices > MAX (6000 > 6000)')
    );
  });
});
