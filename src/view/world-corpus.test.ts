import { beforeAll, describe, expect, it } from 'vitest';

import { MST_FLARE, MST_PATCH, parseBsp, type Bsp } from '../formats/bsp';
import { retailMaps } from '../formats/bsp-test-fixtures';
import { readEntities } from '../formats/entity-text';
import { shaderTextOrder } from '../formats/asset-library';
import { parseShaderScripts } from '../formats/shader-script';
import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { leafArea, loadMap } from '../sim/cm/cm-load';
import { pointLeafnum, writeAreaBits } from '../sim/cm/cm-test';
import { angleVectors } from '../sim/pmove-math';
import { vec3 } from '../sim/vec3';
import { brushModelsAtRest } from './brush-models';
import { verticalFov } from './fov';
import { CLASSIC_FULLSCREEN, identityLight } from './overbright';
import { spectatorStart } from './spectator-start';
import { treeOrder, worldBatches, worldRuns, type WorldBatch } from './world-batches';
import {
  fixSharedVertexLodError,
  loadPatchGrids,
  lodErrorForVolume,
  lodTables,
  parseMesh,
  stitchAllPatches,
  type PatchGrid
} from './world-curves';
import { fogColor } from './world-fog';
import { WorldIndexes, gridBases, viewSpeeds, worldPositions } from './world-indexes';
import {
  DEFAULT_IMAGE,
  loadWorldShaders,
  type ShaderSources,
  type WorldShader
} from './world-shaders';
import { SkyIndexes } from './world-sky';
import { OPEN_AREAS, WorldVis } from './world-vis';

/** The visible set's cvars at their defaults. */
const EVERY_SWITCH = {
  novis: false,
  nocull: false,
  lockpvs: false,
  showcluster: false,
  facePlaneCull: true,
  entities: true
};

/** Six maps that between them have every kind of surface, fog, sky and brush model. */
const MAPS = ['q3dm1', 'q3dm4', 'q3dm9', 'q3dm10', 'q3dm11', 'q3dm17'];

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

/** The surfaces a map's batches draw, each once however many batches its rows are cut across. */
const surfacesDrawn = (batches: WorldBatch[]) =>
  new Set(batches.flatMap((batch) => batch.pieces.map((piece) => piece.surface))).size;

/** Whether a batch in this fog draws its fog's pass: a sky's draws none. */
const fogPassOf = (shader: WorldShader, fog: number) =>
  fog > 0 && !shader.sky && shader.fogPass !== 'none';

/**
 * A batch's draws: one a stage, a sky's box one a side where its faces are there, and its fog's
 * pass.
 */
const drawsOf = (shader: WorldShader, fog: number) =>
  shader.stages.length + (shader.sky?.box ? 6 : 0) + (fogPassOf(shader, fog) ? 1 : 0);

