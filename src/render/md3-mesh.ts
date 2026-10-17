import {
  ADDRESS_CLAMP_TO_EDGE,
  ADDRESS_REPEAT,
  BLEND_ADDITIVE,
  BLEND_NORMAL,
  BoundingBox,
  CULLFACE_BACK,
  CULLFACE_FRONT,
  CULLFACE_NONE,
  Entity,
  FILTER_LINEAR,
  FILTER_LINEAR_MIPMAP_LINEAR,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  StandardMaterial,
  Texture,
  type AppBase,
  type GraphNode,
  type GraphicsDevice,
  type Material,
  type Mesh
} from 'playcanvas';

import type { AssetLibrary } from '../formats/asset-library';
import {
  findShader,
  isSpriteDeform,
  type Deform,
  type ShaderScript,
  type TexMod,
  type Wave
} from '../formats/shader-script';
import { upload32Image } from '../formats/image-scale';
import { decodeTga, type DecodedImage } from '../formats/tga';
import type { Md3Model, Md3Surface } from '../formats/md3';
import { UNITS_PER_METRE } from '../coords';
import type { EntityLight } from '../view/entity-light';
import { modelStep } from '../view/scene-sort';
import { COORDINATES_LENGTH, writeCoordinates } from '../view/stage-motion';
import { isStamped } from '../view/vertex-deform';
import { fogAdjustment, type FogAdjustment } from '../view/world-shaders';
import { applyAlphaFunc } from './alpha-test';
import { modelFogPassMaterial } from './bsp-fog';
import { deformView, viewerInModel } from './deform-view';
import { sortAsModel } from './draw-order';
import {
  DEFORM_SLOTS,
  applyModelChunks,
  bindModelUniforms,
  deformReach,
  readsViewer,
  shadeScale,
  writeAnim,
  writeDeforms,
  writeLight,
  writeView,
  writeViewer
} from './model-chunks';
import { firstFrameMesh, frameTexture, grownBounds, stampMesh, surfaceMesh } from './model-frames';
import {
  sceneDraw,
  sceneEntity,
  surfaceShader,
  tagDraw,
  type SceneEntity,
  type ScenePlacement
} from './scene-draws';
import { drawsInFramebuffer, setGain } from './stage-gain';
import type { ResourceScope } from './texture-cache';

/**
 * The seam where parsed Quake assets become PlayCanvas resources.
 *
 * Everything above this file is engine-free and headless-testable; everything below is the
 * engine. Meshes keep their **Quake units and Z-up orientation** — the basis change and the
 * 32 u/m scale ride on the entity transform (see {@link applyQuakeTransform}), so conversion
 * happens at the render boundary and is never baked in.
 */

/**
 * Rotation that takes Quake's Z-up frame to PlayCanvas' Y-up one.
 *
 * `coords.simToWorld` maps `(x, y, z) -> (x, z, -y)`, which is exactly a -90 degree turn
 * about X. Expressing it as an entity rotation rather than transformed vertices keeps the
 * two frames' relationship in one readable place, and keeps tags, bounds and vertex data
 * all in the same units.
 */
export const QUAKE_TO_WORLD_EULER: [number, number, number] = [-90, 0, 0];

/** Put an entity into the Quake frame: Z-up geometry in Quake units, drawn in metres. */
export function applyQuakeTransform(entity: Entity): void {
  entity.setLocalEulerAngles(...QUAKE_TO_WORLD_EULER);
  const scale = 1 / UNITS_PER_METRE;
  entity.setLocalScale(scale, scale, scale);
}

/**
 * Draw an instance with a material, left alone if it has it: assigning a material drops the
 * instance's shaders, even when it is the one it has.
 */
export function setMaterial(instance: MeshInstance, material: Material): void {
  if (instance.material !== material) instance.material = material;
}

/** How a TGA is decoded: {@link decodeTga}, or a worker's. */
export type DecodeTga = (bytes: Uint8Array, label: string) => DecodedImage | Promise<DecodedImage>;

