import {
  BLENDEQUATION_ADD,
  BLENDMODE_ONE,
  BLENDMODE_ZERO,
  BlendState,
  Color,
  FUNC_EQUAL,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  type AppBase,
  type StandardMaterial,
  type Texture
} from 'playcanvas';

import type { ShaderStage } from '../formats/shader-script';
import { framebufferAlpha, framebufferColor, identityLight, type RendererStyle } from '../view/overbright';
import {
  COORDINATES_LENGTH,
  animMapFrame,
  coordinatesMove,
  firstDrop,
  shaderTime,
  waveAlphaByte,
  waveColorByte,
  writeCoordinates
} from '../view/stage-motion';
import { DEFAULT_SHADER, isLightmapStage, type WorldShader } from '../view/world-shaders';
import { applyFogAdjustment } from './bsp-fog';
import { createStage, type ImageSource } from './effect-material';
import { q3CullMode } from './md3-mesh';
import { MODEL_CHUNKS_VERSION } from './model-chunks';
import { COORDINATE_HELPERS, coordinatesGlsl, coordinatesWgsl } from './stage-coordinates';
import type { ResourceScope } from './texture-cache';
import { VIEW_TERM_DECLARATIONS } from './view-term-chunks';
import { WHITE_IMAGE_PATH, whiteImageTga } from './white-image';

/**
 * A map's shaders' stages as the world draws them, and their moving parts played on the preview's
 * clock (`view/stage-motion.ts`).
 *
 * A stage whose texture has a `tcMod` takes its coordinates from uniforms of the port's own, the
 * engine's map transform left alone: each texture's pieces, written in place each frame where they
 * move, so a frame never updates the material. Its first texture reads uv set 0 and a merged
 * stage's second uv set 1, each from the coordinates its `tcGen` names. An `animMap`'s frame is
 * bound only when it flips, and a wave's colour or alpha set only when its byte changes. A shader
 * opengl1 drops the map for at its draw draws nothing, and its first draw drops the map.
 *
 * A stage that reads the view, `tcGen environment` or a highlight's or a portal's alpha, works it
 * out in its vertex code from the eye in its draw's frame (`render/view-term-chunks.ts`).
 */

/** How an opaque stage blends here: `GL_ONE GL_ZERO`, keeping the framebuffer's alpha. */
export const OPAQUE_BLEND = new BlendState(
  true,
  BLENDEQUATION_ADD,
  BLENDMODE_ONE,
  BLENDMODE_ZERO,
  BLENDEQUATION_ADD,
  BLENDMODE_ZERO,
  BLENDMODE_ONE
);

/** The uniforms of a stage's textures' coordinates, as their draws are given them. */
const COORDINATES_UNIFORMS = ['q3_tc0[0]', 'q3_tc1[0]'] as const;

/** The uniforms of each texture's `tcGen vector`, its two vectors a vec4 each. */
const VECTOR_UNIFORMS = ['q3_tcv0[0]', 'q3_tcv1[0]'] as const;

/** The uniform of an `alphaGen portal` stage's `portalRange`, in its x. */
const PORTAL_UNIFORM = 'q3_portal';

/** A texture's `tcGen` that reads the vertex's place rather than an attribute. */
const placed = (texture: Pick<ShaderStage, 'tcGen'> | undefined) =>
  texture?.tcGen === 'environment' || texture?.tcGen === 'vector';

/** A stage's `alphaGen` that reads the view. */
const viewedAlpha = (stage: ShaderStage) =>
  stage.alphaGen === 'lightingSpecular' || stage.alphaGen === 'portal';

/** Whether a stage reads the eye: an environment's coordinates or the view's alpha. */
const readsEye = (stage: ShaderStage) =>
  stage.tcGen === 'environment' || stage.multitexture?.tcGen === 'environment' || viewedAlpha(stage);

/** Whether a stage is lit by its entity's light, each vertex by its normal. */
const lit = (stage: Pick<ShaderStage, 'rgbGen'>) => stage.rgbGen === 'lightingDiffuse';

