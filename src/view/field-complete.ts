import { tokenize } from '../formats/q3config';
import { KEY_NAMES } from '../formats/q3-keys';
import { otherPlayerNames, playerNameToFieldString, type SaytoClient } from '../net/sayto';
import { fsPathCmp } from '../pak/mount';
import { MAX_EDIT_LINE, type FieldLine } from './edit-field';

/**
 * Tab on a field's line: ioquake3's `Field_AutoComplete` and what it calls (`common.c:3324–3577`,
 * `3634–3794`), which complete the line's last word from the commands and the cvars, or as the
 * command's own completer completes its arguments, and list the matches where there are several;
 * and the completers ioquake3 gives its commands. The lines cited here are `common.c`'s.
 * Engine-free.
 */

/** A cvar as Tab lists it: its name and its string. */
export interface CompletionCvar {
  name: string;
  value: string;
}

/**
 * `completionFunc_t` (`qcommon.h:436`): how a command's arguments complete, handed the completion,
 * where on the line the command starts, and the number of the word being completed, the command's
 * name being the first. It may finish later, as a listing comes in.
 */
export type ArgumentCompleter = (
  completion: Completion,
  from: number,
  argument: number
) => void | Promise<void>;

/** What Tab completes a word from, each list in the order ioquake3 walks it. */
export interface CompletionNames {
  /** `Cmd_CommandCompletion`'s: every command, the names for completion alone among them. */
  commands: readonly string[];
  /** `Cvar_CommandCompletion`'s. */
  cvars: readonly CompletionCvar[];
  /**
   * `Cmd_CompleteArgument`'s find (`cmd.c:741–752`): the completer of the command of that name,
   * matched without regard to case, where it has one.
   */
  completer(name: string): ArgumentCompleter | undefined;
}

/** `TRUNCATE_LENGTH` (`q_shared.h:857`): the room a cvar's listed value has, its `\0` included. */
const TRUNCATE_LENGTH = 64;

/** The longest line a field holds. */
const MAX_LINE = MAX_EDIT_LINE - 1;

/** `Key_KeynameCompletion`'s names (`cl_keys.c:1092–1098`), in `keynames`' order. */
const KEY_NAME_LIST = KEY_NAMES.map(([name]) => name);

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

/** `COM_StripExtension` (`q_shared.c:98–109`): a name cut at the last dot after its last slash. */
function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && name.lastIndexOf('/') < dot ? name.slice(0, dot) : name;
}

/** What `FindMatches` finds of a word: how many names start with it, and what they share. */
interface Matches {
  matches: number;
  shortest: string;
}

/**
 * `FindMatches` (`:3336–3359`) over names: those the word starts, counted, and the first cut to
 * what it shares with the others, in its own case.
 */
function findMatches(names: Iterable<string>, word: string): Matches {
  let matches = 0;
  let shortest = '';
  for (const name of names) {
    if (!startsWith(name, word)) continue;
    matches++;
    if (matches === 1) {
      shortest = name;
      continue;
    }
    let same = 0;
    while (same < shortest.length && same < name.length) {
      if (lower(shortest[same]) !== lower(name[same])) break;
      same++;
    }
    shortest = shortest.slice(0, same);
  }
  return { matches, shortest };
}

/**
 * One Tab's completion: the line as it changes, and the word being completed, which ioquake3 keeps
 * in globals for whatever Tab calls (`completionField`, `completionString`). A command's completer
 * is handed it, and completes its argument by one of the ways here.
 */
export class Completion {
  /** The line, as Tab has left it so far. */
  readonly field: FieldLine;
  private readonly names: CompletionNames;
  private readonly autochat: boolean;
  private readonly print: (text: string) => void;
  /** `completionString`: the word being completed, as the latest {@link command} found it. */
  private word = '';

  /**
   * @param line - The line Tab is pressed on.
   * @param names - The commands and cvars, and the commands' completers.
   * @param autochat - `con_autochat`.
   * @param print - `Com_Printf`, which lists the matches.
   */
  constructor(
    line: FieldLine,
    names: CompletionNames,
    autochat: boolean,
    print: (text: string) => void
  ) {
    this.field = { ...line };
    this.names = names;
    this.autochat = autochat;
    this.print = print;
  }