describe.skipIf(!haveFullSet)("the world's draws on the accept's six maps", () => {
  const maps = new Map<string, Bsp>();
  /** Each map's grids, at `r_mapOverBrightBits` 2 and `r_subdivisions` 4. */
  const grids = new Map<string, (PatchGrid | null)[]>();
  let sources: ShaderSources & { warnings: string[] };

  beforeAll(async () => {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    const texts: string[] = [];
    for (const path of shaderTextOrder(fs)) texts.push((await fs.readText(path)) ?? '');
    const warnings: string[] = [];
    sources = {
      scripts: parseShaderScripts(texts),
      hasImage: (name) => fs.resolveImage(name) !== undefined,
      warn: (text) => warnings.push(text),
      warnings
    };
    for (const map of MAPS) {
      const bsp = parseBsp(await fs.readRequired(`maps/${map}.bsp`), map);
      maps.set(map, bsp);
      grids.set(map, loadPatchGrids(bsp, 1, 4));
    }
  }, 60_000);

  /** Each map's world as it draws, by `r_fullbright`. */
  const counts = (fullbright: boolean) =>
    MAPS.map((map) => {
      const bsp = maps.get(map)!;
      sources.warnings.length = 0;
      const shaders = loadWorldShaders(bsp, sources, fullbright);
      const batches = worldBatches(bsp, shaders, [], grids.get(map)!);
      return {
        map,
        surfaces: surfacesDrawn(batches),
        shaders: new Set(batches.map((batch) => batch.shader)).size,
        batches: batches.length,
        draws: batches.reduce(
          (n, batch) => n + drawsOf(shaders.shaders[batch.shader], batch.fog),
          0
        ),
        warnings: sources.warnings.length
      };
    });

  it("draws each map's world in opengl1's batches, warning of nothing", () => {
    // Measured from the port, and as independent counts of the same maps have them, their curves',
    // skies' and fogs' among them: by name and lightmap index, every curve whole, nothing culled.
    expect(counts(false)).toEqual([
      { map: 'q3dm1', surfaces: 2097, shaders: 93, batches: 99, draws: 205, warnings: 0 },
      { map: 'q3dm4', surfaces: 2313, shaders: 71, batches: 82, draws: 172, warnings: 0 },
      { map: 'q3dm9', surfaces: 5875, shaders: 123, batches: 192, draws: 449, warnings: 0 },
      { map: 'q3dm10', surfaces: 4052, shaders: 73, batches: 83, draws: 188, warnings: 0 },
      { map: 'q3dm11', surfaces: 10338, shaders: 159, batches: 186, draws: 425, warnings: 0 },
      { map: 'q3dm17', surfaces: 1426, shaders: 56, batches: 57, draws: 116, warnings: 0 }
    ]);
  });

  it('draws them under r_fullbright one shader a name', () => {
    // Measured from the port. An independent count of the same maps agrees wherever no fog splits
    // a shader's batches: q3dm4, q3dm9 and q3dm11 have fogged surfaces.
    expect(counts(true)).toEqual([
      { map: 'q3dm1', surfaces: 2097, shaders: 86, batches: 93, draws: 200, warnings: 0 },
      { map: 'q3dm4', surfaces: 2313, shaders: 61, batches: 74, draws: 162, warnings: 0 },
      { map: 'q3dm9', surfaces: 5875, shaders: 102, batches: 164, draws: 389, warnings: 0 },
      { map: 'q3dm10', surfaces: 4052, shaders: 64, batches: 77, draws: 178, warnings: 0 },
      { map: 'q3dm11', surfaces: 10338, shaders: 137, batches: 169, draws: 398, warnings: 0 },
      { map: 'q3dm17', surfaces: 1426, shaders: 49, batches: 52, draws: 109, warnings: 0 }
    ]);
  });

  it('subdivides every patch but the nodraw ones, and draws those the tree reaches whole', () => {
    const curves = MAPS.map((map) => {
      const bsp = maps.get(map)!;
      const made = grids.get(map)!.filter((grid) => grid !== null);
      const shaders = loadWorldShaders(bsp, sources);
      const drawn = worldBatches(bsp, shaders, [], grids.get(map)!).flatMap((batch) =>
        batch.pieces.map(({ surface, rows }) =>
          rows ? (rows.count - 1) * (grids.get(map)![surface]!.width - 1) * 2 : 0
        )
      );
      return {
        map,
        patches: bsp.surfaces.filter((surface) => surface.surfaceType === MST_PATCH).length,
        grids: made.length,
        points: made.reduce((n, grid) => n + grid.width * grid.height, 0),
        triangles: made.reduce((n, grid) => n + (grid.width - 1) * (grid.height - 1) * 2, 0),
        drawn: drawn.reduce((n, triangles) => n + triangles, 0)
      };
    });
    // Measured from the port, and as an independent subdivision of the same maps has them. q3dm4
    // has 4 nodraw patches and 54 in no leaf, and q3dm10 1 nodraw.
    expect(curves).toEqual([
      { map: 'q3dm1', patches: 113, grids: 113, points: 6652, triangles: 9744, drawn: 9744 },
      { map: 'q3dm4', patches: 375, grids: 371, points: 10336, triangles: 11616, drawn: 9600 },
      { map: 'q3dm9', patches: 402, grids: 402, points: 8316, triangles: 8728, drawn: 8728 },
      { map: 'q3dm10', patches: 220, grids: 219, points: 3830, triangles: 3392, drawn: 3392 },
      { map: 'q3dm11', patches: 102, grids: 102, points: 3311, triangles: 4076, drawn: 4076 },
      { map: 'q3dm17', patches: 32, grids: 32, points: 1084, triangles: 1152, drawn: 1152 }
    ]);
  });

  it("drops each map's curve rows at its capture view as opengl1 does", () => {
    const cuts = MAPS.map((map) => {
      const bsp = maps.get(map)!;
      const curves = grids.get(map)!;
      const shaders = loadWorldShaders(bsp, sources);
      const poses = brushModelsAtRest(readEntities(bsp.entityString), bsp.models);
      const runs = worldRuns(bsp, shaders, poses.map((pose) => pose.model), curves);
      const drawn = new Set(runs.flatMap((run) => run.surfaces));
      const detail = new WorldIndexes(bsp, runs, curves, gridBases(bsp, curves, drawn), poses);
      let faceIndexes = 0;
      for (const surface of drawn) {
        if (!curves[surface]) faceIndexes += bsp.surfaces[surface].numIndexes;
      }
      /** The batches and draws, and the curves' triangles. */
      const drawing = () => {
        let [batches, draws, indexes] = [0, 0, 0];
        detail.runs.forEach(({ batches: ranges, used }, r) => {
          const shown = ranges.filter((batch) => batch.count > 0).length;
          batches += shown;
          draws += shown * drawsOf(shaders.shaders[runs[r].shader], runs[r].fog);
          indexes += used;
        });
        return { batches, draws, triangles: (indexes - faceIndexes) / 3 };
      };
      const whole = drawing();
      const start = spectatorStart(readEntities(bsp.entityString));
      const { origin, angles } = start;
      const { forward } = angleVectors(angles);
      // Every surface the tree and the brush models hold, as `r_novis 1` and `r_nocull 1` add them.
      const vis = new WorldVis(bsp, shaders, curves, poses, () => {});
      const everything = { ...EVERY_SWITCH, novis: true, nocull: true };
      vis.view(start, 90, verticalFov(90), everything, OPEN_AREAS);
      detail.view(vis, origin, forward, 250, () => {});
      const atView = drawing();
      // Every curve the tree reaches, drawn or not, as the views were surveyed.
      const reached = treeOrder(bsp).flatMap((surface) => curves[surface] ?? []);
      const cut = reached.filter((grid) => {
        const tables = lodTables(grid, lodErrorForVolume(grid, null, origin, forward, 250));
        return tables.lodWidth < grid.width || tables.lodHeight < grid.height;
      });
      return [
        map,
        `${cut.length} of ${reached.length}`,
        `${atView.triangles} of ${whole.triangles}`,
        [whole.batches, whole.draws],
        [atView.batches, atView.draws]
      ];
    });
    // Measured from the port, brush models among the batches, and as an independent survey of the
    // same views has them, with each fogged batch's pass.
    expect(cuts).toEqual([
      ['q3dm1', '90 of 113', '3772 of 9744', [99, 205], [98, 203]],
      ['q3dm4', '245 of 317', '5956 of 9600', [82, 172], [80, 168]],
      ['q3dm9', '230 of 402', '5828 of 8728', [192, 449], [191, 447]],
      ['q3dm10', '114 of 219', '2548 of 3392', [85, 192], [85, 192]],
      ['q3dm11', '69 of 102', '2212 of 4076', [207, 479], [207, 479]],
      ['q3dm17', '32 of 32', '256 of 1152', [57, 116], [57, 116]]
    ]);
  });

  it('has room in each run for the batches any view can cut it into', () => {
    const room = MAPS.map((map) => {
      const bsp = maps.get(map)!;
      const curves = grids.get(map)!;
      const shaders = loadWorldShaders(bsp, sources);
      const poses = brushModelsAtRest(readEntities(bsp.entityString), bsp.models);
      const runs = worldRuns(bsp, shaders, poses.map((pose) => pose.model), curves);
      const bases = gridBases(bsp, curves, new Set(runs.flatMap((run) => run.surfaces)));
      const detail = new WorldIndexes(bsp, runs, curves, bases, poses);
      const batches = detail.runs.flatMap((run) => run.batches);
      return [map, runs.length, batches.filter((batch) => batch.count > 0).length, batches.length];
    });
    // The runs, their batches with every surface whole, and the batches they have room for: one
    // more a run than its whole could need, for the batch its lit surfaces may start.
    expect(room).toEqual([
      ['q3dm1', 93, 99, 107 + 93],
      ['q3dm4', 76, 82, 90 + 76],
      ['q3dm9', 179, 192, 207 + 179],
      ['q3dm10', 75, 85, 97 + 75],
      ['q3dm11', 186, 207, 230 + 186],
      ['q3dm17', 56, 57, 58 + 56]
    ]);
  });

  it("finds the blocks of each map's sky at its capture view as opengl1 does", () => {
    const skies = MAPS.map((map) => {
      const bsp = maps.get(map)!;
      const curves = grids.get(map)!;
      const shaders = loadWorldShaders(bsp, sources);
      const poses = brushModelsAtRest(readEntities(bsp.entityString), bsp.models);
      const runs = worldRuns(bsp, shaders, poses.map((pose) => pose.model), curves);
      const bases = gridBases(bsp, curves, new Set(runs.flatMap((run) => run.surfaces)));
      const detail = new WorldIndexes(bsp, runs, curves, bases, poses);
      const skyRuns = detail.runs.filter((_, r) => shaders.shaders[runs[r].shader].sky);
      const sky = new SkyIndexes(detail.indexes, worldPositions(bsp, curves, bases), skyRuns);
      sky.view(spectatorStart(readEntities(bsp.entityString)).origin, () => {});
      const batches = sky.runs.flat();
      const drawn = (count: number) => count / 6;
      return [
        map,
        batches.map(({ blocks }) =>
          [0, 1, 2, 3, 4, 5].map((side) => {
            const rect = Array.from(blocks.subarray(side * 4, side * 4 + 4));
            return rect.every((n) => n === 0) ? '-' : rect.join(' ');
          })
        ),
        batches.map(({ box, clouds }) => [
          drawn(box.reduce((n, side) => n + side.count, 0)),
          drawn(clouds.count)
        ])
      ];
    });
    // Each side's least s and t block and its greatest, from -4 to 4, and the blocks the box and
    // the clouds draw. Measured from the port, and as an independent clip of the same views, in
    // doubles, has them. Every view's bottom is clear, and each run's batch for its lit surfaces
    // draws nothing.
    expect(skies).toEqual([
      [
        'q3dm1',
        [
          ['-4 -4 4 4', '-4 -4 4 4', '-4 -4 4 4', '-4 -1 4 4', '-4 -4 4 4', '-'],
          ['-', '-', '-', '-', '-', '-']
        ],
        [
          [296, 296],
          [0, 0]
        ]
      ],
      [
        'q3dm4',
        [
          ['-4 1 2 4', '-2 1 4 4', '-4 0 4 4', '-', '-4 -4 2 4', '-'],
          ['-', '-', '-', '-', '-', '-']
        ],
        [
          [116, 116],
          [0, 0]
        ]
      ],
      [
        'q3dm9',
        [
          ['0 0 4 3', '-4 0 0 2', '-', '-4 -1 4 3', '-', '-'],
          ['-', '-', '-', '-', '-', '-']
        ],
        [
          [52, 52],
          [0, 0]
        ]
      ],
      [
        'q3dm10',
        [
          ['-4 1 4 4', '-4 1 4 4', '-4 1 4 4', '-4 1 4 4', '-4 -4 4 4', '-'],
          ['-', '-', '-', '-', '-', '-']
        ],
        [
          [160, 160],
          [0, 0]
        ]
      ],
      [
        'q3dm11',
        [
          ['-', '-4 -1 4 2', '-4 0 4 4', '2 0 4 2', '-4 -4 2 2', '-'],
          ['-', '-', '-', '-', '-', '-']
        ],
        [
          [96, 96],
          [0, 0]
        ]
      ],
      ['q3dm17', [], []]
    ]);
  });

  it('has its lightmap pages, each asked for within them', () => {
    const pages = MAPS.map((map) => {
      const bsp = maps.get(map)!;
      const asked = bsp.surfaces.map((surface) => surface.lightmapNum);
      return [map, bsp.lightmaps.length, Math.min(...asked), Math.max(...asked)];
    });
    expect(pages).toEqual([
      ['q3dm1', 9, -1, 8],
      ['q3dm4', 13, -1, 12],
      ['q3dm9', 24, -1, 23],
      ['q3dm10', 11, -1, 10],
      ['q3dm11', 25, -1, 24],
      ['q3dm17', 9, -1, 8]
    ]);
  });

  it("starts each map's spectator at its intermission point, looking at its target", () => {
    const starts = MAPS.map((map) => {
      const { origin, angles } = spectatorStart(readEntities(maps.get(map)!.entityString));
      const round = (x: number) => Math.round(x * 100) / 100 + 0;
      return [map, ...[origin.x, origin.y, origin.z, angles.x, angles.y, angles.z].map(round)];
    });
    // The eye 26 above each point; pitch positive looking down.
    expect(starts).toEqual([
      ['q3dm1', 668, 2304, 154, 9.69, -90, 0],
      ['q3dm4', -192, -616, 130, 5.71, 90, 0],
      ['q3dm9', -688, 1216, 438, 23.15, 118.76, 0],
      ['q3dm10', -64, -320, 242, -11.6, 90, 0],
      ['q3dm11', 754, -514, 270, 2.65, 63.43, 0],
      ['q3dm17', 2112, 64, 642, -3.24, 180, 0]
    ]);
  });

  it("stands q3dm10's and q3dm11's brush models where a free-for-all spawns them", () => {
    const rest = (map: string) => {
      const bsp = maps.get(map)!;
      return brushModelsAtRest(readEntities(bsp.entityString), bsp.models);
    };
    for (const map of ['q3dm1', 'q3dm4', 'q3dm9', 'q3dm17']) expect(rest(map), map).toEqual([]);
    expect(rest('q3dm10')).toEqual([{ model: 1, origin: [0, 0, 0], angles: [0, 0, 0] }]);
    const q3dm11 = rest('q3dm11');
    // `*31` and `*32` are `notfree`; every door rests closed, where it was built.
    const drawn = [1, 2, 4, 5, 6, 7, 10, 11, 14, 15, 18, 20, 27];
    expect(q3dm11.map((pose) => pose.model)).toEqual(drawn);
    const XRAY = 'models/mapobjects/skel/xraybig.md3';
    const machines = q3dm11.filter((pose) => pose.model2);
    expect(machines).toEqual([
      { model: 6, origin: [-3200, -2444, -28], angles: [0, 0, 0], model2: XRAY },
      { model: 27, origin: [-3200, -1972, -28], angles: [0, 0, 0], model2: XRAY }
    ]);
    const built = q3dm11.filter((pose) => !pose.model2);
    expect(built.every(({ origin }) => origin.every((x) => x === 0))).toBe(true);

    const bsp = maps.get('q3dm11')!;
    sources.warnings.length = 0;
    const shaders = loadWorldShaders(bsp, sources);
    const batches = worldBatches(
      bsp,
      shaders,
      q3dm11.map((pose) => pose.model),
      grids.get('q3dm11')!
    );
    const models = batches.filter((batch) => batch.model !== 0);
    // Of their 427 surfaces, 7 are flares, which draw nothing at `r_flares 0`.
    expect(surfacesDrawn(models)).toBe(420);
    // Measured from the port; the world's own 186 are unchanged by them.
    expect([models.length, batches.length]).toEqual([21, 207]);
  });
});

