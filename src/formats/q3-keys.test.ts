import { describe, expect, it } from 'vitest';

import { K, MAX_KEYS, keyToString, stringToKey } from './q3-keys';

describe('Q3 key numbers', () => {
  it('numbers keys as keycodes.h does', () => {
    expect([K.TAB, K.ENTER, K.ESCAPE, K.SPACE, K.BACKSPACE]).toEqual([9, 13, 27, 32, 127]);
    expect([K.SHIFT, K.F1, K.KP_EQUALS]).toEqual([138, 145, 177]);
    expect([K.MOUSE1, K.MWHEELDOWN, K.MWHEELUP]).toEqual([178, 183, 184]);
    expect([K.SUPER, K.PAD0_A, K.CONSOLE, MAX_KEYS]).toEqual([329, 340, 371, 372]);
  });
});

describe('stringToKey', () => {
  it('reads a single character as its own key, lowercased', () => {
    expect(stringToKey('w')).toBe(119);
    expect(stringToKey('W')).toBe(119);
    expect(stringToKey('\\')).toBe(92);
    expect(stringToKey('[')).toBe(91);
  });

  it('reads the names without regard to case', () => {
    expect(stringToKey('SPACE')).toBe(K.SPACE);
    // pak0's default.cfg:31 writes it in lower case.
    expect(stringToKey('mwheelup')).toBe(K.MWHEELUP);
    expect(stringToKey('F15')).toBe(159);
    expect(stringToKey('JOY32')).toBe(216);
    expect(stringToKey('AUX16')).toBe(232);
    expect(stringToKey('WORLD_95')).toBe(328);
    expect(stringToKey('WINDOWS')).toBe(K.SUPER);
    expect(stringToKey('PAD0_TOUCHPAD')).toBe(370);
    expect(stringToKey('SEMICOLON')).toBe(59);
  });

  it('reads hex codes as Com_HexStrToInt does', () => {
    expect(stringToKey('0x22')).toBe(34);
    expect(stringToKey('0x7e')).toBe(126);
    expect(stringToKey('0x7E')).toBe(126);
    // A capital X is not hex to Q3, and nor is a code with no digits.
    expect(stringToKey('0X22')).toBe(-1);
    expect(stringToKey('0x')).toBe(-1);
    expect(stringToKey('0x1g')).toBe(-1);
    expect(stringToKey(`0x${MAX_KEYS.toString(16)}`)).toBe(-1);
  });

  it('refuses a name Q3 does not know', () => {
    expect(stringToKey('')).toBe(-1);
    expect(stringToKey('BUTTON')).toBe(-1);
    expect(stringToKey('é')).toBe(-1);
  });
});

describe('keyToString', () => {
  it('writes a printable key as itself, bar the quote and the semicolon', () => {
    expect(keyToString(119)).toBe('w');
    expect(keyToString(92)).toBe('\\');
    expect(keyToString(59)).toBe('SEMICOLON');
    expect(keyToString(34)).toBe('0x22');
  });

  it('writes a named key by its name, and any other as hex', () => {
    expect(keyToString(K.SPACE)).toBe('SPACE');
    expect(keyToString(K.MOUSE1)).toBe('MOUSE1');
    expect(keyToString(K.SUPER)).toBe('WINDOWS');
    expect(keyToString(1)).toBe('0x01');
    expect(keyToString(-1)).toBe('<KEY NOT FOUND>');
    expect(keyToString(MAX_KEYS)).toBe('<OUT OF RANGE>');
  });

  it('writes every key back to the same key, but the capitals Q3 never numbers', () => {
    for (let key = 0; key < K.CONSOLE; key++) {
      if (key >= 65 && key <= 90) continue;
      expect(stringToKey(keyToString(key)), keyToString(key)).toBe(key);
    }
  });
});
