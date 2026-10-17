import { describe, expect, it } from 'vitest';

import { ANIM } from '../sim/animations';
import { TEAM } from '../sim/constants';
import { PW } from '../sim/items';
import { vec3 } from '../sim/vec3';
import {
  BATTLE_SUIT_SHADER,
  BATTLE_WEAPON_SHADER,
  HASTE_TRAIL_STEP_MS,
  INVIS_SHADER,
  QUAD_SHADER,
  QUAD_WEAPON_SHADER,
  RED_QUAD_SHADER,
  REGEN_SHADER,
  bodyPasses,
  hasteTrailPuff,
  invisible,
  regenVisible,
  weaponPasses
} from './powerup-passes';

/** `1 << PW.x`, as `BG_PlayerStateToEntityState` writes the entity's `powerups`. */
const bit = (powerup: number) => 1 << powerup;

describe('powerup passes', () => {
  it('draws nothing over a player holding nothing', () => {
    expect(bodyPasses(0, TEAM.FREE, 0)).toEqual({ hidden: false, shaders: [] });
    expect(weaponPasses(0)).toEqual([]);
  });

  it('draws an invisible player as the invisibility pass alone, body and gun', () => {
    const invis = bit(PW.INVIS);
    expect(invisible(invis)).toBe(true);
    expect(bodyPasses(invis, TEAM.FREE, 0)).toEqual({ hidden: true, shaders: [INVIS_SHADER] });
    expect(weaponPasses(invis)).toEqual([INVIS_SHADER]);
  });

  it('leaves the invisibility pass out once another powerup is the shell', () => {
    expect(bodyPasses(bit(PW.QUAD), TEAM.FREE, 0)).toEqual({ hidden: false, shaders: [QUAD_SHADER] });
  });

  it('draws the quad in the viewer of the red team from the flag shader', () => {
    const quad = bit(PW.QUAD);
    expect(bodyPasses(quad, TEAM.RED, 0).shaders).toEqual([RED_QUAD_SHADER]);
    expect(bodyPasses(quad, TEAM.BLUE, 0).shaders).toEqual([QUAD_SHADER]);
  });

  it('draws regeneration for the hundred milliseconds a second it shows', () => {
    const regen = bit(PW.REGEN);
    // `(cg.time / 100) % 10 == 1`: whole hundreds, and the second of every ten.
    expect(regenVisible(100)).toBe(true);
    expect(regenVisible(199)).toBe(true);
    expect(regenVisible(0)).toBe(false);
    expect(regenVisible(200)).toBe(false);
    expect(regenVisible(1100)).toBe(true);
    expect(bodyPasses(regen, TEAM.FREE, 100).shaders).toEqual([REGEN_SHADER]);
    expect(bodyPasses(regen, TEAM.FREE, 200).shaders).toEqual([]);
  });

  it('draws the battle suit whenever it is held, and the quad before it', () => {
    const both = bit(PW.QUAD) | bit(PW.BATTLESUIT);
    expect(bodyPasses(both, TEAM.FREE, 0).shaders).toEqual([QUAD_SHADER, BATTLE_SUIT_SHADER]);
  });

  it('draws all three shells in ioq3’s order: quad, regeneration, then the suit', () => {
    const all = bit(PW.QUAD) | bit(PW.REGEN) | bit(PW.BATTLESUIT);
    expect(bodyPasses(all, TEAM.FREE, 100).shaders).toEqual([
      QUAD_SHADER,
      REGEN_SHADER,
      BATTLE_SUIT_SHADER
    ]);
  });

  it('dresses the gun in the battle suit and then the quad, ioq3’s order', () => {
    const both = bit(PW.QUAD) | bit(PW.BATTLESUIT);
    expect(weaponPasses(both)).toEqual([BATTLE_WEAPON_SHADER, QUAD_WEAPON_SHADER]);
  });
});

describe('haste trail', () => {
  const at = vec3(10, 20, 30);

  it('leaves a puff at the player’s feet while they run, one every hundred milliseconds', () => {
    // `cent->trailTime` starts at 0 and the first frame passes it: a puff at once, then every
    // hundred milliseconds of clock the mark is behind.
    const first = hasteTrailPuff(ANIM.LEGS_RUN, 0, 0, at);
    expect(first.puff).toEqual(vec3(10, 20, 14));
    expect(first.trailTime).toBe(100);

    expect(hasteTrailPuff(ANIM.LEGS_RUN, first.trailTime, 50, at)).toEqual({
      puff: null,
      trailTime: 100
    });
    const second = hasteTrailPuff(ANIM.LEGS_RUN, first.trailTime, 100, at);
    expect(second.puff).toEqual(vec3(10, 20, 14));
    expect(second.trailTime).toBe(200);
    expect(hasteTrailPuff(ANIM.LEGS_RUN, second.trailTime, 150, at).puff).toBeNull();
  });

  it('catches a mark that fell behind the clock up to it, and no further', () => {
    // A stalled frame: the mark 200 is passed at 1000, and is snapped to the clock rather than
    // left a hundred behind — so the *next* frame passes it again before settling.
    const late = hasteTrailPuff(ANIM.LEGS_BACK, 200, 1000, at);
    expect(late.puff).toEqual(vec3(10, 20, 14));
    expect(late.trailTime).toBe(1000);
    const burst = hasteTrailPuff(ANIM.LEGS_BACK, late.trailTime, 1008, at);
    expect(burst.puff).not.toBeNull();
    expect(burst.trailTime).toBe(1100);
    expect(hasteTrailPuff(ANIM.LEGS_BACK, burst.trailTime, 1016, at).puff).toBeNull();
  });

  it('lays none for a player who is not running', () => {
    expect(hasteTrailPuff(ANIM.LEGS_IDLE, 0, 1000, at)).toEqual({ puff: null, trailTime: 0 });
    expect(hasteTrailPuff(ANIM.LEGS_WALK, 0, 1000, at).puff).toBeNull();
    expect(hasteTrailPuff(ANIM.LEGS_TURN, 0, 1000, at).puff).toBeNull();
  });

  it('reads the animation number with its toggle bit off', () => {
    const toggled = ANIM.LEGS_RUN | 0x80;
    expect(hasteTrailPuff(toggled, 0, 0, at).puff).not.toBeNull();
  });

  it('waits its hundred milliseconds before the first puff', () => {
    expect(HASTE_TRAIL_STEP_MS).toBe(100);
    expect(hasteTrailPuff(ANIM.LEGS_RUN, 1100, 1050, at).puff).toBeNull();
  });
});
