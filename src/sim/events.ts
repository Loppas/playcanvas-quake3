import type { PlayerState } from '../net/protocol';
import { MAX_PS_EVENTS } from '../net/protocol';

/**
 * `entity_event_t` (`bg_public.h:350–457`): the one channel the simulation talks to a client
 * through, and the numbers it talks in.
 *
 * An event is a single integer, and everything a client plays for somebody else — the footstep,
 * the grunt, the shot, the explosion — arrives as one. That is why it is this small: an entity
 * state carries exactly one event at a time and a player state carries a ring of
 * {@link MAX_PS_EVENTS}, so the cheapest possible encoding is what makes them fit.
 *
 * There are three ways an event reaches a client, and which one a thing uses is a decision about
 * *whose* event it is rather than about what it does:
 *
 * - **The predictable ring**, {@link addPredictableEvent}, for what the move itself did. It is on
 *   the player state, so the client that owns that state can raise the same event from the same
 *   input without waiting to be told — which is what "predictable" means.
 * - **`externalEvent`**, for what happened *to* a player rather than what they did. The move
 *   cannot know about it, so it is not in the ring; it rides on the player state all the same,
 *   because only its owner needs it at full rate.
 * - **`s.event` on an entity**, for everything else, including the event-only entities that exist
 *   for one effect and are freed again.
 *
 * The numbers are Quake 3's exactly, including the Team Arena block that ships inside every
 * build's enum whether or not the code behind it does. Leaving a gap out would renumber
 * everything after it, and the number is what goes on the wire.
 */

/**
 * The two bits at the top of an event field, incremented with every event set on the same
 * carrier (`bg_public.h:344–347`).
 *
 * A client fires an event when the field *changes*, so the same event twice running would look
 * like one. The counter is what makes the second footstep a second footstep. Mask them off with
 * `~EV_EVENT_BITS` to get the event back.
 */
export const EV_EVENT_BIT1 = 0x100;
export const EV_EVENT_BIT2 = 0x200;
export const EV_EVENT_BITS = EV_EVENT_BIT1 | EV_EVENT_BIT2;

/** `entity_event_t` (`bg_public.h:350–457`). */
export const EV = {
  NONE: 0,

  FOOTSTEP: 1,
  FOOTSTEP_METAL: 2,
  FOOTSPLASH: 3,
  FOOTWADE: 4,
  SWIM: 5,

  /**
   * A step up, as one of four heights.
   *
   * Which of the four is the height itself, and the move bands a rise to the *nearest* of them
   * rather than rounding up (`bg_slidemove.c:317–329`): an 18-unit stair reports 16 and a
   * 12.8-unit one reports 12. The view can only glide by what it is told, so the small residual
   * is part of the original feel.
   */
  STEP_4: 6,
  STEP_8: 7,
  STEP_12: 8,
  STEP_16: 9,

  FALL_SHORT: 10,
  FALL_MEDIUM: 11,
  FALL_FAR: 12,

  /** The boing at the pad, and the jump sound on the player. */
  JUMP_PAD: 13,

  JUMP: 14,
  /** A foot touches water. */
  WATER_TOUCH: 15,
  /** A foot leaves it. */
  WATER_LEAVE: 16,
  /** The head goes under. */
  WATER_UNDER: 17,
  /** The head comes out. */
  WATER_CLEAR: 18,

  /** An ordinary pickup, which the picker-up can predict. */
  ITEM_PICKUP: 19,
  /** A powerup or team pickup, which everybody hears. */
  GLOBAL_ITEM_PICKUP: 20,

  NOAMMO: 21,
  CHANGE_WEAPON: 22,
  FIRE_WEAPON: 23,

  USE_ITEM0: 24,
  USE_ITEM1: 25,
  USE_ITEM2: 26,
  USE_ITEM3: 27,
  USE_ITEM4: 28,
  USE_ITEM5: 29,
  USE_ITEM6: 30,
  USE_ITEM7: 31,
  USE_ITEM8: 32,
  USE_ITEM9: 33,
  USE_ITEM10: 34,
  USE_ITEM11: 35,
  USE_ITEM12: 36,
  USE_ITEM13: 37,
  USE_ITEM14: 38,
  USE_ITEM15: 39,

  ITEM_RESPAWN: 40,
  ITEM_POP: 41,
  PLAYER_TELEPORT_IN: 42,
  PLAYER_TELEPORT_OUT: 43,

  /** The parm is the sound index. */
  GRENADE_BOUNCE: 44,

  GENERAL_SOUND: 45,
  /** A sound with no attenuation: the same volume wherever it is heard from. */
  GLOBAL_SOUND: 46,
  /** The parm is a {@link GTS}, and which of two sounds a client plays depends on their side. */
  GLOBAL_TEAM_SOUND: 47,

  BULLET_HIT_FLESH: 48,
  BULLET_HIT_WALL: 49,

  MISSILE_HIT: 50,
  MISSILE_MISS: 51,
  MISSILE_MISS_METAL: 52,
  RAILTRAIL: 53,
  SHOTGUN: 54,
  /** `otherEntityNum` is the shooter. */
  BULLET: 55,

  PAIN: 56,
  DEATH1: 57,
  DEATH2: 58,
  DEATH3: 59,
  OBITUARY: 60,

  POWERUP_QUAD: 61,
  POWERUP_BATTLESUIT: 62,
  POWERUP_REGEN: 63,

  /** Take a player who was alive to pieces. */
  GIB_PLAYER: 64,
  /** The score number that floats up off a frag. */
  SCOREPLUM: 65,

  PROXIMITY_MINE_STICK: 66,
  PROXIMITY_MINE_TRIGGER: 67,
  KAMIKAZE: 68,
  OBELISKEXPLODE: 69,
  OBELISKPAIN: 70,
  INVUL_IMPACT: 71,
  JUICED: 72,
  LIGHTNINGBOLT: 73,

  DEBUG_LINE: 74,
  STOPLOOPINGSOUND: 75,
  TAUNT: 76,
  TAUNT_YES: 77,
  TAUNT_NO: 78,
  TAUNT_FOLLOWME: 79,
  TAUNT_GETFLAG: 80,
  TAUNT_GUARDBASE: 81,
  TAUNT_PATROL: 82,

  /**
   * CPMA's step up, whose parm is the rise in whole units. It is past the end of id's list, so
   * none of id's numbers move.
   */
  STEP: 83
} as const;

