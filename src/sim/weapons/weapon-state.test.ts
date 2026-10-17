import { describe, expect, it } from 'vitest';
import type { PlayerState } from '../../net/protocol';
import { BUTTON_ATTACK, BUTTON_USE_HOLDABLE, PMF_USE_ITEM_HELD, STAT } from '../constants';
import { EV, eventsSince } from '../events';
import { HI, PW, findItem, itemIndex } from '../items';
import { ID_RULES } from '../rules';
import { createArmedPlayerState, createUserCmd } from '../types';
import {
  WEAPON_DROPPING,
  WEAPON_FIRE_TIME,
  WEAPON_FIRING,
  WEAPON_RAISING,
  WEAPON_READY,
  WP
} from './constants';
import { beginWeaponChange, fireShot, pmWeapon } from './weapon-state';

const TICK = 8;

/**
 * Run `n` ticks of the weapon state machine, collecting every event raised.
 *
 * The ring is two deep, so the events are taken after each tick rather than after the run: a
 * fire and a weapon change in the same tick are two, and the third would push the first out.
 */
function run(
  state: PlayerState,
  ticks: number,
  cmd: { buttons?: number; weapon?: number } = {},
  gauntletHit = false,
  freeAmmo = false
): number[] {
  const events: number[] = [];
  const command = createUserCmd({
    buttons: cmd.buttons ?? 0,
    weapon: cmd.weapon ?? state.weapon
  });
  for (let i = 0; i < ticks; i++) {
    const before = state.eventSequence;
    pmWeapon(state, command, TICK, { gauntletHit, freeAmmo });
    events.push(...eventsSince(state, before).map(({ event }) => event));
  }
  return events;
}

/** Count fire events in a list. */
const shots = (events: number[]) => events.filter((event) => event === EV.FIRE_WEAPON).length;

/** An armed player holding the given weapon, ready to fire. */
function armed(weapon: number): PlayerState {
  return createArmedPlayerState({ weapon, weaponstate: WEAPON_READY });
}

