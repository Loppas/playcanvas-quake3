import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import type { MenuItem } from './menu';
import {
  radioButton,
  scrollList,
  slider,
  spinControl,
  tab,
  textField,
  type ListState
} from './menu-widgets';

/** q3_ui's widgets, each over a value of its own. */

describe('radioButton (RadioButton_Key)', () => {
  it('flips on Enter, left, right and a click over it, with the move sound, and reads on or off', () => {
    let on = false;
    const item = radioButton({ label: 'Draw FPS', get: () => on, set: (value) => (on = value) });
    expect(item.value).toBe('off');
    expect([K.ENTER, K.LEFTARROW, K.RIGHTARROW].map((key) => item.key!(key))).toEqual(['move', 'move', 'move']);
    expect(item.value).toBe('on');
    expect(item.key!(K.MOUSE1, {})).toBe('move');
    expect(on).toBe(false);
    // Both, for its hit box.
    expect(item.values).toEqual(['on', 'off']);
  });

  it('takes no click with the pointer elsewhere, and no other key', () => {
    let on = false;
    const item = radioButton({ label: 'Draw FPS', get: () => on, set: (value) => (on = value) });
    expect(item.key!(K.MOUSE1)).toBeNull();
    expect(item.key!(K.UPARROW)).toBeNull();
    expect(on).toBe(false);
  });

  it('shows the mark and the line it is given', () => {
    const item = radioButton({
      label: 'Draw FPS',
      get: () => true,
      set: () => {},
      marked: () => true,
      status: () => 'Set by the address'
    });
    expect([item.marked, item.status]).toEqual([true, 'Set by the address']);
  });
});

describe('spinControl (SpinControl_Key)', () => {
  const names = ['disabled', 'CorkScrew', 'Quake III', 'Quake II CTF'];

  it('goes on with right or a click over it, and back with left, round the list', () => {
    let at = 3;
    const item = spinControl({ label: 'Offhand grapple', names, get: () => at, set: (index) => (at = index) });
    expect(item.value).toBe('Quake II CTF');
    expect(item.key!(K.RIGHTARROW)).toBe('move');
    expect(at).toBe(0);
    item.key!(K.LEFTARROW);
    expect(at).toBe(3);
    item.key!(K.MOUSE1, { x: 0.9 });
    expect(at).toBe(0);
    expect(item.key!(K.MOUSE1)).toBeNull();
    expect(item.key!(K.ENTER)).toBeNull();
  });

  it('carries every choice it goes through, for its hit box, as the list is now', () => {
    let list = ['Blue', 'Red'];
    const item = spinControl({ label: 'Team', names: () => list, get: () => 0, set: () => {} });
    expect(item.values).toEqual(['Blue', 'Red']);
    list = ['Free', 'Blue', 'Red'];
    expect(item.values).toEqual(['Free', 'Blue', 'Red']);
  });

  it('draws the picture it is given for a choice', () => {
    let at = 1;
    const item = spinControl({
      label: 'Crosshair',
      names: ['none', 'b'],
      get: () => at,
      set: (index) => (at = index),
      icon: (index) => (index > 0 ? 'gfx/2d/crosshairb' : undefined)
    });
    expect(item.icon).toBe('gfx/2d/crosshairb');
    item.key!(K.RIGHTARROW);
    expect(item.icon).toBeUndefined();
  });

  it('hides itself as it is told to, afresh each time, and carries its place', () => {
    let closed = false;
    const item = spinControl({
      label: '',
      place: 'team 3',
      names: ['Blue', 'Red'],
      get: () => 0,
      set: () => {},
      hidden: () => closed
    });
    expect(item.place).toBe('team 3');
    expect(item.hidden).toBe(false);
    closed = true;
    expect(item.hidden).toBe(true);
  });
});

describe('spinControl, drawn as colours', () => {
  it('draws the colour it is given for a choice', () => {
    let at = 0;
    const item = spinControl({
      label: 'Effects',
      names: ['red', 'yellow'],
      get: () => at,
      set: (index) => (at = index),
      swatch: (index) => (index === 0 ? [1, 0, 0] : [1, 1, 0])
    });
    expect(item.swatch).toEqual([1, 0, 0]);
    item.key!(K.RIGHTARROW);
    expect(item.swatch).toEqual([1, 1, 0]);
  });
});

