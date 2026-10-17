import { describe, expect, it } from 'vitest';

import { EV } from '../sim/events';
import {
  FLIGHT_SOUND,
  PROTECT_SOUND,
  QUAD_SOUND,
  REGEN_SOUND,
  powerupEventSound
} from './powerup-sounds';

/**
 * The sounds the powerups make while they run (`cgs.media`, `cg_main.c:729, 757–758`): the three
 * an event names, and the flight powerup's loop.
 */

describe('powerupEventSound', () => {
  it('names the sound of each powerup event, and nothing for the rest', () => {
    expect(powerupEventSound(EV.POWERUP_QUAD)).toBe(QUAD_SOUND);
    expect(powerupEventSound(EV.POWERUP_BATTLESUIT)).toBe(PROTECT_SOUND);
    expect(powerupEventSound(EV.POWERUP_REGEN)).toBe(REGEN_SOUND);
    expect(powerupEventSound(EV.JUMP)).toBeNull();
  });
});

describe('the powerups’ own sounds', () => {
  it('are the files the manifest brings', () => {
    expect([QUAD_SOUND, PROTECT_SOUND, REGEN_SOUND, FLIGHT_SOUND]).toEqual([
      'sound/items/damage3.wav',
      'sound/items/protect3.wav',
      'sound/items/regen.wav',
      'sound/items/flight.wav'
    ]);
  });
});
