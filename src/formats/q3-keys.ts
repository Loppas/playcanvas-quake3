/**
 * Quake 3's key numbers, and the names a config gives them.
 *
 * A key is a number: a printable key is its lowercased ASCII, and the rest count up from 128
 * (`keycodes.h:32–302`). A config names each one as `Key_KeynumToString` writes it: the character
 * itself, a name from `keynames` (`cl_keys.c:56–327`), or a hex code. DOM-free.
 */

/** The key numbers the port names in code, as `keycodes.h` numbers them. */
export const K = {
  TAB: 9,
  ENTER: 13,
  ESCAPE: 27,
  SPACE: 32,
  BACKSPACE: 127,
  COMMAND: 128,
  CAPSLOCK: 129,
  POWER: 130,
  PAUSE: 131,
  UPARROW: 132,
  DOWNARROW: 133,
  LEFTARROW: 134,
  RIGHTARROW: 135,
  ALT: 136,
  CTRL: 137,
  SHIFT: 138,
  INS: 139,
  DEL: 140,
  PGDN: 141,
  PGUP: 142,
  HOME: 143,
  END: 144,
  /** `K_F1`; F2–F15 follow it. */
  F1: 145,
  KP_HOME: 160,
  KP_UPARROW: 161,
  KP_PGUP: 162,
  KP_LEFTARROW: 163,
  KP_5: 164,
  KP_RIGHTARROW: 165,
  KP_END: 166,
  KP_DOWNARROW: 167,
  KP_PGDN: 168,
  KP_ENTER: 169,
  KP_INS: 170,
  KP_DEL: 171,
  KP_SLASH: 172,
  KP_MINUS: 173,
  KP_PLUS: 174,
  KP_NUMLOCK: 175,
  KP_STAR: 176,
  KP_EQUALS: 177,
  MOUSE1: 178,
  MOUSE2: 179,
  MOUSE3: 180,
  MOUSE4: 181,
  MOUSE5: 182,
  MWHEELDOWN: 183,
  MWHEELUP: 184,
  /** `K_JOY1`; JOY2–JOY32 follow it. */
  JOY1: 185,
  /** `K_AUX1`; AUX2–AUX16 follow it. */
  AUX1: 217,
  /** `K_WORLD_0`; WORLD_1–WORLD_95 follow it. */
  WORLD_0: 233,
  SUPER: 329,
  COMPOSE: 330,
  MODE: 331,
  HELP: 332,
  PRINT: 333,
  SYSREQ: 334,
  SCROLLOCK: 335,
  BREAK: 336,
  MENU: 337,
  EURO: 338,
  UNDO: 339,
  /** `K_PAD0_A`; the pad's other buttons follow it. */
  PAD0_A: 340,
  /** The pseudo-key that brings the console down, which nothing can bind. */
  CONSOLE: 371
} as const;

/** `MAX_KEYS`: one past `K_CONSOLE`, the last key. */
export const MAX_KEYS = 372;

const QUOTE = 34;
const SEMICOLON = 59;

/** The pad's buttons after `K_PAD0_A`, in `keycodes.h`'s order. */
const PAD0_BUTTONS = [
  'A',
  'B',
  'X',
  'Y',
  'BACK',
  'GUIDE',
  'START',
  'LEFTSTICK_CLICK',
  'RIGHTSTICK_CLICK',
  'LEFTSHOULDER',
  'RIGHTSHOULDER',
  'DPAD_UP',
  'DPAD_DOWN',
  'DPAD_LEFT',
  'DPAD_RIGHT',
  'LEFTSTICK_LEFT',
  'LEFTSTICK_RIGHT',
  'LEFTSTICK_UP',
  'LEFTSTICK_DOWN',
  'RIGHTSTICK_LEFT',
  'RIGHTSTICK_RIGHT',
  'RIGHTSTICK_UP',
  'RIGHTSTICK_DOWN',
  'LEFTTRIGGER',
  'RIGHTTRIGGER',
  'MISC1',
  'PADDLE1',
  'PADDLE2',
  'PADDLE3',
  'PADDLE4',
  'TOUCHPAD'
];

/** `count` names numbered from `from`, for keys numbered from `first`. */
const series = (prefix: string, first: number, count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => [`${prefix}${i + from}`, first + i] as const);

