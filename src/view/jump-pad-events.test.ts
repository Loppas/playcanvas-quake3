import { describe, expect, it } from 'vitest';

import { vec3 } from '../sim/vec3';
import { JUMP_PAD_SOUND, jumpPadEvent } from './jump-pad-events';

/**
 * `CG_EntityEvent`'s `EV_JUMP_PAD` (`cg_event.c:655–674`): the pad's boing, the player's own
 * jump sound, and the puff — shared by the player's own events and everyone else's.
 */

describe('JUMP_PAD_SOUND', () => {
  it('is the file the manifest brings', () => {
    expect(JUMP_PAD_SOUND).toBe('sound/world/jumppad.wav');
  });
});

describe('jumpPadEvent', () => {
  it('plays the pad then the player, and throws the puff where the player is', () => {
    const at = vec3(10, 20, 30);
    expect(jumpPadEvent(at)).toEqual({
      sounds: [
        { type: 'shared', path: JUMP_PAD_SOUND },
        { type: 'custom', name: 'jump1' }
      ],
      puff: vec3(10, 20, 30)
    });
  });

  it('keeps the puff its own, so the event cannot be moved by the state it came from', () => {
    const at = vec3(1, 2, 3);
    const event = jumpPadEvent(at);
    at.x = 99;

    expect(event.puff).toEqual(vec3(1, 2, 3));
  });
});
