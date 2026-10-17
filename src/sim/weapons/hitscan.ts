import { MASK } from '../constants';
import { angleVectors } from '../pmove-math';
import type { TraceFn, TraceResult } from '../types';
import { cross, dot, length, madd, normalize, scale, sub, vec3, type Vec3 } from '../vec3';
import {
  BULLET_RANGE,
  MACHINEGUN_SPREAD,
  MUZZLE_FORWARD,
  SHOTGUN_COUNT,
  SHOTGUN_SPREAD
} from './constants';

/**
 * Instant-hit weapons: the muzzle point every shot starts from, Quake's own random number
 * generator, and the spread patterns built on top of it (`g_weapon.c`).
 *
 * The shotgun pattern is fully deterministic from a one-byte seed, so it is portable and
 * golden-testable — id made it that way so the client could draw the same pattern the
 * server traced, without sending eleven rays over the wire.
 */

/**
 * `SnapVector` from `g_local.h` — per-component **truncation** toward zero.
 *
 * Not to be confused with `trap_SnapVector` (`Sys_SnapVector`), which the movement port
 * already implements as `snapVector` and which **rounds to nearest**. Two different
 * operations sharing a name in the original source: velocity rounds, muzzle points and
 * missile velocities truncate. Getting this backwards biases every shot's origin half a
 * unit, so they are deliberately separate functions here.
 */
export function truncVector(v: Vec3): Vec3 {
  return vec3(Math.trunc(v.x), Math.trunc(v.y), Math.trunc(v.z));
}

/**
 * `SnapVectorTowards` (`g_weapon.c:144–154`) — snap to whole units, but always *towards* a point.
 *
 * A third kind of snapping, and the one an impact needs. Rounding an impact point to nearest can
 * move it a fraction of a unit into the surface it struck, which buries the mark; rounding each
 * component towards where the shot came from can only move it back along the shot, into the open.
 *
 * @param v - The point to snap.
 * @param to - What to snap towards: the muzzle for a bullet, the launch point for a missile.
 */
export function snapVectorTowards(v: Vec3, to: Vec3): Vec3 {
  return vec3(
    to.x <= v.x ? Math.floor(v.x) : Math.ceil(v.x),
    to.y <= v.y ? Math.floor(v.y) : Math.ceil(v.y),
    to.z <= v.z ? Math.floor(v.z) : Math.ceil(v.z)
  );
}

/**
 * Quake 3's linear congruential generator (`q_shared.h`).
 *
 * A plain 32-bit LCG, `seed = 69069 * seed + 1`. Ported verbatim rather than replaced with
 * `Math.random` because the shotgun's pattern is defined by it: given the same seed byte,
 * this produces the same eleven pellets id's code would, which is what makes the pattern
 * testable against fixed expectations.
 */
export class Q3Random {
  private seed: number;

  /** @param seed - Starting seed: a shot's, 0–255. */
  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** `Q_rand` — advance and return the raw 32-bit state. */
  rand(): number {
    // Math.imul keeps the multiply in 32-bit, as the C would; >>> 0 makes it unsigned.
    this.seed = (Math.imul(69069, this.seed) + 1) >>> 0;
    return this.seed;
  }

  /** `Q_random` — uniform in [0, 1), from the low 16 bits. */
  random(): number {
    return (this.rand() & 0xffff) / 0x10000;
  }

  /** `Q_crandom` — uniform in [-1, 1). */
  crandom(): number {
    return 2 * (this.random() - 0.5);
  }
}

/** A uniform [0, 1) source, which the machinegun's cone draws from. */
export type RandomFn = () => number;

/**
 * `CalcMuzzlePointOrigin` (`g_weapon.c:787`) — where a shot leaves the gun.
 *
 * Feet origin, plus the eye height, plus 14 units forward, then truncated to integers. The
 * truncation is not cosmetic: it is what the client and server both do, so the tracer the
 * player sees starts exactly where the trace did. CPMA's is 1 unit forward, and not truncated.
 *
 * @param origin - Player origin (feet), already snapped by the move.
 * @param forward - View forward vector.
 * @param viewheight - Eye height above the origin: 26 standing, 12 crouched.
 * @param distance - How far ahead of the eye.
 * @param snap - Whether it is truncated to whole units.
 */