describe('textField (MField)', () => {
  function field(start = '', maxchars = 5, mode = { overstrike: false }) {
    let text = start;
    const item = textField({
      label: 'Name',
      maxchars,
      widthInChars: maxchars,
      get: () => text,
      set: (value) => (text = value),
      mode
    });
    return { item, text: () => text };
  }
  const type = (item: MenuItem, chars: string) => {
    for (const ch of chars) item.char!(ch);
  };

  it("puts characters in at the cursor, up to maxchars, with Q3's cursor stopping on the last place", () => {
    const { item, text } = field();
    type(item, 'Sarge!!');
    expect([text(), item.caret]).toEqual(['Sarge', 4]);
    item.key!(K.HOME);
    type(item, 'x');
    expect(text()).toBe('Sarge');
  });

  it('takes printable ASCII only', () => {
    const { item, text } = field();
    expect(item.char!('\t')).toBeNull();
    expect(item.char!('é')).toBeNull();
    expect(item.char!(' ')).toBe('silent');
    expect(text()).toBe(' ');
  });

  it('moves the cursor, and takes the character before it or at it (MField_KeyDownEvent)', () => {
    const { item, text } = field('abcd', 20);
    expect(item.caret).toBe(4);
    item.key!(K.LEFTARROW);
    item.key!(K.LEFTARROW);
    item.key!(K.BACKSPACE);
    item.key!(K.DEL);
    expect([text(), item.caret]).toEqual(['ad', 1]);
    item.key!(K.END);
    expect(item.caret).toBe(2);
    item.key!(K.HOME);
    type(item, 'x');
    expect(text()).toBe('xad');
  });

  it('writes over the character at the cursor after Insert', () => {
    const { item, text } = field('abc', 20);
    item.key!(K.HOME);
    item.key!(K.INS);
    type(item, 'xy');
    expect(text()).toBe('xyc');
  });

  it('shares insert and overstrike with every field given its mode, as Q3 does', () => {
    const mode = { overstrike: false };
    const name = field('abc', 20, mode);
    const port = field('123', 20, mode);
    name.item.key!(K.INS);
    expect(mode.overstrike).toBe(true);
    port.item.key!(K.HOME);
    type(port.item, '9');
    expect(port.text()).toBe('923');
    mode.overstrike = false;
    name.item.key!(K.HOME);
    type(name.item, 'x');
    expect(name.text()).toBe('xabc');
  });

  it("passes by the control characters a key types, Backspace's among them", () => {
    const { item, text } = field('abc', 20);
    for (const ch of '\b\x01\x03\x05\x16') expect(item.char!(ch)).toBeNull();
    expect(text()).toBe('abc');
  });

  it('goes on to the next item on Enter, as Tab does, and leaves a letter to its character', () => {
    const { item } = field();
    expect(item.key!(K.ENTER)).toBe(K.TAB);
    expect(item.key!('a'.charCodeAt(0))).toBeNull();
  });

  it('hands on its text in the colours it is given, as the text is now', () => {
    let text = 'a';
    const item = textField({
      label: 'Name',
      maxchars: 20,
      widthInChars: 20,
      get: () => text,
      set: (value) => (text = value),
      colored: (value) => [{ text: value.toUpperCase(), color: [1, 0, 0] }],
      mode: { overstrike: false }
    });
    expect(item.colored).toEqual([{ text: 'A', color: [1, 0, 0] }]);
    item.char!('b');
    expect(item.colored).toEqual([{ text: 'AB', color: [1, 0, 0] }]);
    expect(field().item.colored).toBeUndefined();
  });

  it('hands on its whole text, its cursor in it, and its width for the menu to scroll in', () => {
    let text = '';
    const item = textField({
      label: 'Hostname',
      maxchars: 20,
      widthInChars: 5,
      get: () => text,
      set: (value) => (text = value),
      mode: { overstrike: false }
    });
    const shown = () => [item.value, item.caret];
    type(item, 'abcdefgh');
    expect(shown()).toEqual(['abcdefgh', 8]);
    expect(item.widthInChars).toBe(5);
    item.key!(K.HOME);
    item.key!(K.RIGHTARROW);
    expect(shown()).toEqual(['abcdefgh', 1]);
    // A text shortened under the cursor keeps the cursor within it.
    item.key!(K.END);
    text = 'ab';
    expect(shown()).toEqual(['ab', 2]);
  });

  it('takes a paste at the cursor, its first 63 characters, numbers or not (MField_Paste)', () => {
    let text = '';
    const item = textField({
      label: 'Port',
      maxchars: 80,
      widthInChars: 6,
      numbersOnly: true,
      get: () => text,
      set: (value) => (text = value),
      mode: { overstrike: false }
    });
    expect(item.char!('x')).toBe('buzz');
    item.paste!('2x\t7\n');
    // Control characters go nowhere, as MField_CharEvent drops them.
    expect(text).toBe('2x7');
    item.key!(K.HOME);
    item.paste!('1'.repeat(70));
    expect(text).toBe(`${'1'.repeat(63)}2x7`);
    // A full field takes no more, as typing takes none.
    const { item: full, text: after } = field('abcd');
    full.paste!('xyz');
    expect(after()).toBe('abcdx');
  });
});

