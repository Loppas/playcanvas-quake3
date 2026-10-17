import type { MEDAL_SHADERS } from '../formats/asset-manifest';
import type { AnnouncerCue } from './announcer';
import type { HudText } from './hud';
import { SCREEN_WIDTH, type HudRect } from './hud-layout';
import { SMALLCHAR_HEIGHT, SMALLCHAR_WIDTH } from './hud-text';
import { fadeAlpha } from './weapon-bar';

/**
 * The rewards: `pushReward`'s stack (`cg_playerstate.c:286–293`) and `CG_DrawReward`
 * (`cg_draw.c:1454–1519`), which shows each reward's medals for three seconds in turn and says its
 * name as it comes up. Engine-free.
 */

/** `MAX_REWARDSTACK` (`cg_local.h:441`). */
export const MAX_REWARDSTACK = 10;

/** `REWARD_TIME` (`cg_local.h:54`): how long a reward's medals stay up. */
export const REWARD_TIME = 3000;

/** `ICON_SIZE` (`cg_local.h:65`): how far apart the medals are, each drawn 4 short of it. */
const ICON_SIZE = 48;

/** Where the medals' row stands (`cg_draw.c:1499, 1510`). */
export const REWARD_Y = 56;

/** One of the six medals, by its name in {@link MEDAL_SHADERS}. */
export type Medal = keyof typeof MEDAL_SHADERS;

/** One reward: the voice that says it, the medal that shows it, and how many the player has. */
export interface Reward {
  sound: AnnouncerCue;
  medal: Medal;
  count: number;
}

/** `cg.rewardStack`, the three arrays it indexes, and the clock of the one showing. */
export interface RewardState {
  /** `cg.rewardStack`: how many wait behind the one in slot 0. */
  stack: number;
  /** `cg.rewardTime`: when the one in slot 0 came up, or 0 for never. */
  time: number;
  /** `cg.rewardSound`, `rewardShader` and `rewardCount`, slot 0 the one showing. */
  rewards: (Reward | null)[];
}

export function createRewardState(): RewardState {
  return { stack: 0, time: 0, rewards: new Array<Reward | null>(MAX_REWARDSTACK).fill(null) };
}

/**
 * `pushReward`: a reward behind the others. A full stack refuses it. Slot 0 is never written here,
 * since it holds the one showing.
 */
export function pushReward(state: RewardState, reward: Reward): void {
  if (state.stack < MAX_REWARDSTACK - 1) {
    state.stack++;
    state.rewards[state.stack] = reward;
  }
}

/** `CG_MapRestart`'s share: nothing showing, and nothing waiting (`cg_servercmds.c:472–473`). */
export function clearRewards(state: RewardState): void {
  state.time = 0;
  state.stack = 0;
}

/** What `CG_DrawReward` draws this frame, and the voice it starts. */
export interface RewardFrame {
  medal: Medal;
  /** Each medal's place: one for each reward below ten, one alone from ten up. */
  medals: HudRect[];
  /** The count under a lone medal, from ten up. */
  count: HudText | null;
  alpha: number;
  /** The reward's voice, started as it comes up. */
  voice: AnnouncerCue | null;
}

/**
 * `CG_DrawReward`: the reward showing, or the next one once its time is up, whose voice starts as
 * it comes up. Moves `state` on.
 *
 * A reward counted back to 0 — as a restart does to every counter — comes up with no medals, and
 * is still said.
 *
 * @returns what to draw, or `null` with nothing showing and nothing waiting.
 */
export function drawReward(state: RewardState, time: number): RewardFrame | null {
  let voice: AnnouncerCue | null = null;
  // `CG_FadeColor` refuses a start of 0, which is "never".
  let alpha = state.time === 0 ? null : fadeAlpha(state.time, REWARD_TIME, time);
  if (alpha === null) {
    if (state.stack <= 0) return null;
    for (let i = 0; i < state.stack; i++) state.rewards[i] = state.rewards[i + 1];
    state.time = Math.floor(time);
    state.stack--;
    alpha = fadeAlpha(state.time, REWARD_TIME, time) ?? 1;
    voice = state.rewards[0]?.sound ?? null;
  }
  const reward = state.rewards[0];
  if (!reward) return null;

  const size = ICON_SIZE - 4;
  if (reward.count >= 10) {
    const text = String(reward.count);
    return {
      medal: reward.medal,
      medals: [{ x: SCREEN_WIDTH / 2 - ICON_SIZE / 2, y: REWARD_Y, w: size, h: size }],
      count: {
        text,
        x: (SCREEN_WIDTH - SMALLCHAR_WIDTH * text.length) / 2,
        y: REWARD_Y + ICON_SIZE,
        charWidth: SMALLCHAR_WIDTH,
        charHeight: SMALLCHAR_HEIGHT,
        color: [1, 1, 1, alpha],
        shadow: true,
        anchor: 'centre'
      },
      alpha,
      voice
    };
  }
  const left = SCREEN_WIDTH / 2 - (reward.count * ICON_SIZE) / 2;
  return {
    medal: reward.medal,
    medals: Array.from({ length: reward.count }, (_unused, i) => ({
      x: left + i * ICON_SIZE,
      y: REWARD_Y,
      w: size,
      h: size
    })),
    count: null,
    alpha,
    voice
  };
}
