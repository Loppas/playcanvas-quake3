import type { Settings } from './settings/registry';

/**
 * The frame's pace, as `Com_Frame` sets it (`common.c:3117–3165`): each frame begins at least
 * `1000 / com_maxfps` whole milliseconds after the last, less what the frames before it overran
 * by, and `com_maxfpsUnfocused` stands in while the window has lost its focus. A browser hands out
 * frames at the display's refreshes, so a frame the cap holds back is a refresh the game skips:
 * the cap thins the display's frames, and can only rise above its rate where Chromium was started
 * unpaced. Vertical sync in force lifts the cap, and every refresh is a frame. Engine-free: the
 * app is reached through the method PlayCanvas asks for its next frame by.
 */

/** The settings the cap is read from. */
export type PaceSettings = Pick<Settings, 'maxFps' | 'maxFpsUnfocused' | 'swapInterval'>;

/**
 * Whether vertical sync is in force: on, and, in the shell, on as Chromium was started, which it
 * takes up only then.
 *
 * @param launchVsync - The shell's launch's vertical sync; `undefined` in a browser, whose
 *   display paces every frame.
 */
export function vsyncInForce(swapInterval: boolean, launchVsync: boolean | undefined): boolean {
  return swapInterval && launchVsync !== false;
}

/** Whether a change of vertical sync waits for the shell's next launch. */
export function vsyncWaits(swapInterval: boolean, launchVsync: boolean | undefined): boolean {
  return launchVsync !== undefined && swapInterval !== launchVsync;
}

/**
 * `Com_Frame`'s `minMsec` before the overrun is paid back (`common.c:3124–3131`): by C's integer
 * division, so 333 is 3 and 85 is 11, and 0 or less a floor of 1, where above 1000 is none. `null`
 * where no cap is in force.
 *
 * @param focused - Whether the window has the focus, which `com_unfocused` says it has not.
 * @param vsync - Whether vertical sync is in force ({@link vsyncInForce}).
 */
export function frameCap(settings: PaceSettings, focused: boolean, vsync: boolean): number | null {
  if (!focused && settings.maxFpsUnfocused > 0) return Math.trunc(1000 / settings.maxFpsUnfocused);
  if (vsync) return null;
  return settings.maxFps > 0 ? Math.trunc(1000 / settings.maxFps) : 1;
}

/** `Com_Frame`'s statics, and the wait it works out for the frame to come. */
export class FramePacer {
  /** `lastTime`: when the frame before the last began. */
  private lastTime = 0;
  /** `com_frameTime`: when the last began. */
  private frameTime = 0;
  /** `bias`: what the frames have overrun the cap by, paid back from the next. */
  private bias = 0;
  /** How long after the last frame the next may begin, once worked out for it. */
  private wait: number | null = null;

  /**
   * Whether a frame begins at `now`, in whole milliseconds. The wait is worked out at the first
   * look after a frame, as `Com_Frame` works it out before it sleeps, and a frame that begins is
   * counted from `now`.
   *
   * @param cap - {@link frameCap}'s, read at each look; `null` lets every frame through.
   */
  ready(now: number, cap: number | null): boolean {
    if (cap === null) {
      // Nothing is owed across frames no cap held.
      this.bias = 0;
    } else {
      if (this.wait === null) {
        this.bias += this.frameTime - this.lastTime - cap;
        if (this.bias > cap) this.bias = cap;
        this.wait = cap - this.bias;
      }
      // `Com_TimeVal`.
      if (now - this.frameTime < this.wait) return false;
    }
    this.lastTime = this.frameTime;
    this.frameTime = now;
    this.wait = null;
    return true;
  }
}

/** What of PlayCanvas's app the pacer reaches: its tick, and how it asks for its next frame. */
export interface TickingApp {
  tick: (timestamp?: number) => void;
  /** The request outstanding, which the app cancels as it ticks and as it is destroyed. */
  frameRequestId: unknown;
  requestAnimationFrame(): void;
}

/** What {@link paceFrames} is paced with besides the cap. */
export interface PaceOptions {
  pacer?: FramePacer;
  /**
   * The browser's `requestAnimationFrame`, by default looked up as it is called, so a harness's own
   * stands in for it.
   */
  raf?: (callback: FrameRequestCallback) => number;
  /**
   * For a display that is not paced: called at each look the cap holds back, so the display hands
   * out the next at once ({@link unpacedWake}). A paced display hands one out at every refresh.
   */
  wake?: () => void;
}

/**
 * Pace the app's frames. The app asks for its next frame through its `requestAnimationFrame`,
 * which the pacer takes the place of: it looks at each of the display's frames, ticks the app at
 * the first the cap lets through, and asks again at each it holds back. The request outstanding is
 * always the app's `frameRequestId`, so the app's own cancel still reaches it.
 *
 * @param cap - The cap in force ({@link frameCap}), read at each look.
 */
export function paceFrames(
  app: TickingApp,
  cap: () => number | null,
  options: PaceOptions = {}
): void {
  const { pacer = new FramePacer(), wake } = options;
  const raf =
    options.raf ?? ((callback: FrameRequestCallback) => window.requestAnimationFrame(callback));
  const ask = () => {
    app.frameRequestId = raf(look);
  };
  const look = (timestamp: number) => {
    // Whole milliseconds, as `Sys_Milliseconds` counts them.
    if (pacer.ready(Math.floor(timestamp), cap())) {
      app.tick(timestamp);
      return;
    }
    ask();
    wake?.();
  };
  app.requestAnimationFrame = ask;
}

/**
 * Keeps a display that is not paced handing out frames, as the shell's Chromium is when started
 * without vertical sync. It hands out the next frame at once only after a frame that drew
 * something; after one that drew nothing it waits its idle pace, about 18 ms, and no cap past some
 * 55 frames a second would be reached. Each look the cap holds back moves a pixel, so the wait
 * spins on frames, as `com_busyWait 1` spins `Com_Frame`'s. A pixel moved from a timer brings the
 * next frame no sooner.
 */
export function unpacedWake(doc: Document = document): () => void {
  let dot: HTMLElement | undefined;
  let moved = false;
  return () => {
    if (!dot) {
      dot = doc.createElement('div');
      dot.style.cssText = [
        'position:fixed;left:0;top:0;width:1px;height:1px',
        'opacity:0.01;pointer-events:none;will-change:transform'
      ].join(';');
      doc.body.appendChild(dot);
    }
    moved = !moved;
    dot.style.transform = moved ? 'translateX(1px)' : 'none';
  };
}
