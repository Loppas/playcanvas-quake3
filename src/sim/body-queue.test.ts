import { describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, ENTITYNUM_WORLD, MAX_CLIENTS, TR } from '../net/protocol';
import { ANIM, ANIM_TOGGLEBIT } from './animations';
import {
  BODY_QUEUE_SIZE,
  BODY_SINK_DELAY,
  BODY_SINK_END,
  BODY_SINK_INTERVAL,
  clearBodyQue,
  copyToBodyQue
} from './body-queue';
import { box, createFlatWorldTrace } from './box-world';
import { CONTENTS, EF_DEAD, EF_TALK, MOD, PMOVE_MSEC, STAT } from './constants';
import { distinctAsks, recordingTrace } from './trace-test-fixtures';
import { EV, eventNumber } from './events';
import { ET, playerStateToEntityState, type GameEntity } from './game-entity';
import { runItem } from './item-run';
import { Level } from './level';
import { createIdlePlayerState } from './types';
import { GIB_HEALTH } from './combat';
import type { TraceFn } from './types';
import { vec3, type Vec3 } from './vec3';
import { evaluateTrajectory } from './trajectory';
import { radiusDamage } from './weapons/splash';

/**
 * The corpses, as entities in the level's own pool.
 *
 * A body is a thing in the world rather than a record of one, which is what lets a client draw it
 * by reading a snapshot. These drive it the way the game does: a dead player is copied into one of
 * the eight slots, and the level's frame runs it from there — through the shared `G_RunItem` port
 * (`item-run.ts`), which a body reaches as `physicsObject`.
 */

const flat = createFlatWorldTrace();

/** A level whose frame runs its corpses, standing in for a host with its links. */
function match(trace: TraceFn = flat): Level {
  const level: Level = new Level({
    handlers: { runItem: (entity) => runItem(level, entity, trace) }
  });
  return level;
}

/** Run the level a tick at a time, as the host does. */
function ticks(level: Level, from: number, to: number): void {
  for (let time = from; time <= to; time += PMOVE_MSEC) level.runFrame(time);
}

/** Put a dead player in slot 0, as `ClientEndFrame` leaves one the tick they died. */
function dying(
  level: Level,
  options: {
    origin?: Vec3;
    velocity?: Vec3;
    legsAnim?: number;
    grounded?: boolean;
    health?: number;
  } = {}
): GameEntity {
  const entity = level.gentities[0];
  entity.client = level.clients[0];
  entity.inuse = true;
  entity.classname = 'player';
  entity.r.mins = vec3(-15, -15, -24);
  entity.r.maxs = vec3(15, 15, 32);

  const grounded = options.grounded ?? true;
  Object.assign(
    entity.client.ps,
    createIdlePlayerState({
      origin: options.origin ?? vec3(0.7, 0.3, 24.125),
      velocity: options.velocity ?? vec3(),
      viewangles: vec3(0, 90.4, 0),
      legsAnim: options.legsAnim ?? (ANIM.BOTH_DEATH1 | ANIM_TOGGLEBIT),
      groundEntityNum: grounded ? ENTITYNUM_WORLD : ENTITYNUM_NONE
    })
  );
  entity.client.ps.stats[STAT.HEALTH] = options.health ?? -10;
  entity.client.ps.eFlags |= EF_TALK;
  entity.health = entity.client.ps.stats[STAT.HEALTH];
  playerStateToEntityState(entity.client.ps, entity.s, true);
  level.linkEntity(entity);
  return entity;
}

/** `CopyToBodyQue`, where it leaves a body. */
function leaveBody(level: Level, entity: GameEntity): GameEntity {
  const body = copyToBodyQue(level, entity);
  if (!body) throw new Error('no body was left');
  return body;
}

/** The corpses a client would be sent: the slots something has been copied into and not retired. */
function corpses(level: Level): GameEntity[] {
  return level.bodyQue.filter((body) => body.r.linked);
}

