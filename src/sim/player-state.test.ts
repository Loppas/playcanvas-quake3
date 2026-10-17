import { describe, expect, it } from 'vitest';

import { readDeltaPlayerState, writeDeltaPlayerState } from '../net/delta';
import { Message } from '../net/msg';
import {
  createEntityState,
  createPlayerState,
  ENTITYNUM_NONE,
  ENTITYNUM_WORLD,
  MAX_POWERUPS,
  TR,
  type PlayerState
} from '../net/protocol';
import { ANIM } from './animations';
import { createFlatWorldTrace } from './box-world';
import { MINS_Z, PERS, PMOVE_MSEC, STAT } from './constants';
import { EV, addPredictableEvent, eventNumber } from './events';
import { playerStateToEntityState } from './game-entity';
import { pmove } from './pmove';
import { createArmedPlayerState, createIdlePlayerState, createUserCmd, type UserCmd } from './types';
import { vec3 } from './vec3';
import { ALL_WEAPONS, AMMO_INFINITE, WP } from './weapons/constants';

/**
 * The one state — that the move runs over the same `playerState_t` a snapshot carries.
 *
 * The port used to keep two: a reduced one the simulation ran on and the protocol's own, with a
 * conversion between them that nothing could check. These are the tests that would have been
 * impossible while there were two, and they are the reason for the merge: what a move leaves is
 * what goes on the wire, whole, with nothing in between to lose it.
 */

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = -MINS_Z;

const trace = createFlatWorldTrace();

/**
 * Advance a state by whole ticks against the flat world.
 *
 * @param state - State to move, in place.
 * @param ticks - How many {@link PMOVE_MSEC} ticks to run.
 * @param input - Input held for every one of them.
 */
function run(state: PlayerState, ticks: number, input: Partial<UserCmd> = {}): void {
  for (let i = 0; i < ticks; i++) {
    pmove(state, createUserCmd({ ...input, serverTime: state.commandTime + PMOVE_MSEC }), trace);
  }
}

describe('the state a move starts from', () => {
  it('is standing on nothing rather than on slot zero', () => {
    // A zeroed `playerState_t` reads as standing on entity 0, which is a real client, so the one
    // thing a state at rest has to say is that it is in the air.
    expect(createPlayerState().groundEntityNum).toBe(0);
    expect(createIdlePlayerState().groundEntityNum).toBe(ENTITYNUM_NONE);
  });

  it('keeps what it owns in the stats, where the wire reads them', () => {
    const armed = createArmedPlayerState();
    for (const weapon of ALL_WEAPONS) {
      expect(armed.stats[STAT.WEAPONS] & (1 << weapon), String(weapon)).toBeTruthy();
      // The ammo is the fixture's own promise: a test that fires a gun needs it loaded.
      expect(armed.ammo[weapon], String(weapon)).toBe(AMMO_INFINITE);
    }
    expect(armed.stats[STAT.HEALTH]).toBe(100);
    expect(armed.stats[STAT.MAX_HEALTH]).toBe(100);
    expect(armed.weapon).toBe(WP.GAUNTLET);
  });
});

describe('the ground', () => {
  it('is the world while the player stands on it, and nothing in the air', () => {
    const state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    run(state, 1);
    expect(state.groundEntityNum).toBe(ENTITYNUM_WORLD);

    run(state, 1, { upmove: 127 });
    expect(state.groundEntityNum).toBe(ENTITYNUM_NONE);

    run(state, 200);
    expect(state.groundEntityNum).toBe(ENTITYNUM_WORLD);
  });
});

describe('what the move does not own', () => {
  it('it leaves alone across a run of ticks', () => {
    const state = createArmedPlayerState({ origin: vec3(0, 0, GROUND_Z), weapon: WP.MACHINEGUN });
    state.clientNum = 3;
    state.persistant[PERS.SCORE] = 7;
    state.persistant[PERS.SPAWN_COUNT] = 2;
    state.powerups[MAX_POWERUPS - 1] = 9000;
    state.deltaAngles = vec3(0, 90, 0);
    state.ping = 42;
    state.generic1 = 5;

    run(state, 60, { forwardmove: 127, rightmove: 64, upmove: 127 });

    expect(state.clientNum).toBe(3);
    expect(state.persistant[PERS.SCORE]).toBe(7);
    expect(state.persistant[PERS.SPAWN_COUNT]).toBe(2);
    expect(state.powerups[MAX_POWERUPS - 1]).toBe(9000);
    expect(state.deltaAngles).toEqual(vec3(0, 90, 0));
    expect(state.ping).toBe(42);
    expect(state.generic1).toBe(5);
  });
});

