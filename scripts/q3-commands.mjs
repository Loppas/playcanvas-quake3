/**
 * Quake 3's commands, read out of a config's text as `exec` reads them: split into lines by
 * `Cbuf_Execute`, then into tokens by `Cmd_TokenizeString`, with Q3's quoting and comments. The
 * page reads `q3config.cfg` through them (`src/formats/q3config.ts`), and so does the desktop
 * shell, for the settings Chromium takes up as it starts.
 */

/** `MAX_STRING_TOKENS` (`q_shared.h:234`): a command's tokens past this many are dropped. */
const MAX_STRING_TOKENS = 1024;

/**
 * Split a config into command lines, as `Cbuf_Execute` does (`cmd.c:172–249`).
 *
 * A line ends at a newline, or at a semicolon outside quotes. A `//` comment runs to the end of
 * its line, semicolons and all, and a block comment keeps its newlines and semicolons to itself.
 * The comments stay in the lines, for {@link tokenize} to skip.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function commandLines(text) {
  /** @type {string[]} */
  const lines = [];
  // Held from one line to the next, as `Cbuf_Execute` holds them.
  let inStar = false;
  let inSlash = false;
  let rest = text;
  while (rest.length > 0) {
    let quotes = 0;
    let i = 0;
    for (; i < rest.length; i++) {
      const char = rest[i];
      if (char === '"') quotes++;
      if (quotes % 2 === 0) {
        if (i < rest.length - 1) {
          const next = rest[i + 1];
          if (!inStar && char === '/' && next === '/') inSlash = true;
          else if (!inSlash && char === '/' && next === '*') inStar = true;
          else if (inStar && char === '*' && next === '/') {
            // The line ends on the comment's `*`; the `/` goes with the separator.
            inStar = false;
            i++;
            break;
          }
        }
        if (!inSlash && !inStar && char === ';') break;
      }
      if (!inStar && (char === '\n' || char === '\r')) {
        inSlash = false;
        break;
      }
    }
    lines.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  return lines;
}

/**
 * Split a command line into its tokens, as `Cmd_TokenizeString` does (`cmd.c:499–599`).
 *
 * Whitespace is any character up to the space. A quoted token runs to the next quote, spaces and
 * all, with no escapes. A bare token ends at whitespace, a quote or a comment, and a `//` comment
 * ends the line.
 *
 * @param {string} line
 * @param {boolean} [ignoreQuotes] - `Cmd_TokenizeStringIgnoreQuotes`: a quote is a character of
 *   its token like any other.
 * @returns {string[]}
 */
export function tokenize(line, ignoreQuotes = false) {
  /** @type {string[]} */
  const argv = [];
  const end = line.length;
  /** @param {number} at */
  const isSpace = (at) => line.charCodeAt(at) <= 32;
  /** @param {number} at */
  const opensComment = (at) => line[at] === '/' && (line[at + 1] === '/' || line[at + 1] === '*');

  let i = 0;
  while (argv.length < MAX_STRING_TOKENS) {
    // Whitespace and comments before the token.
    for (;;) {
      while (i < end && isSpace(i)) i++;
      if (i >= end || (line[i] === '/' && line[i + 1] === '/')) return argv;
      if (line[i] !== '/' || line[i + 1] !== '*') break;
      while (i < end && (line[i] !== '*' || line[i + 1] !== '/')) i++;
      if (i >= end) return argv;
      i += 2;
    }

    if (!ignoreQuotes && line[i] === '"') {
      const start = ++i;
      while (i < end && line[i] !== '"') i++;
      argv.push(line.slice(start, i));
      if (i >= end) return argv;
      i++;
      continue;
    }

    const start = i;
    while (i < end && !isSpace(i) && (ignoreQuotes || line[i] !== '"') && !opensComment(i)) i++;
    argv.push(line.slice(start, i));
    if (i >= end) return argv;
  }
  return argv;
}

/**
 * Every command in a config, as `exec` would run them: each line's tokens, blank lines left out.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function configCommands(text) {
  return commandLines(text)
    .map((line) => tokenize(line))
    .filter((argv) => argv.length > 0);
}
