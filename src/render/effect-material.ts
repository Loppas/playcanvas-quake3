import {
  BLEND_ADDITIVE,
  BLEND_MULTIPLICATIVE,
  BLEND_NONE,
  BLEND_NORMAL,
  BLENDEQUATION_ADD,
  BLENDMODE_DST_ALPHA,
  BLENDMODE_DST_COLOR,
  BLENDMODE_ONE,
  BLENDMODE_ONE_MINUS_DST_ALPHA,
  BLENDMODE_ONE_MINUS_DST_COLOR,
  BLENDMODE_ONE_MINUS_SRC_ALPHA,
  BLENDMODE_ONE_MINUS_SRC_COLOR,
  BLENDMODE_SRC_ALPHA,
  BLENDMODE_SRC_ALPHA_SATURATE,
  BLENDMODE_SRC_COLOR,
  BLENDMODE_ZERO,
  BlendState,
  Color,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  StandardMaterial,
  Vec2,
  type AppBase,
  type Texture
} from 'playcanvas';

import {
  findShader,
  type Multitexture,
  type ShaderBlend,
  type ShaderStage,
  type TexMod,
  type Wave
} from '../formats/shader-script';
import type { AssetLibrary } from '../formats/asset-library';
import { animFrame } from '../view/effects';
import { texModsAt, waveGlow, type TexTransform } from '../view/shader-animation';
import { fogAdjustment, type FogAdjustment } from '../view/world-shaders';
import { applyAlphaFunc } from './alpha-test';
import { loadTexture, q3CullMode } from './md3-mesh';
import { MODEL_CHUNKS_VERSION } from './model-chunks';
import { gainOf, setGain } from './stage-gain';
import type { ResourceScope } from './texture-cache';

/**
 * Materials for the effect shaders — explosions, sprites, beams, and the surfaces of effect
 * models.
 *
 * Different from a weapon surface's material in two ways that matter. An effect shader is
 * often asked for **by name**, from the manifest, rather than discovered from an MD3 surface.
 * And Q3 draws **every stage** of it as a pass of its own over the same geometry, so a
 * shader comes back as a list of stages: one material each, for the renderer to draw over one
 * mesh in declaration order. Most stages are `animMap` flipbooks, so their frames come back as
 * a list to step through rather than a single map bound once.
 */

/**
 * What a stage animates, and what its brightness depends on: its texture modifiers, its
 * `rgbGen`, `alphaGen wave`, and its blend and blend factors.
 */
export type StageAnimation = Pick<
  ShaderStage,
  'texMods' | 'rgbGen' | 'rgbWave' | 'alphaWave' | 'blend' | 'blendFactors'
>;

/** One stage of a shader, ready to draw and play. */
export interface EffectStage {
  /** The material with frame 0 bound. Clone it per instance to animate independently. */
  material: StandardMaterial;
  /** Flipbook frames in declaration order; a single entry for a plain `map` stage. */
  frames: Texture[];
  /** Flipbook rate, or 0 for a still image. */
  animFps: number;
  /** The stage's animation, for {@link animateEffect}. */
  animation: StageAnimation;
  /** `alphaGen vertex`: its alpha is the vertices', which a sprite's colour gives them. */
  alphaVertex?: boolean;
  /**
   * `tcMod turb`, which moves each vertex by its own position: on a model, the model chunks
   * move this stage's coordinates by a uniform of its own (`model-chunks.ts`).
   */
  turb?: Wave;
  /**
   * `tcGen environment`: on a staged model, the model chunks make this stage's coordinates, the
   * view mirrored in each vertex's normal (`model-chunks.ts`). Elsewhere it reads its surface's
   * own.
   */
  environment?: boolean;
  /** A merged stage's second texture: see {@link MULTITEXTURE_CHUNKS}. */
  multitexture?: SecondTexture;
  /**
   * How a fog dims it, by its blend and its shader's first stage's (`adjustColorsForFog`); none
   * where absent.
   */
  fog?: FogAdjustment;
}

