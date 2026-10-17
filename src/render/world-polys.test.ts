// @vitest-environment jsdom
import { GraphNode, Layer, StandardMaterial, type AppBase, type MeshInstance } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ScenePolys, polyVerts } from '../view/scene-polys';
import { WORLD_ENTITY, sceneKey } from '../view/scene-sort';
import { worldVertexFormat } from './bsp-world';
import { createTestApp } from './engine-test-fixtures';
import { FOG_UNIFORM } from './fog-chunks';
import { WorldPolys } from './world-polys';
import type { WorldStage } from './world-stages';

/** Where the polys' steps start within a key. */
const STEP = 1 << 15;

/** A shader of the test's: its place, and its stages' materials, fogged and not. */
interface TestShader {
  name: string;
  place: number;
  own: WorldStage[];
  fogged: WorldStage[];
}

function stages(n: number): WorldStage[] {
  return Array.from({ length: n }, () => ({
    material: new StandardMaterial(),
    parameters: [],
    eye: false,
    lit: false
  }));
}

function shader(name: string, place: number, count = 1): TestShader {
  return { name, place, own: stages(count), fogged: stages(count) };
}

describe("the frame's polys, drawn", () => {
  let app: AppBase;
  let layer: Layer;
  const fogs = [new Float32Array(12).fill(1), new Float32Array(12).fill(2)];

  beforeEach(() => {
    ({ app } = createTestApp());
    layer = new Layer({ name: 'test' });
  });

  afterEach(() => {
    app.destroy();
  });

  function worldPolys(made: (shader: TestShader) => boolean = () => true) {
    return new WorldPolys<TestShader>(
      app.graphicsDevice,
      layer,
      new GraphNode(),
      worldVertexFormat(app.graphicsDevice),
      (s, fogged) => (made(s) ? (fogged ? s.fogged : s.own) : null),
      (s) => s.place,
      (fog) => fogs[fog - 1],
      new Float32Array(16),
      600
    );
  }

  /** Each poly of `points` points, each at (i, 0, 0) for its `i`th. */
  function scene(...polys: [TestShader, number, number?][]): ScenePolys<TestShader> {
    const out = new ScenePolys<TestShader>(() => {});
    out.inWorld([{ bounds: [[1000, 1000, 1000], [2000, 2000, 2000]] }]);
    for (const [s, points, fog = 0] of polys) {
      const verts = polyVerts(points);
      for (let i = 0; i < points; i++) verts.xyz[i * 3] = i;
      out.add(s, points, verts, 0);
      out.fogs[out.count - 1] = fog;
    }
    return out;
  }

  /** The draws shown, in their keys' order: each its material, its range and its key. */
  function shown() {
    return layer.meshInstances
      .filter((instance: MeshInstance) => instance.visible)
      .sort((a, b) => a.drawOrder - b.drawOrder)
      .map((instance) => {
        const { base, count } = instance.mesh!.primitive[0];
        return { material: instance.material, base, count, key: instance.drawOrder };
      });
  }

  it('draws a run of a shader and a fog as one batch of fans, stage by stage, at its place', () => {
    const a = shader('a', 5, 2);
    const b = shader('b', 3);
    const polys = worldPolys();
    polys.draw(scene([a, 3], [b, 4], [a, 3]));
    const key = (place: number, step: number) => sceneKey(place, WORLD_ENTITY, 0, false, step);
    // b's first, by its place; a's two in the order added, one fan after the other.
    expect(shown()).toEqual([
      { material: b.own[0].material, base: 0, count: 6, key: key(3, STEP) },
      { material: a.own[0].material, base: 6, count: 6, key: key(5, STEP) },
      { material: a.own[1].material, base: 6, count: 6, key: key(5, STEP + 1) }
    ]);
    const { mesh } = layer.meshInstances[0];
    const storage = mesh!.indexBuffer[0].storage as ArrayBuffer;
    // b's fan of four points, then a's two of three, each numbered from where its points went in.
    expect([...new Uint32Array(storage, 0, 12)]).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Each point in the world's format: b's second at x 1, a's first at x 0.
    const vertices = mesh!.vertexBuffer.storage as ArrayBuffer;
    const floats = new Float32Array(vertices);
    const stride = worldVertexFormat(app.graphicsDevice).size / 4;
    expect([floats[stride], floats[4 * stride]]).toEqual([1, 0]);
    expect(polys.speeds).toEqual({
      polys: 3,
      batches: 2,
      vertexes: 10,
      indexes: 12,
      passIndexes: 18
    });
  });

  it("parts a shader's polys by fog, a fogged draw reading its fog in the world's frame", () => {
    const a = shader('a', 5);
    worldPolys().draw(scene([a, 3, 2], [a, 3, 0]));
    const [plain, fogged] = shown();
    expect([plain.material, plain.key]).toEqual([
      a.own[0].material,
      sceneKey(5, WORLD_ENTITY, 0, false, STEP)
    ]);
    expect([fogged.material, fogged.key]).toEqual([
      a.fogged[0].material,
      sceneKey(5, WORLD_ENTITY, 2, false, STEP)
    ]);
    const instance = layer.meshInstances.find((i) => i.material === a.fogged[0].material)!;
    expect((instance.getParameter(FOG_UNIFORM) as { data: unknown }).data).toBe(fogs[1]);
  });

  it("keeps the order added within a key, and gathers a fog's polys from among another's", () => {
    const a = shader('a', 5);
    const polys = new ScenePolys<TestShader>(() => {});
    for (const [x, fog] of [
      [10, 0],
      [20, 2],
      [30, 0]
    ]) {
      const verts = polyVerts(3);
      verts.xyz.fill(x);
      polys.add(a, 3, verts, 0);
      polys.fogs[polys.count - 1] = fog;
    }
    worldPolys().draw(polys);
    // The two out of a fog one batch, the first added first; the fogged one after.
    expect(shown().map(({ base, count }) => [base, count])).toEqual([
      [0, 6],
      [6, 3]
    ]);
    const vertices = layer.meshInstances[0].mesh!.vertexBuffer.storage as ArrayBuffer;
    const floats = new Float32Array(vertices);
    const stride = worldVertexFormat(app.graphicsDevice).size / 4;
    expect([0, 3, 6].map((v) => floats[v * stride])).toEqual([10, 30, 20]);
  });

  it('cuts a batch where the tessellator would overflow, the next a step on', () => {
    const a = shader('a', 5);
    worldPolys().draw(scene(...Array.from({ length: 100 }, (): [TestShader, number] => [a, 10])));
    // 99 polys' 990 points, and the hundredth's would make 1,000.
    expect(shown().map(({ base, count, key }) => [base, count, key])).toEqual([
      [0, 99 * 24, sceneKey(5, WORLD_ENTITY, 0, false, STEP)],
      [99 * 24, 24, sceneKey(5, WORLD_ENTITY, 0, false, STEP + 1)]
    ]);
  });

  it('draws nothing of a shader with no stages made, and hides what a frame does not give', () => {
    const a = shader('a', 5);
    const b = shader('b', 3);
    const polys = worldPolys((s) => s !== b);
    polys.draw(scene([a, 3], [b, 3], [a, 3]));
    expect(shown().map(({ base, count }) => [base, count])).toEqual([[0, 6]]);
    polys.draw(scene());
    expect(shown()).toEqual([]);
    expect(polys.speeds.polys).toBe(0);
  });

  it('keys its draws again where a shader sorted in moves their places', () => {
    const a = shader('a', 5);
    const polys = worldPolys();
    polys.draw(scene([a, 3]));
    a.place = 9;
    polys.key();
    expect(shown()[0].key).toBe(sceneKey(9, WORLD_ENTITY, 0, false, STEP));
  });

  it("warms each stage of each shader over a triangle of no size, in a fog's colours too", () => {
    const a = shader('a', 5, 2);
    const polys = worldPolys();
    polys.warm([a], 1);
    expect(shown().map(({ material, count }) => [material, count])).toEqual([
      [a.own[0].material, 3],
      [a.own[1].material, 3],
      [a.fogged[0].material, 3],
      [a.fogged[1].material, 3]
    ]);
    polys.hide();
    expect(shown()).toEqual([]);
  });
});
