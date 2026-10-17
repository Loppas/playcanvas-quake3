import { describe, expect, it } from 'vitest';

import { CONFIGSTRING } from '../net/commands';
import { ENTITYNUM_WORLD } from '../net/protocol';
import {
  CONTENTS,
  EF_AWARDS,
  EF_AWARD_ASSIST,
  EF_AWARD_CAP,
  EF_AWARD_DEFEND,
  EF_NODRAW,
  FL,
  GT,
  PERS,
  PLAYEREVENT,
  REWARD_SPRITE_TIME,
  TEAM
} from './constants';
import { EV, GTS } from './events';
import { ET, SVF, type GameEntity } from './game-entity';
import { itemIndex, findItem, PW } from './items';
import { DEFAULT_ITEM_MATCH } from './item-touch';
import { Level } from './level';
import {
  addTeamScore,
  checkAlmostCapture,
  createTeamGame,
  FLAG,
  FLAG_NEVER_EXPIRES,
  initTeamGame,
  otherTeam,
  pickupTeam,
  printMsg,
  setFlagStatus,
  teamCheckDroppedItem,
  teamCheckHurtCarrier,
  teamDroppedFlagThink,
  teamForceGesture,
  teamFragBonuses,
  teamName,
  teamResetFlag,
  teamReturnFlag,
  teamTakeFlagSound
} from './team';
import { createIdlePlayerState } from './types';
import { vec3, type Vec3 } from './vec3';

/** Everything a match's flags write out, and the scores they ask for. */
interface Written {
  configstrings: { index: number; value: string }[];
  commands: { clientNum: number | null; text: string }[];
  scores: { clientNum: number; score: number }[];
  ranks: number;
}

/**
 * A CTF match with nothing in it yet, and a record of everything it says.
 *
 * @param inPVS - What the world sees, or a world of one cluster where everything sees all.
 */
function match(
  gametype: number = GT.CTF,
  inPVS?: (p1: Vec3, p2: Vec3) => boolean
): { world: Level; written: Written } {
  const written: Written = { configstrings: [], commands: [], scores: [], ranks: 0 };
  const world = new Level({
    handlers: {
      setConfigstring: (index, value) => written.configstrings.push({ index, value }),
      sendServerCommand: (clientNum, text) => written.commands.push({ clientNum, text }),
      inPVS
    }
  });
  world.itemMatch = {
    ...DEFAULT_ITEM_MATCH,
    gametype: () => gametype,
    addScore: (entity, _origin, score) =>
      written.scores.push({ clientNum: entity.s.number, score }),
    calculateRanks: () => written.ranks++
  };
  return { world, written };
}

/** Just the `CS_FLAGSTATUS` strings, in the order they went out. */
function statuses(written: Written): string[] {
  return written.configstrings
    .filter((c) => c.index === CONFIGSTRING.FLAGSTATUS)
    .map((c) => c.value);
}

/** The `GTS` numbers of every team sound the match has sent. */
function sounds(world: Level): number[] {
  const out: number[] = [];
  for (let i = 0; i < world.numEntities; i++) {
    const entity = world.gentities[i];
    if (!entity.inuse || entity.classname !== 'tempEntity') continue;
    if (entity.s.eType - ET.EVENTS === EV.GLOBAL_TEAM_SOUND) out.push(entity.s.eventParm);
  }
  return out;
}

/** Every flag of a side that is still standing in the world. */
function flagsInWorld(world: Level, team: number): GameEntity[] {
  const classname = team === TEAM.RED ? 'team_CTF_redflag' : 'team_CTF_blueflag';
  const out: GameEntity[] = [];
  for (let ent = world.find(null, 'classname', classname); ent; ) {
    out.push(ent);
    ent = world.find(ent, 'classname', classname);
  }
  return out;
}

/** A player on a side, in a client slot, as `ClientSpawn` leaves one. */
function player(
  world: Level,
  clientNum: number,
  team: number,
  name = 'Sarge',
  at: Vec3 = vec3()
): GameEntity {
  const entity = world.gentities[clientNum];
  entity.inuse = true;
  entity.client = world.clients[clientNum];
  entity.client.ps = createIdlePlayerState();
  entity.client.sess.sessionTeam = team;
  entity.client.pers.netname = name;
  entity.r.currentOrigin = at;
  return entity;
}

/** A flag where the map stood it, or — with `dropped` — where a carrier left it. */
function flag(world: Level, team: number, dropped = false, at: Vec3 = vec3()): GameEntity {
  const classname = team === TEAM.RED ? 'team_CTF_redflag' : 'team_CTF_blueflag';
  const entity = world.spawnEntity();
  entity.classname = classname;
  entity.item = findItem(classname)!;
  entity.s.eType = ET.ITEM;
  entity.s.modelindex = itemIndex(entity.item);
  entity.r.contents = CONTENTS.TRIGGER;
  entity.r.currentOrigin = at;
  if (dropped) {
    entity.flags |= FL.DROPPED_ITEM;
    entity.s.modelindex2 = 1;
  }
  return entity;
}

