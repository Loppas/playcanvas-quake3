import { beforeAll, describe, expect, it } from 'vitest';

import { MST_PATCH, parseBsp, type Bsp } from '../../formats/bsp';
import { retailMaps } from '../../formats/bsp-test-fixtures';
import { havePak } from '../../pak/pak-test-fixtures';
import { CONTENTS } from '../constants';
import { BOX_MODEL_HANDLE } from './cm-local';
import { clipBsp, surveyLoad } from './collision-test-fixtures';
import {
  clipHandleToModel,
  emptyClipMap,
  entityString,
  inlineModel,
  leafArea,
  leafCluster,
  loadMap,
  modelBounds,
  numInlineModels,
  tempBoxModel
} from './cm-load';

const NAME = 'maps/test.bsp';

/** The map loaded, its messages kept. */
function load(bsp: Bsp = clipBsp()) {
  const printed: string[] = [];
  const cm = loadMap(bsp, NAME, { print: (text) => printed.push(text) });
  return { cm, printed };
}

/** The message a map is refused with, or `undefined` if it loads. */
function refusal(bsp: Bsp): string | undefined {
  try {
    loadMap(bsp, NAME, { print: () => {} });
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
}

/** The port's words for an index that lies outside what it indexes. */
const missing = (what: string) => `CM_LoadMap: ${NAME}'s ${what}, which the map has not got`;

describe('loadMap', () => {
  const { cm } = load();

  it("types each plane as Q3 does, axial only for a normal of +1, with its sign bits", () => {
    expect(cm.numPlanes).toBe(7);
    expect(cm.planes.slice(0, 7).map(({ type, signbits }) => [type, signbits])).toEqual([
      [3, 1],
      [0, 0],
      [3, 2],
      [1, 0],
      [3, 4],
      [2, 0],
      [3, 2]
    ]);
    expect(cm.planes[6].normal).toEqual([Math.fround(0.6), Math.fround(-0.8), 0]);
  });

  it("takes each side's surface flags and each brush's contents from their shaders", () => {
    expect(cm.numBrushSides).toBe(6);
    cm.brushsides.slice(0, 6).forEach((side, i) => {
      expect(side.plane).toBe(cm.planes[i]);
      expect(side.surfaceFlags).toBe(0x12);
    });
    expect(cm.numBrushes).toBe(2);
    expect(cm.brushes.slice(0, 2).map((b) => [b.contents, b.numsides, b.firstSide])).toEqual([
      [CONTENTS.SOLID, 6, 0],
      [32, 6, 0]
    ]);
  });

  it("bounds a brush by its first six sides' distances, −x first", () => {
    expect(cm.brushes[0].bounds).toEqual([
      [-64, -64, -64],
      [64, 64, 64]
    ]);
    const skewed = load(
      clipBsp({
        planes: [-10, 20, -30, 40, -50, 60].map((dist, i) => ({
          normal: [i < 2 ? 1 : 0, i >> 1 === 1 ? 1 : 0, i >> 1 === 2 ? 1 : 0],
          dist
        }))
      })
    ).cm;
    expect(skewed.brushes[0].bounds).toEqual([
      [10, 30, 50],
      [20, 40, 60]
    ]);
  });

  it('counts clusters and areas from the leafs, the box past them', () => {
    expect(cm.numLeafs).toBe(3);
    expect(cm.leafs).toHaveLength(3 + 2);
    expect(cm.numClusters).toBe(2);
    expect(cm.numAreas).toBe(3);
    expect(cm.areas).toHaveLength(3);
    expect(cm.areaPortals).toEqual(new Int32Array(9));
  });

  it("spreads each model's bounds by a unit, in floats", () => {
    expect(cm.numSubModels).toBe(2);
    expect(cm.cmodels[0].mins).toEqual([-65, -65, -65]);
    expect(cm.cmodels[0].maxs).toEqual([65, 65, 65]);
    // 0.1 as a float, less 1, rounded to a float again.
    expect(cm.cmodels[1].mins).toEqual([-0.8999999761581421, -1, -65]);
  });

  it("makes each inline model a leaf of its own, listed after the map's and the box's", () => {
    expect(cm.numLeafBrushes).toBe(1);
    expect(Array.from(cm.leafbrushes)).toEqual([0, 2, 1]);
    expect(cm.numLeafSurfaces).toBe(1);
    expect(Array.from(cm.leafsurfaces)).toEqual([0, 1]);
    expect(cm.cmodels[1].leaf).toEqual({
      cluster: 0,
      area: 0,
      firstLeafBrush: 2,
      numLeafBrushes: 1,
      firstLeafSurface: 1,
      numLeafSurfaces: 1
    });
    expect(cm.cmodels[0].leaf.numLeafBrushes).toBe(0);

    const base = clipBsp();
    const both = load(
      clipBsp({ models: [base.models[0], { ...base.models[1], firstBrush: 0, numBrushes: 2 }] })
    ).cm;
    expect(Array.from(both.leafbrushes)).toEqual([0, 2, 0, 1]);
  });

  it('keeps the nodes, the entity text and a patch for each patch surface', () => {
    expect(cm.numNodes).toBe(1);
    expect(cm.nodes[0].plane).toBe(cm.planes[5]);
    expect(cm.nodes[0].children).toEqual([-1, -2]);
    expect(cm.entityString).toBe('{ "classname" "worldspawn" }\0');
    expect(entityString(cm)).toBe(cm.entityString);
    expect(cm.numSurfaces).toBe(2);
    expect(cm.surfaces[0]).toBeNull();
    expect(cm.surfaces[1]).toMatchObject({ checkcount: 0, contents: 1, surfaceFlags: 0x12 });
    expect(cm.surfaces[1]!.pc.numFacets).toBe(1);
  });

  it('sees every cluster from each without visibility, in rows of 32 bytes', () => {
    expect(cm.vised).toBe(false);
    expect(cm.clusterBytes).toBe(32);
    expect(cm.visibility).toEqual(new Uint8Array(32).fill(255));
  });

  it("takes the visibility's clusters and row length from its header", () => {
    const data = Uint8Array.of(1, 3, 2, 0);
    const vised = load(clipBsp({ visibility: { numClusters: 4, clusterBytes: 1, data } })).cm;
    expect(vised.vised).toBe(true);
    expect(vised.numClusters).toBe(4);
    expect(vised.clusterBytes).toBe(1);
    expect(vised.visibility).toBe(data);
  });

  it("floods each area alone while no portal is open", () => {
    expect(cm.floodvalid).toBe(1);
    expect(cm.areas.map(({ floodnum, floodvalid }) => [floodnum, floodvalid])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1]
    ]);
  });

  it("reads collision's cvars as Q3 registers them, unless told otherwise", () => {
    expect(cm.cvars).toEqual({ noAreas: 0, noCurves: 0, playerCurveClip: 1 });
    const told = loadMap(clipBsp(), NAME, { cvars: { noCurves: 1 } });
    expect(told.cvars).toEqual({ noAreas: 0, noCurves: 1, playerCurveClip: 1 });
  });

  it("prints a patch's warnings where it is told to", () => {
    const bowtie = [0, 0, 0, 32, 0, 0, 64, 0, 0, 0, 32, 0, 16, 16, 0, 32, 0, 0, 0, 64, 0, 0, 32, 0];
    const bsp = clipBsp();
    bsp.drawVerts.xyz = Float32Array.from([...bowtie, 0, 0, 0]);
    expect(load(bsp).printed).toEqual(new Array(4).fill('WARNING: CM_GridPlane unresolvable\n'));
  });
});

