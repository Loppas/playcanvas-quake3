import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_FRAME_MSEC } from '../server/program';

import { createFlatWorldTrace, box } from '../sim/box-world';
import { DEFAULT_VIEWHEIGHT, PMOVE_MSEC, STEPSIZE } from '../sim/constants';
import {
  CLIMB_START_X,
  LANE_STAIRS,
  STAIR_RISE,
  createTestRoom,
  testRoomSpawn
} from '../sim/test-room';
import type { TraceFn, UserCmd } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { createVoxelTrace } from '../sim/voxel-trace';
import { MAX_BOB_UP, MAX_STEP_CHANGE, STEP_TIME } from './camera-feel';
import { PlayerView } from './player-view';
import { ViewWorld } from './view-test-fixtures';

/**
 * The whole path from input to camera, driven through the voxel room that `pmove-voxel.test.ts`
 * validates the simulation in.
 *
 * The claim being tested is that the camera moves smoothly through geometry the simulation
 * moves through abruptly. That is measured as the eye's movement on the frames where the
 * *origin* moved discontinuously, which isolates the pop from the deliberate glide that
 * follows it.
 */

/**
 * The server's first frame, which the boot's frames are counted from: a match starts 400 ms into
 * its clock, and its first frame is a tick on from there.
 */
const SPAWN_TIME = 400 + PMOVE_MSEC;

/** A display refreshing at 60 Hz, which is not a multiple of the 8 ms simulation tick. */
const FRAME_MSEC = 1000 / 60;

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = 24;

/** Middle of the staircase lane. */
const STAIRS_Y = (LANE_STAIRS.minY + LANE_STAIRS.maxY) / 2;

const room = createTestRoom();
const roomTrace = createVoxelTrace(room);

/**
 * An open floor with nothing above it. The test room is sealed at 160 units, which is not
 * enough headroom to reach the harder landing bands.
 */
const openTrace = createFlatWorldTrace();

let world: ViewWorld;
let view: PlayerView;

beforeEach(() => {
  view = spawn(testRoomSpawn());
});

/**
 * @param origin - Where to place the player.
 * @param trace - World to move through.
 */
function spawn(origin: Vec3, trace: TraceFn = roomTrace): PlayerView {
  world = new ViewWorld({ origin, trace });
  view = world.view;
  return view;
}

/**
 * Fill in the axes a frame did not mention.
 *
 * @param input - Input held this frame.
 */
function cmd(input: Partial<UserCmd> = {}): Omit<UserCmd, 'serverTime'> {
  return {
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
    angles: vec3(),
    buttons: 0,
    weapon: 0,
    ...input
  };
}

/**
 * Render frames, sampling the camera on each.
 *
 * @param frames - Number of frames to run.
 * @param input - Input held for every frame.
 * @param frameMsec - Real time each frame covers.
 * @returns The camera's eye height on each frame.
 */
function render(
  frames: number,
  input: Partial<UserCmd> = {},
  frameMsec = FRAME_MSEC
): number[] {
  const heights: number[] = [];
  for (let i = 0; i < frames; i++) {
    view.advance(frameMsec, cmd(input));
    heights.push(view.view().origin.z);
  }
  return heights;
}

/** @param values - Series to measure. */
function largestJump(values: number[]): number {
  let largest = 0;
  for (let i = 1; i < values.length; i++) {
    largest = Math.max(largest, Math.abs(values[i] - values[i - 1]));
  }
  return largest;
}

