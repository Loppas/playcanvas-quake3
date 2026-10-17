import {
  BoundingBox,
  Entity,
  Mat4,
  MeshInstance,
  Quat,
  Vec3,
  type AppBase,
  type GraphNode,
  type GraphicsDevice,
  type StandardMaterial
} from 'playcanvas';

import type { Md3Model, Md3Surface, Md3Tag } from '../formats/md3';
import { findShader, isSpriteDeform, type Deform, type TexMod } from '../formats/shader-script';
import { UNITS_PER_METRE } from '../coords';
import {
  entityLight,
  entityLightAt,
  keptEntityLight,
  lightInEntityFrame,
  type EntityLight,
  type KeptEntityLight,
  type LightingScene
} from '../view/entity-light';
import { multipliesColor } from '../view/overbright';
import type { FrameBlend } from '../view/player-animation';
import type { Rgb } from '../view/player-color';
import type { Placement } from '../view/player-pose';
import { modelStep } from '../view/scene-sort';
import { COORDINATES_LENGTH, coordinatesMove, writeCoordinates } from '../view/stage-motion';
import { isStamped } from '../view/vertex-deform';
import { drawnFrames } from '../view/vertex-morph';
import { axisRotation } from './axis-rotation';
import { modelFogPassMaterial } from './bsp-fog';
import { deformView, viewerInModel } from './deform-view';
import { sortAsModel } from './draw-order';
import { isAnimated, playStage, takesEntityColor, type StageOptions } from './effect-material';
import { BLENDED_CHILD } from './md3-mesh';
import {
  DEFORM_SLOTS,
  applyModelChunks,
  bindModelUniforms,
  deformReach,
  readsViewer,
  type ModelStage,
  writeAnim,
  writeDeforms,
  shadeScale,
  writeLight,
  writeView,
  writeViewer
} from './model-chunks';
import { frameTexture, grownBounds, stampMesh, surfaceMesh } from './model-frames';
import {
  sceneDraw,
  sceneEntity,
  surfaceShader,
  tagDraw,
  type SceneEntity,
  type SceneGroup,
  type ScenePlacement
} from './scene-draws';
import { createSkinStages, type SkinSource, type SkinStage } from './skin-material';
import { drawsInFramebuffer, tintGain } from './stage-gain';
import type { ResourceScope } from './texture-cache';

/**
 * A model drawn as Q3 draws a player's parts. Its vertices morph between two frames, each surface
 * draws once per stage of the shader it names, the lit stages are shaded by the entity light, by
 * how the model is turned, and the shining and the mirroring ones catch the light by where the
 * viewer is.
 *
 * Each surface draws its one shared mesh (`model-frames.ts`), and the stage materials' chunks
 * (`model-chunks.ts`) do the per-vertex work from uniforms set here, as ioq3's `opengl2` does.
 * Their TypeScript twins, which the chunks' tests hold them to, are `vertex-morph.ts`,
 * `vertex-deform.ts`, `shader-animation.ts` and `entity-light.ts`.
 */

/**
 * One surface's draws: its shader's deforms, and the uniforms its draws read, which each frame
 * writes.
 */
interface StagedSurface {
  surface: Md3Surface;
  deforms: readonly Deform[];
  /** A stage shines, mirrors or is lit per pixel, so the surface draws by where the viewer is. */
  byViewer: boolean;
  /** `q3_anim`. */
  anim: Float32Array;
  /** `q3_deform`. */
  deforming: Float32Array;
  /** Each stage whose `tcMod`s move with the clock, and its `q3_coords`. */
  coordinates: MovingCoordinates[];
}

/** A stage's `tcMod`s that move with the clock, the `q3_coords` its draws read, and its shader. */
interface MovingCoordinates {
  texMods: readonly TexMod[];
  uniform: Float32Array;
  shader: string;
}