export function calcMuzzlePoint(
  origin: Vec3,
  forward: Vec3,
  viewheight: number,
  distance = MUZZLE_FORWARD,
  snap = true
): Vec3 {
  const muzzle = madd(vec3(origin.x, origin.y, origin.z + viewheight), distance, forward);
  return snap ? truncVector(muzzle) : muzzle;
}

/** The full firing basis for a shot: muzzle point and the three view axes. */
export interface FiringSolution {
  muzzle: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

/**
 * Build the firing basis from player state.
 *
 * @param origin - Player origin (feet).
 * @param viewangles - View angles in degrees.
 * @param viewheight - Eye height above the origin.
 * @param distance - How far ahead of the eye the muzzle is.
 * @param snap - Whether the muzzle is truncated to whole units.
 */
export function firingSolution(
  origin: Vec3,
  viewangles: Vec3,
  viewheight: number,
  distance = MUZZLE_FORWARD,
  snap = true
): FiringSolution {
  const { forward, right, up } = angleVectors(viewangles);
  const muzzle = calcMuzzlePoint(origin, forward, viewheight, distance, snap);
  return { muzzle, forward, right, up };
}

/**
 * `PerpendicularVector` (`q_math.c`) — any unit vector at right angles to `src`.
 *
 * Picks the axis `src` leans on least and projects it onto `src`'s plane. The specific
 * choice matters: the shotgun derives its spread basis this way rather than from the view
 * angles, so reproducing id's exact selection is what makes the pattern match.
 */
export function perpendicularVector(src: Vec3): Vec3 {
  const magnitudes = [Math.abs(src.x), Math.abs(src.y), Math.abs(src.z)];
  let axis = 0;
  for (let i = 1; i < 3; i++) {
    if (magnitudes[i] < magnitudes[axis]) axis = i;
  }
  const unit = vec3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  return normalize(projectPointOnPlane(unit, src));
}

/**
 * `ProjectPointOnPlane` (`q_math.c`), ported literally.
 *
 * Note the double division by `|normal|^2`: id's version is only a true projection when
 * `normal` is already unit length, which it always is at the one call site that matters.
 * Kept as written rather than "corrected", since the corrected form would change the
 * shotgun's basis.
 */
function projectPointOnPlane(p: Vec3, normal: Vec3): Vec3 {
  const inverseDenominator = 1 / dot(normal, normal);
  const d = dot(normal, p) * inverseDenominator;
  return sub(p, scale(scale(normal, inverseDenominator), d));
}

/**
 * The aim a shotgun blast puts on the wire — `VectorScale( forward, 4096, tent->s.origin2 )`
 * followed by `SnapVector`.
 *
 * Scaled up before it is truncated so that the direction survives whole units: a unit vector
 * truncated would be (0, 0, 0) more often than not.
 *
 * @param forward - View forward vector.
 */
export function shotgunWire(forward: Vec3): Vec3 {
  return truncVector(scale(forward, 4096));
}

/**
 * The distance a spread is given at. A shot traced further has its offset scaled with it, so the
 * cone's angle stays: id's bullets go 16 times as far, with 16 times the offset.
 */
export const SPREAD_DISTANCE = 8192;

/** The shotgun's rules, which a client reads from the serverinfo to draw a blast. */
export interface ShotgunRules {
  /** `g_pattern_sg`: 0 is id's random pattern, 1 and 2 CPMA's two fixed ones. */
  pattern: number;
  /** `g_pellets_sg`: how many pellets a blast holds. */
  pellets: number;
  /** `g_spread_sg`: the random pattern's greatest offset on each axis, at 8192 units. */
  spread: number;
}

/** id's shotgun: eleven pellets in a random square. */
export const ID_SHOTGUN: Readonly<ShotgunRules> = Object.freeze({
  pattern: 0,
  pellets: SHOTGUN_COUNT,
  spread: SHOTGUN_SPREAD
});

/**
 * CPMA 1.48's fixed patterns: each pellet's right and up offsets at 8192 units, eight in an inner
 * ring and eight in an outer one. The second is CQ3's, a little wider.
 */
const FIXED_PATTERNS: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  1: [
    [250, 100], [100, 250], [700, 300], [300, 700],
    [-250, 100], [-100, 250], [-700, 300], [-300, 700],
    [250, -100], [100, -250], [700, -300], [300, -700],
    [-250, -100], [-100, -250], [-700, -300], [-300, -700]
  ],
  2: [
    [300, 150], [150, 300], [700, 350], [350, 700],
    [-300, 150], [-150, 300], [-700, 350], [-350, 700],
    [300, -150], [150, -300], [700, -350], [350, -700],
    [-300, -150], [-150, -300], [-700, -350], [-350, -700]
  ]
};