/**
 * The sky's points as Q3 places them for a cloud stage's `turb` (`FillCloudySkySide`,
 * `tr_sky.c:502`): the eye, and the far plane over the box the sky's buffer is made at.
 */
export const SKY_POINTS_UNIFORM = 'q3_sky';

/**
 * A texture's coordinates as its `tcGen` makes them (`tr_shade.c:840-870`), from the vertex's place
 * where the batch holds it: the environment's, `tcGen vector`'s from its vectors, or an attribute's.
 */
function sourceGlsl(k: 0 | 1): string {
  return `
	#if defined(Q3_TC${k}_ENVIRONMENT)
	vec2 st = q3Environment(q3Position(), q3Normal());
	#elif defined(Q3_TC${k}_VECTOR)
	vec2 st = vec2(dot(q3Position(), q3_tcv${k}[0].xyz), dot(q3Position(), q3_tcv${k}[1].xyz));
	#elif defined(Q3_TC${k}_LIGHTMAP)
	vec2 st = vertex_texCoord1;
	#else
	vec2 st = vertex_texCoord0;
	#endif`;
}
function sourceWgsl(k: 0 | 1): string {
  return `
	#if defined(Q3_TC${k}_ENVIRONMENT)
	var st = q3Environment(q3Position(), q3Normal());
	#elif defined(Q3_TC${k}_VECTOR)
	var st = vec2f(dot(q3Position(), uniform.q3_tcv${k}[0].xyz), dot(q3Position(), uniform.q3_tcv${k}[1].xyz));
	#elif defined(Q3_TC${k}_LIGHTMAP)
	var st = vertex_texCoord1;
	#else
	var st = vertex_texCoord0;
	#endif`;
}

/**
 * Where each texture's coordinates come from, and each moved by its pieces. `getUv0` is defined
 * with `getUv1`, after both coordinate attributes are declared, so either texture can read either.
 * `q3Position` is the vertex where Q3's batch holds it: a cloud's among the sky's points.
 */
const STAGE_UV_GLSL = `
${COORDINATE_HELPERS.glsl}
#ifdef Q3_TC0
${coordinatesGlsl('q3_tc0', 'q3Coordinates0')}
#endif
#ifdef Q3_TC1
${coordinatesGlsl('q3_tc1', 'q3Coordinates1')}
#endif
#ifdef Q3_TC0_VECTOR
uniform vec4 q3_tcv0[2];
#endif
#ifdef Q3_TC1_VECTOR
uniform vec4 q3_tcv1[2];
#endif
#ifdef Q3_SKY_POINTS
uniform vec4 q3_sky;
#endif
vec3 q3Position() {
	#ifdef Q3_SKY_POINTS
	return vertex_position.xyz * q3_sky.w + q3_sky.xyz;
	#else
	return vertex_position.xyz;
	#endif
}
#ifdef UV0
vec2 getUv0() {${sourceGlsl(0)}
	#ifdef Q3_TC0
	st = q3Coordinates0(st, q3Position());
	#endif
	return st;
}
#endif
vec2 getUv1() {${sourceGlsl(1)}
	#ifdef Q3_TC1
	st = q3Coordinates1(st, q3Position());
	#endif
	return st;
}
`;
const STAGE_UV_WGSL = `
${COORDINATE_HELPERS.wgsl}
#ifdef Q3_TC0
${coordinatesWgsl('q3_tc0', 'q3Coordinates0')}
#endif
#ifdef Q3_TC1
${coordinatesWgsl('q3_tc1', 'q3Coordinates1')}
#endif
#ifdef Q3_TC0_VECTOR
uniform q3_tcv0: array<vec4f, 2>;
#endif
#ifdef Q3_TC1_VECTOR
uniform q3_tcv1: array<vec4f, 2>;
#endif
#ifdef Q3_SKY_POINTS
uniform q3_sky: vec4f;
#endif
fn q3Position() -> vec3f {
	#ifdef Q3_SKY_POINTS
	return vertex_position.xyz * uniform.q3_sky.w + uniform.q3_sky.xyz;
	#else
	return vertex_position.xyz;
	#endif
}
#ifdef UV0
fn getUv0() -> vec2f {${sourceWgsl(0)}
	#ifdef Q3_TC0
	st = q3Coordinates0(st, q3Position());
	#endif
	return st;
}
#endif
fn getUv1() -> vec2f {${sourceWgsl(1)}
	#ifdef Q3_TC1
	st = q3Coordinates1(st, q3Position());
	#endif
	return st;
}
`;