  /**
   * `Field_CompleteCommand` (`:3478–3563`) on the command that starts at `from`, past any spaces
   * and quotes, its words split with quotes taken as characters like any other. The word completed
   * is its last, or a new empty one where the line ends in a space.
   *
   * With `con_autochat`, a line that doesn't start with `\` gains one, a leading `/` becoming it,
   * whether or not anything matches; a line with no room for it is left as it is. Past the first
   * word, the command after the first `;` is completed as a command, and otherwise the command's
   * completer, if it has one, completes the word. The first word, its slash dropped, is completed
   * from the commands and then the cvars, as `doCommands` and `doCvars` say.
   *
   * @returns what the completer returned, which settles once the line is complete
   */
  command(from: number, doCommands: boolean, doCvars: boolean): void | Promise<void> {
    const { field, names } = this;
    let start = from;
    while (field.text[start] === ' ' || field.text[start] === '"') start++;
    const argv = tokenize(field.text.slice(start), true);
    // ioquake3 reads the character before the command's end, which is the line's.
    const trailing = field.text.endsWith(' ');
    const argument = argv.length + (trailing ? 1 : 0);
    this.word = trailing ? '' : (argv.at(-1) ?? '');

    const { text } = field;
    if (this.autochat && text !== '' && text[0] !== '\\') {
      if (text[0] !== '/') {
        if (text.length + 1 >= MAX_EDIT_LINE) return;
        field.text = `\\${text}`;
        field.cursor++;
      } else {
        field.text = `\\${text.slice(1)}`;
      }
    }

    if (argument > 1) {
      // ioquake3 keeps its pointer to the command, so `start` stays where it was before the `\`.
      const separator = field.text.indexOf(';', start);
      if (separator !== -1) return this.command(separator + 1, true, true);
      const base = /^[\\/]/.test(argv[0]) ? argv[0].slice(1) : argv[0];
      return names.completer(base)?.(this, start, argument);
    }

    if (this.word.startsWith('\\') || this.word.startsWith('/')) this.word = this.word.slice(1);
    if (this.word === '') return;

    const cvarNames = names.cvars.map(({ name }) => name);
    const found = [...(doCommands ? names.commands : []), ...(doCvars ? cvarNames : [])];
    const { shortest, matches } = findMatches(found, this.word);
    if (this.complete(shortest, matches)) return;
    // `PrintMatches` and `PrintCvarMatches` (`:3367–3386`).
    if (doCommands) {
      for (const name of names.commands) {
        if (startsWith(name, shortest)) this.print(`    ${name}\n`);
      }
    }
    if (doCvars) {
      for (const { name, value } of names.cvars) {
        if (!startsWith(name, shortest)) continue;
        this.print(`    ${name} = "${truncateLongString(value)}"\n`);
      }
    }
  }

  /**
   * `Com_SkipTokens` (`q_shared.c:1451–1472`) on the line from `from`, spaces alone separating:
   * where it goes on after that many runs of them, or `from` where it has fewer.
   */
  skipTokens(from: number, count: number): number {
    const { text } = this.field;
    let at = from;
    let runs = 0;
    while (runs < count) {
      if (text[at++] === ' ') {
        runs++;
        while (text[at] === ' ') at++;
      } else if (at >= text.length) {
        break;
      }
    }
    return runs === count ? at : from;
  }

  /**
   * The word completed from names, and the matches listed where there are several: `FindMatches`,
   * `Field_Complete` and `PrintMatches` run over them, as `Field_CompleteKeyname` runs them over
   * the key names (`:3443–3452`).
   */
  list(names: readonly string[]): void {
    const { shortest, matches } = findMatches(names, this.word);
    if (this.complete(shortest, matches)) return;
    for (const name of names) if (startsWith(name, shortest)) this.print(`    ${name}\n`);
  }

  /**
   * `Field_CompleteFilename` (`:3460–3471`) over files as a listing gives them: each name once,
   * without regard to case, the first kept (`FS_AddFileToList`, `files.c:2164–2179`), sorted by
   * {@link fsPathCmp} (`FS_SortFileList`, `:2693–2714`), and with `stripExtension` each without
   * its extension (`FS_FilenameCompletion`, `:4309–4332`); then completed as {@link list}
   * completes.
   */
  files(names: readonly string[], stripExtension: boolean): void {
    const kept: string[] = [];
    for (const name of names) {
      if (!kept.some((other) => lower(other) === lower(name))) kept.push(name);
    }
    kept.sort(fsPathCmp);
    this.list(stripExtension ? kept.map(withoutExtension) : kept);
  }

  /**
   * `Field_CompletePlayerName` (`:3742–3794`): the word completed from players' names, put on the
   * line as the field writes them ({@link playerNameToFieldString}). An empty word takes the first
   * name, and a word that is a whole name, where there are others, the one after it, so each Tab
   * moves on. Where several match, the line and the matches are listed before it changes, and a
   * space follows the name only where it is the only one there is.
   */
  playerNames(names: readonly string[]): void {
    if (names.length === 0) return;
    const { word } = this;
    const { matches, shortest: shared } = findMatches(names, word);
    let shortest = word === '' ? playerNameToFieldString(names[0]) : shared;
    if (word !== '' && lower(shortest) === lower(word) && names.length > 1) {
      const at = names.findIndex((name) => lower(name) === lower(word));
      if (at !== -1) shortest = playerNameToFieldString(names[(at + 1) % names.length]);
    }
    if (matches > 1) {
      this.print(`]${this.field.text}\n`);
      for (const name of names) if (startsWith(name, shortest)) this.print(`    ${name}\n`);
    }
    // `Field_CompletePlayerNameFinal` (`:3634–3656`).
    this.replaceWord(shortest, matches, names.length === 1);
  }

