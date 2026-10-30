import { K } from '../formats/q3-keys';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { ConsoleHistory, MAX_CONSOLE_SAVE_BUFFER } from './console-history';
import { consoleKey, type ConsoleLine } from './console-key';
import { EditField, MAX_FIELD_LENGTH, type EditMode } from './edit-field';
import type { FieldStep } from './edit-field-test-fixtures';

/**
 * The console line's corpus: seeded keys, characters, held keys, the client's state, widths,
 * restarts and history files, run step by step as the twin of ioquake3's own `Console_Key`,
 * `Field_CharEvent`, `CL_LoadConsoleHistory` and `CL_SaveConsoleHistory` runs them, the state after
 * each digested as the twin digests it. Steps are laid out as the field's are, for `fieldInputs`.
 */

/**
 * The `q3history` ioquake3 wrote for lines typed into its console out of a match, 78 wide, under
 * `con_autochat` 1: lines it gave a slash and one typed with one, a line scrolled, one after
 * Ctrl+E, and one recalled and entered again.
 */
export const IOQ3_HISTORY =
  `5 0 5 \\quit 96 18 96 \\echo ${'x'.repeat(90)} 12 -68 12 \\echo shorte ` +
  `96 18 96 \\echo ${'x'.repeat(90)} 7 0 7 \\say hi 16 0 16 /echo beta gamma 11 0 11 \\echo alpha `;

/** What a step does, as the twin numbers it. */
export const CONSOLE_STEP = {
  key: 0,
  char: 1,
  hold: 2,
  release: 3,
  active: 4,
  autochat: 5,
  width: 6,
  restart: 7,
  file: 8
} as const;

/** What a corpus ran: its steps by kind, how far it reached, and its digest. */
export interface ConsoleRun {
  keys: number;
  chars: number;
  holds: number;
  flags: number;
  widths: number;
  restarts: number;
  files: number;
  /** Lines entered and kept in the history. */
  entered: number;
  /** Reads that said they couldn't read the file. */
  unread: number;
  /** Writes that filled the file's room to its last character. */
  full: number;
  /**
   * Characters typed into a recalled line too long to take another, where ioquake3 writes past
   * its buffer, and the twin passes them by as the port refuses them.
   */
  pastBuffer: number;
  /** The longest the line grew. */
  longest: number;
  /** The longest file the history wrote. */
  longestFile: number;
  digest: string;
}

const letter = (ch: string) => ch.charCodeAt(0);
const ctrl = (ch: string) => letter(ch) - 0x60;

/** Keys the history and the text take, alone. */
const CONSOLE_KEYS = [
  K.UPARROW,
  K.KP_UPARROW,
  K.DOWNARROW,
  K.KP_DOWNARROW,
  K.PGUP,
  K.PGDN,
  K.MWHEELUP,
  K.MWHEELDOWN
];

/** Keys the field takes or passes by, and keys `Console_Key` reads only with Ctrl. */
const FIELD_KEYS = [
  K.LEFTARROW,
  K.RIGHTARROW,
  K.HOME,
  K.END,
  K.DEL,
  K.KP_PGUP,
  K.KP_LEFTARROW,
  K.SHIFT,
  K.CTRL,
  letter('l'),
  letter('p'),
  letter('n'),
  letter('e')
];

/** The chords Ctrl and Shift make with them: the held key, the key, and Ctrl's character. */
const CHORDS: [number, number, number][] = [
  [K.CTRL, letter('p'), ctrl('p')],
  [K.CTRL, letter('n'), ctrl('n')],
  [K.CTRL, letter('l'), ctrl('l')],
  [K.CTRL, letter('e'), ctrl('e')],
  [K.CTRL, letter('a'), ctrl('a')],
  [K.CTRL, K.MWHEELUP, 0],
  [K.CTRL, K.MWHEELDOWN, 0],
  [K.CTRL, K.HOME, 0],
  [K.CTRL, K.END, 0],
  [K.SHIFT, K.MWHEELUP, 0],
  [K.SHIFT, K.MWHEELDOWN, 0]
];

