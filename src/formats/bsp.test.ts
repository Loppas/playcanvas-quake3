import { beforeAll, describe, expect, it } from 'vitest';

import { havePak } from '../pak/pak-test-fixtures';
import {
  LUMP_BRUSHES,
  LUMP_BRUSHSIDES,
  LUMP_DRAWINDEXES,
  LUMP_DRAWVERTS,
  LUMP_ENTITIES,
  LUMP_FOGS,
  LUMP_LEAFBRUSHES,
  LUMP_LEAFS,
  LUMP_LEAFSURFACES,
  LUMP_LIGHTGRID,
  LUMP_LIGHTMAPS,
  LUMP_MODELS,
  LUMP_NODES,
  LUMP_PLANES,
  LUMP_SHADERS,
  LUMP_SURFACES,
  LUMP_VISIBILITY,
  MST_FLARE,
  MST_PATCH,
  MST_PLANAR,
  MST_TRIANGLE_SOUP,
  bspEntityText,
  parseBsp,
  parseBspCollision,
  parseBspWorld,
  type Bsp
} from './bsp';
import {
  bspFile,
  buildBsp,
  concat,
  entityLump,
  float32s,
  int32s,
  qpath,
  retailMaps,
  type BspLumps
} from './bsp-test-fixtures';
import { readEntities } from './entity-text';

const NAME = 'maps/test.bsp';

/** A draw vertex: its position, texture and lightmap coordinates, normal and colour. */
function drawVert(
  xyz: number[],
  st: number[],
  lightmap: number[],
  normal: number[],
  rgba: number[]
) {
  return concat(float32s(...xyz, ...st, ...lightmap, ...normal), Uint8Array.from(rgba));
}

/** A lightmap page whose texels count up from `first`. */
const page = (first: number) =>
  Uint8Array.from({ length: 128 * 128 * 3 }, (_, i) => (first + i) & 0xff);

/** A map with every lump the reader reads, each field a value of its own. */
const LUMPS: BspLumps = {
  [LUMP_ENTITIES]: entityLump('{ "classname" "worldspawn" }'),
  [LUMP_SHADERS]: concat(
    qpath('textures/base_wall/concrete'),
    int32s(0x40000, 1),
    qpath('textures/sfx/\x80fog'),
    int32s(0x80, 0x40)
  ),
  [LUMP_PLANES]: concat(float32s(0, 0.6, 0.8, 64), float32s(0, -0.6, -0.8, -64)),
  [LUMP_NODES]: int32s(1, 4, -2, -64, -32, -8, 64, 32, 128),
  [LUMP_LEAFS]: int32s(3, 2, -60, -30, -6, 60, 30, 120, 1, 2, 4, 1),
  [LUMP_LEAFBRUSHES]: int32s(5, 0, 9),
  [LUMP_LEAFSURFACES]: int32s(7, 1, 0),
  [LUMP_MODELS]: concat(float32s(-64.5, -32, -8, 64, 32.25, 128), int32s(5, 2, 6, 1)),
  [LUMP_BRUSHES]: int32s(2, 6, 1),
  [LUMP_BRUSHSIDES]: int32s(0, 1, 1, 0),
  [LUMP_DRAWVERTS]: concat(
    drawVert([1, 2, 3], [0.5, 0.25], [0.125, 0.0625], [0, 0, 1], [10, 20, 30, 255]),
    drawVert([-4, 5.5, 6], [1.5, -0.75], [0.1, 0.2], [0, 1, 0], [40, 50, 60, 128]),
    drawVert([7, 8, -9], [2, 3], [0.3, 0.4], [1, 0, 0], [70, 80, 90, 0])
  ),
  [LUMP_DRAWINDEXES]: int32s(0, 2, 1),
  [LUMP_FOGS]: concat(qpath('textures/sfx/fog'), int32s(3, -1)),
  [LUMP_SURFACES]: concat(
    int32s(1, 0, MST_PLANAR, 0, 3, 0, 3, 1, 16, 32, 8, 4),
    float32s(10, 20, 30, 1, 0, 0, 0, 1, 0, 0, 0, 1),
    int32s(0, 0),
    int32s(0, -1, MST_PATCH, 1, 3, 3, 0, -1, 0, 0, 0, 0),
    float32s(0, 0, 0, -1, -2, -3, 4, 5, 6, 0, 0, 0),
    int32s(3, 5)
  ),
  [LUMP_LIGHTMAPS]: concat(page(0), page(1)),
  // Not a whole number of points, which the grid's load is left to find.
  [LUMP_LIGHTGRID]: Uint8Array.from({ length: 12 }, (_, i) => 200 + i),
  [LUMP_VISIBILITY]: concat(int32s(2, 8), Uint8Array.from({ length: 16 }, (_, i) => i + 1))
};