/**
 * A merged stage's second texture, ready to draw: its flipbook and modifiers, in the material's
 * diffuse map, which draws nothing else here.
 */
export interface SecondTexture {
  frames: Texture[];
  animFps: number;
  texMods: readonly TexMod[];
}

/**
 * How each of the parser's four blends composites.
 *
 * `GL_ONE GL_ONE` is {@link BLEND_ADDITIVE}, **not** `BLEND_ADDITIVEALPHA`. The two are
 * not interchangeable: Q3's additive blend adds RGB and ignores alpha entirely, while
 * `SRC_ALPHA, ONE` multiplies by it first. Q3's effect textures carry whatever alpha they happen
 * to have — often none of consequence — so routing an additive stage through alpha silently
 * scales the whole effect toward nothing.
 */
export const BLEND_TYPES: Record<ShaderBlend, number> = {
  opaque: BLEND_NONE,
  add: BLEND_ADDITIVE,
  blend: BLEND_NORMAL,
  filter: BLEND_MULTIPLICATIVE
};

/** The pairs the four modes draw exactly. Any other draws by its own factors. */
const MODE_PAIRS = new Set([
  'gl_one gl_one',
  'gl_dst_color gl_zero',
  'gl_zero gl_src_color',
  'gl_src_alpha gl_one_minus_src_alpha',
  'gl_one gl_zero'
]);

/** A source factor by Q3's name (`NameToSrcBlendMode`, `tr_shader.c:178–218`). */
const SOURCE_FACTORS: Readonly<Record<string, number>> = {
  gl_one: BLENDMODE_ONE,
  gl_zero: BLENDMODE_ZERO,
  gl_dst_color: BLENDMODE_DST_COLOR,
  gl_one_minus_dst_color: BLENDMODE_ONE_MINUS_DST_COLOR,
  gl_src_alpha: BLENDMODE_SRC_ALPHA,
  gl_one_minus_src_alpha: BLENDMODE_ONE_MINUS_SRC_ALPHA,
  gl_dst_alpha: BLENDMODE_DST_ALPHA,
  gl_one_minus_dst_alpha: BLENDMODE_ONE_MINUS_DST_ALPHA,
  gl_src_alpha_saturate: BLENDMODE_SRC_ALPHA_SATURATE
};

/** A framebuffer factor by Q3's name (`NameToDstBlendMode`, `tr_shader.c:226–262`). */
const FRAMEBUFFER_FACTORS: Readonly<Record<string, number>> = {
  gl_one: BLENDMODE_ONE,
  gl_zero: BLENDMODE_ZERO,
  gl_src_alpha: BLENDMODE_SRC_ALPHA,
  gl_one_minus_src_alpha: BLENDMODE_ONE_MINUS_SRC_ALPHA,
  gl_dst_alpha: BLENDMODE_DST_ALPHA,
  gl_one_minus_dst_alpha: BLENDMODE_ONE_MINUS_DST_ALPHA,
  gl_src_color: BLENDMODE_SRC_COLOR,
  gl_one_minus_src_color: BLENDMODE_ONE_MINUS_SRC_COLOR
};

/**
 * The engine's blend for a pair of Q3's factors that no mode draws exactly, or none for a pair one
 * does. The colour blends by the pair, a name Q3 doesn't know counting as `GL_ONE`, as it does;
 * the framebuffer's alpha is kept.
 *
 * @throws `GL_State`'s drop for a source factor with no framebuffer factor after it
 *   (`tr_backend.c:284-286`)
 */
export function exactBlend(factors: readonly [string, string | undefined]): BlendState | undefined {
  const [source, framebuffer] = factors;
  if (framebuffer === undefined) throw new Error('GL_State: invalid dst blend state bits');
  if (MODE_PAIRS.has(`${source} ${framebuffer}`)) return undefined;
  return new BlendState(
    true,
    BLENDEQUATION_ADD,
    SOURCE_FACTORS[source] ?? BLENDMODE_ONE,
    FRAMEBUFFER_FACTORS[framebuffer] ?? BLENDMODE_ONE,
    BLENDEQUATION_ADD,
    BLENDMODE_ZERO,
    BLENDMODE_ONE
  );
}

