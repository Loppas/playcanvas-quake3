import { describe, expect, it } from 'vitest';

import { MAX_PS_EVENTS, createEntityState, createPlayerState } from '../net/protocol';
import { createGameClient } from './client';
import {
  EV,
  EV_EVENT_BIT1,
  EV_EVENT_BIT2,
  EV_EVENT_BITS,
  addPredictableEvent,
  eventNumber,
  eventsSince,
  isStepEvent,
  nextEventField
} from './events';
import { addEvent, createGameEntity } from './game-entity';

/**
 * The one channel the simulation talks to a client through: the numbers, the ring on the player
 * state, and `G_AddEvent`'s two places to put one.
 */

/** An entity with a client slot behind it, as every client's entity has. */
function client() {
  const entity = createGameEntity();
  entity.client = createGameClient();
  entity.inuse = true;
  return entity;
}

describe('the numbers', () => {
  it("are Quake 3's, gaps and all", () => {
    // The number is what goes on the wire, so leaving out a gap would renumber everything after
    // it. These are `bg_public.h:351–457` read off directly, including the Team Arena block that
    // ships inside every build's enum whether or not the code behind it does.
    expect(EV.NONE).toBe(0);
    expect(EV.FOOTSTEP).toBe(1);
    expect(EV.STEP_4).toBe(6);
    expect(EV.FALL_SHORT).toBe(10);
    expect(EV.JUMP).toBe(14);
    expect(EV.NOAMMO).toBe(21);
    expect(EV.CHANGE_WEAPON).toBe(22);
    expect(EV.FIRE_WEAPON).toBe(23);
    expect(EV.PAIN).toBe(56);
    expect(EV.DEATH1).toBe(57);
    expect(EV.GIB_PLAYER).toBe(64);
    expect(EV.TAUNT).toBe(76);
    expect(EV.TAUNT_PATROL).toBe(82);
  });

  it("put CPMA's step past the end of id's, so that none of id's moves", () => {
    expect(EV.STEP).toBe(EV.TAUNT_PATROL + 1);
  });

  it("know a step up: id's four heights, and CPMA's with its rise", () => {
    expect([EV.STEP_4, EV.STEP_8, EV.STEP_12, EV.STEP_16, EV.STEP].every(isStepEvent)).toBe(true);
    expect([EV.SWIM, EV.FALL_SHORT, EV.TAUNT_PATROL].some(isStepEvent)).toBe(false);
  });

  it('run consecutively, which is what lets a family be indexed', () => {
    // `EV_STEP_4 + n` and `EV_DEATH1 + lastDeath` are how the move and `player_die` pick one
    // (`bg_slidemove.c:321–328`, `g_combat.c:647`), so the order is a mechanism, not a listing.
    expect([EV.STEP_8, EV.STEP_12, EV.STEP_16]).toEqual([EV.STEP_4 + 1, EV.STEP_4 + 2, EV.STEP_4 + 3]);
    expect([EV.DEATH2, EV.DEATH3]).toEqual([EV.DEATH1 + 1, EV.DEATH1 + 2]);
    expect([EV.FALL_MEDIUM, EV.FALL_FAR]).toEqual([EV.FALL_SHORT + 1, EV.FALL_SHORT + 2]);
  });

  it('leave the top two bits for the counter', () => {
    expect([EV_EVENT_BIT1, EV_EVENT_BIT2, EV_EVENT_BITS]).toEqual([0x100, 0x200, 0x300]);
    // Every event fits under the counter, which is why the two can share one field.
    expect(Math.max(...Object.values(EV))).toBeLessThan(EV_EVENT_BIT1);
  });
});