/** A moving stage's chunks: its coordinates, in place of the engine's `uv0VS` and `uv1VS`. */
export const STAGE_COORDINATE_CHUNKS = {
  glsl: new Map([
    ['uv0VS', '\n// getUv0 is with getUv1, in uv1VS.\n'],
    ['uv1VS', STAGE_UV_GLSL]
  ]),
  wgsl: new Map([
    ['uv0VS', '\n// getUv0 is with getUv1, in uv1VS.\n'],
    ['uv1VS', STAGE_UV_WGSL]
  ])
};

/**
 * The colours a stage works out in its own vertex code, over the vertex colours: `rgbGen
 * lightingDiffuse`, its entity's light; `rgbGen oneMinusVertex` and `alphaGen oneMinusVertex`
 * (`tr_shade.c:655-674, 740-745`), the vertex colour's inverse; and the view's alphas,
 * `lightingSpecular` and `portal` (`render/view-term-chunks.ts`).
 */
export const VERTEX_COLOR_CHUNKS = {
  glsl: `
	#ifdef VERTEX_COLOR
	#ifdef Q3_LIGHTING_DIFFUSE
	vVertexColor = q3LightingDiffuse(q3Normal());
	#endif
	#ifdef Q3_ONE_MINUS_VERTEX_RGB
	vVertexColor.rgb = 1.0 - vertex_color.rgb;
	#endif
	#ifdef Q3_ONE_MINUS_VERTEX_ALPHA
	vVertexColor.a = 1.0 - vertex_color.a;
	#endif
	#ifdef Q3_SPECULAR_ALPHA
	vVertexColor.a = q3SpecularAlpha(q3Position(), q3Normal());
	#endif
	#ifdef Q3_PORTAL_ALPHA
	vVertexColor.a = q3PortalAlpha(q3Position());
	#endif
	#endif
`,
  wgsl: `
	#ifdef VERTEX_COLOR
	#ifdef Q3_LIGHTING_DIFFUSE
	output.vVertexColor = q3LightingDiffuse(q3Normal());
	#endif
	#ifdef Q3_ONE_MINUS_VERTEX_RGB
	output.vVertexColor = vec4f(1.0 - vertex_color.rgb, output.vVertexColor.a);
	#endif
	#ifdef Q3_ONE_MINUS_VERTEX_ALPHA
	output.vVertexColor.a = 1.0 - vertex_color.a;
	#endif
	#ifdef Q3_SPECULAR_ALPHA
	output.vVertexColor.a = q3SpecularAlpha(q3Position(), q3Normal());
	#endif
	#ifdef Q3_PORTAL_ALPHA
	output.vVertexColor.a = q3PortalAlpha(q3Position());
	#endif
	#endif
`
};

/**
 * The emission of a stage that reads the vertex colours, the engine's `emissivePS` with the colour
 * decoded here, once interpolated. opengl1 interpolates the colours' bytes as they are; the
 * engine's `vertexColorGamma` decodes each vertex's before, which draws the run from a dark vertex
 * to a light one brighter.
 */
