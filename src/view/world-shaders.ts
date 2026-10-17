import {
  MST_FLARE,
  MST_PATCH,
  MST_PLANAR,
  MST_TRIANGLE_SOUP,
  type Bsp
} from '../formats/bsp';
import {
  SS_BLEND0,
  SS_DECAL,
  SS_ENVIRONMENT,
  SS_FOG,
  SS_OPAQUE,
  SS_SEE_THROUGH,
  findShader,
  parseShader,
  type Multitexture,
  type ShaderScript,
  type ShaderStage,
  type StageTexture,
  type Wave
} from '../formats/shader-script';
import { loadFogs, type WorldFog } from './world-fog';
import { lightmapCount } from './world-light';
import { SKY_SUFFIXES } from './world-sky';

/**
 * The shaders a map's surfaces draw with, registered as opengl1 registers them while it loads the
 * world. `R_LoadFogs` (`tr_bsp.c:1531-1637`) finds each fog's shader first. Then `R_LoadSurfaces`
 * (`:1236-1293`) takes the surfaces in lump order, and each asks `ShaderForShaderNum` (`:269-295`)
 * for its shader, which `R_FindShader` (`tr_shader.c:2512-2658`) finds or makes. Where a shader
 * lands in the draw order is set here: by its sort, then by when it was first asked for
 * (`SortNewShader`, `tr_shader.c:2005-2027`).
 *
 * A face or a patch asks at its lightmap page, and a triangle soup or a flare at
 * `LIGHTMAP_BY_VERTEX` (`tr_bsp.c:315, 390, 450, 508`); under `r_fullbright` every surface asks at
 * `LIGHTMAP_WHITEIMAGE` (`:283-285`). A shader is found by its name and the lightmap index it was
 * made at, so one name can be several shaders.
 *
 * A shader's surfaceparms change nothing here. opengl1 reads none of them for the world's drawing
 * but `fog`, which gives a fog's own face its pass, and `sky` and `nodlight`, which keep dynamic
 * lights off; a curve the map flags nodraw is skipped by the map's own flags (`tr_bsp.c:397`).
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** The lightmap indexes below a page (`tr_common.h:68-71`). */
export const LIGHTMAP_2D = -4;
export const LIGHTMAP_BY_VERTEX = -3;
export const LIGHTMAP_WHITEIMAGE = -2;
export const LIGHTMAP_NONE = -1;

/** `MAX_FACE_POINTS` (`tr_local.h:504`). */
export const MAX_FACE_POINTS = 64;

/** `MAX_QPATH` (`q_shared.h:246`): a name this long is refused a registration. */
const MAX_QPATH = 64;

/** Q3's default shader, and the image it draws, by name (`tr_shader.c:3108`, `tr_image.c:1218`). */
export const DEFAULT_SHADER = '<default>';
export const DEFAULT_IMAGE = '*default';

/** A shader as the world draws it. */
export interface WorldShader {
  /** As asked for, its extension stripped; {@link DEFAULT_SHADER} for Q3's default. */
  name: string;
  /**
   * The lightmap index it was made at: a page, or one of the `LIGHTMAP_*` below them. One with no
   * lightmap stage made at a page is kept at {@link LIGHTMAP_NONE} (`tr_shader.c:2360-2366`).
   */
  lightmapIndex: number;
  /** Its place in `tr.shaders`: the order shaders were first asked for. */
  index: number;
  /** Its `sortedIndex`: its place in the draw order, by sort and then by `index`. */
  sortedIndex: number;
  /** Its sort, one of `SS_*` or a script's own, in a float. */
  sort: number;
  /**
   * `defaultShader`: it failed to parse, or names an image that isn't there. A surface asking
   * for it draws Q3's default shader instead (`tr_bsp.c:289-292`).
   */
  defaultShader: boolean;
  /**
   * The stages it draws, in order, as `FinishShader` leaves them: an implicit shader's, or the
   * script's up to the first with no image, without a `detail` stage `r_detailtextures` drops, each
   * with its coordinates (`tcGen`) settled, and the first two merged into one where they can be
   * (see {@link FinishSwitches}). `$lightmap` and `$whiteimage` are kept as named: a `$lightmap`
   * stage samples the page at {@link lightmapIndex}, and white below 0. {@link DEFAULT_IMAGE} is
   * Q3's default image.
   */
  stages: ShaderStage[];
  /** Its script as its own parse read it; none for an implicit shader or the default. */
  script?: ShaderScript;
  /** Its sky, if it is one (`isSky`): its stages are then the clouds'. */
  sky?: WorldSky;
  /** The `fogParms` its parse reached, the last of each; none where it reached none. */
  fogParms?: WorldFogParms;
  /** How its surfaces in a fog are fogged after their stages. */
  fogPass: FogPass;
  /**
   * How each of its {@link stages} takes a fog in its own colours instead, in order. A merged
   * stage takes its first stage's.
   */
  fogAdjustments: FogAdjustment[];
  /** `remappedShader`: what its surfaces draw instead since a swap (`world-remap.ts`), or none. */
  remappedShader: WorldShader | null;
  /** `timeOffset`: the time a swap to it was made, in seconds, where its stages' clock starts. */
  timeOffset: number;
}

