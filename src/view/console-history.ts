import { atoi } from '../formats/c-scan';
import { comParse, parseCursor } from '../formats/com-parse';
import { Q3HISTORY, type KeptText } from '../settings/config-file';
import type { FieldLine } from './edit-field';

/**
 * The console's history, as ioquake3 keeps it (`cl_keys.c`): the last lines entered, which Up and
 * Down bring back, kept between runs in `q3history`. The lines cited here are `cl_keys.c`'s.
 * Engine-free.
 */

/** `COMMAND_HISTORY` (`keys.h`): the lines the history holds. */
export const COMMAND_HISTORY = 32;

/** `MAX_CONSOLE_SAVE_BUFFER` (`:1461`): the file is shorter than this, or isn't read. */
export const MAX_CONSOLE_SAVE_BUFFER = 1024;

/** What the file is allowed beside a line's text: `strlen("999 999 999  ")` (`:1560`). */
const ENTRY_ROOM = 13;

/** A slot no line has filled: `Field_Clear`'s. */
const EMPTY_LINE: FieldLine = Object.freeze({ text: '', cursor: 0, scroll: 0 });

/**
 * `historyEditLines` (`:30`), with `nextHistoryLine`, the slot the next line entered fills, and
 * `historyLine`, the one Up and Down have reached. Each line keeps its text, cursor and scroll.
 */
export class ConsoleHistory implements KeptText {
  private readonly lines: FieldLine[] = new Array<FieldLine>(COMMAND_HISTORY).fill(EMPTY_LINE);
  private next = 0;
  private at = 0;
  private readonly print: (text: string) => void;
  private readonly listeners = new Set<() => void>();

  /** @param print - `Com_Printf`, for a file that can't be read. */
  constructor(print: (text: string) => void) {
    this.print = print;
  }

  /**
   * `CL_LoadConsoleHistory` (`:1473–1533`): the file's lines, newest first, each its cursor, its
   * scroll, its length and, after one character, its text. A file of
   * {@link MAX_CONSOLE_SAVE_BUFFER} characters or more is not read. One that goes wrong keeps the
   * lines read before it, and a length that runs past the file's end goes wrong, where ioquake3
   * reads on outside it.
   *
   * @param saved - The file as read at start, or `undefined` for none.
   */
  load(saved: string | undefined): void {
    if (saved === undefined || saved.length >= MAX_CONSOLE_SAVE_BUFFER) {
      this.print(`Couldn't read ${Q3HISTORY}.\n`);
      return;
    }
    const file = parseCursor(saved);
    const read: FieldLine[] = [];
    while (read.length < COMMAND_HISTORY) {
      const cursor = comParse(file);
      if (cursor === '') break;
      const scroll = comParse(file);
      if (scroll === '') break;
      const length = comParse(file);
      if (length === '') break;
      const start = file.at! + 1;
      const end = start + atoi(length);
      if (end < start || end > file.text.length) break;
      read.push({ text: file.text.slice(start, end), cursor: atoi(cursor), scroll: atoi(scroll) });
      file.at = end;
    }
    read.reverse();
    for (let i = 0; i < COMMAND_HISTORY; i++) this.lines[i] = read[i] ?? EMPTY_LINE;
    this.next = this.at = read.length;
  }

  /** Enter's copy (`:654–657`): a line into the history, which goes back to its end, and saved. */
  add(line: FieldLine): void {
    this.lines[this.next % COMMAND_HISTORY] = line;
    this.next++;
    this.at = this.next;
    for (const listener of this.listeners) listener();
  }

  /**
   * Up (`:680–688`): the line before the one reached, as far back as the oldest the history holds.
   * Before any is entered that is an empty slot, which clears the line.
   */
  older(): FieldLine {
    if (this.next - this.at < COMMAND_HISTORY && this.at > 0) this.at--;
    return this.lines[this.at % COMMAND_HISTORY];
  }

  /** Down (`:690–701`): the line after the one reached, and past the newest an empty one. */
  newer(): FieldLine {
    this.at++;
    if (this.at >= this.next) {
      this.at = this.next;
      return EMPTY_LINE;
    }
    return this.lines[this.at % COMMAND_HISTORY];
  }

  /**
   * `CL_SaveConsoleHistory`'s file (`:1543–1591`): the lines that aren't empty, newest first, each
   * its cursor, scroll, length and text, for as long as the next fits with {@link ENTRY_ROOM} for
   * its numbers. Longer numbers can still run past the file's room, where `Q_strcat` cuts it.
   */
  text(): string {
    let saved = '';
    const newest = this.next + COMMAND_HISTORY - 1;
    for (let n = 0; n < COMMAND_HISTORY; n++) {
      const { text, cursor, scroll } = this.lines[(newest - n) % COMMAND_HISTORY];
      if (text === '') continue;
      if (saved.length + text.length + ENTRY_ROOM >= MAX_CONSOLE_SAVE_BUFFER) break;
      saved = `${saved}${cursor} ${scroll} ${text.length} ${text} `.slice(
        0,
        MAX_CONSOLE_SAVE_BUFFER - 1
      );
    }
    return saved;
  }

  onSave(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
