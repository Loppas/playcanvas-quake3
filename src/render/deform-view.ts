import { Mat4, Vec3, type GraphNode } from 'playcanvas';

import { worldToSim } from '../coords';
import type { DeformView } from '../view/vertex-deform';

/** Scratch for taking a camera's axes into a model's frame. */
const toModel = new Mat4();
const axis = new Vec3();
const viewerAt = new Vec3();
const viewer: [number, number, number] = [0, 0, 0];

/**
 * Where `camera` is in the model `entity`'s own frame: `backEnd.or.viewOrigin`, which Q3 takes
 * there for each entity (`R_RotateForEntity`, `tr_main.c:327–329`), for a shining, a mirroring or
 * a per-pixel lit stage. The same array each call.
 */
export function viewerInModel(entity: GraphNode, camera: GraphNode): readonly [number, number, number] {
  toModel.copy(entity.getWorldTransform()).invert();
  toModel.transformPoint(camera.getPosition(), viewerAt);
  viewer[0] = viewerAt.x;
  viewer[1] = viewerAt.y;
  viewer[2] = viewerAt.z;
  return viewer;
}

/**
 * Where `camera` looks, for the sprite deforms of the model `entity` draws: its forward, left and
 * up, `backEnd.viewParms.or.axis`, taken into the model's own frame as `GlobalVectorToLocal` takes
 * them (`tr_shade_calc.c:335–339`), each made unit again, so a scaled model's sprites keep their
 * size. A PlayCanvas camera looks along its −Z, with +X to its right.
 *
 * A stamped square's normal is the camera's back in Quake's world frame, where Q3 leaves it
 * (`RB_AddQuadStampExt`).
 */
export function deformView(entity: GraphNode, camera: GraphNode): DeformView {
  toModel.copy(entity.getWorldTransform()).invert();
  const local = (direction: Vec3, sign: number): [number, number, number] => {
    toModel.transformVector(direction, axis).mulScalar(sign).normalize();
    return [axis.x, axis.y, axis.z];
  };
  const { forward } = camera;
  const ahead = worldToSim(forward.x, forward.y, forward.z);
  const length = Math.hypot(ahead.x, ahead.y, ahead.z);
  return {
    forward: local(forward, 1),
    left: local(camera.right, -1),
    up: local(camera.up, 1),
    normal: [-ahead.x / length, -ahead.y / length, -ahead.z / length]
  };
}