/**
 * What `FinishShader` makes of a shader's stages by the renderer's settings:
 * - whether its first two stages merge into one pass of two textures, as opengl1 merges them
 *   where it has a second texture unit: `r_ext_multitexture`, and for a pair that adds,
 *   `r_ext_texture_env_add` too (`GLimp_InitExtensions`, `sdl_glimp.c:947-1005`);
 * - `r_detailtextures`, without which a `detail` stage is dropped (`tr_shader.c:2246-2267`); on by
 *   default, as Q3 has it.
 */
export interface FinishSwitches {
  multitexture: boolean;
  textureEnvAdd: boolean;
  detailTextures?: boolean;
}

/** Each stage a pass of its own. */
export const NO_MULTITEXTURE: FinishSwitches = { multitexture: false, textureEnvAdd: false };

/** A shader's fog (`fogParms_t`, `tr_local.h:317-320`). */
export interface WorldFogParms {
  /** Its colour, 0 to 1 a channel. */
  color: [number, number, number];
  /** How deep it is when it hides what is behind it, in units. */
  depthForOpaque: number;
}

/**
 * How a shader's surfaces in a fog are fogged after their stages (`fogPass_t`,
 * `tr_local.h:306-310`): by a pass over them where the depth is equal, for an opaque surface; where
 * it is less or equal, for a fog's own face; or not at all.
 */
export type FogPass = 'none' | 'equal' | 'lessEqual';

/**
 * How a blended stage of a surface in a fog takes the fog in its own colours (`acff_t`,
 * `tr_local.h:190-195`): its colour, its alpha or both scaled down as the fog thickens, or none.
 */
export type FogAdjustment = 'none' | 'rgb' | 'alpha' | 'rgba';

/** A sky shader's own, as `ParseSkyParms` leaves it (`tr_shader.c:1255-1311`). */
export interface WorldSky {
  /**
   * The outer box's faces, side by side as {@link SKY_SUFFIXES} names them: each `<box>_<suffix>.tga`, or
   * {@link DEFAULT_IMAGE} where it isn't there. None where the shader names no box, or its `_rt`
   * face isn't there, as Q3 then draws none (`tr_sky.c:799`).
   */
  box?: string[];
}

/** What the world's surfaces draw with. */
export interface WorldShaders {
  /** In the order they were first asked for, the default first. */
  shaders: WorldShader[];
  /**
   * Each surface's shader, by its index in {@link shaders}: the default's where its own failed, or
   * where it is a face with too many points.
   */
  surfaceShaders: Int32Array;
  /**
   * The cloud height Q3's one table of the clouds' coordinates was last made at, as each shader
   * parsed a `skyParms` that read one; every sky's clouds draw by it. None if no shader read one.
   */
  cloudHeight?: number;
  /**
   * The sun the last shader parsed with a `q3map_sun` points to, as `tr.sunDirection` is left by
   * the map's load; none if no shader had one.
   */
  sunDirection?: [number, number, number];
  /** The map's fogs, in lump order: a surface's `fogNum` is its fog's place here. */
  fogs: WorldFog[];
  /** The shaders a swap the map's entities can make may draw instead of each one it swaps. */
  swapTargets: ReadonlyMap<WorldShader, readonly WorldShader[]>;
  /**
   * `R_FindShaderByName`: the shader of this name made last, at any lightmap index, or the
   * default where none is.
   */
  findByName(name: string): WorldShader;
  /**
   * `RE_RegisterShaderLightMap`: the shader of this name at this index, made now where it was not,
   * or the default where it failed.
   *
   * @param placeOnly - For a shader registered for its place in the order alone, whose drawing
   *   says what it has to: its parse's warnings go unprinted, and a parse that would drop the map
   *   leaves it the default's.
   */
  register(name: string, lightmapIndex: number, placeOnly?: boolean): WorldShader;
  /** Counts each time a shader is sorted in, which may move every place after it. */
  readonly generation: number;
  /** Every shader of this name, at any lightmap index. */
  variants(name: string): readonly WorldShader[];
  /**
   * The shaders as the load left them, as a renderer started again would have them: none swapped,
   * none registered since, and those made ahead unregistered again.
   */
  reset(): void;
}