/** The uniforms every surface of a model reads: they are the entity's. */
interface EntityUniforms {
  /** `q3_light`. */
  light: Float32Array;
  /** `q3_viewer`. */
  viewer: Float32Array;
  /** `q3_view`, for the sprites. */
  view: Float32Array;
  /** `q3_fog`: its scene entity's `fogData`. */
  fog: Float32Array;
}

/** A model, built to draw. */
export interface StagedModel {
  model: Md3Model;
  entity: Entity;
  surfaces: StagedSurface[];
  uniforms: EntityUniforms;
  /** A lit stage's material, by whose basis its shade is scaled; none for a model with none. */
  lit: StandardMaterial | null;
  /** Its entity's number in a map's scene, which whoever draws it writes. */
  order: SceneEntity;
  /** Where its draws are placed, for its copies to be placed so too; none outside the scene. */
  placement?: ScenePlacement;
}

/** Where a staged model's draws go. */
export interface StagedLayers {
  /** Layers for its draws that write depth; World when absent. */
  layers?: number[];
  /**
   * Layers for the draws that write none, which move onto a child of their own; with the
   * rest when absent.
   */
  blendedLayers?: number[];
  /** Its draws placed in a map's scene, or in their own layers where there is none, for both. */
  scene?: ScenePlacement;
}

/** Scratch for placing an entity. */
const rotation = new Quat();

/** Put an entity where a placement says, in its parent's Quake frame. */
export function place(entity: Entity, { origin, axis }: Placement): void {
  entity.setLocalPosition(origin[0], origin[1], origin[2]);
  entity.setLocalRotation(axisRotation(axis, rotation));
}

/** Turn an MD3 tag's axis rows into a rotation — or the hand's, which Q3 keeps the same way. */
export function tagRotation(tag: Pick<Md3Tag, 'axis'>): Quat {
  const [forward, left, up] = tag.axis;
  const matrix = new Mat4();
  // A tag's axis rows are the child frame's forward/left/up expressed in the parent's
  // frame, so they are the columns of the child-to-parent rotation.
  matrix.set([
    forward[0], forward[1], forward[2], 0,
    left[0], left[1], left[2], 0,
    up[0], up[1], up[2], 0,
    0, 0, 0, 1
  ]);
  return new Quat().setFromMat4(matrix);
}

/** Scratch for {@link lightInEntity}. */
const inverseRotation = new Quat();
const worldLight = new Vec3();
const localLight = new Vec3();

/**
 * An entity's light with its direction taken into the entity's own frame, for
 * `RB_CalcDiffuseColor`, as {@link lightInEntityFrame} takes it by an axis: for a model hung
 * under others, whose axis only the scene knows.
 *
 * The light is a **world** direction, and Q3 evaluates `N·L` in each entity's own frame, so the
 * direction is pulled back through the entity's world rotation rather than the normals
 * being pushed out. That is why a weapon's shading shifts as you turn: the model is fixed
 * to the camera, so turning rotates it under a stationary sun. Freezing this at build time
 * would look fine standing still and wrong the moment you moved.
 *
 * @param light - The light, in Quake's world frame; the splat map's by default.
 * @param out - Where it is written, which may be `light`; a new light by default.
 */
export function lightInEntity(
  entity: Entity,
  light: EntityLight = entityLight(),
  out: KeptEntityLight = keptEntityLight()
): KeptEntityLight {
  const { direction } = light;
  // Quake's frame to the engine's, as `simToWorld` turns it.
  worldLight.set(direction[0], direction[2], -direction[1]).normalize();
  inverseRotation.copy(entity.getRotation()).invert();
  inverseRotation.transformVector(worldLight, localLight);
  for (let i = 0; i < 3; i++) {
    out.ambient[i] = light.ambient[i];
    out.directed[i] = light.directed[i];
  }
  out.direction[0] = localLight.x;
  out.direction[1] = localLight.y;
  out.direction[2] = localLight.z;
  return out;
}

