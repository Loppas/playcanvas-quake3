import type { PlayerState } from '../../net/protocol';
import { ANIM, continueTorsoAnim, startTorsoAnim } from '../animations';
import {
  BUTTON_ATTACK,
  BUTTON_USE_HOLDABLE,
  PMF_RESPAWNED,
  PMF_USE_ITEM_HELD,
  STAT
} from '../constants';
import { EV, addPredictableEvent } from '../events';
import { HI, ITEMS, MEDKIT_HEAL, PW, healthLimit } from '../items';
import { ID_RULES, type SysteminfoRule, type SysteminfoRules } from '../rules';
import type { UserCmd } from '../types';
import {
  AMMO_INFINITE,
  NO_AMMO_TIME,
  WEAPON_DROPPING,
  WEAPON_DROP_TIME,
  WEAPON_FIRE_TIME,
  WEAPON_FIRING,
  WEAPON_RAISE_TIME,
  WEAPON_RAISING,
  WEAPON_READY,
  WP,
  type WeaponId
} from './constants';

/**
 * `PM_Weapon` — the weapon state machine (`bg_pmove.c:1537-1705`).
 *
 * Runs **inside** the movement tick, at its own slot in `PmoveSingle` (after the second
 * ground trace, before footsteps and the velocity snap). It never touches velocity or
 * origin: Quake 3 has no recoil, and firing affects movement only through knockback applied
 * *after* the tick. That is what makes the weapon layer a
 * sibling of the movement sim rather than a change to it.
 *
 * Everything is driven by the single `weaponTime` gate. Fire intervals are **added** to it
 * rather than assigned, so at our 8 ms tick an interval like the railgun's 1500 accumulates
 * up to 7 ms of drift per shot. That drift is Q3's own; reproducing it is the point.
 *
 * The torso's animations are chosen here too, as each state begins.
 */

/** Per-tick inputs `PM_Weapon` reads that are neither state nor user command. */
export interface WeaponTickInput {
  /**
   * Whether the gauntlet's pre-move trace found something it could hurt.
   *
   * Q3 computes this in `ClientThink_real` *before* `Pmove` and applies the damage there
   * (`g_active.c:868`), so the gauntlet only enters its firing state when it has connected, and
   * hums without firing at the air.
   */
  gauntletHit: boolean;
  /** Whether a shot spends nothing, as Clan Arena's do while no round is being played. */
  freeAmmo?: boolean;
  /**
   * Whether a round's countdown is running, as Clan Arena's does before each round. id's step does
   * not ask.
   */
  countdown?: boolean;
}

/** The weapons whose reload is a rule. The rest reload at {@link WEAPON_FIRE_TIME}'s. */
const RELOAD_RULES: Partial<Record<number, SysteminfoRule>> = {
  [WP.GAUNTLET]: 'weapon_reload_g',
  [WP.MACHINEGUN]: 'weapon_reload_mg',
  [WP.SHOTGUN]: 'weapon_reload_sg',
  [WP.GRENADE_LAUNCHER]: 'weapon_reload_gl',
  [WP.ROCKET_LAUNCHER]: 'weapon_reload_rl',
  [WP.LIGHTNING]: 'weapon_reload_lg',
  [WP.RAILGUN]: 'weapon_reload_rg',
  [WP.PLASMAGUN]: 'weapon_reload_pg',
  [WP.BFG]: 'weapon_reload_bfg'
};

/** Whether the player owns a weapon, per the `STAT_WEAPONS` bitmask. */
export function ownsWeapon(state: PlayerState, weapon: number): boolean {
  return (state.stats[STAT.WEAPONS] & (1 << weapon)) !== 0;
}

/** Whether a weapon id is one the game actually has. */
export function isValidWeapon(weapon: number): boolean {
  return weapon > WP.NONE && weapon <= WP.GRAPPLING_HOOK;
}

/** The torso's stand for a weapon: the gauntlet is held out in a stance of its own. */
function standAnim(weapon: number): number {
  return weapon === WP.GAUNTLET ? ANIM.TORSO_STAND2 : ANIM.TORSO_STAND;
}

/**
 * `PM_BeginWeaponChange` (`bg_pmove.c:1468`) — start dropping the current weapon.
 *
 * Silently ignores a switch to an invalid or unowned weapon, and refuses to restart a drop
 * already in progress, so spamming the select key cannot stack drop times.
 *
 * @param dropTime - How long the drop holds the weapon.
 */