/**
 * A shader swap a map's entities can make: `targetShaderName` and `targetShaderNewName`. The world
 * makes each shader a swap would register with the rest, unregistered until the swap asks for it.
 */
export interface ShaderSwap {
  oldShader: string;
  newShader: string;
}

/** How the registry finds what a shader needs. */
export interface ShaderSources {
  /** A shader's script, by name, as `findShader` looks it up. */
  scripts: Map<string, ShaderScript>;
  /** Whether an image is there, through the extension fallback as `R_FindImageFile` finds it. */
  hasImage(name: string): boolean;
  /** Prints a warning, as `ri.Printf(PRINT_WARNING, …)` does. */
  warn(text: string): void;
}

/** A stage the implicit and default shaders are made of: opaque, as the parser leaves one. */
function plainStage(map: string, rgbGen: ShaderStage['rgbGen']): ShaderStage {
  return {
    maps: [map],
    animFps: 0,
    blend: 'opaque',
    depthWrite: true,
    clamp: false,
    texMods: [],
    rgbGen
  };
}

/** `COM_StripExtension`: the name without the extension of its last part. */
function stripExtension(name: string): string {
  return name.replace(/\.[^./]*$/, '');
}

/** The stages of `<default>` (`tr_shader.c:3108-3112`): its image, at `identityLighting`. */
const DEFAULT_STAGES = [plainStage(DEFAULT_IMAGE, 'identityLighting')];

/** Whether a stage draws the lightmap, as `map $lightmap` makes one (`tr_shader.c:629`). */
export function isLightmapStage(stage: Pick<ShaderStage, 'lightmap'>): boolean {
  return stage.lightmap === true;
}

/**
 * An implicit shader's stages, by the lightmap index it is made at (`tr_shader.c:2609-2655`):
 * - **`LIGHTMAP_NONE`:** the image at `lightingDiffuse`;
 * - **`LIGHTMAP_BY_VERTEX`:** the image at `exactVertex`, its alpha left alone;
 * - **`LIGHTMAP_2D`:** the image in its vertex colour and alpha, blended over what is drawn, with
 *   no depth test;
 * - **`LIGHTMAP_WHITEIMAGE`:** white at `identityLighting`, then the image multiplied over it;
 * - **a page:** the lightmap at `identity`, then the image multiplied over it.
 */
function implicitStages(image: string, lightmapIndex: number): ShaderStage[] {
  const multiplied: ShaderStage = {
    ...plainStage(image, 'identity'),
    blend: 'filter',
    blendFactors: ['gl_dst_color', 'gl_zero'],
    depthWrite: false
  };
  switch (lightmapIndex) {
    case LIGHTMAP_NONE:
      return [plainStage(image, 'lightingDiffuse')];
    case LIGHTMAP_BY_VERTEX:
      return [{ ...plainStage(image, 'exactVertex'), alphaGen: 'skip' }];
    case LIGHTMAP_2D:
      return [
        {
          ...plainStage(image, 'vertex'),
          alphaGen: 'vertex',
          blend: 'blend',
          blendFactors: ['gl_src_alpha', 'gl_one_minus_src_alpha'],
          depthWrite: false,
          depthTest: false
        }
      ];
    case LIGHTMAP_WHITEIMAGE:
      return [plainStage('$whiteimage', 'identityLighting'), multiplied];
    default:
      return [{ ...plainStage('$lightmap', 'identity'), lightmap: true }, multiplied];
  }
}

/**
 * How a stage takes a fog in its own colours (`FinishShader`, `tr_shader.c:2293-2322`): only where
 * it and the shader's first stage both blend, and only by a blend whose share fades to nothing as
 * those colours do.
 */
export function fogAdjustment(
  stage: Pick<ShaderStage, 'blendFactors'>,
  first: Pick<ShaderStage, 'blendFactors'>
): FogAdjustment {
  if (!stage.blendFactors || !first.blendFactors) return 'none';
  const [src, dst] = stage.blendFactors;
  if (src === 'gl_one' && dst === 'gl_one') return 'rgb';
  if (src === 'gl_zero' && dst === 'gl_one_minus_src_color') return 'rgb';
  if (src === 'gl_src_alpha' && dst === 'gl_one_minus_src_alpha') return 'alpha';
  if (src === 'gl_one' && dst === 'gl_one_minus_src_alpha') return 'rgba';
  return 'none';
}