describe("loadMap's box hull", () => {
  const { cm } = load();

  it("sets up the box's twelve planes past the map's, its negative ones typed as slanted", () => {
    expect(cm.boxPlanes).toBe(7);
    const box = cm.planes.slice(7, 19);
    expect(box.map(({ normal, type, signbits }) => [...normal, type, signbits])).toEqual([
      [1, 0, 0, 0, 0],
      [-1, 0, 0, 3, 1],
      [1, 0, 0, 0, 0],
      [-1, 0, 0, 3, 1],
      [0, 1, 0, 1, 0],
      [0, -1, 0, 4, 2],
      [0, 1, 0, 1, 0],
      [0, -1, 0, 4, 2],
      [0, 0, 1, 2, 0],
      [0, 0, -1, 5, 4],
      [0, 0, 1, 2, 0],
      [0, 0, -1, 5, 4]
    ]);
  });

  it('makes the box a brush of six sides, +x, −x, +y, −y, +z and −z, of CONTENTS_BODY', () => {
    expect(cm.boxBrush).toBe(cm.brushes[2]);
    expect(cm.boxBrush).toMatchObject({ numsides: 6, firstSide: 6, contents: CONTENTS.BODY });
    expect(cm.brushsides.slice(6).map((side) => cm.planes.indexOf(side.plane))).toEqual([
      7, 10, 11, 14, 15, 18
    ]);
    expect(cm.brushsides.slice(6).every((side) => side.surfaceFlags === 0)).toBe(true);
    expect(cm.boxModel.leaf).toMatchObject({ firstLeafBrush: 1, numLeafBrushes: 1 });
    expect(cm.leafbrushes[1]).toBe(2);
  });

  it('moves the one box to each set of bounds it is given', () => {
    expect(tempBoxModel(cm, [-15, -15, -24], [15, 15, 32])).toBe(BOX_MODEL_HANDLE);
    expect(cm.planes.slice(7, 19).map((p) => p.dist)).toEqual([
      15, -15, -15, 15, 15, -15, -15, 15, 32, -32, -24, 24
    ]);
    expect(cm.boxBrush.bounds).toEqual([
      [-15, -15, -24],
      [15, 15, 32]
    ]);
    expect([cm.boxModel.mins, cm.boxModel.maxs]).toEqual(cm.boxBrush.bounds);

    tempBoxModel(cm, [-1, -2, -3], [4, 5, 6]);
    expect(cm.brushsides.slice(6).map((side) => side.plane.dist)).toEqual([4, 1, 5, 2, 6, 3]);
  });
});

