import { K } from '../formats/q3-keys';
import type { EditMode } from './edit-field';
import type { ColoredText, KeyResult, Menu, MenuItem } from './menu';

/**
 * The widgets the pages are made of: q3_ui's radio button, spin control, slider, field and
 * scrolled list (`ui_qmenu.c`, `ui_mfield.c`). Each stands for a setting through what it is given
 * to read and write it, so it always shows the value in force. Engine-free; `view/menu.ts` hands
 * them their keys.
 *
 * A click uses a widget only with the pointer over it, as q3_ui's radio button asks. Its spin
 * control and slider take a click anywhere while they have the cursor.
 */

/** What every widget shows besides its value. */
export interface WidgetOptions {
  label: string;
  /** Whether this tab's address set it. */
  marked?: () => boolean;
  /** The line under the page while the cursor is on it. */
  status?: () => string | undefined;
}

/** What a radio button reads. */
const ON_OFF: readonly string[] = ['on', 'off'];

const isLeft = (key: number) => key === K.LEFTARROW || key === K.KP_LEFTARROW;
const isRight = (key: number) => key === K.RIGHTARROW || key === K.KP_RIGHTARROW;

/** A number as a slider shows it: whole, or to a tenth. */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * `MTYPE_RADIOBUTTON` (`RadioButton_Key`, `ui_qmenu.c:455–482`): on or off, flipped by Enter, a
 * click, left or right, with the move sound. It reads as Q3 draws it, "on" or "off".
 */
export function radioButton(
  options: WidgetOptions & {
    get(): boolean;
    set(on: boolean): void;
    /** Whether the row is hidden, read afresh each frame. */
    hidden?: () => boolean;
    /** Whether the row is greyed, read afresh each frame. */
    grayed?: () => boolean;
  }
): MenuItem {
  return {
    label: options.label,
    get value() {
      return options.get() ? ON_OFF[0] : ON_OFF[1];
    },
    values: ON_OFF,
    get hidden() {
      return options.hidden?.() ?? false;
    },
    get grayed() {
      return options.grayed?.() ?? false;
    },
    get marked() {
      return options.marked?.() ?? false;
    },
    get status() {
      return options.status?.();
    },
    key(key, pointer) {
      const flips =
        key === K.MOUSE1
          ? pointer !== undefined
          : isLeft(key) ||
            isRight(key) ||
            key === K.ENTER ||
            key === K.KP_ENTER ||
            (key >= K.JOY1 && key < K.JOY1 + 4);
      if (!flips) return null;
      options.set(!options.get());
      return 'move';
    }
  };
}

/**
 * `MTYPE_SPINCONTROL` (`SpinControl_Key`, `ui_qmenu.c:794–823`): one of a list, the next with
 * right or a click and the one before with left, round the list, with the move sound.
 */
export function spinControl(
  options: WidgetOptions & {
    /**
     * The choices' names, in the order the control goes through them. A function for a list that
     * depends on the match, which Q3 swaps into `itemnames` as its page is built.
     */
    names: readonly string[] | (() => readonly string[]);
    /** The choice in force, by its place among `names`. */
    get(): number;
    /** Choose by place among `names`. */
    set(index: number): void;
    /** A picture drawn for a choice, by its shader's name. */
    icon?(index: number): string | undefined;
    /** A colour drawn for a choice. */
    swatch?(index: number): readonly [number, number, number];
    /** Whether the row is greyed, read afresh each frame; a greyed row never takes the cursor. */
    grayed?: () => boolean;
    /** Whether the row is hidden, read afresh each frame, as a slot's side is while it is closed. */
    hidden?: () => boolean;
    /** Its place by name, for a page placed that way. */
    place?: string;
  }
): MenuItem {
  const given = options.names;
  const names = typeof given === 'function' ? given : () => given;
  return {
    label: options.label,
    place: options.place,
    get value() {
      return names()[options.get()];
    },
    get values() {
      return names();
    },
    get grayed() {
      return options.grayed?.() ?? false;
    },
    get hidden() {
      return options.hidden?.() ?? false;
    },
    get icon() {
      return options.icon?.(options.get());
    },
    get swatch() {
      return options.swatch?.(options.get());
    },
    get marked() {
      return options.marked?.() ?? false;
    },
    get status() {
      return options.status?.();
    },
    key(key, pointer) {
      const forward = isRight(key) || (key === K.MOUSE1 && pointer !== undefined);
      if (!forward && !isLeft(key)) return null;
      const list = names();
      options.set((options.get() + (forward ? 1 : -1) + list.length) % list.length);
      return 'move';
    }
  };
}

