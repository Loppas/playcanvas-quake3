import { describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, type PlayerState } from '../net/protocol';
import { copyToBodyQue } from './body-queue';
import { createFlatWorldTrace } from './box-world';
import { damage } from './combat';
import { CONTENTS, GT, MOD, STAT } from './constants';
import { tossClientItems } from './drops';
import { EV, eventNumber } from './events';
import { ET, type GameEntity } from './game-entity';
import { runItem } from './item-run';
import { launchItem } from './item-spawn';
import { DEFAULT_ITEM_MATCH } from './item-touch';
import { findItem, PW } from './items';
import { Level } from './level';
import { spawnClient } from './life-test-fixtures';
import {
  AIR_OUT_TIME,
  DROWN_DAMAGE_MAX,
  DROWN_INTERVAL,
  LAVA_DAMAGE,
  SIZZLE_FRAME_MSEC,
  SLIME_DAMAGE,
  SUIT_AIR_TIME,
  type PlayerLife
} from './player-life';
import { expirePowerups } from './powerups';
import { FLAG, FLAG_NEVER_EXPIRES } from './team';
import { NO_CONTENTS, type PointContentsFn } from './types';
import { vec3 } from './vec3';

/**
 * What the world does to a player at each frame's end (`P_WorldEffects`, `G_SetClientSound`), and
 * what `CONTENTS_NODROP` refuses a death, a body and anything that falls. The water a player is in
 * is what the move left on the entity, which these set as the move would.
 */

const flat = createFlatWorldTrace();

/** The fry's slot, as a level is told it. */
const FRY = 7;

/** A player spawned at (100, 0, 24) in a level whose contents a test fills. */
interface World {
  level: Level;
  life: PlayerLife;
  state: PlayerState;
  entity: GameEntity;
  /** Each sound the match named, in the order it first named it: slot `i + 1`. */
  sounds: string[];
  /** What the level holds at a point, which a test sets. */
  contents: PointContentsFn;
  tossed: number;
}

function world(
  options: {
    startTime?: number;
    gametype?: number;
    random?: number;
    god?: boolean;
    /** Toss what the player carries as the game does, as well as counting it. */
    toss?: boolean;
  } = {}
): World {
  const w = { sounds: [] as string[], contents: NO_CONTENTS, tossed: 0 } as World;
  const level: Level = new Level({
    startTime: options.startTime,
    handlers: {
      runItem: (entity) => runItem(level, entity, flat),
      pointContents: (point, passEntityNum) => w.contents(point, passEntityNum)
    }
  });
  level.itemMatch = {
    ...DEFAULT_ITEM_MATCH,
    gametype: () => options.gametype ?? GT.FFA,
    random: () => options.random ?? 0,
    soundIndex: (name) => {
      if (!w.sounds.includes(name)) w.sounds.push(name);
      return w.sounds.indexOf(name) + 1;
    }
  };
  level.sndFry = FRY;
  const spawned = spawnClient({
    level,
    origin: vec3(100, 0, 24),
    god: options.god,
    tossItems: () => {
      w.tossed++;
      if (options.toss) tossClientItems(level, w.entity);
    }
  });
  // As a game's spawn leaves it: `G_SetOrigin` never writes it, so it is the map's origin.
  spawned.entity.s.origin = vec3();
  return Object.assign(w, { level, ...spawned });
}

/** A frame at `time`, and the client's end of it, its expired powerups off first as the game's. */
function frame(w: World, time: number): void {
  w.level.runFrame(time);
  expirePowerups(w.state, time);
  w.life.endFrame();
}

/** Leave the player in a liquid, as their last move found them. */
function wade(w: World, watertype: number, waterlevel: number): void {
  w.entity.waterlevel = waterlevel;
  w.entity.watertype = watertype;
}

/** Health enough to burn for a while. */
function hardy(w: World): void {
  w.state.stats[STAT.HEALTH] = 1000;
  w.entity.health = 1000;
}

/** Frames from `from` to `to`, `step` apart, and each hurt they took: its time and its points. */
function hurts(w: World, from: number, to: number, step = 8): [number, number][] {
  const taken: [number, number][] = [];
  for (let time = from; time <= to; time += step) {
    const before = w.state.stats[STAT.HEALTH];
    frame(w, time);
    const lost = before - w.state.stats[STAT.HEALTH];
    if (lost) taken.push([time, lost]);
  }
  return taken;
}