/** Scratch for where an entity stands, in Quake's frame. */
const standing = { x: 0, y: 0, z: 0 };

/**
 * The light a model takes where it stands, in the world's frame: {@link entityLightAt} at the
 * entity's own origin, which is where Q3 lights every model but a player's parts and what they
 * hold (`tr_light.c:306–313`).
 *
 * @param scene - What the scene lights it by.
 * @param out - Where it is written; a new light by default.
 */
export function lightAtEntity(
  entity: GraphNode,
  scene: LightingScene,
  out: KeptEntityLight = keptEntityLight()
): KeptEntityLight {
  const at = entity.getPosition();
  // The engine's frame to Quake's, as `worldToSim` turns it.
  standing.x = at.x * UNITS_PER_METRE;
  standing.y = -at.z * UNITS_PER_METRE;
  standing.z = at.y * UNITS_PER_METRE;
  return entityLightAt(standing, scene, undefined, out);
}

/** The colour that changes nothing. */
const WHITE: Rgb = [1, 1, 1];

/** A model's first frame, unblended: what a cleared refEntity shows. */
export const FIRST_FRAME: Readonly<FrameBlend> = { oldFrame: 0, frame: 0, backlerp: 0 };

/**
 * The shader a surface draws with on a model with no skin: the first its MD3 names, as a
 * refEntity with no skin and `skinNum` 0 takes it (`tr_mesh.c:375–381`).
 */
export function ownShader(surface: Md3Surface): string {
  return surface.shaders[0] ?? '';
}

/** The bounds each deforming draw is culled by, for a copy of it to be culled the same. */
const deformedBounds = new WeakMap<MeshInstance, BoundingBox>();

/**
 * Build a model: a draw per stage of the shader `shaderOf` names for each surface, over the
 * surface's one shared mesh. Stages that write depth draw with the model in `layers`; the rest
 * draw over it from a child in `blendedLayers`, in declaration order. Each draw carries its place
 * in that order as its `drawOrder`, for a layer that sorts by hand, and one that sorts back to
 * front sorts them all at the model's origin in that order ({@link sortAsModel}).
 *
 * @param scope - Holds the materials and textures, to be given back with the model; without one
 *   they are made for good, as the view weapon's are.
 * @param shaderOf - The shader a surface draws with: its skin's, or its own for a model with none.
 * @param animated - Collects the stages to play every frame: those that change over time, and
 *   those that take the entity's colour.
 */