/** A surface of this type and patch size, its other fields 0 or none. */
const surfaceOf = (surfaceType: number, width: number, height: number) =>
  concat(
    int32s(0, -1, surfaceType, 0, 0, 0, 0, -1, 0, 0, 0, 0),
    float32s(...new Array<number>(12).fill(0)),
    int32s(width, height)
  );

/** The message a map is refused with, or `undefined` if it reads. */
function refusal(bytes: Uint8Array): string | undefined {
  try {
    parseBsp(bytes, NAME);
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
}

describe('parseBsp', () => {
  const bsp = parseBsp(buildBsp(LUMPS), NAME);

  it("reads the small lumps as records, with Q3's names", () => {
    expect(bsp.shaders).toEqual([
      { shader: 'textures/base_wall/concrete', surfaceFlags: 0x40000, contentFlags: 1 },
      { shader: 'textures/sfx/\x80fog', surfaceFlags: 0x80, contentFlags: 0x40 }
    ]);
    expect(bsp.planes).toEqual([
      { normal: [0, Math.fround(0.6), Math.fround(0.8)], dist: 64 },
      { normal: [0, Math.fround(-0.6), Math.fround(-0.8)], dist: -64 }
    ]);
    expect(bsp.nodes).toEqual([
      { planeNum: 1, children: [4, -2], mins: [-64, -32, -8], maxs: [64, 32, 128] }
    ]);
    expect(bsp.leafs).toEqual([
      {
        cluster: 3,
        area: 2,
        mins: [-60, -30, -6],
        maxs: [60, 30, 120],
        firstLeafSurface: 1,
        numLeafSurfaces: 2,
        firstLeafBrush: 4,
        numLeafBrushes: 1
      }
    ]);
    expect(bsp.models).toEqual([
      {
        mins: [-64.5, -32, -8],
        maxs: [64, 32.25, 128],
        firstSurface: 5,
        numSurfaces: 2,
        firstBrush: 6,
        numBrushes: 1
      }
    ]);
    expect(bsp.brushes).toEqual([{ firstSide: 2, numSides: 6, shaderNum: 1 }]);
    expect(bsp.brushSides).toEqual([
      { planeNum: 0, shaderNum: 1 },
      { planeNum: 1, shaderNum: 0 }
    ]);
    expect(bsp.fogs).toEqual([{ shader: 'textures/sfx/fog', brushNum: 3, visibleSide: -1 }]);
    expect(bsp.entityString).toBe('{ "classname" "worldspawn" }\0');
  });

  it('reads every field of a surface', () => {
    expect(bsp.surfaces).toEqual([
      {
        shaderNum: 1,
        fogNum: 0,
        surfaceType: MST_PLANAR,
        firstVert: 0,
        numVerts: 3,
        firstIndex: 0,
        numIndexes: 3,
        lightmapNum: 1,
        lightmapX: 16,
        lightmapY: 32,
        lightmapWidth: 8,
        lightmapHeight: 4,
        lightmapOrigin: [10, 20, 30],
        lightmapVecs: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1]
        ],
        patchWidth: 0,
        patchHeight: 0
      },
      {
        shaderNum: 0,
        fogNum: -1,
        surfaceType: MST_PATCH,
        firstVert: 1,
        numVerts: 3,
        firstIndex: 3,
        numIndexes: 0,
        lightmapNum: -1,
        lightmapX: 0,
        lightmapY: 0,
        lightmapWidth: 0,
        lightmapHeight: 0,
        lightmapOrigin: [0, 0, 0],
        lightmapVecs: [
          [-1, -2, -3],
          [4, 5, 6],
          [0, 0, 0]
        ],
        patchWidth: 3,
        patchHeight: 5
      }
    ]);
  });

  it('reads the draw vertices into an array a field', () => {
    const { xyz, st, lightmap, normal, color } = bsp.drawVerts;
    expect(Array.from(xyz)).toEqual([1, 2, 3, -4, 5.5, 6, 7, 8, -9]);
    expect(Array.from(st)).toEqual([0.5, 0.25, 1.5, -0.75, 2, 3]);
    expect(Array.from(lightmap)).toEqual([0.125, 0.0625, 0.1, 0.2, 0.3, 0.4].map(Math.fround));
    expect(Array.from(normal)).toEqual([0, 0, 1, 0, 1, 0, 1, 0, 0]);
    expect(Array.from(color)).toEqual([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0]);
  });

  it('copies the bulk lumps into arrays of their own', () => {
    const file = buildBsp(LUMPS);
    const read = parseBsp(file, NAME);
    expect(Array.from(read.leafBrushes)).toEqual([5, 0, 9]);
    expect(Array.from(read.leafSurfaces)).toEqual([7, 1, 0]);
    expect(Array.from(read.drawIndexes)).toEqual([0, 2, 1]);
    expect(read.lightmaps).toEqual([page(0), page(1)]);
    expect(Array.from(read.lightGrid)).toEqual(Array.from({ length: 12 }, (_, i) => 200 + i));
    expect(read.visibility).toEqual({
      numClusters: 2,
      clusterBytes: 8,
      data: Uint8Array.from({ length: 16 }, (_, i) => i + 1)
    });
    for (const array of [
      read.leafBrushes,
      read.drawVerts.color,
      ...read.lightmaps,
      read.lightGrid,
      read.visibility!.data
    ]) {
      expect(array.buffer).not.toBe(file.buffer);
    }
  });

  it('reads a map wherever it sits in its buffer, as a stored pak entry can', () => {
    const file = buildBsp(LUMPS);
    const held = new Uint8Array(file.length + 1);
    held.set(file, 1);
    expect(parseBsp(held.subarray(1), NAME)).toEqual(parseBsp(file, NAME));
  });

  it('takes whole lightmap pages, as the renderer does, and leaves a lone page alone', () => {
    const pages = (lump: Uint8Array) =>
      parseBsp(buildBsp({ [LUMP_LIGHTMAPS]: lump }), NAME).lightmaps.length;
    expect(pages(concat(page(0), page(1), new Uint8Array(100)))).toBe(2);
    expect(pages(new Uint8Array(100))).toBe(0);
    expect(pages(page(0))).toBe(1);
  });

  it('reads a map with no visibility as having none, and its smallest map whole', () => {
    expect(parseBsp(buildBsp(), NAME)).toEqual<Bsp>({
      entityString: '',
      shaders: [{ shader: '', surfaceFlags: 0, contentFlags: 0 }],
      planes: [{ normal: [0, 0, 0], dist: 0 }],
      nodes: [{ planeNum: 0, children: [0, 0], mins: [0, 0, 0], maxs: [0, 0, 0] }],
      leafs: [
        {
          cluster: 0,
          area: 0,
          mins: [0, 0, 0],
          maxs: [0, 0, 0],
          firstLeafSurface: 0,
          numLeafSurfaces: 0,
          firstLeafBrush: 0,
          numLeafBrushes: 0
        }
      ],
      leafBrushes: new Int32Array(0),
      leafSurfaces: new Int32Array(0),
      models: [
        {
          mins: [0, 0, 0],
          maxs: [0, 0, 0],
          firstSurface: 0,
          numSurfaces: 0,
          firstBrush: 0,
          numBrushes: 0
        }
      ],
      brushes: [],
      brushSides: [],
      drawVerts: {
        xyz: new Float32Array(0),
        st: new Float32Array(0),
        lightmap: new Float32Array(0),
        normal: new Float32Array(0),
        color: new Uint8Array(0)
      },
      drawIndexes: new Int32Array(0),
      fogs: [],
      surfaces: [],
      lightmaps: [],
      lightGrid: new Uint8Array(0),
      visibility: null
    });
  });
});

