import { describe, expect, it } from 'vitest';

import { createEntityState, MAX_CLIENTS, type EntityState } from '../net/protocol';
import { ANIM, ANIM_TOGGLEBIT } from '../sim/animations';
import { CONTENTS, EF_FIRING } from '../sim/constants';
import { EV } from '../sim/events';
import { ET } from '../sim/game-entity';
import { HI, PW } from '../sim/items';
import type { PointContentsFn } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import type { EntityEvent } from './entity-events';
import { MEDKIT_SOUND, USE_NOTHING_SOUND } from './item-sounds';
import { JUMP_PAD_SOUND } from './jump-pad-events';
import {
  SELECT_SOUND,
  addPlayerWeapons,
  createEntityMemory,
  otherPlayerEvents,
  type EntityMemory
} from './other-player-events';
import {
  GIB_SOUND,
  GURP1_SOUND,
  GURP2_SOUND,
  LAND_SOUND,
  PAIN_SOUND_DEBOUNCE,
  WATER_IN_SOUND
} from './player-events';
import { PROTECT_SOUND, QUAD_SOUND, REGEN_SOUND } from './powerup-sounds';

/**
 * `CG_EntityEvent` for everyone but the player: what another player's events, and a corpse's,
 * sound like and leave on their slots.
 */

/** The player this client is. */
const OWN = 0;

/** An event on a player's own entity, in slot and client `number`. */
function on(number: number, event: number, fields: Partial<EntityState> = {}): EntityEvent {
  const state = Object.assign(createEntityState(number), { eType: ET.PLAYER, clientNum: number });
  Object.assign(state, fields);
  const origin = vec3(number * 10, 0, 24);
  return { state, number, event, parm: 0, origin, soundOrigin: origin };
}

/**
 * A player's event sent on its own: in a slot of its own, heard from the player
 * (`EF_PLAYER_EVENT`).
 */
function sentAlone(slot: number, player: number, event: number, weapon = 0): EntityEvent {
  const state = Object.assign(createEntityState(slot), {
    eType: ET.EVENTS + event,
    clientNum: player,
    otherEntityNum: player,
    weapon
  });
  const origin = vec3(player * 10, 0, 24);
  return { state, number: player, event, parm: 0, origin, soundOrigin: origin };
}

/** Play some events at a time, with the footstep's roll at the bottom of its range. */
function play(memory: EntityMemory, events: EntityEvent[], time = 1000) {
  return otherPlayerEvents(memory, events, OWN, time, () => 0);
}

