// @vitest-environment jsdom
import {
  BLEND_ADDITIVE,
  CULLFACE_NONE,
  LAYERID_WORLD,
  type AppBase,
  type Entity,
  type StandardMaterial
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { vec3 } from '../sim/vec3';
import type { HitBox } from '../view/hit-boxes';
import { SceneShaders } from '../view/scene-shaders';
import { WORLD_ENTITY } from '../view/scene-sort';
import { LIGHTMAP_2D } from '../view/world-shaders';
import { createTestApp } from './engine-test-fixtures';
import { HitBoxes, borderTexel } from './hit-boxes';
import { SceneDraws, sceneDraw } from './scene-draws';
import { WARM_TIMES } from './warm-up';

/** A standing player's box, drawn at `x`. */
function standing(x: number, color: HitBox['color']): HitBox {
  return { origin: vec3(x, 0, 24), mins: vec3(-15, -15, -24), maxs: vec3(15, 15, 32), color };
}

describe('HitBoxes', () => {
  let app: AppBase;
  let boxes: HitBoxes;

  beforeEach(() => {
    ({ app } = createTestApp());
    boxes = HitBoxes.create(app, [LAYERID_WORLD]);
  });

  afterEach(() => {
    boxes.destroy();
    app.destroy();
  });

  /** The boxes drawn: where each is, how big, and what it is drawn with. */
  function drawn() {
    const root = app.root.findByName('hit-boxes')!;
    return (root.children as Entity[])
      .filter((entity) => entity.enabled)
      .map((entity) => ({
        at: entity.getLocalPosition().toArray(),
        size: entity.getLocalScale().toArray(),
        material: entity.render!.meshInstances[0].material as StandardMaterial
      }));
  }

  it("puts each box about where its player is drawn, as big as the player's box", () => {
    boxes.update([standing(100, [0, 1, 0.16])]);
    const [box] = drawn();
    // The box's middle: 24 up, and halfway from 24 below that to 32 above.
    expect(box.at).toEqual([100, 0, 28]);
    expect(box.size).toEqual([30, 30, 56]);
  });

  it("adds the border onto the scene in the box's colour, both sides, writing no depth", () => {
    boxes.update([standing(100, [0.91, 0, 0]), standing(200, [0.91, 0, 0])]);
    const [first, second] = drawn();
    const { material } = first;
    expect(material.emissive.toArray()).toEqual([0.91, 0, 0, 1]);
    expect(material.emissiveMap).not.toBeNull();
    expect(material.blendType).toBe(BLEND_ADDITIVE);
    expect(material.cull).toBe(CULLFACE_NONE);
    expect(material.depthWrite).toBe(false);
    expect(material.useLighting).toBe(false);
    // One material a colour.
    expect(second.material).toBe(material);
  });

  it("sorts a box in a map's scene as a poly, with the world's surfaces after every entity", () => {
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [],
      gun: [],
      screen: []
    });
    const placed = HitBoxes.create(app, [LAYERID_WORLD], scene);
    try {
      placed.update([standing(100, [0, 1, 0.16])]);
      const box = app.root.findByName('hit-box') as Entity;
      const tag = sceneDraw(box.render!.meshInstances[0])!;
      expect(tag.entity.value).toBe(WORLD_ENTITY);
      expect(tag.shader).toBe(scene.shaders.handle('bbox_nocull', LIGHTMAP_2D));
      // Its fog found by its corners, as a poly's is; added, so a fog dims its colour.
      const { origin, mins, maxs } = standing(100, [0, 1, 0.16]);
      expect(tag.entity.fogBy).toEqual({
        kind: 'box',
        mins: [origin.x + mins.x, origin.y + mins.y, origin.z + mins.z],
        maxs: [origin.x + maxs.x, origin.y + maxs.y, origin.z + maxs.z]
      });
      const { defines } = box.render!.meshInstances[0].material as StandardMaterial;
      expect([defines.has('Q3_FOG_RGB'), defines.has('Q3_FOG_ALPHA')]).toEqual([true, false]);
    } finally {
      placed.destroy();
    }
  });

  it("draws none of the last frame's boxes that are not among this frame's", () => {
    boxes.update([standing(100, [0, 1, 0.16]), standing(200, [0.18, 0.38, 0.78])]);
    expect(drawn()).toHaveLength(2);
    boxes.update([standing(300, [0, 1, 0.16])]);
    expect(drawn().map(({ at }) => at[0])).toEqual([300]);
    boxes.update([]);
    expect(drawn()).toEqual([]);
  });

  it('shows a box for the warm-up, then hides it again', () => {
    const warmed = boxes.warm();
    warmed.at(0);
    expect(drawn()).toHaveLength(1);
    warmed.at(WARM_TIMES[1]);
    warmed.end();
    expect(drawn()).toEqual([]);
  });

  it("gives a box's draw another material only when its colour changes", () => {
    boxes.update([standing(100, [0, 1, 0.16])]);
    const box = app.root.findByName('hit-box') as Entity;
    const [instance] = box.render!.meshInstances;
    const assigned = vi.spyOn(instance, 'material', 'set');
    boxes.update([standing(200, [0, 1, 0.16])]);
    expect(assigned).not.toHaveBeenCalled();
    boxes.update([standing(200, [0.91, 0, 0])]);
    expect(assigned).toHaveBeenCalledTimes(1);
    expect((instance.material as StandardMaterial).emissive.r).toBe(0.91);
  });

  it('draws a box again once a frame asks for it after one that did not', () => {
    boxes.update([standing(100, [0, 1, 0.16]), standing(200, [0, 1, 0.16])]);
    boxes.update([standing(100, [0, 1, 0.16])]);
    boxes.update([standing(100, [0, 1, 0.16]), standing(400, [0, 1, 0.16])]);
    expect(drawn().map(({ at }) => at[0])).toEqual([100, 400]);
  });
});

describe('borderTexel', () => {
  it("makes Excessive Plus's border: bright at each edge and where two meet, black inside", () => {
    // Its texture's own texels, to within its JPEG's noise: [x, y, brightness].
    const read = [
      [0, 0, 249],
      [1, 1, 226],
      [0, 1, 248],
      [2, 2, 142],
      [3, 3, 47],
      [16, 0, 229],
      [16, 1, 168],
      [16, 3, 26],
      [31, 16, 232],
      [16, 16, 0]
    ];
    for (const [x, y, brightness] of read) {
      expect(Math.abs(borderTexel(x, y) - brightness), `${x}, ${y}`).toBeLessThanOrEqual(4);
    }
  });
});