export const VERTEX_COLOR_EMISSION = {
  glsl: `
uniform vec3 material_emissive;
uniform float material_emissiveIntensity;
void getEmission() {
	dEmission = material_emissive * material_emissiveIntensity;
	#ifdef STD_EMISSIVE_TEXTURE
	dEmission *= {STD_EMISSIVE_TEXTURE_DECODE}(texture2DBias({STD_EMISSIVE_TEXTURE_NAME}, {STD_EMISSIVE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).{STD_EMISSIVE_TEXTURE_CHANNEL};
	#endif
	#ifdef STD_EMISSIVE_VERTEX
	dEmission *= pow(saturate(vVertexColor.{STD_EMISSIVE_VERTEX_CHANNEL}), vec3(2.2));
	#endif
}
`,
  wgsl: `
uniform material_emissive: vec3f;
uniform material_emissiveIntensity: f32;
fn getEmission() {
	dEmission = uniform.material_emissive * uniform.material_emissiveIntensity;
	#ifdef STD_EMISSIVE_TEXTURE
	dEmission *= {STD_EMISSIVE_TEXTURE_DECODE}(textureSampleBias({STD_EMISSIVE_TEXTURE_NAME}, {STD_EMISSIVE_TEXTURE_NAME}Sampler, {STD_EMISSIVE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).{STD_EMISSIVE_TEXTURE_CHANNEL};
	#endif
	#ifdef STD_EMISSIVE_VERTEX
	dEmission = dEmission * pow(saturate(vVertexColor.{STD_EMISSIVE_VERTEX_CHANNEL}), vec3f(2.2));
	#endif
}
`
};

/**
 * A stage as the world draws it: its material, the arrays each of its draws is given, and whether
 * they read the eye in their frame (`EYE_UNIFORM`).
 */
export interface WorldStage {
  material: StandardMaterial;
  parameters: readonly (readonly [string, Float32Array])[];
  eye: boolean;
  /** It reads its entity's light (`LIGHT_UNIFORM`), which each of its draws is given. */
  lit: boolean;
}

/** `r_offsetFactor` and `r_offsetUnits`: how far a `polygonOffset` shader is pulled. */
export interface PolygonOffset {
  factor: number;
  units: number;
}

/** What a map's stages are made with. */
export interface StageSources {
  images: ImageSource;
  /** The lightmap pages, by index. */
  lightmaps: readonly Texture[];
  style: RendererStyle;
  scope: ResourceScope;
  /** `r_picmip`. */
  picmip: number;
  offset: PolygonOffset;
}

/** A stage's moving parts, and what the frame last gave it. */
interface MovingStage {
  material: StandardMaterial;
  stage: ShaderStage;
  /** Each texture's coordinates, where they move. */
  coordinates: Float32Array | null;
  secondCoordinates: Float32Array | null;
  /** Each texture's flipbook, where it flips. */
  frames: readonly Texture[];
  secondFrames: readonly Texture[];
  frame: number;
  secondFrame: number;
  /** The bytes its wave last gave its colour and its alpha. */
  color: number;
  alpha: number;
}

/** A shader's moving stages, its `clampTime`, and the drop its first draw makes. */
interface MovingShader {
  shader: WorldShader;
  clampTime: number;
  drop?: string;
  stages: MovingStage[];
}

/** Scratch for a wave's colour. */
const waveColor = new Color();

/**
 * `forceUv1`, documented on `StandardMaterial` and installed at runtime by the engine's
 * `_defineFlag`, but absent from the shipped `.d.ts`.
 */
type ForceUv1Material = StandardMaterial & { forceUv1: boolean };

/** A stage that Q3 changes as it draws: it moves, it flips, or a wave sets its colour or alpha. */
function moves(moving: MovingStage): boolean {
  const { stage } = moving;
  return (
    moving.coordinates !== null ||
    moving.secondCoordinates !== null ||
    moving.frames.length > 1 ||
    moving.secondFrames.length > 1 ||
    stage.rgbGen === 'wave' ||
    stage.alphaGen === 'wave'
  );
}

/** A stage's flipbook at `frame`, its texture bound where it is not already. */
function bindFrame(moving: MovingStage, frame: number): void {
  if (frame === moving.frame) return;
  moving.frame = frame;
  const { material } = moving;
  material.emissiveMap = moving.frames[frame];
  if (material.opacityMap) material.opacityMap = moving.frames[frame];
}

