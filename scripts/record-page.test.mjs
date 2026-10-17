// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPageRecorder } from './record-lib.mjs';

/**
 * The page side of the recorder — the mark key and the status badge.
 *
 * Worth covering because this is the one link a smoke recording cannot prove for itself: the
 * badge showing up in captured frames proves the overlay installs, and the terminal `m` path
 * proves the callback round-trips, but nothing in a headless run presses F8.
 */

/** Dispatch a keydown the way a real key does — capture-phase listeners see it either way. */
const press = (code, init = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { code, cancelable: true, ...init }));

describe('installPageRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom hands the whole file one window, so a previous test's listener would still be on
    // it. The teardown the recorder installs for its own idempotence is what isolates them.
    window.__pcqRecorderTeardown?.();
    document.body.innerHTML = '';
    delete window.__pcqRecorderMark;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the exposed binding when the mark key is pressed', () => {
    const mark = vi.fn();
    window.__pcqRecorderMark = mark;
    installPageRecorder({ markKey: 'F8' });

    press('F8');
    press('F8');
    expect(mark).toHaveBeenCalledTimes(2);
  });

  it('ignores every other key', () => {
    const mark = vi.fn();
    window.__pcqRecorderMark = mark;
    installPageRecorder({ markKey: 'F8' });

    press('KeyW');
    press('Digit1');
    press('F9');
    expect(mark).not.toHaveBeenCalled();
  });

  it('swallows the mark key so it never reaches the game', () => {
    installPageRecorder({ markKey: 'F8' });

    const event = new KeyboardEvent('keydown', { code: 'F8', cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores auto-repeat, so holding the key is still one mark', () => {
    const mark = vi.fn();
    window.__pcqRecorderMark = mark;
    installPageRecorder({ markKey: 'F8' });

    press('F8');
    press('F8', { repeat: true });
    press('F8', { repeat: true });
    expect(mark).toHaveBeenCalledTimes(1);
  });

  // The binding is installed before navigation, but a key pressed during a reload could still
  // land before it exists; the page must not throw in that window.
  it('does not throw when the binding is not there yet', () => {
    installPageRecorder({ markKey: 'F8' });
    expect(() => press('F8')).not.toThrow();
  });

  it('honours a different mark key', () => {
    const mark = vi.fn();
    window.__pcqRecorderMark = mark;
    installPageRecorder({ markKey: 'Backquote' });

    press('F8');
    expect(mark).not.toHaveBeenCalled();
    press('Backquote');
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it('shows elapsed time and how to start a segment', () => {
    installPageRecorder({ markKey: 'F8' });
    vi.advanceTimersByTime(100);

    const badge = document.body.lastElementChild;
    expect(badge.textContent).toMatch(/● REC \d+\.\ds · F8 to start a segment/);
    // The badge must never intercept a click meant for the canvas.
    expect(badge.style.pointerEvents).toBe('none');
  });

  // The red border is the affordance that makes bracketing usable: it has to persist for the
  // whole open segment, not blink once, or you cannot tell which state you are in.
  it('holds a red border for as long as a segment is open', () => {
    installPageRecorder({ markKey: 'F8' });
    const badge = document.body.lastElementChild;

    press('F8');
    vi.advanceTimersByTime(100);
    expect(badge.textContent).toMatch(/⏺ segment 1 · \d+\.\ds · F8 to end$/);
    expect(badge.style.borderColor).toBe('rgb(255, 90, 90)');

    // Well past the 400 ms flash — still open, so still red.
    vi.advanceTimersByTime(2000);
    expect(badge.style.borderColor).toBe('rgb(255, 90, 90)');

    press('F8');
    vi.advanceTimersByTime(500);
    expect(badge.textContent).toMatch(/F8 to start a segment · 1 kept$/);
    expect(badge.style.borderColor).toBe('transparent');
  });

  it('toggles from the terminal path too', () => {
    installPageRecorder({ markKey: 'F8' });
    const badge = document.body.lastElementChild;

    // What `m` + Enter calls, via page.evaluate.
    window.__pcqRecorderNoteMark();
    vi.advanceTimersByTime(100);
    expect(badge.textContent).toMatch(/⏺ segment 1/);

    window.__pcqRecorderNoteMark();
    vi.advanceTimersByTime(500);
    expect(badge.textContent).toMatch(/1 kept$/);
  });

  it('counts a second segment separately', () => {
    installPageRecorder({ markKey: 'F8' });
    for (const _ of [0, 1, 2]) press('F8');
    vi.advanceTimersByTime(100);
    expect(document.body.lastElementChild.textContent).toMatch(/⏺ segment 2/);
  });

  it('installs the badge once the document body exists', () => {
    installPageRecorder({ markKey: 'F8' });
    expect(document.body.children).toHaveLength(1);
  });

  // Playwright applies an init script per navigation; a re-injection must not stack a second
  // listener, or one keypress would silently count as two marks.
  it('replaces a previous installation instead of stacking on it', () => {
    const mark = vi.fn();
    window.__pcqRecorderMark = mark;

    installPageRecorder({ markKey: 'F8' });
    installPageRecorder({ markKey: 'F8' });

    press('F8');
    vi.advanceTimersByTime(100);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(document.body.children).toHaveLength(1);
    // A stacked listener would toggle twice — opening and instantly closing segment 1, which
    // is worse than a miscount: the segment would be empty.
    expect(document.body.lastElementChild.textContent).toMatch(/⏺ segment 1/);
  });
});
