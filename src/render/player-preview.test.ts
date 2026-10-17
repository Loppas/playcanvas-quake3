// @vitest-environment jsdom
import { Mat4, Vec4, type AppBase, type Entity } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerLook } from '../view/player-model';
import { previewFraming } from '../view/player-preview';
import { createTestApp } from './engine-test-fixtures';
import type { PreviewView } from './menu-screen';
import { PREVIEW_CAMERA_PRIORITY, PlayerPreview } from './player-preview';
import { PlayerRig } from './player-rig';
import { playerLibrary } from './player-test-fixtures';
import { TextureCache } from './texture-cache';

/** The player's model beside a menu page, on the null device. */

const look = (model = 'test', skin = 'default'): PlayerLook => ({ body: { model, skin }, head: { model, skin } });
const view = (wanted = look()): PreviewView => ({ rect: [0.5, 0.1, 0.25, 0.8], width: 240, height: 400, look: wanted });

describe('PlayerPreview', () => {
  let app: AppBase;
  let eye: Entity;
  let cache: TextureCache;
  let preview: PlayerPreview;

  beforeEach(() => {
    ({ app, camera: eye } = createTestApp());
    cache = new TextureCache(app.graphicsDevice);
    preview = new PlayerPreview(app, playerLibrary(), cache, eye);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    preview.destroy();
    app.destroy();
  });

  const cameraEntity = () => app.root.findByName('menu-preview-camera') as Entity | null;

  it('stands the model in the box once it is built, idle with the machinegun, in a layer of its own', async () => {
    preview.update(view(), 1000);
    expect(cameraEntity()!.enabled).toBe(false);
    await vi.waitFor(() => expect(preview.current).not.toBeNull());
    preview.update(view(), 1000);

    const camera = cameraEntity()!.camera!;
    expect(cameraEntity()!.enabled).toBe(true);
    expect([camera.rect.x, camera.rect.y, camera.rect.z, camera.rect.w]).toEqual([0.5, 0.1, 0.25, 0.8]);
    expect(camera.fov).toBeCloseTo(previewFraming(240, 400).fovY);
    expect(camera.priority).toBe(eye.camera!.priority + PREVIEW_CAMERA_PRIORITY);
    const layer = app.scene.layers.getLayerByName('menu-preview')!;
    expect(camera.layers).toEqual([layer.id]);

    const rig = preview.current!;
    const legs = rig.root.findByName('legs') as Entity;
    expect(legs.render!.layers).toEqual([layer.id]);
    expect(legs.getLocalPosition().x).toBeCloseTo(previewFraming(240, 400).origin[0]);
    expect(rig.muzzleOrigin()).not.toBeNull();
  });

  it('frames the model by the whole box, and draws the part of the box on the screen', async () => {
    preview.update(view(), 0);
    await vi.waitFor(() => expect(preview.current).not.toBeNull());
    const camera = cameraEntity()!.camera!;
    // q3_ui's box, 320×560, on a 4:3 screen: its right quarter and its top and bottom 40 are off it.
    preview.update(
      { rect: [0.625, 0, 0.375, 1], width: 320, height: 560, window: [0, 40 / 560, 0.75, 520 / 560], look: look() },
      0
    );
    const matrix = new Mat4();
    camera.calculateProjection(matrix, 0);
    const ndc = (x: number, y: number, z: number) => {
      const clip = matrix.transformVec4(new Vec4(x, y, z, 1));
      return [clip.x / clip.w, clip.y / clip.w];
    };
    // Straight ahead is the box's middle: two thirds of the way across the part shown, and halfway
    // up it, which is cut evenly.
    const [x, y] = ndc(0, 0, -10);
    expect(x).toBeCloseTo(1 / 3);
    expect(y).toBeCloseTo(0);
    // The box's left edge, where the whole box's frustum puts it, is the part's left edge.
    const { fovY } = previewFraming(320, 560);
    const halfWidth = 10 * Math.tan((fovY * Math.PI) / 360) * (320 / 560);
    expect(ndc(-halfWidth, 0, -10)[0]).toBeCloseTo(-1);

    preview.update(view(), 0);
    expect(camera.calculateProjection).toBeNull();
  });

  it("falls back to the model's default skin for a skin it lacks", async () => {
    preview.update(view(look('test', 'blue')), 0);
    await vi.waitFor(() => expect(preview.current).not.toBeNull());
    expect(preview.current!.skin).toBe('default');
  });

  it('draws nothing for a model the install lacks, and tries it once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    preview.update(view(look('nobody')), 0);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    preview.update(view(look('nobody')), 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warn).toHaveBeenCalledOnce();
    expect(preview.current).toBeNull();
    expect(cameraEntity()!.enabled).toBe(false);
  });

  it('lets a build go that the page left before it was done', async () => {
    const destroy = vi.spyOn(PlayerRig.prototype, 'destroy');
    preview.update(view(), 0);
    preview.update(null, 0);
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(cache.size).toBe(0));
    expect(preview.current).toBeNull();
  });

  it('gives the body back when the page goes', async () => {
    preview.update(view(), 0);
    await vi.waitFor(() => expect(preview.current).not.toBeNull());
    expect(cache.size).toBeGreaterThan(0);
    preview.update(null, 0);
    expect(preview.current).toBeNull();
    expect(cameraEntity()!.enabled).toBe(false);
    await vi.waitFor(() => expect(cache.size).toBe(0));
  });

  it('takes its camera and layer out of the scene when destroyed', () => {
    preview.destroy();
    expect(cameraEntity()).toBeNull();
    expect(app.scene.layers.getLayerByName('menu-preview')).toBeFalsy();
  });
});
