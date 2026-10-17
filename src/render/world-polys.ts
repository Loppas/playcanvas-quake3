import {
  BUFFER_DYNAMIC,
  INDEXFORMAT_UINT32,
  IndexBuffer,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  SEMANTIC_COLOR,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  VertexBuffer,
  type GraphNode,
  type GraphicsDevice,
  type Layer,
  type StandardMaterial,
  type VertexFormat
} from 'playcanvas';

import { MAX_POLYVERTS, type ScenePolys } from '../view/scene-polys';
import { WORLD_ENTITY, sceneKey } from '../view/scene-sort';
import { SHADER_MAX_INDEXES, SHADER_MAX_VERTEXES } from '../view/world-batches';
import { FOG_UNIFORM } from './fog-chunks';
import { EYE_UNIFORM } from './view-term-chunks';
import type { WorldStage } from './world-stages';

/**
 * A frame's polys as opengl1 draws them (`RB_SurfacePolychain`, `tr_surface.c:189-215`): each a
 * fan, as the world's entity, sorted with the rest of the scene by its shader's place and its fog
 * and kept in the order added. A run of one shader and fog is one batch, cut where the tessellator
 * would overflow (`RB_CheckOverflow`), and drawn stage by stage with the world's stages for its
 * shader, dimmed by its fog where a stage takes the fog in its colours.
 *
 * Every poly's points go into one vertex buffer a frame, in the world's vertex format, and every
 * batch's fan into one index buffer; a pool of draws for each stage's material is given the
 * batches. A shader whose stages were not made with the map's draws nothing.
 */

/**
 * Where the polys' steps start within a key, after any world batch's of the same shader and fog,
 * as Q3 adds the world's surfaces first and its sort keeps them first.
 */
const POLY_STEP = 1 << 15;

/** The most indexes a frame's fans can take: three for each point but the first two of each. */
const MAX_POLY_INDEXES = 3 * MAX_POLYVERTS;

/** A shader's stages, by its fog: made at the map's load, or none. */
export type PolyStages<Shader> = (shader: Shader, fogged: boolean) => readonly WorldStage[] | null;

/** One of a material's draws, given a batch each frame it is used. */
interface PolyDraw<Shader> {
  readonly instance: MeshInstance;
  readonly mesh: Mesh;
  /** What it draws this frame, for its key. */
  shader: Shader | null;
  fog: number;
  step: number;
}

/** A material's draws, and how many of them the frame has given out. */
interface Pool<Shader> {
  draws: PolyDraw<Shader>[];
  used: number;
}

/** What the last frame drew, as `r_speeds` counts it. */
export interface PolySpeeds {
  polys: number;
  batches: number;
  vertexes: number;
  indexes: number;
  /** The indexes once for each of their stages. */
  passIndexes: number;
}

/** The world's polys: their buffers, and a pool of draws for each material. */
export class WorldPolys<Shader> {
  private readonly device: GraphicsDevice;
  private readonly layer: Layer;
  private readonly node: GraphNode;
  private readonly stagesOf: PolyStages<Shader>;
  private readonly place: (shader: Shader) => number;
  private readonly fogData: (fog: number) => Float32Array;
  private readonly eye: Float32Array;
  private readonly vertices: VertexBuffer;
  private readonly indexes: IndexBuffer;
  /** The vertex buffer's storage as floats and as bytes, and where each field is in a vertex. */
  private readonly floats: Float32Array;
  private readonly bytes: Uint8Array;
  private readonly stride: number;
  private readonly position: number;
  private readonly coordinates: number;
  private readonly color: number;
  private readonly indexStorage: Uint32Array<ArrayBuffer>;
  private readonly pools = new Map<StandardMaterial, Pool<Shader>>();
  /** The draws given out this frame, the first {@link count} of them. */
  private readonly given: PolyDraw<Shader>[] = [];
  private count = 0;
  /** Each poly's key this frame, and the polys in the order they draw. */
  private readonly keys: Float64Array;
  private readonly order: Int32Array;
  /** What the last frame drew. */
  readonly speeds: PolySpeeds = { polys: 0, batches: 0, vertexes: 0, indexes: 0, passIndexes: 0 };
  /** The batch being made: its first index, its shader, fog and step, and what it holds. */
  private batchBase = 0;
  private batchShader: Shader | null = null;
  private batchFog = 0;
  private batchStep = 0;
  private batchVertexes = 0;
  private batchIndexes = 0;
  private batchStages: readonly WorldStage[] | null = null;

