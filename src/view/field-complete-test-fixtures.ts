import { CommandRouter } from '../settings/command-router';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { MAX_EDIT_LINE } from './edit-field';
import { autoComplete, type CompletionCvar, type CompletionNames } from './field-complete';

/**
 * Tab's corpus: seeded commands, cvars and lines, each line completed as the twin of ioquake3's
 * own `Field_AutoComplete` completes it over the same names, the line, its cursor and what was
 * printed digested as the twin digests them. The twin adds `Cmd_Init`'s commands and then the
 * corpus's as `Cmd_AddCommand` adds them, as a {@link CommandRouter} does, and reads what
 * {@link completeInputs} writes.
 */

/** A line Tab is pressed on: its text, its cursor, and whether `con_autochat` is on. */
export interface CompleteLine {
  text: string;
  cursor: number;
  autochat: boolean;
}

/**
 * What Tab is pressed over: the commands added after the router's own, in the order they are
 * added; the cvars, in the order `Cvar_CommandCompletion` walks them; and the lines.
 */
export interface CompleteCorpus {
  commands: readonly string[];
  cvars: readonly CompletionCvar[];
  lines: readonly CompleteLine[];
}

/** What a corpus came to: how many lines Tab changed, and how many it listed matches for. */
export interface CompleteRun {
  lines: number;
  changed: number;
  listed: number;
  digest: string;
}

/** A line after Tab: its text and cursor, and what was printed. */
export type Completed = readonly [text: string, cursor: number, printed: string];

/** A hand case: the line, and what the twin gives for it. */
export type CompleteCase = readonly [line: CompleteLine, ...answer: Completed];

/** The longest line a field holds. */
const MAX_LINE = MAX_EDIT_LINE - 1;

/** Names are a prefix and a suffix, so many share a start, and some are `Cmd_Init`'s. */
const PREFIXES = ['cg_', 'cl_', 'con_', 'sv_', 'g_', 's', 'se', 'map', 'e', '+', '-', 'x', ''];
const SUFFIXES = [
  'draw',
  'drawfps',
  'drawtimer',
  'draw2d',
  'run',
  'maxpackets',
  'autochat',
  'notifytime',
  'a',
  'ab',
  'abc',
  'et',
  'eta',
  'ay',
  'cho',
  'xec',
  'attack',
  '_restart',
  ''
];

/** Words that are no name's start: quotes, comments, separators and slashes among them. */
const JUNK = ['x', 'zz', 'hi', '"quoted', 'a"b', '1', '//c', '/*c', '*/', ';', '\\', '/', '"'];

/** What goes before a line's first word, and between its words. */
const LEADS = ['', '', '', ' ', '  ', '"', ' "', '\\', '/', '//', '\\ ', '/"'];
const SEPARATORS = [' ', ' ', ' ', '  ', ';', ';', '; ', ' ;', ' "', '" ', '"'];

/** The lengths a cvar's value is made in: around where `Com_TruncateLongString` cuts it. */
const VALUE_LENGTHS = [0, 1, 5, 28, 62, 63, 64, 65, 66, 100];

/** The page's printable ASCII, from the space. */
const printable = (pick: (n: number) => number) => String.fromCharCode(32 + pick(95));

/** Some of a word's letters in the other case. */
function flipCase(word: string, pick: (n: number) => number): string {
  return Array.from(word, (ch) => (pick(4) === 0 ? swapCase(ch) : ch)).join('');
}

const swapCase = (ch: string) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());

function nameFrom(pick: (n: number) => number): string {
  const name = PREFIXES[pick(PREFIXES.length)] + SUFFIXES[pick(SUFFIXES.length)];
  return flipCase(name === '' ? 'e' : name, pick);
}

/** A word of a line: a name's start in either case, a whole name, or junk. */
function wordFrom(pick: (n: number) => number, names: readonly string[]): string {
  const r = pick(10);
  const name = names[pick(names.length)];
  if (r < 6) return flipCase(name.slice(0, pick(name.length + 1)), pick);
  if (r < 8) return name;
  return JUNK[pick(JUNK.length)];
}

/**
 * A line: up to four words after a lead, now and then a trailing space, and one in five padded
 * to within a few characters of a full line, by leading spaces or by an `echo` and a `;` before it.
 */
function lineFrom(pick: (n: number) => number, names: readonly string[]): CompleteLine {
  let text = LEADS[pick(LEADS.length)];
  const words = 1 + pick(4);
  for (let w = 0; w < words; w++) {
    if (w > 0) text += SEPARATORS[pick(SEPARATORS.length)];
    text += wordFrom(pick, names);
  }
  if (pick(5) === 0) text += ' ';
  if (pick(5) === 0) {
    const room = MAX_LINE - pick(8) - text.length;
    if (pick(2) === 0) text = ' '.repeat(Math.max(room, 0)) + text;
    else text = `echo ${'x'.repeat(Math.max(room - 6, 0))};${text}`;
  }
  text = text.slice(0, MAX_LINE);
  return { text, cursor: pick(text.length + 1), autochat: pick(2) === 1 };
}

