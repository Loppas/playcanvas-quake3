import { K } from './formats/q3-keys';
import { keyForButton, keyForCode, keyForWheel } from './settings/browser-keys';
import type { ClientInput } from './settings/client-input';

/** The Keyboard API's layout map, which TypeScript's DOM types don't carry yet. */
interface LayoutNavigator {
  keyboard?: { getLayoutMap?(): Promise<ReadonlyMap<string, string>> };
}

/**
 * How soon after the mouse is let go an Escape is taken for the one that let it go. A browser that
 * hands the page that key as well as releasing the mouse would otherwise close the menu it opened.
 */
const UNLOCK_ESCAPE_MS = 100;

/** What the menu takes from the keys. */
export interface MenuKeys {
  /**
   * A key or a button while the menu is up (`UI_KeyEvent`).
   *
   * @returns whether the menu used it, so its browser default is stopped
   */
  key(key: number): boolean;
  /**
   * The character a key typed, after its key: Q3's char event, for a field (`K_CHAR_FLAG`).
   *
   * @returns whether the menu used it
   */
  char?(ch: string): boolean;
  /**
   * Text pasted, for a field, as Q3's Shift+Ins and Ctrl+V paste into one (`MField_Paste`).
   *
   * @returns whether the menu used it
   */
  paste?(text: string): boolean;
  /**
   * Open the in-game menu: Escape with the mouse free and no menu up, or the capture lost.
   *
   * @param escape - Whether it was Escape, which Quake 3 answers otherwise while the match is not
   *   in the world, rather than the capture lost.
   */
  open(escape: boolean): void;
}

/**
 * The browser's keys, buttons and mouse, handed to {@link ClientInput} as Q3's, or to the menu
 * while it is up.
 *
 * - A click on the canvas captures the mouse, asking for raw input, free of the OS's
 *   acceleration, where the browser gives it. That click only captures; it doesn't fire.
 * - Escape with the mouse free, or the capture lost, opens the menu. While it is up, every
 *   key and button is the menu's, a held key's repeats too, as SDL hands them on with a key
 *   catcher up (`sdl_input.c:1044–1045`).
 * - Input reaches the game only while the mouse is captured and no menu is up. Losing either, or
 *   the window's focus, lets every key go.
 * - In game a held key doesn't repeat, as ioq3 skips SDL's repeats there.
 * - While the game takes input, a bound key's browser default is stopped: in some browsers `/`
 *   finds text on the page, and Tab moves the focus. So is that of every key the menu uses.
 * - While a menu is up, the browser's paste is the menu's: Ctrl+V and Shift+Ins paste as Q3's
 *   do, the clipboard read from the paste itself, which asks no permission. Shift+Ins is left to
 *   the browser so that it pastes, rather than reaching the menu as Insert.
 */
export class KeyInput {
  private readonly canvas: HTMLCanvasElement;
  private readonly input: ClientInput;
  private readonly menu: MenuKeys | undefined;
  private readonly apple: boolean;
  private readonly detach: () => void;
  private layout: ReadonlyMap<string, string> | undefined;
  private locked = false;
  private menuUp = false;
  private match: boolean;
  /** When the mouse was last let go, on `performance.now()`'s clock. */
  private unlockedAt = Number.NEGATIVE_INFINITY;

  /**
   * @param canvas - The canvas that captures the mouse.
   * @param input - Where Q3's keys go in game.
   * @param menu - Where they go while the menu is up, and what opens it.
   * @param playing - Whether a match is there already, as {@link playing} says.
   */
  constructor(canvas: HTMLCanvasElement, input: ClientInput, menu?: MenuKeys, playing = true) {
    this.canvas = canvas;
    this.input = input;
    this.menu = menu;
    this.match = playing;
    this.apple = /Mac|iPhone|iPad/.test(navigator.platform);
    (navigator as Navigator & LayoutNavigator).keyboard
      ?.getLayoutMap?.()
      .then((layout) => (this.layout = layout))
      .catch(() => {});

    const onKeyDown = (event: KeyboardEvent) => {
      const key = keyForCode(event.code, this.layout, this.apple);
      if (key === null) return;
      if (this.menuUp) {
        if (key === K.ESCAPE && performance.now() - this.unlockedAt < UNLOCK_ESCAPE_MS) return;
        if ((key === K.INS || key === K.KP_INS) && event.shiftKey) return;
        const used = this.menu?.key(key) ?? false;
        // The character it types, as SDL sends a text event after the key's.
        const typed =
          event.key.length === 1 && !event.ctrlKey && !event.metaKey && (this.menu?.char?.(event.key) ?? false);
        if (used || typed) event.preventDefault();
        return;
      }
      if (event.repeat) return;
      if (key === K.ESCAPE && !this.locked) {
        this.menu?.open(true);
        return;
      }
      if (this.input.active && this.input.bound(key)) event.preventDefault();
      this.input.keyDown(key);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyForCode(event.code, this.layout, this.apple);
      if (key !== null) this.input.keyUp(key);
    };
    const onMouseDown = (event: MouseEvent) => {
      const key = keyForButton(event.button);
      if (this.menuUp) {
        if (key !== null) this.menu?.key(key);
        return;
      }
      if (!this.locked) {
        if (this.match) this.capture();
        return;
      }
      if (key !== null) this.input.keyDown(key);
    };
    const onMouseUp = (event: MouseEvent) => {
      const key = keyForButton(event.button);
      if (key !== null) this.input.keyUp(key);
    };
    const onWheel = (event: WheelEvent) => {
      const key = keyForWheel(event.deltaY);
      if (this.menuUp) {
        event.preventDefault();
        if (key !== null) this.menu?.key(key);
        return;
      }
      if (!this.input.active) return;
      event.preventDefault();
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
      this.update();
      if (!lost) return;
      this.unlockedAt = performance.now();
      // The game lost the mouse: the in-game menu opens over it.
      if (!this.menuUp) this.menu?.open(false);
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!this.menuUp) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text !== '' && (this.menu?.paste?.(text) ?? false)) event.preventDefault();
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

  /** Whether a menu is up. Input doesn't reach the game while one is. */
  get menuOpen(): boolean {
    return this.menuUp;
  }

  set menuOpen(open: boolean) {
    this.menuUp = open;
    this.update();
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
    if (!playing && this.locked) document.exitPointerLock();
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

  /** Stop listening, and let every key go. */
  destroy(): void {
    this.detach();
    this.input.active = false;
  }

  private update(): void {
    this.input.active = this.locked && !this.menuUp;
  }
}
