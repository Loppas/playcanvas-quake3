// @vitest-environment jsdom
import {
  BLEND_NORMAL,
  Entity,
  LAYERID_UI,
  LAYERID_WORLD,
  Mesh,
  MeshInstance,
  SEMANTIC_COLOR,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  StandardMaterial,
  TYPE_FLOAT32,
  TYPE_UINT8,
  type AppBase,
  type Layer,
  type Material
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestApp } from './engine-test-fixtures';
import { QuadBatch } from './quad-batch';

/** An unlit, blended material that takes the vertex colour, as the batch's users make theirs. */
function blended(): StandardMaterial {
  const material = new StandardMaterial();
  material.useLighting = false;
  material.blendType = BLEND_NORMAL;
  material.emissiveVertexColor = true;
  material.update();
  return material;
}

const WHITE = [1, 1, 1, 1];

describe('QuadBatch', () => {
  let app: AppBase;
  let camera: Entity;
  let layer: Layer;
  let node: Entity;
  let batch: QuadBatch;
  let red: StandardMaterial;
  let blue: StandardMaterial;

  beforeEach(() => {
    ({ app, camera } = createTestApp());
    layer = app.scene.layers.getLayerById(LAYERID_UI)!;
    node = new Entity('quads');
    app.root.addChild(node);
    batch = new QuadBatch(app.graphicsDevice, node, [layer]);
    red = blended();
    blue = blended();
  });

  afterEach(() => {
    batch?.destroy();
    red.destroy();
    blue.destroy();
    app.destroy();
  });

  /** One frame of quads, each a picture in a material. */
  function frame(materials: readonly Material[]): void {
    batch.begin();
    materials.forEach((material, i) => batch.stretchPic(material, i, 0, 1, 1, 0, 0, 1, 1, WHITE));
    batch.end();
  }

  /** The batch's draws in its layer. */
  function draws(): MeshInstance[] {
    return layer.meshInstances.filter((instance) => instance.node === node);
  }

  /** A draw's mesh: by default the first draw's, whose buffers every draw shares. */
  function mesh(instance = draws()[0]): Mesh {
    return instance.mesh!;
  }

  /** The draws shown, in the order the layer sorts them: each one's material and range. */
  function shown() {
    return draws()
      .filter((instance) => instance.visible)
      .sort((a, b) => a.drawOrder - b.drawOrder)
      .map((instance) => ({
        material: instance.material,
        base: mesh(instance).primitive[0].base,
        count: mesh(instance).primitive[0].count
      }));
  }

  /** The ranges the engine draws in a frame, in its order. */
  function rendered(): { base: number; count: number }[] {
    const ranges: { base: number; count: number }[] = [];
    const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation((primitive) => {
      ranges.push({ base: primitive.base, count: primitive.count });
    });
    app.render();
    draw.mockRestore();
    return ranges;
  }

  /** The corners written: each one's position and texture coordinates, and its colour. */
  function corners(count: number): { at: number[]; color: number[] }[] {
    const storage = mesh().vertexBuffer.storage;
    const floats = new Float32Array(storage);
    const bytes = new Uint8Array(storage);
    return Array.from({ length: count }, (_, i) => ({
      at: [...floats.subarray(i * 6, i * 6 + 5)],
      color: [...bytes.subarray(i * 24 + 20, i * 24 + 24)]
    }));
  }

  it("lays each corner's position, texture coordinates and colour side by side, 24 bytes a corner", () => {
    frame([red]);
    const { format } = mesh().vertexBuffer;
    expect(format.interleaved).toBe(true);
    expect(format.size).toBe(24);
    expect(format.elements.map(({ stride }) => stride)).toEqual([24, 24, 24]);
    expect(
      format.elements.map(({ name, offset, dataType, numComponents, normalize }) => [
        name,
        offset,
        dataType,
        numComponents,
        normalize
      ])
    ).toEqual([
      [SEMANTIC_POSITION, 0, TYPE_FLOAT32, 3, false],
      [SEMANTIC_TEXCOORD0, 12, TYPE_FLOAT32, 2, false],
      [SEMANTIC_COLOR, 20, TYPE_UINT8, 4, true]
    ]);
  });

  it("writes a picture's corners around its rectangle, at its texture coordinates, in its colour", () => {
    batch.begin();
    batch.stretchPic(red, 10, 20, 30, 40, 0.25, 0.5, 0.75, 1, [1, 0.5, 0, 0.25]);
    batch.end();
    const color = [255, 128, 0, 64];
    expect(corners(4)).toEqual([
      { at: [10, 20, 0, 0.25, 0.5], color },
      { at: [40, 20, 0, 0.75, 0.5], color },
      { at: [40, 60, 0, 0.75, 1], color },
      { at: [10, 60, 0, 0.25, 1], color }
    ]);
  });

  it('stamps a whole image about a point, its top left at the point plus left and up', () => {
    batch.begin();
    batch.stamp(red, { x: 100, y: 0, z: 50 }, { x: 0, y: 8, z: 0 }, { x: 0, y: 0, z: 6 }, WHITE);
    batch.end();
    const color = [255, 255, 255, 255];
    expect(corners(4)).toEqual([
      { at: [100, 8, 56, 0, 0], color },
      { at: [100, -8, 56, 1, 0], color },
      { at: [100, -8, 44, 1, 1], color },
      { at: [100, 8, 44, 0, 1], color }
    ]);
  });

  it('holds a colour above 1 at full and one below 0 at none', () => {
    batch.begin();
    batch.stretchPic(red, 0, 0, 1, 1, 0, 0, 1, 1, [2, -1, 1, 0]);
    batch.end();
    expect(corners(1)[0].color).toEqual([255, 0, 255, 0]);
  });

  it('indexes each quad as two triangles, wound as Q3 winds a quad', () => {
    frame([red, red]);
    const indices = new Uint32Array(mesh().indexBuffer[0].storage);
    expect([...indices.subarray(0, 12)]).toEqual([0, 1, 3, 3, 1, 2, 4, 5, 7, 7, 5, 6]);
  });

  it('draws each run of quads in one material as one draw, in the order the runs were written', () => {
    frame([red, red, blue, red]);
    expect(shown()).toEqual([
      { material: red, base: 0, count: 12 },
      { material: blue, base: 12, count: 6 },
      { material: red, base: 18, count: 6 }
    ]);
    expect(rendered()).toEqual([
      { base: 0, count: 12 },
      { base: 12, count: 6 },
      { base: 18, count: 6 }
    ]);
  });

  it("ends a run at its writer's word, so the next quad in its material is a draw of its own", () => {
    batch.begin();
    batch.stretchPic(red, 0, 0, 1, 1, 0, 0, 1, 1, WHITE);
    batch.endRun();
    batch.stretchPic(red, 1, 0, 1, 1, 0, 0, 1, 1, WHITE);
    batch.stretchPic(red, 2, 0, 1, 1, 0, 0, 1, 1, WHITE);
    batch.end();
    expect(shown()).toEqual([
      { material: red, base: 0, count: 6 },
      { material: red, base: 6, count: 12 }
    ]);
    // Only for that frame.
    frame([red, red]);
    expect(shown()).toEqual([{ material: red, base: 0, count: 12 }]);
  });

  it('draws its runs in order where a layer sorts back to front, all at the eye, placed by its bucket', () => {
    const world = app.scene.layers.getLayerById(LAYERID_WORLD)!;
    // A blended triangle ten units ahead of the eye, in the layer's default bucket.
    const ahead = new Entity('ahead');
    ahead.setPosition(0, 0, -10);
    app.root.addChild(ahead);
    const triangle = new Mesh(app.graphicsDevice);
    triangle.setPositions([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    triangle.setNormals([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    triangle.update();
    const glass = blended();
    world.addMeshInstances([new MeshInstance(triangle, glass, ahead)]);
    const order = (drawBucket?: number) => {
      const sorted = new QuadBatch(app.graphicsDevice, node, [world], drawBucket);
      // Each material's draw made in one order, then its runs written in the other.
      for (const materials of [[red, blue], [blue, red]]) {
        sorted.begin();
        for (const material of materials) {
          sorted.stretchPic(material, 0, 0, 1, 1, 0, 0, 1, 1, WHITE);
        }
        sorted.end();
      }
      const ranges = rendered();
      sorted.destroy();
      return ranges;
    };
    const runs = [
      { base: 0, count: 6 },
      { base: 6, count: 6 }
    ];
    expect(order()).toEqual([{ base: 0, count: 3 }, ...runs]);
    expect(order(128)).toEqual([...runs, { base: 0, count: 3 }]);
    glass.destroy();
  });

  it("starts each frame's runs afresh, whatever the last frame wrote", () => {
    frame([red, red, red]);
    frame([blue, red]);
    expect(shown()).toEqual([
      { material: blue, base: 0, count: 6 },
      { material: red, base: 6, count: 6 }
    ]);
  });

  it('draws its quads wherever they are, as no bounds of its own would hold them', () => {
    // In view, and far from the node's origin, which is beyond the camera's far plane.
    camera.setPosition(0, 0, 1500);
    batch.begin();
    batch.stamp(red, { x: 0, y: 0, z: 1400 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, WHITE);
    batch.end();
    expect(rendered()).toEqual([{ base: 0, count: 6 }]);
  });

  it('never gives a draw another material, and hides the draws a frame does not use', () => {
    frame([red, blue, red]);
    const made = draws();
    expect(made).toHaveLength(3);
    const assigned = made.map((instance) => vi.spyOn(instance, 'material', 'set'));
    const added = vi.spyOn(layer, 'addMeshInstances');
    const removed = vi.spyOn(layer, 'removeMeshInstances');

    frame([blue, red]);
    expect(shown()).toEqual([
      { material: blue, base: 0, count: 6 },
      { material: red, base: 6, count: 6 }
    ]);
    frame([]);
    expect(shown()).toEqual([]);
    expect(rendered()).toEqual([]);
    frame([red, blue, red]);
    expect(shown().map(({ material }) => material)).toEqual([red, blue, red]);

    expect(draws()).toEqual(made);
    for (const spy of assigned) expect(spy).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  it('uploads a frame in one write, of the quads it wrote', () => {
    frame([red]);
    const unlock = vi.spyOn(mesh().vertexBuffer, 'unlock');
    frame([red, blue, red]);
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalledWith(0, 3 * 96);
  });

  it('doubles its room when full, keeping the quads written, in buffers of the same format', () => {
    frame([blue]);
    const [first] = draws();
    const { vertexBuffer: vertices, indexBuffer } = mesh(first);
    const room = vertices.numVertices / 4;
    const freed = [vi.spyOn(vertices, 'destroy'), vi.spyOn(indexBuffer[0], 'destroy')];

    batch.begin();
    batch.stretchPic(blue, 7, 0, 1, 1, 0, 0, 1, 1, WHITE);
    for (let i = 1; i <= room; i++) batch.stretchPic(red, i, 0, 1, 1, 0, 0, 1, 1, WHITE);
    batch.end();

    const grown = mesh(first).vertexBuffer;
    expect(grown).not.toBe(vertices);
    expect(grown.numVertices).toBe(room * 2 * 4);
    expect(grown.format.renderingHashString).toBe(vertices.format.renderingHashString);
    expect(mesh(first).indexBuffer[0].numIndices).toBe(room * 2 * 6);
    for (const spy of freed) expect(spy).toHaveBeenCalledTimes(1);
    // Every draw, the one made before the growth too, is on the new buffers.
    for (const instance of draws()) {
      expect(mesh(instance).vertexBuffer).toBe(grown);
      expect(mesh(instance).indexBuffer[0]).toBe(mesh(first).indexBuffer[0]);
    }
    // Each quad's first corner: the one written before the growth, and the last.
    const written = corners((room + 1) * 4);
    expect(written[0].at).toEqual([7, 0, 0, 0, 0]);
    expect(written[room * 4].at).toEqual([room, 0, 0, 0, 0]);
    expect(shown()).toEqual([
      { material: blue, base: 0, count: 6 },
      { material: red, base: 6, count: room * 6 }
    ]);
  });

  it("moves every draw made to other layers, and names the last frame's draw of each run", () => {
    frame([red, blue, red]);
    const runs = draws();
    expect(batch.runsDrawn).toBe(3);
    expect([0, 1, 2].map((run) => batch.runInstance(run).material)).toEqual([red, blue, red]);
    const world = app.scene.layers.getLayerById(LAYERID_WORLD)!;
    batch.setLayers([world]);
    expect(draws()).toEqual([]);
    const moved = world.meshInstances.filter((instance) => instance.node === node);
    expect(moved).toHaveLength(runs.length);
    expect(runs.every((run) => moved.includes(run))).toBe(true);
    // A draw made after the move goes in the new layers.
    frame([red, blue, red, blue]);
    expect(world.meshInstances.filter((instance) => instance.node === node)).toHaveLength(4);
    expect(draws()).toEqual([]);
  });

  it('takes its draws out of their layers when destroyed, and lets go of its buffers once', () => {
    frame([red, blue]);
    const { vertexBuffer, indexBuffer } = mesh();
    const freed = [vi.spyOn(vertexBuffer, 'destroy'), vi.spyOn(indexBuffer[0], 'destroy')];
    batch.destroy();
    batch = undefined!;
    expect(draws()).toEqual([]);
    for (const spy of freed) expect(spy).toHaveBeenCalledTimes(1);
  });
});
