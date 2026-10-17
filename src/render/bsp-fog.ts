import {
  ADDRESS_CLAMP_TO_EDGE,
  BLENDEQUATION_ADD,
  BLENDMODE_ONE,
  BLENDMODE_ONE_MINUS_SRC_ALPHA,
  BLENDMODE_SRC_ALPHA,
  BLENDMODE_ZERO,
  BlendState,
  Color,
  FILTER_LINEAR,
  FUNC_EQUAL,
  FUNC_LESSEQUAL,
  PIXELFORMAT_RGBA8,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  StandardMaterial,
  Texture,
  type GraphicsDevice
} from 'playcanvas';

import type { Deform } from '../formats/shader-script';
import {
  FOG_S,
  FOG_T,
  WORLD_FRAME,
  fogImage,
  fogVectors,
  modelFogNum,
  polyFogNum,
  spriteFogNum,
  type FogFrame,
  type FogVectors,
  type WorldFog
} from '../view/world-fog';
import type { FogAdjustment, FogPass } from '../view/world-shaders';
import type { EffectStage } from './effect-material';
import { FOG_COORDS, FOG_END, FOG_FACTOR, FOG_UNIFORM } from './fog-chunks';
import { MODEL_CHUNKS_VERSION, applyModelChunks } from './model-chunks';
import type { ResourceScope } from './texture-cache';

/**
 * A map's fogs as opengl1 draws them: a pass over each fogged batch after its stages
 * (`RB_FogPass`, `tr_shade.c:578-605`), and a blended stage's colours dimmed by the fog instead
 * (`ComputeColors`, `tr_shade.c:779-797`).
 *
 * Both find each vertex's place on the fog image in the vertex shader (`fog-chunks.ts`).
 */

/** A pass's chunks: its coordinates on the fog image in place of the vertices' own. */
export const FOG_PASS_CHUNKS = {
  glsl: new Map([
    ['litUserDeclarationVS', FOG_COORDS.glsl],
    ['uv0VS', '\nvec2 getUv0() {\n\treturn q3FogTexCoords(vertex_position.xyz);\n}\n']
  ]),
  wgsl: new Map([
    ['litUserDeclarationVS', FOG_COORDS.wgsl],
    ['uv0VS', '\nfn getUv0() -> vec2f {\n\treturn q3FogTexCoords(vertex_position.xyz);\n}\n']
  ])
};

/**
 * A dimmed stage's chunks: how much of its colour each vertex keeps, `1 − R_FogFactor(s, t)`,
 * carried to each pixel and multiplied into what it writes, its colour (`Q3_FOG_RGB`) or its alpha
 * (`Q3_FOG_ALPHA`). What it writes is the framebuffer's value, as Q3's colours are.
 */
export const FOG_ADJUSTMENT_CHUNKS = {
  glsl: new Map([
    ['litUserDeclarationVS', `${FOG_COORDS.glsl}${FOG_FACTOR.glsl}varying float q3FogKeep;\n`],
    [
      'litUserMainEndVS',
      '\n\tq3FogKeep = 1.0 - q3FogFactor(q3FogTexCoords(vertex_position.xyz));\n'
    ],
    ['litUserDeclarationPS', '\nvarying float q3FogKeep;\n'],
    ['litUserMainEndPS', FOG_END.glsl]
  ]),
  wgsl: new Map([
    ['litUserDeclarationVS', `${FOG_COORDS.wgsl}${FOG_FACTOR.wgsl}varying q3FogKeep: f32;\n`],
    [
      'litUserMainEndVS',
      '\n\toutput.q3FogKeep = 1.0 - q3FogFactor(q3FogTexCoords(vertex_position.xyz));\n'
    ],
    ['litUserDeclarationPS', '\nvarying q3FogKeep: f32;\n'],
    ['litUserMainEndPS', FOG_END.wgsl]
  ])
};

/** Set chunks on a material, in both languages. */
function applyChunks(
  material: StandardMaterial,
  chunks: { glsl: Map<string, string>; wgsl: Map<string, string> }
): void {
  const glsl = material.getShaderChunks(SHADERLANGUAGE_GLSL);
  const wgsl = material.getShaderChunks(SHADERLANGUAGE_WGSL);
  for (const [name, code] of chunks.glsl) glsl.set(name, code);
  for (const [name, code] of chunks.wgsl) wgsl.set(name, code);
  material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
}

