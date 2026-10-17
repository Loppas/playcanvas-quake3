import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Md3Model } from '../formats/md3';
import { ShellCache, type Shell, type ShellBuilder } from './shell-cache';

/** A shell with nothing in it but the switch the cache turns. */
function fakeShell(): Shell {
  return { model: { entity: { enabled: false } }, stages: [] } as unknown as Shell;
}

const MODEL = {} as Md3Model;

describe('ShellCache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a shell once, on first asking, and shows it from the frame it lands', async () => {
    const shell = fakeShell();
    const build = vi.fn(async () => shell);
    const cache = new ShellCache('test', build);

    // Asked twice while it builds: one build, and nothing to draw yet.
    expect(cache.show('powerups/quad', 'legs', MODEL)).toBeNull();
    expect(cache.show('powerups/quad', 'legs', MODEL)).toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith('powerups/quad/legs', 'powerups/quad', MODEL, 'legs');

    await cache.settled();
    expect(cache.show('powerups/quad', 'legs', MODEL)).toBe(shell);
    expect(shell.model.entity.enabled).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('keeps each shader and piece apart', async () => {
    const build = vi.fn<ShellBuilder>(async () => fakeShell());
    const cache = new ShellCache('test', build);
    cache.show('powerups/quad', 'legs', MODEL);
    cache.show('powerups/quad', 'torso', MODEL);
    cache.show('powerups/regen', 'legs', MODEL);
    await cache.settled();
    expect(build.mock.calls.map(([key]) => key)).toEqual([
      'powerups/quad/legs',
      'powerups/quad/torso',
      'powerups/regen/legs'
    ]);
  });

  it('hides each shell not shown since it last hid, and never takes a worn one out', async () => {
    /** Each shell's switch, as it is turned. */
    const turned: boolean[][] = [];
    const build = vi.fn(async () => {
      const turns: boolean[] = [];
      turned.push(turns);
      let enabled = false;
      const entity = {
        get enabled() {
          return enabled;
        },
        set enabled(value: boolean) {
          enabled = value;
          turns.push(value);
        }
      };
      return { model: { entity }, stages: [] } as unknown as Shell;
    });
    const cache = new ShellCache('test', build);
    cache.show('a', 'gun', MODEL);
    cache.show('a', 'barrel', MODEL);
    await cache.settled();

    // Two frames wearing both, then one wearing the gun's alone, then one wearing neither.
    const frame = (pieces: string[]) => {
      for (const piece of pieces) cache.show('a', piece, MODEL);
      cache.hideUnshown();
    };
    frame(['gun', 'barrel']);
    frame(['gun', 'barrel']);
    frame(['gun']);
    const [gun, barrel] = cache.built();
    expect([gun.model.entity.enabled, barrel.model.entity.enabled]).toEqual([true, false]);
    frame([]);
    expect([gun.model.entity.enabled, barrel.model.entity.enabled]).toEqual([false, false]);
    expect(turned).toEqual([
      [true, true, true, false],
      [true, true, false, false]
    ]);
  });

  it('hides every shell at once, worn this frame or not, for an owner drawn no more', async () => {
    const cache = new ShellCache('test', async () => fakeShell());
    cache.show('a', 'gun', MODEL);
    cache.show('a', 'barrel', MODEL);
    await cache.settled();
    cache.show('a', 'gun', MODEL);
    cache.show('a', 'barrel', MODEL);
    cache.hideUnshown();

    // Put away mid-frame, after the gun's shell was shown again.
    cache.show('a', 'gun', MODEL);
    cache.hide();
    expect(cache.built().map((shell) => shell.model.entity.enabled)).toEqual([false, false]);
  });

  it('builds shells ahead of use, hidden, once each, and lists what it has built', async () => {
    const build = vi.fn<ShellBuilder>(async () => fakeShell());
    const cache = new ShellCache('test', build);
    cache.show('a', 'gun', MODEL);
    await cache.prepare(['a', 'b'], 'gun', MODEL);
    expect(build.mock.calls.map(([key]) => key)).toEqual(['a/gun', 'b/gun']);
    const built = cache.built();
    expect(built).toHaveLength(2);
    expect(built.map((shell) => shell.model.entity.enabled)).toEqual([false, false]);

    await cache.prepare(['a', 'b'], 'gun', MODEL);
    expect(build).toHaveBeenCalledTimes(2);
    expect(cache.show('b', 'gun', MODEL)).toBe(built[1]);
  });

  it('warns once for a shell that cannot be built, naming its owner, and never draws it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const build = vi.fn(async (): Promise<Shell> => {
      throw new Error('no texture');
    });
    const cache = new ShellCache('viewmodel', build);
    cache.show('powerups/quadWeapon', 'gun', MODEL);
    await cache.settled();

    expect(cache.show('powerups/quadWeapon', 'gun', MODEL)).toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('viewmodel: no powerups/quadWeapon shell for gun');
  });
});
