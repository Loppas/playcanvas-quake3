import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { ConsoleBuffer, NUM_CON_TIMES } from './console-buffer';

/**
 * The console buffer's corpus: seeded prints, resizes and scrolls, run step by step as the twin of
 * ioquake3's own `CL_ConsolePrint`, `Con_Linefeed`, `Con_CheckResize`, `Con_ClearNotify` and the
 * four scrolls runs them, the state after each digested as the twin digests it. The twin reads
 * the steps this writes ({@link consoleInputs}).
 */

/** What a step does, as the twin numbers it. */
export const STEP = {
  print: 0,
  resize: 1,
  pageUp: 2,
  pageDown: 3,
  top: 4,
  bottom: 5,
  clearNotify: 6
} as const;

/** One step: a print's text and real time, or a resize's width in characters. */
export interface ConsoleStep {
  type: number;
  value: number;
  text: string;
}

/** What a corpus ran: its steps by kind, the lines its prints fed, and its digest. */
export interface ConsoleRun {
  prints: number;
  resizes: number;
  scrolls: number;
  clears: number;
  linesFed: number;
  digest: string;
}

/** Every so many steps, and after the last, every cell is digested too. */
const CELLS_EVERY = 25;

/** The widths a resize picks: a 640 to a 3840 screen, `con_scale` 2 at 1920, and slivers. */
const WIDTHS = [78, 158, 238, 118, 38, 478, 97, 10, 2, 1];

/** Colour codes and near misses: ioquake3 takes a letter or digit after `^`, and nothing else. */
const CODES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'Z', 'y', '!', '^', '.', '\xe9'];

/** A word: mostly short, now and then longer than the widest line, its characters printable. */
function word(pick: (n: number) => number): string {
  const length = pick(4) === 0 ? 1 + pick(600) : 1 + pick(12);
  let out = '';
  for (let i = 0; i < length; i++) {
    // Now and then a byte past 127, which ends a word as C counts it.
    out += String.fromCharCode(pick(40) === 0 ? 128 + pick(128) : 33 + pick(94));
  }
  return out;
}

/** A print's text: words, spaces, colour codes, `\n` and `\r`, often ending a line. */
function printText(pick: (n: number) => number): string {
  const kind = pick(50);
  if (kind === 0) return '';
  if (kind === 1) return '[skipnotify]';

  let text = pick(10) === 0 ? '[skipnotify]' : '';
  const tokens = 1 + pick(6);
  for (let t = 0; t < tokens; t++) {
    const r = pick(100);
    if (r < 45) text += word(pick);
    else if (r < 65) text += pick(8) === 0 ? '\t' : ' '.repeat(1 + pick(3));
    else if (r < 77) text += `^${CODES[pick(CODES.length)]}`;
    else if (r < 87) text += '\n';
    else if (r < 92) text += '\r';
    else text += '^';
  }
  if (pick(10) < 7) text += '\n';
  return text;
}

/**
 * A corpus of `count` steps from `seed`: mostly prints, some resizes, scrolls and clears, the real
 * clock moving 0 to 39 milliseconds a step from 0.
 */
export function consoleCorpus(seed: number, count: number): ConsoleStep[] {
  const random = new Seeded(seed);
  // The high bits: the low ones cycle in a few draws.
  const pick = (n: number) => (random.next() >>> 8) % n;
  const steps: ConsoleStep[] = [];
  let realTime = 0;
  for (let s = 0; s < count; s++) {
    realTime += pick(40);
    const r = pick(100);
    if (r < 82) {
      steps.push({ type: STEP.print, value: realTime, text: printText(pick) });
    } else if (r < 85) {
      const width = pick(20) === 0 ? 0 : WIDTHS[pick(WIDTHS.length)];
      steps.push({ type: STEP.resize, value: width, text: '' });
    } else if (r < 99) {
      const scroll = pick(20);
      const type =
        scroll < 8 ? STEP.pageUp : scroll < 14 ? STEP.pageDown : scroll < 17 ? STEP.top : STEP.bottom;
      steps.push({ type, value: 0, text: '' });
    } else {
      steps.push({ type: STEP.clearNotify, value: 0, text: '' });
    }
  }
  return steps;
}

