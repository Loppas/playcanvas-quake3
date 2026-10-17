import { TEAM } from './constants';
import type { ArenaLoadout } from './player-life';
import { WP } from './weapons/constants';

/**
 * CPMA's Clan Arena: the rules of its built-in mode, on Quake 3's own movement, weapons and damage.
 *
 * The values are the mode's, not settings. CPMA changes them only by its votes and its custom
 * modes, so the one setting the mode reads is `roundlimit`.
 */

/**
 * What every spawn is given: each weapon but the BFG, with the mode's `ammo` line (`MG SG GL RL
 * LG RG PG`), the rocket launcher in hand, 100 health and 150 armour. The armour drains back to
 * the max health as any does.
 */
export const CA_LOADOUT: ArenaLoadout = {
  ammo: [
    [WP.MACHINEGUN, 200],
    [WP.SHOTGUN, 50],
    [WP.GRENADE_LAUNCHER, 15],
    [WP.ROCKET_LAUNCHER, 50],
    [WP.LIGHTNING, 150],
    [WP.RAILGUN, 15],
    [WP.PLASMAGUN, 50]
  ],
  weapon: WP.ROCKET_LAUNCHER,
  health: 100,
  armor: 150
};

/**
 * `maxdamage`: the most armour a hit on yourself or a teammate takes. Such a hit takes no health
 * (`selfdamage 2`, `teamdamage 2`), so once the armour is gone it takes nothing.
 */
export const CA_MAX_DAMAGE = 25;

/** `roundwarmup`: the countdown before each round, whose start respawns everyone on a side. */
export const CA_ROUND_WARMUP = 10_000;

/**
 * How long after a side is first found with nobody alive the round's result is read. Both sides
 * out by then is a draw, so a rocket that kills its shooter inside it takes the win away.
 */
export const CA_WIN_DELAY = 1000;

/** The sides as a round's result names them. */
export const CA_TEAM_NAMES: Readonly<Record<number, string>> = {
  [TEAM.RED]: '^1RED^7',
  [TEAM.BLUE]: '^4BLUE^7'
};