/**
 * A corpus from `seed`: 30 commands, some alike but for case, which the list keeps the first of;
 * 30 cvars, none alike but for case, as a cvar store holds them, their values around 63, 64 and 65
 * characters among others; and `count` lines over every name.
 */
export function completeCorpus(seed: number, count: number): CompleteCorpus {
  const random = new Seeded(seed);
  // The high bits: the low ones cycle in a few draws.
  const pick = (n: number) => (random.next() >>> 8) % n;
  const commands = Array.from({ length: 30 }, () => nameFrom(pick));
  const cvars: CompletionCvar[] = [];
  while (cvars.length < 30) {
    const name = nameFrom(pick);
    const length = VALUE_LENGTHS[pick(VALUE_LENGTHS.length)];
    const value = Array.from({ length }, () => printable(pick)).join('');
    if (!cvars.some((cvar) => cvar.name.toLowerCase() === name.toLowerCase())) {
      cvars.push({ name, value });
    }
  }
  const names = [...commands, ...cvars.map(({ name }) => name), 'cmdlist', 'exec', 'echo'];
  const lines = Array.from({ length: count }, () => lineFrom(pick, names));
  return { commands, cvars, lines };
}

/**
 * A corpus as the twin reads it: the commands' count and each one's length as an int and its
 * bytes; the cvars' count and each one's name and value so; the lines' count and each one's text
 * so, its cursor, and 1 or 0 for `con_autochat`.
 */
export function completeInputs(corpus: CompleteCorpus): Uint8Array {
  const bytes: number[] = [];
  const int = (n: number) => {
    for (let i = 0; i < 4; i++) bytes.push((n >>> (8 * i)) & 0xff);
  };
  const text = (s: string) => {
    int(s.length);
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };
  int(corpus.commands.length);
  corpus.commands.forEach(text);
  int(corpus.cvars.length);
  for (const { name, value } of corpus.cvars) {
    text(name);
    text(value);
  }
  int(corpus.lines.length);
  for (const line of corpus.lines) {
    text(line.text);
    int(line.cursor);
    int(line.autochat ? 1 : 0);
  }
  return Uint8Array.from(bytes);
}

/** The names Tab completes from: a router's, with the corpus's added, and the corpus's cvars. */
export function corpusNames(corpus: Pick<CompleteCorpus, 'commands' | 'cvars'>): CompletionNames {
  const router = new CommandRouter({
    cvar: () => false,
    cvarString: () => '',
    game: () => false,
    readCfg: () => Promise.resolve(undefined),
    print: () => {}
  });
  for (const name of corpus.commands) router.add(name);
  return { commands: router.names(), cvars: corpus.cvars };
}

/** Each line as Tab leaves it. */
export function completeLines(corpus: CompleteCorpus): Completed[] {
  const names = corpusNames(corpus);
  return corpus.lines.map(({ text, cursor, autochat }) => {
    let printed = '';
    const done = autoComplete({ text, cursor, scroll: 0 }, names, autochat, (t) => (printed += t));
    return [done.text, done.cursor, printed];
  });
}

/** A string's bytes, as C's `char`s. */
function digestText(digest: Digest, text: string): void {
  digest.int(text.length);
  digest.uint8s(Uint8Array.from(text, (ch) => ch.charCodeAt(0)), 0, text.length);
}

/** The corpus through Tab, digested as the twin digests it: each line, its cursor and its print. */
export function runComplete(corpus: CompleteCorpus): CompleteRun {
  const digest = new Digest();
  const run: CompleteRun = { lines: 0, changed: 0, listed: 0, digest: '' };
  completeLines(corpus).forEach(([text, cursor, printed], i) => {
    run.lines++;
    if (text !== corpus.lines[i].text) run.changed++;
    if (printed !== '') run.listed++;
    digestText(digest, text);
    digest.int(cursor);
    digestText(digest, printed);
  });
  run.digest = digest.hex();
  return run;
}

/** The hand cases' commands, added after the router's own. */
export const CASE_COMMANDS = ['cmd', 'map', 'map_restart', 'say', 'say_team', '+attack', 'Clear'];

/**
 * The hand cases' cvars: values empty, short, and of 63, 64 and 65 characters and longer; and one
 * a command shares its name with.
 */
