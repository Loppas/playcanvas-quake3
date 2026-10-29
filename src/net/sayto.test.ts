import { describe, expect, it } from 'vitest';
import { CONFIGSTRING } from './commands';
import { fieldStringToPlayerName, sayto } from './sayto';

/**
 * A client in a match whose slots hold these names, `sv_maxclients` of them looked in; an empty
 * slot's configstring is empty.
 */
function inMatch(names: Record<number, string>, maxclients = 8) {
  const sent: string[] = [];
  const client = {
    configstring: (index: number) => {
      if (index === CONFIGSTRING.SERVERINFO) return `\\sv_maxclients\\${maxclients}\\g_gametype\\0`;
      const name = names[index - CONFIGSTRING.PLAYERS];
      return name === undefined ? '' : `n\\${name}\\t\\0\\model\\sarge`;
    },
    sendClientCommand: (text: string) => sent.push(text)
  };
  return { client, sent };
}

/** What `sayto` sent and printed for this line. */
function run(argv: readonly string[], names: Record<number, string> | null, maxclients = 8) {
  const printed: string[] = [];
  const match = names ? inMatch(names, maxclients) : null;
  sayto(argv, match?.client ?? null, (text) => printed.push(text));
  return { sent: match?.sent ?? [], printed };
}

describe('sayto', () => {
  const PLAYERS = { 0: 'Bravo', 2: '^1Al^7pha', 5: 'Big Bob' };

  it('tells the player of that name the words after it, by their slot', () => {
    expect(run(['sayto', 'Alpha', 'nice', 'shot'], PLAYERS)).toEqual({
      sent: ['tell 2 "nice shot"'],
      printed: []
    });
  });

  it("matches a player's name with its colours off, without regard to case", () => {
    expect(run(['sayto', 'aLPHA', 'hi'], PLAYERS).sent).toEqual(['tell 2 "hi"']);
    // The name typed keeps its own colours.
    expect(run(['sayto', '^1Alpha', 'hi'], PLAYERS)).toEqual({
      sent: [],
      printed: ['No such player name: ^1Alpha.\n']
    });
  });

  it('reads a name as the field writes it, \\0xNN for the character it codes', () => {
    expect(run(['sayto', 'Big\\0x20Bob', 'hi'], PLAYERS).sent).toEqual(['tell 5 "hi"']);
    expect(run(['sayto', 'Big Bob', 'hi'], PLAYERS).sent).toEqual(['tell 5 "hi"']);
  });

  it('tells the first slot that matches, among the first sv_maxclients', () => {
    expect(run(['sayto', 'bravo', 'hi'], { 1: 'Bravo', 3: 'bravo' }).sent).toEqual([
      'tell 1 "hi"'
    ]);
    expect(run(['sayto', 'Bravo', 'hi'], { 4: 'Bravo' }, 4).printed).toEqual([
      'No such player name: Bravo.\n'
    ]);
  });

  it("cuts a player's name to 31 characters before its colours come off", () => {
    const long = `^1${'x'.repeat(30)}`;
    expect(run(['sayto', 'x'.repeat(29), 'hi'], { 1: long }).sent).toEqual(['tell 1 "hi"']);
    expect(run(['sayto', 'x'.repeat(30), 'hi'], { 1: long }).sent).toEqual([]);
  });

  it('says so for a name nobody has, as with no match to look in', () => {
    expect(run(['sayto', 'Charlie', 'hi'], PLAYERS)).toEqual({
      sent: [],
      printed: ['No such player name: Charlie.\n']
    });
    expect(run(['sayto', 'Alpha', 'hi'], null)).toEqual({
      sent: [],
      printed: ['No such player name: Alpha.\n']
    });
    // The name as it was read, 32 characters at most.
    expect(run(['sayto', `${'y'.repeat(40)}`, 'hi'], PLAYERS).printed).toEqual([
      `No such player name: ${'y'.repeat(32)}.\n`
    ]);
  });

  it('gives its usage for fewer than a name and a word', () => {
    for (const argv of [['sayto'], ['sayto', 'Alpha']]) {
      expect(run(argv, PLAYERS)).toEqual({ sent: [], printed: ['sayto <player name> <text>\n'] });
    }
  });
});

describe('fieldStringToPlayerName', () => {
  it('reads \\0xNN as the character it codes, and anything else as it is', () => {
    expect(fieldStringToPlayerName('Big\\0x20Bob')).toBe('Big Bob');
    expect(fieldStringToPlayerName('a\\0X20b')).toBe('a\\0X20b');
    expect(fieldStringToPlayerName('a\\0xZZb')).toBe('a\\0xZZb');
    expect(fieldStringToPlayerName('a\\0x4')).toBe('a\x04');
  });

  it('ends at a coded NUL, and keeps at most 32 characters', () => {
    expect(fieldStringToPlayerName('ab\\0x00cd')).toBe('ab');
    expect(fieldStringToPlayerName('y'.repeat(40))).toBe('y'.repeat(32));
  });
});
