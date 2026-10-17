import { atof } from './c-scan';

/**
 * Quake 3's shader scripts, read as opengl1 reads them (`renderer/tr_shader.c`).
 *
 * `ScanAndLoadShaderFiles` (`:2948-3096`) checks each file's braces, joins the files that pass
 * into one text and compresses it (`COM_Compress`, `q_shared.c:392-459`); a name's first
 * definition in that text is the one found. `ParseShader` (`:1440-1675`) then reads a definition
 * token by token as `COM_ParseExt` (`q_shared.c:461-571`) cuts them, every keyword and kind it
 * knows with its numbers by `atof` into C's types, its defaults and its order rules, warning where
 * Q3 warns. Where Q3's parse fails, the shader fails ({@link ShaderScript.ok}), and Q3 draws its
 * default shader in its place.
 *
 * Every script is read once at load with every image taken to be there, which is what a model or
 * an effect draws from. The world reads a shader again with its images looked up
 * ({@link parseShader}), as `R_FindShader` reads it each time it makes one.
 *
 * Not read: what Q3 does beside the shader, but for the sun a `q3map_sun` sets. `videoMap` names a
 * cinematic, which the port has no player for, so its stage gets no image. `r_greyscale`, which
 * greys a fog's colour as it is read, is not a cvar of the port's.
 *
 * Directives are matched case-insensitively, as the game's own parser does.
 */

/** How a stage composites, reduced to the four modes the renderer needs to distinguish. */
export type ShaderBlend =
  /** No blend: writes colour and depth. */
  | 'opaque'
  /** `GL_ONE GL_ONE`: beams, flashes, explosions. */
  | 'add'
  /** Any other blend: `GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA` for decals and smoke, and the rest. */
  | 'blend'
  /** `GL_DST_COLOR GL_ZERO` and `GL_ZERO GL_SRC_COLOR`: multiplies the framebuffer. */
  | 'filter';

/**
 * A waveform's function (`genFunc_t`, `tr_local.h:119-130`). `none` is a wave whose function was
 * never read. Q3 has a table for neither it nor `noise`, and drops the map where one is drawn, but
 * for an `rgbGen wave noise`, which reads the noise (`tr_shade_calc.c:29-50, 677-707`).
 */
export type WaveFunc =
  | 'none'
  | 'sin'
  | 'square'
  | 'triangle'
  | 'sawtooth'
  | 'inversesawtooth'
  | 'noise';

/**
 * A Q3 waveform (`waveForm_t`, `tr_local.h:197-204`): `base + amplitude · func(phase + t ·
 * frequency)`, each number a float. A field the parse never reached is 0.
 */
export interface Wave {
  func: WaveFunc;
  base: number;
  amplitude: number;
  phase: number;
  frequency: number;
}

/**
 * A `deformVertexes wave` (`ParseDeform`, `tr_shader.c:1181-1203`): every vertex pushed along its
 * normal by the wave. Each powerup's shell swells off its body so.
 */
export interface WaveDeform {
  type: 'wave';
  /** `1 / div`, in a float: how far the wave's phase moves on for each unit of `x + y + z`. */
  spread: number;
  wave: Wave;
}

/**
 * A `deformVertexes normal <amplitude> <frequency>` (`tr_shader.c:1205-1225`): each normal bent by
 * noise that drifts with time, for a mirror that shimmers. The vertices stay where they are.
 */
export interface NormalDeform {
  type: 'normal';
  amplitude: number;
  frequency: number;
}

/**
 * A `deformVertexes bulge <width> <height> <speed>` (`tr_shader.c:1152-1179`): a sine running
 * along the surface's first texture coordinate pushes each vertex along its normal.
 */
export interface BulgeDeform {
  type: 'bulge';
  /** Radians of the sine a unit of the coordinate spans. */
  width: number;
  /** How far the sine's crest pushes. */
  height: number;
  /** Radians a second the sine moves on. */
  speed: number;
}

/**
 * A `deformVertexes move <x> <y> <z> <wave>` (`tr_shader.c:1227-1242`): the whole surface moved
 * along the vector, scaled by the wave.
 */
export interface MoveDeform {
  type: 'move';
  vector: readonly [number, number, number];
  wave: Wave;
}

/**
 * `deformVertexes autosprite` and `autosprite2` (`tr_shader.c:1131-1139`). Every four vertices are
 * taken as a quad and turned to the viewer: rebuilt as a square facing it, or, for `autosprite2`,
 * pivoted about the quad's long axis.
 */
export interface SpriteDeform {
  type: 'autosprite' | 'autosprite2';
}

/**
 * `deformVertexes projectionShadow` (`tr_shader.c:1126-1129`): the surface flattened onto the
 * plane its entity casts a shadow on, along its light.
 */
export interface ShadowDeform {
  type: 'projectionShadow';
}

/**
 * `deformVertexes text0` to `text7` (`tr_shader.c:1141-1150`): the surface rebuilt as the scene's
 * text of that number, a quad a character. A name past `text7` is `text0`.
 */
export interface TextDeform {
  type: 'text';
  index: number;
}

/**
 * A slot a `deformVertexes` took but never set (`DEFORM_NONE`): its kind unknown or its numbers
 * short. It deforms nothing.
 */
export interface NoDeform {
  type: 'none';
}

/** A shader's deform, in the slot order Q3 runs them (`RB_DeformTessGeometry`). */
export type Deform =
  | WaveDeform
  | NormalDeform
  | BulgeDeform
  | MoveDeform
  | SpriteDeform
  | ShadowDeform
  | TextDeform
  | NoDeform;

/** Whether a deform turns its quads to the viewer, and so reads four vertices at a time. */
export function isSpriteDeform(deform: Deform): deform is SpriteDeform {
  return deform.type === 'autosprite' || deform.type === 'autosprite2';
}

/** `MAX_SHADER_DEFORMS` (`tr_local.h:219`): the deforms a shader keeps. */
export const MAX_SHADER_DEFORMS = 3;

/** `MAX_SHADER_STAGES` (`tr_local.h:117`): a ninth stage fails the shader. */
export const MAX_SHADER_STAGES = 8;

/** `TR_MAX_TEXMODS` (`tr_local.h:206`): a fifth `tcMod` in a stage drops the map. */
export const TR_MAX_TEXMODS = 4;

/** `MAX_IMAGE_ANIMATIONS` (`tr_local.h:258`): the frames an `animMap` keeps. */
export const MAX_IMAGE_ANIMATIONS = 8;

/** `shaderSort_t` (`tr_local.h:89-114`): where a shader draws among the others, lowest first. */
export const SS_BAD = 0;
export const SS_PORTAL = 1;
export const SS_ENVIRONMENT = 2;
export const SS_OPAQUE = 3;
export const SS_DECAL = 4;
export const SS_SEE_THROUGH = 5;
export const SS_BANNER = 6;
export const SS_FOG = 7;
export const SS_UNDERWATER = 8;
export const SS_BLEND0 = 9;
export const SS_BLEND1 = 10;
export const SS_BLEND2 = 11;
export const SS_BLEND3 = 12;
export const SS_BLEND6 = 13;
export const SS_STENCIL_SHADOW = 14;
export const SS_ALMOST_NEAREST = 15;
export const SS_NEAREST = 16;

/** The sorts `ParseSort` knows by name (`tr_shader.c:1328-1348`); any other reads as a number. */
const SORT_NAMES: ReadonlyMap<string, number> = new Map([
  ['portal', SS_PORTAL],
  ['sky', SS_ENVIRONMENT],
  ['opaque', SS_OPAQUE],
  ['decal', SS_DECAL],
  ['seethrough', SS_SEE_THROUGH],
  ['banner', SS_BANNER],
  ['additive', SS_BLEND1],
  ['nearest', SS_NEAREST],
  ['underwater', SS_UNDERWATER]
]);

