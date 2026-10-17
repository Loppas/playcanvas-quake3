import { copy, type Vec3 } from '../sim/vec3';
import type { PlayerSound } from './player-events';

/**
 * What a jump pad does to a client's ears and eyes: `CG_EntityEvent`'s `EV_JUMP_PAD`
 * (`cg_event.c:655–674`). Shared by the player's own events and everyone else's, because Quake 3
 * plays the same two sounds and throws the same puff whichever body hit the pad.
 */

/** `cgs.media.jumpPadSound` (`cg_main.c:612`): the pad's boing. */
export const JUMP_PAD_SOUND = 'sound/world/jumppad.wav';

/** What hitting a pad sounds like and leaves behind. */
export interface JumpPadEvent {
  /**
   * "boing sound at origin, jump sound on player" (`cg_event.c:671–673`): the pad's own sound,
   * then the player's `*jump1.wav`, both from the player the event is on.
   */
  sounds: PlayerSound[];
  /** `CG_SmokePuff`'s puff, where the player is. */
  puff: Vec3;
}

/**
 * The event as a client plays it.
 *
 * @param origin - `cent->lerpOrigin`: where the player who hit the pad is.
 */
export function jumpPadEvent(origin: Vec3): JumpPadEvent {
  return {
    sounds: [
      { type: 'shared', path: JUMP_PAD_SOUND },
      { type: 'custom', name: 'jump1' }
    ],
    puff: copy(origin)
  };
}
