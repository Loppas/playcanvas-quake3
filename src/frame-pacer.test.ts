import { describe, expect, it } from 'vitest';

import {
  FramePacer,
  frameCap,
  paceFrames,
  unpacedWake,
  vsyncInForce,
  vsyncWaits,
  type PaceSettings,
  type TickingApp
} from './frame-pacer';

const SETTINGS: PaceSettings = { maxFps: 125, maxFpsUnfocused: 0, swapInterval: false };

/** The frames a pacer lets through, of looks at these whole milliseconds, under one cap. */
function frames(pacer: FramePacer, looks: Iterable<number>, cap: number | null): number[] {
  const begun: number[] = [];
  for (const now of looks) if (pacer.ready(now, cap)) begun.push(now);
  return begun;
}

/** Looks every millisecond, from `from` up to and including `to`. */
function* everyMs(from: number, to: number): Generator<number> {
  for (let now = from; now <= to; now++) yield now;
}

/** A display's refreshes at `hz` for `seconds`, each in the whole milliseconds a look sees. */
function* refreshes(hz: number, seconds: number, from = 1000): Generator<number> {
  for (let n = 0; n < hz * seconds; n++) yield Math.floor(from + (n * 1000) / hz);
}

describe('frameCap', () => {
  it("is Com_Frame's minMsec, by C's integer division", () => {
    const cap = (maxFps: number) => frameCap({ ...SETTINGS, maxFps }, true, false);
    expect([125, 333, 85, 60, 1000].map(cap)).toEqual([8, 3, 11, 16, 1]);
    // 0 or less is a floor of 1, where past 1000 is none.
    expect([0, -1, 1001].map(cap)).toEqual([1, 1, 0]);
  });

  it('is lifted while vertical sync is in force', () => {
    expect(frameCap(SETTINGS, true, true)).toBeNull();
  });

  it('takes com_maxfpsUnfocused while the window has lost its focus, vertical sync or not', () => {
    const settings = { ...SETTINGS, maxFpsUnfocused: 30 };
    expect(frameCap(settings, false, false)).toBe(33);
    expect(frameCap(settings, false, true)).toBe(33);
    expect(frameCap(settings, true, false)).toBe(8);
    // At 0 it is no cap of its own, and the window's focus changes nothing.
    expect(frameCap(SETTINGS, false, false)).toBe(8);
    expect(frameCap(SETTINGS, false, true)).toBeNull();
  });
});

describe('vertical sync', () => {
  it("is the setting's in a browser, whose display paces every frame", () => {
    expect(vsyncInForce(true, undefined)).toBe(true);
    expect(vsyncInForce(false, undefined)).toBe(false);
    expect(vsyncWaits(false, undefined)).toBe(false);
  });

  it('is in force in the shell only if its launch took it up; a change waits for the next', () => {
    expect(vsyncInForce(true, true)).toBe(true);
    // Launched unpaced, the cap holds until the shell starts again.
    expect(vsyncInForce(true, false)).toBe(false);
    expect(vsyncWaits(true, false)).toBe(true);
    // Turned off, the cap holds at once, below the display's rate until the next launch.
    expect(vsyncInForce(false, true)).toBe(false);
    expect(vsyncWaits(false, true)).toBe(true);
    expect(vsyncWaits(false, false)).toBe(false);
  });
});

describe('FramePacer', () => {
  it("starts from Com_Frame's statics: two frames at once, then one every 8 ms", () => {
    // The first wait is 16 against a frame time of 0; the next pays back the whole cap.
    const begun = frames(new FramePacer(), everyMs(100, 140), 8);
    expect(begun).toEqual([100, 101, 108, 116, 124, 132, 140]);
  });

  it('pays an overrun back from the next frame', () => {
    const pacer = new FramePacer();
    frames(pacer, everyMs(100, 124), 8);
    // The frame begun at 124 runs to 135, 3 ms past its due.
    expect(frames(pacer, everyMs(135, 156), 8)).toEqual([135, 140, 148, 156]);
  });

  it('pays back no more than one cap, however long a frame stalls', () => {
    const pacer = new FramePacer();
    frames(pacer, everyMs(100, 124), 8);
    expect(frames(pacer, everyMs(224, 248), 8)).toEqual([224, 225, 232, 240, 248]);
  });

  it('keeps the wait it worked out at the first look, as Com_Frame does before it sleeps', () => {
    const pacer = new FramePacer();
    frames(pacer, everyMs(100, 124), 8);
    expect(pacer.ready(125, 8)).toBe(false);
    // The window loses its focus: the next wait is 33's, from the frame after, and the 25 the
    // frame before fell short of it by is waited out too.
    expect(frames(pacer, everyMs(126, 132), 33)).toEqual([132]);
    expect(frames(pacer, everyMs(133, 190), 33)).toEqual([190]);
  });

  it('lets every look through with no cap in force', () => {
    expect(frames(new FramePacer(), [100, 101, 101, 103], null)).toEqual([100, 101, 101, 103]);
  });

  it('forgets the overrun while no cap is in force', () => {
    const pacer = new FramePacer();
    frames(pacer, everyMs(100, 124), 8);
    // 3 ms late, so 3 is owed from the next frame on.
    expect(frames(pacer, everyMs(135, 136), 8)).toEqual([135]);
    // Vertical sync comes on for a frame, and goes off again: the next waits its full 8, and the
    // 6 the frame between fell short by.
    expect(pacer.ready(137, null)).toBe(true);
    expect(frames(pacer, everyMs(138, 151), 8)).toEqual([151]);
  });

  /** How many refreshes of a `hz` display apart each frame after the first ten is. */
  const apart = (begun: number[], hz: number) => {
    const settled = begun.slice(10);
    const counts = settled.slice(1).map((now, n) => Math.round(((now - settled[n]) * hz) / 1000));
    return [...new Set(counts)].sort();
  };

  it("thins a 240 Hz display's frames to 125 a second, a refresh or two apart", () => {
    const begun = frames(new FramePacer(), refreshes(240, 3), 8);
    // Two refreshes are 8.33 ms, so the overrun builds until a frame comes a refresh after.
    expect(apart(begun, 240)).toEqual([1, 2]);
    const second = begun.filter((now) => now >= 2000 && now < 3000).length;
    expect(Math.abs(second - 125)).toBeLessThanOrEqual(1);
  });

  it("thins a 144 Hz display's to 62.5 a second under 60's 16 ms, 2 or 3 refreshes apart", () => {
    const begun = frames(new FramePacer(), refreshes(144, 3), 16);
    expect(apart(begun, 144)).toEqual([2, 3]);
    const twoSeconds = begun.filter((now) => now >= 2000 && now < 4000).length;
    expect(Math.abs(twoSeconds - 125)).toBeLessThanOrEqual(1);
  });

  it('adds no frame to a display slower than the cap: 60 Hz under 125 is every refresh', () => {
    const looks = [...refreshes(60, 1)];
    expect(frames(new FramePacer(), looks, 8)).toEqual(looks);
  });
});

