// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { K } from './formats/q3-keys';
import { KeyInput } from './key-input';
import { BUTTON_ATTACK, BUTTON_TALK } from './sim/constants';
import { KEYCATCH, type ClientInput } from './settings/client-input';
import { routedInput } from './settings/input-test-fixtures';
import { DEFAULT_SETTINGS } from './settings/registry';
import { ConsoleHistory } from './view/console-history';
import { consoleKey, type ConsoleLine } from './view/console-key';
import { EditField } from './view/edit-field';

/**
 * The DOM seam: which browser event becomes which Q3 key, and when the game takes them. Pointer
 * lock is the one thing jsdom lacks, so the canvas's request and the document's locked element
 * are stood in for; the events and everything behind them are real.
 */

let canvas: HTMLCanvasElement;
let input: ClientInput;
let keys: KeyInput;
let locked: Element | null;
let requestPointerLock: ReturnType<typeof vi.fn<(options?: PointerLockOptions) => Promise<void>>>;

beforeEach(() => {
  canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  locked = null;
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => locked });
  requestPointerLock = vi.fn(async () => {});
  canvas.requestPointerLock = requestPointerLock;
  input = routedInput().input;
  keys = new KeyInput(canvas, input);
});

afterEach(() => {
  keys.destroy();
  canvas.remove();
});

/** Take the mouse, or let it go, as the browser reports it. */
function lock(element: Element | null = canvas): void {
  locked = element;
  document.dispatchEvent(new Event('pointerlockchange'));
}