/**
 * How a stage colours itself (`colorGen_t`, `tr_local.h:165-178`). `wave` carries its waveform in
 * {@link ShaderStage.rgbWave}, and `const` its colour in {@link ShaderStage.constantColor}.
 */
export type RgbGen =
  | 'identityLighting'
  | 'identity'
  | 'entity'
  | 'oneMinusEntity'
  | 'exactVertex'
  | 'vertex'
  | 'oneMinusVertex'
  | 'wave'
  | 'lightingDiffuse'
  | 'const';

/**
 * How a stage's alpha is made (`alphaGen_t`, `tr_local.h:152-163`). `skip` leaves what its colour
 * gave. `wave` carries its waveform in {@link ShaderStage.alphaWave}, `const` its value in
 * {@link ShaderStage.constantColor}, and `portal` its range in {@link ShaderScript.portalRange}.
 */
export type AlphaGen =
  | 'identity'
  | 'skip'
  | 'entity'
  | 'oneMinusEntity'
  | 'vertex'
  | 'oneMinusVertex'
  | 'lightingSpecular'
  | 'wave'
  | 'portal'
  | 'const';

/**
 * Where a texture's coordinates come from (`texCoordGen_t`, `tr_local.h:180-188`): the surface's
 * lightmap coordinates, its own, the view mirrored in each normal, or each position's distance
 * along two vectors.
 */
export type TcGen = 'lightmap' | 'texture' | 'environment' | 'vector';

/**
 * A texture-coordinate modifier (`texModInfo_t`, `tr_local.h:233-255`), in a float a number:
 * - `scroll`, in repeats a second along s and t; `scale` multiplies them;
 * - `transform`, `s' = s·m00 + t·m10 + t0` and `t' = s·m01 + t·m11 + t1`, its matrix in the
 *   order written, `m00 m01 m10 m11`;
 * - `turb`, each vertex moved by a sine of its own position, always the sine table's;
 * - `entityTranslate`, a scroll by the entity's own;
 * - `none`, a slot whose `tcMod` did not read, which stops the modifiers after it
 *   (`tr_shade.c:878-880`).
 *
 * A `tcMod` that fails to read keeps, in Q3, what an earlier shader left in its slot of a static
 * array (`tr_shader.c:32`, `2180-2193`). The port's slot is empty.
 */
export type TexMod =
  | { type: 'none' }
  | {
      type: 'transform';
      matrix: readonly [number, number, number, number];
      translate: readonly [number, number];
    }
  | { type: 'turb'; wave: Wave }
  | { type: 'scroll'; s: number; t: number }
  | { type: 'scale'; s: number; t: number }
  | { type: 'stretch'; wave: Wave }
  | { type: 'rotate'; degreesPerSecond: number }
  | { type: 'entityTranslate' };

/**
 * `alphaFunc`'s three tests (`NameToAFunc`, `tr_shader.c:153-170`): a texel is drawn if its alpha
 * is above 0, below 0.5, or at least 0.5 (`GL_State`, `tr_backend.c:346-363`).
 */
export type AlphaFunc = 'GT0' | 'LT128' | 'GE128';

/**
 * A stage's texture and how it is placed on a surface (`textureBundle_t`, `tr_local.h:260-274`):
 * its images, how fast they flip, whether they clamp, whether it is the lightmap, and its
 * coordinates.
 */
export type StageTexture = Pick<
  ShaderStage,
  'maps' | 'animFps' | 'clamp' | 'lightmap' | 'tcGen' | 'tcGenVectors' | 'texMods' | 'videoMap'
>;

/**
 * The second texture of a stage merged from two (`bundle[1]`), and how it meets the first
 * (`multitextureEnv`, `tr_local.h:351`): multiplied into it or added to it, after the stage's
 * colour has been multiplied in.
 */
export interface Multitexture extends StageTexture {
  env: 'modulate' | 'add';
}

/** One rendering pass of a shader (`shaderStage_t`, `tr_local.h:278-296`). */
export interface ShaderStage {
  /**
   * The images it draws, as `R_BindAnimatedImage` picks among them: the one, or an `animMap`'s
   * frames, up to 8. `$lightmap` and `$whiteimage` are kept as named. None for a stage with no
   * image.
   */
  maps: string[];
  /** Flipbook rate in frames per second, in a float; 0 for a stage with no `animMap`. */
  animFps: number;
  /** `map $lightmap`: the stage draws the lightmap (`isLightmap`). */
  lightmap?: boolean;
  blend: ShaderBlend;
  /**
   * Its blend's two factors as Q3 names them, lowercased: the source's, then the framebuffer's
   * (`tr_shader.c:178-262`), a name Q3 doesn't know read as `gl_one`, and a shorthand standing for
   * its pair. Absent with no blend, which `GL_ONE GL_ZERO` is too (`:1067-1072`). The framebuffer's
   * is absent where a `blendFunc` named a source and no framebuffer factor came after it, which
   * Q3 drops the map for when it draws (`GL_State`, `tr_backend.c:284-286`).
   */
  blendFactors?: readonly [string, string | undefined];
  /** `alphaFunc`, absent when the stage tests nothing. */
  alphaFunc?: AlphaFunc;
  /** Whether it writes depth: off for a blend unless `depthWrite` says so. */
  depthWrite: boolean;
  /**
   * False for a stage drawn with no depth test (`GLS_DEPTHTEST_DISABLE`). No keyword asks for it:
   * only a shader Q3 makes itself has one.
   */
  depthTest?: boolean;
  /** `depthFunc equal`: drawn only where the depth is the same; `lequal` by default. */
  depthFunc?: 'equal';
  /** `detail`: dropped where `r_detailtextures` is 0. */
  detail?: boolean;
  /** `clampMap` rather than `map`: the texture stops at its edges instead of repeating. */
  clamp: boolean;
  /** `tcGen`; absent where none was said, which `FinishShader` makes `lightmap` or `texture`. */
  tcGen?: TcGen;
  /** `tcGen vector`'s two vectors, each position's s and t its dot with them. */
  tcGenVectors?: readonly [readonly [number, number, number], readonly [number, number, number]];
  /** Its `tcMod`s in declaration order, which is the order Q3 applies them in: one a slot. */
  texMods: TexMod[];
  /** `videoMap`'s cinematic, which the port does not play. */
  videoMap?: string;
  /** `rgbGen`, or where the stage names none, the default Q3 gives its blend (`:1053-1061`). */
  rgbGen: RgbGen;
  /** `rgbGen wave`'s waveform. */
  rgbWave?: Wave;
  /**
   * `alphaGen`; absent is `identity`, which a stage at `rgbGen identity` or `lightingDiffuse` gives
   * as `skip` (`:1075-1080`). `rgbGen vertex` brings `vertex` where none was said before it.
   */
  alphaGen?: AlphaGen;
  /** `alphaGen wave`'s waveform. */
  alphaWave?: Wave;
  /**
   * `rgbGen const`'s colour and `alphaGen const`'s alpha, as the bytes Q3 keeps, `255 ·` each
   * value wrapped to a byte: none where neither was said.
   */
  constantColor?: readonly [number, number, number, number];
  /**
   * A second texture drawn in the same pass, where two stages were merged into one
   * (`CollapseMultitexture`, `tr_shader.c:1810-1917`). A script never sets it.
   */
  multitexture?: Multitexture;
}

