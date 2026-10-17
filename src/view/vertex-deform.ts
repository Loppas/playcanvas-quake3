import type {
  BulgeDeform,
  Deform,
  MoveDeform,
  NormalDeform,
  WaveDeform
} from '../formats/shader-script';
import { noise4 } from './noise';
import { evalWave, waveFunc } from './shader-animation';

/**
 * Q3's vertex deforms (`renderergl1/tr_shade_calc.c:112–581`), run over one surface's vertices in
 * the model's own frame: after the frame lerp, and before any colour or coordinate is made
 * (`RB_DeformTessGeometry`, `tr_shade.c:996`).
 *
 * These are the arithmetic's definition. The model chunks (`render/model-chunks.ts`) do the same
 * on the GPU, and tests hold them to these. Engine-free, like the rest of `src/view/`.
 */

/** A direction, or a point, in three dimensions. */
type Triple = readonly [number, number, number];

/** A surface's vertices as the deforms see them: `tess.xyz`, `tess.normal`, `tess.texCoords`. */
export interface DeformVertices {
  /** Three per vertex, in the model's own frame, moved in place. */
  positions: Float32Array;
  /** Three per vertex, unit length, turned in place. */
  normals: Float32Array;
  /** The first texture coordinates, two per vertex; `autosprite` rewrites them. */
  uvs: Float32Array;
  /** The surface's triangles, `tess.indexes`: `autosprite2` reads their order. */
  indices: ArrayLike<number>;
}

/**
 * Where the viewer looks, for the sprite deforms: `backEnd.viewParms.or.axis` taken into the
 * model's own frame (`GlobalVectorToLocal`, `:335–339`), each of unit length. A scaled model's
 * sprites so keep their own size, as Q3's `nonNormalizedAxes` compensation leaves them
 * (`:395–406`). The port draws no mirror, so the mirror's flip of `left` has no place here.
 */
export interface DeformView {
  /** The view's forward, `axis[0]`, in the model's frame. */
  forward: Triple;
  /** Its left, `axis[1]`. */
  left: Triple;
  /** Its up, `axis[2]`. */
  up: Triple;
  /**
   * A stamped square's normal: the view's back, `−axis[0]`, **in the world's frame**. Q3 never
   * takes it into the model's (`RB_AddQuadStampExt`, `tr_surface.c:106–111`).
   */
  normal: Triple;
}

/**
 * `RB_CalcDeformVertexes` (`:118–159`): each vertex pushed along its normal by the wave. A wave
 * with no frequency pushes every vertex alike, as every powerup shell's does; one with a
 * frequency is phased along the surface, each vertex's by `(x + y + z) · spread`, so the push
 * ripples across it.
 *
 * @param positions - Positions in the model's own frame, three per vertex, pushed in place.
 * @param normals - Their unit normals.
 * @param seconds - Q3's `shaderTime` for the surface.
 */
export function waveDeform(
  deform: WaveDeform,
  positions: Float32Array,
  normals: ArrayLike<number>,
  seconds: number
): void {
  const { wave, spread } = deform;
  if (wave.frequency === 0) {
    const scale = evalWave(wave, seconds);
    for (let i = 0; i < positions.length; i++) positions[i] += normals[i] * scale;
    return;
  }
  for (let p = 0; p < positions.length; p += 3) {
    const off = (positions[p] + positions[p + 1] + positions[p + 2]) * spread;
    const scale =
      wave.base + wave.amplitude * waveFunc(wave.func, wave.phase + off + seconds * wave.frequency);
    positions[p] += normals[p] * scale;
    positions[p + 1] += normals[p + 1] * scale;
    positions[p + 2] += normals[p + 2] * scale;
  }
}

/**
 * `RB_CalcDeformNormals` (`:169–193`), which Q3 calls wiggling the normals for wavy environment
 * mapping. Each axis of a normal gains `amplitude` times the noise at the vertex's position scaled
 * by 0.98, at `shaderTime · frequency`; y's noise is read 100 units further along x, and z's 200.
 * Then the normal is made unit again. Q3 does that with `Q_rsqrt`'s estimate; this does it
 * exactly, as the rest of the port does. The vertices stay where they are.
 */
export function normalDeform(
  deform: NormalDeform,
  positions: ArrayLike<number>,
  normals: Float32Array,
  seconds: number
): void {
  const { amplitude } = deform;
  const t = seconds * deform.frequency;
  for (let p = 0; p < positions.length; p += 3) {
    const x = positions[p] * 0.98;
    const y = positions[p + 1] * 0.98;
    const z = positions[p + 2] * 0.98;
    const nx = normals[p] + amplitude * noise4(x, y, z, t);
    const ny = normals[p + 1] + amplitude * noise4(100 + x, y, z, t);
    const nz = normals[p + 2] + amplitude * noise4(200 + x, y, z, t);
    const length = Math.hypot(nx, ny, nz);
    const scale = length > 0 ? 1 / length : 1;
    normals[p] = nx * scale;
    normals[p + 1] = ny * scale;
    normals[p + 2] = nz * scale;
  }
}