function keyDown(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { code, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

function click(button = 0): void {
  canvas.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
  window.dispatchEvent(new MouseEvent('mouseup', { button }));
}

describe('capturing the mouse', () => {
  it('captures on a click, asking for raw input, and the click does not fire', () => {
    click();
    expect(requestPointerLock).toHaveBeenCalledWith({ unadjustedMovement: true });
    lock();
    expect(keys.captured).toBe(true);
    expect(input.cmdButtons()).toBe(0);

    click();
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK);
    expect(requestPointerLock).toHaveBeenCalledOnce();
  });

  it('asks again without raw input where the browser refuses it', async () => {
    requestPointerLock.mockRejectedValueOnce(new DOMException('no raw input', 'NotSupportedError'));
    click();
    await vi.waitFor(() => expect(requestPointerLock).toHaveBeenCalledTimes(2));
    expect(requestPointerLock).toHaveBeenLastCalledWith();
  });

  it('does not capture with a catcher up', () => {
    input.setCatcher(KEYCATCH.UI);
    click();
    expect(requestPointerLock).not.toHaveBeenCalled();
  });

  it('captures nothing with no match to play, and lets the mouse go as the match goes', () => {
    const exitPointerLock = vi.fn();
    document.exitPointerLock = exitPointerLock;
    click();
    lock();
    keys.playing = false;
    expect(exitPointerLock).toHaveBeenCalledOnce();
    lock(null);
    click();
    expect(requestPointerLock).toHaveBeenCalledOnce();

    keys.playing = true;
    click();
    expect(requestPointerLock).toHaveBeenCalledTimes(2);
  });

  it('knows from the start that there is no match, and captures nothing on the first click', () => {
    keys.destroy();
    keys = new KeyInput(canvas, input, undefined, false);
    expect(keys.playing).toBe(false);
    click();
    expect(requestPointerLock).not.toHaveBeenCalled();
  });
});

describe('when the game takes input', () => {
  it('takes keys only while the mouse is captured', () => {
    keyDown('KeyW');
    expect(input.keyMove().forwardmove).toBe(0);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    lock();
    keyDown('KeyW');
    expect(input.keyMove().forwardmove).toBe(127);
  });

  it('lets every key go when the capture is lost', () => {
    lock();
    keyDown('KeyW');
    lock(null);
    expect(input.active).toBe(false);
    expect(input.keyMove().forwardmove).toBe(0);
  });

  it('lets every key go when the window loses its focus', () => {
    lock();
    keyDown('KeyW');
    window.dispatchEvent(new Event('blur'));
    expect(input.keyMove().forwardmove).toBe(0);
  });

  it('holds input back while a catcher is up, and gives it back after', () => {
    lock();
    input.setCatcher(KEYCATCH.UI);
    keyDown('KeyW');
    expect(input.keyMove().forwardmove).toBe(0);
    input.setCatcher(0);
    keyDown('KeyW');
    expect(input.keyMove().forwardmove).toBe(127);
  });
});

describe('keys, the wheel and the mouse', () => {
  it("skips a held key's repeats, as ioq3 does in game", () => {
    lock();
    keyDown('Digit5');
    keyDown('Digit5', { repeat: true });
    expect(input.takeCommands()).toEqual([['weapon', '5']]);
  });

  it('turns the wheel up into weapprev and down into weapnext, as pak0 binds them', () => {
    lock();
    const up = new WheelEvent('wheel', { deltaY: -100, cancelable: true });
    canvas.dispatchEvent(up);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
    expect(input.takeCommands()).toEqual([['weapprev'], ['weapnext']]);
    expect(up.defaultPrevented).toBe(true);
  });

  it('reads a turn with Shift held by its sideways part, where it has no vertical one', () => {
    lock();
    const turn = (init: WheelEventInit) =>
      canvas.dispatchEvent(new WheelEvent('wheel', { cancelable: true, ...init }));
    turn({ deltaX: -100, shiftKey: true });
    turn({ deltaX: 100, shiftKey: true });
    // Without Shift a sideways turn is no key, and with it a vertical part still leads.
    turn({ deltaX: -100 });
    turn({ deltaX: -100, deltaY: 100, shiftKey: true });
    expect(input.takeCommands()).toEqual([['weapprev'], ['weapnext'], ['weapnext']]);
  });

  it("stops a bound key's browser default while the game takes input, and only then", () => {
    expect(keyDown('KeyW').defaultPrevented).toBe(false);
    lock();
    expect(keyDown('KeyD').defaultPrevented).toBe(true);
    expect(keyDown('KeyZ').defaultPrevented).toBe(false);
  });

  it('passes the mouse movement on while captured', () => {
    const move = (dx: number, dy: number) => {
      const event = new MouseEvent('mousemove');
      Object.defineProperties(event, { movementX: { value: dx }, movementY: { value: dy } });
      document.dispatchEvent(event);
    };
    move(5, 5);
    lock();
    move(3, -2);
    expect(input.takeMouse()).toEqual({ dx: 3, dy: -2 });
  });

  it("keeps the browser's menu off the right button", () => {
    const event = new MouseEvent('contextmenu', { cancelable: true });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('numbers the keys as Q3 does', () => {
    lock();
    keyDown('ShiftLeft');
    expect(input.keyMove().upmove).toBe(-127);
    click(0);
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK);
    expect(K.SHIFT).toBe(138);
  });
});

describe('the menu', () => {
  let menu: {
    key: ReturnType<typeof vi.fn<(key: number) => boolean>>;
    char: ReturnType<typeof vi.fn<(ch: string) => boolean>>;
    paste: ReturnType<typeof vi.fn<(text: string) => boolean>>;
    open: ReturnType<typeof vi.fn<() => void>>;
  };
  let lost: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    keys.destroy();
    const up = () => input.setCatcher(KEYCATCH.UI);
    menu = {
      key: vi.fn(() => true),
      char: vi.fn(() => true),
      paste: vi.fn(() => true),
      open: vi.fn(up)
    };
    lost = vi.fn(up);
    input = routedInput([['m'.charCodeAt(0), 'togglemenu']], undefined, { menu }).input;
    keys = new KeyInput(canvas, input, lost);
  });

  const pressed = () => menu.key.mock.calls.map(([key]) => key);

  it('opens on Escape before the first capture, and neither the game nor the menu takes the key', () => {
    keyDown('Escape');
    expect(menu.open).toHaveBeenCalledOnce();
    expect(input.catchers).toBe(KEYCATCH.UI);
    expect(menu.key).not.toHaveBeenCalled();
    expect(lost).not.toHaveBeenCalled();
  });

  it('opens when the game loses the mouse', () => {
    lock();
    lock(null);
    expect(lost).toHaveBeenCalledOnce();
    expect(input.active).toBe(false);
  });

  it('leaves Escape to the browser while the mouse is captured, whose letting it go opens the menu', () => {
    lock();
    expect(keyDown('Escape').defaultPrevented).toBe(false);
    expect(menu.open).not.toHaveBeenCalled();
    lock(null);
    expect(lost).toHaveBeenCalledOnce();
  });

  it('opens nothing more when the mouse is lost with a catcher up', () => {
    lock();
    input.setCatcher(KEYCATCH.CONSOLE);
    lock(null);
    expect(lost).not.toHaveBeenCalled();
  });

  it('opens on a key bound to togglemenu with the mouse captured, and hands the menu Escape on it', () => {
    lock();
    keyDown('KeyM');
    expect(menu.open).toHaveBeenCalledOnce();
    expect(input.catchers).toBe(KEYCATCH.UI);
    keyDown('KeyM');
    expect(pressed()).toEqual(['m'.charCodeAt(0), K.ESCAPE]);
  });

  it('lets the mouse go when asked, for a menu opened over it, and not when it is free', () => {
    const exitPointerLock = vi.fn();
    document.exitPointerLock = exitPointerLock;
    keys.release();
    expect(exitPointerLock).not.toHaveBeenCalled();
    lock();
    keys.release();
    expect(exitPointerLock).toHaveBeenCalledOnce();
  });

  it('gives the menu every key while it is up, repeats too, and stops the defaults of those it uses', () => {
    input.setCatcher(KEYCATCH.UI);
    const tab = keyDown('Tab');
    menu.key.mockReturnValueOnce(false);
    const q = keyDown('KeyQ');
    keyDown('ArrowDown', { repeat: true });
    expect(pressed()).toEqual([K.TAB, 'q'.charCodeAt(0), K.DOWNARROW]);
    expect(tab.defaultPrevented).toBe(true);
    expect(q.defaultPrevented).toBe(false);
  });

  it("hands the menu the character a key types after the key, and SDL's control characters", () => {
    input.setCatcher(KEYCATCH.UI);
    menu.key.mockReturnValue(false);
    const typed = keyDown('KeyA', { key: 'A' });
    // A Ctrl chord's letter, as its control character alone; Backspace's ^H.
    keyDown('KeyC', { key: 'c', ctrlKey: true });
    keyDown('Backspace', { key: 'Backspace' });
    keyDown('Enter', { key: 'Enter' });
    // Ctrl with a key that isn't a letter types nothing.
    keyDown('Digit1', { key: '1', ctrlKey: true });
    expect(menu.char.mock.calls.map(([ch]) => ch)).toEqual(['A', '\x03', '\b']);
    expect(typed.defaultPrevented).toBe(true);
  });

  it('gives it the wheel while it is up, and stops its default', () => {
    input.setCatcher(KEYCATCH.UI);
    const wheel = new WheelEvent('wheel', { deltaY: 100, cancelable: true });
    canvas.dispatchEvent(wheel);
    expect(pressed()).toEqual([K.MWHEELDOWN]);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it('gives it the buttons as keys, and neither captures nor fires', () => {
    input.setCatcher(KEYCATCH.UI);
    click(0);
    click(2);
    expect(pressed()).toEqual([K.MOUSE1, K.MOUSE2]);
    expect(requestPointerLock).not.toHaveBeenCalled();
    expect(input.cmdButtons()).toBe(BUTTON_TALK);
  });

  it('passes over the Escape that let the mouse go, in case a browser hands that on too', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    lock();
    lock(null);
    keyDown('Escape');
    expect(menu.key).not.toHaveBeenCalled();
    now.mockReturnValue(1200);
    keyDown('Escape');
    expect(pressed()).toEqual([K.ESCAPE]);
    now.mockRestore();
  });

  /** The browser's paste, of `text`, as Ctrl+V or Shift+Ins gives it. */
  function paste(text: string): Event {
    const event = new Event('paste', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    document.dispatchEvent(event);
    return event;
  }

  it("hands the menu the browser's paste while up, and stops the default of one taken", () => {
    expect(paste('203.0.113.9').defaultPrevented).toBe(false);
    expect(menu.paste).not.toHaveBeenCalled();
    input.setCatcher(KEYCATCH.UI);
    expect(paste('203.0.113.9').defaultPrevented).toBe(true);
    expect(menu.paste).toHaveBeenCalledExactlyOnceWith('203.0.113.9');
    menu.paste.mockReturnValueOnce(false);
    expect(paste('x').defaultPrevented).toBe(false);
    // An empty clipboard pastes nothing.
    paste('');
    expect(menu.paste).toHaveBeenCalledTimes(2);
  });

  it("leaves Shift+Ins to the browser to paste with, where Insert alone is the menu's", () => {
    input.setCatcher(KEYCATCH.UI);
    const shifted = keyDown('Insert', { shiftKey: true });
    expect(menu.key).not.toHaveBeenCalled();
    expect(shifted.defaultPrevented).toBe(false);
    keyDown('Insert');
    expect(pressed()).toEqual([K.INS]);
  });

  it('captures the mouse when asked, as Resume asks from its own click', () => {
    keys.capture();
    expect(requestPointerLock).toHaveBeenCalledWith({ unadjustedMovement: true });
  });
});

describe("the console's line", () => {
  let field: EditField;
  let line: ConsoleLine & { run: ReturnType<typeof vi.fn<(text: string) => void>> };

  beforeEach(() => {
    keys.destroy();
    field = new EditField({ overstrike: false }, 78);
    line = {
      field,
      history: new ConsoleHistory(() => {}),
      scrollback: { pageUp: vi.fn(), pageDown: vi.fn(), top: vi.fn(), bottom: vi.fn() },
      isDown: (key) => input.isDown(key),
      active: () => false,
      autochat: () => true,
      names: () => ({ commands: ['cmdlist'], cvars: [] }),
      print: () => {},
      run: vi.fn()
    };
    input = routedInput(undefined, undefined, {
      console: {
        key: (key) => consoleKey(key, line),
        char: (ch) => field.char(ch),
        paste: (text) => {
          field.paste(text);
          return true;
        }
      }
    }).input;
    keys = new KeyInput(canvas, input);
    input.setCatcher(KEYCATCH.CONSOLE);
  });

  /** Letters typed a key at a time, each with its character. */
  const type = (letters: string) =>
    Array.from(letters, (ch) => keyDown(`Key${ch.toUpperCase()}`, { key: ch }));
  /** A letter's key with Ctrl held. */
  const ctrl = (letter: string) =>
    keyDown(`Key${letter.toUpperCase()}`, { key: letter, ctrlKey: true });

  it('takes no character from the key whose bind drops it', () => {
    keys.destroy();
    const console = {
      key: (key: number) => field.keyDown(key),
      char: (ch: string) => field.char(ch)
    };
    const wired = routedInput([['k'.charCodeAt(0), 'toggleconsole']], undefined, { console });
    wired.router.add('toggleconsole', () => input.setCatcher(input.catchers ^ KEYCATCH.CONSOLE));
    input = wired.input;
    keys = new KeyInput(canvas, input);
    type('k');
    expect([input.catchers, field.text]).toEqual([KEYCATCH.CONSOLE, '']);
    type('k');
    expect(field.text).toBe('k');
  });

  it("types each key's character into it, and stops the key's default", () => {
    const events = type('hello');
    expect([field.text, field.cursor]).toEqual(['hello', 5]);
    expect(events.every((event) => event.defaultPrevented)).toBe(true);
  });

  it('takes the character before the cursor on Backspace, as the ^H SDL types for it', () => {
    type('abc');
    keyDown('ArrowLeft', { key: 'ArrowLeft' });
    const backspace = keyDown('Backspace', { key: 'Backspace' });
    expect([field.text, field.cursor]).toEqual(['ac', 1]);
    expect(backspace.defaultPrevented).toBe(true);
  });

  it('goes to its ends on Ctrl+A and Ctrl+E, and clears it on Ctrl+C', () => {
    type('abc');
    expect(ctrl('a').defaultPrevented).toBe(true);
    expect(field.cursor).toBe(0);
    ctrl('e');
    expect(field.cursor).toBe(3);
    ctrl('c');
    expect([field.text, field.cursor]).toEqual(['', 0]);
  });

  it("leaves Ctrl+V to the browser, and takes the paste it makes, the first line of it", () => {
    type('ab');
    const v = ctrl('v');
    expect(v.defaultPrevented).toBe(false);
    expect(field.text).toBe('ab');
    const event = new Event('paste', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'cd\r\nef' } });
    document.dispatchEvent(event);
    expect(field.text).toBe('abcd');
    expect(event.defaultPrevented).toBe(true);
  });

  it("completes the line on Tab, stopping the browser's move of the focus", () => {
    type('cmdl');
    const tab = keyDown('Tab', { key: 'Tab' });
    expect([field.text, field.cursor]).toEqual(['\\cmdlist ', 9]);
    expect(tab.defaultPrevented).toBe(true);
  });

  it('enters the line on Enter, and brings it back on Up, stopping both defaults', () => {
    type('kill');
    const enter = keyDown('Enter', { key: 'Enter' });
    expect(line.run.mock.calls).toEqual([['kill']]);
    expect(field.text).toBe('');
    const up = keyDown('ArrowUp', { key: 'ArrowUp' });
    expect(field.text).toBe('\\kill');
    expect([enter.defaultPrevented, up.defaultPrevented]).toEqual([true, true]);
  });

  it('holds Ctrl from its own key for Ctrl+L and Ctrl+P, and stops their defaults', () => {
    type('kill');
    keyDown('Enter', { key: 'Enter' });
    keyDown('ControlLeft', { key: 'Control', ctrlKey: true });
    const l = ctrl('l');
    const p = ctrl('p');
    expect(line.run.mock.calls).toEqual([['kill'], ['clear']]);
    expect(field.text).toBe('\\kill');
    expect([l.defaultPrevented, p.defaultPrevented]).toEqual([true, true]);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ControlLeft' }));
    type('l');
    expect(field.text).toBe('\\killl');
  });

  it('scrolls the text on the wheel, and brings back a line on a sideways turn with Shift', () => {
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    expect(line.scrollback.pageUp).toHaveBeenCalledTimes(1);
    type('kill');
    keyDown('Enter', { key: 'Enter' });
    keyDown('ShiftLeft', { key: 'Shift', shiftKey: true });
    const sideways = { deltaX: -100, shiftKey: true, cancelable: true };
    canvas.dispatchEvent(new WheelEvent('wheel', sideways));
    expect(field.text).toBe('\\kill');
    expect(line.scrollback.pageUp).toHaveBeenCalledTimes(1);
  });
});

