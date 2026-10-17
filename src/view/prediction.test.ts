import { describe, expect, it } from 'vitest';

import { copyPlayerState } from '../net/delta';
import {
  createEntityState,
  createNetUserCmd,
  createPlayerState,
  TR,
  type EntityState,
  type NetUserCmd,
  type PlayerState,
  type Trajectory
} from '../net/protocol';
import { createFlatWorldTrace } from '../sim/box-world';
import { angleToShort, shortAngle } from '../sim/client';
import { createClipInlineModels } from '../sim/clip-trace';
import { triggerBsp } from '../sim/cm/collision-test-fixtures';
import { loadMap } from '../sim/cm/cm-load';
import {
  BUTTON_ATTACK,
  CONTENTS,
  DF_NO_FOOTSTEPS,
  EF_NODRAW,
  PITCH_LIMIT_DEGREES,
  PITCH_LIMIT_SHORT,
  PM_NORMAL,
  PM_SPECTATOR,
  PMF_GRAPPLE_PULL,
  STAT
} from '../sim/constants';
import { SOLID_BMODEL } from '../sim/entity-solid';
import { EV } from '../sim/events';
import { ET } from '../sim/game-entity';
import { findItem, itemIndex } from '../sim/items';
import { defaultRules } from '../sim/rules';
import {
  NO_CONTENTS,
  NO_INLINE_MODELS,
  createIdlePlayerState,
  type InlineModels
} from '../sim/types';
import { vec3 } from '../sim/vec3';
import { Q2_GRAPPLE_SPEED } from '../sim/weapons/grapple';
import { WEAPON_READY, WP } from '../sim/weapons/constants';
import {
  Prediction,
  type CommandRing,
  type PredictionFrame,
  type PredictionSnapshot
} from './prediction';

/**
 * `CG_PredictPlayerState`'s own arithmetic: which commands a frame replays, what a freeze leaves,
 * the correction the camera is owed, and the two touches a client predicts for itself.
 */

/** A command ring a test fills by hand, with the newest at {@link cmdNumber}. */
class Ring implements CommandRing {
  cmdNumber = 0;
  private readonly cmds: NetUserCmd[] = [];

  add(serverTime: number, input: Partial<NetUserCmd> = {}): void {
    const cmd = createNetUserCmd();
    cmd.serverTime = serverTime;
    Object.assign(cmd, input);
    this.cmdNumber++;
    this.cmds[this.cmdNumber] = cmd;
  }

  at(number: number): NetUserCmd {
    return this.cmds[number] ?? createNetUserCmd();
  }
}

/** A snapshot at a time, with the player standing where asked. */
function snapshot(serverTime: number, origin: ReturnType<typeof vec3>): PredictionSnapshot {
  const ps = createPlayerState();
  ps.commandTime = serverTime;
  ps.origin = vec3(origin.x, origin.y, origin.z);
  ps.viewheight = 26;
  // What a snapshot always carries: the server writes these onto the state at each think.
  ps.speed = 320;
  ps.gravity = 800;
  ps.stats[STAT.HEALTH] = 100;
  return { serverTime, ps, entities: [] };
}

/** A frame around the snapshots a test cares about; everything else is defaults. */
function frame(overrides: Partial<PredictionFrame> & { snap: PredictionSnapshot }): PredictionFrame {
  return {
    nextSnap: null,
    nextFrameTeleport: false,
    cgTime: 0,
    oldTime: 0,
    commands: new Ring(),
    trace: createFlatWorldTrace(),
    pointContents: NO_CONTENTS,
    rules: defaultRules(),
    pmoveMsec: 8,
    grappleMode: null,
    gametype: 0,
    predictItems: true,
    showMiss: 0,
    errorDecay: 100,
    triggers: [],
    inlineModels: NO_INLINE_MODELS,
    currentState: () => undefined,
    print: () => {},
    ...overrides
  };
}