describe('the flags at the start of a match', () => {
  it('are both at their bases, and every client is told so', () => {
    const { world, written } = match();

    initTeamGame(world, GT.CTF);

    expect(world.teamgame.redStatus).toBe(FLAG.ATBASE);
    expect(world.teamgame.blueStatus).toBe(FLAG.ATBASE);
    // Twice, because each flag is set on its own; what matters is that the last word is "00".
    expect(statuses(written).at(-1)).toBe('00');
  });

  it('are said out loud although a cleared match already reads them home', () => {
    // `Team_InitGame`'s "invalid to force update" (`g_team.c:49–54`): without it the write is
    // skipped as a change that is not one, and a client that never hears gets no flag icons.
    const { world, written } = match();
    expect(world.teamgame.redStatus).toBe(FLAG.ATBASE);

    initTeamGame(world, GT.CTF);

    expect(statuses(written).length).toBeGreaterThan(0);
  });

  it('clear the whole struct, not only the two statuses', () => {
    // The `memset` takes the take times with it, and a restart that kept them would throttle the
    // first grab of the new match against a clock that has been reset under it.
    const { world } = match();
    Object.assign(world.teamgame, {
      lastFlagCapture: 4_000,
      lastCaptureTeam: TEAM.RED,
      redTakenTime: 9_000,
      blueTakenTime: 9_000
    });

    initTeamGame(world, GT.CTF);

    expect(world.teamgame).toEqual({ ...createTeamGame() });
  });
});

describe('a flag that moves', () => {
  it('is sent as red then blue, in Quake 3’s own characters', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);

    setFlagStatus(world, TEAM.RED, FLAG.TAKEN);
    expect(statuses(written).at(-1)).toBe('10');

    setFlagStatus(world, TEAM.BLUE, FLAG.DROPPED);
    expect(statuses(written).at(-1)).toBe('12');

    setFlagStatus(world, TEAM.RED, FLAG.ATBASE);
    expect(statuses(written).at(-1)).toBe('02');
  });

  it('says nothing when it has not moved', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const before = statuses(written).length;

    setFlagStatus(world, TEAM.RED, FLAG.ATBASE);

    expect(statuses(written).length).toBe(before);
  });

  it('is nobody’s but red’s and blue’s', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const before = statuses(written).length;

    // `TEAM_FREE` is One Flag CTF's, which the port does not play.
    setFlagStatus(world, TEAM.FREE, FLAG.TAKEN);

    expect(statuses(written).length).toBe(before);
  });

  it('says it is on the floor the moment it is dropped', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);

    teamCheckDroppedItem(world, flag(world, TEAM.BLUE, true));

    expect(world.teamgame.blueStatus).toBe(FLAG.DROPPED);
    expect(statuses(written).at(-1)).toBe('02');
  });

  it('is not confused with a rocket launcher somebody dropped', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const before = statuses(written).length;

    const rocket = world.spawnEntity();
    rocket.item = findItem('weapon_rocketlauncher')!;
    teamCheckDroppedItem(world, rocket);

    expect(statuses(written).length).toBe(before);
  });
});

describe('a line of text to the match', () => {
  it('goes out as a print command, to everyone when nobody is named', () => {
    const { world, written } = match();

    printMsg(world, null, 'The RED flag has returned!\n');

    expect(written.commands).toEqual([
      { clientNum: null, text: 'print "The RED flag has returned!\n"' }
    ]);
  });

  it('turns a double quote into a single one, because "double quotes are bad"', () => {
    // The command is itself quoted, so a quote inside it would end the command early.
    const { world, written } = match();

    printMsg(world, 3, 'Don\'t know what team the "flag" is on.\n');

    expect(written.commands[0].clientNum).toBe(3);
    expect(written.commands[0].text).toBe('print "Don\'t know what team the \'flag\' is on.\n"');
  });
});

describe('a side scoring', () => {
  it('adds to the team score and says who scored', () => {
    const { world } = match();
    world.teamScores[TEAM.RED] = 3;
    world.teamScores[TEAM.BLUE] = 0;

    addTeamScore(world, world.gentities[0].s.origin, TEAM.RED, 1);

    expect(world.teamScores[TEAM.RED]).toBe(4);
    expect(sounds(world)).toEqual([GTS.REDTEAM_SCORED]);
  });

  it('says the teams are tied when the score that is landing levels them', () => {
    // The sound is chosen against what the total *will be*, so this is "that tied it".
    const { world } = match();
    world.teamScores[TEAM.RED] = 2;
    world.teamScores[TEAM.BLUE] = 3;

    addTeamScore(world, world.gentities[0].s.origin, TEAM.RED, 1);

    expect(sounds(world)).toEqual([GTS.TEAMS_ARE_TIED]);
  });

  it('says a side took the lead when it was level or behind and now is not', () => {
    const { world } = match();
    world.teamScores[TEAM.RED] = 2;
    world.teamScores[TEAM.BLUE] = 2;

    addTeamScore(world, world.gentities[0].s.origin, TEAM.BLUE, 1);

    expect(sounds(world)).toEqual([GTS.BLUETEAM_TOOK_LEAD]);
  });

  it('is heard by everybody, wherever they are standing', () => {
    const { world } = match();

    addTeamScore(world, world.gentities[0].s.origin, TEAM.BLUE, 1);

    const sound = world.gentities.find((e) => e.inuse && e.classname === 'tempEntity')!;
    expect(sound.r.svFlags & SVF.BROADCAST).toBeTruthy();
  });
});

