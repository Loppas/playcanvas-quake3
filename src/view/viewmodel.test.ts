import { describe, expect, it } from 'vitest';
import { parseAnimationConfig, type Animation } from '../formats/animation-config';
import { havePak0, openPak } from '../pak/pak-test-fixtures';
import { ANIM, nextAnim } from '../sim/animations';
import { createLerpFrame, runLerpFrame } from './lerp-frame';
import {
  angleMod,
  barrelSpinAngle,
  createBarrelSpin,
  handFrames,
  spinBarrel,
  torsoToHandFrame,
  viewmodelFovOffset,
  viewmodelLandOffset,
  viewmodelSway
} from './viewmodel';

describe('viewmodelSway', () => {
  it('drifts even when standing perfectly still', () => {
    // The +40 floor in the idle term is what keeps a Quake weapon subtly alive at rest.
    // Without it the gun looks pasted onto the screen.
    const still = { xyspeed: 0, bobCycle: 0, time: 500 };
    const sway = viewmodelSway(still);
    expect(Math.abs(sway.pitch)).toBeGreaterThan(0);
    expect(sway.pitch).toBe(sway.yaw);
    expect(sway.pitch).toBe(sway.roll);
  });

  it('sways further the faster you run', () => {
    const slow = viewmodelSway({ xyspeed: 50, bobCycle: 64, time: 0 });
    const fast = viewmodelSway({ xyspeed: 320, bobCycle: 64, time: 0 });
    expect(Math.abs(fast.yaw)).toBeGreaterThan(Math.abs(slow.yaw));
  });

  it('leans the opposite way on alternate footfalls', () => {
    // Bit 7 of the bob cycle selects the leading foot; without the inversion a run would
    // list to one side permanently.
    const left = viewmodelSway({ xyspeed: 320, bobCycle: 64, time: 0 });
    const right = viewmodelSway({ xyspeed: 320, bobCycle: 64 + 128, time: 0 });
    expect(Math.sign(left.yaw)).toBe(-Math.sign(right.yaw));
  });

  it('has no bob contribution at a footfall, where the sine is zero', () => {
    // bobCycle 0 puts bobfracsin at 0, so only the idle drift remains — and it is the same
    // on all three axes, which is the signature of the drift term.
    const sway = viewmodelSway({ xyspeed: 320, bobCycle: 0, time: 250 });
    expect(sway.pitch).toBeCloseTo(sway.yaw, 10);
    expect(sway.yaw).toBeCloseTo(sway.roll, 10);
  });

  it('stays small enough to read as sway rather than as aim', () => {
    // A few degrees at most: this moves the gun, not the shot. The simulation's aim is
    // untouched by any of this.
    for (let cycle = 0; cycle < 256; cycle += 7) {
      const sway = viewmodelSway({ xyspeed: 400, bobCycle: cycle, time: cycle * 13 });
      expect(Math.abs(sway.pitch)).toBeLessThan(10);
      expect(Math.abs(sway.yaw)).toBeLessThan(10);
      expect(Math.abs(sway.roll)).toBeLessThan(10);
    }
  });
});

describe('viewmodelLandOffset', () => {
  it('dips in over 150 ms then recovers over 300', () => {
    expect(viewmodelLandOffset(-20, 0)).toBeCloseTo(0, 6);
    expect(viewmodelLandOffset(-20, 150)).toBeCloseTo(-5, 6);
    expect(viewmodelLandOffset(-20, 300)).toBeCloseTo(-2.5, 6);
    expect(viewmodelLandOffset(-20, 450)).toBeCloseTo(0, 6);
  });

  it('is a quarter of the camera dip, so the gun lags the view', () => {
    expect(viewmodelLandOffset(-100, 150)).toBeCloseTo(-25, 6);
  });

  it('is inert outside the window', () => {
    expect(viewmodelLandOffset(-20, 1000)).toBe(0);
    expect(viewmodelLandOffset(-20, -5)).toBe(0);
  });
});

