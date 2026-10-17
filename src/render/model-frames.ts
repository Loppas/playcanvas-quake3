import {
  ADDRESS_CLAMP_TO_EDGE,
  BoundingBox,
  FILTER_NEAREST,
  INDEXFORMAT_UINT16,
  INDEXFORMAT_UINT32,
  IndexBuffer,
  Mesh,
  PIXELFORMAT_RGBA32F,
  PRIMITIVE_TRIANGLES,
  SEMANTIC_COLOR,
  SEMANTIC_NORMAL,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  Texture,
  TYPE_FLOAT32,
  TYPE_UINT8,
  Vec3,
  VertexBuffer,
  VertexFormat,
  VertexIterator,
  type GraphicsDevice
} from 'playcanvas';

import type { Md3Surface } from '../formats/md3';
import { quadEdgeOrders, stampIndices } from '../view/vertex-deform';

/**
 * An MD3 surface kept on the GPU whole, for the model chunks (`model-chunks.ts`) to morph and
 * deform there: every frame in a float texture, and one mesh that never changes, or a second
 * drawing the squares `autosprite` stamps. ioq3's `opengl2`
 * keeps every frame in one vertex buffer and binds two of them per draw
 * (`renderergl2/tr_surface.c:1245–1285`); a texture read by vertex index does the same through
 * PlayCanvas's own materials.
 *
 * Both belong to the surface, not to an entity: every model drawing it shares them, and they are
 * kept for the page's life, as the asset library keeps the surface.
 */

/** Texels a row at most: WebGL2's least `MAX_TEXTURE_SIZE`. */
export const FRAME_TEXTURE_WIDTH = 2048;

/** Texels a vertex takes in each frame: its position, then its normal. */
export const TEXELS_PER_VERTEX = 2;

/**
 * Which texel holds what no frame changes about a vertex: its first texture coordinates, s and t,
 * then which of its quad's edges the surface's triangles name in order (`quadEdgeOrders`), for
 * `autosprite2`; 0 for a vertex in no whole quad. They come first, one texel for each vertex.
 */
export function vertexTexel(vertex: number): number {
  return vertex;
}

/**
 * Which texel holds one vertex's position (`part` 0) or normal (`part` 1) in one frame: after the
 * vertices' own, the frames in turn, each its vertices in turn. The chunks read it at
 * `(index mod width, index div width)`.
 */
export function frameTexel(numVerts: number, frame: number, vertex: number, part: 0 | 1): number {
  return numVerts + (frame * numVerts + vertex) * TEXELS_PER_VERTEX + part;
}

/** A surface's frames as RGBA float texels, row by row. */
export interface FrameTexels {
  width: number;
  height: number;
  /** `width * height * 4` floats; any lane not written is 0, and so is any texel past the last. */
  data: Float32Array;
}

/**
 * A surface laid out for its texture, as `formats/md3.ts` decodes it: each vertex's coordinates
 * and its quad's edge orders ({@link vertexTexel}), then the frames' positions and normals, the
 * same `lerpMeshVertexes` reads ({@link frameTexel}). A short surface takes one row only as wide
 * as it needs.
 */
export function packFrames(surface: Md3Surface): FrameTexels {
  const { numVerts, frames } = surface;
  const count = numVerts + frames.length * numVerts * TEXELS_PER_VERTEX;
  const width = Math.max(1, Math.min(FRAME_TEXTURE_WIDTH, count));
  const height = Math.max(1, Math.ceil(count / width));
  const data = new Float32Array(width * height * 4);
  const orders = quadEdgeOrders(surface.indices, numVerts);
  for (let v = 0; v < numVerts; v++) {
    const at = vertexTexel(v) * 4;
    data.set(surface.uvs.subarray(v * 2, v * 2 + 2), at);
    data[at + 2] = orders[Math.floor(v / 4)] ?? 0;
  }
  frames.forEach((frame, f) => {
    for (let v = 0; v < numVerts; v++) {
      const at = frameTexel(numVerts, f, v, 0) * 4;
      data.set(frame.positions.subarray(v * 3, v * 3 + 3), at);
      data.set(frame.normals.subarray(v * 3, v * 3 + 3), at + 4);
    }
  });
  return { width, height, data };
}

