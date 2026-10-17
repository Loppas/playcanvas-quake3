// @vitest-environment jsdom
import { Layer, type AppBase, type Entity, type StandardMaterial } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssetLibrary } from '../formats/asset-library';
import { vec3 } from '../sim/vec3';
import type { FloatSprite } from '../view/player-sprites';
import { SceneShaders } from '../view/scene-shaders';
import { PLAYER_PART, packetEntity, predictedEntity } from '../view/scene-sort';
import { LIGHTMAP_2D } from '../view/world-shaders';
import { createTestApp } from './engine-test-fixtures';
import { FloatSprites } from './float-sprites';
import { encode, whiteTga } from './player-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';
import { WARM_TIMES } from './warm-up';

/**
 * The floating sprites on the null device, with a digit's and a medal's shaders in the shapes the
 * retail scripts give them: the digit takes the vertex colour, the medal does not.
 */

const SHADERS = `
gfx/2d/numbers/two_32b { nopicmip { map gfx/2d/numbers/two_32b.tga
  blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA rgbgen vertex } }
medal_excellent { nopicmip { clampmap menu/medals/medal_excellent.tga blendFunc blend } }
`;

function library(): AssetLibrary {
  return new AssetLibrary(
    new Map<string, Uint8Array>([
      ['scripts/gfx.shader', encode(SHADERS)],
      ['gfx/2d/numbers/two_32b.tga', whiteTga()],
      ['menu/medals/medal_excellent.tga', whiteTga()]
    ])
  );
}

const DIGIT: FloatSprite = {
  shader: 'gfx/2d/numbers/two_32b',
  origin: vec3(10, 20, 30),
  radius: 4,
  color: [0, 1, 0, 0.5],
  order: 0
};
const MEDAL: FloatSprite = {
  shader: 'medal_excellent',
  origin: vec3(-10, 0, 78),
  radius: 10,
  color: [1, 0, 0, 0.2],
  order: 0
};

