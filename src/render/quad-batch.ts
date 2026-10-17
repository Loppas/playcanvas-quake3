import {
  BUFFER_DYNAMIC,
  BUFFER_STATIC,
  INDEXFORMAT_UINT32,
  IndexBuffer,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  SEMANTIC_COLOR,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  TYPE_FLOAT32,
  TYPE_UINT8,
  VertexBuffer,
  VertexFormat,
  type GraphicsDevice,
  type GraphNode,
  type Layer,
  type Material
} from 'playcanvas';

import { ORDER_STEP } from './draw-order';

/**
 * Quads written each frame and drawn a run at a time, as Quake 3's backend draws its 2D pictures
 * and its merged sprites: quads written one after another in one shader are one draw, as
 * `RB_StretchPic` and `RB_RenderDrawSurfList` flush only when the shader changes, and the draws go
 * in the order their runs were written.
 *
 * Every quad of a frame goes into one buffer, uploaded in one write at its end, and each run's draw
 * is that buffer's range. A material keeps its own draws, used in turn by its runs, so no draw is
 * ever given another material, and one no run needs is hidden rather than taken out of its layers.
 *
 * A material draws a quad's colour only if it reads the vertex colour (`emissiveVertexColor`,
 * `opacityVertexColor`). The shader clamps it at 1, so a brightness above 1 goes on the material,
 * and `vertexColorGamma` decodes it as a texture's texel is decoded. A layer that sorts by hand
 * draws the runs in order, and so does one that sorts back to front, which puts them all at the
 * eye and leaves their place among its other draws to their draw bucket. `LAYERID_UI` draws only
 * blended draws, so a material there is blended.
 */

/** Bytes a corner takes: its position, its texture coordinates and its colour, side by side. */
const CORNER_BYTES = 24;
/** Where a corner's colour starts, in its bytes. */
const COLOR_BYTE = 20;
/** Bytes a quad takes. */
const QUAD_BYTES = CORNER_BYTES * 4;
/** Indices a quad takes: two triangles. */
const QUAD_INDICES = 6;
/** The quads the buffer holds at first. */
const FIRST_CAPACITY = 64;

/** A point, as the view and the engine both spell one. */
export interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** One draw: a mesh over the shared buffers, whose range is its run's. */
interface Draw {
  mesh: Mesh;
  instance: MeshInstance;
}

/** A material's draws, and how many of them this frame's runs have used. */
interface Pool {
  draws: Draw[];
  used: number;
}

/** Quads written one after another in one material. */
interface Run {
  material: Material;
  first: number;
  count: number;
}

export class QuadBatch {
  private readonly device: GraphicsDevice;
  private readonly node: GraphNode;
  private layers: readonly Layer[];
  private readonly drawBucket: number | undefined;
  private readonly format: VertexFormat;
  private readonly pools = new Map<Material, Pool>();
  /** This frame's runs, in the order written; the array outlives the frame, its tail unused. */
  private readonly runs: Run[] = [];
  /** Each of the last frame's runs' draws, in the order written; its tail unused. */
  private readonly runDraws: MeshInstance[] = [];
  private runCount = 0;
  /** The runs a quad can no longer join: all but the last, or all of them once it is ended. */
  private closed = 0;
  private quads = 0;
  private capacity = FIRST_CAPACITY;
  private vertices: VertexBuffer;
  private indices: IndexBuffer;
  private floats: Float32Array;
  private bytes: Uint8ClampedArray;

  /**
   * @param node - Places every quad: the quads are written in its space.
   * @param layers - The layers the quads draw in.
   * @param drawBucket - The draws' `drawBucket`, where a layer sorts them among its others.
   */
  constructor(
    device: GraphicsDevice,
    node: GraphNode,
    layers: readonly Layer[],
    drawBucket?: number
  ) {
    this.device = device;
    this.node = node;
    this.layers = layers;
    this.drawBucket = drawBucket;
    this.format = new VertexFormat(device, [
      { semantic: SEMANTIC_POSITION, components: 3, type: TYPE_FLOAT32 },
      { semantic: SEMANTIC_TEXCOORD0, components: 2, type: TYPE_FLOAT32 },
      { semantic: SEMANTIC_COLOR, components: 4, type: TYPE_UINT8, normalize: true }
    ]);
    this.vertices = this.vertexBuffer(this.capacity);
    this.indices = quadIndices(device, this.capacity);
    this.floats = new Float32Array(this.vertices.storage);
    this.bytes = new Uint8ClampedArray(this.vertices.storage);
  }

