import { angleVectors } from '../sim/pmove-math';
import type { TraceFn } from '../sim/types';
import { cross, dot, madd, normalize, scale, sub, vec3, type Vec3 } from '../sim/vec3';
import {
  LIGHTNING_RANGE,
  MISSILES,
  MUZZLE_FORWARD,
  WP,
  type WeaponId
} from '../sim/weapons/constants';
import { traceShot } from '../sim/weapons/hitscan';

/** Radius of the plasma ball sprite — `ent.radius = 16` in `CG_Missile`. */
export const PLASMA_SPRITE_RADIUS = 16;

/** Radius of the plasma's impact mark — `radius = 16` in `CG_MissileHitWall`. */
export const PLASMA_MARK_RADIUS = 16;

/**
 * World-effect presentation maths — projectile orientation and the explosion curve
 * (`cg_ents.c:CG_Missile`, `cg_localents.c:CG_AddSpriteExplosion`).
 *
 * Engine-free like the rest of `src/view/`. These are the parts of the effect layer with a
 * right answer: how a rocket is oriented, how fast it rolls, how big an explosion is at a
 * given moment. The renderer turns the results into entities.
 */

/** An orthonormal frame in Quake's convention: forward, left, up. */
export interface Basis {
  forward: Vec3;
  left: Vec3;
  up: Vec3;
}

/**
 * `PerpendicularVector` (`q_math.c:1246`) — any unit vector at right angles to `src`.
 *
 * Starts from whichever axis `src` leans on least, which is what keeps it stable: projecting
 * out the component along `src` cannot then collapse to zero, however `src` is pointed.
 */
export function perpendicularVector(src: Vec3): Vec3 {
  const components = [Math.abs(src.x), Math.abs(src.y), Math.abs(src.z)];
  let smallest = 0;
  for (let i = 1; i < 3; i++) {
    if (components[i] < components[smallest]) smallest = i;
  }
  const axis = vec3(smallest === 0 ? 1 : 0, smallest === 1 ? 1 : 0, smallest === 2 ? 1 : 0);
  // Project onto the plane whose normal is `src`, then normalize.
  return normalize(sub(axis, scale(src, dot(src, axis) / dot(src, src))));
}

/**
 * Rotate `point` about the unit axis `axis` by `degrees` — `RotatePointAroundVector`.
 *
 * Rodrigues' formula rather than Q3's basis-matrix construction; they agree for a unit axis,
 * and this way there is nothing to get wrong about the intermediate basis.
 */
