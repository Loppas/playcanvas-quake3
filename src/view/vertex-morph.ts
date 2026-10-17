import type { Md3Surface } from '../formats/md3';
import { rendererStyle, type RendererStyle } from './overbright';

/**
 * A model's vertices between two of its frames: `LerpMeshVertexes` and the frame check before it
 * (`tr_surface.c:612–707`, `tr_mesh.c:307–316`).
 *
 * These are the arithmetic's definition. The model chunks (`render/model-chunks.ts`) morph every
 * vertex the same on the GPU, and tests hold them to these. Engine-free, like the rest of
 * `src/view/`: frames in, one moment's positions and normals out.
 */

/**
 * The frames a model draws, as `R_AddMD3Surfaces` checks them: if either is a frame the model
 * lacks, both become frame 0 (`tr_mesh.c:307–316`). A few custom models name frames past their
 * last; retail ones never do.
 */
export function drawnFrames(numFrames: number, oldFrame: number, frame: number): [number, number] {
  if (frame >= numFrames || frame < 0 || oldFrame >= numFrames || oldFrame < 0) return [0, 0];
  return [oldFrame, frame];
}

/**
 * One surface's positions and normals at a blend of two frames (`LerpMeshVertexes_scalar`). A
 * frame drawn whole is copied as it is, whatever the old frame was.
 *
 * Blended normals are made unit length again under `opengl1`, as it makes them. `opengl2` leaves
 * them short, on the CPU and on the GPU alike (`renderergl2/tr_surface.c:823–825`,
 * `generic_vp.glsl:228`), and every deform, mirror and generic shade then reads them so.
 *
 * @param backlerp - How much of `oldFrame` is left: 0 draws `frame` alone.
 * @param positions - Overwritten with `numVerts * 3` positions, in Quake units.
 * @param normals - Overwritten with `numVerts * 3` normals.
 * @param style - The renderer to morph like; the one set at load unless a test says otherwise.
 */
export function lerpMeshVertexes(
  surface: Md3Surface,
  oldFrame: number,
  frame: number,
  backlerp: number,
  positions: Float32Array,
  normals: Float32Array,
  style: RendererStyle = rendererStyle()
): void {
  const next = surface.frames[frame];
  if (backlerp === 0) {
    positions.set(next.positions);
    normals.set(next.normals);
    return;
  }

  const old = surface.frames[oldFrame];
  const front = 1 - backlerp;
  for (let i = 0; i < positions.length; i++) {
    positions[i] = old.positions[i] * backlerp + next.positions[i] * front;
  }
  // `VectorArrayNormalize`: the blend of two unit normals is shorter than one.
  const renormalises = style.renderer === 'opengl1';
  for (let i = 0; i < normals.length; i += 3) {
    const x = old.normals[i] * backlerp + next.normals[i] * front;
    const y = old.normals[i + 1] * backlerp + next.normals[i + 1] * front;
    const z = old.normals[i + 2] * backlerp + next.normals[i + 2] * front;
    const length = Math.hypot(x, y, z);
    const scale = renormalises && length > 0 ? 1 / length : 1;
    normals[i] = x * scale;
    normals[i + 1] = y * scale;
    normals[i + 2] = z * scale;
  }
}
