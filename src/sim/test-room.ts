import { DenseVoxelGrid } from './voxel-grid';
import { vec3, type Vec3 } from './vec3';

/**
 * A synthetic voxel room exercising every basic movement behaviour: a flat
 * runway, a climbable staircase, a voxel-stepped ramp, a doorway, a pit, and a wall one
 * voxel thick.
 *
 * For testing it is better than a real map: every dimension here is known exactly, so a
 * failure points at the simulation rather than at the scan.
 *
 * All measurements are Q3 units, Z-up, at the project's 32 units = 1 m scale.
 */

/** 5 cm voxels — `splat-transform --voxel-size` default, expressed in Q3 units. */
export const TEST_VOXEL_SIZE = 1.6;

/** Rise of one staircase step. Below STEPSIZE (18), so it is climbable. */
export const STAIR_RISE = 12.8;

/** Depth of one staircase step. */
export const STAIR_TREAD = 32;

/**
 * Number of staircase steps. Chosen so that a standing player still has headroom on the
 * upper level: the climb must leave more than the 56-unit player height below the ceiling.
 */
export const STAIR_COUNT = 6;

/** Height of the upper level that both the staircase and the ramp reach. */
export const UPPER_LEVEL = STAIR_RISE * STAIR_COUNT;

/** Horizontal run of one ramp step: a 1:2 grade built from single voxels. */
export const RAMP_RUN = TEST_VOXEL_SIZE * 2;

/** X at which the staircase and the ramp begin. */
export const CLIMB_START_X = 128;

/** X of the near face of the wall that is one voxel thick. */
export const THIN_WALL_X = 900;

/** Width of the doorway through the corridor pinch. */
export const DOORWAY_WIDTH = 64;

/** X range occupied by the corridor pinch. */
export const CORRIDOR = { minX: 640, maxX: 672 };

/**
 * The pit in the middle lane, cut through the floor.
 *
 * Wide enough that a sprinting player cannot cross it: at 320 ups it takes half a second,
 * by which time the fall is far deeper than the 18-unit step height, so the far lip cannot
 * be stepped back onto.
 */
export const PIT = { minX: 704, maxX: 864 };

export const ROOM = {
  minX: -32,
  maxX: 960,
  minY: -256,
  maxY: 256,
  floorZ: 0,
  // Clears the upper level by more than a standing player's 56 units, so the staircase and
  // ramp can actually be stood on at the top.
  ceilingZ: 160,
  basementZ: -32
};

/** The middle lane: flat floor the length of the room, and the running runway. */
export const LANE_MIDDLE = { minY: -128, maxY: 128 };

/** The staircase lane. */
export const LANE_STAIRS = { minY: ROOM.minY, maxY: LANE_MIDDLE.minY };

/** The ramp lane. */
export const LANE_RAMP = { minY: LANE_MIDDLE.maxY, maxY: ROOM.maxY };

/** X beyond which the runway is no longer clear. */
export const RUNWAY_END_X = CORRIDOR.minX;

/**
 * Build the test room.
 *
 * The grid starts fully solid and the room is carved out of it, exactly as
 * `splat-transform --voxel-carve` produces a playable volume from a scan. Everything beyond
 * the authored region stays solid, so the room is sealed by construction.
 */
export function createTestRoom(): DenseVoxelGrid {
  const grid = new DenseVoxelGrid(
    TEST_VOXEL_SIZE,
    vec3(ROOM.minX, ROOM.minY, ROOM.basementZ),
    vec3(ROOM.maxX, ROOM.maxY, ROOM.ceilingZ)
  );

  grid.carve(
    vec3(ROOM.minX, ROOM.minY, ROOM.floorZ),
    vec3(ROOM.maxX, ROOM.maxY, ROOM.ceilingZ)
  );

  addClimb(grid, LANE_STAIRS, STAIR_TREAD, STAIR_RISE, STAIR_COUNT);
  // Rounded, not divided: UPPER_LEVEL is built by repeated addition, so the quotient can
  // land a hair above the whole number and add a step the ramp was never meant to have.
  addClimb(grid, LANE_RAMP, RAMP_RUN, TEST_VOXEL_SIZE, Math.round(UPPER_LEVEL / TEST_VOXEL_SIZE));
  addCorridor(grid);
  addPit(grid);
  addThinWall(grid);

  return grid;
}

/** Where a standing player starts: on the floor of the middle lane, at the west end. */
export function testRoomSpawn(): Vec3 {
  return vec3(0, 0, 24);
}

/**
 * Build a flight of steps rising to {@link UPPER_LEVEL}.
 *
 * Only the band each step adds is filled; the volume beneath it is already solid from the
 * steps below, which keeps the authoring cost proportional to the surface rather than to the
 * volume.
 *
 * @param grid - Grid to write into.
 * @param lane - Y range the flight occupies.
 * @param run - Horizontal depth of one step.
 * @param rise - Vertical height of one step.
 * @param count - Number of steps.
 */
function addClimb(
  grid: DenseVoxelGrid,
  lane: { minY: number; maxY: number },
  run: number,
  rise: number,
  count: number
) {
  for (let step = 0; step < count; step++) {
    grid.fill(
      vec3(CLIMB_START_X + step * run, lane.minY, step * rise),
      vec3(ROOM.maxX, lane.maxY, (step + 1) * rise)
    );
  }
}

/**
 * A full-height wall across the room, with a doorway in the middle lane.
 *
 * @param grid - Grid to write into.
 */
function addCorridor(grid: DenseVoxelGrid) {
  grid.fill(
    vec3(CORRIDOR.minX, ROOM.minY, ROOM.floorZ),
    vec3(CORRIDOR.maxX, ROOM.maxY, ROOM.ceilingZ)
  );
  grid.carve(
    vec3(CORRIDOR.minX, -DOORWAY_WIDTH / 2, ROOM.floorZ),
    vec3(CORRIDOR.maxX, DOORWAY_WIDTH / 2, ROOM.ceilingZ)
  );
}

/**
 * A hole through the floor of the middle lane.
 *
 * @param grid - Grid to write into.
 */
function addPit(grid: DenseVoxelGrid) {
  grid.carve(
    vec3(PIT.minX, LANE_MIDDLE.minY, ROOM.basementZ),
    vec3(PIT.maxX, LANE_MIDDLE.maxY, ROOM.floorZ)
  );
}

/**
 * A wall one voxel thick, for checking that fast movers cannot pass through it.
 *
 * @param grid - Grid to write into.
 */
function addThinWall(grid: DenseVoxelGrid) {
  grid.fill(
    vec3(THIN_WALL_X, LANE_MIDDLE.minY, ROOM.floorZ),
    vec3(THIN_WALL_X + TEST_VOXEL_SIZE, LANE_MIDDLE.maxY, ROOM.ceilingZ)
  );
}
