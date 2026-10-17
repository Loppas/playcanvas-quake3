import {
  Quat,
  Vec3,
  type AppBase,
  type Entity,
  type GraphNode,
  type Layer,
  type StandardMaterial
} from 'playcanvas';

import type { AssetLibrary } from '../formats/asset-library';
import { findShader } from '../formats/shader-script';
import { LOCAL_ENTITY_BASE } from '../view/scene-sort';
import type { SortedShader } from '../view/scene-shaders';
import { LIGHTMAP_2D } from '../view/world-shaders';
import { createEffectStages } from './effect-material';
import type { GammaVertexColorMaterial } from './md3-mesh';
import { QuadBatch, type Point } from './quad-batch';
import { dimEffectStages } from './bsp-fog';
import { sceneDraw, sceneEntity, tagDraw, type SceneDraws } from './scene-draws';
import type { Warmed } from './warm-up';

/**
 * Sprites drawn as Quake 3 draws a sprite entity (`RB_SurfaceSprite`): a square about its origin,
 * facing the view and turned in the view's plane, in the colour it carries. A frame's are written
 * into a batch of their own in the order they were added, which for the local entities that add
 * them is Q3's, oldest first.
 *
 * Q3 draws an `entityMergable` shader's sprites as one batch, and any other's a batch an entity;
 * either way, each stage of the shader over them in turn. It sorts a frame's draws by shader
 * before anything else (`R_AddDrawSurf`), and a blended shader with no `sort` of its own by when
 * cgame registered it. In a map's scene each batch takes its place by its shader and its first
 * sprite's entity (`scene-draws.ts`).
 */

/**
 * The shaders drawn here: `waterBubble`, whose `sort underwater` puts it ahead of every blended
 * shader, then the rest in the order cgame registers them (`cg_main.c:851, 859, 882`), which is
 * before nearly every other effect's. So each takes a draw bucket ahead of the effects' own, the
 * first the furthest ahead.
 */
export const MERGED_SHADERS = ['waterBubble', 'smokePuff', 'bloodTrail', 'hasteSmokePuff'] as const;

export type MergedShader = (typeof MERGED_SHADERS)[number];

/** `MeshInstance`'s draw bucket by default, which every other effect keeps. */
const DEFAULT_BUCKET = 127;

/** The draw bucket a shader's sprites take. */
export function mergedBucket(shader: MergedShader): number {
  return DEFAULT_BUCKET + MERGED_SHADERS.length - MERGED_SHADERS.indexOf(shader);
}

/** Numbers a sprite is kept in: its origin, radius, rotation, colour, entity and fog. */
const SPRITE_NUMBERS = 11;

/** The sprites there is room for at first. */
const FIRST_CAPACITY = 64;

/** For the warm-up: one sprite, at the node's origin. */
const ORIGIN: Point = { x: 0, y: 0, z: 0 };
const WHITE = [1, 1, 1, 1];

/** A stage reads a sprite's colour where its `rgbGen` takes the vertices'. */
const VERTEX_RGB = new Set(['vertex', 'exactVertex']);

/** Scratch: the node's rotation, undone. */
const unturn = new Quat();
/** Scratch: a sprite's origin. */
const spriteAt: [number, number, number] = [0, 0, 0];

export class MergedSprites {
  private readonly batch: QuadBatch;
  /** A material a stage of the shader, in its order. */
  private readonly stages: StandardMaterial[];
  private readonly node: GraphNode;
  private readonly camera: Entity;
  private readonly mergable: boolean;
  /** The scene its batches take places in, and the shader they sort by there. */
  private readonly scene: { draws: SceneDraws; shader: SortedShader } | null;
  /** This frame's sprites, {@link SPRITE_NUMBERS} numbers each; the array outlives the frame. */
  private sprites = new Float64Array(SPRITE_NUMBERS * FIRST_CAPACITY);
  private count = 0;
  /** This frame's runs: each one's first sprite and its stage. */
  private readonly runSprites: number[] = [];
  private readonly runStages: number[] = [];
  private runs = 0;
  /** The view's left and up in the node's space: `viewParms.or.axis[1]` and `[2]`. */
  private readonly viewLeft = new Vec3();
  private readonly viewUp = new Vec3();
  /** One sprite's origin, its corners' offsets from it, and its colour. */
  private readonly origin = new Vec3();
  private readonly left = new Vec3();
  private readonly up = new Vec3();
  private readonly color = [0, 0, 0, 0];