/**
 * A stage's blend as opengl1's state bits hold it, as its source and framebuffer factors: `none`
 * for no blend, and a framebuffer factor never read as `none` too.
 */
function blendBits(stage: ShaderStage): string {
  if (!stage.blendFactors) return 'none';
  const [src, dst] = stage.blendFactors;
  return `${src} ${dst ?? 'none'}`;
}

/** The blends `CollapseMultitexture` merges and gives, by {@link blendBits}. */
const MULTIPLIES = 'gl_zero gl_src_color';
const FILTER = 'gl_dst_color gl_zero';
const ADDS = 'gl_one gl_one';

/** A merged stage's blend, as the parser leaves one. */
const MERGED_BLENDS: Readonly<Record<string, Pick<ShaderStage, 'blend' | 'blendFactors'>>> = {
  none: { blend: 'opaque' },
  [FILTER]: { blend: 'filter', blendFactors: ['gl_dst_color', 'gl_zero'] },
  [ADDS]: { blend: 'add', blendFactors: ['gl_one', 'gl_one'] }
};

/**
 * `collapse` (`tr_shader.c:1771-1800`): the first and second stages' blends that merge, what the
 * second texture does to the first, and the merged stage's blend.
 */
const COLLAPSE: readonly {
  first: string;
  second: string;
  env: Multitexture['env'];
  blend: string;
}[] = [
  { first: 'none', second: MULTIPLIES, env: 'modulate', blend: 'none' },
  { first: 'none', second: FILTER, env: 'modulate', blend: 'none' },
  { first: FILTER, second: FILTER, env: 'modulate', blend: FILTER },
  { first: MULTIPLIES, second: FILTER, env: 'modulate', blend: FILTER },
  { first: FILTER, second: MULTIPLIES, env: 'modulate', blend: FILTER },
  { first: MULTIPLIES, second: MULTIPLIES, env: 'modulate', blend: FILTER },
  { first: 'none', second: ADDS, env: 'add', blend: 'none' },
  { first: ADDS, second: ADDS, env: 'add', blend: ADDS }
];

/** Whether two waves are the same to the bit in every parameter, as `memcmp` compares them. */
const sameWave = (a: Wave | undefined, b: Wave | undefined) =>
  a?.func === b?.func &&
  Object.is(a?.base, b?.base) &&
  Object.is(a?.amplitude, b?.amplitude) &&
  Object.is(a?.phase, b?.phase) &&
  Object.is(a?.frequency, b?.frequency);

/** A stage's texture, as `CollapseMultitexture` moves it from one stage to another. */
function textureOf(stage: StageTexture): StageTexture {
  const { maps, animFps, clamp, lightmap, tcGen, tcGenVectors, texMods, videoMap } = stage;
  const texture: StageTexture = { maps, animFps, clamp, texMods };
  if (lightmap !== undefined) texture.lightmap = lightmap;
  if (tcGen !== undefined) texture.tcGen = tcGen;
  if (tcGenVectors !== undefined) texture.tcGenVectors = tcGenVectors;
  if (videoMap !== undefined) texture.videoMap = videoMap;
  return texture;
}

/**
 * `CollapseMultitexture` (`tr_shader.c:1810-1917`): a shader's first two stages merged into one
 * pass of two textures, where their blends are a row of its table and they draw alike in all
 * else but their depth writes: the same alpha test, depth test and depth function, and the same
 * `rgbGen` and `alphaGen`, their waves alike. A pair that adds must be at `identity`. A `const`
 * colour is not compared, so the merged stage draws the first's.
 *
 * The merged stage is the first, at the table's blend. Its texture is the first stage's, or the
 * second's where the first draws the lightmap, and the other is its second texture. The stages
 * after it move down.
 */
