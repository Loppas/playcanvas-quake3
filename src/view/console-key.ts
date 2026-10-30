import { K } from '../formats/q3-keys';
import type { ConsoleHistory } from './console-history';
import type { ConsoleText } from './console-print';
import { MAX_FIELD_LENGTH, type EditField } from './edit-field';
import { autoComplete, type CompletionNames } from './field-complete';

/**
 * `Console_Key` (`cl_keys.c:613–746`): a key pressed at the console, which enters its line, brings
 * back an earlier one, scrolls its text, or goes on to the line's field. Engine-free.
 */

/** A letter's key, which Q3 numbers by the letter. */
const letterKey = (letter: string) => letter.charCodeAt(0);

/** What `Console_Key` works on. */
export interface ConsoleLine {
  /** `g_consoleField`: the line being typed. */
  field: EditField;
  /** The lines entered before it. */
  history: ConsoleHistory;
  /** The console's text, which PgUp, PgDn and the wheel scroll. */
  scrollback: Pick<ConsoleText, 'pageUp' | 'pageDown' | 'top' | 'bottom'>;
  /** `Key_IsDown`: whether a key is held. */
  isDown(key: number): boolean;
  /** Whether the client is in a match: `clc.state == CA_ACTIVE`. */
  active(): boolean;
  /**
   * `con_autochat`: a line with no leading slash is said in a match, and run as commands out of
   * one.
   */
  autochat(): boolean;
  /** What Tab completes a word from: the commands, then the cvars. */
  names(): CompletionNames;
  /** `Com_Printf`. */
  print(text: string): void;
  /** `Cbuf_AddText`: text run as console commands. */
  run(text: string): void;
}

/**
 * A key pressed at the console, in `Console_Key`'s order: Ctrl+L runs `clear`; Enter enters the
 * line; Tab completes its last word; Up, Ctrl+P and Shift with the wheel up bring back the line
 * before, and Down, Ctrl+N and Shift with the wheel down the one after; PgUp and PgDn scroll the
 * text two lines, and the wheel two, or six with Ctrl; Ctrl+Home and Ctrl+End go to its ends; and
 * any other key is the field's.
 *
 * @returns whether the key was taken, so its browser default is stopped
 */
export function consoleKey(key: number, line: ConsoleLine): boolean {
  const { field, history, scrollback } = line;
  const ctrl = line.isDown(K.CTRL);
  const shift = line.isDown(K.SHIFT);

  if (key === letterKey('l') && ctrl) {
    line.run('clear');
    return true;
  }
  if (key === K.ENTER || key === K.KP_ENTER) {
    enter(line);
    return true;
  }
  if (key === K.TAB) {
    const print = (text: string) => line.print(text);
    field.restore(autoComplete(field.line(), line.names(), line.autochat(), print));
    return true;
  }
  if (
    (key === K.MWHEELUP && shift) ||
    key === K.UPARROW ||
    key === K.KP_UPARROW ||
    (key === letterKey('p') && ctrl)
  ) {
    field.restore(history.older());
    return true;
  }
  if (
    (key === K.MWHEELDOWN && shift) ||
    key === K.DOWNARROW ||
    key === K.KP_DOWNARROW ||
    (key === letterKey('n') && ctrl)
  ) {
    field.restore(history.newer());
    return true;
  }
  if (key === K.PGUP || key === K.MWHEELUP) {
    const pages = key === K.MWHEELUP && ctrl ? 3 : 1;
    for (let i = 0; i < pages; i++) scrollback.pageUp();
    return true;
  }
  if (key === K.PGDN || key === K.MWHEELDOWN) {
    const pages = key === K.MWHEELDOWN && ctrl ? 3 : 1;
    for (let i = 0; i < pages; i++) scrollback.pageDown();
    return true;
  }
  if (key === K.HOME && ctrl) {
    scrollback.top();
    return true;
  }
  if (key === K.END && ctrl) {
    scrollback.bottom();
    return true;
  }
  return field.keyDown(key);
}

/** A line with a leading slash, which is run as commands whatever `con_autochat` says. */
const isCommand = (text: string) => text.startsWith('\\') || text.startsWith('/');

/**
 * Enter (`cl_keys.c:620–668`): the line echoed after a `]`, and run without its slash, or said
 * with `cmd say`; out of a match `con_autochat` gives a line its slash first, with the cursor moved
 * on. An empty line is echoed alone. Any other is kept in the history and cleared.
 */
function enter(line: ConsoleLine): void {
  const { field } = line;
  const typed = field.line();
  let { text, cursor } = typed;
  if (!line.active() && line.autochat() && text !== '' && !isCommand(text)) {
    text = `\\${text.slice(0, MAX_FIELD_LENGTH)}`;
    cursor++;
  }
  line.print(`]${text}\n`);
  let commands: string;
  if (isCommand(text)) commands = text.slice(1);
  else if (text === '') return;
  else commands = line.autochat() ? `cmd say ${text}` : text;

  line.history.add({ text, cursor, scroll: typed.scroll });
  field.clear();
  // After the line is kept and cleared, as Q3's command buffer runs it after the key's event.
  line.run(commands);
}