/**
 * Dim a blended stage by its fog, as `RB_CalcModulateColorsByFog`, `RB_CalcModulateAlphasByFog` and
 * `RB_CalcModulateRGBAsByFog` dim its colours (`tr_shade_calc.c:731-785`). Q3 truncates each
 * product to a byte; here it is kept whole.
 *
 * Q3 dims the stage's colour, so the dimming comes before anything else the stage's ending does:
 * a merged stage's second texture is added after it, undimmed (`DrawMultitextured`). Its other
 * chunks follow what the stage already has there: the view's terms, and the colours it works out
 * over its vertex colours, which the dimming takes as Q3's takes them.
 */
export function applyFogAdjustment(
  material: StandardMaterial,
  adjustment: Exclude<FogAdjustment, 'none'>
): void {
  for (const [language, chunks] of [
    [SHADERLANGUAGE_GLSL, FOG_ADJUSTMENT_CHUNKS.glsl],
    [SHADERLANGUAGE_WGSL, FOG_ADJUSTMENT_CHUNKS.wgsl]
  ] as const) {
    const own = material.getShaderChunks(language);
    for (const [name, code] of chunks) {
      const kept = own.get(name) ?? '';
      own.set(name, name === 'litUserMainEndPS' ? code + kept : kept + code);
    }
  }
  material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
  material.setDefine('Q3_FOG_RGB', adjustment !== 'alpha');
  material.setDefine('Q3_FOG_ALPHA', adjustment !== 'rgb');
}

/**
 * How a fog's pass blends: `GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA`, keeping the framebuffer's alpha
 * as the world's stages do.
 */
const FOG_BLEND = new BlendState(
  true,
  BLENDEQUATION_ADD,
  BLENDMODE_SRC_ALPHA,
  BLENDMODE_ONE_MINUS_SRC_ALPHA,
  BLENDEQUATION_ADD,
  BLENDMODE_ZERO,
  BLENDMODE_ONE
);

/**
 * A fog's pass as `RB_FogPass` draws it: the fog image's alpha on the fog's coordinates, in the
 * fog's colour, over what the batch's stages drew. It writes no depth, and tests it as its
 * shader's pass says: equal over an opaque shader's surfaces, less or equal over a fog's face.
 *
 * @param image - `*fog`.
 * @param color - The fog's colour as `fogColor` packs it, a byte a channel and its alpha.
 * @param cull - Its shader's, as `q3CullMode` maps it.
 */
export function fogPassMaterial(
  image: Texture,
  color: readonly number[],
  pass: Exclude<FogPass, 'none'>,
  cull: number,
  scope: ResourceScope
): StandardMaterial {
  const material = scope.own(new StandardMaterial());
  material.useLighting = false;
  material.diffuse.set(0, 0, 0);
  material.emissive.set(color[0] / 255, color[1] / 255, color[2] / 255);
  material.opacity = color[3] / 255;
  material.opacityMap = image;
  material.opacityMapChannel = 'a';
  material.blendState = FOG_BLEND;
  material.depthWrite = false;
  material.depthFunc = pass === 'equal' ? FUNC_EQUAL : FUNC_LESSEQUAL;
  material.cull = cull;
  applyChunks(material, FOG_PASS_CHUNKS);
  material.update();
  return material;
}

/** `*fog` for the models' passes, made once a device, as each map's world makes its own. */
const modelFogImages = new WeakMap<GraphicsDevice, Texture>();

/** The fog image a model's pass reads, unmipped and clamped as the world's is. */
function modelFogImage(device: GraphicsDevice): Texture {
  let image = modelFogImages.get(device);
  if (!image) {
    image = new Texture(device, {
      name: '*fog',
      width: FOG_S,
      height: FOG_T,
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: FILTER_LINEAR,
      magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE
    });
    (image.lock() as Uint8Array).set(fogImage());
    image.unlock();
    modelFogImages.set(device, image);
  }
  return image;
}

/**
 * A model surface's fog pass, as `RB_FogPass` draws it over an opaque shader's batch: the world's
 * pass ({@link fogPassMaterial}) over the surface's own morph and deforms, through the model
 * chunks, its coordinates on the fog image worked out at each vertex as the stages place it. Its
 * colour is its fog's, which each draw gives it (`scene-draws.ts`), and its depth is tested equal.
 *
 * @param deforms - Its shader's, which move its vertices as they move its stages'.
 * @param cull - Its shader's, as `q3CullMode` maps it.
 */
