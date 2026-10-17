import { MAX_PS_EVENTS, type PlayerState } from '../net/protocol';
import { ANIM, animOf } from '../sim/animations';
import { CROUCH_VIEWHEIGHT, DEFAULT_VIEWHEIGHT, MASK, MINS_Z, STAT } from '../sim/constants';
import type { Footsteps } from '../formats/animation-config';
import { CUSTOM_SOUNDS, DEFAULT_MODEL } from '../formats/asset-manifest';
import { EV, eventNumber, type Event } from '../sim/events';
import { NO_CONTENTS, type PointContentsFn } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { createDamageFeedback, damageFeedback, type DamageFeedback } from './damage-feedback';
import { jumpPadEvent } from './jump-pad-events';

/**
 * The player's own events, as the client plays them:
 * - `CG_CheckPlayerstateEvents` (`cg_playerstate.c:212–243`), which is how a client learns that
 *   anything happened at all: it compares the player state it has just been given against the one
 *   before it, and everything between the two event sequences is new;
 * - `CG_TransitionPlayerState`'s damage feedback (`cg_playerstate.c:505–508`);
 * - `CG_CheckLocalSounds`' pain, heard in the health (`cg_playerstate.c:331–336`), gurgled under
 *   water;
 * - `CG_EntityEvent`'s cases for the player: footsteps, falls, jumps, the taunt, the water's,
 *   deaths, drowned or not, and the gib (`cg_event.c:552–682`, `710–725`, `1167–1223`).
 *
 * What comes out is what to play and throw; the sound bus resolves each sound for the chosen
 * model, and the gibs are `fragments.ts`'. The pain time this keeps is the one the body's torso
 * twitches from.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** "Don't do more than two pain sounds a second" (`cg_event.c:482–485`). */
export const PAIN_SOUND_DEBOUNCE = 500;

/** Each footstep set has four sounds, one picked by `rand()&3` (`cg_event.c:556`; `cg_main.c:684–697`). */
export const FOOTSTEP_VARIANTS = 4;

/** `cgs.media.landSound`, a short fall's (`cg_main.c:647`). */
export const LAND_SOUND = 'sound/player/land1.wav';

/** `cgs.media.gibSound` (`cg_main.c:618`). */
export const GIB_SOUND = 'sound/player/gibsplt1.wav';

/** `cgs.media.watrInSound`, `watrOutSound` and `watrUnSound` (`cg_main.c:677–679`). */
export const WATER_IN_SOUND = 'sound/player/watr_in.wav';
export const WATER_OUT_SOUND = 'sound/player/watr_out.wav';
export const WATER_UNDER_SOUND = 'sound/player/watr_un.wav';

/** The gurgles `CG_PainEvent` plays in place of a grunt under water (`cg_event.c:497–502`). */
export const GURP1_SOUND = 'sound/player/gurp1.wav';
export const GURP2_SOUND = 'sound/player/gurp2.wav';

/** One of `cg_customSoundNames` (`cg_players.c:26–40`), without its `*` and `.wav`. */
export type CustomSound = (typeof CUSTOM_SOUNDS)[number];

/** `*death1.wav` to `*death3.wav`, by the death that played. */
const DEATH_SOUNDS: readonly CustomSound[] = ['death1', 'death2', 'death3'];

/**
 * `CG_CheckPlayerstateEvents` (`cg_playerstate.c:212–243`): what is new between two player states.
 *
 * The external event comes first, and only when it has changed — it is not in the ring and has no
 * sequence of its own, so "did it change" is the only thing that can be asked of it. Then the ring,
 * from where the previous state's sequence had got to, clamped to the {@link MAX_PS_EVENTS} the
 * ring still holds: a client that missed a snapshot has missed those events, and they are gone.
 *
 * @param ps - The player state as it is now.
 * @param ops - The player state before it. Only the two fields the comparison reads are asked
 *   for, so a caller that keeps no whole previous state can still make the comparison.
 * @returns The events, oldest first, ready for `CG_EntityEvent`.
 */