/** A sky's parameters, as the shader's `skyParms` left them (`ParseSkyParms`, `:1255-1311`). */
export interface ShaderSky {
  /** The last outer box named; `-` names none. Its faces are `<outerBox>_<suffix>.tga`. */
  outerBox?: string;
  /** The last cloud height read, 0 being 512, in a float. */
  cloudHeight?: number;
}

/** A shader's fog (`fogParms_t`, `tr_local.h:317-320`), as its parse left it. */
export interface ShaderFog {
  /** Each channel by `atof`, in a float; 0 where the parse never reached it. */
  color: [number, number, number];
  /** By `atof`, in a float; 0 where the line ended before it. */
  depthForOpaque: number;
}

/** A parsed shader definition (`shader_t`, `tr_local.h:323-379`). */
export interface ShaderScript {
  /** Shader name as written, lowercased: this is the key MD3 surfaces reference. */
  name: string;
  /**
   * Whether `ParseShader` took it. Where it did not, the fields hold what the parse reached, the
   * stage it failed in last, and Q3 draws its default shader for it.
   */
  ok: boolean;
  /** The `ERR_DROP` the parse stopped at: a fifth `tcMod` in a stage. */
  drop?: string;
  /** The warnings its parse printed, in order, each a line as `ri.Printf` prints it. */
  warnings: string[];
  cull: 'front' | 'back' | 'none';
  stages: ShaderStage[];
  /** True if any stage is additive; the fast test the effect renderers actually ask. */
  additive: boolean;
  /**
   * Its `deformVertexes`, one a slot, in order: run over a model's vertices before anything is
   * drawn. Q3 keeps three slots; see {@link MAX_SHADER_DEFORMS}.
   *
   * The BFG ball's `bfg01` is an `autosprite`, which Q3 turns to the viewer every frame. Drawn
   * as ordinary geometry, a flat quad on a projectile flying away turns edge-on and collapses to
   * a line. (The rocket has none: its glow is a disc facing backwards, so a rocket flying away
   * shows it face-on.)
   */
  deforms: Deform[];
  /** Its sort as written, by `sort` or `portal`, in a float; 0 for none: FinishShader sorts it. */
  sort: number;
  /** `polygonOffset`: drawn pulled towards the viewer, and sorted as a decal unless sorted. */
  polygonOffset: boolean;
  /** `clampTime`, a double: the time its stages stop at; 0 for none. */
  clampTime: number;
  /** `alphaGen portal`'s range, in a float: the distance its alpha reaches 1 at; 0 for none. */
  portalRange: number;
  /**
   * `nomipmaps`: the shader's textures upload without mipmaps, so thin bright detail stays sharp
   * at a distance instead of averaging away. The BFG ball's trail is one.
   */
  noMipMaps: boolean;
  /** `nopicmip`, or `nomipmaps`, which implies it: its images keep their size under `r_picmip`. */
  noPicMip: boolean;
  /**
   * `entityMergable`: its sprites from separate entities draw as one batch, as smoke and blood
   * puffs do; any other shader's are a batch an entity (`tr_backend.c:544-547`).
   */
  entityMergable: boolean;
  /** What its `skyParms` left; none where it has none. */
  sky?: ShaderSky;
  /** `isSky`: a `skyParms` read all three parameters. Its surfaces are then drawn as a sky. */
  isSky: boolean;
  /** What its `fogParms` left; none where it has none. */
  fogParms?: ShaderFog;
  /**
   * The sun its last `q3map_sun` or ioquake3's `q3map_sunExt` points to, unit, in floats; none
   * where it has none. Parsing one sets `tr.sunDirection` for every entity lit with no light grid.
   */
  sunDirection?: [number, number, number];
  /** The `surfaceparm`s Q3 knows, lowercased, in order (`ParseSurfaceParm`, `tr_shader.c:1411`). */
  surfaceParms: string[];
  /** Where its definition is, for {@link parseShader} to read it again. */
  source: ShaderSource;
}

/** A definition's place in the scripts' compressed text: just past its name. */
export interface ShaderSource {
  text: string;
  at: number;
}

/** A shader file: its path, for the warnings, and its text. */
export interface ShaderFile {
  name: string;
  text: string;
}

/** `MAX_TOKEN_CHARS` (`q_shared.h:235`): a longer word keeps its first 1,023 characters. */
const MAX_TOKEN_CHARS = 1024;

/**
 * A character as `COM_ParseExt` reads a `char`, 0 past the end. A byte past 127 is negative where
 * `char` is signed, as on x86, so it reads below a space: whitespace between tokens.
 */
function charAt(text: string, i: number): number {
  if (i >= text.length) return 0;
  const c = text.charCodeAt(i);
  return c > 127 ? -1 : c;
}

const NEWLINE = 10;
const RETURN = 13;
const SPACE = 32;
const TAB = 9;
const QUOTE = 34;
const STAR = 42;
const SLASH = 47;

/**
 * `COM_Compress` (`q_shared.c:392-459`): comments gone, each run of spaces one space and each run
 * of line breaks one, a quoted string copied as it is.
 */
export function compress(text: string): string {
  const out: string[] = [];
  let newline = false;
  let whitespace = false;
  let i = 0;
  while (i < text.length) {
    const c = charAt(text, i);
    if (c === SLASH && charAt(text, i + 1) === SLASH) {
      while (i < text.length && charAt(text, i) !== NEWLINE) i++;
    } else if (c === SLASH && charAt(text, i + 1) === STAR) {
      while (i < text.length && (charAt(text, i) !== STAR || charAt(text, i + 1) !== SLASH)) i++;
      if (i < text.length) i += 2;
    } else if (c === NEWLINE || c === RETURN) {
      newline = true;
      i++;
    } else if (c === SPACE || c === TAB) {
      whitespace = true;
      i++;
    } else {
      if (newline) {
        out.push('\n');
        newline = false;
        whitespace = false;
      }
      if (whitespace) {
        out.push(' ');
        whitespace = false;
      }
      if (c === QUOTE) {
        const end = text.indexOf('"', i + 1);
        const close = end < 0 ? text.length : end + 1;
        out.push(text.slice(i, close));
        i = close;
      } else {
        out.push(text[i]);
        i++;
      }
    }
  }
  return out.join('');
}

/**
 * Q3's tokenizer over a text, as its parse functions share it: `COM_ParseExt`, `SkipRestOfLine`
 * and `SkipBracedSection` (`q_shared.c:461-637`), and the line count its warnings give.
 */
class Tokens {
  readonly text: string;
  /** `*data_p`: where the next read begins, or none once a read ran off the end. */
  at: number | null;
  /** `com_lines`, from 1. */
  lines = 1;
  /** `com_tokenline`: the line the last token began on, 0 for none. */
  private tokenLine = 0;

  constructor(text: string, at = 0) {
    this.text = text;
    this.at = at;
  }

  /** `COM_GetCurrentParseLine`. */
  get line(): number {
    return this.tokenLine || this.lines;
  }

  /**
   * `COM_ParseExt`: the next token, or `''` at the end, or, where line breaks are not allowed, at
   * a line's end.
   */
  next(allowLineBreaks: boolean): string {
    const { text } = this;
    this.tokenLine = 0;
    if (this.at === null) return '';
    let data = this.at;
    let hasNewLines = false;
    let c: number;
    for (;;) {
      while ((c = charAt(text, data)) <= SPACE) {
        if (c === 0) {
          this.at = null;
          return '';
        }
        if (c === NEWLINE) {
          this.lines++;
          hasNewLines = true;
        }
        data++;
      }
      if (hasNewLines && !allowLineBreaks) {
        this.at = data;
        return '';
      }
      if (c === SLASH && charAt(text, data + 1) === SLASH) {
        data += 2;
        while (charAt(text, data) !== 0 && charAt(text, data) !== NEWLINE) data++;
      } else if (c === SLASH && charAt(text, data + 1) === STAR) {
        data += 2;
        const closes = () => charAt(text, data) === STAR && charAt(text, data + 1) === SLASH;
        while (charAt(text, data) !== 0 && !closes()) {
          if (charAt(text, data) === NEWLINE) this.lines++;
          data++;
        }
        if (charAt(text, data) !== 0) data += 2;
      } else {
        break;
      }
    }
    this.tokenLine = this.lines;

    if (c === QUOTE) {
      const start = data + 1;
      let end = start;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\n') this.lines++;
        end++;
      }
      this.at = end < text.length ? end + 1 : null;
      return text.slice(start, Math.min(end, start + MAX_TOKEN_CHARS - 1));
    }

