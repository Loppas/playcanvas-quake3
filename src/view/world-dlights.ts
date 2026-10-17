import { dlightClip, type ProjectedLight } from './dynamic-lights';

/**
 * The triangles of a batch a dynamic light's pass draws, as `ProjectDlightTexture` keeps them
 * (`tr_shade.c:517-532`): each whose three vertexes do not all lie past one edge of the light's
 * reach, in the batch's order.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** What `r_speeds 4` prints of a frame's light passes, by Q3's counters. */
export interface DlightSpeeds {
  /** `c_dlightSurfaces`: the surfaces a test left a light on. */
  surfaces: number;
  /** `c_dlightSurfacesCulled`: the faces and curves a test left none on. */
  culled: number;
  /** `c_dlightVertexes`: each pass's batch's vertexes, projected. */
  vertexes: number;
  /** `c_dlightIndexes / 3`: the triangles the passes drew. */
  triangles: number;
}

/** `r_speeds 4`'s line (`tr_cmds.c:51-56`), or none where no vertex was projected. */
export function dlightSpeedsLine({ surfaces, culled, vertexes, triangles }: DlightSpeeds): string {
  if (vertexes === 0) return '';
  const tris = Math.trunc(triangles);
  return `dlight srf:${surfaces}  culled:${culled}  verts:${vertexes}  tris:${tris}\n`;
}

/**
 * Each vertex's clip bits for the light and batch being projected, worked out once each however
 * many triangles share the vertex.
 */
export class ClipCache {
  private stamps: Int32Array;
  private readonly clips: Uint8Array;
  private stamp = 0;

  /** @param vertexes - How many vertexes the batches' indexes can number. */
  constructor(vertexes: number) {
    this.stamps = new Int32Array(vertexes);
    this.clips = new Uint8Array(vertexes);
  }

  /** Forget every vertex's bits: a new light, or a new batch. */
  next(): void {
    if (++this.stamp === 0x7fffffff) {
      this.stamps.fill(0);
      this.stamp = 1;
    }
  }

  /**
   * A vertex's clip bits.
   *
   * @param positions - The vertexes, `stride` floats each, x, y and z from `offset`.
   */
  clip(
    light: ProjectedLight,
    positions: Float32Array,
    stride: number,
    offset: number,
    vertex: number
  ): number {
    if (this.stamps[vertex] === this.stamp) return this.clips[vertex];
    const at = vertex * stride + offset;
    const clip = dlightClip(light, positions[at], positions[at + 1], positions[at + 2]);
    this.stamps[vertex] = this.stamp;
    this.clips[vertex] = clip;
    return clip;
  }
}

/**
 * Write the triangles of a batch's indexes the light reaches into `out` from `at`: `hitIndexes`.
 *
 * @param positions - The vertexes the indexes number, `stride` floats each, x, y and z from
 *   `offset`, in the frame `light` was projected into.
 * @param indexes - The batch's, `count` of them from `first`.
 * @returns how many indexes were written
 */
export function keptTriangles(
  light: ProjectedLight,
  positions: Float32Array,
  stride: number,
  offset: number,
  indexes: Uint32Array,
  first: number,
  count: number,
  out: Uint32Array,
  at: number,
  cache: ClipCache
): number {
  cache.next();
  let written = 0;
  for (let i = first; i < first + count; i += 3) {
    const a = indexes[i];
    const b = indexes[i + 1];
    const c = indexes[i + 2];
    const clipA = cache.clip(light, positions, stride, offset, a);
    const clipB = cache.clip(light, positions, stride, offset, b);
    const clipC = cache.clip(light, positions, stride, offset, c);
    if (clipA & clipB & clipC) continue;
    out[at + written] = a;
    out[at + written + 1] = b;
    out[at + written + 2] = c;
    written += 3;
  }
  return written;
}
