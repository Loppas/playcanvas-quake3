import {
  LIGHTMAP_SIZE,
  MST_PLANAR,
  type Bsp,
  type BspBrush,
  type BspBrushSide,
  type BspFog,
  type BspLeaf,
  type BspModel,
  type BspNode,
  type BspPlane,
  type BspSurface,
  type BspVisibility
} from '../formats/bsp';
import { parseShaderScripts } from '../formats/shader-script';
import type { ShaderSources } from './world-shaders';

/**
 * Maps built as records rather than bytes, for tests of what the world makes of a BSP once read.
 */

/** A surface: a face of 3 points and 3 indexes in shader 0, unfogged, where not said otherwise. */
export function surface(fields: Partial<BspSurface> = {}): BspSurface {
  return {
    shaderNum: 0,
    fogNum: -1,
    surfaceType: MST_PLANAR,
    firstVert: 0,
    numVerts: 3,
    firstIndex: 0,
    numIndexes: 3,
    lightmapNum: -1,
    lightmapX: 0,
    lightmapY: 0,
    lightmapWidth: 0,
    lightmapHeight: 0,
    lightmapOrigin: [0, 0, 0],
    lightmapVecs: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 1]
    ],
    patchWidth: 0,
    patchHeight: 0,
    ...fields
  };
}

/** A leaf holding these entries of the leaf-surface list. */
export function leaf(firstLeafSurface: number, numLeafSurfaces: number): BspLeaf {
  return {
    cluster: 0,
    area: 0,
    mins: [0, 0, 0],
    maxs: [0, 0, 0],
    firstLeafSurface,
    numLeafSurfaces,
    firstLeafBrush: 0,
    numLeafBrushes: 0
  };
}

/** A node splitting into these two children: a node's number, or a leaf's as `-(leaf + 1)`. */
export function node(front: number, back: number): BspNode {
  return { planeNum: 0, children: [front, back], mins: [0, 0, 0], maxs: [0, 0, 0] };
}

/** An inline model of these surfaces. */
export function model(firstSurface: number, numSurfaces: number): BspModel {
  return {
    mins: [0, 0, 0],
    maxs: [0, 0, 0],
    firstSurface,
    numSurfaces,
    firstBrush: 0,
    numBrushes: 0
  };
}

/** A fog volume: an axial box, the shader it is filled with, and the side its face is on. */
export interface TestFog {
  mins: [number, number, number];
  maxs: [number, number, number];
  shader: string;
  /** −1 for none; its top by default. */
  visibleSide?: number;
}

/**
 * The planes, brush sides, brushes and fogs of these fog volumes, each brush's six sides in the
 * order a brush sorts them: −x, +x, −y, +y, −z, +z.
 */
export function fogParts(
  fogs: TestFog[]
): Required<Pick<TestBspParts, 'planes' | 'brushes' | 'brushSides' | 'fogs'>> {
  const planes: BspPlane[] = [];
  const brushSides: BspBrushSide[] = [];
  const brushes: BspBrush[] = [];
  for (const { mins, maxs } of fogs) {
    brushes.push({ firstSide: brushSides.length, numSides: 6, shaderNum: 0 });
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [-1, 1]) {
        const normal: [number, number, number] = [0, 0, 0];
        normal[axis] = sign;
        brushSides.push({ planeNum: planes.length, shaderNum: 0 });
        planes.push({ normal, dist: sign < 0 ? -mins[axis] : maxs[axis] });
      }
    }
  }
  return {
    planes,
    brushes,
    brushSides,
    fogs: fogs.map(({ shader, visibleSide = 5 }, brushNum) => ({ shader, brushNum, visibleSide }))
  };
}

