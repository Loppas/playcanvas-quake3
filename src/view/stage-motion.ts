import type { Deform, ShaderStage, TexMod, Wave, WaveFunc } from '../formats/shader-script';
import { noise4 } from './noise';
import { tableForFunc } from './shader-animation';

/**
 * A stage's moving parts as opengl1 works them out for each batch it draws, in its arithmetic: the
 * shader's time (`RB_BeginSurface`, `tr_shade.c:332-335`), the waves read from the function
 * tables (`tr_shade_calc.c:27-81`), the colours and alphas as the bytes `RB_CalcWaveColor` and
 * `RB_CalcWaveAlpha` write, an `animMap`'s frame (`R_BindAnimatedImage`, `tr_shade.c:217-247`), and
 * each texture's coordinates (`ComputeTexCoords`, `tr_shade.c:829-923`), its `tcMod`s composed into
 * affine pieces cut at each `turb`, which moves each vertex by its own position.
 *
 * Engine-free like the rest of `src/view/`. Each function writes into what it is given, so a frame
 * makes nothing.
 */

/** `FUNCTABLE_SIZE` (`tr_local.h:835`): a function's period in its table's steps. */
export const FUNCTABLE_SIZE = 1024;

/** `FUNCTABLE_SIZE2` (`tr_local.h:836`): the steps an `animMap`'s frame is shifted down by. */
const FUNCTABLE_SIZE2 = 10;

/** A table of one period of a function, each entry a float, filled as `R_Init` fills them. */
function functionTable(entry: (i: number) => number): Float32Array {
  const table = new Float32Array(FUNCTABLE_SIZE);
  for (let i = 0; i < FUNCTABLE_SIZE; i++) table[i] = entry(i);
  return table;
}

/**
 * `tr.sinTable` (`tr_init.c:1200`): its period is 1,023 steps, not 1,024, and its angle a float
 * before `DEG2RAD` takes it to double precision.
 */
export const SIN_TABLE = functionTable((i) => {
  const degrees = Math.fround(Math.fround(i * 360) / (FUNCTABLE_SIZE - 1));
  return Math.sin((degrees * Math.PI) / 180);
});

/** `tr.squareTable`, `tr.sawToothTable` and `tr.inverseSawToothTable` (`tr_init.c:1201-1203`). */
const SQUARE_TABLE = functionTable((i) => (i < FUNCTABLE_SIZE / 2 ? 1 : -1));
const SAWTOOTH_TABLE = functionTable((i) => i / FUNCTABLE_SIZE);
const INVERSE_SAWTOOTH_TABLE = functionTable((i) => 1 - SAWTOOTH_TABLE[i]);

/** `tr.triangleTable` (`tr_init.c:1205-1219`): up a quarter, down to 0 by the half, then below. */
const TRIANGLE_TABLE = new Float32Array(FUNCTABLE_SIZE);
for (let i = 0; i < FUNCTABLE_SIZE; i++) {
  if (i < FUNCTABLE_SIZE / 2) {
    TRIANGLE_TABLE[i] =
      i < FUNCTABLE_SIZE / 4 ? i / (FUNCTABLE_SIZE / 4) : 1 - TRIANGLE_TABLE[i - FUNCTABLE_SIZE / 4];
  } else {
    TRIANGLE_TABLE[i] = -TRIANGLE_TABLE[i - FUNCTABLE_SIZE / 2];
  }
}

/**
 * `TableForFunc` (`tr_shade_calc.c:29-50`): a function's table.
 *
 * @param shader - The shader drawn, which the drop names; a model's draws leave it out.
 * @throws its drop for noise or a wave with no function
 */
export function functionTableFor(func: WaveFunc, shader?: string): Float32Array {
  switch (func) {
    case 'sin':
      return SIN_TABLE;
    case 'triangle':
      return TRIANGLE_TABLE;
    case 'square':
      return SQUARE_TABLE;
    case 'sawtooth':
      return SAWTOOTH_TABLE;
    case 'inversesawtooth':
      return INVERSE_SAWTOOTH_TABLE;
    default:
      tableForFunc(func, shader);
      return SIN_TABLE;
  }
}

/**
 * A table's step for `x` periods in: `(int64_t)(x · FUNCTABLE_SIZE) & FUNCTABLE_MASK`, the cast
 * truncating towards zero and the mask taking a negative step from the period's end.
 */
export function tableStep(x: number): number {
  const step = Math.trunc(x * FUNCTABLE_SIZE);
  return ((step % FUNCTABLE_SIZE) + FUNCTABLE_SIZE) % FUNCTABLE_SIZE;
}

