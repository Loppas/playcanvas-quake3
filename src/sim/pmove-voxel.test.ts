import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, type PlayerState } from '../net/protocol';
import { DEFAULT_SPEED, PMF_DUCKED, PMOVE_MSEC, STEPSIZE } from './constants';
import { pmove } from './pmove';
import {
  CLIMB_START_X,
  CORRIDOR,
  DOORWAY_WIDTH,
  LANE_MIDDLE,
  LANE_RAMP,
  LANE_STAIRS,
  PIT,
  ROOM,
  RUNWAY_END_X,
  THIN_WALL_X,
  TEST_VOXEL_SIZE,
  UPPER_LEVEL,
  createTestRoom,
  testRoomSpawn
} from './test-room';
import { createIdlePlayerState, createUserCmd, type UserCmd } from './types';
import { createVoxelTrace } from './voxel-trace';
import { DenseVoxelGrid } from './voxel-grid';
import { vec3 } from './vec3';

/**
 * The pmove simulation driven through the synthetic voxel room.
 *
 * Where the box-world tests prove the movement equations, these prove the whole stack — the
 * swept voxel trace, the step move and the ground classification working together on
 * geometry made of 5 cm voxels.
 */

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = 24;

/** Middle of the staircase lane. */
const STAIRS_Y = (LANE_STAIRS.minY + LANE_STAIRS.maxY) / 2;

/** Middle of the ramp lane. */
const RAMP_Y = (LANE_RAMP.minY + LANE_RAMP.maxY) / 2;

const room = createTestRoom();
const trace = createVoxelTrace(room);

let state: PlayerState;

beforeEach(() => {
  state = createIdlePlayerState({ origin: testRoomSpawn() });
});

/**
 * Advance the simulation.
 *
 * @param ticks - Number of {@link PMOVE_MSEC} ticks to run.
 * @param input - Input held for every tick.
 */
function run(ticks: number, input: Partial<UserCmd> = {}) {
  for (let i = 0; i < ticks; i++) {
    pmove(state, createUserCmd({ ...input, serverTime: state.commandTime + PMOVE_MSEC }), trace);
  }
}

/** Horizontal speed, which is what every Quake speed figure refers to. */
function horizontalSpeed(): number {
  return Math.hypot(state.velocity.x, state.velocity.y);
}

describe('walking', () => {
  it('stands on the voxel floor without sinking or sticking', () => {
    run(20);

    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(true);
    expect(state.origin.z).toBeCloseTo(GROUND_Z, 1);
  });

  it('runs the length of the runway at full speed', () => {
    run(125, { forwardmove: 127 });

    expect(horizontalSpeed()).toBe(DEFAULT_SPEED);
    expect(state.origin.x).toBeGreaterThan(200);
    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(true);
  });

  it('stops dead against the wall beside the doorway', () => {
    state.origin = vec3(RUNWAY_END_X - 200, LANE_MIDDLE.maxY - 32, GROUND_Z);
    run(200, { forwardmove: 127 });

    expect(state.origin.x).toBeLessThan(CORRIDOR.minX);
  });

  it('fits through the doorway', () => {
    run(300, { forwardmove: 127 });

    expect(state.origin.x).toBeGreaterThan(CORRIDOR.maxX);
    expect(Math.abs(state.origin.y)).toBeLessThan(DOORWAY_WIDTH / 2);
  });
});

describe('jumping', () => {
  it('jumps and lands back on the voxel floor', () => {
    run(1, { upmove: 127 });
    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(false);

    run(200, { upmove: 127 });
    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(true);
    expect(state.origin.z).toBeCloseTo(GROUND_Z, 0);
  });

  it('keeps its run speed through a jump', () => {
    run(125, { forwardmove: 127 });
    const before = horizontalSpeed();
    run(1, { forwardmove: 127, upmove: 127 });
    run(20, { forwardmove: 127, upmove: 127 });

    expect(horizontalSpeed()).toBe(before);
  });

  it('falls into the pit and cannot step back out', () => {
    state.origin = vec3(PIT.minX - 96, 0, GROUND_Z);
    run(150, { forwardmove: 127 });

    expect(state.origin.z).toBeLessThan(GROUND_Z);
    expect(state.origin.x).toBeGreaterThan(PIT.minX);
    expect(state.origin.x).toBeLessThan(PIT.maxX);
  });
});

describe('crouching', () => {
  it('ducks and moves at a quarter speed', () => {
    run(125, { forwardmove: 127, upmove: -127 });

    expect(state.pmFlags & PMF_DUCKED).toBeTruthy();
    expect(horizontalSpeed()).toBeCloseTo(DEFAULT_SPEED * 0.25, 0);
  });

  it('stands back up in open space', () => {
    run(5, { upmove: -127 });
    run(5);

    expect(state.pmFlags & PMF_DUCKED).toBeFalsy();
  });

  it('stays crouched under a voxel ceiling too low to stand in', () => {
    const grid = new DenseVoxelGrid(TEST_VOXEL_SIZE, vec3(-64, -64, -32), vec3(320, 64, 128));
    grid.carve(vec3(-64, -64, 0), vec3(320, 64, 44.8));
    const lowTrace = createVoxelTrace(grid);

    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    for (let i = 0; i < 10; i++) {
      pmove(
        state,
        createUserCmd({ upmove: -127, serverTime: state.commandTime + PMOVE_MSEC }),
        lowTrace
      );
    }
    for (let i = 0; i < 10; i++) {
      pmove(state, createUserCmd({ serverTime: state.commandTime + PMOVE_MSEC }), lowTrace);
    }

    expect(state.pmFlags & PMF_DUCKED).toBeTruthy();
  });
});