describe('putting a flag back', () => {
  it('stands the map’s flag up again and takes the dropped one away', () => {
    const { world } = match();
    const base = flag(world, TEAM.RED);
    base.r.svFlags |= SVF.NOCLIENT;
    base.s.eFlags |= EF_NODRAW;
    base.r.contents = 0;
    const onTheFloor = flag(world, TEAM.RED, true);

    const returned = teamResetFlag(world, TEAM.RED);

    expect(returned).toBe(base);
    expect(base.r.contents).toBe(CONTENTS.TRIGGER);
    expect(base.s.eFlags & EF_NODRAW).toBe(0);
    expect(onTheFloor.inuse).toBe(false);
    expect(world.teamgame.redStatus).toBe(FLAG.ATBASE);
  });

  it('has nothing to hand back for a side that is neither red nor blue', () => {
    const { world } = match();
    expect(teamResetFlag(world, TEAM.FREE)).toBeNull();
  });

  it('sends a dropped flag home when its time is up, and says so', () => {
    const { world, written } = match();
    const base = flag(world, TEAM.BLUE);
    const onTheFloor = flag(world, TEAM.BLUE, true);
    teamCheckDroppedItem(world, onTheFloor);

    teamDroppedFlagThink(world, onTheFloor);

    // The dropped flag's slot is freed and taken at once by the temp entity carrying the sound,
    // which is Quake 3's own `G_Spawn`: this early in a map it reuses anything just freed. So the
    // question worth asking is what flags the world has left, not what became of that slot.
    expect(flagsInWorld(world, TEAM.BLUE)).toEqual([base]);
    expect(base.r.contents).toBe(CONTENTS.TRIGGER);
    expect(world.teamgame.blueStatus).toBe(FLAG.ATBASE);
    expect(sounds(world)).toEqual([GTS.RED_RETURN]);
    // The timer plays the sound and says nothing: the console line belongs to `Team_ReturnFlag`,
    // which the think does not call.
    expect(written.commands).toEqual([]);
  });

  it('says the flag has returned when something sends it home on purpose', () => {
    const { world, written } = match();
    const base = flag(world, TEAM.RED);
    const onTheFloor = flag(world, TEAM.RED, true);
    teamCheckDroppedItem(world, onTheFloor);

    teamReturnFlag(world, TEAM.RED);

    expect(flagsInWorld(world, TEAM.RED)).toEqual([base]);
    expect(world.teamgame.redStatus).toBe(FLAG.ATBASE);
    expect(sounds(world)).toEqual([GTS.BLUE_RETURN]);
    expect(written.commands.at(-1)?.text).toBe('print "The RED flag has returned!\n"');
  });
});

describe('the sound a grab makes', () => {
  it('is played when the other flag is on its stand', () => {
    const { world } = match();
    const red = flag(world, TEAM.RED);

    teamTakeFlagSound(world, red, TEAM.RED);

    expect(sounds(world)).toEqual([GTS.BLUE_TAKEN]);
  });

  it('is held back for ten seconds when the other flag is away as well', () => {
    // "Only play sound when the flag was at the base or not picked up the last 10 seconds": a
    // flag pulled back and forth in a doorway is not shouted about every time.
    const { world } = match();
    const red = flag(world, TEAM.RED);
    world.teamgame.blueStatus = FLAG.TAKEN;
    world.time = 20_000;

    teamTakeFlagSound(world, red, TEAM.RED);
    const first = sounds(world).length;
    world.time = 25_000;
    teamTakeFlagSound(world, red, TEAM.RED);

    expect(first).toBe(1);
    expect(sounds(world).length).toBe(1);
  });
});