/**
 * `tess.shaderTime` (`tr_shade.c:332-335`): the refdef's time in seconds, in double precision
 * (`tr_scene.c:347`), less the shader's `timeOffset`, and held at its `clampTime` once it reaches
 * it.
 *
 * @param time - The refdef's time, in whole milliseconds.
 * @param clampTime - The shader's `clampTime`; 0 for none.
 * @param timeOffset - The shader's `timeOffset`, which a swap to it gives it; 0 for none.
 */
export function shaderTime(time: number, clampTime: number, timeOffset = 0): number {
  const seconds = time * 0.001 - timeOffset;
  return clampTime && seconds >= clampTime ? clampTime : seconds;
}

/**
 * `EvalWaveForm` (`tr_shade_calc.c:57-64`), through `WAVEVALUE` (`:27`): the wave's table read at
 * its phase now, with no blending between steps, as a float.
 *
 * @throws `TableForFunc`'s drop, naming `shader`
 */
export function waveValue(wave: Wave, time: number, shader?: string): number {
  const table = functionTableFor(wave.func, shader);
  const sample = table[tableStep(wave.phase + time * wave.frequency)];
  return Math.fround(wave.base + Math.fround(sample * wave.amplitude));
}

/**
 * `RB_CalcWaveColor` (`tr_shade_calc.c:677-707`): the byte an `rgbGen wave` writes in each colour
 * channel, its wave times `tr.identityLight`, or a noise wave from its phase on, clamped and
 * truncated as `ri.ftol` truncates (`cvttss2si`).
 *
 * @param light - `tr.identityLight`.
 * @throws `TableForFunc`'s drop for a wave with no function
 */
export function waveColorByte(wave: Wave, time: number, light: number, shader?: string): number {
  const glow =
    wave.func === 'noise'
      ? Math.fround(
          wave.base +
            Math.fround(noise4(0, 0, 0, (time + wave.phase) * wave.frequency) * wave.amplitude)
        )
      : Math.fround(waveValue(wave, time, shader) * light);
  return Math.trunc(Math.fround(255 * Math.min(1, Math.max(0, glow))));
}

/**
 * `RB_CalcWaveAlpha` (`tr_shade_calc.c:712-726`): the byte an `alphaGen wave` writes, its wave
 * clamped (`EvalWaveFormClamped`) and truncated.
 *
 * @throws `TableForFunc`'s drop for noise or a wave with no function
 */
export function waveAlphaByte(wave: Wave, time: number, shader?: string): number {
  const glow = Math.min(1, Math.max(0, waveValue(wave, time, shader)));
  return Math.trunc(Math.fround(255 * glow));
}

/**
 * `R_BindAnimatedImage`'s frame (`tr_shade.c:217-247`): the steps of the sine table the flipbook
 * has run through, shifted down so its frames line up with a wave of its rate, wrapped to the
 * frames it has; 0 before the clock starts, and for a texture of one image.
 *
 * @param speed - `imageAnimationSpeed`, its frames a second.
 */
export function animMapFrame(time: number, speed: number, frames: number): number {
  if (frames <= 1) return 0;
  const steps = Math.trunc(time * speed * FUNCTABLE_SIZE);
  const frame = Math.max(0, Math.floor(steps / (1 << FUNCTABLE_SIZE2)));
  return frame % frames;
}

/**
 * The most `turb`s a texture holds, one in each of its `tcMod` slots (`TR_MAX_TEXMODS`,
 * `tr_local.h:247`).
 */
export const MAX_TURBS = 4;

/**
 * The floats a texture's coordinates take: a vec4 holding how many `turb`s cut it, then two vec4s
 * for each affine piece, `(a, b, e, 0)` and `(c, d, f, 0)`, so each coordinate is the dot of
 * `(s, t, 1)` with a row, a vec4 after each piece but the last for the `turb` that follows it:
 * its amplitude, the fraction of its phase now, and the whole periods taken from it.
 */
export const COORDINATES_LENGTH = 4 * (1 + 3 * MAX_TURBS + 2);

/**
 * The piece being composed, and the `tcMod` being added to it: affine maps of a texture's
 * coordinates, `s' = a·s + b·t + e` and `t' = c·s + d·t + f`, held as `a, b, e, c, d, f`. Written
 * in place, so composing makes nothing.
 */
const piece = new Float64Array(6);
const mod = new Float64Array(6);

/** The map that moves nothing. */
const IDENTITY = Float64Array.of(1, 0, 0, 0, 1, 0);

/** {@link piece}, then {@link mod}: the piece made the two composed. */
function compose(): void {
  const a = piece[0];
  const b = piece[1];
  const e = piece[2];
  const c = piece[3];
  const d = piece[4];
  const f = piece[5];
  piece[0] = mod[0] * a + mod[1] * c;
  piece[1] = mod[0] * b + mod[1] * d;
  piece[2] = mod[0] * e + mod[1] * f + mod[2];
  piece[3] = mod[3] * a + mod[4] * c;
  piece[4] = mod[3] * b + mod[4] * d;
  piece[5] = mod[3] * e + mod[4] * f + mod[5];
}