    const start = data;
    do data++;
    while (charAt(text, data) > SPACE);
    this.at = data;
    return text.slice(start, Math.min(data, start + MAX_TOKEN_CHARS - 1));
  }

  /** `SkipRestOfLine`: past the next line break, or to the end. */
  skipRestOfLine(): void {
    if (this.at === null || this.at >= this.text.length) return;
    const end = this.text.indexOf('\n', this.at);
    if (end < 0) {
      this.at = null;
      return;
    }
    this.lines++;
    this.at = end + 1;
  }

  /**
   * `SkipBracedSection`: tokens until the braces opened, `depth` of them already, are closed.
   *
   * @returns Whether they closed before the end.
   */
  skipBracedSection(depth: number): boolean {
    do {
      const token = this.next(true);
      if (token === '{') depth++;
      else if (token === '}') depth--;
    } while (depth && this.at !== null);
    return depth === 0;
  }
}

/** C's `float`. */
const f32 = Math.fround;

/** A C float or double converted to a byte, as x86 converts one: truncated, then its low 8 bits. */
const toByte = (value: number): number => Math.trunc(value) & 255;

/** The `surfaceparm`s Q3 knows (`infoParms`, `tr_shader.c:1360-1401`). */
const INFO_PARMS = new Set([
  'water',
  'slime',
  'lava',
  'playerclip',
  'monsterclip',
  'nodrop',
  'nonsolid',
  'origin',
  'trans',
  'detail',
  'structural',
  'areaportal',
  'clusterportal',
  'donotenter',
  'fog',
  'sky',
  'lightfilter',
  'alphashadow',
  'hint',
  'slick',
  'noimpact',
  'nomarks',
  'ladder',
  'nodamage',
  'metalsteps',
  'flesh',
  'nosteps',
  'nodraw',
  'pointlight',
  'nolightmap',
  'nodlight',
  'dust'
]);

/** The factors `NameToSrcBlendMode` knows (`tr_shader.c:178-218`). */
const SOURCE_FACTORS = new Set([
  'gl_one',
  'gl_zero',
  'gl_dst_color',
  'gl_one_minus_dst_color',
  'gl_src_alpha',
  'gl_one_minus_src_alpha',
  'gl_dst_alpha',
  'gl_one_minus_dst_alpha',
  'gl_src_alpha_saturate'
]);

/** The factors `NameToDstBlendMode` knows (`tr_shader.c:226-262`). */
const FRAMEBUFFER_FACTORS = new Set([
  'gl_one',
  'gl_zero',
  'gl_src_alpha',
  'gl_one_minus_src_alpha',
  'gl_dst_alpha',
  'gl_one_minus_dst_alpha',
  'gl_src_color',
  'gl_one_minus_src_color'
]);

/** The shorthands' pairs (`ParseStage`, `tr_shader.c:811-819`). */
const SHORTHAND_FACTORS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ['add', ['gl_one', 'gl_one']],
  ['filter', ['gl_dst_color', 'gl_zero']],
  ['blend', ['gl_src_alpha', 'gl_one_minus_src_alpha']]
]);

/** The functions `NameToGenFunc` knows (`tr_shader.c:270-299`); any other is `sin`. */
const GEN_FUNCS: ReadonlyMap<string, WaveFunc> = new Map([
  ['sin', 'sin'],
  ['square', 'square'],
  ['triangle', 'triangle'],
  ['sawtooth', 'sawtooth'],
  ['inversesawtooth', 'inversesawtooth'],
  ['noise', 'noise']
]);

/** The `rgbGen` kinds `ParseStage` knows besides `wave` and `const` (`tr_shader.c:869-903`). */
const RGB_GENS: ReadonlyMap<string, RgbGen> = new Map([
  ['identity', 'identity'],
  ['identitylighting', 'identityLighting'],
  ['entity', 'entity'],
  ['oneminusentity', 'oneMinusEntity'],
  ['vertex', 'vertex'],
  ['exactvertex', 'exactVertex'],
  ['lightingdiffuse', 'lightingDiffuse'],
  ['oneminusvertex', 'oneMinusVertex']
]);

/**
 * The `alphaGen` kinds `ParseStage` knows besides `wave`, `const` and `portal`
 * (`tr_shader.c:933-956`).
 */
const ALPHA_GENS: ReadonlyMap<string, AlphaGen> = new Map([
  ['identity', 'identity'],
  ['entity', 'entity'],
  ['oneminusentity', 'oneMinusEntity'],
  ['vertex', 'vertex'],
  ['lightingspecular', 'lightingSpecular'],
  ['oneminusvertex', 'oneMinusVertex']
]);

/** The blend a pair of factors reduces to. */
function blendOf(source: string, framebuffer: string | undefined): ShaderBlend {
  if (source === 'gl_one' && framebuffer === 'gl_one') return 'add';
  if (source === 'gl_dst_color' && framebuffer === 'gl_zero') return 'filter';
  if (source === 'gl_zero' && framebuffer === 'gl_src_color') return 'filter';
  return 'blend';
}

/** A stage's texture slots as `ParseStage` fills them (`textureBundle_t`). */
interface Bundle {
  /** `image[]`: a name each slot, or none where the slot is empty. */
  images: (string | undefined)[];
  numImageAnimations: number;
  imageAnimationSpeed: number;
  /** Whether `image[0]` came from a `clampMap`. */
  clamp: boolean;
  isLightmap: boolean;
  tcGen?: TcGen;
  tcGenVectors: [number, number, number][];
  texMods: TexMod[];
  videoMap?: string;
}

/** A stage as `ParseStage` builds it, before its state is settled. */
interface StageState {
  bundle: Bundle;
  rgbGen?: RgbGen;
  rgbWave?: Wave;
  alphaGen?: AlphaGen;
  alphaWave?: Wave;
  constantColor?: [number, number, number, number];
  isDetail: boolean;
  /** `stateBits`' parts, settled where the stage closes. */
  depthMask: boolean;
  blendSource?: string;
  blendFramebuffer?: string;
  alphaFunc?: AlphaFunc;
  depthFunc?: 'equal';
}

/** Why `ParseShader` stopped: it failed, or it dropped the map. */
class ParseStop {
  readonly drop?: string;

  constructor(drop?: string) {
    this.drop = drop;
  }
}

/**
 * One run of `ParseShader` over a definition, into Q3's working `shader` and `stages`.
 */
class ShaderParse {
  readonly warnings: string[] = [];
  readonly script: Omit<ShaderScript, 'name' | 'ok' | 'warnings' | 'source'> = {
    cull: 'front',
    stages: [],
    additive: false,
    deforms: [],
    sort: 0,
    polygonOffset: false,
    clampTime: 0,
    portalRange: 0,
    noMipMaps: false,
    noPicMip: false,
    entityMergable: false,
    isSky: false,
    surfaceParms: []
  };

  private readonly tokens: Tokens;
  /** `shader.name`, which its warnings give. */
  private readonly name: string;
  private readonly hasImage: (name: string) => boolean;