/**
 * Each retail map's curves: the cracks stitched, the error entries one past a table's end still
 * hold after the fix, the entries the fix changes, the grids' points and triangles, and the widest
 * and tallest grid.
 */
const STITCHED: Record<string, [number, number, number, number, number, string]> = {
  'pro-q3dm13': [24, 0, 191, 4505, 6648, '33x17'],
  'pro-q3dm6': [0, 0, 874, 7166, 6774, '29x5'],
  'pro-q3tourney2': [0, 0, 319, 4245, 3808, '33x9'],
  'pro-q3tourney4': [0, 0, 4, 256, 224, '11x2'],
  q3ctf1: [0, 0, 344, 8104, 10464, '33x7'],
  q3ctf2: [28, 54, 1290, 13462, 15936, '33x33'],
  q3ctf3: [92, 0, 544, 12018, 13248, '22x5'],
  q3ctf4: [0, 0, 64, 1394, 1792, '17x7'],
  q3dm0: [0, 0, 24, 1774, 2080, '17x9'],
  q3dm1: [0, 0, 186, 6652, 9744, '33x15'],
  q3dm10: [0, 0, 648, 3830, 3392, '17x2'],
  q3dm11: [0, 0, 61, 3311, 4076, '21x13'],
  q3dm12: [1, 0, 446, 5130, 5042, '18x5'],
  q3dm13: [4, 0, 127, 4329, 6568, '33x17'],
  q3dm14: [0, 0, 537, 8013, 9340, '33x7'],
  q3dm15: [2, 0, 702, 6131, 6052, '17x7'],
  q3dm16: [104, 43, 299, 2606, 2608, '65x5'],
  q3dm17: [0, 0, 154, 1084, 1152, '17x5'],
  q3dm18: [0, 0, 646, 4705, 4600, '22x5'],
  q3dm19: [0, 0, 0, 0, 0, '0x0'],
  q3dm2: [0, 0, 415, 6624, 7888, '17x9'],
  q3dm3: [0, 0, 171, 2532, 2452, '17x5'],
  q3dm4: [0, 0, 596, 10336, 11616, '33x17'],
  q3dm5: [0, 0, 466, 4193, 3954, '13x5'],
  q3dm6: [0, 0, 874, 7166, 6774, '29x5'],
  q3dm7: [0, 0, 294, 7329, 9752, '33x9'],
  q3dm8: [12, 24, 780, 7455, 7884, '17x9'],
  q3dm9: [0, 0, 542, 8316, 8728, '33x9'],
  q3tourney1: [0, 0, 839, 8169, 8188, '50x9'],
  q3tourney2: [0, 0, 250, 3467, 3104, '33x9'],
  q3tourney3: [0, 0, 216, 2491, 2664, '17x7'],
  q3tourney4: [0, 0, 4, 256, 224, '11x2'],
  q3tourney5: [0, 0, 148, 1205, 1312, '17x5'],
  q3tourney6: [0, 0, 0, 136, 128, '17x2'],
  q3tourney6_ctf: [0, 0, 0, 136, 128, '17x2'],
  test_bigbox: [0, 0, 0, 0, 0, '0x0']
};

