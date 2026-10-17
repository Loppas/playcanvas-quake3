import { describe, expect, it } from 'vitest';
import type { PlayerState } from '../../net/protocol';
import { BUTTON_ATTACK, BUTTON_USE_HOLDABLE, EF_TALK, STAT } from '../constants';
import { EV, eventsSince } from '../events';
import { PW, findItem, itemIndex } from '../items';
import type { Rules } from '../rules';
import { presetRules } from '../rules-test-fixtures';
import { createArmedPlayerState, createUserCmd } from '../types';
import { WEAPON_DROPPING, WEAPON_FIRING, WEAPON_RAISING, WEAPON_READY, WP } from './constants';
import { pmWeapon } from './weapon-state';
import { pmWeaponCpma } from './weapon-state-cpma';

/**
 * CPMA's weapon step, run with each ruleset's shipped preset. At the port's 8 ms tick a phase of
 * `t` ms costs ⌈t / 8⌉ + 1 ticks, so a change under id's 200 and 250 is ready on the 58th tick.
 */

const TICK = 8;

const VQ3 = presetRules('vq3');
const PMC = presetRules('pmc');
const CPM = presetRules('cpm');
const CQ3 = presetRules('cq3');
const DEV = presetRules('dev');
const PRESETS = { VQ3, PMC, CPM, CQ3, DEV };

/** Each preset's answer to `measure`, by the preset's name. */
function byPreset<T>(measure: (rules: Rules) => T): Record<keyof typeof PRESETS, T> {
  const entries = Object.entries(PRESETS).map(([name, rules]) => [name, measure(rules)]);
  return Object.fromEntries(entries) as Record<keyof typeof PRESETS, T>;
}

/** A command: the buttons held, and the weapon asked for, which is the one in hand by default. */
interface Held {
  buttons?: number;
  weapon?: number;
}

/**
 * Run ticks of CPMA's step under `rules`.
 *
 * @returns The events the ticks raised, taken after each, since the ring is two deep.
 */
function run(
  state: PlayerState,
  rules: Rules,
  ticks: number,
  held: Held = {},
  countdown = false
): number[] {
  const events: number[] = [];
  const cmd = createUserCmd({ buttons: held.buttons ?? 0, weapon: held.weapon ?? state.weapon });
  for (let i = 0; i < ticks; i++) {
    const before = state.eventSequence;
    pmWeaponCpma(state, cmd, TICK, { gauntletHit: true, countdown }, rules);
    events.push(...eventsSince(state, before).map(({ event }) => event));
  }
  return events;
}

/** The tick, counting from 1, on which the first shot goes off; 0 for none in 400. */
function shotTick(state: PlayerState, rules: Rules, held: Held): number {
  for (let tick = 1; tick <= 400; tick++) {
    if (run(state, rules, 1, held).includes(EV.FIRE_WEAPON)) return tick;
  }
  return 0;
}

/** The tick, counting from 1, on which `weapon` is up and ready; 0 for never in 400. */
function readyTick(state: PlayerState, rules: Rules, weapon: number): number {
  for (let tick = 1; tick <= 400; tick++) {
    run(state, rules, 1, { weapon });
    if (state.weapon === weapon && state.weaponstate === WEAPON_READY) return tick;
  }
  return 0;
}

/** The ticks from each shot to the next, over `count` shots of held fire. */
function gaps(state: PlayerState, rules: Rules, count: number): number[] {
  const ticks: number[] = [];
  for (let tick = 1; ticks.length < count && tick < 10_000; tick++) {
    if (run(state, rules, 1, { buttons: BUTTON_ATTACK }).includes(EV.FIRE_WEAPON)) ticks.push(tick);
  }
  return ticks.slice(1).map((tick, i) => tick - ticks[i]);
}

/** A player holding `weapon`, ready, who owns every weapon and never runs out. */
function armed(weapon: number): PlayerState {
  return createArmedPlayerState({ weapon, weaponstate: WEAPON_READY });
}

/** A stretch of the equivalence test's script. */
interface Step extends Held {
  ticks: number;
  haste?: boolean;
  talk?: boolean;
  countdown?: boolean;
}

