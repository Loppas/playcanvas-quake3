import { colorIndex, isColorCode } from '../formats/color-codes';
import { K } from '../formats/q3-keys';

/**
 * Q3's line editor, `field_t`, as the console and the chat line edit it: a line of text, the cursor
 * in it, and how far it is scrolled within its width. The rules are ioquake3's
 * (`cl_keys.c:346–596`, `common.c:3318–3322`), and the lines cited here are `cl_keys.c`'s.
 * Engine-free.
 */

/**
 * The longest line: `MAX_EDIT_LINE` less two, "to leave room for the leading slash and trailing \0"
 * (`:572–573`).
 */
export const MAX_FIELD_LENGTH = 254;

/** `COLOR_WHITE`, which a field's text is drawn in from its first character. */
const COLOR_WHITE = 7;

/** What `Sys_GetClipboardData` cuts a paste at (`sys_main.c:162–163`). */
const LINE_BREAKS = '\n\r\b';

/** A letter's control character, as SDL sends it for Ctrl and the letter (`CTRL`). */
const ctrl = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 0x60);

/**
 * `key_overstrikeMode`: whether a character typed writes over the one at the cursor rather than
 * going in before it. One for every field, the menu's among them, which Insert in any of them
 * swaps.
 */
export interface EditMode {
  overstrike: boolean;
}

/** The part of a field's line its draw shows: `length` characters from `start`. */
export interface FieldWindow {
  start: number;
  length: number;
}

export class EditField {
  /** `widthInChars`: the characters the field has room for, one of them kept for the cursor. */
  widthInChars: number;
  private readonly mode: EditMode;
  private buffer = '';
  private cursorAt = 0;
  private scrolled = 0;

  /**
   * @param mode - Insert or overstrike, shared with every other field.
   * @param widthInChars - The room it has, in characters.
   */
  constructor(mode: EditMode, widthInChars: number) {
    this.mode = mode;
    this.widthInChars = widthInChars;
  }

  /** `buffer`: the line. */
  get text(): string {
    return this.buffer;
  }

  /** `cursor`: where on the line the next character goes. */
  get cursor(): number {
    return this.cursorAt;
  }

  /**
   * `scroll`: the first character the draw would show. Ctrl+E can leave it below 0, which the
   * draw reads as it stands.
   */
  get scroll(): number {
    return this.scrolled;
  }

  /** Whether a character typed writes over the one at the cursor: the mode it shares. */
  get overstrike(): boolean {
    return this.mode.overstrike;
  }

  /** `Field_Clear` (`common.c:3318–3322`): an empty line, its cursor and scroll at the start. */
  clear(): void {
    this.buffer = '';
    this.cursorAt = 0;
    this.scrolled = 0;
  }

  /**
   * `Field_KeyDownEvent` (`:463–517`): Delete, the arrows, Home and End move the cursor or take
   * the character at it, and Insert swaps insert for overstrike. Then, for any key at all, the
   * scroll is moved to keep the cursor in its width: a key comes before the character it types,
   * which keeps typing's scroll right.
   *
   * @returns whether it was one of the field's keys
   */
  keyDown(key: number): boolean {
    const len = this.buffer.length;
    let used = true;
    switch (key) {
      case K.DEL:
        if (this.cursorAt < len) {
          this.buffer = this.buffer.slice(0, this.cursorAt) + this.buffer.slice(this.cursorAt + 1);
        }
        break;
      case K.RIGHTARROW:
        if (this.cursorAt < len) this.cursorAt++;
        break;
      case K.LEFTARROW:
        if (this.cursorAt > 0) this.cursorAt--;
        break;
      case K.HOME:
        this.cursorAt = 0;
        break;
      case K.END:
        this.cursorAt = len;
        break;
      case K.INS:
        this.mode.overstrike = !this.mode.overstrike;
        break;
      default:
        used = false;
    }
    if (this.cursorAt < this.scrolled) {
      this.scrolled = this.cursorAt;
    } else if (this.cursorAt >= this.scrolled + this.widthInChars && this.cursorAt <= len) {
      this.scrolled = this.cursorAt - this.widthInChars + 1;
    }
    return used;
  }