/**
 * `MTYPE_SLIDER` (`Slider_Key`, `ui_qmenu.c:566–621`): a number between two ends. Left and right
 * step it by one, with the move sound, and buzz at an end. A click puts it where the pointer is
 * along the bar, held to its ends. It reads as its number, to a tenth.
 *
 * The port's own besides, as Q3's sliders show no number and take no typing (`Slider_Draw`,
 * `ui_qmenu.c:629–685`): a number typed in the value's place.
 * - A digit or a point, with the cursor on the slider, starts one, drawn with a caret as a field's
 *   text is. A click on the number starts one holding the value, as a field holds its text.
 * - It takes digits and one point, with one place after it, and no more whole digits than the top
 *   end has. It buzzes at anything else, as Q3's numbers-only field does at a letter
 *   (`MenuField_Key`, `ui_mfield.c:423–424`).
 * - Backspace takes the last character back.
 * - Enter, or the cursor leaving, applies it, held to the ends. Nothing, or a point alone, leaves
 *   the value as it was.
 * - Escape or the right button puts the old value back. Left and right apply it, then step, and a
 *   click on the bar sets the value there instead.
 */
export function slider(
  options: WidgetOptions & { min: number; max: number; get(): number; set(value: number): void }
): MenuItem {
  const { min, max } = options;
  /** The number being typed, or `null` while none is. */
  let typed: string | null = null;
  const wholeDigits = String(Math.trunc(max)).length;
  const apply = () => {
    const number = typed === null ? NaN : Number.parseFloat(typed);
    typed = null;
    if (!Number.isNaN(number)) options.set(Math.min(max, Math.max(min, number)));
  };
  /** Whether a number typed so far can take this character next. */
  const takes = (text: string, ch: string): boolean => {
    const point = text.indexOf('.');
    if (ch === '.') return point < 0;
    if (ch < '0' || ch > '9') return false;
    return point < 0 ? text.length < wholeDigits : text.length - point < 2;
  };
  return {
    label: options.label,
    get value() {
      return typed ?? formatNumber(options.get());
    },
    get caret() {
      return typed?.length;
    },
    get editing() {
      return typed !== null;
    },
    get slider() {
      return Math.min(1, Math.max(0, (options.get() - min) / (max - min)));
    },
    get marked() {
      return options.marked?.() ?? false;
    },
    get status() {
      return options.status?.();
    },
    key(key, pointer) {
      // A click on the number opens it holding the value, or leaves the one being typed as it is.
      if (key === K.MOUSE1 && pointer?.number) {
        if (typed === null) typed = formatNumber(options.get());
        return 'silent';
      }
      if (typed !== null) {
        switch (key) {
          case K.ENTER:
          case K.KP_ENTER:
            apply();
            return 'move';
          case K.BACKSPACE:
            typed = typed.slice(0, -1);
            return 'silent';
          case K.ESCAPE:
          case K.MOUSE2:
            typed = null;
            return 'silent';
          case K.MOUSE1:
            if (pointer?.x !== undefined) typed = null;
            break;
          default:
            // Up, down and Tab are the menu's, and its cursor leaving applies the number.
            if (isLeft(key) || isRight(key)) apply();
        }
      }
      const value = options.get();
      if (key === K.MOUSE1) {
        if (pointer?.x === undefined) return null;
        const placed = min + Math.min(1, Math.max(0, pointer.x)) * (max - min);
        if (placed === value) return 'silent';
        options.set(placed);
        return 'move';
      }
      const step = isRight(key) ? 1 : isLeft(key) ? -1 : 0;
      if (step === 0) return null;
      if (step < 0 ? value <= min : value >= max) return 'buzz';
      // Q3 steps a value between whole ones past an end; the port stops it there.
      options.set(Math.min(max, Math.max(min, value + step)));
      return 'move';
    },
    char(ch) {
      if (ch.length !== 1 || ch < ' ') return null;
      const text = typed ?? '';
      if (!takes(text, ch)) return 'buzz';
      typed = text + ch;
      return 'silent';
    },
    blur() {
      apply();
    }
  };
}