  /**
   * @param node - What the draws hang from: the world's root, in Quake's frame.
   * @param format - The world's vertex format.
   * @param place - A shader's place in the draw order, its `sortedIndex`.
   * @param fogData - What a draw in a fog reads for it, in the world's frame, by the fog's place
   *   among the map's plus one.
   * @param eye - The eye in the world's frame, for a stage that reads the view.
   * @param maxPolys - The most polys a frame holds.
   */
  constructor(
    device: GraphicsDevice,
    layer: Layer,
    node: GraphNode,
    format: VertexFormat,
    stagesOf: PolyStages<Shader>,
    place: (shader: Shader) => number,
    fogData: (fog: number) => Float32Array,
    eye: Float32Array,
    maxPolys: number
  ) {
    this.device = device;
    this.layer = layer;
    this.node = node;
    this.stagesOf = stagesOf;
    this.place = place;
    this.fogData = fogData;
    this.eye = eye;
    this.vertices = new VertexBuffer(device, format, MAX_POLYVERTS, { usage: BUFFER_DYNAMIC });
    // A buffer made without data locks to its own storage, an `ArrayBuffer`.
    const storage = this.vertices.lock() as ArrayBuffer;
    this.floats = new Float32Array(storage);
    this.bytes = new Uint8Array(storage);
    this.stride = format.size;
    const offset = (semantic: string) => format.elements.find((e) => e.name === semantic)!.offset;
    this.position = offset(SEMANTIC_POSITION);
    this.coordinates = offset(SEMANTIC_TEXCOORD0);
    this.color = offset(SEMANTIC_COLOR);
    this.indexStorage = new Uint32Array(MAX_POLY_INDEXES);
    this.indexes = new IndexBuffer(
      device,
      INDEXFORMAT_UINT32,
      MAX_POLY_INDEXES,
      BUFFER_DYNAMIC,
      this.indexStorage.buffer
    );
    this.keys = new Float64Array(maxPolys);
    this.order = new Int32Array(maxPolys);
  }

  /**
   * Draw a frame's polys: sorted by their shaders' places and fogs, keeping the order added, cut
   * into batches, their points and fans written and uploaded, and a draw given each batch's
   * stages. The draws not given are hidden.
   */
  draw(polys: ScenePolys<Shader>): void {
    for (const pool of this.pools.values()) pool.used = 0;
    this.count = 0;
    const speeds = this.speeds;
    speeds.polys = speeds.batches = speeds.vertexes = speeds.indexes = speeds.passIndexes = 0;
    const { keys, order } = this;
    let n = 0;
    for (let p = 0; p < polys.count; p++) {
      const shader = polys.shaders[p]!;
      // Placed first, which finds the shader in the map's registry.
      const place = this.place(shader);
      if (!this.stagesOf(shader, polys.fogs[p] > 0)) continue;
      keys[p] = place * 64 + polys.fogs[p];
      // Stable: an insertion sort, the polys mostly in their order already.
      let i = n++;
      while (i > 0 && keys[order[i - 1]] > keys[p]) {
        order[i] = order[i - 1];
        i--;
      }
      order[i] = p;
    }

    let vertexes = 0;
    let indexes = 0;
    this.batchShader = null;
    for (let i = 0; i < n; i++) {
      const p = order[i];
      const shader = polys.shaders[p]!;
      const fog = polys.fogs[p];
      const size = polys.sizes[p];
      const fan = Math.max(0, 3 * (size - 2));
      if (shader !== this.batchShader || fog !== this.batchFog) {
        this.endBatch();
        this.beginBatch(shader, fog, 0, indexes);
      } else if (
        this.batchVertexes + size >= SHADER_MAX_VERTEXES ||
        this.batchIndexes + fan >= SHADER_MAX_INDEXES
      ) {
        // `RB_CheckOverflow`: the batch drawn, and another begun.
        const next = this.batchStep + this.batchStages!.length;
        this.endBatch();
        this.beginBatch(shader, fog, next, indexes);
      }
      this.writePoints(polys, p, vertexes);
      for (let k = 0; k < size - 2; k++) {
        this.indexStorage[indexes++] = vertexes;
        this.indexStorage[indexes++] = vertexes + k + 1;
        this.indexStorage[indexes++] = vertexes + k + 2;
      }
      vertexes += size;
      this.batchVertexes += size;
      this.batchIndexes += fan;
      speeds.polys++;
    }
    this.endBatch();
    if (vertexes > 0) this.vertices.unlock(0, vertexes * this.stride);
    if (indexes > 0) this.indexes.unlock(0, indexes * 4);
    speeds.vertexes = vertexes;
    speeds.indexes = indexes;
    for (const pool of this.pools.values()) {
      for (let i = pool.used; i < pool.draws.length; i++) pool.draws[i].instance.visible = false;
    }
  }

  /** The draws the last frame gave out, in the order given. */
  get drawn(): MeshInstance[] {
    return this.given.slice(0, this.count).map((draw) => draw.instance);
  }

  /** Key the frame's draws again, as a shader sorted in moves the places after it. */
  key(): void {
    for (let i = 0; i < this.count; i++) {
      const draw = this.given[i];
      draw.instance.drawOrder = this.drawKey(draw.shader!, draw.fog, draw.step);
    }
  }