describe('the frame and the clock', () => {
  it('starts drawing exactly on the first snapshot', () => {
    // The boot runs until the client is in the world. Its gamestate goes in fragments at the
    // client's rate, which here take the server's first four frames, and the command sent
    // against it puts the client in on the fifth: the first snapshot it has in the world, and the
    // one the drawn clock starts on, rather than at zero, which is the point.
    expect(view.time).toBe(SPAWN_TIME + 4 * PMOVE_MSEC);
  });

  it('runs the host on real time a frame at a time, carrying what is short of a tick', () => {
    const start = world.game.host.time;
    // Three 6 ms frames are 18 ms: two whole ticks with 2 ms still owed.
    for (let i = 0; i < 3; i++) view.advance(6, cmd());
    expect(world.game.host.time - start).toBe(2 * PMOVE_MSEC);
    view.advance(6, cmd());
    expect(world.game.host.time - start).toBe(3 * PMOVE_MSEC);
  });

  it('moves the clock by each frame, fraction and all', () => {
    render(200, {}, 6.5);
    const start = view.time;
    render(100, {}, 6.5);
    // The clock drifts toward the newest snapshot by a share of a millisecond at most as each one
    // comes, and back as far, so over many frames it keeps real time.
    expect(Math.abs(view.time - start - 650)).toBeLessThan(1);
  });

  it('draws a snapshot or so behind the newest, whatever the frames', () => {
    render(600);
    // 600 frames at 60 Hz is 10 seconds.
    expect(world.game.host.time).toBeGreaterThan(SPAWN_TIME + 10_000 - PMOVE_MSEC);
    const behind = world.game.host.time - view.time;
    expect(behind).toBeGreaterThan(5);
    expect(behind).toBeLessThan(FRAME_MSEC + 2 * PMOVE_MSEC);
  });

  it('drops a backlog rather than simulating a minute of held input', () => {
    const start = world.game.host.time;
    const realtime = world.game.connection.clock.realtime;
    view.advance(60_000, cmd());
    expect(world.game.host.time - start).toBe(MAX_FRAME_MSEC);
    // The server runs in this frame, so the client's clock clamps with it, as Q3's listen server
    // does: a client whose server is elsewhere keeps real time to 5000 (`MAX_REMOTE_FRAME_MSEC`).
    expect(world.game.connection.clock.realtime - realtime).toBe(MAX_FRAME_MSEC);
  });

  it('lets no time pass in a frame of none', () => {
    render(10);
    const [host, time] = [world.game.host.time, view.time];
    view.advance(0, cmd());
    expect([world.game.host.time, view.time]).toEqual([host, time]);
  });
});

describe('drawing between snapshots', () => {
  const FORWARD = { forwardmove: 127 };

  it('draws the player between the snapshots the clock is between, by where it is', () => {
    render(60, FORWARD, PMOVE_MSEC);

    const atTick = view.sample().origin.x;
    view.advance(PMOVE_MSEC, cmd(FORWARD));
    const afterTick = view.sample().origin.x;

    // Half a tick of the clock is half a tick of the run, less the clock's drift, a share of a
    // millisecond at most.
    view.advance(PMOVE_MSEC / 2, cmd(FORWARD));
    expect(Math.abs(view.sample().origin.x - (afterTick + (afterTick - atTick) / 2))).toBeLessThan(
      0.15
    );
  });

  it('never draws the player past the newest predicted step', () => {
    // The drawn position is the blend of the last two predicted steps, so it trails the
    // newest one by less than one step of the run and never passes it.
    render(60, FORWARD, PMOVE_MSEC);
    view.advance(PMOVE_MSEC * 0.9, cmd(FORWARD));
    const drawn = view.sample().origin.x;
    const newest = view.player.origin.x;
    expect(drawn).toBeLessThanOrEqual(newest);
    expect(drawn).toBeGreaterThan(newest - 4);
  });

  it('turns the camera on the frame the mouse turned it, before any snapshot says so', () => {
    render(30);
    const facing = view.sample().viewangles.y;
    view.advance(1, cmd({ angles: vec3(0, 30, 0) }));
    expect(view.sample().viewangles.y - facing).toBeCloseTo(30, 1);
    // The snapshot's own angles have not heard of it.
    expect(view.player.viewangles.y).toBeCloseTo(facing, 4);
  });

  it('smooths the 125 Hz simulation onto a 60 Hz display', () => {
    // The prediction's blend: a 60 Hz frame covers two or three 8 ms steps, so without it
    // the drawn speed would alternate by half every frame.
    render(120, FORWARD);

    const drawn = [view.sample().origin.x];
    const steps = [view.player.origin.x];
    for (let i = 0; i < 30; i++) {
      view.advance(FRAME_MSEC, cmd(FORWARD));
      drawn.push(view.sample().origin.x);
      steps.push(view.player.origin.x);
    }

    const deltas = (values: number[]): number[] =>
      values.slice(1).map((x, i) => x - values[i]);
    const drawnSpread = spread(deltas(drawn));
    // The step itself alternates by half; the blend leaves a few percent, the clock's own drift.
    expect(drawnSpread).toBeLessThan(spread(deltas(steps)) / 4);
    expect(drawnSpread).toBeLessThan(0.5);
  });
});

