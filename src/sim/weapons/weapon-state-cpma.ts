import type { PlayerState } from '../../net/protocol';
import { EF_TALK, PMF_RESPAWNED, STAT } from '../constants';
import { PW } from '../items';
import type { SysteminfoRules } from '../rules';
import type { UserCmd } from '../types';
import { WEAPON_DROPPING, WEAPON_FIRING, WEAPON_RAISING, WP } from './constants';
import {
  beginWeaponChange,
  finishWeaponChange,
  fireShot,
  isValidWeapon,
  ownsWeapon,
  raiseDone,
  releaseTrigger,
  reloadTime,
  startAttack,
  useHoldable,
  type WeaponTickInput
} from './weapon-state';

/**
 * CPMA 1.48's `PM_Weapon`: id's `pmWeapon`, built from the same pieces in the same order, with each
 * of CPMA's changes behind its own rule. With every one off it is id's step.
 *
 * CPMA's changes are three timers and three returns placed between id's steps, which is why this
 * is a step of its own rather than id's with seams. The switch lock holds a change's finish, the
 * rail timer holds the railgun, and a round's countdown holds the trigger.
 *
 * @param state - Player state to advance.
 * @param cmd - Input for this tick.
 * @param msec - Tick length in milliseconds.
 * @param input - Per-tick inputs computed outside the move.
 * @param rules - The rules its times and switches are read from.
 */
export function pmWeaponCpma(
  state: PlayerState,
  cmd: UserCmd,
  msec: number,
  input: WeaponTickInput,
  rules: Readonly<SysteminfoRules>
): void {
  const { stats } = state;
  if (state.pmFlags & PMF_RESPAWNED) return;
  // `pmove_TalkHoldsWeapon`: talking stops the step, and its timers with it.
  if (rules.pmove_TalkHoldsWeapon && state.eFlags & EF_TALK) return;

  if (stats[STAT.HEALTH] <= 0) {
    state.weapon = WP.NONE;
    return;
  }

  if (useHoldable(state, cmd, rules)) return;

  if (stats[STAT.RAIL_TIME] > 0) stats[STAT.RAIL_TIME] -= msec;
  if (stats[STAT.WEAPON_LOCK] > 0) stats[STAT.WEAPON_LOCK] -= msec;
  if (state.weaponTime > 0) state.weaponTime -= msec;

  if (state.weaponTime <= 0 || state.weaponstate !== WEAPON_FIRING) {
    if (state.weapon !== cmd.weapon) {
      if (upgrades(state, cmd)) stats[STAT.WEAPON_LOCK] = rules.pmove_WeaponUpgradeLockTime;
      const drop = hasteSkipsSwitch(state, rules) ? 0 : rules.pmove_WeaponDropTime;
      beginWeaponChange(state, cmd.weapon, drop);
    }
  }

  // The lock does not stop a change beginning. It holds the finish, and so the new weapon.
  if (stats[STAT.WEAPON_LOCK] > 0 && state.weapon !== cmd.weapon) return;
  if (state.weaponTime > 0) return;

  if (state.weaponstate === WEAPON_DROPPING) {
    finishChange(state, cmd, rules);
    return;
  }

  // The railgun comes up, and fires, only once its own timer has run out.
  if (state.weapon === WP.RAILGUN && stats[STAT.RAIL_TIME] > 0) return;

  if (state.weaponstate === WEAPON_RAISING) {
    raiseDone(state);
    return;
  }

  if (releaseTrigger(state, cmd)) return;
  // `g_countdownHold`: while a round counts down the trigger does nothing, and the weapon's state
  // and time stay as they were.
  if (rules.g_countdownHold && input.countdown) return;
  if (!startAttack(state, input.gauntletHit)) return;
  if (!fireShot(state, Boolean(input.freeAmmo), rules.pmove_WeaponNoAmmoTime)) return;

  let addTime = reloadTime(state.weapon, rules);
  if (state.weapon === WP.RAILGUN && rules.weapon_timer_rg) {
    // Assigned, where `weaponTime` is added to, so no tick's overshoot carries into the next shot.
    stats[STAT.RAIL_TIME] = addTime;
    if (rules.weapon_switchTime_rg) addTime = rules.weapon_switchTime_rg;
  }
  stats[STAT.WEAPON_LOCK] = rules.pmove_WeaponLockTime;
  if (state.powerups[PW.HASTE]) {
    // Every hasted shot shortens both timers, whichever weapon fired it.
    const factor = rules.weapon_hasteFactor;
    if (!rules.weapon_hasteSparesReload) addTime = Math.trunc(addTime / factor);
    stats[STAT.RAIL_TIME] = Math.trunc(stats[STAT.RAIL_TIME] / factor);
    stats[STAT.WEAPON_LOCK] = Math.trunc(stats[STAT.WEAPON_LOCK] / factor);
  }
  state.weaponTime += addTime;
}

/**
 * `pmove_WeaponUpgradeLockTime`: whether this change is up from the gauntlet or the machinegun,
 * with no drop or lock already running, once a better weapon has been raised since the spawn.
 * Weapons are told by their number, so an empty hand counts as below and the grapple as above.
 */
function upgrades(state: PlayerState, cmd: UserCmd): boolean {
  return (
    state.weaponstate !== WEAPON_DROPPING &&
    state.stats[STAT.WEAPON_LOCK] <= 0 &&
    state.weapon <= WP.MACHINEGUN &&
    cmd.weapon > WP.MACHINEGUN &&
    state.stats[STAT.UPGRADE_RAISED] !== 0
  );
}

/**
 * `PM_FinishWeaponChange`, with CPMA's two changes. Under `pmove_WeaponLockTime` a change to a
 * weapon not held leaves the hand empty and the change unfinished, where id's raises the empty
 * hand. Under `pmove_WeaponUpgradeLockTime`, raising a weapon better than the machinegun ends the
 * free change up.
 */
function finishChange(state: PlayerState, cmd: UserCmd, rules: Readonly<SysteminfoRules>): void {
  const held = isValidWeapon(cmd.weapon) && ownsWeapon(state, cmd.weapon);
  if (rules.pmove_WeaponLockTime && !held) {
    state.weapon = WP.NONE;
    return;
  }

  finishWeaponChange(state, cmd, hasteSkipsSwitch(state, rules) ? 0 : rules.pmove_WeaponRaiseTime);
  if (rules.pmove_WeaponUpgradeLockTime && state.weapon > WP.MACHINEGUN) {
    state.stats[STAT.UPGRADE_RAISED] = 1;
  }
}

/** `weapon_hasteSkipsSwitch`: under haste, a change has no drop and no raise. */
function hasteSkipsSwitch(state: PlayerState, rules: Readonly<SysteminfoRules>): boolean {
  return rules.weapon_hasteSkipsSwitch !== 0 && Boolean(state.powerups[PW.HASTE]);
}
