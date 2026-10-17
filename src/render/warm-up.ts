import {
  DEVICETYPE_WEBGL2,
  Entity,
  type AppBase,
  type CameraComponent,
  type GraphicsDevice,
  type RenderComponent,
  type WebglGraphicsDevice
} from 'playcanvas';

import { canvasHasArea } from './canvas-area';

/**
 * The load's last step, as `CL_InitCGame` ends in `RE_EndRegistration` (`cl_cgame.c:761`), whose
 * `RB_ShowImages` draws every image once "to make sure they are resident" (`tr_init.c:1315–1320`):
 * every draw the match can make is drawn under the load screen, so that the device makes its
 * shaders and pipelines there, and not at the draw's first use in play. Both are the device's for
 * good once made, so a draw's later copies, and a later map, find them.
 *
 * Each module shows what it has built, hidden or not, and builds once what it would otherwise build
 * only at use. A material's shader follows its state, and an animated stage's state changes as it
 * plays: at zero its texture transform is the identity, and once it moves it is not. So everything
 * is drawn twice, every clock at zero and then away from it.
 */

/** One module's draws for the warm-up. */
export interface Warmed {
  /**
   * Show everything, played at `seconds` on every clock it runs on. The first call shows it; a
   * later one plays it at another moment.
   */
  at(seconds: number): void;
  /**
   * The frames of its longest flipbook, where it has any: after the moments, each is drawn with
   * {@link frame}, so that every image is drawn once, as `RB_ShowImages` draws them. A texture's
   * first draw makes what the device samples it with, which play would otherwise make.
   */
  frames?(): number;
  /** Bind the `k`th frame of each of its flipbooks, wrapping round a shorter one. */
  frame?(k: number): void;
  /** Hide all it showed, and let go of what it built for the warm-up. */
  end(): void;
}

/**
 * The moments the warm-up draws at, in seconds: zero, and an odd moment away from it, which no
 * scroll or turn of a shader brings back to where it started.
 */
export const WARM_TIMES: readonly number[] = [0, 0.1234];

/**
 * Draw a frame of everything `warmed` shows at each of {@link WARM_TIMES}, then one for each frame
 * of the longest flipbook among them, then put it all away. The frames are drawn at once, not at
 * the page's next ones, so nothing else runs between the showing and the hiding. Every camera draws
 * them with culling off, so nothing shown is missed for being out of its view. A canvas with no
 * area draws none, as a frame drawn there is lost (`canvas-area.ts`).
 */
export function warmUp(app: AppBase, warmed: readonly Warmed[]): void {
  const render = () => {
    if (canvasHasArea(app)) app.render();
  };
  const culling = new Map<CameraComponent, boolean>();
  try {
    for (const seconds of WARM_TIMES) {
      for (const draws of warmed) draws.at(seconds);
      // A camera a module put up is among them from its first call.
      for (const camera of app.systems.camera?.cameras ?? []) {
        if (culling.has(camera)) continue;
        culling.set(camera, camera.frustumCulling);
        camera.frustumCulling = false;
      }
      render();
    }
    let frames = 0;
    for (const draws of warmed) frames = Math.max(frames, draws.frames?.() ?? 0);
    for (let k = 0; k < frames; k++) {
      for (const draws of warmed) draws.frame?.(k);
      render();
    }
  } finally {
    for (const [camera, culled] of culling) camera.frustumCulling = culled;
    for (const draws of warmed) draws.end();
  }
}

/**
 * Resolve at the end of the first frame that draws every splat through `camera` sorted, none of it
 * still loading, or that draws none through it. A splat is drawn only once its sorter has answered,
 * and that first drawing copies it into the engine's work buffer, a pass with a pipeline of its
 * own; a warm-up after this finds the copy made.
 */
