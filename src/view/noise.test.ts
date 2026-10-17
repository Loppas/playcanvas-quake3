import { describe, expect, it } from 'vitest';

import {
  NOISE,
  NOISE_PERM,
  NOISE_SIZE,
  NOISE_TABLE,
  fillNoise,
  latticeNoise,
  noise4
} from './noise';

describe('the noise table', () => {
  it('is filled as R_NoiseInit fills it: a value, then a byte, from each two draws', () => {
    // Microsoft's rand from its first state gives 41, 18467, 6334, 26500.
    const draws = [41, 18467, 6334, 26500];
    let at = 0;
    const { table, perm } = fillNoise(() => Math.fround(draws[at++ % draws.length] / 32767));
    expect(at).toBe(2 * NOISE_SIZE);
    expect(table[0]).toBe(Math.fround(Math.fround(41 / 32767) * 2 - 1));
    expect(perm[0]).toBe(Math.trunc(Math.fround(Math.fround(18467 / 32767) * 255)));
    expect(table[1]).toBe(Math.fround(Math.fround(6334 / 32767) * 2 - 1));
    expect(perm[1]).toBe(Math.trunc(Math.fround(Math.fround(26500 / 32767) * 255)));
    // A draw of 1, `rand()` at `RAND_MAX`, is the top of both.
    expect(fillNoise(() => 1)).toEqual({
      table: new Float32Array(NOISE_SIZE).fill(1),
      perm: new Uint8Array(NOISE_SIZE).fill(255)
    });
  });

  it("is filled once from the port's random source, as Q3's is from the clock", () => {
    expect([NOISE.table, NOISE.perm]).toEqual([NOISE_TABLE, NOISE_PERM]);
    expect([NOISE_TABLE.length, NOISE_PERM.length]).toEqual([NOISE_SIZE, NOISE_SIZE]);
    expect(NOISE_TABLE.every((value) => value >= -1 && value <= 1)).toBe(true);
    expect(new Set(NOISE_TABLE).size).toBeGreaterThan(NOISE_SIZE / 2);
  });

  it('picks a lattice point through the bytes, as INDEX nests them', () => {
    const val = (a: number) => NOISE_PERM[a & 255];
    expect(latticeNoise(1, 2, 3, 4)).toBe(NOISE_TABLE[val(1 + val(2 + val(3 + val(4))))]);
    // Every axis wraps at 256, a negative coordinate as two's complement wraps it.
    expect(latticeNoise(1 + 256, 2 - 512, 3, 4 + 256)).toBe(latticeNoise(1, 2, 3, 4));
    expect(latticeNoise(-1, 0, 0, 0)).toBe(latticeNoise(255, 0, 0, 0));
  });
});

describe('noise4', () => {
  it('reads the lattice itself at its points', () => {
    expect(noise4(5, 6, 7, 8)).toBe(latticeNoise(5, 6, 7, 8));
    expect(noise4(-3, 0, 100, 2)).toBe(latticeNoise(-3, 0, 100, 2));
  });

  it("blends between them along each axis by LERP's weights", () => {
    const at = latticeNoise;
    expect(noise4(5.25, 6, 7, 8)).toBeCloseTo(0.75 * at(5, 6, 7, 8) + 0.25 * at(6, 6, 7, 8), 6);
    expect(noise4(5, 6, 7, 8.5)).toBeCloseTo(0.5 * at(5, 6, 7, 8) + 0.5 * at(5, 6, 7, 9), 6);
    // The cell's middle at one moment is the mean of its eight corners then.
    let sum = 0;
    for (const [dx, dy, dz] of [
      [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]
    ]) {
      sum += at(5 + dx, 6 + dy, 7 + dz, 8);
    }
    expect(noise4(5.5, 6.5, 7.5, 8)).toBeCloseTo(sum / 8, 6);
  });

  it('floors a negative coordinate, so the cell below holds it', () => {
    const at = latticeNoise;
    expect(noise4(-0.25, 0, 0, 0)).toBeCloseTo(0.25 * at(-1, 0, 0, 0) + 0.75 * at(0, 0, 0, 0), 6);
  });
});
