import {
  BUFFER_DYNAMIC,
  BUFFER_STATIC,
  GraphNode,
  INDEXFORMAT_UINT32,
  IndexBuffer,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  SEMANTIC_TEXCOORD1,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  TYPE_FLOAT32,
  VertexBuffer,
  VertexFormat,
  VertexIterator,
  type GraphicsDevice,
  type StandardMaterial
} from 'playcanvas';

import type { Vec3 as ViewVector } from '../sim/vec3';
import type { WorldIndexes } from '../view/world-indexes';
import {
  SKY_VERTICES,
  SkyIndexes,
  boxTexCoords,
  cloudTexCoords,
  skyPoints,
  type SkyRange
} from '../view/world-sky';
import { MODEL_CHUNKS_VERSION } from './model-chunks';
import { EYE_UNIFORM } from './view-term-chunks';
import { SKY_POINTS_UNIFORM, type WorldStage } from './world-stages';

/**
 * A map's sky as opengl1 draws it (`RB_StageIteratorSky`, `tr_sky.c:779-826`): each sky batch
 * draws the box's six sides, then its shader's stages as the clouds, over the blocks its triangles
 * cover from the eye (`view/world-sky.ts`), about the eye and at the far plane's depth.
 *
 * Every side's points are in one buffer, made once, the box's texture coordinates beside the
 * clouds'. Each batch has its place in an index buffer of the sky's own, written again only when
 * its blocks change: its draws take their new counts, and those with none are hidden.
 */

/** `sky_texorder` (`tr_sky.c:372`): the face each side of the box draws, by its suffix's place. */
export const SKY_TEXORDER = [0, 2, 1, 3, 4, 5] as const;

/**
 * The far plane the box is made at. Any serves: the box is about the eye and drawn at the far
 * plane's depth, so its size changes nothing seen.
 */
const SKY_Z_FAR = 1024;

/** Each vertex's depth made the far plane's: z set to w, so z over w is 1 whatever the clip. */
const FAR_PLANE_GLSL = `
	gl_Position.z = gl_Position.w;
`;
const FAR_PLANE_WGSL = `
	output.position.z = output.position.w;
`;

/**
 * Draw a material at the far plane's depth, as Q3 draws the sky in the depth range [1,1]
 * (`tr_sky.c:795`), in both shading languages.
 */
export function atFarPlane(material: StandardMaterial): void {
  material.getShaderChunks(SHADERLANGUAGE_GLSL).set('litUserMainEndVS', FAR_PLANE_GLSL);
  material.getShaderChunks(SHADERLANGUAGE_WGSL).set('litUserMainEndVS', FAR_PLANE_WGSL);
  material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
}

/** What a sky's shader draws with. */
export interface SkyMaterials {
  /** Each side of the box's, in side order; none for a sky with no box. */
  box: readonly StandardMaterial[];
  /** The clouds' stages, in order, and what each one's draws read. */
  clouds: readonly WorldStage[];
}

/** Where a sky's draws are put as they are made: each draw, and its batch. */
export interface SkyDrawList {
  draws: MeshInstance[];
  batches: number[];
}

/** One range of a sky batch's indexes, and its draws. */
interface SkyPart {
  mesh: Mesh;
  range: SkyRange;
  instances: MeshInstance[];
}

/** A sky batch's draws: each side of the box's, then the clouds'. */
interface SkyDraw {
  parts: SkyPart[];
  /** Whether a brush model draws it, so `r_drawentities` hides it. */
  entity: boolean;
}

/**
 * The sky's points, each with the clouds' texture coordinates, and the box's beside them.
 *
 * @param cloudHeight - The height the clouds' table is made at.
 */