/**
 * Each retail map's skies: the shader, the lightmap index it was made at, its sort, the height its
 * clouds' table was made at, and its outer box with the faces found. Measured from the port, and as
 * the survey of the shaders and the paks found them.
 */
const SKIES: Record<string, string[]> = {
  'pro-q3dm13': ['textures/skies/tim_dm3_red -1 2 512 -'],
  'pro-q3dm6': ['textures/skies/xtoxicskytim_q3dm5 -1 2 512 -'],
  'pro-q3tourney2': ['textures/skies/xtoxicsky_tourney -1 2 512 -'],
  'pro-q3tourney4': ['textures/skies/pjbasesky_arena1_sky -1 2 512 -'],
  q3ctf1: ['textures/skies/toxicskytim_blue -1 2 512 -'],
  q3ctf2: ['textures/skies/pj_ctf2_sky -1 2 128 -'],
  q3ctf3: ['textures/skies/xtoxicsky_q3ctf3 -1 2 512 -'],
  q3ctf4: [],
  q3dm0: ['textures/skies/q3dm0 -1 2 512 -'],
  q3dm1: ['textures/skies/tim_hell -1 2 384 -'],
  q3dm10: ['textures/skies/skybox -1 2 512 env/space1 (6 faces)'],
  q3dm11: ['textures/skies/pj_dm9sky -1 2 512 -'],
  q3dm12: ['textures/skies/pj_dm10sky -1 2 512 -'],
  q3dm13: ['textures/skies/tim_dm3_red -1 2 512 -'],
  q3dm14: ['textures/skies/toxicskytim_dm9 -1 2 512 -'],
  q3dm15: ['textures/skies/tim_dm14red -1 2 512 -'],
  q3dm16: [],
  q3dm17: [],
  q3dm18: [],
  q3dm19: [],
  q3dm2: ['textures/skies/toxicskytim_dm5 -1 2 512 -'],
  q3dm3: ['textures/skies/killsky -1 2 512 -'],
  q3dm4: ['textures/skies/xtoxicsky_dm9 -1 2 512 -'],
  q3dm5: ['textures/skies/toxicskytim_dm2 -1 2 512 -'],
  q3dm6: ['textures/skies/xtoxicskytim_q3dm5 -1 2 512 -'],
  q3dm7: ['textures/skies/toxicskytim_dm8 -1 2 512 -'],
  q3dm8: ['textures/skies/pj_arena4_sky -1 2 128 -'],
  q3dm9: ['textures/skies/toxicskytim_dm7 -1 2 512 -'],
  q3tourney1: ['textures/skies/nightsky_xian_dm1 -1 2 512 env/xnight2 (6 faces)'],
  q3tourney2: ['textures/skies/xtoxicsky_tourney -1 2 512 -'],
  q3tourney3: ['textures/skies/tim_km2 -1 2 512 -'],
  q3tourney4: ['textures/skies/pjbasesky_arena1_sky -1 2 512 -'],
  q3tourney5: ['textures/skies/toxicskydim -1 2 512 -'],
  q3tourney6: [],
  q3tourney6_ctf: [],
  test_bigbox: []
};

/**
 * Each retail map's sky batches: the surfaces they hold, their triangles, and the batches. Measured
 * from the port, and as the survey of the maps found them.
 */
const SKY_BATCHES: Record<string, [number, number, number]> = {
  'pro-q3dm13': [31, 116, 1],
  'pro-q3dm6': [38, 165, 1],
  'pro-q3tourney2': [29, 116, 1],
  'pro-q3tourney4': [22, 71, 1],
  q3ctf1: [61, 298, 1],
  q3ctf2: [20, 88, 1],
  q3ctf3: [62, 170, 1],
  q3ctf4: [0, 0, 0],
  q3dm0: [49, 158, 1],
  q3dm1: [16, 67, 1],
  q3dm10: [1, 17, 1],
  q3dm11: [70, 238, 1],
  q3dm12: [37, 110, 1],
  q3dm13: [31, 105, 1],
  q3dm14: [29, 103, 1],
  q3dm15: [32, 199, 1],
  q3dm16: [0, 0, 0],
  q3dm17: [0, 0, 0],
  q3dm18: [0, 0, 0],
  q3dm19: [0, 0, 0],
  q3dm2: [33, 116, 1],
  q3dm3: [52, 149, 1],
  q3dm4: [7, 62, 1],
  q3dm5: [17, 69, 1],
  q3dm6: [38, 163, 1],
  q3dm7: [80, 300, 1],
  q3dm8: [14, 46, 1],
  q3dm9: [54, 253, 1],
  q3tourney1: [12, 53, 1],
  q3tourney2: [28, 105, 1],
  q3tourney3: [23, 64, 1],
  q3tourney4: [18, 51, 1],
  q3tourney5: [1, 2, 1],
  q3tourney6: [0, 0, 0],
  q3tourney6_ctf: [0, 0, 0],
  test_bigbox: [0, 0, 0]
};

/**
 * Each retail map's fogs, in lump order: its shader and the place it was registered at, its least
 * and greatest corners, its colour at `r_overBrightBits 1`, its depth, and the plane its face lies
 * on. Measured from the port; the shaders, corners and faces as the survey of the maps read them.
 */