let decodeTgaBytes: DecodeTga = decodeTga;

/**
 * Decode every TGA with `decode` from now on. The page hands them to a worker, so a texture's
 * decode runs off the thread that draws; Node and the tests decode in place.
 */
export function decodeTgasWith(decode: DecodeTga): void {
  decodeTgaBytes = decode;
}

/**
 * Decode any image a pak can hold into raw RGBA.
 *
 * One representation for both formats: TGAs by {@link decodeTgasWith}'s decoder, JPEGs by the
 * browser, read back through a canvas. That costs a draw per JPEG, and in exchange every image
 * reaches the GPU by the same path, with the same row order and the same alpha handling. Uploading
 * a JPEG's bitmap instead gives the same bytes, but was measured holding the GPU's queue back into
 * the first seconds of play.
 */
export async function decodeImage(path: string, bytes: Uint8Array): Promise<DecodedImage> {
  if (path.endsWith('.tga')) return decodeTgaBytes(bytes, path);

  // Copy into a fresh buffer: the pak bytes are a subarray of a much larger archive, and
  // Blob would otherwise be typed against a possibly-shared buffer.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const bitmap = await createImageBitmap(new Blob([copy.buffer]));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, pixels: data.data };
  } finally {
    bitmap.close();
  }
}

/**
 * Upload a decoded image as a texture with Quake's own filtering defaults.
 *
 * @param clamp - Stop at the edges instead of repeating, for a `clampMap` stage.
 * @param mipmaps - Build mipmaps; off for a `nomipmaps` shader, whose textures stay sharp at a
 *   distance.
 */
export function createTexture(
  device: GraphicsDevice,
  name: string,
  image: DecodedImage,
  clamp = false,
  mipmaps = true
): Texture {
  const address = clamp ? ADDRESS_CLAMP_TO_EDGE : ADDRESS_REPEAT;
  const texture = new Texture(device, {
    name,
    width: image.width,
    height: image.height,
    format: PIXELFORMAT_RGBA8,
    mipmaps,
    minFilter: mipmaps ? FILTER_LINEAR_MIPMAP_LINEAR : FILTER_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: address,
    addressV: address
  });
  const surface = texture.lock() as Uint8Array;
  surface.set(image.pixels);
  texture.unlock();
  return texture;
}

/**
 * Map a Quake 3 shader's `cull` onto PlayCanvas — **not** the identity mapping it looks like.
 *
 * `GL_Cull` (`renderer/tr_backend.c`) calls `qglCullFace(GL_FRONT)` for `CT_FRONT_SIDED`,
 * which is Q3's default and what a shader's `cull front` selects. That reads backwards until
 * you look at the data: MD3 triangles are wound **clockwise** when seen from outside the
 * model, so the face GL calls "front" is the one pointing into the model's interior.
 * Measured rather than assumed — every one of the rocket launcher's 405 triangles has a
 * winding normal opposing its own vertex normals (see `md3-mesh.test.ts`).
 *
 * PlayCanvas leaves the front face at CCW on both backends, so Q3's default is
 * {@link CULLFACE_FRONT} here. Getting this backwards does not hide the model — it draws its
 * *inside*, which looks almost right at a glance and then reads as inverted relief: vents
 * that push in instead of out, fittings seen from behind.
 */
export function q3CullMode(cull: ShaderScript['cull'] | undefined): number {
  if (cull === 'none') return CULLFACE_NONE;
  return cull === 'back' ? CULLFACE_BACK : CULLFACE_FRONT;
}

/**
 * Build a still mesh of its own for each MD3 surface, at its first frame, for a model drawn neither
 * lit nor moved, as an explosion's is. A model its owner lights or moves draws its surfaces'
 * shared meshes through the chunks instead ({@link createMd3Entity}).
 */
