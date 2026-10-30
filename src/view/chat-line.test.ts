import { describe, expect, it } from 'vitest';
import { K } from '../formats/q3-keys';
import {
  CHAT_WIDTH,
  TEAM_CHAT_WIDTH,
  messageKey,
  messageMode,
  type ChatLine
} from './chat-line';
import { EditField } from './edit-field';

/** A chat line in a match, with what it sent and how often it closed. */
function chatLine(over: Partial<ChatLine> = {}) {
  const sent: string[] = [];
  let closed = 0;
  const line: ChatLine = {
    field: new EditField({ overstrike: false }, CHAT_WIDTH),
    team: false,
    playerNum: -1,
    active: () => true,
    send: (command) => sent.push(command),
    close: () => closed++,
    ...over
  };
  return { line, sent, closed: () => closed };
}

/** Type `text` into a field, a character at a time. */
function type(field: EditField, text: string): void {
  for (const ch of text) field.char(ch);
}

describe('messageMode', () => {
  it('sets messagemode up to say to everyone, cleared, 30 wide', () => {
    const { line } = chatLine({ team: true, playerNum: 4 });
    type(line.field, 'left over');
    line.field.widthInChars = 7;
    expect(messageMode(line, 'say')).toBe(true);
    expect(line).toMatchObject({ team: false, playerNum: -1 });
    expect(line.field.text).toBe('');
    expect(line.field.cursor).toBe(0);
    expect(line.field.widthInChars).toBe(CHAT_WIDTH);
    expect(CHAT_WIDTH).toBe(30);
  });

  it('sets messagemode2 up to say to the team, 25 wide', () => {
    const { line } = chatLine({ playerNum: 4 });
    type(line.field, 'x');
    expect(messageMode(line, 'say_team')).toBe(true);
    expect(line).toMatchObject({ team: true, playerNum: -1 });
    expect(line.field.text).toBe('');
    expect(line.field.widthInChars).toBe(TEAM_CHAT_WIDTH);
    expect(TEAM_CHAT_WIDTH).toBe(25);
  });

  it('sets a tell up to the slot cgame names, 30 wide, for slots 0 to 63', () => {
    for (const slot of [0, 7, 63]) {
      const { line } = chatLine({ team: true });
      type(line.field, 'x');
      line.field.widthInChars = TEAM_CHAT_WIDTH;
      expect(messageMode(line, 'tell', slot)).toBe(true);
      expect(line).toMatchObject({ team: false, playerNum: slot });
      expect(line.field.text).toBe('');
      expect(line.field.widthInChars).toBe(CHAT_WIDTH);
    }
  });

  it('opens no tell to nobody or past the slots, a line kept but said instead', () => {
    for (const target of [-1, 64, 1022]) {
      const { line } = chatLine({ playerNum: 5 });
      type(line.field, 'typed');
      expect(messageMode(line, 'tell', target)).toBe(false);
      // `chat_playerNum` is set before it is looked at, so a tell line already open is a say now.
      expect(line).toMatchObject({ team: false, playerNum: -1 });
      expect(line.field.text).toBe('typed');
      expect(line.field.widthInChars).toBe(CHAT_WIDTH);
    }
    // A tell with no target given is to nobody.
    expect(messageMode(chatLine().line, 'tell')).toBe(false);
  });
});

describe('messageKey', () => {
  it('lets the line go and clears it on Escape, sending nothing', () => {
    const { line, sent, closed } = chatLine();
    type(line.field, 'never mind');
    expect(messageKey(K.ESCAPE, line)).toBe(true);
    expect(line.field.text).toBe('');
    expect(closed()).toBe(1);
    expect(sent).toEqual([]);
  });

  it("says the line on Enter, inside quotes, as Message_Key writes it, then lets it go", () => {
    const { line, sent, closed } = chatLine();
    type(line.field, 'hello there');
    expect(messageKey(K.ENTER, line)).toBe(true);
    expect(sent).toEqual(['say "hello there"\n']);
    expect(line.field.text).toBe('');
    expect(closed()).toBe(1);
  });

  it('says a team line to the team, and a tell to its slot', () => {
    const team = chatLine({ team: true });
    type(team.line.field, 'go');
    messageKey(K.ENTER, team.line);
    expect(team.sent).toEqual(['say_team "go"\n']);

    // A tell wins over the team, as the C looks at it first.
    const tell = chatLine({ team: true, playerNum: 0 });
    type(tell.line.field, 'psst');
    messageKey(K.KP_ENTER, tell.line);
    expect(tell.sent).toEqual(['tell 0 "psst"\n']);
  });

  it('sends the line as it was typed: quotes, semicolons and colour codes untouched', () => {
    const { line, sent } = chatLine();
    type(line.field, 'a "b"; //c ^1d');
    messageKey(K.ENTER, line);
    expect(sent).toEqual(['say "a "b"; //c ^1d"\n']);
  });

  it('sends nothing for an empty line, or out of a match, and lets it go all the same', () => {
    const empty = chatLine();
    expect(messageKey(K.ENTER, empty.line)).toBe(true);
    expect(empty.sent).toEqual([]);
    expect(empty.closed()).toBe(1);

    const away = chatLine({ active: () => false });
    type(away.line.field, 'hello');
    expect(messageKey(K.KP_ENTER, away.line)).toBe(true);
    expect(away.sent).toEqual([]);
    expect(away.line.field.text).toBe('');
    expect(away.closed()).toBe(1);
  });

  it("hands any other key to the field, which says whether it took it", () => {
    const { line, sent, closed } = chatLine();
    type(line.field, 'abc');
    expect(messageKey(K.LEFTARROW, line)).toBe(true);
    expect(messageKey(K.HOME, line)).toBe(true);
    expect(line.field.cursor).toBe(0);
    expect(messageKey(K.DEL, line)).toBe(true);
    expect(line.field.text).toBe('bc');
    // No history and no completion, as in Q3.
    expect(messageKey(K.UPARROW, line)).toBe(false);
    expect(messageKey(K.TAB, line)).toBe(false);
    expect(messageKey(K.MOUSE1, line)).toBe(false);
    expect(line.field.text).toBe('bc');
    expect(sent).toEqual([]);
    expect(closed()).toBe(0);
  });
});