/**
 * `global_team_sound_t` (`bg_public.h:459–475`): what a {@link EV.GLOBAL_TEAM_SOUND} names.
 *
 * The taken and the returned sounds are named for the side that gets the news rather than for
 * the flag it happened to — the *red* flag being taken is `BLUE_TAKEN`, because blue took it.
 *
 * Team Arena's four keep their places, because the numbers of the ones after them are Quake 3's
 * and go on the wire.
 */
export const GTS = {
  RED_CAPTURE: 0,
  BLUE_CAPTURE: 1,
  RED_RETURN: 2,
  BLUE_RETURN: 3,
  RED_TAKEN: 4,
  BLUE_TAKEN: 5,
  REDOBELISK_ATTACKED: 6,
  BLUEOBELISK_ATTACKED: 7,
  REDTEAM_SCORED: 8,
  BLUETEAM_SCORED: 9,
  REDTEAM_TOOK_LEAD: 10,
  BLUETEAM_TOOK_LEAD: 11,
  TEAMS_ARE_TIED: 12,
  KAMIKAZE: 13
} as const;

/** Whether an event is a step up: one of id's four heights, or CPMA's with its rise. */
export function isStepEvent(event: number): boolean {
  return event === EV.STEP || (event >= EV.STEP_4 && event <= EV.STEP_16);
}

/** The event a field carries, with the counter that distinguishes two of the same taken off. */
export function eventNumber(field: number): number {
  return field & ~EV_EVENT_BITS;
}

/**
 * `BG_AddPredictableEventToPlayerstate` (`bg_misc.c:1396–1414`): put an event in the player
 * state's ring and move the sequence on.
 *
 * The sequence only ever rises, and the ring is {@link MAX_PS_EVENTS} deep, so a tick that raises
 * more events than that loses the oldest — which Quake 3 accepts, because two is as many as a
 * snapshot can carry and a third would have nowhere to go anyway.
 *
 * @param ps - The player state to raise the event on; its `eventSequence` advances.
 * @param event - One of {@link EV}.
 * @param parm - The event's argument, or zero for the ones that take none.
 */
export function addPredictableEvent(ps: PlayerState, event: number, parm = 0): void {
  ps.events[ps.eventSequence & (MAX_PS_EVENTS - 1)] = event;
  ps.eventParms[ps.eventSequence & (MAX_PS_EVENTS - 1)] = parm;
  ps.eventSequence++;
}

/** One event as a reader takes it off a state: what happened, and its argument. */
export interface Event {
  /** One of {@link EV}, with the counter bits already off. */
  event: number;
  parm: number;
}

/**
 * Walk the events a player state has gained since an earlier reading of its sequence.
 *
 * This is the loop `ClientEvents` (`g_active.c:549–552`) and `CG_CheckPlayerstateEvents`
 * (`cg_playerstate.c:226–242`) both run: from where the reader had got to, up to where the
 * sequence is now, clamped to what the ring still holds. Both ends of the port read the same
 * events out of the same ring, which is the point of the ring being on the state.
 *
 * @param ps - The player state to read; nothing on it is changed.
 * @param since - The `eventSequence` the reader last saw.
 * @returns The events, oldest first.
 */
export function eventsSince(ps: PlayerState, since: number): Event[] {
  const events: Event[] = [];
  const first = Math.max(since, ps.eventSequence - MAX_PS_EVENTS);
  for (let i = first; i < ps.eventSequence; i++) {
    const slot = i & (MAX_PS_EVENTS - 1);
    events.push({ event: ps.events[slot], parm: ps.eventParms[slot] });
  }
  return events;
}

/**
 * The value an event field takes when a new event is set on it: the event, with the counter in
 * the top two bits moved on from whatever was there before.
 *
 * `G_AddEvent` writes this into `s.event` or `ps.externalEvent`, and the body queue writes it
 * into a corpse's. It is the one rule that makes two of the same event in a row readable as two,
 * so it lives in one place rather than at each carrier.
 *
 * @param current - What the field holds now.
 * @param event - One of {@link EV}.
 */
export function nextEventField(current: number, event: number): number {
  return event | (((current & EV_EVENT_BITS) + EV_EVENT_BIT1) & EV_EVENT_BITS);
}