describe('InitBodyQue', () => {
  it("pins Q3's queue, and takes its slots before anything else on the map", () => {
    expect(BODY_QUEUE_SIZE).toBe(8);
    expect(BODY_SINK_DELAY).toBe(5000);
    expect(BODY_SINK_INTERVAL).toBe(100);
    expect(BODY_SINK_END).toBe(6500);

    const level = match();
    expect(level.bodyQue.map((body) => body.s.number)).toEqual([
      MAX_CLIENTS,
      MAX_CLIENTS + 1,
      MAX_CLIENTS + 2,
      MAX_CLIENTS + 3,
      MAX_CLIENTS + 4,
      MAX_CLIENTS + 5,
      MAX_CLIENTS + 6,
      MAX_CLIENTS + 7
    ]);
    // Held for the whole map: freeing one only unlinks it, so nothing else is given its number.
    for (const body of level.bodyQue) {
      expect(body.neverFree).toBe(true);
      expect(body.inuse).toBe(true);
      expect(body.r.linked).toBe(false);
    }
  });

  it('reaches nobody until a body is copied into it', () => {
    const level = match();
    expect(corpses(level)).toHaveLength(0);

    const body = leaveBody(level, dying(level));
    expect(corpses(level)).toEqual([body]);
  });
});

describe('CopyToBodyQue', () => {
  it('leaves an entity anyone can see, wearing what the player wore', () => {
    const level = match();
    const player = dying(level);
    const body = leaveBody(level, player);

    expect(body.s.eType).toBe(ET.PLAYER);
    expect(body.s.clientNum).toBe(player.s.clientNum);
    // `EF_DEAD` alone: whatever else the player was carrying goes with the body.
    expect(body.s.eFlags).toBe(EF_DEAD);
    expect(body.r.contents).toBe(CONTENTS.CORPSE);
    expect(body.r.ownerNum).toBe(player.s.number);
    expect(body.s.number).toBe(MAX_CLIENTS);
    // The player is taken out of the world in the same breath, so the two are never both there.
    expect(player.r.linked).toBe(false);
  });

  it('keeps the last frame of the death that played, so it does not fall again', () => {
    const level = match();
    const cases: [number, number][] = [
      [ANIM.BOTH_DEATH1, ANIM.BOTH_DEAD1],
      [ANIM.BOTH_DEAD1 | ANIM_TOGGLEBIT, ANIM.BOTH_DEAD1],
      [ANIM.BOTH_DEATH2 | ANIM_TOGGLEBIT, ANIM.BOTH_DEAD2],
      [ANIM.BOTH_DEATH3, ANIM.BOTH_DEAD3],
      // A gibbed player never played a death; the body takes the last one.
      [ANIM.LEGS_RUN, ANIM.BOTH_DEAD3]
    ];
    for (const [legs, dead] of cases) {
      const body = leaveBody(level, dying(level, { legsAnim: legs }));
      expect(body.s.legsAnim, String(legs)).toBe(dead);
      expect(body.s.torsoAnim, String(legs)).toBe(dead);
    }
  });

  it('lies at whole units, because that is where the entity it copies is', () => {
    const level = match();
    const body = leaveBody(level, dying(level));

    expect(body.s.pos.trType).toBe(TR.STATIONARY);
    expect(body.s.pos.trBase).toEqual(vec3(0, 0, 24));
    expect(body.s.apos.trBase).toEqual(vec3(0, 90, 0));
    expect(body.r.currentOrigin).toEqual(vec3(0, 0, 24));
  });

  it('takes the slots round, so the ninth body replaces the first', () => {
    const level = match();
    for (let i = 0; i < 9; i++) {
      leaveBody(level, dying(level, { origin: vec3(i * 100, 0, 24) }));
    }

    const xs = corpses(level).map((body) => body.s.pos.trBase.x);
    expect(xs).toHaveLength(8);
    expect(xs).not.toContain(0);
    expect(xs).toContain(800);
  });

  it('leaves a gibbed player a body past hurting', () => {
    const level = match();
    const whole = leaveBody(level, dying(level, { health: -10 }));
    expect(whole.takedamage).toBe(true);

    const pieces = leaveBody(level, dying(level, { health: GIB_HEALTH }));
    expect(pieces.takedamage).toBe(false);
  });

  it('empties on a restart', () => {
    const level = match();
    leaveBody(level, dying(level));
    clearBodyQue(level);

    expect(corpses(level)).toHaveLength(0);
    expect(level.bodyQueIndex).toBe(0);
  });
});