  private constructor(
    app: AppBase,
    stages: StandardMaterial[],
    node: GraphNode,
    layers: readonly Layer[],
    camera: Entity,
    drawBucket: number,
    mergable: boolean,
    scene: { draws: SceneDraws; shader: SortedShader } | null
  ) {
    this.stages = stages;
    this.node = node;
    this.camera = camera;
    this.mergable = mergable;
    this.scene = scene;
    this.batch = new QuadBatch(app.graphicsDevice, node, layers, drawBucket);
    scene?.draws.placeBatch(this.batch, 'effects');
  }

  /**
   * @param node - Where the sprites are placed: Quake units, Z up.
   * @param layers - The layers they draw in, where there is no scene to place them in.
   * @param camera - The eye they face.
   * @param scene - Where they are placed: a map's scene, or their own layers.
   */
  static async create(
    app: AppBase,
    library: AssetLibrary,
    shader: MergedShader,
    node: GraphNode,
    layers: readonly Layer[],
    camera: Entity,
    scene?: SceneDraws
  ): Promise<MergedSprites> {
    const stages = await createEffectStages(app, library, shader);
    for (const { material, animation, alphaVertex } of stages) {
      material.emissiveVertexColor = VERTEX_RGB.has(animation.rgbGen);
      (material as GammaVertexColorMaterial).vertexColorGamma = true;
      material.opacityVertexColor = alphaVertex === true;
      material.update();
    }
    dimEffectStages(stages);
    return new MergedSprites(
      app,
      stages.map((stage) => stage.material),
      node,
      layers,
      camera,
      mergedBucket(shader),
      findShader(library.shaders, shader)?.entityMergable ?? false,
      scene ? { draws: scene, shader: scene.shaders.handle(shader, LIGHTMAP_2D) } : null
    );
  }

  /** Start a frame: no sprite added yet. */
  begin(): void {
    this.count = 0;
  }

  /**
   * A sprite this frame, after those added before it.
   *
   * @param radius - Half its width.
   * @param rotation - `refEntity.rotation`: its turn in the view's plane, in degrees.
   * @param color - `shaderRGBA`: red, green, blue and alpha, each a byte over 255.
   * @param entity - Its entity's number in a map's scene: a local entity's.
   */
  add(
    origin: Point,
    radius: number,
    rotation: number,
    color: ArrayLike<number>,
    entity = LOCAL_ENTITY_BASE
  ): void {
    if ((this.count + 1) * SPRITE_NUMBERS > this.sprites.length) {
      const grown = new Float64Array(this.sprites.length * 2);
      grown.set(this.sprites);
      this.sprites = grown;
    }
    const at = this.count++ * SPRITE_NUMBERS;
    const sprites = this.sprites;
    sprites[at] = origin.x;
    sprites[at + 1] = origin.y;
    sprites[at + 2] = origin.z;
    sprites[at + 3] = radius;
    sprites[at + 4] = rotation;
    for (let i = 0; i < 4; i++) sprites[at + 5 + i] = color[i];
    sprites[at + 9] = entity;
    // Its fog (`R_SpriteFogNum`), its origin in the node's space being the world's.
    spriteAt[0] = origin.x;
    spriteAt[1] = origin.y;
    spriteAt[2] = origin.z;
    sprites[at + 10] = this.scene ? this.scene.draws.fog.spriteFog(spriteAt, radius) : 0;
  }