export function beginWeaponChange(
  state: PlayerState,
  weapon: number,
  dropTime = WEAPON_DROP_TIME
): void {
  if (!isValidWeapon(weapon)) return;
  if (!ownsWeapon(state, weapon)) return;
  if (state.weaponstate === WEAPON_DROPPING) return;

  // `EV_CHANGE_WEAPON` carries no weapon, because it is raised where the drop begins and the
  // weapon in hand does not change until the raise finishes 450 ms later.
  addPredictableEvent(state, EV.CHANGE_WEAPON);
  state.weaponstate = WEAPON_DROPPING;
  state.weaponTime += dropTime;
  startTorsoAnim(state, ANIM.TORSO_DROP);
}

/**
 * `PM_FinishWeaponChange` (`bg_pmove.c:1493`) — commit the new weapon and raise it.
 *
 * @param raiseTime - How long the raise holds the weapon.
 */
export function finishWeaponChange(
  state: PlayerState,
  cmd: UserCmd,
  raiseTime = WEAPON_RAISE_TIME
): void {
  let weapon = cmd.weapon;
  if (!isValidWeapon(weapon) || !ownsWeapon(state, weapon)) weapon = WP.NONE;

  state.weapon = weapon;
  state.weaponstate = WEAPON_RAISING;
  state.weaponTime += raiseTime;
  startTorsoAnim(state, ANIM.TORSO_RAISE);
}

/** A shot's reload, the `addTime` of `PM_Weapon`'s switch (`bg_pmove.c:1645–1688`). */
export function reloadTime(weapon: number, rules: Readonly<SysteminfoRules>): number {
  const rule = RELOAD_RULES[weapon];
  return rule ? rules[rule] : (WEAPON_FIRE_TIME[weapon as WeaponId] ?? WEAPON_FIRE_TIME[WP.NONE]);
}

/**
 * "Check for item using" (`bg_pmove.c:1556–1571`). The key is read as a level, with
 * `PMF_USE_ITEM_HELD` as its latch, so one press uses one item: the command the key goes down on
 * raises the event and clears the slot, while every command after it, and the release, falls
 * through to the gun.
 *
 * @param rules - The rules the health limit is read from.
 * @returns Whether the command went to the holdable, which ends the weapon's step.
 */
export function useHoldable(
  state: PlayerState,
  cmd: UserCmd,
  rules: Readonly<SysteminfoRules> = ID_RULES
): boolean {
  if (!(cmd.buttons & BUTTON_USE_HOLDABLE)) {
    state.pmFlags &= ~PMF_USE_ITEM_HELD;
    return false;
  }
  if (state.pmFlags & PMF_USE_ITEM_HELD) return false;

  // The table's slot 0 is `IT_BAD` with a tag of 0, so "nothing in hand" reads as the use-nothing
  // event without a check of its own.
  const item = ITEMS[state.stats[STAT.HOLDABLE_ITEM]];
  if (
    item.giTag === HI.MEDKIT &&
    state.stats[STAT.HEALTH] >= healthLimit(rules, state.stats) + MEDKIT_HEAL
  ) {
    // "don't use medkit if at max health": refused, with neither the event nor the latch — so
    // with the key held, the next command tries again.
  } else {
    state.pmFlags |= PMF_USE_ITEM_HELD;
    addPredictableEvent(state, EV.USE_ITEM0 + item.giTag);
    state.stats[STAT.HOLDABLE_ITEM] = 0;
  }
  return true;
}

/** The raise's end: the weapon is ready, and the torso stands with it. */
export function raiseDone(state: PlayerState): void {
  state.weaponstate = WEAPON_READY;
  startTorsoAnim(state, standAnim(state.weapon));
}

/**
 * Attack let go: the weapon is ready.
 *
 * @returns Whether attack is up, which ends the weapon's step.
 */
export function releaseTrigger(state: PlayerState, cmd: UserCmd): boolean {
  if (cmd.buttons & BUTTON_ATTACK) return false;
  state.weaponTime = 0;
  state.weaponstate = WEAPON_READY;
  return true;
}

/**
 * The attack's start: the torso's attack, and the weapon firing. The gauntlet only "fires" when it
 * would actually connect, and is otherwise ready again.
 *
 * @param gauntletHit - See {@link WeaponTickInput.gauntletHit}.
 * @returns Whether the attack started.
 */
export function startAttack(state: PlayerState, gauntletHit: boolean): boolean {
  if (state.weapon === WP.GAUNTLET) {
    if (!gauntletHit) {
      state.weaponTime = 0;
      state.weaponstate = WEAPON_READY;
      return false;
    }
    startTorsoAnim(state, ANIM.TORSO_ATTACK2);
  } else {
    startTorsoAnim(state, ANIM.TORSO_ATTACK);
  }

  state.weaponstate = WEAPON_FIRING;
  return true;
}

