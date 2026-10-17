// @vitest-environment jsdom
import { Entity, Vec3 } from 'playcanvas';
import { describe, it } from 'vitest';

import { deformView, viewerInModel } from './deform-view';
import { expectClose } from './engine-test-fixtures';
import { applyQuakeTransform } from './md3-mesh';

/** A model under the Quake frame's root, turned `yaw` degrees about Quake's up and scaled. */
function model(yaw: number, scale: number): Entity {
  const root = new Entity('root');
  applyQuakeTransform(root);
  const entity = new Entity('model');
  entity.setLocalEulerAngles(0, 0, yaw);
  entity.setLocalScale(scale, scale, scale);
  root.addChild(entity);
  return entity;
}

describe('deformView', () => {
  it("takes a camera's forward, left and up into a model's frame, each of unit length", () => {
    // Unturned, the camera looks along the world's −z, which is Quake's +y: left is Quake's −x
    // and up its +z.
    const camera = new Entity('camera');
    const unturned = deformView(model(0, 1), camera);
    expectClose(unturned.forward, [0, 1, 0]);
    expectClose(unturned.left, [-1, 0, 0]);
    expectClose(unturned.up, [0, 0, 1]);

    // A model turned 90° left sees the same camera look along its own +x, and at twice the size
    // the axes stay unit, so its sprites keep their size.
    const turned = deformView(model(90, 2), camera);
    expectClose(turned.forward, [1, 0, 0]);
    expectClose(turned.left, [0, 1, 0]);
    expectClose(turned.up, [0, 0, 1]);
  });

  it("gives a stamp the camera's back in the world's frame, however the model is turned", () => {
    const camera = new Entity('camera');
    // Looking down and along the world's +x: Quake's forward and down.
    camera.setEulerAngles(-30, -90, 0);
    const [x, y, z] = [Math.cos(Math.PI / 6), 0, -Math.sin(Math.PI / 6)];
    for (const yaw of [0, 90, 200]) {
      const view = deformView(model(yaw, 1), camera);
      expectClose(view.normal, [-x, -y, -z]);
    }
    // Where the forward itself turns with the model.
    expectClose(deformView(model(90, 1), camera).forward, [0, -x, z]);
  });
});

describe('viewerInModel', () => {
  it("takes where a camera is into a model's own frame, scale and all", () => {
    const entity = model(90, 2);
    entity.setLocalPosition(10, 0, 0);
    // In the world, 64 units above the model's origin and 32 ahead along Quake's +x.
    const camera = new Entity('camera');
    camera.setPosition(entity.getWorldTransform().transformPoint(new Vec3(16, 0, 32)));
    expectClose(viewerInModel(entity, camera), [16, 0, 32]);
  });
});