describe('pmWeapon firing', () => {
  it('fires on the first tick attack is held', () => {
    const state = armed(WP.ROCKET_LAUNCHER);
    const events = run(state, 1, { buttons: BUTTON_ATTACK });
    // `EV_FIRE_WEAPON` carries no weapon: which one went off is the one in hand.
    expect(events).toEqual([EV.FIRE_WEAPON]);
    expect(state.weaponstate).toBe(WEAPON_FIRING);
  });

  it('does not fire without the attack button', () => {
    expect(shots(run(armed(WP.ROCKET_LAUNCHER), 200))).toBe(0);
  });

  it('holds fire for the weapon interval', () => {
    // The rocket launcher's 800 ms is exactly 100 ticks, so a second shot lands on tick 101.
    const state = armed(WP.ROCKET_LAUNCHER);
    expect(shots(run(state, 100, { buttons: BUTTON_ATTACK }))).toBe(1);
    expect(shots(run(state, 1, { buttons: BUTTON_ATTACK }))).toBe(1);
  });

  it('reproduces the fire-rate table over one second of held fire', () => {
    // Measured from the port and pinned: shots in 1000 ms of held fire at an 8 ms tick.
    // Every count is exactly 1000 / addTime rounded down, which is the point — see the
    // jitter test below for why that is not obvious.
    const expected: [number, number][] = [
      [WP.MACHINEGUN, 10],
      [WP.SHOTGUN, 1],
      [WP.GRENADE_LAUNCHER, 2],
      [WP.ROCKET_LAUNCHER, 2],
      [WP.LIGHTNING, 20],
      [WP.RAILGUN, 1],
      [WP.PLASMAGUN, 10],
      [WP.BFG, 5]
    ];
    for (const [weapon, count] of expected) {
      const fired = shots(run(armed(weapon), 125, { buttons: BUTTON_ATTACK }));
      expect(fired, `weapon ${weapon}`).toBe(count);
    }
  });

  it('jitters individual gaps but holds the average, because the remainder carries', () => {
    // The subtle half of `weaponTime += addTime`. An interval that is not a multiple of the
    // tick cannot be hit exactly, so gaps alternate — the machinegun's nominal 100 ms comes
    // out as 104, 96, 104, 96. It averages exactly 100 only because `weaponTime` is left
    // *negative* when it expires (the decrement is skipped once it is not positive) and the
    // overshoot is subtracted from the next interval. Assigning instead of adding, or
    // clamping to zero, would lose that and make every weapon slower than Q3's.
    const state = armed(WP.MACHINEGUN);
    const gaps: number[] = [];
    let last = 0;
    for (let tick = 1; tick <= 125; tick++) {
      if (shots(run(state, 1, { buttons: BUTTON_ATTACK })) > 0) {
        if (last) gaps.push((tick - last) * TICK);
        last = tick;
      }
    }
    expect(new Set(gaps)).toEqual(new Set([104, 96]));
    // Every adjacent pair sums to exactly twice the nominal interval, which is the precise
    // claim: the overshoot is repaid on the following shot, never accumulated.
    for (let i = 0; i + 1 < gaps.length; i += 2) {
      expect(gaps[i] + gaps[i + 1]).toBe(2 * WEAPON_FIRE_TIME[WP.MACHINEGUN]);
    }
  });

  it('quickens every fire interval by 1.3 while haste is held', () => {
    // `addTime /= 1.3` before it is added (`bg_pmove.c:1700–1702`), and `addTime` is an int, so
    // the rocket launcher's 800 becomes 615 rather than 615.38.
    const state = armed(WP.ROCKET_LAUNCHER);
    state.powerups[PW.HASTE] = 1;
    run(state, 1, { buttons: BUTTON_ATTACK });
    expect(state.weaponTime).toBe(615);

    // 615 ms is 77 ticks of 8, so the second shot lands on the 78th rather than the 101st.
    expect(shots(run(state, 76, { buttons: BUTTON_ATTACK }))).toBe(0);
    expect(shots(run(state, 1, { buttons: BUTTON_ATTACK }))).toBe(1);
  });

  it('leaves weaponTime negative when an interval overshoots', () => {
    // The mechanism behind the test above, asserted directly: 50 ms of lightning cooldown
    // takes 7 ticks (56 ms) to run out and lands at -6, not 0.
    const state = armed(WP.LIGHTNING);
    run(state, 1, { buttons: BUTTON_ATTACK });
    expect(state.weaponTime).toBe(WEAPON_FIRE_TIME[WP.LIGHTNING]);

    run(state, 6, { buttons: BUTTON_ATTACK });
    expect(state.weaponTime).toBe(2);

    run(state, 1, { buttons: BUTTON_ATTACK });
    // Fired again on this tick, so the timer is -6 + 50.
    expect(state.weaponTime).toBe(44);
  });

  it('does not shorten a fire interval when attack is released', () => {
    // The `weaponTime > 0` gate returns before the button is ever examined, so releasing
    // cannot cancel a cooldown. Measured: releasing leaves the timer running normally and
    // the state does not return to READY until it expires, 100 ticks after the shot.
    const state = armed(WP.ROCKET_LAUNCHER);
    run(state, 1, { buttons: BUTTON_ATTACK });
    expect(state.weaponTime).toBe(800);

    run(state, 1, { buttons: 0 });
    expect(state.weaponTime).toBe(792);
    expect(state.weaponstate).toBe(WEAPON_FIRING);

    run(state, 98, { buttons: 0 });
    expect(state.weaponstate).toBe(WEAPON_FIRING);
    run(state, 1, { buttons: 0 });
    expect(state.weaponstate).toBe(WEAPON_READY);
  });

  it('refires at the same moment whether the button is held or tapped', () => {
    // The corollary, and the reason it is worth pinning: tapping buys nothing in Q3.
    const ticksToSecondShot = (releaseFor: number) => {
      const state = armed(WP.ROCKET_LAUNCHER);
      run(state, 1, { buttons: BUTTON_ATTACK });
      run(state, releaseFor, { buttons: 0 });
      for (let tick = 1; tick <= 200; tick++) {
        if (shots(run(state, 1, { buttons: BUTTON_ATTACK })) > 0) return releaseFor + tick;
      }
      return -1;
    };
    expect(ticksToSecondShot(0)).toBe(100);
    expect(ticksToSecondShot(50)).toBe(100);
  });

  it('leaves infinite ammo untouched', () => {
    const state = armed(WP.ROCKET_LAUNCHER);
    run(state, 500, { buttons: BUTTON_ATTACK });
    // The -1 sentinel passes every check without special-casing.
    expect(state.ammo[WP.ROCKET_LAUNCHER]).toBe(-1);
  });

  it('raises noAmmo and stalls when a weapon is actually empty', () => {
    const state = armed(WP.ROCKET_LAUNCHER);
    state.ammo[WP.ROCKET_LAUNCHER] = 0;
    const events = run(state, 1, { buttons: BUTTON_ATTACK });
    expect(events).toEqual([EV.NOAMMO]);
    expect(state.weaponTime).toBe(500);
  });

  it('decrements finite ammo', () => {
    const state = armed(WP.ROCKET_LAUNCHER);
    state.ammo[WP.ROCKET_LAUNCHER] = 2;
    run(state, 101, { buttons: BUTTON_ATTACK });
    expect(state.ammo[WP.ROCKET_LAUNCHER]).toBe(0);
  });

  it('spends nothing while ammo is free, and fires as ever', () => {
    const state = armed(WP.ROCKET_LAUNCHER);
    state.ammo[WP.ROCKET_LAUNCHER] = 2;
    const events = run(state, 101, { buttons: BUTTON_ATTACK }, false, true);
    expect(shots(events)).toBe(2);
    expect(state.ammo[WP.ROCKET_LAUNCHER]).toBe(2);
  });
});