export function collapseMultitexture(
  stages: ShaderStage[],
  switches: FinishSwitches
): ShaderStage[] {
  if (!switches.multitexture || stages.length < 2) return stages;
  const [a, b] = stages;
  if (
    a.alphaFunc !== b.alphaFunc ||
    a.depthFunc !== b.depthFunc ||
    (a.depthTest ?? true) !== (b.depthTest ?? true)
  ) {
    return stages;
  }
  const [aBits, bBits] = [blendBits(a), blendBits(b)];
  const row = COLLAPSE.find(({ first, second }) => first === aBits && second === bBits);
  if (!row || (row.env === 'add' && !switches.textureEnvAdd)) return stages;
  const alphaGen = a.alphaGen ?? 'identity';
  if (a.rgbGen !== b.rgbGen || alphaGen !== (b.alphaGen ?? 'identity')) return stages;
  if (row.env === 'add' && a.rgbGen !== 'identity') return stages;
  if (a.rgbGen === 'wave' && !sameWave(a.rgbWave, b.rgbWave)) return stages;
  if (alphaGen === 'wave' && !sameWave(a.alphaWave, b.alphaWave)) return stages;

  // The first stage's state and colour, without its texture and blend.
  const {
    maps,
    animFps,
    clamp,
    lightmap,
    tcGen,
    tcGenVectors,
    texMods,
    videoMap,
    blend,
    blendFactors,
    ...state
  } = a;
  const [kept, moved] = isLightmapStage(a) ? [b, a] : [a, b];
  const merged: ShaderStage = {
    ...state,
    ...textureOf(kept),
    ...MERGED_BLENDS[row.blend],
    multitexture: { ...textureOf(moved), env: row.env }
  };
  return [merged, ...stages.slice(2)];
}

/**
 * A sky's outer box, its faces found as `R_FindImageFile` finds them, the default image standing
 * in for one that isn't there (`tr_shader.c:1268-1278`).
 */
function skyBox(outerBox: string | undefined, sources: ShaderSources): string[] | undefined {
  if (outerBox === undefined) return undefined;
  const faces = SKY_SUFFIXES.map((suffix) => `${outerBox}_${suffix}.tga`);
  if (!sources.hasImage(faces[0])) return undefined;
  return faces.map((face) => (sources.hasImage(face) ? face : DEFAULT_IMAGE));
}

/** What a shader is before `FinishShader`: its stages, and what sorts it. */
type Unfinished = Pick<ShaderScript, 'stages' | 'isSky' | 'polygonOffset' | 'sort'>;

/** An implicit shader's, or the default's: stages, and nothing else said. */
const unscripted = (stages: ShaderStage[]): Unfinished => ({
  stages,
  isSky: false,
  polygonOffset: false,
  sort: 0
});

/**
 * A shader finished as `FinishShader` finishes it (`tr_shader.c:2203-2383`):
 * - its sort: a sky's, whatever was said; a decal's for `polygonOffset` where none was said;
 * - each stage in turn: one with no image warned of, and the drawing stopping there; a `detail`
 *   stage dropped without `r_detailtextures`; its coordinates `lightmap` for the lightmap and
 *   `texture` otherwise, where none were said; and where it and the first stage blend, its fog
 *   adjustment, and where nothing sorted the shader yet, a see-through sort if it writes depth and
 *   a blend's if not;
 * - opaque, if nothing sorted it; the first two stages merged; a lightmap index kept only with a
 *   lightmap stage; and a fog's sort with no stages but a sky.
 */
function finish(
  name: string,
  shader: Unfinished,
  lightmapIndex: number,
  sources: ShaderSources,
  switches: FinishSwitches
): Pick<WorldShader, 'sort' | 'stages' | 'fogAdjustments' | 'lightmapIndex'> {
  let sort = shader.isSky ? SS_ENVIRONMENT : shader.sort;
  if (shader.polygonOffset && !sort) sort = SS_DECAL;

  const stages = [...shader.stages];
  /** The first stage with no image, which the drawing stops at. */
  let drawn = Infinity;
  let hasLightmapStage = false;
  const adjustments: FogAdjustment[] = [];
  for (let i = 0; i < stages.length; ) {
    let stage = stages[i];
    if (stage.maps.length === 0) {
      sources.warn(`Shader ${name} has a stage with no image\n`);
      drawn = Math.min(drawn, i);
      adjustments.push('none');
      i++;
      continue;
    }
    if (stage.detail && switches.detailTextures === false) {
      stages.splice(i, 1);
      continue;
    }
    if (!stage.tcGen) {
      stage = { ...stage, tcGen: isLightmapStage(stage) ? 'lightmap' : 'texture' };
      stages[i] = stage;
    }
    if (isLightmapStage(stage)) hasLightmapStage = true;
    adjustments.push(fogAdjustment(stage, stages[0]));
    if (stage.blendFactors && stages[0].blendFactors && !sort) {
      sort = stage.depthWrite ? SS_SEE_THROUGH : SS_BLEND0;
    }
    i++;
  }
  if (!sort) sort = SS_OPAQUE;

  const finished = stages.slice(0, drawn);
  const fogAdjustments = adjustments.slice(0, finished.length);
  const merged = collapseMultitexture(finished, switches);
  if (merged.length < finished.length) fogAdjustments.splice(1, 1);
  if (stages.length === 0 && !shader.isSky) sort = SS_FOG;
  const kept = lightmapIndex >= 0 && !hasLightmapStage ? LIGHTMAP_NONE : lightmapIndex;
  return { sort, stages: merged, fogAdjustments, lightmapIndex: kept };
}