/** The box holding a surface in every one of its frames, in the model's own frame. */
export function frameBounds(surface: Md3Surface): {
  mins: [number, number, number];
  maxs: [number, number, number];
} {
  const mins: [number, number, number] = [Infinity, Infinity, Infinity];
  const maxs: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { positions } of surface.frames) {
    for (let i = 0; i < positions.length; i++) {
      const axis = i % 3;
      mins[axis] = Math.min(mins[axis], positions[i]);
      maxs[axis] = Math.max(maxs[axis], positions[i]);
    }
  }
  return { mins, maxs };
}

/**
 * How far any vertex of a whole quad stands from its quad's middle, in any frame: as far as a
 * sprite deform can put a corner from that middle. `autosprite` stands each corner
 * `|v₀ − mid| · 0.707 · √2` from it, and `autosprite2` each end's vertices half the end from its
 * middle, which is no further. A frame blend's vertices stand no further than both frames'.
 */
export function quadReach(surface: Md3Surface): number {
  const quads = Math.floor(surface.numVerts / 4);
  let reach = 0;
  for (const { positions } of surface.frames) {
    for (let quad = 0; quad < quads; quad++) {
      const p = quad * 12;
      const mid = [0, 1, 2].map(
        (axis) =>
          0.25 * (positions[p + axis] + positions[p + 3 + axis] + positions[p + 6 + axis] + positions[p + 9 + axis])
      );
      for (let corner = 0; corner < 4; corner++) {
        const at = p + corner * 3;
        reach = Math.max(
          reach,
          Math.hypot(positions[at] - mid[0], positions[at + 1] - mid[1], positions[at + 2] - mid[2])
        );
      }
    }
  }
  return reach;
}

/** `bounds` grown by `reach` on every side: where a surface can be once its deforms move it. */
export function grownBounds(bounds: BoundingBox, reach: number): BoundingBox {
  const halfExtents = bounds.halfExtents.clone().add(new Vec3(reach, reach, reach));
  return new BoundingBox(bounds.center.clone(), halfExtents);
}

/** Each device's textures and meshes, by surface. */
const textures = new WeakMap<GraphicsDevice, WeakMap<Md3Surface, Texture>>();
const meshes = new WeakMap<GraphicsDevice, WeakMap<Md3Surface, Mesh>>();
const stamps = new WeakMap<GraphicsDevice, WeakMap<Md3Surface, Mesh>>();

/** What `cache` holds for `device` and `surface`, made by `make` the first time. */
function cached<T>(
  cache: WeakMap<GraphicsDevice, WeakMap<Md3Surface, T>>,
  device: GraphicsDevice,
  surface: Md3Surface,
  make: () => T
): T {
  let bySurface = cache.get(device);
  if (!bySurface) {
    bySurface = new WeakMap();
    cache.set(device, bySurface);
  }
  let value = bySurface.get(surface);
  if (value === undefined) {
    value = make();
    bySurface.set(surface, value);
  }
  return value;
}

/**
 * A surface's frames in an unfiltered RGBA32F texture ({@link packFrames}), made once per device.
 */
export function frameTexture(device: GraphicsDevice, surface: Md3Surface): Texture {
  return cached(textures, device, surface, () => {
    const { width, height, data } = packFrames(surface);
    return new Texture(device, {
      name: `frames:${surface.name}`,
      width,
      height,
      format: PIXELFORMAT_RGBA32F,
      mipmaps: false,
      minFilter: FILTER_NEAREST,
      magFilter: FILTER_NEAREST,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
      levels: [data]
    });
  });
}

/**
 * A surface's one mesh, made once per device and never changed. It keeps frame 0's positions and
 * normals for anything that reads them, the surface's own coordinates, and a white colour stream
 * so a lit or a shining stage's material still reads vertex colours, which the chunks write. Its
 * bounds hold every frame. Its instances pin it, and so does this, so it outlives them all.
 */
