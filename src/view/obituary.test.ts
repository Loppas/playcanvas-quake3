import { describe, expect, it } from 'vitest';

import type { Gender } from '../formats/animation-config';
import { CONFIGSTRING } from '../net/commands';
import { ENTITYNUM_NONE, ENTITYNUM_WORLD, MAX_CLIENTS } from '../net/protocol';
import { GT, MOD, RANK_TIED_FLAG } from '../sim/constants';
import { fragMessage, killerName, obituary } from './obituary';

/** Who is in each slot: Visor in 0 and a red Sarge in 1, and nobody else. */
const NAMES: readonly string[] = ['Visor', '^1Sarge'];

/** `CG_ConfigString` for the players: an empty string for a slot nobody is in. */
function configstring(index: number): string {
  const name = NAMES[index - CONFIGSTRING.PLAYERS];
  return name === undefined ? '' : `n\\${name}\\t\\0`;
}

const VISOR = 0;
const SARGE = 1;

/** The line for a death, with the dead in a gender. */
function line(mod: number, target: number, attacker: number, gender: Gender = 'male') {
  return obituary(mod, target, attacker, configstring, () => gender);
}

describe('the killer the board keeps', () => {
  it('is the name as the line prints it, white after it', () => {
    expect(killerName(SARGE, configstring)).toBe('^1Sarge^7');
  });

  it('is none for the world, which is no client at all', () => {
    expect(killerName(ENTITYNUM_WORLD, configstring)).toBeNull();
    expect(killerName(ENTITYNUM_NONE, configstring)).toBeNull();
  });

  it('is only the white for a slot nobody is in, as Q3 keeps it', () => {
    expect(killerName(5, configstring)).toBe('^7');
  });
});

describe('obituary', () => {
  it.each([
    [MOD.GRAPPLE, 'was caught by ^1Sarge^7'],
    [MOD.GAUNTLET, 'was pummeled by ^1Sarge^7'],
    [MOD.MACHINEGUN, 'was machinegunned by ^1Sarge^7'],
    [MOD.SHOTGUN, 'was gunned down by ^1Sarge^7'],
    [MOD.GRENADE, "ate ^1Sarge^7's grenade"],
    [MOD.GRENADE_SPLASH, "was shredded by ^1Sarge^7's shrapnel"],
    [MOD.ROCKET, "ate ^1Sarge^7's rocket"],
    [MOD.ROCKET_SPLASH, "almost dodged ^1Sarge^7's rocket"],
    [MOD.PLASMA, "was melted by ^1Sarge^7's plasmagun"],
    [MOD.PLASMA_SPLASH, "was melted by ^1Sarge^7's plasmagun"],
    [MOD.RAILGUN, 'was railed by ^1Sarge^7'],
    [MOD.LIGHTNING, 'was electrocuted by ^1Sarge^7'],
    [MOD.BFG, "was blasted by ^1Sarge^7's BFG"],
    [MOD.BFG_SPLASH, "was blasted by ^1Sarge^7's BFG"],
    [MOD.TELEFRAG, "tried to invade ^1Sarge^7's personal space"],
    [MOD.UNKNOWN, 'was killed by ^1Sarge^7']
  ])('tells means %i at another hand with both names, white after each', (mod, told) => {
    expect(line(mod, VISOR, SARGE)).toBe(`Visor^7 ${told}\n`);
  });

  it.each([
    [MOD.SUICIDE, 'suicides'],
    [MOD.FALLING, 'cratered'],
    [MOD.CRUSH, 'was squished'],
    [MOD.WATER, 'sank like a rock'],
    [MOD.SLIME, 'melted'],
    [MOD.LAVA, 'does a back flip into the lava'],
    [MOD.TARGET_LASER, 'saw the light'],
    [MOD.TRIGGER_HURT, 'was in the wrong place']
  ])('tells means %i the same whoever caused it', (mod, told) => {
    expect(line(mod, VISOR, ENTITYNUM_WORLD)).toBe(`Visor^7 ${told}.\n`);
    expect(line(mod, VISOR, SARGE)).toBe(`Visor^7 ${told}.\n`);
  });

  it.each([
    [
      MOD.GRENADE_SPLASH,
      'tripped on his own grenade',
      'tripped on her own grenade',
      'tripped on its own grenade'
    ],
    [MOD.ROCKET_SPLASH, 'blew himself up', 'blew herself up', 'blew itself up'],
    [MOD.PLASMA_SPLASH, 'melted himself', 'melted herself', 'melted itself'],
    [
      MOD.BFG_SPLASH,
      'should have used a smaller gun',
      'should have used a smaller gun',
      'should have used a smaller gun'
    ],
    [MOD.ROCKET, 'killed himself', 'killed herself', 'killed itself'],
    // `/kill`'s own means: the first test sets "suicides", and the second overwrites it.
    [MOD.SUICIDE, 'killed himself', 'killed herself', 'killed itself'],
    [MOD.FALLING, 'killed himself', 'killed herself', 'killed itself']
  ])('tells means %i by their own hand in their gender', (mod, male, female, neuter) => {
    expect(line(mod, SARGE, SARGE, 'male')).toBe(`^1Sarge^7 ${male}.\n`);
    expect(line(mod, SARGE, SARGE, 'female')).toBe(`^1Sarge^7 ${female}.\n`);
    expect(line(mod, SARGE, SARGE, 'neuter')).toBe(`^1Sarge^7 ${neuter}.\n`);
  });

  it("reads the gender of the dead, and only for a death by their own hand", () => {
    const asked: number[] = [];
    const gender = (clientNum: number): Gender => {
      asked.push(clientNum);
      return 'female';
    };
    obituary(MOD.RAILGUN, VISOR, SARGE, configstring, gender);
    obituary(MOD.FALLING, VISOR, ENTITYNUM_WORLD, configstring, gender);
    expect(asked).toEqual([]);
    expect(obituary(MOD.ROCKET_SPLASH, VISOR, VISOR, configstring, gender)).toBe(
      'Visor^7 blew herself up.\n'
    );
    expect(asked).toEqual([VISOR]);
  });

  it('says only that they died, for a means with no line of its own and no client to blame', () => {
    expect(line(MOD.UNKNOWN, VISOR, ENTITYNUM_WORLD)).toBe('Visor^7 died.\n');
    expect(line(MOD.RAILGUN, VISOR, ENTITYNUM_NONE)).toBe('Visor^7 died.\n');
    expect(line(MOD.RAILGUN, VISOR, -1)).toBe('Visor^7 died.\n');
  });

  it("keeps a name's first 29 characters, its colour codes counted, and whites it after", () => {
    const long = (index: number) =>
      index === CONFIGSTRING.PLAYERS + VISOR
        ? `n\\${'A'.repeat(35)}`
        : `n\\^2${'B'.repeat(35)}`;
    expect(obituary(MOD.RAILGUN, VISOR, SARGE, long, () => 'male')).toBe(
      `${'A'.repeat(29)}^7 was railed by ^2${'B'.repeat(27)}^7\n`
    );
  });

  it("names nobody for a slot nobody is in, as Q3's can never find a slot without a string", () => {
    expect(line(MOD.FALLING, 5, ENTITYNUM_WORLD)).toBe('^7 cratered.\n');
    expect(line(MOD.RAILGUN, VISOR, 7)).toBe('Visor^7 was railed by ^7\n');
  });

  it('prints nothing for a target that is no client, where Q3 stops cgame', () => {
    expect(line(MOD.RAILGUN, MAX_CLIENTS, SARGE)).toBeNull();
    expect(line(MOD.RAILGUN, -1, SARGE)).toBeNull();
  });
});

