import { flatPolyFogNum, type WorldFog } from './world-fog';

/**
 * The polys a frame's scene holds, as `RE_AddPolyToScene` keeps them (`tr_scene.c:110-187`):
 * cgame's marks, shadows and wakes, each a polygon of points with their texture coordinates and
 * colours, and the fog it is drawn in. A frame takes at most {@link MAX_POLYS} polys and
 * {@link MAX_POLYVERTS} points; a poly past either is dropped, as Q3 drops it with a warning only a
 * developer sees.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `MAX_POLYS` and `MAX_POLYVERTS` (`tr_local.h:1568-1569`): `r_maxpolys` and `r_maxpolyverts`. */
export const MAX_POLYS = 600;
export const MAX_POLYVERTS = 3000;

/** Points as `polyVert_t` holds them, side by side: three floats, two, and four bytes each. */
export interface PolyVerts {
  xyz: Float32Array;
  st: Float32Array;
  modulate: Uint8Array;
}

/** Room for `count` points. */
export function polyVerts(count: number): PolyVerts {
  return {
    xyz: new Float32Array(count * 3),
    st: new Float32Array(count * 2),
    modulate: new Uint8Array(count * 4)
  };
}

/** A frame's polys, made with room for the most it can hold. */
export class ScenePolys<Shader> {
  /** `r_numpolys` and `r_numpolyverts`: the polys and points the frame holds. */
  count = 0;
  points = 0;
  /** Each poly's shader, its first point, its points and its fog: 0, or a fog's place plus one. */
  readonly shaders: (Shader | null)[] = new Array<Shader | null>(MAX_POLYS).fill(null);
  readonly firsts = new Int32Array(MAX_POLYS);
  readonly sizes = new Int32Array(MAX_POLYS);
  readonly fogs = new Int32Array(MAX_POLYS);
  /** Every poly's points, in the order added. */
  readonly verts = polyVerts(MAX_POLYVERTS);
  /** The polys dropped this frame for want of room. */
  dropped = 0;

  /** The map's fogs a poly's points are tested against; none where no world is loaded. */
  private world: readonly Pick<WorldFog, 'bounds'>[] = [];
  private readonly warn: (text: string) => void;

  /** @param warn - Where a poly with no shader is warned of, as `ri.Printf` prints. */
  constructor(warn: (text: string) => void) {
    this.warn = warn;
  }

  /** The fogs of the world the scene is drawn in, from its load; none for none. */
  inWorld(fogs: readonly Pick<WorldFog, 'bounds'>[]): void {
    this.world = fogs;
  }

  /** A frame begins with no polys (`R_InitNextFrame`, `tr_scene.c:40-60`). */
  begin(): void {
    for (let i = 0; i < this.count; i++) this.shaders[i] = null;
    this.count = 0;
    this.points = 0;
    this.dropped = 0;
  }

  /**
   * `RE_AddPolyToScene` for one poly: `numVerts` points from the `first`th of `verts`, in the fog
   * its points' box first meets, one only touching it counted.
   *
   * @param shader - Its shader's handle; null for 0, a shader that failed to register.
   */
  add(shader: Shader | null, numVerts: number, verts: PolyVerts, first: number): void {
    if (shader === null) {
      this.warn('WARNING: RE_AddPolyToScene: NULL poly shader\n');
      return;
    }
    if (this.points + numVerts > MAX_POLYVERTS || this.count >= MAX_POLYS) {
      this.dropped++;
      return;
    }
    const poly = this.count++;
    const at = this.points;
    this.points += numVerts;
    this.shaders[poly] = shader;
    this.firsts[poly] = at;
    this.sizes[poly] = numVerts;
    const { xyz, st, modulate } = this.verts;
    for (let i = 0; i < numVerts; i++) {
      for (let k = 0; k < 3; k++) xyz[(at + i) * 3 + k] = verts.xyz[(first + i) * 3 + k];
      for (let k = 0; k < 2; k++) st[(at + i) * 2 + k] = verts.st[(first + i) * 2 + k];
      for (let k = 0; k < 4; k++) modulate[(at + i) * 4 + k] = verts.modulate[(first + i) * 4 + k];
    }
    this.fogs[poly] = flatPolyFogNum(this.world, xyz, at, numVerts);
  }
}