describe('pmWeapon gauntlet', () => {
  it('never fires without a hit, so it only hums', () => {
    // Faithful, not a gap: `CheckGauntletAttack` runs before the move, and always misses with
    // nothing to hit.
    expect(shots(run(armed(WP.GAUNTLET), 200, { buttons: BUTTON_ATTACK }, false))).toBe(0);
  });

  it('fires when the pre-move trace found something', () => {
    expect(shots(run(armed(WP.GAUNTLET), 1, { buttons: BUTTON_ATTACK }, true))).toBe(1);
  });

  it('stays ready rather than busy when it misses', () => {
    const state = armed(WP.GAUNTLET);
    run(state, 5, { buttons: BUTTON_ATTACK }, false);
    expect(state.weaponstate).toBe(WEAPON_READY);
    expect(state.weaponTime).toBe(0);
  });
});

describe('pmWeapon item using', () => {
  /** An armed player holding one of the two holdables. */
  function holding(classname: string): PlayerState {
    const state = armed(WP.MACHINEGUN);
    state.stats[STAT.HOLDABLE_ITEM] = itemIndex(findItem(classname)!);
    return state;
  }

  const held = (classname: string) => itemIndex(findItem(classname)!);

  it('uses the held item on the command the key goes down, and lets it go', () => {
    const state = holding('holdable_medkit');
    const events = run(state, 1, { buttons: BUTTON_USE_HOLDABLE });
    expect(events).toEqual([EV.USE_ITEM0 + HI.MEDKIT]);
    expect(state.stats[STAT.HOLDABLE_ITEM]).toBe(0);
    expect(state.pmFlags & PMF_USE_ITEM_HELD).toBe(PMF_USE_ITEM_HELD);
  });

  it('holds the use down to one press, and hands the move back to the gun', () => {
    // `PMF_USE_ITEM_HELD` is the latch: while the key stays down the weapon's own code runs
    // again, which is what `bg_pmove.c:1558–1568` returning only on the press buys.
    const state = holding('holdable_medkit');
    run(state, 1, { buttons: BUTTON_USE_HOLDABLE });
    expect(run(state, 1, { buttons: BUTTON_USE_HOLDABLE | BUTTON_ATTACK })).toEqual([
      EV.FIRE_WEAPON
    ]);

    // Releasing the key clears the latch, so the next press uses again — nothing to use now.
    run(state, 1, { buttons: 0 });
    expect(state.pmFlags & PMF_USE_ITEM_HELD).toBe(0);
    expect(run(state, 1, { buttons: BUTTON_USE_HOLDABLE })).toEqual([EV.USE_ITEM0]);
  });

  it('raises use-item-zero with nothing in hand, and still swallows the command', () => {
    const state = armed(WP.MACHINEGUN);
    const events = run(state, 1, { buttons: BUTTON_USE_HOLDABLE | BUTTON_ATTACK });
    expect(events).toEqual([EV.USE_ITEM0]);
    expect(shots(events)).toBe(0);
  });

  it('refuses the medkit at max + 25, and keeps it in hand', () => {
    // "don't use medkit if at max health": the refusal raises nothing and clears nothing, and
    // does not set the latch — so with the key held, every command tries again (`:1559–1567`).
    const state = holding('holdable_medkit');
    state.stats[STAT.HEALTH] = 125;
    expect(run(state, 1, { buttons: BUTTON_USE_HOLDABLE })).toEqual([]);
    expect(state.stats[STAT.HOLDABLE_ITEM]).toBe(held('holdable_medkit'));
    expect(state.pmFlags & PMF_USE_ITEM_HELD).toBe(0);

    // One point under and it goes off, so the line is the ceiling and not the max.
    state.stats[STAT.HEALTH] = 124;
    expect(run(state, 1, { buttons: BUTTON_USE_HOLDABLE })).toEqual([EV.USE_ITEM0 + HI.MEDKIT]);
  });

  it('refuses the medkit at a fixed 125 under the fixed limits, whatever the handicap', () => {
    const state = holding('holdable_medkit');
    state.stats[STAT.MAX_HEALTH] = 50;
    state.stats[STAT.HEALTH] = 124;
    const use = createUserCmd({ buttons: BUTTON_USE_HOLDABLE, weapon: state.weapon });
    // id's line is 25 over the max health, which the handicap lowers.
    pmWeapon(state, use, TICK, { gauntletHit: false });
    expect(state.stats[STAT.HOLDABLE_ITEM]).toBe(held('holdable_medkit'));

    const fixed = { ...ID_RULES, g_fixedHealthLimits: 1 };
    state.stats[STAT.HEALTH] = 125;
    pmWeapon(state, use, TICK, { gauntletHit: false }, fixed);
    expect(state.stats[STAT.HOLDABLE_ITEM]).toBe(held('holdable_medkit'));
    state.stats[STAT.HEALTH] = 124;
    pmWeapon(state, use, TICK, { gauntletHit: false }, fixed);
    expect(state.stats[STAT.HOLDABLE_ITEM]).toBe(0);
  });

  it('uses the teleporter at any health', () => {
    const state = holding('holdable_teleporter');
    state.stats[STAT.HEALTH] = 125;
    expect(run(state, 1, { buttons: BUTTON_USE_HOLDABLE })).toEqual([
      EV.USE_ITEM0 + HI.TELEPORTER
    ]);
  });

  it('leaves a dead hand alone', () => {
    // The health check comes first, as it does in the C: a corpse uses nothing.
    const state = holding('holdable_medkit');
    state.stats[STAT.HEALTH] = 0;
    expect(run(state, 1, { buttons: BUTTON_USE_HOLDABLE })).toEqual([]);
    expect(state.stats[STAT.HOLDABLE_ITEM]).toBe(held('holdable_medkit'));
  });
});

