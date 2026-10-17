import type { AppBase } from 'playcanvas';

/**
 * A frame drawn on a canvas with no area is lost, and on WebGPU it takes the rest of its work
 * with it: no texture can be made to draw it into, so the browser refuses the frame's whole
 * submit. Among that work can be what the engine does only once, such as a splat's copy into its
 * work buffer at its first sort, which then draws black for good.
 */

/** Fit the device to its canvas, as a frame begins by doing, and say whether it has an area. */
export function canvasHasArea(app: AppBase): boolean {
  app.updateCanvasSize();
  const { width, height } = app.graphicsDevice;
  return width > 0 && height > 0;
}

/**
 * Draw none of the app's frames while its canvas has no area: each still updates and ends, and
 * the first frame the canvas has an area again draws.
 */
export function holdFramesWithoutArea(app: AppBase): void {
  app.on('framerender', () => {
    app.autoRender = canvasHasArea(app);
  });
}