export function checkPlayerstateEvents(
  ps: PlayerState,
  ops: Pick<PlayerState, 'eventSequence' | 'externalEvent'>
): Event[] {
  const events: Event[] = [];

  if (ps.externalEvent && ps.externalEvent !== ops.externalEvent) {
    events.push({ event: ps.externalEvent, parm: ps.externalEventParm });
  }

  const first = Math.max(ops.eventSequence, ps.eventSequence - MAX_PS_EVENTS);
  for (let i = first; i < ps.eventSequence; i++) {
    const slot = i & (MAX_PS_EVENTS - 1);
    events.push({ event: ps.events[slot], parm: ps.eventParms[slot] });
  }

  return events;
}

/** A sound a player's body makes. */
export type PlayerSound =
  /** One of the model's own (`CG_CustomSound`). */
  | { type: 'custom'; name: CustomSound }
  /**
   * A footstep, 1–4, from the model's set (`cgs.media.footsteps[ci->footsteps][rand()&3]`), or
   * from the `set` a metal floor or the water picks. `cg_footsteps` silences every one.
   */
  | { type: 'footstep'; variant: number; set?: Footsteps }
  /** A sound every player makes alike. */
  | { type: 'shared'; path: string };

/**
 * Which of a model's own sounds a name starting `*` is, as `CG_CustomSound` matches it
 * (`cg_players.c:53–66`), or null for any other name.
 */
export function customSoundName(name: string): CustomSound | null {
  return CUSTOM_SOUNDS.find((sound) => name === `*${sound}.wav`) ?? null;
}

/** `CG_PainEvent`'s sound for the health a hurt left (`cg_event.c:487–495`). */
export function painSound(health: number): CustomSound {
  if (health < 25) return 'pain25_1';
  if (health < 50) return 'pain50_1';
  if (health < 75) return 'pain75_1';
  return 'pain100_1';
}

/**
 * Where one of a model's own sounds comes from, as `CG_LoadClientInfo` registers them
 * (`cg_players.c:705–722`): the model's own file, or sarge's where the model has none.
 *
 * @param has - Whether a file is in the library.
 */
export function customSoundPath(
  model: string,
  name: CustomSound,
  has: (path: string) => boolean
): string {
  const own = `sound/player/${model}/${name}.wav`;
  return has(own) ? own : `sound/player/${DEFAULT_MODEL}/${name}.wav`;
}

/** `cent->pe`'s pain: what `CG_PainEvent` keeps of a body between its hurts. */
export interface PainMemory {
  /** `cent->pe.painTime`: when the last pain sound played, which the torso's twitch runs from. */
  painTime: number;
  /** `cent->pe.painDirection`: flipped by each pain sound, so the twitch alternates sides. */
  painDirection: number;
}

/** How deep a body stands, asked only when a sound depends on it. */
export type WaterLevelFn = () => number;

/** A body nothing has asked the water of. */
const DRY: WaterLevelFn = () => 0;

/**
 * `CG_WaterLevel` (`cg_event.c:428–470`): how deep a body stands, 0 to 3, by what is at its feet,
 * its waist and its eyes. Crouched is read from its legs, so a body that ducks while its legs are
 * in another animation is sampled standing.
 *
 * @param origin - Where the body is.
 * @param legsAnim - Its legs' animation, with or without the toggle bit.
 * @param pointContents - `CG_PointContents`, passing nobody.
 */
export function waterLevel(
  origin: Vec3,
  legsAnim: number,
  pointContents: PointContentsFn
): number {
  const anim = animOf(legsAnim);
  const crouched = anim === ANIM.LEGS_WALKCR || anim === ANIM.LEGS_IDLECR;
  const viewheight = crouched ? CROUCH_VIEWHEIGHT : DEFAULT_VIEWHEIGHT;
  const sample2 = viewheight - MINS_Z;
  const sample1 = Math.trunc(sample2 / 2);
  const at = (z: number) => pointContents(vec3(origin.x, origin.y, z), -1) & MASK.WATER;

  if (!at(origin.z + MINS_Z + 1)) return 0;
  if (!at(origin.z + MINS_Z + sample1)) return 1;
  if (!at(origin.z + MINS_Z + sample2)) return 2;
  return 3;
}