export function modelFogPassMaterial(
  device: GraphicsDevice,
  deforms: readonly Deform[],
  cull: number,
  scope?: ResourceScope
): StandardMaterial {
  const material = new StandardMaterial();
  scope?.own(material);
  material.useLighting = false;
  material.diffuse.set(0, 0, 0);
  material.opacityMap = modelFogImage(device);
  material.opacityMapChannel = 'a';
  material.blendState = FOG_BLEND;
  material.depthWrite = false;
  material.depthFunc = FUNC_EQUAL;
  material.cull = cull;
  material.setParameter(FOG_UNIFORM, NO_FOG_DATA as Float32Array);
  const stage = { lit: false, specular: false, environment: false, coordinates: false };
  applyModelChunks(material, { ...stage, deforms, fog: 'pass' });
  return material;
}

/** The effect materials already dimmed by their fog. */
const dimmed = new WeakSet<StandardMaterial>();

/**
 * Dim an effect's blended stages by the fog it is drawn in, as `adjustColorsForFog` says for each,
 * where the stages draw their vertices as given, in the world's frame or their entity's: a
 * sprite's, a beam's or a model's built still. Each reads its draw's `q3_fog`, nothing along the
 * view until a draw gives it its own, which keeps its colour whole.
 */
export function dimEffectStages(stages: readonly Pick<EffectStage, 'material' | 'fog'>[]): void {
  for (const { material, fog } of stages) {
    if (!fog || fog === 'none' || dimmed.has(material)) continue;
    dimmed.add(material);
    applyFogAdjustment(material, fog);
    material.setParameter(FOG_UNIFORM, NO_FOG_DATA as Float32Array);
    material.update();
  }
}

/** Write a fog's vectors into the array its draws read: s's, t's, and the eye's t. */
function writeFogData({ distance, depth, eyeT }: FogVectors, data: Float32Array): void {
  for (let k = 0; k < 4; k++) {
    data[k] = distance[k];
    data[4 + k] = depth[k];
  }
  data[8] = eyeT;
}

/**
 * What a draw in no fog reads: no distance along the view, which fogs nothing, so a stage dimmed by
 * its fog keeps its colour whole.
 */
export const NO_FOG_DATA: Readonly<Float32Array> = new Float32Array(12);

/** A fog's numbers, by its place among the map's plus one: 0 for none. */
type FogNumber = number;

/**
 * A map's scene's fogs as its models and effects take them (`R_ComputeFogNum`, `R_SpriteFogNum`,
 * `RE_AddPolyToScene`): which fog each is drawn in, and the vectors its draws read, in the world's
 * frame or its own entity's, for the view the world's fogs were last drawn from. With no fogs, as
 * with no map's world (`RDF_NOWORLDMODEL`), nothing is in one.
 */
export class SceneFogs {
  readonly fogs: readonly WorldFog[];
  /** Each fog's vectors in the world's frame, written at each view. */
  private readonly world: Float32Array[];
  /** Each fog's colour as its pass draws it, as a material's emissive uniform holds one. */
  private readonly colors: Float32Array[];
  /** The view's eye and forward axis, in the world's frame. */
  private readonly eye: [number, number, number] = [0, 0, 0];
  private readonly forward: [number, number, number] = [1, 0, 0];
  private readonly vectors: FogVectors = { distance: [0, 0, 0, 0], depth: [0, 0, 0, 0], eyeT: 0 };

  /**
   * @param colors - Each fog's colour as `fogColor` packs it, a byte a channel.
   */
  constructor(fogs: readonly WorldFog[], colors: readonly (readonly number[])[]) {
    this.fogs = fogs;
    this.world = fogs.map(() => new Float32Array(12));
    this.colors = colors.map(([r, g, b]) => {
      // Linear, as the engine gives a material's colour to its shader.
      const linear = new Color(r / 255, g / 255, b / 255).linear();
      return Float32Array.of(linear.r, linear.g, linear.b);
    });
  }

