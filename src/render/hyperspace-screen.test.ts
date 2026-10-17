// @vitest-environment jsdom
import { BLEND_NONE, Layer, type AppBase, type Entity, type StandardMaterial } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLASSIC_FULLSCREEN } from '../view/overbright';
import { HYPERSPACE_KEY } from '../view/scene-sort';
import { SceneShaders } from '../view/scene-shaders';
import { NO_SCENE_FOGS } from './bsp-fog';
import { createTestApp } from './engine-test-fixtures';
import {
  HYPERSPACE_LAYER_NAME,
  HyperspaceScreen,
  hyperspaceClear,
  hyperspaceGrey
} from './hyperspace-screen';
import { SceneDraws } from './scene-draws';
import { warmUp } from './warm-up';
import { OPAQUE_BLEND } from './world-stages';

/** A scene's groups with no layers of their own. */
const NO_SCENE = { models: [], effects: [], gun: [], screen: [] };

/**
 * `RDF_HYPERSPACE`'s screen (`tr_backend.c:383–395`): a grey of `(time & 255) / 255` for the
 * world, under the gun and the 2D.
 */

describe('hyperspaceGrey', () => {
  it("climbs from black every 256 ms, doubled by classic Q3's ramp and clamped at white", () => {
    expect(hyperspaceGrey(0, CLASSIC_FULLSCREEN)).toBe(0);
    // `refdef.time` is whole: a fractional clock is taken down.
    expect(hyperspaceGrey(51.9, CLASSIC_FULLSCREEN)).toBe((51 / 255) * 2);
    expect(hyperspaceGrey(128, CLASSIC_FULLSCREEN)).toBe(1);
    expect(hyperspaceGrey(255, CLASSIC_FULLSCREEN)).toBe(1);
    expect(hyperspaceGrey(256 + 51, CLASSIC_FULLSCREEN)).toBe((51 / 255) * 2);
  });

  it('is the clear as it is with no ramp: in a window, or under opengl2', () => {
    expect(hyperspaceGrey(51, { renderer: 'opengl1', overBrightBits: 0 })).toBe(51 / 255);
    expect(hyperspaceGrey(51, { renderer: 'opengl2', overBrightBits: 1 })).toBe(51 / 255);
    expect(hyperspaceGrey(51, { renderer: 'opengl1', overBrightBits: 2 })).toBe((51 / 255) * 4);
  });
});

describe('HyperspaceScreen', () => {
  let app: AppBase;
  let camera: Entity;
  let screen: HyperspaceScreen;

  beforeEach(() => {
    const test = createTestApp();
    app = test.app;
    camera = test.camera;
    screen = new HyperspaceScreen(app, camera);
  });

  afterEach(() => app.destroy());

  const layer = () => app.scene.layers.getLayerByName(HYPERSPACE_LAYER_NAME)!;

  it('is the last layer the eye draws, and the last in the composition', () => {
    expect(camera.camera!.layers.at(-1)).toBe(layer().id);
    const { layerList } = app.scene.layers;
    expect(layerList.at(-1)).toBe(layer());
  });

  it('draws nothing until a frame is in hyperspace, and nothing after', () => {
    const [quad] = layer().meshInstances;
    expect(screen.shown).toBe(false);
    expect(quad.visible).toBe(false);

    screen.show(51);
    expect(quad.visible).toBe(true);
    const material = quad.material as StandardMaterial;
    expect(material.emissive.r).toBe(hyperspaceGrey(51));
    expect([material.emissive.g, material.emissive.b]).toEqual([
      material.emissive.r,
      material.emissive.r
    ]);
    // Opaque, over everything, testing and writing no depth, so the gun's camera draws over it.
    expect(material.blendType).toBe(BLEND_NONE);
    expect([material.depthTest, material.depthWrite]).toEqual([false, false]);
    expect(quad.screenSpace).toBe(true);

    screen.show(null);
    expect(quad.visible).toBe(false);
  });

  it('draws for the warm-up, so a first teleport makes nothing, and hides after', () => {
    const [quad] = layer().meshInstances;
    const seen: number[] = [];
    const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
      seen.push(app.graphicsDevice.scope.resolve('meshInstanceId').value as number);
    });
    warmUp(app, [screen.warm()]);
    draw.mockRestore();
    expect(seen).toContain(quad.id);
    expect(screen.shown).toBe(false);
  });

  it("draws the framebuffer's grey in a map's scene, after every shader, under the ramp", () => {
    const scene = new SceneDraws(new SceneShaders(), NO_SCENE);
    const placed = new HyperspaceScreen(app, camera, scene);
    const own = app.scene.layers.layerList.at(-1)!;
    const [quad] = own.meshInstances;
    const sceneLayer = new Layer({ name: 'scene' });
    app.scene.layers.push(sceneLayer);
    scene.enter({ layer: sceneLayer, fog: NO_SCENE_FOGS, key: () => {} });
    expect(own.meshInstances).toEqual([]);
    expect(sceneLayer.meshInstances).toEqual([quad]);
    placed.show(51);
    const material = quad.material as StandardMaterial;
    // Q3's clear, which the ramp doubles with the rest.
    expect(material.emissive.r).toBe(hyperspaceClear(51));
    expect(hyperspaceClear(51)).toBe(51 / 255);
    expect(quad.drawOrder).toBe(HYPERSPACE_KEY);
    expect(material.blendState.equals(OPAQUE_BLEND)).toBe(true);
    scene.enter(null);
    expect(own.meshInstances).toEqual([quad]);
    placed.show(51);
    expect([material.emissive.r, material.blendType]).toEqual([hyperspaceGrey(51), BLEND_NONE]);
    placed.destroy();
  });

  it('leaves the eye and the composition when it goes', () => {
    const id = layer().id;
    screen.destroy();
    expect(camera.camera!.layers).not.toContain(id);
    expect(app.scene.layers.getLayerByName(HYPERSPACE_LAYER_NAME)).toBeFalsy();
  });
});
