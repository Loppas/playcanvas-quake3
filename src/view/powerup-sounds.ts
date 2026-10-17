import { EV } from '../sim/events';

/**
 * The sounds the powerups make while they run (`cgs.media`, `cg_main.c:729, 757–758`).
 *
 * The pickup sounds are `item-sounds.ts`': this is what the quad, the suit and regeneration say
 * once they are held — and each is named on the event the thing that happened raised, which is
 * how a client knows to play it.
 */

/** The quad's, played as a quadded shot goes off and as a landing gauntlet punch says so. */
export const QUAD_SOUND = 'sound/items/damage3.wav';

/** The battle suit's, played every time it takes a hit off one. */
export const PROTECT_SOUND = 'sound/items/protect3.wav';

/** Regeneration's, played on each heal the once-a-second action gives. */
export const REGEN_SOUND = 'sound/items/regen.wav';

/**
 * Flight's, which is not a one-shot but a loop: "flight plays a looped sound"
 * (`cg_players.c:1855–1858`), added again every frame the powerup is held and heard from the
 * body wearing it.
 */
export const FLIGHT_SOUND = 'sound/items/flight.wav';

/**
 * `CG_EntityEvent`'s three powerup cases (`cg_event.c:1189–1214`): which sound an event plays,
 * or `null` for an event that is not one of them.
 *
 * @param event - The event number, with the counter bits taken off.
 */
export function powerupEventSound(event: number): string | null {
  switch (event) {
    case EV.POWERUP_QUAD:
      return QUAD_SOUND;
    case EV.POWERUP_BATTLESUIT:
      return PROTECT_SOUND;
    case EV.POWERUP_REGEN:
      return REGEN_SOUND;
    default:
      return null;
  }
}
