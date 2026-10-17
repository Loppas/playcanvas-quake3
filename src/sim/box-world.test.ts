import { describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from '../net/protocol';
import { box, createBoxWorldTrace, createFlatWorldTrace, floorBox } from './box-world';
import { CONTENTS, MASK } from './constants';
import { playerBounds } from './types';
import { vec3 } from './vec3';

/**
 * The trace is the contract every other part of the simulation is written against, so it is
 * tested directly rather than only through pmove.
 */

const { mins, maxs } = playerBounds(false);

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = 24;

/** A player's sweep: past nobody, since the boxes are all there is, and stopped by the solid. */
const PLAYER = [ENTITYNUM_NONE, MASK.PLAYERSOLID] as const;

describe('open space', () => {
  const trace = createBoxWorldTrace([]);

  it('reports a clean move when nothing is in the way', () => {
    const result = trace(vec3(), mins, maxs, vec3(100, 0, 0), ...PLAYER);

    expect(result.fraction).toBe(1);
    expect(result.startsolid).toBe(false);
    expect(result.allsolid).toBe(false);
    expect(result.endpos).toEqual(vec3(100, 0, 0));
  });
});

describe('sweeping into a solid', () => {
  const trace = createFlatWorldTrace([box(100, -100, 0, 200, 100, 100)]);

  it('stops short of the surface rather than touching it', () => {
    const result = trace(vec3(0, 0, GROUND_Z), mins, maxs, vec3(200, 0, GROUND_Z), ...PLAYER);

    // The box's near face is at x = 100 and the player is 15 wide, so contact is at x = 85.
    expect(result.fraction).toBeLessThan(1);
    expect(result.endpos.x).toBeLessThan(85);
    expect(result.endpos.x).toBeGreaterThan(84);
  });

  it('returns a unit normal facing back along the sweep', () => {
    const result = trace(vec3(0, 0, GROUND_Z), mins, maxs, vec3(200, 0, GROUND_Z), ...PLAYER);

    expect(result.normal).toEqual(vec3(-1, 0, 0));
  });

  it('returns the normal of the face it actually hits', () => {
    const above = trace(vec3(150, 0, 200), mins, maxs, vec3(150, 0, GROUND_Z), ...PLAYER);

    expect(above.normal).toEqual(vec3(0, 0, 1));
  });

  it('catches a solid thinner than the sweep, so nothing tunnels', () => {
    const thin = createBoxWorldTrace([box(100, -100, -100, 102, 100, 100)]);
    const result = thin(vec3(0, 0, 0), mins, maxs, vec3(1000, 0, 0), ...PLAYER);

    expect(result.fraction).toBeLessThan(1);
    expect(result.endpos.x).toBeLessThan(85);
  });

  it('scales the fraction to the sweep, not to world distance', () => {
    const short = trace(vec3(0, 0, GROUND_Z), mins, maxs, vec3(170, 0, GROUND_Z), ...PLAYER);
    const long = trace(vec3(0, 0, GROUND_Z), mins, maxs, vec3(340, 0, GROUND_Z), ...PLAYER);

    expect(long.fraction).toBeCloseTo(short.fraction / 2, 2);
    expect(long.endpos.x).toBeCloseTo(short.endpos.x, 2);
  });
});

describe('resting on a surface', () => {
  const trace = createFlatWorldTrace();

  it('does not treat exact contact as penetration', () => {
    // A player standing precisely on the floor must be free to move horizontally; if this
    // reports startsolid, every surface becomes flypaper.
    const result = trace(vec3(0, 0, GROUND_Z), mins, maxs, vec3(100, 0, GROUND_Z), ...PLAYER);

    expect(result.startsolid).toBe(false);
    expect(result.fraction).toBe(1);
  });

  it('still finds the ground on a downward probe from that position', () => {
    const result = trace(vec3(0, 0, GROUND_Z), mins, maxs, vec3(0, 0, GROUND_Z - 0.25), ...PLAYER);

    expect(result.fraction).toBeLessThan(1);
    expect(result.normal).toEqual(vec3(0, 0, 1));
  });
});

describe('starting inside a solid', () => {
  const trace = createBoxWorldTrace([box(-100, -100, -100, 100, 100, 100)]);

  it('reports startsolid and refuses to advance', () => {
    const result = trace(vec3(0, 0, 0), mins, maxs, vec3(500, 0, 0), ...PLAYER);

    expect(result.startsolid).toBe(true);
    expect(result.fraction).toBe(0);
    expect(result.endpos).toEqual(vec3(0, 0, 0));
  });

  it('reports allsolid only when the whole sweep stays inside', () => {
    const escaping = trace(vec3(0, 0, 0), mins, maxs, vec3(500, 0, 0), ...PLAYER);
    const buried = trace(vec3(0, 0, 0), mins, maxs, vec3(1, 0, 0), ...PLAYER);

    expect(escaping.allsolid).toBe(false);
    expect(buried.allsolid).toBe(true);
  });
});

describe('zero-length queries', () => {
  const trace = createBoxWorldTrace([floorBox(), box(-100, -100, 40, 100, 100, 200)]);

  it('reports clear when the box fits', () => {
    const ducked = playerBounds(true);
    const at = vec3(0, 0, GROUND_Z);
    const result = trace(at, ducked.mins, ducked.maxs, at, ...PLAYER);

    expect(result.allsolid).toBe(false);
  });

  it('reports allsolid when the box does not fit', () => {
    // The ceiling is 40 units up; a standing player is 32 above the origin at z = 24.
    const result = trace(vec3(0, 0, GROUND_Z), mins, maxs, vec3(0, 0, GROUND_Z), ...PLAYER);

    expect(result.allsolid).toBe(true);
  });
});

describe('what the boxes say they are', () => {
  const trace = createFlatWorldTrace();
  const down = vec3(0, 0, -100);

  it('names the world, and solid, as what stopped a sweep', () => {
    const hit = trace(vec3(0, 0, GROUND_Z), mins, maxs, down, ENTITYNUM_NONE, MASK.SHOT);

    expect(hit).toMatchObject({ entityNum: ENTITYNUM_WORLD, contents: CONTENTS.SOLID });
  });

  it('is gone through by a mask that does not name solid', () => {
    const through = trace(vec3(0, 0, GROUND_Z), mins, maxs, down, ENTITYNUM_NONE, CONTENTS.BODY);

    expect(through).toMatchObject({ fraction: 1, entityNum: ENTITYNUM_NONE });
  });
});
