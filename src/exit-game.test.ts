// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { EXIT_WAIT_MS, exitGame } from './exit-game';

/**
 * EXIT GAME's way out: the game quit, then the window closed, or, where the browser keeps the tab,
 * the game stopped.
 */

/** Exit on a root of its own, with the wait held until the test runs it. */
function exiting(stop: () => void, quit: () => void = vi.fn()) {
  const root = document.createElement('div');
  const close = vi.fn();
  const waits: { then: () => void; ms: number }[] = [];
  exitGame(root, quit, stop, { close, later: (then, ms) => waits.push({ then, ms }) });
  return { root, close, waits };
}

describe('exitGame', () => {
  it('closes the window, and where it stays open, stops the game and says so', () => {
    const stop = vi.fn();
    const { root, close, waits } = exiting(stop);
    expect(close).toHaveBeenCalledOnce();
    expect([stop.mock.calls.length, root.querySelector('.end-screen')]).toEqual([0, null]);

    expect(waits.map((wait) => wait.ms)).toEqual([EXIT_WAIT_MS]);
    waits[0].then();
    expect(stop).toHaveBeenCalledOnce();
    expect(root.querySelector('.end-screen')?.textContent).toContain('You can close this tab.');
  });

  it('quits the game first, as Com_Quit_f shuts it down before the program goes', () => {
    const quit = vi.fn();
    const stop = vi.fn();
    const { close, waits } = exiting(stop, quit);
    expect(quit).toHaveBeenCalledOnce();
    expect(quit.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    waits[0].then();
    expect(quit).toHaveBeenCalledOnce();
    expect(quit.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]);
  });

  it('says so even when the game will not stop cleanly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, waits } = exiting(() => {
      throw new Error('already gone');
    });
    waits[0].then();
    expect(root.querySelector('.end-screen')).not.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('closes the window and stops even when the game will not quit cleanly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = vi.fn();
    const { root, close, waits } = exiting(stop, () => {
      throw new Error('already gone');
    });
    expect(close).toHaveBeenCalledOnce();
    waits[0].then();
    expect(stop).toHaveBeenCalledOnce();
    expect(root.querySelector('.end-screen')).not.toBeNull();
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'The game did not quit cleanly:'
    ]);
    warn.mockRestore();
  });
});