/**
 * `MTYPE_FIELD` (`MenuField_Key`, `MField_KeyDownEvent`, `MField_CharEvent`; `ui_mfield.c:139–278`):
 * a line of text, edited where its cursor is.
 * - A printable ASCII character goes in at the cursor, while there are fewer than `maxchars`.
 * - Backspace takes the character before the cursor, and Delete the one at it.
 * - Left, right, Home and End move the cursor. Insert swaps putting a character in for writing
 *   over the one at the cursor, for every field sharing its mode, as Q3's one
 *   `key_overstrikeMode` is every field's.
 * - Enter goes on to the next item, as Tab does.
 *
 * Its text is read and written through what it is given, at every edit. Given colours for its text,
 * it hands them on, to be drawn while the cursor is off it, as the Player page draws a name's colour
 * codes. It hands on its whole text and its `widthInChars`, and the menu draws the text scrolled
 * within that room to keep the cursor shown, where Q3 scrolls it by characters (`MField_Draw`,
 * `ui_mfield.c:33–60`): the port's face is proportional. Text pasted goes in a character at a
 * time, the first 63 of it, as `MField_Paste` reads its 64-byte buffer, past a numbers-only
 * field's check. Q3's other Ctrl chords are left out.
 */
export function textField(
  options: WidgetOptions & {
    maxchars: number;
    get(): string;
    set(text: string): void;
    /** Its text in colours, drawn in its place while the cursor is off the field. */
    colored?(text: string): readonly ColoredText[];
    /**
     * `QMF_NUMBERSONLY` (`MenuField_Key`, `ui_mfield.c:423–424`): a letter buzzes instead of
     * going in. Only a letter — Quake 3 asks `Q_isalpha`, so punctuation still reaches the field
     * and it is the cvar's own reading that refuses it.
     */
    numbersOnly?: boolean;
    /** `widthInChars`: the room it keeps for its text, in q3_ui's cells. */
    widthInChars: number;
    /** Insert or overstrike, which every field shares. */
    mode: EditMode;
  }
): MenuItem {
  let cursor = options.get().length;
  const { mode } = options;
  /** The cursor, kept within the text as it is now, which the console may have shortened. */
  const place = () => Math.min(cursor, options.get().length);
  /** `MField_CharEvent`: a printable character in at the cursor, or over the one there. */
  const insert = (ch: string) => {
    const code = ch.charCodeAt(0);
    if (ch.length !== 1 || code < 32 || code > 126) return false;
    const text = options.get();
    cursor = place();
    if (mode.overstrike ? cursor >= options.maxchars : text.length >= options.maxchars) return true;
    options.set(text.slice(0, cursor) + ch + text.slice(mode.overstrike ? cursor + 1 : cursor));
    // Q3's cursor stops on a full field's last place.
    if (cursor < options.maxchars - 1) cursor++;
    return true;
  };
  return {
    label: options.label,
    widthInChars: options.widthInChars,
    get value() {
      return options.get();
    },
    get caret() {
      return place();
    },
    get colored() {
      return options.colored?.(options.get());
    },
    get marked() {
      return options.marked?.() ?? false;
    },
    get status() {
      return options.status?.();
    },
    key(key) {
      const text = options.get();
      cursor = place();
      switch (key) {
        // "have enter go to next cursor point" (`ui_mfield.c`).
        case K.ENTER:
        case K.KP_ENTER:
          return K.TAB;
        // Q3's backspace is a char event, ctrl-h; a browser gives it only as a key.
        case K.BACKSPACE:
          if (cursor > 0) {
            options.set(text.slice(0, cursor - 1) + text.slice(cursor));
            cursor--;
          }
          return 'silent';
        case K.DEL:
        case K.KP_DEL:
          if (cursor < text.length) options.set(text.slice(0, cursor) + text.slice(cursor + 1));
          return 'silent';
        case K.LEFTARROW:
        case K.KP_LEFTARROW:
          cursor = Math.max(0, cursor - 1);
          return 'silent';
        case K.RIGHTARROW:
        case K.KP_RIGHTARROW:
          cursor = Math.min(text.length, cursor + 1);
          return 'silent';
        case K.HOME:
        case K.KP_HOME:
          cursor = 0;
          return 'silent';
        case K.END:
        case K.KP_END:
          cursor = text.length;
          return 'silent';
        case K.INS:
        case K.KP_INS:
          mode.overstrike = !mode.overstrike;
          return 'silent';
        default:
          return null;
      }
    },
    char(ch) {
      if (options.numbersOnly && ch.length === 1 && /[a-z]/i.test(ch)) return 'buzz';
      return insert(ch) ? 'silent' : null;
    },
    paste(text) {
      for (const ch of text.slice(0, PASTE_LENGTH)) insert(ch);
    }
  };
}

