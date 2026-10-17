import { Entity, MeshInstance, type AppBase, type Mesh } from 'playcanvas';

import { UNITS_PER_METRE } from '../coords';
import type { AssetLibrary } from '../formats/asset-library';
import { NO_CONTENTS, type PointContentsFn, type TraceFn } from '../sim/types';
import type { Vec3 } from '../sim/vec3';
import type { DamageBlob } from '../view/damage-feedback';
import {
  NO_WORLD,
  entityLightAt,
  keptEntityLight,
  lightInEntityFrame,
  type LightingScene
} from '../view/entity-light';
import { Fragments, type BounceMark, type GibPiece, type GibSound } from '../view/fragments';
import { LocalEntities } from '../view/local-entities';
import { IDENTITY_AXIS } from '../view/q-math';
import { dimEffectStages } from './bsp-fog';
import { createEffectStages, type EffectStage } from './effect-material';
import {
  applyQuakeTransform,
  copyMd3,
  createMd3Entity,
  faceMd3,
  playMd3,
  shadeMd3,
  type Md3Renderable
} from './md3-mesh';
import { MergedSprites } from './merged-sprites';
import { showHidden, type Warmed } from './warm-up';
import { createSpriteMesh } from './world-effects';
import { BLOB_ENTITY, localEntity } from '../view/scene-sort';
import { LIGHTMAP_2D } from '../view/world-shaders';
import {
  sceneEntity,
  setFogRadius,
  type SceneDraws,
  type SceneEntity
} from './scene-draws';

/**
 * Gibs, and the blood of a hurt: the pieces `fragments.ts` throws, the blood
 * they trail, and the blob `CG_DamageBlendBlob` splashes in front of the eye.
 *
 * A piece is its model from `models/gibs/`, copied from one built at the start and lit every frame
 * where it is, as Q3 lights every entity; Q3 never turns a gib (`axisDefault`), so each takes the
 * light unturned. The trail's puffs are sprites of `bloodTrail` merged into one draw, fading by
 * their colour's alpha, in the effects layer after the splat map, as the smoke trails are. The
 * blob is a sprite of `viewBloodBlend` hung off the camera; the view weapon draws over it, as Q3's
 * depth hack keeps the gun in front of everything.
 */

/** Every piece `CG_GibPlayer` can throw. */
const PIECES: readonly GibPiece[] = [
  'skull',
  'brain',
  'abdomen',
  'arm',
  'chest',
  'fist',
  'foot',
  'forearm',
  'intestine',
  'leg'
];

/** A piece's model (`cg_main.c:961–970`). */
export function gibModelPath(piece: GibPiece): string {
  return `models/gibs/${piece}.md3`;
}

/** `cgs.media.viewBloodShader` (`cg_main.c:842`). */
const BLOOD_BLOB_SHADER = 'viewBloodBlend';

/** A puff's colour: white, as `CG_BloodTrail` hands it, its alpha set puff by puff. */
const puffColor = [1, 1, 1, 0];

/** A sprite, and its one draw, whose opacity is set sprite by sprite. */
interface Sprite {
  entity: Entity;
  instance: MeshInstance;
  /** Its entity in a map's scene, whose fog is found by its radius. */
  order: SceneEntity;
}

/** What the gibs and the blob are drawn from this frame. */
export interface GibEffectsInput {
  /** Where the player went to pieces this frame. */
  gibOrigins: readonly Vec3[];
  /** `cg_gibs`: every piece, or only the skull or the brain. */
  allPieces: boolean;
  /** Game time in milliseconds, which `cg.time` counts whole. */
  time: number;
  /** `cg.refdef.vieworg`, in Quake units: a puff the view is inside is let go. */
  eye: Vec3;
  /** The blob in front of the eye, or `null`: no hurt, or the camera is behind the body. */
  blob: DamageBlob | null;
}