const FOGS: Record<string, string[]> = {
  'pro-q3tourney2': [
    'textures/sfx/kc_hellfog_1k #1 520,-184,-256 632,-72,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 520,72,-256 648,184,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 792,64,-256 888,184,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 1200,1208,-388 1296,1328,-108 63,15,12 225 0,0,-1,108',
    'textures/sfx/kc_hellfog_1k #1 855,1155,-388 1053,1261,-108 63,15,12 225 0,0,-1,108',
    'textures/sfx/kc_hellfog_1k #1 1224,750,-232 1280,1000,48 63,15,12 225 0,0,-1,-48',
    'textures/sfx/kc_hellfog_1k #1 -388,-960,-1028 260,-124,-151 63,15,12 225 0,0,-1,151',
    'textures/sfx/kc_hellfog_1k #1 -760,-182,-256 -648,-70,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 -776,74,-256 -648,186,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 -1016,66,-256 -920,186,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 816,1512,-388 1040,1576,-108 63,15,12 225 0,0,-1,108'
  ],
  q3ctf1: ['textures/sfx/fog_timctf1 #1 520,-1088,0 1016,-208,44 92,92,99 464 0,0,-1,-44'],
  q3ctf3: [
    'textures/sfx/xbluefog #1 -576,-2432,-640 640,-1728,-16 38,38,114 128 0,0,-1,16',
    'textures/sfx/xredfog #2 -576,2880,-640 640,3584,-16 114,38,38 128 0,0,-1,16',
    'textures/sfx/xredfog #2 136,2896,-256 312,3136,-128 114,38,38 128 -'
  ],
  q3dm11: ['textures/sfx/q3dm9fog #1 -2768,-1688,-648 -2016,-272,-160 70,14,12 256 0,0,-1,160'],
  q3dm12: [
    'textures/sfx/hellfog_pj_dm10 #1 -1216,-3264,-832 -112,-688,-288 63,15,12 392 0,0,-1,288',
    'textures/sfx/hellfog_pj_dm10 #1 -976,480,-656 -160,1676,-256 63,15,12 392 0,0,-1,256'
  ],
  q3dm14: [
    'textures/sfx/q3dm14fog #1 -336,-540,-768 600,592,-592 70,14,12 256 0,0,-1,592',
    'textures/sfx/q3dm14fog #1 -1186,-1802,-840 -480,-306,-592 70,14,12 256 0,0,-1,592',
    'textures/sfx/q3dm14fog #1 500,-760,-780 840,-536,-544 70,14,12 256 0,0,-1,544'
  ],
  q3dm15: [
    'textures/sfx/hellfog_tim_dm14 #1 -408,490,-896 216,1296,-498 70,14,12 128 0,0,-1,498',
    'textures/sfx/hellfog_tim_dm14 #1 152,1368,-672 200,1608,-452 70,14,12 128 0,0,-1,452',
    'textures/sfx/hellfog_tim_dm14 #1 -400,1368,-640 -352,1608,-452 70,14,12 128 0,0,-1,452',
    'textures/sfx/hellfog_tim_dm14 #1 -224,1800,-640 24,1848,-424 70,14,12 128 0,0,-1,424'
  ],
  q3dm19: ['textures/sfx/xfinalfog #1 -1984,-2496,-4032 3520,2496,-3456 0,0,0 500 0,0,-1,3456'],
  q3dm4: ['textures/sfx/xdensegreyfog #1 -640,-1024,-384 256,-512,-256 89,89,89 1700 0,0,-1,256'],
  q3dm5: ['textures/sfx/fog_timdm2 #1 -908,-1188,-170 64,-540,-90 78,39,0 356 0,0,-1,90'],
  q3dm7: [
    'textures/sfx/hellfogdense #1 896,-1270,-632 1284,-1108,-484 70,14,12 128 0,0,-1,484',
    'textures/sfx/fog_intel #2 1004,-440,-280 1720,416,-194 95,48,0 800 0,0,-1,194'
  ],
  q3dm8: [
    'textures/sfx/fog_pjdm1 #1 320,824,-616 396,888,-360 93,93,79 300 -',
    'textures/sfx/fog_pjdm1 #1 776,-436,-44 1600,728,-28 93,93,79 300 0,0,-1,28'
  ],
  q3dm9: [
    'textures/sfx/q3dm9fog #1 -1216,448,-264 -532,1856,64 70,14,12 256 0,0,-1,-64',
    'textures/sfx/hellfogdense #2 -672,-520,-112 -308,-108,50 70,14,12 128 0,0,-1,-50',
    'textures/sfx/hellfogdense #2 -1420,-520,-96 -1088,-108,50 70,14,12 128 0,0,-1,-50',
    'textures/sfx/q3dm9fog #1 -208,248,-324 416,896,8 70,14,12 256 0,0,-1,-8',
    'textures/sfx/q3dm9fog #1 -2144,248,-324 -1520,896,8 70,14,12 256 0,0,-1,-8',
    'textures/sfx/q3dm9fog #1 -1296,-1344,-516 -432,-104,-232 70,14,12 256 0,0,-1,232'
  ],
  q3tourney2: [
    'textures/sfx/kc_hellfog_1k #1 520,-56,-256 632,56,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 -272,-848,-1032 144,0,-40 63,15,12 225 0,0,-1,40',
    'textures/sfx/kc_hellfog_1k #1 520,200,-256 648,312,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 792,192,-256 888,312,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 -1016,192,-256 -920,312,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 -776,200,-256 -648,312,24 63,15,12 225 0,0,-1,-24',
    'textures/sfx/kc_hellfog_1k #1 -760,-56,-256 -648,56,24 63,15,12 225 0,0,-1,-24'
  ],
  q3tourney3: [
    'textures/sfx/q3tourney3fog #1 -488,-384,-648 336,320,-80 70,14,12 384 0,0,-1,80',
    'textures/sfx/q3tourney3fog #1 -776,40,-648 -496,184,-80 70,14,12 384 0,0,-1,80',
    'textures/sfx/q3tourney3fog #1 -776,-248,-648 -496,-104,-80 70,14,12 384 0,0,-1,80'
  ],
  q3tourney5: ['textures/sfx/fog_timdm1 #1 736,668,-270 3472,3340,503 78,39,0 616 0,0,-1,-503']
};

/**
 * Each retail map's fogged surfaces, flares aside, by the pass each takes: depth-equal,
 * less-or-equal and none. Measured from the port.
 */
const FOGGED: Record<string, [number, number, number]> = {
  'pro-q3tourney2': [100, 11, 0],
  q3ctf1: [73, 1, 0],
  q3ctf3: [196, 2, 0],
  q3dm11: [69, 1, 0],
  q3dm12: [51, 2, 0],
  q3dm14: [167, 3, 0],
  q3dm15: [66, 4, 0],
  q3dm19: [13, 1, 0],
  q3dm4: [81, 1, 0],
  q3dm5: [114, 1, 0],
  q3dm7: [125, 2, 0],
  q3dm8: [47, 1, 0],
  q3dm9: [362, 7, 0],
  q3tourney2: [44, 7, 0],
  q3tourney3: [66, 3, 0],
  q3tourney5: [1277, 1, 14]
};

/**
 * Each retail map's batches in a fog, brush models among them: all of them, those that draw their
 * fog's pass, and those whose stages the fog dims. Measured from the port, and as the fog survey's
 * batches have them with each fog's faces added.
 */
