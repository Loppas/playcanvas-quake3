import { CONTENTS } from './constants';
import type { EntityShared } from './game-entity';
import { vec3, type Vec3 } from './vec3';

/**
 * An entity's box in the 24 bits of `s.solid`: how a server tells a client what it may hit, and
 * the two conversions either side of the wire (`sv_world.c:222–250`, `cg_predict.c:109–117`).
 *
 * A client traces too — a lightning bolt, a shotgun's pellets — and has to know where everyone is
 * and how big. It is sent the entity state and nothing of `r`, so linking an entity packs its box
 * into the state as three bytes: the half-width, the depth below the origin, and the height above
 * it less 32. That is enough for anything that is a box the same width both ways, which is every
 * player, crouching or standing.
 *
 * Only what stops a shot or a move is packed, `CONTENTS_SOLID` or `CONTENTS_BODY`, so a corpse,
 * whose box is `CONTENTS_CORPSE`, is nothing a client can hit.
 */

/** "A solid_box will never create this value": a brush model, whose shape is the map's. */
export const SOLID_BMODEL = 0xffffff;

/** Each byte holds 1 to 255, so a box has some size whatever it is given. */
function toByte(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), 255);
}

/**
 * `SV_LinkEntity`'s encoding (`sv_world.c:222–250`): an entity's box as `s.solid`, or 0 for one
 * nothing can hit.
 *
 * Each size goes to a whole unit toward zero, as C's conversion does, and between 1 and 255. The
 * x half-width stands for y as well: "assume that x/y are equal and symetric". The bounds are
 * floats, and the height's 32 is added in floats.
 *
 * @param r - What linking reads of the entity: whether it is a brush model, what it is made of,
 *   and its bounds about its origin.
 */
export function packSolid(r: Pick<EntityShared, 'bmodel' | 'contents' | 'mins' | 'maxs'>): number {
  if (r.bmodel) return SOLID_BMODEL;
  if (!(r.contents & (CONTENTS.SOLID | CONTENTS.BODY))) return 0;
  const i = toByte(Math.fround(r.maxs.x));
  const j = toByte(-Math.fround(r.mins.z));
  // "And z maxs can be negative..."
  const k = toByte(Math.fround(Math.fround(r.maxs.z) + 32));
  return (k << 16) | (j << 8) | i;
}

/**
 * `CG_ClipMoveToEntities`' decoding (`cg_predict.c:109–117`): the box a packed `s.solid` stands
 * for, about the entity's origin.
 *
 * @param solid - A packed box, neither 0 nor {@link SOLID_BMODEL}.
 */
export function solidBox(solid: number): { mins: Vec3; maxs: Vec3 } {
  const x = solid & 255;
  const zd = (solid >> 8) & 255;
  const zu = ((solid >> 16) & 255) - 32;
  return { mins: vec3(-x, -x, -zd), maxs: vec3(x, x, zu) };
}
