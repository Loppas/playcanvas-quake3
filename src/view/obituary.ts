import type { Gender } from '../formats/animation-config';
import { CONFIGSTRING } from '../net/commands';
import { infoValueForKey } from '../net/info';
import { MAX_CLIENTS } from '../net/protocol';
import { GT, MOD } from '../sim/constants';
import { placeString } from './place-string';

/**
 * `CG_Obituary` (`cg_event.c:82–335`): the line a death prints on every client, from the obituary
 * the server broadcasts. Engine-free.
 *
 * The line names the dead and, where another client killed them, the killer, each in their own
 * colours and white after. A death by the player's own hand is told in their model's gender.
 *
 * Q3 also puts "You fragged" and the killer's place in the middle of the killer's screen
 * ({@link fragMessage}), and keeps the killer's name for the dead's scoreboard
 * ({@link killerName}).
 */

/** The deaths told the same way whoever caused them (`cg_event.c:121–149`). */
const SINGLE_MESSAGES: Readonly<Partial<Record<number, string>>> = {
  [MOD.SUICIDE]: 'suicides',
  [MOD.FALLING]: 'cratered',
  [MOD.CRUSH]: 'was squished',
  [MOD.WATER]: 'sank like a rock',
  [MOD.SLIME]: 'melted',
  [MOD.LAVA]: 'does a back flip into the lava',
  [MOD.TARGET_LASER]: 'saw the light',
  [MOD.TRIGGER_HURT]: 'was in the wrong place'
};

/** Him, her or it, as `gender_t` picks (`cg_event.c:151–206`). */
function pronoun(gender: Gender, male: string, female: string, neuter: string): string {
  return gender === 'female' ? female : gender === 'neuter' ? neuter : male;
}

/** A death by the player's own hand, told in their gender (`cg_event.c:151–206`). */
function selfMessage(mod: number, gender: Gender): string {
  switch (mod) {
    case MOD.GRENADE_SPLASH:
      return `tripped on ${pronoun(gender, 'his', 'her', 'its')} own grenade`;
    case MOD.ROCKET_SPLASH:
      return `blew ${pronoun(gender, 'himself', 'herself', 'itself')} up`;
    case MOD.PLASMA_SPLASH:
      return `melted ${pronoun(gender, 'himself', 'herself', 'itself')}`;
    case MOD.BFG_SPLASH:
      return 'should have used a smaller gun';
    default:
      return `killed ${pronoun(gender, 'himself', 'herself', 'itself')}`;
  }
}

/**
 * A death at another client's hand: what comes before the killer's name, and after it
 * (`cg_event.c:248–324`).
 */
function killMessage(mod: number): [string, string] {
  switch (mod) {
    case MOD.GRAPPLE:
      return ['was caught by', ''];
    case MOD.GAUNTLET:
      return ['was pummeled by', ''];
    case MOD.MACHINEGUN:
      return ['was machinegunned by', ''];
    case MOD.SHOTGUN:
      return ['was gunned down by', ''];
    case MOD.GRENADE:
      return ['ate', "'s grenade"];
    case MOD.GRENADE_SPLASH:
      return ['was shredded by', "'s shrapnel"];
    case MOD.ROCKET:
      return ['ate', "'s rocket"];
    case MOD.ROCKET_SPLASH:
      return ['almost dodged', "'s rocket"];
    case MOD.PLASMA:
    case MOD.PLASMA_SPLASH:
      return ['was melted by', "'s plasmagun"];
    case MOD.RAILGUN:
      return ['was railed by', ''];
    case MOD.LIGHTNING:
      return ['was electrocuted by', ''];
    case MOD.BFG:
    case MOD.BFG_SPLASH:
      return ['was blasted by', "'s BFG"];
    case MOD.TELEFRAG:
      return ['tried to invade', "'s personal space"];
    default:
      return ['was killed by', ''];
  }
}