export async function buildStagedModel(
  app: AppBase,
  library: SkinSource,
  scope: ResourceScope | undefined,
  name: string,
  model: Md3Model,
  shaderOf: (surface: Md3Surface) => string,
  { layers, blendedLayers, scene }: StagedLayers,
  animated: SkinStage[]
): Promise<StagedModel> {
  const drawn = sceneEntity({ kind: 'model', frames: model.frames, frame: 0 });
  /** Whether the draws that write no depth move onto a child of their own. */
  const apart = scene ? scene.group === 'models' : blendedLayers !== undefined;
  const opaque: MeshInstance[] = [];
  const blended: MeshInstance[] = [];
  const surfaces: StagedSurface[] = [];
  const uniforms: EntityUniforms = {
    light: new Float32Array(12),
    viewer: new Float32Array(4),
    view: new Float32Array(16),
    fog: drawn.fogData
  };
  /** The draws that deform, and the bounds they are culled by. */
  const grown = new Map<MeshInstance, BoundingBox>();
  let order = 0;
  let lit: StandardMaterial | null = null;
  try {
    for (const [s, surface] of model.surfaces.entries()) {
      const shaderName = shaderOf(surface);
      const stages = await createSkinStages(app, library, shaderName, scope);
      if (stages.length === 0) continue;
      const deforms = (shaderName ? findShader(library.shaders, shaderName)?.deforms : undefined) ?? [];
      const device = app.graphicsDevice;
      const passed = scene ? { scope } : null;
      const built = buildSurface(device, surface, shaderName, stages, deforms, uniforms, passed);
      const depthHack = scene?.group === 'gun';
      for (const [index, instance] of built.instances.entries()) {
        if (built.bounds) grown.set(instance, built.bounds);
        instance.drawOrder = order++;
        const stage = stages[index];
        if (stage.lit) lit ??= stage.material;
        (stage.depthWrite || !apart ? opaque : blended).push(instance);
        if (scene) {
          const shader = surfaceShader(scene, shaderName);
          tagDraw(instance, { shader, entity: drawn, step: modelStep(index, s), depthHack });
        }
        if (isAnimated(stage) || takesEntityColor(stage)) animated.push(stage);
      }
      // After the surface's stages, as `RB_FogPass` follows the batch's.
      if (scene && built.pass) {
        if (built.bounds) grown.set(built.pass, built.bounds);
        built.pass.drawOrder = order++;
        opaque.push(built.pass);
        const shader = surfaceShader(scene, shaderName);
        const step = modelStep(stages.length, s);
        tagDraw(built.pass, { shader, entity: drawn, step, depthHack, fogPass: true });
      }
      surfaces.push(built.surface);
    }
  } catch (error) {
    // The shared meshes keep a hold of their own; the scope has the materials.
    for (const instance of [...opaque, ...blended]) instance.destroy();
    throw error;
  }

  const entity = new Entity(name);
  entity.addComponent('render', { meshInstances: opaque, ...(layers ? { layers } : {}) });
  if (scene) scene.draws.place(entity.render!, scene.group);
  if (blended.length > 0) {
    const child = new Entity(BLENDED_CHILD);
    child.addComponent('render', {
      meshInstances: blended,
      ...(blendedLayers ? { layers: blendedLayers } : {})
    });
    if (scene) scene.draws.place(child.render!, 'effects');
    entity.addChild(child);
  }
  // A render component gives each draw its own bounds as it takes them, so these go on after.
  for (const [instance, bounds] of grown) {
    instance.setCustomAabb(bounds);
    deformedBounds.set(instance, bounds);
  }
  sortAsModel([...opaque, ...blended], entity);
  return { model, entity, surfaces, uniforms, lit, order: drawn, placement: scene };
}

/**
 * A copy of a model, for another entity to draw: draws of its own over the same meshes and
 * materials, and uniforms of its own, so each copy is placed and lit apart while the stages play
 * once for every copy, as Q3 draws every entity of a model with its one registration. The copy is
 * unplaced, with nothing hung under it but its blended draws.
 */