/** The console's widths: at 640, 1920, 1920 with con_scale 2 and 3840, and slivers. */
const WIDTHS = [78, 238, 118, 478, 30, 10, 1];

/** A character of a typed line: mostly letters and spaces, now and then a slash first. */
function typedChar(pick: (n: number) => number, first: boolean): number {
  if (first && pick(3) === 0) return letter(pick(2) === 0 ? '/' : '\\');
  const r = pick(10);
  if (r === 0) return 32;
  if (r < 6) return letter('a') + pick(26);
  return 33 + pick(94);
}

/** A number as a history file holds it: written plainly, or quoted, padded or trailed. */
function fileNumber(pick: (n: number) => number, n: number): { text: string; quoted: boolean } {
  const r = pick(12);
  if (r === 0) return { text: `"${n}"`, quoted: true };
  if (r === 1) return { text: `+${n}`, quoted: false };
  if (r === 2) return { text: `00${n}`, quoted: false };
  if (r === 3) return { text: `${n}x`, quoted: false };
  return { text: `${n}`, quoted: false };
}

/** What lies between a file's numbers: a space mostly, else more whitespace or a comment. */
function fileGap(pick: (n: number) => number): string {
  const r = pick(16);
  if (r === 0) return '\t';
  if (r === 1) return '  \n ';
  if (r === 2) return ' /* gap */ ';
  if (r === 3) return ' // note\n';
  return ' ';
}

/** A character of a history file's line: printable, or now and then a tab, a break or a NUL. */
function fileChar(pick: (n: number) => number): string {
  const r = pick(200);
  if (r === 0) return '\0';
  if (r < 4) return '\t\n\r'[r - 1];
  return String.fromCharCode(32 + pick(95));
}

/**
 * A history file: lines as `CL_SaveConsoleHistory` writes them, with the room `COM_Parse` gives
 * its numbers, now and then too many for its room, and now and then cut short. A cut never falls
 * in a quoted number or in a line's length, where ioquake3 reads past the end of its data.
 */
function historyFile(pick: (n: number) => number): string {
  let text = '';
  const forbidden: [number, number][] = [];
  const lines = pick(4) === 0 ? pick(45) : pick(12);
  for (let i = 0; i < lines; i++) {
    const length = pick(5) === 0 ? pick(256) : pick(30);
    let line = '';
    for (let j = 0; j < length; j++) line += fileChar(pick);
    const numbers = [pick(length + 1), pick(4) === 0 ? pick(400) - 200 : 0, length];
    if (i > 0 || pick(4) === 0) text += fileGap(pick);
    numbers.forEach((n, at) => {
      const { text: number, quoted } = fileNumber(pick, n);
      if (at > 0) text += fileGap(pick);
      const start = text.length;
      text += number;
      if (at === 2) forbidden.push([start, text.length]);
      else if (quoted) forbidden.push([start, text.length - 1]);
    });
    // The one character skipped after the length: a quote ends it, so after one it can be any.
    const skipped = text.endsWith('"') && pick(3) === 0 ? 'x' : ' ';
    text += `${skipped}${line} `;
  }
  if (text.length > 0 && pick(4) === 0) {
    const cut = pick(text.length);
    if (!forbidden.some(([start, end]) => cut > start && cut <= end)) text = text.slice(0, cut);
  }
  return text;
}

/**
 * A corpus of `count` steps from `seed`: lines typed and entered, in a match and out of one, with
 * and without `con_autochat`; a full line entered, recalled and typed into; the history's keys and
 * the text's, alone and in their chords; the field's keys; Ctrl+E for a scroll below 0; widths; and
 * restarts, from the file the history wrote or from one written for it.
 */