describe('stairs', () => {
  /**
   * Walk forward, recording the eye and the origin it follows.
   *
   * @param frames - Number of frames to run.
   * @returns Eye heights and origin heights, frame for frame.
   */
  function walk(frames: number): { eye: number[]; origin: number[] } {
    const eye: number[] = [];
    const origin: number[] = [];
    for (let i = 0; i < frames; i++) {
      view.advance(FRAME_MSEC, cmd({ forwardmove: 127 }));
      eye.push(view.view().origin.z);
      origin.push(view.player.origin.z);
    }
    return { eye, origin };
  }

  const climb = () => {
    spawn(vec3(CLIMB_START_X - 128, STAIRS_Y, GROUND_Z));
    return walk(120);
  };

  /**
   * How far the eye moved on each frame that the origin was teleported up a step.
   *
   * This is the pop, isolated from the glide that follows it: the glide's own 1-2 units per
   * frame is motion the player is meant to see, whereas anything happening *on* the step
   * frame is the jolt the layer exists to remove.
   *
   * @param series - Eye and origin heights from {@link walk}.
   */
  function popsAtSteps({ eye, origin }: { eye: number[]; origin: number[] }): number[] {
    const pops: number[] = [];
    for (let i = 1; i < origin.length; i++) {
      if (origin[i] - origin[i - 1] > STEPSIZE / 4) {
        pops.push(Math.abs(eye[i] - eye[i - 1]));
      }
    }
    return pops;
  }

  it('climbs the staircase', () => {
    climb();
    expect(view.player.origin.z).toBeGreaterThan(GROUND_Z + STAIR_RISE * 3);
  });

  it('absorbs each step the origin teleports up', () => {
    const series = climb();
    const pops = popsAtSteps(series);

    expect(pops.length).toBeGreaterThan(3);
    // The glide absorbs each 12.8-unit teleport. An isolated step bands to 12 (delta < 15),
    // leaving ~0.8; the worst per-frame residual over a fast continuous climb (multi-tick
    // frames and the 32-unit glide clamp) is larger but still well under a raw step. Q3 keeps a
    // small residual on any stair that is not a multiple of 4 — see the exact 16-unit case below.
    expect(Math.max(...pops)).toBeLessThan(STAIR_RISE / 4);
  });

  it('glides a canonical 16-unit stair away exactly', () => {
    // 16 is the rise Q3's maps are built on, and the one its four event bands report exactly.
    const rise = 16;
    spawn(vec3(0, 0, GROUND_Z), createFlatWorldTrace([box(128, -256, 0, 4096, 256, rise)]));
    const pops = popsAtSteps(walk(90));

    // What survives is the glide's own decay, not the step: a 60 Hz frame covers two ticks, so
    // the step is taken part-way through the frame it is drawn on and the glide has already run
    // for a tick or so of its 200 ms by then. That much of the step shows, and nothing more.
    expect(pops.length).toBe(1);
    expect(pops[0]).toBeLessThan((rise * (PMOVE_MSEC + FRAME_MSEC)) / STEP_TIME);
  });

  it("glides a whole 18-unit stair away under CPMA's rise, where id's leaves 2 to pop", () => {
    /** How far the eye moved on the tick the origin went up the stair. */
    const pop = (cvars: Record<string, string>): number => {
      const trace = createFlatWorldTrace([box(128, -256, 0, 4096, 256, 18)]);
      view = new ViewWorld({ origin: vec3(0, 0, GROUND_Z), trace, cvars }).view;
      for (let tick = 0; tick < 180; tick++) {
        const before = { origin: view.player.origin.z, eye: view.view().origin.z };
        view.advance(PMOVE_MSEC, cmd({ forwardmove: 127 }));
        if (view.player.origin.z - before.origin > STEPSIZE / 4) {
          return view.view().origin.z - before.eye;
        }
      }
      throw new Error('the stair was never climbed');
    };
    expect(pop({})).toBeCloseTo(2.03, 1);
    expect(pop({ pmove_StepRise: '1' })).toBeCloseTo(0.03, 1);
  });

  it('does not interpolate through a step, which is a teleport rather than motion', () => {
    const rise = 16;
    spawn(vec3(0, 0, GROUND_Z), createFlatWorldTrace([box(128, -256, 0, 4096, 256, rise)]));
    // A tick at a time, so the step is the last one the frame ran and what it left is what is
    // drawn: a frame covering two would refresh the blend from the tick after it.
    for (let tick = 0; tick < 180; tick++) {
      const before = view.player.origin.z;
      view.advance(PMOVE_MSEC, cmd({ forwardmove: 127 }));
      if (view.player.origin.z - before <= STEPSIZE / 4) continue;

      // The glide subtracts the step from the eye, and what it subtracts from has to be at the
      // level the step reached: blending up to it as well would draw the pop twice over.
      expect(view.sample().origin.z).toBeCloseTo(view.player.origin.z, 6);
      return;
    }
    throw new Error('the stair was never climbed');
  });

  it('holds a step while the stair lies between the blended pair, above 125 Hz', () => {
    // Above 125 Hz a frame is often shorter than the 8 ms step, so the same pair — previousStep
    // to state — is drawn again on frames that make no new step. The snap used to last only the
    // frame that played the event, and the blend then crossed the stair, dipping the eye: up to
    // 7.7 u on a 16-unit stair at 240 Hz. The snap must hold for as long as the stair lies
    // between the pair: a step snaps while the eye glides.
    for (const hz of [144, 240]) {
      spawn(vec3(CLIMB_START_X - 128, STAIRS_Y, GROUND_Z));
      const frameMsec = 1000 / hz;
      // Let the spawn's own drop land first: its dip is not a stair.
      for (let i = 0; i < Math.ceil(hz / 2); i++) view.advance(frameMsec, cmd());
      let worstDrop = 0;
      let previousEye = view.view().origin.z;
      for (let i = 0; i < Math.ceil(hz * 2.5); i++) {
        view.advance(frameMsec, cmd({ forwardmove: 127 }));
        const eye = view.view().origin.z;
        worstDrop = Math.max(worstDrop, previousEye - eye);
        previousEye = eye;
      }
      // The climb only ever raises the eye; only the bob (a tenth of a unit) may dip it, never a
      // stair let back down by the blend.
      expect(worstDrop, `at ${hz} Hz`).toBeLessThan(1);
    }
  });

  it('glides each step on the predicted path, where the move itself popped', () => {
    // `camera-feel`'s step smoothing runs on the predicted state, so the eye leads the drawn
    // origin by whatever of the step is still gliding rather than jumping with it.
    spawn(vec3(CLIMB_START_X - 128, STAIRS_Y, GROUND_Z));
    // Let the spawn's own drop land first: its dip is not a stair.
    for (let i = 0; i < 20; i++) view.advance(PMOVE_MSEC, cmd());
    let climbed = false;
    let glided = false;
    for (let i = 0; i < 120; i++) {
      view.advance(PMOVE_MSEC, cmd({ forwardmove: 127 }));
      const { origin, viewheight } = view.sample();
      const eye = view.view().origin.z;
      // The eye sits at the drawn eye, within a landing dip below (a stair's own fall event) and
      // the biggest step glide and bob above.
      expect(eye).toBeGreaterThan(origin.z + viewheight - 24 - MAX_BOB_UP);
      expect(eye).toBeLessThan(origin.z + viewheight + MAX_STEP_CHANGE + MAX_BOB_UP);
      glided ||= eye > origin.z + viewheight + 1;
      climbed ||= origin.z > GROUND_Z + STAIR_RISE;
    }
    expect(climbed).toBe(true);
    expect(glided).toBe(true);
  });

  it('leaves no residual once the climb is over', () => {
    climb();
    const settled = render(30);
    expect(settled.at(-1)).toBeCloseTo(view.player.origin.z + DEFAULT_VIEWHEIGHT, 6);
  });
});