  /**
   * `Field_Complete` (`:3411–3435`): the word replaced by what the matches share, a space after a
   * single match. Several are about to be listed, under the line.
   *
   * @returns whether there is nothing to list
   */
  private complete(shortest: string, matches: number): boolean {
    this.replaceWord(shortest, matches, true);
    if (matches <= 1) return true;
    this.print(`]${this.field.text}\n`);
    return false;
  }

  /**
   * The line's last characters, as many as the word has, replaced by `shortest`, wherever the word
   * was, and the line cut to its room; the cursor at its end. A single match takes a space after
   * it with `space`, where there is room for one; with none, the cursor stays at the line's end,
   * where ioquake3's steps past it. With no match the line is left as it is.
   */
  private replaceWord(shortest: string, matches: number, space: boolean): void {
    if (matches === 0) return;
    const { field } = this;
    const offset = field.text.length - this.word.length;
    field.text = (field.text.slice(0, offset) + shortest).slice(0, MAX_LINE);
    if (matches === 1 && space && field.text.length < MAX_LINE) field.text += ' ';
    field.cursor = field.text.length;
  }
}

/**
 * `Field_AutoComplete` (`:3572–3577`): Tab on a field's line, as `Field_CompleteCommand` completes
 * it. A completer may wait for a listing, so the line comes back once it is complete; the matches
 * are printed as they are found.
 *
 * @param print - `Com_Printf`, which lists the matches.
 * @returns the line completed, its scroll as it was
 */
export async function autoComplete(
  line: FieldLine,
  names: CompletionNames,
  autochat: boolean,
  print: (text: string) => void
): Promise<FieldLine> {
  const completion = new Completion(line, names, autochat, print);
  await completion.command(0, true, true);
  return completion.field;
}

/** `Cvar_CompleteCvarName` (`cvar.c:1419–1429`): a cvar's name, as the command's second word. */
export const completeCvarName: ArgumentCompleter = (completion, from, argument) => {
  if (argument !== 2) return;
  const p = completion.skipTokens(from, 1);
  if (p > from) return completion.command(p, false, true);
};

/** `Key_CompleteUnbind` (`cl_keys.c:1104–1114`): a key's name, as the command's second word. */
export const completeUnbind: ArgumentCompleter = (completion, from, argument) => {
  if (argument === 2 && completion.skipTokens(from, 1) > from) completion.list(KEY_NAME_LIST);
};

/**
 * `Key_CompleteBind` (`cl_keys.c:1121–1141`): a key's name as the command's second word, and from
 * the third on, the command bound to it, completed as a command of its own.
 */
export const completeBind: ArgumentCompleter = (completion, from, argument) => {
  if (argument === 2) return completeUnbind(completion, from, argument);
  if (argument < 3) return;
  const p = completion.skipTokens(from, 2);
  if (p > from) return completion.command(p, true, true);
};

/**
 * A file's name as the command's second word, from the files `list` gives, as
 * {@link Completion.files} takes them: `Cmd_CompleteCfgName` (`cmd.c:849–853`) and
 * `Cmd_CompleteTxtName` (`cl_console.c:353–357`).
 */
export function completeFileName(
  list: () => readonly string[] | Promise<readonly string[]>,
  stripExtension = false
): ArgumentCompleter {
  return async (completion, _from, argument) => {
    if (argument === 2) completion.files(await list(), stripExtension);
  };
}

/**
 * `SV_CompleteMapName` (`sv_ccmds.c:1467–1471`): a map's name as the command's second word, the
 * names sorted as ioquake3 sorts its maps' BSPs, by their file names.
 *
 * @param names - The maps, as `map` takes them.
 */
export function completeMapName(names: () => readonly string[]): ArgumentCompleter {
  return completeFileName(() => names().map((name) => `${name}.bsp`), true);
}

/**
 * `CL_CompletePlayerName` (`cl_main.c:1803–1840`): a player's name as the command's second word,
 * from those of the other players in the client's match ({@link otherPlayerNames}), and none out
 * of one.
 *
 * @param client - The client in a match, or `null`.
 */
export function completePlayerName(
  client: () => Pick<SaytoClient, 'configstring' | 'clientNum'> | null
): ArgumentCompleter {
  return (completion, _from, argument) => {
    const playing = client();
    if (argument === 2 && playing) completion.playerNames(otherPlayerNames(playing));
  };
}