describe('the replay', () => {
  it('runs every command the base has not answered, and none of the ones it has', () => {
    const ring = new Ring();
    ring.add(8);
    ring.add(16, { forwardmove: 127 });
    const prediction = new Prediction();

    const moved = prediction.predict(
      frame({ snap: snapshot(8, vec3(0, 0, 24)), commands: ring, cgTime: 16, oldTime: 8 })
    );

    expect(moved).toBe(true);
    expect(prediction.state.commandTime).toBe(16);
    expect(prediction.state.origin.x).toBeGreaterThan(0);
    // The step before the newest, which the drawn position blends from.
    expect(prediction.previousStep.commandTime).toBe(8);
  });

  it("replays the move in the world's liquids, as CG_PointContents finds them", () => {
    const ring = new Ring();
    ring.add(8);
    ring.add(16);
    const prediction = new Prediction();
    const deep = snapshot(8, vec3(0, 0, 500));

    prediction.predict(frame({ snap: deep, commands: ring, cgTime: 16, oldTime: 8 }));
    expect(prediction.state.velocity.z).toBe(-6);

    prediction.reset();
    const pool = (point: { z: number }) => (point.z < 1000 ? CONTENTS.WATER : 0);
    prediction.predict(
      frame({ snap: deep, commands: ring, cgTime: 16, oldTime: 8, pointContents: pool })
    );
    // The swim's sink, where the air's gravity took 6.
    expect(prediction.state.velocity.z).toBe(-2);
  });

  it('freezes when the ring no longer holds the commands the snapshot wants', () => {
    const ring = new Ring();
    for (let time = 8; time <= 8 + 64 * 8; time += 8) ring.add(time);
    const prediction = new Prediction();
    const printed: string[] = [];

    const moved = prediction.predict(
      frame({
        snap: snapshot(8, vec3(0, 0, 24)),
        commands: ring,
        cgTime: 1000,
        oldTime: 992,
        showMiss: 1,
        print: (text) => printed.push(text)
      })
    );

    expect(moved).toBe(false);
    expect(printed.join('')).toContain('PACKET_BACKUP');
    // The state is left where it was, as Q3's freeze leaves it.
    expect(prediction.state.commandTime).toBe(8);
  });

  it('leaves the prediction alone when the base already has the newest command', () => {
    const ring = new Ring();
    ring.add(8);
    const prediction = new Prediction();
    prediction.predict(
      frame({ snap: snapshot(8, vec3(0, 0, 24)), commands: ring, cgTime: 8, oldTime: 0 })
    );
    const before = { ...prediction.state.origin };

    const moved = prediction.predict(
      frame({ snap: snapshot(8, vec3(5, 0, 24)), commands: ring, cgTime: 16, oldTime: 8 })
    );

    expect(moved).toBe(false);
    expect(prediction.state.origin).toEqual(before);
  });

  it("skips a command from beyond the newest, as a map_restart's leftover", () => {
    const ring = new Ring();
    ring.add(16);
    ring.add(8);
    const prediction = new Prediction();

    prediction.predict(
      frame({ snap: snapshot(0, vec3(0, 0, 24)), commands: ring, cgTime: 24, oldTime: 16 })
    );

    // The 16 was made before the restart and sits behind the ring's newest, 8: it is passed over.
    expect(prediction.state.commandTime).toBe(8);
  });

  it("rounds a command's time up to the move's grid, as the server does", () => {
    const ring = new Ring();
    ring.add(1003);
    const prediction = new Prediction();

    prediction.predict(
      frame({ snap: snapshot(0, vec3(0, 0, 24)), commands: ring, cgTime: 1010, oldTime: 1000 })
    );

    expect(prediction.state.commandTime).toBe(1008);
  });

  it('turns the view for a command the base already has, and by the delta angles', () => {
    const first = new Ring();
    first.add(16);
    const prediction = new Prediction();
    prediction.predict(
      frame({ snap: snapshot(0, vec3(0, 0, 24)), commands: first, cgTime: 16, oldTime: 8 })
    );

    // Both commands are the same 24 ms step: the first runs, the second is already in the base
    // and so is not simulated — but it still turns the view (`cg_predict.c:508–510`), by the
    // delta the snapshot set.
    const second = new Ring();
    second.add(24, { angles: [0, 0, 0] });
    second.add(24, { angles: [0, 1000, 0] });
    const base = snapshot(16, vec3(0, 0, 24));
    base.ps.deltaAngles = vec3(100, 0, 0);
    prediction.predict(
      frame({
        snap: snapshot(8, vec3(0, 0, 24)),
        nextSnap: base,
        commands: second,
        cgTime: 24,
        oldTime: 16
      })
    );

    expect(prediction.state.commandTime).toBe(24);
    expect(prediction.state.viewangles.x).toBeCloseTo(shortAngle(100), 6);
    expect(prediction.state.viewangles.y).toBeCloseTo(shortAngle(1000), 6);
  });

  it('holds the pitch to the limit and writes the fix-up back into the delta', () => {
    const ring = new Ring();
    ring.add(8, { angles: [angleToShort(90), 0, 0] });
    const prediction = new Prediction();

    prediction.predict(
      frame({ snap: snapshot(0, vec3(0, 0, 24)), commands: ring, cgTime: 8, oldTime: 0 })
    );

    expect(prediction.state.viewangles.x).toBeCloseTo(PITCH_LIMIT_DEGREES, 4);
    expect(prediction.state.deltaAngles.x).toBe(PITCH_LIMIT_SHORT - angleToShort(90));
  });

  it('runs the Q2 winch after the move, as the server does', () => {
    const base = snapshot(0, vec3(0, 0, 24));
    base.ps.pmFlags = PMF_GRAPPLE_PULL;
    base.ps.grapplePoint = vec3(0, 0, 124);
    const ring = new Ring();
    ring.add(8);
    const prediction = new Prediction();

    prediction.predict(
      frame({ snap: base, commands: ring, cgTime: 8, oldTime: 0, grappleMode: 'q2winch' })
    );

    expect(prediction.state.velocity.z).toBeCloseTo(Q2_GRAPPLE_SPEED - base.ps.gravity * 0.008, 6);
  });

  it('does not let a predicted gauntlet connect, which would spend its swing', () => {
    const base = createIdlePlayerState({ origin: vec3(0, 0, 24), weapon: WP.GAUNTLET });
    const ring = new Ring();
    ring.add(8, { buttons: BUTTON_ATTACK, weapon: WP.GAUNTLET });
    const prediction = new Prediction();

    prediction.predict(
      frame({
        snap: { serverTime: 0, ps: base, entities: [] },
        commands: ring,
        cgTime: 8,
        oldTime: 0
      })
    );

    // "always be free from prediction errors with the gauntlet": with nothing hit, the swing
    // never starts, so the weapon stays ready.
    expect(prediction.state.weaponstate).toBe(WEAPON_READY);
  });

  it('passes the no-footsteps rule into the move', () => {
    const footsteps = (dmflags: number): boolean => {
      const prediction = new Prediction();
      const ring = new Ring();
      const rules = { ...defaultRules(), dmflags };
      // One state carried from frame to frame, as the snapshots would: the bob a footstep is
      // raised on counts up across ticks.
      const base = createIdlePlayerState({ origin: vec3(0, 0, 24) });
      for (let time = 8; time <= 2000; time += 8) {
        ring.add(time, { forwardmove: 127 });
        base.commandTime = time - 8;
        prediction.predict(
          frame({
            snap: { serverTime: time - 8, ps: base, entities: [] },
            commands: ring,
            cgTime: time,
            oldTime: time - 8,
            rules
          })
        );
        if ([...prediction.state.events].includes(EV.FOOTSTEP)) return true;
        copyPlayerState(prediction.state, base);
      }
      return false;
    };

    expect(footsteps(0)).toBe(true);
    expect(footsteps(DF_NO_FOOTSTEPS)).toBe(false);
  });

  it('starts a new world from the snapshot, not the last world', () => {
    const prediction = new Prediction();
    const ring = new Ring();
    ring.add(8);
    prediction.predict(
      frame({ snap: snapshot(0, vec3(0, 0, 24)), commands: ring, cgTime: 8, oldTime: 0 })
    );

    prediction.reset();
    prediction.predict(
      frame({
        snap: snapshot(100, vec3(40, 0, 24)),
        commands: new Ring(),
        cgTime: 100,
        oldTime: 8
      })
    );

    expect(prediction.state.origin.x).toBe(40);
  });
});

