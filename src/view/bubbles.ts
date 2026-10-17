import { CONTENTS } from '../sim/constants';
import type { PointContentsFn, TraceFn } from '../sim/types';
import { add, copy, length, madd, scale, sub, vec3, type Vec3 } from '../sim/vec3';

/**
 * `CG_BubbleTrail` (`cg_effects.c:36–87`): the bubbles a shot leaves along its line under water,
 * and the stretch of a pellet's line they are left along.
 *
 * A bubble is a local entity drawn as a sprite of `waterBubble`: `LE_MOVE_SCALE_FADE` under
 * `LEF_PUFF_DONT_SCALE`, so it keeps its radius as it drifts up and fades out over a second and a
 * little more. Its `le->radius` is never set, so unlike a puff it is never let go for the view
 * being inside it (`cg_localents.c:379–386`).
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `cgs.media.waterBubbleShader` (`cg_main.c:863`). */
export const WATER_BUBBLE_SHADER = 'waterBubble';

/** `re->radius` (`cg_effects.c:72`). */
export const BUBBLE_RADIUS = 3;

/** A bubble lasts this long, and up to {@link BUBBLE_LIFETIME_SPREAD} more (`cg_effects.c:64`). */
export const BUBBLE_LIFETIME = 1000;
export const BUBBLE_LIFETIME_SPREAD = 250;

/** It drifts up to this many units a second along each axis (`cg_effects.c:84–86`)... */
export const BUBBLE_DRIFT = 5;

/** ...and this many more upward. */
export const BUBBLE_RISE = 6;

/** How far apart a rocket's or a grenade's trail lays them (`cg_weapons.c:370`)... */
export const MISSILE_BUBBLE_SPACING = 8;

/** ...and a shotgun pellet's (`cg_weapons.c:1992`). */
export const PELLET_BUBBLE_SPACING = 32;

/** `CG_Trace`'s `NULL` box: the surface is found by a point. */
const POINT = vec3();

/** One bubble: `localEntity_t` for `LE_MOVE_SCALE_FADE`. */
export interface Bubble {
  /** `pos.trBase`: where it was laid. */
  base: Vec3;
  /** `pos.trDelta`: its drift, in units a second. */
  delta: Vec3;
  startTime: number;
  endTime: number;
}

/**
 * `CG_BubbleTrail`: a bubble every `spacing` units along the line, the first a random whole
 * number of units short of `spacing` from its start.
 *
 * @param time - `cg.time`, in milliseconds.
 * @param random - `random()`, a number in [0, 1); `rand()`'s are drawn from it too.
 */
export function bubbleTrail(
  start: Vec3,
  end: Vec3,
  spacing: number,
  time: number,
  random: () => number
): Bubble[] {
  const bubbles: Bubble[] = [];
  const line = sub(end, start);
  const len = length(line);
  const dir = len > 0 ? scale(line, 1 / len) : vec3();
  const crandom = () => 2 * (random() - 0.5);

  // "Advance a random amount first."
  let i = Math.floor(random() * spacing);
  let move = madd(start, i, dir);
  const step = scale(dir, spacing);
  for (; i < len; i += spacing) {
    const endTime = Math.trunc(time + BUBBLE_LIFETIME + random() * BUBBLE_LIFETIME_SPREAD);
    const x = crandom() * BUBBLE_DRIFT;
    const y = crandom() * BUBBLE_DRIFT;
    const z = crandom() * BUBBLE_DRIFT + BUBBLE_RISE;
    bubbles.push({ base: copy(move), delta: vec3(x, y, z), startTime: time, endTime });
    move = add(move, step);
  }
  return bubbles;
}

/** Where a bubble is at `time`: `TR_LINEAR` from where it was laid. */
export function bubbleOrigin(bubble: Bubble, time: number): Vec3 {
  return madd(bubble.base, (time - bubble.startTime) * 0.001, bubble.delta);
}

/**
 * A bubble's alpha at `time`, out of 1: `CG_AddMoveScaleFade`'s byte, `0xff * c`, fading from
 * whole as it is laid to nothing as it goes.
 */
export function bubbleAlpha(bubble: Bubble, time: number): number {
  const c = (bubble.endTime - time) / (bubble.endTime - bubble.startTime);
  return Math.trunc(0xff * c) / 0xff;
}

/**
 * The stretch of a shotgun pellet's line `CG_ShotgunPellet` lays bubbles along
 * (`cg_weapons.c:1986–2004`): the whole of it when its two ends are in the same contents and
 * those hold water; from the muzzle up to the surface when only the muzzle is in water; from where
 * it struck back up to the surface when only that is; or none.
 *
 * Each end is asked of the world and its solid brush models, passing entity 0.
 *
 * @param start - Where the pellet left.
 * @param end - Where it was aimed: its trace's far end.
 * @param hit - Where its trace stopped.
 * @param trace - The world, traced against water alone for the surface.
 * @param pointContents - `CG_PointContents`.
 */
export function pelletBubbleLine(
  start: Vec3,
  end: Vec3,
  hit: Vec3,
  trace: TraceFn,
  pointContents: PointContentsFn
): { start: Vec3; end: Vec3 } | null {
  const source = pointContents(start, 0);
  const dest = pointContents(hit, 0);
  if (source === dest) return source & CONTENTS.WATER ? { start, end: hit } : null;
  if (source & CONTENTS.WATER) {
    return { start, end: trace(end, POINT, POINT, start, -1, CONTENTS.WATER).endpos };
  }
  if (dest & CONTENTS.WATER) {
    return { start: hit, end: trace(start, POINT, POINT, end, -1, CONTENTS.WATER).endpos };
  }
  return null;
}
