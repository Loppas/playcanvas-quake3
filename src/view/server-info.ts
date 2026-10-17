import { atof, atoi } from '../formats/c-scan';
import { infoValueForKey } from '../net/info';
import { AMMO_SUFFIX } from '../sim/items';
import { HITSCAN_RULES, ID_RULES, ruleValue, type HitscanRules } from '../sim/rules';
import { MAX_WEAPONS } from '../sim/weapons/constants';
import { ID_SHOTGUN, type ShotgunRules } from '../sim/weapons/hitscan';
import { ID_MISSILE_LOOKS, type MissileLooks } from './effects';

/**
 * `CG_ParseServerinfo` (`cg_servercmds.c:155–174`): what the client reads out of `CS_SERVERINFO`,
 * which the host writes from the serverinfo cvars at a map load.
 */

/** The serverinfo the HUD draws from, and the announcer's limits. */
export interface ServerInfo {
  /** `g_gametype`, which decides the score area's two halves. */
  readonly gametype: number;
  /** `fraglimit`: the score that ends a match, or 0 for none. */
  readonly fraglimit: number;
  /** `timelimit`: the minutes a match runs for, or 0 for none. */
  readonly timelimit: number;
  /** `capturelimit`: the captures that end a CTF match, or 0 for none. */
  readonly capturelimit: number;
  /** `roundlimit`: the rounds that end a Clan Arena match, or 0 for none. */
  readonly roundlimit: number;
  /** `sv_maxclients`: the match's slots, which the latched cvar may since have moved past. */
  readonly maxclients: number;
  /** The shotgun's pattern, which a blast is drawn by: id's where the string does not say. */
  readonly shotgun: Readonly<ShotgunRules>;
  /**
   * The rest of the hitscan weapons' numbers, which the player's own shots are drawn by before the
   * server answers them: id's where the string does not say.
   */
  readonly hitscan: Readonly<HitscanRules>;
  /** How the plasma and the BFG's impact are drawn: id's where the string does not say. */
  readonly missiles: Readonly<MissileLooks>;
  /** `g_lowAmmo_<w>` by weapon: the ammo the HUD warns under, 0 where the string does not say. */
  readonly lowAmmo: readonly number[];
}

/** A key's number, or `fallback` where the string does not carry the key. */
function numberOr(
  configstring: string,
  key: string,
  read: (text: string) => number,
  fallback: number
): number {
  const text = infoValueForKey(configstring, key);
  return text === '' ? fallback : read(text);
}

/**
 * Read the serverinfo string.
 *
 * @param configstring - `CS_SERVERINFO`.
 * @returns the fields the client reads, each 0 when the string does not carry it.
 */
export function serverInfo(configstring: string): ServerInfo {
  return {
    gametype: atoi(infoValueForKey(configstring, 'g_gametype')),
    fraglimit: atoi(infoValueForKey(configstring, 'fraglimit')),
    timelimit: atoi(infoValueForKey(configstring, 'timelimit')),
    capturelimit: atoi(infoValueForKey(configstring, 'capturelimit')),
    roundlimit: atoi(infoValueForKey(configstring, 'roundlimit')),
    maxclients: atoi(infoValueForKey(configstring, 'sv_maxclients')),
    shotgun: {
      pattern: numberOr(configstring, 'g_pattern_sg', atoi, ID_SHOTGUN.pattern),
      pellets: numberOr(configstring, 'g_pellets_sg', atoi, ID_SHOTGUN.pellets),
      spread: numberOr(configstring, 'g_spread_sg', atof, ID_SHOTGUN.spread)
    },
    hitscan: hitscanRules(configstring),
    missiles: {
      plasmaSize: numberOr(configstring, 'g_plasmaSize', atof, ID_MISSILE_LOOKS.plasmaSize),
      plasmaMarkSize: numberOr(
        configstring,
        'g_plasmaMarkSize',
        atof,
        ID_MISSILE_LOOKS.plasmaMarkSize
      ),
      bfgSplashRadius: numberOr(
        configstring,
        'g_splashradius_bfg',
        atoi,
        ID_MISSILE_LOOKS.bfgSplashRadius
      )
    },
    lowAmmo: lowAmmoMarks(configstring)
  };
}

/** The hitscan rules, each read as its cvar is, and id's where the string does not carry it. */
function hitscanRules(configstring: string): HitscanRules {
  const rules = {} as HitscanRules;
  for (const name of HITSCAN_RULES) {
    rules[name] = numberOr(configstring, name, (text) => ruleValue(name, text), ID_RULES[name]);
  }
  return rules;
}

/** Each weapon's low-ammo mark, and 0 for the weapons without one. */
function lowAmmoMarks(configstring: string): number[] {
  const marks = new Array<number>(MAX_WEAPONS).fill(0);
  for (const [weapon, suffix] of AMMO_SUFFIX) {
    marks[weapon] = atoi(infoValueForKey(configstring, `g_lowAmmo_${suffix}`));
  }
  return marks;
}