/**
 * Where a stage's images come from: the extracted assets, or the search path itself. Each finds an
 * image as `R_FindImageFile` does, through the extension fallback.
 */
export interface ImageSource {
  resolveImage(reference: string): string | undefined;
  read(path: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
}

/**
 * Build every stage of one effect shader, in declaration order.
 *
 * Stages that draw only `$lightmap` or `$whiteimage` are skipped; no effect has one. A shader
 * that isn't found, or has no stage with an image, still yields one untextured additive stage,
 * so the effect draws as a plain glow rather than not at all.
 *
 * An additive stage gets **no opacity map**, and is faded by scaling `material.emissive` —
 * which is what Q3 does too, through `rgbGen`. Each stage starts at its brightness
 * on screen; see {@link animateEffect}.
 *
 * @param app - The running app.
 * @param library - Extracted weapon assets.
 * @param shaderName - As the manifest and `CG_RegisterWeapon` spell it, or as an MD3 surface
 *   names it, extension and all.
 * @param scope - Holds the stages' materials and textures, to be given back with the model that
 *   drew them; without one they are made for good.
 */
export async function createEffectStages(
  app: AppBase,
  library: AssetLibrary,
  shaderName: string,
  scope?: ResourceScope
): Promise<EffectStage[]> {
  const shader = findShader(library.shaders, shaderName);
  const cull = q3CullMode(shader?.cull);
  const drawn = (shader?.stages ?? []).filter((stage) =>
    stage.maps.some((map) => !map.startsWith('$'))
  );
  const mipmaps = !shader?.noMipMaps;
  if (drawn.length === 0) {
    return [await createStage(app, library, undefined, cull, mipmaps, scope)];
  }

  const stages: EffectStage[] = [];
  for (const stage of drawn) {
    const made = await createStage(app, library, stage, cull, mipmaps, scope);
    stages.push({ ...made, fog: fogAdjustment(stage, shader!.stages[0]) });
  }
  return stages;
}

/** A merged stage's second texture's texel, sampled through the material's diffuse map. */
const SECOND_TEXEL_GLSL =
  'texture2DBias({STD_DIFFUSE_TEXTURE_NAME}, {STD_DIFFUSE_TEXTURE_UV}, {STD_TEXTURE_BIAS})';
const SECOND_TEXEL_WGSL = `textureSampleBias(
		{STD_DIFFUSE_TEXTURE_NAME},
		{STD_DIFFUSE_TEXTURE_NAME}Sampler,
		{STD_DIFFUSE_TEXTURE_UV},
		{STD_TEXTURE_BIAS}
	)`;

/**
 * A merged stage's second texture, as `DrawMultitextured` draws it (`tr_shade.c:350-387`), in
 * what the stage writes: multiplied into it, or added to it under `Q3_MULTITEXTURE_ADD`. The
 * texel is taken to what a pass of it alone at full colour would write, and where the stage has
 * no image there, as for `$whiteimage`, it is white.
 */
export const MULTITEXTURE_CHUNKS = {
  glsl: new Map([
    [
      'litUserMainEndPS',
      `
	#ifdef STD_DIFFUSE_TEXTURE
	vec3 q3Texel = gammaCorrectOutput(toneMap({STD_DIFFUSE_TEXTURE_DECODE}(${SECOND_TEXEL_GLSL})));
	#else
	vec3 q3Texel = vec3(1.0);
	#endif
	#ifdef Q3_MULTITEXTURE_ADD
	gl_FragColor.rgb += q3Texel;
	#else
	gl_FragColor.rgb *= q3Texel;
	#endif
`
    ]
  ]),
  wgsl: new Map([
    [
      'litUserMainEndPS',
      `
	#ifdef STD_DIFFUSE_TEXTURE
	let q3Texel = gammaCorrectOutput(toneMap({STD_DIFFUSE_TEXTURE_DECODE}(${SECOND_TEXEL_WGSL})));
	#else
	let q3Texel = vec3f(1.0);
	#endif
	#ifdef Q3_MULTITEXTURE_ADD
	output.color = vec4f(output.color.rgb + q3Texel, output.color.a);
	#else
	output.color = vec4f(output.color.rgb * q3Texel, output.color.a);
	#endif
`
    ]
  ])
};

/**
 * What a merged stage's alpha test multiplies its alpha by first: its second texture's alpha, as
 * the texture unit multiplies alphas whether it adds or multiplies colours.
 */
const SECOND_ALPHA = {
  glsl: `	#ifdef STD_DIFFUSE_TEXTURE
	a *= ${SECOND_TEXEL_GLSL}.a;
	#endif
`,
  wgsl: `	#ifdef STD_DIFFUSE_TEXTURE
	a = a * ${SECOND_TEXEL_WGSL}.a;
	#endif
`
};

/**
 * One stage's material and frames. A stage drawing `$whiteimage` gets the white image where
 * `images` reads it as one (`white-image.ts`), and otherwise no map, drawing its colour alone; a
 * `$lightmap` is the caller's to bind. A stage whose blend factors no mode draws exactly draws by
 * its own
 * ({@link exactBlend}), and `alphaGen lightingSpecular` takes the vertex colours' alpha. A merged
 * stage's second texture is loaded as its first is, and drawn by {@link MULTITEXTURE_CHUNKS}.
 *
 * @param images - Where its images are read from.
 * @param mipmaps - Off for a `nomipmaps` shader.
 * @param scope - Holds the material and textures; see {@link createEffectStages}.
 * @param picmip - Uploads its images as opengl1's `Upload32` does, halved this many times; see
 *   {@link loadTexture}. Absent, they upload as they are.
 */
export async function createStage(
  app: AppBase,
  images: ImageSource,
  stage: ShaderStage | undefined,
  cull: number,
  mipmaps: boolean,
  scope?: ResourceScope,
  picmip?: number
): Promise<EffectStage> {
  const blend = stage?.blend ?? 'add';
  const animation: StageAnimation = {
    texMods: stage?.texMods ?? [],
    rgbGen: stage?.rgbGen ?? 'identityLighting',
    rgbWave: stage?.rgbWave,
    alphaWave: stage?.alphaWave,
    blend,
    blendFactors: stage?.blendFactors
  };
  const material = new StandardMaterial();
  scope?.own(material);
  material.useLighting = false;
  material.diffuse.set(0, 0, 0);
  // Its brightness. A stage that animates replays it every frame.
  setGain(material, animation);
  material.blendType = BLEND_TYPES[blend];
  const exact = stage?.blendFactors && exactBlend(stage.blendFactors);
  if (exact) material.blendState = exact;
  // A blended stage writes no depth unless it says `depthWrite`, as the parser infers.
  material.depthWrite = stage?.depthWrite ?? false;
  material.cull = cull;
  const second = stage?.multitexture;
  applyAlphaFunc(material, stage?.alphaFunc, second && SECOND_ALPHA);

  /** A texture's frames, the images found of its maps. */
  const load = async ({ maps, clamp }: Pick<ShaderStage, 'maps' | 'clamp'>) => {
    const loaded: Texture[] = [];
    for (const map of maps) {
      if (map.toLowerCase() === '$lightmap') continue;
      const path = images.resolveImage(map);
      const bytes = path ? await images.read(path) : undefined;
      if (!path || !bytes) continue;
      loaded.push(await loadTexture(app, path, bytes, clamp, mipmaps, scope, picmip));
    }
    return loaded;
  };
  const frames = await load(stage ?? { maps: [], clamp: false });
  const multitexture = second && (await multitextureOf(material, second, load));

  if (frames.length > 0) {
    material.emissiveMap = frames[0];
    // Only a blended or alpha-tested stage reads alpha; an additive one would be scaled to
    // nothing by it.
    if (blend === 'blend' || material.alphaTest > 0) material.opacityMap = frames[0];
  }
  // `alphaGen lightingSpecular`: the vertex colours' alpha, which the model writes each frame,
  // times the texture's.
  if (stage?.alphaGen === 'lightingSpecular') {
    material.opacityVertexColor = true;
    material.opacityVertexColorChannel = 'a';
  }
  material.update();

  return {
    material,
    frames,
    animFps: stage?.animFps ?? 0,
    animation,
    alphaVertex: stage?.alphaGen === 'vertex',
    turb: stage?.texMods.find(
      (mod): mod is Extract<TexMod, { type: 'turb' }> => mod.type === 'turb'
    )?.wave,
    environment: stage?.tcGen === 'environment',
    multitexture
  };
}

/**
 * A merged stage's second texture put in its material: its first frame in the diffuse map, which
 * draws nothing else with the diffuse colour black, and {@link MULTITEXTURE_CHUNKS}.
 */
async function multitextureOf(
  material: StandardMaterial,
  second: Multitexture,
  load: (texture: Multitexture) => Promise<Texture[]>
): Promise<SecondTexture> {
  const frames = await load(second);
  if (frames.length > 0) material.diffuseMap = frames[0];
  for (const [language, chunks] of [
    [SHADERLANGUAGE_GLSL, MULTITEXTURE_CHUNKS.glsl],
    [SHADERLANGUAGE_WGSL, MULTITEXTURE_CHUNKS.wgsl]
  ] as const) {
    for (const [name, code] of chunks) material.getShaderChunks(language).set(name, code);
  }
  material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
  material.setDefine('Q3_MULTITEXTURE_ADD', second.env === 'add');
  return { frames, animFps: second.animFps, texMods: second.texMods };
}

/**
 * Show a merged stage's second texture at `seconds`: its flipbook frame, and its `tcMod`s in its
 * map's transform. With no frames, the diffuse map is left as it is.
 */
export function playMultitexture(
  material: StandardMaterial,
  second: SecondTexture,
  seconds: number
): void {
  const frame = second.frames[animFrame(seconds * 1000, second.animFps, second.frames.length)];
  if (frame) material.diffuseMap = frame;
  if (second.texMods.length > 0) {
    const { tiling, degrees, offset } = mapTransformOf(texModsAt(second.texMods, seconds));
    material.diffuseMapTiling = new Vec2(tiling[0], tiling[1]);
    material.diffuseMapRotation = degrees;
    material.diffuseMapOffset = new Vec2(offset[0], offset[1]);
  }
  material.update();
}

/**
 * Bind one flipbook frame to a material.
 *
 * Both maps where an opacity map is in use: the alpha a blended stage reads comes from it, so
 * leaving it on frame 0 while the colour advances flickers through the wrong silhouette.
 * Additive stages have none, and skip it.
 *
 * @param material - Material to rebind; usually a per-instance clone.
 * @param frames - The flipbook.
 * @param index - Frame to show.
 */
export function bindEffectFrame(
  material: StandardMaterial,
  frames: readonly Texture[],
  index: number
): void {
  const texture = frames[index];
  if (!texture || material.emissiveMap === texture) return;
  material.emissiveMap = texture;
  if (material.opacityMap) material.opacityMap = texture;
  material.update();
}

/** Whether a stage changes over time at all, so a still one costs nothing per frame. */
export function isAnimated(stage: Pick<EffectStage, 'animation' | 'animFps' | 'frames'>): boolean {
  const { texMods, rgbWave, alphaWave } = stage.animation;
  const flipbook = stage.animFps > 0 && stage.frames.length > 1;
  return flipbook || texMods.length > 0 || rgbWave !== undefined || alphaWave !== undefined;
}

/**
 * Whether a stage takes its colour from the entity drawing it (`rgbGen entity`), so each draw
 * feeds one in: `color1`, in the railgun's flash and its glow.
 */
export function takesEntityColor(stage: Pick<EffectStage, 'animation'>): boolean {
  return stage.animation.rgbGen === 'entity';
}

/** PlayCanvas' tiling, rotation and offset for one texture-coordinate transform. */
export interface MapTransform {
  tiling: [number, number];
  /** Degrees, as `emissiveMapRotation` takes them. */
  degrees: number;
  offset: [number, number];
}

/**
 * Split a texture-coordinate transform into PlayCanvas' map parameters.
 *
 * PlayCanvas samples at `(dot((u, v, 1), T0), dot((u, v, 1), T1))`, with
 * `T0 = (cos r · tx, −sin r · ty, ox)` and `T1 = (sin r · tx, cos r · ty, 1 − ty − oy)`
 * (`standard-material.js`, the `uvTransform` chunk). Its linear part is a rotation times a
 * diagonal scale, so it holds exactly any transform whose two columns are at right angles.
 * Every combination the effect shaders use is one: none turns a texture it has scaled
 * unevenly. A mirroring scale comes out as a half turn.
 */
export function mapTransformOf(m: TexTransform): MapTransform {
  const tx = Math.hypot(m.a, m.c);
  const radians = tx > 0 ? Math.atan2(m.c, m.a) : Math.atan2(-m.b, m.d);
  const ty = -m.b * Math.sin(radians) + m.d * Math.cos(radians);
  return {
    tiling: [tx, ty],
    degrees: (radians * 180) / Math.PI,
    offset: [m.e, 1 - ty - m.f]
  };
}

/** How a stage's animation is placed on one particular draw. */
export interface StageOptions {
  /**
   * The coordinates the geometry itself hands the stage, applied before its modifiers: a
   * beam's texture repeats every 256 units of its length.
   */
  base?: TexTransform;
  /** Scales the stage's colour, for a fade Q3 feeds in through the vertex colour. */
  brightness?: number;
  /**
   * Its colour is its vertex colours, which hold the entity's shade: on screen halved, for the
   * material to double back (`LIGHT_HEADROOM`), and whole in a map's scene.
   */
  lit?: boolean;
  /**
   * The vertex or entity colour, channel by channel, as `rgbGen vertex` or `rgbGen entity`
   * multiplies it in: `color1`, in the rail, the hook and the railgun's flash. White
   * by default.
   */
  color?: readonly [number, number, number];
  /**
   * The draw's own vertex shader moves the texture coordinates from the port's `q3_coords`
   * uniform (`model-chunks.ts`), so this must not also set the engine's map transform: a staged
   * model's stages play here, and {@link playStagedStages} sets it.
   */
  ownsTransform?: boolean;
}

const WHITE = [1, 1, 1] as const;

/**
 * Draw a one-frame additive stage **over** what lies behind it instead, so that a colour fed in
 * shows on a bright background as well as on a dark one.
 *
 * Added light only brightens, so on white it draws nothing, whatever its colour. Here the
 * texture's brightness becomes the stage's opacity, and its colour a flat `material.emissive`
 * with no map: where the texture is bright the colour covers the background, and where it is
 * dark the background shows through. Over black that is exactly the additive stage, tinted: the
 * colour times the texture. Over white, the colour still shows.
 *
 * The texture's green channel stands for its brightness, since green carries most of luminance;
 * on a grey texture it is all three.
 *
 * Play it with {@link animateEffect}, not {@link playStage}, whose flipbook binding would put
 * the emissive map back.
 *
 * @param material - The stage's material: an instance's own clone, never a prototype's.
 */
export function blendOver(material: StandardMaterial): void {
  material.opacityMap = material.emissiveMap;
  material.opacityMapChannel = 'g';
  material.emissiveMap = null;
  material.blendType = BLEND_NORMAL;
  // A fog that dimmed what it added fades it by its opacity instead.
  if (material.getDefine(FOG_RGB_DEFINE)) {
    material.setDefine(FOG_RGB_DEFINE, false);
    material.setDefine(FOG_ALPHA_DEFINE, true);
  }
  material.update();
}

/** The defines a stage dimmed by its fog dims its colour by, and its alpha (`fog-chunks.ts`). */
const FOG_RGB_DEFINE = 'Q3_FOG_RGB';
const FOG_ALPHA_DEFINE = 'Q3_FOG_ALPHA';

/**
 * What {@link animateEffect} last gave each material, in {@link given}'s order. A play that would
 * give the same leaves the material alone: its `update()` is the costly part, and is redone at
 * the material's next draw.
 */
const applied = new WeakMap<StandardMaterial, Float64Array>();
/** Scratch: a play's colour (0–2), opacity (3), map tiling (4–5), rotation (6) and offset (7–8). */
const given = new Float64Array(9);
const glowColor = new Color();
const tilingVec = new Vec2();
const offsetVec = new Vec2();

/** Whether two plays give the same, a value never given (NaN) counting as the same as itself. */
function sameValues(a: Float64Array, b: Float64Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
  }
  return true;
}

