import { describe, expect, it } from 'vitest';

import { createNetUserCmd } from '../net/protocol';
import { NOT_SAVED, NUM_PING_SAMPLES } from './client';
import { damage } from './combat';
import { CROUCH_HEIGHT, DEAD_HEIGHT, MOD, PM_DEAD, TEAM } from './constants';
import { SVF, type GameEntity } from './game-entity';
import { Level } from './level';
import { spawnClient } from './life-test-fixtures';
import {
  HISTORY_MSEC,
  resetHistory,
  samplePing,
  shotSeed,
  storeHistory,
  timeShiftFor,
  undoTimeShiftFor,
  unTimeShiftClient
} from './unlagged';
import { copy, vec3 } from './vec3';
import { WP } from './weapons/constants';

/**
 * Lag compensation's server half: each player's history, the rewind a hitscan shot runs the others
 * through, and true ping.
 */

/** The level's clock at the start, a second in, so no time here is a zero. */
const START = 1000;

/** A frame's length, `sv_fps` 125's. */
const FRAME = 8;

/**
 * Three players in a bare world: the shooter in slot 0, a target in 1 and another in 2. What the
 * server sends any of them is kept.
 */
function world() {
  const sent: { to: number | null; text: string }[] = [];
  const level = new Level({
    handlers: { sendServerCommand: (to, text) => sent.push({ to, text }) },
    startTime: START
  });
  const [shooter, target, other] = [0, 1, 2].map(
    (slot) => spawnClient({ level, slot, origin: vec3(0, slot * 100, 24) }).entity
  );
  return { level, shooter, target, other, sent };
}

/**
 * Stand a player as a think leaves them: a snapshot shows them at `x`, the world links them by a
 * box round it, and the traces find them a quarter unit on, where they really are.
 */
function stand(level: Level, entity: GameEntity, x: number): void {
  const { y, z } = entity.s.pos.trBase;
  entity.s.pos.trBase = vec3(x, y, z);
  entity.r.currentOrigin = copy(entity.s.pos.trBase);
  level.linkEntity(entity);
  entity.r.currentOrigin = vec3(x + 0.25, y, z);
}

/** A frame's end at `time`: the clock moves on and each player is recorded where they stand. */
function endFrame(level: Level, time: number, players: GameEntity[]): void {
  level.previousTime = level.time;
  level.time = time;
  for (const player of players) storeHistory(level, player);
}

/**
 * A second of frames, with the target walking down +x a unit for every millisecond after the
 * start: at 1100 it stood at 100, and at the last frame, 2000, at 1000.
 */
function walked() {
  const built = world();
  const { level, shooter, target, other } = built;
  for (let time = START + FRAME; time <= 2000; time += FRAME) {
    stand(level, target, time - START);
    endFrame(level, time, [shooter, target, other]);
  }
  return built;
}

/** Name the frame the shooter drew in the command they fire on. */
function drew(shooter: GameEntity, time: number, snapTime: number, nextSnapTime: number): void {
  const cmd = shooter.client!.pers.cmd;
  cmd.serverTime = time + FRAME;
  cmd.drawnTime = time;
  cmd.drawnSnapTime = snapTime;
  cmd.drawnNextSnapTime = nextSnapTime;
}

/** Where a player is traced at, across x alone. */
function tracedX(entity: GameEntity): number {
  return entity.r.currentOrigin.x;
}