  /**
   * End a frame: draw what it added, facing the eye as it is now, and nothing else. A merged
   * shader's sprites are drawn stage by stage over a run of them, which a change of fog ends, as
   * Q3's backend begins a batch at one (`tr_backend.c:546-555`).
   */
  end(): void {
    // The eye's axes in the node's space, Quake's left the eye's right reversed.
    unturn.copy(this.node.getRotation()).invert();
    unturn.transformVector(this.camera.right, this.viewLeft).mulScalar(-1);
    unturn.transformVector(this.camera.up, this.viewUp);

    this.batch.begin();
    this.runs = 0;
    const fogOf = (index: number) => this.sprites[index * SPRITE_NUMBERS + 10];
    if (this.mergable) {
      for (let first = 0; first < this.count; ) {
        let end = first + 1;
        while (end < this.count && fogOf(end) === fogOf(first)) end++;
        for (const [step, stage] of this.stages.entries()) {
          for (let i = first; i < end; i++) this.stamp(stage, i);
          this.run(first, step);
        }
        this.batch.endRun();
        first = end;
      }
    } else {
      for (let i = 0; i < this.count; i++) {
        for (const [step, stage] of this.stages.entries()) {
          this.stamp(stage, i);
          this.run(i, step);
        }
        this.batch.endRun();
      }
    }
    this.batch.end();
    if (this.scene) this.key(this.scene);
  }

  /** Note a run written: its first sprite, and its stage. */
  private run(sprite: number, step: number): void {
    this.runSprites[this.runs] = sprite;
    this.runStages[this.runs] = step;
    this.runs++;
  }

  /**
   * Each of the frame's batches' places in a map's scene, at its first sprite's entity and fog, a
   * stage at a time, and the fog's vectors it reads, the sprites being in the world's frame.
   */
  private key({ draws, shader }: { draws: SceneDraws; shader: SortedShader }): void {
    const { batch, sprites } = this;
    for (let run = 0; run < batch.runsDrawn; run++) {
      const at = this.runSprites[run] * SPRITE_NUMBERS;
      const instance = batch.runInstance(run);
      let tag = sceneDraw(instance);
      if (!tag) {
        tag = { shader, entity: sceneEntity(), step: 0 };
        tagDraw(instance, tag);
      }
      const { entity } = tag;
      entity.value = sprites[at + 9];
      entity.fog = sprites[at + 10];
      entity.fogData.set(draws.fog.worldData(entity.fog));
      tag.step = this.runStages[run];
    }
  }

  /** Draw nothing until the next frame adds something. */
  clear(): void {
    this.begin();
    this.end();
  }

  /** One sprite, for the warm-up (`warm-up.ts`). */
  warm(): Warmed {
    return {
      at: () => {
        this.begin();
        this.add(ORIGIN, 1, 0, WHITE);
        this.end();
      },
      end: () => this.clear()
    };
  }

  destroy(): void {
    this.scene?.draws.release(this.batch);
    this.batch.destroy();
    for (const stage of this.stages) stage.destroy();
  }

  /** Stamp sprite `index` in a stage, as `RB_SurfaceSprite` lays its corners. */
  private stamp(stage: StandardMaterial, index: number): void {
    const sprites = this.sprites;
    const at = index * SPRITE_NUMBERS;
    const radius = sprites[at + 3];
    const angle = (Math.PI * sprites[at + 4]) / 180;
    const c = Math.cos(angle) * radius;
    const s = Math.sin(angle) * radius;
    const { viewLeft: l, viewUp: u } = this;
    this.left.set(l.x * c - u.x * s, l.y * c - u.y * s, l.z * c - u.z * s);
    this.up.set(u.x * c + l.x * s, u.y * c + l.y * s, u.z * c + l.z * s);
    this.origin.set(sprites[at], sprites[at + 1], sprites[at + 2]);
    for (let i = 0; i < 4; i++) this.color[i] = sprites[at + 5 + i];
    this.batch.stamp(stage, this.origin, this.left, this.up, this.color);
  }
}