function skyVertices(device: GraphicsDevice, cloudHeight: number): VertexBuffer {
  const format = new VertexFormat(device, [
    { semantic: SEMANTIC_POSITION, components: 3, type: TYPE_FLOAT32 },
    { semantic: SEMANTIC_TEXCOORD0, components: 2, type: TYPE_FLOAT32 },
    { semantic: SEMANTIC_TEXCOORD1, components: 2, type: TYPE_FLOAT32 }
  ]);
  const vertices = new VertexBuffer(device, format, SKY_VERTICES, { usage: BUFFER_STATIC });
  const iterator = new VertexIterator(vertices);
  iterator.writeData(SEMANTIC_POSITION, skyPoints(SKY_Z_FAR), SKY_VERTICES);
  iterator.writeData(SEMANTIC_TEXCOORD0, cloudTexCoords(cloudHeight), SKY_VERTICES);
  iterator.writeData(SEMANTIC_TEXCOORD1, boxTexCoords(), SKY_VERTICES);
  iterator.end();
  return vertices;
}

/** A map's sky, in the world's list of draws. */
export class BspSky {
  /** The sky's draws hang from this, kept at the eye. */
  readonly node = new GraphNode('sky');

  private readonly device: GraphicsDevice;
  private readonly indexes: SkyIndexes;
  private readonly vertices: VertexBuffer;
  private readonly buffer: IndexBuffer;
  /** Each world run's place among the sky's runs, or -1 for one that is not a sky's. */
  private readonly places: Int32Array;
  /** Each sky run's batches' draws, as {@link addDraws} makes them. */
  private readonly draws: SkyDraw[][] = [];
  private fast = false;
  private entitiesShown = true;
  /**
   * Where Q3 puts the sky's points for a cloud stage's `turb`: the eye, and the far plane over the
   * box this buffer is made at, written at each view.
   */
  private readonly points = new Float32Array(4);
  /** A batch written again: its draws' counts taken, and its indexes uploaded. */
  private readonly rewrite = (run: number, k: number): void => {
    const draw = this.draws[run][k];
    for (const { mesh, range } of draw.parts) mesh.primitive[0].count = range.count;
    this.show(draw);
    const { box, clouds } = this.indexes.runs[run][k];
    const from = box[0].base;
    this.buffer.unlock(from * 4, (clouds.base + clouds.count - from) * 4);
  };

  /**
   * The sky's buffers, each batch with no blocks.
   *
   * @param runs - Which of the world's runs are a sky's, in the order they draw.
   * @param detail - The world's indexes, as its runs are cut.
   * @param positions - Each of the world's vertices' x, y and z.
   * @param cloudHeight - The height the clouds' table was last made at.
   */
  constructor(
    device: GraphicsDevice,
    runs: readonly boolean[],
    detail: WorldIndexes,
    positions: Float32Array,
    cloudHeight: number
  ) {
    this.device = device;
    this.places = new Int32Array(runs.length).fill(-1);
    const skyRuns = detail.runs.filter((_, r) => runs[r]);
    let place = 0;
    runs.forEach((sky, r) => {
      if (sky) this.places[r] = place++;
    });
    this.indexes = new SkyIndexes(detail.indexes, positions, skyRuns);
    this.vertices = skyVertices(device, cloudHeight);
    // Its storage is the array the blocks are written in, so a batch written again uploads in
    // place.
    this.buffer = new IndexBuffer(
      device,
      INDEXFORMAT_UINT32,
      this.indexes.indexes.length,
      BUFFER_DYNAMIC,
      this.indexes.indexes.buffer
    );
  }

