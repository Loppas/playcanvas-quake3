import { describe, expect, it } from 'vitest';

import { SHARED_ASSETS } from '../formats/asset-manifest';
import {
  TELE_IN_SOUND,
  TELE_OUT_SOUND,
  TELEPORT_EFFECT_MODEL,
  TELEPORT_EFFECT_MS,
  TELEPORT_EFFECT_SHADER,
  teleportEffectFade
} from './teleport-events';

/**
 * A teleport's two ends as a client plays them (`cg_event.c:885–895`, `cg_effects.c:172–202`).
 */

describe("a teleport's media", () => {
  it('are what the manifest brings', () => {
    expect(SHARED_ASSETS.sounds).toContain(TELE_IN_SOUND);
    expect(SHARED_ASSETS.sounds).toContain(TELE_OUT_SOUND);
    expect(SHARED_ASSETS.models).toContain(TELEPORT_EFFECT_MODEL);
    expect(SHARED_ASSETS.shaders).toContain(TELEPORT_EFFECT_SHADER);
    expect([TELE_IN_SOUND, TELE_OUT_SOUND]).toEqual([
      'sound/world/telein.wav',
      'sound/world/teleout.wav'
    ]);
  });
});

describe('teleportEffectFade', () => {
  it("dims from white to black over the effect's half second, as LE_FADE_RGB does", () => {
    expect(TELEPORT_EFFECT_MS).toBe(500);
    expect(teleportEffectFade(0)).toBe(1);
    expect(teleportEffectFade(125)).toBe(0.75);
    expect(teleportEffectFade(500)).toBe(0);
  });
});