describe("parseBsp's checks", () => {
  const MOD = 'MOD_LoadBmodel: funny lump size';
  const LOAD_MAP = `LoadMap: funny lump size in ${NAME}`;

  it("refuses another version in CM_LoadMap's words, and reads any ident, as Q3 does", () => {
    expect(refusal(buildBsp({}, 47))).toBe(
      `CM_LoadMap: ${NAME} has wrong version number (47 should be 46)`
    );
    const file = buildBsp();
    file.set([0x58, 0x58, 0x58, 0x58]);
    expect(refusal(file)).toBeUndefined();
  });

  it("refuses a lump that is not whole records, in the first loader's words", () => {
    const lumps: [number, number, string][] = [
      [LUMP_SHADERS, 72, 'CMod_LoadShaders: funny lump size'],
      [LUMP_LEAFS, 48, MOD],
      [LUMP_LEAFBRUSHES, 4, MOD],
      [LUMP_LEAFSURFACES, 4, MOD],
      [LUMP_PLANES, 16, MOD],
      [LUMP_BRUSHSIDES, 8, MOD],
      [LUMP_BRUSHES, 12, MOD],
      [LUMP_MODELS, 40, 'CMod_LoadSubmodels: funny lump size'],
      [LUMP_NODES, 36, MOD],
      [LUMP_SURFACES, 104, MOD],
      [LUMP_DRAWVERTS, 44, MOD],
      [LUMP_FOGS, 72, LOAD_MAP],
      [LUMP_DRAWINDEXES, 4, LOAD_MAP]
    ];
    for (const [lump, size, message] of lumps) {
      expect(refusal(buildBsp({ [lump]: new Uint8Array(size + 1) })), `lump ${lump}`).toBe(message);
      const whole = buildBsp({ [lump]: new Uint8Array(size * 2) });
      expect(refusal(whole), `lump ${lump}`).toBeUndefined();
    }
  });

  it("refuses a map with no shaders, leafs, planes, models or nodes in collision's words", () => {
    const empty = new Uint8Array(0);
    expect(refusal(buildBsp({ [LUMP_SHADERS]: empty }))).toBe('Map with no shaders');
    expect(refusal(buildBsp({ [LUMP_LEAFS]: empty }))).toBe('Map with no leafs');
    expect(refusal(buildBsp({ [LUMP_PLANES]: empty }))).toBe('Map with no planes');
    expect(refusal(buildBsp({ [LUMP_MODELS]: empty }))).toBe('Map with no models');
    expect(refusal(buildBsp({ [LUMP_NODES]: empty }))).toBe('Map has no nodes');
  });

  it("refuses a brush or brush side whose shader the map has not got, in collision's words", () => {
    // The smallest map has one shader.
    const sides = (...shaderNums: number[]) =>
      refusal(buildBsp({ [LUMP_BRUSHSIDES]: int32s(...shaderNums.flatMap((s) => [0, s])) }));
    expect(sides(0, 0)).toBeUndefined();
    expect(sides(0, 1)).toBe('CMod_LoadBrushSides: bad shaderNum: 1');
    expect(sides(-1, 1)).toBe('CMod_LoadBrushSides: bad shaderNum: -1');
    const brushes = (...shaderNums: number[]) =>
      refusal(buildBsp({ [LUMP_BRUSHES]: int32s(...shaderNums.flatMap((s) => [0, 0, s])) }));
    expect(brushes(0, 0)).toBeUndefined();
    expect(brushes(0, 2)).toBe('CMod_LoadBrushes: bad shaderNum: 2');
    expect(brushes(-5, 2)).toBe('CMod_LoadBrushes: bad shaderNum: -5');
  });

  it("checks the sides' shaders after their lump's size, and the brushes' before the models'", () => {
    const badSide = int32s(0, 3);
    const badBrush = int32s(0, 0, 3);
    const funnyModels = new Uint8Array(41);
    expect(refusal(buildBsp({ [LUMP_BRUSHSIDES]: badSide, [LUMP_PLANES]: new Uint8Array(0) }))).toBe(
      'Map with no planes'
    );
    expect(
      refusal(buildBsp({ [LUMP_BRUSHSIDES]: badSide, [LUMP_BRUSHES]: new Uint8Array(13) }))
    ).toBe('CMod_LoadBrushSides: bad shaderNum: 3');
    expect(refusal(buildBsp({ [LUMP_BRUSHES]: badBrush, [LUMP_MODELS]: funnyModels }))).toBe(
      'CMod_LoadBrushes: bad shaderNum: 3'
    );
  });

  it('holds a map to 256 models', () => {
    expect(refusal(buildBsp({ [LUMP_MODELS]: new Uint8Array(40 * 256) }))).toBeUndefined();
    expect(refusal(buildBsp({ [LUMP_MODELS]: new Uint8Array(40 * 257) }))).toBe(
      'MAX_SUBMODELS exceeded'
    );
  });

  describe("a patch's size, in collision's words", () => {
    /** The message a map of these surfaces is refused with. */
    const sized = (...surfaces: Uint8Array[]) =>
      refusal(buildBsp({ [LUMP_SURFACES]: concat(...surfaces) }));
    const patch = (width: number, height: number) => sized(surfaceOf(MST_PATCH, width, height));
    const BAD = 'CM_GeneratePatchFacets: bad parameters';
    const EVEN = 'CM_GeneratePatchFacets: even sizes are invalid for quadratic meshes';
    const OVER = 'CM_GeneratePatchFacets: source is > MAX_GRID_SIZE';

    it('takes 1024 control points at most', () => {
      expect(patch(31, 33)).toBeUndefined();
      expect(patch(33, 33)).toBe('ParseMesh: MAX_PATCH_VERTS');
    });

    it('takes sides of more than 2, odd, and up to 129', () => {
      expect(patch(3, 3)).toBeUndefined();
      expect(patch(2, 3)).toBe(`${BAD}: (2, 3)`);
      expect(patch(3, -1)).toBe(`${BAD}: (3, -1)`);
      expect(patch(5, 4)).toBe(EVEN);
      expect(patch(129, 7)).toBeUndefined();
      expect(patch(131, 7)).toBe(OVER);
      expect(patch(7, 131)).toBe(OVER);
    });

    it("checks in collision's order, the first patch first", () => {
      expect(patch(2, 600)).toBe('ParseMesh: MAX_PATCH_VERTS');
      expect(patch(2, 512)).toBe(`${BAD}: (2, 512)`);
      expect(patch(2, 4)).toBe(`${BAD}: (2, 4)`);
      expect(patch(130, 3)).toBe(EVEN);
      expect(sized(surfaceOf(MST_PATCH, 4, 3), surfaceOf(MST_PATCH, 2, 3))).toBe(EVEN);
    });

    it("leaves every other surface's patch size alone", () => {
      for (const type of [MST_PLANAR, MST_TRIANGLE_SOUP, MST_FLARE]) {
        expect(sized(surfaceOf(type, 2, 2))).toBeUndefined();
      }
    });
  });

  it('stops a map with several faults on the one Quake 3 meets first', () => {
    // Collision's loader, in its order, then the renderer's.
    const faults: [BspLumps, string][] = [
      [{ [LUMP_SHADERS]: new Uint8Array(73) }, 'CMod_LoadShaders: funny lump size'],
      [{ [LUMP_LEAFS]: new Uint8Array(0) }, 'Map with no leafs'],
      [{ [LUMP_LEAFBRUSHES]: new Uint8Array(5) }, MOD],
      [{ [LUMP_LEAFSURFACES]: new Uint8Array(5) }, MOD],
      [{ [LUMP_PLANES]: new Uint8Array(0) }, 'Map with no planes'],
      [{ [LUMP_BRUSHSIDES]: new Uint8Array(9) }, MOD],
      [{ [LUMP_MODELS]: new Uint8Array(41) }, 'CMod_LoadSubmodels: funny lump size'],
      [{ [LUMP_NODES]: new Uint8Array(0) }, 'Map has no nodes'],
      [{ [LUMP_DRAWVERTS]: new Uint8Array(45) }, MOD],
      [
        { [LUMP_SURFACES]: surfaceOf(MST_PATCH, 4, 3) },
        'CM_GeneratePatchFacets: even sizes are invalid for quadratic meshes'
      ],
      [{ [LUMP_FOGS]: new Uint8Array(73) }, LOAD_MAP]
    ];
    faults.forEach(([, message], i) => {
      const lumps = Object.assign({}, ...faults.slice(i).map(([fault]) => fault));
      expect(refusal(buildBsp(lumps)), message).toBe(message);
    });
  });

  it("refuses a file too short for its header, or a lump outside it, in the port's words", () => {
    const file = buildBsp({ [LUMP_VISIBILITY]: concat(int32s(1, 1), new Uint8Array(1)) });
    expect(refusal(file.subarray(0, 143))).toBe(`CM_LoadMap: ${NAME} is too short for a header`);
    expect(refusal(file.subarray(0, file.length - 4))).toBe(
      `CM_LoadMap: ${NAME}'s visibility lump lies outside the file`
    );
    new DataView(file.buffer).setInt32(8 + 8 * LUMP_SURFACES, -4, true);
    expect(refusal(file)).toBe(`CM_LoadMap: ${NAME}'s surfaces lump lies outside the file`);
  });
});