describe('the state a move leaves', () => {
  it('goes over the wire and comes back the same', () => {
    const state = createArmedPlayerState({
      origin: vec3(0, 0, GROUND_Z),
      weapon: WP.ROCKET_LAUNCHER
    });
    run(state, 30, { forwardmove: 127, upmove: 127 });

    const out = Message.write(2048);
    writeDeltaPlayerState(out, null, state);
    expect(out.overflowed).toBe(false);
    const back = readDeltaPlayerState(Message.read(out.written.slice()), null, createPlayerState());

    // An origin is a float and comes back at the wire's 32 bits of one; a velocity has been
    // snapped to whole units by the move, so it comes back exact.
    expect(back.origin.x).toBeCloseTo(state.origin.x, 4);
    expect(back.origin.z).toBeCloseTo(state.origin.z, 4);
    expect(back.velocity).toEqual(state.velocity);
    expect(back.viewangles).toEqual(state.viewangles);
    expect(back.groundEntityNum).toBe(state.groundEntityNum);
    expect(back.bobCycle).toBe(state.bobCycle);
    expect(back.legsAnim).toBe(state.legsAnim);
    expect(back.torsoAnim).toBe(state.torsoAnim);
    expect(back.weapon).toBe(state.weapon);
    expect(back.weaponstate).toBe(state.weaponstate);
    expect(back.weaponTime).toBe(state.weaponTime);
    expect(back.stats).toEqual(state.stats);
    expect(back.ammo).toEqual(state.ammo);
  });

  it('is what the entity state other clients see is built from', () => {
    const state = createArmedPlayerState({ origin: vec3(0, 0, GROUND_Z), weapon: WP.SHOTGUN });
    state.clientNum = 2;
    run(state, 20, { forwardmove: 127 });

    const s = createEntityState();
    playerStateToEntityState(state, s, false);

    expect(s.number).toBe(2);
    expect(s.pos.trType).toBe(TR.INTERPOLATE);
    expect(s.pos.trBase).toEqual(state.origin);
    expect(s.pos.trDelta).toEqual(state.velocity);
    expect(s.groundEntityNum).toBe(ENTITYNUM_WORLD);
    expect(s.weapon).toBe(WP.SHOTGUN);
    expect(s.legsAnim).toBe(state.legsAnim);
    expect(s.torsoAnim).toBe(state.torsoAnim);
    expect(state.legsAnim).not.toBe(ANIM.LEGS_IDLE);
  });
});

describe('the events other clients see', () => {
  it('drains the ring one event per snapshot, since an entity state holds one at a time', () => {
    const state = createArmedPlayerState();
    const s = createEntityState();
    addPredictableEvent(state, EV.JUMP);
    addPredictableEvent(state, EV.FOOTSTEP);

    playerStateToEntityState(state, s, false);
    expect(eventNumber(s.event)).toBe(EV.JUMP);

    playerStateToEntityState(state, s, false);
    expect(eventNumber(s.event)).toBe(EV.FOOTSTEP);

    // Nothing left: the entity keeps showing the last one until the frame takes it away.
    playerStateToEntityState(state, s, false);
    expect(eventNumber(s.event)).toBe(EV.FOOTSTEP);
  });

  it('rides the low two bits of the sequence along, so the same event twice is seen twice', () => {
    const state = createArmedPlayerState();
    const s = createEntityState();
    addPredictableEvent(state, EV.FOOTSTEP);
    addPredictableEvent(state, EV.FOOTSTEP);

    playerStateToEntityState(state, s, false);
    const first = s.event;
    playerStateToEntityState(state, s, false);

    expect(s.event).not.toBe(first);
    expect(eventNumber(s.event)).toBe(EV.FOOTSTEP);
  });

  it('sends the external event instead while there is one, as it is what happened to them', () => {
    const state = createArmedPlayerState();
    const s = createEntityState();
    addPredictableEvent(state, EV.JUMP);
    state.externalEvent = EV.PAIN;
    state.externalEventParm = 70;

    playerStateToEntityState(state, s, false);
    expect(eventNumber(s.event)).toBe(EV.PAIN);
    expect(s.eventParm).toBe(70);
    // The ring is untouched, so the jump is still there once the external event is taken away.
    expect(state.entityEventSequence).toBe(0);
  });
});