describe('barrelSpinAngle', () => {
  it('spins at 0.9 degrees per millisecond while firing', () => {
    expect(barrelSpinAngle(0, 100, true)).toBeCloseTo(90, 6);
  });

  it('coasts to a stop over a second, never unwinding', () => {
    // The property that matters, and the one a naive taper breaks: the angle only ever
    // increases. Sampled across the whole coast so a non-monotonic curve cannot hide.
    let previous = -1;
    for (let t = 0; t <= 1000; t += 25) {
      const angle = barrelSpinAngle(0, t, false);
      expect(angle, `t=${t}`).toBeGreaterThanOrEqual(previous);
      previous = angle;
    }
  });

  it('slows as it coasts rather than stopping dead', () => {
    const first = barrelSpinAngle(0, 100, false) - barrelSpinAngle(0, 0, false);
    const last = barrelSpinAngle(0, 1000, false) - barrelSpinAngle(0, 900, false);
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(first);
  });

  it('holds its final angle once the coast is over, instead of snapping back', () => {
    const settled = barrelSpinAngle(0, 1000, false);
    expect(barrelSpinAngle(0, 5000, false)).toBeCloseTo(settled, 6);
    expect(settled).toBeGreaterThan(0);
  });

  it('carries the angle it started from, so the barrel never jumps', () => {
    expect(barrelSpinAngle(45, 0, true)).toBe(45);
  });
});

describe('spinBarrel', () => {
  it('is frame-rate independent: the angle depends on elapsed time, not on frame count', () => {
    // The whole point of latching only on start/stop rather than integrating per frame.
    const coarse = createBarrelSpin(0);
    spinBarrel(coarse, 0, true);
    const coarseAngle = spinBarrel(coarse, 1000, true);

    const fine = createBarrelSpin(0);
    for (let t = 0; t <= 1000; t += 10) spinBarrel(fine, t, true);
    const fineAngle = spinBarrel(fine, 1000, true);

    expect(fineAngle).toBeCloseTo(coarseAngle, 6);
    expect(coarseAngle).toBeCloseTo(900, 6);
  });

  it('latches the angle at the moment firing stops, then coasts on from there', () => {
    const state = createBarrelSpin(0);
    spinBarrel(state, 0, true);
    // Stop at 400 ms: the state records where the barrel had got to.
    const atStop = spinBarrel(state, 400, false);
    expect(atStop).toBeCloseTo(360, 6);
    expect(state.spinning).toBe(false);
    expect(state.time).toBe(400);
    // Folded into 0..360, so a long session cannot accumulate an unusable float.
    expect(state.angle).toBeCloseTo(0, 6);

    // And it keeps turning after the trigger is released rather than stopping dead.
    expect(spinBarrel(state, 500, false)).toBeGreaterThan(0);
  });

  it('does not rewrite its state on frames where nothing changed', () => {
    const state = createBarrelSpin(0);
    spinBarrel(state, 0, true);
    const latched = { ...state };
    spinBarrel(state, 250, true);
    spinBarrel(state, 500, true);
    expect(state).toEqual(latched);
  });

  it('starts at rest', () => {
    const state = createBarrelSpin(1234);
    expect(state.spinning).toBe(false);
    // No elapsed time yet, so no accumulated angle to show on the first frame.
    expect(spinBarrel(state, 1234, false)).toBe(0);
  });
});

describe('angleMod', () => {
  it('folds into 0..360 from either direction', () => {
    expect(angleMod(45)).toBe(45);
    expect(angleMod(725)).toBeCloseTo(5, 10);
    expect(angleMod(-90)).toBeCloseTo(270, 10);
  });
});

describe('viewmodelFovOffset', () => {
  it('does nothing at or below Quake 3 default fov', () => {
    expect(viewmodelFovOffset(90)).toBe(0);
    expect(viewmodelFovOffset(80)).toBe(0);
  });

  it('drops the gun further the wider the view gets', () => {
    expect(viewmodelFovOffset(110)).toBeCloseTo(-4, 10);
    expect(viewmodelFovOffset(130)).toBeLessThan(viewmodelFovOffset(110));
  });
});