export function splatsSorted(app: AppBase, camera: CameraComponent): Promise<void> {
  const system = app.systems.gsplat;
  if (!system) return Promise.resolve();
  return new Promise((resolve) => {
    let drawn = false;
    let sorted = true;
    const onReady = (
      drawing: CameraComponent,
      _layer: unknown,
      ready: boolean,
      loading: number
    ) => {
      if (drawing !== camera) return;
      drawn = true;
      sorted &&= ready && !loading;
    };
    const onFrameEnd = () => {
      if (drawn && !sorted) {
        drawn = false;
        sorted = true;
        return;
      }
      system.off('frame:ready', onReady);
      app.off('frameend', onFrameEnd);
      resolve();
    };
    system.on('frame:ready', onReady);
    app.on('frameend', onFrameEnd);
  });
}

/** How often a wait on a WebGL2 device asks whether its work is done, in milliseconds. */
const FENCE_POLL_MS = 16;

/** The queue of a browser's `GPUDevice`, as {@link gpuFinished} waits on it. */
interface GpuQueue {
  onSubmittedWorkDone(): Promise<void>;
}

/**
 * Resolve once the device has done all the work given to it, as `RB_ShowImages` ends in
 * `qglFinish` (`tr_backend.c:1004`). The browser makes a draw's pipeline in its GPU process after
 * the draw is recorded, so a load that ends with its warm-up waits on this: otherwise the pipelines
 * are still being made under the first frames in play, and hold them. At once on a device that has
 * no queue to wait on.
 */
export async function gpuFinished(device: GraphicsDevice): Promise<void> {
  // PlayCanvas' handle on the browser's device, which its typings leave out.
  const gpu = (device as unknown as { wgpu?: { queue: GpuQueue } | null }).wgpu;
  if (gpu) {
    await gpu.queue.onSubmittedWorkDone();
  } else if (device.deviceType === DEVICETYPE_WEBGL2) {
    await (device as WebglGraphicsDevice).clientWaitAsync(0, FENCE_POLL_MS);
  }
}

/**
 * Show every entity under `root` that is hidden, `root` among them, and every render component
 * switched off, until the function returned puts each back. `root`'s parent must show.
 */
export function showHidden(root: Entity): () => void {
  const entities: Entity[] = [];
  const renders: RenderComponent[] = [];
  const visit = (entity: Entity) => {
    // Its parent shows by now, so whether it shows is its own.
    if (!entity.enabled) {
      entity.enabled = true;
      entities.push(entity);
    }
    const { render } = entity;
    if (render && !render.enabled) {
      render.enabled = true;
      renders.push(render);
    }
    for (const child of entity.children) {
      if (child instanceof Entity) visit(child);
    }
  };
  visit(root);
  return () => {
    for (const render of renders) render.enabled = false;
    for (const entity of entities) entity.enabled = false;
  };
}

/** What a device has made: shader modules and render pipelines. */
export interface Made {
  shaders: number;
  pipelines: number;
}

/** The two makers of a browser's `GPUDevice` that {@link countMade} counts. */
interface GpuMakers {
  createShaderModule(descriptor: unknown): unknown;
  createRenderPipeline(descriptor: unknown): unknown;
}

/**
 * Count the shader modules and render pipelines a WebGPU device makes from now on, for a check that
 * the warm-up leaves none to make in play; `null` on any other device.
 */
export function countMade(device: GraphicsDevice): Made | null {
  // PlayCanvas' handle on the browser's device, which its typings leave out.
  const gpu = (device as unknown as { wgpu?: GpuMakers | null }).wgpu;
  if (!gpu) return null;
  const made: Made = { shaders: 0, pipelines: 0 };
  const createShaderModule = gpu.createShaderModule.bind(gpu);
  const createRenderPipeline = gpu.createRenderPipeline.bind(gpu);
  gpu.createShaderModule = (descriptor) => {
    made.shaders++;
    return createShaderModule(descriptor);
  };
  gpu.createRenderPipeline = (descriptor) => {
    made.pipelines++;
    return createRenderPipeline(descriptor);
  };
  return made;
}