/** What `MField_Paste` takes of the clipboard: its 64-byte buffer, less the NUL. */
const PASTE_LENGTH = 63;

/** The glyphs a list's arrows read, where q3_ui draws its arrows' art (`arrows_vert_0`). */
export const LIST_ARROWS = { up: '▲', down: '▼' } as const;

/** A list's place: the row chosen, and the first row its window shows (`curvalue`, `top`). */
export interface ListState {
  curvalue: number;
  top: number;
}

/**
 * `MTYPE_SCROLLLIST` of one column (`ScrollList_Key`, `ui_qmenu.c:908–1226`): rows in a window
 * `height` long, one of them chosen. The chosen row is apart from the menu's cursor, which rests on
 * the list as a whole.
 * - Up and Down choose the next row, the window following, and buzz at an end. Home and End go to
 *   the ends, and PgUp and PgDn a window less one at a time.
 * - The wheel scrolls the window three rows, or one in a window under six, the choice staying,
 *   silently.
 * - A printable key chooses the next row whose first character it is, round the end of the list,
 *   the window brought to it as a Windows list box does.
 * - A click chooses the row under the pointer; a click past the last row is taken silently.
 * - Left and right are taken silently, and Enter activates it, as any item.
 *
 * A key that chooses a row tells `changed`, and makes the move sound only then.
 */