describe('the history', () => {
  it("records where a snapshot shows each player, their box and the frame's time", () => {
    const { target } = walked();
    const client = target.client!;
    const newest = client.history[client.historyHead];

    expect(newest.origin).toEqual(vec3(1000, 100, 24));
    expect(newest.mins).toEqual(target.r.mins);
    expect(newest.maxs).toEqual(target.r.maxs);
    expect(newest.time).toBe(2000);
  });

  it("holds 850 ms of frames, as many records as the frame's length needs", () => {
    const { level, shooter, target, other } = walked();
    expect(target.client!.history).toHaveLength(Math.ceil(HISTORY_MSEC / FRAME));

    // `sv_fps` 20: the newest records are kept, in their order, in a history of 17.
    stand(level, target, 1050);
    endFrame(level, 2050, [shooter, target, other]);
    const client = target.client!;
    expect(client.history).toHaveLength(17);
    const back = (i: number) => client.history[(client.historyHead - i + 17) % 17];
    const times = client.history.map((_, i) => back(i).time);
    expect(times.slice(0, 3)).toEqual([2050, 2000, 1992]);
  });

  it('repeats its oldest record when made longer, so an older time still finds the oldest', () => {
    const { level, shooter, target, other } = walked();
    // A frame at `sv_fps` 20 and one at 125 again: the 17 kept go back to the record at 1880.
    for (const time of [2050, 2058]) {
      stand(level, target, time - START);
      endFrame(level, time, [shooter, target, other]);
    }
    expect(target.client!.history).toHaveLength(Math.ceil(HISTORY_MSEC / FRAME));
    drew(shooter, 1500, 1500, 1500);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(tracedX(target)).toBe(880);
  });

  it('is filled at a reset with where the player stands, a frame apart back from now', () => {
    const { level, target } = walked();
    resetHistory(level, target);

    const client = target.client!;
    expect(client.historyHead).toBe(client.history.length - 1);
    client.history.forEach((record, i) => {
      expect(record.origin).toEqual(vec3(1000.25, 100, 24));
      expect(record.time).toBe(2000 - (client.historyHead - i) * FRAME);
    });
  });

  it('is filled at a reset with the box the player has now', () => {
    const { level, target } = walked();
    target.r.maxs = vec3(15, 15, CROUCH_HEIGHT);

    resetHistory(level, target);

    for (const record of target.client!.history) {
      expect(record.mins).toEqual(target.r.mins);
      expect(record.maxs).toEqual(vec3(15, 15, CROUCH_HEIGHT));
    }
  });
});

