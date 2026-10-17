import { PW } from '../sim/items';
import type { Vec3 } from '../sim/vec3';
import { anglesToAxis } from './hand-pose';
import type { Placement } from './player-pose';

/**
 * `CG_TrailItem` and the two flags `CG_PlayerPowerups` trails with it (`cg_players.c:1627–1645`,
 * `:1862–1881`): baseq3 draws a carried flag as the flag's own model, sixteen units behind its
 * carrier and sixteen above, turned ninety degrees across the way they face. Engine-free.
 *
 * The port draws this one alone. Team Arena draws a flag on a pole whose cloth flaps
 * (`CG_PlayerFlag`, `:1653–1762`), and cgame picks between the two by whether the carrier's torso carries a
 * `tag_flag` (`:696–702`) — which no retail baseq3 player model has, and whose own models are in
 * no retail baseq3 pak. So the trail is both what Quake 3 draws with the art an owner has and the
 * only one the port could draw.
 *
 * The light each flag gives off is not here: it is the powerup gather's, beside the quad's
 * (`POWERUP_LIGHTS` in [`light-sources.ts`](light-sources.ts)).
 */

/** `VectorMA( cent->lerpOrigin, -16, axis[0], ent.origin )`: how far behind the carrier it hangs. */
export const TRAIL_ITEM_BACK = 16;
/** `ent.origin[2] += 16`: and how far above them. */
export const TRAIL_ITEM_UP = 16;
/** `angles[YAW] += 90`: the model is turned across the carrier's facing, not along it. */
export const TRAIL_ITEM_YAW = 90;

/** A player as the trail reads one. */
export interface FlagCarrier {
  /** `cent->lerpOrigin`: where their body is drawn. */
  origin: Readonly<Vec3>;
  /** `cent->lerpAngles`: which way they look. The trail keeps the yaw and drops the rest. */
  angles: Readonly<Vec3>;
  /** `currentState.powerups`: the bitmask of what they hold. */
  powerups: number;
  /** The flag's entity's number in a map's scene, as their own (`scene-sort.ts`); 0 by default. */
  order?: number;
}

/** Where a flag is drawn, and its entity's number in a map's scene. */
export type TrailPlace = Placement & { order: number };

/** Where each side's flag is drawn this frame, or `null` for one nobody is carrying. */
export interface FlagTrails {
  red: TrailPlace | null;
  blue: TrailPlace | null;
}

/**
 * `CG_TrailItem`'s place for a model trailed behind a player.
 *
 * The pitch and the roll are dropped before the offset is measured, so a flag hangs level
 * whatever its carrier is doing — which also makes the offset's own vertical term nothing, and
 * the sixteen up the whole of the lift. The model is then turned a further ninety degrees, so it
 * flies across the carrier's back rather than along it.
 */
export function trailItem(origin: Readonly<Vec3>, angles: Readonly<Vec3>): Placement {
  const forward = anglesToAxis(0, angles.y, 0)[0];
  return {
    origin: [
      origin.x - TRAIL_ITEM_BACK * forward[0],
      origin.y - TRAIL_ITEM_BACK * forward[1],
      origin.z - TRAIL_ITEM_BACK * forward[2] + TRAIL_ITEM_UP
    ],
    axis: anglesToAxis(0, angles.y + TRAIL_ITEM_YAW, 0)
  };
}

/**
 * Where the two flags trail this frame.
 *
 * Quake 3 adds one model per carrying entity as it walks the snapshot, and Capture the Flag gives
 * it at most one of each: a side has one flag, and taking it is what sets the powerup, so no two
 * players hold the same one. A corpse cannot hold one either — the death drops or returns it and
 * the state is rebuilt before the body is copied — so the first carrier found is the only one.
 *
 * @param carriers - Every player drawn this frame, the viewer's own body among them, as
 *   `CG_AddPacketEntities` has them.
 */
export function flagTrails(carriers: readonly FlagCarrier[]): FlagTrails {
  const trailOf = (powerup: number): TrailPlace | null => {
    const carrier = carriers.find((candidate) => (candidate.powerups & (1 << powerup)) !== 0);
    if (!carrier) return null;
    return { ...trailItem(carrier.origin, carrier.angles), order: carrier.order ?? 0 };
  };
  return { red: trailOf(PW.REDFLAG), blue: trailOf(PW.BLUEFLAG) };
}