/**
 * Load the fogs as `R_LoadFogs` does, each fog's shader found at {@link LIGHTMAP_NONE}. Then
 * register every surface's shader in lump order, as `R_LoadSurfaces` does, and check each surface
 * in Q3's words.
 *
 * Last, make each shader a swap of a shader the map has would draw instead and register, as
 * `R_RemapShader` registers one the map hasn't got, at lightmap 0 (`tr_shader.c:84-88`). Made
 * ahead, it is registered only when a swap asks for it: no name finds it until then, and the
 * warnings its parse gave are printed then. One whose parse drops the map is left to the swap.
 *
 * @param fullbright - `r_fullbright`: every surface asks at {@link LIGHTMAP_WHITEIMAGE}.
 * @param switches - Whether stages merge, and whether `detail` stages draw; by default no stage
 *   merges and every one draws.
 * @param swaps - The swaps the map's entities can make, their names as cgame cuts them.
 * @throws as `loadFogs` throws for a fog's brush; `Bad surfaceType` for a surface of no known type,
 *   `ShaderForShaderNum: bad num <n>` for one naming a shader the map hasn't got, and `Bad index in
 *   triangle surface` for a triangle soup indexing outside its own vertices; a shader's `ERR_DROP`
 *   as its parse gave it; and in the port's own words for a surface other than a flare in a fog the
 *   map hasn't got, which Q3 reads past
 */
