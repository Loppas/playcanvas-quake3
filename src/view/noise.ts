/**
 * Q3's noise (`renderercommon/tr_noise.c`): 256 random values in [−1, 1], and 256 random bytes
 * that pick among them for each point of a four-dimensional lattice, blended smoothly between the
 * points. `deformVertexes normal` bends normals by it, and `rgbGen wave noise` reads it.
 *
 * Q3 fills both from `rand()` at the renderer's start (`R_NoiseInit`, `:41–50`), seeded from the
 * clock (`qcommon/common.c:2650–2657`), so no two runs share a table. The port fills its one table
 * the same way, once, from its own random source.
 *
 * Engine-free, like the rest of `src/view/`. Nothing here makes anything once the table is filled.
 */

/** `NOISE_SIZE`: the values in the table, and the lattice's period along each axis. */
export const NOISE_SIZE = 256;
const NOISE_MASK = NOISE_SIZE - 1;

/** `s_noise_table`, the values, and `s_noise_perm`, the bytes that pick them. */
export interface NoiseTable {
  table: Float32Array;
  /** Q3's "perm" is no permutation: each byte is drawn on its own, so some repeat. */
  perm: Uint8Array;
}

const f = Math.fround;

/**
 * A table filled as `R_NoiseInit` fills it: a value, then a byte, for each entry in turn, each from
 * one draw of `random`, which stands for `rand() / (float)RAND_MAX`.
 *
 * @param random - Draws in [0, 1].
 */
export function fillNoise(random: () => number): NoiseTable {
  const table = new Float32Array(NOISE_SIZE);
  const perm = new Uint8Array(NOISE_SIZE);
  for (let i = 0; i < NOISE_SIZE; i++) {
    table[i] = f(random()) * 2 - 1;
    perm[i] = Math.trunc(f(f(random()) * 255));
  }
  return { table, perm };
}

/** The port's table, filled once from its random source. */
export const NOISE = fillNoise(Math.random);

/** {@link NOISE}'s values and bytes, as the models' chunks bake them in. */
export const NOISE_TABLE = NOISE.table;
export const NOISE_PERM = NOISE.perm;

/** `VAL`: the byte a coordinate picks, wrapped at the lattice's period. */
function val(perm: Uint8Array, a: number): number {
  return perm[a & NOISE_MASK];
}

/**
 * `GetNoiseValue` (`:34–39`): the value at a lattice point, picked through the bytes by `INDEX`.
 * Each coordinate wraps at the lattice's period, a negative one as two's complement wraps it.
 */
export function latticeNoise(x: number, y: number, z: number, t: number, noise = NOISE): number {
  const { perm } = noise;
  return noise.table[val(perm, x + val(perm, y + val(perm, z + val(perm, t))))];
}

/** Q3's `LERP` (`qcommon/q_shared.h:1422`), in floats. */
function lerp(a: number, b: number, w: number): number {
  return f(f(a * f(1 - w)) + f(b * w));
}

/** One moment's cell of `R_NoiseGet4f`: its eight corners blended along x, then y, then z. */
function cell(
  ix: number,
  iy: number,
  iz: number,
  it: number,
  fx: number,
  fy: number,
  fz: number,
  noise: NoiseTable
): number {
  const front = lerp(
    lerp(latticeNoise(ix, iy, iz, it, noise), latticeNoise(ix + 1, iy, iz, it, noise), fx),
    lerp(latticeNoise(ix, iy + 1, iz, it, noise), latticeNoise(ix + 1, iy + 1, iz, it, noise), fx),
    fy
  );
  const back = lerp(
    lerp(latticeNoise(ix, iy, iz + 1, it, noise), latticeNoise(ix + 1, iy, iz + 1, it, noise), fx),
    lerp(
      latticeNoise(ix, iy + 1, iz + 1, it, noise),
      latticeNoise(ix + 1, iy + 1, iz + 1, it, noise),
      fx
    ),
    fy
  );
  return lerp(front, back, fz);
}

/**
 * `R_NoiseGet4f` (`:52–91`), in its floats: the noise at a point in space and time, the sixteen
 * lattice values around it blended across the cell, then between its two moments. The time is a
 * double, and its fraction a float.
 */
export function noise4(x: number, y: number, z: number, t: number, noise = NOISE): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const it = Math.floor(t);
  const fx = f(x - ix);
  const fy = f(y - iy);
  const fz = f(z - iz);
  const ft = f(t - it);
  const now = cell(ix, iy, iz, it, fx, fy, fz, noise);
  return lerp(now, cell(ix, iy, iz, it + 1, fx, fy, fz, noise), ft);
}