describe('walking into a flag', () => {
  it('takes the other side’s, which is then carried until it is lost', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const blue = flag(world, TEAM.BLUE);
    const carrier = player(world, 0, TEAM.RED);

    // −1 is `Touch_Item`'s "never bring it back, but free it if it was dropped".
    expect(pickupTeam(world, blue, carrier)).toBe(-1);
    // `INT_MAX`, written out rather than read back off the constant, so that changing the
    // constant is a failure here and not a tautology.
    expect(carrier.client!.ps.powerups[PW.BLUEFLAG]).toBe(2_147_483_647);
    expect(world.teamgame.blueStatus).toBe(FLAG.TAKEN);
    expect(carrier.client!.pers.teamState.flagsince).toBe(world.time);
    expect(written.commands.at(-1)?.text).toBe('print "Sarge^7 got the BLUE flag!\n"');
  });

  it('does nothing at all to your own flag when you are carrying nothing', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const red = flag(world, TEAM.RED);
    const defender = player(world, 0, TEAM.RED);
    const before = written.commands.length;

    expect(pickupTeam(world, red, defender)).toBe(0);
    expect(written.commands.length).toBe(before);
    expect(world.teamScores[TEAM.RED]).toBe(0);
  });

  it('returns your own flag off the floor, and pays for it', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const base = flag(world, TEAM.RED);
    const onTheFloor = flag(world, TEAM.RED, true);
    teamCheckDroppedItem(world, onTheFloor);
    const defender = player(world, 0, TEAM.RED, 'Grunt');
    world.time = 8_000;

    // Zero, because `Team_ResetFlag` has already freed the entity `Touch_Item` was holding.
    expect(pickupTeam(world, onTheFloor, defender)).toBe(0);
    expect(written.scores).toEqual([{ clientNum: 0, score: 1 }]);
    expect(defender.client!.pers.teamState.flagrecovery).toBe(1);
    expect(defender.client!.pers.teamState.lastreturnedflag).toBe(8_000);
    expect(world.teamgame.redStatus).toBe(FLAG.ATBASE);
    expect(base.r.contents).toBe(CONTENTS.TRIGGER);
    expect(written.commands.at(-1)?.text).toBe('print "Grunt^7 returned the RED flag!\n"');
  });

  it('captures when you carry the enemy flag into your own', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const red = flag(world, TEAM.RED);
    flag(world, TEAM.BLUE);
    const carrier = player(world, 0, TEAM.RED);
    carrier.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    world.time = 12_000;

    expect(pickupTeam(world, red, carrier)).toBe(0);

    expect(carrier.client!.ps.powerups[PW.BLUEFLAG]).toBe(0);
    expect(world.teamScores[TEAM.RED]).toBe(1);
    expect(carrier.client!.ps.persistant[PERS.CAPTURES]).toBe(1);
    expect(carrier.client!.pers.teamState.captures).toBe(1);
    expect(carrier.client!.ps.eFlags & EF_AWARDS).toBe(EF_AWARD_CAP);
    expect(carrier.client!.rewardTime).toBe(12_000 + REWARD_SPRITE_TIME);
    // The capture bonus, which is baseq3's 5 and not Team Arena's 100.
    expect(written.scores).toEqual([{ clientNum: 0, score: 5 }]);
    expect(world.teamgame.lastFlagCapture).toBe(12_000);
    expect(world.teamgame.lastCaptureTeam).toBe(TEAM.RED);
    expect(sounds(world)).toContain(GTS.RED_CAPTURE);
    expect(written.ranks).toBeGreaterThan(0);
    expect(written.commands.at(-1)?.text).toBe('print "Sarge^7 captured the BLUE flag!\n"');
  });

  it('puts both flags back when the capture lands', () => {
    const { world } = match();
    initTeamGame(world, GT.CTF);
    const red = flag(world, TEAM.RED);
    const blue = flag(world, TEAM.BLUE);
    world.teamgame.blueStatus = FLAG.TAKEN;
    const carrier = player(world, 0, TEAM.RED);
    carrier.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;

    pickupTeam(world, red, carrier);

    expect(world.teamgame.redStatus).toBe(FLAG.ATBASE);
    expect(world.teamgame.blueStatus).toBe(FLAG.ATBASE);
    expect(blue.r.contents).toBe(CONTENTS.TRIGGER);
  });

  it('pays a team mate who returned a flag a moment before the capture', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const red = flag(world, TEAM.RED);
    flag(world, TEAM.BLUE);
    const carrier = player(world, 0, TEAM.RED);
    carrier.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const mate = player(world, 1, TEAM.RED, 'Grunt');
    const enemy = player(world, 2, TEAM.BLUE, 'Visor');
    // Past ten seconds, so that the zeroed `lastfraggedcarrier` is not also inside its window.
    world.time = 20_000;
    mate.client!.pers.teamState.lastreturnedflag = 15_000;

    pickupTeam(world, red, carrier);

    expect(written.scores).toContainEqual({ clientNum: 1, score: 1 });
    expect(mate.client!.ps.persistant[PERS.ASSIST_COUNT]).toBe(1);
    // The sprite is the assister's, whatever the capturer is wearing.
    expect(mate.client!.ps.eFlags & EF_AWARDS).toBe(EF_AWARD_ASSIST);
    expect(carrier.client!.ps.eFlags & EF_AWARDS).toBe(EF_AWARD_CAP);
    // Quake 3 counts the assist on the *capturer*, not on whoever assisted.
    expect(carrier.client!.pers.teamState.assists).toBe(1);
    // The other side cannot claim a defence against a capture that has already happened.
    expect(enemy.client!.pers.teamState.lasthurtcarrier).toBe(-5);
  });

  it("pays a mate who killed their flag's carrier, and floats the assist over them", () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const red = flag(world, TEAM.RED);
    flag(world, TEAM.BLUE);
    const carrier = player(world, 0, TEAM.RED);
    carrier.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const mate = player(world, 1, TEAM.RED, 'Grunt');
    // Past ten seconds, so that the zeroed `lastreturnedflag` is not also inside its window.
    world.time = 20_000;
    mate.client!.pers.teamState.lastfraggedcarrier = 15_000;

    pickupTeam(world, red, carrier);

    expect(written.scores).toContainEqual({ clientNum: 1, score: 2 });
    expect(mate.client!.ps.persistant[PERS.ASSIST_COUNT]).toBe(1);
    expect(mate.client!.ps.eFlags & EF_AWARDS).toBe(EF_AWARD_ASSIST);
    expect(mate.client!.rewardTime).toBe(20_000 + REWARD_SPRITE_TIME);
  });

  it('pays nobody whose return was more than ten seconds ago', () => {
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const red = flag(world, TEAM.RED);
    flag(world, TEAM.BLUE);
    const carrier = player(world, 0, TEAM.RED);
    carrier.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const mate = player(world, 1, TEAM.RED, 'Grunt');
    world.time = 20_000;
    mate.client!.pers.teamState.lastreturnedflag = 1_000;

    pickupTeam(world, red, carrier);

    expect(written.scores).not.toContainEqual({ clientNum: 1, score: 1 });
    expect(mate.client!.ps.persistant[PERS.ASSIST_COUNT]).toBe(0);
  });

  it('pays the whole side for a capture in the opening ten seconds, as Quake 3 does', () => {
    // A cleared team state reads zero for both assist clocks, and zero plus their ten seconds is
    // still ahead of a match that has only just started — so a capture inside the first ten
    // seconds pays every team mate for a return *and* for a carrier kill that never happened.
    // Kept because it is what Quake 3 does with the same zeroes.
    const { world, written } = match();
    initTeamGame(world, GT.CTF);
    const red = flag(world, TEAM.RED);
    flag(world, TEAM.BLUE);
    const carrier = player(world, 0, TEAM.RED);
    carrier.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const mate = player(world, 1, TEAM.RED, 'Grunt');
    world.time = 5_000;

    pickupTeam(world, red, carrier);

    expect(written.scores).toContainEqual({ clientNum: 1, score: 1 });
    expect(written.scores).toContainEqual({ clientNum: 1, score: 2 });
    expect(mate.client!.ps.persistant[PERS.ASSIST_COUNT]).toBe(2);
  });

  it('tells the player when the map named a flag nothing knows', () => {
    const { world, written } = match();
    const odd = world.spawnEntity();
    odd.classname = 'team_CTF_greenflag';
    const walker = player(world, 0, TEAM.RED);

    expect(pickupTeam(world, odd, walker)).toBe(0);
    expect(written.commands.at(-1)).toEqual({
      clientNum: 0,
      text: 'print "Don\'t know what team the flag is on.\n"'
    });
  });
});