const FOG_DRAWS: Record<string, [number, number, number]> = {
  'pro-q3tourney2': [28, 28, 0],
  q3ctf1: [7, 7, 0],
  q3ctf3: [15, 15, 0],
  q3dm11: [6, 6, 0],
  q3dm12: [11, 11, 0],
  q3dm14: [19, 19, 0],
  q3dm15: [19, 19, 0],
  q3dm19: [5, 5, 0],
  q3dm4: [6, 6, 0],
  q3dm5: [13, 13, 0],
  q3dm7: [12, 12, 0],
  q3dm8: [7, 7, 0],
  q3dm9: [58, 58, 0],
  q3tourney2: [17, 17, 0],
  q3tourney3: [18, 18, 0],
  q3tourney5: [46, 44, 2]
};

/**
 * Each retail map's shaders that its scripts sort, by `sort` or `portal`: the shader, the lightmap
 * index it was made at, its sort and its fog pass. Measured from the port, and as the survey of the
 * maps found them.
 */
const SORTED: Record<string, string[]> = {
  'pro-q3dm6': ['models/mapobjects/flag/banner_strgg -3 6 none'],
  'pro-q3tourney2': ['models/mapobjects/flag/banner_strgg -3 6 none'],
  'pro-q3tourney4': ['models/mapobjects/skull/ribcage -3 8 none'],
  q3ctf2: ['textures/sfx/bugmirror -1 1 equal'],
  q3ctf4: ['textures/ctf/blue_telep 6 10 none'],
  q3dm0: ['textures/common/mirror2 -1 1 equal', 'textures/sfx/portal_sfx -3 1 equal'],
  q3dm10: ['textures/sfx/fan3 10 6 none', 'textures/sfx/fan3bladeb -1 5 none'],
  q3dm11: ['textures/sfx/portal_sfx -3 1 equal'],
  q3dm13: ['models/mapobjects/skull/ribcage -3 8 none'],
  q3dm2: ['models/mapobjects/skull/ribcage -3 8 none'],
  q3dm4: ['models/mapobjects/flag/banner_strgg -3 6 none'],
  q3dm6: ['models/mapobjects/flag/banner_strgg -3 6 none'],
  q3dm7: ['textures/sfx/portal_sfx -3 1 equal'],
  q3dm8: [
    'textures/sfx/bugmirror -1 1 equal',
    'models/mapobjects/flag/banner_strgg -3 6 none',
    'models/mapobjects/skull/ribcage -3 8 none',
    'models/mapobjects/weeds/weed02 -3 8 none'
  ],
  q3tourney2: ['models/mapobjects/flag/banner_strgg -3 6 none'],
  q3tourney4: ['models/mapobjects/skull/ribcage -3 8 none'],
  q3tourney6: ['textures/common/mirror2 -1 1 equal'],
  q3tourney6_ctf: ['textures/common/mirror2 -1 1 equal']
};

describe.skipIf(!haveFullSet)("the 36 retail maps' skies, fogs and sorts", () => {
  /** Each map's skies, as {@link SKIES} lists them. */
  let skies: Record<string, string[]>;
  /** Each map's sky batches, as {@link SKY_BATCHES} counts them. */
  let skyBatches: Record<string, number[]>;
  /** Each map's fogs, as {@link FOGS} lists them, for the maps with any. */
  let fogs: Record<string, string[]>;
  /** Each map's fogged surfaces by their pass, as {@link FOGGED} counts them. */
  let fogged: Record<string, number[]>;
  /** The map, shader and adjustments of each fogged surface that takes no pass. */
  let adjusted: Set<string>;
  /** Each map's batches in a fog, as {@link FOG_DRAWS} counts them. */
  let fogDraws: Record<string, number[]>;
  /** The maps whose fogs' shaders were not the first registered, after the default. */
  let fogsLate: string[];
  /** Each map's shaders its scripts sort, as {@link SORTED} lists them, for the maps with any. */
  let sorted: Record<string, string[]>;
  let warnings: string[];

  beforeAll(async () => {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    const texts: string[] = [];
    for (const path of shaderTextOrder(fs)) texts.push((await fs.readText(path)) ?? '');
    warnings = [];
    const sources: ShaderSources = {
      scripts: parseShaderScripts(texts),
      hasImage: (name) => fs.resolveImage(name) !== undefined,
      warn: (text) => warnings.push(text)
    };
    skies = {};
    skyBatches = {};
    fogs = {};
    fogged = {};
    adjusted = new Set();
    fogDraws = {};
    fogsLate = [];
    sorted = {};
    for (const path of fs.list('maps/', 'bsp')) {
      const map = path.slice('maps/'.length, -'.bsp'.length);
      const bsp = parseBsp(await fs.readRequired(path), path);
      const shaders = loadWorldShaders(bsp, sources);
      const poses = brushModelsAtRest(readEntities(bsp.entityString), bsp.models);
      const models = poses.map((pose) => pose.model);
      const all = worldBatches(bsp, shaders, models, loadPatchGrids(bsp, 1, 4));
      const batches = all.filter((batch) => shaders.shaders[batch.shader].sky);
      const indexes = batches.reduce((n, batch) => n + batch.numIndexes, 0);
      skyBatches[map] = [surfacesDrawn(batches), indexes / 3, batches.length];
      skies[map] = shaders.shaders
        .filter((shader) => shader.sky)
        .map(({ name, lightmapIndex, sort, sky }) => {
          const box = sky!.box;
          const faces = box ? box.filter((face) => face !== DEFAULT_IMAGE).length : 0;
          const boxed = box ? `${box[0].slice(0, -'_rt.tga'.length)} (${faces} faces)` : '-';
          return `${name} ${lightmapIndex} ${sort} ${shaders.cloudHeight} ${boxed}`;
        });
      const scripted = shaders.shaders
        .filter(({ script }) => script?.sort)
        .map(({ name, lightmapIndex, sort, fogPass }) =>
          [name, lightmapIndex, sort, fogPass].join(' ')
        );
      if (scripted.length > 0) sorted[map] = scripted;

      if (bsp.fogs.length === 0) continue;
      const named = (name: string) =>
        shaders.shaders.findIndex((shader) => shader.name.toLowerCase() === name.toLowerCase());
      fogs[map] = shaders.fogs.map(({ bounds: [mins, maxs], parms, surface }, i) => {
        const { shader } = bsp.fogs[i];
        const color = fogColor(parms, identityLight(CLASSIC_FULLSCREEN)).slice(0, 3);
        const fields = [mins, maxs, color, [parms.depthForOpaque], surface ?? ['-']];
        return `${shader} #${named(shader)} ${fields.map((field) => field.join(',')).join(' ')}`;
      });
      const firsts = [...new Set(bsp.fogs.map((fog) => fog.shader.toLowerCase()))];
      if (firsts.some((name, k) => named(name) !== k + 1)) fogsLate.push(map);
      const passes = { equal: 0, lessEqual: 0, none: 0 };
      bsp.surfaces.forEach((surface, i) => {
        if (surface.fogNum < 0 || surface.surfaceType === MST_FLARE) return;
        const shader = shaders.shaders[shaders.surfaceShaders[i]];
        passes[shader.fogPass]++;
        if (shader.fogPass === 'none') {
          adjusted.add(`${map} ${shader.name} ${shader.fogAdjustments.join(',')}`);
        }
      });
      fogged[map] = [passes.equal, passes.lessEqual, passes.none];
      const inFog = all.filter((batch) => batch.fog > 0);
      const shaderOf = (batch: WorldBatch) => shaders.shaders[batch.shader];
      fogDraws[map] = [
        inFog.length,
        inFog.filter((batch) => fogPassOf(shaderOf(batch), batch.fog)).length,
        inFog.filter((batch) => shaderOf(batch).fogAdjustments.some((a) => a !== 'none')).length
      ];
    }
  }, 60_000);

  it('has each sky the shaders make, its clouds at its height and its box where found', () => {
    expect(skies).toEqual(SKIES);
    expect(warnings.filter((text) => text.includes('skyParms'))).toEqual([]);
  });

  it("batches each map's sky as the world's are", () => {
    expect(skyBatches).toEqual(SKY_BATCHES);
  });

  it("loads each map's fogs, their shaders registered first", () => {
    expect(fogs).toEqual(FOGS);
    expect(fogsLate).toEqual([]);
    expect(warnings.filter((text) => /fogParms|parenthesis|vector element/.test(text))).toEqual([]);
  });

  it("gives each map's fogged surfaces their pass, and dims q3tourney5's flames instead", () => {
    expect(fogged).toEqual(FOGGED);
    expect([...adjusted].sort()).toEqual([
      'q3tourney5 textures/sfx/flame1side rgb,rgb,rgb',
      'q3tourney5 textures/sfx/xflame1side rgb,rgb,rgb'
    ]);
  });

  it("draws each fogged batch's pass, and dims q3tourney5's flames instead", () => {
    expect(fogDraws).toEqual(FOG_DRAWS);
  });

  it('sorts each shader its script sorts as FinishShader does, and gives it its fog pass by it', () => {
    expect(sorted).toEqual(SORTED);
  });
});

