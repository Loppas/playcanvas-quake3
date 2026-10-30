import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import { ConsoleHistory } from './console-history';
import { consoleKey, type ConsoleLine } from './console-key';
import {
  consoleCorpus,
  IOQ3_HISTORY,
  runConsole,
  type ConsoleRun
} from './console-key-test-fixtures';
import { EditField, MAX_FIELD_LENGTH } from './edit-field';
import { completeFileName } from './field-complete';

/**
 * The corpus over three seeds, 6000 steps each, as ioquake3's own `Console_Key`, `Field_CharEvent`,
 * `CL_LoadConsoleHistory` and `CL_SaveConsoleHistory`, compiled from its C, ran it: the steps by
 * kind, how far they reached, and the digest of the state after every step. The twin ran most of
 * the hand cases below and in `console-history.test.ts` too, as steps it can take, and agreed with
 * the port on each.
 */
const TWIN: Record<number, ConsoleRun> = {
  1: {
    keys: 3015,
    chars: 2659,
    holds: 158,
    flags: 33,
    widths: 30,
    restarts: 94,
    files: 11,
    entered: 55,
    unread: 10,
    full: 0,
    pastBuffer: 14,
    longest: 255,
    longestFile: 936,
    digest: '5cf3d216'
  },
  2: {
    keys: 3014,
    chars: 2675,
    holds: 188,
    flags: 27,
    widths: 15,
    restarts: 73,
    files: 8,
    entered: 49,
    unread: 6,
    full: 0,
    pastBuffer: 40,
    longest: 255,
    longestFile: 810,
    digest: 'afbdf8ff'
  },
  3: {
    keys: 3015,
    chars: 2696,
    holds: 165,
    flags: 30,
    widths: 21,
    restarts: 67,
    files: 6,
    entered: 54,
    unread: 2,
    full: 0,
    pastBuffer: 0,
    longest: 254,
    longestFile: 1017,
    digest: 'f24f37ef'
  }
};

/** Cvars for Tab to complete. */
const DRAWS = [
  { name: 'cg_drawFPS', value: '0' },
  { name: 'cg_draw2D', value: '1' }
];

/** Lets a Tab's completion in, as it comes in before the next key's event. */
const nextKey = () => new Promise((resolve) => setTimeout(resolve));

/**
 * The console's line at a console 78 wide, out of a match, with `con_autochat` 1, Tab completing
 * from three commands and {@link DRAWS}, and `exec`'s cfgs once `state.listing` settles.
 */
function console78() {
  const held = new Set<number>();
  const state = { active: false, autochat: true, listing: Promise.resolve() };
  const completeCfgName = completeFileName(async () => {
    await state.listing;
    return ['autoexec.cfg', 'my.cfg'];
  });
  const line = {
    field: new EditField({ overstrike: false }, 78),
    history: new ConsoleHistory(() => {}),
    scrollback: { pageUp: vi.fn(), pageDown: vi.fn(), top: vi.fn(), bottom: vi.fn() },
    isDown: (key: number) => held.has(key),
    active: () => state.active,
    autochat: () => state.autochat,
    names: () => ({
      commands: ['cmdlist', 'clear', 'exec'],
      cvars: DRAWS,
      completer: (name: string) => (name.toLowerCase() === 'exec' ? completeCfgName : undefined)
    }),
    print: vi.fn(),
    run: vi.fn()
  } satisfies ConsoleLine;
  /** A key pressed with others held. */
  const press = (key: number, ...holding: number[]) => {
    for (const hold of holding) held.add(hold);
    const took = consoleKey(key, line);
    held.clear();
    return took;
  };
  /** Text typed, each character after its key. */
  const type = (text: string) => {
    for (const ch of text) {
      press(ch.toLowerCase().charCodeAt(0));
      line.field.char(ch);
    }
  };
  return { line, state, press, type };
}

const letter = (ch: string) => ch.charCodeAt(0);

