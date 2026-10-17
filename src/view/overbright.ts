import type { ShaderStage } from '../formats/shader-script';
import { waveColor } from './shader-animation';
import { waveColorByte } from './stage-motion';

/**
 * How bright a stage shows on screen, under the Q3 renderer the port draws like.
 *
 * Both of ioq3's renderers start from `r_overBrightBits` and its inverse, `tr.identityLight`,
 * and spend them differently:
 *
 * - **`opengl1`** draws into its framebuffer at `identityLight`, and the display's gamma ramp
 *   multiplies the whole screen back up (`R_SetColorMappings`, `tr_image.c`). It does that only
 *   in fullscreen, so Q3 in a window is `r_overBrightBits 0`. A default stage shows at its
 *   texture's own brightness. `rgbGen identity` skips the division and shows brighter, and so
 *   does a wave that climbs past 1.
 * - **`opengl2`** has no ramp. `ComputeShaderColors` (`tr_shade.c`) multiplies `identity` by the
 *   overbright factor itself, but leaves a wave its `identityLight`, so every wave draws dimmer.
 *   Its tone map and auto-exposure are not ported.
 *
 * The port blends in display space, as both do, so each stage is simply drawn at its gain
 * (`render/effect-material.ts`). A map's world is the exception: its lightmaps are multiplied by
 * the textures in the framebuffer, where a gain would clamp a light over half before the multiply.
 * So the world draws `opengl1`'s framebuffer ({@link framebufferColor}), and a pass after it
 * doubles the screen as the ramp does (`render/bsp-world.ts`). Engine-free like the rest of
 * `src/view/`.
 */

/** Which of ioq3's renderers to draw like: `cl_renderer`. */
export type Renderer = 'opengl1' | 'opengl2';

/** A renderer and its `r_overBrightBits`, which between them set every stage's brightness. */
export interface RendererStyle {
  renderer: Renderer;
  /** `r_overBrightBits`, 0 to 2. */
  overBrightBits: number;
  /**
   * `r_normalMapping` and `r_specularMapping`, which only `opengl2` reads, each on where absent,
   * as ioq3 defaults it. With both off it lights models per vertex (`USE_FAST_LIGHT`,
   * `tr_glsl.c:1122`). baseq3 ships no normal or specular map, so either one on lights a model
   * as both do.
   */
  normalMapping?: boolean;
  specularMapping?: boolean;
}

/** Q3's defaults, and the port's: `opengl1` in fullscreen, at `r_overBrightBits 1`. */
export const CLASSIC_FULLSCREEN: RendererStyle = { renderer: 'opengl1', overBrightBits: 1 };

let current: RendererStyle = CLASSIC_FULLSCREEN;

/**
 * Set the style everything draws in. Called once at load, from the settings, before anything
 * is built: like the cvars it stands for, it is latched, and a change takes a reload.
 */
export function setRendererStyle(style: RendererStyle): void {
  current = style;
}

/** The style everything draws in. */
export function rendererStyle(): RendererStyle {
  return current;
}

/**
 * The style a map's scene is drawn in: `opengl1`'s, at the style's overbright bits, whichever
 * renderer the style is, as a BSP map's world is drawn.
 */
export function sceneStyle(style: RendererStyle = current): RendererStyle {
  return style.renderer === 'opengl1' ? style : { ...style, renderer: 'opengl1' };
}

/** `1 << r_overBrightBits`: `opengl1`'s ramp, and `opengl2`'s overbright factor. */
export function overbrightFactor(style: RendererStyle): number {
  return 1 << style.overBrightBits;
}

/** `tr.identityLight`: what a default stage is drawn at, for the ramp to multiply back. */
export function identityLight(style: RendererStyle): number {
  return 1 / overbrightFactor(style);
}

/**
 * Whether a stage multiplies colour by colour, the framebuffer's by its own or its own by the
 * framebuffer's, as a filter does. A stage with no factors is judged by its mode.
 */
export function multipliesColor(stage: Pick<ShaderStage, 'blend' | 'blendFactors'>): boolean {
  if (!stage.blendFactors) return stage.blend === 'filter';
  const [source, framebuffer] = stage.blendFactors;
  return (
    source === 'gl_dst_color' ||
    source === 'gl_one_minus_dst_color' ||
    framebuffer === 'gl_src_color' ||
    framebuffer === 'gl_one_minus_src_color'
  );
}

