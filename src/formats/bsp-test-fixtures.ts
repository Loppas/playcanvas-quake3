import { openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import {
  BSP_VERSION,
  HEADER_LUMPS,
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
  type Bsp
} from './bsp';

/**
 * Synthetic BSPs, for tests that need a map without the paks, and the retail maps, read once a
 * test file, for tests that have them.
 */

/** A BSP's lumps' bytes, by `LUMP_*` number. */
export type BspLumps = Partial<Record<number, Uint8Array>>;

/**
 * The smallest map Q3 loads: one zeroed shader, leaf, plane, model and node, the lumps
 * collision will not load empty (`cm_load.c:101, 133, 191, 282, 326`).
 */
export const MINIMAL_LUMPS: Readonly<BspLumps> = {
  [LUMP_SHADERS]: new Uint8Array(72),
  [LUMP_LEAFS]: new Uint8Array(48),
  [LUMP_PLANES]: new Uint8Array(16),
  [LUMP_MODELS]: new Uint8Array(40),
  [LUMP_NODES]: new Uint8Array(36)
};

/**
 * Build the bytes of a BSP: the "IBSP" header, then each lump in turn, from `lumps` or else
 * {@link MINIMAL_LUMPS}, each at a 4-byte boundary. A lump given neither is empty.
 *
 * @param version - Written in the header; 46 by default.
 */
export function buildBsp(lumps: BspLumps = {}, version = BSP_VERSION): Uint8Array {
  const all = { ...MINIMAL_LUMPS, ...lumps };
  const parts = Array.from({ length: HEADER_LUMPS }, (_, n) => all[n] ?? new Uint8Array(0));
  const padded = (length: number) => (length + 3) & ~3;
  const header = 8 + HEADER_LUMPS * 8;
  const bytes = new Uint8Array(parts.reduce((end, part) => end + padded(part.length), header));
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x42, 0x53, 0x50]);
  view.setInt32(4, version, true);
  let at = header;
  parts.forEach((part, n) => {
    view.setInt32(8 + 8 * n, at, true);
    view.setInt32(12 + 8 * n, part.length, true);
    bytes.set(part, at);
    at += padded(part.length);
  });
  return bytes;
}

/** Little-endian 32-bit integers, as a record's fields. */
export function int32s(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setInt32(i * 4, value, true));
  return bytes;
}

/** Little-endian 32-bit floats, as a record's fields. */
export function float32s(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return bytes;
}

/** A name in its `MAX_QPATH` field: a byte a character, then NULs to 64 bytes. */
export function qpath(name: string): Uint8Array {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i);
  return bytes;
}

/** The entity lump holding `text`, with its closing NUL. */
export function entityLump(text: string): Uint8Array {
  return Uint8Array.from(`${text}\0`, (c) => c.charCodeAt(0));
}

/** These parts, end to end: a record from its fields, or a lump from its records. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** A BSP's lumps written back as its file, which `parseBsp` reads as they were. */
export function bspFile(bsp: Bsp): Uint8Array {
  const { drawVerts } = bsp;
  const verts = Array.from({ length: drawVerts.xyz.length / 3 }, (_, i) =>
    concat(
      float32s(...drawVerts.xyz.subarray(i * 3, i * 3 + 3)),
      float32s(...drawVerts.st.subarray(i * 2, i * 2 + 2)),
      float32s(...drawVerts.lightmap.subarray(i * 2, i * 2 + 2)),
      float32s(...drawVerts.normal.subarray(i * 3, i * 3 + 3)),
      drawVerts.color.subarray(i * 4, i * 4 + 4)
    )
  );
  const visibility = bsp.visibility
    ? concat(int32s(bsp.visibility.numClusters, bsp.visibility.clusterBytes), bsp.visibility.data)
    : new Uint8Array(0);
  return buildBsp({
    [LUMP_ENTITIES]: Uint8Array.from(bsp.entityString, (c) => c.charCodeAt(0)),
    [LUMP_SHADERS]: concat(
      ...bsp.shaders.map((s) => concat(qpath(s.shader), int32s(s.surfaceFlags, s.contentFlags)))
    ),
    [LUMP_PLANES]: concat(...bsp.planes.map((p) => float32s(...p.normal, p.dist))),
    [LUMP_NODES]: concat(
      ...bsp.nodes.map((n) => int32s(n.planeNum, ...n.children, ...n.mins, ...n.maxs))
    ),
    [LUMP_LEAFS]: concat(
      ...bsp.leafs.map((l) =>
        int32s(
          l.cluster,
          l.area,
          ...l.mins,
          ...l.maxs,
          l.firstLeafSurface,
          l.numLeafSurfaces,
          l.firstLeafBrush,
          l.numLeafBrushes
        )
      )
    ),
    [LUMP_LEAFSURFACES]: int32s(...bsp.leafSurfaces),
    [LUMP_LEAFBRUSHES]: int32s(...bsp.leafBrushes),
    [LUMP_MODELS]: concat(
      ...bsp.models.map((m) =>
        concat(
          float32s(...m.mins, ...m.maxs),
          int32s(m.firstSurface, m.numSurfaces, m.firstBrush, m.numBrushes)
        )
      )
    ),
    [LUMP_BRUSHES]: concat(
      ...bsp.brushes.map((b) => int32s(b.firstSide, b.numSides, b.shaderNum))
    ),
    [LUMP_BRUSHSIDES]: concat(...bsp.brushSides.map((s) => int32s(s.planeNum, s.shaderNum))),
    [LUMP_DRAWVERTS]: concat(...verts),
    [LUMP_DRAWINDEXES]: int32s(...bsp.drawIndexes),
    [LUMP_FOGS]: concat(
      ...bsp.fogs.map((f) => concat(qpath(f.shader), int32s(f.brushNum, f.visibleSide)))
    ),
    [LUMP_SURFACES]: concat(
      ...bsp.surfaces.map((s) =>
        concat(
          int32s(
            s.shaderNum,
            s.fogNum,
            s.surfaceType,
            s.firstVert,
            s.numVerts,
            s.firstIndex,
            s.numIndexes,
            s.lightmapNum,
            s.lightmapX,
            s.lightmapY,
            s.lightmapWidth,
            s.lightmapHeight
          ),
          float32s(...s.lightmapOrigin, ...s.lightmapVecs.flat()),
          int32s(s.patchWidth, s.patchHeight)
        )
      )
    ),
    [LUMP_LIGHTMAPS]: concat(...bsp.lightmaps),
    [LUMP_LIGHTGRID]: bsp.lightGrid,
    [LUMP_VISIBILITY]: visibility
  });
}

/**
 * Every retail map, the highest-precedence copy of each, as `read` makes it from the BSP and its
 * path, by name. pak0–pak8 must all be present. The paks are mounted and every map inflated each
 * call, so a test file calls it once, from a `beforeAll`.
 */
export async function retailMaps<T>(
  read: (bytes: Uint8Array, path: string) => T
): Promise<Map<string, T>> {
  const fs = new PakFileSystem();
  for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
  const maps = new Map<string, T>();
  for (const path of fs.list('maps/', 'bsp')) {
    maps.set(path.slice('maps/'.length, -'.bsp'.length), read(await fs.readRequired(path), path));
  }
  return maps;
}
