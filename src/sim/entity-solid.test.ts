import { describe, expect, it } from 'vitest';

import { CONTENTS, CROUCH_HEIGHT } from './constants';
import { packSolid, SOLID_BMODEL, solidBox } from './entity-solid';
import { playerBounds } from './types';
import { vec3, type Vec3 } from './vec3';

/** What linking reads of an entity: a box of `CONTENTS_BODY`, unless it says otherwise. */
function linked(mins: Vec3, maxs: Vec3, contents: number = CONTENTS.BODY, bmodel = false) {
  return { bmodel, contents, mins, maxs };
}

describe('packSolid', () => {
  it("packs a standing player's box as its half-width, its depth, and its height plus 32", () => {
    const { mins, maxs } = playerBounds(false);
    expect(packSolid(linked(mins, maxs))).toBe((64 << 16) | (24 << 8) | 15);
  });

  it("packs a crouching player's lower top", () => {
    const { mins, maxs } = playerBounds(true);
    expect(packSolid(linked(mins, maxs))).toBe(((CROUCH_HEIGHT + 32) << 16) | (24 << 8) | 15);
  });

  it('packs only what stops a shot or a move: the solid and the body', () => {
    const { mins, maxs } = playerBounds(false);
    expect(packSolid(linked(mins, maxs, CONTENTS.SOLID))).not.toBe(0);
    expect(packSolid(linked(mins, maxs, CONTENTS.CORPSE))).toBe(0);
    expect(packSolid(linked(mins, maxs, 0))).toBe(0);
  });

  it('marks a brush model, whose shape is the map’s, with the value no box makes', () => {
    expect(packSolid(linked(vec3(), vec3(), 0, true))).toBe(SOLID_BMODEL);
  });

  it('takes each size to a whole unit toward zero, and keeps it between 1 and 255', () => {
    // C's float-to-int conversion, then the clamps: "z maxs can be negative...".
    expect(packSolid(linked(vec3(-15.9, -15.9, -24.9), vec3(15.9, 15.9, 32.9)))).toBe(
      (64 << 16) | (24 << 8) | 15
    );
    expect(packSolid(linked(vec3(0, 0, 0), vec3(0.5, 0.5, -40)))).toBe((1 << 16) | (1 << 8) | 1);
    // Which for a box that big is the brush model's value after all, whatever Q3's comment says.
    expect(packSolid(linked(vec3(-300, -300, -300), vec3(300, 300, 300)))).toBe(SOLID_BMODEL);
  });

  it("adds the height's 32 in floats, which can round up to the next unit before it is cut", () => {
    const top = Math.fround(0.99999994);
    expect(packSolid(linked(vec3(-1, -1, -1), vec3(1, 1, top)))).toBe((33 << 16) | (1 << 8) | 1);
  });
});

describe('solidBox', () => {
  it("unpacks a player's box as it was linked", () => {
    for (const ducked of [false, true]) {
      const { mins, maxs } = playerBounds(ducked);
      expect(solidBox(packSolid(linked(mins, maxs)))).toEqual({ mins, maxs });
    }
  });

  it('unpacks the lowest top a byte holds as below the origin', () => {
    expect(solidBox((1 << 16) | (1 << 8) | 1)).toEqual({
      mins: vec3(-1, -1, -1),
      maxs: vec3(1, 1, -31)
    });
  });
});
