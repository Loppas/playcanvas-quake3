import { comParse, parseCursor } from '../formats/com-parse';
import { hexToInt, K, stringToKey } from '../formats/q3-keys';

/**
 * The browser's keys and buttons as Q3 numbers them: what
 * `IN_TranslateSDLToQ3Key` does for SDL's (`sdl_input.c:196–322`). DOM-free: it takes the
 * event's strings and numbers.
 *
 * A key is found by `KeyboardEvent.code`, its place on the keyboard. SDL names a printable key by
 * the character it types on the player's layout, and so does this where the browser says what
 * that is (the Keyboard API's layout map); elsewhere it is the US layout's, which the codes are
 * named after. The number row is always its digits, as ioq3 makes it (`sdl_input.c:200–210`).
 */

/** Each printable key's character on a US layout, by its code, letters and digits aside. */
const PRINTABLE = new Map([
  ['Minus', '-'],
  ['Equal', '='],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backslash', '\\'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['Backquote', '`'],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/']
]);

/** `MAX_CONSOLE_KEYS` (`sdl_input.c:95`): the most words `cl_consoleKeys` is read for. */
const MAX_CONSOLE_KEYS = 16;

/** The keys that type nothing, by their codes (`sdl_input.c:218–296`). */
const NAMED = new Map<string, number>([
  ['Space', K.SPACE],
  ['Enter', K.ENTER],
  ['NumpadEnter', K.KP_ENTER],
  ['Tab', K.TAB],
  ['Escape', K.ESCAPE],
  ['Backspace', K.BACKSPACE],
  ['Delete', K.DEL],
  ['Insert', K.INS],
  ['Home', K.HOME],
  ['End', K.END],
  ['PageUp', K.PGUP],
  ['PageDown', K.PGDN],
  ['ArrowUp', K.UPARROW],
  ['ArrowDown', K.DOWNARROW],
  ['ArrowLeft', K.LEFTARROW],
  ['ArrowRight', K.RIGHTARROW],
  ['ShiftLeft', K.SHIFT],
  ['ShiftRight', K.SHIFT],
  ['ControlLeft', K.CTRL],
  ['ControlRight', K.CTRL],
  ['AltLeft', K.ALT],
  ['AltRight', K.ALT],
  ['CapsLock', K.CAPSLOCK],
  ['ScrollLock', K.SCROLLOCK],
  ['NumLock', K.KP_NUMLOCK],
  ['Pause', K.PAUSE],
  ['PrintScreen', K.PRINT],
  ['ContextMenu', K.MENU],
  ['Power', K.POWER],
  ['Help', K.HELP],
  ['Undo', K.UNDO],
  // The keypad by its keys, whatever Num Lock says, as SDL's keysyms have it.
  ['Numpad0', K.KP_INS],
  ['Numpad1', K.KP_END],
  ['Numpad2', K.KP_DOWNARROW],
  ['Numpad3', K.KP_PGDN],
  ['Numpad4', K.KP_LEFTARROW],
  ['Numpad5', K.KP_5],
  ['Numpad6', K.KP_RIGHTARROW],
  ['Numpad7', K.KP_HOME],
  ['Numpad8', K.KP_UPARROW],
  ['Numpad9', K.KP_PGUP],
  ['NumpadDecimal', K.KP_DEL],
  ['NumpadDivide', K.KP_SLASH],
  ['NumpadMultiply', K.KP_STAR],
  ['NumpadSubtract', K.KP_MINUS],
  ['NumpadAdd', K.KP_PLUS]
]);

/**
 * A key, by its `KeyboardEvent.code`, as Q3 numbers it.
 *
 * @param layout - The Keyboard API's layout map: the character each code types on the player's
 *   layout, where the browser gives one.
 * @param apple - On a Mac, where Q3 names the Command key `COMMAND` rather than `WINDOWS`.
 * @returns The key, or `null` for one Q3 has no number for.
 */
export function keyForCode(code: string, layout?: ReadonlyMap<string, string>, apple = false): number | null {
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1].charCodeAt(0);

  // A printable ASCII character is the key's own number, lowercased as Q3 numbers keys.
  const typed = layout?.get(code);
  if (typed !== undefined && /^[!-~]$/.test(typed)) return typed.toLowerCase().charCodeAt(0);
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase().charCodeAt(0);
  const printable = PRINTABLE.get(code);
  if (printable !== undefined) return printable.charCodeAt(0);

  const f = /^F(\d+)$/.exec(code);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 15) return K.F1 + Number(f[1]) - 1;
  if (code === 'MetaLeft' || code === 'MetaRight') return apple ? K.COMMAND : K.SUPER;
  return NAMED.get(code) ?? null;
}

/**
 * `IN_IsConsoleKey` (`sdl_input.c:106–189`): whether a key, or a character typed, toggles the
 * console, by `cl_consoleKeys`. Its words are cut as `COM_Parse` cuts them, up to 16: a `0x` code
 * above 0 names a character, and any other word a key, as `bind` names one. A word that names no
 * key counts for nothing.
 *
 * @param consoleKeys - `cl_consoleKeys`.
 * @param key - The key, or 0 to ask of a character alone.
 * @param character - The character's code, or 0 to ask of a key alone.
 */
export function isConsoleKey(consoleKeys: string, key: number, character: number): boolean {
  // "If the character is the same as the key, prefer the character"
  if (key === character) key = 0;
  const cursor = parseCursor(consoleKeys);
  for (let read = 0; read < MAX_CONSOLE_KEYS; ) {
    const word = comParse(cursor);
    if (word === '') break;
    const code = hexToInt(word);
    if (code > 0) {
      if (code === character) return true;
    } else {
      const named = stringToKey(word);
      if (named <= 0) continue;
      if (key !== 0 && named === key) return true;
    }
    read++;
  }
  return false;
}

/**
 * A mouse button, by `MouseEvent.button`, as Q3 numbers it (`sdl_input.c:1128–1136`): left
 * `MOUSE1`, right `MOUSE2`, middle `MOUSE3`, and back and forward `MOUSE4` and `MOUSE5`.
 *
 * @returns The key, or `null` for no button.
 */
export function keyForButton(button: number): number | null {
  switch (button) {
    case 0:
      return K.MOUSE1;
    case 1:
      return K.MOUSE3;
    case 2:
      return K.MOUSE2;
    case 3:
      return K.MOUSE4;
    case 4:
      return K.MOUSE5;
    default:
      return button > 4 ? K.AUX1 + ((button - 3) % 16) : null;
  }
}

/**
 * The wheel, by a turn's `WheelEvent` delta, as the key Q3 presses and lets go for each turn of it
 * (`sdl_input.c:1143–1152`): up, away from the player, is `MWHEELUP`.
 *
 * @returns The key, or `null` for a turn of none.
 */
export function keyForWheel(delta: number): number | null {
  if (delta < 0) return K.MWHEELUP;
  if (delta > 0) return K.MWHEELDOWN;
  return null;
}