describe('otherPlayerEvents', () => {
  it("plays a match's `*` sound in its event entity's voice, which is client 0's", () => {
    // A speaker naming a model's sound: an entity past the clients, so `CG_CustomSound` reads
    // client 0's model (`cg_event.c:1020–1027`, `cg_players.c:57–59`).
    const number = MAX_CLIENTS + 9;
    // Not the voice: `CG_CustomSound` is handed `es->number`, whatever else the entity carries.
    const state = Object.assign(createEntityState(number), {
      eType: ET.EVENTS + EV.GENERAL_SOUND,
      clientNum: 5
    });
    const sound = (parm: number): EntityEvent => ({
      state,
      number,
      event: EV.GENERAL_SOUND,
      parm,
      origin: vec3(5, 6, 7),
      soundOrigin: vec3(5, 6, 7)
    });
    const names = ['', '*drown.wav', 'sound/player/gurp1.wav', '*nothing.wav'];
    const { sounds } = otherPlayerEvents(
      createEntityMemory(),
      [sound(1), sound(2), sound(3)],
      OWN,
      1000,
      () => 0,
      (index) => names[index]
    );

    // A file's name is the world's sound, `entity-events.ts`', and an unknown `*` name is none.
    expect(sounds).toEqual([
      { number, origin: vec3(5, 6, 7), voice: 0, sound: { type: 'custom', name: 'drown' } }
    ]);
  });

  it("throws the jump pad's puff and plays it from whoever hit it", () => {
    // `EV_JUMP_PAD` on a player: the pad's sound and their own jump, both from them, and the
    // puff `CG_SmokePuff` adds at them (`cg_event.c:655–674`).
    const memory = createEntityMemory();
    const { sounds, puffs } = play(memory, [on(2, EV.JUMP_PAD)]);

    const from = { number: 2, origin: vec3(20, 0, 24), voice: 2 };
    expect(sounds).toEqual([
      { ...from, sound: { type: 'shared', path: JUMP_PAD_SOUND } },
      { ...from, sound: { type: 'custom', name: 'jump1' } }
    ]);
    expect(puffs).toEqual([vec3(20, 0, 24)]);
  });

  it("voices a pad's jump sound by the event's number, as CG_CustomSound takes it", () => {
    // A corpse's slot is past the clients, so `CG_CustomSound` falls back to slot 0's sounds.
    const memory = createEntityMemory();
    const { sounds } = play(memory, [on(MAX_CLIENTS + 4, EV.JUMP_PAD, { clientNum: 5 })]);

    expect(sounds.map(({ voice, sound }) => ({ voice, type: sound.type }))).toEqual([
      { voice: 5, type: 'shared' },
      { voice: 0, type: 'custom' }
    ]);
  });

  it("plays another player's body in their own sounds, from them", () => {
    const memory = createEntityMemory();
    const { sounds } = play(memory, [
      on(2, EV.JUMP),
      on(2, EV.TAUNT),
      on(2, EV.DEATH2),
      on(2, EV.FALL_MEDIUM),
      on(2, EV.FALL_SHORT)
    ]);
    const from = { number: 2, origin: vec3(20, 0, 24), voice: 2 };
    expect(sounds).toEqual([
      { ...from, sound: { type: 'custom', name: 'jump1' } },
      { ...from, sound: { type: 'custom', name: 'taunt' } },
      { ...from, sound: { type: 'custom', name: 'death2' } },
      { ...from, sound: { type: 'custom', name: 'pain100_1' } },
      { ...from, sound: { type: 'shared', path: LAND_SOUND } }
    ]);
  });

  it("walks in the footsteps of the client the entity names, and speaks as its number's", () => {
    // `ci` is `es->clientNum`'s for a footstep, and `CG_CustomSound` takes `es->number`, which for
    // anything past the clients is slot 0's.
    const memory = createEntityMemory();
    const { sounds } = play(memory, [
      on(2, EV.FOOTSTEP, { clientNum: 5 }),
      on(MAX_CLIENTS + 4, EV.JUMP, { clientNum: 5 })
    ]);
    expect(sounds.map(({ voice, sound }) => ({ voice, type: sound.type }))).toEqual([
      { voice: 5, type: 'footstep' },
      { voice: 0, type: 'custom' }
    ]);
    expect(sounds[0].sound).toEqual({ type: 'footstep', variant: 1 });
  });

  it("splashes and gasps from them, the gasp in their number's voice", () => {
    // `*gasp.wav` is `CG_CustomSound( es->number )`'s; the water's own three are everyone's.
    const memory = createEntityMemory();
    const { sounds } = play(memory, [
      on(2, EV.WATER_TOUCH, { clientNum: 5 }),
      on(2, EV.SWIM, { clientNum: 5 }),
      on(2, EV.FOOTSTEP_METAL, { clientNum: 5 }),
      on(2, EV.WATER_CLEAR, { clientNum: 5 }),
      on(MAX_CLIENTS + 4, EV.WATER_CLEAR, { clientNum: 5 })
    ]);
    expect(sounds.map(({ number, voice, sound }) => ({ number, voice, sound }))).toEqual([
      { number: 2, voice: 5, sound: { type: 'shared', path: WATER_IN_SOUND } },
      { number: 2, voice: 5, sound: { type: 'footstep', variant: 1, set: 'splash' } },
      { number: 2, voice: 5, sound: { type: 'footstep', variant: 1, set: 'metal' } },
      { number: 2, voice: 2, sound: { type: 'custom', name: 'gasp' } },
      { number: MAX_CLIENTS + 4, voice: 0, sound: { type: 'custom', name: 'gasp' } }
    ]);
  });

  it("grunts at another player's hurt, twice a second at most, twitching each way in turn", () => {
    const memory = createEntityMemory();
    const pain = (health: number, time: number) =>
      play(memory, [{ ...on(2, EV.PAIN), parm: health }], time).sounds;

    expect(pain(60, 1000)).toEqual([
      { number: 2, origin: vec3(20, 0, 24), voice: 2, sound: { type: 'custom', name: 'pain75_1' } }
    ]);
    expect(memory.pain[2]).toEqual({ painTime: 1000, painDirection: 1 });

    expect(pain(40, 1000 + PAIN_SOUND_DEBOUNCE - 8)).toEqual([]);
    expect(pain(20, 1000 + PAIN_SOUND_DEBOUNCE)).toEqual([
      expect.objectContaining({ sound: { type: 'custom', name: 'pain25_1' } })
    ]);
    expect(memory.pain[2]).toEqual({ painTime: 1000 + PAIN_SOUND_DEBOUNCE, painDirection: 0 });
  });

  it("gurgles a hurt and drowns a death with the head under, as the body's legs stand", () => {
    const asked: number[] = [];
    /** Water below `top`; a body at 24 has its eyes at 50 standing and 36 crouched. */
    const pool =
      (top: number): PointContentsFn =>
      (point, pass) => {
        asked.push(pass);
        return point.z < top ? CONTENTS.WATER : 0;
      };
    const hear = (events: EntityEvent[], top: number, random = 0) =>
      otherPlayerEvents(createEntityMemory(), events, OWN, 1000, () => random, () => '', pool(top))
        .sounds.map(({ number, voice, sound }) => ({ number, voice, sound }));
    const hurt = (fields: Partial<EntityState> = {}) => ({ ...on(2, EV.PAIN, fields), parm: 60 });
    const gurgle = (path: string) => ({ number: 2, voice: 2, sound: { type: 'shared', path } });
    const drown = { number: 3, voice: 3, sound: { type: 'custom', name: 'drown' } };

    expect(hear([hurt(), on(3, EV.DEATH1)], 51)).toEqual([gurgle(GURP2_SOUND), drown]);
    expect(hear([hurt()], 51, 0.75)).toEqual([gurgle(GURP1_SOUND)]);
    expect(hear([hurt(), on(3, EV.DEATH1)], 50).map(({ sound }) => sound)).toEqual([
      { type: 'custom', name: 'pain75_1' },
      { type: 'custom', name: 'death1' }
    ]);

    const crouched = { legsAnim: ANIM.LEGS_IDLECR | ANIM_TOGGLEBIT };
    expect(hear([hurt(crouched), on(3, EV.DEATH1, { legsAnim: ANIM.LEGS_WALKCR })], 37)).toEqual([
      gurgle(GURP2_SOUND),
      drown
    ]);
    expect(new Set(asked)).toEqual(new Set([-1]));

    // Nothing else a body does asks.
    asked.length = 0;
    hear([on(2, EV.FOOTSTEP), on(2, EV.JUMP), on(2, EV.WATER_UNDER)], 51);
    expect(asked).toEqual([]);
  });

  it("keeps a hurt's twitch on the slot it came in, and grunts in its number's voice", () => {
    // `CG_PainEvent( cent, ... )`, and `CG_CustomSound( es->number, ... )`, which for anything past
    // the clients is slot 0's.
    const memory = createEntityMemory();
    const alone = { ...sentAlone(70, 2, EV.PAIN), parm: 90 };
    const corpse = { ...on(MAX_CLIENTS + 4, EV.PAIN, { clientNum: 5 }), parm: 90 };
    const { sounds } = play(memory, [alone, corpse]);

    expect(sounds.map(({ number, voice }) => ({ number, voice }))).toEqual([
      { number: 2, voice: 2 },
      { number: MAX_CLIENTS + 4, voice: 0 }
    ]);
    expect(memory.pain[70].painTime).toBe(1000);
    expect(memory.pain[2].painTime).toBe(Number.NEGATIVE_INFINITY);
  });

  it("holds another player's pain off right after their far fall's grunt", () => {
    const memory = createEntityMemory();
    const { sounds } = play(memory, [on(2, EV.FALL_FAR), { ...on(2, EV.PAIN), parm: 90 }]);
    expect(sounds.map(({ sound }) => sound)).toEqual([{ type: 'custom', name: 'fall1' }]);
  });

  it("leaves the player's own pain to their health", () => {
    // `cg_event.c:1158–1165`: never on the player this client predicts.
    const memory = createEntityMemory();
    expect(play(memory, [{ ...on(OWN, EV.PAIN), parm: 50 }]).sounds).toEqual([]);
    expect(memory.pain[OWN].painTime).toBe(Number.NEGATIVE_INFINITY);
  });

  it('clicks at a weapon change, from whoever made it', () => {
    const memory = createEntityMemory();
    expect(play(memory, [on(2, EV.CHANGE_WEAPON)]).sounds).toEqual([
      {
        number: 2,
        origin: vec3(20, 0, 24),
        voice: 2,
        sound: { type: 'shared', path: SELECT_SOUND }
      }
    ]);
  });

  it('goes to pieces where the entity is, with the splat from there', () => {
    const memory = createEntityMemory();
    const body = on(MAX_CLIENTS + 1, EV.GIB_PLAYER, { clientNum: 2 });
    const { sounds, gibs } = play(memory, [body]);
    expect(sounds).toEqual([
      {
        number: MAX_CLIENTS + 1,
        origin: body.origin,
        voice: 2,
        sound: { type: 'shared', path: GIB_SOUND }
      }
    ]);
    expect(gibs).toEqual([body.origin]);
  });

  it('plays nothing for an event no body makes a sound for', () => {
    const memory = createEntityMemory();
    expect(play(memory, [on(2, EV.STEP_8), on(3, EV.STEP), on(70, EV.MISSILE_MISS)])).toEqual({
      sounds: [],
      gibs: [],
      puffs: []
    });
  });
});