describe('the taunt a capture forces', () => {
  it('is set on the side that captured and on nobody else', () => {
    const { world } = match();
    const mine = player(world, 0, TEAM.RED);
    const theirs = player(world, 1, TEAM.BLUE);
    const empty = world.gentities[2];

    teamForceGesture(world, TEAM.RED);

    expect(mine.flags & FL.FORCE_GESTURE).toBeTruthy();
    expect(theirs.flags & FL.FORCE_GESTURE).toBe(0);
    expect(empty.flags & FL.FORCE_GESTURE).toBe(0);
  });
});

describe('what a kill is worth in Capture the Flag', () => {
  /**
   * A CTF match with both flags on their stands, 4,000 units apart so nothing is near both.
   *
   * @param inPVS - What the world sees, or everything.
   */
  function bases(inPVS?: (p1: Vec3, p2: Vec3) => boolean) {
    const { world, written } = match(GT.CTF, inPVS);
    initTeamGame(world, GT.CTF);
    const red = flag(world, TEAM.RED, false, vec3(0, 2_000, 0));
    const blue = flag(world, TEAM.BLUE, false, vec3(0, -2_000, 0));
    world.time = 30_000;
    return { world, written, red, blue };
  }

  /** Somewhere neither flag can see, so only the bonus under test can fire. */
  const NOWHERE = vec3(9_000, 0, 0);
  const ALSO_NOWHERE = vec3(9_100, 0, 0);

  it('pays for killing whoever is carrying your flag, and says so', () => {
    const { world, written } = bases();
    const thief = player(world, 1, TEAM.BLUE, 'Grunt', NOWHERE);
    thief.client!.ps.powerups[PW.REDFLAG] = FLAG_NEVER_EXPIRES;
    const defender = player(world, 0, TEAM.RED, 'Sarge', ALSO_NOWHERE);

    teamFragBonuses(world, thief, defender);

    expect(written.scores).toEqual([{ clientNum: 0, score: 2 }]);
    expect(defender.client!.pers.teamState.fragcarrier).toBe(1);
    expect(defender.client!.pers.teamState.lastfraggedcarrier).toBe(30_000);
    expect(written.commands.at(-1)?.text).toBe("print \"Sarge^7 fragged BLUE's flag carrier!\n\"");
  });

  it('clears the hunters’ claims once the carrier they were hunting is dead', () => {
    // `lasthurtcarrier` is set on whoever hurts the *other* side's carrier, and it is what pays
    // that carrier's team mates for killing them. Once the carrier is dead the danger is over,
    // so the clocks on the killer's own side go — `otherteam` is the other side from the victim.
    const { world } = bases();
    const thief = player(world, 1, TEAM.BLUE, 'Grunt', NOWHERE);
    thief.client!.ps.powerups[PW.REDFLAG] = FLAG_NEVER_EXPIRES;
    const defender = player(world, 0, TEAM.RED, 'Sarge', ALSO_NOWHERE);
    const hunter = player(world, 2, TEAM.RED, 'Visor', NOWHERE);
    hunter.client!.pers.teamState.lasthurtcarrier = 29_000;

    teamFragBonuses(world, thief, defender);

    expect(hunter.client!.pers.teamState.lasthurtcarrier).toBe(0);
  });

  it('pays nothing for killing yourself, standing on your own flag or not', () => {
    // On the flag, because that is where a missing "not yourself" would pay a base defence.
    const { world, written } = bases();
    const player0 = player(world, 0, TEAM.RED, 'Sarge', vec3(0, 1_900, 0));

    teamFragBonuses(world, player0, player0);

    expect(written.scores).toEqual([]);
  });

  it('pays nothing for killing a team mate, wherever they fall', () => {
    const { world, written } = bases();
    const mate = player(world, 1, TEAM.RED, 'Grunt', vec3(0, 1_900, 0));
    mate.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const killer = player(world, 0, TEAM.RED, 'Sarge', vec3(0, 1_800, 0));

    teamFragBonuses(world, mate, killer);

    expect(written.scores).toEqual([]);
  });

  it('pays for killing somebody who has just hurt your own carrier', () => {
    const { world, written } = bases();
    const mate = player(world, 2, TEAM.RED, 'Visor', NOWHERE);
    mate.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const attacker = player(world, 1, TEAM.BLUE, 'Grunt', NOWHERE);
    void mate;
    const defender = player(world, 0, TEAM.RED, 'Sarge', ALSO_NOWHERE);
    attacker.client!.pers.teamState.lasthurtcarrier = 25_000;

    teamFragBonuses(world, attacker, defender);

    expect(written.scores).toEqual([{ clientNum: 0, score: 2 }]);
    expect(defender.client!.pers.teamState.carrierdefense).toBe(1);
    expect(defender.client!.ps.persistant[PERS.DEFEND_COUNT]).toBe(1);
    expect(defender.client!.ps.eFlags & EF_AWARDS).toBe(EF_AWARD_DEFEND);
    // The claim is spent: a second kill of the same player is worth nothing.
    expect(attacker.client!.pers.teamState.lasthurtcarrier).toBe(0);
  });

  it('pays nothing for that if the hurt was more than eight seconds ago', () => {
    const { world, written } = bases();
    const attacker = player(world, 1, TEAM.BLUE, 'Grunt', NOWHERE);
    const defender = player(world, 0, TEAM.RED, 'Sarge', ALSO_NOWHERE);
    attacker.client!.pers.teamState.lasthurtcarrier = 20_000;

    teamFragBonuses(world, attacker, defender);

    expect(written.scores).toEqual([]);
  });

  it('pays nothing for that when you are the carrier being defended', () => {
    // The test is `!attacker->ps.powerups[flag_pw]`, and `flag_pw` is the *victim's* own flag —
    // which whoever killed them is holding only if they are the carrier themselves.
    const { world, written } = bases();
    const hunter = player(world, 1, TEAM.RED, 'Grunt', NOWHERE);
    const carrier = player(world, 0, TEAM.BLUE, 'Sarge', ALSO_NOWHERE);
    carrier.client!.ps.powerups[PW.REDFLAG] = FLAG_NEVER_EXPIRES;
    hunter.client!.pers.teamState.lasthurtcarrier = 25_000;

    teamFragBonuses(world, hunter, carrier);

    expect(written.scores).toEqual([]);
  });

  it('pays for a kill near your own flag', () => {
    const { world, written } = bases();
    const attacker = player(world, 1, TEAM.BLUE, 'Grunt', vec3(0, 1_500, 0));
    const defender = player(world, 0, TEAM.RED, 'Sarge', vec3(0, 1_600, 0));

    teamFragBonuses(world, attacker, defender);

    expect(written.scores).toEqual([{ clientNum: 0, score: 1 }]);
    expect(defender.client!.pers.teamState.basedefense).toBe(1);
    expect(defender.client!.ps.persistant[PERS.DEFEND_COUNT]).toBe(1);
    expect(defender.client!.ps.eFlags & EF_AWARDS).toBe(EF_AWARD_DEFEND);
  });

  /** A world that sees only these points, from anywhere, with each pair it was asked about. */
  function sightOf(...seen: Vec3[]) {
    const asked: [Vec3, Vec3][] = [];
    const inPVS = (p1: Vec3, p2: Vec3) => {
      asked.push([{ ...p1 }, { ...p2 }]);
      return seen.some((p) => p.x === p2.x && p.y === p2.y && p.z === p2.z);
    };
    return { inPVS, asked };
  }

  it('pays near your flag for whichever of the two is near it and in its sight', () => {
    // Near the flag and out of its sight, and in its sight but too far: each distance goes with
    // its own sight, so neither counts.
    const flagAt = vec3(0, 2_000, 0);
    const near = vec3(0, 1_600, 0);
    const far = vec3(0, 900, 0);
    const blind = sightOf(far);
    const unpaid = bases(blind.inPVS);
    const killed = player(unpaid.world, 1, TEAM.BLUE, 'Grunt', near);
    teamFragBonuses(unpaid.world, killed, player(unpaid.world, 0, TEAM.RED, 'Sarge', far));
    expect(unpaid.written.scores).toEqual([]);
    expect(blind.asked).toEqual([[flagAt, near]]);

    const seen = vec3(0, 1_500, 0);
    const sight = sightOf(seen);
    const paid = bases(sight.inPVS);
    const unseen = player(paid.world, 1, TEAM.BLUE, 'Grunt', near);
    teamFragBonuses(paid.world, unseen, player(paid.world, 0, TEAM.RED, 'Sarge', seen));
    expect(paid.written.scores).toEqual([{ clientNum: 0, score: 1 }]);
    expect(sight.asked).toEqual([
      [flagAt, near],
      [flagAt, seen]
    ]);
  });

  it('pays near your carrier for whichever of the two is near them and in their sight', () => {
    const carrierAt = vec3(9_000, 0, 0);
    const near = vec3(9_000, 500, 0);
    const far = vec3(9_000, 1_500, 0);
    const blind = sightOf(far);
    const unpaid = bases(blind.inPVS);
    const mate = player(unpaid.world, 2, TEAM.RED, 'Visor', carrierAt);
    mate.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const killed = player(unpaid.world, 1, TEAM.BLUE, 'Grunt', near);
    teamFragBonuses(unpaid.world, killed, player(unpaid.world, 0, TEAM.RED, 'Sarge', far));
    expect(unpaid.written.scores).toEqual([]);
    expect(blind.asked).toEqual([[carrierAt, near]]);

    const seen = vec3(9_000, -500, 0);
    const sight = sightOf(seen);
    const paid = bases(sight.inPVS);
    const carrier = player(paid.world, 2, TEAM.RED, 'Visor', carrierAt);
    carrier.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const unseen = player(paid.world, 1, TEAM.BLUE, 'Grunt', near);
    const killer = player(paid.world, 0, TEAM.RED, 'Sarge', seen);
    teamFragBonuses(paid.world, unseen, killer);
    expect(paid.written.scores).toEqual([{ clientNum: 0, score: 1 }]);
    expect(killer.client!.pers.teamState.carrierdefense).toBe(1);
    expect(sight.asked).toEqual([
      [carrierAt, near],
      [carrierAt, seen]
    ]);
  });

  it('pays nothing for a kill nowhere near anything', () => {
    const { world, written } = bases();
    const attacker = player(world, 1, TEAM.BLUE, 'Grunt', NOWHERE);
    const defender = player(world, 0, TEAM.RED, 'Sarge', ALSO_NOWHERE);

    teamFragBonuses(world, attacker, defender);

    expect(written.scores).toEqual([]);
  });

  it('defends nothing with a flag that is lying on the floor', () => {
    // The lookup walks past a dropped flag: only the one on its stand is a base to defend.
    const { world, written } = bases();
    world.freeEntity(world.find(null, 'classname', 'team_CTF_redflag')!);
    flag(world, TEAM.RED, true, vec3(0, 2_000, 0));
    const attacker = player(world, 1, TEAM.BLUE, 'Grunt', vec3(0, 1_500, 0));
    const defender = player(world, 0, TEAM.RED, 'Sarge', vec3(0, 1_600, 0));

    teamFragBonuses(world, attacker, defender);

    expect(written.scores).toEqual([]);
  });

  it('pays for a kill near your own carrier, for less', () => {
    const { world, written } = bases();
    const mate = player(world, 2, TEAM.RED, 'Visor', NOWHERE);
    mate.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const attacker = player(world, 1, TEAM.BLUE, 'Grunt', vec3(9_000, 500, 0));
    const defender = player(world, 0, TEAM.RED, 'Sarge', ALSO_NOWHERE);

    teamFragBonuses(world, attacker, defender);

    expect(written.scores).toEqual([{ clientNum: 0, score: 1 }]);
    expect(defender.client!.pers.teamState.carrierdefense).toBe(1);
    expect(defender.client!.ps.eFlags & EF_AWARDS).toBe(EF_AWARD_DEFEND);
  });

  it('pays one bonus and not two, in Quake 3’s order of importance', () => {
    // A kill of the carrier standing on your own flag is worth the carrier kill alone.
    const { world, written } = bases();
    const thief = player(world, 1, TEAM.BLUE, 'Grunt', vec3(0, 2_000, 0));
    thief.client!.ps.powerups[PW.REDFLAG] = FLAG_NEVER_EXPIRES;
    const defender = player(world, 0, TEAM.RED, 'Sarge', vec3(0, 2_000, 0));

    teamFragBonuses(world, thief, defender);

    expect(written.scores).toEqual([{ clientNum: 0, score: 2 }]);
    expect(defender.client!.pers.teamState.basedefense).toBe(0);
  });
});