export function createMd3Meshes(device: GraphicsDevice, model: Md3Model): Mesh[] {
  return model.surfaces.map((surface) => firstFrameMesh(device, surface, surface.indices, false));
}

/**
 * `vertexColorGamma` is documented on `StandardMaterial` and installed at runtime by the
 * engine's `_defineFlag`, but it is absent from the shipped `.d.ts` — so it has to be named
 * here to be reachable from TypeScript.
 */
export type GammaVertexColorMaterial = StandardMaterial & { vertexColorGamma: boolean };

/**
 * Whether a surface takes Q3's per-entity diffuse lighting.
 *
 * `R_FindShader` only sets `CGEN_LIGHTING_DIFFUSE` on the **default** shader it synthesises
 * for an image with no script. A surface whose name resolves to a real shader script gets
 * that script's own `rgbGen` instead, and {@link createSurfaceMaterial} draws it flat, from its
 * first stage, at that stage's brightness.
 */
export function usesEntityLighting(
  library: AssetLibrary,
  surfaceShaderName: string
): boolean {
  return !findShader(library.shaders, surfaceShaderName);
}

/**
 * Build the material for one MD3 surface from its embedded shader name.
 *
 * Deliberately shallow: a diffuse map and an additive or alpha blend if the shader
 * asks for one. The scene's own lights are still not used — the splat map provides none to
 * sample — but "unlit" is not the same as "fullbright", and Q3's weapons are *not*
 * fullbright: {@link usesEntityLighting} surfaces carry `CGEN_LIGHTING_DIFFUSE` as per-vertex
 * colours, which the model chunks write from the model's light (`model-chunks.ts`).
 *
 * `vertexColorGamma` is what makes that faithful. Q3 multiplies texture by light in gamma
 * space; PlayCanvas decodes an RGBA8 map with `pow(2.2)` and re-encodes on output, so without
 * the flag the vertex colour would be the one term left in linear space and the shading
 * gradient would come out compressed.
 *
 * Its emissive colour is its brightness on screen under the renderer the port draws like:
 * twice a lit surface's vertex colours, which hold half its shade, or the gain of a
 * scripted surface's stage.
 *
 * @param scope - Holds the material and its texture, to be given back with the model that drew
 *   them; without one they are made for good, as the first-person weapons' are.
 */
/** A surface lit by its entity, as its vertex colours' shade. */
const LIT_STAGE = { rgbGen: 'lightingDiffuse', blend: 'opaque' } as const;

/** A surface drawn as a default stage draws. */
const DEFAULT_STAGE = { rgbGen: 'identityLighting', blend: 'opaque' } as const;

export async function createSurfaceMaterial(
  app: AppBase,
  library: AssetLibrary,
  surfaceShaderName: string,
  scope?: ResourceScope
): Promise<StandardMaterial> {
  const material = new StandardMaterial();
  scope?.own(material);
  material.useLighting = false;
  material.diffuse.set(0, 0, 0);

  const shader = findShader(library.shaders, surfaceShaderName);
  const stage = shader?.stages.find((s) => s.maps.some((m) => !m.startsWith('$')));

  // Its brightness. A lit surface's vertex colours hold its shade, halved on screen for this to
  // double back. A scripted one draws its single stage still, so a wave keeps a default stage's
  // brightness. So does a stage taking the entity's colour, which nothing feeds it here.
  if (usesEntityLighting(library, surfaceShaderName)) {
    material.emissiveVertexColor = true;
    (material as GammaVertexColorMaterial).vertexColorGamma = true;
    setGain(material, LIT_STAGE, { lit: true });
  } else if (stage && stage.rgbGen !== 'wave' && stage.rgbGen !== 'entity') {
    setGain(material, stage);
  } else {
    setGain(material, DEFAULT_STAGE);
  }

  const texture = library.surfaceTexture(surfaceShaderName);
  if (texture) {
    const uploaded = await loadTexture(
      app,
      texture.path,
      texture.bytes,
      false,
      !shader?.noMipMaps,
      scope
    );
    material.emissiveMap = uploaded;
    material.opacityMap = uploaded;
  }

  if (stage?.blend === 'add') {
    // `GL_ONE GL_ONE` adds RGB and ignores alpha. `BLEND_ADDITIVEALPHA` (`SRC_ALPHA, ONE`)
    // multiplies by it first, which silently scales an effect toward nothing whenever the
    // texture's alpha is not what a Q3 artist happened to care about.
    material.blendType = BLEND_ADDITIVE;
    material.depthWrite = false;
  } else if (stage?.blend === 'blend' || stage?.alphaFunc) {
    material.blendType = BLEND_NORMAL;
    material.depthWrite = false;
  }
  applyAlphaFunc(material, stage?.alphaFunc);

  material.cull = q3CullMode(shader?.cull);
  material.update();
  return material;
}