describe('paceFrames', () => {
  /** A display whose frames come when the test says, and an app that asks for each next one. */
  function setup(cap: () => number | null) {
    const queue: FrameRequestCallback[] = [];
    let requests = 0;
    const ticks: number[] = [];
    const app: TickingApp = {
      frameRequestId: undefined,
      // PlayCanvas's tick asks for its next frame first thing.
      tick: (timestamp) => {
        ticks.push(timestamp!);
        app.requestAnimationFrame();
      },
      requestAnimationFrame: () => {
        throw new Error('the browser asked directly');
      }
    };
    let woken = 0;
    paceFrames(app, cap, {
      raf: (callback) => {
        queue.push(callback);
        return ++requests;
      },
      wake: () => woken++
    });
    const refresh = (timestamp: number) => {
      for (const callback of queue.splice(0)) callback(timestamp);
    };
    const pending = () => queue.length;
    return { app, ticks, refresh, woken: () => woken, requests: () => requests, pending };
  }

  it('ticks the app at the frames the cap lets through, and asks again at those it holds', () => {
    const { app, ticks, refresh, requests, pending } = setup(() => 8);
    app.requestAnimationFrame();
    for (const timestamp of [100.25, 101.5, 104.2, 108.9, 112.1]) refresh(timestamp);
    // Handed the display's own timestamp, which the app's frame time is taken from.
    expect(ticks).toEqual([100.25, 101.5, 108.9]);
    // One request outstanding at every step, and always the app's own to cancel.
    expect(pending()).toBe(1);
    expect(app.frameRequestId).toBe(requests());
    expect(requests()).toBe(6);
  });

  it('counts the frames in whole milliseconds, as Sys_Milliseconds does', () => {
    const { app, ticks, refresh } = setup(() => 8);
    app.requestAnimationFrame();
    for (const timestamp of [100.9, 101.9, 108.2, 109.1]) refresh(timestamp);
    // The third frame's wait is 7, which 108.2 is in whole milliseconds after 101.9, though 6.3
    // have passed.
    expect(ticks).toEqual([100.9, 101.9, 108.2]);
  });

  it('wakes an unpaced display at each frame it holds back, and at none it lets through', () => {
    const { app, ticks, refresh, woken } = setup(() => 8);
    app.requestAnimationFrame();
    for (const timestamp of [100.5, 101.5, 102.5, 107.2, 108.4]) refresh(timestamp);
    expect([ticks, woken()]).toEqual([[100.5, 101.5, 108.4], 2]);
  });

  it('reads the cap at each look, so vertical sync turned on lets the next frame through', () => {
    let cap: number | null = 100;
    const { app, ticks, refresh } = setup(() => cap);
    app.requestAnimationFrame();
    refresh(1000);
    refresh(1001);
    refresh(1010);
    cap = null;
    refresh(1011);
    expect(ticks).toEqual([1000, 1001, 1011]);
  });
});

describe('unpacedWake', () => {
  /** A document holding one body, and what is put in it. */
  function page() {
    const added: { style: { cssText?: string; transform?: string } }[] = [];
    const doc = {
      createElement: () => ({ style: {} }),
      body: { appendChild: (node: (typeof added)[number]) => added.push(node) }
    } as unknown as Document;
    return { doc, added };
  }

  it('moves one pixel, out of the way of the pointer, each time the other way', () => {
    const { doc, added } = page();
    const wake = unpacedWake(doc);
    expect(added).toEqual([]);
    wake();
    expect(added).toHaveLength(1);
    const [dot] = added;
    expect(dot.style.cssText).toContain('position:fixed');
    expect(dot.style.cssText).toContain('pointer-events:none');
    expect(dot.style.transform).toBe('translateX(1px)');
    wake();
    expect(dot.style.transform).toBe('none');
    wake();
    expect([added.length, dot.style.transform]).toEqual([1, 'translateX(1px)']);
  });
});