/** Write {@link piece} at vec4 `at` of `out`, and start the next at the identity. */
function writePiece(out: Float32Array, at: number): void {
  const i = at * 4;
  out[i] = piece[0];
  out[i + 1] = piece[1];
  out[i + 2] = piece[2];
  out[i + 3] = 0;
  out[i + 4] = piece[3];
  out[i + 5] = piece[4];
  out[i + 6] = piece[5];
  out[i + 7] = 0;
  piece.set(IDENTITY);
}

/**
 * {@link mod} as one `tcMod` moves coordinates at `time`, as its function in `tr_shade_calc.c`
 * moves them: `transform` by its matrix (`:975-987`), `scale` about the origin (`:937-946`),
 * `scroll` by the fraction of its offset now, kept in double precision (`:951-970`), `rotate`
 * by the sine table's steps (`:992-1015`), and `stretch` by the inverse of its wave about the middle
 * (`:86-101`). The world entity's `shaderTexCoord` is 0, so `entityTranslate` moves nothing.
 */
function modAt(texMod: Exclude<TexMod, { type: 'none' | 'turb' }>, time: number, shader?: string): void {
  switch (texMod.type) {
    case 'transform': {
      const { matrix, translate } = texMod;
      // `matrix` is `m00 m01 m10 m11`: s takes m00 and m10, t m01 and m11.
      mod[0] = matrix[0];
      mod[1] = matrix[2];
      mod[2] = translate[0];
      mod[3] = matrix[1];
      mod[4] = matrix[3];
      mod[5] = translate[1];
      return;
    }
    case 'scale':
      mod.set(IDENTITY);
      mod[0] = texMod.s;
      mod[4] = texMod.t;
      return;
    case 'scroll': {
      const s = texMod.s * time;
      const t = texMod.t * time;
      mod.set(IDENTITY);
      mod[2] = s - Math.floor(s);
      mod[5] = t - Math.floor(t);
      return;
    }
    case 'rotate': {
      const degrees = -texMod.degreesPerSecond * time;
      const step = Math.trunc(degrees * Math.fround(FUNCTABLE_SIZE / 360));
      const sin = SIN_TABLE[((step % FUNCTABLE_SIZE) + FUNCTABLE_SIZE) % FUNCTABLE_SIZE];
      const quarter = step + FUNCTABLE_SIZE / 4;
      const cos = SIN_TABLE[((quarter % FUNCTABLE_SIZE) + FUNCTABLE_SIZE) % FUNCTABLE_SIZE];
      mod[0] = cos;
      mod[1] = -sin;
      mod[2] = Math.fround(0.5 - 0.5 * cos + 0.5 * sin);
      mod[3] = sin;
      mod[4] = cos;
      mod[5] = Math.fround(0.5 - 0.5 * sin - 0.5 * cos);
      return;
    }
    case 'stretch': {
      const p = Math.fround(1 / waveValue(texMod.wave, time, shader));
      const middle = Math.fround(0.5 - Math.fround(0.5 * p));
      mod[0] = p;
      mod[1] = 0;
      mod[2] = middle;
      mod[3] = 0;
      mod[4] = p;
      mod[5] = middle;
      return;
    }
    case 'entityTranslate':
      mod.set(IDENTITY);
      return;
  }
}

/**
 * A texture's coordinates at `time`, as `ComputeTexCoords` moves them (`tr_shade.c:875-921`): its
 * `tcMod`s in order up to an empty slot, the affine ones composed into a piece and each `turb` its
 * own. A `turb` moves each coordinate by the sine table's step at its vertex's place over 1,024
 * plus the wave's phase now (`RB_CalcTurbulentTexCoords`, `tr_shade_calc.c:917-932`); the phase is
 * kept as its fraction and its whole periods, so the shader's floats keep their precision and
 * truncate the step as Q3's cast does. See {@link COORDINATES_LENGTH} for the layout.
 *
 * @param out - At least {@link COORDINATES_LENGTH} floats.
 * @throws `TableForFunc`'s drop for a `stretch` with no table, naming `shader`
 */
export function writeCoordinates(
  texMods: readonly TexMod[],
  time: number,
  out: Float32Array,
  shader?: string
): void {
  piece.set(IDENTITY);
  let turbs = 0;
  for (let i = 0; i < texMods.length; i++) {
    const texMod = texMods[i];
    if (texMod.type === 'none') break;
    if (texMod.type === 'turb') {
      writePiece(out, 1 + 3 * turbs);
      const { amplitude, phase, frequency } = texMod.wave;
      const now = phase + time * frequency;
      const whole = Math.floor(now);
      const at = (3 + 3 * turbs) * 4;
      out[at] = amplitude;
      out[at + 1] = now - whole;
      out[at + 2] = whole;
      out[at + 3] = 0;
      turbs++;
      continue;
    }
    modAt(texMod, time, shader);
    compose();
  }
  writePiece(out, 1 + 3 * turbs);
  out[0] = turbs;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
}