  /** Draw in other layers from now on, every draw made so far moved to them. */
  setLayers(layers: readonly Layer[]): void {
    for (const pool of this.pools.values()) {
      const instances = pool.draws.map((draw) => draw.instance);
      for (const layer of this.layers) layer.removeMeshInstances(instances, true);
      for (const layer of layers) layer.addMeshInstances(instances, true);
    }
    this.layers = layers;
  }

  /** How many runs the last frame drew. */
  get runsDrawn(): number {
    return this.runCount;
  }

  /** The draw of the last frame's `run`th run, until the next frame's {@link end}. */
  runInstance(run: number): MeshInstance {
    return this.runDraws[run];
  }

  /** Start a frame: no quad written yet. */
  begin(): void {
    this.quads = 0;
    this.runCount = 0;
    this.closed = 0;
  }

  /** End the run being written: the next quad starts a draw of its own, even in its material. */
  endRun(): void {
    this.closed = this.runCount;
  }

  /**
   * A picture over a rectangle, as `RB_StretchPic` writes one: from (x, y) to (x + w, y + h), at
   * the texture's (s1, t1) and (s2, t2).
   *
   * @param color - Red, green, blue and alpha, each from 0 to 1.
   */
  stretchPic(
    material: Material,
    x: number,
    y: number,
    w: number,
    h: number,
    s1: number,
    t1: number,
    s2: number,
    t2: number,
    color: ArrayLike<number>
  ): void {
    const at = this.next(material) * 4;
    this.corner(at, x, y, 0, s1, t1, color);
    this.corner(at + 1, x + w, y, 0, s2, t1, color);
    this.corner(at + 2, x + w, y + h, 0, s2, t2, color);
    this.corner(at + 3, x, y + h, 0, s1, t2, color);
  }

  /**
   * A whole image about a point, as `RB_AddQuadStamp` writes one: its corners `left` and `up`
   * from `origin`, the image's top left at `origin + left + up`.
   *
   * @param color - Red, green, blue and alpha, each from 0 to 1.
   */
  stamp(material: Material, origin: Point, left: Point, up: Point, color: ArrayLike<number>): void {
    const at = this.next(material) * 4;
    const { x, y, z } = origin;
    this.corner(at, x + left.x + up.x, y + left.y + up.y, z + left.z + up.z, 0, 0, color);
    this.corner(at + 1, x - left.x + up.x, y - left.y + up.y, z - left.z + up.z, 1, 0, color);
    this.corner(at + 2, x - left.x - up.x, y - left.y - up.y, z - left.z - up.z, 1, 1, color);
    this.corner(at + 3, x + left.x - up.x, y + left.y - up.y, z + left.z - up.z, 0, 1, color);
  }

  /** End a frame: upload what it wrote, and draw each of its runs in turn and nothing else. */
  end(): void {
    this.vertices.unlock(0, this.quads * QUAD_BYTES);
    for (const pool of this.pools.values()) pool.used = 0;
    for (let i = 0; i < this.runCount; i++) {
      const { material, first, count } = this.runs[i];
      const draw = this.draw(material);
      const primitive = draw.mesh.primitive[0];
      primitive.base = first * QUAD_INDICES;
      primitive.count = count * QUAD_INDICES;
      draw.instance.drawOrder = i;
      draw.instance.visible = true;
      this.runDraws[i] = draw.instance;
    }
    for (const pool of this.pools.values()) {
      for (let i = pool.used; i < pool.draws.length; i++) pool.draws[i].instance.visible = false;
    }
  }

  destroy(): void {
    for (const pool of this.pools.values()) {
      for (const { instance } of pool.draws) {
        for (const layer of this.layers) layer.removeMeshInstances([instance], true);
        instance.destroy();
      }
    }
    this.pools.clear();
    this.vertices.destroy();
    this.indices.destroy();
  }

