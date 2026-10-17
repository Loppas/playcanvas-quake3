// @vitest-environment jsdom
import { RESOLUTION_AUTO, type AppBase } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasHasArea, holdFramesWithoutArea } from './canvas-area';
import { createTestApp } from './engine-test-fixtures';

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
    // The page's pacer asks for the next frame; here the test ticks.
    app.requestAnimationFrame = () => {};
  });

  afterEach(() => {
    app.destroy();
  });

  /** Size the canvas on the page, then tick the app once. */
  const tick = (width: number, height: number) => {
    page.width = width;
    page.height = height;
    app.tick(performance.now());
  };

  it('fits the device to the canvas, and says whether it has an area', () => {
    expect(canvasHasArea(app)).toBe(true);
    for (const [width, height] of [[0, 0], [0, 720], [1280, 0]]) {
      page.width = width;
      page.height = height;
      expect(canvasHasArea(app), `${width}x${height}`).toBe(false);
      expect([app.graphicsDevice.width, app.graphicsDevice.height]).toEqual([width, height]);
    }
    page.width = 1280;
    page.height = 720;
    expect(canvasHasArea(app)).toBe(true);
  });

  it('holds every frame while the canvas has none, the update and the end going on', () => {
    holdFramesWithoutArea(app);
    const log: string[] = [];
    vi.spyOn(app, 'render').mockImplementation(() => log.push('render'));
    app.on('update', () => log.push('update'));
    app.on('frameend', () => log.push('end'));

    tick(1280, 720);
    expect(log.splice(0)).toEqual(['update', 'render', 'end']);
    tick(0, 0);
    tick(0, 720);
    tick(1280, 0);
    expect(log.splice(0)).toEqual(['update', 'end', 'update', 'end', 'update', 'end']);
    // No resize is heard: the canvas is found again as the frame looks.
    tick(1280, 720);
    expect(log.splice(0)).toEqual(['update', 'render', 'end']);
  });
});