/**
 * Where a texture's pieces, as {@link writeCoordinates} writes them, put one vertex's coordinates:
 * each piece in turn, and each `turb` between them adding `tr.sinTable` at the step its place
 * reaches, truncated towards zero on the side the whole sum falls. The chunks
 * (`render/stage-coordinates.ts`) do the same on the GPU, in floats.
 *
 * @param out - Where to write s and t.
 */
export function coordinatesAt(
  pieces: Float32Array,
  s: number,
  t: number,
  x: number,
  y: number,
  z: number,
  out: [number, number]
): [number, number] {
  const affine = (at: number) => {
    const i = at * 4;
    const ss = s * pieces[i] + t * pieces[i + 1] + pieces[i + 2];
    t = s * pieces[i + 4] + t * pieces[i + 5] + pieces[i + 6];
    s = ss;
  };
  affine(1);
  const turbs = Math.min(pieces[0], MAX_TURBS);
  for (let j = 0; j < turbs; j++) {
    const at = (3 + 3 * j) * 4;
    const step = (sum: number) => {
      const scaled = sum + pieces[at + 1] * FUNCTABLE_SIZE;
      const whole = scaled >= -FUNCTABLE_SIZE * pieces[at + 2] ? Math.floor(scaled) : Math.ceil(scaled);
      return SIN_TABLE[whole - FUNCTABLE_SIZE * Math.floor(whole / FUNCTABLE_SIZE)];
    };
    s += step(x + z) * pieces[at];
    t += step(y) * pieces[at];
    affine(4 + 3 * j);
  }
  out[0] = s;
  out[1] = t;
  return out;
}

/** Whether a texture's coordinates move with the clock: it scrolls, turns, stretches or ripples. */
export function coordinatesMove(texMods: readonly TexMod[]): boolean {
  for (const texMod of texMods) {
    if (texMod.type === 'none') return false;
    if (texMod.type === 'scroll' && (texMod.s !== 0 || texMod.t !== 0)) return true;
    if (texMod.type === 'rotate' || texMod.type === 'stretch' || texMod.type === 'turb') {
      return true;
    }
  }
  return false;
}

/** The message `TableForFunc` drops the map with, or none where the function has a table. */
function tableDrop(func: WaveFunc, shader: string): string | undefined {
  try {
    functionTableFor(func, shader);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** A texture's `tcMod`s' drop, in their order up to an empty slot: only `stretch` reads a table. */
function texModsDrop(texMods: readonly TexMod[], shader: string): string | undefined {
  for (const texMod of texMods) {
    if (texMod.type === 'none') return undefined;
    if (texMod.type === 'stretch') {
      const drop = tableDrop(texMod.wave.func, shader);
      if (drop) return drop;
    }
  }
  return undefined;
}

/**
 * The first error a batch of a shader drops the map with as opengl1 draws it, in its order: each
 * deform that reads a table (`RB_DeformTessGeometry`, `tr_shade_calc.c:538-581`), then each stage's
 * colour (`ComputeColors`, `tr_shade.c:612-822`), its textures' coordinates (`ComputeTexCoords`)
 * and its blend (`GL_State`, `tr_backend.c:284-286`). None for a shader that draws.
 *
 * @param shader - Its name, as `TableForFunc` prints it.
 */
export function firstDrop(
  shader: string,
  deforms: readonly Deform[],
  stages: readonly ShaderStage[]
): string | undefined {
  for (const deform of deforms) {
    if (deform.type !== 'wave' && deform.type !== 'move') continue;
    const drop = tableDrop(deform.wave.func, shader);
    if (drop) return drop;
  }
  for (const stage of stages) {
    // A noise colour reads no table; any other wave does.
    if (stage.rgbGen === 'wave' && stage.rgbWave && stage.rgbWave.func !== 'noise') {
      const drop = tableDrop(stage.rgbWave.func, shader);
      if (drop) return drop;
    }
    if (stage.alphaGen === 'wave' && stage.alphaWave) {
      const drop = tableDrop(stage.alphaWave.func, shader);
      if (drop) return drop;
    }
    const drop =
      texModsDrop(stage.texMods, shader) ??
      (stage.multitexture && texModsDrop(stage.multitexture.texMods, shader));
    if (drop) return drop;
    if (stage.blendFactors && stage.blendFactors[1] === undefined) {
      return 'GL_State: invalid dst blend state bits';
    }
  }
  return undefined;
}