/** The gibs in the world, and the blob in front of the eye. */
export class GibEffects {
  /** Quake units, Z-up, at the world's origin. */
  private readonly root: Entity;
  private readonly camera: Entity;
  private readonly trace: TraceFn;
  private readonly pointContents: PointContentsFn;
  private readonly fragments: Fragments;
  /** Each piece as built, hidden, for its copies. */
  private readonly prototypes: Map<GibPiece, Md3Renderable>;
  /** Each piece's copies, reused from frame to frame. */
  private readonly pools = new Map<GibPiece, Md3Renderable[]>();
  /** The trail's puffs, in `bloodTrail` (`cg_main.c:859`). */
  private readonly trail: MergedSprites;
  private readonly blob: Sprite;
  /** The scene's light; a scene with no world when absent. */
  private readonly lights: LightingScene | undefined;
  /** A piece's light, written for each piece shaded. */
  private readonly light = keptEntityLight();
  /** How many copies of each piece the frame has drawn. */
  private readonly used = new Map<GibPiece, number>();
  private destroyed = false;

  private constructor(
    camera: Entity,
    root: Entity,
    trace: TraceFn,
    layers: number[],
    fragments: Fragments,
    prototypes: Map<GibPiece, Md3Renderable>,
    spriteMesh: Mesh,
    trail: MergedSprites,
    blood: EffectStage,
    lights: LightingScene | undefined,
    pointContents: PointContentsFn,
    scene: SceneDraws | undefined
  ) {
    this.camera = camera;
    this.lights = lights;
    this.trace = trace;
    this.pointContents = pointContents;
    this.fragments = fragments;
    this.prototypes = prototypes;
    this.trail = trail;
    this.root = root;
    for (const prototype of prototypes.values()) this.root.addChild(prototype.entity);

    const instance = new MeshInstance(spriteMesh, blood.material);
    const entity = new Entity('blood-blob');
    entity.addComponent('render', { meshInstances: [instance], layers });
    entity.enabled = false;
    camera.addChild(entity);
    // `CG_DamageBlendBlob`'s sprite, the first entity a view adds, in `viewBloodShader`.
    const order = sceneEntity({ kind: 'sprite', radius: 0 });
    order.value = BLOB_ENTITY;
    this.blob = { entity, instance, order };
    const shader = scene?.shaders.handle(BLOOD_BLOB_SHADER, LIGHTMAP_2D);
    if (scene && shader) scene.placeDrawing(entity.render!, 'effects', shader, order);
  }

  /**
   * Build every piece the paks have, and the two blood sprites.
   *
   * @param camera - The eye: the blob hangs off it, and the puffs face it.
   * @param trace - `CG_Trace`, for the pieces to hit.
   * @param layers - The effects layer, after the splat map, for what writes no depth.
   * @param random - `random()`, for the throws and the splats.
   * @param lights - The scene's light, its grid and its lights, which light each piece where it is.
   * @param localEntities - The pool each piece and puff takes its place in.
   * @param pointContents - `CG_PointContents`, for a piece that lands in nodrop.
   * @param scene - The scene each drawing is placed in, where a map's world is drawn.
   * @param bounceMark - Where a piece's first bounce leaves its blood; none for none.
   */
  static async create(
    app: AppBase,
    library: AssetLibrary,
    camera: Entity,
    trace: TraceFn,
    layers: number[],
    random: () => number = Math.random,
    lights?: LightingScene,
    localEntities = new LocalEntities(),
    pointContents: PointContentsFn = NO_CONTENTS,
    scene?: SceneDraws,
    bounceMark: BounceMark | null = null
  ): Promise<GibEffects> {
    const prototypes = new Map<GibPiece, Md3Renderable>();
    for (const piece of PIECES) {
      const path = gibModelPath(piece);
      if (!library.read(path)) continue;
      const model = await createMd3Entity(app, library, path, {
        blendedLayers: layers,
        ...(scene ? { scene: { draws: scene, group: 'models' as const } } : {})
      });
      model.entity.enabled = false;
      prototypes.set(piece, model);
    }
    const root = new Entity('gibs');
    applyQuakeTransform(root);
    app.root.addChild(root);
    const trail = await MergedSprites.create(
      app,
      library,
      'bloodTrail',
      root,
      layers.flatMap((id) => app.scene.layers.getLayerById(id) ?? []),
      camera,
      scene
    );
    const [blood] = await createEffectStages(app, library, BLOOD_BLOB_SHADER);
    dimEffectStages([blood]);
    return new GibEffects(
      camera,
      root,
      trace,
      layers,
      new Fragments(random, localEntities, bounceMark),
      prototypes,
      createSpriteMesh(app.graphicsDevice),
      trail,
      blood,
      lights,
      pointContents,
      scene
    );
  }