  constructor(tokens: Tokens, name: string, hasImage: (name: string) => boolean) {
    this.tokens = tokens;
    this.name = name;
    this.hasImage = hasImage;
  }

  private warn(text: string): void {
    this.warnings.push(`WARNING: ${text}\n`);
  }

  private fail(text?: string): never {
    if (text !== undefined) this.warn(text);
    throw new ParseStop();
  }

  /** `ParseShader` (`tr_shader.c:1440-1675`): whether it took the definition. */
  parse(): boolean {
    const { tokens, name } = this;
    const shader = this.script;
    let token = tokens.next(true);
    if (token[0] !== '{') this.fail(`expecting '{', found '${token}' instead in shader '${name}'`);
    for (;;) {
      token = tokens.next(true);
      if (!token) this.fail(`no concluding '}' in shader ${name}`);
      const word = token.toLowerCase();
      if (token[0] === '}') break;
      if (token[0] === '{') {
        if (shader.stages.length >= MAX_SHADER_STAGES) {
          this.fail(`too many stages in shader ${name} (max is ${MAX_SHADER_STAGES})`);
        }
        this.parseStage();
      } else if (word.startsWith('qer')) {
        tokens.skipRestOfLine();
      } else if (word === 'q3map_sun' || word === 'q3map_sunext') {
        // `tr.sunLight`, its colour and intensity, lights nothing opengl1 draws.
        for (let i = 0; i < 4; i++) tokens.next(false);
        // Degrees to radians in a float, through a double `M_PI` (`tr_shader.c:1491-1521`).
        const radians = () => f32(f32(f32(atof(tokens.next(false))) / 180) * Math.PI);
        const a = radians();
        const b = radians();
        shader.sunDirection = [
          f32(Math.cos(a) * Math.cos(b)),
          f32(Math.sin(a) * Math.cos(b)),
          f32(Math.sin(b))
        ];
        tokens.skipRestOfLine();
      } else if (word === 'deformvertexes') {
        this.parseDeform();
      } else if (word === 'tesssize') {
        tokens.skipRestOfLine();
      } else if (word === 'clamptime') {
        token = tokens.next(false);
        if (token) shader.clampTime = atof(token);
      } else if (word.startsWith('q3map')) {
        tokens.skipRestOfLine();
      } else if (word === 'surfaceparm') {
        const parm = tokens.next(false).toLowerCase();
        if (INFO_PARMS.has(parm)) shader.surfaceParms.push(parm);
      } else if (word === 'nomipmaps') {
        shader.noMipMaps = true;
        shader.noPicMip = true;
      } else if (word === 'nopicmip') {
        shader.noPicMip = true;
      } else if (word === 'polygonoffset') {
        shader.polygonOffset = true;
      } else if (word === 'entitymergable') {
        shader.entityMergable = true;
      } else if (word === 'fogparms') {
        const fog = (shader.fogParms ??= { color: [0, 0, 0], depthForOpaque: 0 });
        if (!this.parseVector(3, fog.color)) this.fail();
        token = tokens.next(false);
        if (!token) {
          this.warn(`missing parm for 'fogParms' keyword in shader '${name}'`);
          continue;
        }
        fog.depthForOpaque = f32(atof(token));
        tokens.skipRestOfLine();
      } else if (word === 'portal') {
        shader.sort = SS_PORTAL;
      } else if (word === 'skyparms') {
        this.parseSkyParms();
      } else if (word === 'light') {
        tokens.next(false);
      } else if (word === 'cull') {
        token = tokens.next(false);
        const face = token.toLowerCase();
        if (!token) this.warn(`missing cull parms in shader '${name}'`);
        else if (face === 'none' || face === 'twosided' || face === 'disable') shader.cull = 'none';
        else if (['back', 'backside', 'backsided'].includes(face)) shader.cull = 'back';
        else this.warn(`invalid cull parm '${token}' in shader '${name}'`);
      } else if (word === 'sort') {
        this.parseSort();
      } else {
        this.fail(`unknown general shader parameter '${token}' in '${name}'`);
      }
    }
    return (
      shader.stages.length > 0 || shader.isSky || shader.surfaceParms.includes('fog')
    );
  }

  /**
   * `ParseVector` (`tr_shader.c:118-145`): a parenthesised vector off the line, each element read
   * into `v` as it comes.
   */
  private parseVector(count: number, v: number[]): boolean {
    const { tokens, name } = this;
    if (tokens.next(false) !== '(') {
      this.warn(`missing parenthesis in shader '${name}'`);
      return false;
    }
    for (let i = 0; i < count; i++) {
      const token = tokens.next(false);
      if (!token) {
        this.warn(`missing vector element in shader '${name}'`);
        return false;
      }
      v[i] = f32(atof(token));
    }
    if (tokens.next(false) !== ')') {
      this.warn(`missing parenthesis in shader '${name}'`);
      return false;
    }
    return true;
  }

  /** `ParseWaveForm` (`tr_shader.c:307-351`): a function and four numbers, up to its line's end. */
  private parseWaveForm(): Wave {
    const wave: Wave = { func: 'none', base: 0, amplitude: 0, phase: 0, frequency: 0 };
    const missing = () => this.warn(`missing waveform parm in shader '${this.name}'`);
    const token = this.tokens.next(false);
    if (!token) {
      missing();
      return wave;
    }
    wave.func = this.genFunc(token);
    for (const field of ['base', 'amplitude', 'phase', 'frequency'] as const) {
      const value = this.tokens.next(false);
      if (!value) {
        missing();
        return wave;
      }
      wave[field] = f32(atof(value));
    }
    return wave;
  }

  /** `NameToGenFunc`: a function by name, `sin` with a warning for one Q3 doesn't know. */
  private genFunc(token: string): WaveFunc {
    const func = GEN_FUNCS.get(token.toLowerCase());
    if (func) return func;
    this.warn(`invalid genfunc name '${token}' in shader '${this.name}'`);
    return 'sin';
  }

  /** `ParseSort` (`tr_shader.c:1319-1349`). */
  private parseSort(): void {
    const token = this.tokens.next(false);
    if (!token) {
      this.warn(`missing sort parameter in shader '${this.name}'`);
      return;
    }
    this.script.sort = SORT_NAMES.get(token.toLowerCase()) ?? f32(atof(token));
  }

  /**
   * `ParseSkyParms` (`tr_shader.c:1255-1311`): the outer box, the cloud height and the inner box
   * off the line. Each part read stays, and only all three make a sky.
   */
  private parseSkyParms(): void {
    const { tokens } = this;
    const missing = () => this.warn(`'skyParms' missing parameter in shader '${this.name}'`);
    const sky = (this.script.sky ??= {});
    let token = tokens.next(false);
    if (!token) return missing();
    if (token !== '-') sky.outerBox = token;
    token = tokens.next(false);
    if (!token) return missing();
    sky.cloudHeight = f32(atof(token)) || 512;
    token = tokens.next(false);
    if (!token) return missing();
    this.script.isSky = true;
  }

  /** `ParseDeform` (`tr_shader.c:1107-1245`): one slot taken once its kind is read. */
  private parseDeform(): void {
    const { tokens, name } = this;
    const shader = this.script;
    const token = tokens.next(false);
    if (!token) {
      this.warn(`missing deform parm in shader '${name}'`);
      return;
    }
    if (shader.deforms.length === MAX_SHADER_DEFORMS) {
      this.warn(`MAX_SHADER_DEFORMS in '${name}'`);
      return;
    }
    const slot = shader.deforms.length;
    shader.deforms.push({ type: 'none' });
    const set = (deform: Deform) => (shader.deforms[slot] = deform);
    const kind = token.toLowerCase();
    /** The next `count` numbers off the line, or none where the line ends first. */
    const numbers = (count: number, warning: string): number[] | undefined => {
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        const value = tokens.next(false);
        if (!value) {
          this.warn(`${warning} in shader '${name}'`);
          return undefined;
        }
        values.push(f32(atof(value)));
      }
      return values;
    };