describe('consoleKey: Enter', () => {
  it('says a line in a match, under con_autochat, and keeps it', () => {
    const { line, state, press, type } = console78();
    state.active = true;
    type('hello there');
    expect(press(K.ENTER)).toBe(true);
    expect(line.print.mock.calls).toEqual([[']hello there\n']]);
    expect(line.run.mock.calls).toEqual([['cmd say hello there']]);
    expect(line.field.line()).toEqual({ text: '', cursor: 0, scroll: 0 });
    expect(line.history.older()).toEqual({ text: 'hello there', cursor: 11, scroll: 0 });
  });

  it('runs a line out of a match as commands, giving it a slash and the cursor a place', () => {
    const { line, press, type } = console78();
    type('map q3dm1');
    press(K.LEFTARROW);
    press(K.KP_ENTER);
    expect(line.print.mock.calls).toEqual([[']\\map q3dm1\n']]);
    expect(line.run.mock.calls).toEqual([['map q3dm1']]);
    expect(line.history.older()).toEqual({ text: '\\map q3dm1', cursor: 9, scroll: 0 });
  });

  it('runs a line with a leading slash as commands, in a match too', () => {
    const { line, state, press, type } = console78();
    state.active = true;
    type('/kill');
    press(K.ENTER);
    type('\\echo hi; echo there');
    press(K.ENTER);
    expect(line.print.mock.calls).toEqual([[']/kill\n'], [']\\echo hi; echo there\n']]);
    expect(line.run.mock.calls).toEqual([['kill'], ['echo hi; echo there']]);
    expect(line.history.older().text).toBe('\\echo hi; echo there');
  });

  it('runs a line as it stands without con_autochat, in a match or out of one', () => {
    const { line, state, press, type } = console78();
    state.autochat = false;
    type('hello');
    press(K.ENTER);
    state.active = true;
    type('hello');
    press(K.ENTER);
    expect(line.print.mock.calls).toEqual([[']hello\n'], [']hello\n']]);
    expect(line.run.mock.calls).toEqual([['hello'], ['hello']]);
  });

  it('echoes an empty line alone, keeping nothing', () => {
    const { line, state, press } = console78();
    expect(press(K.ENTER)).toBe(true);
    state.active = true;
    press(K.ENTER);
    expect(line.print.mock.calls).toEqual([[']\n'], [']\n']]);
    expect(line.run).not.toHaveBeenCalled();
    expect(line.history.text()).toBe('');
  });

  it('runs the line once it is kept and cleared', () => {
    const { line, press, type } = console78();
    const seen: string[] = [];
    line.run.mockImplementation(() => seen.push(line.field.text, line.history.text()));
    type('/echo a');
    press(K.ENTER);
    expect(seen).toEqual(['', '7 0 7 /echo a ']);
  });

  it('gives a full line its slash, 255 characters long, the command the whole of it', () => {
    const { line, press } = console78();
    const full = 'a'.repeat(MAX_FIELD_LENGTH);
    line.field.restore({ text: full, cursor: 3, scroll: 0 });
    press(K.ENTER);
    expect(line.run.mock.calls).toEqual([[full]]);
    expect(line.history.older()).toEqual({ text: `\\${full}`, cursor: 4, scroll: 0 });
  });

  it('cuts a longer line the history brought back to 254 before its slash', () => {
    const { line, press } = console78();
    const long = 'a'.repeat(MAX_FIELD_LENGTH + 1);
    line.history.load(`255 0 255 ${long} `);
    press(K.UPARROW);
    press(K.ENTER);
    const cut = long.slice(0, MAX_FIELD_LENGTH);
    expect(line.run.mock.calls).toEqual([[cut]]);
    expect(line.history.older()).toEqual({ text: `\\${cut}`, cursor: 256, scroll: 0 });
  });

  it('keeps a line its scroll, which Ctrl+E can leave below 0', () => {
    const { line, state, press, type } = console78();
    state.active = true;
    type('say hi');
    press(letter('e'), K.CTRL);
    line.field.char('\x05');
    press(K.ENTER);
    expect(line.history.older()).toEqual({ text: 'say hi', cursor: 6, scroll: -72 });
  });
});