describe('the correction', () => {
  it('measures the miss against the snapshot and decays it into the camera only', () => {
    const prediction = new Prediction();
    const first = new Ring();
    first.add(16);
    prediction.predict(
      frame({ snap: snapshot(0, vec3(0, 0, 24)), commands: first, cgTime: 16, oldTime: 8 })
    );

    // The server answers five units away from where last frame's prediction had the player, at
    // the same command time the prediction reached — which is the only case a miss is measured.
    const second = new Ring();
    second.add(24);
    prediction.predict(
      frame({
        snap: snapshot(8, vec3(0, 0, 24)),
        nextSnap: snapshot(16, vec3(0, 0, 29)),
        commands: second,
        cgTime: 24,
        oldTime: 16
      })
    );

    expect(prediction.cameraOffset(24, 100).z).toBeCloseTo(-5 * 0.92, 3);
    expect(prediction.cameraOffset(32, 100).z).toBeCloseTo(-5 * 0.84, 3);
    // Past the decay's whole time the error is let go.
    expect(prediction.cameraOffset(116, 100).z).toBe(0);
    expect(prediction.cameraOffset(124, 100).z).toBe(0);
  });

  it('clears the error outright on a teleport', () => {
    const prediction = new Prediction();
    const first = new Ring();
    first.add(16);
    prediction.predict(
      frame({ snap: snapshot(0, vec3(0, 0, 24)), commands: first, cgTime: 16, oldTime: 8 })
    );
    const second = new Ring();
    second.add(24);
    prediction.predict(
      frame({
        snap: snapshot(8, vec3(0, 0, 24)),
        nextSnap: snapshot(16, vec3(0, 0, 29)),
        commands: second,
        cgTime: 24,
        oldTime: 16
      })
    );
    expect(prediction.cameraOffset(24, 100).z).toBeLessThan(0);

    // A teleport clears it before the next miss is measured.
    prediction.thisFrameTeleport = true;
    const third = new Ring();
    third.add(32);
    prediction.predict(
      frame({
        snap: snapshot(24, vec3(0, 0, 29)),
        nextSnap: snapshot(32, vec3(0, 0, 29)),
        commands: third,
        cgTime: 32,
        oldTime: 24
      })
    );
    expect(prediction.cameraOffset(32, 100).z).toBe(0);
  });

  it('ignores a miss under a tenth of a unit', () => {
    const prediction = new Prediction();
    const first = new Ring();
    first.add(16);
    prediction.predict(
      frame({ snap: snapshot(0, vec3(0, 0, 24)), commands: first, cgTime: 16, oldTime: 8 })
    );
    const second = new Ring();
    second.add(24);
    prediction.predict(
      frame({
        snap: snapshot(8, vec3(0, 0, 24)),
        nextSnap: snapshot(16, vec3(0, 0, 24.05)),
        commands: second,
        cgTime: 24,
        oldTime: 16
      })
    );

    expect(prediction.cameraOffset(32, 100).z).toBe(0);
  });

  it('decays the error already owed before a second miss is added', () => {
    const prediction = new Prediction();
    const first = new Ring();
    first.add(16);
    prediction.predict(
      frame({ snap: snapshot(0, vec3(0, 0, 24)), commands: first, cgTime: 16, oldTime: 8 })
    );
    const second = new Ring();
    second.add(24);
    prediction.predict(
      frame({
        snap: snapshot(8, vec3(0, 0, 24)),
        nextSnap: snapshot(16, vec3(5, 0, 24)),
        commands: second,
        cgTime: 24,
        oldTime: 16
      })
    );
    const third = new Ring();
    third.add(32);
    prediction.predict(
      frame({
        snap: snapshot(16, vec3(5, 0, 24)),
        nextSnap: snapshot(24, vec3(7, 0, 24)),
        commands: third,
        cgTime: 32,
        oldTime: 24
      })
    );

    // The first miss was 5, measured at oldTime 16. By frame 3's clock it has 84 of its 100 ms
    // left, and the second miss of 2 is added to what remains. At 40 ms on, the camera still
    // owes 84% of that 6.2.
    expect(prediction.cameraOffset(40, 100).x).toBeCloseTo(-(5 * 0.84 + 2) * 0.84, 3);
  });
});

