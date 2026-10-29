import { K, MAX_KEYS } from '../formats/q3-keys';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { isConsoleKey } from './browser-keys';

/**
 * `isConsoleKey`'s corpus: seeded `cl_consoleKeys` values, each asked of every key and of every
 * character to {@link LAST_CHARACTER}, as the twin of ioquake3's own `IN_IsConsoleKey` asks them,
 * each answer digested as the twin digests it. The twin reads what {@link consoleKeysInputs} and
 * {@link consoleKeyCaseInputs} write.
 */

/** The last character a corpus asks of, past `0x173` (`K_CONSOLE`'s number) and `0x1ff`. */
export const LAST_CHARACTER = 0x2ff;

/** A hand case: `cl_consoleKeys`, the key and the character asked of, and the twin's answer. */
export type ConsoleKeyCase = readonly [
  consoleKeys: string,
  key: number,
  character: number,
  answer: boolean
];

/** What a corpus came to: how many answers were yes, and the digest of every answer in order. */
export interface ConsoleKeysRun {
  matches: number;
  digest: string;
}

const key = (char: string) => char.charCodeAt(0);
const DEFAULT = '~ ` 0x7e 0x60';
const LETTERS = 'abcdefghijklmnopq';

/**
 * Hand cases, each with the twin's answer: the default; a key name, a lone character and a code;
 * the words that name nothing; the sixteenth word and the seventeenth; quotes, an empty word and a
 * comment; a key asked as its own character.
 */
export const CONSOLE_KEY_CASES: readonly ConsoleKeyCase[] = [
  [DEFAULT, key('`'), 0, true],
  [DEFAULT, key('~'), 0, true],
  [DEFAULT, 0, 0x60, true],
  [DEFAULT, 0, 0x7e, true],
  [DEFAULT, key('a'), 0, false],
  [DEFAULT, 0, key('a'), false],
  [DEFAULT, K.CONSOLE, 0, false],
  [DEFAULT, 0, 0, false],
  ['PAUSE', K.PAUSE, 0, true],
  ['PAUSE', key('`'), 0, false],
  ['PAUSE', 0, 0x60, false],
  ['escape', K.ESCAPE, 0, true],
  ['A', key('a'), 0, true],
  ['A', 0, key('A'), false],
  ['0x41', 0, key('A'), true],
  ['0x41', key('a'), 0, false],
  ['0X41', 0, key('A'), false],
  ['0x7E', 0, 0x7e, true],
  ['0x173', 0, 0x173, true],
  ['0x173', K.CONSOLE, 0, false],
  ['SEMICOLON', key(';'), 0, true],
  [';', key(';'), 0, true],
  ['MOUSE1', K.MOUSE1, 0, true],
  ['0x0 0x 0xzz NOPE pause', K.PAUSE, 0, true],
  ['0x0', 0, 0, false],
  [LETTERS.slice(0, 16).split('').join(' '), key('p'), 0, true],
  [LETTERS.split('').join(' '), key('q'), 0, false],
  [`NOPE ${LETTERS.slice(0, 16).split('').join(' ')}`, key('p'), 0, true],
  ['"PAUSE"', K.PAUSE, 0, true],
  ['"a b"', key('a'), 0, false],
  ['"" a', key('a'), 0, false],
  ['a // b', key('b'), 0, false],
  ['a // b\nc', key('c'), 0, true],
  ['a', key('a'), key('a'), false],
  ['0x61', key('a'), key('a'), true]
];

/** The words a corpus is made of: names, characters and codes, and words that name nothing. */
const WORDS = [
  '~',
  '`',
  '0x7e',
  '0x60',
  '0x7E',
  '0X7e',
  'PAUSE',
  'f1',
  'TAB',
  'escape',
  'SEMICOLON',
  ';',
  'MOUSE1',
  'MWHEELUP',
  'KP_ENTER',
  'WINDOWS',
  'a',
  'Z',
  '1',
  '^',
  '/',
  '0x0',
  '0x00',
  '0x',
  '0xzz',
  '0x41',
  '0x1ff',
  '0x173',
  '0x2fe',
  '0xFF',
  'NOPE',
  '"PAUSE"',
  '"a b"',
  '""',
  '//x'
];

/** A value: up to 20 words, mostly a space apart and now and then a line apart. */
function consoleKeysText(pick: (n: number) => number): string {
  let text = '';
  const words = pick(21);
  for (let w = 0; w < words; w++) {
    if (w > 0) text += pick(6) === 0 ? '\n' : ' ';
    text += WORDS[pick(WORDS.length)];
  }
  return text;
}

/** A corpus of `count` values from `seed`. */
export function consoleKeysCorpus(seed: number, count: number): string[] {
  const random = new Seeded(seed);
  // The high bits: the low ones cycle in a few draws.
  const pick = (n: number) => (random.next() >>> 8) % n;
  return Array.from({ length: count }, () => consoleKeysText(pick));
}

/** Bytes for the twin: a count, then each record as `write` puts it. */
function inputs<T>(
  records: readonly T[],
  write: (record: T, int: (n: number) => void, text: (s: string) => void) => void
): Uint8Array {
  const bytes: number[] = [];
  const int = (n: number) => {
    for (let i = 0; i < 4; i++) bytes.push((n >>> (8 * i)) & 0xff);
  };
  const text = (s: string) => {
    int(s.length);
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };
  int(records.length);
  for (const record of records) write(record, int, text);
  return Uint8Array.from(bytes);
}

/** A corpus as the twin reads it: the count, then each value's length as an int and its bytes. */
export function consoleKeysInputs(texts: readonly string[]): Uint8Array {
  return inputs(texts, (value, _, text) => text(value));
}

/** Hand cases as the twin reads them: the count, then each value, its key and its character. */
export function consoleKeyCaseInputs(cases: readonly ConsoleKeyCase[]): Uint8Array {
  return inputs(cases, ([value, asked, character], int, text) => {
    text(value);
    int(asked);
    int(character);
  });
}

/** The corpus through {@link isConsoleKey}: each answer, every key then every character. */
export function runConsoleKeys(texts: readonly string[]): ConsoleKeysRun {
  const digest = new Digest();
  let matches = 0;
  const answer = (yes: boolean) => {
    if (yes) matches++;
    digest.int(yes ? 1 : 0);
  };
  for (const text of texts) {
    for (let asked = 0; asked < MAX_KEYS; asked++) answer(isConsoleKey(text, asked, 0));
    for (let character = 1; character <= LAST_CHARACTER; character++) {
      answer(isConsoleKey(text, 0, character));
    }
  }
  return { matches, digest: digest.hex() };
}