  /**
   * A draw of each stage of each shader made, over a triangle of no size, for the warm-up: in a
   * fog's colours too where the map has fogs. The next frame's {@link draw} hides them.
   *
   * @param fogs - How many fogs the map has.
   */
  warm(shaders: readonly Shader[], fogs: number): void {
    for (const pool of this.pools.values()) pool.used = 0;
    this.count = 0;
    this.floats.fill(0, 0, (3 * this.stride) / 4);
    this.indexStorage.set([0, 1, 2]);
    this.vertices.unlock(0, 3 * this.stride);
    this.indexes.unlock(0, 3 * 4);
    for (const shader of shaders) {
      for (const fog of fogs > 0 ? [0, 1] : [0]) {
        const stages = this.stagesOf(shader, fog > 0);
        if (!stages) continue;
        for (const [s, stage] of stages.entries()) {
          const draw = this.drawOf(stage);
          draw.mesh.primitive[0].base = 0;
          draw.mesh.primitive[0].count = 3;
          this.give(draw, shader, fog, POLY_STEP + s);
        }
      }
    }
  }

  /** Every draw hidden, until the next frame's {@link draw} gives them out. */
  hide(): void {
    this.count = 0;
    for (const pool of this.pools.values()) {
      pool.used = 0;
      for (const draw of pool.draws) draw.instance.visible = false;
    }
  }

  /** Take every draw out of the layer and free them, and the buffers. */
  destroy(): void {
    for (const pool of this.pools.values()) {
      const instances = pool.draws.map((draw) => draw.instance);
      this.layer.removeMeshInstances(instances, true);
      for (const instance of instances) instance.destroy();
    }
    this.pools.clear();
    this.vertices.destroy();
    this.indexes.destroy();
  }

  private beginBatch(shader: Shader, fog: number, step: number, base: number): void {
    this.batchShader = shader;
    this.batchFog = fog;
    this.batchStep = step;
    this.batchBase = base;
    this.batchVertexes = 0;
    this.batchIndexes = 0;
    this.batchStages = this.stagesOf(shader, fog > 0);
  }

  /** The batch being made drawn: a draw for each of its stages, over its range of the fans. */
  private endBatch(): void {
    const { batchShader: shader, batchStages: stages, batchIndexes: count } = this;
    this.batchShader = null;
    if (shader === null || !stages || count === 0) return;
    this.speeds.batches++;
    this.speeds.passIndexes += count * stages.length;
    for (let s = 0; s < stages.length; s++) {
      const draw = this.drawOf(stages[s]);
      const primitive = draw.mesh.primitive[0];
      primitive.base = this.batchBase;
      primitive.count = count;
      this.give(draw, shader, this.batchFog, POLY_STEP + this.batchStep + s);
    }
  }

  /** A draw given out this frame: keyed, read for its fog, and shown. */
  private give(draw: PolyDraw<Shader>, shader: Shader, fog: number, step: number): void {
    draw.shader = shader;
    draw.fog = fog;
    draw.step = step;
    draw.instance.drawOrder = this.drawKey(shader, fog, step);
    if (fog > 0) draw.instance.setParameter(FOG_UNIFORM, this.fogData(fog));
    draw.instance.visible = true;
    this.given[this.count++] = draw;
  }

  private drawKey(shader: Shader, fog: number, step: number): number {
    return sceneKey(this.place(shader), WORLD_ENTITY, fog, false, step);
  }

  /** A stage's material's next draw this frame, made and put in the layer where it has none. */
  private drawOf(stage: WorldStage): PolyDraw<Shader> {
    let pool = this.pools.get(stage.material);
    if (!pool) {
      pool = { draws: [], used: 0 };
      this.pools.set(stage.material, pool);
    }
    const made = pool.draws[pool.used];
    pool.used++;
    if (made) return made;
    const mesh = new Mesh(this.device);
    mesh.vertexBuffer = this.vertices;
    mesh.indexBuffer[0] = this.indexes;
    mesh.primitive[0] = {
      type: PRIMITIVE_TRIANGLES,
      base: 0,
      baseVertex: 0,
      count: 0,
      indexed: true
    };
    // Held here too: releasing the draw would otherwise free the shared buffers.
    mesh.incRefCount();
    const instance = new MeshInstance(mesh, stage.material, this.node);
    // The polys are cgame's, culled by no one.
    instance.cull = false;
    for (const [name, data] of stage.parameters) instance.setParameter(name, data);
    if (stage.eye) instance.setParameter(EYE_UNIFORM, this.eye);
    this.layer.addMeshInstances([instance], true);
    const draw: PolyDraw<Shader> = { instance, mesh, shader: null, fog: 0, step: 0 };
    pool.draws.push(draw);
    return draw;
  }

  /** A poly's points into the vertex buffer from the `at`th vertex. */
  private writePoints(polys: ScenePolys<Shader>, p: number, at: number): void {
    const { floats, bytes, stride, position, coordinates, color } = this;
    const { xyz, st, modulate } = polys.verts;
    const first = polys.firsts[p];
    for (let i = 0; i < polys.sizes[p]; i++) {
      const v = first + i;
      const base = (at + i) * stride;
      const xyzAt = (base + position) / 4;
      floats[xyzAt] = xyz[v * 3];
      floats[xyzAt + 1] = xyz[v * 3 + 1];
      floats[xyzAt + 2] = xyz[v * 3 + 2];
      const stAt = (base + coordinates) / 4;
      floats[stAt] = st[v * 2];
      floats[stAt + 1] = st[v * 2 + 1];
      for (let k = 0; k < 4; k++) bytes[base + color + k] = modulate[v * 4 + k];
    }
  }
}
