import {
  BUFFER_DYNAMIC,
  INDEXFORMAT_UINT32,
  IndexBuffer,
  Mesh,
  PRIMITIVE_TRIANGLES,
  SEMANTIC_COLOR,
  SEMANTIC_NORMAL,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  SEMANTIC_TEXCOORD1,
  VertexBuffer,
  type GraphicsDevice,
  type VertexFormat
} from 'playcanvas';

import type { Deform } from '../formats/shader-script';
import { NOISE } from '../view/noise';
import { shaderTime } from '../view/stage-motion';
import {
  Tess,
  WORLD_ENTITY,
  deformTess,
  type DeformEntity,
  type DeformScene
} from '../view/world-deforms';
import type { RunBatch, RunIndexes, WorldIndexes } from '../view/world-indexes';

/**
 * The world's deformed runs, drawn from a vertex buffer and an index buffer of their own. Each
 * frame, each of their batches a view draws is laid out as Q3's tessellator holds it, from a copy
 * of its vertexes made with the world, deformed as `RB_DeformTessGeometry` deforms it
 * (`view/world-deforms.ts`), and written after the batch before it; then what was written is
 * uploaded. Every stage of a batch, its fog pass and the fog's dimming draw the same vertexes, so a
 * stage at `depthFunc equal` meets the first, as Q3's do.
 */

/** The world's vertexes as made at load, by their places among its vertices. */
export interface WorldVertexData {
  xyz: Float32Array;
  normal: Float32Array;
  st: Float32Array;
  lightmap: Float32Array;
  /** Four bytes a vertex. */
  color: Uint8Array;
}

/** How the shader a run draws deforms it. */
export interface RunDeforms {
  deforms: readonly Deform[];
  /** Its shader's name, which `TableForFunc`'s drop prints. */
  shader: string;
  /** Its shader's `clampTime`; 0 for none. */
  clampTime: number;
  /** Its shader's `timeOffset`; 0 for none. */
  timeOffset: number;
}

/** A run whose shader deforms its vertexes, or a shader it may draw instead does. */
export interface DeformedRunOptions extends RunDeforms {
  /** Its place among the world's runs. */
  run: number;
  entity: DeformEntity;
  /**
   * Whether a shader it may draw stamps `autosprite`'s quads, which room is made for; by default,
   * whether its own does.
   */
  stamps?: boolean;
}

/** The copy of the deformed runs' vertexes made at load, each colour's four bytes a word. */
interface Source {
  xyz: Float32Array;
  normal: Float32Array;
  st: Float32Array;
  lightmap: Float32Array;
  colors: Uint32Array;
}

interface DeformedRun extends DeformedRunOptions {
  indexes: RunIndexes;
  /** Its batches' meshes, one a batch, each placed by the frame. */
  meshes: Mesh[];
  /** Each batch's vertexes as the frame's deform left the tessellator (`tess.numVertexes`). */
  vertexes: Int32Array;
}

/** `backEnd.refdef.text`: the port's scenes set none. */
const NO_TEXT: readonly string[] = ['', '', '', '', '', '', '', ''];

/** The most vertexes `autosprite` adds to a batch: the rest of a last quad it stamps whole. */
const STAMP_SLACK = 3;

