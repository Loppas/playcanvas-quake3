import { describe, expect, it } from 'vitest';

import {
  MAX_REWARDSTACK,
  REWARD_TIME,
  REWARD_Y,
  clearRewards,
  createRewardState,
  drawReward,
  pushReward,
  type Reward
} from './rewards';

const IMPRESSIVE: Reward = { sound: 'impressive', medal: 'impressive', count: 1 };
const EXCELLENT: Reward = { sound: 'excellent', medal: 'excellent', count: 2 };

describe('pushReward', () => {
  it('stacks behind the one showing, and refuses one past the ninth', () => {
    const state = createRewardState();
    for (let i = 0; i < MAX_REWARDSTACK + 3; i++) pushReward(state, { ...IMPRESSIVE, count: i });
    expect(state.stack).toBe(MAX_REWARDSTACK - 1);
    // Slot 0 is the one showing, which a push never writes.
    expect(state.rewards[0]).toBeNull();
    expect(state.rewards[MAX_REWARDSTACK - 1]?.count).toBe(MAX_REWARDSTACK - 2);
  });
});

describe('CG_DrawReward', () => {
  it('draws nothing with nothing waiting', () => {
    expect(drawReward(createRewardState(), 5000)).toBeNull();
  });

  it('brings the next up and says it, then shows it for three seconds', () => {
    const state = createRewardState();
    pushReward(state, IMPRESSIVE);

    const first = drawReward(state, 5000);
    expect(first).toMatchObject({ medal: 'impressive', voice: 'impressive', alpha: 1 });
    expect(state.stack).toBe(0);

    // Said once, as it came up.
    expect(drawReward(state, 6000)?.voice).toBeNull();
    // `CG_FadeColor`: whole until its last 200 ms.
    expect(drawReward(state, 7800)?.alpha).toBe(1);
    expect(drawReward(state, 7900)?.alpha).toBeCloseTo(0.5, 6);
    expect(drawReward(state, 5000 + REWARD_TIME)).toBeNull();
  });

  it('takes the next one as the last runs out, in the order they came', () => {
    const state = createRewardState();
    pushReward(state, IMPRESSIVE);
    pushReward(state, EXCELLENT);

    expect(drawReward(state, 1000)?.voice).toBe('impressive');
    expect(drawReward(state, 1000 + REWARD_TIME - 1)?.medal).toBe('impressive');
    const next = drawReward(state, 1000 + REWARD_TIME);
    expect(next).toMatchObject({ medal: 'excellent', voice: 'excellent' });
    expect(drawReward(state, 1000 + 2 * REWARD_TIME)).toBeNull();
  });

  it('draws one medal for each reward, 48 apart and centred, each 44 square', () => {
    const state = createRewardState();
    pushReward(state, { ...IMPRESSIVE, count: 3 });
    expect(drawReward(state, 1000)?.medals).toEqual([
      { x: 248, y: REWARD_Y, w: 44, h: 44 },
      { x: 296, y: REWARD_Y, w: 44, h: 44 },
      { x: 344, y: REWARD_Y, w: 44, h: 44 }
    ]);
  });

  it('draws one medal with the count under it from ten up, faded with it', () => {
    const state = createRewardState();
    pushReward(state, { ...IMPRESSIVE, count: 12 });
    const frame = drawReward(state, 1000)!;
    expect(frame.medals).toEqual([{ x: 296, y: REWARD_Y, w: 44, h: 44 }]);
    expect(frame.count).toMatchObject({
      text: '12',
      x: 312,
      y: REWARD_Y + 48,
      charWidth: 8,
      charHeight: 16,
      shadow: true
    });
    expect(drawReward(state, 1000 + REWARD_TIME - 100)?.count?.color[3]).toBeCloseTo(0.5, 6);
  });

  it('draws nine medals for nine, and one with its count for ten', () => {
    const nine = createRewardState();
    pushReward(nine, { ...IMPRESSIVE, count: 9 });
    expect(drawReward(nine, 1000)?.medals).toHaveLength(9);

    const ten = createRewardState();
    pushReward(ten, { ...IMPRESSIVE, count: 10 });
    const frame = drawReward(ten, 1000)!;
    expect(frame.medals).toHaveLength(1);
    expect(frame.count?.text).toBe('10');
  });

  it('says a reward counted back to 0, with no medals to show', () => {
    // What a restart does to every counter, which `CG_CheckLocalSounds` pushes like any other.
    const state = createRewardState();
    pushReward(state, { ...EXCELLENT, count: 0 });
    expect(drawReward(state, 1000)).toMatchObject({ medals: [], count: null, voice: 'excellent' });
  });

  it('has nothing showing and nothing waiting after a restart', () => {
    const state = createRewardState();
    pushReward(state, IMPRESSIVE);
    pushReward(state, EXCELLENT);
    drawReward(state, 1000);
    clearRewards(state);
    expect(drawReward(state, 1500)).toBeNull();
  });
});