/**
 * `CG_PainEvent` (`cg_event.c:479–509`): the grunt for the health a hurt left, or a gurgle by
 * `rand()&1` with the head under, and the twitch it starts — or nothing, within half a second of
 * the last.
 *
 * @param pain - The body's pain memory, updated in place.
 * @param depth - The body's `CG_WaterLevel`.
 * @param random - `rand()`, as a number in [0, 1), for the gurgle.
 * @returns the sound, or `null` for none
 */
export function painEvent(
  pain: PainMemory,
  health: number,
  time: number,
  depth: WaterLevelFn = DRY,
  random: () => number = Math.random
): PlayerSound | null {
  if (time - pain.painTime < PAIN_SOUND_DEBOUNCE) return null;
  let sound: PlayerSound = { type: 'custom', name: painSound(health) };
  if (depth() === 3) {
    sound = { type: 'shared', path: Math.floor(random() * 2) ? GURP1_SOUND : GURP2_SOUND };
  }
  pain.painTime = time;
  pain.painDirection ^= 1;
  return sound;
}

/**
 * The sound a player's body makes for one of its events, which `CG_EntityEvent` plays alike for
 * the player's own events and for anyone else's (`cg_event.c:552–682`, `710–725`, `1167–1223`):
 * footsteps, splashes, falls, jumps, the taunt, the water's sounds, the deaths and the gib.
 *
 * @param event - The event number, with the counter bits taken off.
 * @param pain - The body's pain memory: a far fall holds its next pain sound off.
 * @param time - When it played, in milliseconds.
 * @param random - `rand()`, as a number in [0, 1), for the footstep.
 * @param depth - The body's `CG_WaterLevel`: a death with the head under is `*drown.wav`.
 * @returns the sound, or `null` for an event the body makes none for
 */
export function bodyEventSound(
  event: number,
  pain: PainMemory,
  time: number,
  random: () => number,
  depth: WaterLevelFn = DRY
): PlayerSound | null {
  const footstep = (set?: Footsteps): PlayerSound => {
    const variant = 1 + Math.floor(random() * FOOTSTEP_VARIANTS);
    return set ? { type: 'footstep', variant, set } : { type: 'footstep', variant };
  };
  switch (event) {
    case EV.FOOTSTEP:
      return footstep();
    case EV.FOOTSTEP_METAL:
      return footstep('metal');
    // No move raises `EV_FOOTWADE`, but Q3's client plays it as a splash.
    case EV.FOOTSPLASH:
    case EV.FOOTWADE:
    case EV.SWIM:
      return footstep('splash');

    case EV.FALL_SHORT:
      return { type: 'shared', path: LAND_SOUND };
    case EV.FALL_MEDIUM:
      // "Use normal pain sound."
      return { type: 'custom', name: 'pain100_1' };
    case EV.FALL_FAR:
      // "Don't play a pain sound right after this."
      pain.painTime = time;
      return { type: 'custom', name: 'fall1' };

    case EV.JUMP:
      return { type: 'custom', name: 'jump1' };
    case EV.TAUNT:
      return { type: 'custom', name: 'taunt' };

    case EV.DEATH1:
    case EV.DEATH2:
    case EV.DEATH3:
      if (depth() === 3) return { type: 'custom', name: 'drown' };
      return { type: 'custom', name: DEATH_SOUNDS[event - EV.DEATH1] };

    case EV.WATER_TOUCH:
      return { type: 'shared', path: WATER_IN_SOUND };
    case EV.WATER_LEAVE:
      return { type: 'shared', path: WATER_OUT_SOUND };
    case EV.WATER_UNDER:
      return { type: 'shared', path: WATER_UNDER_SOUND };
    case EV.WATER_CLEAR:
      return { type: 'custom', name: 'gasp' };

    case EV.GIB_PLAYER:
      return { type: 'shared', path: GIB_SOUND };

    default:
      return null;
  }
}

/** What the client keeps of the player's events between ticks. */
export interface PlayerEvents extends PainMemory {
  /** The view's reaction to the last hurt. */
  damage: DamageFeedback;
  /** `ops`: the health and `damageEvent` the last transition left, to see a change against. */
  health: number;
  damageEvent: number;
}