describe('climbing', () => {
  it('climbs the staircase to the upper level', () => {
    state.origin = vec3(CLIMB_START_X - 96, STAIRS_Y, GROUND_Z);
    run(200, { forwardmove: 127 });

    expect(state.origin.z).toBeCloseTo(GROUND_Z + UPPER_LEVEL, 0);
    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(true);
  });

  it('climbs the voxel-stepped ramp to the same level', () => {
    state.origin = vec3(CLIMB_START_X - 96, RAMP_Y, GROUND_Z);
    run(250, { forwardmove: 127 });

    expect(state.origin.z).toBeCloseTo(GROUND_Z + UPPER_LEVEL, 0);
    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(true);
  });

  it('keeps most of its speed going up the ramp', () => {
    // Single-voxel steps are what a voxelised slope really is; the step move should read
    // them as a ramp rather than as a wall to grind against.
    state.origin = vec3(ROOM.minX + 16, RAMP_Y, GROUND_Z);
    run(40, { forwardmove: 127 });
    const onFlat = horizontalSpeed();
    expect(state.origin.x).toBeLessThan(CLIMB_START_X);

    run(60, { forwardmove: 127 });
    expect(state.origin.z).toBeGreaterThan(GROUND_Z);
    expect(horizontalSpeed()).toBeGreaterThan(onFlat * 0.8);
  });

  it('steps up a ledge at the step height but is stopped by a taller one', () => {
    const climbable = ledgeRoom(STEPSIZE - 1.6);
    const tooTall = ledgeRoom(STEPSIZE + 8);

    expect(climbable).toBeGreaterThan(200);
    expect(tooTall).toBeLessThan(200);
  });
});

describe('fast movement', () => {
  it('does not tunnel through a wall one voxel thick at 15 m/s', () => {
    // 15 m/s is 480 units per second at 32 units = 1 m, which is 3.84 units a tick against a
    // 1.6-unit wall: a discrete check at tick boundaries would step straight over it.
    state.origin = vec3(THIN_WALL_X - 20, 0, GROUND_Z);
    state.velocity = vec3(480, 0, 0);
    run(40, { forwardmove: 127 });

    expect(state.origin.x).toBeLessThan(THIN_WALL_X);
    expect(state.origin.x).toBeGreaterThan(THIN_WALL_X - 30);
  });

  it('does not tunnel out through a sealed wall at absurd speed', () => {
    // Far beyond anything the game can produce; the trace should hold regardless.
    const grid = new DenseVoxelGrid(TEST_VOXEL_SIZE, vec3(-64, -64, -32), vec3(320, 64, 160));
    grid.carve(vec3(-64, -64, 0), vec3(320, 64, 160));
    const sealed = createVoxelTrace(grid);

    const player = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    player.velocity = vec3(20_000, 0, 0);
    for (let i = 0; i < 40; i++) {
      pmove(
        player,
        createUserCmd({ forwardmove: 127, serverTime: player.commandTime + PMOVE_MSEC }),
        sealed
      );
    }

    expect(player.origin.x).toBeLessThan(320);
  });

  it('gains speed above the ground cap when strafe jumping', () => {
    run(125, { forwardmove: 127 });
    expect(horizontalSpeed()).toBe(DEFAULT_SPEED);

    let yaw = 0;
    run(1, { forwardmove: 127, upmove: 127, angles: vec3(0, yaw, 0) });
    for (let i = 0; i < 40; i++) {
      yaw += 0.7;
      run(1, {
        forwardmove: 127,
        rightmove: 127,
        upmove: 127,
        angles: vec3(0, yaw, 0)
      });
    }

    expect(horizontalSpeed()).toBeGreaterThan(DEFAULT_SPEED);
    expect(state.origin.x).toBeLessThan(RUNWAY_END_X);
  });
});

/**
 * Run at a ledge of the given height and report how far the player got.
 *
 * @param height - Height of the ledge above the floor.
 */
function ledgeRoom(height: number): number {
  const grid = new DenseVoxelGrid(TEST_VOXEL_SIZE, vec3(-64, -64, -32), vec3(640, 64, 256));
  grid.carve(vec3(-64, -64, 0), vec3(640, 64, 256));
  grid.fill(vec3(200, -64, 0), vec3(640, 64, height));

  const ledgeTrace = createVoxelTrace(grid);
  const player = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
  for (let i = 0; i < 120; i++) {
    pmove(
      player,
      createUserCmd({ forwardmove: 127, serverTime: player.commandTime + PMOVE_MSEC }),
      ledgeTrace
    );
  }

  return player.origin.x;
}
