// @vitest-environment jsdom
import { Entity, Layer, Mesh, MeshInstance, StandardMaterial, type AppBase } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ORDER_STEP, sortAsModel } from './draw-order';
import { createTestApp } from './engine-test-fixtures';

/**
 * The order draws come out of the engine's own back-to-front sort, on the null device: a camera
 * at the origin looking down −Z, so a thing's distance is how far it stands down −Z.
 */

let app: AppBase;
let camera: Entity;
let layer: Layer;

beforeEach(() => {
  ({ app, camera } = createTestApp());
  layer = new Layer({ name: 'blended' });
});

afterEach(() => {
  app.destroy();
});

/** A draw of a small triangle `depth` down the view, its place in its model's order `order`. */
function drawAt(depth: number, order = 0): MeshInstance {
  const mesh = new Mesh(app.graphicsDevice);
  mesh.setPositions([-1, 0, -depth, 1, 0, -depth, 0, 1, -depth]);
  mesh.setIndices([0, 1, 2]);
  mesh.update();
  // Its bounds are read in the world, through a node of its own.
  const draw = new MeshInstance(mesh, new StandardMaterial(), new Entity('draw'));
  draw.drawOrder = order;
  return draw;
}

/** A model's own node, `depth` down the view, hung halfway there from a parent as a body's parts are. */
function modelAt(depth: number): Entity {
  const parent = new Entity('parent');
  parent.setPosition(0, 0, -depth / 2);
  app.root.addChild(parent);
  const entity = new Entity('model');
  parent.addChild(entity);
  entity.setPosition(0, 0, -depth);
  return entity;
}

/** The draws, handed to the layer as given, in the order it draws them back to front. */
function sorted(draws: MeshInstance[]): MeshInstance[] {
  const culled = layer.getCulledInstances(camera.camera!.camera);
  culled.transparent = [...draws];
  layer.sortVisible(camera.camera!.camera, true);
  return culled.transparent;
}

describe('sortAsModel', () => {
  it("draws a model's draws in the order it adds them, whatever their own bounds", () => {
    const first = drawAt(5, 0);
    const second = drawAt(20, 1);
    // By its own bounds the farther draws first.
    expect(sorted([first, second])).toEqual([second, first]);
    sortAsModel([first, second], modelAt(10));
    expect(sorted([second, first])).toEqual([first, second]);
  });

  it('draws two models back to front by their origins, wherever each is when the layer sorts', () => {
    // The far model's draws stand nearer than the near one's.
    const far = [drawAt(1, 0), drawAt(1, 1)];
    const near = [drawAt(50, 0), drawAt(50, 1)];
    const farModel = modelAt(30);
    sortAsModel(far, farModel);
    sortAsModel(near, modelAt(10));
    expect(sorted([...near, ...far])).toEqual([...far, ...near]);
    farModel.setPosition(0, 0, -5);
    expect(sorted([...far, ...near])).toEqual([...near, ...far]);
  });

  it("keeps a model's every place apart at the far end of a map, past the engine's bucket", () => {
    // 8192 units down the view, at 32 to the metre, and more draws than a body has.
    const draws = Array.from({ length: 64 }, (_, order) => drawAt(1, order));
    sortAsModel(draws, modelAt(256));
    expect(sorted([...draws].reverse())).toEqual(draws);
    expect(draws[1].calculateSortDistance!(draws[1], camera.getPosition(), camera.forward)).toBeCloseTo(
      256 - ORDER_STEP,
      9
    );
  });
});