describe('a rewind', () => {
  it('puts the others where the shooter drew them, between two snapshots by its fraction', () => {
    const { level, shooter, target, other } = walked();
    drew(shooter, 1610, 1600, 1650);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    // A fifth of the way from 600 to 650.
    expect(target.r.currentOrigin).toEqual(vec3(610, 100, 24));
    // The one who stood still is where they stood, which is the record and not the quarter on.
    expect(other.r.currentOrigin).toEqual(vec3(0, 200, 24));
    expect(tracedX(shooter)).toBe(0);
  });

  it('finds a snapshot time between two records between them', () => {
    const { level, shooter, target } = walked();
    drew(shooter, 1602, 1602, 1602);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(tracedX(target)).toBe(602);
  });

  it('moves nobody for snapshots at or past the newest record', () => {
    const { level, shooter, target } = walked();
    drew(shooter, 2000, 2000, 2010);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(tracedX(target)).toBe(1000.25);
    expect(target.client!.saved.time).toBe(NOT_SAVED);
  });

  it('takes where a player is now for a next snapshot at or past the newest record', () => {
    const { level, shooter, target } = walked();
    drew(shooter, 1996, 1992, 2000);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    // Halfway from the record at 1992 to the quarter on that the traces find now.
    expect(tracedX(target)).toBe(996.125);
  });

  it('takes the oldest record for a time before the history', () => {
    const { level, shooter, target } = walked();
    const oldest = 2000 - (Math.ceil(HISTORY_MSEC / FRAME) - 1) * FRAME;
    drew(shooter, 1100, 1100, 1100);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(tracedX(target)).toBe(oldest - START);
  });

  it('holds the fraction to the two snapshots it names', () => {
    const { level, shooter, target } = walked();
    drew(shooter, 1800, 1600, 1650);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(tracedX(target)).toBe(650);
  });

  it('takes a command that names no drawn frame at its own time', () => {
    const { level, shooter, target } = walked();
    drew(shooter, 0, 0, 0);
    shooter.client!.pers.cmd.serverTime = 1500;

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(tracedX(target)).toBe(500);
  });

  it('moves the dead and bots, and passes over the shooter and anyone watching', () => {
    const { level, shooter, target, other } = walked();
    const watching = spawnClient({ level, slot: 3, origin: vec3(0, 300, 24) }).entity;
    const eliminated = spawnClient({ level, slot: 4, origin: vec3(0, 400, 24) }).entity;
    const bot = spawnClient({ level, slot: 5, origin: vec3(0, 500, 24) }).entity;
    const players = [shooter, target, other, watching, eliminated, bot];
    for (let time = 2008; time <= 2400; time += FRAME) {
      for (const player of players) stand(level, player, time - START);
      endFrame(level, time, players);
    }
    target.client!.ps.pmType = PM_DEAD;
    watching.client!.sess.sessionTeam = TEAM.SPECTATOR;
    eliminated.client!.pers.roundSpectator = true;
    bot.r.svFlags |= SVF.BOT;
    drew(shooter, 2100, 2100, 2100);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(players.map(tracedX)).toEqual([1400.25, 1100, 1100, 1400.25, 1400.25, 1100]);
  });

  it('moves the player in the first slot for a shot from another', () => {
    const { level, shooter: first, target, other } = world();
    for (let time = START + FRAME; time <= 2000; time += FRAME) {
      stand(level, first, time - START);
      endFrame(level, time, [first, target, other]);
    }
    drew(other, 1600, 1600, 1600);

    timeShiftFor(level, other, WP.RAILGUN, 1);

    expect(tracedX(first)).toBe(600);
  });

  it("is never a bot's", () => {
    const { level, shooter, target } = walked();
    shooter.r.svFlags |= SVF.BOT;
    drew(shooter, 1600, 1600, 1600);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(tracedX(target)).toBe(1000.25);
  });

  it.each([
    [1, WP.MACHINEGUN, true],
    [1, WP.RAILGUN, true],
    [204, WP.SHOTGUN, true],
    [204, WP.LIGHTNING, true],
    [4, WP.MACHINEGUN, true],
    [128, WP.RAILGUN, true],
    [128, WP.MACHINEGUN, false],
    [8, WP.MACHINEGUN, false],
    [0, WP.RAILGUN, false]
  ])('at xp_unlagged %i, weapon %i finds others as drawn: %s', (unlagged, weapon, drawn) => {
    const { level, shooter, target } = walked();
    drew(shooter, 1600, 1600, 1600);
    // Any other a snapshot gap before the command ran: 56 ms, at 20 snapshots a second.
    shooter.client!.pers.snapshotMsec = 50;

    timeShiftFor(level, shooter, weapon, unlagged);

    expect(tracedX(target)).toBe(drawn ? 600 : 944);
  });

  it('puts everyone back, in the world by the box it found them by', () => {
    const { level, shooter, target } = walked();
    const before = { ...target.r, absmin: copy(target.r.absmin), absmax: copy(target.r.absmax) };
    drew(shooter, 1600, 1600, 1600);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);
    expect(target.r.absmin.x).toBe(600 + target.r.mins.x - 1);
    undoTimeShiftFor(level, shooter);

    expect(target.r.currentOrigin).toEqual(vec3(1000.25, 100, 24));
    expect(target.r.mins).toEqual(before.mins);
    expect(target.r.maxs).toEqual(before.maxs);
    // Round the snapped origin, as the think linked them, not round the exact one.
    expect(target.r.absmin).toEqual(before.absmin);
    expect(target.r.absmax).toEqual(before.absmax);
    expect(target.client!.saved.time).toBe(NOT_SAVED);

    // Nothing is saved now, so a second restore leaves them be.
    target.r.currentOrigin = vec3(7, 7, 7);
    undoTimeShiftFor(level, shooter);
    expect(target.r.currentOrigin).toEqual(vec3(7, 7, 7));
  });

  it('gives a player the box they had then, and links them by their own once put back', () => {
    const { level, shooter, target, other } = world();
    const standing = copy(target.r.maxs);
    // Crouched until 1800, and standing from then on.
    target.r.maxs = vec3(standing.x, standing.y, CROUCH_HEIGHT);
    for (let time = START + FRAME; time <= 2000; time += FRAME) {
      if (time === 1800) target.r.maxs = copy(standing);
      stand(level, target, time - START);
      endFrame(level, time, [shooter, target, other]);
    }
    const solid = target.s.solid;
    drew(shooter, 1600, 1600, 1600);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);
    expect(target.r.maxs.z).toBe(CROUCH_HEIGHT);
    expect(target.s.solid).not.toBe(solid);
    undoTimeShiftFor(level, shooter);

    expect(target.r.maxs).toEqual(standing);
    // The box a snapshot sends of them is the one linking packs.
    expect(target.s.solid).toBe(solid);
  });

  it('saves a player once a frame, so that two rewinds still put them back where they were', () => {
    const { level, shooter, target } = walked();
    drew(shooter, 1600, 1600, 1600);
    timeShiftFor(level, shooter, WP.RAILGUN, 1);
    drew(shooter, 1500, 1500, 1500);
    timeShiftFor(level, shooter, WP.RAILGUN, 1);
    expect(tracedX(target)).toBe(500);

    undoTimeShiftFor(level, shooter);

    expect(tracedX(target)).toBe(1000.25);
  });

  it("leaves one killed in it where they died, and the shot's restore passes them by", () => {
    const { level, shooter, target } = walked();
    drew(shooter, 1600, 1600, 1600);
    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    damage(level, target, shooter, shooter, vec3(1, 0, 0), 1000, 0, MOD.RAILGUN);
    expect(target.client!.ps.pmType).toBe(PM_DEAD);
    expect(tracedX(target)).toBe(1000.25);
    undoTimeShiftFor(level, shooter);

    expect(tracedX(target)).toBe(1000.25);
    expect(target.r.maxs.z).toBe(DEAD_HEIGHT);
  });

  it("restores only a save of this frame's", () => {
    const { level, shooter, target, other } = walked();
    drew(shooter, 1600, 1600, 1600);
    timeShiftFor(level, shooter, WP.RAILGUN, 1);
    endFrame(level, 2008, [shooter, other]);

    unTimeShiftClient(level, target);

    expect(tracedX(target)).toBe(600);
  });
});

