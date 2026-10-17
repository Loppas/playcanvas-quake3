import { TR, type Trajectory } from '../net/protocol';
import { f, QVM_PI } from './cm/q-math';
import { copy, madd, vec3, type Vec3 } from './vec3';
import { MISSILE_GRAVITY } from './weapons/constants';

/**
 * `BG_EvaluateTrajectory` and its derivative (`bg_misc.c:1197–1272`): where a thing is, and how
 * fast it is going, at an instant.
 *
 * Nothing in Quake 3 integrates a position forward. A rocket, a grenade, a door and a corpse all
 * store where they started, how fast, and when — and where they are *now* is worked out from
 * those three whenever anybody asks. That is why a grenade keeps a clean parabola at any frame
 * rate, why a bounce restarts the arc rather than continuing it, and why the server can send a
 * moving thing once and let every client place it for itself on any frame in between.
 *
 * Both the game module and the client run this over the same `s.pos`, which is what makes a
 * missile's position agree on both sides of the wire without either of them being told it.
 */

/**
 * Where a trajectory is at an instant.
 *
 * @param tr - The trajectory to read; nothing on it is changed.
 * @param time - The instant, in milliseconds on the level's clock.
 */
export function evaluateTrajectory(tr: Trajectory, time: number): Vec3 {
  switch (tr.trType) {
    case TR.STATIONARY:
    // A client interpolates one of these between the snapshots it has, so on its own it is
    // only ever where it last was.
    case TR.INTERPOLATE:
      return copy(tr.trBase);

    case TR.LINEAR:
      return madd(tr.trBase, (time - tr.trTime) * 0.001, tr.trDelta);

    case TR.SINE: {
      const phase = Math.sin(((time - tr.trTime) / tr.trDuration) * Math.PI * 2);
      return madd(tr.trBase, phase, tr.trDelta);
    }

    case TR.LINEAR_STOP: {
      const at = Math.min(time, tr.trTime + tr.trDuration);
      return madd(tr.trBase, Math.max((at - tr.trTime) * 0.001, 0), tr.trDelta);
    }

    case TR.GRAVITY: {
      // Hardcoded 800, and deliberately not `g_gravity`: Quake 3 writes the constant into the
      // evaluator, so a grenade arcs the same way whatever the world's gravity is.
      const deltaTime = (time - tr.trTime) * 0.001;
      const at = madd(tr.trBase, deltaTime, tr.trDelta);
      at.z -= 0.5 * MISSILE_GRAVITY * deltaTime * deltaTime;
      return at;
    }

    default:
      throw new Error(`trajectory: unknown trType ${tr.trType}`);
  }
}

/** `0.001`, which q3lcc's floats hold as a float. */
const QVM_MILLI = f(0.001);

/**
 * `BG_EvaluateTrajectory` (`bg_misc.c:1197-1235`) as a QVM runs it: every product and sum a
 * float, `M_PI` and the literals floats, and the sine a trap, a double's answer rounded to a float.
 *
 * A mover is placed by it, so that its wire state and every rider's push are Quake 3's to the bit:
 * in doubles a bobber drifts from Quake 3's as the level's clock runs.
 *
 * @param tr - The trajectory to read; nothing on it is changed.
 * @param atTime - The instant, in whole milliseconds on the level's clock.
 * @param result - Where it is, written in place.
 */
export function qvmEvaluateTrajectory(tr: Trajectory, atTime: number, result: Vec3): void {
  const { trBase, trDelta } = tr;
  // What `trDelta` is scaled by: the seconds since `trTime`, or the sine's phase.
  let factor: number;
  switch (tr.trType) {
    case TR.STATIONARY:
    case TR.INTERPOLATE:
      result.x = trBase.x;
      result.y = trBase.y;
      result.z = trBase.z;
      return;

    case TR.LINEAR:
      factor = f(f(atTime - tr.trTime) * QVM_MILLI);
      break;

    case TR.SINE: {
      const deltaTime = f(f(atTime - tr.trTime) / f(tr.trDuration));
      factor = f(Math.sin(f(f(deltaTime * QVM_PI) * 2)));
      break;
    }

    case TR.LINEAR_STOP:
      if (atTime > tr.trTime + tr.trDuration) atTime = tr.trTime + tr.trDuration;
      factor = f(f(atTime - tr.trTime) * QVM_MILLI);
      if (factor < 0) factor = 0;
      break;

    case TR.GRAVITY:
      factor = f(f(atTime - tr.trTime) * QVM_MILLI);
      result.x = f(trBase.x + f(trDelta.x * factor));
      result.y = f(trBase.y + f(trDelta.y * factor));
      result.z = f(trBase.z + f(trDelta.z * factor));
      result.z = f(result.z - f(f(f(0.5 * MISSILE_GRAVITY) * factor) * factor));
      return;

    default:
      throw new Error(`BG_EvaluateTrajectory: unknown trType: ${tr.trType}`);
  }
  result.x = f(trBase.x + f(trDelta.x * factor));
  result.y = f(trBase.y + f(trDelta.y * factor));
  result.z = f(trBase.z + f(trDelta.z * factor));
}

/**
 * How fast a trajectory is going at an instant.
 *
 * For a linear thing this is just the stored rate; for a falling one it is not, because gravity
 * has been pulling since `trTime`. Reflecting the stored rate off a surface instead of this one
 * is the natural mistake, and it makes a grenade bounce back up to its throwing speed however far
 * it fell.
 *
 * @param tr - The trajectory to read; nothing on it is changed.
 * @param time - The instant, in milliseconds on the level's clock.
 * @param into - Written and returned, for a caller that keeps its own; a new one by default.
 */
export function evaluateTrajectoryDelta(tr: Trajectory, time: number, into = vec3()): Vec3 {
  const { trDelta } = tr;
  switch (tr.trType) {
    case TR.STATIONARY:
    case TR.INTERPOLATE:
      return setVec(into, 0, 0, 0);

    case TR.LINEAR:
      return setVec(into, trDelta.x, trDelta.y, trDelta.z);

    case TR.SINE: {
      // The derivative of the sine, and Quake 3's own halving of it, which is wrong by a factor
      // of `2 * PI / trDuration` and is what every mover in the game moves by.
      const phase = Math.cos(((time - tr.trTime) / tr.trDuration) * Math.PI * 2) * 0.5;
      return setVec(into, trDelta.x * phase, trDelta.y * phase, trDelta.z * phase);
    }

    case TR.LINEAR_STOP:
      return time > tr.trTime + tr.trDuration
        ? setVec(into, 0, 0, 0)
        : setVec(into, trDelta.x, trDelta.y, trDelta.z);

    case TR.GRAVITY: {
      const z = trDelta.z - MISSILE_GRAVITY * (time - tr.trTime) * 0.001;
      return setVec(into, trDelta.x, trDelta.y, z);
    }

    default:
      throw new Error(`trajectory: unknown trType ${tr.trType}`);
  }
}

/** A vector written in place. */
function setVec(v: Vec3, x: number, y: number, z: number): Vec3 {
  v.x = x;
  v.y = y;
  v.z = z;
  return v;
}