describe('FloatSprites', () => {
  let app: AppBase;
  let camera: Entity;
  let sprites: FloatSprites;

  beforeEach(async () => {
    const test = createTestApp();
    app = test.app;
    camera = test.camera;
    const layer = new Layer({ name: 'blended' });
    app.scene.layers.push(layer);
    camera.setEulerAngles(10, 30, 0);
    sprites = await FloatSprites.create(app, library(), camera, [layer.id]);
  });

  afterEach(() => {
    sprites.destroy();
    app.destroy();
  });

  /** The quads drawn now with a shader. */
  function drawn(shader: string): Entity[] {
    return (app.root.find((node) => node.name === `float-sprite:${shader}`) as Entity[]).filter(
      (entity) => entity.enabled
    );
  }

  it('stands each where it is asked, two radii across, turned with the camera', () => {
    sprites.update([DIGIT, MEDAL]);

    const [digit] = drawn(DIGIT.shader);
    const local = digit.getLocalPosition();
    expect([local.x, local.y, local.z]).toEqual([10, 20, 30]);
    expect(digit.getLocalScale().x).toBe(8);
    const turned = digit.getRotation();
    const facing = camera.getRotation();
    expect(Math.abs(turned.dot(facing))).toBeCloseTo(1, 6);

    expect(drawn(MEDAL.shader)[0].getLocalScale().x).toBe(20);
  });

  it('tints and fades a digit by its colour, and leaves a medal as its image is', () => {
    sprites.update([DIGIT, MEDAL]);

    const [digitInstance] = drawn(DIGIT.shader)[0].render!.meshInstances;
    const tint = digitInstance.material as StandardMaterial;
    expect([tint.emissive.r, tint.emissive.b]).toEqual([0, 0]);
    expect(tint.emissive.g).toBeGreaterThan(0);
    const opacity = digitInstance.getParameter('material_opacity') as { data: number } | undefined;
    expect(opacity?.data).toBe(0.5);

    const [medalInstance] = drawn(MEDAL.shader)[0].render!.meshInstances;
    const plain = medalInstance.material as StandardMaterial;
    expect(plain.emissive.g).toBeGreaterThan(0);
    expect(plain.emissive.r).toBe(plain.emissive.g);
    expect(medalInstance.getParameter('material_opacity')).toBeUndefined();
  });

  it('keeps one material for each colour a stage is asked in', () => {
    sprites.update([DIGIT, { ...DIGIT, origin: vec3() }]);
    const [a, b] = drawn(DIGIT.shader).map((entity) => entity.render!.meshInstances[0].material);
    expect(a).toBe(b);
  });

  it("gives a quad's draw another material only when its colour changes", () => {
    sprites.update([DIGIT, MEDAL]);
    const [digit] = drawn(DIGIT.shader)[0].render!.meshInstances;
    const [medal] = drawn(MEDAL.shader)[0].render!.meshInstances;
    const assigned = [vi.spyOn(digit, 'material', 'set'), vi.spyOn(medal, 'material', 'set')];

    sprites.update([{ ...DIGIT, origin: vec3(1, 2, 3) }, { ...MEDAL, color: [0, 0, 1, 1] }]);
    expect(assigned.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
    sprites.update([{ ...DIGIT, color: [1, 0, 0, 0.5] }, MEDAL]);
    expect(assigned.map((spy) => spy.mock.calls.length)).toEqual([1, 0]);
    expect((digit.material as StandardMaterial).emissive.r).toBeGreaterThan(0);
  });

  it('draws nothing of the last frame that is not in this one', () => {
    sprites.update([DIGIT, DIGIT, MEDAL]);
    expect(drawn(DIGIT.shader)).toHaveLength(2);

    sprites.update([DIGIT]);
    expect(drawn(DIGIT.shader)).toHaveLength(1);
    expect(drawn(MEDAL.shader)).toHaveLength(0);
  });

  it('shows a sprite of every shader for the warm-up, then hides them again', () => {
    const warmed = sprites.warm();
    warmed.at(0);
    expect([drawn(DIGIT.shader), drawn(MEDAL.shader)].map((quads) => quads.length)).toEqual([1, 1]);
    warmed.at(WARM_TIMES[1]);
    warmed.end();
    expect([drawn(DIGIT.shader), drawn(MEDAL.shader)]).toEqual([[], []]);
    // Kept for play.
    sprites.update([DIGIT]);
    expect(app.root.find((node) => node.name === `float-sprite:${DIGIT.shader}`)).toHaveLength(1);
  });

  it("numbers a quad in a map's scene as its sprite's entity, its shader a 2D one", async () => {
    const layer = new Layer({ name: 'effects' });
    app.scene.layers.push(layer);
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [layer],
      gun: [],
      screen: []
    });
    const placed = await FloatSprites.create(app, library(), camera, [layer.id], scene);
    try {
      placed.update([
        { ...DIGIT, order: packetEntity(5, PLAYER_PART.sprite) },
        { ...MEDAL, order: predictedEntity(PLAYER_PART.sprite) }
      ]);
      const tagOf = (shader: string) => sceneDraw(drawn(shader)[0].render!.meshInstances[0])!;
      expect([tagOf(DIGIT.shader).entity.value, tagOf(MEDAL.shader).entity.value]).toEqual([
        packetEntity(5, PLAYER_PART.sprite),
        predictedEntity(PLAYER_PART.sprite)
      ]);
      expect(tagOf(MEDAL.shader).shader).toBe(scene.shaders.handle(MEDAL.shader, LIGHTMAP_2D));
      // Each a sprite, its fog found by its radius.
      expect(tagOf(DIGIT.shader).entity.fogBy).toEqual({ kind: 'sprite', radius: DIGIT.radius });
    } finally {
      placed.destroy();
    }
  });

  it('draws nothing for a shader the install has no script for', () => {
    sprites.update([{ ...MEDAL, shader: 'medal_capture' }]);
    expect(app.root.find((node) => node.name.startsWith('float-sprite:'))).toEqual([]);
  });
});