describe('emptyClipMap', () => {
  const cm = emptyClipMap();

  it('is the map of no name: one leaf, cluster and area, and a world model of nothing', () => {
    expect([cm.name, cm.entityString]).toEqual(['', '']);
    expect([cm.numLeafs, cm.numClusters, cm.numAreas]).toEqual([1, 1, 1]);
    const none = [cm.numSubModels, cm.numBrushes, cm.numBrushSides, cm.numLeafBrushes];
    expect([...none, cm.numSurfaces]).toEqual([0, 0, 0, 0, 0]);
    expect(cm.cmodels).toHaveLength(1);
    expect(cm.cmodels[0]).toMatchObject({ mins: [0, 0, 0], maxs: [0, 0, 0] });
    expect(cm.cmodels[0].leaf).toMatchObject({ numLeafBrushes: 0, numLeafSurfaces: 0 });
  });

  it('has a node, both its sides the one leaf, so that CM_Trace runs on it', () => {
    expect(cm.numNodes).toBe(1);
    expect(cm.nodes[0].children).toEqual([-1, -1]);
    expect(cm.nodes[0].plane).toBe(cm.planes[0]);
  });

  it("sets the box hull up past the node's plane, as a map's load does", () => {
    expect(cm.boxPlanes).toBe(1);
    expect(cm.boxBrush).toBe(cm.brushes[0]);
    expect(cm.boxBrush).toMatchObject({ numsides: 6, firstSide: 0, contents: CONTENTS.BODY });
    expect(cm.brushsides.map((side) => cm.planes.indexOf(side.plane))).toEqual([
      1, 4, 5, 8, 9, 12
    ]);
    expect(cm.boxModel.leaf).toMatchObject({ firstLeafBrush: 0, numLeafBrushes: 1 });
    expect(cm.leafbrushes[0]).toBe(0);

    expect(tempBoxModel(cm, [-15, -15, -24], [15, 15, 32])).toBe(BOX_MODEL_HANDLE);
    expect(cm.planes.slice(1).map((p) => p.dist)).toEqual([
      15, -15, -15, 15, 15, -15, -15, 15, 32, -32, -24, 24
    ]);
  });

  it("refuses the world's handle in Q3's words, as a map of no models has none", () => {
    expect(() => clipHandleToModel(cm, 0)).toThrow('CM_ClipHandleToModel: bad handle 0 < 0 < 256');
  });
});