/** Frames from `from` to `to`, and how many battle suit pulses they raised. */
function pulses(w: World, from: number, to: number): number {
  let count = 0;
  for (let time = from; time <= to; time += 8) {
    const before = w.state.externalEvent;
    frame(w, time);
    const event = w.state.externalEvent;
    if (event !== before && eventNumber(event) === EV.POWERUP_BATTLESUIT) count++;
  }
  return count;
}

/** The entities that are one event of this kind, as a client finds them in a snapshot. */
function tempEvents(level: Level, event: number): GameEntity[] {
  return level.gentities.filter((e) => e.inuse && e.s.eType === ET.EVENTS + event);
}

describe('drowning', () => {
  it("pins Q3's air and its hurts", () => {
    expect(AIR_OUT_TIME).toBe(12_000);
    expect(SUIT_AIR_TIME).toBe(10_000);
    expect(DROWN_INTERVAL).toBe(1000);
    expect(DROWN_DAMAGE_MAX).toBe(15);
  });

  it('starts 12 s after the last frame out, 4 a second and 2 more each time, to 15', () => {
    const w = world();
    w.state.stats[STAT.ARMOR] = 50;
    frame(w, 8);
    wade(w, CONTENTS.WATER, 3);

    expect(hurts(w, 16, 19_100)).toEqual([
      [12_016, 4],
      [13_016, 6],
      [14_016, 8],
      [15_016, 10],
      [16_016, 12],
      [17_016, 14],
      [18_016, 15],
      [19_016, 15]
    ]);
    // `DAMAGE_NO_ARMOR`: the breath comes off the health alone.
    expect(w.state.stats[STAT.ARMOR]).toBe(50);
  });

  it('starts over at 4 after a frame out of the water, with 12 s of air again', () => {
    const w = world();
    frame(w, 8);
    wade(w, CONTENTS.WATER, 3);
    expect(hurts(w, 16, 14_100).map(([, points]) => points)).toEqual([4, 6, 8]);

    wade(w, CONTENTS.WATER, 2);
    frame(w, 14_104);
    wade(w, CONTENTS.WATER, 3);
    expect(hurts(w, 14_112, 27_000)).toEqual([[26_112, 4]]);
  });

  it('holds off the pain event, and sounds nothing of its own: cgame gurgles and drowns', () => {
    let draws = 0;
    const w = world();
    w.level.itemMatch = { ...w.level.itemMatch, random: () => (draws++, 0) };
    frame(w, 8);
    wade(w, CONTENTS.WATER, 3);
    const pains = w.state.damageEvent;
    const before = w.state.externalEvent;
    const health = w.state.stats[STAT.HEALTH];
    hurts(w, 16, 12_016);

    // Hurt, with the view's feedback, but no `EV_PAIN` for everyone else to hear.
    expect(w.state.stats[STAT.HEALTH]).toBe(health - 4);
    expect(w.state.damageCount).toBe(4);
    expect(w.state.damageEvent).toBe(pains);
    expect(w.state.externalEvent).toBe(before);
    expect(tempEvents(w.level, EV.GENERAL_SOUND)).toEqual([]);
    expect([w.sounds, draws]).toEqual([[], 0]);

    // The breath that kills is a death like any other, and cgame hears it drowned.
    const last = world();
    frame(last, 8);
    wade(last, CONTENTS.WATER, 3);
    last.state.stats[STAT.HEALTH] = 4;
    hurts(last, 16, 12_016);
    expect(last.state.stats[STAT.HEALTH]).toBe(0);
    expect(eventNumber(last.state.externalEvent)).toBe(EV.DEATH1);
    expect(tempEvents(last.level, EV.GENERAL_SOUND)).toEqual([]);
  });

  it('still lets a pain past its 200 ms play, as another hurt brings one', () => {
    const w = world();
    frame(w, 8);
    wade(w, CONTENTS.WATER, 3);
    hurts(w, 16, 12_016);
    const pains = w.state.damageEvent;

    damage(w.level, w.entity, null, null, null, 10, 0, MOD.ROCKET);
    frame(w, 12_216);
    expect(w.state.damageEvent).toBe(pains);
    damage(w.level, w.entity, null, null, null, 10, 0, MOD.ROCKET);
    frame(w, 12_224);
    expect(w.state.damageEvent).toBe(pains + 1);
  });

  it('is held off by the battle suit, which keeps 10 s of air and pulses for no water', () => {
    const w = world();
    frame(w, 8);
    wade(w, CONTENTS.WATER, 3);
    w.state.powerups[PW.BATTLESUIT] = 5000;
    expect(pulses(w, 16, 1000)).toBe(0);
    // Topped up to 10 s at the suit's last frame, 4992.
    expect(hurts(w, 1008, 15_100)).toEqual([[15_000, 4]]);
  });

  it('never runs out of air in noclip, gurgles nothing, and leaves it with 12 s of air', () => {
    const w = world();
    hardy(w);
    w.life.endFrame();
    w.entity.client!.noclip = true;
    wade(w, CONTENTS.WATER, 3);
    expect(hurts(w, 8, 12_100)).toEqual([]);
    expect(tempEvents(w.level, EV.GENERAL_SOUND)).toEqual([]);
    hurts(w, 12_108, 13_000);

    // The air from its last frame in noclip, 12 996.
    w.entity.client!.noclip = false;
    expect(hurts(w, 13_008, 25_100)).toEqual([[25_000, 4]]);
  });

  it('leaves the dead under water alone', () => {
    const w = world();
    frame(w, 8);
    wade(w, CONTENTS.WATER, 3);
    w.state.stats[STAT.HEALTH] = 0;
    w.entity.health = 0;
    expect(hurts(w, 16, 12_100)).toEqual([]);
    expect(tempEvents(w.level, EV.GENERAL_SOUND)).toEqual([]);
  });
});