/** What a test map is made of; the rest is filled in. */
export interface TestBspParts {
  /** The shader lump's names, in order. */
  shaders?: string[];
  surfaces?: BspSurface[];
  /**
   * The tree. By default one node, its front a leaf holding every surface the world model has in
   * lump order, its back an empty leaf.
   */
  nodes?: BspNode[];
  leafs?: BspLeaf[];
  leafSurfaces?: number[];
  /** By default the world alone, holding every surface. */
  models?: BspModel[];
  drawIndexes?: number[];
  entityString?: string;
  /** How many lightmap pages it has, each black; none by default. */
  lightmaps?: number;
  /** By default one, facing up through the origin. */
  planes?: BspPlane[];
  /** None by default, nor any brush sides or fogs; see {@link fogParts}. */
  brushes?: BspBrush[];
  brushSides?: BspBrushSide[];
  fogs?: BspFog[];
  /** The draw vertices' positions, three a vertex, where a test places them. */
  xyz?: number[];
  /** None by default. */
  visibility?: BspVisibility;
  /** The light grid's lump, as stored; empty by default. */
  lightGrid?: Uint8Array;
}

/**
 * A map of these parts. Its draw vertices are as many as the surfaces reach, each at
 * `(i, 2i, 3i)` for vertex `i` unless placed, so a batch's bounds are its vertices' numbers.
 */
export function testBsp(parts: TestBspParts = {}): Bsp {
  const surfaces = parts.surfaces ?? [surface()];
  const models = parts.models ?? [model(0, surfaces.length)];
  const world = models[0];
  const numVerts = Math.max(
    surfaces.reduce((end, s) => Math.max(end, s.firstVert + s.numVerts), 0),
    (parts.xyz?.length ?? 0) / 3
  );
  const xyz = new Float32Array(numVerts * 3);
  for (let i = 0; i < numVerts; i++) xyz.set([i, 2 * i, 3 * i], i * 3);
  if (parts.xyz) xyz.set(parts.xyz);
  const numIndexes = surfaces.reduce((end, s) => Math.max(end, s.firstIndex + s.numIndexes), 0);
  return {
    entityString: parts.entityString ?? '\0',
    shaders: (parts.shaders ?? ['textures/test/wall']).map((shader) => ({
      shader,
      surfaceFlags: 0,
      contentFlags: 0
    })),
    planes: parts.planes ?? [{ normal: [0, 0, 1], dist: 0 }],
    nodes: parts.nodes ?? [node(-1, -2)],
    leafs: parts.leafs ?? [leaf(0, world.numSurfaces), leaf(0, 0)],
    leafBrushes: new Int32Array(0),
    leafSurfaces: Int32Array.from(
      parts.leafSurfaces ??
        Array.from({ length: world.numSurfaces }, (_, i) => world.firstSurface + i)
    ),
    models,
    brushes: parts.brushes ?? [],
    brushSides: parts.brushSides ?? [],
    drawVerts: {
      xyz,
      st: new Float32Array(numVerts * 2),
      lightmap: new Float32Array(numVerts * 2),
      normal: new Float32Array(numVerts * 3),
      color: new Uint8Array(numVerts * 4).fill(255)
    },
    drawIndexes: Int32Array.from(
      parts.drawIndexes ?? Array.from({ length: numIndexes }, (_, i) => i % 3)
    ),
    fogs: parts.fogs ?? [],
    surfaces,
    lightmaps: Array.from(
      { length: parts.lightmaps ?? 0 },
      () => new Uint8Array(LIGHTMAP_SIZE * LIGHTMAP_SIZE * 3)
    ),
    lightGrid: parts.lightGrid ?? new Uint8Array(0),
    visibility: parts.visibility ?? null
  };
}

/**
 * Where a test's shaders come from: these scripts, these images, and its warnings kept in
 * `warnings`.
 */
export function testSources(
  scripts: string,
  images: readonly string[]
): ShaderSources & { warnings: string[] } {
  const warnings: string[] = [];
  const found = new Set(images.map((image) => image.toLowerCase()));
  return {
    scripts: parseShaderScripts([scripts]),
    // As the extension fallback finds one: the name, or its stem with any image extension.
    hasImage: (name) => {
      const lower = name.toLowerCase();
      const stem = lower.replace(/\.[^./]*$/, '');
      return found.has(lower) || ['.tga', '.jpg'].some((extension) => found.has(stem + extension));
    },
    warn: (text) => warnings.push(text),
    warnings
  };
}