export function copyStagedModel(part: StagedModel): StagedModel {
  const { fogBy } = part.order;
  const order = sceneEntity(fogBy && { ...fogBy });
  const uniforms: EntityUniforms = {
    light: new Float32Array(part.uniforms.light.length),
    viewer: new Float32Array(part.uniforms.viewer.length),
    view: new Float32Array(part.uniforms.view.length),
    fog: order.fogData
  };
  /** Each uniform the model's draws hold, and the copy's own in its place. */
  const own = new Map<unknown, Float32Array>([
    [part.uniforms.light, uniforms.light],
    [part.uniforms.viewer, uniforms.viewer],
    [part.uniforms.view, uniforms.view],
    [part.uniforms.fog, uniforms.fog]
  ]);
  const surfaces = part.surfaces.map((surface): StagedSurface => {
    const copy: StagedSurface = {
      ...surface,
      anim: new Float32Array(surface.anim.length),
      deforming: new Float32Array(surface.deforming.length),
      // As the model's were last written, until the copy's first draw writes its own.
      coordinates: surface.coordinates.map((moving) => ({
        ...moving,
        uniform: Float32Array.from(moving.uniform)
      }))
    };
    own.set(surface.anim, copy.anim);
    own.set(surface.deforming, copy.deforming);
    for (const [index, { uniform }] of surface.coordinates.entries()) {
      own.set(uniform, copy.coordinates[index].uniform);
    }
    return copy;
  });

  const ordered: MeshInstance[] = [];
  const { placement } = part;
  const copyDraws = (from: Entity, to: Entity, group: SceneGroup): void => {
    const draws = from.render!.meshInstances.map((instance) => {
      const draw = new MeshInstance(instance.mesh!, instance.material!);
      // The frames, and a still stage's `q3_coords`, are never written, so they stay the model's.
      for (const [name, { data }] of instance.getParameters()) {
        draw.setParameter(name, own.get(data) ?? data);
      }
      draw.drawOrder = instance.drawOrder;
      const tag = sceneDraw(instance);
      if (tag) tagDraw(draw, { ...tag, entity: order });
      // A fog pass hidden until a fog shows it.
      if (tag?.fogPass) draw.visible = false;
      return draw;
    });
    to.addComponent('render', { meshInstances: draws, layers: [...from.render!.layers] });
    if (placement) placement.draws.place(to.render!, group);
    // As the model's own, the bounds go on once the component has taken the draws.
    for (const [index, instance] of from.render!.meshInstances.entries()) {
      const bounds = deformedBounds.get(instance);
      if (!bounds) continue;
      draws[index].setCustomAabb(bounds);
      deformedBounds.set(draws[index], bounds);
    }
    ordered.push(...draws);
  };
  const entity = new Entity(part.entity.name);
  copyDraws(part.entity, entity, placement?.group ?? 'models');
  const blended = part.entity.children.find((child) => child.name === BLENDED_CHILD);
  if (blended) {
    const child = new Entity(BLENDED_CHILD);
    copyDraws(blended as Entity, child, 'effects');
    entity.addChild(child);
  }
  sortAsModel(ordered, entity);
  return { model: part.model, entity, surfaces, uniforms, lit: part.lit, order, placement };
}

/**
 * One surface: a draw per stage over the surface's shared mesh, or its stamps' for an
 * `autosprite`, each stage's material given the model chunks, and every draw holding the uniforms
 * it reads. A stage's `tcMod`s that stand still are written once, and those that move at each
 * draw. A surface that deforms comes with its bounds grown as far as its deforms push, for its
 * draws to be culled by.
 *
 * @param shader - The shader it draws with, which a drop names.
 * @param pass - Where its fog pass is held, for a surface drawn in a map's scene, which then has
 *   one, hidden until a fog shows it; none outside it.
 */
function buildSurface(
  device: GraphicsDevice,
  surface: Md3Surface,
  shader: string,
  stages: readonly SkinStage[],
  deforms: readonly Deform[],
  model: EntityUniforms,
  pass: { scope?: ResourceScope } | null
): {
  surface: StagedSurface;
  instances: MeshInstance[];
  pass: MeshInstance | null;
  bounds: BoundingBox | null;
} {
  const mesh = isStamped(deforms) ? stampMesh(device, surface) : surfaceMesh(device, surface);
  const frames = frameTexture(device, surface);
  const drawn: ModelStage[] = stages.map((stage) => ({
    lit: stage.lit,
    specular: stage.specular,
    environment: stage.environment === true,
    coordinates: stage.animation.texMods.length > 0,
    deforms,
    multiplies: multipliesColor(stage.animation),
    fog: stage.fog === 'none' ? undefined : stage.fog
  }));
  const built: StagedSurface = {
    surface,
    deforms,
    byViewer: drawn.some((stage) => readsViewer(stage)),
    anim: new Float32Array(4),
    deforming: new Float32Array(DEFORM_SLOTS * 8),
    coordinates: []
  };
  const reach = deformReach(deforms, surface);
  const bounds = reach > 0 ? grownBounds(mesh.aabb, reach) : null;
  const instances = stages.map((stage, index) => {
    applyModelChunks(stage.material, drawn[index]);
    const instance = new MeshInstance(mesh, stage.material);
    const { texMods } = stage.animation;
    // Where they stand still, or where they stand until the first draw moves them.
    const coordinates = new Float32Array(COORDINATES_LENGTH);
    const moves = coordinatesMove(texMods);
    writeCoordinates(moves ? [] : texMods, 0, coordinates, shader);
    if (moves) built.coordinates.push({ texMods, uniform: coordinates, shader });
    bindModelUniforms(instance, frames, {
      anim: built.anim,
      light: model.light,
      viewer: model.viewer,
      deforms: built.deforming,
      coordinates,
      view: model.view,
      fog: model.fog
    });
    return instance;
  });
  let fogPass: MeshInstance | null = null;
  if (pass) {
    const cull = stages[0].material.cull;
    fogPass = new MeshInstance(mesh, modelFogPassMaterial(device, deforms, cull, pass.scope));
    fogPass.visible = false;
    bindModelUniforms(fogPass, frames, {
      anim: built.anim,
      light: model.light,
      viewer: model.viewer,
      deforms: built.deforming,
      coordinates: new Float32Array(COORDINATES_LENGTH),
      view: model.view,
      fog: model.fog
    });
  }
  return { surface: built, instances, pass: fogPass, bounds };
}