/**
 * A material's texture: counted in `scope` and given back with it where there is one, else made
 * for good.
 *
 * @param picmip - Sized as opengl1's `Upload32` sizes it, halved this many times
 *   (`upload32Image`); absent, uploaded at the file's own size.
 */
export async function loadTexture(
  app: AppBase,
  path: string,
  bytes: Uint8Array,
  clamp: boolean,
  mipmaps: boolean,
  scope?: ResourceScope,
  picmip?: number
): Promise<Texture> {
  if (scope) return scope.texture(path, bytes, clamp, mipmaps, picmip);
  const image = await decodeImage(path, bytes);
  const sized = picmip === undefined ? image : upload32Image(image, picmip);
  return createTexture(app.graphicsDevice, path, sized, clamp, mipmaps);
}

/** A model's entity, and the uniforms its owner writes each frame. */
export interface Md3Renderable {
  entity: Entity;
  /** The `q3_light` its draws read, for {@link shadeMd3}; `null` for a model built otherwise. */
  light: Float32Array | null;
  /** A lit surface's material, by whose basis its shade is scaled; none for a model with none. */
  litMaterial: StandardMaterial | null;
  /** Its entity's number in a map's scene, which whoever draws it writes. */
  order: SceneEntity;
  /** Where its draws are placed, for its copies to be placed so too; none outside the scene. */
  placement?: ScenePlacement;
  /** The `q3_view` its sprites read, for {@link faceMd3}; `null` for a model with no sprite. */
  view: Float32Array | null;
  /**
   * The `q3_viewer` its per-pixel lit surfaces read, for {@link faceMd3}; `null` for a model with
   * none.
   */
  viewer: Float32Array | null;
  /** Surfaces with a `tcMod turb` stage, for the caller to ripple on its clock. */
  turbulent: TurbulentSurface[];
  /** Surfaces whose shader deforms them, for the caller to move on its clock. */
  deforming: DeformingSurface[];
}

/**
 * A surface whose shader deforms it: its deforms, and the `q3_deform` its draws read. A model's copies share it, as they share its ripples: missiles, gibs and flashes carry no
 * `shaderTime`, so every copy shows the same moment.
 */
export interface DeformingSurface {
  deforms: readonly Deform[];
  uniform: Float32Array;
}

/**
 * Move a model's surfaces on to `seconds`, on the clock its stages play on: its ripples and its
 * deforms. A model's copies share both, so one call serves them all.
 */
export function playMd3(model: Pick<Md3Renderable, 'turbulent' | 'deforming'>, seconds: number): void {
  for (const surface of model.turbulent) rippleSurface(surface, seconds);
  for (const { deforms, uniform } of model.deforming) writeDeforms(deforms, seconds, uniform);
}

/**
 * A stage with `tcMod turb`: its ripple as a `tcMod` of its own, and the `q3_coords` its draw reads,
 * which is all a ripple writes; the chunks move the coordinates, and the stage's other `tcMod`s
 * stay the material's map transform, after it. Whoever owns the clock it plays on moves it, and a
 * model's copies share it, so one write serves them all.
 */