export function rotatePointAroundVector(point: Vec3, axis: Vec3, degrees: number): Vec3 {
  const radians = (degrees * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const perpendicular = cross(axis, point);
  const along = dot(axis, point) * (1 - c);
  return vec3(
    point.x * c + perpendicular.x * s + axis.x * along,
    point.y * c + perpendicular.y * s + axis.y * along,
    point.z * c + perpendicular.z * s + axis.z * along
  );
}

/** A laser drawn this frame: its entity's number, and its beam's two ends. */
export interface DrawnLaser {
  key: number;
  start: Vec3;
  end: Vec3;
}

/** `RB_SurfaceBeam`'s tube (`tr_surface.c:286, 313`): six sides, four units out from the beam. */
export const LASER_SIDES = 6;
export const LASER_RADIUS = 4;

/**
 * The frame of a laser's tube, as `RB_SurfaceBeam` lays it (`tr_surface.c:284–334`): along the
 * beam, its first corner {@link perpendicularVector} of the beam's direction, and each next turned
 * 60° about the beam, toward `up`. A corner is `start + LASER_RADIUS × (cos θ × left + sin θ ×
 * up)`, at the start and again at the end.
 *
 * Quake 3's renderers lay the corners about the world's origin, as they never add the beam's start
 * to them, so the tube runs from (0 0 0). The port lays them about the start, where the laser is.
 *
 * @param start - Where the beam starts: the laser.
 * @param end - Where it stops.
 * @returns the frame and the beam's length, or null for a beam of no length, which Quake 3 does
 *   not draw
 */
export function laserFrame(start: Vec3, end: Vec3): { basis: Basis; length: number } | null {
  const along = sub(end, start);
  const length = Math.hypot(along.x, along.y, along.z);
  if (length === 0) return null;
  const forward = scale(along, 1 / length);
  const left = perpendicularVector(forward);
  return { basis: { forward, left, up: cross(forward, left) }, length };
}

/**
 * The frame a projectile is drawn in — `CG_Missile` plus `RotateAroundDirection`.
 *
 * `forward` is the direction of travel, so a rocket points where it is going. The other two
 * axes are arbitrary up to the roll, which is exactly why Q3 spins them: a rocket with a
 * fixed arbitrary roll looks like it is sliding rather than flying.
 *
 * @param delta - Velocity. A stationary projectile falls back to pointing up, as Q3 does.
 * @param spinDegrees - Roll about the direction of travel.
 */
export function missileAxis(delta: Vec3, spinDegrees: number): Basis {
  const length = Math.hypot(delta.x, delta.y, delta.z);
  const forward = length === 0 ? vec3(0, 0, 1) : scale(delta, 1 / length);
  const left = rotatePointAroundVector(perpendicularVector(forward), forward, spinDegrees);
  return { forward, left, up: cross(forward, left) };
}

/**
 * How far a projectile has rolled — `RotateAroundDirection( ent.axis, cg.time / 4 )`.
 *
 * A quarter of a degree per millisecond: 90 degrees a second, slow enough to read as a spin
 * rather than a blur.
 */
export function missileSpinAngle(time: number): number {
  return time / 4;
}

/** How one weapon's impact is drawn. */
export interface ExplosionStyle {
  /**
   * `isSprite` — a camera-facing fireball rather than a model at the impact point. The two
   * kinds are placed completely differently: a sprite faces the camera and grows on a fixed
   * curve, a model sits on the surface with a random roll. Both fade by their shader alone.
   */
  sprite: boolean;
  /** Lifetime in milliseconds. */
  durationMs: number;
  /** The weapon whose explosion shader it is drawn in, where that is not its own. */
  shaderOf?: WeaponId;
}

/**
 * Impact styles — the `duration`/`isSprite` cases of `CG_MissileHitWall`
 * (`cg_weapons.c:1780`).
 *
 * The rocket is the only explosion that runs a full second. `isSprite` defaults to false and
 * only the grenade, rocket and BFG set it: the bullets draw `bullet.md3`, and the railgun and
 * plasma gun `ring02.md3`. A model impact is drawn unchanged and left to its shader. The
 * lightning gun is absent on purpose: `CG_MissileHitWall` gives it no explosion at all,
 * because its impact flare is drawn as part of the beam.
 */
export const EXPLOSION_STYLES: Partial<Record<WeaponId, ExplosionStyle>> = {
  [WP.MACHINEGUN]: { sprite: false, durationMs: 600 },
  [WP.SHOTGUN]: { sprite: false, durationMs: 600 },
  [WP.GRENADE_LAUNCHER]: { sprite: true, durationMs: 600 },
  [WP.ROCKET_LAUNCHER]: { sprite: true, durationMs: 1000 },
  [WP.RAILGUN]: { sprite: false, durationMs: 600 },
  [WP.PLASMAGUN]: { sprite: false, durationMs: 600 },
  [WP.BFG]: { sprite: true, durationMs: 600 }
};

/** How the server's rules have a client draw the missiles, which it reads from the serverinfo. */
export interface MissileLooks {
  /** `g_plasmaSize`: the plasma ball's radius. */
  readonly plasmaSize: number;
  /** `g_plasmaMarkSize`: the plasma's mark radius. */
  readonly plasmaMarkSize: number;
  /** `g_splashradius_bfg`: the BFG's blast, without which its impact is drawn bare. */
  readonly bfgSplashRadius: number;
}

/** id's: the plasma's ball and mark at 16, and a BFG with a blast. */
export const ID_MISSILE_LOOKS: MissileLooks = Object.freeze({
  plasmaSize: PLASMA_SPRITE_RADIUS,
  plasmaMarkSize: PLASMA_MARK_RADIUS,
  bfgSplashRadius: MISSILES[WP.BFG]!.splashRadius
});

/**
 * CPMA's BFG impact where the BFG has no blast: its own model and sound, but drawn as a model,
 * in the railgun's explosion shader (`CG_MissileHitWall`).
 */
export const BARE_BFG_EXPLOSION: ExplosionStyle = {
  sprite: false,
  durationMs: 600,
  shaderOf: WP.RAILGUN
};

/** How an impact's explosion is drawn under the rules the serverinfo carries. */
export function explosionStyle(weapon: WeaponId, looks: MissileLooks): ExplosionStyle | undefined {
  if (weapon === WP.BFG && !looks.bfgSplashRadius) return BARE_BFG_EXPLOSION;
  return EXPLOSION_STYLES[weapon];
}

/**
 * How large an impact's model is drawn: CPMA's `CG_MissileHitWall` scales the plasma's ring by
 * its mark's radius over id's 16, and leaves every other impact as it is.
 */
export function explosionScale(weapon: WeaponId, looks: MissileLooks): number {
  return weapon === WP.PLASMAGUN ? looks.plasmaMarkSize / PLASMA_MARK_RADIUS : 1;
}

/**
 * Distance an explosion sprite is pushed off the surface it struck — `VectorMA( origin, 16,
 * dir, sprOrg )`.
 *
 * Without it half the sprite is inside the wall.
 */
export const EXPLOSION_SURFACE_OFFSET = 16;

/**
 * Sprite radius over an explosion's life — `re.radius = 42 * (1 - c) + 30`.
 *
 * Note what this is *not*: the per-weapon `radius` in `CG_MissileHitWall` sizes the scorch
 * mark, not the fireball, and `CG_AddSpriteExplosion` overwrites the radius unconditionally.
 * So every sprite explosion in Quake 3 is the same size — a rocket and a plasma bolt differ
 * in their shader and their duration, not their scale.
 *
 * @param progress - 0 at the moment of impact, 1 when the explosion ends.
 */
export function explosionRadius(progress: number): number {
  return 42 * saturate(progress) + 30;
}

/**
 * Which frame of an `animMap` flipbook is showing.
 *
 * Q3 drives these off shader time, which starts when the effect is created, so every
 * explosion plays its sheet from the beginning rather than from wherever the global clock
 * happens to be.
 *
 * @param elapsedMs - Milliseconds since the effect started.
 * @param fps - Flipbook rate from the shader.
 * @param frameCount - Number of images in the sheet.
 */
export function animFrame(elapsedMs: number, fps: number, frameCount: number): number {
  if (frameCount <= 1 || fps <= 0) return 0;
  return Math.floor((elapsedMs / 1000) * fps) % frameCount;
}

/** `cgs.media.bloodExplosionShader` (`cg_main.c:976`): the spurt where a shot struck someone. */
export const BLOOD_SHADER = 'bloodExplosion';

/**
 * `CG_Bleed`'s sprite (`cg_effects.c:507–512`): 24 units in radius, for half a second.
 *
 * It neither grows nor fades — `LE_EXPLOSION` draws what it was given — and it sets no
 * `shaderTime`, so its five frames run on the game clock: a spurt shows whichever two or three
 * of them the clock is on, and every spurt shows the same one.
 */
export const BLOOD_RADIUS = 24;
export const BLOOD_MS = 500;

/** `step = 50` in `CG_RocketTrail` — one smoke puff every 50 ms of flight. */
export const TRAIL_STEP_MS = 50;

/** The `+ 8` in `CG_AddScaleFade`'s radius: a puff is never smaller than this. */
export const TRAIL_MIN_RADIUS = 8;

/** A projectile's smoke trail. */
export interface TrailStyle {
  /** `wi->trailRadius` — how much the puff grows over its life. */
  radius: number;
  /** `wi->wiTrailTime` — how long each puff lasts, in milliseconds. */
  lifetimeMs: number;
  /**
   * Whether the puff grows as it fades, which a trail's does. `LEF_PUFF_DONT_SCALE` says no, and
   * is what a jump pad's puff is made with: it keeps its radius for its whole life.
   */
  grow?: boolean;
  /**
   * The alpha `CG_SmokePuff` was given: a trail's is 0.33, the haste trail's 1. See
   * {@link smokeAlpha}.
   */
  alpha?: number;
}

/**
 * Trail styles — `CG_RegisterWeapon`'s `trailRadius`/`wiTrailTime`.
 *
 * Only the two ballistic weapons leave one. The rocket's puffs are twice the size and last
 * nearly three times as long, which is why a rocket reads as a smoke trail and a grenade as a
 * quick wisp.
 */
export const TRAIL_STYLES: Partial<Record<WeaponId, TrailStyle>> = {
  [WP.ROCKET_LAUNCHER]: { radius: 64, lifetimeMs: 2000 },
  [WP.GRENADE_LAUNCHER]: { radius: 32, lifetimeMs: 700 }
};

/** The puff a jump pad throws up: `CG_SmokePuff(..., 32, 1, 1, 1, 0.33f, 1000, ...)` (`cg_event.c:662`). */
export const JUMP_PAD_PUFF: TrailStyle = { radius: 32, lifetimeMs: 1000, grow: false };

/** How fast that puff drifts: `CG_SmokePuff`'s velocity argument is `up`, one unit a second. */
export const JUMP_PAD_PUFF_DRIFT: Vec3 = vec3(0, 0, 1);

/**
 * The puff a hasted runner leaves: `CG_SmokePuff(origin, vec3_origin, 8, 1, 1, 1, 1, 500,
 * cg.time, 0, 0, cgs.media.hastePuffShader)` with `leType = LE_SCALE_FADE`
 * (`cg_players.c:1522–1532`). It grows as it fades, and its colour alpha is 1 — three times a
 * trail puff's.
 */
export const HASTE_PUFF: TrailStyle = { radius: 8, lifetimeMs: 500, alpha: 1 };

/**
 * A smoke puff's radius over its life — `re->radius = le->radius * (1 - c) + 8`.
 *
 * Grows rather than shrinks: the puff spreads as it fades ({@link smokeAlpha}), so the oldest
 * part of a trail is the widest and faintest.
 *
 * @param style - The weapon's trail style.
 * @param progress - 0 when the puff appears, 1 when it dies.
 */
export function smokeRadius(style: TrailStyle, progress: number): number {
  return style.radius * saturate(progress) + TRAIL_MIN_RADIUS;
}

/**
 * A smoke puff's alpha over its life — `re->shaderRGBA[3] = 0xff * c * le->color[3]` in
 * `CG_AddScaleFade`, with the alpha `CG_SmokePuff` was handed: the byte Q3 stores, over 255.
 *
 * It starts at a third of opaque and fades from there. `smokePuff` is `blendfunc blend` with
 * `alphaGen vertex`, so this is the alpha the puff draws with. `CG_AddSpriteExplosion` works out
 * the same number for an explosion, but hands it to additive shaders that fade by
 * `rgbGen wave`, so there it never reaches the screen.
 *
 * @param progress - 0 when the puff appears, 1 when it dies.
 * @param alpha - The style's colour alpha: 0.33 for a trail or a jump pad, 1 for haste.
 */
export function smokeAlpha(progress: number, alpha = 0.33): number {
  return Math.trunc(0xff * (1 - saturate(progress)) * alpha) / 0xff;
}

/**
 * Beam half-widths — `r_railCoreWidth` (default 6) and the hard-coded 8 in
 * `RB_SurfaceLightningBolt`.
 *
 * Half, not full: `DoRailCore` puts vertices at `+spanWidth` and `-spanWidth`, so a rail core
 * is twelve units across and a lightning bolt sixteen.
 */
export const RAIL_CORE_HALF_WIDTH = 6;
export const LIGHTNING_HALF_WIDTH = 8;

/** `t = len / 256.0f` in `DoRailCore` — the beam texture repeats every 256 units. */
export const BEAM_TEXTURE_LENGTH = 256;

/** `cg_railTrailTime` — how long a rail beam hangs in the air, in milliseconds. */
export const RAIL_TRAIL_MS = 400;

/**
 * The lightning bolt is drawn four times, 45 degrees apart about its own axis
 * (`RB_SurfaceLightningBolt`).
 *
 * Four blades at 45 degrees cover 180, which is a full turn for a double-sided quad. That is
 * what gives the bolt volume from any angle instead of vanishing edge-on.
 */
export const LIGHTNING_BLADES = 4;
export const LIGHTNING_BLADE_STEP_DEGREES = 45;

/**
 * How far back along the beam the lightning gun's impact flare sits — `VectorMA( trace.endpos,
 * -16, dir, beam.origin )`.
 */
export const LIGHTNING_FLARE_OFFSET = 16;

/** Where the lightning gun's bolt ends this frame, and whether it struck something. */
export interface LightningBolt {
  /** Where the trace stopped: the first surface in the way, or `LIGHTNING_RANGE` out. */
  end: Vec3;
  /** Whether it stopped on something, which is when the crackle is drawn. */
  hit: boolean;
}

/**
 * The lightning gun's bolt this frame — `CG_LightningBolt`.
 *
 * A fresh trace every frame: from the eye, 14 units along the view, out to `LIGHTNING_RANGE`.
 * Q3 does not reuse the server's shot for this, which is what keeps the bolt on the crosshair
 * however the player moves between shots. The bolt is drawn from the gun's own `tag_flash`;
 * this is only where it ends.
 *
 * @param origin - The player's origin, as the camera is drawn from it.
 * @param viewangles - View angles in degrees.
 * @param viewheight - Eye height above the origin.
 * @param trace - `CG_Trace`.
 * @param clientNum - The player firing it, whom the bolt passes through (`cg_weapons.c:1025–1026`).
 */
export function lightningBolt(
  origin: Vec3,
  viewangles: Vec3,
  viewheight: number,
  trace: TraceFn,
  clientNum: number
): LightningBolt {
  const { forward } = angleVectors(viewangles);
  const muzzle = madd(vec3(origin.x, origin.y, origin.z + viewheight), MUZZLE_FORWARD, forward);
  const shot = traceShot(trace, muzzle, madd(muzzle, LIGHTNING_RANGE, forward), clientNum);
  return { end: shot.endpos, hit: shot.hit };
}

/**
 * The grappling hook's flare. CorkScrew's `CG_GrappleTrail` draws the grate lamp's flare
 * as a sprite where the hook is, its radius 10 give or take 1, re-rolled every frame…
 */
export const GRAPPLE_FLARE_SHADER = 'models/mapobjects/gratelamp/gratelamp_flare';
export const GRAPPLE_FLARE_RADIUS = 10;
export const GRAPPLE_FLARE_JITTER = 1;
/** …and pulled 16 units toward the viewer, so the wall it caught does not cut it in half. */
export const GRAPPLE_FLARE_PULL = 16;

/** An off-hand grappling hook as it is drawn this frame: the player's own, or anyone else's. */
export interface GrappleHook {
  /** Who threw it, by client number: the hook's `s.otherEntityNum`. */
  owner: number;
  /** Where the hook is: in flight, or where it caught. CorkScrew draws both alike. */
  position: Vec3;
  /**
   * Where the pointer starts if the thrower's drawn gun has no `tag_flash` to give it: the
   * player's own shot's muzzle point, or `CG_GrappleTrail`'s point on anyone else's body.
   * CorkScrew starts it from the gun's flash.
   */
  muzzle: Vec3;
}

/**
 * Where the hook's flare is drawn: the hook, pulled {@link GRAPPLE_FLARE_PULL} units toward
 * the viewer.
 *
 * @param hook - Where the hook is.
 * @param eye - Where the viewer is.
 */
export function grappleFlarePosition(hook: Vec3, eye: Vec3): Vec3 {
  const toEye = sub(eye, hook);
  const distance = Math.hypot(toEye.x, toEye.y, toEye.z);
  if (distance === 0) return { ...hook };
  return madd(hook, GRAPPLE_FLARE_PULL / distance, toEye);
}

/**
 * The flare's radius this frame — `10 + 2 * (random() - 0.5)`, re-rolled every frame, so it
 * shimmers between a radius of 9 and 11.
 *
 * @param random - Uniform over [0, 1]; injectable so a test can pin it.
 */
export function grappleFlareRadius(random: () => number = Math.random): number {
  return GRAPPLE_FLARE_RADIUS + 2 * GRAPPLE_FLARE_JITTER * (random() - 0.5);
}

/**
 * The axis a beam's quad spans, so it faces the viewer — `RB_SurfaceRailCore`.
 *
 * `cross(start − eye, end − eye)` is normal to the plane through the eye and the beam, so a
 * quad spanning it is edge-on to nothing. The degenerate case is the eye looking exactly down
 * the beam, where that plane is undefined; any perpendicular will do there, because a beam
 * pointing straight at you is a dot.
 *
 * @param start - Beam start, world space.
 * @param end - Beam end, world space.
 * @param eye - Viewer position.
 */
export function beamSide(start: Vec3, end: Vec3, eye: Vec3): Vec3 {
  const side = cross(normalize(sub(start, eye)), normalize(sub(end, eye)));
  if (dot(side, side) < 1e-12) return perpendicularVector(normalize(sub(end, start)));
  return normalize(side);
}

/** Clamp to 0..1. */
function saturate(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