export function loadWorldShaders(
  bsp: Bsp,
  sources: ShaderSources,
  fullbright = false,
  switches: FinishSwitches = NO_MULTITEXTURE,
  swaps: readonly ShaderSwap[] = []
): WorldShaders {
  const numLightmaps = lightmapCount(bsp.lightmaps.length);
  const shaders: WorldShader[] = [];
  /** By the name in lower case, as Q3 hashes and compares names; the latest made last. */
  const byName = new Map<string, WorldShader[]>();
  /**
   * The shaders made ahead of a swap, by the name and index a registration would ask for them at,
   * which may not be the index they keep.
   */
  const madeAhead = new Map<string, WorldShader>();
  /** Those not registered yet, which no lookup finds, with the warnings their parse gave. */
  const unregistered = new Map<WorldShader, string[]>();
  /** Where the warnings of a shader being made ahead are held, while it is. */
  let held: string[] | null = null;
  /** Whether a registration for a place alone is being made, whose warnings go unprinted. */
  let quiet = false;
  const aheadKey = (name: string, lightmapIndex: number) =>
    `${stripExtension(name).toLowerCase()}@${lightmapIndex}`;
  const own: ShaderSources = {
    scripts: sources.scripts,
    hasImage: (name) => sources.hasImage(name),
    warn: (text) => {
      if (quiet) return;
      if (held) held.push(text);
      else sources.warn(text);
    }
  };
  /** Whether the load is done, after which a shader made is sorted in at once. */
  let loaded = false;
  let generation = 0;
  /** `SortNewShader`: by sort, and among one sort by registration. */
  const sortShaders = () => {
    const sorted = [...shaders].sort((a, b) => a.sort - b.sort || a.index - b.index);
    sorted.forEach((shader, place) => (shader.sortedIndex = place));
    generation++;
  };
  /**
   * `GeneratePermanentShader`: the next place in `tr.shaders`, and the fog pass by the shader's
   * sort and its `surfaceparm fog` (`tr_shader.c:2049-2053`).
   */
  const permanent = (
    shader: Omit<WorldShader, 'index' | 'sortedIndex' | 'fogPass' | 'remappedShader' | 'timeOffset'>
  ): WorldShader => {
    const { sort, script } = shader;
    const fogPass: FogPass =
      sort <= SS_OPAQUE ? 'equal' : script?.surfaceParms.includes('fog') ? 'lessEqual' : 'none';
    const made: WorldShader = {
      ...shader,
      index: shaders.length,
      sortedIndex: 0,
      fogPass,
      remappedShader: null,
      timeOffset: 0
    };
    shaders.push(made);
    if (loaded) sortShaders();
    return made;
  };
  const defaultShader = permanent({
    name: DEFAULT_SHADER,
    defaultShader: false,
    ...finish(DEFAULT_SHADER, unscripted(DEFAULT_STAGES), LIGHTMAP_NONE, own, switches)
  });
  /** The height the clouds' table was last made at (`R_InitSkyTexCoords`). */
  let cloudHeight: number | undefined;
  /** `tr.sunDirection`, as the last parse with a `q3map_sun` set it. */
  let sunDirection: [number, number, number] | undefined;

  /** `R_FindShader`: a shader of this name made at this index, or made now. */
  const findWorldShader = (asked: string, askedIndex: number): WorldShader => {
    if (asked === '') return defaultShader;
    let lightmapIndex = askedIndex;
    if (lightmapIndex >= numLightmaps) {
      lightmapIndex = LIGHTMAP_BY_VERTEX;
    } else if (lightmapIndex < LIGHTMAP_2D) {
      own.warn(`WARNING: shader '${asked}' has invalid lightmap index of ${lightmapIndex}\n`);
      lightmapIndex = LIGHTMAP_BY_VERTEX;
    }
    const name = stripExtension(asked);
    const key = name.toLowerCase();
    const named = byName.get(key) ?? [];
    // A failed shader answers to its name at any index. Q3's hash chains put the latest first.
    for (let i = named.length - 1; i >= 0; i--) {
      const shader = named[i];
      if (shader.lightmapIndex === lightmapIndex || shader.defaultShader) return shader;
    }

    const found = findShader(sources.scripts, name);
    let made: WorldShader;
    if (found) {
      const script = parseShader(found, name, (image) => sources.hasImage(image));
      for (const warning of script.warnings) own.warn(warning);
      if (script.drop !== undefined) throw new Error(script.drop);
      // The world's sky is the map's: one made ahead leaves its clouds alone.
      if (script.sky?.cloudHeight !== undefined && !held) cloudHeight = script.sky.cloudHeight;
      if (script.sunDirection && !held) sunDirection = script.sunDirection;
      made = permanent({
        name,
        ...finish(name, script, lightmapIndex, own, switches),
        defaultShader: !script.ok,
        script
      });
      if (script.isSky) {
        const box = skyBox(script.sky?.outerBox, sources);
        made.sky = box ? { box } : {};
      }
      if (script.fogParms) {
        const { color, depthForOpaque } = script.fogParms;
        made.fogParms = { color: [...color], depthForOpaque };
      }
    } else if (sources.hasImage(asked)) {
      const stages = implicitStages(asked, lightmapIndex);
      made = permanent({
        name,
        ...finish(name, unscripted(stages), lightmapIndex, own, switches),
        defaultShader: false
      });
    } else {
      // "Couldn't find image file for shader", a developer's line only (`tr_shader.c:2598-2603`).
      made = permanent({
        name,
        ...finish(name, unscripted([]), lightmapIndex, own, switches),
        defaultShader: true
      });
    }
    if (held) unregistered.set(made, held);
    named.push(made);
    byName.set(key, named);
    return made;
  };

  /** Every registered shader of this name. */
  const variants = (name: string): WorldShader[] => {
    const named = byName.get(stripExtension(name).toLowerCase()) ?? [];
    return named.filter((shader) => !unregistered.has(shader));
  };
  const findByName = (name: string): WorldShader => {
    if (name === '') return defaultShader;
    return variants(name).at(-1) ?? defaultShader;
  };
  const register = (name: string, lightmapIndex: number, placeOnly = false): WorldShader => {
    if (name.length >= MAX_QPATH) {
      if (!placeOnly) sources.warn('Shader name exceeds MAX_QPATH\n');
      return defaultShader;
    }
    // One made ahead is the one this registration makes, registered now.
    const ahead = madeAhead.get(aheadKey(name, lightmapIndex));
    const warnings = ahead ? unregistered.get(ahead) : undefined;
    let shader: WorldShader;
    if (ahead && warnings) {
      unregistered.delete(ahead);
      if (!placeOnly) for (const warning of warnings) sources.warn(warning);
      shader = ahead;
    } else if (placeOnly) {
      quiet = true;
      try {
        shader = findWorldShader(name, lightmapIndex);
      } catch {
        shader = defaultShader;
      } finally {
        quiet = false;
      }
    } else {
      shader = findWorldShader(name, lightmapIndex);
    }
    return shader.defaultShader ? defaultShader : shader;
  };

  /**
   * `ShaderForShaderNum`, the default's index standing in for a shader that failed.
   *
   * @param lightmapNum - The lightmap index the surface asks at.
   */
  const shaderForShaderNum = (shaderNum: number, lightmapNum: number): number => {
    if (shaderNum < 0 || shaderNum >= bsp.shaders.length) {
      throw new Error(`ShaderForShaderNum: bad num ${shaderNum}`);
    }
    const asked = fullbright ? LIGHTMAP_WHITEIMAGE : lightmapNum;
    const shader = findWorldShader(bsp.shaders[shaderNum].shader, asked);
    return shader.defaultShader ? defaultShader.index : shader.index;
  };

  const fogs = loadFogs(bsp, (name) => findWorldShader(name, LIGHTMAP_NONE));

  const surfaceShaders = new Int32Array(bsp.surfaces.length);
  bsp.surfaces.forEach((surface, i) => {
    switch (surface.surfaceType) {
      case MST_PLANAR:
        surfaceShaders[i] = shaderForShaderNum(surface.shaderNum, surface.lightmapNum);
        if (surface.numVerts > MAX_FACE_POINTS) {
          // Q3 also cuts the face's points to 64 and leaves its indexes reading past them; the
          // port keeps them all.
          sources.warn(`WARNING: MAX_FACE_POINTS exceeded: ${surface.numVerts}\n`);
          surfaceShaders[i] = defaultShader.index;
        }
        break;
      case MST_TRIANGLE_SOUP: {
        surfaceShaders[i] = shaderForShaderNum(surface.shaderNum, LIGHTMAP_BY_VERTEX);
        const { firstIndex, numIndexes, numVerts } = surface;
        for (let n = firstIndex; n < firstIndex + numIndexes; n++) {
          const index = bsp.drawIndexes[n];
          if (index < 0 || index >= numVerts) throw new Error('Bad index in triangle surface');
        }
        break;
      }
      case MST_PATCH:
        surfaceShaders[i] = shaderForShaderNum(surface.shaderNum, surface.lightmapNum);
        break;
      case MST_FLARE:
        surfaceShaders[i] = shaderForShaderNum(surface.shaderNum, LIGHTMAP_BY_VERTEX);
        break;
      default:
        throw new Error('Bad surfaceType');
    }
    // A flare is not drawn here, and retail maps' flares often name a fog the map hasn't got.
    const { fogNum } = surface;
    if (surface.surfaceType !== MST_FLARE && (fogNum < -1 || fogNum >= fogs.length)) {
      throw new Error(`R_LoadSurfaces: surface ${i}'s fog ${fogNum} lies outside the fogs`);
    }
  });

  // Each swap of a shader the map has, to the new name's last registered shader, or to one made
  // ahead at lightmap 0.
  const swapTargets = new Map<WorldShader, WorldShader[]>();
  for (const { oldShader, newShader } of swaps) {
    const swapped = variants(oldShader);
    if (swapped.length === 0) continue;
    let target = findByName(newShader);
    if (target === defaultShader) {
      const key = aheadKey(newShader, 0);
      if (!madeAhead.has(key)) {
        held = [];
        try {
          const made = findWorldShader(newShader, 0);
          if (unregistered.has(made)) madeAhead.set(key, made);
        } catch {
          // Its drop is the swap's to make.
        } finally {
          held = null;
        }
      }
      const ahead = madeAhead.get(key);
      if (!ahead) continue;
      target = ahead;
    }
    for (const shader of swapped) {
      const targets = swapTargets.get(shader) ?? [];
      if (shader !== target && !targets.includes(target)) targets.push(target);
      swapTargets.set(shader, targets);
    }
  }

  sortShaders();
  loaded = true;
  const loadedCount = shaders.length;
  const aheadWarnings = new Map(unregistered);
  const reset = () => {
    shaders.length = loadedCount;
    for (const [key, named] of byName) {
      byName.set(key, named.filter((shader) => shader.index < loadedCount));
    }
    unregistered.clear();
    for (const [shader, warnings] of aheadWarnings) unregistered.set(shader, warnings);
    for (const shader of shaders) {
      shader.remappedShader = null;
      shader.timeOffset = 0;
    }
    sortShaders();
  };
  return {
    shaders,
    surfaceShaders,
    cloudHeight,
    sunDirection,
    fogs,
    swapTargets,
    findByName,
    register,
    variants,
    reset,
    get generation() {
      return generation;
    }
  };
}
