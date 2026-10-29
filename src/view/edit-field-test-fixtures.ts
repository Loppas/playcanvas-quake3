import { K } from '../formats/q3-keys';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { EditField } from './edit-field';

/**
 * The input field's corpus: seeded keys, characters, pastes, draws and widths, run step by step as
 * the twin of ioquake3's own `Field_KeyDownEvent`, `Field_CharEvent`, `Field_Paste` (through
 * `Sys_GetClipboardData`), `Field_Clear` and `Field_VariableSizeDraw` runs them, the state after
 * each digested as the twin digests it. The twin reads the steps this writes ({@link fieldInputs}).
 */

/** What a step does, as the twin numbers it. */
export const FIELD_STEP = {
  key: 0,
  char: 1,
  paste: 2,
  draw: 3,
  width: 4,
  clear: 5
} as const;

/** One step: a key's number, a character's code, a paste's text or a width. */
export interface FieldStep {
  type: number;
  value: number;
  text: string;
}

/** What a corpus ran: its steps by kind, how far it reached, and its digest. */
export interface FieldRun {
  keys: number;
  chars: number;
  pastes: number;
  draws: number;
  widths: number;
  clears: number;
  /** Draws whose window started before the line, where ioquake3 reads outside its buffer. */
  drawsBeforeLine: number;
  /** The longest the line grew. */
  longest: number;
  /** The lowest the scroll went. */
  lowestScroll: number;
  digest: string;
}

/** The keys a key step presses: the field's own, their keypad twins, and keys it passes by. */
const KEYS = [
  K.DEL,
  K.RIGHTARROW,
  K.LEFTARROW,
  K.HOME,
  K.END,
  K.INS,
  K.KP_DEL,
  K.KP_INS,
  K.KP_HOME,
  K.KP_LEFTARROW,
  K.ENTER,
  K.TAB,
  K.SHIFT,
  K.CTRL,
  K.UPARROW,
  'a'.charCodeAt(0),
  'e'.charCodeAt(0)
];

/**
 * The control characters a character step types: Ctrl+A, C, E and H, and others the field passes
 * by. Never Ctrl+V, which in ioquake3 pastes, and in the twin would paste the paste's own text.
 */
const CONTROLS = [1, 3, 5, 8, 9, 10, 12, 13, 27, 31];

/**
 * The widths a width step picks: the console's at 640, 1920 and con_scale 2, the chat line's, and
 * slivers.
 */
const WIDTHS = [78, 238, 118, 30, 25, 10, 5, 2, 1];

/** A printable character, now and then a caret or a space. */
function printable(pick: (n: number) => number): number {
  const r = pick(20);
  if (r === 0) return '^'.charCodeAt(0);
  if (r === 1) return 32;
  return 33 + pick(94);
}

/**
 * A paste's text: printable runs, now and then a line break or a control character, at times
 * first.
 */
function pasteText(pick: (n: number) => number): string {
  if (pick(30) === 0) return '';
  let text = '';
  if (pick(6) === 0) text += '\n\r\b'[pick(3)].repeat(1 + pick(3));
  const length = pick(4) === 0 ? pick(320) : pick(24);
  for (let i = 0; i < length; i++) {
    const r = pick(60);
    if (r === 0) text += '\n';
    else if (r === 1) text += '\r';
    else if (r === 2) text += '\b';
    else if (r === 3) text += String.fromCharCode(CONTROLS[pick(CONTROLS.length)]);
    else text += String.fromCharCode(printable(pick));
  }
  return text;
}

/**
 * A corpus of `count` steps from `seed`: mostly characters typed as a browser types them, each
 * after its key, then lone keys and characters, draws, pastes, and now and then a new width or a
 * clear.
 */
