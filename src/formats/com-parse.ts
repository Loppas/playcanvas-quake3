/**
 * Quake 3's tokenizer, `COM_ParseExt` (`q_shared.c:461–570`), which the game reads its text files
 * through: a map's entities, an arena file, a model's `animation.cfg`.
 *
 * A token is a quoted string, or a word that runs to the next whitespace, after any whitespace and
 * `//` or `/* *​/` comments. A quoted string may hold line breaks and has no escapes. A word does
 * not stop at a comment's slashes or at a quote.
 *
 * Text is read byte for byte: {@link textOfBytes} makes each byte one character, so a length
 * here is a length in bytes, as Q3's limits are. A byte above 127 is part of a word, as it is
 * where C's `char` is unsigned. Where it is signed, as on x86, Q3 skips such a byte as
 * whitespace. The retail maps and arena files hold none, and splat-maps' lint refuses them.
 */

/** `MAX_TOKEN_CHARS` (`q_shared.h:235`): a token keeps one byte less, for its NUL. */
export const MAX_TOKEN_CHARS = 1024;

/** Where a parse has got to in a text: the `char *` that `COM_Parse` moves along. */
export interface ParseCursor {
  readonly text: string;
  /**
   * Where the next token is looked for, or `null` once the text has run out, as `COM_Parse` sets
   * its pointer to `NULL`. An empty quoted string is a token, so only this tells the two apart.
   */
  at: number | null;
}

/**
 * A cursor at the start of a text, which ends at its first NUL, as a C string does.
 *
 * @param text - The file's contents, a byte to a character.
 */
export function parseCursor(text: string): ParseCursor {
  const nul = text.indexOf('\0');
  return { text: nul < 0 ? text : text.slice(0, nul), at: 0 };
}

/**
 * A file's bytes as text, one character to each byte, so that no byte is lost or merged.
 *
 * @param bytes - The file.
 */
export function textOfBytes(bytes: Uint8Array): string {
  let text = '';
  // A chunk at a time, since spreading a whole file into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return text;
}

/**
 * `COM_Parse`: the next token, looking across line breaks.
 *
 * @returns the token, or `''` at the end of the text, as `com_token` is left empty there
 */
export function comParse(cursor: ParseCursor): string {
  return comParseExt(cursor, true);
}

/**
 * `COM_ParseExt`: the next token.
 *
 * @param allowLineBreaks - False to stop at a line break instead, which gives `''` and leaves the
 *   cursor at the next line's first token. A line break inside a block comment does not count,
 *   since Q3 notices only those it skips as whitespace.
 * @returns the token, cut to {@link MAX_TOKEN_CHARS} less one without a word, or `''`
 */
export function comParseExt(cursor: ParseCursor, allowLineBreaks: boolean): string {
  if (cursor.at === null) return '';
  const { text } = cursor;
  let at = cursor.at;
  let hasNewLines = false;

  for (;;) {
    // `SkipWhitespace`: every byte up to a space, line breaks noted.
    while (at < text.length && text.charCodeAt(at) <= 32) {
      if (text.charCodeAt(at) === 10) hasNewLines = true;
      at++;
    }
    if (at >= text.length) {
      cursor.at = null;
      return '';
    }
    if (hasNewLines && !allowLineBreaks) {
      cursor.at = at;
      return '';
    }

    if (text.startsWith('//', at)) {
      at += 2;
      while (at < text.length && text[at] !== '\n') at++;
    } else if (text.startsWith('/*', at)) {
      at += 2;
      while (at < text.length && !text.startsWith('*/', at)) at++;
      if (at < text.length) at += 2;
    } else {
      break;
    }
  }

  if (text[at] === '"') {
    const start = at + 1;
    const close = text.indexOf('"', start);
    const end = close < 0 ? text.length : close;
    cursor.at = close < 0 ? text.length : close + 1;
    return text.slice(start, Math.min(end, start + MAX_TOKEN_CHARS - 1));
  }

  const start = at;
  do at++;
  while (at < text.length && text.charCodeAt(at) > 32);
  cursor.at = at;
  return text.slice(start, Math.min(at, start + MAX_TOKEN_CHARS - 1));
}