/** A merged stage's second flipbook at `frame`, bound where it is not already. */
function bindSecondFrame(moving: MovingStage, frame: number): void {
  if (frame === moving.secondFrame) return;
  moving.secondFrame = frame;
  moving.material.diffuseMap = moving.secondFrames[frame];
}

/** A map's stages, made shader by shader, and played on its clock. */
export class WorldStages {
  private readonly app: AppBase;
  private readonly sources: StageSources;
  /** The clock's time the stages are made at, in milliseconds. */
  private readonly time: number;
  private readonly light: number;
  /**
   * Each shader's moving parts, by the shader itself: a registry started again gives cgame's
   * shaders their places afresh, so an index may come to name another.
   */
  private readonly shaders = new Map<WorldShader, MovingShader>();
  /** {@link shaders}' moving and dropping ones, in the order their shaders draw. */
  private played: MovingShader[] | null = null;
  /** Every material a `polygonOffset` pulls towards the viewer. */
  private readonly pulled: StandardMaterial[] = [];
  private factor: number;
  private units: number;
  /** White, for a stage with no image of its own whose second texture reads uv set 0. */
  private white: Promise<Texture> | null = null;

  constructor(app: AppBase, sources: StageSources, time: number) {
    this.app = app;
    this.sources = sources;
    this.time = time;
    this.light = identityLight(sources.style);
    this.factor = sources.offset.factor;
    this.units = sources.offset.units;
  }

  /** A shader's moving parts, made at its first asking with the drop its draws make. */
  private movingOf(shader: WorldShader): MovingShader {
    let moving = this.shaders.get(shader);
    if (!moving) {
      const drop = firstDrop(shader.name, shader.script?.deforms ?? [], shader.stages);
      moving = { shader, clampTime: shader.script?.clampTime ?? 0, stages: [] };
      if (drop !== undefined) moving.drop = drop;
      this.shaders.set(shader, moving);
      this.played = null;
    }
    return moving;
  }

  /** Whether a shader's batches draw nothing, its first draw dropping the map. */
  drops(shader: WorldShader): boolean {
    return this.movingOf(shader).drop !== undefined;
  }

