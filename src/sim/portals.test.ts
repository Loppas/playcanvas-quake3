import { describe, expect, it } from 'vitest';

import { dirToByte } from './dir-byte';
import { ET, SVF, type GameEntity } from './game-entity';
import type { Level } from './level';
import {
  CAMERA_FAST_ROTATE,
  CAMERA_NO_SWING,
  CAMERA_SLOW_ROTATE,
  FAST_ROTATE_FRAME,
  LOCATE_CAMERA_DELAY,
  SLOW_ROTATE_FRAME
} from './portals';
import { newRecord, runUntil, spawnedLevel } from './trigger-test-fixtures';
import { vec3 } from './vec3';

/**
 * Portals: `misc_portal_surface` and `misc_portal_camera` (`g_misc.c:158–238`). The aims and rolls
 * are ioquake3's C in q3lcc's floats, compiled and printed (scratchpad `m3c/twin.c`).
 */

/** The first entity of a classname in a level. */
function first(world: Level, classname: string): GameEntity {
  return world.find(null, 'classname', classname)!;
}

const SURFACE = { classname: 'misc_portal_surface', origin: '-1000 300 96', target: 'cam' };

/** A camera at (−1200 300 96), with these keys besides. */
function camera(keys: Record<string, string> = {}) {
  return { classname: 'misc_portal_camera', targetname: 'cam', origin: '-1200 300 96', ...keys };
}

describe('misc_portal_surface', () => {
  it('is a point in the world sent as a portal, a mirror when it targets nothing', () => {
    const mirror = first(
      spawnedLevel([{ classname: 'misc_portal_surface', origin: '1 2 3' }]),
      'misc_portal_surface'
    );
    expect(mirror.s.eType).toBe(ET.PORTAL);
    expect(mirror.r.svFlags).toBe(SVF.PORTAL);
    expect(mirror.r.linked).toBe(true);
    expect(mirror.r.mins).toEqual(vec3());
    expect(mirror.r.maxs).toEqual(vec3());
    expect(mirror.s.origin2).toEqual(vec3(1, 2, 3));
    expect(mirror.nextthink).toBe(0);
  });

  it('takes its camera’s place, roll and aim at what the camera targets', () => {
    const world = spawnedLevel([
      SURFACE,
      camera({ target: 'look', roll: '45' }),
      { classname: 'target_position', targetname: 'look', origin: '-1000 512 0' }
    ]);
    const surface = first(world, 'misc_portal_surface');
    const cam = first(world, 'misc_portal_camera');
    expect(surface.nextthink).toBe(LOCATE_CAMERA_DELAY);
    expect(LOCATE_CAMERA_DELAY).toBe(100);
    runUntil(world, 104);

    expect(surface.r.ownerNum).toBe(cam.s.number);
    expect(surface.s.origin2).toEqual(vec3(-1200, 300, 96));
    expect(surface.s.clientNum).toBe(32);
    // It swings unless told not to, and turns not at all unless told to.
    expect(surface.s.powerups).toBe(1);
    expect(surface.s.frame).toBe(0);
    expect(surface.s.eventParm).toBe(
      dirToByte(vec3(0.65177363157272339, 0.69088006019592285, -0.31285133957862854))
    );
  });

  it('aims along a camera’s angles when the camera targets nothing, and clears them', () => {
    const record = newRecord();
    const world = spawnedLevel([SURFACE, camera({ angle: '90' })], record);
    runUntil(world, 104);
    expect(first(world, 'misc_portal_surface').s.eventParm).toBe(dirToByte(vec3(0, 1, 0)));
    expect(first(world, 'misc_portal_camera').s.angles).toEqual(vec3());
    expect(record.prints).toEqual(['G_PickTarget called with NULL targetname']);
  });

  it.each([
    [CAMERA_SLOW_ROTATE, SLOW_ROTATE_FRAME, 1],
    [CAMERA_FAST_ROTATE, FAST_ROTATE_FRAME, 1],
    [CAMERA_SLOW_ROTATE | CAMERA_FAST_ROTATE, SLOW_ROTATE_FRAME, 1],
    [CAMERA_NO_SWING, 0, 0]
  ])('sends a camera’s spawnflags %d as a turn of %d and a swing of %d', (flags, frame, swing) => {
    const world = spawnedLevel([SURFACE, camera({ spawnflags: String(flags) })]);
    runUntil(world, 104);
    const surface = first(world, 'misc_portal_surface');
    expect(surface.s.frame).toBe(frame);
    expect(surface.s.powerups).toBe(swing);
  });

  it('says so of a camera that is not there, in id’s spelling, and goes', () => {
    const record = newRecord();
    const world = spawnedLevel([SURFACE], record);
    const surface = first(world, 'misc_portal_surface');
    runUntil(world, 104);
    expect(record.prints).toEqual([
      'G_PickTarget: target cam not found',
      "Couldn't find target for misc_partal_surface"
    ]);
    expect(surface.inuse).toBe(false);
  });
});

describe('misc_portal_camera', () => {
  it('is a point in the world, not a portal', () => {
    const cam = first(spawnedLevel([camera()]), 'misc_portal_camera');
    expect(cam.s.eType).toBe(ET.GENERAL);
    expect(cam.r.svFlags).toBe(0);
    expect(cam.r.linked).toBe(true);
    expect(cam.r.mins).toEqual(vec3());
  });

  it.each([
    ['0', 0],
    ['45', 32],
    ['90', 64],
    ['-30', -21],
    ['400', 284],
    ['1', 0],
    ['359', 255]
  ])('sends a roll of %s degrees as %d 256ths, as the QVM’s floats make it', (roll, sent) => {
    expect(first(spawnedLevel([camera({ roll })]), 'misc_portal_camera').s.clientNum).toBe(sent);
  });
});
