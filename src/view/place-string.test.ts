import { describe, expect, it } from 'vitest';

import { RANK_TIED_FLAG } from '../sim/constants';
import { placeString } from './place-string';

describe('CG_PlaceString', () => {
  it('colours the first three places blue, red and yellow', () => {
    // `S_COLOR_BLUE "1st" S_COLOR_WHITE` (`cg_event.c:53–60`).
    expect(placeString(1)).toBe('^41st^7');
    expect(placeString(2)).toBe('^12nd^7');
    expect(placeString(3)).toBe('^33rd^7');
  });

  it('says 11th, 12th and 13th rather than 11st', () => {
    expect(placeString(11)).toBe('11th');
    expect(placeString(12)).toBe('12th');
    expect(placeString(13)).toBe('13th');
    expect(placeString(21)).toBe('21st');
    expect(placeString(22)).toBe('22nd');
    expect(placeString(23)).toBe('23rd');
    expect(placeString(4)).toBe('4th');
    expect(placeString(10)).toBe('10th');
  });

  it('puts "Tied for " before a tie', () => {
    expect(placeString(1 | RANK_TIED_FLAG)).toBe('Tied for ^41st^7');
    expect(placeString(4 | RANK_TIED_FLAG)).toBe('Tied for 4th');
  });
});