/** @param state - The player as the client first sees them. */
export function createPlayerEvents(state: Pick<PlayerState, 'stats' | 'damageEvent'>): PlayerEvents {
  return {
    painTime: Number.NEGATIVE_INFINITY,
    painDirection: 0,
    damage: createDamageFeedback(),
    health: state.stats[STAT.HEALTH],
    damageEvent: state.damageEvent
  };
}

/** What one tick asks the presentation to play and throw. */
export interface PlayerEventOutput {
  sounds: PlayerSound[];
  /** `EV_GIB_PLAYER`: the player went to pieces, for `CG_GibPlayer`. */
  gibbed: boolean;
  /** `EV_JUMP_PAD`: the puff a jump pad throws at the player, for `CG_SmokePuff`. */
  puffs: Vec3[];
}

/**
 * Fold one tick into the client's side of the player's events.
 *
 * The order is Q3's for the player it predicts. The tick's events play first, as the predicted
 * move raises them; the pain of a hurt comes after, once the health that shows it arrives. So a
 * far fall's grunt holds off the pain sound its damage would play, as `cg_event.c:611` means
 * it to. Q3 checks the health first within one transition, but for the predicted player the
 * events come a snapshot ahead of the health.
 *
 * The player's own `EV_PAIN` is ignored, as Q3 ignores it for the player it predicts
 * (`cg_event.c:1159–1164`): their pain is heard in their health.
 *
 * @param events - The client's memory of the player, updated in place.
 * @param state - The player after the tick.
 * @param played - What {@link checkPlayerstateEvents} found, in Quake 3's order.
 * @param time - `cg.time` as they were read, in milliseconds.
 * @param damageTime - When a hurt landed, which the view's kick is timed from: `cg.damageTime`,
 *   the snapshot's time rather than the frame's (`cg_playerstate.c:181`).
 * @param random - `rand()`, as a number in [0, 1), for the footstep and the gurgle.
 * @param pointContents - `CG_PointContents`, for how deep the player stands when they are hurt
 *   or die. Quake 3 reads the body it drew the frame before; the port reads the state the
 *   events came on.
 */
export function transitionPlayerEvents(
  events: PlayerEvents,
  state: PlayerState,
  played: readonly Event[],
  time: number,
  damageTime = time,
  random: () => number = Math.random,
  pointContents: PointContentsFn = NO_CONTENTS
): PlayerEventOutput {
  const sounds: PlayerSound[] = [];
  const puffs: Vec3[] = [];
  let gibbed = false;
  const depth = () => waterLevel(state.origin, state.legsAnim, pointContents);

  if (state.damageEvent !== events.damageEvent && state.damageCount) {
    damageFeedback(
      events.damage,
      state.damageYaw,
      state.damagePitch,
      state.damageCount,
      state.stats[STAT.HEALTH],
      state.viewangles,
      damageTime
    );
  }

  for (const { event } of played) {
    const number = eventNumber(event);
    // `EV_JUMP_PAD`: the pad's sound, the player's jump sound and the puff at the player, which
    // `CG_EntityEvent` plays and throws alike for every body (`cg_event.c:655–674`).
    if (number === EV.JUMP_PAD) {
      const pad = jumpPadEvent(state.origin);
      sounds.push(...pad.sounds);
      puffs.push(pad.puff);
      continue;
    }
    // The player's own pain is heard in their health, below, and not in `EV_PAIN`
    // (`cg_event.c:1158–1165`). The event is still raised, because everyone else plays it.
    const sound = bodyEventSound(number, events, time, random, depth);
    if (sound) sounds.push(sound);
    if (number === EV.GIB_PLAYER) gibbed = true;
  }

  // "Health changes of more than -1 should make pain sounds."
  const health = state.stats[STAT.HEALTH];
  if (health < events.health - 1 && health > 0) {
    const pain = painEvent(events, health, time, depth, random);
    if (pain) sounds.push(pain);
  }

  events.health = health;
  events.damageEvent = state.damageEvent;
  return { sounds, gibbed, puffs };
}