/**
 * The steps as the twin reads them: their count, then each one's type, value and text's length as
 * ints, and its text's bytes.
 */
export function consoleInputs(steps: readonly ConsoleStep[]): Uint8Array {
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

/** Runs one step on the buffer. */
export function runStep(buffer: ConsoleBuffer, step: ConsoleStep): void {
  switch (step.type) {
    case STEP.print:
      buffer.print(step.text, step.value);
      break;
    case STEP.resize:
      buffer.resize(step.value);
      break;
    case STEP.pageUp:
      buffer.pageUp();
      break;
    case STEP.pageDown:
      buffer.pageDown();
      break;
    case STEP.top:
      buffer.top();
      break;
    case STEP.bottom:
      buffer.bottom();
      break;
    case STEP.clearNotify:
      buffer.clearNotify();
      break;
    default:
      throw new Error(`no step ${step.type}`);
  }
}

/**
 * Adds the buffer's state to a digest, as the twin's `digestState`: the line being written, the
 * view's, the width and the lines held, and the last {@link NUM_CON_TIMES} lines' times, oldest
 * first. With `cells`, every line of the ring too, the first first, each cell as C's two bytes.
 */
export function digestConsole(digest: Digest, buffer: ConsoleBuffer, cells: boolean): void {
  digest.int(buffer.current).int(buffer.display).int(buffer.lineWidth).int(buffer.totalLines);
  for (let k = 0; k < NUM_CON_TIMES; k++) {
    digest.int(buffer.lineTime(buffer.current - NUM_CON_TIMES + 1 + k));
  }
  if (!cells) return;
  for (let row = 0; row < buffer.totalLines; row++) {
    const line = buffer.line(row);
    digest.uint8s(new Uint8Array(line.buffer, line.byteOffset, line.byteLength), 0, line.byteLength);
  }
}

/** A line as the twin prints it: its number and time, its text to its last character, and each character's colour. */
export interface LineDescription {
  line: number;
  time: number;
  text: string;
  colors: string;
}

/** The buffer as the twin prints it for a hand case: where it is, and its last few lines. */
export interface ConsoleDescription {
  current: number;
  display: number;
  lineWidth: number;
  totalLines: number;
  lines: LineDescription[];
}

/** The buffer's last `count` lines, the one being written last, as the twin's `dump` prints them. */
export function describeLines(buffer: ConsoleBuffer, count: number): ConsoleDescription {
  const lines: LineDescription[] = [];
  for (let n = buffer.current - count + 1; n <= buffer.current; n++) {
    const cells = buffer.line(n);
    let end = cells.length;
    while (end > 0 && (cells[end - 1] & 255) === 32) end--;
    let text = '';
    let colors = '';
    for (const cell of cells.subarray(0, end)) {
      text += String.fromCharCode(cell & 255);
      colors += String(cell >> 8);
    }
    lines.push({ line: n, time: buffer.lineTime(n), text, colors });
  }
  const { current, display, lineWidth, totalLines } = buffer;
  return { current, display, lineWidth, totalLines, lines };
}

/** Runs a corpus on a new buffer, digesting after every step as the twin does. */
export function runConsole(steps: readonly ConsoleStep[]): ConsoleRun {
  const buffer = new ConsoleBuffer();
  const digest = new Digest();
  const run: ConsoleRun = { prints: 0, resizes: 0, scrolls: 0, clears: 0, linesFed: 0, digest: '' };
  steps.forEach((step, s) => {
    const before = buffer.current;
    runStep(buffer, step);
    if (step.type === STEP.print) {
      run.prints++;
      run.linesFed += buffer.current - before;
    } else if (step.type === STEP.resize) {
      run.resizes++;
    } else if (step.type === STEP.clearNotify) {
      run.clears++;
    } else {
      run.scrolls++;
    }
    digestConsole(digest, buffer, s % CELLS_EVERY === CELLS_EVERY - 1 || s === steps.length - 1);
  });
  run.digest = digest.hex();
  return run;
}
