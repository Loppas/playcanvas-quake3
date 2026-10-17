import { describe, expect, it } from 'vitest';
import type { Md3Surface } from '../formats/md3';
import { drawnFrames, lerpMeshVertexes } from './vertex-morph';

/** One vertex over two frames: from (0, 0, 0) facing +X, to (8, 4, 0) facing +Y. */
const SURFACE: Md3Surface = {
  name: 'l_legs',
  shaders: [],
  numVerts: 1,
  indices: new Uint32Array(0),
  uvs: new Float32Array(2),
  frames: [
    { positions: new Float32Array([0, 0, 0]), normals: new Float32Array([1, 0, 0]) },
    { positions: new Float32Array([8, 4, 0]), normals: new Float32Array([0, 1, 0]) }
  ]
};

function morph(oldFrame: number, frame: number, backlerp: number) {
  const positions = new Float32Array(3);
  const normals = new Float32Array(3);
  lerpMeshVertexes(SURFACE, oldFrame, frame, backlerp, positions, normals);
  return { positions: [...positions], normals: [...normals] };
}

describe('lerpMeshVertexes', () => {
  it('copies the frame when none of the old one is left', () => {
    expect(morph(0, 1, 0)).toEqual({ positions: [8, 4, 0], normals: [0, 1, 0] });
  });

  it('blends the positions by backlerp, the old frame taking that share', () => {
    expect(morph(0, 1, 0.25).positions).toEqual([6, 3, 0]);
  });

  it('makes blended normals unit length again', () => {
    const [x, y, z] = morph(0, 1, 0.5).normals;
    expect(x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(z).toBe(0);
  });

  it('leaves them short under opengl2, as it never makes them unit again', () => {
    const positions = new Float32Array(3);
    const normals = new Float32Array(3);
    lerpMeshVertexes(SURFACE, 0, 1, 0.5, positions, normals, { renderer: 'opengl2', overBrightBits: 1 });
    expect([...normals]).toEqual([0.5, 0.5, 0]);
    expect([...positions]).toEqual([4, 2, 0]);
  });
});

describe('drawnFrames', () => {
  it('keeps two frames the model has', () => {
    expect(drawnFrames(191, 165, 166)).toEqual([165, 166]);
  });

  it('draws frame 0 for both when either is past the end or below 0', () => {
    expect(drawnFrames(191, 190, 191)).toEqual([0, 0]);
    expect(drawnFrames(191, 191, 5)).toEqual([0, 0]);
    expect(drawnFrames(191, -1, 5)).toEqual([0, 0]);
  });
});