describe("parseBsp's two halves", () => {
  const LOAD_MAP = `LoadMap: funny lump size in ${NAME}`;

  it("read collision's lumps, then the renderer's four, into what parseBsp reads whole", () => {
    const file = buildBsp(LUMPS);
    const collision = parseBspCollision(file, NAME);
    expect(Object.keys(collision)).not.toContain('fogs');
    expect(Object.keys(collision)).not.toContain('drawIndexes');
    expect(Object.keys(collision)).not.toContain('lightmaps');
    expect(Object.keys(collision)).not.toContain('lightGrid');
    expect(parseBspWorld(file, NAME, collision)).toEqual(parseBsp(file, NAME));
  });

  it("leave the renderer's two checks to the renderer's half, as Q3's server never makes them", () => {
    for (const [lump, size] of [
      [LUMP_FOGS, 72],
      [LUMP_DRAWINDEXES, 4]
    ]) {
      const file = buildBsp({ [lump]: new Uint8Array(size + 1) });
      const collision = parseBspCollision(file, NAME);
      expect(() => parseBspWorld(file, NAME, collision), `lump ${lump}`).toThrow(LOAD_MAP);
    }
  });
});

describe('bspFile', () => {
  it('writes a map back as the bytes it was read from', () => {
    const file = buildBsp(LUMPS);
    expect(bspFile(parseBsp(file, NAME))).toEqual(file);
  });
});