export interface TurbulentSurface {
  texMods: readonly TexMod[];
  uniform: Float32Array;
}

/** Move a stage's ripple on to this moment. */
export function rippleSurface(surface: TurbulentSurface, seconds: number): void {
  writeCoordinates(surface.texMods, seconds, surface.uniform);
}

/** Name of the child holding a model's depthless surfaces, when they draw apart. */
export const BLENDED_CHILD = 'blended';

/** A draw for one stage of a surface's shader. */
export interface SurfaceStage {
  material: StandardMaterial;
  /** `tcMod turb`: this stage's coordinates ripple, by a uniform of its own. */
  turb?: Wave;
  /** How a fog dims it (`adjustColorsForFog`); none where absent. */
  fog?: FogAdjustment;
}

/**
 * Which layers a model's surfaces render into, anything left out drawing in World, and how
 * many stages of each surface's shader they draw.
 */
export interface Md3Layers {
  /** Layers for every surface — the viewmodel keeps its whole weapon in its own. */
  layers?: number[];
  /**
   * Layers for the draws that write no depth — a depthless surface, or a blended stage over an
   * opaque one — which then move onto a child render component of their own: layers belong to
   * a render component, and a projectile's glow has to draw in a different one from its body.
   */
  blendedLayers?: number[];
  /**
   * Materials for **every** stage of a surface's shader, each drawn as its own instance over
   * the surface's mesh, in order; or `null` to draw the surface from its first stage as
   * usual. Injected, so this module need not know how an effect shader is built.
   */
  stages?: (surfaceShaderName: string) => Promise<readonly SurfaceStage[] | null>;
  /**
   * Holds the surfaces' materials and textures, to be given back with the model that drew them;
   * without one they are made for good. A `stages` callback takes care of its own.
   */
  scope?: ResourceScope;
  /** Its draws placed in a map's scene, or in their own layers where there is none, for both. */
  scene?: ScenePlacement;
}

/**
 * Build a renderable entity for a model, **in Quake space**: units, Z-up, untransformed.
 *
 * The caller decides where it goes. Placed directly in the world it needs
 * {@link applyQuakeTransform}; hung off the viewmodel rig it inherits that from the rig's
 * root and stays in Quake units, which is what lets tag offsets be used as written.
 *
 * Every surface draws its one shared mesh (`model-frames.ts`) at frame 0, or its stamps' for an
 * `autosprite`, and the model chunks (`model-chunks.ts`) shade it, deform it, turn its sprites and
 * ripple it.
 *
 * Every draw takes its place in Q3's order, surface by surface and stage by stage, as its
 * `drawOrder`, and sorts by it at the model's origin ({@link sortAsModel}).
 *
 * @param options - Which layers the surfaces render into, and whether they draw every stage.
 */
