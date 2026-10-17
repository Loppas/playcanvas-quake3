import { ENTITYNUM_NONE } from '../net/protocol';
import { f } from '../sim/cm/q-math';
import { CONTENTS, MASK } from '../sim/constants';
import { PW } from '../sim/items';
import type { PointContentsFn, TraceFn } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { WP, type WeaponId } from '../sim/weapons/constants';
import { LEMT } from './fragments';
import type { Marks } from './marks';
import { polyVerts, type PolyVerts } from './scene-polys';

/**
 * The marks cgame makes beyond the scene's own effects: where a missile or a shot hits a wall
 * (`CG_MissileHitWall`'s mark, `cg_weapons.c:1924-1936`), where a gib bounces
 * (`CG_FragmentBounceMark`, `cg_localents.c:155-175`), a player's shadow on the ground under them
 * (`CG_PlayerShadow`, `cg_players.c:2005-2050`) and the wake round them where they stand in water
 * (`CG_PlayerSplash`, `:2060-2138`).
 *
 * The arithmetic is cgame's QVM's floats, in Q3's order.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** The marks' shaders cgame registers (`cg_main.c:1025-1031`), by their handles. */
export interface MarkMedia<Shader> {
  bullet: Shader;
  burn: Shader;
  hole: Shader;
  energy: Shader;
  shadow: Shader;
  wake: Shader;
  blood: Shader;
}

/** The shaders' names, as `CG_RegisterGraphics` registers them. */
export const MARK_SHADERS: Readonly<MarkMedia<string>> = {
  bullet: 'gfx/damage/bullet_mrk',
  burn: 'gfx/damage/burn_med_mrk',
  hole: 'gfx/damage/hole_lg_mrk',
  energy: 'gfx/damage/plasma_mrk',
  shadow: 'markShadow',
  wake: 'wake',
  blood: 'bloodMark'
};

/** A weapon's mark: its shader, by its media's name, and its radius. */
interface WeaponMark {
  shader: keyof MarkMedia<unknown>;
  radius: number;
}

/**
 * `CG_MissileHitWall`'s switch (`cg_weapons.c:1768-1899`), baseq3's build: a weapon it names its
 * own mark, and any other the lightning gun's, whose case its `default` falls into.
 */
const WEAPON_MARKS: ReadonlyMap<number, WeaponMark> = new Map([
  [WP.GRENADE_LAUNCHER, { shader: 'burn', radius: 64 }],
  [WP.ROCKET_LAUNCHER, { shader: 'burn', radius: 64 }],
  [WP.RAILGUN, { shader: 'energy', radius: 24 }],
  [WP.PLASMAGUN, { shader: 'energy', radius: 16 }],
  [WP.BFG, { shader: 'burn', radius: 32 }],
  [WP.SHOTGUN, { shader: 'bullet', radius: 4 }],
  [WP.MACHINEGUN, { shader: 'bullet', radius: 8 }]
]);
const DEFAULT_MARK: WeaponMark = { shader: 'hole', radius: 12 };

/** An impact's own: where, the plane's normal, and the rail's tint, `color1`'s. */
export interface MarkedImpact {
  weapon: WeaponId;
  origin: Vec3;
  normal: Vec3;
  color?: readonly [number, number, number];
}

/** Scratch for a mark's place and direction. */
const at = [0, 0, 0];
const dir = [0, 0, 0];

function setPlace(origin: Vec3, normal: Vec3): void {
  at[0] = origin.x;
  at[1] = origin.y;
  at[2] = origin.z;
  dir[0] = normal.x;
  dir[1] = normal.y;
  dir[2] = normal.z;
}

/**
 * `CG_MissileHitWall`'s mark: its weapon's, turned at random, the rail's in its thrower's
 * `color1`, the plasma's and the rail's fading their alpha and the rest their colour.
 *
 * @param random - cgame's `random()`, in [0, 1].
 * @param time - `cg.time`.
 */
export function impactMark<Shader>(
  marks: Marks<Shader>,
  media: MarkMedia<Shader>,
  impact: MarkedImpact,
  random: () => number,
  time: number
): void {
  const { shader, radius } = WEAPON_MARKS.get(impact.weapon) ?? DEFAULT_MARK;
  const orientation = f(f(random()) * 360);
  const alphaFade = shader === 'energy';
  const tint = impact.weapon === WP.RAILGUN ? (impact.color ?? BLACK) : WHITE;
  setPlace(impact.origin, impact.normal);
  const [red, green, blue] = tint;
  const mark = media[shader];
  marks.impactMark(mark, at, dir, orientation, red, green, blue, 1, alphaFade, radius, false, time);
}

/** A rail's tint where its thrower has no clientinfo, as a rail nobody's is black; the rest's. */
const BLACK = [0, 0, 0] as const;
const WHITE = [1, 1, 1] as const;

/**
 * `CG_FragmentBounceMark`: blood where a gib bounces, 16 to 47 units across and fading its alpha;
 * a burn's for `LEMT_BURN`, which baseq3 never gives. A fragment marks once.
 *
 * @param markType - The fragment's {@link LEMT}.
 * @param random - cgame's `random()`, in [0, 1); its `rand()` is a draw of it scaled.
 */