describe('bspEntityText', () => {
  it('reads lump 0 with its NUL, which the reader stops at', () => {
    const text = bspEntityText(
      buildBsp({ [LUMP_ENTITIES]: entityLump('{ "classname" "worldspawn" }') }),
      NAME
    );
    expect(text.endsWith('\0')).toBe(true);
    expect(readEntities(text)).toEqual([[['classname', 'worldspawn']]]);
  });

  it("refuses another version with CM_LoadMap's words", () => {
    expect(() => bspEntityText(buildBsp({}, 47), NAME)).toThrow(
      `CM_LoadMap: ${NAME} has wrong version number (47 should be 46)`
    );
  });

  it("refuses a short file, or an entity lump outside it, in the port's words", () => {
    const file = buildBsp({ [LUMP_ENTITIES]: entityLump('{}') });
    expect(() => bspEntityText(file.subarray(0, 143), NAME)).toThrow(
      `CM_LoadMap: ${NAME} is too short for a header`
    );
    for (const filelen of [file.length, -1]) {
      new DataView(file.buffer).setInt32(12, filelen, true);
      expect(() => bspEntityText(file, NAME)).toThrow(
        `CM_LoadMap: ${NAME}'s entities lump lies outside the file`
      );
    }
  });
});

/** A map's counts, in {@link SURVEY}'s columns. */
function survey(bsp: Bsp): (number | string)[] {
  const ofType = (type: number) => bsp.surfaces.filter((s) => s.surfaceType === type);
  let largest = '0x0';
  let most = 0;
  for (const s of ofType(MST_PATCH)) {
    if (s.patchWidth * s.patchHeight > most) {
      most = s.patchWidth * s.patchHeight;
      largest = `${s.patchWidth}x${s.patchHeight}`;
    }
  }
  const fogged = bsp.surfaces.filter((s) => s.surfaceType !== MST_FLARE && s.fogNum >= 0);
  return [
    bsp.surfaces.length,
    ofType(MST_PLANAR).length,
    ofType(MST_PATCH).length,
    ofType(MST_TRIANGLE_SOUP).length,
    ofType(MST_FLARE).length,
    bsp.models[0].numSurfaces,
    largest,
    bsp.lightmaps.length,
    bsp.visibility?.numClusters ?? 'none',
    Math.max(...bsp.leafs.map((leaf) => leaf.area)) + 1,
    bsp.fogs.length,
    fogged.length,
    bsp.shaders.length
  ];
}