describe('the predictable ring', () => {
  it('puts an event in the ring and moves the sequence on', () => {
    const ps = createPlayerState();
    addPredictableEvent(ps, EV.JUMP);

    expect(ps.eventSequence).toBe(1);
    expect(eventsSince(ps, 0)).toEqual([{ event: EV.JUMP, parm: 0 }]);
  });

  it('carries no counter, because the sequence already tells two of the same apart', () => {
    const ps = createPlayerState();
    addPredictableEvent(ps, EV.FOOTSTEP);
    addPredictableEvent(ps, EV.FOOTSTEP);

    expect(eventsSince(ps, 0).map(({ event }) => event)).toEqual([EV.FOOTSTEP, EV.FOOTSTEP]);
    expect(ps.eventSequence).toBe(2);
  });

  it('is two deep, so a third event in one tick takes the first one away', () => {
    // `MAX_PS_EVENTS` is 2 because that is as many as one snapshot can carry, so a tick that
    // raises more than two has nowhere to put the rest and Quake 3 drops the oldest.
    expect(MAX_PS_EVENTS).toBe(2);

    const ps = createPlayerState();
    addPredictableEvent(ps, EV.JUMP);
    addPredictableEvent(ps, EV.FOOTSTEP);
    addPredictableEvent(ps, EV.TAUNT);

    expect(eventsSince(ps, 0).map(({ event }) => event)).toEqual([EV.FOOTSTEP, EV.TAUNT]);
  });

  it('carries the parm alongside', () => {
    const ps = createPlayerState();
    addPredictableEvent(ps, EV.GRENADE_BOUNCE, 3);

    expect(eventsSince(ps, 0)).toEqual([{ event: EV.GRENADE_BOUNCE, parm: 3 }]);
  });

  it('reads nothing when the reader is already up to date', () => {
    const ps = createPlayerState();
    addPredictableEvent(ps, EV.JUMP);

    expect(eventsSince(ps, ps.eventSequence)).toEqual([]);
  });
});

describe('G_AddEvent', () => {
  it("puts a client's event on the player state, where only that client reads it", () => {
    const entity = client();
    addEvent(entity, EV.PAIN, 70, 1000);

    expect(eventNumber(entity.client!.ps.externalEvent)).toBe(EV.PAIN);
    expect(entity.client!.ps.externalEventParm).toBe(70);
    expect(entity.client!.ps.externalEventTime).toBe(1000);
    // The entity state is left alone: `BG_PlayerStateToEntityState` is the only thing that puts
    // a client's event there, so that the two cannot disagree.
    expect(entity.s.event).toBe(0);
  });

  it("puts everything else's on the entity state", () => {
    const entity = createGameEntity();
    addEvent(entity, EV.GIB_PLAYER, 3, 1000);

    expect(eventNumber(entity.s.event)).toBe(EV.GIB_PLAYER);
    expect(entity.s.eventParm).toBe(3);
  });

  it('dates the event, which is what the frame takes it away by', () => {
    const entity = createGameEntity();
    addEvent(entity, EV.JUMP, 0, 4500);

    expect(entity.eventTime).toBe(4500);
  });

  it('moves the counter on every time, so the same event twice running reads as two', () => {
    const entity = createGameEntity();
    addEvent(entity, EV.FOOTSTEP, 0, 1000);
    const first = entity.s.event;
    addEvent(entity, EV.FOOTSTEP, 0, 1100);

    expect(entity.s.event).not.toBe(first);
    expect(eventNumber(entity.s.event)).toBe(EV.FOOTSTEP);
  });

  it('wraps the counter after four, which is all two bits hold', () => {
    const entity = createGameEntity();
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      addEvent(entity, EV.FOOTSTEP, 0, 1000 + i);
      seen.push(entity.s.event & EV_EVENT_BITS);
    }

    expect(seen).toEqual([EV_EVENT_BIT1, EV_EVENT_BIT2, EV_EVENT_BIT1 | EV_EVENT_BIT2, 0, EV_EVENT_BIT1]);
  });

  it('holds one at a time, so a second event in the same tick is the one that is heard', () => {
    // `player_die` then `GibEntity` inside one hit is the case that matters: the gib lands on
    // top of the death. Quake 3 accepts it, because the field is one event wide.
    const entity = client();
    addEvent(entity, EV.DEATH1, 0, 1000);
    addEvent(entity, EV.GIB_PLAYER, 0, 1000);

    expect(eventNumber(entity.client!.ps.externalEvent)).toBe(EV.GIB_PLAYER);
  });

  it('ignores a zero event, which is not an event', () => {
    const entity = createGameEntity();
    addEvent(entity, EV.NONE, 0, 1000);

    expect(entity.s.event).toBe(0);
    expect(entity.eventTime).toBe(0);
  });
});

describe('nextEventField', () => {
  it('is the same rule wherever an event is kept', () => {
    // The body queue writes its corpses' events itself, so the counter has to be one rule rather
    // than one per carrier.
    const s = createEntityState();
    s.event = nextEventField(s.event, EV.GIB_PLAYER);

    expect(s.event).toBe(EV.GIB_PLAYER | EV_EVENT_BIT1);
    expect(eventNumber(nextEventField(s.event, EV.GIB_PLAYER))).toBe(EV.GIB_PLAYER);
  });
});
