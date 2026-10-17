import { describe, expect, it } from 'vitest';

import { FOOTSTEP_SETS, PLAYER_SOUNDS } from '../formats/asset-manifest';
import type { PlayerState } from '../net/protocol';
import { ANIM, ANIM_TOGGLEBIT } from '../sim/animations';
import { CONTENTS, STAT } from '../sim/constants';
import { EV, addPredictableEvent, type Event } from '../sim/events';
import { createArmedPlayerState, type PointContentsFn } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { JUMP_PAD_SOUND } from './jump-pad-events';
import {
  GIB_SOUND,
  GURP1_SOUND,
  GURP2_SOUND,
  LAND_SOUND,
  WATER_IN_SOUND,
  WATER_OUT_SOUND,
  WATER_UNDER_SOUND,
  checkPlayerstateEvents,
  createPlayerEvents,
  customSoundName,
  customSoundPath,
  painEvent,
  painSound,
  transitionPlayerEvents,
  waterLevel,
  type PlayerEvents
} from './player-events';

/** A player at `health`, as a tick leaves them. */
function player(health: number, overrides: Partial<PlayerState> = {}): PlayerState {
  const state = createArmedPlayerState(overrides);
  state.stats[STAT.HEALTH] = health;
  return state;
}

/** The client's memory of a player it last saw at `health`. */
function watching(health: number): PlayerEvents {
  return createPlayerEvents(player(health));
}

/** `EV_*` numbers as a list of events, which is what the ring reads out as. */
const raised = (...events: number[]): Event[] => events.map((event) => ({ event, parm: 0 }));

describe('customSoundName', () => {
  it("reads a `*` name as one of the model's own, by the whole of it", () => {
    expect(customSoundName('*drown.wav')).toBe('drown');
    expect(customSoundName('*gasp.wav')).toBe('gasp');
    expect(customSoundName('*drown')).toBeNull();
    expect(customSoundName('*wade.wav')).toBeNull();
    expect(customSoundName('sound/player/sarge/drown.wav')).toBeNull();
  });
});

describe('painSound', () => {
  it('picks by the health left, in bands of 25', () => {
    expect([24, 25, 49, 50, 74, 75, 125].map(painSound)).toEqual([
      'pain25_1',
      'pain50_1',
      'pain50_1',
      'pain75_1',
      'pain75_1',
      'pain100_1',
      'pain100_1'
    ]);
  });
});

/** `contents` below `top`, and nothing above, recording each pass entity asked with. */
function liquid(top: number, contents: number = CONTENTS.WATER, asked: number[] = []) {
  const pool: PointContentsFn = (point, pass) => {
    asked.push(pass);
    return point.z < top ? contents : 0;
  };
  return pool;
}

describe('waterLevel', () => {
  // A body at z = 24 samples standing at 1, 25 and 50, and crouched at 1, 18 and 36.
  const at = vec3(10, 20, 24);

  it('reads feet, waist and eyes standing, each only if the one below is wet', () => {
    expect([1, 2, 26, 51].map((top) => waterLevel(at, ANIM.LEGS_IDLE, liquid(top)))).toEqual([
      0, 1, 2, 3
    ]);
    // Water around the eyes alone is nothing: the feet are asked first.
    const band: PointContentsFn = (point) => (point.z > 40 ? CONTENTS.WATER : 0);
    expect(waterLevel(at, ANIM.LEGS_IDLE, band)).toBe(0);
  });

  it('reads the crouched heights when the legs crouch, toggled or not', () => {
    for (const legs of [ANIM.LEGS_IDLECR, ANIM.LEGS_WALKCR | ANIM_TOGGLEBIT]) {
      expect([19, 37].map((top) => waterLevel(at, legs, liquid(top)))).toEqual([2, 3]);
    }
    // Any other legs stand, whatever the body is doing: a death, a swim, a jump.
    for (const legs of [ANIM.BOTH_DEATH1, ANIM.LEGS_SWIM, ANIM.LEGS_JUMP | ANIM_TOGGLEBIT]) {
      expect(waterLevel(at, legs, liquid(37))).toBe(2);
    }
  });

  it('counts lava and slime as water and nothing else, asking at the body passing nobody', () => {
    const asked: number[] = [];
    for (const liquidContents of [CONTENTS.LAVA, CONTENTS.SLIME, CONTENTS.WATER | CONTENTS.FOG]) {
      expect(waterLevel(at, ANIM.LEGS_IDLE, liquid(51, liquidContents, asked))).toBe(3);
    }
    for (const dry of [CONTENTS.FOG, CONTENTS.SOLID, CONTENTS.NODROP, CONTENTS.PLAYERCLIP]) {
      expect(waterLevel(at, ANIM.LEGS_IDLE, liquid(51, dry))).toBe(0);
    }
    expect(new Set(asked)).toEqual(new Set([-1]));
    const points: number[][] = [];
    waterLevel(at, ANIM.LEGS_IDLE, (point) => {
      points.push([point.x, point.y, point.z]);
      return CONTENTS.WATER;
    });
    expect(points).toEqual([
      [10, 20, 1],
      [10, 20, 25],
      [10, 20, 50]
    ]);
  });
});

