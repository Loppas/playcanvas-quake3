import { K } from './formats/q3-keys';
import { isConsoleKey, keyForButton, keyForCode, keyForWheel } from './settings/browser-keys';
import { KEYCATCH, type ClientInput } from './settings/client-input';

/** The Keyboard API's layout map, which TypeScript's DOM types don't carry yet. */
interface LayoutNavigator {
  keyboard?: { getLayoutMap?(): Promise<ReadonlyMap<string, string>> };
}

/**
 * How soon after the mouse is let go an Escape is taken for the one that let it go. A browser that
 * hands the page that key as well as releasing the mouse would otherwise close the menu it opened,
 * or lift the console.
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
 * - The chat line keeps the mouse, as Q3's does; the console and the menu let it go.
 * - A click on the canvas with nothing up but the chat line captures the mouse, asking for raw
 *   input, free of the OS's acceleration, where the browser gives it. That click only captures; it
 *   doesn't fire.
 * - Escape with the mouse free is Q3's Escape. With it captured, Escape is the browser's, which lets
 *   it go and never reaches the page, so the capture lost is Escape: with nothing up it opens the
 *   menu, with the chat line up it closes the line, and with Shift held it drops the console, as
 *   Shift+Escape does.
 * - A key `cl_consoleKeys` names is the console key, which no bind can take and which types
 *   nothing, and a character it names presses and lets go the console key instead of being typed
 *   (`sdl_input.c:315–319, 1103–1106`). Mouse buttons and the wheel are never console keys.
 * - The mouse is let go while the console is down, as Q3 lets it go in a window
 *   (`sdl_input.c:1251–1255`), and taken back as it lifts.
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
  private readonly consoleKeys: () => string;
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
   * @param consoleKeys - `cl_consoleKeys`, read at each key.
   */
  constructor(
    canvas: HTMLCanvasElement,
    input: ClientInput,
    lost?: () => void,
    playing = true,
    consoleKeys: () => string = () => ''
  ) {
    this.canvas = canvas;
    this.input = input;
    this.lost = lost ?? (() => {});
    this.match = playing;
    this.consoleKeys = consoleKeys;
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
        if (this.locked || unlocking) return;
      }
      if (catchers !== 0 && (key === K.INS || key === K.KP_INS) && event.shiftKey) return;
      const consoleKeys = this.consoleKeys();
      if (isConsoleKey(consoleKeys, key, 0)) {
        this.input.keyDown(K.CONSOLE);
        event.preventDefault();
        return;
      }
      // With the character it types, as SDL sends a text event after the key's.
      const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : '';
      const toggles = printable !== '' && isConsoleKey(consoleKeys, 0, printable.charCodeAt(0));
      const typed = controlChar(key, event.ctrlKey) || (toggles ? '' : printable);
      const taken = this.input.keyDown(key, typed);
      if (toggles) {
        this.input.keyDown(K.CONSOLE);
        this.input.keyUp(K.CONSOLE);
      }
      if (taken || toggles) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyForCode(event.code, this.layout, this.apple);
      if (key === null) return;
      this.input.keyUp(isConsoleKey(this.consoleKeys(), key, 0) ? K.CONSOLE : key);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!this.locked && !this.freesMouse()) {
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
      // A browser may turn the wheel with Shift held into a sideways scroll, where SDL keeps it.
      const turned = event.shiftKey && event.deltaY === 0 ? event.deltaX : event.deltaY;
      const key = keyForWheel(turned);
      if (key === null) return;
      this.input.keyDown(key);
      this.input.keyUp(key);
    };
    const onMouseMove = (event: MouseEvent) => {
      if (this.locked) this.input.mouseMove(event.movementX, event.movementY);
    };
    const onLockChange = () => {
      const lost = this.locked && document.pointerLockElement !== this.canvas;
      // Read before the capture's loss lets every key go.
      const shifted = this.input.isDown(K.SHIFT);
      this.locked = document.pointerLockElement === this.canvas;
      this.input.active = this.locked;
      if (!lost) return;
      this.unlockedAt = performance.now();
      if (this.freesMouse()) return;
      if (shifted) {
        // Shift+Escape, its Escape the browser's: the console key pressed and let go.
        this.input.keyDown(K.CONSOLE);
        this.input.keyUp(K.CONSOLE);
      } else if (this.input.catchers & KEYCATCH.MESSAGE) {
        // The browser's Escape, which closes the chat line.
        this.input.keyDown(K.ESCAPE);
        this.input.keyUp(K.ESCAPE);
      } else {
        // The game lost the mouse: the in-game menu opens over it.
        this.lost();
      }
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

  /**
   * The console has just dropped or lifted: the mouse is let go while it is down, and taken back
   * as it lifts with nothing else up but the chat line, in a match. A browser gives it back unasked
   * after the page let it go itself, but after its own Escape only to a click, or a key other than
   * Escape a moment later; refused, it waits for a click on the view.
   */
  followConsole(): void {
    if (this.input.catchers & KEYCATCH.CONSOLE) this.release();
    else if (!this.freesMouse() && this.match) this.capture();
  }

  /** Whether a catcher that lets the mouse go is up: the console or the menu. */
  private freesMouse(): boolean {
    return (this.input.catchers & ~KEYCATCH.MESSAGE) !== 0;
  }

  /** Stop listening, and let every key go. */
  destroy(): void {
    this.detach();
    this.input.active = false;
  }
}