export class DeformedRuns {
  readonly vertices: VertexBuffer;
  readonly indexes: IndexBuffer;
  /** `backEnd.viewParms.or.axis`, which the world writes at each view. */
  readonly view: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array([1, 0, 0]),
    new Float32Array([0, 1, 0]),
    new Float32Array([0, 0, 1])
  ];

  private readonly detail: WorldIndexes;
  private readonly runs: DeformedRun[];
  private readonly byRun = new Map<number, DeformedRun>();
  /** The vertex buffer's storage, as floats and as words, and the index buffer's. */
  private readonly floats: Float32Array;
  private readonly words: Uint32Array;
  private readonly indexData: Uint32Array<ArrayBuffer>;
  /** A vertex's floats, and where each of its fields starts among them. */
  private readonly floatStride: number;
  private readonly fields: Record<'xyz' | 'normal' | 'st' | 'lightmap' | 'color', number>;
  /** The copy made at load, and where each of the world's vertices is in it, or −1. */
  private readonly source: Source;
  private readonly sourceOf: Int32Array;
  private readonly tess = new Tess();
  private readonly scene: DeformScene;
  private readonly bytes: number;

  /**
   * The buffers, with room for every deformed run's batches with all their surfaces at once, and
   * the copy of every vertex they can draw.
   *
   * @param format - The world's vertex format.
   * @param data - The world's vertexes.
   * @param detail - The world's indexes, every run cut whole, as they are when made: the copy is
   *   of the vertexes those cuts list.
   */
  constructor(
    device: GraphicsDevice,
    format: VertexFormat,
    data: WorldVertexData,
    detail: WorldIndexes,
    options: readonly DeformedRunOptions[]
  ) {
    this.detail = detail;
    const count = data.xyz.length / 3;
    this.sourceOf = new Int32Array(count).fill(-1);
    let copied = 0;
    let vertexRoom = 0;
    let indexRoom = 0;
    this.runs = options.map((option) => {
      const indexes = detail.runs[option.run];
      const { tess, batches } = indexes;
      if (!tess) throw new Error(`Run ${option.run} deforms, and was not cut tessellated`);
      const listed = batches.reduce((sum, batch) => sum + batch.vertexes, 0);
      for (let i = 0; i < listed; i++) {
        if (this.sourceOf[tess[i]] < 0) this.sourceOf[tess[i]] = copied++;
      }
      vertexRoom += tess.length + STAMP_SLACK * batches.length;
      const next = detail.runs[option.run + 1]?.base ?? detail.indexes.length;
      const room = next - indexes.base;
      const stamped = option.stamps ?? option.deforms.some(({ type }) => type === 'autosprite');
      const stamps = stamped ? Math.ceil(tess.length * 1.5) + 6 * batches.length : 0;
      indexRoom += Math.max(room, stamps);
      const run: DeformedRun = {
        ...option,
        indexes,
        meshes: [],
        vertexes: new Int32Array(batches.length)
      };
      this.byRun.set(option.run, run);
      return run;
    });

    const colors = new Uint32Array(data.color.buffer, data.color.byteOffset, count);
    this.source = {
      xyz: new Float32Array(copied * 3),
      normal: new Float32Array(copied * 3),
      st: new Float32Array(copied * 2),
      lightmap: new Float32Array(copied * 2),
      colors: new Uint32Array(copied)
    };
    for (let w = 0; w < count; w++) {
      const s = this.sourceOf[w];
      if (s < 0) continue;
      this.source.xyz.set(data.xyz.subarray(w * 3, w * 3 + 3), s * 3);
      this.source.normal.set(data.normal.subarray(w * 3, w * 3 + 3), s * 3);
      this.source.st.set(data.st.subarray(w * 2, w * 2 + 2), s * 2);
      this.source.lightmap.set(data.lightmap.subarray(w * 2, w * 2 + 2), s * 2);
      this.source.colors[s] = colors[w];
    }

    this.bytes = format.size;
    this.floatStride = format.size / 4;
    const at = (semantic: string) =>
      format.elements.find((element) => element.name === semantic)!.offset / 4;
    this.fields = {
      xyz: at(SEMANTIC_POSITION),
      normal: at(SEMANTIC_NORMAL),
      st: at(SEMANTIC_TEXCOORD0),
      lightmap: at(SEMANTIC_TEXCOORD1),
      color: at(SEMANTIC_COLOR)
    };
    this.vertices = new VertexBuffer(device, format, Math.max(1, vertexRoom), {
      usage: BUFFER_DYNAMIC
    });
    const storage = this.vertices.lock() as ArrayBuffer;
    this.floats = new Float32Array(storage);
    this.words = new Uint32Array(storage);
    this.indexData = new Uint32Array(Math.max(1, indexRoom));
    this.indexes = new IndexBuffer(
      device,
      INDEXFORMAT_UINT32,
      this.indexData.length,
      BUFFER_DYNAMIC,
      this.indexData.buffer
    );
    for (const run of this.runs) {
      run.meshes = run.indexes.batches.map(() => {
        const mesh = new Mesh(device);
        mesh.vertexBuffer = this.vertices;
        mesh.indexBuffer[0] = this.indexes;
        mesh.primitive[0] = {
          type: PRIMITIVE_TRIANGLES,
          base: 0,
          baseVertex: 0,
          count: 0,
          indexed: true
        };
        // Held here too: releasing every draw would otherwise free the shared buffers.
        mesh.incRefCount();
        return mesh;
      });
    }
    this.scene = {
      shaderTime: 0,
      time: 0,
      view: this.view,
      entity: WORLD_ENTITY,
      texts: NO_TEXT,
      noise: NOISE,
      shader: ''
    };
  }

  /** A deformed run's meshes, one for each of its batches, or none for a run not deformed. */
  meshes(run: number): readonly Mesh[] | undefined {
    return this.byRun.get(run)?.meshes;
  }

  /** A deformed batch's vertexes as the last deform left the tessellator. */
  vertexesOf(run: number, batch: number): number {
    return this.byRun.get(run)?.vertexes[batch] ?? 0;
  }

  /**
   * The vertexes as the last deform wrote them, {@link stride} floats each, x, y and z from
   * {@link xyz}, and their indexes: what a deformed batch's mesh draws, from its primitive's base.
   */
  get positions(): Float32Array {
    return this.floats;
  }
  get stride(): number {
    return this.floatStride;
  }
  get xyz(): number {
    return this.fields.xyz;
  }
  get indexStorage(): Uint32Array {
    return this.indexData;
  }

  /** A run deformed from the next frame on as the shader it draws now deforms it. */
  drawWith(run: number, { deforms, shader, clampTime, timeOffset }: RunDeforms): void {
    const deformed = this.byRun.get(run);
    if (!deformed) return;
    deformed.deforms = deforms;
    deformed.shader = shader;
    deformed.clampTime = clampTime;
    deformed.timeOffset = timeOffset;
  }

  /**
   * Deform each batch the view draws, after the view has cut the world's runs: each laid out as
   * the tessellator holds it, deformed at the clock's time, written after the one before, and its
   * meshes placed over what it wrote. Then all that was written is uploaded.
   *
   * @param time - The clock, in milliseconds, as `backEnd.refdef.time`.
   * @throws `TableForFunc`'s drop for a deform with no table
   */
  deform(time: number): void {
    const { scene } = this;
    scene.time = time;
    let vertexes = 0;
    let indexes = 0;
    for (let r = 0; r < this.runs.length; r++) {
      const run = this.runs[r];
      if (run.indexes.count === 0) continue;
      scene.shaderTime = shaderTime(time, run.clampTime, run.timeOffset);
      scene.entity = run.entity;
      scene.shader = run.shader;
      const { batches, tess: listed } = run.indexes;
      for (let k = 0; k < batches.length; k++) {
        const batch = batches[k];
        if (batch.count === 0) continue;
        this.fill(batch, listed!);
        deformTess(run.deforms, this.tess, scene);
        this.write(vertexes, indexes);
        const primitive = run.meshes[k].primitive[0];
        primitive.base = indexes;
        primitive.count = this.tess.numIndexes;
        run.vertexes[k] = this.tess.numVertexes;
        vertexes += this.tess.numVertexes;
        indexes += this.tess.numIndexes;
      }
    }
    if (vertexes > 0) this.vertices.unlock(0, vertexes * this.bytes);
    if (indexes > 0) this.indexes.unlock(0, indexes * 4);
  }

  /** Free the buffers; the meshes go with the world's draws. */
  destroy(): void {
    this.vertices.destroy();
    this.indexes.destroy();
  }

  /** A batch laid out in the tessellator from the copy, as its cut listed it, with its indexes. */
  private fill(batch: RunBatch, listed: Int32Array): void {
    const { tess, source, sourceOf } = this;
    for (let v = 0; v < batch.vertexes; v++) {
      const s = sourceOf[listed[batch.first + v]];
      tess.xyz[v * 3] = source.xyz[s * 3];
      tess.xyz[v * 3 + 1] = source.xyz[s * 3 + 1];
      tess.xyz[v * 3 + 2] = source.xyz[s * 3 + 2];
      tess.normal[v * 3] = source.normal[s * 3];
      tess.normal[v * 3 + 1] = source.normal[s * 3 + 1];
      tess.normal[v * 3 + 2] = source.normal[s * 3 + 2];
      tess.st[v * 2] = source.st[s * 2];
      tess.st[v * 2 + 1] = source.st[s * 2 + 1];
      tess.lightmap[v * 2] = source.lightmap[s * 2];
      tess.lightmap[v * 2 + 1] = source.lightmap[s * 2 + 1];
      tess.colors[v] = source.colors[s];
    }
    const from = this.detail.indexes;
    for (let i = 0; i < batch.count; i++) tess.indexes[i] = from[batch.base + i];
    tess.numVertexes = batch.vertexes;
    tess.numIndexes = batch.count;
  }

  /** The tessellator written into the buffers' storage from these places. */
  private write(vertexes: number, indexes: number): void {
    const { tess, floats, words, fields, floatStride: stride } = this;
    for (let v = 0; v < tess.numVertexes; v++) {
      const o = (vertexes + v) * stride;
      floats[o + fields.xyz] = tess.xyz[v * 3];
      floats[o + fields.xyz + 1] = tess.xyz[v * 3 + 1];
      floats[o + fields.xyz + 2] = tess.xyz[v * 3 + 2];
      floats[o + fields.normal] = tess.normal[v * 3];
      floats[o + fields.normal + 1] = tess.normal[v * 3 + 1];
      floats[o + fields.normal + 2] = tess.normal[v * 3 + 2];
      floats[o + fields.st] = tess.st[v * 2];
      floats[o + fields.st + 1] = tess.st[v * 2 + 1];
      floats[o + fields.lightmap] = tess.lightmap[v * 2];
      floats[o + fields.lightmap + 1] = tess.lightmap[v * 2 + 1];
      words[o + fields.color] = tess.colors[v];
    }
    const out = this.indexData;
    for (let i = 0; i < tess.numIndexes; i++) out[indexes + i] = tess.indexes[i] + vertexes;
  }
}