/**
 * A made-up table in the retail shape: the drop's five frames and the raise's four one after the
 * other, and both attacks' six. Every other row sits well clear of them.
 */
function torsoTable(): Animation[] {
  const row = (firstFrame: number, numFrames = 1): Animation => ({
    firstFrame,
    numFrames,
    loopFrames: 0,
    frameLerp: 66,
    initialLerp: 66,
    reversed: false,
    flipflop: false
  });
  const rows = Array.from({ length: ANIM.MAX_TOTALANIMATIONS }, () => row(300));
  rows[ANIM.TORSO_ATTACK] = row(50, 6);
  rows[ANIM.TORSO_ATTACK2] = row(60, 6);
  rows[ANIM.TORSO_DROP] = row(100, 5);
  rows[ANIM.TORSO_RAISE] = row(105, 4);
  return rows;
}

describe('torsoToHandFrame', () => {
  const table = torsoTable();
  const across = (first: number, count: number) =>
    Array.from({ length: count }, (_, i) => torsoToHandFrame(table, first + i));

  it("maps the nine frames from TORSO_DROP's first to hand frames 6–14", () => {
    expect(across(100, 9)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(torsoToHandFrame(table, 99)).toBe(0);
    expect(torsoToHandFrame(table, 109)).toBe(0);
  });

  it("maps either attack's six frames to 1–6", () => {
    expect(across(50, 7)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(across(60, 6)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rests the hand on 0 for any other torso frame', () => {
    expect(torsoToHandFrame(table, 300)).toBe(0);
  });
});

describe('handFrames', () => {
  it("blends the hand as the torso blends, from its old frame to its new", () => {
    expect(handFrames(torsoTable(), { oldFrame: 101, frame: 102, backlerp: 0.25 })).toEqual({
      from: 7,
      to: 8,
      frac: 0.75
    });
  });
});

describe.skipIf(!havePak0)("sarge's hand timing (pak0)", () => {
  it('follows his torso: the drop and the raise on 6–14, either attack on 1–6', async () => {
    const pak0 = await openPak('pak0.pk3');
    const text = new TextDecoder().decode(await pak0.read('models/players/sarge/animation.cfg'));
    const { animations } = parseAnimationConfig(text)!;
    const frames = (anim: number) => {
      const { firstFrame, numFrames } = animations[anim];
      return Array.from({ length: numFrames }, (_, i) => torsoToHandFrame(animations, firstFrame + i));
    };
    expect(frames(ANIM.TORSO_DROP)).toEqual([6, 7, 8, 9, 10]);
    expect(frames(ANIM.TORSO_RAISE)).toEqual([11, 12, 13, 14]);
    expect(frames(ANIM.TORSO_ATTACK)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(frames(ANIM.TORSO_ATTACK2)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(frames(ANIM.TORSO_STAND)).toEqual([0]);
  });

  it('plays his recoil through 1–6 on his torso clock', async () => {
    const pak0 = await openPak('pak0.pk3');
    const text = new TextDecoder().decode(await pak0.read('models/players/sarge/animation.cfg'));
    const { animations } = parseAnimationConfig(text)!;
    const torso = createLerpFrame();
    for (let t = 0; t <= 1000; t += 8) runLerpFrame(animations, torso, ANIM.TORSO_STAND, t);

    // The shot's first moment already blends from the hand at rest toward the first recoil frame:
    // the crossfade `CG_SetLerpFrameAnimation` gives any new animation.
    const attack = nextAnim(ANIM.TORSO_STAND, ANIM.TORSO_ATTACK);
    runLerpFrame(animations, torso, attack, 1000);
    expect(handFrames(animations, torso)).toMatchObject({ from: 0, to: 1 });

    const shown: number[] = [1];
    for (let t = 1001; t < 2000; t++) {
      runLerpFrame(animations, torso, attack, t);
      const { to } = handFrames(animations, torso);
      if (shown[shown.length - 1] !== to) shown.push(to);
    }
    expect(shown).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