/**
 * A stage's brightness on screen, relative to its texture, at `seconds`.
 *
 * A stage that multiplies colour by colour, as a filter does, is never multiplied up. In
 * `opengl1` it multiplies a framebuffer already drawn at `identityLight`, so the ramp restores
 * the product by itself, which is why Q3 gives a filter stage `identity` by default
 * (`tr_shader.c`). `opengl2` exempts every such pair outright (`ComputeShaderColors`,
 * `tr_shade.c:572–579`).
 *
 * `rgbGen entity` takes the entity's colour as it is (`RB_CalcColorFromEntity`), so classic Q3's
 * ramp doubles it as it doubles `identity`; `opengl2` takes it unmultiplied (`ComputeShaderColors`).
 * `lightingDiffuse` shows as a default stage does: a staged model's shade is in its vertex
 * colours, which its material doubles, and a surface drawn from its first stage alone draws
 * flat. The colour `rgbGen vertex` and `rgbGen entity` read is left to the caller, as a
 * brightness or a colour it multiplies in: the rail core's fade, and `color1` in the rail, the
 * hook, and the railgun's flash and glow. A `const`, `oneMinusEntity` or `oneMinusVertex` stage
 * shows as a default stage does too: a model draws none of those colours.
 *
 * @param seconds - Q3's `shaderTime` for the stage, for `rgbGen wave`.
 * @param style - The renderer to draw like; the one set at load unless a test says otherwise.
 */
export function stageGain(
  stage: Pick<ShaderStage, 'rgbGen' | 'rgbWave' | 'blend' | 'blendFactors'>,
  seconds: number,
  style: RendererStyle = current
): number {
  const factor = multipliesColor(stage) ? 1 : overbrightFactor(style);
  const light = identityLight(style);
  const classic = style.renderer === 'opengl1';

  if (stage.rgbGen === 'wave' && stage.rgbWave) {
    // `RB_CalcWaveColor` gives the wave `identityLight` before its clamp. `opengl1`'s ramp
    // multiplies it back, so a wave past 1 keeps climbing; `opengl2` never does.
    const glow = waveColor(stage.rgbWave, seconds, light);
    return classic ? factor * glow : glow;
  }
  const escapes = stage.rgbGen === 'identity' || stage.rgbGen === 'exactVertex';
  if (classic) return factor * (escapes || stage.rgbGen === 'entity' ? 1 : light);
  return escapes ? factor : 1;
}

/**
 * A model's or an effect's stage's brightness as `opengl1` writes it into its framebuffer, relative
 * to its texture, at `seconds` (`ComputeColors`, `tr_shade.c:612-695`): what it draws in a map's
 * scene, before the ramp multiplies the screen back up, under either renderer. {@link stageGain}
 * is the same stage's brightness on screen, and the two differ by the ramp's factor but where a
 * byte is truncated or a wave clamped in the framebuffer.
 *
 * - `identity` and `exactVertex` are 1, and so are `entity`, the entity's colour fed in as it is,
 *   and `lightingDiffuse`, whose vertex colours hold the shade's bytes whole here.
 * - `vertex` is `identityLight`, to multiply the colour fed in by.
 * - A wave is the byte `RB_CalcWaveColor` writes (`tr_shade_calc.c:677-707`).
 * - Anything else draws as a default stage does, at `tr.identityLightByte`, as on screen.
 *
 * @param style - The renderer's overbright bits; the style set at load unless a test says
 *   otherwise.
 */
export function framebufferGain(
  stage: Pick<ShaderStage, 'rgbGen' | 'rgbWave'>,
  seconds: number,
  style: RendererStyle = current
): number {
  const light = identityLight(style);
  switch (stage.rgbGen) {
    case 'identity':
    case 'exactVertex':
    case 'entity':
    case 'lightingDiffuse':
      return 1;
    case 'vertex':
      return light;
    case 'wave':
      if (stage.rgbWave) return waveColorByte(stage.rgbWave, seconds, light) / 255;
  }
  return Math.trunc(255 * light) / 255;
}