export async function createMd3Entity(
  app: AppBase,
  library: AssetLibrary,
  path: string,
  { layers, blendedLayers, stages, scope, scene }: Md3Layers = {}
): Promise<Md3Renderable> {
  const model = library.model(path);
  const order = sceneEntity({ kind: 'model', frames: model.frames, frame: 0 });
  /** Whether the draws that write no depth move onto a child of their own. */
  const apart = scene ? scene.group === 'models' : blendedLayers !== undefined;
  const shaderNames = model.surfaces.map((surface) => surface.shaders[0] ?? '');
  const isLit = (index: number) => usesEntityLighting(library, shaderNames[index]);
  const deformsOf = (index: number) => findShader(library.shaders, shaderNames[index])?.deforms ?? [];
  /** How a fog dims a surface drawn flat from its script's first stage. */
  const flatFog = (index: number): FogAdjustment => {
    const first = findShader(library.shaders, shaderNames[index])?.stages[0];
    return first ? fogAdjustment(first, first) : 'none';
  };
  const device = app.graphicsDevice;
  const shared: SharedUniforms = {
    light: new Float32Array(12),
    viewer: new Float32Array(4),
    deforms: new Float32Array(DEFORM_SLOTS * 8),
    view: new Float32Array(16),
    coordinates: new Float32Array(COORDINATES_LENGTH),
    fog: order.fogData
  };
  writeCoordinates([], 0, shared.coordinates);

  const entity = new Entity(path);
  const instances: MeshInstance[] = [];
  // Made on the first depthless draw, and only when those draw apart.
  let blended: Entity | null = null;
  const blendedInstances: MeshInstance[] = [];
  const turbulent: TurbulentSurface[] = [];
  const deforming: DeformingSurface[] = [];
  /** The draws that deform, and the bounds they are culled by. */
  const grown = new Map<MeshInstance, BoundingBox>();
  /** Every draw, each with its place in Q3's order. */
  const ordered: MeshInstance[] = [];
  let seen = false;
  let litMaterial: StandardMaterial | null = null;

  for (const [i, surface] of model.surfaces.entries()) {
    const given = stages && !isLit(i) ? await stages(shaderNames[i]) : null;
    const surfaceStages: readonly SurfaceStage[] =
      given && given.length > 0
        ? given
        : [
            {
              material: await createSurfaceMaterial(app, library, shaderNames[i], scope),
              fog: isLit(i) ? 'none' : flatFog(i)
            }
          ];
    const materials = surfaceStages.map((stage) => stage.material);
    if (isLit(i)) litMaterial ??= materials[0];
    const deforms = deformsOf(i);
    const mesh = isStamped(deforms) ? stampMesh(device, surface) : surfaceMesh(device, surface);
    const draws = materials.map((material) => new MeshInstance(mesh, material));
    // After the surface's stages, as `RB_FogPass` follows the batch's, for one in a map's scene.
    const pass = scene
      ? new MeshInstance(mesh, modelFogPassMaterial(device, deforms, materials[0].cull, scope))
      : null;
    const bound = bindSurface(
      device,
      model,
      surface,
      draws,
      surfaceStages,
      isLit(i),
      deforms,
      shared,
      pass
    );
    turbulent.push(...bound.turbulent);
    if (bound.deforming) deforming.push(bound.deforming);
    seen ||= bound.seen;
    for (const [stage, instance] of draws.entries()) {
      if (bound.bounds) grown.set(instance, bound.bounds);
      instance.drawOrder = ordered.length;
      ordered.push(instance);
      if (scene) {
        const shader = surfaceShader(scene, shaderNames[i]);
        const depthHack = scene.group === 'gun';
        tagDraw(instance, { shader, entity: order, step: modelStep(stage, i), depthHack });
      }
      // A draw that writes no depth moves onto the depthless child.
      if (apart && !materials[stage].depthWrite) {
        blended ??= new Entity(BLENDED_CHILD);
        blendedInstances.push(instance);
      } else {
        instances.push(instance);
      }
    }
    if (pass && scene) {
      if (bound.bounds) grown.set(pass, bound.bounds);
      pass.drawOrder = ordered.length;
      ordered.push(pass);
      const shader = surfaceShader(scene, shaderNames[i]);
      const depthHack = scene.group === 'gun';
      const step = modelStep(draws.length, i);
      tagDraw(pass, { shader, entity: order, step, depthHack, fogPass: true });
      instances.push(pass);
    }
  }

  entity.addComponent('render', { meshInstances: instances, ...(layers ? { layers } : {}) });
  if (scene) scene.draws.place(entity.render!, scene.group);
  if (blended) {
    blended.addComponent('render', {
      meshInstances: blendedInstances,
      ...(blendedLayers ? { layers: blendedLayers } : {})
    });
    if (scene) scene.draws.place(blended.render!, 'effects');
    entity.addChild(blended);
  }
  // A render component gives each draw its own bounds as it takes them, so these go on after.
  for (const [instance, bounds] of grown) cullBy(instance, bounds);
  sortAsModel(ordered, entity);

  const sprites = model.surfaces.some((_, index) => deformsOf(index).some(isSpriteDeform));
  return {
    entity,
    light: shared.light,
    litMaterial,
    order,
    placement: scene,
    view: sprites ? shared.view : null,
    viewer: seen ? shared.viewer : null,
    turbulent,
    deforming
  };
}