export function surfaceMesh(device: GraphicsDevice, surface: Md3Surface): Mesh {
  return cached(meshes, device, surface, () => keptMesh(device, surface, surface.indices));
}

/**
 * The same, drawn by the triangles `RB_AddQuadStampExt` gives the squares `autosprite` stamps
 * (`stampIndices`) in place of the surface's own: Q3 draws the stamps, not the quads.
 */
export function stampMesh(device: GraphicsDevice, surface: Md3Surface): Mesh {
  return cached(stamps, device, surface, () => keptMesh(device, surface, stampIndices(surface.numVerts)));
}

/** A surface's mesh, as {@link surfaceMesh} describes it, drawn by `indices`. */
function keptMesh(device: GraphicsDevice, surface: Md3Surface, indices: Uint32Array): Mesh {
  const mesh = firstFrameMesh(device, surface, indices, true);
  const { mins, maxs } = frameBounds(surface);
  const bounds = new BoundingBox();
  bounds.setMinMax(new Vec3(...mins), new Vec3(...maxs));
  mesh.aabb = bounds;
  mesh.incRefCount();
  return mesh;
}

/**
 * A surface's first frame as a mesh drawn by `indices`, bounded by that frame: each vertex's
 * position, normal, texture coordinates and, if `white`, an opaque white colour, side by side in
 * one buffer. `Mesh.update` lays each attribute out in a block sized to the vertex count, and
 * WebGPU keys a pipeline by the attributes' offsets, so a shader would make pipelines of its own
 * for each surface of a new size; side by side, the offsets are the vertex's own.
 */
export function firstFrameMesh(
  device: GraphicsDevice,
  surface: Md3Surface,
  indices: Uint32Array,
  white: boolean
): Mesh {
  const { numVerts } = surface;
  const first = surface.frames[0];
  const format = new VertexFormat(device, [
    { semantic: SEMANTIC_POSITION, components: 3, type: TYPE_FLOAT32 },
    { semantic: SEMANTIC_NORMAL, components: 3, type: TYPE_FLOAT32 },
    { semantic: SEMANTIC_TEXCOORD0, components: 2, type: TYPE_FLOAT32 },
    ...(white ? [{ semantic: SEMANTIC_COLOR, components: 4, type: TYPE_UINT8, normalize: true }] : [])
  ]);
  const vertices = new VertexBuffer(device, format, numVerts);
  const iterator = new VertexIterator(vertices);
  iterator.writeData(SEMANTIC_POSITION, first.positions, numVerts);
  iterator.writeData(SEMANTIC_NORMAL, first.normals, numVerts);
  // Texture coordinates go in unchanged. Two flips cancel: Q3's TGA loader rewrites a
  // bottom-origin file into top-down rows and uploads them with the first row at v = 0, and our
  // decoder and PlayCanvas (whose `flipY` defaults to false) do the same. So v = 0 is the top of
  // the image in both engines; mirroring V here turns every weapon skin upside down.
  iterator.writeData(SEMANTIC_TEXCOORD0, surface.uvs, numVerts);
  if (white) iterator.writeData(SEMANTIC_COLOR, new Uint8Array(numVerts * 4).fill(255), numVerts);
  iterator.end();

  const triangles = new IndexBuffer(
    device,
    numVerts > 0xffff ? INDEXFORMAT_UINT32 : INDEXFORMAT_UINT16,
    indices.length
  );
  triangles.writeData(indices, indices.length);

  const mesh = new Mesh(device);
  mesh.vertexBuffer = vertices;
  mesh.indexBuffer[0] = triangles;
  mesh.primitive[0] = { type: PRIMITIVE_TRIANGLES, base: 0, baseVertex: 0, count: indices.length, indexed: true };
  const bounds = new BoundingBox();
  bounds.compute(first.positions, numVerts);
  mesh.aabb = bounds;
  return mesh;
}