describe('BodySink', () => {
  it('lies still for five seconds, then sinks a unit per think until it goes', () => {
    // Q3's 100 ms think lands on the port's 8 ms tick every 104 ms, as the 450 ms weapon
    // switch comes to 464: the body sinks 15 units and is gone 6.56 s after the respawn.
    // Q3's 50 ms server frames give 16 units and 6.6 s.
    const level = match();
    const start = 800;
    ticks(level, PMOVE_MSEC, start);
    const body = leaveBody(level, dying(level));

    ticks(level, start + PMOVE_MSEC, start + 4992);
    expect(body.s.pos.trBase.z).toBe(24);

    ticks(level, start + 5000, start + 5000);
    expect(body.s.pos.trBase.z).toBe(23);

    ticks(level, start + 5008, start + 6552);
    expect(corpses(level)).toHaveLength(1);
    expect(body.s.pos.trBase.z).toBe(24 - 15);

    ticks(level, start + 6560, start + 6560);
    expect(corpses(level)).toHaveLength(0);
    // Unlinked rather than freed: the slot is still the body's, so nothing else can take it.
    expect(body.inuse).toBe(true);
    expect(body.physicsObject).toBe(false);
  });
});

describe('a body left in mid-air', () => {
  it('falls on the gravity arc, then rests a unit above the floor', () => {
    const level = match();
    const body = leaveBody(
      level,
      dying(level, { origin: vec3(0, 0, 200), velocity: vec3(100, 0, 0), grounded: false })
    );

    expect(body.s.pos.trType).toBe(TR.GRAVITY);
    // 100 ms in: 10 units along, and half of 800 · 0.1² = 4 units down.
    expect(evaluateTrajectory(body.s.pos, 100)).toEqual(vec3(10, 0, 196));

    // A body does not bounce: `CopyToBodyQue` gives it a `physicsBounce` of 0, so the first
    // thing it touches stops it dead. The fall from 200 units reaches the floor in 0.63 s, and
    // nothing follows it — a body that bounced would still be in the air here.
    ticks(level, PMOVE_MSEC, 700);
    expect(body.s.pos.trType).toBe(TR.STATIONARY);

    ticks(level, 708, 2000);
    // The box's bottom rests on the floor 24 below the origin, the trace stops an eighth of a
    // unit short, and the landing lifts it a unit, then snaps it down to whole units.
    expect(body.s.pos.trBase.z).toBe(25);
    expect(body.s.pos.trBase.x).toBeGreaterThan(50);
    expect(evaluateTrajectory(body.s.pos, 5000)).toEqual(body.s.pos.trBase);
    // `G_SetOrigin` moves the body without linking it again, so the box a blast measures to is
    // where the fall's last trace stopped rather than where the landing lifted it to.
    expect(body.r.absmin.z).toBeLessThan(body.s.pos.trBase.z + body.r.mins.z - 1);
    expect(body.r.absmin.z).toBeGreaterThan(24 + body.r.mins.z - 1);
  });
});

