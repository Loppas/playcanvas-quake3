import { describe, expect, it } from 'vitest';

import {
  BLOB_ENTITY,
  ENTITY_PARTS,
  HYPERSPACE_KEY,
  LOCAL_ENTITY_BASE,
  MAX_SHADER_PLACES,
  PLAYER_PART,
  VIEW_WEAPON_PART,
  WORLD_ENTITY,
  localEntity,
  modelStep,
  overHyperspaceKey,
  packetEntity,
  predictedEntity,
  rampKey,
  sceneKey,
  viewWeaponEntity,
  viewWeaponPart
} from './scene-sort';

/** Whether keys are each after the last. */
const ascending = (keys: readonly number[]) => keys.every((key, i) => i === 0 || key > keys[i - 1]);

describe("the scene's key", () => {
  it("sorts by place, entity, fog, the dlight bit, then the step, as R_AddDrawSurf's key", () => {
    expect(
      ascending([
        sceneKey(3, WORLD_ENTITY, 31, true, 65535),
        sceneKey(4, 0, 0, false, 0),
        sceneKey(4, 0, 0, false, 1),
        sceneKey(4, 0, 0, true, 0),
        sceneKey(4, 0, 1, false, 0),
        sceneKey(4, 1, 0, false, 0),
        sceneKey(5, 0, 0, false, 0)
      ])
    ).toBe(true);
  });

  it('holds every key exactly in a double, the last below 2^53', () => {
    const last = sceneKey(MAX_SHADER_PLACES - 2, WORLD_ENTITY, 31, true, 65535);
    expect(last).toBeLessThan(2 ** 53);
    expect(Number.isSafeInteger(last)).toBe(true);
    expect(last - 1).not.toBe(last);
    expect(Number.isSafeInteger(rampKey(1))).toBe(true);
  });

  it('numbers the entities in the order cgame adds them, and the world after them all', () => {
    expect(
      ascending([
        BLOB_ENTITY,
        predictedEntity(0),
        predictedEntity(ENTITY_PARTS - 1),
        packetEntity(0),
        packetEntity(0, PLAYER_PART.hook),
        packetEntity(1),
        packetEntity(1023, ENTITY_PARTS - 1),
        localEntity(0),
        localEntity(16383, 3),
        viewWeaponEntity(0),
        viewWeaponEntity(VIEW_WEAPON_PART.crackle),
        WORLD_ENTITY
      ])
    ).toBe(true);
    expect(LOCAL_ENTITY_BASE).toBe(localEntity(0));
    // A part past the room an entity has stays its last.
    expect(packetEntity(5, 99)).toBe(packetEntity(5, ENTITY_PARTS - 1));
    expect(viewWeaponPart(viewWeaponEntity(VIEW_WEAPON_PART.flash))).toBe(VIEW_WEAPON_PART.flash);
  });

  it('keeps the local entities in the order they were made, their serials coming round', () => {
    expect(localEntity(7)).toBeLessThan(localEntity(8));
    expect(localEntity(1 << 14)).toBe(localEntity(0));
  });

  it("puts a player's every part in its order, a part's shells after it", () => {
    const parts = [
      PLAYER_PART.sprite,
      PLAYER_PART.legs,
      PLAYER_PART.torso,
      PLAYER_PART.head,
      PLAYER_PART.gun,
      PLAYER_PART.barrel,
      PLAYER_PART.flash,
      PLAYER_PART.bolt,
      PLAYER_PART.crackle,
      PLAYER_PART.flag,
      PLAYER_PART.hook
    ];
    expect(ascending(parts)).toBe(true);
    // The legs' three shells fit before the torso, and the gun's two before the barrel.
    expect(PLAYER_PART.torso - PLAYER_PART.legs).toBe(4);
    expect(PLAYER_PART.barrel - PLAYER_PART.gun).toBe(3);
    expect(Math.max(...parts) + 1).toBeLessThan(ENTITY_PARTS);
  });

  it('draws one entity\'s surfaces of a shader stage by stage', () => {
    expect(ascending([modelStep(0, 0), modelStep(0, 5), modelStep(1, 0), modelStep(2, 63)])).toBe(
      true
    );
  });

  it('puts the grey after every shader, the gun over it, then the ramp', () => {
    const lastShader = sceneKey(MAX_SHADER_PLACES - 1, WORLD_ENTITY, 31, true, 65535);
    expect(
      ascending([
        lastShader,
        HYPERSPACE_KEY,
        overHyperspaceKey(0, 0, 0),
        overHyperspaceKey(0, 0, 1),
        overHyperspaceKey(0, 1, 0),
        overHyperspaceKey(3, 0, 0),
        overHyperspaceKey(MAX_SHADER_PLACES - 1, ENTITY_PARTS - 1, 511),
        rampKey(0),
        rampKey(1)
      ])
    ).toBe(true);
  });
});