  /**
   * A shader's stages, each built by the shared builder, in the colour and alpha opengl1 writes
   * into its framebuffer at the clock's time, its vertex colours or their inverses taken where its
   * `rgbGen` or `alphaGen` reads them, and blended. A `$lightmap` texture samples the shader's page,
   * and draws white below a page, as `$whiteimage` does (`tr_shader.c:622-635`). Each texture
   * reads the coordinates its `tcGen` names, moved by its `tcMod`s. None for a shader whose draws
   * drop the map.
   *
   * @param fogged - Made for a run in a fog: a stage with a fog adjustment is dimmed by its fog.
   * @param sky - Made for a sky's clouds, whose points a `turb` reads as the sky's.
   */
  async build(shader: WorldShader, fogged = false, sky = false): Promise<WorldStage[]> {
    const moving = this.movingOf(shader);
    if (moving.drop !== undefined) return [];
    const { images, lightmaps, style, scope, picmip } = this.sources;
    const script = shader.script;
    const time = shaderTime(this.time, moving.clampTime);
    // The default image is made without `IMGFLAG_PICMIP` (`tr_image.c:1218`).
    const halvings = script?.noPicMip || shader.name === DEFAULT_SHADER ? 0 : picmip;
    const cull = q3CullMode(script?.cull);
    const page = shader.lightmapIndex >= 0 ? lightmaps[shader.lightmapIndex] : undefined;
    const stages: WorldStage[] = [];
    for (const [i, stage] of shader.stages.entries()) {
      const built = await createStage(this.app, images, stage, cull, !script?.noMipMaps, scope, halvings);
      const { material } = built;
      const second = stage.multitexture;
      if (isLightmapStage(stage) && page) material.emissiveMap = page;
      if (second && isLightmapStage(second) && page) material.diffuseMap = page;
      const parameters: (readonly [string, Float32Array])[] = [];
      const record: MovingStage = {
        material,
        stage,
        coordinates: null,
        secondCoordinates: null,
        frames: built.frames,
        secondFrames: built.multitexture?.frames ?? [],
        frame: -1,
        secondFrame: -1,
        color: -1,
        alpha: -1
      };
      const moved = stage.texMods.length > 0 || (second !== undefined && second.texMods.length > 0);
      if (moved || readsEye(stage) || lit(stage) || placed(stage) || placed(second)) {
        // Uv set 0 is declared only with a map on it: white, where the stage has no image and its
        // second texture reads that set's attribute.
        if (!material.emissiveMap && second && second.tcGen !== 'lightmap' && !placed(second)) {
          material.emissiveMap = await this.whiteImage();
        }
        this.coordinate(material, stage, sky);
        for (const [k, texture] of [stage, second].entries()) {
          if (texture?.tcGenVectors && texture.tcGen === 'vector') {
            const [s, t] = texture.tcGenVectors;
            parameters.push([VECTOR_UNIFORMS[k], Float32Array.of(...s, 0, ...t, 0)]);
          }
          if (!texture || texture.texMods.length === 0) continue;
          const coordinates = new Float32Array(COORDINATES_LENGTH);
          writeCoordinates(texture.texMods, time, coordinates, shader.name);
          parameters.push([COORDINATES_UNIFORMS[k], coordinates]);
          if (!coordinatesMove(texture.texMods)) continue;
          if (k === 0) record.coordinates = coordinates;
          else record.secondCoordinates = coordinates;
        }
      } else {
        // Each texture on the coordinates its `tcGen` names (`tr_shade.c:844-855`).
        if (stage.tcGen === 'lightmap') {
          material.emissiveMapUv = 1;
          if (material.opacityMap) material.opacityMapUv = 1;
        }
        if (second?.tcGen === 'lightmap') material.diffuseMapUv = 1;
      }
      // A wave's colour is the frame's to set.
      if (stage.rgbGen !== 'wave') {
        const [red, green, blue] = framebufferColor(stage, time, style);
        material.emissive.set(red, green, blue);
      }
      this.vertexColors(material, stage);
      if (stage.alphaGen === 'portal') {
        parameters.push([PORTAL_UNIFORM, Float32Array.of(script?.portalRange ?? 0, 0, 0, 0)]);
      }
      if (stage.depthTest === false) material.depthTest = false;
      if (stage.depthFunc === 'equal') material.depthFunc = FUNC_EQUAL;
      if (script?.polygonOffset) this.pull(material);
      if (!material.transparent) material.blendState = OPAQUE_BLEND;
      const adjustment = shader.fogAdjustments[i];
      if (fogged && adjustment !== 'none') applyFogAdjustment(material, adjustment);
      // Its frames, colour and alpha at the clock's time.
      this.playStage(record, time, shader.name);
      material.update();
      if (moves(record)) moving.stages.push(record);
      stages.push({ material, parameters, eye: readsEye(stage), lit: lit(stage) });
    }
    return stages;
  }