  /** The quad to write next, in `material`: the last run's next, or the first of a new run. */
  private next(material: Material): number {
    if (this.quads === this.capacity) this.grow();
    const last = this.runCount > this.closed ? this.runs[this.runCount - 1] : undefined;
    if (last?.material === material) {
      last.count++;
    } else {
      const run = this.runs[this.runCount];
      if (run) {
        run.material = material;
        run.first = this.quads;
        run.count = 1;
      } else {
        this.runs.push({ material, first: this.quads, count: 1 });
      }
      this.runCount++;
    }
    return this.quads++;
  }

  /** Write corner `index`. */
  private corner(
    index: number,
    x: number,
    y: number,
    z: number,
    s: number,
    t: number,
    color: ArrayLike<number>
  ): void {
    const float = index * (CORNER_BYTES / 4);
    this.floats[float] = x;
    this.floats[float + 1] = y;
    this.floats[float + 2] = z;
    this.floats[float + 3] = s;
    this.floats[float + 4] = t;
    const byte = index * CORNER_BYTES + COLOR_BYTE;
    for (let i = 0; i < 4; i++) this.bytes[byte + i] = color[i] * 255;
  }

  /** A material's next draw this frame, made if it has none to spare. */
  private draw(material: Material): Draw {
    let pool = this.pools.get(material);
    if (!pool) {
      pool = { draws: [], used: 0 };
      this.pools.set(material, pool);
    }
    let draw = pool.draws[pool.used];
    if (!draw) {
      const mesh = new Mesh(this.device);
      mesh.vertexBuffer = this.vertices;
      mesh.indexBuffer[0] = this.indices;
      mesh.primitive[0] = { type: PRIMITIVE_TRIANGLES, base: 0, baseVertex: 0, count: 0, indexed: true };
      // Counted by the batch too: releasing the draw releases a mesh only it counts, buffers and
      // all, and the buffers are shared.
      mesh.incRefCount();
      const instance = new MeshInstance(mesh, material, this.node);
      // Its quads are anywhere in the node's space, so no bounds of its own would hold them.
      instance.cull = false;
      instance.calculateSortDistance = inRunOrder;
      if (this.drawBucket !== undefined) instance.drawBucket = this.drawBucket;
      for (const layer of this.layers) layer.addMeshInstances([instance], true);
      draw = { mesh, instance };
      pool.draws.push(draw);
    }
    pool.used++;
    return draw;
  }

  /** Twice the room, the quads written so far kept, in buffers of the same format. */
  private grow(): void {
    this.capacity *= 2;
    const vertices = this.vertexBuffer(this.capacity);
    new Uint8Array(vertices.storage).set(new Uint8Array(this.vertices.storage, 0, this.quads * QUAD_BYTES));
    const indices = quadIndices(this.device, this.capacity);
    for (const pool of this.pools.values()) {
      for (const { mesh } of pool.draws) {
        mesh.vertexBuffer = vertices;
        mesh.indexBuffer[0] = indices;
      }
    }
    this.vertices.destroy();
    this.indices.destroy();
    this.vertices = vertices;
    this.indices = indices;
    this.floats = new Float32Array(vertices.storage);
    this.bytes = new Uint8ClampedArray(vertices.storage);
  }

  private vertexBuffer(quads: number): VertexBuffer {
    return new VertexBuffer(this.device, this.format, quads * 4, { usage: BUFFER_DYNAMIC });
  }
}

/** A run's distance in a layer that sorts back to front: at the eye, in the order written. */
function inRunOrder(draw: MeshInstance): number {
  return -draw.drawOrder * ORDER_STEP;
}

/**
 * Two triangles a quad, for `quads` quads: each quad's corners as `RB_AddQuadStampExt` indexes
 * them, wound as both of Q3's writers wind theirs.
 */
function quadIndices(device: GraphicsDevice, quads: number): IndexBuffer {
  const indices = new Uint32Array(quads * QUAD_INDICES);
  for (let quad = 0; quad < quads; quad++) {
    const corner = quad * 4;
    indices.set([corner, corner + 1, corner + 3, corner + 3, corner + 1, corner + 2], quad * QUAD_INDICES);
  }
  return new IndexBuffer(device, INDEXFORMAT_UINT32, indices.length, BUFFER_STATIC, indices.buffer);
}