  /**
   * `Field_CharEvent` (`:524–596`): a character typed. Ctrl+C clears the line, Ctrl+H takes the
   * character before the cursor, and Ctrl+A and Ctrl+E go to its ends, Ctrl+E's scroll one short
   * of End's. Printable ASCII goes in at the cursor, or over the one there, up to
   * {@link MAX_FIELD_LENGTH}, and any other character is passed by. Ctrl+V is passed by too: the
   * browser's paste brings the text, to {@link paste}.
   *
   * @returns whether the field used it
   */
  char(ch: string): boolean {
    if (ch === ctrl('c')) {
      this.clear();
      return true;
    }
    const len = this.buffer.length;
    if (ch === ctrl('h')) {
      if (this.cursorAt > 0) {
        this.buffer = this.buffer.slice(0, this.cursorAt - 1) + this.buffer.slice(this.cursorAt);
        this.cursorAt--;
        if (this.cursorAt < this.scrolled) this.scrolled--;
      }
      return true;
    }
    if (ch === ctrl('a')) {
      this.cursorAt = 0;
      this.scrolled = 0;
      return true;
    }
    if (ch === ctrl('e')) {
      this.cursorAt = len;
      this.scrolled = this.cursorAt - this.widthInChars;
      return true;
    }
    const code = ch.length === 1 ? ch.charCodeAt(0) : 0;
    if (code < 32 || code > 126) return false;

    if (this.mode.overstrike) {
      if (this.cursorAt === MAX_FIELD_LENGTH) return true;
      this.buffer = this.buffer.slice(0, this.cursorAt) + ch + this.buffer.slice(this.cursorAt + 1);
    } else {
      if (len === MAX_FIELD_LENGTH) return true;
      this.buffer = this.buffer.slice(0, this.cursorAt) + ch + this.buffer.slice(this.cursorAt);
    }
    this.cursorAt++;
    if (this.cursorAt >= this.widthInChars) this.scrolled++;
    return true;
  }

  /**
   * `Field_Paste` (`:434–451`): text pasted, typed a character at a time so that insert,
   * overstrike and the length hold. `Sys_GetClipboardData` ends it where `strtok` cuts it, at the
   * first line break after anything else, so any line breaks before that are typed too, and a `\b`
   * among them backspaces.
   */
  paste(text: string): void {
    let start = 0;
    while (start < text.length && LINE_BREAKS.includes(text[start])) start++;
    let end = start;
    while (end < text.length && !LINE_BREAKS.includes(text[end])) end++;
    for (const ch of text.slice(0, end)) this.char(ch);
  }

  /**
   * `Field_VariableSizeDraw`'s window (`:355–373`): the line from its scroll, a character short of
   * its width so the cursor always has room, and the scroll brought back to show the line's end
   * where it has gone past it, as ioquake3's draw keeps it. Where the scroll is below 0 the window
   * starts before the line, which ioquake3 reads from outside its buffer.
   */
  window(): FieldWindow {
    let length = this.widthInChars - 1;
    const len = this.buffer.length;
    let start = 0;
    if (len > length) {
      if (this.scrolled + length > len) this.scrolled = len - length;
      start = this.scrolled;
    }
    if (start + length > len) length = len - start;
    return { start, length };
  }
}

/**
 * A field's text as ioquake3 draws it, its colour codes shown (`SCR_DrawSmallStringExt` and
 * `SCR_DrawStringExt` with `noColorEscape`, `cl_scrn.c:199–243, 267–294`): each character's colour
 * in `g_color_table`, white from the first, and a code's colour from its `^` on.
 */
export function typedColors(text: string): number[] {
  let color = COLOR_WHITE;
  return Array.from({ length: text.length }, (_, at) => {
    if (isColorCode(text, at)) color = colorIndex(text[at + 1]);
    return color;
  });
}

/** Whether a field's cursor shows at `realTime` milliseconds: 256 on, 256 off (`:396–398`). */
export function cursorShown(realTime: number): boolean {
  return ((realTime >> 8) & 1) === 0;
}