describe.skipIf(!haveFullSet)("the 36 retail maps' curves, stitched", () => {
  let maps: Map<string, (number | string)[]>;
  beforeAll(async () => {
    const zoneId = new Float32Array(new Uint32Array([0x1d4a11]).buffer)[0];
    const tables = (grid: PatchGrid) => [...grid.widthLodError, ...grid.heightLodError];
    maps = await retailMaps((bytes, path) => {
      const bsp = parseBsp(bytes, path);
      const grids = bsp.surfaces.map((surface, i) =>
        surface.surfaceType === MST_PATCH ? parseMesh(bsp, i, 1, 4) : null
      );
      const stitches = stitchAllPatches(grids);
      const before = grids.map((grid) => grid && tables(grid));
      fixSharedVertexLodError(grids);
      const made = grids.filter((grid) => grid !== null);
      const fixed = grids.map((grid, i) =>
        grid ? tables(grid).filter((error, k) => error !== before[i]![k]).length : 0
      );
      return [
        stitches,
        made.reduce((n, grid) => n + tables(grid).filter((error) => error === zoneId).length, 0),
        fixed.reduce((n, count) => n + count, 0),
        made.reduce((n, grid) => n + grid.width * grid.height, 0),
        made.reduce((n, grid) => n + (grid.width - 1) * (grid.height - 1) * 2, 0),
        `${Math.max(0, ...made.map((grid) => grid.width))}x` +
          `${Math.max(0, ...made.map((grid) => grid.height))}`
      ];
    });
  }, 60_000);

  it("stitches each map's cracks, and fixes its errors, as Q3 does", () => {
    // The stitches are what Q3's console prints for each map (`stitched <n> LoD cracks`). The rest
    // were measured from the port; an independent port of the same code agrees, counting the fix by
    // its writes rather than the entries changed.
    expect(Object.fromEntries(maps)).toEqual(STITCHED);
  });
});

