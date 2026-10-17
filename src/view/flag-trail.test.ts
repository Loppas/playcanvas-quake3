import { describe, expect, it } from 'vitest';

import { PW } from '../sim/items';
import { vec3 } from '../sim/vec3';
import { anglesToAxis } from './hand-pose';
import {
  TRAIL_ITEM_BACK,
  TRAIL_ITEM_UP,
  TRAIL_ITEM_YAW,
  flagTrails,
  trailItem,
  type FlagCarrier
} from './flag-trail';

/** A player carrying what the test says, facing `yaw`, standing at the origin unless told. */
function carrier(powerups: number, yaw = 0, at = vec3(0, 0, 0)): FlagCarrier {
  return { origin: at, angles: vec3(0, yaw, 0), powerups };
}

describe('CG_TrailItem', () => {
  it('hangs the model 16 behind the carrier and 16 above', () => {
    // `VectorMA( cent->lerpOrigin, -16, axis[0], ent.origin )` and `ent.origin[2] += 16`: the
    // two are Quake 3's own numbers, so the literals stand here and not the constants.
    expect(TRAIL_ITEM_BACK).toBe(16);
    expect(TRAIL_ITEM_UP).toBe(16);

    // Facing +X: sixteen behind is sixteen back along it.
    const place = trailItem(vec3(100, 50, 20), vec3(0, 0, 0));

    expect(place.origin[0]).toBeCloseTo(84);
    expect(place.origin[1]).toBeCloseTo(50);
    expect(place.origin[2]).toBeCloseTo(36);
  });

  it('measures "behind" along the carrier\'s own facing', () => {
    // Facing +Y: sixteen behind is sixteen back along it instead.
    const place = trailItem(vec3(0, 0, 0), vec3(0, 90, 0));

    expect(place.origin[0]).toBeCloseTo(0);
    expect(place.origin[1]).toBeCloseTo(-16);
    expect(place.origin[2]).toBeCloseTo(16);
  });

  it('drops the pitch and the roll, so a flag hangs level however its carrier lies', () => {
    const level = trailItem(vec3(0, 0, 0), vec3(0, 40, 0));
    const tilted = trailItem(vec3(0, 0, 0), vec3(-70, 40, 25));

    expect(tilted.origin).toEqual(level.origin);
    expect(tilted.axis).toEqual(level.axis);
  });

  it('turns the model 90° across the way the carrier faces', () => {
    expect(TRAIL_ITEM_YAW).toBe(90);
    const place = trailItem(vec3(0, 0, 0), vec3(0, 40, 0));

    expect(place.axis).toEqual(anglesToAxis(0, 130, 0));
  });
});

describe('CG_PlayerPowerups: the flags trailed', () => {
  it('trails each side\'s flag behind whoever holds it', () => {
    const trails = flagTrails([
      carrier(1 << PW.REDFLAG, 0, vec3(100, 0, 0)),
      carrier(1 << PW.BLUEFLAG, 0, vec3(-100, 0, 0))
    ]);

    expect(trails.red?.origin[0]).toBeCloseTo(84);
    expect(trails.blue?.origin[0]).toBeCloseTo(-116);
  });

  it('trails nothing for a flag nobody is carrying', () => {
    expect(flagTrails([])).toEqual({ red: null, blue: null });
    expect(flagTrails([carrier(1 << PW.QUAD)])).toEqual({ red: null, blue: null });
    expect(flagTrails([carrier(1 << PW.REDFLAG)]).blue).toBeNull();
  });
});