describe('scrollList (ScrollList_Key)', () => {
  /** A list of `count` rows, each named by its number, in a window of `height`. */
  function listOf(count: number, height = 4) {
    const state: ListState = { curvalue: 0, top: 0 };
    const changed = vi.fn();
    const names = Array.from({ length: count }, (_, n) => `row ${n}`);
    const item = scrollList({
      height,
      state,
      count: () => names.length,
      cells: (index) => [{ text: names[index] }],
      initial: (index) => names[index].charAt(0),
      changed
    });
    const shown = () => item.list!.rows.map(([cell]) => cell.text);
    return { item, state, changed, names, shown };
  }

  it('shows the rows in its window, the chosen one by its place there', () => {
    const { item, state, shown } = listOf(6);
    expect(shown()).toEqual(['row 0', 'row 1', 'row 2', 'row 3']);
    expect(item.list!.selected).toBe(0);
    state.top = 2;
    expect(shown()).toEqual(['row 2', 'row 3', 'row 4', 'row 5']);
    expect(item.list!.selected).toBe(-1);
  });

  it('chooses the next row with Up and Down, the window following, and buzzes at an end', () => {
    const { item, state, changed } = listOf(6);
    expect(item.key!(K.UPARROW)).toBe('buzz');
    for (let n = 0; n < 5; n++) expect(item.key!(K.DOWNARROW)).toBe('move');
    expect(state).toEqual({ curvalue: 5, top: 2 });
    expect(item.key!(K.KP_DOWNARROW)).toBe('buzz');
    expect(changed).toHaveBeenCalledTimes(5);
    for (let n = 0; n < 4; n++) item.key!(K.UPARROW);
    expect(state).toEqual({ curvalue: 1, top: 1 });
  });

  it('goes a window less one with PgUp and PgDn, and to the ends with Home and End', () => {
    const { item, state } = listOf(10);
    expect(item.key!(K.PGDN)).toBe('move');
    expect(state).toEqual({ curvalue: 3, top: 0 });
    item.key!(K.KP_PGDN);
    item.key!(K.PGDN);
    expect(state).toEqual({ curvalue: 9, top: 6 });
    expect(item.key!(K.PGDN)).toBe('buzz');
    expect(item.key!(K.PGUP)).toBe('move');
    expect(state).toEqual({ curvalue: 6, top: 6 });
    // The window's top goes up to the new choice.
    item.key!(K.KP_PGUP);
    expect(state).toEqual({ curvalue: 3, top: 3 });
    expect(item.key!(K.HOME)).toBe('move');
    expect(state).toEqual({ curvalue: 0, top: 0 });
    expect(item.key!(K.HOME)).toBe('buzz');
    expect(item.key!(K.END)).toBe('move');
    expect(state).toEqual({ curvalue: 9, top: 6 });
    expect(item.key!(K.KP_END)).toBe('buzz');
  });

  it('scrolls the window with the wheel, silently, and leaves the choice where it was', () => {
    const { item, state, changed } = listOf(10);
    expect(item.key!(K.MWHEELUP)).toBe('buzz');
    // A window under six scrolls a row at a time.
    expect(item.key!(K.MWHEELDOWN)).toBe('silent');
    expect(state).toEqual({ curvalue: 0, top: 1 });
    for (let n = 0; n < 5; n++) item.key!(K.MWHEELDOWN);
    expect(state.top).toBe(6);
    expect(item.key!(K.MWHEELDOWN)).toBe('buzz');
    expect(changed).toHaveBeenCalledTimes(6);
    // A window of six or more scrolls three, held to the last window's top.
    const tall = listOf(10, 6);
    tall.item.key!(K.MWHEELDOWN);
    expect(tall.state).toEqual({ curvalue: 0, top: 3 });
    tall.item.key!(K.MWHEELDOWN);
    expect(tall.state.top).toBe(4);
    tall.item.key!(K.MWHEELUP);
    expect(tall.state.top).toBe(1);
  });

  it('chooses the row under a click, and takes one past the last row silently', () => {
    const { item, state, changed, names } = listOf(6);
    expect(item.key!(K.MOUSE1, { y: 0.6 })).toBe('move');
    expect(state.curvalue).toBe(2);
    expect(item.key!(K.MOUSE1, { y: 0.6 })).toBe('silent');
    names.length = 2;
    expect(item.key!(K.MOUSE1, { y: 0.9 })).toBe('silent');
    expect(state.curvalue).toBe(2);
    expect(changed).toHaveBeenCalledOnce();
    // A click with the pointer elsewhere is the menu's.
    expect(item.key!(K.MOUSE1)).toBeNull();
  });

  it('goes to the next row starting with a typed key, round the end, the window following', () => {
    const { item, state, names } = listOf(8);
    names.splice(0, 8, 'alpha', 'bravo', 'able', 'c', 'd', 'e', 'f', 'Axe');
    expect(item.key!('a'.charCodeAt(0))).toBe('move');
    expect(state.curvalue).toBe(2);
    item.key!('a'.charCodeAt(0));
    expect(state).toEqual({ curvalue: 7, top: 4 });
    item.key!('a'.charCodeAt(0));
    expect(state).toEqual({ curvalue: 0, top: 0 });
    expect(item.key!('z'.charCodeAt(0))).toBe('buzz');
  });

  it('takes left and right silently, and leaves Tab and Enter to the menu, Enter sounding', () => {
    const { item } = listOf(3);
    expect(item.key!(K.LEFTARROW)).toBe('silent');
    expect(item.key!(K.RIGHTARROW)).toBe('silent');
    expect(item.key!(K.TAB)).toBeNull();
    expect(item.key!(K.ENTER)).toBeNull();
    expect(item.activate).toBeDefined();
  });

  it('buzzes at every move with no rows', () => {
    const { item, state } = listOf(0);
    const keys = [K.UPARROW, K.DOWNARROW, K.PGUP, K.PGDN, K.HOME, K.END, 'a'.charCodeAt(0)];
    expect(keys.map((key) => item.key!(key))).toEqual(keys.map(() => 'buzz'));
    expect(state).toEqual({ curvalue: 0, top: 0 });
    expect(item.list).toEqual({ rows: [], selected: -1 });
  });
});