  /**
   * A stage's textures given their coordinates in the vertex shader, the first texture on uv set 0,
   * the second on uv set 1: each made as its `tcGen` makes them and moved by its pieces. A stage
   * that reads the view is given the view's terms.
   */
  private coordinate(material: StandardMaterial, stage: ShaderStage, sky: boolean): void {
    const second = stage.multitexture;
    const viewed = readsEye(stage) || lit(stage) || placed(stage) || placed(second);
    for (const [language, chunks, declarations] of [
      [SHADERLANGUAGE_GLSL, STAGE_COORDINATE_CHUNKS.glsl, VIEW_TERM_DECLARATIONS.glsl],
      [SHADERLANGUAGE_WGSL, STAGE_COORDINATE_CHUNKS.wgsl, VIEW_TERM_DECLARATIONS.wgsl]
    ] as const) {
      const own = material.getShaderChunks(language);
      for (const [name, code] of chunks) own.set(name, code);
      if (viewed) own.set('litUserDeclarationVS', sky ? declarations.sky : declarations.world);
    }
    material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
    (material as ForceUv1Material).forceUv1 = true;
    material.emissiveMapUv = 0;
    material.opacityMapUv = 0;
    material.diffuseMapUv = 1;
    for (const [k, texture] of [stage, second].entries()) {
      material.setDefine(`Q3_TC${k}`, texture !== undefined && texture.texMods.length > 0);
      material.setDefine(`Q3_TC${k}_LIGHTMAP`, texture?.tcGen === 'lightmap');
      material.setDefine(`Q3_TC${k}_ENVIRONMENT`, texture?.tcGen === 'environment');
      material.setDefine(`Q3_TC${k}_VECTOR`, texture?.tcGen === 'vector');
    }
    material.setDefine('Q3_SKY_POINTS', sky);
  }

  /** A white image, as `$whiteimage` is, made once and held with the world's textures. */
  private whiteImage(): Promise<Texture> {
    this.white ??= this.sources.scope.texture(WHITE_IMAGE_PATH, whiteImageTga(), false, false);
    return this.white;
  }

  /**
   * The vertex colours a stage's `rgbGen` and `alphaGen` read, their inverses or the view's alphas
   * written over them, and its alpha where it stands still.
   */
  private vertexColors(material: StandardMaterial, stage: ShaderStage): void {
    const { rgbGen, alphaGen } = stage;
    const colored = rgbGen === 'vertex' || rgbGen === 'exactVertex' || rgbGen === 'oneMinusVertex';
    if (colored || lit(stage)) {
      material.emissiveVertexColor = true;
      material.getShaderChunks(SHADERLANGUAGE_GLSL).set('emissivePS', VERTEX_COLOR_EMISSION.glsl);
      material.getShaderChunks(SHADERLANGUAGE_WGSL).set('emissivePS', VERTEX_COLOR_EMISSION.wgsl);
      material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
    }
    const alpha = framebufferAlpha(stage, this.sources.style);
    if (alpha === 'vertex' || alphaGen === 'oneMinusVertex' || viewedAlpha(stage)) {
      material.opacityVertexColor = true;
      material.opacityVertexColorChannel = 'a';
    } else if (alpha !== undefined) {
      material.opacity = alpha;
    }
    const written =
      rgbGen === 'oneMinusVertex' ||
      alphaGen === 'oneMinusVertex' ||
      viewedAlpha(stage) ||
      lit(stage);
    if (!written) return;
    material.getShaderChunks(SHADERLANGUAGE_GLSL).set('litUserMainEndVS', VERTEX_COLOR_CHUNKS.glsl);
    material.getShaderChunks(SHADERLANGUAGE_WGSL).set('litUserMainEndVS', VERTEX_COLOR_CHUNKS.wgsl);
    material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
    material.setDefine('Q3_LIGHTING_DIFFUSE', lit(stage));
    material.setDefine('Q3_ONE_MINUS_VERTEX_RGB', rgbGen === 'oneMinusVertex');
    material.setDefine('Q3_ONE_MINUS_VERTEX_ALPHA', alphaGen === 'oneMinusVertex');
    material.setDefine('Q3_SPECULAR_ALPHA', alphaGen === 'lightingSpecular');
    material.setDefine('Q3_PORTAL_ALPHA', alphaGen === 'portal');
  }

  /**
   * A material drawn pulled towards the viewer, as `polygonOffset` pulls a shader's stages and its
   * fog pass (`tr_shade.c:1014-1018`): `glPolygonOffset(r_offsetFactor, r_offsetUnits)`, the slope's
   * factor and the depth's units.
   */
  pull(material: StandardMaterial): void {
    material.slopeDepthBias = this.factor;
    material.depthBias = this.units;
    this.pulled.push(material);
  }