/**
 * Whether a model draws its own surfaces, leaving what hangs under it — a barrel, a flash, a
 * shell — as it is: an invisible player's gun is drawn as its shell alone
 * (`cg_weapons.c:1171–1173`), and the view weapon's shells hang from the gun.
 */
export function drawOwnSurfaces(part: StagedModel, drawn: boolean): void {
  part.entity.render!.enabled = drawn;
  for (const child of part.entity.children) {
    if (child.name === BLENDED_CHILD) (child as Entity).render!.enabled = drawn;
  }
}

/** Scratch for {@link drawStagedModel}: a light with no world, and a light in a model's frame. */
const noWorld = keptEntityLight();
const framed = keptEntityLight();

/**
 * Draw a model this frame: placed, its vertices at its frames' blend, its lit stages shaded by how
 * it is turned under the light (`R_SetupEntityLighting`), its shining stages lit and its mirroring
 * ones reflecting by where the viewer is, its sprites turned to where the viewer looks, and its
 * ripples moved on.
 *
 * @param seconds - The clock its stages play on.
 * @param viewer - The camera it is seen from, for a shining, a mirroring or a per-pixel lit stage
 *   and a sprite. Without one, a shining stage shows no highlight, a mirroring one its surface's
 *   own coordinates, a per-pixel lit one is seen head on, and a sprite deform does nothing.
 * @param light - Its light, in the world's frame; by default a scene's with no world, as the HUD's
 *   models and the menu's are lit.
 */
export function drawStagedModel(
  part: StagedModel,
  pose: Placement & FrameBlend,
  seconds: number,
  viewer?: GraphNode,
  light: EntityLight = entityLight(undefined, noWorld)
): void {
  place(part.entity, pose);
  drawPlacedModel(part, pose, lightInEntityFrame(pose.axis, light, framed), seconds, viewer);
}

/** Whether a surface draws by where the viewer is; made once, so a frame makes no function. */
const drawsByViewer = (surface: StagedSurface) => surface.byViewer;

/** Whether a surface turns its quads to the viewer. */
const turnsSprites = (surface: StagedSurface) => surface.deforms.some(isSpriteDeform);

/**
 * Draw a model where it already sits, as {@link drawStagedModel} draws one it places, its lit
 * stages shaded by a light given in the model's own frame: for a model hung under others, as the
 * view weapon hangs from the hand. A frame writes only the model's uniforms; the chunks do the
 * rest.
 *
 * @param light - The model's light, its direction in the model's own frame.
 */
