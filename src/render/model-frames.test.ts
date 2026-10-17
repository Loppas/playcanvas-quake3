// @vitest-environment jsdom
import {
  FILTER_NEAREST,
  MeshInstance,
  PIXELFORMAT_RGBA32F,
  StandardMaterial,
  type AppBase
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Md3Surface } from '../formats/md3';
import { createTestApp } from './engine-test-fixtures';
import {
  FRAME_TEXTURE_WIDTH,
  firstFrameMesh,
  frameBounds,
  frameTexel,
  frameTexture,
  packFrames,
  quadReach,
  stampMesh,
  surfaceMesh,
  vertexTexel
} from './model-frames';

/**
 * A surface of `numVerts` vertices over `numFrames` frames, each number telling its place: vertex
 * `v` sits at (f, v, 1) in frame f, faces (0, 0, −1 − v), and is textured at (v + 0.5, −v).
 */
function surface(numVerts: number, numFrames: number): Md3Surface {
  const frames = Array.from({ length: numFrames }, (_, f) => ({
    positions: Float32Array.from({ length: numVerts * 3 }, (_, i) => [f, Math.floor(i / 3), 1][i % 3]),
    normals: Float32Array.from({ length: numVerts * 3 }, (_, i) =>
      i % 3 === 2 ? -1 - Math.floor(i / 3) : 0
    )
  }));
  return {
    name: 'test',
    shaders: [],
    numVerts,
    indices: Uint32Array.from({ length: Math.floor(numVerts / 3) * 3 }, (_, i) => i),
    uvs: Float32Array.from({ length: numVerts * 2 }, (_, i) =>
      i % 2 === 0 ? i / 2 + 0.5 : -(i - 1) / 2
    ),
    frames
  };
}

/** The texel at `index` of packed frames, as four numbers. */
function texelAt(data: Float32Array, index: number): number[] {
  return [...data.subarray(index * 4, index * 4 + 4)];
}

describe('packFrames', () => {
  it("lays each vertex's coordinates down, then each frame's vertices in turn", () => {
    const packed = packFrames(surface(3, 2));
    // Three vertices' own, then two frames of three, two texels each: one short row.
    expect([packed.width, packed.height]).toEqual([15, 1]);
    expect(vertexTexel(2)).toBe(2);
    // A vertex in no whole quad has no edge orders.
    expect(texelAt(packed.data, vertexTexel(2))).toEqual([2.5, -2, 0, 0]);
    expect(frameTexel(3, 1, 2, 0)).toBe(13);
    expect(texelAt(packed.data, frameTexel(3, 1, 2, 0))).toEqual([1, 2, 1, 0]);
    expect(texelAt(packed.data, frameTexel(3, 1, 2, 1))).toEqual([0, 0, -3, 0]);
    expect(texelAt(packed.data, frameTexel(3, 0, 0, 1))).toEqual([0, 0, -1, 0]);
  });

  it("marks each vertex with its quad's edge orders, for autosprite2", () => {
    // Six vertices drawn 0 1 2 3 4 5: the first quad's neighbours 0-1, 1-2 and 2-3 are its
    // edges 0, 3 and 5; the last two make no quad.
    const packed = packFrames(surface(6, 1));
    const orders = [0, 1, 2, 3, 4, 5].map((v) => texelAt(packed.data, vertexTexel(v))[2]);
    expect(orders).toEqual([0b101001, 0b101001, 0b101001, 0b101001, 0, 0]);
  });

  it(`wraps at ${FRAME_TEXTURE_WIDTH} texels a row, as WebGL2 guarantees no wider`, () => {
    // 1,100 vertices take 3,300 texels, their own and one frame's: a full row and 1,252 over.
    const packed = packFrames(surface(1100, 1));
    expect([packed.width, packed.height]).toEqual([FRAME_TEXTURE_WIDTH, 2]);
    expect(packed.data.length).toBe(FRAME_TEXTURE_WIDTH * 2 * 4);
    // The last vertex's normal is the 3,300th texel, at (1251, 1).
    expect(frameTexel(1100, 0, 1099, 1)).toBe(FRAME_TEXTURE_WIDTH + 1251);
    expect(texelAt(packed.data, FRAME_TEXTURE_WIDTH + 1251)).toEqual([0, 0, -1100, 0]);
  });
});

describe('frameBounds', () => {
  it('holds the surface in every frame, not just the first', () => {
    // Positions (f, v, 1): x runs over the frames, y over the vertices.
    expect(frameBounds(surface(3, 4))).toEqual({ mins: [0, 0, 1], maxs: [3, 2, 1] });
  });
});

describe('quadReach', () => {
  it("is the farthest any quad's vertex stands from its middle, in any frame", () => {
    // A 2-unit square, then a quad drawn out at its last corner, 7 across and 1 up from its
    // middle at (−1, 1, 7); the vertex left over, far off, makes no quad.
    const square = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 100, 0, 0];
    const kite = [0, 0, 7, 2, 0, 7, 2, 2, 7, -8, 2, 7, 100, 0, 0];
    const two = surface(5, 2);
    two.frames[0].positions = Float32Array.from(square);
    two.frames[1].positions = Float32Array.from(kite);
    expect(quadReach(two)).toBeCloseTo(Math.sqrt(50), 6);
    expect(quadReach(surface(3, 1))).toBe(0);
  });
});