export const CASE_CVARS: readonly CompletionCvar[] = [
  { name: 'cg_drawFPS', value: '0' },
  { name: 'cg_drawTimer', value: '1' },
  { name: 'cg_draw2D', value: '1' },
  { name: 'con_autochat', value: '1' },
  { name: 'con_notifytime', value: '3' },
  { name: 'sv_hostname', value: `${'abcdefghij'.repeat(6)}klm` },
  { name: 'sv_motd', value: `${'abcdefghij'.repeat(6)}klmn` },
  { name: 'sv_master1', value: `${'abcdefghij'.repeat(6)}klmno` },
  { name: 'sv_master2', value: `${'0123456789'.repeat(9)}` },
  { name: 'Cmd', value: '' }
];

/** A line with `con_autochat` on or off, its cursor at its end unless it says otherwise. */
function typed(autochat: boolean) {
  return (text: string, cursor = text.length): CompleteLine => ({ text, cursor, autochat });
}
const on = typed(true);
const off = typed(false);
const spaces = (n: number) => ' '.repeat(n);

/** How the hand cases list the `cg_draw` cvars, and the `sv_` ones. */
const DRAWS = '    cg_drawFPS = "0"\n    cg_drawTimer = "1"\n    cg_draw2D = "1"\n';
const SVS =
  `    sv_hostname = "${'abcdefghij'.repeat(6)}klm"\n` +
  `    sv_motd = "${'abcdefghij'.repeat(6)}klm"\n` +
  '    sv_master1 = "abcdefghijabcdefghijabcdefgh ... ghijabcdefghijabcdefghijklmno"\n' +
  '    sv_master2 = "0123456789012345678901234567 ... 12345678901234567890123456789"\n';

/**
 * Hand cases over {@link CASE_COMMANDS} and {@link CASE_CVARS}, each with the twin's answer: one
 * match, with `con_autochat` on and off and with either slash; several, listed in the first
 * match's case, a cvar with its value cut by its length; after a `;`, and before one; an argument,
 * an empty line, one of spaces, and no match; a word after a quote or a comment, and before one;
 * and lines too full for the whole match, its space, or the slash. Where ioquake3's cursor steps
 * past the line, the answer is the port's, at the line's end.
 */
export const COMPLETE_CASES: readonly CompleteCase[] = [
  [on('cmdl'), '\\cmdlist ', 9, ''],
  [off('cmdl'), 'cmdlist ', 8, ''],
  [on('/cmdl'), '\\cmdlist ', 9, ''],
  [off('/cmdl'), '/cmdlist ', 9, ''],
  [on('\\cmdl'), '\\cmdlist ', 9, ''],
  [on('cmdlist'), '\\cmdlist ', 9, ''],
  [on('+at'), '\\+attack ', 9, ''],
  [off('clear'), 'Clear ', 6, ''],
  [on('cg_dr'), '\\cg_draw', 8, `]\\cg_draw\n${DRAWS}`],
  [on('CG_DR'), '\\cg_draw', 8, `]\\cg_draw\n${DRAWS}`],
  [on('cg_draw', 3), '\\cg_draw', 8, `]\\cg_draw\n${DRAWS}`],
  [on('con_'), '\\con_', 5, ']\\con_\n    con_autochat = "1"\n    con_notifytime = "3"\n'],
  [on('cmd'), '\\cmd', 4, ']\\cmd\n    cmd\n    cmdlist\n    Cmd = ""\n'],
  [off('m'), 'map', 3, ']map\n    map_restart\n    map\n'],
  [on('sv_'), '\\sv_', 4, `]\\sv_\n${SVS}`],
  [off('s'), 's', 1, `]s\n    say_team\n    say\n${SVS}`],
  [on('echo hi;con_a'), '\\echo hi;con_autochat ', 22, ''],
  [off('echo "a b";cmdl'), 'echo "a b";cmdlist ', 19, ''],
  [on('echo;con_a'), '\\echo;con_a', 11, ''],
  [off('echo "a;b" cmdl'), 'echo "a;b" cmdl', 15, ''],
  [on('echo hi;'), '\\echo hi;', 9, ''],
  [on('echo hi; '), '\\echo hi; ', 10, ''],
  [on('map '), '\\map ', 5, ''],
  [on(''), '', 0, ''],
  [on(spaces(3), 1), `\\${spaces(3)}`, 2, ''],
  [on('xyz', 1), '\\xyz', 2, ''],
  [on('"cmdl'), '\\"cmdlist ', 10, ''],
  [off('/*x*/cmdl'), '/*x*/cmdlist ', 13, ''],
  [off('cmdl // x'), 'cmdl cmdlist ', 13, ''],
  [off(`${spaces(249)}cmdl`), `${spaces(249)}cmdlis`, 255, ''],
  [off(`${spaces(251)}cmdl`), `${spaces(251)}cmdl`, 255, ''],
  [on(`${spaces(250)}cmdl`), `\\${spaces(250)}cmdl`, 255, ''],
  [on(`${spaces(251)}cmdl`), `${spaces(251)}cmdl`, 255, '']
];

