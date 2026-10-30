import { MAX_CLIENTS, type EntityState } from '../net/protocol';
import { qvmAngleVectors, vectorMA } from '../sim/cm/q-math';
import { CONTENTS } from '../sim/constants';
import { PW } from '../sim/items';
import type { PointContentsFn, TraceFn } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';

/**
 * Who is under the crosshair, as cgame keeps it: `cg.crosshairClientNum` and
 * `cg.crosshairClientTime`, which `CG_ScanForCrosshairEntity` stamps (`cg_draw.c:2003–2031`), and
 * what the names under the crosshair and `CG_CrosshairPlayer` read of it. Quake 3 scans only where
 * it draws the names, so nothing is sighted while they are not drawn. Engine-free.
 */

/** How long a player sighted stays under the crosshair (`cg_draw.c:2058`, `cg_main.c:410`). */
export const CROSSHAIR_CLIENT_TIME = 1000;

/** How far the scan looks (`cg_draw.c:2011`). */
const SCAN_RANGE = 131072;

/** `cg.crosshairClientNum` and `cg.crosshairClientTime`. */
export interface CrosshairPlayer {
  /** The player last sighted; 0 before any, as `cg` cleared leaves it. */
  clientNum: number;
  /** When, in `cg.time`'s whole milliseconds; 0 for never. */
  time: number;
}

/** As `CG_Init` leaves it, `cg` cleared: nobody sighted. */
export function createCrosshairPlayer(): CrosshairPlayer {
  return { clientNum: 0, time: 0 };
}

/** What the scan reads of the client's world this frame. */
export interface CrosshairScan {
  /** `CG_Trace`. */
  trace: TraceFn;
  /** `CG_PointContents`. */
  pointContents: PointContentsFn;
  /** `cg_entities[ n ].currentState`, if the current snapshot has the entity. */
  currentState: (number: number) => EntityState | undefined;
  /** `cg.refdef.vieworg`. */
  origin: Vec3;
  /** The angles `cg.refdef.viewaxis` is built from, in degrees: pitch, yaw, roll. */
  angles: Vec3;
  /** `cg.snap->ps.clientNum`: whose entity the trace passes. */
  clientNum: number;
}

/** A point's box. */
const POINT = vec3();

/** The view's angles, its forward and the scan's far end, written at each scan. */
const angles = [0, 0, 0];
const forward = [0, 0, 0];
const start = [0, 0, 0];
const far = [0, 0, 0];
const end = vec3();

/**
 * `CG_ScanForCrosshairEntity`: a point traced from the view straight ahead, passing the player's
 * own entity, stopped by walls and bodies. A player hit is the one under the crosshair now, unless
 * where the trace stopped is in fog or they carry invisibility. Anything else keeps the last.
 *
 * @param time - `cg.time`.
 */
export function scanForCrosshairEntity(
  state: CrosshairPlayer,
  scan: CrosshairScan,
  time: number
): void {
  const { origin } = scan;
  angles[0] = scan.angles.x;
  angles[1] = scan.angles.y;
  angles[2] = scan.angles.z;
  // `AnglesToAxis`, whose first axis is `AngleVectors`' forward.
  qvmAngleVectors(angles, forward, null, null);
  start[0] = origin.x;
  start[1] = origin.y;
  start[2] = origin.z;
  vectorMA(start, SCAN_RANGE, forward, far);
  end.x = far[0];
  end.y = far[1];
  end.z = far[2];
  const mask = CONTENTS.SOLID | CONTENTS.BODY;
  const trace = scan.trace(origin, POINT, POINT, end, scan.clientNum, mask);
  if (trace.entityNum >= MAX_CLIENTS) return;
  if (scan.pointContents(trace.endpos, 0) & CONTENTS.FOG) return;
  if ((scan.currentState(trace.entityNum)?.powerups ?? 0) & (1 << PW.INVIS)) return;
  state.clientNum = trace.entityNum;
  state.time = Math.floor(time);
}

/**
 * `CG_CrosshairPlayer`: the player last under the crosshair, for a second after. It tests the time
 * alone, so before any sighting it answers 0 while the clock is under a second, as Quake 3's does.
 *
 * @param time - `cg.time`.
 * @returns their client number, or −1 with nobody sighted in the last second
 */
export function crosshairPlayer(state: Readonly<CrosshairPlayer>, time: number): number {
  return Math.floor(time) > state.time + CROSSHAIR_CLIENT_TIME ? -1 : state.clientNum;
}
