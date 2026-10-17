// @vitest-environment jsdom
import { Entity, LAYERID_WORLD, type AppBase, type GraphicsDevice } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestApp } from './engine-test-fixtures';
import {
  WARM_TIMES,
  countMade,
  gpuFinished,
  showHidden,
  splatsSorted,
  warmUp,
  type Warmed
} from './warm-up';

/** The warm-up's frames, and what each module shows for them, on the null device. */

describe('warmUp', () => {
  let app: AppBase;
  let camera: Entity;

  beforeEach(() => {
    ({ app, camera } = createTestApp());
  });

  afterEach(() => {
    app.destroy();
  });

  /** A module's draws that log each call. */
  function logged(log: string[], name: string): Warmed {
    return {
      at: (seconds) => log.push(`${name} at ${seconds}`),
      end: () => log.push(`${name} end`)
    };
  }

  it('draws a frame at each moment, the eye culling nothing, then puts it all away', () => {
    const log: string[] = [];
    vi.spyOn(app, 'render').mockImplementation(() => {
      log.push(`render, culling ${camera.camera!.frustumCulling}`);
    });
    warmUp(app, [logged(log, 'a'), logged(log, 'b')]);
    expect(log).toEqual([
      'a at 0',
      'b at 0',
      'render, culling false',
      `a at ${WARM_TIMES[1]}`,
      `b at ${WARM_TIMES[1]}`,
      'render, culling false',
      'a end',
      'b end'
    ]);
    expect(camera.camera!.frustumCulling).toBe(true);
  });

  it("then draws each frame of the longest flipbook, binding each module's in turn", () => {
    const log: string[] = [];
    vi.spyOn(app, 'render').mockImplementation(() => {
      log.push(`render, culling ${camera.camera!.frustumCulling}`);
    });
    const flipping = (name: string, frames: number): Warmed => ({
      ...logged(log, name),
      frames: () => frames,
      frame: (k) => log.push(`${name} frame ${k}`)
    });
    warmUp(app, [flipping('a', 2), logged(log, 'b'), flipping('c', 3)]);
    expect(log.slice(log.lastIndexOf(`c at ${WARM_TIMES[1]}`) + 1)).toEqual([
      'render, culling false',
      'a frame 0',
      'c frame 0',
      'render, culling false',
      'a frame 1',
      'c frame 1',
      'render, culling false',
      'a frame 2',
      'c frame 2',
      'render, culling false',
      'a end',
      'b end',
      'c end'
    ]);
    expect(camera.camera!.frustumCulling).toBe(true);
  });

  it('draws no frame while the canvas has no area, each module shown and put away still', () => {
    const log: string[] = [];
    vi.spyOn(app, 'render').mockImplementation(() => {
      log.push('render');
    });
    app.graphicsDevice.resizeCanvas(0, 0);
    warmUp(app, [
      { ...logged(log, 'a'), frames: () => 2, frame: (k) => log.push(`a frame ${k}`) }
    ]);
    expect(log).toEqual(['a at 0', `a at ${WARM_TIMES[1]}`, 'a frame 0', 'a frame 1', 'a end']);
  });

  it('draws through a camera a module puts up, culling nothing there either', () => {
    const own = new Entity('own-camera');
    own.addComponent('camera');
    own.enabled = false;
    app.root.addChild(own);
    const culled: boolean[] = [];
    vi.spyOn(app, 'render').mockImplementation(() => culled.push(own.camera!.frustumCulling));
    warmUp(app, [{ at: () => (own.enabled = true), end: () => (own.enabled = false) }]);
    expect(culled).toEqual([false, false]);
    expect(own.camera!.frustumCulling).toBe(true);
  });

  it('puts everything away even when a draw fails', () => {
    const ended: string[] = [];
    const failing: Warmed = {
      at: (seconds) => {
        if (seconds > 0) throw new Error('lost');
      },
      end: () => ended.push('failing')
    };
    vi.spyOn(app, 'render').mockImplementation(() => {});
    expect(() =>
      warmUp(app, [failing, { at: () => {}, end: () => ended.push('other') }])
    ).toThrow('lost');
    expect(ended).toEqual(['failing', 'other']);
    expect(camera.camera!.frustumCulling).toBe(true);
  });

  it("renders the app's own frames", () => {
    const render = vi.spyOn(app, 'render');
    warmUp(app, []);
    expect(render).toHaveBeenCalledTimes(WARM_TIMES.length);
  });
});

describe('showHidden', () => {
  let app: AppBase;

  beforeEach(() => {
    ({ app } = createTestApp());
  });

  afterEach(() => {
    app.destroy();
  });

  /** An entity drawing nothing, in World. */
  function drawn(name: string): Entity {
    const entity = new Entity(name);
    entity.addComponent('render', { type: 'box', layers: [LAYERID_WORLD] });
    return entity;
  }

  it('shows every hidden entity and every render switched off, and puts each back', () => {
    const root = new Entity('root');
    app.root.addChild(root);
    const hidden = drawn('hidden');
    const under = drawn('under');
    const shownUnder = drawn('shown under');
    const off = drawn('off');
    hidden.addChild(under);
    hidden.addChild(shownUnder);
    root.addChild(hidden);
    root.addChild(off);
    hidden.enabled = false;
    under.enabled = false;
    off.render!.enabled = false;
    root.enabled = false;

    const putBack = showHidden(root);
    expect([root, hidden, under, shownUnder, off].map((entity) => entity.enabled)).toEqual([
      true,
      true,
      true,
      true,
      true
    ]);
    expect(off.render!.enabled).toBe(true);

    putBack();
    expect([root.enabled, off.render!.enabled]).toEqual([false, false]);
    // Each as it was of its own: shown again, the hidden parent shows the child it showed.
    root.enabled = true;
    expect([hidden.enabled, off.enabled]).toEqual([false, true]);
    hidden.enabled = true;
    expect([under.enabled, shownUnder.enabled]).toEqual([false, true]);
  });
});