describe('painEvent', () => {
  it('gurgles by rand()&1 in place of the grunt with the head under, and twitches alike', () => {
    const pain = { painTime: Number.NEGATIVE_INFINITY, painDirection: 0 };
    expect(painEvent(pain, 60, 1000, () => 3, () => 0.75)).toEqual({
      type: 'shared',
      path: GURP1_SOUND
    });
    expect(pain).toEqual({ painTime: 1000, painDirection: 1 });
    expect(painEvent(pain, 60, 1500, () => 3, () => 0.25)).toEqual({
      type: 'shared',
      path: GURP2_SOUND
    });
    expect(painEvent(pain, 60, 2000, () => 2, () => 0.75)).toEqual({
      type: 'custom',
      name: 'pain75_1'
    });
    expect([GURP1_SOUND, GURP2_SOUND]).toEqual([1, 2].map((n) => `sound/player/gurp${n}.wav`));
    for (const path of [GURP1_SOUND, GURP2_SOUND]) expect(PLAYER_SOUNDS).toContain(path);
  });

  it('asks neither the water nor rand() within the half second it is silent', () => {
    const pain = { painTime: 1000, painDirection: 0 };
    const ask = () => {
      throw new Error('asked');
    };
    expect(painEvent(pain, 60, 1499, ask, ask)).toBeNull();
    // And rand() not for a grunt.
    expect(painEvent(pain, 60, 1500, () => 2, ask)).toEqual({ type: 'custom', name: 'pain75_1' });
  });
});

describe('customSoundPath', () => {
  it("takes the model's own, and sarge's where it has none", () => {
    const has = (path: string) => path === 'sound/player/xaero/jump1.wav';
    expect(customSoundPath('xaero', 'jump1', has)).toBe('sound/player/xaero/jump1.wav');
    expect(customSoundPath('xaero', 'taunt', has)).toBe('sound/player/sarge/taunt.wav');
  });
});

describe('transitionPlayerEvents: movement', () => {
  it('plays a jump, a footstep from the set and a short landing', () => {
    const out = transitionPlayerEvents(
      watching(125),
      player(125),
      raised(EV.JUMP, EV.FOOTSTEP, EV.FALL_SHORT),
      1000,
      1000,
      () => 0.6
    );
    expect(out.sounds).toEqual([
      { type: 'custom', name: 'jump1' },
      { type: 'footstep', variant: 3 },
      { type: 'shared', path: LAND_SOUND }
    ]);
  });

  it("grunts at a medium fall, then plays the pain its 5 damage leaves", () => {
    const out = transitionPlayerEvents(
      watching(60),
      player(55),
      raised(EV.FALL_MEDIUM),
      1000
    );
    expect(out.sounds).toEqual([
      { type: 'custom', name: 'pain100_1' },
      { type: 'custom', name: 'pain75_1' }
    ]);
  });

  it("plays a far fall's own sound, which holds off the pain its damage would play", () => {
    const events = watching(125);
    const out = transitionPlayerEvents(
      events,
      player(115),
      raised(EV.FALL_FAR),
      1000
    );
    expect(out.sounds).toEqual([{ type: 'custom', name: 'fall1' }]);
    expect(events.painTime).toBe(1000);
  });

  it("plays a metal floor's clanks and the water's splashes, whatever the model's set", () => {
    const out = transitionPlayerEvents(
      watching(125),
      player(125),
      raised(EV.FOOTSTEP_METAL, EV.FOOTSPLASH, EV.FOOTWADE, EV.SWIM),
      1000,
      1000,
      () => 0.3
    );
    expect(out.sounds).toEqual([
      { type: 'footstep', variant: 2, set: 'metal' },
      { type: 'footstep', variant: 2, set: 'splash' },
      { type: 'footstep', variant: 2, set: 'splash' },
      { type: 'footstep', variant: 2, set: 'splash' }
    ]);
    // Clanks and splashes, four of each, among the sounds no model owns.
    expect([FOOTSTEP_SETS.metal, FOOTSTEP_SETS.splash]).toEqual(['clank', 'splash']);
    for (const i of [1, 2, 3, 4]) {
      expect(PLAYER_SOUNDS).toContain(`sound/player/footsteps/clank${i}.wav`);
      expect(PLAYER_SOUNDS).toContain(`sound/player/footsteps/splash${i}.wav`);
    }
  });

  it('picks each of the four by rand()&3, one draw an event', () => {
    const draws = [0, 0.25, 0.5, 0.99];
    const out = transitionPlayerEvents(
      watching(125),
      player(125),
      raised(EV.FOOTSTEP_METAL, EV.SWIM, EV.FOOTSTEP, EV.FOOTSPLASH),
      1000,
      1000,
      () => draws.shift()!
    );
    expect(out.sounds).toEqual([
      { type: 'footstep', variant: 1, set: 'metal' },
      { type: 'footstep', variant: 2, set: 'splash' },
      { type: 'footstep', variant: 3 },
      { type: 'footstep', variant: 4, set: 'splash' }
    ]);
  });

  it("plays the water's three as they are, and the gasp in the model's own voice", () => {
    const out = transitionPlayerEvents(
      watching(125),
      player(125),
      raised(EV.WATER_TOUCH, EV.WATER_UNDER, EV.WATER_CLEAR, EV.WATER_LEAVE),
      1000
    );
    expect(out.sounds).toEqual([
      { type: 'shared', path: WATER_IN_SOUND },
      { type: 'shared', path: WATER_UNDER_SOUND },
      { type: 'custom', name: 'gasp' },
      { type: 'shared', path: WATER_OUT_SOUND }
    ]);
    const water = ['watr_in', 'watr_un', 'watr_out'].map((name) => `sound/player/${name}.wav`);
    expect([WATER_IN_SOUND, WATER_UNDER_SOUND, WATER_OUT_SOUND]).toEqual(water);
    for (const path of water) expect(PLAYER_SOUNDS).toContain(path);
  });
});