/**
 * Put a stage's animation at `seconds` onto a material: its brightness, times any colour fed
 * in, into the emissive colour, `alphaGen wave` into the opacity, and the texture modifiers into
 * the map transform.
 *
 * The emissive colour is the stage's brightness **on screen**, under the renderer the port
 * draws like (`view/overbright.ts`): in classic Q3, 2 for `rgbGen identity` and up to 2 for a
 * wave. PlayCanvas makes that exact. It decodes the texture and linearizes the colour with the
 * same 2.2 power it encodes the output with, and blends in the 8-bit backbuffer, so a colour of
 * 2 draws twice the texture, clamped at white just as Q3's gamma ramp clamps it.
 *
 * @param material - The draw's material: an effect's own clone, or a prototype's shared one.
 * @param seconds - Q3's `shaderTime` for the effect: its age, or the game clock.
 */
export function animateEffect(
  material: StandardMaterial,
  animation: StageAnimation,
  seconds: number,
  { base, brightness = 1, lit = false, color = WHITE, ownsTransform = false }: StageOptions = {}
): void {
  const last = applied.get(material);
  if (last) given.set(last);
  else given.fill(Number.NaN);
  const glow = gainOf(material, animation, seconds, brightness, lit, color);
  given[0] = glow[0];
  given[1] = glow[1];
  given[2] = glow[2];
  // `RB_CalcWaveAlpha`. A blended stage's opacity map multiplies it, as Q3 multiplies the
  // texture's alpha by the vertex's.
  if (animation.alphaWave) given[3] = waveGlow(animation.alphaWave, seconds);
  // With `ownsTransform`, the draw's own vertex shader moves the coordinates from `q3_coords`,
  // and setting the engine's map transform here would only make it walk every map again.
  const moved = !ownsTransform && (animation.texMods.length > 0 || base !== undefined);
  if (moved) {
    const { tiling, degrees, offset } = mapTransformOf(
      texModsAt(animation.texMods, seconds, base)
    );
    given[4] = tiling[0];
    given[5] = tiling[1];
    given[6] = degrees;
    given[7] = offset[0];
    given[8] = offset[1];
  }
  if (last && sameValues(given, last)) return;
  if (last) last.set(given);
  else applied.set(material, given.slice());

  glowColor.set(given[0], given[1], given[2]);
  material.emissive = glowColor;
  if (animation.alphaWave) material.opacity = given[3];
  if (moved) {
    // Through the setters: reading a map's tiling or offset marks the material's transforms as
    // changing, and every later update then walks each map the material could have.
    tilingVec.set(given[4], given[5]);
    offsetVec.set(given[7], given[8]);
    material.emissiveMapTiling = tilingVec;
    material.emissiveMapRotation = given[6];
    material.emissiveMapOffset = offsetVec;
    // A blended stage reads its alpha through the same coordinates.
    if (material.opacityMap) {
      material.opacityMapTiling = tilingVec;
      material.opacityMapRotation = given[6];
      material.opacityMapOffset = offsetVec;
    }
  }

  material.update();
}

/**
 * Show a stage at `seconds`: its flipbook frame, then its animation.
 *
 * @param material - The draw's material: the stage's own, or a clone of it.
 */
export function playStage(
  material: StandardMaterial,
  stage: EffectStage,
  seconds: number,
  options?: StageOptions
): void {
  bindEffectFrame(
    material,
    stage.frames,
    animFrame(seconds * 1000, stage.animFps, stage.frames.length)
  );
  animateEffect(material, stage.animation, seconds, options);
}
