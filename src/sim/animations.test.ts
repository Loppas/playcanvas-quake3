import { describe, expect, it } from 'vitest';

import {
  ANIM,
  ANIM_TOGGLEBIT,
  TIMER_GESTURE,
  TIMER_LAND,
  animOf,
  continueLegsAnim,
  continueTorsoAnim,
  forceLegsAnim,
  nextAnim,
  startLegsAnim,
  startTorsoAnim
} from './animations';
import { PM_DEAD } from './constants';
import { createIdlePlayerState } from './types';

describe('animation numbers', () => {
  it("keep animNumber_t's order, which indexes an animation.cfg's rows", () => {
    expect(ANIM.BOTH_DEATH1).toBe(0);
    expect(ANIM.BOTH_DEAD3).toBe(5);
    expect(ANIM.TORSO_GESTURE).toBe(6);
    expect(ANIM.TORSO_STAND2).toBe(12);
    expect(ANIM.LEGS_WALKCR).toBe(13);
    expect(ANIM.LEGS_TURN).toBe(24);
    expect(ANIM.MAX_ANIMATIONS).toBe(31);
    expect(ANIM.LEGS_BACKCR).toBe(32);
    expect(ANIM.LEGS_BACKWALK).toBe(33);
    expect(ANIM.MAX_TOTALANIMATIONS).toBe(37);
  });

  it("pin Q3's toggle bit and holds", () => {
    expect(ANIM_TOGGLEBIT).toBe(128);
    expect(TIMER_LAND).toBe(130);
    expect(TIMER_GESTURE).toBe(2294);
  });
});

describe('starting an animation', () => {
  it('flips the toggle bit, so restarting the same row still reads as a change', () => {
    const state = createIdlePlayerState();
    startTorsoAnim(state, ANIM.TORSO_ATTACK);
    const first = state.torsoAnim;
    startTorsoAnim(state, ANIM.TORSO_ATTACK);

    expect(animOf(first)).toBe(ANIM.TORSO_ATTACK);
    expect(animOf(state.torsoAnim)).toBe(ANIM.TORSO_ATTACK);
    expect(state.torsoAnim ^ first).toBe(ANIM_TOGGLEBIT);
  });

  it('leaves the legs alone while a landing holds them, unless forced', () => {
    const state = createIdlePlayerState({ legsTimer: 50 });
    startLegsAnim(state, ANIM.LEGS_RUN);
    expect(animOf(state.legsAnim)).toBe(ANIM.LEGS_IDLE);

    forceLegsAnim(state, ANIM.LEGS_JUMP);
    expect(animOf(state.legsAnim)).toBe(ANIM.LEGS_JUMP);
    expect(state.legsTimer).toBe(0);
  });

  it('does not restart an animation that is already playing when continued', () => {
    const state = createIdlePlayerState();
    const idle = state.legsAnim;
    continueLegsAnim(state, ANIM.LEGS_IDLE);
    expect(state.legsAnim).toBe(idle);

    continueLegsAnim(state, ANIM.LEGS_RUN);
    expect(animOf(state.legsAnim)).toBe(ANIM.LEGS_RUN);
  });

  it('holds the torso against a continue while a gesture runs', () => {
    const state = createIdlePlayerState({ torsoTimer: 100 });
    continueTorsoAnim(state, ANIM.TORSO_STAND2);
    expect(animOf(state.torsoAnim)).toBe(ANIM.TORSO_STAND);
  });

  it('changes nothing on a dead player, though a force still clears the hold', () => {
    const state = createIdlePlayerState({
      pmType: PM_DEAD,
      legsAnim: ANIM.BOTH_DEATH2,
      legsTimer: 80
    });
    startTorsoAnim(state, ANIM.TORSO_ATTACK);
    forceLegsAnim(state, ANIM.LEGS_JUMP);

    expect(animOf(state.torsoAnim)).toBe(ANIM.TORSO_STAND);
    expect(animOf(state.legsAnim)).toBe(ANIM.BOTH_DEATH2);
    expect(state.legsTimer).toBe(0);
  });

  it('sets a row directly with the bit flipped, as player_die does', () => {
    expect(nextAnim(ANIM.LEGS_RUN | ANIM_TOGGLEBIT, ANIM.BOTH_DEATH1)).toBe(ANIM.BOTH_DEATH1);
    expect(nextAnim(ANIM.LEGS_RUN, ANIM.BOTH_DEATH1)).toBe(ANIM.BOTH_DEATH1 | ANIM_TOGGLEBIT);
  });
});