describe('consoleKey: Tab', () => {
  it('completes the line ahead of the field, giving it a slash under con_autochat', async () => {
    const { line, press, type } = console78();
    type('cmdl');
    press(K.LEFTARROW);
    expect(press(K.TAB)).toBe(true);
    await nextKey();
    expect(line.field.line()).toEqual({ text: '\\cmdlist ', cursor: 9, scroll: 0 });
    expect(line.print).not.toHaveBeenCalled();
  });

  it('lists the matches under the line, each cvar with its value', async () => {
    const { line, press, type } = console78();
    type('cg_d');
    press(K.TAB);
    await nextKey();
    expect(line.field.line()).toEqual({ text: '\\cg_draw', cursor: 8, scroll: 0 });
    expect(line.print.mock.calls).toEqual([
      [']\\cg_draw\n'],
      ['    cg_drawFPS = "0"\n'],
      ['    cg_draw2D = "1"\n']
    ]);
  });

  it('reads con_autochat at the press, and leaves the scroll as it was', async () => {
    const { line, state, press, type } = console78();
    state.autochat = false;
    const typed = `echo ${'x'.repeat(80)};`;
    type(`${typed}cmdl`);
    const { scroll } = line.field;
    press(K.TAB);
    await nextKey();
    expect(line.field.line()).toEqual({ text: `${typed}cmdlist `, cursor: 94, scroll });
    expect(scroll).toBeGreaterThan(0);
  });

  it("completes a command's argument once the listing it waits for is in", async () => {
    const { line, state, press, type } = console78();
    let list!: () => void;
    state.listing = new Promise((resolve) => (list = resolve));
    type('exec a');
    press(K.TAB);
    await nextKey();
    expect(line.field.text).toBe('exec a');
    list();
    await nextKey();
    expect(line.field.line()).toEqual({ text: '\\exec autoexec.cfg ', cursor: 19, scroll: 0 });
  });

  it('keeps the line a key changed while the listing came in, and lists the matches', async () => {
    const { line, state, press, type } = console78();
    let list!: () => void;
    state.listing = new Promise((resolve) => (list = resolve));
    type('exec ');
    press(K.TAB);
    type('m');
    list();
    await nextKey();
    expect(line.field.line()).toEqual({ text: 'exec m', cursor: 6, scroll: 0 });
    expect(line.print.mock.calls).toEqual([
      [']\\exec \n'],
      ['    autoexec.cfg\n'],
      ['    my.cfg\n']
    ]);
  });

  it('keeps the line where a key moved the cursor while the listing came in', async () => {
    const { line, state, press, type } = console78();
    let list!: () => void;
    state.listing = new Promise((resolve) => (list = resolve));
    type('exec a');
    press(K.TAB);
    press(K.LEFTARROW);
    list();
    await nextKey();
    expect(line.field.line()).toEqual({ text: 'exec a', cursor: 5, scroll: 0 });
  });
});

describe('consoleKey: the history', () => {
  /** A console with three lines entered out of a match. */
  function entered() {
    const tools = console78();
    for (const text of ['/a', '/bb', '/ccc']) {
      tools.type(text);
      tools.press(K.ENTER);
    }
    return tools;
  }

  it('brings back the lines before on Up, keypad Up, Ctrl+P and Shift with the wheel up', () => {
    const { line, press } = entered();
    expect(press(K.UPARROW)).toBe(true);
    expect(line.field.line()).toEqual({ text: '/ccc', cursor: 4, scroll: 0 });
    press(K.KP_UPARROW);
    expect(line.field.text).toBe('/bb');
    expect(press(letter('p'), K.CTRL)).toBe(true);
    expect(line.field.text).toBe('/a');
    press(K.MWHEELUP, K.SHIFT);
    expect(line.field.text).toBe('/a');
    expect(line.scrollback.pageUp).not.toHaveBeenCalled();
  });

  it('goes on on Down, keypad Down, Ctrl+N and Shift with the wheel down, then empties', () => {
    const { line, press } = entered();
    press(K.UPARROW);
    press(K.UPARROW);
    press(K.UPARROW);
    expect(press(K.DOWNARROW)).toBe(true);
    expect(line.field.text).toBe('/bb');
    press(K.KP_DOWNARROW);
    expect(line.field.text).toBe('/ccc');
    expect(press(letter('n'), K.CTRL)).toBe(true);
    expect(line.field.line()).toEqual({ text: '', cursor: 0, scroll: 0 });
    press(K.UPARROW);
    press(K.MWHEELDOWN, K.SHIFT);
    expect(line.field.text).toBe('');
    expect(line.scrollback.pageDown).not.toHaveBeenCalled();
  });

  it('loses a line being typed to Up, and clears it on Up before any is entered', () => {
    const fresh = console78();
    fresh.type('half');
    fresh.press(K.UPARROW);
    expect(fresh.line.field.line()).toEqual({ text: '', cursor: 0, scroll: 0 });

    const { line, press, type } = entered();
    type('typing');
    press(K.UPARROW);
    press(K.DOWNARROW);
    expect(line.field.text).toBe('');
  });

  it('hands P, N and L to the field without Ctrl', () => {
    const { line, press } = entered();
    for (const ch of 'pnl') expect(press(letter(ch))).toBe(false);
    expect(line.field.text).toBe('');
    // The three lines entered, and no more.
    expect(line.run).toHaveBeenCalledTimes(3);
  });
});