export function fieldCorpus(seed: number, count: number): FieldStep[] {
  const random = new Seeded(seed);
  // The high bits: the low ones cycle in a few draws.
  const pick = (n: number) => (random.next() >>> 8) % n;
  const steps: FieldStep[] = [];
  while (steps.length < count) {
    const r = pick(1000);
    if (r < 420) {
      const ch = printable(pick);
      const key = String.fromCharCode(ch).toLowerCase().charCodeAt(0);
      steps.push({ type: FIELD_STEP.key, value: key, text: '' });
      steps.push({ type: FIELD_STEP.char, value: ch, text: '' });
    } else if (r < 520) {
      const ch = pick(3) === 0 ? CONTROLS[pick(CONTROLS.length)] : printable(pick);
      // Ctrl+C clears the line, so it comes seldom, or the line would never grow long.
      if (ch === 3 && pick(8) !== 0) continue;
      steps.push({ type: FIELD_STEP.char, value: ch, text: '' });
    } else if (r < 790) {
      steps.push({ type: FIELD_STEP.key, value: KEYS[pick(KEYS.length)], text: '' });
    } else if (r < 820) {
      steps.push({ type: FIELD_STEP.paste, value: 0, text: pasteText(pick) });
    } else if (r < 990) {
      steps.push({ type: FIELD_STEP.draw, value: 0, text: '' });
    } else if (r < 997) {
      steps.push({ type: FIELD_STEP.width, value: WIDTHS[pick(WIDTHS.length)], text: '' });
    } else {
      steps.push({ type: FIELD_STEP.clear, value: 0, text: '' });
    }
  }
  return steps.slice(0, count);
}

/**
 * The steps as the twin reads them: their count, then each one's type, value and text's length as
 * ints, and its text's bytes.
 */
export function fieldInputs(steps: readonly FieldStep[]): Uint8Array {
  const size = steps.reduce((sum, step) => sum + 12 + step.text.length, 4);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, steps.length, true);
  let at = 4;
  for (const step of steps) {
    view.setInt32(at, step.type, true);
    view.setInt32(at + 4, step.value, true);
    view.setInt32(at + 8, step.text.length, true);
    at += 12;
    for (let i = 0; i < step.text.length; i++) bytes[at++] = step.text.charCodeAt(i) & 255;
  }
  return bytes;
}

/** A string's bytes, as C's `char`s. */
function digestText(digest: Digest, text: string): void {
  digest.int(text.length);
  digest.uint8s(Uint8Array.from(text, (ch) => ch.charCodeAt(0)), 0, text.length);
}

/**
 * Runs a corpus on a new field, 78 wide in insert, digesting after every step as the twin does:
 * the cursor, the scroll, the width, overstrike and the line; and for a draw, what it shows and
 * the cursor's place in it, or -1 for a window that starts before the line.
 */
export function runField(steps: readonly FieldStep[]): FieldRun {
  const mode = { overstrike: false };
  const field = new EditField(mode, 78);
  const digest = new Digest();
  const run: FieldRun = {
    keys: 0,
    chars: 0,
    pastes: 0,
    draws: 0,
    widths: 0,
    clears: 0,
    drawsBeforeLine: 0,
    longest: 0,
    lowestScroll: 0,
    digest: ''
  };
  for (const step of steps) {
    switch (step.type) {
      case FIELD_STEP.key:
        run.keys++;
        field.keyDown(step.value);
        break;
      case FIELD_STEP.char:
        run.chars++;
        field.char(String.fromCharCode(step.value));
        break;
      case FIELD_STEP.paste:
        run.pastes++;
        field.paste(step.text);
        break;
      case FIELD_STEP.draw: {
        run.draws++;
        const { start, length } = field.window();
        if (start < 0) {
          run.drawsBeforeLine++;
          digest.int(-1);
        } else {
          digestText(digest, field.text.slice(start, start + length));
          digest.int(field.cursor - start);
        }
        break;
      }
      case FIELD_STEP.width:
        run.widths++;
        field.widthInChars = step.value;
        break;
      case FIELD_STEP.clear:
        run.clears++;
        field.clear();
        break;
      default:
        throw new Error(`no step ${step.type}`);
    }
    run.longest = Math.max(run.longest, field.text.length);
    run.lowestScroll = Math.min(run.lowestScroll, field.scroll);
    digest.int(field.cursor).int(field.scroll).int(field.widthInChars).int(mode.overstrike ? 1 : 0);
    digestText(digest, field.text);
  }
  run.digest = digest.hex();
  return run;
}
