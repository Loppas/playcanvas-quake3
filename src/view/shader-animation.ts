import type { TexMod, Wave, WaveFunc } from '../formats/shader-script';
import { noise4 } from './noise';

/**
 * Q3's per-frame shader maths (`tr_shade_calc.c`) for the directives the models and effects
 * animate: waveforms, `rgbGen` and `alphaGen wave`, `tcMod stretch`, `rotate`, `scroll`, `scale`
 * and `transform`, and `tcGen environment`, each read continuously. The deforms are
 * `vertex-deform.ts`'s, and a stage's coordinates as opengl1 steps them, `turb` among them,
 * `stage-motion.ts`'s.
 *
 * Engine-free like the rest of `src/view/`. What moves with time is evaluated at
 * `tess.shaderTime`: an effect's own age where Q3 starts its clock at spawn, or the game clock
 * where it doesn't.
 */

/** Each function's number in `genFunc_t` (`tr_local.h:119-130`), as `TableForFunc` prints it. */
const GEN_FUNC_NUMBERS: Readonly<Record<WaveFunc, number>> = {
  none: 0,
  sin: 1,
  square: 2,
  triangle: 3,
  sawtooth: 4,
  inversesawtooth: 5,
  noise: 6
};

/**
 * `TableForFunc` (`tr_shade_calc.c:29-50`): Q3 has a table for every function but noise and a
 * wave's with no function, and drops the map where one of those is drawn.
 *
 * @param shader - The shader drawn, which Q3's message names; a model's draws leave it out.
 * @throws its drop
 */
export function tableForFunc(func: WaveFunc, shader?: string): void {
  if (func === 'none' || func === 'noise') {
    const named = shader === undefined ? '' : ` in shader '${shader}'`;
    throw new Error(`TableForFunc called with invalid function '${GEN_FUNC_NUMBERS[func]}'${named}`);
  }
}

/**
 * One period of a waveform's function — Q3's function tables (`tr_init.c`), read continuously
 * rather than in 1024 steps.
 *
 * @throws {@link tableForFunc}'s drop for a function with no table
 */
export function waveFunc(func: WaveFunc, x: number): number {
  const f = x - Math.floor(x);
  switch (func) {
    case 'none':
    case 'noise':
      tableForFunc(func);
      return 0;
    case 'sin':
      return Math.sin(2 * Math.PI * f);
    case 'square':
      return f < 0.5 ? 1 : -1;
    case 'sawtooth':
      return f;
    case 'inversesawtooth':
      return 1 - f;
    case 'triangle': {
      // Up to 1 over the first quarter, back to 0 by the half, then the same below zero.
      const half = f < 0.5 ? f : f - 0.5;
      const rise = half < 0.25 ? 4 * half : 2 - 4 * half;
      return f < 0.5 ? rise : -rise;
    }
  }
}

/** `EvalWaveForm`: `base + amplitude · func(phase + t · frequency)`. */
export function evalWave(wave: Wave, seconds: number): number {
  return wave.base + wave.amplitude * waveFunc(wave.func, wave.phase + seconds * wave.frequency);
}

/**
 * `RB_CalcWaveColor` and `RB_CalcWaveAlpha`: a wave clamped to [0, 1], as a colour or an
 * alpha.
 */
export function waveGlow(wave: Wave, seconds: number): number {
  return Math.min(1, Math.max(0, evalWave(wave, seconds)));
}

/**
 * `RB_CalcWaveColor` (`tr_shade_calc.c:677-707`) before its byte: a noise wave reads the noise
 * from its phase on, `base + amplitude · noise((t + phase) · frequency)`, and is never scaled;
 * any other wave is scaled by `light`. Clamped to [0, 1].
 *
 * @param light - `tr.identityLight`.
 */
export function waveColor(wave: Wave, seconds: number, light: number): number {
  const glow =
    wave.func === 'noise'
      ? wave.base + noise4(0, 0, 0, (seconds + wave.phase) * wave.frequency) * wave.amplitude
      : evalWave(wave, seconds) * light;
  return Math.min(1, Math.max(0, glow));
}

/**
 * An affine map of texture coordinates, as `RB_CalcTransformTexCoords` applies one:
 * `s' = a·s + b·t + e` and `t' = c·s + d·t + f`.
 */
export interface TexTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Coordinates as the geometry hands them over. */
export const IDENTITY_TRANSFORM: TexTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Scale about the origin, as `tcMod scale` does, and as a beam's repeat along its length. */
export function scaleTransform(s: number, t: number): TexTransform {
  return { a: s, b: 0, c: 0, d: t, e: 0, f: 0 };
}

/** `first`, then `next`. */
export function thenTransform(first: TexTransform, next: TexTransform): TexTransform {
  return {
    a: next.a * first.a + next.b * first.c,
    b: next.a * first.b + next.b * first.d,
    c: next.c * first.a + next.d * first.c,
    d: next.c * first.b + next.d * first.d,
    e: next.a * first.e + next.b * first.f + next.e,
    f: next.c * first.e + next.d * first.f + next.f
  };
}

