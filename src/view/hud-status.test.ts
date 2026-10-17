import { describe, expect, it } from 'vitest';

import { WEAPON_FIRING, WEAPON_READY } from '../sim/weapons/constants';
import {
  STATUS_COLORS,
  STAT_MINUS,
  ammoColor,
  colorForHealth,
  fieldDigits,
  healthColor
} from './hud-status';

describe('fieldDigits', () => {
  it('right-aligns a number in its field, 2 in from the edge', () => {
    expect(fieldDigits(185, 3, 125)).toEqual([
      { x: 187, frame: 1 },
      { x: 219, frame: 2 },
      { x: 251, frame: 5 }
    ]);
    expect(fieldDigits(185, 3, 7)).toEqual([{ x: 251, frame: 7 }]);
  });

  it('draws a minus sign from its own shader', () => {
    expect(fieldDigits(370, 3, -5)).toEqual([
      { x: 404, frame: STAT_MINUS },
      { x: 436, frame: 5 }
    ]);
  });

  it('clamps to what three digits hold', () => {
    expect(fieldDigits(0, 3, 1234).map((digit) => digit.frame)).toEqual([9, 9, 9]);
    expect(fieldDigits(0, 3, -150).map((digit) => digit.frame)).toEqual([STAT_MINUS, 9, 9]);
  });

  it('caps a field at five digits, and draws the first five of a longer number', () => {
    expect(fieldDigits(0, 7, 1234567).map((digit) => digit.frame)).toEqual([1, 2, 3, 4, 5]);
    expect(fieldDigits(0, 0, 5)).toEqual([]);
  });
});

describe('healthColor', () => {
  it('is white over 100, amber to 26, and red at 0 or below', () => {
    expect(healthColor(125, 0)).toBe(STATUS_COLORS.over);
    expect(healthColor(100, 0)).toBe(STATUS_COLORS.normal);
    expect(healthColor(26, 0)).toBe(STATUS_COLORS.normal);
    expect(healthColor(0, 0)).toBe(STATUS_COLORS.low);
    expect(healthColor(-30, 256)).toBe(STATUS_COLORS.low);
  });

  it('flashes amber and red every 256 ms at 25 or less', () => {
    expect(healthColor(25, 0)).toBe(STATUS_COLORS.normal);
    expect(healthColor(25, 255)).toBe(STATUS_COLORS.normal);
    expect(healthColor(25, 256)).toBe(STATUS_COLORS.low);
    expect(healthColor(1, 512)).toBe(STATUS_COLORS.normal);
  });
});

describe('ammoColor', () => {
  it('greys the count while a shot holds the gun past another 100 ms', () => {
    expect(ammoColor(WEAPON_FIRING, 150)).toBe(STATUS_COLORS.firing);
    expect(ammoColor(WEAPON_FIRING, 100)).toBe(STATUS_COLORS.normal);
    expect(ammoColor(WEAPON_READY, 400)).toBe(STATUS_COLORS.normal);
  });

  it("reds the count under the weapon's low-ammo mark, and never with none", () => {
    expect(ammoColor(WEAPON_READY, 0, 4, 5)).toBe(STATUS_COLORS.low);
    expect(ammoColor(WEAPON_FIRING, 150, 4, 5)).toBe(STATUS_COLORS.low);
    expect(ammoColor(WEAPON_READY, 0, 5, 5)).toBe(STATUS_COLORS.normal);
    expect(ammoColor(WEAPON_READY, 0, 0, 0)).toBe(STATUS_COLORS.normal);
  });
});

describe('colorForHealth', () => {
  it('is white at full strength, then yellow, then red', () => {
    expect(colorForHealth(100, 0)).toEqual([1, 1, 1, 1]);
    expect(colorForHealth(80, 0)).toEqual([1, 1, 14 / 33, 1]);
    expect(colorForHealth(45, 0)).toEqual([1, 0.5, 0, 1]);
    expect(colorForHealth(20, 0)).toEqual([1, 0, 0, 1]);
  });

  it('counts armor up to what it could save, and is black when dead', () => {
    // 50 health could keep 97 armor's worth: 147 in all.
    expect(colorForHealth(50, 100)).toEqual([1, 1, 1, 1]);
    // 30 health with 10 armor: 40.
    expect(colorForHealth(30, 10)).toEqual([1, 1 / 3, 0, 1]);
    expect(colorForHealth(0, 50)).toEqual([0, 0, 0, 1]);
  });
});