describe('landing dips', () => {
  /**
   * Drop the player onto open ground and render until the dip has fully recovered.
   *
   * @param height - Height above the floor to fall from.
   * @returns Eye heights from the landing onwards, and how deep the deepest dip was.
   */
  function dropOnto(height: number): { eye: number[]; depth: number } {
    spawn(vec3(0, 0, GROUND_Z + height), openTrace);

    // Effective gravity is 750, not 800 — the velocity snap.
    const fallFrames = Math.ceil((Math.sqrt((2 * height) / 750) * 1000) / FRAME_MSEC) + 1;
    render(fallFrames);

    const eye = render(60);
    // Measured against where the player actually came to rest, which is the trace's
    // SURFACE_CLIP_EPSILON above the floor rather than exactly on it.
    const resting = view.player.origin.z + DEFAULT_VIEWHEIGHT;
    return { eye, depth: resting - Math.min(...eye) };
  }

  it('dips the camera below the resting eye height, then recovers', () => {
    const { eye, depth } = dropOnto(300);

    expect(depth).toBeGreaterThan(8);
    expect(eye.at(-1)).toBeCloseTo(view.player.origin.z + DEFAULT_VIEWHEIGHT, 6);
  });

  it('dips further after a harder fall', () => {
    const shallow = dropOnto(100).depth;
    const deep = dropOnto(450).depth;

    expect(shallow).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(shallow);
  });

  it('does not dip when stepping off a kerb', () => {
    // Under the 47-unit threshold the landing is a footstep, and the camera does not move.
    expect(dropOnto(16).depth).toBeCloseTo(0, 6);
  });
});