/**
 * The shot: a click with the gun empty, or a round spent and the fire event raised. It comes after
 * the attack's start, so an empty gun still goes through the motion.
 *
 * @param freeAmmo - See {@link WeaponTickInput.freeAmmo}.
 * @param noAmmoTime - How long a click holds the weapon.
 * @returns Whether it fired.
 */
export function fireShot(
  state: PlayerState,
  freeAmmo: boolean,
  noAmmoTime = NO_AMMO_TIME
): boolean {
  if (!state.ammo[state.weapon]) {
    addPredictableEvent(state, EV.NOAMMO);
    state.weaponTime += noAmmoTime;
    return false;
  }

  // The -1 sentinel passes untouched, which is the whole mechanism behind infinite ammo.
  if (state.ammo[state.weapon] !== AMMO_INFINITE && !freeAmmo) state.ammo[state.weapon]--;

  addPredictableEvent(state, EV.FIRE_WEAPON);
  return true;
}

/**
 * Advance the weapon by one tick.
 *
 * Mutates `state` and appends any events raised, matching the C. The call order below is
 * `PM_Weapon`'s exactly, and two behaviours live in that ordering rather than in any
 * formula:
 *
 * - The weapon-change check runs **before** the `weaponTime` gate, so a switch can be
 *   queued during a cooldown and starts the moment the shot's interval is not still
 *   running.
 * - Everything else runs **after** the gate, so releasing attack does *not* shorten a fire
 *   interval. Measured: with the rocket launcher's 800 ms, the second shot lands on the
 *   same tick whether you hold the button or release it and press again. The
 *   `weaponTime = 0` on the release path is reached only once the timer has already
 *   expired, and is a no-op numerically — it exists to leave the state READY.
 *
 * Because the timer is decremented before the gate and acts only when it reaches zero, each
 * phase costs `ceil(time / msec) + 1` ticks. That is why a nominal 450 ms weapon switch
 * measures **464 ms** at our 8 ms tick.
 *
 * Nothing runs at all until attack has been let go since the last spawn, and a dead player's
 * hand is emptied.
 *
 * @param state - Player state to advance.
 * @param cmd - Input for this tick.
 * @param msec - Tick length in milliseconds.
 * @param input - Per-tick inputs computed outside the move.
 * @param rules - The rules its times are read from.
 */
export function pmWeapon(
  state: PlayerState,
  cmd: UserCmd,
  msec: number,
  input: WeaponTickInput,
  rules: Readonly<SysteminfoRules> = ID_RULES
): void {
  // The click that respawned the player must not also fire the gun.
  if (state.pmFlags & PMF_RESPAWNED) return;

  if (state.stats[STAT.HEALTH] <= 0) {
    state.weapon = WP.NONE;
    return;
  }

  if (useHoldable(state, cmd, rules)) return;

  if (state.weaponTime > 0) state.weaponTime -= msec;

  // A change may be *started* while the cooldown runs — but not mid-shot, which is why
  // WEAPON_FIRING is excluded rather than simply testing the timer.
  if (state.weaponTime <= 0 || state.weaponstate !== WEAPON_FIRING) {
    if (state.weapon !== cmd.weapon) {
      beginWeaponChange(state, cmd.weapon, rules.pmove_WeaponDropTime);
    }
  }

  // The hard gate: nothing below happens while the weapon is busy.
  if (state.weaponTime > 0) return;

  if (state.weaponstate === WEAPON_DROPPING) {
    finishWeaponChange(state, cmd, rules.pmove_WeaponRaiseTime);
    return;
  }

  if (state.weaponstate === WEAPON_RAISING) {
    raiseDone(state);
    return;
  }

  if (releaseTrigger(state, cmd)) return;
  if (!startAttack(state, input.gauntletHit)) return;
  if (!fireShot(state, Boolean(input.freeAmmo), rules.pmove_WeaponNoAmmoTime)) return;

  let addTime = reloadTime(state.weapon, rules);
  // Haste quickens the interval by `weapon_hasteFactor`, 1.3 as id has it (`bg_pmove.c:1700–1702`).
  // `addTime` is an int in the C, so the division truncates there; truncating here too keeps
  // `weaponTime` whole and the drift the tests above measure unchanged.
  if (state.powerups[PW.HASTE]) addTime = Math.trunc(addTime / rules.weapon_hasteFactor);
  state.weaponTime += addTime;
}

/**
 * `PM_TorsoAnimation` (`bg_pmove.c:1518`): once a weapon is ready, the torso settles into its
 * stand, unless a gesture still holds it. Runs straight after {@link pmWeapon}.
 */
export function torsoAnimation(state: PlayerState): void {
  if (state.weaponstate !== WEAPON_READY) return;
  continueTorsoAnim(state, standAnim(state.weapon));
}