describe("CPMA's weapon step", () => {
  it("is id's step under VQ3's preset", () => {
    // Every branch of id's: shots, a change held off by a shot, an empty clip, a change to a
    // weapon not held, haste, talking, a countdown and the gauntlet.
    const script: Step[] = [
      { ticks: 30, buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN },
      { ticks: 70, buttons: BUTTON_ATTACK, weapon: WP.SHOTGUN },
      { ticks: 400, buttons: BUTTON_ATTACK, weapon: WP.SHOTGUN },
      { ticks: 5, weapon: WP.ROCKET_LAUNCHER },
      { ticks: 40, weapon: WP.BFG },
      { ticks: 80, buttons: BUTTON_ATTACK, weapon: WP.RAILGUN },
      { ticks: 300, buttons: BUTTON_ATTACK, weapon: WP.RAILGUN, haste: true },
      { ticks: 20, buttons: BUTTON_ATTACK, weapon: WP.RAILGUN, talk: true },
      { ticks: 20, buttons: BUTTON_ATTACK, weapon: WP.PLASMAGUN, countdown: true },
      { ticks: 100, buttons: BUTTON_ATTACK, weapon: WP.GAUNTLET }
    ];
    const ids = armed(WP.MACHINEGUN);
    const cpma = armed(WP.MACHINEGUN);
    for (const state of [ids, cpma]) {
      state.ammo[WP.SHOTGUN] = 3;
      state.stats[STAT.WEAPONS] &= ~(1 << WP.BFG);
    }

    for (const step of script) {
      for (const state of [ids, cpma]) {
        state.powerups[PW.HASTE] = step.haste ? 1 : 0;
        state.eFlags = step.talk ? state.eFlags | EF_TALK : state.eFlags & ~EF_TALK;
      }
      const cmd = createUserCmd({ buttons: step.buttons ?? 0, weapon: step.weapon });
      const input = { gauntletHit: true, countdown: step.countdown };
      for (let i = 0; i < step.ticks; i++) {
        pmWeapon(ids, cmd, TICK, input, VQ3);
        pmWeaponCpma(cpma, cmd, TICK, input, VQ3);
        expect(cpma).toEqual(ids);
      }
    }
  });

  it("reloads each weapon in each preset's time", () => {
    const weapons = [
      WP.GAUNTLET,
      WP.MACHINEGUN,
      WP.SHOTGUN,
      WP.GRENADE_LAUNCHER,
      WP.ROCKET_LAUNCHER,
      WP.LIGHTNING,
      WP.RAILGUN,
      WP.PLASMAGUN,
      WP.BFG
    ];
    const reloads = byPreset((rules) =>
      weapons.map((weapon) => {
        const state = armed(weapon);
        run(state, rules, 1, { buttons: BUTTON_ATTACK });
        return state.weaponTime;
      })
    );
    // CQ3's railgun is its switch time: its reload is the rail timer's.
    expect(reloads).toEqual({
      VQ3: [400, 100, 1000, 800, 800, 50, 1500, 100, 200],
      PMC: [400, 100, 1000, 700, 800, 50, 1500, 100, 800],
      CPM: [400, 100, 1000, 800, 800, 66, 1250, 100, 1000],
      CQ3: [400, 100, 1000, 800, 800, 66, 1000, 100, 1250],
      DEV: [400, 100, 1000, 800, 800, 66, 1250, 100, 1000]
    });
  });

  it("clicks an empty weapon for each preset's out-of-ammo time", () => {
    const clicks = byPreset((rules) => {
      const state = armed(WP.ROCKET_LAUNCHER);
      state.ammo[WP.ROCKET_LAUNCHER] = 0;
      return [run(state, rules, 1, { buttons: BUTTON_ATTACK }), state.weaponTime];
    });
    expect(clicks).toEqual({
      VQ3: [[EV.NOAMMO], 500],
      PMC: [[EV.NOAMMO], 100],
      CPM: [[EV.NOAMMO], 200],
      CQ3: [[EV.NOAMMO], 500],
      DEV: [[EV.NOAMMO], 200]
    });
  });

  it("changes weapon in each preset's drop and raise", () => {
    // From the rocket launcher to the shotgun with attack held. With neither a drop nor a raise,
    // the change is one tick, the raise's end the next, and the shot the third.
    const held = { buttons: BUTTON_ATTACK, weapon: WP.SHOTGUN };
    const shots = byPreset((rules) => shotTick(armed(WP.ROCKET_LAUNCHER), rules, held));
    expect(shots).toEqual({ VQ3: 59, PMC: 3, CPM: 3, CQ3: 59, DEV: 3 });
  });

  it('locks every change after a shot until the lock runs out', () => {
    const locks = byPreset((rules) => {
      const state = armed(WP.ROCKET_LAUNCHER);
      run(state, rules, 1, { buttons: BUTTON_ATTACK });
      return state.stats[STAT.WEAPON_LOCK];
    });
    expect(locks).toEqual({ VQ3: 0, PMC: 100, CPM: 100, CQ3: 100, DEV: 100 });

    // Off the lightning gun under CPM: its 66 lets the change begin on the 10th tick, and the lock
    // holds the finish to the 14th, 104 ms after the shot rather than 72.
    const held = { buttons: BUTTON_ATTACK, weapon: WP.ROCKET_LAUNCHER };
    const locked = armed(WP.LIGHTNING);
    run(locked, CPM, 1, { buttons: BUTTON_ATTACK });
    expect(shotTick(locked, CPM, held)).toBe(15);
    const free = armed(WP.LIGHTNING);
    const unlocked = { ...CPM, pmove_WeaponLockTime: 0 };
    run(free, unlocked, 1, { buttons: BUTTON_ATTACK });
    expect(shotTick(free, unlocked, held)).toBe(11);

    // It holds no shot of the weapon in hand: the lightning gun still fires on its 66.
    expect(gaps(armed(WP.LIGHTNING), CPM, 5)).toEqual([9, 8, 8, 8]);
  });

  it('takes the upgrade lock only where a change up from the gauntlet or machinegun begins', () => {
    // A change to the machinegun, turned to the rocket launcher in the drop, takes none.
    const turned = armed(WP.GAUNTLET);
    turned.stats[STAT.UPGRADE_RAISED] = 1;
    run(turned, CQ3, 10, { weapon: WP.MACHINEGUN });
    run(turned, CQ3, 1, { weapon: WP.ROCKET_LAUNCHER });
    expect(turned.stats[STAT.WEAPON_LOCK]).toBe(0);

    // Nor does one begun while a longer lock after a shot still runs: it runs on as it was.
    const shot = armed(WP.MACHINEGUN);
    shot.stats[STAT.UPGRADE_RAISED] = 1;
    const long = { ...CPM, pmove_WeaponLockTime: 200 };
    run(shot, long, 1, { buttons: BUTTON_ATTACK });
    run(shot, long, 13, { weapon: WP.ROCKET_LAUNCHER });
    expect(shot.stats[STAT.WEAPON_LOCK]).toBe(96);

    // Nor one up from the shotgun. Weapons are told by number, so the grapple is up.
    const locks = [WP.SHOTGUN, WP.MACHINEGUN].map((from) => {
      const state = armed(from);
      state.stats[STAT.UPGRADE_RAISED] = 1;
      const to = from === WP.SHOTGUN ? WP.ROCKET_LAUNCHER : WP.GRAPPLING_HOOK;
      run(state, CPM, 1, { weapon: to });
      return state.stats[STAT.WEAPON_LOCK];
    });
    expect(locks).toEqual([0, 200]);
  });

  it('locks a change up from the machinegun once a better weapon has been raised', () => {
    // After a spawn: up to the rocket launcher, down to the machinegun, and up again. Only the
    // second change up takes the 200, which CQ3's drop hides. id's changes after the first come up
    // a tick sooner, on the overshoot the last one carried.
    const changes = byPreset((rules) => {
      const state = armed(WP.MACHINEGUN);
      const first = readyTick(state, rules, WP.ROCKET_LAUNCHER);
      const second = readyTick(state, rules, WP.MACHINEGUN);
      run(state, rules, 1, { weapon: WP.ROCKET_LAUNCHER });
      const lock = state.stats[STAT.WEAPON_LOCK];
      const third = 1 + readyTick(state, rules, WP.ROCKET_LAUNCHER);
      return [first, second, third, lock, state.stats[STAT.UPGRADE_RAISED]];
    });
    expect(changes).toEqual({
      VQ3: [58, 57, 57, 0, 0],
      PMC: [2, 2, 27, 200, 1],
      CPM: [2, 2, 27, 200, 1],
      CQ3: [58, 57, 57, 200, 1],
      DEV: [2, 2, 27, 200, 1]
    });
  });

  it('refires the railgun on its own timer, which carries no overshoot', () => {
    // PMC's 1500 is 188 ticks every time, where id's alternates 188 and 187. CPM's 1250 is 157.
    const refires = byPreset((rules) => gaps(armed(WP.RAILGUN), rules, 4));
    expect(refires).toEqual({
      VQ3: [188, 187, 188],
      PMC: [188, 188, 188],
      CPM: [157, 157, 157],
      CQ3: [188, 188, 188],
      DEV: [157, 157, 157]
    });
  });

  it("lets a change away from the railgun begin at CQ3's switch time", () => {
    const state = armed(WP.RAILGUN);
    run(state, CQ3, 1, { buttons: BUTTON_ATTACK });
    expect(state.weaponTime).toBe(1000);
    expect(state.stats[STAT.RAIL_TIME]).toBe(1500);
    // 1000 ms is out on the 126th tick.
    expect(run(state, CQ3, 124, { weapon: WP.ROCKET_LAUNCHER })).toEqual([]);
    expect(run(state, CQ3, 1, { weapon: WP.ROCKET_LAUNCHER })).toEqual([EV.CHANGE_WEAPON]);
  });

  it('runs the rail timer while the railgun is holstered, and brings it up once it is out', () => {
    const state = armed(WP.ROCKET_LAUNCHER);
    state.stats[STAT.RAIL_TIME] = 400;
    run(state, CPM, 10);
    expect(state.stats[STAT.RAIL_TIME]).toBe(320);

    run(state, CPM, 1, { weapon: WP.RAILGUN });
    expect(state.weapon).toBe(WP.RAILGUN);
    run(state, CPM, 38, { weapon: WP.RAILGUN });
    expect(state.weaponstate).toBe(WEAPON_RAISING);
    run(state, CPM, 1, { weapon: WP.RAILGUN });
    expect(state.weaponstate).toBe(WEAPON_READY);
  });

  it("shortens the weapon's times by each preset's haste factor", () => {
    // A rocket's reload, and the lock after it. CQ3 spares the reload and shortens the lock.
    const hasted = byPreset((rules) => {
      const state = armed(WP.ROCKET_LAUNCHER);
      state.powerups[PW.HASTE] = 1;
      run(state, rules, 1, { buttons: BUTTON_ATTACK });
      return [state.weaponTime, state.stats[STAT.WEAPON_LOCK]];
    });
    expect(hasted).toEqual({
      VQ3: [615, 0],
      PMC: [800, 100],
      CPM: [800, 100],
      CQ3: [800, 75],
      DEV: [800, 100]
    });

    // Under CQ3 every hasted shot shortens the rail timer, whichever weapon fires it.
    const railgun = armed(WP.RAILGUN);
    railgun.powerups[PW.HASTE] = 1;
    run(railgun, CQ3, 1, { buttons: BUTTON_ATTACK });
    expect(railgun.weaponTime).toBe(1000);
    expect(railgun.stats[STAT.RAIL_TIME]).toBe(1127);
    const rocket = armed(WP.ROCKET_LAUNCHER);
    rocket.powerups[PW.HASTE] = 1;
    rocket.stats[STAT.RAIL_TIME] = 1008;
    run(rocket, CQ3, 1, { buttons: BUTTON_ATTACK });
    expect(rocket.stats[STAT.RAIL_TIME]).toBe(751);
  });

  it('changes weapon with no drop and no raise under haste, under CQ3', () => {
    const held = { buttons: BUTTON_ATTACK, weapon: WP.SHOTGUN };
    const shots = byPreset((rules) => {
      const state = armed(WP.ROCKET_LAUNCHER);
      state.powerups[PW.HASTE] = 1;
      return shotTick(state, rules, held);
    });
    expect(shots).toEqual({ VQ3: 59, PMC: 3, CPM: 3, CQ3: 3, DEV: 3 });
  });

  it("refuses the medkit at 25 over each preset's health limit", () => {
    const medkit = itemIndex(findItem('holdable_medkit')!);
    const uses = (rules: Rules, health: number) => {
      const state = armed(WP.MACHINEGUN);
      state.stats[STAT.MAX_HEALTH] = 50;
      state.stats[STAT.HEALTH] = health;
      state.stats[STAT.HOLDABLE_ITEM] = medkit;
      run(state, rules, 1, { buttons: BUTTON_USE_HOLDABLE });
      return state.stats[STAT.HOLDABLE_ITEM] === 0;
    };
    // A handicap of 50 puts id's line at 75, and CPMA's is 125 whatever the handicap.
    expect(byPreset((rules) => [uses(rules, 74), uses(rules, 124), uses(rules, 125)])).toEqual({
      VQ3: [true, false, false],
      PMC: [true, true, false],
      CPM: [true, true, false],
      CQ3: [true, true, false],
      DEV: [true, true, false]
    });
  });

  it('stops while talking, timers and all', () => {
    const talking = byPreset((rules) => {
      const state = armed(WP.ROCKET_LAUNCHER);
      run(state, rules, 1, { buttons: BUTTON_ATTACK });
      state.eFlags |= EF_TALK;
      run(state, rules, 10, { buttons: BUTTON_ATTACK });
      return [state.weaponTime, state.stats[STAT.WEAPON_LOCK]];
    });
    expect(talking).toEqual({
      VQ3: [720, 0],
      PMC: [800, 100],
      CPM: [800, 100],
      CQ3: [800, 100],
      DEV: [800, 100]
    });
  });

  it('holds the trigger while a round counts down, and nothing else', () => {
    const counting = byPreset((rules) => {
      const state = armed(WP.ROCKET_LAUNCHER);
      state.ammo[WP.ROCKET_LAUNCHER] = 5;
      const events = run(state, rules, 10, { buttons: BUTTON_ATTACK }, true);
      return [events, state.ammo[WP.ROCKET_LAUNCHER], state.weaponstate, state.weaponTime];
    });
    const held = [[], 5, WEAPON_READY, 0];
    expect(counting).toEqual({
      VQ3: [[EV.FIRE_WEAPON], 4, WEAPON_FIRING, 728],
      PMC: held,
      CPM: held,
      CQ3: held,
      DEV: held
    });

    const state = armed(WP.ROCKET_LAUNCHER);
    const change = { buttons: BUTTON_ATTACK, weapon: WP.SHOTGUN };
    expect(run(state, CPM, 1, change, true)).toEqual([EV.CHANGE_WEAPON]);
  });

  it('leaves a change to a weapon not held unfinished under the lock', () => {
    // A change up from the machinegun, held by the drop or the upgrade lock, and the command asks
    // for the BFG before it finishes. id's raises an empty hand.
    const changes = byPreset((rules) => {
      const state = armed(WP.MACHINEGUN);
      state.stats[STAT.WEAPONS] &= ~(1 << WP.BFG);
      state.stats[STAT.UPGRADE_RAISED] = 1;
      run(state, rules, 1, { weapon: WP.ROCKET_LAUNCHER });
      run(state, rules, 30, { weapon: WP.BFG });
      const asked = [state.weapon, state.weaponstate];
      // Asked for one held again, the change finishes.
      run(state, rules, 1, { weapon: WP.SHOTGUN });
      return [...asked, state.weapon];
    });
    expect(changes).toEqual({
      VQ3: [WP.NONE, WEAPON_RAISING, WP.NONE],
      PMC: [WP.NONE, WEAPON_DROPPING, WP.SHOTGUN],
      CPM: [WP.NONE, WEAPON_DROPPING, WP.SHOTGUN],
      CQ3: [WP.NONE, WEAPON_DROPPING, WP.SHOTGUN],
      DEV: [WP.NONE, WEAPON_DROPPING, WP.SHOTGUN]
    });
  });
});