describe('a blast on the bodies', () => {
  /**
   * 80 points over 128 units: 96 units off a body's box, a blast gives it 20. The box is the one
   * `ClientSpawn` gives the player, as the world links it a unit bigger each way — 16 each way
   * across, and −1 to 57 up from the floor for a body lying on it.
   */
  const DAMAGE = 80;
  const RADIUS = 128;

  /** 96 units off the side of a body lying at the origin, level with its middle. */
  const SIDE = vec3(0, 16 + 96, 8);

  /**
   * A blast of another player's, at their handicap's max health. They are in slot 1 and out of
   * the world, so the blast reaches the bodies and nobody else.
   */
  function blast(level: Level, origin: Vec3, trace: TraceFn = flat, maxHealth = 100): void {
    const shooter = level.gentities[1];
    shooter.client = level.clients[1];
    shooter.inuse = true;
    shooter.client.ps.stats[STAT.MAX_HEALTH] = maxHealth;
    radiusDamage(level, trace, origin, shooter, DAMAGE, RADIUS, null, MOD.ROCKET_SPLASH);
  }

  /** A level with one body lying at the origin. */
  function lying(trace: TraceFn = flat): { level: Level; body: GameEntity } {
    const level = match(trace);
    return { level, body: leaveBody(level, dying(level, { origin: vec3(0, 0, 24) })) };
  }

  it("takes each body's share, and gibs one taken to −40", () => {
    const { level, body } = lying();
    blast(level, SIDE);
    expect(body.health).toBe(-20);
    expect(body.s.eType).toBe(ET.PLAYER);

    blast(level, SIDE);
    expect(body.health).toBe(-40);
    // `body_die` → `GibEntity`: past hurting, out of the world's way, and nothing left to draw.
    expect(eventNumber(body.s.event)).toBe(EV.GIB_PLAYER);
    expect(body.s.eventParm).toBe(0);
    expect(body.s.eType).toBe(ET.INVISIBLE);
    expect(body.takedamage).toBe(false);
    expect(body.r.contents).toBe(0);

    const gibbed = body.health;
    blast(level, SIDE);
    expect(body.health).toBe(gibbed);
  });

  it("scales the hurt by the attacker's handicap, and costs at least a point", () => {
    const { level, body } = lying();
    blast(level, SIDE, flat, 50);
    expect(body.health).toBe(-10);

    // Half a unit inside the radius, the falloff leaves 0.3 of a point, which truncates to none.
    blast(level, vec3(0, 16 + RADIUS - 0.5, 8));
    expect(body.health).toBe(-11);

    blast(level, vec3(0, 16 + RADIUS, 8));
    expect(body.health).toBe(-11);
  });

  it("leaves a gibbed player's body alone", () => {
    const level = match();
    const body = leaveBody(level, dying(level, { origin: vec3(0, 0, 24), health: GIB_HEALTH }));
    blast(level, vec3(0, 0, 8));
    expect(body.health).toBe(0);
  });

  it('does not reach a body behind a wall', () => {
    const walled = createFlatWorldTrace([box(-128, 40, 0, 128, 48, 128)]);
    const { level, body } = lying(walled);
    blast(level, SIDE, walled);
    expect(body.health).toBe(0);
  });

  it("keeps a slot's health for the body that takes it next", () => {
    const { level } = lying();
    blast(level, SIDE);
    // Seven more, out of reach; the ninth takes the first one's slot, and its −20.
    for (let i = 1; i < BODY_QUEUE_SIZE; i++) {
      leaveBody(level, dying(level, { origin: vec3(i * 1000, 0, 24) }));
    }
    const next = leaveBody(level, dying(level, { origin: vec3(0, 0, 24) }));
    expect(next.s.number).toBe(MAX_CLIENTS);

    blast(level, SIDE);
    expect(next.health).toBe(-40);
    expect(eventNumber(next.s.event)).toBe(EV.GIB_PLAYER);
  });

  it('starts every slot afresh on a restart', () => {
    const { level } = lying();
    blast(level, SIDE);
    clearBodyQue(level);

    const body = leaveBody(level, dying(level, { origin: vec3(0, 0, 24) }));
    blast(level, SIDE);
    expect(body.health).toBe(-20);
  });

  it('finds a sinking body where it lay', () => {
    const { level, body } = lying();
    ticks(level, PMOVE_MSEC, 6000);
    expect(body.s.pos.trBase.z).toBeLessThan(24 - 5);

    // A body that sinks is never linked again, so the box a blast measures to is where it landed
    // rather than where it is drawn (`BodySink` moves the trajectory alone).
    blast(level, SIDE);
    expect(body.health).toBe(-20);
  });
});

describe("a corpse's fall", () => {
  it('passes its own player and stops at the world alone, through players and corpses', () => {
    const { trace, asked } = recordingTrace(flat);
    const level = match(trace);
    const entity = dying(level, { origin: vec3(0, 0, 200), grounded: false });
    const body = leaveBody(level, entity);
    expect(body.clipmask).toBe(CONTENTS.SOLID | CONTENTS.PLAYERCLIP);

    ticks(level, PMOVE_MSEC, 100);

    expect(distinctAsks(asked)).toEqual([
      { passEntityNum: 0, contentmask: CONTENTS.SOLID | CONTENTS.PLAYERCLIP }
    ]);
  });

  it('comes to rest standing on whatever it landed on', () => {
    const onSix: TraceFn = (...args) => {
      const result = flat(...args);
      return result.fraction < 1 ? { ...result, entityNum: 6 } : result;
    };
    const level = match(onSix);
    const body = leaveBody(level, dying(level, { origin: vec3(0, 0, 60), grounded: false }));

    ticks(level, PMOVE_MSEC, 2000);

    expect(body.s.pos.trType).toBe(TR.STATIONARY);
    expect(body.s.groundEntityNum).toBe(6);
  });
});