describe('consoleKey: the text and the field', () => {
  it('runs clear on Ctrl+L', () => {
    const { line, press } = console78();
    expect(press(letter('l'), K.CTRL)).toBe(true);
    expect(line.run.mock.calls).toEqual([['clear']]);
  });

  it('scrolls the text two lines on PgUp and PgDn, and on the wheel two, or six with Ctrl', () => {
    const { line, press } = console78();
    const { pageUp, pageDown } = line.scrollback;
    expect(press(K.PGUP)).toBe(true);
    expect(pageUp).toHaveBeenCalledTimes(1);
    press(K.MWHEELUP);
    expect(pageUp).toHaveBeenCalledTimes(2);
    press(K.MWHEELUP, K.CTRL);
    expect(pageUp).toHaveBeenCalledTimes(5);
    expect(press(K.PGDN)).toBe(true);
    expect(pageDown).toHaveBeenCalledTimes(1);
    press(K.MWHEELDOWN);
    press(K.MWHEELDOWN, K.CTRL);
    expect(pageDown).toHaveBeenCalledTimes(5);
  });

  it("goes to the text's top and bottom on Ctrl+Home and Ctrl+End, the line's ends without", () => {
    const { line, press, type } = console78();
    type('abc');
    expect(press(K.HOME, K.CTRL)).toBe(true);
    expect(line.scrollback.top).toHaveBeenCalledTimes(1);
    expect(line.field.cursor).toBe(3);
    press(K.HOME);
    expect(line.field.cursor).toBe(0);
    expect(press(K.END, K.CTRL)).toBe(true);
    expect(line.scrollback.bottom).toHaveBeenCalledTimes(1);
    expect(line.field.cursor).toBe(0);
    press(K.END);
    expect(line.field.cursor).toBe(3);
  });

  it('hands any other key to the field, which says whether it was its own', () => {
    const { line, press, type } = console78();
    type('abc');
    expect(press(K.LEFTARROW)).toBe(true);
    expect(line.field.cursor).toBe(2);
    expect(press(K.PAUSE)).toBe(false);
    expect(press(K.KP_PGUP)).toBe(false);
    expect(line.scrollback.pageUp).not.toHaveBeenCalled();
  });
});

describe('consoleKey: as ioquake3 runs it', () => {
  it.each([1, 2, 3])('runs seed %i as ioquake3 does', (seed) => {
    expect(runConsole(consoleCorpus(seed, 6000))).toEqual(TWIN[seed]);
  });

  it('keeps the lines typed into ioquake3 as the q3history it wrote for them', () => {
    const { line, press } = console78();
    // Typed as text alone, as the lines were sent to ioquake3's window.
    const send = (text: string) => {
      for (const ch of text) line.field.char(ch);
    };
    send('echo alpha');
    press(K.ENTER);
    send('/echo beta gamma');
    press(K.ENTER);
    send('say hi');
    press(K.ENTER);
    send(`echo ${'x'.repeat(90)}`);
    press(K.ENTER);
    // Windows typed the E of Ctrl+E as well.
    send('echo short');
    press(letter('e'), K.CTRL);
    send('\x05e');
    press(K.ENTER);
    press(K.UPARROW);
    press(K.UPARROW);
    press(K.ENTER);
    send('quit');
    press(K.ENTER);
    expect(line.history.text()).toBe(IOQ3_HISTORY);
  });
});
