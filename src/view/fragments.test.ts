import { describe, expect, it, vi } from 'vitest';

import { createFlatWorldTrace } from '../sim/box-world';
import { CONTENTS } from '../sim/constants';
import { distinctAsks, recordingTrace } from '../sim/trace-test-fixtures';
import { vec3, type Vec3 } from '../sim/vec3';
import {
  BLOOD_PUFF_DROP,
  BLOOD_PUFF_LIFETIME,
  BLOOD_TRAIL_STEP,
  Fragments,
  GIB_JUMP,
  GIB_LIFETIME,
  GIB_LIFETIME_SPREAD,
  GIB_VELOCITY,
  LEMT,
  SINK_DEPTH,
  SINK_TIME,
  drawBloodPuff,
  fallPosition,
  type BounceMark,
  type GibSound
} from './fragments';
import { LocalEntities, MAX_LOCAL_ENTITIES } from './local-entities';

/**
 * `CG_GibPlayer` and the fragments it throws, against Q3's numbers, on a floor whose surface is
 * z = 0.
 */

const floor = createFlatWorldTrace();

/** Far above anything thrown, so no puff is let go for the view being inside it. */
const FAR_EYE = vec3(0, 0, 100_000);

/** About 60 fps, in whole milliseconds as `cg.time` counts. */
const FRAME = 16;

describe('Fragments.gibPlayer', () => {
  it('throws the skull or the brain, then nine pieces more, two of them legs', () => {
    const skull = new Fragments(() => 0.25);
    skull.gibPlayer(vec3(0, 0, 24), 0);
    expect(skull.gibs.map((gib) => gib.piece)).toEqual([
      'skull',
      'abdomen',
      'arm',
      'chest',
      'fist',
      'foot',
      'forearm',
      'intestine',
      'leg',
      'leg'
    ]);

    const brain = new Fragments(() => 0.75);
    brain.gibPlayer(vec3(0, 0, 24), 0);
    expect(brain.gibs[0].piece).toBe('brain');
  });

  it('throws only the skull or the brain with cg_gibs 0', () => {
    const fragments = new Fragments(() => 0.25);
    fragments.gibPlayer(vec3(0, 0, 24), 0, false);
    expect(fragments.gibs.map((gib) => gib.piece)).toEqual(['skull']);
  });

  it('throws each piece at up to 250 along each axis, and 250 more upward', () => {
    const low = new Fragments(() => 0);
    low.gibPlayer(vec3(), 0);
    for (const gib of low.gibs) {
      expect(gib.delta).toEqual(vec3(-GIB_VELOCITY, -GIB_VELOCITY, GIB_JUMP - GIB_VELOCITY));
    }

    const high = new Fragments(() => 0.999_999);
    high.gibPlayer(vec3(), 0);
    for (const gib of high.gibs) {
      expect(gib.delta.x).toBeCloseTo(GIB_VELOCITY, 2);
      expect(gib.delta.z).toBeCloseTo(GIB_JUMP + GIB_VELOCITY, 2);
    }
  });

  it('keeps each piece for 5 s and up to 3 s more', () => {
    const early = new Fragments(() => 0);
    early.gibPlayer(vec3(), 1000);
    expect(early.gibs[0].endTime).toBe(1000 + GIB_LIFETIME);

    const late = new Fragments(() => 0.5);
    late.gibPlayer(vec3(), 1000);
    expect(late.gibs[0].endTime).toBe(1000 + GIB_LIFETIME + GIB_LIFETIME_SPREAD / 2);
  });
});

describe('fallPosition', () => {
  it("falls under Q3's 800, with no snap", () => {
    expect(fallPosition(vec3(0, 0, 100), vec3(10, 0, 0), 0, 1000)).toEqual(vec3(10, 0, -300));
  });
});