describe('transitionPlayerEvents: hurts', () => {
  it('plays a pain sound for a hurt, at most two a second, flipping the twitch each time', () => {
    const events = watching(125);
    expect(transitionPlayerEvents(events, player(100), [], 1000).sounds).toEqual([
      { type: 'custom', name: 'pain100_1' }
    ]);
    expect(events).toMatchObject({ painTime: 1000, painDirection: 1 });

    expect(transitionPlayerEvents(events, player(80), [], 1499).sounds).toEqual([]);
    expect(transitionPlayerEvents(events, player(60), [], 1500).sounds).toEqual([
      { type: 'custom', name: 'pain75_1' }
    ]);
    expect(events).toMatchObject({ painTime: 1500, painDirection: 0 });
  });

  it('is silent for a hurt of one point', () => {
    expect(transitionPlayerEvents(watching(125), player(124), [], 0).sounds).toEqual([]);
  });

  it('plays the death, and no pain, for the hurt that kills', () => {
    const out = transitionPlayerEvents(
      watching(30),
      player(-20),
      raised(EV.DEATH2),
      0
    );
    expect(out.sounds).toEqual([{ type: 'custom', name: 'death2' }]);
  });

  it('gurgles a hurt and drowns a death where the state stands with its head under', () => {
    // Water to 51 over a player standing at 24: their eyes, at 50, are under.
    const at = (health: number, overrides: Partial<PlayerState> = {}) =>
      player(health, { origin: vec3(0, 0, 24), legsAnim: ANIM.LEGS_IDLE, ...overrides });
    const hurt = (pool: PointContentsFn, legsAnim: number = ANIM.LEGS_IDLE) =>
      transitionPlayerEvents(watching(100), at(90, { legsAnim }), [], 1000, 1000, () => 0.75, pool)
        .sounds;
    expect(hurt(liquid(51))).toEqual([{ type: 'shared', path: GURP1_SOUND }]);
    expect(hurt(liquid(50))).toEqual([{ type: 'custom', name: 'pain100_1' }]);
    // Crouched, by the legs, the eyes are at 36.
    expect(hurt(liquid(37), ANIM.LEGS_IDLECR)).toEqual([{ type: 'shared', path: GURP1_SOUND }]);

    const died = (state: PlayerState) =>
      transitionPlayerEvents(watching(30), state, raised(EV.DEATH3), 0, 0, () => 0, liquid(51))
        .sounds;
    expect(died(at(-10, { legsAnim: ANIM.BOTH_DEATH3 }))).toEqual([
      { type: 'custom', name: 'drown' }
    ]);
    // Read where the state is, so a body a unit higher has its eyes out.
    expect(died(at(-10, { legsAnim: ANIM.BOTH_DEATH3, origin: vec3(0, 0, 25) }))).toEqual([
      { type: 'custom', name: 'death3' }
    ]);
  });

  it('throws the gibs, and plays their splat', () => {
    const out = transitionPlayerEvents(watching(10), player(-40), raised(EV.GIB_PLAYER), 0);
    expect(out).toEqual({
      sounds: [{ type: 'shared', path: GIB_SOUND }],
      gibbed: true,
      puffs: []
    });
  });

  it('plays the pad and the player, and throws the puff where the player is', () => {
    // `CG_EntityEvent`'s `EV_JUMP_PAD` (`cg_event.c:655–674`): the pad's boing, the player's own
    // jump sound, and a smoke puff at the player.
    const state = player(100, { origin: vec3(10, 20, 30) });
    const out = transitionPlayerEvents(watching(100), state, raised(EV.JUMP_PAD), 1000);

    expect(out.sounds).toEqual([
      { type: 'shared', path: JUMP_PAD_SOUND },
      { type: 'custom', name: 'jump1' }
    ]);
    expect(out.puffs).toEqual([vec3(10, 20, 30)]);
  });

  it("ignores the player's own EV_PAIN: their pain is heard in their health", () => {
    const out = transitionPlayerEvents(
      watching(100),
      player(100),
      [{ event: EV.PAIN, parm: 100 }],
      0
    );
    expect(out.sounds).toEqual([]);
  });
});

