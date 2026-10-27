import { describe, expect, it, vi } from 'vitest';

import { Cvars } from './cvars';
import { GameConfig } from './game-config';
import { restartAddress, vidRestart } from './vid-restart';

/** `vid_restart`: the address the page reloads at, and that it saves first. */

describe('restartAddress', () => {
  it("carries a change to a setting the address set, and leaves the rest of the address alone", () => {
    const cvars = new Cvars();
    cvars.applyUrl('?cl_renderer=opengl2&debug=1&CG_FOV=100');
    cvars.set('cl_renderer', 'opengl1');
    expect(restartAddress('http://localhost:5173/?cl_renderer=opengl2&debug=1&CG_FOV=100#top', cvars)).toBe(
      'http://localhost:5173/?cl_renderer=opengl1&debug=1&CG_FOV=100#top'
    );
  });

  it('adds nothing for a setting only the file has', () => {
    const cvars = new Cvars();
    cvars.set('cl_renderer', 'opengl2');
    expect(restartAddress('http://localhost:5173/', cvars)).toBe('http://localhost:5173/');
  });
});

describe('vidRestart', () => {
  it('waits for the file to be written, then reloads at the address', async () => {
    const config = new GameConfig({ search: '?cl_renderer=opengl2', print: () => {} });
    config.command(['cl_renderer', 'opengl1']);
    const order: string[] = [];
    let save = () => {};
    const keeper = {
      stop: () => {},
      settled: () =>
        new Promise<void>((resolve) => {
          save = () => {
            order.push('saved');
            resolve();
          };
        })
    };
    const location = {
      href: 'http://localhost:5173/?cl_renderer=opengl2',
      reload: vi.fn(() => order.push('reloaded'))
    } as unknown as Location;
    const history = {
      state: null,
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => order.push(url))
    } as unknown as History;

    const restarted = vidRestart(config, keeper, location, history);
    await Promise.resolve();
    expect(order).toEqual([]);
    save();
    await restarted;
    expect(order).toEqual(['saved', 'http://localhost:5173/?cl_renderer=opengl1', 'reloaded']);
  });
});
