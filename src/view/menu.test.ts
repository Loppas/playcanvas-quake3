import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import {
  MAX_MENU_DEPTH,
  Menu,
  type KeyResult,
  type MenuItem,
  type MenuPage,
  type MenuSound,
  type Pointer
} from './menu';

/**
 * q3_ui's menu framework, headless: the stack, the cursor, the keys, the pointer and the sounds.
 */

const KEY_Q = 'q'.charCodeAt(0);

/** A menu that records the sounds it plays, its pages going up, and its closing. */
function recorded() {
  const sounds: MenuSound[] = [];
  const pushed = vi.fn();
  const closed = vi.fn();
  const menu = new Menu({ sound: (sound) => sounds.push(sound), pushed, closed });
  return { menu, sounds, pushed, closed };
}

/** A page of items by their labels, a label in brackets greyed, with the items activated, in order. */
function page(labels: readonly string[], extra: Partial<MenuPage> = {}) {
  const activated: string[] = [];
  const items: MenuItem[] = labels.map((label) => {
    const grayed = label.startsWith('[');
    const name = grayed ? label.slice(1, -1) : label;
    return { label: name, grayed, activate: () => activated.push(name) };
  });
  return { page: { items, ...extra }, activated };
}

describe('the stack (UI_PushMenu, UI_PopMenu)', () => {
  it('takes the whole menu away at a force-off, however deep, and quietly', () => {
    const { menu, sounds, closed } = recorded();
    menu.open(page(['A']).page);
    menu.push(page(['B']).page);
    sounds.length = 0;

    menu.forceOff();

    expect(menu.isOpen).toBe(false);
    expect(menu.page).toBeNull();
    expect(sounds).toEqual([]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('says so at each page put up, as UI_PushMenu sets the catcher, and not at one put in its place', () => {
    const { menu, pushed } = recorded();
    const first = page(['A']).page;
    menu.open(first);
    menu.push(page(['B']).page);
    menu.push(first);
    expect(pushed).toHaveBeenCalledTimes(3);
    menu.replace(page(['C']).page);
    menu.pop();
    expect(pushed).toHaveBeenCalledTimes(3);
  });

  it('is not closed twice by a force-off on a menu that is already off', () => {
    const { menu, closed } = recorded();

    menu.forceOff();

    expect(closed).not.toHaveBeenCalled();
  });

  it('opens a page alone on the stack, its cursor on the first live item, with the in sound', () => {
    const { menu, sounds } = recorded();
    const first = page(['A']).page;
    const second = page(['[B]', 'C', 'D']).page;
    menu.open(first);
    menu.push(page(['E']).page);
    menu.open(second);
    expect(menu.depth).toBe(1);
    expect(menu.page).toBe(second);
    expect(menu.cursor).toBe(1);
    expect(sounds).toEqual(['in', 'in', 'in']);
  });

  it('cuts back to a page pushed again, with its cursor at the start', () => {
    const { menu } = recorded();
    const [a, b, c] = ['A', 'B', 'C'].map((label) => page([label, 'X']).page);
    menu.push(a);
    menu.push(b);
    menu.key(K.DOWNARROW);
    menu.push(c);
    menu.push(b);
    expect(menu.depth).toBe(2);
    expect(menu.page).toBe(b);
    expect(menu.cursor).toBe(0);
  });

  it("puts another page in the top one's place without a sound, its cursor where it is told", () => {
    const { menu, sounds } = recorded();
    menu.open(page(['A']).page);
    menu.push(page(['B', 'C']).page);
    const other = page(['D', 'E', 'F']).page;
    sounds.length = 0;
    menu.replace(other, 2);
    expect([menu.depth, menu.page, menu.cursor]).toEqual([2, other, 2]);
    expect(sounds).toEqual([]);
  });

  it('refuses a page past the eighth', () => {
    const { menu } = recorded();
    for (let i = 0; i < MAX_MENU_DEPTH; i++) menu.push(page(['A']).page);
    expect(() => menu.push(page(['A']).page)).toThrow('menu stack overflow');
  });

  it('goes back a page on Escape or the right button, with the out sound, and closes from the last', () => {
    const { menu, sounds, closed } = recorded();
    menu.push(page(['A']).page);
    menu.push(page(['B']).page);
    sounds.length = 0;
    expect(menu.key(K.ESCAPE)).toBe(true);
    expect(menu.depth).toBe(1);
    expect(closed).not.toHaveBeenCalled();
    menu.key(K.MOUSE2);
    expect(menu.isOpen).toBe(false);
    expect(closed).toHaveBeenCalledOnce();
    expect(sounds).toEqual(['out', 'out']);
    expect(menu.key(K.ESCAPE)).toBe(false);
  });

  it('puts the cursor on an item quietly, taking the pointer off it (Menu_SetCursor)', () => {
    const { menu, sounds } = recorded();
    menu.open(page(['A', 'B', 'C']).page);
    menu.hover(0);
    sounds.length = 0;
    menu.select(2);
    expect([menu.cursor, menu.mouseFocus]).toEqual([2, false]);
    expect(sounds).toEqual([]);
  });
});

describe('the cursor (Menu_AdjustCursor)', () => {
  it('goes down with Down and Tab and up with Up, round the page, passing greyed items', () => {
    const { menu, sounds } = recorded();
    menu.open(page(['A', '[B]', 'C', 'D']).page);
    sounds.length = 0;
    const cursors = [K.DOWNARROW, K.TAB, K.KP_DOWNARROW, K.UPARROW, K.KP_UPARROW].map((key) => {
      menu.key(key);
      return menu.cursor;
    });
    expect(cursors).toEqual([2, 3, 0, 3, 2]);
    expect(sounds).toEqual(['move', 'move', 'move', 'move', 'move']);
  });

  it('passes hidden items by, as it passes greyed ones', () => {
    const { menu } = recorded();
    menu.open({ items: [{ label: 'A' }, { label: 'APPLY', hidden: true }, { label: 'C' }] });
    menu.key(K.DOWNARROW);
    expect(menu.cursor).toBe(2);
    menu.hover(1);
    expect(menu.mouseFocus).toBe(false);
  });

  it('passes an inactive item by, starts past it, and never uses it', () => {
    const { menu } = recorded();
    const activate = vi.fn();
    menu.open({ items: [{ label: 'HUMAN', inactive: true, activate }, { label: 'B' }, { label: 'C' }] });
    expect(menu.cursor).toBe(1);
    menu.key(K.DOWNARROW);
    menu.key(K.DOWNARROW);
    expect(menu.cursor).toBe(1);
    menu.hover(0);
    expect(menu.mouseFocus).toBe(false);
    menu.key(K.MOUSE1);
    expect(activate).not.toHaveBeenCalled();
  });

  it('plays nothing when there is nowhere else to go', () => {
    const { menu, sounds } = recorded();
    menu.open(page(['[A]', 'B', '[C]']).page);
    sounds.length = 0;
    menu.key(K.DOWNARROW);
    menu.key(K.UPARROW);
    expect(menu.cursor).toBe(1);
    expect(sounds).toEqual([]);
  });
});

describe('activation (Menu_ActivateItem)', () => {
  it('activates the item at the cursor on Enter, then plays the move sound', () => {
    const { menu, sounds } = recorded();
    const { page: shown, activated } = page(['A', 'B']);
    menu.open(shown);
    menu.key(K.DOWNARROW);
    sounds.length = 0;
    menu.key(K.ENTER);
    menu.key(K.KP_ENTER);
    expect(activated).toEqual(['B', 'B']);
    expect(sounds).toEqual(['move', 'move']);
  });

  it('plays nothing for a silent item', () => {
    const { menu, sounds } = recorded();
    const activate = vi.fn();
    menu.open({ items: [{ label: 'A', silent: true, activate }] });
    sounds.length = 0;
    menu.key(K.ENTER);
    expect(activate).toHaveBeenCalledOnce();
    expect(sounds).toEqual([]);
  });

  it('gives the item at the cursor its keys first, and plays what it says', () => {
    const { menu, sounds } = recorded();
    const key = (pressed: number): KeyResult =>
      pressed === K.RIGHTARROW ? 'buzz' : pressed === K.LEFTARROW ? 'silent' : null;
    menu.open({ items: [{ label: 'A', key }, { label: 'B' }] });
    sounds.length = 0;
    expect(menu.key(K.RIGHTARROW)).toBe(true);
    expect(menu.key(K.LEFTARROW)).toBe(true);
    menu.key(K.DOWNARROW);
    expect(sounds).toEqual(['buzz', 'move']);
    expect(menu.cursor).toBe(1);
  });

  it('hands the widget the pointer, and where it is on the item, only while it is over it', () => {
    const { menu } = recorded();
    const key = vi.fn((_key: number, _pointer?: Pointer): KeyResult => 'move');
    menu.open({ items: [{ label: 'A', key }] });
    menu.key(K.RIGHTARROW);
    menu.hover(0, { x: 0.25 });
    menu.key(K.MOUSE1);
    menu.hover(0, { x: 1, number: true });
    menu.key(K.MOUSE1);
    expect(key.mock.calls).toEqual([
      [K.RIGHTARROW, undefined],
      [K.MOUSE1, { x: 0.25 }],
      [K.MOUSE1, { x: 1, number: true }]
    ]);
  });

  it("handles another key in the widget's key's place, as a field's Enter is Tab", () => {
    const { menu } = recorded();
    menu.open({ items: [{ label: 'Name', key: (key) => (key === K.ENTER ? K.TAB : null) }, { label: 'B' }] });
    menu.key(K.ENTER);
    expect(menu.cursor).toBe(1);
  });

  it('gives a typed character to the item at the cursor, which only a field takes', () => {
    const { menu } = recorded();
    const typed: string[] = [];
    const char = (ch: string): KeyResult => {
      typed.push(ch);
      return 'silent';
    };
    menu.open({ items: [{ label: 'Name', char }, { label: 'B' }] });
    expect(menu.char('A')).toBe(true);
    menu.key(K.DOWNARROW);
    expect(menu.char('b')).toBe(false);
    expect(typed).toEqual(['A']);
  });

  it('lets the page take a key first, with the sound it gives', () => {
    const { menu, sounds } = recorded();
    const { page: shown, activated } = page(['A'], { key: (key) => (key === KEY_Q ? 'buzz' : key) });
    menu.open(shown);
    sounds.length = 0;
    expect(menu.key(KEY_Q)).toBe(true);
    menu.key(K.ENTER);
    expect(sounds).toEqual(['buzz', 'move']);
    expect(activated).toEqual(['A']);
  });

  it('leaves a key it has no use for', () => {
    const { menu } = recorded();
    menu.open(page(['A']).page);
    expect(menu.key(KEY_Q)).toBe(false);
  });
});

describe('the pointer (UI_MouseEvent)', () => {
  it('moves the cursor to the item under it, with the move sound, and a click uses that item', () => {
    const { menu, sounds } = recorded();
    const { page: shown, activated } = page(['A', 'B', 'C']);
    menu.open(shown);
    sounds.length = 0;
    menu.hover(2);
    menu.hover(2);
    expect(menu.cursor).toBe(2);
    expect(menu.mouseFocus).toBe(true);
    menu.key(K.MOUSE1);
    expect(activated).toEqual(['C']);
    expect(sounds).toEqual(['move', 'move']);
  });

  it('uses nothing on a click off every item, or over a greyed one', () => {
    const { menu } = recorded();
    const { page: shown, activated } = page(['A', '[B]']);
    menu.open(shown);
    menu.hover(0);
    menu.hover(null);
    menu.key(K.MOUSE1);
    menu.hover(1);
    menu.key(K.MOUSE1);
    expect(activated).toEqual([]);
    expect(menu.cursor).toBe(0);
  });

  it('takes the click away once the keys move the cursor off the item under it', () => {
    const { menu } = recorded();
    const { page: shown, activated } = page(['A', 'B']);
    menu.open(shown);
    menu.hover(0);
    menu.key(K.DOWNARROW);
    menu.key(K.MOUSE1);
    expect(activated).toEqual([]);
  });

  it('plays nothing when it comes to a silent item', () => {
    const { menu, sounds } = recorded();
    menu.open({ items: [{ label: 'A' }, { label: 'B', silent: true }] });
    sounds.length = 0;
    menu.hover(1);
    expect(sounds).toEqual([]);
  });
});

describe('an edit under way', () => {
  it('sees Escape before the page goes back, and once it is done, Escape goes back', () => {
    const { menu, sounds } = recorded();
    const seen: number[] = [];
    let editing = true;
    const item: MenuItem = {
      label: 'Field of view',
      get editing() {
        return editing;
      },
      key: (key) => {
        seen.push(key);
        if (key !== K.ESCAPE) return null;
        editing = false;
        return 'silent';
      }
    };
    menu.open({ items: [item, { label: 'BACK' }] });
    sounds.length = 0;
    expect(menu.key(K.ESCAPE)).toBe(true);
    expect([menu.depth, seen, sounds]).toEqual([1, [K.ESCAPE], []]);
    menu.key(K.ESCAPE);
    expect(menu.isOpen).toBe(false);
  });

  it('tells the item the cursor leaves, however it goes', () => {
    const { menu } = recorded();
    const left: string[] = [];
    const items = (name: string): MenuItem[] =>
      [1, 2].map((n) => ({ label: `${name}${n}`, blur: () => left.push(`${name}${n}`) }));
    const first: MenuPage = { items: items('a') };
    const second: MenuPage = { items: items('b') };

    menu.open(first);
    menu.key(K.DOWNARROW);
    menu.hover(0);
    menu.hover(0);
    menu.select(1);
    menu.select(1);
    menu.push(second);
    menu.replace({ items: items('c') });
    menu.pop();
    menu.open(second);
    menu.key(K.ESCAPE);
    // Down, the pointer, a quiet move, a page over it, one in its place, back, the menu opened
    // again, and closed; staying put tells nothing.
    expect(left).toEqual(['a1', 'a2', 'a1', 'a2', 'b1', 'c1', 'a2', 'b1']);
  });
});

describe('a confirm (UI_ConfirmMenu)', () => {
  it('asks with the cursor on NO, and moves between the answers with left and right', () => {
    const { menu } = recorded();
    menu.open(page(['A']).page);
    menu.confirm('SURE?', vi.fn());
    expect(menu.page).toMatchObject({ title: 'SURE?', layout: 'confirm' });
    expect(menu.page!.items.map((item) => item.label)).toEqual(['YES', 'NO']);
    expect(menu.cursor).toBe(1);
    menu.key(K.LEFTARROW);
    expect(menu.cursor).toBe(0);
    menu.key(K.RIGHTARROW);
    expect(menu.cursor).toBe(1);
  });

  it('goes back a page and then acts on YES, and on NO only goes back', () => {
    const { menu } = recorded();
    const under = page(['A']).page;
    menu.open(under);
    const action = vi.fn(() => expect(menu.page).toBe(under));
    menu.confirm('SURE?', action);
    menu.key(K.ENTER);
    expect(action).not.toHaveBeenCalled();
    expect(menu.page).toBe(under);

    menu.confirm('SURE?', action);
    menu.key(K.LEFTARROW);
    menu.key(K.ENTER);
    expect(action).toHaveBeenCalledOnce();
  });

  it('carries a warning under its answers, as Defaults gives one', () => {
    const { menu } = recorded();
    menu.confirm('SET TO DEFAULTS?', vi.fn(), 'WARNING: This will reset *ALL* options.');
    expect(menu.page!.warning).toBe('WARNING: This will reset *ALL* options.');
  });

  it('answers at once to Y and N, and the letter goes no further', () => {
    const { menu } = recorded();
    const typed = vi.fn((): KeyResult => null);
    menu.open({ items: [{ label: 'NAME', key: typed }] });
    const action = vi.fn();
    menu.confirm('SURE?', action);
    menu.key('n'.charCodeAt(0));
    expect(action).not.toHaveBeenCalled();
    menu.confirm('SURE?', action);
    menu.key('y'.charCodeAt(0));
    expect(action).toHaveBeenCalledOnce();
    expect(typed).not.toHaveBeenCalled();
    expect(menu.depth).toBe(1);
  });
});

describe('the placement', () => {
  const page = (label: string): MenuPage => ({ items: [{ label }] });

  it("stands a menu's pages in the middle unless it was opened otherwise", () => {
    const menu = new Menu();
    menu.open(page('A'));
    expect(menu.placement).toBe('centred');
  });

  it('keeps the placement the menu was opened in for every page over the first, a confirm too', () => {
    const menu = new Menu();
    menu.open(page('A'), 'q3ui');
    menu.push(page('B'));
    menu.confirm('SURE?', () => {});
    expect(menu.page!.layout).toBe('confirm');
    expect(menu.placement).toBe('q3ui');
    menu.pop();
    menu.replace(page('C'));
    expect(menu.placement).toBe('q3ui');
  });

  it('takes the placement afresh at each opening', () => {
    const menu = new Menu();
    menu.open(page('A'), 'q3ui');
    menu.forceOff();
    menu.open(page('A'));
    expect(menu.placement).toBe('centred');
  });
});

describe("the pointer's items, a paste and a page's frame", () => {
  it('passes a pointer-only item by with the keys, and takes the pointer to it (MOUSEONLY)', () => {
    const { menu, sounds } = recorded();
    const arrow = vi.fn();
    const items: MenuItem[] = [
      { label: 'UP', mouseOnly: true, activate: arrow },
      { label: 'LIST', activate: () => {} },
      { label: 'DOWN', mouseOnly: true, activate: arrow },
      { label: 'BACK', activate: () => {} }
    ];
    menu.open({ items });
    // The cursor starts on the first item the keys reach, and goes round past the rest.
    expect(menu.cursor).toBe(1);
    menu.key(K.DOWNARROW);
    expect(menu.cursor).toBe(3);
    menu.key(K.TAB);
    expect(menu.cursor).toBe(1);

    menu.hover(2);
    expect(menu.cursor).toBe(2);
    sounds.length = 0;
    menu.key(K.MOUSE1);
    expect(arrow).toHaveBeenCalledOnce();
    expect(sounds).toEqual(['move']);
  });

  it('hands a paste to the live item at the cursor that takes one, and says whether it did', () => {
    const menu = new Menu();
    const pasted: string[] = [];
    menu.open({
      items: [
        { label: 'FIELD', paste: (text) => pasted.push(text) },
        { label: 'GREYED', grayed: true, paste: (text) => pasted.push(`grey ${text}`) },
        { label: 'BUTTON', activate: () => {} }
      ]
    });
    expect(menu.paste('203.0.113.9')).toBe(true);
    menu.select(1);
    expect(menu.paste('no')).toBe(false);
    menu.select(2);
    expect(menu.paste('no')).toBe(false);
    expect(pasted).toEqual(['203.0.113.9']);
    menu.forceOff();
    expect(menu.paste('no')).toBe(false);
  });

  it("runs the top page's frame alone, as q3_ui draws only the menu on top", () => {
    const menu = new Menu();
    const under = vi.fn();
    const over = vi.fn();
    menu.open({ items: [{ label: 'A' }], frame: under });
    menu.frame();
    menu.push({ items: [{ label: 'B' }], frame: over });
    menu.frame();
    expect([under.mock.calls.length, over.mock.calls.length]).toEqual([1, 1]);
    menu.forceOff();
    menu.frame();
    expect(over).toHaveBeenCalledOnce();
  });
});