describe('the console key', () => {
  let field: EditField;
  let menu: {
    key: ReturnType<typeof vi.fn<(key: number) => boolean>>;
    char: ReturnType<typeof vi.fn<(ch: string) => boolean>>;
    open: ReturnType<typeof vi.fn<() => void>>;
  };
  let lost: ReturnType<typeof vi.fn<() => void>>;
  /** The binds' halves run and the toggles, in order. */
  let ran: string[];
  let consoleKeys: string;
  let exitPointerLock: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    keys.destroy();
    field = new EditField({ overstrike: false }, 78);
    const up = () => input.setCatcher(KEYCATCH.UI);
    menu = { key: vi.fn(() => true), char: vi.fn(() => true), open: vi.fn(up) };
    lost = vi.fn(up);
    consoleKeys = DEFAULT_SETTINGS.consoleKeys;
    exitPointerLock = vi.fn();
    document.exitPointerLock = exitPointerLock;
    ran = [];
    const binds = ['`', 'q'].map((ch) => [ch.charCodeAt(0), '+held'] as const);
    const wired = routedInput(binds, undefined, {
      console: { key: (key) => field.keyDown(key), char: (ch) => field.char(ch) },
      menu
    });
    // As the client's own: the catcher flipped, and the mouse after it.
    wired.router.add('toggleconsole', () => {
      ran.push('toggleconsole');
      input.setCatcher(input.catchers ^ KEYCATCH.CONSOLE);
      keys.followConsole();
    });
    for (const half of ['+held', '-held']) {
      wired.router.add(half, (argv) => void ran.push(argv.join(' ')));
    }
    input = wired.input;
    keys = new KeyInput(canvas, input, lost, true, () => consoleKeys);
  });

  const backquote = (init: KeyboardEventInit = {}) => keyDown('Backquote', { key: '`', ...init });

  it('drops and lifts the console on the key left of 1, typing nothing and running no bind', () => {
    const drop = backquote();
    expect([input.catchers, field.text]).toEqual([KEYCATCH.CONSOLE, '']);
    expect(drop.defaultPrevented).toBe(true);
    backquote();
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backquote' }));
    expect(input.catchers).toBe(0);
    expect(ran).toEqual(['toggleconsole', 'toggleconsole']);
  });

  it('drops it over the menu, which has neither the key nor its character, and lifts it', () => {
    input.setCatcher(KEYCATCH.UI);
    keyDown('ShiftLeft', { key: 'Shift', shiftKey: true });
    menu.key.mockClear();
    backquote({ key: '~', shiftKey: true });
    expect(input.catchers).toBe(KEYCATCH.UI | KEYCATCH.CONSOLE);
    expect([menu.key, menu.char].map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
    backquote();
    expect(input.catchers).toBe(KEYCATCH.UI);
  });

  it('toggles on a character cl_consoleKeys names, typed by any key, after that key', () => {
    backquote();
    keyDown('KeyQ', { key: 'q' });
    const tilde = keyDown('KeyQ', { key: '~' });
    expect([input.catchers, field.text, tilde.defaultPrevented]).toEqual([0, 'q', true]);
  });

  it('runs the bind of the key that types one first, as SDL sends a key before its text', () => {
    lock();
    keyDown('KeyQ', { key: '~' });
    expect(ran).toEqual(['+held 113', 'toggleconsole', '-held 113']);
  });

  it('frees the backquote once cl_consoleKeys leaves it out, and toggles on what it names', () => {
    consoleKeys = 'PAUSE';
    keyDown('Pause');
    backquote();
    keyDown('KeyQ', { key: '~' });
    expect([input.catchers, field.text]).toEqual([KEYCATCH.CONSOLE, '`~']);
    keyDown('Pause');
    expect(input.catchers).toBe(0);
  });

  it('lifts it on Shift+Escape with the mouse free', () => {
    backquote();
    keyDown('ShiftLeft', { key: 'Shift', shiftKey: true });
    keyDown('Escape', { key: 'Escape', shiftKey: true });
    expect(input.catchers).toBe(0);
    expect(menu.open).not.toHaveBeenCalled();
  });

  it("toggles again on the held key's repeats while a catcher is up, as SDL hands them on", () => {
    backquote();
    backquote({ repeat: true });
    expect(input.catchers).toBe(0);
    backquote({ repeat: true });
    expect(input.catchers).toBe(0);
  });

  it('makes no console key of a mouse button or the wheel, as SDL makes none', () => {
    consoleKeys = 'MOUSE1 MWHEELUP';
    input.setCatcher(KEYCATCH.CONSOLE);
    click();
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    expect(input.catchers).toBe(KEYCATCH.CONSOLE);
  });

  it('lets the mouse go as it drops, opening nothing, and takes it back as it lifts', () => {
    lock();
    backquote();
    expect(exitPointerLock).toHaveBeenCalledOnce();
    lock(null);
    expect(lost).not.toHaveBeenCalled();
    backquote();
    expect(requestPointerLock).toHaveBeenCalledExactlyOnceWith({ unadjustedMovement: true });
  });

  it('leaves the mouse free as it lifts over the menu, or with no match to play', () => {
    input.setCatcher(KEYCATCH.UI);
    backquote();
    backquote();
    input.setCatcher(0);
    keys.playing = false;
    backquote();
    backquote();
    expect(requestPointerLock).not.toHaveBeenCalled();
  });

  it('drops it, opening no menu, when the browser lets the mouse go with Shift held', () => {
    lock();
    keyDown('ShiftLeft', { key: 'Shift', shiftKey: true });
    lock(null);
    expect(input.catchers).toBe(KEYCATCH.CONSOLE);
    expect([lost, menu.open].map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
  });

  it('passes over a late Shift+Escape after the mouse it let go dropped the console', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    lock();
    keyDown('ShiftLeft', { key: 'Shift', shiftKey: true });
    lock(null);
    keyDown('ShiftLeft', { key: 'Shift', shiftKey: true, repeat: true });
    keyDown('Escape', { key: 'Escape', shiftKey: true });
    expect(input.catchers).toBe(KEYCATCH.CONSOLE);
    now.mockReturnValue(1200);
    keyDown('Escape', { key: 'Escape', shiftKey: true });
    expect(input.catchers).toBe(0);
    now.mockRestore();
  });
});

describe('teardown', () => {
  it('stops listening once destroyed', () => {
    lock();
    keys.destroy();
    keyDown('KeyW');
    expect(input.active).toBe(false);
    expect(input.keyMove().forwardmove).toBe(0);
  });

  it('stops hearing a paste once destroyed', () => {
    const paste = vi.fn(() => true);
    keys.destroy();
    input = routedInput(undefined, undefined, { menu: { key: () => true, paste, open: () => {} } }).input;
    keys = new KeyInput(canvas, input);
    input.setCatcher(KEYCATCH.UI);
    keys.destroy();
    const event = new Event('paste');
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'x' } });
    document.dispatchEvent(event);
    expect(paste).not.toHaveBeenCalled();
  });
});
