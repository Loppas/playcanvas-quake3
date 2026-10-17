import { describe, expect, it } from 'vitest';

import { MAX_TOKEN_CHARS, comParse, comParseExt, parseCursor, textOfBytes } from './com-parse';

/** Every token of a text, as `COM_Parse` reads them, up to the end. */
function tokens(text: string): string[] {
  const cursor = parseCursor(text);
  const out: string[] = [];
  for (;;) {
    const token = comParse(cursor);
    if (cursor.at === null) break;
    out.push(token);
  }
  return out;
}

describe('comParse', () => {
  it('reads words and quoted strings, past whitespace of any kind', () => {
    expect(tokens('{\r\n"classname" "worldspawn"\n\t"message"   "The Garage"\n}')).toEqual([
      '{',
      'classname',
      'worldspawn',
      'message',
      'The Garage',
      '}'
    ]);
  });

  it("skips both kinds of comment, as NetRadiant's saves need", () => {
    const text = '// entity 0\n{\n//@$& layerdef "0" -1 0 0 0\n"a" /* note\n */ "1"\n// brush 0\n}';
    expect(tokens(text)).toEqual(['{', 'a', '1', '}']);
  });

  it("does not stop a word at a comment's slashes or at a quote", () => {
    expect(tokens('a//b c"d" "e"f')).toEqual(['a//b', 'c"d"', 'e', 'f']);
  });

  it('keeps line breaks inside a quoted string, with no escapes', () => {
    expect(tokens('"two\nlines" "back\\slash"')).toEqual(['two\nlines', 'back\\slash']);
  });

  it('gives an empty quoted string as a token, which only the cursor tells from the end', () => {
    const cursor = parseCursor('"" x');
    expect(comParse(cursor)).toBe('');
    expect(cursor.at).not.toBeNull();
    expect(comParse(cursor)).toBe('x');
    expect(comParse(cursor)).toBe('');
    expect(cursor.at).toBeNull();
    // And it stays at the end.
    expect(comParse(cursor)).toBe('');
  });

  it('runs an unclosed quote to the end of the text', () => {
    expect(tokens('a "never closed')).toEqual(['a', 'never closed']);
  });

  it('ends the text at its first NUL, as a C string ends', () => {
    expect(tokens('a b\0c d')).toEqual(['a', 'b']);
  });

  it('cuts a token to 1023 bytes without a word, and reads on past it', () => {
    const long = 'x'.repeat(MAX_TOKEN_CHARS + 10);
    expect(tokens(`${long} "${long}" y`)).toEqual([
      'x'.repeat(MAX_TOKEN_CHARS - 1),
      'x'.repeat(MAX_TOKEN_CHARS - 1),
      'y'
    ]);
  });
});

describe('comParseExt without line breaks', () => {
  it('stops at a line break with an empty token, and resumes on the next line', () => {
    const cursor = parseCursor('map\n"q3dm17"');
    expect(comParseExt(cursor, true)).toBe('map');
    expect(comParseExt(cursor, false)).toBe('');
    expect(comParseExt(cursor, false)).toBe('q3dm17');
  });

  it('counts a line comment as running to a line break, but not a block comment', () => {
    // `SkipWhitespace` is what notices a line break, and a block comment skips its own.
    const block = parseCursor('key /*\n*/ value');
    comParseExt(block, true);
    expect(comParseExt(block, false)).toBe('value');

    const line = parseCursor('key // note\nvalue');
    comParseExt(line, true);
    expect(comParseExt(line, false)).toBe('');
  });
});

describe('textOfBytes', () => {
  it('makes each byte one character, so no byte is lost or merged', () => {
    const bytes = Uint8Array.from([0x61, 0x00, 0x80, 0xe9, 0xff]);
    const text = textOfBytes(bytes);
    expect(Array.from(text, (c) => c.charCodeAt(0))).toEqual([0x61, 0x00, 0x80, 0xe9, 0xff]);
  });

  it('reads a file longer than one call can spread', () => {
    expect(textOfBytes(new Uint8Array(100_000).fill(0x41))).toHaveLength(100_000);
  });
});
