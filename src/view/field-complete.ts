import { tokenize } from '../formats/q3config';
import { MAX_EDIT_LINE, type FieldLine } from './edit-field';

/**
 * Tab on a field's line: ioquake3's `Field_AutoComplete` and what it calls (`common.c:3324–3577`),
 * which complete the line's last word from the commands and the cvars, and list the matches where
 * there are several. The lines cited here are `common.c`'s. Engine-free.
 */

/** A cvar as Tab lists it: its name and its string. */
export interface CompletionCvar {
  name: string;
  value: string;
}

/** What Tab completes a word from, each list in the order ioquake3 walks it. */
export interface CompletionNames {
  /** `Cmd_CommandCompletion`'s: every command, the names for completion alone among them. */
  commands: readonly string[];
  /** `Cvar_CommandCompletion`'s. */
  cvars: readonly CompletionCvar[];
}

/** `TRUNCATE_LENGTH` (`q_shared.h:857`): the room a cvar's listed value has, its `\0` included. */
const TRUNCATE_LENGTH = 64;

/** The longest line a field holds. */
const MAX_LINE = MAX_EDIT_LINE - 1;

/** C's `tolower`: ASCII alone. */
const lower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** `Q_stricmpn` to the prefix's length: whether a name starts with it, without regard to case. */
const startsWith = (name: string, prefix: string) =>
  lower(name.slice(0, prefix.length)) === lower(prefix);

/**
 * `Com_TruncateLongString` (`q_shared.c:1059–1071`): a value as it is listed. One of 64
 * characters loses its last, and a longer one its middle.
 */
function truncateLongString(value: string): string {
  if (value.length <= TRUNCATE_LENGTH) return value.slice(0, TRUNCATE_LENGTH - 1);
  const half = TRUNCATE_LENGTH / 2;
  return `${value.slice(0, half - 4)} ... ${value.slice(value.length - half + 3)}`;
}

/**
 * `Field_AutoComplete` (`:3572–3577`): Tab on a field's line, as `Field_CompleteCommand` completes
 * it.
 *
 * @param print - `Com_Printf`, which lists the matches.
 * @returns the line completed, its scroll as it was
 */
export function autoComplete(
  line: FieldLine,
  names: CompletionNames,
  autochat: boolean,
  print: (text: string) => void
): FieldLine {
  const field = { ...line };
  completeCommand(field, 0, names, autochat, print);
  return field;
}

/**
 * `Field_CompleteCommand` (`:3478–3563`) on the command that starts at `from`, past any spaces
 * and quotes, its words split with quotes taken as characters like any other. The word completed
 * is its last, or a new empty one where the line ends in a space.
 *
 * With `con_autochat`, a line that doesn't start with `\` gains one, a leading `/` becoming it,
 * whether or not anything matches; a line with no room for it is left as it is. Past the first
 * word, the command after the first `;` is completed as a command, and otherwise nothing: no
 * command here completes its arguments. The first word, its slash dropped, is completed from the
 * commands and then the cvars.
 */
function completeCommand(
  field: FieldLine,
  from: number,
  names: CompletionNames,
  autochat: boolean,
  print: (text: string) => void
): void {
  let start = from;
  while (field.text[start] === ' ' || field.text[start] === '"') start++;
  const argv = tokenize(field.text.slice(start), true);
  // ioquake3 reads the character before the command's end, which is the line's.
  const trailing = field.text.endsWith(' ');
  const argument = argv.length + (trailing ? 1 : 0);
  let word = trailing ? '' : (argv.at(-1) ?? '');

  const { text } = field;
  if (autochat && text !== '' && text[0] !== '\\') {
    if (text[0] !== '/') {
      if (text.length + 1 >= MAX_EDIT_LINE) return;
      field.text = `\\${text}`;
      field.cursor++;
    } else {
      field.text = `\\${text.slice(1)}`;
    }
  }

  if (argument > 1) {
    const separator = field.text.indexOf(';', start);
    if (separator !== -1) completeCommand(field, separator + 1, names, autochat, print);
    return;
  }

  if (word.startsWith('\\') || word.startsWith('/')) word = word.slice(1);
  if (word === '') return;

  // `FindMatches` (`:3336–3359`): the matches counted, and the first cut to what they share.
  let matches = 0;
  let shortest = '';
  const find = (name: string) => {
    if (!startsWith(name, word)) return;
    matches++;
    if (matches === 1) {
      shortest = name;
      return;
    }
    let same = 0;
    while (same < shortest.length && same < name.length) {
      if (lower(shortest[same]) !== lower(name[same])) break;
      same++;
    }
    shortest = shortest.slice(0, same);
  };
  for (const name of names.commands) find(name);
  for (const { name } of names.cvars) find(name);

  if (complete(field, word, shortest, matches, print)) return;
  // `PrintMatches` and `PrintCvarMatches` (`:3367–3386`).
  for (const name of names.commands) {
    if (startsWith(name, shortest)) print(`    ${name}\n`);
  }
  for (const { name, value } of names.cvars) {
    if (startsWith(name, shortest)) print(`    ${name} = "${truncateLongString(value)}"\n`);
  }
}

/**
 * `Field_Complete` (`:3411–3435`): the line's last characters, as many as the word has, replaced
 * by what the matches share, wherever the word was, and the line cut to its room; the cursor at its
 * end. One match takes a space after it, where there is room for one; with none, the cursor stays
 * at the line's end, where ioquake3's steps past it. Several are about to be listed, under the
 * line.
 *
 * @returns whether there is nothing to list
 */
function complete(
  field: FieldLine,
  word: string,
  shortest: string,
  matches: number,
  print: (text: string) => void
): boolean {
  if (matches === 0) return true;
  const offset = field.text.length - word.length;
  field.text = (field.text.slice(0, offset) + shortest).slice(0, MAX_LINE);
  if (matches === 1 && field.text.length < MAX_LINE) field.text += ' ';
  field.cursor = field.text.length;
  if (matches === 1) return true;
  print(`]${field.text}\n`);
  return false;
}
