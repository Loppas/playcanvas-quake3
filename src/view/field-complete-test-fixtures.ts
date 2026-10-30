import { cleanStr } from '../formats/color-codes';
import { KEY_NAMES } from '../formats/q3-keys';
import { CONFIGSTRING } from '../net/commands';
import { playerNameToFieldString } from '../net/sayto';
import { CommandRouter } from '../settings/command-router';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { MAX_EDIT_LINE } from './edit-field';
import {
  autoComplete,
  completeBind,
  completeCvarName,
  completeFileName,
  completeMapName,
  completePlayerName,
  completeUnbind,
  type ArgumentCompleter,
  type CompletionCvar,
  type CompletionNames
} from './field-complete';

/**
 * Tab's corpus: seeded commands, cvars, listings, players and lines, each line completed as the
 * twin of ioquake3's own `Field_AutoComplete` completes it over the same names, the line, its
 * cursor and what was printed digested as the twin digests them. The twin adds `Cmd_Init`'s
 * commands, with their completers, and then the corpus's as `Cmd_AddCommand` and
 * `Cmd_SetCommandCompletionFunc` add them, as a {@link CommandRouter} does, and reads what
 * {@link completeInputs} writes.
 */

/** A line Tab is pressed on: its text, its cursor, and whether `con_autochat` is on. */
export interface CompleteLine {
  text: string;
  cursor: number;
  autochat: boolean;
}

/** The completers a corpus's command can be given, by the number the twin knows each by. */
export const COMPLETER = {
  NONE: 0,
  /** `Cmd_CompleteCfgName`, over {@link CompleteNames.cfgs}. */
  CFG: 1,
  /** `Cmd_CompleteTxtName`, over {@link CompleteNames.txts}. */
  TXT: 2,
  CVAR: 3,
  BIND: 4,
  UNBIND: 5,
  /** `SV_CompleteMapName`, over {@link CompleteNames.maps}. */
  MAP: 6,
  /** `CL_CompletePlayerName`, over {@link CompleteNames.players}. */
  PLAYER: 7
} as const;

export type Completer = (typeof COMPLETER)[keyof typeof COMPLETER];

/** What Tab is pressed over, its lines aside. */
export interface CompleteNames {
  /**
   * The commands added after the router's own, in the order they are added, each with the
   * completer it is then given: one a name already taken gives that command.
   */
  commands: readonly (readonly [name: string, completer: Completer])[];
  /** The cvars, in the order `Cvar_CommandCompletion` walks them. */
  cvars: readonly CompletionCvar[];
  /** The cfgs, as a listing gives them, for `exec` and {@link COMPLETER.CFG}. */
  cfgs: readonly string[];
  /** The `.txt` files, as a listing gives them. */
  txts: readonly string[];
  /** The maps, as `map` takes them: lower case, each once. The twin lists each as its BSP. */
  maps: readonly string[];
  /** The serverinfo configstring. */
  serverinfo: string;
  /** The players' configstrings, a slot to each from the first. */
  players: readonly string[];
  /** The client's own slot. */
  clientNum: number;
}

