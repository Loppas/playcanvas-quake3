import { describe, expect, it } from 'vitest';

import { atof, atoi, scanFloats, strtol } from './c-scan';

describe('atoi', () => {
  it('reads the leading integer, and anything else as 0', () => {
    expect(atoi('42')).toBe(42);
    expect(atoi(' -7 units')).toBe(-7);
    expect(atoi('3.9')).toBe(3);
    expect(atoi('1e3')).toBe(1);
    expect(atoi('0x10')).toBe(0);
    expect(atoi('none')).toBe(0);
    expect(atoi('')).toBe(0);
  });
});

describe('atof', () => {
  it('reads the leading decimal number, and anything else as 0', () => {
    expect(atof('800')).toBe(800);
    expect(atof(' -0.5x')).toBe(-0.5);
    expect(atof('.25')).toBe(0.25);
    expect(atof('1.')).toBe(1);
    expect(atof('2e2')).toBe(200);
    expect(atof('fast')).toBe(0);
  });
});

describe('strtol', () => {
  it('reads decimal, hex after 0x and octal after a leading 0, and says where it stopped', () => {
    expect(strtol('68')).toEqual({ value: 68, end: 2 });
    expect(strtol('  -12 empty')).toEqual({ value: -12, end: 5 });
    expect(strtol('\t\n\v\f\r +7')).toEqual({ value: 7, end: 8 });
    expect(strtol('0x1F')).toEqual({ value: 31, end: 4 });
    expect(strtol('017')).toEqual({ value: 15, end: 3 });
    expect(strtol('08')).toEqual({ value: 0, end: 1 });
    expect(strtol('0x')).toEqual({ value: 0, end: 1 });
    expect(strtol('game 1 full', 4)).toEqual({ value: 1, end: 6 });
  });

  it('stops where it began when there is no number', () => {
    expect(strtol('')).toEqual({ value: 0, end: 0 });
    expect(strtol('  x')).toEqual({ value: 0, end: 0 });
    expect(strtol('PlayCanvasQuake 1')).toEqual({ value: 0, end: 0 });
    expect(strtol('-')).toEqual({ value: 0, end: 0 });
  });
});

describe('scanFloats', () => {
  it('reads up to three numbers, stopping at the first that will not read', () => {
    expect(scanFloats('-4 -4 43')).toEqual([-4, -4, 43]);
    expect(scanFloats('1 2 3 4')).toEqual([1, 2, 3]);
    expect(scanFloats('  10\t20')).toEqual([10, 20]);
    expect(scanFloats('1,2,3')).toEqual([1]);
    expect(scanFloats('x 1 2')).toEqual([]);
  });
});