describe("another player's shot", () => {
  it('flashes their gun and sounds the weapon, from them', () => {
    const memory = createEntityMemory();
    const { sounds } = play(memory, [on(2, EV.FIRE_WEAPON, { weapon: WP.MACHINEGUN })], 1000);
    expect(sounds).toEqual([
      {
        number: 2,
        origin: vec3(20, 0, 24),
        voice: 2,
        sound: { type: 'fire', weapon: WP.MACHINEGUN }
      }
    ]);
    expect(memory.muzzleFlashTime[2]).toBe(1000);
    expect(memory.railFireTime[2]).toBe(Number.NEGATIVE_INFINITY);
  });

  it("dims the railgun's glow from the shot", () => {
    const memory = createEntityMemory();
    play(memory, [on(2, EV.FIRE_WEAPON, { weapon: WP.RAILGUN })], 1000);
    expect(memory.railFireTime[2]).toBe(1000);
  });

  it('is silent with nothing in hand', () => {
    const memory = createEntityMemory();
    expect(play(memory, [on(2, EV.FIRE_WEAPON, { weapon: WP.NONE })]).sounds).toEqual([]);
    expect(memory.muzzleFlashTime[2]).toBe(Number.NEGATIVE_INFINITY);
  });

  it('sounds the lightning gun on the first shot of a burst only, and flashes on every one', () => {
    const memory = createEntityMemory();
    const firing = on(2, EV.FIRE_WEAPON, { weapon: WP.LIGHTNING, eFlags: EF_FIRING });
    expect(play(memory, [firing], 1000).sounds).toHaveLength(1);

    // Drawn with its firing loop on, as `CG_AddPlayerWeapon` draws it after the events.
    addPlayerWeapons(memory, [firing.state]);
    expect(play(memory, [firing], 1050).sounds).toEqual([]);
    expect(memory.muzzleFlashTime[2]).toBe(1050);
  });

  it("flashes the slot a shot sent on its own came in, and not the player's gun", () => {
    // Q3 keeps what an event leaves on the `cent` it arrived on, which for a player's second
    // event of a move is the event's own entity: heard from the player, drawn on nobody.
    const memory = createEntityMemory();
    const { sounds } = play(memory, [sentAlone(70, 2, EV.FIRE_WEAPON, WP.RAILGUN)], 1000);
    expect(sounds).toEqual([
      expect.objectContaining({ number: 2, voice: 2, sound: { type: 'fire', weapon: WP.RAILGUN } })
    ]);
    expect(memory.muzzleFlashTime[2]).toBe(Number.NEGATIVE_INFINITY);
    expect(memory.railFireTime[2]).toBe(Number.NEGATIVE_INFINITY);
    expect(memory.muzzleFlashTime[70]).toBe(1000);
  });
});