describe('a mover underfoot', () => {
  /** The mover's number, which the ground under the player names. */
  const MOVER = 5;

  /** Mover {@link MOVER}, on the trajectories given. */
  function mover(pos: Partial<Trajectory>, apos: Partial<Trajectory> = {}): EntityState {
    const state = createEntityState(MOVER);
    state.eType = ET.MOVER;
    state.solid = SOLID_BMODEL;
    Object.assign(state.pos, pos);
    Object.assign(state.apos, apos);
    return state;
  }

  /** The flat world, its ground named as the mover, and the mover where the snapshot has it. */
  function standingOn(state: EntityState): Partial<PredictionFrame> {
    const flat = createFlatWorldTrace();
    return {
      trace: (...args) => {
        const result = flat(...args);
        if (result.fraction < 1) result.entityNum = MOVER;
        return result;
      },
      currentState: (number) => (number === MOVER ? state : undefined)
    };
  }

  /** Sliding along +x at 100 a second. */
  const SLIDING = mover({ trType: TR.LINEAR, trDelta: vec3(100, 0, 0) });

  it("takes cg.physicsTime from the base's snapshot, and keeps it when nothing is tried", () => {
    const ring = new Ring();
    ring.add(16);
    const prediction = new Prediction();
    const snap = snapshot(8, vec3(0, 0, 24));
    const nextSnap = snapshot(16, vec3(0, 0, 24));
    prediction.predict(frame({ snap, nextSnap, commands: ring, cgTime: 16, oldTime: 8 }));
    expect(prediction.physicsTime).toBe(16);

    // A teleport takes the older snapshot's state, and its time.
    const teleport = frame({ snap, nextSnap, nextFrameTeleport: true, commands: ring, cgTime: 16 });
    prediction.predict(teleport);
    expect(prediction.physicsTime).toBe(8);

    // Even with nothing to replay; but not when the ring has lost the commands.
    prediction.predict(frame({ snap: nextSnap, commands: ring, cgTime: 16 }));
    expect(prediction.physicsTime).toBe(16);
    const lost = new Ring();
    for (let time = 8; time <= 8 + 64 * 8; time += 8) lost.add(time);
    prediction.predict(frame({ snap, commands: lost, cgTime: 1000 }));
    expect(prediction.physicsTime).toBe(16);
  });

  it('carries both steps the view blends along it, from the snapshot to the frame', () => {
    const ring = new Ring();
    ring.add(16);
    const prediction = new Prediction();
    const snap = snapshot(8, vec3(0, 0, 24));
    snap.ps.groundEntityNum = MOVER;
    const onIt = { snap, commands: ring, cgTime: 20, oldTime: 12, ...standingOn(SLIDING) };

    expect(prediction.predict(frame(onIt))).toBe(true);
    // The replay met it as it stood at 8, and the frame is drawn at 20: 1.2 on.
    expect(prediction.state.groundEntityNum).toBe(MOVER);
    expect(prediction.state.origin.x).toBeCloseTo(1.2, 5);
    expect(prediction.previousStep.origin.x).toBeCloseTo(1.2, 5);
    expect(prediction.stateTime).toBe(20);
    // The first frame's state is the snapshot's, which stands at the snapshot's time: no miss.
    expect(prediction.cameraOffset(20, 100)).toEqual(vec3());

    // On the world, the same replay goes nowhere.
    prediction.reset();
    prediction.predict(frame({ ...onIt, currentState: () => undefined }));
    expect(prediction.state.origin.x).toBe(0);
  });

  it('turns the player round a turning one, and their view with it', () => {
    const disc = mover({}, { trType: TR.LINEAR, trDelta: vec3(0, 36, 0) });
    const ring = new Ring();
    ring.add(1008);
    const prediction = new Prediction();
    const snap = snapshot(1000, vec3(64, 0, 24));
    prediction.predict(frame({ snap, commands: ring, cgTime: 1008, ...standingOn(disc) }));

    // A frame's turn of a disc turning 36 a second, as the twin's hand case has it.
    expect(prediction.moverTurn).toEqual(vec3(0, Math.fround(0.288002014), 0));
    expect(prediction.state.viewangles.y).toBe(Math.fround(0.288002014));
    expect(prediction.state.origin.x).toBeCloseTo(63.9991913, 4);
    expect(prediction.state.origin.y).toBeCloseTo(0.3217, 4);
  });

  it("turns the view by each frame's own turn, and by none once off the mover", () => {
    const disc = mover({}, { trType: TR.LINEAR, trDelta: vec3(0, 36, 0) });
    const prediction = new Prediction();
    const snap = snapshot(1000, vec3(64, 0, 24));
    const ring = new Ring();
    ring.add(1008);
    prediction.predict(frame({ snap, commands: ring, cgTime: 1008, ...standingOn(disc) }));
    ring.add(1016);
    const later = { snap, commands: ring, cgTime: 1016, oldTime: 1008 };
    prediction.predict(frame({ ...later, ...standingOn(disc) }));
    // The turn from the snapshot to this frame: 16 ms of it, not the last frame's 8 more.
    expect(prediction.moverTurn.y).toBeCloseTo(0.576, 4);

    ring.add(1024);
    prediction.predict(frame({ snap, commands: ring, cgTime: 1024, oldTime: 1016 }));
    expect(prediction.moverTurn).toEqual(vec3());
  });

  it('lets the times and the turn go with the last world', () => {
    const disc = mover({}, { trType: TR.LINEAR, trDelta: vec3(0, 36, 0) });
    const prediction = new Prediction();
    const ring = new Ring();
    ring.add(1008);
    const snap = snapshot(1000, vec3(64, 0, 24));
    prediction.predict(frame({ snap, commands: ring, cgTime: 1008, ...standingOn(disc) }));
    expect(prediction.moverTurn.y).toBeGreaterThan(0);

    prediction.reset();
    const { physicsTime, stateTime, moverTurn } = prediction;
    expect({ physicsTime, stateTime, moverTurn }).toEqual({
      physicsTime: 0,
      stateTime: 0,
      moverTurn: vec3()
    });
  });

  it("takes none of the mover's own motion for a miss", () => {
    const prediction = new Prediction();
    const snap = snapshot(8, vec3(0, 0, 24));
    const first = new Ring();
    first.add(16);
    prediction.predict(frame({ snap, commands: first, cgTime: 16, ...standingOn(SLIDING) }));

    // The same base a frame on: the step to 16 is replayed against the mover at 8 again, and is
    // measured carried to 16, where the last frame's prediction stands.
    const second = new Ring();
    second.add(16);
    second.add(24);
    const printed: string[] = [];
    const print = (text: string) => printed.push(text);
    const again = { snap, commands: second, cgTime: 24, oldTime: 16, showMiss: 1, print };
    prediction.predict(frame({ ...again, ...standingOn(SLIDING) }));

    expect(printed.join('')).not.toContain('Prediction miss');
    expect(prediction.cameraOffset(24, 100)).toEqual(vec3());
  });

  it("measures against a snapshot's own state at that snapshot's time", () => {
    // A frame that replayed nothing drew the snapshot at 16, the player carried to 0.8 by the
    // server's push, and kept it as the prediction, standing at 16, as the view keeps it.
    const prediction = new Prediction();
    const snap = snapshot(16, vec3(0.8, 0, 24));
    snap.ps.groundEntityNum = MOVER;
    const none = new Ring();
    none.add(16);
    prediction.predict(frame({ snap, commands: none, cgTime: 20, ...standingOn(SLIDING) }));
    copyPlayerState(snap.ps, prediction.state);
    prediction.stateTime = 16;

    const ring = new Ring();
    ring.add(16);
    ring.add(24);
    const printed: string[] = [];
    const print = (text: string) => printed.push(text);
    const next = { snap, commands: ring, cgTime: 28, oldTime: 20, showMiss: 1, print };
    prediction.predict(frame({ ...next, ...standingOn(SLIDING) }));

    expect(printed.join('')).not.toContain('Prediction miss');
  });
});