/**
 * `RB_CalcBulgeVertexes` (`:201–222`): each vertex pushed along its normal by
 * `height · sin(s · width + t · speed)`, `s` its first texture coordinate, so a swell runs along
 * the surface. Q3 reads its sine table in 1,024 steps; this reads the sine itself, as `evalWave`
 * does.
 *
 * @param seconds - The level's clock, `backEnd.refdef.time`, not the shader's: the one the port
 *   plays every model's stages on, since none carries a `shaderTime` of its own.
 */
export function bulgeDeform(deform: BulgeDeform, vertices: DeformVertices, seconds: number): void {
  const { positions, normals, uvs } = vertices;
  const now = seconds * deform.speed;
  for (let p = 0, v = 0; p < positions.length; p += 3, v += 2) {
    const scale = Math.sin(uvs[v] * deform.width + now) * deform.height;
    positions[p] += normals[p] * scale;
    positions[p + 1] += normals[p + 1] * scale;
    positions[p + 2] += normals[p + 2] * scale;
  }
}

/** How far `RB_CalcMoveVertexes` moves a surface at `seconds`: the vector, scaled by the wave. */
export function moveOffset(deform: MoveDeform, seconds: number): [number, number, number] {
  const scale = evalWave(deform.wave, seconds);
  return [deform.vector[0] * scale, deform.vector[1] * scale, deform.vector[2] * scale];
}

/** `RB_CalcMoveVertexes` (`:232–252`): every vertex moved by {@link moveOffset}. */
export function moveDeform(deform: MoveDeform, positions: Float32Array, seconds: number): void {
  const offset = moveOffset(deform, seconds);
  for (let i = 0; i < positions.length; i++) positions[i] += offset[i % 3];
}

/**
 * The corners `RB_AddQuadStampExt` puts round a square's middle, as multiples of the view's left
 * and up: top left, top right, bottom right and bottom left as the viewer sees them.
 */
export const STAMP_CORNERS: readonly (readonly [number, number])[] = [
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1]
];

/** Their coordinates, `(s1, t1)`, `(s2, t1)`, `(s2, t2)` and `(s1, t2)` for Q3's 0 and 1. */
export const STAMP_UVS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1]
];

/**
 * The triangles `RB_AddQuadStampExt` gives each square (`tr_surface.c:80–87`): its corners 0, 1, 3
 * and 3, 1, 2. A trailing group of fewer than four vertices gets none.
 */
export function stampIndices(numVerts: number): Uint32Array {
  const quads = Math.floor(numVerts / 4);
  const out = new Uint32Array(quads * 6);
  for (let quad = 0; quad < quads; quad++) {
    const first = quad * 4;
    out.set([first, first + 1, first + 3, first + 3, first + 1, first + 2], quad * 6);
  }
  return out;
}

/** Whether a shader's surface is drawn as the squares `autosprite` stamps, by their triangles. */
export function isStamped(deforms: readonly Deform[]): boolean {
  return deforms.some((deform) => deform.type === 'autosprite');
}

/**
 * `AutospriteDeform` (`:349–410`): every four vertices, taken as a quad, replaced by a square
 * facing the viewer round their midpoint, its half-side `|v₀ − mid| · 0.707` (`RB_AddQuadStamp`).
 * Its corners, coordinates and normal are {@link STAMP_CORNERS}, {@link STAMP_UVS} and the view's
 * back. Q3 draws the square with its own triangles, so a mesh drawing it takes
 * {@link stampIndices} for the surface's.
 *
 * A trailing group of fewer than four is left as it is, where Q3 reads past the surface's end.
 */
export function autospriteDeform(vertices: DeformVertices, view: DeformView): void {
  const { positions, normals, uvs } = vertices;
  const quads = Math.floor(positions.length / 12);
  for (let quad = 0; quad < quads; quad++) {
    const p = quad * 12;
    const mid = [0, 1, 2].map(
      (axis) =>
        0.25 * (positions[p + axis] + positions[p + 3 + axis] + positions[p + 6 + axis] + positions[p + 9 + axis])
    );
    const radius =
      Math.hypot(positions[p] - mid[0], positions[p + 1] - mid[1], positions[p + 2] - mid[2]) * 0.707;
    const left = view.left.map((value) => value * radius);
    const up = view.up.map((value) => value * radius);
    STAMP_CORNERS.forEach(([l, u], corner) => {
      for (let axis = 0; axis < 3; axis++) {
        positions[p + corner * 3 + axis] = mid[axis] + l * left[axis] + u * up[axis];
        normals[p + corner * 3 + axis] = view.normal[axis];
      }
      uvs.set(STAMP_UVS[corner], quad * 8 + corner * 2);
    });
  }
}

/** `edgeVerts` (`:420–427`): a quad's six edges, by its vertices' places in it. */
export const QUAD_EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3]
];