export function drawPlacedModel(
  part: StagedModel,
  frames: FrameBlend,
  light: EntityLight,
  seconds: number,
  viewer?: GraphNode
): void {
  const needed = viewer !== undefined && part.surfaces.some(drawsByViewer);
  const seen = needed ? viewerInModel(part.entity, viewer) : null;
  // The frame its fog is found by, which the scene finds before it draws.
  const { fogBy } = part.order;
  if (fogBy?.kind === 'model') {
    fogBy.frame = drawnFrames(part.model.numFrames, frames.oldFrame, frames.frame)[1];
  }
  // And where it looks, for a sprite.
  const sprites = part.surfaces.some(turnsSprites);
  const { uniforms } = part;
  writeLight(light, uniforms.light, shadeScale(part.lit !== null && drawsInFramebuffer(part.lit)));
  writeViewer(seen, uniforms.viewer);
  if (sprites) writeView(viewer ? deformView(part.entity, viewer) : null, uniforms.view);
  for (const surface of part.surfaces) {
    writeAnim(part.model.numFrames, surface.surface.numVerts, frames, surface.anim);
    writeDeforms(surface.deforms, seconds, surface.deforming);
    writeMovingCoordinates(surface, seconds);
  }
}

/** A surface's moving `tcMod`s at `seconds`. */
function writeMovingCoordinates(surface: StagedSurface, seconds: number): void {
  for (let i = 0; i < surface.coordinates.length; i++) {
    const { texMods, uniform, shader } = surface.coordinates[i];
    writeCoordinates(texMods, seconds, uniform, shader);
  }
}

/**
 * Move a staged model's texture coordinates to `seconds`, without drawing it: for a warm-up that
 * plays a model's stages before it is ever drawn, as an item's.
 */
export function writeStagedTexMods(part: StagedModel, seconds: number): void {
  for (const surface of part.surfaces) writeMovingCoordinates(surface, seconds);
}

/** How {@link playStagedStages} plays a model's stages in its own colours. */
const PLAIN_LIT: StageOptions = { lit: true, color: WHITE, ownsTransform: true };
const PLAIN: StageOptions = { color: WHITE, ownsTransform: true };

/**
 * Play a model's stages at `seconds`: those that change over time, and those that take the
 * entity's colour. A lit stage's colour is its vertex colours, doubled; `stageGain` gives it 1. A
 * stage taking the entity's colour multiplies in `color`, white when there is none.
 *
 * @param tint - Multiplies every stage's colour, for a model drawn in another's colours, as
 *   {@link tintStagedModel} multiplies the stages never played.
 */
export function playStagedStages(
  stages: readonly SkinStage[],
  seconds: number,
  color?: Rgb,
  tint: Rgb = WHITE
): void {
  // A model in its own colours, as a map's are, plays on options made once.
  const plain = tint === WHITE && color === undefined;
  const lit = plain ? PLAIN_LIT : { lit: true, color: tint, ownsTransform: true };
  const own = plain ? PLAIN : { color: tint, ownsTransform: true };
  let tinted = PLAIN;
  if (!plain) {
    const [r, g, b] = color ?? WHITE;
    tinted = { color: [r * tint[0], g * tint[1], b * tint[2]] as const, ownsTransform: true };
  }
  for (const stage of stages) {
    const options = stage.lit ? lit : takesEntityColor(stage) ? tinted : own;
    playStage(stage.material, stage, seconds, options);
  }
}

/**
 * Multiply every stage of a model by `tint`, for a model drawn in another's colours: once, for the
 * stages never played again. {@link playStagedStages} tints the rest as it plays them.
 */
export function tintStagedModel(part: StagedModel, tint: Rgb): void {
  const blended = part.entity.children.filter((child) => child.name === BLENDED_CHILD);
  for (const entity of [part.entity, ...blended] as Entity[]) {
    for (const instance of entity.render!.meshInstances) {
      const material = instance.material as StandardMaterial;
      tintGain(material, tint);
      material.update();
    }
  }
}