describe('the touches', () => {
  /** A pad on the trigger map's brush model `n`, which launches straight up. */
  function brushPad(n = 1) {
    const pad = createEntityState(5);
    pad.eType = ET.PUSH_TRIGGER;
    pad.solid = SOLID_BMODEL;
    pad.modelindex = n;
    pad.origin2 = vec3(0, 0, 300);
    return pad;
  }

  /** One step from a player standing at (x, y) on the floor, with these triggers and models. */
  function stepAt(x: number, y: number, triggers: EntityState[], inlineModels: InlineModels) {
    const ring = new Ring();
    ring.add(8);
    const prediction = new Prediction();
    prediction.predict(
      frame({
        snap: snapshot(0, vec3(x, y, 24)),
        commands: ring,
        cgTime: 8,
        oldTime: 0,
        triggers,
        inlineModels
      })
    );
    return prediction.state;
  }

  it("launches from a brush pad by its brush, as the server's contact tests it", () => {
    const models = createClipInlineModels(loadMap(triggerBsp(), 'maps/test.bsp'));
    expect(stepAt(50, 50, [brushPad()], models).velocity.z).toBe(300);
    // Inside the model's bounds, but in the corner its brush is cut from.
    expect(stepAt(75, 75, [brushPad()], models).velocity.z).toBe(0);
  });

  /** A teleporter on the trigger map's brush model 1. */
  function brushTeleporter() {
    const teleporter = createEntityState(6);
    teleporter.eType = ET.TELEPORT_TRIGGER;
    teleporter.solid = SOLID_BMODEL;
    teleporter.modelindex = 1;
    return teleporter;
  }

  /** One step from a player at (x, y), as {@link stepAt}, and the prediction it leaves. */
  function predictedAt(x: number, y: number, triggers: EntityState[], pmType = PM_NORMAL) {
    const models = createClipInlineModels(loadMap(triggerBsp(), 'maps/test.bsp'));
    const snap = snapshot(0, vec3(x, y, 24));
    snap.ps.pmType = pmType;
    const ring = new Ring();
    ring.add(8);
    const prediction = new Prediction();
    prediction.predict(
      frame({ snap, commands: ring, cgTime: 8, oldTime: 0, triggers, inlineModels: models })
    );
    return prediction;
  }

  it('goes into hyperspace in a teleporter, by its brush, and moves nowhere for it', () => {
    const inside = predictedAt(50, 50, [brushTeleporter()]);
    expect(inside.hyperspace).toBe(true);
    // The teleport itself is the server's: the step stays where it was.
    expect(inside.state.origin.x).toBe(50);
    expect(inside.state.velocity).toEqual(vec3());
    // In the bounds, but in the corner the brush is cut from.
    expect(predictedAt(75, 75, [brushTeleporter()]).hyperspace).toBe(false);
  });

  it('takes a spectator into hyperspace too, and leaves it on a reset', () => {
    const watcher = predictedAt(50, 50, [brushTeleporter()], PM_SPECTATOR);
    expect(watcher.hyperspace).toBe(true);
    watcher.reset();
    expect(watcher.hyperspace).toBe(false);
  });

  it('takes no item for a spectator, who only works teleporters', () => {
    const item = createEntityState(7);
    item.eType = ET.ITEM;
    item.pos.trType = TR.STATIONARY;
    item.pos.trBase = vec3(0, 0, 24);
    item.modelindex = itemIndex(findItem('weapon_rocketlauncher')!);
    const snap = snapshot(0, vec3(0, 0, 24));
    snap.ps.pmType = PM_SPECTATOR;
    const ring = new Ring();
    ring.add(8);
    const prediction = new Prediction();

    prediction.predict(frame({ snap, commands: ring, cgTime: 8, oldTime: 0, triggers: [item] }));

    expect([...prediction.state.events]).not.toContain(EV.ITEM_PICKUP);
  });

  it("passes over a brush trigger on model 0, which is the world's", () => {
    const always: InlineModels = {
      ...NO_INLINE_MODELS,
      inlineModel: (index) => index,
      contact: () => true
    };
    expect(stepAt(0, 0, [brushPad(1)], always).velocity.z).toBe(300);
    expect(stepAt(0, 0, [brushPad(0)], always).velocity.z).toBe(0);
  });

  it('launches the player from a jump pad the predicted box is inside', () => {
    const pad = createEntityState(5);
    pad.eType = ET.PUSH_TRIGGER;
    pad.pos.trType = TR.STATIONARY;
    pad.pos.trBase = vec3(0, 0, 24);
    pad.origin2 = vec3(0, 0, 300);
    const ring = new Ring();
    ring.add(8);
    const prediction = new Prediction();

    prediction.predict(
      frame({
        snap: snapshot(0, vec3(0, 0, 24)),
        commands: ring,
        cgTime: 8,
        oldTime: 0,
        triggers: [pad]
      })
    );

    expect(prediction.state.velocity.z).toBe(300);
    expect(prediction.state.jumppadEnt).toBe(5);
    expect([...prediction.state.events]).toContain(EV.JUMP_PAD);
  });

  it('predicts an item pickup, and not with cg_predictItems off', () => {
    const item = createEntityState(7);
    item.eType = ET.ITEM;
    item.pos.trType = TR.STATIONARY;
    item.pos.trBase = vec3(0, 0, 24);
    item.modelindex = itemIndex(findItem('weapon_rocketlauncher')!);
    const grab = (predictItems: boolean): PlayerState => {
      const ring = new Ring();
      ring.add(8);
      const prediction = new Prediction();
      prediction.predict(
        frame({
          snap: snapshot(0, vec3(0, 0, 24)),
          commands: ring,
          cgTime: 8,
          oldTime: 0,
          triggers: [item],
          predictItems
        })
      );
      return prediction.state;
    };

    const taken = grab(true);
    expect([...taken.events]).toContain(EV.ITEM_PICKUP);
    expect(item.eFlags & EF_NODRAW).toBeTruthy();
    // A token round, so the autoswitch can put the weapon in hand at once.
    expect(taken.ammo[WP.ROCKET_LAUNCHER]).toBe(1);

    expect([...grab(false).events]).not.toContain(EV.ITEM_PICKUP);
  });

  it('takes an item once in a frame, however many steps crossed it', () => {
    const item = createEntityState(7);
    item.eType = ET.ITEM;
    item.pos.trType = TR.STATIONARY;
    item.pos.trBase = vec3(0, 0, 24);
    item.modelindex = itemIndex(findItem('weapon_rocketlauncher')!);
    const ring = new Ring();
    ring.add(8);
    ring.add(16);
    const prediction = new Prediction();

    prediction.predict(
      frame({
        snap: snapshot(0, vec3(0, 0, 24)),
        commands: ring,
        cgTime: 16,
        oldTime: 8,
        triggers: [item]
      })
    );

    expect([...prediction.state.events].filter((event) => event === EV.ITEM_PICKUP)).toHaveLength(1);
  });

  it("forgets at a reset which items it took on the last world's clock", () => {
    const touched = (prediction: Prediction): boolean => {
      const item = createEntityState(7);
      item.eType = ET.ITEM;
      item.pos.trType = TR.STATIONARY;
      item.pos.trBase = vec3(0, 0, 24);
      item.modelindex = itemIndex(findItem('weapon_rocketlauncher')!);
      const ring = new Ring();
      ring.add(8);
      prediction.predict(
        frame({
          snap: snapshot(0, vec3(0, 0, 24)),
          commands: ring,
          cgTime: 8,
          oldTime: 0,
          triggers: [item]
        })
      );
      return prediction.state.events.includes(EV.ITEM_PICKUP);
    };
    const prediction = new Prediction();
    expect(touched(prediction)).toBe(true);
    expect(touched(prediction)).toBe(false);

    // A new map's clock may come round to the same time, with an item in the same slot.
    prediction.reset();
    expect(touched(prediction)).toBe(true);
  });

  it('leaves an item the grab rules refuse, as a health one at full health', () => {
    const item = createEntityState(9);
    item.eType = ET.ITEM;
    item.pos.trType = TR.STATIONARY;
    item.pos.trBase = vec3(0, 0, 24);
    item.modelindex = itemIndex(findItem('item_health')!);
    const ring = new Ring();
    ring.add(8);
    const prediction = new Prediction();

    prediction.predict(
      frame({
        snap: snapshot(0, vec3(0, 0, 24)),
        commands: ring,
        cgTime: 8,
        oldTime: 0,
        triggers: [item]
      })
    );

    // The snapshot stands at full health, so the 25 the item carries is over the limit.
    expect([...prediction.state.events]).not.toContain(EV.ITEM_PICKUP);
  });

  it("clears the pad's frame once a step touches no pad", () => {
    const prediction = new Prediction();
    const first = new Ring();
    first.add(8);
    prediction.predict(
      frame({ snap: snapshot(0, vec3(0, 0, 24)), commands: first, cgTime: 8, oldTime: 0 })
    );

    const base = snapshot(16, vec3(0, 0, 24));
    base.ps.jumppadFrame = 100;
    const second = new Ring();
    second.add(24);
    prediction.predict(
      frame({
        snap: snapshot(8, vec3(0, 0, 24)),
        nextSnap: base,
        commands: second,
        cgTime: 24,
        oldTime: 16
      })
    );

    expect(prediction.state.jumppadEnt).toBe(0);
    expect(prediction.state.jumppadFrame).toBe(0);
  });
});