describe('a carrier killed a step from home', () => {
  /** Blue's carrier of the red flag, `from` their own flag standing at home at the origin. */
  function almost(from: number, gametype: number = GT.CTF) {
    const { world } = match(gametype);
    const home = flag(world, TEAM.BLUE);
    home.s.origin = vec3();
    const carrier = player(world, 0, TEAM.BLUE, 'Sarge');
    carrier.client!.ps.powerups[PW.REDFLAG] = FLAG_NEVER_EXPIRES;
    carrier.client!.ps.origin = vec3(from, 0, 0);
    const killer = player(world, 1, TEAM.RED, 'Grunt');
    return { world, home, carrier, killer };
  }
  const events = (entity: GameEntity) => entity.client!.ps.persistant[PERS.PLAYEREVENTS];

  it('says "holy shit" to the carrier and to whoever killed them', () => {
    const { world, carrier, killer } = almost(199);
    checkAlmostCapture(world, carrier, killer);
    expect(events(carrier)).toBe(PLAYEREVENT.HOLYSHIT);
    expect(events(killer)).toBe(PLAYEREVENT.HOLYSHIT);
  });

  it('says nothing 200 units out', () => {
    const { world, carrier, killer } = almost(200);
    checkAlmostCapture(world, carrier, killer);
    expect(events(carrier)).toBe(0);
  });

  it('says nothing when their own flag is away from home', () => {
    const { world, home, carrier, killer } = almost(50);
    home.r.svFlags |= SVF.NOCLIENT;
    checkAlmostCapture(world, carrier, killer);
    expect(events(carrier)).toBe(0);
  });

  it('measures to the flag at home, passing over a copy lying where it was dropped', () => {
    const { world } = match();
    // Dropped beside where the carrier dies, and found first.
    const lying = flag(world, TEAM.BLUE, true);
    lying.s.origin = vec3(40, 0, 0);
    const home = flag(world, TEAM.BLUE);
    home.s.origin = vec3(5_000, 0, 0);
    const carrier = player(world, 0, TEAM.BLUE, 'Sarge');
    carrier.client!.ps.powerups[PW.REDFLAG] = FLAG_NEVER_EXPIRES;
    carrier.client!.ps.origin = vec3(50, 0, 0);

    checkAlmostCapture(world, carrier, player(world, 1, TEAM.RED, 'Grunt'));
    expect(events(carrier)).toBe(0);
  });

  it('says it to the carrier alone when nobody killed them', () => {
    const { world, carrier } = almost(50);
    checkAlmostCapture(world, carrier, world.gentities[ENTITYNUM_WORLD]);
    expect(events(carrier)).toBe(PLAYEREVENT.HOLYSHIT);
  });

  it('is only for a carrier, in capture the flag', () => {
    const empty = almost(50);
    empty.carrier.client!.ps.powerups[PW.REDFLAG] = 0;
    checkAlmostCapture(empty.world, empty.carrier, empty.killer);
    expect(events(empty.carrier)).toBe(0);

    const team = almost(50, GT.TEAM);
    checkAlmostCapture(team.world, team.carrier, team.killer);
    expect(events(team.carrier)).toBe(0);
  });
});