/**
 * Whether a pattern is one of CPMA's fixed ones, which its server lays on the view's axes.
 *
 * @param pattern - `g_pattern_sg`.
 */
export function isFixedPattern(pattern: number): boolean {
  return FIXED_PATTERNS[pattern] !== undefined;
}

/** A blast's pellets: how far each is traced, and each one's right and up offsets there. */
interface PelletSpread {
  range: number;
  offsets: (readonly [number, number])[];
}

/**
 * The pellets' offsets. id's random pattern draws two values a pellet from the seed, in a square,
 * at 131072 units. A fixed pattern takes its table in order, round again past its sixteen, at
 * 8192.
 */
function pelletSpread(seed: number, shotgun: Readonly<ShotgunRules>): PelletSpread {
  const fixed = FIXED_PATTERNS[shotgun.pattern];
  const offsets: (readonly [number, number])[] = [];
  if (fixed) {
    for (let i = 0; i < shotgun.pellets; i++) offsets.push(fixed[i % fixed.length]);
    return { range: SPREAD_DISTANCE, offsets };
  }
  const random = new Q3Random(seed);
  const scale = BULLET_RANGE / SPREAD_DISTANCE;
  for (let i = 0; i < shotgun.pellets; i++) {
    const r = random.crandom() * shotgun.spread * scale;
    const u = random.crandom() * shotgun.spread * scale;
    offsets.push([r, u]);
  }
  return { range: BULLET_RANGE, offsets };
}

/** Each pellet's endpoint: `range` along the aim, then its offsets along right and up. */
function pelletEnds(
  start: Vec3,
  forward: Vec3,
  right: Vec3,
  up: Vec3,
  spread: PelletSpread
): Vec3[] {
  return spread.offsets.map(([r, u]) => {
    let end = madd(start, spread.range, forward);
    end = madd(end, r, right);
    end = madd(end, u, up);
    return end;
  });
}

/**
 * `ShotgunPattern` (`g_weapon.c:321`) — a blast's pellet endpoints, on the axes the aim alone
 * gives.
 *
 * Deterministic from `seed` and the aim as {@link shotgunWire} left it, which is the whole
 * point: the client is sent one event carrying a seed and a direction, and works out the same
 * eleven pellets the server traced rather than being sent eleven rays. Both sides start from the
 * *received* value, which is why this takes the wire's vector rather than the original aim.
 *
 * The offsets use independent uniform values for right and up, so the scatter is a
 * **square**, not a disc — a Quake 3 shotgun quirk players can actually see at range.
 *
 * CPMA's client draws its fixed patterns on these axes too, though its server fires them on the
 * view's ({@link shotgunPatternOnView}). A pattern looks the same turned a quarter or mirrored, so
 * the two agree while the aim leans least on the vertical. Elsewhere the drawn impacts are the
 * hits turned about the aim.
 *
 * @param muzzle - Where the pellets leave from: the event's origin.
 * @param wire - The aim as the wire carries it, from {@link shotgunWire}.
 * @param seed - The shot's seed, 0–255.
 * @param shotgun - The pattern, the pellets and the spread.
 */
export function shotgunPattern(
  muzzle: Vec3,
  wire: Vec3,
  seed: number,
  shotgun: Readonly<ShotgunRules> = ID_SHOTGUN
): Vec3[] {
  const direction = normalize(wire);
  const right = perpendicularVector(direction);
  const up = cross(direction, right);
  return pelletEnds(muzzle, direction, right, up, pelletSpread(seed, shotgun));
}