describe("pmWeapon's pieces", () => {
  it('drop a weapon for the time the change is given', () => {
    const state = armed(WP.MACHINEGUN);
    beginWeaponChange(state, WP.ROCKET_LAUNCHER, 0);
    expect(state.weaponstate).toBe(WEAPON_DROPPING);
    expect(state.weaponTime).toBe(0);
  });

  it('hold an empty gun for the time the click is given', () => {
    const state = armed(WP.ROCKET_LAUNCHER);
    state.ammo[WP.ROCKET_LAUNCHER] = 0;
    expect(fireShot(state, false, 100)).toBe(false);
    expect(state.weaponTime).toBe(100);
  });
});

describe('pmWeapon switching', () => {
  it('changes weapon in 58 ticks: nominally 450 ms, measured 464', () => {
    // 200 ms drop + 250 ms raise (`PM_BeginWeaponChange` / `PM_FinishWeaponChange`), but
    // the timer is decremented before the gate and only acts at zero, so each phase costs
    // one tick more than the division suggests: 26 + 32 = 58 ticks = 464 ms. Measured from
    // the port and pinned; the nominal 450 is not reachable on an 8 ms tick.
    const state = armed(WP.MACHINEGUN);
    const events = run(state, 1, { weapon: WP.ROCKET_LAUNCHER });
    // `EV_CHANGE_WEAPON` carries no weapon: the one asked for is on the command, and the one
    // in hand does not change until the raise finishes.
    expect(events).toEqual([EV.CHANGE_WEAPON]);
    expect(state.weaponstate).toBe(WEAPON_DROPPING);
    // The old weapon is still held all through the drop — that is what a drop *is*.
    expect(state.weapon).toBe(WP.MACHINEGUN);

    run(state, 24, { weapon: WP.ROCKET_LAUNCHER });
    expect(state.weapon).toBe(WP.MACHINEGUN);

    // Tick 26: the drop expires and the new weapon is committed, then starts rising.
    run(state, 1, { weapon: WP.ROCKET_LAUNCHER });
    expect(state.weapon).toBe(WP.ROCKET_LAUNCHER);
    expect(state.weaponstate).toBe(WEAPON_RAISING);

    run(state, 31, { weapon: WP.ROCKET_LAUNCHER });
    expect(state.weaponstate).toBe(WEAPON_RAISING);

    // Tick 58.
    run(state, 1, { weapon: WP.ROCKET_LAUNCHER });
    expect(state.weaponstate).toBe(WEAPON_READY);
  });

  it('cannot fire during a switch', () => {
    const state = armed(WP.MACHINEGUN);
    const events = run(state, 57, { weapon: WP.ROCKET_LAUNCHER, buttons: BUTTON_ATTACK });
    expect(shots(events)).toBe(0);
    // And fires on the very next tick, once the raise completes.
    expect(shots(run(state, 2, { weapon: WP.ROCKET_LAUNCHER, buttons: BUTTON_ATTACK }))).toBe(1);
  });

  it('ignores a switch to a weapon the player does not own', () => {
    const state = armed(WP.MACHINEGUN);
    state.stats[STAT.WEAPONS] = 1 << WP.MACHINEGUN;
    const events = run(state, 10, { weapon: WP.BFG });
    expect(events).toEqual([]);
    expect(state.weapon).toBe(WP.MACHINEGUN);
  });

  it('ignores a switch to an invalid weapon id', () => {
    const state = armed(WP.MACHINEGUN);
    expect(run(state, 10, { weapon: 99 })).toEqual([]);
    expect(state.weapon).toBe(WP.MACHINEGUN);
  });

  it('does not restart a drop already in progress', () => {
    // Spamming select must not stack drop times, or a weapon could never come up.
    const state = armed(WP.MACHINEGUN);
    run(state, 1, { weapon: WP.ROCKET_LAUNCHER });
    const timeAfterFirst = state.weaponTime;
    run(state, 1, { weapon: WP.ROCKET_LAUNCHER });
    expect(state.weaponTime).toBe(timeAfterFirst - TICK);
  });

  it('will not start a switch mid-shot, only mid-cooldown', () => {
    // The change check excludes WEAPON_FIRING specifically, so the shot's own interval is
    // never interrupted — but a queued switch does start once the state leaves FIRING.
    const state = armed(WP.ROCKET_LAUNCHER);
    run(state, 1, { buttons: BUTTON_ATTACK });
    expect(state.weaponstate).toBe(WEAPON_FIRING);

    const events = run(state, 1, { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
    expect(events).toEqual([]);
    expect(state.weaponstate).toBe(WEAPON_FIRING);
  });
});

describe('pmWeapon rules', () => {
  const rules = {
    ...ID_RULES,
    pmove_WeaponDropTime: 0,
    pmove_WeaponRaiseTime: 0,
    pmove_WeaponNoAmmoTime: 200,
    weapon_reload_lg: 66,
    weapon_hasteFactor: 2
  };
  const tick = (state: PlayerState, buttons: number, weapon = state.weapon) =>
    pmWeapon(state, createUserCmd({ buttons, weapon }), TICK, { gauntletHit: false }, rules);

  it('reads its times from the rules', () => {
    const lightning = armed(WP.LIGHTNING);
    tick(lightning, BUTTON_ATTACK);
    expect(lightning.weaponTime).toBe(66);

    const hasted = armed(WP.LIGHTNING);
    hasted.powerups[PW.HASTE] = 1;
    tick(hasted, BUTTON_ATTACK);
    expect(hasted.weaponTime).toBe(33);

    const empty = armed(WP.ROCKET_LAUNCHER);
    empty.ammo[WP.ROCKET_LAUNCHER] = 0;
    tick(empty, BUTTON_ATTACK);
    expect(empty.weaponTime).toBe(200);

    // With no drop and no raise, a change is up on the tick after it begins.
    const changing = armed(WP.ROCKET_LAUNCHER);
    tick(changing, 0, WP.SHOTGUN);
    tick(changing, 0, WP.SHOTGUN);
    expect([changing.weapon, changing.weaponstate]).toEqual([WP.SHOTGUN, WEAPON_READY]);
  });
});