    if (kind === 'projectionshadow') {
      set({ type: 'projectionShadow' });
    } else if (kind === 'autosprite' || kind === 'autosprite2') {
      set({ type: kind });
    } else if (kind.startsWith('text')) {
      const n = token.charCodeAt(4) - 48;
      set({ type: 'text', index: n >= 0 && n <= 7 ? n : 0 });
    } else if (kind === 'bulge') {
      const values = numbers(3, 'missing deformVertexes bulge parm');
      if (values) set({ type: 'bulge', width: values[0], height: values[1], speed: values[2] });
    } else if (kind === 'wave') {
      const div = tokens.next(false);
      if (!div) {
        this.warn(`missing deformVertexes parm in shader '${name}'`);
        return;
      }
      let spread = 100;
      if (atof(div) !== 0) spread = f32(1 / atof(div));
      else this.warn(`illegal div value of 0 in deformVertexes command for shader '${name}'`);
      set({ type: 'wave', spread, wave: this.parseWaveForm() });
    } else if (kind === 'normal') {
      const values = numbers(2, 'missing deformVertexes parm');
      if (values) set({ type: 'normal', amplitude: values[0], frequency: values[1] });
    } else if (kind === 'move') {
      const vector = numbers(3, 'missing deformVertexes parm');
      if (vector) {
        const [x, y, z] = vector;
        set({ type: 'move', vector: [x, y, z], wave: this.parseWaveForm() });
      }
    } else {
      this.warn(`unknown deformVertexes subtype '${token}' found in shader '${name}'`);
    }
  }

  /**
   * `R_FindImageFile` for a stage's image: whether it is there, warning and failing the shader
   * where it is not.
   */
  private findImage(image: string): void {
    if (this.hasImage(image)) return;
    this.fail(`R_FindImageFile could not find '${image}' in shader '${this.name}'`);
  }

  /** `ParseStage` (`tr_shader.c:589-1091`), its stage active once begun, as Q3's is. */
  private parseStage(): void {
    const { tokens, name } = this;
    const state: StageState = {
      bundle: {
        images: [],
        numImageAnimations: 0,
        imageAnimationSpeed: 0,
        clamp: false,
        isLightmap: false,
        tcGenVectors: [
          [0, 0, 0],
          [0, 0, 0]
        ],
        texMods: []
      },
      isDetail: false,
      depthMask: true
    };
    const { bundle } = state;
    let depthMaskExplicit = false;
    const stages = this.script.stages;
    const slot = stages.length;
    stages.push(unfinishedStage(state));
    try {
      for (;;) {
        let token = tokens.next(true);
        if (!token) {
          this.warnings.push("WARNING: no matching '}' found\n");
          throw new ParseStop();
        }
        if (token[0] === '}') break;
        const word = token.toLowerCase();
        /** A keyword's parameter, failing the shader where the line ends first. */
        const parameter = (keyword: string): string => {
          const value = tokens.next(false);
          if (!value) this.fail(`missing parameter for '${keyword}' keyword in shader '${name}'`);
          return value;
        };

        if (word === 'map') {
          token = parameter('map');
          const image = token.toLowerCase();
          if (image === '$whiteimage') {
            bundle.images[0] = token;
          } else if (image === '$lightmap') {
            bundle.isLightmap = true;
            bundle.images[0] = token;
          } else {
            bundle.images[0] = undefined;
            this.findImage(token);
            bundle.images[0] = token;
          }
          bundle.clamp = false;
        } else if (word === 'clampmap') {
          token = parameter('clampmap');
          bundle.images[0] = undefined;
          this.findImage(token);
          bundle.images[0] = token;
          bundle.clamp = true;
        } else if (word === 'animmap') {
          bundle.imageAnimationSpeed = f32(atof(parameter('animMap')));
          let totalImages = 0;
          while ((token = tokens.next(false))) {
            const num = bundle.numImageAnimations;
            if (num < MAX_IMAGE_ANIMATIONS) {
              bundle.images[num] = undefined;
              this.findImage(token);
              bundle.images[num] = token;
              if (num === 0) bundle.clamp = false;
              bundle.numImageAnimations++;
            }
            totalImages++;
          }
          if (totalImages > MAX_IMAGE_ANIMATIONS) {
            this.warn(
              `ignoring excess images for 'animMap' (found ${totalImages}, max is ` +
                `${MAX_IMAGE_ANIMATIONS}) in shader '${name}'`
            );
          }
        } else if (word === 'videomap') {
          bundle.videoMap = parameter('videoMap');
        } else if (word === 'alphafunc') {
          token = parameter('alphaFunc');
          const test = token.toUpperCase();
          if (test === 'GT0' || test === 'LT128' || test === 'GE128') {
            state.alphaFunc = test;
          } else {
            this.warn(`invalid alphaFunc name '${token}' in shader '${name}'`);
            state.alphaFunc = undefined;
          }
        } else if (word === 'depthfunc') {
          token = parameter('depthfunc');
          const func = token.toLowerCase();
          if (func === 'lequal') state.depthFunc = undefined;
          else if (func === 'equal') state.depthFunc = 'equal';
          else this.warn(`unknown depthfunc '${token}' in shader '${name}'`);
        } else if (word === 'detail') {
          state.isDetail = true;
        } else if (word === 'blendfunc') {
          token = tokens.next(false);
          if (!token) {
            this.warn(`missing parm for blendFunc in shader '${name}'`);
            continue;
          }
          const pair = SHORTHAND_FACTORS.get(token.toLowerCase());
          if (pair) {
            [state.blendSource, state.blendFramebuffer] = pair;
          } else {
            state.blendSource = this.blendFactor(token, SOURCE_FACTORS);
            token = tokens.next(false);
            if (!token) {
              this.warn(`missing parm for blendFunc in shader '${name}'`);
              continue;
            }
            state.blendFramebuffer = this.blendFactor(token, FRAMEBUFFER_FACTORS);
          }
          if (!depthMaskExplicit) state.depthMask = false;
        } else if (word === 'rgbgen') {
          this.parseRgbGen(state);
        } else if (word === 'alphagen') {
          this.parseAlphaGen(state);
        } else if (word === 'texgen' || word === 'tcgen') {
          this.parseTcGen(bundle);
        } else if (word === 'tcmod') {
          // The rest of the line, joined into one buffer of 1,024 characters (`:1018-1029`).
          let buffer = '';
          while ((token = tokens.next(false))) buffer += `${token} `;
          this.parseTexMod(buffer.slice(0, 1023), bundle);
        } else if (word === 'depthwrite') {
          state.depthMask = true;
          depthMaskExplicit = true;
        } else {
          this.fail(`unknown parameter '${token}' in shader '${name}'`);
        }
      }
    } finally {
      stages[slot] = unfinishedStage(state);
    }

    // The stage closed: its default colour, its blend and its alpha settled (`:1053-1088`).
    state.rgbGen ??=
      state.blendSource === undefined ||
      state.blendSource === 'gl_one' ||
      state.blendSource === 'gl_src_alpha'
        ? 'identityLighting'
        : 'identity';
    if (state.blendSource === 'gl_one' && state.blendFramebuffer === 'gl_zero') {
      state.blendSource = state.blendFramebuffer = undefined;
      state.depthMask = true;
    }
    if (
      (state.alphaGen ?? 'identity') === 'identity' &&
      (state.rgbGen === 'identity' || state.rgbGen === 'lightingDiffuse')
    ) {
      state.alphaGen = 'skip';
    }
    const stage = finishedStage(state);
    stages[slot] = stage;
    if (stage.blend === 'add') this.script.additive = true;
  }

  /** `NameToSrcBlendMode` and `NameToDstBlendMode`: a name Q3 doesn't know warns, as `gl_one`. */
  private blendFactor(token: string, known: ReadonlySet<string>): string {
    const factor = token.toLowerCase();
    if (known.has(factor)) return factor;
    this.warn(`unknown blend mode '${token}' in shader '${this.name}', substituting GL_ONE`);
    return 'gl_one';
  }

  /** `rgbGen` (`tr_shader.c:842-909`). */
  private parseRgbGen(state: StageState): void {
    const { tokens, name } = this;
    const token = tokens.next(false);
    if (!token) {
      this.warn(`missing parameters for rgbGen in shader '${name}'`);
      return;
    }
    const kind = token.toLowerCase();
    if (kind === 'wave') {
      state.rgbWave = this.parseWaveForm();
      state.rgbGen = 'wave';
    } else if (kind === 'const') {
      const color = [0, 0, 0];
      this.parseVector(3, color);
      const constant = (state.constantColor ??= [0, 0, 0, 0]);
      for (let i = 0; i < 3; i++) constant[i] = toByte(f32(255 * color[i]));
      state.rgbGen = 'const';
    } else if (RGB_GENS.has(kind)) {
      state.rgbGen = RGB_GENS.get(kind);
      // `AGEN_IDENTITY` is 0, so an `alphaGen identity` said before counts as none (`:888-890`).
      if (kind === 'vertex' && (state.alphaGen ?? 'identity') === 'identity') {
        state.alphaGen = 'vertex';
      }
    } else {
      this.warn(`unknown rgbGen parameter '${token}' in shader '${name}'`);
    }
  }

  /** `alphaGen` (`tr_shader.c:913-976`). */
  private parseAlphaGen(state: StageState): void {
    const { tokens, name } = this;
    let token = tokens.next(false);
    if (!token) {
      this.warn(`missing parameters for alphaGen in shader '${name}'`);
      return;
    }
    const kind = token.toLowerCase();
    if (kind === 'wave') {
      state.alphaWave = this.parseWaveForm();
      state.alphaGen = 'wave';
    } else if (kind === 'const') {
      token = tokens.next(false);
      (state.constantColor ??= [0, 0, 0, 0])[3] = toByte(255 * atof(token));
      state.alphaGen = 'const';
    } else if (kind === 'portal') {
      state.alphaGen = 'portal';
      token = tokens.next(false);
      if (!token) {
        this.script.portalRange = 256;
        this.warn(
          `missing range parameter for alphaGen portal in shader '${name}', defaulting to 256`
        );
      } else {
        this.script.portalRange = f32(atof(token));
      }
    } else if (ALPHA_GENS.has(kind)) {
      state.alphaGen = ALPHA_GENS.get(kind);
    } else {
      this.warn(`unknown alphaGen parameter '${token}' in shader '${name}'`);
    }
  }

  /** `tcGen` (`tr_shader.c:980-1012`). */
  private parseTcGen(bundle: Bundle): void {
    const token = this.tokens.next(false);
    if (!token) {
      this.warn(`missing texgen parm in shader '${this.name}'`);
      return;
    }
    const kind = token.toLowerCase();
    if (kind === 'environment') bundle.tcGen = 'environment';
    else if (kind === 'lightmap') bundle.tcGen = 'lightmap';
    else if (kind === 'texture' || kind === 'base') bundle.tcGen = 'texture';
    else if (kind === 'vector') {
      this.parseVector(3, bundle.tcGenVectors[0]);
      this.parseVector(3, bundle.tcGenVectors[1]);
      bundle.tcGen = 'vector';
    } else {
      this.warn(`unknown texgen parm in shader '${this.name}'`);
    }
  }

  /**
   * `ParseTexMod` (`tr_shader.c:359-581`) over the line's buffer: a slot taken before the kind is
   * read, and set only once all its numbers are.
   */
  private parseTexMod(buffer: string, bundle: Bundle): void {
    const { name } = this;
    if (bundle.texMods.length === TR_MAX_TEXMODS) {
      throw new ParseStop(`ERROR: too many tcMod stages in shader '${name}'`);
    }
    const slot = bundle.texMods.length;
    bundle.texMods.push({ type: 'none' });
    const tokens = new Tokens(buffer);
    const token = tokens.next(false);
    /** The next `count` numbers, or none with this warning where the buffer ends first. */
    const numbers = (count: number, ...warnings: string[]): number[] | undefined => {
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        const value = tokens.next(false);
        if (!value) {
          this.warn(`${warnings[Math.min(i, warnings.length - 1)]} in shader '${name}'`);
          return undefined;
        }
        values.push(f32(atof(value)));
      }
      return values;
    };
    const set = (mod: TexMod) => (bundle.texMods[slot] = mod);
    switch (token.toLowerCase()) {
      case 'turb': {
        // Its base is read and never used, and its function is always the sine's.
        const v = numbers(4, 'missing tcMod turb parms', 'missing tcMod turb');
        if (v) {
          const [base, amplitude, phase, frequency] = v;
          set({ type: 'turb', wave: { func: 'sin', base, amplitude, phase, frequency } });
        }
        break;
      }
      case 'scale': {
        const v = numbers(2, 'missing scale parms');
        if (v) set({ type: 'scale', s: v[0], t: v[1] });
        break;
      }
      case 'scroll': {
        const v = numbers(2, 'missing scale scroll parms');
        if (v) set({ type: 'scroll', s: v[0], t: v[1] });
        break;
      }
      case 'stretch': {
        const func = tokens.next(false);
        if (!func) {
          this.warn(`missing stretch parms in shader '${name}'`);
          break;
        }
        const wave = this.genFunc(func);
        const v = numbers(4, 'missing stretch parms');
        if (v) {
          const [base, amplitude, phase, frequency] = v;
          set({ type: 'stretch', wave: { func: wave, base, amplitude, phase, frequency } });
        }
        break;
      }
      case 'transform': {
        const v = numbers(6, 'missing transform parms');
        if (v) {
          const [m00, m01, m10, m11, t0, t1] = v;
          set({ type: 'transform', matrix: [m00, m01, m10, m11], translate: [t0, t1] });
        }
        break;
      }
      case 'rotate': {
        const v = numbers(1, 'missing tcMod rotate parms');
        if (v) set({ type: 'rotate', degreesPerSecond: v[0] });
        break;
      }
      case 'entitytranslate':
        set({ type: 'entityTranslate' });
        break;
      default:
        this.warn(`unknown tcMod '${token}' in shader '${name}'`);
    }
  }
}