describe('slider (Slider_Key)', () => {
  it('steps by one with left and right, and buzzes at an end without moving', () => {
    let value = 9;
    const item = slider({ label: 'Effects volume', min: 0, max: 10, get: () => value, set: (v) => (value = v) });
    expect(item.key!(K.RIGHTARROW)).toBe('move');
    expect(value).toBe(10);
    expect(item.key!(K.RIGHTARROW)).toBe('buzz');
    expect(value).toBe(10);
    value = 0;
    expect(item.key!(K.LEFTARROW)).toBe('buzz');
    expect(value).toBe(0);
  });

  it('stops a step from between whole values at the end, which Q3 steps past', () => {
    let value = 129.5;
    const item = slider({ label: 'Field of view', min: 60, max: 130, get: () => value, set: (v) => (value = v) });
    item.key!(K.RIGHTARROW);
    expect(value).toBe(130);
  });

  it('puts the value where a click lands along the bar, and reads to a tenth', () => {
    let value = 89.2;
    const item = slider({ label: 'Field of view', min: 60, max: 130, get: () => value, set: (v) => (value = v) });
    expect(item.value).toBe('89.2');
    expect(item.slider).toBeCloseTo((89.2 - 60) / 70);
    expect(item.key!(K.MOUSE1, { x: 0.5 })).toBe('move');
    expect(value).toBe(95);
    expect(item.value).toBe('95');
    expect(item.key!(K.MOUSE1, { x: 0.5 })).toBe('silent');
    expect(item.key!(K.MOUSE1, {})).toBeNull();
  });
});