export function fragmentBounceMark<Shader>(
  marks: Marks<Shader>,
  media: MarkMedia<Shader>,
  markType: number,
  origin: Vec3,
  normal: Vec3,
  random: () => number,
  time: number
): void {
  const blood = markType === LEMT.BLOOD;
  if (!blood && markType !== LEMT.BURN) return;
  const radius = blood ? 16 + Math.floor(random() * 32) : 8 + Math.floor(random() * 16);
  const orientation = f(f(random()) * 360);
  setPlace(origin, normal);
  const shader = blood ? media.blood : media.burn;
  marks.impactMark(shader, at, dir, orientation, 1, 1, 1, 1, true, radius, false, time);
}

/** The marks' handles, each found by its name. */
export function markMedia<Shader>(handle: (name: string) => Shader): MarkMedia<Shader> {
  const media = {} as MarkMedia<Shader>;
  for (const key of Object.keys(MARK_SHADERS) as (keyof MarkMedia<Shader>)[]) {
    media[key] = handle(MARK_SHADERS[key]);
  }
  return media;
}

/** `SHADOW_DISTANCE` (`cg_players.c:2004`): how far down a shadow is looked for. */
const SHADOW_DISTANCE = 128;
const SHADOW_MINS = vec3(-15, -15, 0);
const SHADOW_MAXS = vec3(15, 15, 2);
const POINT = vec3(0, 0, 0);

/** Scratch for where a trace starts and ends. */
const start = vec3();
const end = vec3();

/**
 * `CG_PlayerShadow`: under `cg_shadows 1`, a mark straight down the world from a body, within
 * 128 units, darker the nearer, turned as its legs are and made for this frame alone; none for the
 * invisible. `cg_shadows` 2 and 3 have shadows of their own, not ported, and no mark.
 *
 * @param origin - Where the body is drawn: `lerpOrigin`.
 * @param powerups - Its entity's mask.
 * @param legsYaw - Its legs' yaw, as `CG_PlayerAngles` left it this frame.
 * @param shadows - `cg_shadows`.
 * @param trace - The world's alone, `trap_CM_BoxTrace`'s.
 */
export function playerShadow<Shader>(
  origin: Vec3,
  powerups: number,
  legsYaw: number,
  shadows: number,
  trace: TraceFn,
  marks: Marks<Shader>,
  shader: Shader,
  time: number
): void {
  if (shadows === 0) return;
  if (powerups & (1 << PW.INVIS)) return;
  end.x = origin.x;
  end.y = origin.y;
  end.z = f(origin.z - SHADOW_DISTANCE);
  const tr = trace(origin, SHADOW_MINS, SHADOW_MAXS, end, ENTITYNUM_NONE, MASK.PLAYERSOLID);
  if (tr.fraction === 1 || tr.startsolid || tr.allsolid) return;
  if (shadows !== 1) return;
  const alpha = f(1 - tr.fraction);
  setPlace(tr.endpos, tr.normal);
  const yaw = f(legsYaw);
  marks.impactMark(shader, at, dir, yaw, alpha, alpha, alpha, 1, false, 24, true, time);
}

/** The liquids a wake is drawn on. */
const LIQUID = CONTENTS.WATER | CONTENTS.SLIME | CONTENTS.LAVA;

/** The wake's square, its corners' coordinates and colours as `CG_PlayerSplash` lays them. */
const wake = polyVerts(4);
wake.st.set([0, 0, 0, 1, 1, 1, 1, 0]);
wake.modulate.fill(255);
/** Each corner's side of the centre, x then y. */
const WAKE_CORNERS = [-32, -32, -32, 32, 32, 32, 32, -32];

/**
 * `CG_PlayerSplash`: under any `cg_shadows` but 0, where the body's feet are in a liquid and its
 * head out of it and of the solid, a square 64 units across on the liquid's surface, for this frame
 * alone.
 *
 * @param contents - The client's, `CG_PointContents`: the world's and its brush models'.
 * @param trace - The world's alone, `trap_CM_BoxTrace`'s.
 * @param addPoly - `trap_R_AddPolyToScene`.
 */
export function playerSplash<Shader>(
  origin: Vec3,
  shadows: number,
  contents: PointContentsFn,
  trace: TraceFn,
  addPoly: (shader: Shader, numVerts: number, verts: PolyVerts, first: number) => void,
  shader: Shader
): void {
  if (shadows === 0) return;
  end.x = origin.x;
  end.y = origin.y;
  end.z = f(origin.z - 24);
  // "if the feet aren't in liquid, don't make a mark"
  if (!(contents(end, 0) & LIQUID)) return;
  start.x = origin.x;
  start.y = origin.y;
  start.z = f(origin.z + 32);
  // "if the head isn't out of liquid, don't make a mark"
  if (contents(start, 0) & (CONTENTS.SOLID | LIQUID)) return;
  const tr = trace(start, POINT, POINT, end, ENTITYNUM_NONE, LIQUID);
  if (tr.fraction === 1) return;
  for (let i = 0; i < 4; i++) {
    wake.xyz[i * 3] = f(tr.endpos.x + WAKE_CORNERS[i * 2]);
    wake.xyz[i * 3 + 1] = f(tr.endpos.y + WAKE_CORNERS[i * 2 + 1]);
    wake.xyz[i * 3 + 2] = tr.endpos.z;
  }
  addPoly(shader, 4, wake, 0);
}
