import { describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from '../net/protocol';
import { CONTENTS, MASK } from './constants';
import { playerBounds } from './types';
import { createVoxelPointContents, createVoxelTrace } from './voxel-trace';
import { DenseVoxelGrid, type VoxelGrid } from './voxel-grid';
import { vec3, type Vec3 } from './vec3';

/**
 * Unit coverage for the swept-AABB voxel trace: the trace's contract, checked against geometry
 * whose answers are known by construction.
 */

const VOXEL_SIZE = 1.6;
const { mins, maxs } = playerBounds(false);

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = 24;

/**
 * A room with a floor at z = 0 and open space above it.
 *
 * @param build - Adds solids to the carved room.
 */
function room(build: (grid: DenseVoxelGrid) => void = () => {}): VoxelGrid {
  const grid = new DenseVoxelGrid(VOXEL_SIZE, vec3(-320, -320, -64), vec3(960, 320, 320));
  grid.carve(vec3(-320, -320, 0), vec3(960, 320, 320));
  build(grid);
  return grid;
}

/**
 * @param grid - Grid to trace against.
 * @param from - Sweep start.
 * @param to - Sweep end.
 */
function sweep(grid: VoxelGrid, from: Vec3, to: Vec3) {
  return createVoxelTrace(grid)(from, mins, maxs, to, ENTITYNUM_NONE, MASK.PLAYERSOLID);
}

describe('open space', () => {
  it('completes a move with nothing in the way', () => {
    const result = sweep(room(), vec3(0, 0, GROUND_Z), vec3(200, 0, GROUND_Z));

    expect(result.fraction).toBe(1);
    expect(result.startsolid).toBe(false);
    expect(result.endpos).toEqual(vec3(200, 0, GROUND_Z));
  });

  it('does not treat standing on the floor as penetration', () => {
    // The single most important case: if resting exactly on a surface reports startsolid,
    // the player is glued in place forever.
    const result = sweep(room(), vec3(0, 0, GROUND_Z), vec3(200, 0, GROUND_Z));

    expect(result.startsolid).toBe(false);
  });

  it('finds the floor on a downward probe', () => {
    const result = sweep(room(), vec3(0, 0, GROUND_Z), vec3(0, 0, GROUND_Z - 0.25));

    expect(result.fraction).toBeLessThan(1);
    expect(result.normal).toEqual(vec3(0, 0, 1));
  });
});

describe('hitting a solid', () => {
  const wallAtX = 320;
  const walled = room((grid) => {
    grid.fill(vec3(wallAtX, -320, 0), vec3(wallAtX + 64, 320, 320));
  });

  it('stops short of the surface', () => {
    const result = sweep(walled, vec3(0, 0, GROUND_Z), vec3(640, 0, GROUND_Z));

    // Contact is at the wall face minus the player's half-width.
    expect(result.endpos.x).toBeLessThan(wallAtX - 15);
    expect(result.endpos.x).toBeGreaterThan(wallAtX - 16);
  });

  it('returns the exact face normal', () => {
    const result = sweep(walled, vec3(0, 0, GROUND_Z), vec3(640, 0, GROUND_Z));
    expect(result.normal).toEqual(vec3(-1, 0, 0));
  });

  it('returns the normal of a ceiling when moving up into it', () => {
    const ceiling = room((grid) => {
      grid.fill(vec3(-320, -320, 200), vec3(960, 320, 320));
    });
    const result = sweep(ceiling, vec3(0, 0, GROUND_Z), vec3(0, 0, 300));

    expect(result.normal).toEqual(vec3(0, 0, -1));
    expect(result.fraction).toBeLessThan(1);
  });

  it('scales the fraction to the sweep, so a longer sweep stops at the same place', () => {
    const short = sweep(walled, vec3(0, 0, GROUND_Z), vec3(320, 0, GROUND_Z));
    const long = sweep(walled, vec3(0, 0, GROUND_Z), vec3(640, 0, GROUND_Z));

    expect(long.endpos.x).toBeCloseTo(short.endpos.x, 6);
    expect(long.fraction).toBeCloseTo(short.fraction / 2, 6);
  });
});

describe('thin geometry', () => {
  it('catches a wall one voxel thick even at extreme speed', () => {
    // 15 m/s is 480 units per second, but this sweep is a hundred times further than any
    // tick could ever move: the DDA must not step over the wall regardless.
    const thin = room((grid) => {
      grid.fill(vec3(320, -320, 0), vec3(320 + VOXEL_SIZE, 320, 320));
    });
    const result = sweep(thin, vec3(0, 0, GROUND_Z), vec3(960, 0, GROUND_Z));

    expect(result.fraction).toBeLessThan(1);
    expect(result.endpos.x).toBeLessThan(320 - 15);
  });

  it('catches a solid the box would straddle without its centre touching', () => {
    // A knee-high kerb below the origin: only the bottom of the box meets it.
    const kerb = room((grid) => {
      grid.fill(vec3(320, -320, 0), vec3(384, 320, 8));
    });
    const result = sweep(kerb, vec3(0, 0, GROUND_Z), vec3(640, 0, GROUND_Z));

    expect(result.fraction).toBeLessThan(1);
    expect(result.normal).toEqual(vec3(-1, 0, 0));
  });

  it('fits through a gap exactly wide enough for the box', () => {
    const gap = room((grid) => {
      grid.fill(vec3(320, -320, 0), vec3(384, -16, 320));
      grid.fill(vec3(320, 16, 0), vec3(384, 320, 320));
    });
    const result = sweep(gap, vec3(0, 0, GROUND_Z), vec3(640, 0, GROUND_Z));

    expect(result.fraction).toBe(1);
  });
});

describe('starting inside a solid', () => {
  const buried = room((grid) => {
    grid.fill(vec3(-64, -64, 0), vec3(64, 64, 128));
  });

  it('reports startsolid and refuses to advance', () => {
    const result = sweep(buried, vec3(0, 0, GROUND_Z), vec3(640, 0, GROUND_Z));

    expect(result.startsolid).toBe(true);
    expect(result.fraction).toBe(0);
    expect(result.endpos).toEqual(vec3(0, 0, GROUND_Z));
  });

  it('reports allsolid only when the sweep never gets clear', () => {
    const escaping = sweep(buried, vec3(0, 0, GROUND_Z), vec3(640, 0, GROUND_Z));
    const stuck = sweep(buried, vec3(0, 0, GROUND_Z), vec3(1, 0, GROUND_Z));

    expect(escaping.allsolid).toBe(false);
    expect(stuck.allsolid).toBe(true);
  });
});

describe('zero-length queries', () => {
  const lowCeiling = room((grid) => {
    grid.fill(vec3(-320, -320, 48), vec3(960, 320, 320));
  });
  const trace = createVoxelTrace(lowCeiling);
  const at = vec3(0, 0, GROUND_Z);

  it('reports clear when the box fits', () => {
    const ducked = playerBounds(true);
    const fits = trace(at, ducked.mins, ducked.maxs, at, ENTITYNUM_NONE, MASK.PLAYERSOLID);
    expect(fits.allsolid).toBe(false);
  });

  it('reports allsolid when the box does not fit', () => {
    expect(trace(at, mins, maxs, at, ENTITYNUM_NONE, MASK.PLAYERSOLID).allsolid).toBe(true);
  });
});

describe('the world is closed', () => {
  it('treats everything outside the authored region as solid', () => {
    const grid = new DenseVoxelGrid(VOXEL_SIZE, vec3(-64, -64, -64), vec3(64, 64, 64));
    grid.carve(vec3(-64, -64, -64), vec3(64, 64, 64));

    const result = sweep(grid, vec3(0, 0, 0), vec3(640, 0, 0));
    expect(result.fraction).toBeLessThan(1);
  });
});

describe('what the map says it is', () => {
  const trace = createVoxelTrace(room());
  const from = vec3(0, 0, GROUND_Z + 10);
  const down = vec3(0, 0, -100);

  it('names the world, and solid, as what stopped a sweep, and nothing as what did not', () => {
    const hit = trace(from, mins, maxs, down, ENTITYNUM_NONE, MASK.SHOT);
    const miss = trace(from, mins, maxs, vec3(0, 0, 60), ENTITYNUM_NONE, MASK.SHOT);

    expect(hit).toMatchObject({ entityNum: ENTITYNUM_WORLD, contents: CONTENTS.SOLID });
    expect(miss).toMatchObject({ entityNum: ENTITYNUM_NONE, contents: 0, fraction: 1 });
  });

  it('is gone through by a mask that does not name solid, as every voxel is', () => {
    expect(trace(from, mins, maxs, down, ENTITYNUM_NONE, CONTENTS.BODY).fraction).toBe(1);
  });
});

describe('point contents', () => {
  const contents = createVoxelPointContents(room());

  it('is solid in a solid voxel and nothing in an open one, its lower face in it', () => {
    expect(contents(vec3(0, 0, 0), ENTITYNUM_NONE)).toBe(0);
    expect(contents(vec3(10, -10, 100), ENTITYNUM_NONE)).toBe(0);
    expect(contents(vec3(0, 0, -0.01), ENTITYNUM_NONE)).toBe(CONTENTS.SOLID);
    expect(contents(vec3(0, 0, -VOXEL_SIZE), ENTITYNUM_NONE)).toBe(CONTENTS.SOLID);
  });

  it('is solid outside the grid', () => {
    expect(contents(vec3(2000, 0, 10), ENTITYNUM_NONE)).toBe(CONTENTS.SOLID);
  });
});