describe('a rewind for a weapon xp_unlagged leaves out', () => {
  it.each([
    // 20 snapshots a second, 50 ms apart, which go at every seventh frame.
    [50, 0, 944],
    // The same, run 5 ms after the last frame ended: between two records.
    [50, 5, 949],
    // 30 a second, 33 ms apart, at every fifth.
    [33, 0, 960]
  ])('at snapshots %i ms apart, run %i ms after a frame: back to x %d', (msec, offset, x) => {
    const { level, shooter, target } = walked();
    drew(shooter, 1600, 1600, 1600);
    shooter.client!.pers.snapshotMsec = msec;
    shooter.client!.frameOffset = offset;

    timeShiftFor(level, shooter, WP.RAILGUN, 0);

    expect(tracedX(target)).toBe(x);
  });

  it('moves nobody for a player sent a snapshot every frame, whose command ran a frame on', () => {
    const { level, shooter, target } = walked();
    shooter.client!.pers.snapshotMsec = FRAME;
    shooter.client!.frameOffset = FRAME;

    timeShiftFor(level, shooter, WP.RAILGUN, 0);

    expect(tracedX(target)).toBe(1000.25);
    expect(target.client!.saved.time).toBe(NOT_SAVED);
  });
});

describe('cg_debugDelag', () => {
  /** A second walked, with the shooter asking for the report and their command run 3 ms late. */
  function debugging() {
    const built = walked();
    built.shooter.client!.pers.debugDelag = true;
    built.shooter.client!.frameOffset = 3;
    return built;
  }

  it("prints each target's rewind to a railgun's shooter, and the frame's times", () => {
    const { level, shooter, sent } = debugging();
    drew(shooter, 1610, 1600, 1650);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(sent).toEqual([
      {
        to: 0,
        text:
          'print "^1Rec: time: 1610, j: 1600, k: 1650, origin: 610.00 100.00 24.00\n' +
          '^2frac: 0.2000, origin1: 600.00 100.00 24.00, origin2: 650.00 100.00 24.00\n' +
          '^7level.time: 2000, est time: 2003, level.time delta: 390, est real ping: 393\n"'
      },
      {
        to: 0,
        text:
          'print "^1Rec: time: 1610, j: 1600, k: 1650, origin: 0.00 200.00 24.00\n' +
          '^2frac: 0.2000, origin1: 0.00 200.00 24.00, origin2: 0.00 200.00 24.00\n' +
          '^7level.time: 2000, est time: 2003, level.time delta: 390, est real ping: 393\n"'
      }
    ]);
  });

  it('says No rec for a target it leaves where they are, at the frame', () => {
    const { level, shooter, sent } = debugging();
    drew(shooter, 2000, 2000, 2010);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(sent[0].text).toBe(
      'print "^1No rec: time: 2000, j: 2000, k: 2000, origin: 1000.25 100.00 24.00\n' +
        '^2frac: 0.0000, origin1: 1000.25 100.00 24.00, origin2: 1000.25 100.00 24.00\n' +
        '^7level.time: 2000, est time: 2003, level.time delta: 0, est real ping: 3\n"'
    );
  });

  it('prints a shot xp_unlagged leaves out at the time it falls back to', () => {
    const { level, shooter, sent } = debugging();
    drew(shooter, 1600, 1600, 1600);
    shooter.client!.pers.snapshotMsec = 50;

    timeShiftFor(level, shooter, WP.RAILGUN, 0);

    // 56 ms back, the 50 ms gap in whole frames, from when the command ran.
    expect(sent[0].text).toContain('^1Rec: time: 1947, j: 1947, k: 1947, origin: 947.00 100.00 ');
  });

  it("reckons the frame's times from the whole milliseconds the shot was aimed at", () => {
    const { level, shooter, sent } = debugging();
    drew(shooter, 1610 + 128 / 256, 1600, 1650);

    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(sent[0].text).toContain(
      '^7level.time: 2000, est time: 2003, level.time delta: 390, est real ping: 393\n'
    );
  });

  it('prints nothing for another weapon, or for a shooter who did not ask', () => {
    const { level, shooter, sent } = debugging();
    drew(shooter, 1610, 1600, 1650);
    timeShiftFor(level, shooter, WP.MACHINEGUN, 1);
    undoTimeShiftFor(level, shooter);
    shooter.client!.pers.debugDelag = false;
    timeShiftFor(level, shooter, WP.RAILGUN, 1);

    expect(sent).toEqual([]);
  });
});