describe('Fragments.update', () => {
  it('trails a puff at each 150 ms mark it passes in the air, and none after its first bounce', () => {
    // Straight up at 250, from 1000 above the floor: it lands just short of 2 s.
    const fragments = new Fragments(() => 0.5);
    fragments.gibPlayer(vec3(0, 0, 1000), 0, false);
    let time = 0;
    fragments.update(time, floor, FAR_EYE);
    while (fragments.gibs[0].bleeding) {
      time += FRAME;
      fragments.update(time, floor, FAR_EYE);
    }
    const marks: number[] = [];
    for (let t = BLOOD_TRAIL_STEP; t <= time - FRAME; t += BLOOD_TRAIL_STEP) marks.push(t);
    expect(marks.length).toBeGreaterThan(10);
    expect(fragments.puffs.map((puff) => puff.startTime)).toEqual(marks);

    for (let i = 0; i < 30; i++) {
      time += FRAME;
      fragments.update(time, floor, FAR_EYE);
    }
    expect(Math.max(...fragments.puffs.map((puff) => puff.startTime))).toBe(marks[marks.length - 1]);
  });

  it('splats on its first bounce only, where it hit', () => {
    // 0.25 throws the skull, and on its bounce draws a splat, the second of the three.
    const fragments = new Fragments(() => 0.25);
    fragments.gibPlayer(vec3(0, 0, 100), 0, false);
    const sounds: GibSound[] = [];
    for (let time = 0; time < 5000 && !fragments.gibs[0].resting; time += FRAME) {
      sounds.push(...fragments.update(time, floor, FAR_EYE).sounds);
    }
    expect(fragments.gibs[0].resting).toBe(true);
    expect(sounds).toHaveLength(1);
    expect(sounds[0].path).toBe('sound/player/gibimp2.wav');
    expect(sounds[0].origin.z).toBeGreaterThanOrEqual(0);
    expect(sounds[0].origin.z).toBeLessThan(0.25);
  });

  it('leaves its blood where it first bounces, and nowhere after, by its own random', () => {
    const marks: { markType: number; z: number; normal: Vec3; time: number; drawn: number }[] = [];
    const bounceMark: BounceMark = (markType, origin, normal, random, time) =>
      marks.push({ markType, z: origin.z, normal: { ...normal }, time, drawn: random() });
    const fragments = new Fragments(() => 0.25, new LocalEntities(), bounceMark);
    fragments.gibPlayer(vec3(0, 0, 100), 0, false);
    let landed = 0;
    for (let time = 0; time < 5000 && !fragments.gibs[0].resting; time += FRAME) {
      fragments.update(time, floor, FAR_EYE);
      if (landed === 0 && marks.length > 0) landed = time;
    }
    expect(marks).toEqual([
      { markType: LEMT.BLOOD, z: marks[0].z, normal: vec3(0, 0, 1), time: landed, drawn: 0.25 }
    ]);
    expect(marks[0].z).toBeGreaterThanOrEqual(0);
    expect(marks[0].z).toBeLessThan(0.25);
  });

  it('leaves no blood where it goes in nodrop', () => {
    const bounceMark = vi.fn<BounceMark>();
    const fragments = new Fragments(() => 0.25, new LocalEntities(), bounceMark);
    fragments.gibPlayer(vec3(0, 0, 100), 0, false);
    for (let time = 0; time < 5000 && fragments.gibs.length > 0; time += FRAME) {
      fragments.update(time, floor, FAR_EYE, () => CONTENTS.NODROP);
    }
    expect(bounceMark).not.toHaveBeenCalled();
  });

  it('falls through nodrop, and goes, silent and undrawn, at the first thing it hits there', () => {
    // 0.25 would splat on the bounce. Nodrop everywhere: only a hit asks it.
    const pool = new LocalEntities();
    const fragments = new Fragments(() => 0.25, pool);
    fragments.gibPlayer(vec3(0, 0, 100), 0, false);
    const asked: { point: number; pass: number }[] = [];
    const nodrop = (point: { z: number }, pass: number) => {
      asked.push({ point: point.z, pass });
      return CONTENTS.NODROP;
    };
    let time = 0;
    let frame = fragments.update(time, floor, FAR_EYE, nodrop);
    while (fragments.gibs.length > 0 && time < 5000) {
      expect(frame.gibs).toHaveLength(1);
      time += FRAME;
      frame = fragments.update(time, floor, FAR_EYE, nodrop);
    }
    expect(time).toBeGreaterThan(FRAME);
    expect([frame.gibs, frame.sounds]).toEqual([[], []]);
    // Its puffs stay; its own place is given back.
    expect(pool.count).toBe(fragments.puffs.length);
    // Asked once, where it struck the floor, of `CG_PointContents` passing entity 0.
    expect(asked).toHaveLength(1);
    expect(asked[0].point).toBeGreaterThanOrEqual(0);
    expect(asked[0].point).toBeLessThan(0.25);
    expect(asked[0].pass).toBe(0);
  });

  it('bounces and splats as ever where what it hits is not nodrop', () => {
    const fragments = new Fragments(() => 0.25);
    fragments.gibPlayer(vec3(0, 0, 100), 0, false);
    const water = () => CONTENTS.WATER | CONTENTS.FOG;
    const sounds: GibSound[] = [];
    for (let time = 0; time < 5000 && !fragments.gibs[0].resting; time += FRAME) {
      sounds.push(...fragments.update(time, floor, FAR_EYE, water).sounds);
    }
    expect(fragments.gibs).toHaveLength(1);
    expect(sounds).toHaveLength(1);
  });

  it('comes to rest where its last frame in the air left it, then sinks 16 over its last second', () => {
    const fragments = new Fragments(() => 0.5);
    fragments.gibPlayer(vec3(0, 0, 100), 0, false);
    const gib = fragments.gibs[0];
    let time = 0;
    while (!gib.resting && time < gib.endTime) {
      fragments.update(time, floor, FAR_EYE);
      time += FRAME;
    }
    expect(gib.resting).toBe(true);
    // The last bounce left it rising under 40 ups; it rests a frame's fall or less off the floor.
    expect(gib.delta.z).toBeLessThan(40);
    const rest = gib.origin.z;
    expect(rest).toBeGreaterThanOrEqual(0);
    expect(rest).toBeLessThan(4);

    const resting = fragments.update(gib.endTime - SINK_TIME - FRAME, floor, FAR_EYE);
    expect(resting.gibs[0].lightOrigin).toEqual(resting.gibs[0].origin);
    const sinking = fragments.update(gib.endTime - SINK_TIME / 2, floor, FAR_EYE);
    expect(sinking.gibs[0].origin.z).toBeCloseTo(rest - SINK_DEPTH / 2, 6);
    // Lit where it came to rest, so the floor does not put it in the dark.
    expect(sinking.gibs[0].lightOrigin).toEqual({ ...gib.origin });
    expect(fragments.update(gib.endTime, floor, FAR_EYE).gibs).toEqual([]);
    expect(fragments.gibs).toEqual([]);
  });

  it('lets a puff go when the view is inside it', () => {
    const fragments = new Fragments(() => 0.5);
    fragments.gibPlayer(vec3(0, 0, 1000), 0, false);
    for (let time = 0; time <= 160; time += FRAME) fragments.update(time, floor, FAR_EYE);
    expect(fragments.puffs).toHaveLength(1);

    const puff = fragments.puffs[0];
    fragments.update(176, floor, drawBloodPuff(puff, 176).origin);
    expect(fragments.puffs).not.toContain(puff);
  });

  it('clears everything, as a restart does', () => {
    const fragments = new Fragments(() => 0.5);
    fragments.gibPlayer(vec3(0, 0, 1000), 0);
    for (let time = 0; time <= 320; time += FRAME) fragments.update(time, floor, FAR_EYE);
    fragments.clear();
    expect(fragments.gibs).toEqual([]);
    expect(fragments.puffs).toEqual([]);
  });

  it('holds a local entity for each piece and each puff, and gives each back as it goes', () => {
    const pool = new LocalEntities();
    const fragments = new Fragments(() => 0.5, pool);
    fragments.gibPlayer(vec3(0, 0, 1000), 0);
    expect(pool.count).toBe(10);
    // Two marks passed: a puff from each of the ten pieces at each.
    for (let time = 0; time <= 2 * BLOOD_TRAIL_STEP + FRAME; time += FRAME) {
      fragments.update(time, floor, FAR_EYE);
    }
    expect([fragments.puffs.length, pool.count]).toEqual([20, 30]);
    // The first mark's puffs go after their two seconds.
    fragments.update(BLOOD_TRAIL_STEP + BLOOD_PUFF_LIFETIME, floor, FAR_EYE);
    expect(pool.count).toBe(fragments.gibs.length + fragments.puffs.length);
    // And every piece after its time, and the rest of the puffs.
    fragments.update(GIB_LIFETIME + GIB_LIFETIME_SPREAD, floor, FAR_EYE);
    expect([fragments.gibs.length, fragments.puffs.length, pool.count]).toEqual([0, 0, 0]);
    fragments.gibPlayer(vec3(0, 0, 1000), 9000);
    fragments.clear();
    expect(pool.count).toBe(0);
  });

  it('lets a piece or a puff go when the pool frees its place for a newer local entity', () => {
    const pool = new LocalEntities();
    const fragments = new Fragments(() => 0.5, pool);
    fragments.gibPlayer(vec3(0, 0, 1000), 0, false);
    let time = 0;
    for (; time <= BLOOD_TRAIL_STEP + FRAME; time += FRAME) fragments.update(time, floor, FAR_EYE);
    expect([fragments.gibs.length, fragments.puffs.length]).toEqual([1, 1]);
    // The skull's place goes first, its puff's next.
    for (let i = 2; i <= MAX_LOCAL_ENTITIES; i++) pool.alloc();
    fragments.update(time, floor, FAR_EYE);
    expect([fragments.gibs.length, fragments.puffs.length]).toEqual([0, 1]);
    pool.alloc();
    fragments.update(time + FRAME, floor, FAR_EYE);
    expect([fragments.gibs.length, fragments.puffs.length]).toEqual([0, 0]);
  });

  it("draws a piece and a puff with their places' serials, which order them in a scene", () => {
    const pool = new LocalEntities();
    // Two made before, so the skull's is 2 and its puff's 3.
    pool.alloc();
    pool.alloc();
    const fragments = new Fragments(() => 0.5, pool);
    fragments.gibPlayer(vec3(0, 0, 1000), 0, false);
    let frame = fragments.update(0, floor, FAR_EYE);
    for (let time = FRAME; time <= BLOOD_TRAIL_STEP + FRAME; time += FRAME) {
      frame = fragments.update(time, floor, FAR_EYE);
    }
    expect([frame.gibs.map((gib) => gib.serial), frame.puffs.map((puff) => puff.serial)]).toEqual([
      [2],
      [3]
    ]);
  });
});

