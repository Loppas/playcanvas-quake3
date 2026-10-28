// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { K } from './formats/q3-keys';
import { KeyInput } from './key-input';
import { BUTTON_ATTACK, BUTTON_TALK } from './sim/constants';
import { KEYCATCH, type ClientInput } from './settings/client-input';
import { routedInput } from './settings/input-test-fixtures';

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

  it("hands the menu the character a key types, after the key, but no Ctrl chord's", () => {
    input.setCatcher(KEYCATCH.UI);
    menu.key.mockReturnValue(false);
    const typed = keyDown('KeyA', { key: 'A' });
    keyDown('KeyC', { key: 'c', ctrlKey: true });
    keyDown('Enter', { key: 'Enter' });
    expect(menu.char.mock.calls.map(([ch]) => ch)).toEqual(['A']);
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
