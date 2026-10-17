// @vitest-environment jsdom
import { StandardMaterial, type AppBase } from 'playcanvas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assembledShaders, createTestApp } from './engine-test-fixtures';
import { firstInstanceReached, guardMeshInstanceStorage } from './mesh-instance-storage';

/** The device's switches as PlayCanvas's WebGPU device has them, with a stand-in browser device. */
interface Storing {
  wgpu: unknown;
  supportsMeshInstanceStorage: boolean;
  meshInstanceStorage: { destroy(): void } | null;
}

describe('the probe', () => {
  it('passes a device whose helper saw each draw its own firstInstance', () => {
    expect(firstInstanceReached([0, 255])).toBe(true);
  });

  it('fails one whose helper saw 0 for both, or that drew neither', () => {
    expect(firstInstanceReached([0, 0])).toBe(false);
    expect(firstInstanceReached([255, 255])).toBe(false);
  });
});

describe('guardMeshInstanceStorage', () => {
  let app: AppBase | null = null;

  /** A WebGPU device's switches, the storage on, as the engine leaves them. */
  function storing(): { device: AppBase['graphicsDevice']; switches: Storing } {
    app = createTestApp().app;
    const switches = app.graphicsDevice as unknown as Storing;
    switches.wgpu = {};
    switches.supportsMeshInstanceStorage = true;
    switches.meshInstanceStorage = { destroy: vi.fn() };
    return { device: app.graphicsDevice, switches };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    app?.destroy();
    app = null;
  });

  it('turns the storage off where the probe fails, and gives its buffer back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { device, switches } = storing();
    const storage = switches.meshInstanceStorage!;
    await expect(guardMeshInstanceStorage(device, async () => [0, 0])).resolves.toBe(true);
    expect(switches.supportsMeshInstanceStorage).toBe(false);
    expect(switches.meshInstanceStorage).toBeNull();
    expect(storage.destroy).toHaveBeenCalledOnce();
  });

  it('leaves it on where the probe passes', async () => {
    const { device, switches } = storing();
    await expect(guardMeshInstanceStorage(device, async () => [0, 255])).resolves.toBe(false);
    expect(switches.supportsMeshInstanceStorage).toBe(true);
    expect(switches.meshInstanceStorage).not.toBeNull();
  });

  it('turns it off where the probe cannot run, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { device, switches } = storing();
    const failing = async (): Promise<[number, number]> => {
      throw new Error('device lost');
    };
    await expect(guardMeshInstanceStorage(device, failing)).resolves.toBe(true);
    expect(switches.supportsMeshInstanceStorage).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('probes nothing on a device without the storage, as WebGL2 is', async () => {
    const { device, switches } = storing();
    switches.wgpu = null;
    const probe = vi.fn(async (): Promise<[number, number]> => [0, 0]);
    await expect(guardMeshInstanceStorage(device, probe)).resolves.toBe(false);
    switches.wgpu = {};
    switches.supportsMeshInstanceStorage = false;
    await expect(guardMeshInstanceStorage(device, probe)).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("puts every material's draws back on uniforms of their own, in the WGSL", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    storing();
    expect(assembledShaders(app!, new StandardMaterial(), 'wgsl').vertex).toContain(
      'meshInstanceStorage'
    );
    app!.destroy();

    const { device } = storing();
    await guardMeshInstanceStorage(device, async () => [0, 0]);
    expect(assembledShaders(app!, new StandardMaterial(), 'wgsl').vertex).not.toContain(
      'meshInstanceStorage'
    );
  });
});
