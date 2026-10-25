// @vitest-environment jsdom
import { RESOLUTION_AUTO, type AppBase } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp } from './engine-test-fixtures';

/**
 * The port draws every frame, whatever the canvas's size on the page. On WebGPU a frame with no
 * texture to draw into is refused whole, and with it any work the engine does only once, such as a
 * splat's first copy into its work buffer; the engine keeps one there.
 */
describe('a canvas with no area', () => {
  let app: AppBase;
  /** The canvas's size on the page, which the device is fitted to. */
  const page = { width: 1280, height: 720 };

  beforeEach(() => {
    ({ app } = createTestApp());
    const canvas = app.graphicsDevice.canvas;
    Object.defineProperty(canvas, 'clientWidth', { get: () => page.width, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { get: () => page.height, configurable: true });
    app.setCanvasResolution(RESOLUTION_AUTO);
  });

  afterEach(() => {
    app.destroy();
  });

  /** Size the canvas on the page, draw a frame, and read the size the device drew it at. */
  const drawnAt = (width: number, height: number) => {
    page.width = width;
    page.height = height;
    app.render();
    return [app.graphicsDevice.width, app.graphicsDevice.height];
  };

  it('keeps the device at its last size, so each frame still has a texture to draw into', () => {
    expect(drawnAt(1280, 720)).toEqual([1280, 720]);
    for (const [width, height] of [[0, 0], [0, 720], [1280, 0]]) {
      expect(drawnAt(width, height), `${width}x${height}`).toEqual([1280, 720]);
    }
    // No resize is heard: the canvas is found again as the frame begins.
    expect(drawnAt(1600, 900)).toEqual([1600, 900]);
  });
});