describe('addPlayerWeapons', () => {
  it("keeps each player's firing loop, for the gauntlet and the lightning gun", () => {
    const memory = createEntityMemory();
    const holding = (number: number, weapon: number, eFlags = EF_FIRING) =>
      Object.assign(createEntityState(number), { weapon, eFlags });
    addPlayerWeapons(memory, [
      holding(1, WP.LIGHTNING),
      holding(2, WP.GAUNTLET),
      holding(3, WP.RAILGUN),
      holding(4, WP.LIGHTNING, 0)
    ]);
    expect(memory.lightningFiring.slice(1, 5)).toEqual([true, true, false, false]);
  });

  it('leaves a player with nothing in hand as it was, since no gun of theirs is drawn', () => {
    const memory = createEntityMemory();
    memory.lightningFiring[1] = true;
    addPlayerWeapons(memory, [createEntityState(1)]);
    expect(memory.lightningFiring[1]).toBe(true);
  });
});

describe("another player's powerups", () => {
  /** The sound an event on the player in slot 2 played, without the entity it came from. */
  const soundOf = (memory: EntityMemory, events: EntityEvent[], time = 1000) =>
    play(memory, events, time).sounds.map(({ sound }) => sound);

  it('plays the suit sound when the suit took the hit', () => {
    expect(play(createEntityMemory(), [on(2, EV.POWERUP_BATTLESUIT)]).sounds).toEqual([
      {
        number: 2,
        origin: vec3(20, 0, 24),
        voice: 2,
        sound: { type: 'shared', path: PROTECT_SOUND }
      }
    ]);
  });

  it('plays the regen sound on each heal', () => {
    expect(soundOf(createEntityMemory(), [on(2, EV.POWERUP_REGEN)])).toEqual([
      { type: 'shared', path: REGEN_SOUND }
    ]);
  });

  it('plays the quad sound on the gauntlet punch that landed', () => {
    expect(soundOf(createEntityMemory(), [on(2, EV.POWERUP_QUAD)])).toEqual([
      { type: 'shared', path: QUAD_SOUND }
    ]);
  });

  it('plays the quad sound before the shot of a player holding one', () => {
    const quad = on(2, EV.FIRE_WEAPON, {
      weapon: WP.ROCKET_LAUNCHER,
      powerups: 1 << PW.QUAD
    });

    expect(soundOf(createEntityMemory(), [quad])).toEqual([
      { type: 'shared', path: QUAD_SOUND },
      { type: 'fire', weapon: WP.ROCKET_LAUNCHER }
    ]);
  });

  it("leaves a quadded lightning gun's burst to its loop, quad sound and all", () => {
    // `CG_FireWeapon` returns for the lightning gun on every shot after the first, before either
    // sound is reached (`cg_weapons.c:1694–1711`).
    const memory = createEntityMemory();
    const firing = on(2, EV.FIRE_WEAPON, {
      weapon: WP.LIGHTNING,
      powerups: 1 << PW.QUAD,
      eFlags: EF_FIRING
    });
    addPlayerWeapons(memory, [firing.state]);

    expect(soundOf(memory, [firing], 1050)).toEqual([]);
  });

  it('leaves a shot without a quad sounding like the weapon alone', () => {
    expect(soundOf(createEntityMemory(), [on(2, EV.FIRE_WEAPON, { weapon: WP.ROCKET_LAUNCHER })])).toEqual([
      { type: 'fire', weapon: WP.ROCKET_LAUNCHER }
    ]);
  });
});

describe("another player's item use", () => {
  /** The sound an event on the player in slot 2 played, without the entity it came from. */
  const soundOf = (memory: EntityMemory, events: EntityEvent[]) =>
    play(memory, events).sounds.map(({ sound }) => sound);

  it('plays the medkit from whoever used it, and nothing for an empty hand', () => {
    // `CG_UseItem` (`cg_event.c:376–383`), heard from the entity that used it.
    expect(soundOf(createEntityMemory(), [on(2, EV.USE_ITEM0 + HI.MEDKIT)])).toEqual([
      { type: 'shared', path: MEDKIT_SOUND }
    ]);
    expect(soundOf(createEntityMemory(), [on(3, EV.USE_ITEM0)])).toEqual([
      { type: 'shared', path: USE_NOTHING_SOUND }
    ]);
  });

  it('leaves the teleporter to its own two effects', () => {
    expect(soundOf(createEntityMemory(), [on(2, EV.USE_ITEM0 + HI.TELEPORTER)])).toEqual([]);
  });
});