describe('drawBloodPuff', () => {
  it('falls 40 and grows from 16 to 36 across as it fades, over its two seconds', () => {
    const puff = {
      base: vec3(0, 0, 50),
      startTime: 1000,
      endTime: 1000 + BLOOD_PUFF_LIFETIME,
      rotation: 30
    };
    expect(drawBloodPuff(puff, 1000)).toEqual({
      origin: vec3(0, 0, 50),
      radius: 16,
      alpha: 1,
      rotation: 30,
      serial: 0
    });
    expect(drawBloodPuff(puff, 2000)).toEqual({
      origin: vec3(0, 0, 50 - BLOOD_PUFF_DROP / 2),
      radius: 26,
      alpha: 127 / 255,
      rotation: 30,
      serial: 0
    });
  });
});

describe("a fragment's trace", () => {
  it('passes nobody and stops at what is solid alone, as CG_AddFragment traces', () => {
    const { trace, asked } = recordingTrace(floor);
    const fragments = new Fragments(() => 0.25);
    fragments.gibPlayer(vec3(0, 0, 24), 0);

    for (let time = FRAME; time < 500; time += FRAME) fragments.update(time, trace, FAR_EYE);

    expect(distinctAsks(asked)).toEqual([{ passEntityNum: -1, contentmask: CONTENTS.SOLID }]);
  });
});
