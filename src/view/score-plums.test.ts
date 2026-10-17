import { describe, expect, it } from 'vitest';

import { vec3 } from '../sim/vec3';
import { LocalEntities, MAX_LOCAL_ENTITIES } from './local-entities';
import { localEntity } from './scene-sort';
import { SCORE_PLUM_TIME, ScorePlums, plumColor } from './score-plums';

/** Where the view is: well off to one side along −y, so a plum faces it along +y. */
const EYE = vec3(0, -500, 0);

describe('CG_ScorePlum', () => {
  it('is only the scorer’s, and only with cg_scorePlums on', () => {
    const plums = new ScorePlums();
    plums.add(2, vec3(0, 0, 100), 1, 0, 1, true);
    plums.add(1, vec3(0, 0, 100), 1, 0, 1, false);
    expect(plums.sprites(1000, EYE)).toEqual([]);

    plums.add(1, vec3(0, 0, 100), 1, 0, 1, true);
    expect(plums.sprites(1000, EYE)).toHaveLength(1);
  });

  it('puts one 20 units lower when it would sit at the height of the last', () => {
    const plums = new ScorePlums();
    plums.add(0, vec3(0, 0, 100), 1, 0, 0, true);
    plums.add(0, vec3(0, 0, 115), 1, 0, 0, true);
    plums.add(0, vec3(0, 0, 200), 1, 0, 0, true);
    // Each is measured against the last's own height, not where it was put.
    const heights = plums.sprites(SCORE_PLUM_TIME / 2, EYE).map(({ origin }) => origin.z);
    expect(heights).toEqual([100 + 60, 115 - 20 + 60, 200 + 60]);
  });

  it('starts the first one lower if it is born near the origin’s height', () => {
    // `lastPos` starts zeroed, as a static does.
    const plums = new ScorePlums();
    plums.add(0, vec3(0, 0, 10), 1, 0, 0, true);
    expect(plums.sprites(SCORE_PLUM_TIME / 2, EYE)[0].origin.z).toBe(10 - 20 + 60);
  });
});

describe('CG_AddScorePlum', () => {
  it('rises from 10 to 110 units over its four seconds, swaying across the view', () => {
    const plums = new ScorePlums();
    plums.add(0, vec3(0, 0, 500), 1, 1000, 0, true);
    const at = (time: number) => plums.sprites(time, EYE)[0]?.origin;

    expect(at(1000)).toMatchObject({ z: 510 });
    expect(at(3000)).toMatchObject({ z: 560 });
    // "Across" is the view's direction crossed with up, which here is −x. At the half the sway
    // is −10 along it, and the one digit sits half its width further along: 10 − 4.
    expect(at(3000)!.x).toBeCloseTo(6, 6);
    // A quarter from the end the sine is at its height, and the sway +10 along it: −10 − 4.
    expect(at(4000)!.x).toBeCloseTo(-14, 6);
    expect(at(5000)).toBeUndefined();
  });

  it('fades over its last quarter, in whole steps of 255', () => {
    const plums = new ScorePlums();
    plums.add(0, vec3(0, 0, 500), 1, 0, 0, true);
    expect(plums.sprites(2000, EYE)[0].color[3]).toBe(1);
    expect(plums.sprites(3500, EYE)[0].color[3]).toBe(Math.trunc(255 * 4 * 0.125) / 255);
  });

  it('writes the score a digit to a sprite, most significant first, the sign ahead', () => {
    const plums = new ScorePlums();
    plums.add(0, vec3(0, 0, 500), -12, 0, 0, true);
    const digits = plums.sprites(2000, EYE);
    expect(digits.map(({ shader }) => shader)).toEqual([
      'gfx/2d/numbers/minus_32b',
      'gfx/2d/numbers/one_32b',
      'gfx/2d/numbers/two_32b'
    ]);
    // 8 apart across the view, from half the count's width out, each 4 across.
    expect(digits.map(({ origin }) => origin.x - digits[2].origin.x)).toEqual([-16, -8, 0]);
    expect(digits.every(({ radius }) => radius === 4)).toBe(true);
  });

  it("orders its digits in a scene as its local entity's parts, as they are added", () => {
    const pool = new LocalEntities();
    pool.alloc();
    const plums = new ScorePlums(pool);
    plums.add(0, vec3(0, 0, 500), -12, 0, 0, true);
    expect(plums.sprites(2000, EYE).map(({ order }) => order)).toEqual(
      [0, 1, 2].map((part) => localEntity(1, part))
    );
  });

  it('writes a zero as one digit', () => {
    const plums = new ScorePlums();
    plums.add(0, vec3(0, 0, 500), 0, 0, 0, true);
    expect(plums.sprites(2000, EYE).map(({ shader }) => shader)).toEqual([
      'gfx/2d/numbers/zero_32b'
    ]);
  });

  it('lets one go that the view is inside', () => {
    const plums = new ScorePlums();
    plums.add(0, vec3(0, 0, 500), 1, 0, 0, true);
    // Where the plum is at half its life, before the sway.
    expect(plums.sprites(2000, vec3(-10, 0, 560))).toEqual([]);
    expect(plums.sprites(2100, EYE)).toEqual([]);
  });

  it('is gone after a restart', () => {
    const plums = new ScorePlums();
    plums.add(0, vec3(0, 0, 500), 1, 0, 0, true);
    plums.clear();
    expect(plums.sprites(1000, EYE)).toEqual([]);
  });

  it('holds a local entity while it floats, and gives it back as it goes', () => {
    const pool = new LocalEntities();
    const plums = new ScorePlums(pool);
    plums.add(0, vec3(0, 0, 500), 1, 0, 0, true);
    plums.add(0, vec3(0, 0, 900), 1, 1000, 0, true);
    expect(pool.count).toBe(2);
    plums.sprites(SCORE_PLUM_TIME, EYE);
    expect(pool.count).toBe(1);
    // Inside it, the view lets it go.
    plums.sprites(1000 + SCORE_PLUM_TIME / 2, vec3(-10, 0, 960));
    expect(pool.count).toBe(0);
    plums.add(0, vec3(0, 0, 500), 1, 0, 0, true);
    plums.clear();
    expect(pool.count).toBe(0);
  });

  it('lets one go when the pool frees its place for a newer local entity', () => {
    const pool = new LocalEntities();
    const plums = new ScorePlums(pool);
    plums.add(0, vec3(0, 0, 500), 1, 0, 0, true);
    for (let i = 0; i < MAX_LOCAL_ENTITIES; i++) pool.alloc();
    expect(plums.sprites(1000, EYE)).toEqual([]);
    expect(pool.count).toBe(MAX_LOCAL_ENTITIES);
  });
});

describe('a plum’s colour', () => {
  it('is white for 1, green to 9, yellow to 19, blue to 49, magenta from 50, red below 0', () => {
    expect(plumColor(1)).toEqual([1, 1, 1]);
    expect(plumColor(0)).toEqual([1, 1, 1]);
    expect(plumColor(2)).toEqual([0, 1, 0]);
    expect(plumColor(9)).toEqual([0, 1, 0]);
    expect(plumColor(10)).toEqual([1, 1, 0]);
    expect(plumColor(19)).toEqual([1, 1, 0]);
    expect(plumColor(20)).toEqual([0, 0, 1]);
    expect(plumColor(49)).toEqual([0, 0, 1]);
    expect(plumColor(50)).toEqual([1, 0, 1]);
    expect(plumColor(-1)).toEqual([1, 0x11 / 255, 0x11 / 255]);
  });
});