  /**
   * Make a sky run's draws, at the end of the world's: for each batch, each side of the box, then
   * each cloud stage.
   *
   * @param run - The run, by its place among the world's.
   * @param entity - Whether a brush model draws it.
   * @param eye - The eye in the world's frame, for a cloud stage that reads the view.
   * @param own - The world's draws, in order, each its place as its draw order, and each one's
   *   batch, by its place among the run's.
   * @param last - The same for the run's last batch's draws, which the world keeps apart.
   */
  addDraws(
    run: number,
    materials: SkyMaterials,
    entity: boolean,
    eye: Float32Array,
    own: SkyDrawList,
    last: SkyDrawList = own
  ): void {
    const place = this.places[run];
    const batches = this.indexes.runs[place];
    this.draws[place] = batches.map((batch, k): SkyDraw => {
      const { draws, batches: told } = k === batches.length - 1 ? last : own;
      const ranges = materials.box.length > 0 ? [...batch.box, batch.clouds] : [batch.clouds];
      const parts = ranges.map((range, i): SkyPart => {
        const mesh = new Mesh(this.device);
        mesh.vertexBuffer = this.vertices;
        mesh.indexBuffer[0] = this.buffer;
        mesh.primitive[0] = {
          type: PRIMITIVE_TRIANGLES,
          base: range.base,
          baseVertex: 0,
          count: range.count,
          indexed: true
        };
        // Held by the sky too: releasing every draw would otherwise free the shared buffers.
        mesh.incRefCount();
        const own: readonly WorldStage[] =
          i < materials.box.length
            ? [{ material: materials.box[i], parameters: [], eye: false, lit: false }]
            : materials.clouds;
        const instances = own.map(({ material, parameters, eye: viewed }) => {
          const instance = new MeshInstance(mesh, material, this.node);
          instance.drawOrder = draws.length;
          // Its blocks are those the seen triangles cover, so the engine has nothing to cull.
          instance.cull = false;
          for (const [name, data] of parameters) instance.setParameter(name, data);
          if (i >= materials.box.length) instance.setParameter(SKY_POINTS_UNIFORM, this.points);
          if (viewed) instance.setParameter(EYE_UNIFORM, eye);
          draws.push(instance);
          told.push(k);
          return instance;
        });
        return { mesh, range, instances };
      });
      const draw = { parts, entity };
      this.show(draw);
      return draw;
    });
  }

  /**
   * Draw the sky from the eye: the box moved to it, and the blocks found again if it moved or a
   * run was cut again. Under `r_fastsky` nothing is drawn, and nothing found (`tr_sky.c:780-782`).
   *
   * @param zFar - The view's far plane, which Q3 makes the sky's box at (`MakeSkyVec`,
   *   `tr_sky.c:323`), in units.
   * @param fastSky - `r_fastsky`.
   */
  view(eye: Readonly<ViewVector>, zFar: number, fastSky: boolean): void {
    if (fastSky !== this.fast) {
      this.fast = fastSky;
      this.showAll();
    }
    if (fastSky) return;
    this.node.setLocalPosition(eye.x, eye.y, eye.z);
    this.points[0] = eye.x;
    this.points[1] = eye.y;
    this.points[2] = eye.z;
    this.points[3] = zFar / SKY_Z_FAR;
    this.indexes.view(eye, this.rewrite);
  }

  /** A world run cut again: if it is a sky's, its blocks are found again at the next view. */
  cut(run: number): void {
    const place = this.places[run];
    if (place >= 0) this.indexes.cut(place);
  }

  /** `r_drawentities`: a brush model's sky batches are hidden with it. */
  showEntities(shown: boolean): void {
    this.entitiesShown = shown;
    this.showAll();
  }

  /**
   * Every draw shown over the whole box, for the warm-up, whatever hides it. The next view finds
   * the blocks again.
   */
  whole(): void {
    this.indexes.whole(this.rewrite);
    for (const draws of this.draws) {
      for (const { parts } of draws) {
        for (const { instances } of parts) {
          for (const instance of instances) instance.visible = true;
        }
      }
    }
  }

  /** Every draw shown as the blocks, `r_fastsky` and `r_drawentities` have it. */
  showAll(): void {
    for (const draws of this.draws) for (const draw of draws) this.show(draw);
  }

  /** Free the buffers; the draws are the world's to free, and the node goes with its parent. */
  destroy(): void {
    this.vertices.destroy();
    this.buffer.destroy();
  }

  /**
   * A batch's draws shown where they have blocks, unless `r_fastsky` or `r_drawentities` hides
   * them.
   */
  private show(draw: SkyDraw): void {
    const drawn = !this.fast && (!draw.entity || this.entitiesShown);
    for (const { range, instances } of draw.parts) {
      for (const instance of instances) instance.visible = drawn && range.count > 0;
    }
  }
}