/** A bundle as a stage's texture: the image or frames `R_BindAnimatedImage` picks among. */
function textureOfBundle(bundle: Bundle): StageTexture {
  const { images, numImageAnimations } = bundle;
  const frames = numImageAnimations <= 1 ? images.slice(0, 1) : images.slice(0, numImageAnimations);
  const texture: StageTexture = {
    maps: images[0] === undefined ? [] : (frames as string[]),
    animFps: bundle.imageAnimationSpeed,
    clamp: bundle.clamp,
    texMods: [...bundle.texMods]
  };
  if (bundle.isLightmap) texture.lightmap = true;
  if (bundle.tcGen) texture.tcGen = bundle.tcGen;
  if (bundle.tcGen === 'vector') {
    const [s, t] = bundle.tcGenVectors;
    texture.tcGenVectors = [[s[0], s[1], s[2]], [t[0], t[1], t[2]]];
  }
  if (bundle.videoMap !== undefined) texture.videoMap = bundle.videoMap;
  return texture;
}

/** A stage's colours besides its `rgbGen`. */
type StageColors = Pick<ShaderStage, 'rgbWave' | 'alphaGen' | 'alphaWave' | 'constantColor'>;

/** A stage's colours as its state holds them. */
function colorsOf(state: StageState): StageColors {
  const colors: StageColors = {};
  if (state.rgbWave) colors.rgbWave = state.rgbWave;
  if (state.alphaGen) colors.alphaGen = state.alphaGen;
  if (state.alphaWave) colors.alphaWave = state.alphaWave;
  if (state.constantColor) colors.constantColor = [...state.constantColor];
  return colors;
}