describe('running bobs', () => {
  it('oscillates the eye while running and holds it still while standing', () => {
    const runningSpread = spread(render(120, { forwardmove: 127 }).slice(30));
    spawn(testRoomSpawn());
    const standingSpread = spread(render(120).slice(30));

    expect(runningSpread).toBeGreaterThan(1);
    expect(standingSpread).toBe(0);
  });

  it('bobs the view angles as well as the eye', () => {
    const pitches: number[] = [];
    for (let i = 0; i < 120; i++) {
      view.advance(FRAME_MSEC, cmd({ forwardmove: 127 }));
      pitches.push(view.view().angles.x);
    }
    expect(spread(pitches.slice(30))).toBeGreaterThan(0.1);
  });

  it('stops bobbing when the player stops', () => {
    render(120, { forwardmove: 127 });
    const stopped = render(120).slice(60);
    expect(spread(stopped)).toBe(0);
  });
});

describe('crouching', () => {
  it('glides the eye down rather than dropping it', () => {
    render(30);
    const ducking = render(30, { upmove: -127 });

    expect(largestJump(ducking)).toBeLessThan(DEFAULT_VIEWHEIGHT / 4);
    expect(ducking.at(-1)).toBeCloseTo(view.player.origin.z + view.player.viewheight, 6);
  });
});

/** @param values - Series to measure. */
function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}
