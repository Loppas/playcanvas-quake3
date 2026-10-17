/**
 * C's number readers, as Quake 3's text formats lean on them: `atoi`, `atof` and `sscanf`'s
 * `"%f %f %f"`, and `strtol`, as dpmaster reads a protocol number. None of them fails. What they
 * cannot read is 0, or is left as it was.
 *
 * C's `strtod` also reads hexadecimal, `inf` and `nan`, which these do not. No file the port reads
 * holds one.
 */

/** A decimal float as `%f` reads one: a sign, digits with an optional point, and an exponent. */
const C_FLOAT = /^[\t\n\v\f\r ]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

/** C's `atoi`: the leading integer, or 0. */
export function atoi(text: string): number {
  const value = Number.parseInt(text, 10);
  return Number.isNaN(value) ? 0 : value;
}

/** C's `atof`: the leading number, or 0. */
export function atof(text: string): number {
  const match = C_FLOAT.exec(text);
  return match ? Number.parseFloat(match[1]) : 0;
}

/**
 * C's `strtol` with a base of 0: spaces skipped, a sign, and then hexadecimal after `0x`, octal
 * after any other leading `0`, or decimal.
 *
 * @param start - Where in `text` to begin, as the pointer C's is handed.
 * @returns the number, and where reading stopped: at `start` itself when there were no digits
 */
export function strtol(text: string, start = 0): { value: number; end: number } {
  let at = start;
  while (at < text.length && '\t\n\v\f\r '.includes(text[at])) at++;
  const sign = text[at] === '-' ? -1 : 1;
  if (text[at] === '-' || text[at] === '+') at++;

  let base = 10;
  if (text[at] === '0' && /^[xX][0-9a-fA-F]/.test(text.slice(at + 1, at + 3))) {
    base = 16;
    at += 2;
  } else if (text[at] === '0') {
    base = 8;
  }

  const first = at;
  let value = 0;
  for (; at < text.length; at++) {
    const digit = Number.parseInt(text[at], 16);
    if (Number.isNaN(digit) || digit >= base) break;
    value = value * base + digit;
  }
  return at === first ? { value: 0, end: start } : { value: sign * value, end: at };
}

/**
 * `sscanf( text, "%f %f %f", … )`: up to three numbers, stopping at the first that will not read.
 *
 * @returns the numbers read, in order, which may be fewer than three
 */
export function scanFloats(text: string): number[] {
  const values: number[] = [];
  let rest = text;
  while (values.length < 3) {
    const match = C_FLOAT.exec(rest);
    if (!match) break;
    values.push(Number.parseFloat(match[1]));
    rest = rest.slice(match[0].length);
  }
  return values;
}