describe('"You fragged"', () => {
  /** The word to Sarge's screen for a death, below a team game unless one is given. */
  const toSarge = (mod: number, target: number, attacker: number, gametype: number = GT.FFA) =>
    fragMessage(mod, target, attacker, SARGE, configstring, gametype, 0, 3);

  it('names the dead, and below a team game the place the kill leaves the killer in', () => {
    expect(toSarge(MOD.RAILGUN, VISOR, SARGE)).toBe('You fragged Visor^7\n^41st^7 place with 3');
    expect(toSarge(MOD.RAILGUN, VISOR, SARGE, GT.TOURNAMENT)).toBe(
      'You fragged Visor^7\n^41st^7 place with 3'
    );
  });

  it('tells a tie for the place as a tie', () => {
    const tied = fragMessage(
      MOD.RAILGUN,
      VISOR,
      SARGE,
      SARGE,
      configstring,
      GT.FFA,
      1 | RANK_TIED_FLAG,
      3
    );
    expect(tied).toBe('You fragged Visor^7\nTied for ^12nd^7 place with 3');
  });

  it('has no place to tell in a team game', () => {
    expect(toSarge(MOD.RAILGUN, VISOR, SARGE, GT.TEAM)).toBe('You fragged Visor^7');
    expect(toSarge(MOD.RAILGUN, VISOR, SARGE, GT.CTF)).toBe('You fragged Visor^7');
  });

  it('is only the killer’s', () => {
    expect(toSarge(MOD.RAILGUN, SARGE, VISOR)).toBeNull();
    expect(toSarge(MOD.RAILGUN, VISOR, ENTITYNUM_WORLD)).toBeNull();
  });

  it('is not said for a death told in a word of its own', () => {
    // The player's own hand, whatever it was done with, and the deaths nobody is blamed for.
    expect(toSarge(MOD.ROCKET_SPLASH, SARGE, SARGE)).toBeNull();
    expect(toSarge(MOD.FALLING, VISOR, SARGE)).toBeNull();
    expect(toSarge(MOD.TRIGGER_HURT, VISOR, SARGE)).toBeNull();
  });

  it('is not said for a target that is no client', () => {
    expect(toSarge(MOD.RAILGUN, MAX_CLIENTS, SARGE)).toBeNull();
  });
});
