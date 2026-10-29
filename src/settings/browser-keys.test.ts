import { describe, expect, it } from 'vitest';

import { K, keyToString } from '../formats/q3-keys';
import { DEFAULT_SETTINGS } from './registry';
import { isConsoleKey, keyForButton, keyForCode, keyForWheel } from './browser-keys';
import {
  CONSOLE_KEY_CASES,
  consoleKeysCorpus,
  runConsoleKeys,
  type ConsoleKeysRun
} from './console-keys-test-fixtures';

/**
 * The corpus over three seeds, 300 values each, as ioquake3's own `IN_IsConsoleKey`, compiled from
 * its C, answered it.
 */
const TWIN: Record<number, ConsoleKeysRun> = {
  1: { matches: 1368, digest: '4abad0a5' },
  2: { matches: 1431, digest: '2a7d51c4' },
  3: { matches: 1412, digest: '99fbce35' }
};

/** A code's key, by Q3's name for it. */
const named = (code: string, layout?: ReadonlyMap<string, string>, apple?: boolean) => {
  const key = keyForCode(code, layout, apple);
  return key === null ? null : keyToString(key);
};

describe('keyForCode', () => {
  it('names the letters, the number row and the punctuation as a US layout types them', () => {
    expect(['KeyW', 'KeyA', 'Digit1', 'Digit0'].map((code) => named(code))).toEqual(['w', 'a', '1', '0']);
    expect(['BracketLeft', 'Backslash', 'Slash', 'Backquote', 'Semicolon'].map((code) => named(code))).toEqual(
      ['[', '\\', '/', '`', 'SEMICOLON']
    );
  });

  it("names a printable key by what the player's layout types, as SDL does, but the digits by place", () => {
    const azerty = new Map([
      ['KeyQ', 'a'],
      ['KeyA', 'q'],
      ['Digit1', '&'],
      ['Semicolon', 'm'],
      ['KeyE', 'é']
    ]);
    expect(named('KeyQ', azerty)).toBe('a');
    expect(named('KeyA', azerty)).toBe('q');
    expect(named('Semicolon', azerty)).toBe('m');
    // "1" is "&" on AZERTY, and still the 1 key to Q3 (`sdl_input.c:200–210`).
    expect(named('Digit1', azerty)).toBe('1');
    // A character past ASCII falls back to the key's US name.
    expect(named('KeyE', azerty)).toBe('e');
  });

  it('names the keys that type nothing', () => {
    expect(['Space', 'Enter', 'Tab', 'Escape', 'ShiftLeft', 'ControlRight', 'AltLeft'].map((code) => named(code))).toEqual(
      ['SPACE', 'ENTER', 'TAB', 'ESCAPE', 'SHIFT', 'CTRL', 'ALT']
    );
    expect(['F1', 'F12', 'ArrowUp', 'PageDown', 'Delete'].map((code) => named(code))).toEqual([
      'F1',
      'F12',
      'UPARROW',
      'PGDN',
      'DEL'
    ]);
  });

  it('names the keypad by its keys, as SDL does', () => {
    expect(['Numpad8', 'Numpad5', 'Numpad0', 'NumpadEnter', 'NumpadAdd'].map((code) => named(code))).toEqual([
      'KP_UPARROW',
      'KP_5',
      'KP_INS',
      'KP_ENTER',
      'KP_PLUS'
    ]);
  });

  it('names the Meta key WINDOWS, or COMMAND on a Mac', () => {
    expect(named('MetaLeft')).toBe('WINDOWS');
    expect(named('MetaRight', undefined, true)).toBe('COMMAND');
  });

  it('has no number for a key Q3 does not know', () => {
    expect(keyForCode('F16')).toBeNull();
    expect(keyForCode('IntlYen')).toBeNull();
    expect(keyForCode('')).toBeNull();
  });
});

describe('keyForButton', () => {
  it("numbers the mouse's buttons as ioq3 does", () => {
    expect([0, 2, 1, 3, 4].map(keyForButton)).toEqual([K.MOUSE1, K.MOUSE2, K.MOUSE3, K.MOUSE4, K.MOUSE5]);
    expect(keyForButton(5)).toBe(K.AUX1 + 2);
    expect(keyForButton(-1)).toBeNull();
  });
});

describe('keyForWheel', () => {
  it('turns the wheel up into MWHEELUP and down into MWHEELDOWN', () => {
    expect(keyForWheel(-100)).toBe(K.MWHEELUP);
    expect(keyForWheel(3)).toBe(K.MWHEELDOWN);
    expect(keyForWheel(0)).toBeNull();
  });
});

describe('isConsoleKey', () => {
  it.each(CONSOLE_KEY_CASES)(
    'reads %j for key %i, character %i, as ioquake3 does',
    (value, key, character, answer) => {
      expect(isConsoleKey(value, key, character)).toBe(answer);
    }
  );

  it.each([1, 2, 3])('runs seed %i as ioquake3 does', (seed) => {
    expect(runConsoleKeys(consoleKeysCorpus(seed, 300))).toEqual(TWIN[seed]);
  });

  it('makes the key left of 1 a console key by default, by its two characters as well', () => {
    const { consoleKeys } = DEFAULT_SETTINGS;
    const byCode = (code: string) => isConsoleKey(consoleKeys, keyForCode(code)!, 0);
    const byCharacter = (ch: string) => isConsoleKey(consoleKeys, 0, ch.charCodeAt(0));
    expect(['Backquote', 'KeyA', 'Escape'].map(byCode)).toEqual([true, false, false]);
    expect(['`', '~', 'a'].map(byCharacter)).toEqual([true, true, false]);
  });
});