export function consoleCorpus(seed: number, count: number): FieldStep[] {
  const random = new Seeded(seed);
  // The high bits: the low ones cycle in a few draws.
  const pick = (n: number) => (random.next() >>> 8) % n;
  const steps: FieldStep[] = [];
  const push = (type: number, value = 0, text = '') => steps.push({ type, value, text });
  let length = 0;
  let shifted = false;
  const type = (run: number) => {
    for (let i = 0; i < run; i++) {
      const ch = typedChar(pick, length === 0);
      push(CONSOLE_STEP.key, String.fromCharCode(ch).toLowerCase().charCodeAt(0));
      push(CONSOLE_STEP.char, ch);
      length++;
    }
  };
  // Shift+Insert pastes in ioquake3, where the browser keeps it.
  const insert = () => !shifted && push(CONSOLE_STEP.key, K.INS);
  while (steps.length < count) {
    const r = pick(1000);
    if (r < 250) {
      type(1 + (pick(32) === 0 ? pick(250) : pick(16)));
    } else if (r < 254) {
      // A full line entered, which out of a match takes a slash, then recalled and typed into.
      type(256);
      push(CONSOLE_STEP.key, K.ENTER);
      push(CONSOLE_STEP.key, K.UPARROW);
      type(2);
      insert();
      type(1);
      insert();
    } else if (r < 300) {
      // Ctrl+C clears the line, so it comes seldom.
      const controls = [ctrl('h'), ctrl('h'), ctrl('a'), ctrl('e'), ctrl('c')];
      push(CONSOLE_STEP.char, controls[pick(pick(9) === 0 ? 5 : 4)]);
    } else if (r < 450) {
      push(CONSOLE_STEP.key, pick(4) === 0 ? K.KP_ENTER : K.ENTER);
      length = 0;
    } else if (r < 590) {
      push(CONSOLE_STEP.key, CONSOLE_KEYS[pick(CONSOLE_KEYS.length)]);
    } else if (r < 690) {
      const [held, key, ch] = CHORDS[pick(CHORDS.length)];
      push(CONSOLE_STEP.hold, held);
      push(CONSOLE_STEP.key, key);
      if (ch !== 0) push(CONSOLE_STEP.char, ch);
      push(CONSOLE_STEP.release, held);
      if (held === K.SHIFT) shifted = false;
    } else if (r < 800) {
      push(CONSOLE_STEP.key, FIELD_KEYS[pick(FIELD_KEYS.length)]);
    } else if (r < 810) {
      insert();
    } else if (r < 820) {
      const key = [K.CTRL, K.SHIFT][pick(2)];
      const hold = pick(2) === 0;
      push(hold ? CONSOLE_STEP.hold : CONSOLE_STEP.release, key);
      if (key === K.SHIFT) shifted = hold;
    } else if (r < 860) {
      if (pick(2) === 0) push(CONSOLE_STEP.active, pick(2));
      else push(CONSOLE_STEP.autochat, pick(5) === 0 ? 0 : 1);
    } else if (r < 890) {
      push(CONSOLE_STEP.width, WIDTHS[pick(WIDTHS.length)]);
    } else if (r < 990) {
      push(CONSOLE_STEP.restart);
      length = 0;
    } else {
      if (pick(10) === 0) push(CONSOLE_STEP.file, 0);
      else push(CONSOLE_STEP.file, 1, historyFile(pick));
      length = 0;
    }
  }
  return steps.slice(0, count);
}

/** A string's bytes, as C's `char`s. */
function digestText(digest: Digest, text: string): void {
  digest.int(text.length);
  digest.uint8s(Uint8Array.from(text, (ch) => ch.charCodeAt(0)), 0, text.length);
}

/**
 * Runs a corpus on the console's line, 78 wide, out of a match and under `con_autochat` 1, with no
 * history file, digesting after every step as the twin does: the line, its cursor and scroll, and
 * overstrike; the commands run and the text printed since the step before; how often the text has
 * scrolled; and the file.
 */