describe('countMade', () => {
  it("counts the shader modules and pipelines a WebGPU device makes, and hands each on", () => {
    const createShaderModule = vi.fn((descriptor: unknown) => ({ module: descriptor }));
    const createRenderPipeline = vi.fn((descriptor: unknown) => ({ pipeline: descriptor }));
    const device = { wgpu: { createShaderModule, createRenderPipeline } };
    const made = countMade(device as unknown as GraphicsDevice)!;
    const gpu = device.wgpu;

    expect(gpu.createShaderModule('vs')).toEqual({ module: 'vs' });
    gpu.createShaderModule('fs');
    expect(gpu.createRenderPipeline('p')).toEqual({ pipeline: 'p' });
    expect(made).toEqual({ shaders: 2, pipelines: 1 });
    expect(createShaderModule).toHaveBeenCalledTimes(2);
  });

  it('counts nothing on a device other than WebGPU', () => {
    const { app } = createTestApp();
    expect(countMade(app.graphicsDevice)).toBeNull();
    app.destroy();
  });
});

/** Whether `waiting` has settled once everything already queued has run. */
async function settled(waiting: Promise<void>): Promise<boolean> {
  let done = false;
  void waiting.then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

describe('splatsSorted', () => {
  let app: AppBase;
  let camera: Entity;

  beforeEach(() => {
    ({ app, camera } = createTestApp());
  });

  afterEach(() => {
    app.destroy();
  });

  const world = { name: 'World' };
  const effects = { name: 'Effects' };
  /** The splat system's word for a camera and a layer, as it gives it each frame. */
  const ready = (drawing: Entity, layer: object, sorted: boolean, loading = 0) =>
    app.systems.gsplat!.fire('frame:ready', drawing.camera, layer, sorted, loading);

  it("waits to the end of a frame that draws the eye's splats sorted", async () => {
    const listening = app.hasEvent('frameend');
    const waiting = splatsSorted(app, camera.camera!);
    ready(camera, world, false);
    app.fire('frameend');
    expect(await settled(waiting)).toBe(false);

    ready(camera, world, true);
    expect(await settled(waiting)).toBe(false);
    app.fire('frameend');
    expect(await settled(waiting)).toBe(true);
    expect(app.systems.gsplat!.hasEvent('frame:ready')).toBe(false);
    expect(app.hasEvent('frameend')).toBe(listening);
  });

  it('waits while any layer of them is unsorted, or a part of them is still loading', async () => {
    const waiting = splatsSorted(app, camera.camera!);
    ready(camera, world, true);
    ready(camera, effects, false);
    app.fire('frameend');
    expect(await settled(waiting)).toBe(false);

    ready(camera, world, true, 1);
    ready(camera, effects, true);
    app.fire('frameend');
    expect(await settled(waiting)).toBe(false);

    ready(camera, world, true);
    ready(camera, effects, true);
    app.fire('frameend');
    expect(await settled(waiting)).toBe(true);
  });

  it('resolves at the end of a frame that draws no splat through the eye', async () => {
    const other = new Entity('other-camera');
    other.addComponent('camera');
    app.root.addChild(other);
    const waiting = splatsSorted(app, camera.camera!);
    ready(other, world, false);
    app.fire('frameend');
    expect(await settled(waiting)).toBe(true);
  });
});

describe('gpuFinished', () => {
  it("waits until a WebGPU device's queue has done its work", async () => {
    let finish!: () => void;
    const onSubmittedWorkDone = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const device = { wgpu: { queue: { onSubmittedWorkDone } } };
    const waiting = gpuFinished(device as unknown as GraphicsDevice);

    expect(await settled(waiting)).toBe(false);
    finish();
    expect(await settled(waiting)).toBe(true);
    expect(onSubmittedWorkDone).toHaveBeenCalledTimes(1);
  });

  it("waits on a WebGL2 device's fence, asked each frame", async () => {
    let finish!: () => void;
    const clientWaitAsync = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const device = { deviceType: 'webgl2', clientWaitAsync };
    const waiting = gpuFinished(device as unknown as GraphicsDevice);

    expect(await settled(waiting)).toBe(false);
    finish();
    expect(await settled(waiting)).toBe(true);
    expect(clientWaitAsync).toHaveBeenCalledWith(0, 16);
  });

  it('resolves at once on a device with no queue', async () => {
    const { app } = createTestApp();
    expect(await settled(gpuFinished(app.graphicsDevice))).toBe(true);
    app.destroy();
  });
});