  /** `r_offsetFactor` and `r_offsetUnits` as they are now, read at each frame as Q3 reads them. */
  offset({ factor, units }: PolygonOffset): void {
    if (factor === this.factor && units === this.units) return;
    this.factor = factor;
    this.units = units;
    for (const material of this.pulled) {
      material.slopeDepthBias = factor;
      material.depthBias = units;
      material.update();
    }
  }

  /**
   * Play the stages of the shaders a frame draws at the clock's `time`: each texture's moving
   * coordinates written, each flipbook's frame bound as it flips, and a wave's colour or alpha set
   * as its byte changes. The first drawn shader whose draws drop the map drops it, in Q3's words.
   *
   * @param time - The clock, in milliseconds.
   * @param drawn - Whether a shader has a batch this frame draws.
   * @param drops - Whether a shader that drops the map drops it now; not in the warm-up.
   */
  play(time: number, drawn: (shader: WorldShader) => boolean, drops = true): void {
    const played = (this.played ??= [...this.shaders.values()]
      .filter((moving) => moving.drop !== undefined || moving.stages.length > 0)
      .sort((a, b) => a.shader.sortedIndex - b.shader.sortedIndex));
    for (let i = 0; i < played.length; i++) {
      const moving = played[i];
      if (!drawn(moving.shader)) continue;
      if (moving.drop !== undefined) {
        if (drops) throw new Error(moving.drop);
        continue;
      }
      const at = shaderTime(time, moving.clampTime, moving.shader.timeOffset);
      for (let k = 0; k < moving.stages.length; k++) {
        this.playStage(moving.stages[k], at, moving.shader.name);
      }
    }
  }

  /** The frames of the longest flipbook among the stages, or 0 where none flips. */
  flipbookFrames(): number {
    let frames = 0;
    for (const moving of this.shaders.values()) {
      for (const stage of moving.stages) {
        frames = Math.max(frames, stage.frames.length, stage.secondFrames.length);
      }
    }
    return frames > 1 ? frames : 0;
  }

  /**
   * Bind the `k`th frame of every flipbook, wrapping round a shorter one, for the warm-up: the next
   * {@link play} binds each at the clock's time again.
   */
  flip(k: number): void {
    for (const moving of this.shaders.values()) {
      for (const stage of moving.stages) {
        if (stage.frames.length > 1) bindFrame(stage, k % stage.frames.length);
        if (stage.secondFrames.length > 1) bindSecondFrame(stage, k % stage.secondFrames.length);
      }
    }
  }

  /** One stage at a shader's time: what {@link play} plays. */
  private playStage(moving: MovingStage, time: number, shader: string): void {
    const { material, stage } = moving;
    if (moving.coordinates) writeCoordinates(stage.texMods, time, moving.coordinates, shader);
    if (moving.secondCoordinates) {
      writeCoordinates(stage.multitexture!.texMods, time, moving.secondCoordinates, shader);
    }
    // `R_BindAnimatedImage` (`tr_shade.c:217-247`), through the maps, which the draw binds.
    if (moving.frames.length > 1) {
      bindFrame(moving, animMapFrame(time, stage.animFps, moving.frames.length));
    }
    if (moving.secondFrames.length > 1) {
      bindSecondFrame(moving, animMapFrame(time, stage.multitexture!.animFps, moving.secondFrames.length));
    }
    let changed = false;
    if (stage.rgbGen === 'wave') {
      const byte = waveColorByte(stage.rgbWave!, time, this.light, shader);
      if (byte !== moving.color) {
        moving.color = byte;
        waveColor.set(byte / 255, byte / 255, byte / 255);
        material.emissive = waveColor;
        changed = true;
      }
    }
    if (stage.alphaGen === 'wave') {
      const byte = waveAlphaByte(stage.alphaWave!, time, shader);
      if (byte !== moving.alpha) {
        moving.alpha = byte;
        material.opacity = byte / 255;
        changed = true;
      }
    }
    if (changed) material.update();
  }
}