describe('lava and slime', () => {
  it("pins Q3's hurts and its frame", () => {
    expect(LAVA_DAMAGE).toBe(30);
    expect(SLIME_DAMAGE).toBe(10);
    expect(SIZZLE_FRAME_MSEC).toBe(50);
  });

  it("burn in Q3's rhythm at the port's frame: two 50 ms apart every 750 ms", () => {
    const w = world();
    hardy(w);
    wade(w, CONTENTS.LAVA, 1);
    // Quake 3's frames at 50, 750, 800, 1500, 1550, 2250 and 2300, each on its first 8 ms frame.
    expect(hurts(w, 8, 2999)).toEqual([
      [56, 30],
      [752, 30],
      [800, 30],
      [1504, 30],
      [1552, 30],
      [2256, 30],
      [2304, 30]
    ]);
  });

  it("burn on the same frames at Q3's own 50 ms frame", () => {
    const w = world();
    hardy(w);
    wade(w, CONTENTS.LAVA, 1);
    expect(hurts(w, 50, 2999, 50).map(([time]) => time)).toEqual([
      50, 750, 800, 1500, 1550, 2250, 2300
    ]);
  });

  it("count Q3's frames from the level's start", () => {
    const w = world({ startTime: 4 });
    hardy(w);
    wade(w, CONTENTS.LAVA, 1);
    expect(hurts(w, 12, 200)).toEqual([[60, 30]]);
  });

  it('cost a water level each: slime 10, lava 30, through armor', () => {
    const w = world();
    hardy(w);
    w.state.stats[STAT.ARMOR] = 100;
    wade(w, CONTENTS.SLIME, 2);
    frame(w, 56);
    // The armor takes its share of 20, as `G_Damage` gives it any hit without `DAMAGE_NO_ARMOR`.
    expect(1000 - w.state.stats[STAT.HEALTH] + (100 - w.state.stats[STAT.ARMOR])).toBe(20);
    expect(w.state.stats[STAT.ARMOR]).toBeLessThan(100);

    const lava = world();
    hardy(lava);
    lava.state.stats[STAT.ARMOR] = 100;
    wade(lava, CONTENTS.LAVA, 2);
    frame(lava, 56);
    expect(1000 - lava.state.stats[STAT.HEALTH] + (100 - lava.state.stats[STAT.ARMOR])).toBe(60);
    expect(lava.state.stats[STAT.ARMOR]).toBeLessThan(100);
  });

  it('are not held off by a burn god mode took nothing from', () => {
    const w = world({ god: true });
    hardy(w);
    wade(w, CONTENTS.LAVA, 1);
    expect(hurts(w, 8, 1000)).toEqual([]);
    w.life.god = false;
    expect(hurts(w, 1008, 1100)).toEqual([[1056, 30]]);
  });

  it('keep their rhythm whatever other pain did', () => {
    const w = world();
    hardy(w);
    // A fall's, which in Quake 3 would hold the burn off.
    w.entity.painDebounceTime = 10_000;
    wade(w, CONTENTS.SLIME, 1);
    expect(hurts(w, 8, 800).map(([time]) => time)).toEqual([56, 752, 800]);
  });

  it('pulse the battle suit 20 times a second instead, and hurt nothing', () => {
    const w = world();
    hardy(w);
    w.state.powerups[PW.BATTLESUIT] = 10_000;
    wade(w, CONTENTS.LAVA, 1);
    expect(pulses(w, 8, 1000)).toBe(20);
    expect(w.state.stats[STAT.HEALTH]).toBe(1000);
  });

  it('leave the dead alone', () => {
    const w = world();
    w.state.stats[STAT.HEALTH] = 0;
    wade(w, CONTENTS.LAVA, 1);
    expect(hurts(w, 8, 1000)).toEqual([]);
  });

  it('sound the fry from the player while they stand in either, and nothing else', () => {
    const w = world();
    hardy(w);
    for (const [watertype, waterlevel, loop] of [
      [CONTENTS.LAVA, 1, FRY],
      [CONTENTS.SLIME, 2, FRY],
      [CONTENTS.WATER, 3, 0],
      [0, 0, 0]
    ]) {
      wade(w, watertype, waterlevel);
      w.life.endFrame();
      expect(w.state.loopSound).toBe(loop);
      expect(w.entity.s.loopSound).toBe(loop);
    }
  });
});

