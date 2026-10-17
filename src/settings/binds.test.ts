import { describe, expect, it, vi } from 'vitest';

import { K, keyToString } from '../formats/q3-keys';
import { BindTable, bindWarning, defaultBinds } from './binds';

/** A table's binds by key name, for reading at a glance. */
const byName = (binds: Iterable<readonly [number, string]>) =>
  Object.fromEntries([...binds].map(([key, command]) => [keyToString(key), command]));

describe('defaultBinds', () => {
  it("binds the port's keys to Q3's commands, and the wheel as pak0's default.cfg does", () => {
    expect(byName(defaultBinds(true))).toEqual({
      w: '+forward',
      s: '+back',
      a: '+moveleft',
      d: '+moveright',
      SPACE: '+moveup',
      SHIFT: '+movedown',
      MOUSE1: '+attack',
      TAB: '+scores',
      ENTER: '+button2',
      MWHEELUP: 'weapprev',
      MWHEELDOWN: 'weapnext',
      f: '+button5',
      1: 'weapon 1',
      2: 'weapon 2',
      3: 'weapon 3',
      4: 'weapon 4',
      5: 'weapon 5',
      6: 'weapon 6',
      7: 'weapon 7',
      8: 'weapon 8',
      9: 'weapon 9',
      c: 'toggle pcq_drawCollision',
      p: 'viewpos'
    });
  });

  it('leaves C and P unbound without DEBUG_MODE', () => {
    expect(defaultBinds(false).has('c'.charCodeAt(0))).toBe(false);
    expect(defaultBinds(false).has('p'.charCodeAt(0))).toBe(false);
  });
});

describe('bindWarning', () => {
  it('warns of Ctrl and Meta, whose shortcuts a browser keeps', () => {
    for (const key of [K.CTRL, K.SUPER, K.COMMAND]) {
      expect(bindWarning(key), keyToString(key)).toContain('W can close the tab');
    }
    expect(bindWarning(K.CTRL)).toMatch(/^CTRL: a browser keeps Ctrl\+W/);
  });

  it('warns of no other key, and of none in the desktop shell', () => {
    expect(bindWarning(K.SHIFT)).toBeNull();
    expect(bindWarning('w'.charCodeAt(0))).toBeNull();
    expect(bindWarning(K.CTRL, true)).toBeNull();
  });
});

describe('BindTable', () => {
  it('binds, rebinds and unbinds a key, announcing each change', () => {
    const table = new BindTable([]);
    const changed = vi.fn();
    table.onChange(changed);

    table.set(K.CTRL, '+attack');
    table.set(K.CTRL, '+attack');
    expect(table.get(K.CTRL)).toBe('+attack');
    table.set(K.CTRL, '');
    expect(table.get(K.CTRL)).toBeUndefined();
    table.set(K.CTRL, '');
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('clears every bind for unbindall', () => {
    const table = new BindTable();
    table.clear();
    expect(table.entries()).toEqual([]);
  });

  it('lists the keys a command is bound to, in key order and in any case', () => {
    const table = new BindTable([
      [K.UPARROW, '+forward'],
      ['w'.charCodeAt(0), '+FORWARD'],
      [K.SPACE, '+moveup']
    ]);
    expect(table.keysFor('+forward')).toEqual(['w'.charCodeAt(0), K.UPARROW]);
  });
});