/**
 * For each quad, which of its {@link QUAD_EDGES} its triangles name in order, as
 * `Autosprite2Deform` looks for them (`:511–518`): bit `e` is set where two neighbours among the
 * quad's six indices are edge `e`'s first vertex and then its second. It decides which way along
 * the new minor axis each end of the edge goes. An index past the surface's last matches nothing.
 */
export function quadEdgeOrders(indices: ArrayLike<number>, numVerts: number): Uint8Array {
  const quads = Math.floor(numVerts / 4);
  const out = new Uint8Array(quads);
  for (let quad = 0; quad < quads; quad++) {
    const first = quad * 4;
    const at = quad * 6;
    QUAD_EDGES.forEach(([a, b], edge) => {
      for (let k = 0; k < 5; k++) {
        if (indices[at + k] === first + a && indices[at + k + 1] === first + b) {
          out[quad] |= 1 << edge;
          break;
        }
      }
    });
  }
  return out;
}

/**
 * `Autosprite2Deform` (`:429–529`): each quad, a long strip, pivoted about its long axis to face
 * the viewer. Its two shortest edges are its ends. The long axis runs from the first end's
 * midpoint to the second's, and the minor axis is square to it and to the view. Each end's two
 * vertices are put either side of its midpoint, half the end's length along the minor axis, the
 * way round that {@link quadEdgeOrders} gives. The texture coordinates and normals stay.
 *
 * A trailing group of fewer than four is left as it is, where Q3 reads past the surface's end.
 *
 * @param orders - The surface's {@link quadEdgeOrders}.
 * @param forward - The view's forward, in the model's frame.
 */
export function autosprite2Deform(positions: Float32Array, orders: Uint8Array, forward: Triple): void {
  const quads = Math.floor(positions.length / 12);
  const point = (vertex: number) => [0, 1, 2].map((axis) => positions[vertex * 3 + axis]);
  for (let quad = 0; quad < quads; quad++) {
    const first = quad * 4;
    const corners = [0, 1, 2, 3].map((corner) => point(first + corner));
    // The two shortest edges, the first found winning a tie, from Q3's start of 999999.
    const nums = [0, 0];
    const lengths = [999999, 999999];
    QUAD_EDGES.forEach(([a, b], edge) => {
      const l = corners[a].reduce((sum, value, axis) => sum + (value - corners[b][axis]) ** 2, 0);
      if (l < lengths[0]) {
        nums[1] = nums[0];
        lengths[1] = lengths[0];
        nums[0] = edge;
        lengths[0] = l;
      } else if (l < lengths[1]) {
        nums[1] = edge;
        lengths[1] = l;
      }
    });
    const mids = nums.map((edge) => {
      const [a, b] = QUAD_EDGES[edge];
      return corners[a].map((value, axis) => 0.5 * (value + corners[b][axis]));
    });
    const major = mids[1].map((value, axis) => value - mids[0][axis]);
    const cross = [
      major[1] * forward[2] - major[2] * forward[1],
      major[2] * forward[0] - major[0] * forward[2],
      major[0] * forward[1] - major[1] * forward[0]
    ];
    // `VectorNormalize` leaves a zero vector as it is.
    const length = Math.hypot(cross[0], cross[1], cross[2]);
    const minor = cross.map((value) => (length > 0 ? value / length : value));
    nums.forEach((edge, j) => {
      const [a, b] = QUAD_EDGES[edge];
      const l = 0.5 * Math.sqrt(lengths[j]);
      const toward = orders[quad] & (1 << edge) ? -1 : 1;
      for (let axis = 0; axis < 3; axis++) {
        positions[(first + a) * 3 + axis] = mids[j][axis] + toward * l * minor[axis];
        positions[(first + b) * 3 + axis] = mids[j][axis] - toward * l * minor[axis];
      }
    });
  }
}

/**
 * `RB_DeformTessGeometry` (`:538–581`): a shader's deforms over a surface, in slot order.
 *
 * @param seconds - Q3's `shaderTime` for the surface; `bulge` reads it as the level's clock too.
 * @param view - Where the viewer looks; a sprite deform does nothing without one.
 */
export function deformVertexes(
  deforms: readonly Deform[],
  vertices: DeformVertices,
  seconds: number,
  view: DeformView | null
): void {
  const { positions, normals } = vertices;
  for (const deform of deforms) {
    switch (deform.type) {
      case 'wave':
        waveDeform(deform, positions, normals, seconds);
        break;
      case 'normal':
        normalDeform(deform, positions, normals, seconds);
        break;
      case 'bulge':
        bulgeDeform(deform, vertices, seconds);
        break;
      case 'move':
        moveDeform(deform, positions, seconds);
        break;
      case 'autosprite':
        if (view) autospriteDeform(vertices, view);
        break;
      case 'autosprite2':
        if (view) {
          const orders = quadEdgeOrders(vertices.indices, positions.length / 3);
          autosprite2Deform(positions, orders, view.forward);
        }
        break;
    }
  }
}