/**
 * A name as the obituary prints it: `Q_strncpyz` into 30 bytes less the 2 the white takes, so the
 * first 29 characters, and white after them, whatever colour the name ended in.
 */
function obituaryName(info: string): string {
  return `${infoValueForKey(info, 'n').slice(0, 29)}^7`;
}

/**
 * The killer's name as `CG_Obituary` keeps it for the scoreboard (`cg_event.c:240–245`): the name
 * with white after it, as the line prints it.
 *
 * @param attacker - `otherEntityNum2`: who killed them, or the world's number for anything else.
 * @returns the name, or `null` when the killer is not a client — the world, which is never named.
 */
export function killerName(attacker: number, configstring: (index: number) => string): string | null {
  if (attacker < 0 || attacker >= MAX_CLIENTS) return null;
  return obituaryName(configstring(CONFIGSTRING.PLAYERS + attacker));
}

/**
 * `CG_Obituary`'s word to the killer (`cg_event.c:212–231`): "You fragged" and whom, and below a
 * team game the place the kill leaves them in, raised in the middle of their screen.
 *
 * Only a kill by somebody else earns it. A death the line tells in a word of its own — a fall,
 * the lava, the player's own hand — has been told and returned from before it is reached.
 *
 * @param own - `cg.snap->ps.clientNum`: whose screen this is.
 * @param gametype - `cgs.gametype`, which decides whether there is a place to tell.
 * @param rank - `PERS_RANK` as the snapshot carrying the obituary has it, the kill counted.
 * @param score - `PERS_SCORE`, the same.
 * @returns the message, or `null` when this client did not make the kill.
 */
export function fragMessage(
  mod: number,
  target: number,
  attacker: number,
  own: number,
  configstring: (index: number) => string,
  gametype: number,
  rank: number,
  score: number
): string | null {
  if (target < 0 || target >= MAX_CLIENTS) return null;
  if (attacker === target || SINGLE_MESSAGES[mod] !== undefined) return null;
  if (attacker !== own) return null;
  const targetName = obituaryName(configstring(CONFIGSTRING.PLAYERS + target));
  if (gametype >= GT.TEAM) return `You fragged ${targetName}`;
  return `You fragged ${targetName}\n${placeString(rank + 1)} place with ${score}`;
}

/**
 * What `CG_Obituary` prints for one obituary, its newline and all.
 *
 * A slot nobody is in still has a string, the empty one, so a death there is told with no name,
 * as Q3's is: its "no string" test can never pass. A target that is no client at all is an error
 * that stops Q3's cgame; here it prints nothing.
 *
 * @param mod - `eventParm`: the means of death.
 * @param target - `otherEntityNum`: who died.
 * @param attacker - `otherEntityNum2`: who killed them, or the world's number for anything else.
 * @param configstring - `CG_ConfigString`, for each client's `CS_PLAYERS` string.
 * @param gender - `ci->gender`, which only a death by the player's own hand reads.
 * @returns the line, or `null` for none.
 */
export function obituary(
  mod: number,
  target: number,
  attacker: number,
  configstring: (index: number) => string,
  gender: (clientNum: number) => Gender
): string | null {
  if (target < 0 || target >= MAX_CLIENTS) return null;
  const attackerInfo =
    attacker >= 0 && attacker < MAX_CLIENTS ? configstring(CONFIGSTRING.PLAYERS + attacker) : null;
  const targetName = obituaryName(configstring(CONFIGSTRING.PLAYERS + target));

  let message = SINGLE_MESSAGES[mod] ?? null;
  if (attacker === target) message = selfMessage(mod, gender(target));
  if (message) return `${targetName} ${message}.\n`;

  // Only a client has a string, so this is Q3's test that the killer is not the world.
  if (attackerInfo !== null) {
    const [before, after] = killMessage(mod);
    return `${targetName} ${before} ${obituaryName(attackerInfo)}${after}\n`;
  }

  // "we don't know what it was"
  return `${targetName} died.\n`;
}