/** `keynames` (`cl_keys.c:56–327`), in its order. */
const KEY_NAMES: readonly (readonly [string, number])[] = [
  ['TAB', K.TAB],
  ['ENTER', K.ENTER],
  ['ESCAPE', K.ESCAPE],
  ['SPACE', K.SPACE],
  ['BACKSPACE', K.BACKSPACE],
  ['UPARROW', K.UPARROW],
  ['DOWNARROW', K.DOWNARROW],
  ['LEFTARROW', K.LEFTARROW],
  ['RIGHTARROW', K.RIGHTARROW],
  ['ALT', K.ALT],
  ['CTRL', K.CTRL],
  ['SHIFT', K.SHIFT],
  ['COMMAND', K.COMMAND],
  ['CAPSLOCK', K.CAPSLOCK],
  ...series('F', K.F1, 15),
  ['INS', K.INS],
  ['DEL', K.DEL],
  ['PGDN', K.PGDN],
  ['PGUP', K.PGUP],
  ['HOME', K.HOME],
  ['END', K.END],
  ...series('MOUSE', K.MOUSE1, 5),
  ['MWHEELUP', K.MWHEELUP],
  ['MWHEELDOWN', K.MWHEELDOWN],
  ...series('JOY', K.JOY1, 32),
  ...series('AUX', K.AUX1, 16),
  ['KP_HOME', K.KP_HOME],
  ['KP_UPARROW', K.KP_UPARROW],
  ['KP_PGUP', K.KP_PGUP],
  ['KP_LEFTARROW', K.KP_LEFTARROW],
  ['KP_5', K.KP_5],
  ['KP_RIGHTARROW', K.KP_RIGHTARROW],
  ['KP_END', K.KP_END],
  ['KP_DOWNARROW', K.KP_DOWNARROW],
  ['KP_PGDN', K.KP_PGDN],
  ['KP_ENTER', K.KP_ENTER],
  ['KP_INS', K.KP_INS],
  ['KP_DEL', K.KP_DEL],
  ['KP_SLASH', K.KP_SLASH],
  ['KP_MINUS', K.KP_MINUS],
  ['KP_PLUS', K.KP_PLUS],
  ['KP_NUMLOCK', K.KP_NUMLOCK],
  ['KP_STAR', K.KP_STAR],
  ['KP_EQUALS', K.KP_EQUALS],
  ['PAUSE', K.PAUSE],
  // "because a raw semicolon separates commands"
  ['SEMICOLON', SEMICOLON],
  ...series('WORLD_', K.WORLD_0, 96, 0),
  ['WINDOWS', K.SUPER],
  ['COMPOSE', K.COMPOSE],
  ['MODE', K.MODE],
  ['HELP', K.HELP],
  ['PRINT', K.PRINT],
  ['SYSREQ', K.SYSREQ],
  ['SCROLLOCK', K.SCROLLOCK],
  ['BREAK', K.BREAK],
  ['MENU', K.MENU],
  ['POWER', K.POWER],
  ['EURO', K.EURO],
  ['UNDO', K.UNDO],
  ...PAD0_BUTTONS.map((button, i) => [`PAD0_${button}`, K.PAD0_A + i] as const)
];

/** Each name's key, by the name in lower case, for `Q_stricmp`'s match. */
const KEY_BY_NAME = new Map(KEY_NAMES.map(([name, key]) => [name.toLowerCase(), key]));

/** Each named key's first name, as `Key_KeynumToString`'s loop finds it. */
const NAME_BY_KEY = new Map<number, string>();
for (const [name, key] of KEY_NAMES) if (!NAME_BY_KEY.has(key)) NAME_BY_KEY.set(key, name);

/**
 * `Key_StringToKeynum` (`cl_keys.c:833–857`): a single character is its own key, lowercased; a
 * `0x` hex code is the key it numbers; anything else is looked up by name, without regard to
 * case.
 *
 * @returns The key, or −1 for a name Q3 does not know.
 */
export function stringToKey(name: string): number {
  if (name === '') return -1;
  if (name.length === 1) {
    const code = name.charCodeAt(0);
    // `tolower` on one byte: a character past ASCII is more than one byte in Q3's UTF-8.
    if (code >= 128) return -1;
    return code >= 65 && code <= 90 ? code + 32 : code;
  }
  const hex = hexToInt(name);
  if (hex >= 0 && hex < MAX_KEYS) return hex;
  return KEY_BY_NAME.get(name.toLowerCase()) ?? -1;
}

/**
 * `Key_KeynumToString` (`cl_keys.c:867–905`): a printable character stands for itself, except
 * the quote and the semicolon, which a config would read as syntax; a named key takes its name;
 * anything else becomes a hex code.
 */
export function keyToString(key: number): string {
  if (key === -1) return '<KEY NOT FOUND>';
  if (key < 0 || key >= MAX_KEYS) return '<OUT OF RANGE>';
  if (key > 32 && key < 127 && key !== QUOTE && key !== SEMICOLON) return String.fromCharCode(key);
  const name = NAME_BY_KEY.get(key);
  if (name !== undefined) return name;
  // Two digits, however large the key, as Q3 writes them.
  const digit = (n: number) => String.fromCharCode(n > 9 ? n - 10 + 97 : n + 48);
  return `0x${digit(key >> 4)}${digit(key & 15)}`;
}

/** `Com_HexStrToInt` (`q_shared.c:683–715`): `0x` and at least one hex digit, or −1. */
function hexToInt(text: string): number {
  if (text[0] !== '0' || text[1] !== 'x' || text.length < 3) return -1;
  let value = 0;
  for (const char of text.slice(2).toLowerCase()) {
    const digit = '0123456789abcdef'.indexOf(char);
    if (digit < 0) return -1;
    value = value * 16 + digit;
  }
  return value;
}
