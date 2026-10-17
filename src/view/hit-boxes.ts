import type { EntityState, PlayerState } from '../net/protocol';
import { CROUCH_VIEWHEIGHT, EF_DEAD, PERS, TEAM } from '../sim/constants';
import { solidBox } from '../sim/entity-solid';
import { playerBounds } from '../sim/types';
import type { Vec3 } from '../sim/vec3';

/**
 * `cg_drawBBox`: each living player's hit box, where the view draws them, in their team's colour,
 * as Excessive Plus draws it from unlagged's `CG_AddBoundingBox` (`cg_unlagged.c`). Its own
 * hit-box scale and cylinder belong to its gameplay, and are left out.
 */

/** A box to draw: where its player is drawn, the box about that point, and its colour. */
export interface HitBox {
  origin: Vec3;
  mins: Vec3;
  maxs: Vec3;
  color: readonly [number, number, number];
}

/** A player the view draws: the entity the snapshot carried, and where it is drawn. */
interface DrawnPlayer {
  state: EntityState;
  origin: Vec3;
}

/** The player's own body, which no snapshot sent to them carries, and where it is drawn. */
export interface OwnBody {
  origin: Vec3;
  ps: Pick<PlayerState, 'eFlags' | 'viewheight' | 'persistant'>;
}

/** Excessive Plus's colours: the red team's, the blue team's, and anyone's in neither. */
const RED: HitBox['color'] = [0.91, 0, 0];
const BLUE: HitBox['color'] = [0.18, 0.38, 0.78];
const FREE: HitBox['color'] = [0, 1, 0.16];

/**
 * The boxes to draw: every other living player's, from the box its entity carries, and the
 * player's own while their body is drawn, from their stance.
 *
 * @param others - Every player the view draws, each where it draws them.
 * @param team - A player's team, by client number.
 * @param own - The player's own body, or null while it is not drawn.
 */
export function playerHitBoxes(
  others: readonly DrawnPlayer[],
  team: (clientNum: number) => number,
  own: OwnBody | null
): HitBox[] {
  const boxes: HitBox[] = [];
  for (const { state, origin } of others) {
    // A corpse is dead, and packs no box.
    if (state.eFlags & EF_DEAD || state.solid === 0) continue;
    const { mins, maxs } = solidBox(state.solid);
    boxes.push({ origin, mins, maxs, color: teamColor(team(state.clientNum)) });
  }
  if (own !== null && (own.ps.eFlags & EF_DEAD) === 0) {
    // Crouched by the view height, as Excessive Plus tells.
    const { mins, maxs } = playerBounds(own.ps.viewheight === CROUCH_VIEWHEIGHT);
    boxes.push({ origin: own.origin, mins, maxs, color: teamColor(own.ps.persistant[PERS.TEAM]) });
  }
  return boxes;
}

function teamColor(team: number): HitBox['color'] {
  if (team === TEAM.RED) return RED;
  if (team === TEAM.BLUE) return BLUE;
  return FREE;
}