/**
 * CPMA's `ShotgunPattern`: a fixed pattern's endpoints on the shooter's own view axes, from the
 * muzzle, so that the pattern stands square to the view whichever way it looks.
 *
 * @param solution - Firing basis.
 * @param shotgun - A fixed pattern, and the pellets.
 */
export function shotgunPatternOnView(
  solution: FiringSolution,
  shotgun: Readonly<ShotgunRules>
): Vec3[] {
  const { muzzle, forward, right, up } = solution;
  return pelletEnds(muzzle, forward, right, up, pelletSpread(0, shotgun));
}

/**
 * `Bullet_Fire`'s spread (`g_weapon.c:178`) — one machinegun round's endpoint.
 *
 * id's draws from the unseeded `random()`, and unlagged's from `Q_rand` at a seed of the shot's
 * own, as the shotgun does, so that a client can draw the same round. Whichever drives it is
 * passed in. The offsets are polar here (angle then radius), giving a **round** cone — the
 * opposite of the shotgun's square one.
 *
 * @param solution - Firing basis.
 * @param random - Uniform [0, 1) source, drawn three times; `Math.random` by default.
 * @param spread - The greatest offset at 8192 units; the machinegun's is 200.
 * @param range - How far the round is traced.
 */
export function bulletEndpoint(
  solution: FiringSolution,
  random: RandomFn = Math.random,
  spread = MACHINEGUN_SPREAD,
  range = BULLET_RANGE
): Vec3 {
  const scale = range / SPREAD_DISTANCE;
  const angle = random() * Math.PI * 2;
  const u = Math.sin(angle) * (2 * (random() - 0.5)) * spread * scale;
  const r = Math.cos(angle) * (2 * (random() - 0.5)) * spread * scale;

  let end = madd(solution.muzzle, range, solution.forward);
  end = madd(end, r, solution.right);
  end = madd(end, u, solution.up);
  return end;
}

/** Where an instant-hit shot landed. */
export interface HitscanResult {
  /** Impact point, or the endpoint if the shot hit nothing. */
  endpos: Vec3;
  /** Surface normal at the impact, or the trace's own where nothing was hit. */
  normal: Vec3;
  /** Whether the shot hit anything. */
  hit: boolean;
  /** Distance travelled, in units. */
  distance: number;
  /** What it hit: `ENTITYNUM_WORLD`, an entity, or `ENTITYNUM_NONE`. */
  entityNum: number;
  /** `CONTENTS_*` of what it hit; a player is `CONTENTS_BODY`. */
  contents: number;
  /** `SURF_*` of what it hit; the sky is `SURF_NOIMPACT`, which leaves no mark or blast. */
  surfaceFlags: number;
}

/**
 * Trace one instant-hit shot: a point, stopped by `MASK_SHOT`, as every bullet, beam and pellet
 * of Quake 3's is on both sides.
 *
 * It passes through the shooter, and through whatever the shooter owns — their own corpses
 * among them, which Quake 3's bullets cannot hit either. A shot that starts inside someone else
 * and gets out goes on past them, as `Bullet_Fire`'s does: it reads where the trace stopped and
 * never whether it started solid.
 *
 * @param trace - Swept-AABB trace.
 * @param start - Shot origin.
 * @param end - Shot endpoint.
 * @param passEntityNum - The shooter, or −1 on a client for a shot that passes nobody.
 */
export function traceShot(
  trace: TraceFn,
  start: Vec3,
  end: Vec3,
  passEntityNum: number
): HitscanResult {
  const result: TraceResult = trace(start, vec3(), vec3(), end, passEntityNum, MASK.SHOT);
  return {
    endpos: result.endpos,
    normal: result.normal,
    hit: result.fraction < 1,
    distance: length(sub(result.endpos, start)),
    entityNum: result.entityNum,
    contents: result.contents,
    surfaceFlags: result.surfaceFlags
  };
}

/**
 * Endpoint for a fixed-range beam: the lightning gun (768) and the railgun (8192).
 *
 * @param solution - Firing basis.
 * @param range - Trace length in units.
 */
export function beamEndpoint(solution: FiringSolution, range: number): Vec3 {
  return madd(solution.muzzle, range, solution.forward);
}