  /**
   * The view the fogs are drawn from: each fog's vectors in the world's frame written again, and
   * the eye and forward axis kept for the entities drawn after.
   */
  view(eye: readonly [number, number, number], forward: readonly [number, number, number]): void {
    for (let k = 0; k < 3; k++) {
      this.eye[k] = eye[k];
      this.forward[k] = forward[k];
    }
    for (let i = 0; i < this.fogs.length; i++) {
      const vectors = fogVectors(this.fogs[i], eye, forward, WORLD_FRAME, this.vectors);
      writeFogData(vectors, this.world[i]);
    }
  }

  /** `R_ComputeFogNum`'s fog for an MD3 at `origin`, drawn at a frame of this `localOrigin`. */
  modelFog(
    origin: readonly [number, number, number],
    localOrigin: readonly [number, number, number],
    radius: number
  ): FogNumber {
    return this.fogs.length === 0 ? 0 : modelFogNum(this.fogs, origin, localOrigin, radius);
  }

  /** `R_SpriteFogNum`'s fog for a sprite, a beam or the rail's core or rings. */
  spriteFog(origin: readonly [number, number, number], radius: number): FogNumber {
    return this.fogs.length === 0 ? 0 : spriteFogNum(this.fogs, origin, radius);
  }

  /** `RE_AddPolyToScene`'s fog for a poly of these points. */
  polyFog(points: readonly (readonly [number, number, number])[]): FogNumber {
    return polyFogNum(this.fogs, points);
  }

  /** What a draw placed in the world's frame reads for a fog, or for none. */
  worldData(fog: FogNumber): Readonly<Float32Array> {
    return fog === 0 ? NO_FOG_DATA : this.world[fog - 1];
  }

  /**
   * Write what an entity's draws read for a fog into their array, in the frame their vertices are
   * placed in, for the view last given; nothing along the view for none.
   *
   * @param model - A model's, whose eye is measured in its frame as `R_RotateForEntity` measures
   *   it; any other entity's draws are in the world's frame to Q3, and keep the world's eye.
   */
  writeEntityData(fog: FogNumber, frame: FogFrame, data: Float32Array, model: boolean): void {
    if (fog === 0) {
      data.fill(0);
      return;
    }
    writeFogData(fogVectors(this.fogs[fog - 1], this.eye, this.forward, frame, this.vectors), data);
    if (!model) data[8] = this.world[fog - 1][8];
  }

  /** A fog's colour, as its pass's emissive uniform takes it. */
  passColor(fog: FogNumber): Readonly<Float32Array> {
    return this.colors[fog - 1];
  }
}

/** A scene with no map's world: no fogs. */
export const NO_SCENE_FOGS = new SceneFogs([], []);

/** One fog in one frame, and the array its draws read. */
interface FogView {
  fog: WorldFog;
  frame: FogFrame;
  data: Float32Array;
}

/**
 * The arrays the fogged draws read: one for each fog in each frame its draws are placed in, the
 * world's or a brush model's, written again at each view.
 */
export class FogUniforms {
  private readonly fogs: readonly WorldFog[];
  private readonly views = new Map<string, FogView>();
  /** The same in a list, which a view goes through by index, making no iterator. */
  private readonly list: FogView[] = [];
  /** Where a view's vectors for each are worked out. */
  private readonly vectors: FogVectors = {
    distance: [0, 0, 0, 0],
    depth: [0, 0, 0, 0],
    eyeT: 0
  };

  constructor(fogs: readonly WorldFog[]) {
    this.fogs = fogs;
  }

  /**
   * The array for a fog's draws in a frame, made at the first asking.
   *
   * @param fog - The fog, by its place among the map's.
   * @param entity - Which frame, by a number the caller keeps for it.
   */
  data(fog: number, entity: number, frame: FogFrame): Float32Array {
    const key = `${fog} ${entity}`;
    let view = this.views.get(key);
    if (!view) {
      view = { fog: this.fogs[fog], frame, data: new Float32Array(12) };
      this.views.set(key, view);
      this.list.push(view);
    }
    return view.data;
  }

  /**
   * Write each array for a view.
   *
   * @param eye - The view's origin, in the world's frame.
   * @param forward - The view's forward axis, in the world's frame.
   */
  view(eye: readonly [number, number, number], forward: readonly [number, number, number]): void {
    for (let i = 0; i < this.list.length; i++) {
      const { fog, frame, data } = this.list[i];
      writeFogData(fogVectors(fog, eye, forward, frame, this.vectors), data);
    }
  }
}