/**
 * A stage whose parse failed in it, as Q3 leaves it active: its state bits never set, so no blend,
 * no depth write and no test, and its colour as far as it was read.
 */
function unfinishedStage(state: StageState): ShaderStage {
  const stage: ShaderStage = {
    ...textureOfBundle(state.bundle),
    blend: 'opaque',
    depthWrite: false,
    rgbGen: state.rgbGen ?? 'identityLighting',
    ...colorsOf(state)
  };
  if (state.isDetail) stage.detail = true;
  return stage;
}

/** A closed stage, its state bits settled. */
function finishedStage(state: StageState): ShaderStage {
  const stage: ShaderStage = {
    ...textureOfBundle(state.bundle),
    blend: 'opaque',
    depthWrite: state.depthMask,
    rgbGen: state.rgbGen!,
    ...colorsOf(state)
  };
  if (state.blendSource !== undefined) {
    stage.blend = blendOf(state.blendSource, state.blendFramebuffer);
    stage.blendFactors = [state.blendSource, state.blendFramebuffer];
  }
  if (state.alphaFunc) stage.alphaFunc = state.alphaFunc;
  if (state.depthFunc) stage.depthFunc = state.depthFunc;
  if (state.isDetail) stage.detail = true;
  return stage;
}

/**
 * Read a shader's definition again, as `R_FindShader` reads it each time it makes one
 * (`tr_shader.c:2563-2577`): its images looked up, its warnings naming it as it was asked for.
 *
 * @param name - `shader.name`: the name asked for, its extension stripped.
 * @param hasImage - Whether an image is there, as `R_FindImageFile` finds it.
 */
export function parseShader(
  script: Pick<ShaderScript, 'name' | 'source'>,
  name: string,
  hasImage: (image: string) => boolean
): ShaderScript {
  const { source } = script;
  const run = new ShaderParse(new Tokens(source.text, source.at), name, hasImage);
  let ok = false;
  let drop: string | undefined;
  try {
    ok = run.parse();
  } catch (stop) {
    if (!(stop instanceof ParseStop)) throw stop;
    drop = stop.drop;
  }
  const parsed: ShaderScript = {
    name: script.name,
    ok,
    warnings: run.warnings,
    ...run.script,
    source
  };
  if (drop !== undefined) parsed.drop = drop;
  return parsed;
}

/**
 * `ScanAndLoadShaderFiles`' check of one file's braces (`tr_shader.c:2986-3022`): each name
 * followed by a braced section, or the whole file is ignored.
 *
 * @returns The warning ignoring it, or none for a file that passes.
 */
function checkShaderFile({ name, text }: ShaderFile): string | undefined {
  const tokens = new Tokens(text);
  for (;;) {
    let token = tokens.next(true);
    if (!token) return undefined;
    const shaderName = token.slice(0, 63);
    const shaderLine = tokens.line;
    token = tokens.next(true);
    if (token !== '{') {
      const found = token ? ` (found "${token}" on line ${tokens.line})` : '';
      return (
        `WARNING: Ignoring shader file ${name}. Shader "${shaderName}" on line ${shaderLine} ` +
        `missing opening brace${found}.\n`
      );
    }
    if (!tokens.skipBracedSection(1)) {
      return (
        `WARNING: Ignoring shader file ${name}. Shader "${shaderName}" on line ${shaderLine} ` +
        'missing closing brace.\n'
      );
    }
  }
}

/**
 * Read every shader file as `ScanAndLoadShaderFiles` loads them, and each definition as
 * `ParseShader` reads it with every image taken to be there.
 *
 * The files are joined in the order given, a file whose braces don't match left out. Where a name
 * is defined more than once the **first** definition wins, as `FindShaderInShaderText` finds it
 * (`tr_shader.c:2399-2442`). Which one is first is the caller's order to give: ioq3's is
 * `shaderTextOrder`'s.
 *
 * @param sources - The files, in the order they are to be joined; a bare text is a file of no name.
 * @param warn - Hears the warnings of a file left out.
 */
export function parseShaderScripts(
  sources: readonly (string | ShaderFile)[],
  warn: (text: string) => void = () => {}
): Map<string, ShaderScript> {
  const texts: string[] = [];
  for (const source of sources) {
    const file = typeof source === 'string' ? { name: '', text: source } : source;
    // `strcat` stops at a file's first NUL.
    const nul = file.text.indexOf('\0');
    const text = nul < 0 ? file.text : file.text.slice(0, nul);
    const ignored = checkShaderFile({ name: file.name, text });
    if (ignored) warn(ignored);
    else texts.push(`${text}\n`);
  }
  const text = compress(texts.join(''));

  const shaders = new Map<string, ShaderScript>();
  const tokens = new Tokens(text);
  for (;;) {
    const name = tokens.next(true).toLowerCase();
    if (!name) break;
    if (!shaders.has(name) && tokens.at !== null) {
      shaders.set(name, parseShader({ name, source: { text, at: tokens.at } }, name, () => true));
    }
    tokens.skipBracedSection(0);
  }
  return shaders;
}

/**
 * Look a shader up the way `R_FindShader` does: **strip the extension first**.
 *
 * This matters more than it looks. MD3 surfaces name their material with an extension
 * (`models/weapons2/railgun/railgun2.tga`) while the shader script declares it without one
 * (`models/weapons2/railgun/railgun2`), so a literal lookup misses. Three of the ten
 * weapons — railgun, plasma gun and BFG — get their entire look from environment-mapped
 * shaders found only through this strip; without it they fall back to a texture path that
 * does not exist in the pak.
 *
 * Only the final extension is removed, matching `COM_StripExtension`, so a name like
 * `railgun2.glow.tga` resolves as `railgun2.glow`.
 */
export function findShader(
  shaders: Map<string, ShaderScript>,
  name: string
): ShaderScript | undefined {
  const lower = name.toLowerCase();
  return shaders.get(lower.replace(/\.[^./]*$/, '')) ?? shaders.get(lower);
}

/**
 * The texture an MD3 surface should sample, given its embedded shader name.
 *
 * Resolution follows `R_FindShader`: look the name up in the shader scripts (extension
 * stripped, see {@link findShader}) and take its first image-bearing stage; failing that,
 * treat the name itself as a texture path. The caller still has to run the result through
 * the pak's extension fallback, since shader scripts routinely name a `.tga` that only
 * ships as `.jpg`.
 *
 * @returns the reference to resolve, or `undefined` for a shader with no usable image
 */
export function diffuseReference(
  shaders: Map<string, ShaderScript>,
  surfaceShaderName: string
): string | undefined {
  const shader = findShader(shaders, surfaceShaderName);
  if (!shader) return surfaceShaderName;

  for (const stage of shader.stages) {
    const map = stage.maps.find((m) => !m.startsWith('$'));
    if (map) return map;
  }
  return undefined;
}