describe("a shot's seed", () => {
  it('is the whole milliseconds of the drawn time, round 256, or of its own without one', () => {
    const cmd = createNetUserCmd();
    Object.assign(cmd, { serverTime: 1500, drawnTime: 1003 + 200 / 256, drawnSnapTime: 950 });
    expect(shotSeed(cmd)).toBe(1003 % 256);
    cmd.drawnSnapTime = 0;
    expect(shotSeed(cmd)).toBe(1500 % 256);
  });
});

describe('true ping', () => {
  /** A command run `offset` ms after the last frame ended, which drew its frame at `drawnAt`. */
  function measure(level: Level, entity: GameEntity, drawnAt: number, offset = 10): void {
    drew(entity, drawnAt, drawnAt, drawnAt);
    entity.client!.frameOffset = offset;
    samplePing(level, entity.client!);
  }

  it("is the mean of the last 64 commands' run, less a snapshot gap, less their drawn time", () => {
    const { level, shooter } = walked();
    const { pers } = shooter.client!;
    pers.snapshotMsec = 50;

    // Run at 2010, less 56, less 1900: 54 each, so the mean climbs as the ring fills.
    for (let i = 0; i < NUM_PING_SAMPLES / 2; i++) measure(level, shooter, 1900);
    expect(pers.realPing).toBe(27);
    for (let i = 0; i < NUM_PING_SAMPLES / 2; i++) measure(level, shooter, 1900);
    expect(pers.realPing).toBe(54);

    // The next goes over the oldest: 63 of 54 and one of -10.
    measure(level, shooter, 1964);
    expect(pers.sampleHead).toBe(1);
    expect(pers.realPing).toBe(53);
  });

  it('holds the mean at 0, and keeps each sample as it was', () => {
    const { level, shooter } = walked();
    const { pers } = shooter.client!;
    pers.snapshotMsec = 50;

    // Drawn at the last frame and run at once: 56 under.
    measure(level, shooter, 2000, 0);

    expect(pers.pingSamples[0]).toBe(-56);
    expect(pers.realPing).toBe(0);
  });

  it("drops the mean's fraction, as C's whole-number division does", () => {
    const { level, shooter } = walked();
    const { pers } = shooter.client!;
    pers.snapshotMsec = 50;

    // Three of 54: 162 over 64, or 2.53.
    for (let i = 0; i < 3; i++) measure(level, shooter, 1900);

    expect(pers.realPing).toBe(2);
  });

  it('measures a command that names no drawn frame from its own time', () => {
    const { level, shooter } = walked();
    const client = shooter.client!;
    client.pers.snapshotMsec = 50;
    drew(shooter, 0, 0, 0);
    client.pers.cmd.serverTime = 1900;
    client.frameOffset = 10;

    samplePing(level, client);

    expect(client.pers.pingSamples[0]).toBe(54);
  });
});
