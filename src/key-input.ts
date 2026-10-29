import { K } from './formats/q3-keys';
import { keyForButton, keyForCode, keyForWheel } from './settings/browser-keys';
import { KEYCATCH, type ClientInput } from './settings/client-input';

/** The Keyboard API's layout map, which TypeScript's DOM types don't carry yet. */
interface LayoutNavigator {
  keyboard?: { getLayoutMap?(): Promise<ReadonlyMap<string, string>> };
}

/**
 * How soon after the mouse is let go an Escape is taken for the one that let it go. A browser that
 * hands the page that key as well as releasing the mouse would otherwise close the menu it opened.
 */
const UNLOCK_ESCAPE_MS = 100;

/**
 * The control character SDL types after a key (`sdl_input.c:1050–1053`): ^H for Backspace, and
 * for a letter with Ctrl held, its own. None for any other key.
 */
function controlChar(key: number, ctrl: boolean): string {
  if (key === K.BACKSPACE) return '\b';
  return ctrl && key >= 0x61 && key <= 0x7a ? String.fromCharCode(key - 0x60) : '';
}

/**
 * The browser's keys, buttons and mouse, handed to {@link ClientInput} as Q3's, which sends each
 * where the key catchers say.
 *
 * - A click on the canvas with nothing up captures the mouse, asking for raw input, free of the
 *   OS's acceleration, where the browser gives it. That click only captures; it doesn't fire.
 * - Escape with the mouse free is Q3's Escape. With it captured, Escape is the browser's, which lets
 *   it go, and the capture lost with nothing up opens the menu.
 * - A held key repeats only with a catcher up, as SDL hands its repeats on
 *   (`sdl_input.c:1044–1045`).
 * - Losing the capture, or the window's focus, lets every key go.
 * - A key taken has its browser default stopped: in some browsers `/` finds text on the page, and
 *   Tab moves the focus.
 * - With a catcher up, the browser's paste is the catcher's: Ctrl+V and Shift+Ins paste as Q3's
 *   do, the clipboard read from the paste itself, which asks no permission. Shift+Ins is left to
 *   the browser so that it pastes, rather than reaching the catcher as Insert.
 * - Backspace, and a letter with Ctrl, type SDL's control characters, which Q3's fields edit by.
 */
export class KeyInput {
  private readonly canvas: HTMLCanvasElement;
  private readonly input: ClientInput;
  private readonly lost: () => void;
  private readonly apple: boolean;
  private readonly detach: () => void;
  private layout: ReadonlyMap<string, string> | undefined;
  private locked = false;
  private match: boolean;
  /** When the mouse was last let go, on `performance.now()`'s clock. */
  private unlockedAt = Number.NEGATIVE_INFINITY;

  /**
   * @param canvas - The canvas that captures the mouse.
   * @param input - Where Q3's keys go.
   * @param lost - What the capture lost with nothing up opens: the in-game menu.
   * @param playing - Whether a match is there already, as {@link playing} says.
   */
  constructor(canvas: HTMLCanvasElement, input: ClientInput, lost?: () => void, playing = true) {
    this.canvas = canvas;
    this.input = input;
    this.lost = lost ?? (() => {});
    this.match = playing;
    this.apple = /Mac|iPhone|iPad/.test(navigator.platform);
    (navigator as Navigator & LayoutNavigator).keyboard
      ?.getLayoutMap?.()
      .then((layout) => (this.layout = layout))
      .catch(() => {});

    const onKeyDown = (event: KeyboardEvent) => {
      const key = keyForCode(event.code, this.layout, this.apple);
      if (key === null) return;
      const catchers = this.input.catchers;
      if (event.repeat && catchers === 0) return;
      if (key === K.ESCAPE) {
        const unlocking = performance.now() - this.unlockedAt < UNLOCK_ESCAPE_MS;
        if (this.locked || (catchers & KEYCATCH.UI && unlocking)) return;
      }
      if (catchers !== 0 && (key === K.INS || key === K.KP_INS) && event.shiftKey) return;
      // With the character it types, as SDL sends a text event after the key's.
      const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : '';
      const typed = controlChar(key, event.ctrlKey) || printable;
      if (this.input.keyDown(key, typed)) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyForCode(event.code, this.layout, this.apple);
      if (key !== null) this.input.keyUp(key);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (this.input.catchers === 0 && !this.locked) {
        if (this.match) this.capture();
        return;
      }
      const key = keyForButton(event.button);
      if (key !== null) this.input.keyDown(key);
    };
    const onMouseUp = (event: MouseEvent) => {
      const key = keyForButton(event.button);
      if (key !== null) this.input.keyUp(key);
    };
    const onWheel = (event: WheelEvent) => {
      if (this.input.catchers === 0 && !this.input.active) return;
      event.preventDefault();
      const key = keyForWheel(event.deltaY);
      if (key === null) return;
      this.input.keyDown(key);
      this.input.keyUp(key);
    };
    const onMouseMove = (event: MouseEvent) => {
      if (this.locked) this.input.mouseMove(event.movementX, event.movementY);
    };
    const onLockChange = () => {
      const lost = this.locked && document.pointerLockElement !== this.canvas;
      this.locked = document.pointerLockElement === this.canvas;
      this.input.active = this.locked;
      if (!lost) return;
      this.unlockedAt = performance.now();
      // The game lost the mouse: the in-game menu opens over it.
      if (this.input.catchers === 0) this.lost();
    };
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text !== '' && this.input.paste(text)) event.preventDefault();
    };
    const onBlur = () => this.input.clear();
    // The right button is bindable, and a browser menu has no place over the game.
    const onContextMenu = (event: Event) => event.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onBlur);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('paste', onPaste);
    this.detach = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('paste', onPaste);
    };
  }

  /** Whether the mouse is captured. */
  get captured(): boolean {
    return this.locked;
  }

  /**
   * Whether a match is there to take the keys and the mouse. With none, a click captures nothing,
   * and the mouse is let go.
   */
  get playing(): boolean {
    return this.match;
  }

  set playing(playing: boolean) {
    this.match = playing;
    if (!playing) this.release();
  }

  /**
   * Capture the mouse, with raw input where the browser gives it, else as it comes. A browser grants
   * the capture only in answer to a click or a key other than Escape, so Resume's click asks for it
   * from its own handler.
   */
  capture(): void {
    // A browser that can't give raw input refuses the request, so ask again without it.
    const request = this.canvas.requestPointerLock({ unadjustedMovement: true }) as Promise<void> | undefined;
    request?.catch(() => {
      (this.canvas.requestPointerLock() as Promise<void> | undefined)?.catch(() => {});
    });
  }

  /** Let the mouse go, as a menu opened while it is captured needs it to point with. */
  release(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** Stop listening, and let every key go. */
  destroy(): void {
    this.detach();
    this.input.active = false;
  }
}