/** What every draw of a model reads, whichever surface it draws. */
interface SharedUniforms {
  light: Float32Array;
  /**
   * Where the viewer is, for a surface lit per pixel, the only thing the shared path draws by it
   * but its sprites; all zero, seen head on, until it is first faced.
   */
  viewer: Float32Array;
  /** The deforms of a surface that has none: all zero. */
  deforms: Float32Array;
  /** Where the camera looks, for the sprites; all zero, drawing none, until it is first faced. */
  view: Float32Array;
  /** Coordinates as the surface hands them over, for a stage with no `turb`. */
  coordinates: Float32Array;
  /** Its scene entity's `fogData`. */
  fog: Float32Array;
}

/**
 * The bounds each deforming draw is culled by, for its copies to take over: a clone keeps none of
 * its prototype's.
 */
const deformedBounds = new WeakMap<MeshInstance, BoundingBox>();

/** Cull a draw by `bounds`, after its render component has taken it, and remember them. */
function cullBy(instance: MeshInstance, bounds: BoundingBox): void {
  instance.setCustomAabb(bounds);
  deformedBounds.set(instance, bounds);
}

/**
 * Ready one surface's draws, one per stage in order: each stage's material given the model chunks,
 * and each draw bound to the surface's frames at frame 0 and to the model's uniforms. It draws no
 * `tcGen environment`. Each `tcMod turb` stage ripples by a uniform of its own, and a surface its
 * shader deforms moves by one of its own too, first written at 0 s.
 *
 * @param deforms - Its shader's deforms.
 * @param pass - Its fog pass, bound as its stages are, and hidden until a fog shows it; none
 *   outside a map's scene.
 * @returns The rippling stages and the deforming surface, for the caller to move on its clock,
 *   whether a draw reads where the viewer is, and, if the surface moves, the bounds its draws are
 *   to be culled by.
 */
function bindSurface(
  device: GraphicsDevice,
  model: Md3Model,
  surface: Md3Surface,
  draws: readonly MeshInstance[],
  stages: readonly SurfaceStage[],
  lit: boolean,
  deforms: readonly Deform[],
  shared: SharedUniforms,
  pass: MeshInstance | null
): {
  turbulent: TurbulentSurface[];
  deforming: DeformingSurface | null;
  seen: boolean;
  bounds: BoundingBox | null;
} {
  const frames = frameTexture(device, surface);
  const anim = new Float32Array(4);
  writeAnim(model.numFrames, surface.numVerts, { oldFrame: 0, frame: 0, backlerp: 0 }, anim);
  const deforming =
    deforms.length > 0 ? { deforms, uniform: new Float32Array(DEFORM_SLOTS * 8) } : null;
  if (deforming) writeDeforms(deforms, 0, deforming.uniform);
  const turbulent: TurbulentSurface[] = [];
  let seen = false;
  draws.forEach((instance, index) => {
    const wave = stages[index]?.turb;
    const fog = stages[index]?.fog;
    const stage = {
      lit,
      specular: false,
      environment: false,
      coordinates: wave !== undefined,
      deforms,
      fog: fog === 'none' ? undefined : fog
    };
    applyModelChunks(instance.material as StandardMaterial, stage);
    seen ||= readsViewer(stage);
    const coordinates = wave ? new Float32Array(COORDINATES_LENGTH) : shared.coordinates;
    bindModelUniforms(instance, frames, {
      ...shared,
      deforms: deforming?.uniform ?? shared.deforms,
      anim,
      coordinates
    });
    if (wave) {
      const ripple = { texMods: [{ type: 'turb', wave }] as const, uniform: coordinates };
      rippleSurface(ripple, 0);
      turbulent.push(ripple);
    }
  });
  if (pass) {
    pass.visible = false;
    bindModelUniforms(pass, frames, {
      ...shared,
      deforms: deforming?.uniform ?? shared.deforms,
      anim
    });
  }
  const reach = deformReach(deforms, surface);
  const bounds = reach > 0 ? grownBounds(surfaceMesh(device, surface).aabb, reach) : null;
  return { turbulent, deforming, seen, bounds };
}