describe('slider, with a number typed in', () => {
  /** A slider over a number of its own, from 60 to 130, typed into a character at a time. */
  function typing(start: number) {
    let value = start;
    const item = slider({ label: 'Field of view', min: 60, max: 130, get: () => value, set: (v) => (value = v) });
    const type = (chars: string) => [...chars].map((ch) => item.char!(ch));
    return { item, type, value: () => value };
  }

  it('shows the number typed in its value, with a caret, and applies it on Enter', () => {
    const { item, type, value } = typing(90);
    expect([item.editing, item.caret]).toEqual([false, undefined]);
    expect(type('105')).toEqual(['silent', 'silent', 'silent']);
    expect([item.value, item.caret, item.editing, value()]).toEqual(['105', 3, true, 90]);
    expect(item.key!(K.ENTER)).toBe('move');
    expect([item.value, item.caret, item.editing, value()]).toEqual(['105', undefined, false, 105]);
  });

  it('takes digits and one point, with one place after it, and buzzes at anything else', () => {
    const { item, type, value } = typing(90);
    // No more whole digits than 130 has.
    expect(type('1234')).toEqual(['silent', 'silent', 'silent', 'buzz']);
    expect(type('.55.')).toEqual(['silent', 'silent', 'buzz', 'buzz']);
    expect(type('a -')).toEqual(['buzz', 'buzz', 'buzz']);
    expect(item.value).toBe('123.5');
    // A key's name is no character, nor is the control character Backspace or a Ctrl chord types.
    expect(item.char!('Enter')).toBeNull();
    expect(['\b', '\x01', '\x1f'].map((ch) => item.char!(ch))).toEqual([null, null, null]);
    item.key!(K.ENTER);
    expect(value()).toBe(123.5);
  });

  it('holds a typed number to the ends, and leaves the value be for no number', () => {
    const { item, type, value } = typing(90);
    type('5');
    item.key!(K.ENTER);
    expect(value()).toBe(60);
    type('999');
    item.key!(K.ENTER);
    expect(value()).toBe(130);
    type('.');
    item.key!(K.ENTER);
    expect(value()).toBe(130);
    type('1');
    item.key!(K.BACKSPACE);
    expect([item.value, item.caret]).toEqual(['', 0]);
    item.key!(K.ENTER);
    expect([value(), item.editing]).toEqual([130, false]);
  });

  it('puts the old value back on Escape or the right button, which are the page’s otherwise', () => {
    const { item, type, value } = typing(90);
    for (const key of [K.ESCAPE, K.MOUSE2]) {
      type('7');
      expect(item.key!(key)).toBe('silent');
      expect([item.value, item.editing, value()]).toEqual(['90', false, 90]);
    }
    expect(item.key!(K.ESCAPE)).toBeNull();
  });

  it('applies the number as the cursor leaves, or before left and right step it', () => {
    const { item, type, value } = typing(90);
    type('100');
    item.blur!();
    expect([value(), item.editing]).toEqual([100, false]);
    type('100');
    expect(item.key!(K.RIGHTARROW)).toBe('move');
    expect(value()).toBe(101);
    // Down is the menu's, whose cursor leaving applies it.
    type('80');
    expect(item.key!(K.DOWNARROW)).toBeNull();
  });

  it('sets the value where a click lands on the bar, over the number typed', () => {
    const { item, type, value } = typing(90);
    type('100');
    // A click off the bar leaves the number be.
    expect(item.key!(K.MOUSE1, {})).toBeNull();
    expect(item.editing).toBe(true);
    expect(item.key!(K.MOUSE1, { x: 0.5 })).toBe('move');
    expect([value(), item.editing]).toEqual([95, false]);
  });

  it('opens its number at a click on it, holding the value, and the bar keeps its click', () => {
    const { item, type, value } = typing(89.2);
    expect(item.key!(K.MOUSE1, { x: 1, number: true })).toBe('silent');
    expect([item.value, item.caret, item.editing, value()]).toEqual(['89.2', 4, true, 89.2]);
    // Its one place is taken, and Backspace makes room.
    expect(type('5')).toEqual(['buzz']);
    for (let i = 0; i < 3; i++) item.key!(K.BACKSPACE);
    type('5');
    // Another click on it leaves the number as it is.
    expect(item.key!(K.MOUSE1, { x: 1, number: true })).toBe('silent');
    expect([item.value, value()]).toEqual(['85', 89.2]);
    item.key!(K.ENTER);
    expect([value(), item.editing]).toEqual([85, false]);
    // At the bar's right end, a click sets the top end, as Q3's does.
    expect(item.key!(K.MOUSE1, { x: 1, number: false })).toBe('move');
    expect(value()).toBe(130);
  });
});

describe('tab', () => {
  it('opens its section, and the one shown does nothing', () => {
    const open = vi.fn();
    tab('SOUND', false, open).activate!();
    const shown = tab('DISPLAY', true, open);
    shown.activate!();
    expect(open).toHaveBeenCalledOnce();
    expect(shown.tab).toBe('current');
  });
});