describe("loadMap's clip handles and leafs", () => {
  const { cm } = load();

  it('names a model by its number, and the box by 255', () => {
    expect(clipHandleToModel(cm, 0)).toBe(cm.cmodels[0]);
    expect(clipHandleToModel(cm, 1)).toBe(cm.cmodels[1]);
    expect(clipHandleToModel(cm, 255)).toBe(cm.boxModel);
  });

  it("refuses any other handle in Q3's words, the capsule's among them", () => {
    expect(() => clipHandleToModel(cm, -1)).toThrow('CM_ClipHandleToModel: bad handle -1');
    expect(() => clipHandleToModel(cm, 2)).toThrow(
      'CM_ClipHandleToModel: bad handle 2 < 2 < 256'
    );
    expect(() => clipHandleToModel(cm, 254)).toThrow(
      'CM_ClipHandleToModel: bad handle 2 < 254 < 256'
    );
    expect(() => clipHandleToModel(cm, 256)).toThrow('CM_ClipHandleToModel: bad handle 512');
  });

  it("takes 255 for a map's 256th model before the box, as Q3 does", () => {
    const world = clipBsp().models[0];
    const models = Array.from({ length: 256 }, () => ({ ...world, numBrushes: 0 }));
    const full = load(clipBsp({ models })).cm;
    expect(clipHandleToModel(full, 255)).toBe(full.cmodels[255]);
  });

  it("gives an inline model's handle, its bounds, and how many there are", () => {
    expect(numInlineModels(cm)).toBe(2);
    expect(inlineModel(cm, 1)).toBe(1);
    expect(() => inlineModel(cm, 2)).toThrow('CM_InlineModel: bad number');
    expect(() => inlineModel(cm, -1)).toThrow('CM_InlineModel: bad number');
    const mins = [0, 0, 0];
    const maxs = [0, 0, 0];
    modelBounds(cm, 1, mins, maxs);
    expect([mins, maxs]).toEqual([cm.cmodels[1].mins, cm.cmodels[1].maxs]);
  });

  it("gives a leaf's cluster and area, refusing a leaf the map has not got", () => {
    expect([0, 1, 2].map((leaf) => [leafCluster(cm, leaf), leafArea(cm, leaf)])).toEqual([
      [0, 0],
      [-1, -1],
      [1, 2]
    ]);
    expect(() => leafCluster(cm, 3)).toThrow('CM_LeafCluster: bad number');
    expect(() => leafArea(cm, -1)).toThrow('CM_LeafArea: bad number');
  });
});

