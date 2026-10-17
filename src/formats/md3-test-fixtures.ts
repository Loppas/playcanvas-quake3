/**
 * Synthetic MD3s, for tests that need a model without the paks: any number of
 * frames, tags that move from frame to frame, and surfaces of one triangle each, or of what
 * vertices and triangles a test gives.
 */

type Row = [number, number, number];

/** What to build. Every surface and tag has {@link Md3Spec.frames} frames. */
export interface Md3Spec {
  frames?: number;
  /** Each tag's origin, frame by frame, with an identity axis unless one is given. */
  tags?: Record<string, Array<{ origin: Row; axis?: [Row, Row, Row] }>>;
  /**
   * Each surface: its name as stored, the shader it embeds, its vertices' coordinates in each
   * frame, three a vertex in Quake units that are whole 64ths, and its triangles. One triangle by
   * default, 0 1 2. Vertex `v` is textured at (v & 1, v >> 1 & 1).
   */
  surfaces?: Array<{
    name: string;
    shader?: string;
    positions?: (frame: number) => number[];
    indices?: number[];
  }>;
  /**
   * The frame bounds every frame carries, for the tests that read a model's own size — the
   * item radius, a weapon's midpoint. A one-unit box about the origin by default.
   */
  bounds?: { mins?: Row; maxs?: Row };
}

const HEADER = 108;
const FRAME = 56;
const TAG = 112;
const SURFACE_HEADER = 108;
const SHADER = 68;

/** A triangle in the Y–Z plane that climbs one unit a frame. */
const DEFAULT_POSITIONS = (frame: number) => [0, 0, frame, 0, 1, frame, 0, 0, frame + 1];

/** Build the bytes of an MD3 to `spec`. Every normal faces +Z. */
export function buildMd3(spec: Md3Spec): Uint8Array {
  const numFrames = spec.frames ?? 1;
  const tagNames = Object.keys(spec.tags ?? {});
  const surfaces = spec.surfaces ?? [];

  /** Each surface's layout: where its parts sit within it, and its size. */
  const layouts = surfaces.map(({ positions = DEFAULT_POSITIONS, indices = [0, 1, 2] }) => {
    const numVerts = positions(0).length / 3;
    const ofsTriangles = SURFACE_HEADER + SHADER;
    const ofsSt = ofsTriangles + indices.length * 4;
    const ofsXyz = ofsSt + numVerts * 8;
    return { numVerts, indices, ofsTriangles, ofsSt, ofsXyz, size: ofsXyz + numFrames * numVerts * 8 };
  });
  const ofsTags = HEADER + numFrames * FRAME;
  const ofsSurfaces = ofsTags + numFrames * tagNames.length * TAG;

  const bytes = new Uint8Array(ofsSurfaces + layouts.reduce((total, { size }) => total + size, 0));
  const view = new DataView(bytes.buffer);
  const writeName = (at: number, text: string, width = 64) =>
    bytes.set(new TextEncoder().encode(text).subarray(0, width - 1), at);

  view.setUint32(0, 0x33504449, true); // "IDP3"
  view.setInt32(4, 15, true);
  writeName(8, 'models/test/synthetic');
  view.setInt32(76, numFrames, true);
  view.setInt32(80, tagNames.length, true);
  view.setInt32(84, surfaces.length, true);
  view.setInt32(92, HEADER, true);
  view.setInt32(96, ofsTags, true);
  view.setInt32(100, ofsSurfaces, true);

  for (let frame = 0; frame < numFrames; frame++) {
    const at = HEADER + frame * FRAME;
    const mins = spec.bounds?.mins ?? [-1, -1, -1];
    const maxs = spec.bounds?.maxs ?? [1, 1, 1];
    for (let i = 0; i < 3; i++) {
      view.setFloat32(at + i * 4, mins[i], true);
      view.setFloat32(at + 12 + i * 4, maxs[i], true);
    }
    view.setFloat32(at + 36, 2, true); // radius
    tagNames.forEach((name, index) => {
      const tag = spec.tags![name][frame];
      const t = ofsTags + (frame * tagNames.length + index) * TAG;
      writeName(t, name);
      tag.origin.forEach((value, i) => view.setFloat32(t + 64 + i * 4, value, true));
      const axis = tag.axis ?? [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
      ];
      axis.flat().forEach((value, i) => view.setFloat32(t + 76 + i * 4, value, true));
    });
  }

  let s = ofsSurfaces;
  surfaces.forEach(({ name, shader = '', positions = DEFAULT_POSITIONS }, index) => {
    const { numVerts, indices, ofsTriangles, ofsSt, ofsXyz, size } = layouts[index];
    view.setUint32(s, 0x33504449, true);
    writeName(s + 4, name);
    view.setInt32(s + 72, numFrames, true);
    view.setInt32(s + 76, 1, true); // numShaders
    view.setInt32(s + 80, numVerts, true);
    view.setInt32(s + 84, indices.length / 3, true); // numTriangles
    view.setInt32(s + 88, ofsTriangles, true);
    view.setInt32(s + 92, SURFACE_HEADER, true);
    view.setInt32(s + 96, ofsSt, true);
    view.setInt32(s + 100, ofsXyz, true);
    view.setInt32(s + 104, size, true);
    writeName(s + SURFACE_HEADER, shader);
    indices.forEach((vertex, i) => view.setInt32(s + ofsTriangles + i * 4, vertex, true));
    for (let v = 0; v < numVerts; v++) {
      view.setFloat32(s + ofsSt + v * 8, v & 1, true);
      view.setFloat32(s + ofsSt + v * 8 + 4, (v >> 1) & 1, true);
    }
    for (let frame = 0; frame < numFrames; frame++) {
      const corners = positions(frame);
      for (let v = 0; v < numVerts; v++) {
        const at = s + ofsXyz + (frame * numVerts + v) * 8;
        for (let i = 0; i < 3; i++) view.setInt16(at + i * 2, Math.round(corners[v * 3 + i] * 64), true);
        view.setUint16(at + 6, 0, true); // lat 0, lng 0: +Z
      }
    }
    s += size;
  });
  return bytes;
}