/**
 * Another of a model in the world: its entity cloned (`Entity.clone`), drawing the same meshes.
 * A cloned draw holds none of its prototype's parameters, bounds or order, so each takes them over
 * by its place: the frames, the ripples and the deforms, which every copy shares, the bounds a
 * deforming draw is culled by, its place in Q3's order, sorted at the copy's own origin, and a
 * light, a view and a viewer of its own.
 */
export function copyMd3(prototype: Md3Renderable): Md3Renderable {
  const entity = prototype.entity.clone();
  const { fogBy } = prototype.order;
  const order = sceneEntity(fogBy && { ...fogBy });
  const own = new Map<unknown, Float32Array>([[prototype.order.fogData, order.fogData]]);
  for (const array of [prototype.light, prototype.view, prototype.viewer]) {
    if (array) own.set(array, new Float32Array(array.length));
  }
  const ordered: MeshInstance[] = [];
  const { placement } = prototype;
  const rebind = (from: GraphNode, to: GraphNode): void => {
    const render = (to as Entity).render;
    const draws = render?.meshInstances ?? [];
    (from as Entity).render?.meshInstances.forEach((instance, index) => {
      for (const [name, { data }] of instance.getParameters()) {
        draws[index].setParameter(name, own.get(data) ?? data);
      }
      const bounds = deformedBounds.get(instance);
      if (bounds) cullBy(draws[index], bounds);
      draws[index].drawOrder = instance.drawOrder;
      const tag = sceneDraw(instance);
      if (tag) tagDraw(draws[index], { ...tag, entity: order });
      // A fog pass hidden until a fog shows it.
      if (tag?.fogPass) draws[index].visible = false;
      ordered.push(draws[index]);
    });
    if (render && placement) {
      placement.draws.place(render, to.name === BLENDED_CHILD ? 'effects' : placement.group);
    }
    from.children.forEach((child, index) => rebind(child, to.children[index]));
  };
  rebind(prototype.entity, entity);
  sortAsModel(ordered, entity);
  return {
    entity,
    light: prototype.light && own.get(prototype.light)!,
    litMaterial: prototype.litMaterial,
    order,
    placement,
    view: prototype.view && own.get(prototype.view)!,
    viewer: prototype.viewer && own.get(prototype.viewer)!,
    turbulent: prototype.turbulent,
    deforming: prototype.deforming
  };
}

/**
 * Show one of a model in the world to `camera` this frame, once it is placed: its sprites turned
 * to where the camera looks, its `q3_view`, by which the chunks stamp and pivot every quad, and
 * its per-pixel light seen from where the camera is, its `q3_viewer`.
 */
export function faceMd3(
  model: Pick<Md3Renderable, 'entity' | 'view' | 'viewer'>,
  camera: GraphNode
): void {
  if (model.view) writeView(deformView(model.entity, camera), model.view);
  if (model.viewer) writeViewer(viewerInModel(model.entity, camera), model.viewer);
}

/**
 * Shade one of a model in the world for this frame (`RB_CalcDiffuseColor`), by its light in its
 * own frame: its `q3_light`, which the chunks shade by.
 */
export function shadeMd3(
  model: Pick<Md3Renderable, 'light' | 'litMaterial'>,
  light: EntityLight
): void {
  const { litMaterial } = model;
  const framebuffer = litMaterial !== null && drawsInFramebuffer(litMaterial);
  if (model.light) writeLight(light, model.light, shadeScale(framebuffer));
}