describe("loadMap's checks", () => {
  it("refuses an empty name in Q3's words", () => {
    expect(() => loadMap(clipBsp(), '')).toThrow('CM_LoadMap: NULL name');
  });

  it("refuses more than 256 models, and a patch of more than 1024 points, in Q3's words", () => {
    const models = Array.from({ length: 257 }, () => clipBsp().models[0]);
    expect(refusal(clipBsp({ models }))).toBe('MAX_SUBMODELS exceeded');
    const bsp = clipBsp();
    bsp.surfaces[1] = { ...bsp.surfaces[1], patchWidth: 33, patchHeight: 33 };
    expect(refusal(bsp)).toBe('ParseMesh: MAX_PATCH_VERTS');
  });

  it("refuses an index Q3 would read past, in the port's words", () => {
    const base = clipBsp();
    const leaf = (fields: object) => ({ leafs: [{ ...base.leafs[0], ...fields }] });
    const model1 = (fields: object) => ({
      models: [base.models[0], { ...base.models[1], ...fields }]
    });
    const node = (fields: object) => ({ nodes: [{ ...base.nodes[0], ...fields }] });
    const patch = (fields: object) => ({
      surfaces: [base.surfaces[0], { ...base.surfaces[1], ...fields }]
    });
    const brush = (firstSide: number, numSides: number) => [{ firstSide, numSides, shaderNum: 0 }];
    const cases: [Partial<Bsp>, string][] = [
      [leaf({ firstLeafBrush: 1 }), "leaf 0's leaf brushes 1 on"],
      [leaf({ firstLeafSurface: 1 }), "leaf 0's leaf surfaces 1 on"],
      [{ leafBrushes: Int32Array.of(5) }, "leaf brush 0's brush 5"],
      [{ leafSurfaces: Int32Array.of(9) }, "leaf surface 0's surface 9"],
      [{ brushSides: [{ planeNum: 7, shaderNum: 0 }] }, "brush side 0's plane 7"],
      [{ brushes: brush(1, 6) }, "brush 0's sides 1 on"],
      [{ brushes: brush(2, 4) }, "brush 0's sides 2 on"],
      [model1({ firstBrush: 2 }), "model 1's brushes 2 on"],
      [model1({ firstSurface: 2 }), "model 1's surfaces 2 on"],
      [node({ planeNum: 9 }), "node 0's plane 9"],
      [node({ children: [3, -1] }), "node 0's child 3"],
      [node({ children: [-4, -1] }), "node 0's child -4"],
      [patch({ firstVert: 1 }), "surface 1's vertices"],
      [patch({ shaderNum: 3 }), "surface 1's shader"]
    ];
    for (const [parts, what] of cases) expect(refusal(clipBsp(parts)), what).toBe(missing(what));
  });

  it("reads a brush's six sides into the next brush's, as Q3 does, when it has fewer", () => {
    const sides = [0, 1, 2, 3, 4, 5, 0, 1, 2, 3].map((planeNum) => ({ planeNum, shaderNum: 0 }));
    const bsp = clipBsp({
      brushes: [
        { firstSide: 0, numSides: 4, shaderNum: 0 },
        { firstSide: 4, numSides: 6, shaderNum: 0 }
      ],
      brushSides: sides
    });
    expect(load(bsp).cm.brushes[0].bounds).toEqual([
      [-64, -64, -64],
      [64, 64, 64]
    ]);
  });

  it("refuses in the order Q3's loaders read: leafs, leaf brushes, sides, models, nodes", () => {
    const base = clipBsp();
    const faults: Partial<Bsp>[] = [
      { leafs: [{ ...base.leafs[0], firstLeafSurface: 1 }] },
      { leafBrushes: Int32Array.of(5) },
      { brushSides: [{ planeNum: 7, shaderNum: 0 }] },
      { models: [base.models[0], { ...base.models[1], firstBrush: 2 }] },
      { nodes: [{ ...base.nodes[0], planeNum: 9 }] },
      { surfaces: [base.surfaces[0], { ...base.surfaces[1], shaderNum: 3 }] }
    ];
    const messages = [
      "leaf 0's leaf surfaces 1 on",
      "leaf brush 0's brush 5",
      "brush side 0's plane 7",
      "model 1's brushes 2 on",
      "node 0's plane 9",
      "surface 1's shader"
    ];
    faults.forEach((_, i) => {
      const bsp = clipBsp(Object.assign({}, ...faults.slice(i)));
      expect(refusal(bsp), messages[i]).toBe(missing(messages[i]));
    });
  });

  it('loads only patch surfaces as patches', () => {
    const bsp = clipBsp();
    expect(bsp.surfaces[1].surfaceType).toBe(MST_PATCH);
    bsp.surfaces[1] = { ...bsp.surfaces[1], surfaceType: 3 };
    expect(load(bsp).cm.surfaces).toEqual([null, null]);
  });
});