/** What Tab is pressed over, and the lines. */
export interface CompleteCorpus extends CompleteNames {
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

/** No listings and no players. */
const NOTHING_LISTED = {
  cfgs: [],
  txts: [],
  maps: [],
  serverinfo: '',
  players: [],
  clientNum: 0
} as const;

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

/** A name's start in either case, the whole name, or junk. */
function wordFrom(pick: (n: number) => number, names: readonly string[]): string {
  const r = pick(10);
  const name = names[pick(names.length)];
  if (r < 6) return flipCase(name.slice(0, pick(name.length + 1)), pick);
  if (r < 8) return name;
  return JUNK[pick(JUNK.length)];
}

/** One in five lines padded to within a few characters of a full line, by spaces or an `echo`. */
function padded(text: string, pick: (n: number) => number): string {
  if (pick(5) === 0) {
    const room = MAX_LINE - pick(8) - text.length;
    if (pick(2) === 0) text = ' '.repeat(Math.max(room, 0)) + text;
    else text = `echo ${'x'.repeat(Math.max(room - 6, 0))};${text}`;
  }
  return text.slice(0, MAX_LINE);
}

/** A line's text, its cursor somewhere on it, and `con_autochat` on or off. */
function lineAt(text: string, pick: (n: number) => number): CompleteLine {
  return { text, cursor: pick(text.length + 1), autochat: pick(2) === 1 };
}

/** A line: up to four words after a lead, now and then a trailing space, and sometimes padded. */
function lineFrom(pick: (n: number) => number, names: readonly string[]): CompleteLine {
  let text = LEADS[pick(LEADS.length)];
  const words = 1 + pick(4);
  for (let w = 0; w < words; w++) {
    if (w > 0) text += SEPARATORS[pick(SEPARATORS.length)];
    text += wordFrom(pick, names);
  }
  if (pick(5) === 0) text += ' ';
  return lineAt(padded(text, pick), pick);
}

/** 30 cvars, none alike but for case, as a cvar store holds them, their values around 64 long. */
function cvarsFrom(pick: (n: number) => number): CompletionCvar[] {
  const cvars: CompletionCvar[] = [];
  while (cvars.length < 30) {
    const name = nameFrom(pick);
    const length = VALUE_LENGTHS[pick(VALUE_LENGTHS.length)];
    const value = Array.from({ length }, () => printable(pick)).join('');
    if (!cvars.some((cvar) => cvar.name.toLowerCase() === name.toLowerCase())) {
      cvars.push({ name, value });
    }
  }
  return cvars;
}

/**
 * A corpus from `seed`: 30 commands, some alike but for case, which the list keeps the first of;
 * 30 cvars; and `count` lines over every name. Nothing is listed and there are no players.
 */
export function completeCorpus(seed: number, count: number): CompleteCorpus {
  const random = new Seeded(seed);
  // The high bits: the low ones cycle in a few draws.
  const pick = (n: number) => (random.next() >>> 8) % n;
  const commands = Array.from({ length: 30 }, () => nameFrom(pick));
  const cvars = cvarsFrom(pick);
  const names = [...commands, ...cvars.map(({ name }) => name), 'cmdlist', 'exec', 'echo'];
  const lines = Array.from({ length: count }, () => lineFrom(pick, names));
  const listed = commands.map((name) => [name, COMPLETER.NONE] as const);
  return { ...NOTHING_LISTED, commands: listed, cvars, lines };
}

/** The commands whose arguments the argument corpus completes, as ioquake3 gives them theirs. */
const ARGUMENT_COMMANDS: readonly (readonly [string, Completer])[] = [
  ['set', COMPLETER.CVAR],
  ['seta', COMPLETER.CVAR],
  ['sets', COMPLETER.CVAR],
  ['reset', COMPLETER.CVAR],
  ['toggle', COMPLETER.CVAR],
  ['bind', COMPLETER.BIND],
  ['unbind', COMPLETER.UNBIND],
  ['bindlist', COMPLETER.NONE],
  ['condump', COMPLETER.TXT],
  ['writeconfig', COMPLETER.CFG],
  ['map', COMPLETER.MAP],
  ['devmap', COMPLETER.MAP],
  ['map_restart', COMPLETER.NONE],
  ['sayto', COMPLETER.PLAYER],
  ['say', COMPLETER.NONE]
];

/** Cfgs, some alike but for case, one in a folder, one with a space, some with no extension. */
const CFGS = [
  'autoexec.cfg',
  'Autoexec.cfg',
  'AUTOEXEC.CFG',
  'q3config.cfg',
  'q3config_server.cfg',
  'my config.cfg',
  'a.cfg',
  'a-b.cfg',
  'a.b.cfg',
  'A.cfg',
  'cfg',
  'presets/vq3.cfg',
  'presets/cpm.cfg',
  'presets/pmc.cfg',
  'Presets/vq3.cfg'
];
const TXTS = ['condump.txt', 'Condump.txt', 'notes.txt', 'note s.txt', 'a/b.txt', 'a/b/c.txt'];

/** Maps whose names run on past others', by a dot, a dash, a digit or a folder. */
const MAPS = [
  'q3dm1',
  'q3dm17',
  'q3dm1-beta',
  'q3dm1.b',
  'q3dm10',
  'q3tourney2',
  'q3ctf1',
  'garage_cats',
  'garage_rats',
  'pro-q3dm6',
  'sub/q3dm1',
  'a b'
];

/**
 * Players' names: alike but for case, sharing starts, coloured, with spaces, all colour, too long
 * for the buffer, and with a character above ASCII.
 */
const PLAYER_NAMES = [
  'Sarge',
  'sarge',
  'Sarg',
  'Sargent',
  'Anarki',
  'Major',
  '^1Major',
  'Ma^2jor',
  '^^7Doom',
  'Doom^',
  '^1^2',
  'Big Bad',
  'big  bad',
  ' Lead',
  'Trail ',
  'A',
  'a',
  'Xaero'.repeat(8),
  'Hié'
];

/** Some of a pool, in a random order. */
function someOf(pool: readonly string[], pick: (n: number) => number): string[] {
  const kept = pool.filter(() => pick(3) !== 0);
  for (let i = kept.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [kept[i], kept[j]] = [kept[j], kept[i]];
  }
  return kept;
}

/** What a corpus says of the players. */
type CorpusPlayers = Pick<CompleteNames, 'serverinfo' | 'players' | 'clientNum'>;

/**
 * Players for a corpus: a configstring for each slot, some empty and some with no name; a
 * serverinfo whose `sv_maxclients` counts them, or fewer, now and then with a space before it or
 * a letter after; and the client's slot.
 */
function playersFrom(pick: (n: number) => number): CorpusPlayers {
  const slots = pick(11);
  const players = Array.from({ length: slots }, () => {
    const r = pick(10);
    if (r < 2) return '';
    if (r < 3) return '\\t\\0\\model\\sarge';
    return `\\n\\${PLAYER_NAMES[pick(PLAYER_NAMES.length)]}\\t\\${pick(4)}\\model\\sarge`;
  });
  const maxclients = [`${slots}`, ` ${slots}`, `${slots}x`, `${Math.max(slots - 2, 0)}`][pick(4)];
  return {
    serverinfo: `\\sv_hostname\\noname\\sv_maxclients\\${maxclients}\\g_gametype\\0`,
    players,
    clientNum: slots === 0 ? 0 : pick(slots)
  };
}

/**
 * A line for the argument corpus: a command, mostly one that completes its arguments, and up to
 * three words after it from what those complete: keys, cvars, cfgs, maps and players' names as
 * the field writes them, now and then a command after a `;`.
 */
function argumentLineFrom(
  pick: (n: number) => number,
  commands: readonly string[],
  words: readonly string[]
): CompleteLine {
  let text = LEADS[pick(LEADS.length)];
  const parts = pick(5) === 0 ? 2 : 1;
  for (let part = 0; part < parts; part++) {
    if (part > 0) text += [';', '; ', ' ;'][pick(3)];
    text += wordFrom(pick, commands);
    const count = pick(4);
    for (let w = 0; w < count; w++) {
      text += SEPARATORS[pick(SEPARATORS.length)];
      text += wordFrom(pick, words);
    }
  }
  if (pick(3) === 0) text += ' ';
  return lineAt(padded(text, pick), pick);
}

/**
 * The argument corpus from `seed`: the commands that complete their arguments, then a few more,
 * alike some of those but for case and given another completer; 30 cvars; some of the cfgs, the
 * `.txt` files and the maps, in a random order; players; and `count` lines over all of them.
 */
export function argumentCorpus(seed: number, count: number): CompleteCorpus {
  const random = new Seeded(seed);
  const pick = (n: number) => (random.next() >>> 8) % n;
  const others = Array.from({ length: 4 }, () => {
    const [name] = ARGUMENT_COMMANDS[pick(ARGUMENT_COMMANDS.length)];
    const alike = pick(2) === 0 ? flipCase(name, pick) : nameFrom(pick);
    return [alike, pick(8) as Completer] as const;
  });
  const commands = [...ARGUMENT_COMMANDS, ...others];
  const cvars = cvarsFrom(pick);
  const listed = {
    cfgs: someOf(CFGS, pick),
    txts: someOf(TXTS, pick),
    maps: someOf(MAPS, pick),
    ...playersFrom(pick)
  };
  const playerWords = PLAYER_NAMES.map((name) => playerNameToFieldString(cleanStr(name)));
  const words = [
    ...KEY_NAMES.map(([name]) => name),
    ...cvars.map(({ name }) => name),
    ...CFGS,
    ...TXTS,
    ...MAPS,
    ...playerWords,
    ...commands.map(([name]) => name),
    'exec',
    'vstr'
  ];
  const names = [...commands.map(([name]) => name), 'exec', 'execq', 'vstr', 'cmdlist'];
  const lines = Array.from({ length: count }, () => argumentLineFrom(pick, names, words));
  return { commands, cvars, ...listed, lines };
}

/**
 * A corpus as the twin reads it, every text as its length as an int and its bytes: the commands'
 * count and each one's name and completer; the cvars' count and each one's name and value; the
 * cfgs', `.txt` files' and maps' counts and names, each map as its BSP's file; the serverinfo, the
 * client's slot, and the players' count and configstrings; and the lines' count and each one's
 * text, its cursor, and 1 or 0 for `con_autochat`.
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
  const texts = (list: readonly string[]) => {
    int(list.length);
    list.forEach(text);
  };
  int(corpus.commands.length);
  for (const [name, completer] of corpus.commands) {
    text(name);
    int(completer);
  }
  int(corpus.cvars.length);
  for (const { name, value } of corpus.cvars) {
    text(name);
    text(value);
  }
  texts(corpus.cfgs);
  texts(corpus.txts);
  texts(corpus.maps.map((name) => `${name}.bsp`));
  text(corpus.serverinfo);
  int(corpus.clientNum);
  texts(corpus.players);
  int(corpus.lines.length);
  for (const line of corpus.lines) {
    text(line.text);
    int(line.cursor);
    int(line.autochat ? 1 : 0);
  }
  return Uint8Array.from(bytes);
}

/** The completer the port gives a corpus's command for each {@link COMPLETER}. */
function completers(names: CompleteNames): readonly (ArgumentCompleter | undefined)[] {
  const client = {
    configstring: (index: number) =>
      index === CONFIGSTRING.SERVERINFO
        ? names.serverinfo
        : (names.players[index - CONFIGSTRING.PLAYERS] ?? ''),
    clientNum: names.clientNum
  };
  return [
    undefined,
    completeFileName(() => names.cfgs),
    completeFileName(() => names.txts),
    completeCvarName,
    completeBind,
    completeUnbind,
    completeMapName(() => names.maps),
    completePlayerName(() => client)
  ];
}

/**
 * The names Tab completes from: a router's, `exec` listing the corpus's cfgs, with the corpus's
 * commands added and given their completers, and the corpus's cvars.
 */
export function corpusNames(names: CompleteNames): CompletionNames {
  const router = new CommandRouter({
    cvar: () => false,
    cvarString: () => '',
    game: () => false,
    readCfg: () => Promise.resolve(undefined),
    listCfgs: () => Promise.resolve(names.cfgs),
    print: () => {}
  });
  const given = completers(names);
  for (const [name, completer] of names.commands) {
    router.add(name);
    const complete = given[completer];
    if (complete) router.setCompletion(name, complete);
  }
  return {
    commands: router.names(),
    cvars: names.cvars,
    completer: (name) => router.completer(name)
  };
}

/** Each line as Tab leaves it. */
export async function completeLines(corpus: CompleteCorpus): Promise<Completed[]> {
  const names = corpusNames(corpus);
  const done: Completed[] = [];
  for (const { text, cursor, autochat } of corpus.lines) {
    let printed = '';
    const print = (t: string) => void (printed += t);
    const line = await autoComplete({ text, cursor, scroll: 0 }, names, autochat, print);
    done.push([line.text, line.cursor, printed]);
  }
  return done;
}

/** A string's bytes, as C's `char`s. */
function digestText(digest: Digest, text: string): void {
  digest.int(text.length);
  digest.uint8s(Uint8Array.from(text, (ch) => ch.charCodeAt(0)), 0, text.length);
}

/** The corpus through Tab, digested as the twin digests it: each line, its cursor and its print. */
export async function runComplete(corpus: CompleteCorpus): Promise<CompleteRun> {
  const digest = new Digest();
  const run: CompleteRun = { lines: 0, changed: 0, listed: 0, digest: '' };
  (await completeLines(corpus)).forEach(([text, cursor, printed], i) => {
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

/**
 * The hand cases' names: their commands, added after the router's own; and cvars with values
 * empty, short, and of 63, 64 and 65 characters and longer, and one a command shares its name with.
 */
export const CASE_NAMES: CompleteNames = {
  ...NOTHING_LISTED,
  commands: ['cmd', 'map', 'map_restart', 'say', 'say_team', '+attack', 'Clear'].map(
    (name) => [name, COMPLETER.NONE] as const
  ),
  cvars: [
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
  ]
};

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
 * Hand cases over {@link CASE_NAMES}, each with the twin's answer: one match, with `con_autochat`
 * on and off and with either slash; several, listed in the first match's case, a cvar with its
 * value cut by its length; after a `;`, and before one; an argument, an empty line, one of spaces,
 * and no match; a word after a quote or a comment, and before one; and lines too full for the
 * whole match, its space, or the slash. Where ioquake3's cursor steps past the line, the answer is
 * the port's, at the line's end.
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

/**
 * The argument cases' names: commands with ioquake3's completers and one named like the cvars,
 * cvars, cfgs alike but for case, one with a space and some in a folder, `.txt` files, maps
 * running on past others' names, and players: the client's own slot, coloured names, the first of
 * them with a space, an empty slot, and one with no name.
 */
export const ARGUMENT_NAMES: CompleteNames = {
  commands: [...ARGUMENT_COMMANDS, ['cg_drawGun', COMPLETER.NONE]],
  cvars: [
    { name: 'cg_drawFPS', value: '0' },
    { name: 'cg_drawTimer', value: '1' },
    { name: 'cg_draw2D', value: '1' },
    { name: 'con_autochat', value: '1' },
    { name: 'sv_hostname', value: 'noname' }
  ],
  cfgs: [
    'autoexec.cfg',
    'Autoexec.cfg',
    'q3config.cfg',
    'my config.cfg',
    'presets/vq3.cfg',
    'presets/pmc.cfg',
    'presets/cpm.cfg'
  ],
  txts: ['condump.txt', 'notes.txt', 'Notes.txt', 'logs/a.txt'],
  maps: ['q3dm1', 'q3dm17', 'q3dm1-beta', 'q3dm1.b', 'q3tourney2', 'garage_cats'],
  serverinfo: '\\sv_maxclients\\8\\sv_hostname\\noname',
  players: [
    '\\n\\Me\\t\\0',
    '\\n\\Sarge\\t\\1',
    '\\n\\^1Big Bad\\t\\2',
    '',
    '\\n\\sarge2\\t\\1',
    '\\n\\Visor\\t\\2',
    '\\t\\0',
    '\\n\\Doom\\t\\0'
  ],
  clientNum: 0
};

/** Matches as Tab lists them, a line each. */
const listed = (...names: string[]) => names.map((name) => `    ${name}\n`).join('');

/** How the argument cases list the maps that start `q3dm1`, the files, and keys. */
const Q3DM1S = listed('q3dm1-beta', 'q3dm1.b', 'q3dm1', 'q3dm17');
const TXTS_LISTED = listed('condump.txt', 'logs/a.txt', 'notes.txt');
const PRESETS_LISTED = listed('presets/cpm.cfg', 'presets/pmc.cfg', 'presets/vq3.cfg');
const CFGS_LISTED =
  listed('autoexec.cfg', 'my config.cfg') + PRESETS_LISTED + listed('q3config.cfg');
const MOUSE_KEYS = listed('MOUSE1', 'MOUSE2', 'MOUSE3', 'MOUSE4', 'MOUSE5');
const KP_KEYS = listed(
  ...[
    ...['HOME', 'UPARROW', 'PGUP', 'LEFTARROW', '5', 'RIGHTARROW', 'END', 'DOWNARROW', 'PGDN'],
    ...['ENTER', 'INS', 'DEL', 'SLASH', 'MINUS', 'PLUS', 'NUMLOCK', 'STAR', 'EQUALS']
  ].map((key) => `KP_${key}`)
);

/**
 * Hand cases over {@link ARGUMENT_NAMES}, each with the twin's answer: maps, cfgs and `.txt` files,
 * listed and completed, alike names but for case once; key names, and a command bound after one,
 * but not past a comment with no space; cvars after `set` and `vstr`, with `con_autochat`, after a
 * leading space, and nothing past their word; players, the first for an empty word, the next for
 * a whole name, wrapping round, and none after a name with a space; and commands with no
 * completer, after a `;`, a slash, or in another case.
 */
export const ARGUMENT_CASES: readonly CompleteCase[] = [
  [on('map q3dm'), '\\map q3dm1', 10, `]\\map q3dm1\n${Q3DM1S}`],
  [off('map q3dm1-'), 'map q3dm1-beta ', 15, ''],
  [off('devmap GAR'), 'devmap garage_cats ', 19, ''],
  [off('map '), 'map ', 4, `]map \n${listed('garage_cats')}${Q3DM1S}${listed('q3tourney2')}`],
  [off('exec '), 'exec ', 5, `]exec \n${CFGS_LISTED}`],
  [off('exec auto'), 'exec autoexec.cfg ', 18, ''],
  [off('exec my'), 'exec my config.cfg ', 19, ''],
  [off('execq pres'), 'execq presets/', 14, `]execq presets/\n${PRESETS_LISTED}`],
  [off('writeconfig q3'), 'writeconfig q3config.cfg ', 25, ''],
  [off('condump n'), 'condump notes.txt ', 18, ''],
  [off('condump '), 'condump ', 8, `]condump \n${TXTS_LISTED}`],
  [off('bind MOUSE'), 'bind MOUSE', 10, `]bind MOUSE\n${MOUSE_KEYS}`],
  [off('bind mouse1'), 'bind MOUSE1 ', 12, ''],
  [off('unbind kp_'), 'unbind KP_', 10, `]unbind KP_\n${KP_KEYS}`],
  [off('bind x exec '), 'bind x exec ', 12, `]bind x exec \n${CFGS_LISTED}`],
  [off('bind x exec au'), 'bind x exec autoexec.cfg ', 25, ''],
  [off('bind x cg_dr'), 'bind x cg_draw', 14, `]bind x cg_draw\n${listed('cg_drawGun')}${DRAWS}`],
  [off('bind a exec'), 'bind a exec', 11, `]bind a exec\n${listed('execq', 'exec')}`],
  [off('bind x'), 'bind x', 6, ''],
  [off('unbind/*x*/mouse1'), 'unbind/*x*/mouse1', 17, ''],
  [off('bind/*x*/mouse1'), 'bind/*x*/mouse1', 15, ''],
  [off('set cg_dr'), 'set cg_draw', 11, `]set cg_draw\n${DRAWS}`],
  [on('set cg_dr'), '\\set cg_draw', 12, `]\\set cg_draw\n${DRAWS}`],
  [on(' set cg_dr'), '\\ set cg_draw', 13, `]\\ set cg_draw\n${DRAWS}`],
  [off('set  cg_dr'), 'set  cg_draw', 12, `]set  cg_draw\n${DRAWS}`],
  [off('set/*x*/cg_dr'), 'set/*x*/cg_dr', 13, ''],
  [off('toggle con_'), 'toggle con_autochat ', 20, ''],
  [off('set cg_drawFPS 1'), 'set cg_drawFPS 1', 16, ''],
  [off('set bind MOUSE'), 'set bind MOUSE', 14, ''],
  [off('vstr sv_h'), 'vstr sv_hostname ', 17, ''],
  [off('vstr exec au'), 'vstr exec au', 12, ''],
  [off('sayto '), 'sayto Big\\0x20Bad', 17, ']sayto \n'],
  [off('sayto Visor'), 'sayto sarge2', 12, ''],
  [off('sayto Doom'), 'sayto Sarge', 11, ''],
  [off('sayto Big\\0x20Bad'), 'sayto Big\\0x20Bad', 17, ''],
  [off('sayto sa'), 'sayto Sarge', 11, ']sayto sa\n    Sarge\n    sarge2\n'],
  [off('sayto sarge'), 'sayto Visor', 11, ']sayto sarge\n    Visor\n'],
  [off('sayto sarge2'), 'sayto Big\\0x20Bad', 17, ''],
  [on('sayto d'), '\\sayto Doom', 11, ''],
  [off('say hi'), 'say hi', 6, ''],
  [off('map_restart 5'), 'map_restart 5', 13, ''],
  [off('echo hi;map q3dm1'), 'echo hi;map q3dm1', 17, `]echo hi;map q3dm1\n${Q3DM1S}`],
  [off('/map q3dm17'), '/map q3dm17 ', 12, ''],
  [off('\\\\map q3'), '\\\\map q3', 8, ''],
  [off('MAP Q3T'), 'MAP q3tourney2 ', 15, ''],
  [off('map "q3dm17'), 'map "q3dm17', 11, '']
];

/** {@link ARGUMENT_NAMES} with one other player, whose name has a space. */
export const ONE_PLAYER_NAMES: CompleteNames = {
  ...ARGUMENT_NAMES,
  players: ['\\n\\Me\\t\\0', '\\n\\^1Big Bad\\t\\0']
};

/**
 * Hand cases over {@link ONE_PLAYER_NAMES}, each with the twin's answer: the only player's name
 * takes a space after it, as the field writes it for an empty word, and as it is for a word it
 * starts with.
 */
export const ONE_PLAYER_CASES: readonly CompleteCase[] = [
  [off('sayto '), 'sayto Big\\0x20Bad ', 18, ''],
  [off('sayto b'), 'sayto Big Bad ', 14, ''],
  [on('sayto BIG'), '\\sayto Big Bad ', 15, ''],
  [off('sayto x'), 'sayto x', 7, '']
];