describe('transitionPlayerEvents: damage feedback', () => {
  it("kicks the view when damageEvent moves with a count, once for each", () => {
    const events = watching(125);
    const hurt = player(100, { damageEvent: 1, damageCount: 25, damageYaw: 255, damagePitch: 255 });
    transitionPlayerEvents(events, hurt, [], 1000);
    // 25 × 40/100.
    expect(events.damage).toMatchObject({ time: 1000, value: 10, pitch: -10 });

    transitionPlayerEvents(events, hurt, [], 1200);
    expect(events.damage.time).toBe(1000);
  });

  it('does nothing for a moved damageEvent with no count', () => {
    const events = watching(125);
    transitionPlayerEvents(events, player(125, { damageEvent: 1, damageCount: 0 }), [], 1000);
    expect(events.damage.time).toBe(Number.NEGATIVE_INFINITY);
  });

  it('hears no hurt in a respawn', () => {
    const events = createPlayerEvents(player(-20, { damageEvent: 3 }));
    const out = transitionPlayerEvents(events, player(125), [], 5000);
    expect(out.sounds).toEqual([]);
    expect(events.damage.time).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('checkPlayerstateEvents', () => {
  it('reports what the ring gained since the state before it, oldest first', () => {
    const ps = player(125);
    const ops = { eventSequence: ps.eventSequence, externalEvent: ps.externalEvent };
    addPredictableEvent(ps, EV.JUMP);
    addPredictableEvent(ps, EV.FOOTSTEP);

    expect(checkPlayerstateEvents(ps, ops)).toEqual([
      { event: EV.JUMP, parm: 0 },
      { event: EV.FOOTSTEP, parm: 0 }
    ]);
  });

  it('reports nothing when neither the sequence nor the external event has moved', () => {
    const ps = player(125);
    addPredictableEvent(ps, EV.JUMP);
    const ops = { eventSequence: ps.eventSequence, externalEvent: ps.externalEvent };

    expect(checkPlayerstateEvents(ps, ops)).toEqual([]);
  });

  it('keeps only the last two of a tick that raised three', () => {
    // `MAX_PS_EVENTS` is 2, so the third overwrites the first where it lies, and the reader
    // clamps to what is still there rather than reading the newer event twice.
    const ps = player(125);
    const ops = { eventSequence: ps.eventSequence, externalEvent: ps.externalEvent };
    addPredictableEvent(ps, EV.JUMP);
    addPredictableEvent(ps, EV.FOOTSTEP);
    addPredictableEvent(ps, EV.TAUNT);

    expect(checkPlayerstateEvents(ps, ops).map(({ event }) => event)).toEqual([
      EV.FOOTSTEP,
      EV.TAUNT
    ]);
  });

  it('puts the external event first, and plays it only once', () => {
    // `G_AddEvent`'s counter is what makes a second identical event readable as a second one;
    // without a change the client has nothing to notice, which is why the event stays put for
    // 300 ms and is played on the tick it arrives.
    const ps = player(125);
    ps.externalEvent = EV.PAIN;
    ps.externalEventParm = 70;
    const ops = { eventSequence: ps.eventSequence, externalEvent: 0 };
    addPredictableEvent(ps, EV.FOOTSTEP);

    expect(checkPlayerstateEvents(ps, ops)).toEqual([
      { event: EV.PAIN, parm: 70 },
      { event: EV.FOOTSTEP, parm: 0 }
    ]);
    expect(checkPlayerstateEvents(ps, { eventSequence: ps.eventSequence, externalEvent: EV.PAIN }))
      .toEqual([]);
  });
});