export function runConsole(steps: readonly FieldStep[]): ConsoleRun {
  const mode: EditMode = { overstrike: false };
  const held = new Set<number>();
  const state = { active: false, autochat: true, width: 78 };
  const pages = { up: 0, down: 0, top: 0, bottom: 0 };
  const digest = new Digest();
  const run: ConsoleRun = {
    keys: 0,
    chars: 0,
    holds: 0,
    flags: 0,
    widths: 0,
    restarts: 0,
    files: 0,
    entered: 0,
    unread: 0,
    full: 0,
    pastBuffer: 0,
    longest: 0,
    longestFile: 0,
    digest: ''
  };
  let file: string | undefined;
  let commands = '';
  let printed = '';
  const print = (text: string) => {
    if (text === "Couldn't read q3history.\n") run.unread++;
    printed += text;
  };
  const line: ConsoleLine = {
    field: new EditField(mode, state.width),
    history: new ConsoleHistory(print),
    scrollback: {
      pageUp: () => void pages.up++,
      pageDown: () => void pages.down++,
      top: () => void pages.top++,
      bottom: () => void pages.bottom++
    },
    isDown: (key) => held.has(key),
    active: () => state.active,
    autochat: () => state.autochat,
    names: () => ({ commands: [], cvars: [], completer: () => undefined }),
    print,
    run: (text) => void (commands += `${text}\n`)
  };
  // `Con_Init`'s, as a new run of the program: the line cleared, and the history read anew.
  const restart = () => {
    mode.overstrike = false;
    line.field.clear();
    const history = new ConsoleHistory(print);
    history.load(file);
    history.onSave(() => {
      file = history.text();
      run.entered++;
      run.longestFile = Math.max(run.longestFile, file.length);
      if (file.length === MAX_CONSOLE_SAVE_BUFFER - 1) run.full++;
    });
    line.history = history;
  };
  restart();

  for (const step of steps) {
    // The width the console has, set each frame.
    line.field.widthInChars = state.width;
    switch (step.type) {
      case CONSOLE_STEP.key:
        run.keys++;
        consoleKey(step.value, line);
        break;
      case CONSOLE_STEP.char: {
        run.chars++;
        const { field } = line;
        const past = mode.overstrike ? field.cursor > MAX_FIELD_LENGTH : true;
        if (step.value >= 32 && field.text.length > MAX_FIELD_LENGTH && past) run.pastBuffer++;
        field.char(String.fromCharCode(step.value));
        break;
      }
      case CONSOLE_STEP.hold:
        run.holds++;
        held.add(step.value);
        break;
      case CONSOLE_STEP.release:
        run.holds++;
        held.delete(step.value);
        break;
      case CONSOLE_STEP.active:
        run.flags++;
        state.active = step.value !== 0;
        break;
      case CONSOLE_STEP.autochat:
        run.flags++;
        state.autochat = step.value !== 0;
        break;
      case CONSOLE_STEP.width:
        run.widths++;
        state.width = step.value;
        break;
      case CONSOLE_STEP.restart:
        run.restarts++;
        restart();
        break;
      case CONSOLE_STEP.file:
        run.files++;
        file = step.value === 0 ? undefined : step.text;
        restart();
        break;
      default:
        throw new Error(`no step ${step.type}`);
    }
    const { text, cursor, scroll } = line.field.line();
    run.longest = Math.max(run.longest, text.length);
    digest.int(cursor).int(scroll).int(mode.overstrike ? 1 : 0);
    digestText(digest, text);
    digestText(digest, commands);
    digestText(digest, printed);
    digest.int(pages.up).int(pages.down).int(pages.top).int(pages.bottom);
    digest.int(file === undefined ? 0 : 1);
    digestText(digest, file ?? '');
    commands = '';
    printed = '';
  }
  run.digest = digest.hex();
  return run;
}