export function scrollList(options: {
  /** The rows the window shows. */
  height: number;
  state: ListState;
  /** How many rows there are (`numitems`). */
  count(): number;
  /** A row's cells, by its place in the list. */
  cells(index: number): readonly ColoredText[];
  /** What a typed key is matched against: the row's first character (`itemnames[j][0]`). */
  initial(index: number): string;
  /** The chosen row moved, or the window did (`QM_GOTFOCUS`). */
  changed?(): void;
  /** Whether the list is greyed, read afresh each frame. */
  grayed?: () => boolean;
  /** Its place by name, for a page placed that way. */
  place?: string;
}): MenuItem {
  const { height, state } = options;
  const scroll = height < 6 ? 1 : 3;
  /** The callback, and the move sound; or, with none to tell, silence. */
  const moved = (old: number): KeyResult => {
    if (old === state.curvalue || !options.changed) return 'silent';
    options.changed();
    return 'move';
  };
  /** A move to an end: the move sound where it went somewhere, else the buzz. */
  const toEnd = (old: number): KeyResult => {
    if (old === state.curvalue || !options.changed) return 'buzz';
    options.changed();
    return 'move';
  };
  const told = () => options.changed?.();
  return {
    label: '',
    place: options.place,
    get list() {
      const count = options.count();
      const rows: (readonly ColoredText[])[] = [];
      for (let i = state.top; i < state.top + height && i < count; i++) rows.push(options.cells(i));
      const selected = state.curvalue - state.top;
      return { rows, selected: selected >= 0 && selected < rows.length ? selected : -1 };
    },
    get grayed() {
      return options.grayed?.() ?? false;
    },
    // Enter only sounds: the list's callback takes nothing but a new row (`ui_servers2.c:1239`).
    activate: () => {},
    key(key, pointer) {
      const count = options.count();
      const old = state.curvalue;
      switch (key) {
        case K.MOUSE1: {
          if (pointer === undefined) return null;
          const row = pointer.y === undefined ? -1 : Math.floor(pointer.y * height);
          if (row >= 0 && row < height && state.top + row < count) {
            state.curvalue = state.top + row;
            return moved(old);
          }
          // Absorbed, silently.
          return 'silent';
        }
        case K.HOME:
        case K.KP_HOME:
          state.curvalue = 0;
          state.top = 0;
          return toEnd(old);
        case K.END:
        case K.KP_END:
          state.curvalue = Math.max(0, count - 1);
          state.top = Math.max(0, state.curvalue - (height - 1));
          return toEnd(old);
        case K.PGUP:
        case K.KP_PGUP:
          if (state.curvalue <= 0) return 'buzz';
          state.curvalue = Math.max(0, state.curvalue - (height - 1));
          state.top = state.curvalue;
          told();
          return 'move';
        case K.PGDN:
        case K.KP_PGDN:
          if (state.curvalue >= count - 1) return 'buzz';
          state.curvalue = Math.min(count - 1, state.curvalue + (height - 1));
          state.top = Math.max(0, state.curvalue - (height - 1));
          told();
          return 'move';
        case K.MWHEELUP:
          if (state.top <= 0) return 'buzz';
          state.top = Math.max(0, state.top - scroll);
          told();
          return 'silent';
        case K.MWHEELDOWN:
          if (state.top >= count - height) return 'buzz';
          state.top = Math.min(count - height, state.top + scroll);
          told();
          return 'silent';
        case K.UPARROW:
        case K.KP_UPARROW:
          if (state.curvalue <= 0) return 'buzz';
          state.curvalue--;
          if (state.curvalue < state.top) state.top--;
          told();
          return 'move';
        case K.DOWNARROW:
        case K.KP_DOWNARROW:
          if (state.curvalue >= count - 1) return 'buzz';
          state.curvalue++;
          if (state.curvalue >= state.top + height) state.top++;
          told();
          return 'move';
        case K.LEFTARROW:
        case K.KP_LEFTARROW:
        case K.RIGHTARROW:
        case K.KP_RIGHTARROW:
          return 'silent';
      }
      // The next row starting with a printable key, without regard to case.
      if (key < 32 || key > 126) return null;
      const typed = String.fromCharCode(key).toLowerCase();
      for (let i = 1; i <= count; i++) {
        const j = (state.curvalue + i) % count;
        if (options.initial(j).toLowerCase() !== typed) continue;
        if (j < state.top) state.top = j;
        else if (j > state.top + height - 1) state.top = j + 1 - height;
        if (state.curvalue === j) return 'buzz';
        state.curvalue = j;
        told();
        return 'move';
      }
      return 'buzz';
    }
  };
}

/**
 * A tab: one of a page's sections, in the strip across its head, as the System pages have
 * (`ui_video.c:1073–1103`). The one shown does nothing, as Q3's does.
 */
export function tab(label: string, current: boolean, open: () => void): MenuItem {
  return { label, tab: current ? 'current' : 'other', activate: current ? () => {} : open };
}

/** BACK, as Q3's corner button goes back a page. */
export function back(menu: Menu): MenuItem {
  return { label: 'BACK', role: 'back', activate: () => menu.pop() };
}