describe('CONTENTS_NODROP', () => {
  /** The world in nodrop east of x = 50. */
  const eastDrops: PointContentsFn = (point) => (point.x > 50 ? CONTENTS.NODROP : 0);

  it('lets a death in it drop what it carried, whose flag is sent home where it lands', () => {
    const w = world({ gametype: GT.CTF, toss: true });
    const base = w.level.spawnEntity();
    base.classname = 'team_CTF_redflag';
    base.item = findItem('team_CTF_redflag')!;
    base.r.contents = 0;
    w.level.teamgame.redStatus = FLAG.TAKEN;
    w.state.powerups[PW.REDFLAG] = FLAG_NEVER_EXPIRES;
    w.contents = eastDrops;

    damage(w.level, w.entity, null, null, null, 200, 0, MOD.ROCKET);

    expect(w.tossed).toBe(1);
    const [flag] = w.level.gentities.filter((e) => e.inuse && e.item === base.item && e !== base);
    expect(flag.r.currentOrigin.x).toBe(100);
    expect(w.level.teamgame.redStatus).toBe(FLAG.DROPPED);

    hurts(w, 8, 1000);

    expect(flag.inuse).toBe(false);
    expect(w.level.teamgame.redStatus).toBe(FLAG.ATBASE);
    expect(base.r.contents).toBe(CONTENTS.TRIGGER);
  });

  it('lets a death outside it drop what it carried', () => {
    const w = world();
    w.contents = (point) => (point.x < 50 ? CONTENTS.NODROP : 0);
    damage(w.level, w.entity, null, null, null, 200, 0, MOD.ROCKET);
    expect(w.tossed).toBe(1);
  });

  it('never gibs, holding the body a point short of it, but for a suicide', () => {
    const w = world();
    w.contents = eastDrops;
    w.life.endFrame();
    const before = w.state.externalEvent;
    damage(w.level, w.entity, null, null, null, 300, 0, MOD.ROCKET);

    expect(w.entity.s.eType).toBe(ET.PLAYER);
    expect(w.entity.takedamage).toBe(true);
    expect([w.entity.health, w.state.stats[STAT.HEALTH]]).toEqual([-39, -39]);
    expect(w.state.externalEvent).not.toBe(before);
    expect(eventNumber(w.state.externalEvent)).toBe(EV.DEATH1);

    const suicide = world();
    suicide.contents = eastDrops;
    damage(suicide.level, suicide.entity, null, null, null, 300, 0, MOD.SUICIDE);
    expect(suicide.entity.s.eType).toBe(ET.INVISIBLE);
  });

  it('gibs outside it', () => {
    const w = world();
    damage(w.level, w.entity, null, null, null, 300, 0, MOD.ROCKET);
    expect(w.entity.s.eType).toBe(ET.INVISIBLE);
  });

  it("leaves no body where the entity state's origin is in it, wherever the player fell", () => {
    const w = world();
    w.contents = (point) => (point.x < 50 ? CONTENTS.NODROP : 0);
    damage(w.level, w.entity, null, null, null, 50, 0, MOD.ROCKET);

    expect(copyToBodyQue(w.level, w.entity)).toBeNull();
    expect(w.level.bodyQue.filter((body) => body.r.linked)).toEqual([]);
    expect(w.entity.r.linked).toBe(false);

    const fell = world();
    fell.contents = eastDrops;
    damage(fell.level, fell.entity, null, null, null, 50, 0, MOD.ROCKET);
    expect(copyToBodyQue(fell.level, fell.entity)).not.toBeNull();
  });

  it('takes away a dropped item that lands in it, and keeps one that lands outside', () => {
    const w = world();
    w.contents = eastDrops;
    const rail = findItem('weapon_railgun')!;
    const lost = launchItem(w.level, rail, vec3(100, 0, 100), vec3());
    const kept = launchItem(w.level, rail, vec3(-100, 0, 100), vec3());
    hurts(w, 8, 1000);

    expect(lost.inuse).toBe(false);
    expect(kept.inuse).toBe(true);
    expect(kept.r.currentOrigin.z).toBeLessThan(100);
  });

  it('keeps an item that only falls through it, asking where the fall ends', () => {
    const w = world();
    w.contents = (point) => (point.z > 50 ? CONTENTS.NODROP : 0);
    const rail = launchItem(w.level, findItem('weapon_railgun')!, vec3(-100, 0, 200), vec3());
    hurts(w, 8, 1500);
    expect(rail.inuse).toBe(true);
    expect(rail.r.currentOrigin.z).toBeLessThan(50);
  });

  it('sends a red flag home as well as a blue', () => {
    const w = world({ gametype: GT.CTF });
    const base = w.level.spawnEntity();
    base.classname = 'team_CTF_redflag';
    base.item = findItem('team_CTF_redflag')!;
    w.contents = eastDrops;
    launchItem(w.level, findItem('team_CTF_redflag')!, vec3(100, 0, 100), vec3());
    hurts(w, 8, 1000);
    expect(w.level.teamgame.redStatus).toBe(FLAG.ATBASE);
  });

  it('sends a dropped flag that lands in it home', () => {
    const w = world({ gametype: GT.CTF });
    const base = w.level.spawnEntity();
    base.classname = 'team_CTF_blueflag';
    base.item = findItem('team_CTF_blueflag')!;
    base.r.contents = 0;
    w.contents = eastDrops;
    const flag = launchItem(w.level, findItem('team_CTF_blueflag')!, vec3(100, 0, 100), vec3());
    expect(w.level.teamgame.blueStatus).toBe(FLAG.DROPPED);

    hurts(w, 8, 1000);

    expect(flag.inuse).toBe(false);
    expect(w.level.teamgame.blueStatus).toBe(FLAG.ATBASE);
    expect(base.r.contents).toBe(CONTENTS.TRIGGER);
  });

  it('takes away a body that falls into it, which is unlinked rather than freed', () => {
    const w = world();
    w.contents = (point) => (point.z < 40 && point.x > 50 ? CONTENTS.NODROP : 0);
    w.state.origin = vec3(100, 0, 100);
    w.entity.r.currentOrigin = vec3(100, 0, 100);
    damage(w.level, w.entity, null, null, null, 50, 0, MOD.ROCKET);
    // In the air when it was left, so it falls.
    w.state.groundEntityNum = ENTITYNUM_NONE;
    w.life.endFrame();
    const body = copyToBodyQue(w.level, w.entity)!;
    expect(body.r.linked).toBe(true);

    for (let time = 8; time <= 1000 && body.r.linked; time += 8) w.level.runFrame(time);

    expect(body.r.linked).toBe(false);
    expect(body.inuse).toBe(true);
  });
});