/** Each reference a map's records make that misses what it refers to, the first few. */
function misses(bsp: Bsp): string[] {
  const found: string[] = [];
  const within = (first: number, count: number, length: number) =>
    first >= 0 && count >= 0 && first + count <= length;
  const numVerts = bsp.drawVerts.xyz.length / 3;
  bsp.planes.forEach(({ normal }, i) => {
    if (Math.abs(Math.hypot(...normal) - 1) > 1e-5) found.push(`plane ${i}'s normal`);
  });
  bsp.nodes.forEach(({ planeNum, children }, i) => {
    if (!within(planeNum, 1, bsp.planes.length)) found.push(`node ${i}'s plane`);
    for (const child of children) {
      const ok = child >= 0 ? child < bsp.nodes.length : -1 - child < bsp.leafs.length;
      if (!ok) found.push(`node ${i}'s child`);
    }
  });
  bsp.leafs.forEach((leaf, i) => {
    if (!within(leaf.firstLeafSurface, leaf.numLeafSurfaces, bsp.leafSurfaces.length)) {
      found.push(`leaf ${i}'s surfaces`);
    }
    if (!within(leaf.firstLeafBrush, leaf.numLeafBrushes, bsp.leafBrushes.length)) {
      found.push(`leaf ${i}'s brushes`);
    }
    if (leaf.cluster < -1 || leaf.cluster >= (bsp.visibility?.numClusters ?? 1)) {
      found.push(`leaf ${i}'s cluster`);
    }
  });
  bsp.leafBrushes.forEach((brush, i) => {
    if (!within(brush, 1, bsp.brushes.length)) found.push(`leaf brush ${i}`);
  });
  bsp.leafSurfaces.forEach((surface, i) => {
    if (!within(surface, 1, bsp.surfaces.length)) found.push(`leaf surface ${i}`);
  });
  bsp.models.forEach((model, i) => {
    if (!within(model.firstSurface, model.numSurfaces, bsp.surfaces.length)) {
      found.push(`model ${i}'s surfaces`);
    }
    if (!within(model.firstBrush, model.numBrushes, bsp.brushes.length)) {
      found.push(`model ${i}'s brushes`);
    }
  });
  bsp.brushes.forEach((brush, i) => {
    if (!within(brush.firstSide, brush.numSides, bsp.brushSides.length)) {
      found.push(`brush ${i}'s sides`);
    }
    if (!within(brush.shaderNum, 1, bsp.shaders.length)) found.push(`brush ${i}'s shader`);
  });
  bsp.brushSides.forEach((side, i) => {
    if (!within(side.planeNum, 1, bsp.planes.length)) found.push(`brush side ${i}'s plane`);
    if (!within(side.shaderNum, 1, bsp.shaders.length)) found.push(`brush side ${i}'s shader`);
  });
  bsp.fogs.forEach((fog, i) => {
    const brush = bsp.brushes[fog.brushNum];
    if (!brush || fog.visibleSide < -1 || fog.visibleSide >= brush.numSides) {
      found.push(`fog ${i}'s brush`);
    }
  });
  bsp.surfaces.forEach((s, i) => {
    if (!within(s.shaderNum, 1, bsp.shaders.length)) found.push(`surface ${i}'s shader`);
    // q3map writes a flare's fog as 0 whether or not the map has a fog.
    if (s.surfaceType !== MST_FLARE && (s.fogNum < -1 || s.fogNum >= bsp.fogs.length)) {
      found.push(`surface ${i}'s fog`);
    }
    if (s.lightmapNum >= bsp.lightmaps.length) found.push(`surface ${i}'s lightmap`);
    if (!within(s.firstVert, s.numVerts, numVerts)) found.push(`surface ${i}'s vertices`);
    if (!within(s.firstIndex, s.numIndexes, bsp.drawIndexes.length)) {
      found.push(`surface ${i}'s indexes`);
    }
    for (let j = s.firstIndex; j < s.firstIndex + s.numIndexes; j++) {
      if (!within(bsp.drawIndexes[j], 1, s.numVerts)) found.push(`surface ${i}'s index ${j}`);
    }
  });
  const vis = bsp.visibility;
  if (vis && vis.data.length !== vis.numClusters * vis.clusterBytes) found.push('the bitsets');
  return found.slice(0, 5);
}