describe('on the device', () => {
  let app: AppBase;
  beforeEach(() => {
    ({ app } = createTestApp());
  });
  afterEach(() => {
    app.destroy();
  });

  it('makes one float texture per surface, unfiltered, and keeps it', () => {
    const one = surface(3, 2);
    const texture = frameTexture(app.graphicsDevice, one);
    expect(texture.format).toBe(PIXELFORMAT_RGBA32F);
    expect([texture.width, texture.height]).toEqual([15, 1]);
    expect(texture.mipmaps).toBe(false);
    // Read by texel, never filtered: WebGL2 cannot filter a 32-bit float without an extension.
    expect([texture.minFilter, texture.magFilter]).toEqual([FILTER_NEAREST, FILTER_NEAREST]);
    expect(frameTexture(app.graphicsDevice, one)).toBe(texture);
    expect(frameTexture(app.graphicsDevice, surface(3, 2))).not.toBe(texture);
  });

  it('makes one static mesh per surface, with a colour stream and every frame in its bounds', () => {
    const one = surface(3, 4);
    const mesh = surfaceMesh(app.graphicsDevice, one);
    expect(surfaceMesh(app.graphicsDevice, one)).toBe(mesh);
    const format = mesh.vertexBuffer!.format;
    expect(format.hasColor).toBe(true);
    expect(format.hasUv(0)).toBe(true);
    expect(format.hasUv(1)).toBe(false);
    // Frame 0's positions and normals, for what reads them; the shader reads its own.
    const positions: number[] = [];
    mesh.getPositions(positions);
    expect(positions).toEqual([...one.frames[0].positions]);
    const normals: number[] = [];
    mesh.getNormals(normals);
    expect(normals).toEqual([...one.frames[0].normals]);
    const uvs: number[] = [];
    mesh.getUvs(0, uvs);
    expect(uvs).toEqual([...one.uvs]);
    const colors: number[] = [];
    mesh.getColors(colors);
    expect(colors).toEqual(new Array(12).fill(255));
    const indices: number[] = [];
    mesh.getIndices(indices);
    expect(indices).toEqual([0, 1, 2]);
    expect(mesh.primitive[0]).toMatchObject({ base: 0, count: 3, indexed: true });
    expect([...mesh.aabb.getMin().toArray()]).toEqual([0, 0, 1]);
    expect([...mesh.aabb.getMax().toArray()]).toEqual([3, 2, 1]);
  });

  it("lays each vertex's attributes side by side, so surfaces of every size share one layout", () => {
    const formats = [
      surfaceMesh(app.graphicsDevice, surface(3, 1)),
      surfaceMesh(app.graphicsDevice, surface(12, 2)),
      stampMesh(app.graphicsDevice, surface(8, 1))
    ].map((mesh) => mesh.vertexBuffer!.format);
    expect(formats.map((format) => format.interleaved)).toEqual([true, true, true]);
    // What WebGPU keys a pipeline by, the attributes' offsets with it.
    expect(new Set(formats.map((format) => format.renderingHashString)).size).toBe(1);
  });

  it('makes a mesh of the first frame, with no colours if none are asked for, bounded by that frame', () => {
    const one = surface(3, 4);
    const mesh = firstFrameMesh(app.graphicsDevice, one, one.indices, false);
    const format = mesh.vertexBuffer!.format;
    expect(format.hasColor).toBe(false);
    expect(format.interleaved).toBe(true);
    const uvs: number[] = [];
    mesh.getUvs(0, uvs);
    expect(uvs).toEqual([...one.uvs]);
    expect([...mesh.aabb.getMin().toArray()]).toEqual([0, 0, 1]);
    expect([...mesh.aabb.getMax().toArray()]).toEqual([0, 2, 1]);
    // Its own, for its owner to let go of.
    expect(mesh.refCount).toBe(0);
  });

  it("makes the stamps' mesh apart, the same vertices drawn by RB_AddQuadStampExt's triangles", () => {
    const one = surface(6, 4);
    const stamp = stampMesh(app.graphicsDevice, one);
    expect(stampMesh(app.graphicsDevice, one)).toBe(stamp);
    expect(stamp).not.toBe(surfaceMesh(app.graphicsDevice, one));
    const indices: number[] = [];
    stamp.getIndices(indices);
    expect(indices).toEqual([0, 1, 3, 3, 1, 2]);
    const positions: number[] = [];
    stamp.getPositions(positions);
    expect(positions).toEqual([...one.frames[0].positions]);
    expect(stamp.vertexBuffer!.format.hasColor).toBe(true);
    expect([...stamp.aabb.getMin().toArray()]).toEqual([0, 0, 1]);
    expect([...stamp.aabb.getMax().toArray()]).toEqual([3, 5, 1]);
  });

  it('outlives every model drawing it', () => {
    const one = surface(3, 1);
    const mesh = surfaceMesh(app.graphicsDevice, one);
    // A model's draws go when it does, and each takes its hold on the mesh with it.
    new MeshInstance(mesh, new StandardMaterial()).destroy();
    expect(mesh.vertexBuffer).not.toBeNull();
    expect(surfaceMesh(app.graphicsDevice, one)).toBe(mesh);
  });
});