/** Where a transform takes one pair of coordinates. */
export function applyTransform(m: TexTransform, s: number, t: number): [number, number] {
  return [m.a * s + m.b * t + m.e, m.c * s + m.d * t + m.f];
}

/** One modifier at one moment; `none` ends the modifiers before it is reached. */
function texModAt(mod: Exclude<TexMod, { type: 'none' }>, seconds: number): TexTransform {
  switch (mod.type) {
    case 'transform': {
      // `RB_CalcTransformTexCoords` (`tr_shade_calc.c:975-987`).
      const [m00, m01, m10, m11] = mod.matrix;
      const [t0, t1] = mod.translate;
      return { a: m00, b: m10, c: m01, d: m11, e: t0, f: t1 };
    }
    case 'entityTranslate':
      // A scroll by the entity's `shaderTexCoord`, which nothing the port draws sets.
      return IDENTITY_TRANSFORM;
    case 'stretch': {
      // `RB_CalcStretchTexCoords`: scale by 1 / wave about (½, ½).
      const p = 1 / evalWave(mod.wave, seconds);
      return { a: p, b: 0, c: 0, d: p, e: 0.5 - 0.5 * p, f: 0.5 - 0.5 * p };
    }
    case 'rotate': {
      // `RB_CalcRotateTexCoords`: turn by −degreesPerSecond · t about (½, ½).
      const radians = (-mod.degreesPerSecond * seconds * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      return {
        a: cos,
        b: -sin,
        c: sin,
        d: cos,
        e: 0.5 - 0.5 * cos + 0.5 * sin,
        f: 0.5 - 0.5 * sin - 0.5 * cos
      };
    }
    case 'scroll': {
      // `RB_CalcScrollTexCoords` keeps only the fractional part, so coordinates never grow.
      const s = mod.s * seconds;
      const t = mod.t * seconds;
      return { a: 1, b: 0, c: 0, d: 1, e: s - Math.floor(s), f: t - Math.floor(t) };
    }
    case 'scale':
      // `RB_CalcScaleTexCoords`, about the origin.
      return scaleTransform(mod.s, mod.t);
    case 'turb':
      // Per vertex, so it is no part of a map transform: an effect model ripples its
      // coordinates before its transform (`stage-motion.ts`).
      return IDENTITY_TRANSFORM;
  }
}

/**
 * `RB_CalcEnvironmentTexCoords` (`tr_shade_calc.c:888–912`): the direction from each vertex to
 * the viewer, mirrored in its normal, read as coordinates: `s = ½ + ½·y` and `t = ½ − ½·z` of the
 * mirrored direction. A face turned along the model's forward axis and seen square on shows the
 * texture's middle, and the texture slides over the model as the viewer or the model moves, as a
 * reflection does. The model chunks (`render/model-chunks.ts`) make them the same on the GPU,
 * and tests hold them to this.
 *
 * Q3 makes the direction unit length with `Q_rsqrt`'s estimate; this makes it exactly.
 *
 * @param positions - Positions in the model's own frame, three per vertex.
 * @param normals - Their unit normals.
 * @param viewer - Where the viewer is, in the same frame.
 * @param out - Where to write, two per vertex.
 */
export function environmentUvs(
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  viewer: readonly [number, number, number],
  out: Float32Array
): Float32Array {
  for (let v = 0, p = 0; p < positions.length; v += 2, p += 3) {
    let vx = viewer[0] - positions[p];
    let vy = viewer[1] - positions[p + 1];
    let vz = viewer[2] - positions[p + 2];
    const length = Math.hypot(vx, vy, vz);
    if (length > 0) {
      vx /= length;
      vy /= length;
      vz /= length;
    }
    const d = normals[p] * vx + normals[p + 1] * vy + normals[p + 2] * vz;
    out[v] = 0.5 + (normals[p + 1] * 2 * d - vy) * 0.5;
    out[v + 1] = 0.5 - (normals[p + 2] * 2 * d - vz) * 0.5;
  }
  return out;
}

/**
 * A stage's texture modifiers at one moment, composed into one transform in declaration
 * order, which is the order Q3 runs them over the coordinates. An empty slot ends them
 * (`tr_shade.c:878-880`).
 *
 * @param base - Applied first: the coordinates the geometry itself hands the stage, such as a
 *   beam's `length / 256` repeat.
 */
export function texModsAt(
  mods: readonly TexMod[],
  seconds: number,
  base: TexTransform = IDENTITY_TRANSFORM
): TexTransform {
  let transform = base;
  for (const mod of mods) {
    if (mod.type === 'none') break;
    transform = thenTransform(transform, texModAt(mod, seconds));
  }
  return transform;
}
