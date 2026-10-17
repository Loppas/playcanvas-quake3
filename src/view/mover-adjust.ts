import { ENTITYNUM_MAX_NORMAL, type EntityState } from '../net/protocol';
import { f } from '../sim/cm/q-math';
import { ET } from '../sim/game-entity';
import { turnMove } from '../sim/mover-push';
import { qvmEvaluateTrajectory } from '../sim/trajectory';
import { vec3, type Vec3 } from '../sim/vec3';

/** The mover's place and turn at either end, and the turn's move, written at each adjust. */
const oldOrigin = vec3();
const oldAngles = vec3();
const origin = vec3();
const angles = vec3();
const deltaAngles = vec3();
const org = vec3();
const move2 = vec3();

/**
 * `CG_AdjustPositionForMover` (`cg_ents.c:712-752`), ioquake3's, in cgame's floats: carry what
 * stands on a mover along with it from one time to another, as the server's push carries it.
 *
 * The mover is the one numbered, as the current snapshot has it; anything that is not a mover, or
 * a number that names no entity, carries nothing. The point goes with the mover's move, and turns
 * about where the mover started by the mover's turn; the angles turn with it, all three.
 *
 * ioquake3's: id's moves the point by the mover's move alone and leaves the angles.
 *
 * @param input - Where it stands at `fromTime`.
 * @param moverNum - What it stands on: a `groundEntityNum`.
 * @param currentState - `cg_entities[ n ].currentState`, or undefined for a slot the current
 *   snapshot has not got.
 * @param out - Where it stands at `toTime`, written in place; may be `input`.
 * @param anglesIn - How it is turned at `fromTime`.
 * @param anglesOut - How it is turned at `toTime`, written in place; may be `anglesIn`.
 */
export function adjustPositionForMover(
  input: Vec3,
  moverNum: number,
  fromTime: number,
  toTime: number,
  currentState: (number: number) => EntityState | undefined,
  out: Vec3,
  anglesIn: Vec3,
  anglesOut: Vec3
): void {
  const mover =
    moverNum <= 0 || moverNum >= ENTITYNUM_MAX_NORMAL ? undefined : currentState(moverNum);
  if (mover === undefined || mover.eType !== ET.MOVER) {
    copyInto(input, out);
    copyInto(anglesIn, anglesOut);
    return;
  }

  qvmEvaluateTrajectory(mover.pos, fromTime, oldOrigin);
  qvmEvaluateTrajectory(mover.apos, fromTime, oldAngles);
  qvmEvaluateTrajectory(mover.pos, toTime, origin);
  qvmEvaluateTrajectory(mover.apos, toTime, angles);

  deltaAngles.x = f(angles.x - oldAngles.x);
  deltaAngles.y = f(angles.y - oldAngles.y);
  deltaAngles.z = f(angles.z - oldAngles.z);

  // "origin change when on a rotating object"
  org.x = f(input.x - oldOrigin.x);
  org.y = f(input.y - oldOrigin.y);
  org.z = f(input.z - oldOrigin.z);
  turnMove(deltaAngles, org, move2);

  out.x = f(input.x + f(f(origin.x - oldOrigin.x) + move2.x));
  out.y = f(input.y + f(f(origin.y - oldOrigin.y) + move2.y));
  out.z = f(input.z + f(f(origin.z - oldOrigin.z) + move2.z));
  anglesOut.x = f(anglesIn.x + deltaAngles.x);
  anglesOut.y = f(anglesIn.y + deltaAngles.y);
  anglesOut.z = f(anglesIn.z + deltaAngles.z);
}

/** `VectorCopy`, in place. */
function copyInto(from: Vec3, to: Vec3): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