  /**
   * Throw this frame's gibs, move everything, and draw it — `CG_GibPlayer`, `CG_AddLocalEntities`
   * and `CG_DamageBlendBlob`.
   *
   * @returns the splats the pieces made this frame, for the sound bus
   */
  update(input: GibEffectsInput): GibSound[] {
    const time = Math.floor(input.time);
    for (const origin of input.gibOrigins) this.fragments.gibPlayer(origin, time, input.allPieces);
    const frame = this.fragments.update(time, this.trace, input.eye, this.pointContents);

    // `CG_LaunchGib` gives a piece no `shaderTime`, so every copy shows the game clock's moment,
    // and one update of its prototype moves them all.
    for (const prototype of this.prototypes.values()) playMd3(prototype, time / 1000);
    const { used, light } = this;
    used.clear();
    const scene = this.lights ?? NO_WORLD;
    for (const gib of frame.gibs) {
      const index = used.get(gib.piece) ?? 0;
      const copy = this.gibCopy(gib.piece, index);
      if (!copy) continue;
      used.set(gib.piece, index + 1);
      copy.order.value = localEntity(gib.serial);
      copy.entity.enabled = true;
      copy.entity.setLocalPosition(gib.origin.x, gib.origin.y, gib.origin.z);
      entityLightAt(gib.lightOrigin, scene, undefined, light);
      shadeMd3(copy, lightInEntityFrame(IDENTITY_AXIS, light, light));
      faceMd3(copy, this.camera);
    }
    for (const [piece, pool] of this.pools) {
      for (let i = used.get(piece) ?? 0; i < pool.length; i++) pool[i].entity.enabled = false;
    }

    this.trail.begin();
    for (const puff of frame.puffs) {
      // `alphaGen vertex`: the fade is the sprite's alpha.
      puffColor[3] = puff.alpha;
      this.trail.add(puff.origin, puff.radius, puff.rotation, puffColor, localEntity(puff.serial));
    }
    this.trail.end();

    this.drawBlob(input.blob);
    return frame.sounds;
  }

  /** Take every piece and puff away, as a restart does. */
  clear(): void {
    this.fragments.clear();
    this.trail.clear();
  }

  /**
   * Every piece and both blood sprites, for the warm-up (`warm-up.ts`): each piece played on the
   * game clock, a trail's puff and the blob, each in its own layer.
   */
  warm(): Warmed {
    const trail = this.trail.warm();
    let hide: (() => void) | null = null;
    return {
      at: (seconds) => {
        trail.at(seconds);
        if (!hide) {
          const shown = showHidden(this.root);
          const blob = this.blob.entity.enabled;
          this.blob.entity.enabled = true;
          hide = () => {
            shown();
            this.blob.entity.enabled = blob;
          };
        }
        for (const prototype of this.prototypes.values()) playMd3(prototype, seconds);
      },
      end: () => {
        trail.end();
        hide?.();
        hide = null;
      }
    };
  }

  /** Remove everything from the scene. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.trail.destroy();
    this.root.destroy();
    this.blob.entity.destroy();
  }

  /** The `index`th copy of a piece, made on first need; `null` for a piece the paks lack. */
  private gibCopy(piece: GibPiece, index: number): Md3Renderable | null {
    const prototype = this.prototypes.get(piece);
    if (!prototype) return null;
    let pool = this.pools.get(piece);
    if (!pool) {
      pool = [];
      this.pools.set(piece, pool);
    }
    while (pool.length <= index) {
      const copy = copyMd3(prototype);
      this.root.addChild(copy.entity);
      pool.push(copy);
    }
    return pool[index];
  }

  /** Place the blob in front of the eye, or put it away. */
  private drawBlob(blob: DamageBlob | null): void {
    const { entity, instance, order } = this.blob;
    entity.enabled = blob !== null;
    if (!blob) return;
    setFogRadius(order, blob.radius);
    // The camera's own frame: +x right, +y up, −z ahead. The blob's offsets are along the view's
    // forward, left and up.
    entity.setLocalPosition(
      -blob.left / UNITS_PER_METRE,
      blob.up / UNITS_PER_METRE,
      -blob.forward / UNITS_PER_METRE
    );
    const size = (2 * blob.radius) / UNITS_PER_METRE;
    entity.setLocalScale(size, size, size);
    instance.setParameter('material_opacity', blob.alpha);
  }
}