describe('hurting a flag carrier', () => {
  it('is remembered against whoever did it', () => {
    const { world } = match();
    world.time = 12_000;
    const carrier = player(world, 0, TEAM.RED);
    carrier.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const attacker = player(world, 1, TEAM.BLUE, 'Grunt');

    teamCheckHurtCarrier(world, carrier, attacker);

    expect(attacker.client!.pers.teamState.lasthurtcarrier).toBe(12_000);
  });

  it('is not remembered for hurting your own side, or somebody carrying nothing', () => {
    const { world } = match();
    world.time = 12_000;
    const carrier = player(world, 0, TEAM.RED);
    carrier.client!.ps.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;
    const mate = player(world, 1, TEAM.RED, 'Grunt');
    const empty = player(world, 2, TEAM.RED, 'Visor');
    const enemy = player(world, 3, TEAM.BLUE, 'Bones');

    teamCheckHurtCarrier(world, carrier, mate);
    teamCheckHurtCarrier(world, empty, enemy);

    expect(mate.client!.pers.teamState.lasthurtcarrier).toBe(0);
    expect(enemy.client!.pers.teamState.lasthurtcarrier).toBe(0);
  });
});

describe('the sides themselves', () => {
  it('face each other, and anyone on neither faces nobody', () => {
    expect(otherTeam(TEAM.RED)).toBe(TEAM.BLUE);
    expect(otherTeam(TEAM.BLUE)).toBe(TEAM.RED);
    expect(otherTeam(TEAM.SPECTATOR)).toBe(TEAM.SPECTATOR);
    expect(otherTeam(TEAM.FREE)).toBe(TEAM.FREE);
  });

  it('are named as Quake 3 names them in a message', () => {
    expect(teamName(TEAM.RED)).toBe('RED');
    expect(teamName(TEAM.BLUE)).toBe('BLUE');
    expect(teamName(TEAM.SPECTATOR)).toBe('SPECTATOR');
    expect(teamName(TEAM.FREE)).toBe('FREE');
  });
});