/**
 * The twin's load of each retail map (scratchpad `m0/stats.txt`): ioquake3's own `CM_LoadMap`,
 * compiled and run over the map. Brushes, sides, planes, leafs, leaf brushes, models, clusters,
 * areas and whether the map is vised; then patches, their facets and planes, the most facets and
 * planes in one patch, all their borders, and a digest of every patch's bounds, planes and facets
 * as bits.
 */
const TWIN: Record<string, (number | string)[]> = {
  'pro-q3dm13': [
    1818, 12708, 5358, 3980, 8648, 4, 2004, 2, 1, 94, 585, 3713, 64, 412, 7389, '84dca2c9'
  ],
  'pro-q3dm6': [
    2088, 14131, 4108, 5112, 10294, 4, 2605, 4, 1, 358, 1340, 6209, 40, 72, 11037, '9bb39157'
  ],
  'pro-q3tourney2': [
    2236, 15933, 6092, 4776, 10295, 13, 2220, 2, 1, 243, 712, 4106, 8, 47, 6751, 'ddb064bc'
  ],
  'pro-q3tourney4': [
    1480, 10804, 3808, 2000, 5297, 19, 988, 3, 1, 16, 14, 86, 4, 9, 82, '61fbf404'
  ],
  q3ctf1: [
    1681, 10593, 3014, 3388, 9635, 7, 1541, 3, 1, 226, 1182, 4527, 32, 71, 10291, 'bdd23369'
  ],
  q3ctf2: [
    6179, 43673, 10904, 5826, 22197, 51, 2775, 5, 1, 536, 2314, 11007, 127, 1026, 21051, '8fc1da8a'
  ],
  q3ctf3: [
    4604, 31126, 3920, 7024, 17156, 5, 3206, 2, 1, 506, 2288, 11200, 24, 43, 22855, 'ad6a7919'
  ],
  q3ctf4: [795, 5888, 2796, 1281, 2796, 29, 776, 1, 1, 26, 336, 1653, 28, 137, 3968, '338c2d1c'],
  q3dm0: [1944, 13519, 5752, 3330, 9859, 14, 1672, 5, 1, 46, 202, 1102, 24, 235, 2397, '6e0f7aa7'],
  q3dm1: [987, 6443, 2276, 2109, 6687, 1, 942, 2, 1, 113, 774, 5299, 64, 542, 10398, '6aca7c51'],
  q3dm10: [2265, 15028, 2482, 2931, 8407, 3, 1382, 1, 1, 220, 507, 2775, 4, 22, 4052, '2167e1b2'],
  q3dm11: [
    5478, 38480, 9940, 7110, 25148, 33, 3210, 3, 1, 102, 540, 2320, 36, 305, 5365, 'c400d955'
  ],
  q3dm12: [
    4865, 34174, 8654, 5651, 17360, 64, 2463, 11, 1, 254, 782, 3645, 24, 54, 6436, 'd038b9a6'
  ],
  q3dm13: [1604, 10709, 3502, 3372, 7074, 4, 1697, 3, 1, 81, 561, 3462, 64, 412, 7124, '8518cb79'],
  q3dm14: [
    2522, 16261, 4996, 5356, 14511, 17, 2484, 2, 1, 315, 1041, 4929, 32, 72, 9383, '41124a12'
  ],
  q3dm15: [
    2832, 18731, 5314, 4949, 11876, 21, 2232, 1, 1, 312, 1038, 4937, 16, 41, 8622, '66798532'
  ],
  q3dm16: [1376, 9745, 2750, 2076, 5690, 12, 1097, 1, 1, 101, 439, 1714, 24, 50, 3397, 'fdd0d7db'],
  q3dm17: [456, 3432, 2226, 756, 1373, 20, 424, 1, 1, 32, 180, 1436, 16, 91, 2336, '1c06b40d'],
  q3dm18: [
    1534, 10128, 1960, 3362, 6780, 19, 1890, 1, 1, 222, 1080, 4995, 36, 83, 9169, 'bfb54808'
  ],
  q3dm19: [417, 3343, 2676, 434, 1000, 18, 206, 1, 1, 0, 0, 0, 0, 0, 0, '811c9dc5'],
  q3dm2: [1371, 8711, 2614, 2484, 6747, 3, 1147, 4, 1, 236, 961, 4054, 16, 62, 8271, 'b750647a'],
  q3dm3: [851, 5744, 1772, 1172, 3648, 1, 521, 2, 1, 109, 433, 2268, 16, 84, 4037, '25249fd1'],
  q3dm4: [
    1235, 7976, 2076, 3340, 6265, 10, 1678, 3, 1, 375, 1276, 6993, 56, 511, 12798, '020d5945'
  ],
  q3dm5: [1566, 10212, 2864, 2245, 6134, 4, 1055, 1, 1, 226, 804, 3649, 16, 43, 6541, '72463f98'],
  q3dm6: [
    2081, 13490, 3076, 5108, 10316, 4, 2612, 4, 1, 358, 1340, 6209, 40, 72, 11037, '9bb39157'
  ],
  q3dm7: [
    2599, 16752, 5248, 4840, 14885, 8, 2333, 3, 1, 189, 1030, 4044, 32, 221, 9481, '64c0d6c6'
  ],
  q3dm8: [
    2896, 20080, 5576, 2382, 9462, 29, 1117, 4, 1, 357, 1230, 5910, 16, 157, 10644, '32eb55ed'
  ],
  q3dm9: [
    2546, 16927, 5112, 4400, 9852, 27, 2197, 5, 1, 402, 1278, 5876, 16, 105, 10709, 'aea279c5'
  ],
  q3tourney1: [
    1561, 10743, 3188, 1587, 5665, 4, 731, 2, 1, 343, 1203, 6481, 16, 85, 11300, 'a363a707'
  ],
  q3tourney2: [
    1821, 12406, 3616, 4180, 8307, 11, 1994, 1, 1, 206, 576, 3340, 8, 40, 5442, '30f3abd0'
  ],
  q3tourney3: [
    861, 5743, 2004, 2019, 5021, 15, 985, 2, 1, 119, 420, 1719, 16, 34, 3388, '9001daea'
  ],
  q3tourney4: [1376, 9594, 2734, 1705, 4798, 17, 845, 3, 1, 16, 14, 86, 4, 9, 82, '61fbf404'],
  q3tourney5: [514, 3237, 942, 708, 2205, 2, 329, 1, 1, 59, 144, 806, 4, 24, 1262, 'b885e062'],
  q3tourney6: [556, 4382, 1980, 1459, 2049, 22, 916, 1, 1, 4, 16, 157, 4, 40, 286, 'bd7642a3'],
  q3tourney6_ctf: [587, 4580, 2068, 1498, 2113, 22, 940, 1, 1, 4, 16, 157, 4, 40, 286, 'bd7642a3'],
  test_bigbox: [6, 36, 24, 8, 18, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, '811c9dc5'],
};

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('loadMap against the twin, over the 36 retail maps', () => {
  let maps: Map<string, { survey: (number | string)[]; printed: string[] }>;
  beforeAll(async () => {
    maps = await retailMaps((bytes, path) => {
      const printed: string[] = [];
      const cm = loadMap(parseBsp(bytes, path), path, { print: (text) => printed.push(text) });
      return { survey: Object.values(surveyLoad(cm)), printed };
    });
  }, 120_000);

  it("loads every map as Quake 3's own code does, each patch to the bit", () => {
    expect(Object.fromEntries([...maps].map(([name, { survey }]) => [name, survey]))).toEqual(TWIN);
  });

  it('prints nothing for a retail map, as the twin printed nothing', () => {
    for (const [name, { printed }] of maps) expect(printed, name).toEqual([]);
  });
});