/**
 * Each retail map's counts, measured from the paks by a script apart from the port's reader:
 * surfaces; planar, patch, triangle soup and flare; the world model's; the largest patch; the
 * lightmap pages, clusters and areas; the fogs and the fogged surfaces; and the shaders.
 */
const SURVEY: Record<string, (number | string)[]> = {
  'pro-q3dm13': [4286, 4123, 94, 69, 0, 4286, '9x11', 14, 2004, 2, 0, 0, 99],
  'pro-q3dm6': [4318, 3728, 358, 180, 52, 4318, '9x15', 16, 2605, 4, 0, 0, 83],
  'pro-q3tourney2': [4254, 3919, 243, 41, 51, 4254, '9x3', 18, 2220, 2, 11, 111, 91],
  'pro-q3tourney4': [2983, 2868, 16, 70, 29, 2911, '9x3', 9, 988, 3, 0, 0, 109],
  q3ctf1: [4206, 3936, 226, 32, 12, 4182, '9x5', 16, 1541, 3, 1, 74, 88],
  q3ctf2: [10850, 9785, 536, 48, 481, 10736, '9x7', 30, 2775, 5, 0, 0, 112],
  q3ctf3: [8069, 7393, 506, 90, 80, 8069, '9x9', 34, 3206, 2, 3, 198, 75],
  q3ctf4: [2131, 2073, 26, 16, 16, 1962, '9x3', 7, 776, 1, 0, 0, 47],
  q3dm0: [5023, 4806, 46, 43, 128, 5017, '9x7', 9, 1672, 5, 0, 0, 113],
  q3dm1: [2097, 1942, 113, 42, 0, 2097, '9x7', 9, 942, 2, 0, 0, 94],
  q3dm10: [4184, 3757, 220, 96, 111, 4164, '9x3', 11, 1382, 1, 0, 0, 82],
  q3dm11: [11226, 10742, 102, 173, 209, 10708, '9x5', 25, 3210, 3, 1, 70, 151],
  q3dm12: [10148, 9564, 254, 88, 242, 9998, '9x5', 32, 2463, 11, 2, 53, 140],
  q3dm13: [3666, 3505, 81, 66, 14, 3666, '9x11', 12, 1697, 3, 0, 0, 101],
  q3dm14: [6061, 5663, 315, 72, 11, 5859, '9x5', 23, 2484, 2, 3, 170, 104],
  q3dm15: [6962, 6518, 312, 99, 33, 6854, '9x5', 25, 2232, 1, 4, 70, 116],
  q3dm16: [1969, 1789, 101, 73, 6, 1969, '9x9', 9, 1097, 1, 0, 0, 72],
  q3dm17: [1439, 1335, 32, 59, 13, 1439, '9x3', 9, 424, 1, 0, 0, 66],
  q3dm18: [3850, 3446, 222, 15, 167, 3850, '9x15', 48, 1890, 1, 0, 0, 70],
  q3dm19: [1325, 1179, 0, 27, 119, 1019, '0x0', 13, 206, 1, 1, 14, 53],
  q3dm2: [2998, 2706, 236, 37, 19, 2986, '7x7', 11, 1147, 4, 0, 0, 106],
  q3dm3: [1650, 1513, 109, 22, 6, 1650, '9x3', 8, 521, 2, 0, 0, 65],
  q3dm4: [2486, 1933, 375, 63, 115, 2486, '9x9', 13, 1678, 3, 1, 82, 75],
  q3dm5: [3433, 3117, 226, 59, 31, 3433, '9x3', 9, 1055, 1, 1, 115, 92],
  q3dm6: [4318, 3728, 358, 180, 52, 4318, '9x15', 17, 2612, 4, 0, 0, 82],
  q3dm7: [6098, 5823, 189, 49, 37, 6002, '9x9', 22, 2333, 3, 2, 127, 133],
  q3dm8: [4879, 4268, 357, 40, 214, 4778, '9x5', 15, 1117, 4, 2, 48, 93],
  q3dm9: [5917, 5429, 402, 46, 40, 5917, '9x5', 24, 2197, 5, 6, 369, 113],
  q3tourney1: [2379, 1952, 343, 45, 39, 2379, '9x5', 9, 731, 2, 0, 0, 58],
  q3tourney2: [3358, 3059, 206, 40, 53, 3358, '9x3', 14, 1994, 1, 7, 51, 87],
  q3tourney3: [1936, 1794, 119, 18, 5, 1888, '9x5', 10, 985, 2, 3, 69, 64],
  q3tourney4: [2837, 2728, 16, 64, 29, 2765, '9x3', 8, 845, 3, 0, 0, 102],
  q3tourney5: [1299, 1231, 59, 8, 1, 1299, '9x3', 5, 329, 1, 1, 1292, 46],
  q3tourney6: [2247, 2116, 4, 33, 94, 2077, '9x3', 5, 916, 1, 0, 0, 76],
  q3tourney6_ctf: [2341, 2211, 4, 33, 93, 2173, '9x3', 6, 940, 1, 0, 0, 88],
  test_bigbox: [6, 6, 0, 0, 0, 6, '0x0', 1, 'none', 1, 0, 0, 1]
};

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('parseBsp against the 36 retail maps', () => {
  let maps: Map<string, { counts: (number | string)[]; misses: string[] }>;
  beforeAll(async () => {
    maps = await retailMaps((bytes, path) => {
      const bsp = parseBsp(bytes, path);
      return { counts: survey(bsp), misses: misses(bsp) };
    });
  }, 60_000);

  it("reads every map with the survey's counts", () => {
    expect(Object.fromEntries([...maps].map(([name, { counts }]) => [name, counts]))).toEqual(
      SURVEY
    );
  });

  it('finds every reference a record makes inside what it refers to', () => {
    for (const [name, map] of maps) expect(map.misses, name).toEqual([]);
  });
});
