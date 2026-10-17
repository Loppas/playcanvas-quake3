import { Mat4, Quat } from 'playcanvas';

/** Scratch for {@link axisRotation}, which runs for every piece of every body, every frame. */
const matrix = new Mat4();

/**
 * Turn a Q3 axis, forward, left and up as rows, into an entity's rotation.
 *
 * The rows are the child frame's forward, left and up measured in its parent's frame, so they are
 * the columns of the child-to-parent rotation. Q3 draws with the matrix as it is; a rotation keeps
 * its turn and drops the slight skew that blending a tag between two frames leaves.
 */
export function axisRotation(axis: readonly (readonly number[])[], out = new Quat()): Quat {
  // Column-major: each basis vector's column. The last row and column stay the identity's.
  const { data } = matrix;
  for (let k = 0; k < 3; k++) {
    const row = axis[k];
    data[k * 4] = row[0];
    data[k * 4 + 1] = row[1];
    data[k * 4 + 2] = row[2];
  }
  return out.setFromMat4(matrix);
}