describe.skipIf(!haveFullSet)("the capture views' visible sets", () => {
  /** The capture's seven maps. */
  const maps = new Map<string, Bsp>();
  /** A map with doors across its areas' portals. */
  let doors: Bsp;
  let sources: ShaderSources;

  beforeAll(async () => {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    const texts: string[] = [];
    for (const path of shaderTextOrder(fs)) texts.push((await fs.readText(path)) ?? '');
    sources = {
      scripts: parseShaderScripts(texts),
      hasImage: (name) => fs.resolveImage(name) !== undefined,
      warn: () => {}
    };
    for (const map of [...MAPS, 'q3tourney5']) {
      maps.set(map, parseBsp(await fs.readRequired(`maps/${map}.bsp`), map));
    }
    doors = parseBsp(await fs.readRequired('maps/q3dm12.bsp'), 'q3dm12');
  }, 60_000);

  /** A view's counts as `r_speeds 1` and `5` print them, on one line. */
  const speedsLine = (s: ReturnType<typeof viewSpeeds>) =>
    `${s.shaders}/${s.surfaces} shaders/surfs ${s.leafs} leafs ${s.vertexes} verts ` +
    `${s.triangles}/${s.passTriangles} tris zFar: ${s.zFar}`;

  it('finds what each capture view sees as opengl1 does', () => {
    const views = [];
    for (const [map, bsp] of maps) {
      const shaders = loadWorldShaders(bsp, sources);
      // The same shaders in the same order, with their pairs merged as Q3's defaults merge them.
      const merged = loadWorldShaders(bsp, sources, false, {
        multitexture: true,
        textureEnvAdd: true
      }).shaders;
      const curves = loadPatchGrids(bsp, 1, 4);
      const entities = readEntities(bsp.entityString);
      const poses = brushModelsAtRest(entities, bsp.models);
      const runs = worldRuns(bsp, shaders, poses.map((pose) => pose.model), curves);
      const vis = new WorldVis(bsp, shaders, curves, poses, () => {});
      // The capture's view: the spectator's start, 90° across at 4:3.
      const start = spectatorStart(entities, () => 0);
      vis.view(start, 90, verticalFov(90), EVERY_SWITCH, OPEN_AREAS);
      const added = Array.from(vis.surfaces.subarray(0, vis.count));
      const world = bsp.models[0].numSurfaces;
      const drawn = new Set(runs.flatMap((run) => run.surfaces));
      const worldDrawn = added.filter((surface) => surface < world && drawn.has(surface)).length;
      const clusters = bsp.visibility?.numClusters;
      const zFar = Math.round(vis.zFar);
      // The batches the view draws, each curve at the rows it keeps.
      const detail = new WorldIndexes(bsp, runs, curves, gridBases(bsp, curves, drawn), poses);
      detail.view(vis, start.origin, angleVectors(start.angles).forward, 250, () => {});
      let [batches, draws, mergedDraws, indexes] = [0, 0, 0, 0];
      detail.runs.forEach((run, r) => {
        const shown = run.batches.filter((batch) => batch.count > 0).length;
        batches += shown;
        draws += shown * drawsOf(shaders.shaders[runs[r].shader], runs[r].fog);
        mergedDraws += shown * drawsOf(merged[runs[r].shader], runs[r].fog);
        indexes += run.used;
      });
      views.push([
        map,
        clusters,
        vis.viewCluster,
        vis.leafs,
        worldDrawn,
        added.length,
        zFar,
        [batches, draws, mergedDraws, indexes]
      ]);
    }
    // The map's clusters, the eye's, the leafs reached, the world's surfaces drawn of those added,
    // every surface added, brush models' and those drawing nothing among them, the far plane, and
    // the batches, draws, draws with pairs merged, and indexes drawn. As an independent walk of the
    // same views in doubles counts them, but for the surfaces added. Its batches drew every brush
    // model whole: q3dm11's differ by the 21 batches of its 13, of which `*20` alone is seen here,
    // in 2.
    expect(views).toEqual([
      ['q3dm1', 942, 272, 274, 503, 503, 1598, [57, 119, 75, 8295]],
      ['q3dm4', 1678, 1287, 265, 417, 447, 1600, [42, 85, 54, 14097]],
      ['q3dm9', 2197, 293, 195, 355, 355, 1038, [55, 128, 75, 4761]],
      ['q3dm10', 1382, 948, 256, 471, 501, 1435, [45, 98, 74, 6501]],
      ['q3dm11', 3210, 388, 167, 720, 806, 1347, [49, 111, 71, 6696]],
      ['q3dm17', 424, 5, 395, 701, 714, 4878, [44, 88, 61, 10323]],
      ['q3tourney5', 329, 88, 151, 393, 394, 2411, [36, 103, 76, 4452]]
    ]);
  });

  it("counts each capture view as Quake 3's r_speeds 1 and 5 print it, lit and fullbright", () => {
    const lines = [];
    for (const fullbright of [false, true]) {
      for (const [map, bsp] of maps) {
        // As the capture draws it: no entity, and pairs merged as Q3's defaults merge them.
        const shaders = loadWorldShaders(bsp, sources, fullbright, {
          multitexture: true,
          textureEnvAdd: true
        });
        const curves = loadPatchGrids(bsp, 1, 4);
        const entities = readEntities(bsp.entityString);
        const poses = brushModelsAtRest(entities, bsp.models);
        const runs = worldRuns(bsp, shaders, poses.map((pose) => pose.model), curves);
        const vis = new WorldVis(bsp, shaders, curves, poses, () => {});
        const start = spectatorStart(entities, () => 0);
        vis.view(start, 90, verticalFov(90), { ...EVERY_SWITCH, entities: false }, OPEN_AREAS);
        const drawn = new Set(runs.flatMap((run) => run.surfaces));
        const detail = new WorldIndexes(bsp, runs, curves, gridBases(bsp, curves, drawn), poses);
        detail.view(vis, start.origin, angleVectors(start.angles).forward, 250, () => {});
        const passes = runs.map((run) => shaders.shaders[run.shader].stages.length);
        lines.push([
          map,
          fullbright ? 'unlit' : 'lit',
          speedsLine(viewSpeeds(vis, detail.runs, passes))
        ]);
      }
    }
    // What Quake 3's console printed at each view, in a window and under `r_fullbright`, with no
    // entity drawn. Its game closed no area these views show.
    expect(lines).toEqual([
      ['q3dm1', 'lit', '57/503 shaders/surfs 274 leafs 3682 verts 2765/2886 tris zFar: 1598'],
      ['q3dm4', 'lit', '42/447 shaders/surfs 265 leafs 4496 verts 4699/7165 tris zFar: 1600'],
      ['q3dm9', 'lit', '55/355 shaders/surfs 195 leafs 2078 verts 1587/1627 tris zFar: 1038'],
      ['q3dm10', 'lit', '43/481 shaders/surfs 256 leafs 3046 verts 2127/2933 tris zFar: 1435'],
      ['q3dm11', 'lit', '47/725 shaders/surfs 167 leafs 3354 verts 1922/2746 tris zFar: 1347'],
      ['q3dm17', 'lit', '44/714 shaders/surfs 395 leafs 4913 verts 3441/4535 tris zFar: 4878'],
      ['q3tourney5', 'lit', '36/394 shaders/surfs 151 leafs 2217 verts 1484/1512 tris zFar: 2411'],
      ['q3dm1', 'unlit', '53/503 shaders/surfs 274 leafs 3687 verts 2765/5488 tris zFar: 1598'],
      ['q3dm4', 'unlit', '34/447 shaders/surfs 265 leafs 4496 verts 4699/9436 tris zFar: 1600'],
      ['q3dm9', 'unlit', '46/355 shaders/surfs 195 leafs 2078 verts 1587/3188 tris zFar: 1038'],
      ['q3dm10', 'unlit', '37/481 shaders/surfs 256 leafs 3046 verts 2127/4233 tris zFar: 1435'],
      ['q3dm11', 'unlit', '40/725 shaders/surfs 167 leafs 3354 verts 1922/3881 tris zFar: 1347'],
      ['q3dm17', 'unlit', '38/714 shaders/surfs 395 leafs 4913 verts 3441/6699 tris zFar: 4878'],
      ['q3tourney5', 'unlit', '33/394 shaders/surfs 151 leafs 2217 verts 1484/2948 tris zFar: 2411']
    ]);
  });

  it('counts a view facing a shut door as Quake 3 printed it, the areas past it closed', () => {
    const shaders = loadWorldShaders(doors, sources, false, {
      multitexture: true,
      textureEnvAdd: true
    });
    const curves = loadPatchGrids(doors, 1, 4);
    const poses = brushModelsAtRest(readEntities(doors.entityString), doors.models);
    const runs = worldRuns(doors, shaders, poses.map((pose) => pose.model), curves);
    const drawn = new Set(runs.flatMap((run) => run.surfaces));
    const bases = gridBases(doors, curves, drawn);
    const passes = runs.map((run) => shaders.shaders[run.shader].stages.length);
    const cm = loadMap(doors, 'q3dm12');
    const lines = [];
    // A spectator at q3dm12's intermission point, moved to the door `*3/*4` in a scratch pak, and
    // 264 units nearer, looking north at it, shut across the portal from area 2 to area 4.
    for (const y of [-1864, -1600]) {
      const view = { origin: vec3(608, y, -149), angles: vec3(0, 90, 0) };
      // `SV_BuildClientSnapshot`'s mask from that eye, every portal shut: all but its own area
      // closed.
      const areamask = new Uint8Array(32);
      writeAreaBits(cm, areamask, leafArea(cm, pointLeafnum(cm, [608, y, -149])));
      for (let i = 0; i < 32; i++) areamask[i] ^= 0xff;
      for (const mask of [areamask, OPEN_AREAS]) {
        const vis = new WorldVis(doors, shaders, curves, poses, () => {});
        vis.view(view, 90, verticalFov(90), { ...EVERY_SWITCH, entities: false }, mask);
        const detail = new WorldIndexes(doors, runs, curves, bases, poses);
        detail.view(vis, view.origin, angleVectors(view.angles).forward, 250, () => {});
        lines.push(speedsLine(viewSpeeds(vis, detail.runs, passes)));
      }
    }
    // What Quake 3's console printed at each view, in a window, under its own game's mask; then
    // what the port reaches with no area closed.
    expect(lines).toEqual([
      '19/169 shaders/surfs 27 leafs 798 verts 491/916 tris zFar: 650',
      '91/911 shaders/surfs 262 leafs 4728 verts 2972/4786 tris zFar: 3114',
      '17/107 shaders/surfs 21 leafs 493 verts 296/557 tris zFar: 381',
      '93/981 shaders/surfs 308 leafs 5087 verts 3201/5023 tris zFar: 2898'
    ]);
  });
});