/**
 * A world stage's colour as `opengl1` writes it into its framebuffer, before the ramp multiplies
 * the screen back up, at `seconds` (`ComputeColors`, `tr_shade.c:612-695`). A map's world draws
 * this way under either renderer, followed by its ramp pass.
 *
 * - `identity` and `exactVertex` are 1, and `identityLighting` is `tr.identityLightByte`: the
 *   division truncated to a byte.
 * - `vertex` and `oneMinusVertex` are `identityLight`, to multiply the vertex colours by, or their
 *   inverses (`tr_shade.c:639-674`).
 * - A wave is the byte `RB_CalcWaveColor` writes (`tr_shade_calc.c:677-707`).
 * - `const` is its colour.
 * - `entity` is black, and `oneMinusEntity` white: the world entity's colour is never set, so is 0
 *   (`tr_init.c:1181`).
 * - `lightingDiffuse` is 1, its vertices' colours its entity's light as `RB_CalcDiffuseColor`
 *   writes it (`tr_shade_calc.c:1082-1129`): a brush model's, and the world entity's, which is 0.
 *
 * @param style - The renderer's overbright bits; the style set at load unless a test says
 *   otherwise.
 * @param out - Where to write red, green and blue.
 */
export function framebufferColor(
  stage: Pick<ShaderStage, 'rgbGen' | 'rgbWave' | 'constantColor'>,
  seconds: number,
  style: RendererStyle = current,
  out: [number, number, number] = [0, 0, 0]
): [number, number, number] {
  const light = identityLight(style);
  switch (stage.rgbGen) {
    case 'identity':
    case 'exactVertex':
    case 'oneMinusEntity':
      return out.fill(1);
    case 'identityLighting':
      return out.fill(Math.trunc(255 * light) / 255);
    case 'vertex':
    case 'oneMinusVertex':
      return out.fill(light);
    case 'wave':
      return out.fill(waveColorByte(stage.rgbWave!, seconds, light) / 255);
    case 'const': {
      const [r, g, b] = stage.constantColor ?? [0, 0, 0];
      out[0] = r / 255;
      out[1] = g / 255;
      out[2] = b / 255;
      return out;
    }
    case 'lightingDiffuse':
      return out.fill(1);
    case 'entity':
      return out.fill(0);
  }
}

/**
 * A world stage's alpha as `opengl1` leaves it, where it is a constant (`ComputeColors`,
 * `tr_shade.c:700-777`): its `alphaGen`'s, or with `skip` its `rgbGen`'s. The world entity's alpha
 * is 0. `vertex` where it is the vertex colours' alpha, as the light `lightingDiffuse` writes is:
 * the world entity's 0, and a brush model's 255. None where it moves or differs a vertex: a wave,
 * a highlight, a portal's distance, or a vertex colour's inverse.
 *
 * @param style - The renderer's overbright bits, which `rgbGen vertex` keeps the vertices' alpha
 *   at only where they are 0.
 */
export function framebufferAlpha(
  stage: Pick<ShaderStage, 'rgbGen' | 'alphaGen' | 'constantColor'>,
  style: RendererStyle = current
): number | 'vertex' | undefined {
  const fromColor = (): number | 'vertex' | undefined => {
    switch (stage.rgbGen) {
      case 'identity':
      case 'wave':
      case 'oneMinusEntity':
        return 1;
      case 'identityLighting':
        return Math.trunc(255 * identityLight(style)) / 255;
      case 'exactVertex':
      case 'vertex':
      case 'lightingDiffuse':
        return 'vertex';
      case 'const':
        return (stage.constantColor?.[3] ?? 0) / 255;
      case 'entity':
        return 0;
      case 'oneMinusVertex':
        // Leaves the alpha as the stage before left it: only `skip` reaches here, which this
        // `rgbGen` never takes.
        return undefined;
    }
  };
  switch (stage.alphaGen ?? 'identity') {
    case 'skip':
      return fromColor();
    case 'identity':
      if (stage.rgbGen === 'identity') return 1;
      return stage.rgbGen === 'vertex' && identityLight(style) === 1 ? 'vertex' : 1;
    case 'const':
      return (stage.constantColor?.[3] ?? 0) / 255;
    case 'entity':
      return 0;
    case 'oneMinusEntity':
      return 1;
    case 'vertex':
      return 'vertex';
    case 'wave':
    case 'lightingSpecular':
    case 'oneMinusVertex':
    case 'portal':
      return undefined;
  }
}
