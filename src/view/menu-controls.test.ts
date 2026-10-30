import { describe, expect, it } from 'vitest';

import { K } from '../formats/q3-keys';
import { GameConfig, type GameConfigOptions } from '../settings/game-config';
import { Menu, type MenuItem, type MenuSound } from './menu';
import { bindText, controlsPage } from './menu-controls';

/** Controls: its sections, the capture of a key, and the mouse. */

const key = (char: string) => char.charCodeAt(0);

/** The Controls page, open over a config of its own, with the sounds it plays from here. */
function controls(options: GameConfigOptions = {}) {
  const config = new GameConfig({ print: () => {}, ...options });
  const sounds: MenuSound[] = [];
  const menu = new Menu({ sound: (sound) => sounds.push(sound) });
  menu.open(controlsPage(menu, config));
  sounds.length = 0;
  return { menu, config, sounds };
}

const labels = (menu: Menu) => menu.page!.items.map((item) => item.label);

/** The item on the page with this label. */
function row(menu: Menu, label: string): MenuItem {
  const found = menu.page!.items.find((item) => item.label === label);
  expect(found, label).toBeDefined();
  return found!;
}

/** Put the pointer over an item by its label. */
function point(menu: Menu, label: string): void {
  const index = labels(menu).indexOf(label);
  expect(index, label).toBeGreaterThanOrEqual(0);
  menu.hover(index, { x: 0.5 });
}

/** Show a section by its tab. */
function section(menu: Menu, name: string): void {
  point(menu, name);
  menu.key(K.MOUSE1);
}

describe('Controls', () => {
  it("gives each section all four, in its tabs' order, to share one panel", () => {
    const { menu } = controls();
    const sections = menu.page!.sections!;
    expect(sections).toHaveLength(4);
    expect(sections[0]).toBe(menu.page);
    section(menu, 'SHOOT');
    expect(menu.page).toBe(sections[2]);
    expect(menu.page!.sections).toBe(sections);
  });

  it("opens at Look, and switches sections in place, as Q3's tabs do", () => {
    const { menu, sounds } = controls();
    expect(menu.page!.title).toBe('CONTROLS');
    expect(labels(menu)).toEqual(['LOOK', 'MOVE', 'SHOOT', 'MISC', 'mouse speed', 'invert mouse', 'BACK']);

    section(menu, 'MOVE');
    expect([menu.depth, menu.cursor]).toEqual([1, 1]);
    expect(labels(menu).slice(4)).toEqual([
      'walk forward',
      'backpedal',
      'step left',
      'step right',
      'up / jump',
      'down / crouch',
      'BACK'
    ]);
    expect(sounds).toEqual(['move', 'move']);

    section(menu, 'SHOOT');
    expect(labels(menu).slice(4)).toEqual([
      'attack',
      'next weapon',
      'prev weapon',
      'gauntlet',
      'machinegun',
      'shotgun',
      'grenade launcher',
      'rocket launcher',
      'lightning',
      'railgun',
      'plasma gun',
      'BFG',
      'Fire grapple',
      'BACK'
    ]);
  });

  it('lays every section out for the longest, so the page keeps its size as the tabs switch', () => {
    const { menu } = controls();
    const tabs = menu.page!.items.filter((item) => item.tab !== undefined).map((item) => item.label);
    const rows = tabs.map((name) => {
      section(menu, name);
      const page = menu.page!;
      expect(page.rows, name).toBeGreaterThanOrEqual(page.items.length - tabs.length);
      return page.rows;
    });
    // Shoot's thirteen binds, and BACK.
    expect(rows).toEqual(tabs.map(() => 14));
  });

  it('keeps Misc for everyone, with show scores first as Q3 lists it, the collision overlay after', () => {
    const chats = ['chat', 'chat - team', 'chat - target', 'chat - attacker'];
    const plain = controls({ debugMode: false }).menu;
    expect(labels(plain).slice(0, 4)).toEqual(['LOOK', 'MOVE', 'SHOOT', 'MISC']);
    section(plain, 'MISC');
    expect(labels(plain).slice(4)).toEqual(['show scores', 'use item', ...chats, 'BACK']);
    expect(row(plain, 'show scores').value).toBe('TAB');
    // Q3's second Misc row is the holdable key, bound to Enter by pak0's `default.cfg:29`.
    expect(row(plain, 'use item').value).toBe('ENTER');
    // The four chats, on `messagemode` to `messagemode4`; Q3 binds none but the first.
    expect(chats.map((label) => row(plain, label).value)).toEqual(['T', 'Y', '???', '???']);

    const { menu } = controls();
    section(menu, 'MISC');
    expect(labels(menu).slice(4)).toEqual([
      'show scores',
      'use item',
      ...chats,
      'collision overlay',
      'BACK'
    ]);
    expect(row(menu, 'collision overlay').value).toBe('C');
  });

  it("reads a row's first two keys in upper case, or ??? for none (Controls_DrawKeyBinding)", () => {
    expect(bindText([])).toBe('???');
    expect(bindText([key('w'), K.UPARROW, key('x')])).toBe('W or UPARROW');
    const { menu } = controls();
    section(menu, 'MOVE');
    expect(row(menu, 'walk forward').value).toBe('W');
    expect(row(menu, 'down / crouch').value).toBe('SHIFT');
  });
});

describe("Controls' capture (Controls_MenuKey)", () => {
  it('waits for a key on Enter, greys the rest, and takes the key from where it was bound', () => {
    const { menu, config, sounds } = controls();
    section(menu, 'MOVE');
    point(menu, 'walk forward');
    sounds.length = 0;
    menu.key(K.ENTER);
    const forward = row(menu, 'walk forward');
    expect([forward.status, forward.grayed, forward.marked]).toEqual([
      'Waiting for new key ... ESCAPE to cancel',
      false,
      true
    ]);
    expect([row(menu, 'backpedal').grayed, row(menu, 'MOVE').grayed]).toEqual([true, true]);

    menu.key(key('s'));
    expect(config.binds.get(key('s'))).toBe('+forward');
    expect(forward.value).toBe('S or W');
    expect(row(menu, 'backpedal').value).toBe('???');
    expect(row(menu, 'backpedal').grayed).toBe(false);
    expect(sounds).toEqual(['move', 'out']);
  });

  it('keeps both keys for one it had, and takes the command alone for a third', () => {
    const { menu, config } = controls();
    section(menu, 'MOVE');
    point(menu, 'walk forward');
    menu.key(K.ENTER);
    menu.key(K.UPARROW);
    menu.key(K.ENTER);
    menu.key(key('w'));
    expect(row(menu, 'walk forward').value).toBe('W or UPARROW');
    menu.key(K.ENTER);
    menu.key(key('i'));
    expect(row(menu, 'walk forward').value).toBe('I');
    expect([config.binds.get(key('w')), config.binds.get(K.UPARROW)]).toEqual([undefined, undefined]);
  });

  it('cancels on Escape, passes the backquote over, and takes a mouse button', () => {
    const { menu, config, sounds } = controls();
    section(menu, 'SHOOT');
    point(menu, 'attack');
    menu.key(K.MOUSE1);
    sounds.length = 0;
    menu.key(K.ESCAPE);
    expect(row(menu, 'attack').status).not.toContain('Waiting');
    expect(menu.depth).toBe(1);
    expect(sounds).toEqual(['out']);

    menu.key(K.ENTER);
    menu.key(key('`'));
    expect(row(menu, 'attack').status).toContain('Waiting');
    menu.key(K.MOUSE2);
    expect(config.binds.get(K.MOUSE2)).toBe('+attack');
    expect(row(menu, 'attack').value).toBe('MOUSE1 or MOUSE2');
  });

  it("clears a row's keys on Backspace or Delete while nothing waits, and nothing else's", () => {
    const { menu, config, sounds } = controls();
    section(menu, 'SHOOT');
    point(menu, 'next weapon');
    sounds.length = 0;
    menu.key(K.BACKSPACE);
    expect(row(menu, 'next weapon').value).toBe('???');
    expect(config.binds.get(K.MWHEELDOWN)).toBeUndefined();
    expect(sounds).toEqual(['out']);
    point(menu, 'SHOOT');
    expect(menu.key(K.DEL)).toBe(false);
  });

  it('binds the scores key from Misc, keeping the one it had, and clears it', () => {
    const { menu, config } = controls({ debugMode: false });
    section(menu, 'MISC');
    point(menu, 'show scores');
    menu.key(K.ENTER);
    menu.key(key('k'));
    expect(config.binds.get(key('k'))).toBe('+scores');
    expect(row(menu, 'show scores').value).toBe('TAB or K');

    menu.key(K.BACKSPACE);
    expect(row(menu, 'show scores').value).toBe('???');
    expect([config.binds.get(K.TAB), config.binds.get(key('k'))]).toEqual([undefined, undefined]);
  });

  it('binds each chat row to its message mode, as Q3 names them (ui_controls2.c:262–265)', () => {
    const { menu, config } = controls({ debugMode: false });
    section(menu, 'MISC');
    const chats = { chat: 'g', 'chat - team': 'h', 'chat - target': 'j', 'chat - attacker': 'k' };
    for (const [label, pressed] of Object.entries(chats)) {
      point(menu, label);
      menu.key(K.ENTER);
      menu.key(key(pressed));
    }
    expect(['g', 'h', 'j', 'k'].map((pressed) => config.binds.get(key(pressed)))).toEqual([
      'messagemode',
      'messagemode2',
      'messagemode3',
      'messagemode4'
    ]);
    expect(row(menu, 'chat').value).toBe('G or T');
  });

  it('warns of a key a browser keeps, on the row that has it, but not in the shell', () => {
    for (const shell of [false, true]) {
      const { menu } = controls({ shell });
      section(menu, 'SHOOT');
      point(menu, 'attack');
      expect(row(menu, 'attack').status).toBe('Press ENTER or CLICK to change, BACKSPACE to clear');
      menu.key(K.ENTER);
      menu.key(K.CTRL);
      const status = row(menu, 'attack').status;
      if (shell) expect(status).toBe('Press ENTER or CLICK to change, BACKSPACE to clear');
      else expect(status).toContain('a browser keeps Ctrl+W');
    }
  });
});

describe("Controls' Look", () => {
  it('sets the mouse speed from 2 to 30, and inverts the mouse through the sign of m_pitch', () => {
    const { menu, config } = controls();
    const speed = row(menu, 'mouse speed');
    expect([speed.value, speed.status]).toEqual(['6.8', 'Use Arrow Keys or CLICK to change']);
    point(menu, 'mouse speed');
    menu.key(K.RIGHTARROW);
    expect(config.cvars.string('sensitivity')).toBe('7.800000');

    point(menu, 'invert mouse');
    menu.key(K.ENTER);
    expect(config.cvars.string('m_pitch')).toBe('-0.022000');
    menu.key(K.ENTER);
    expect(config.cvars.string('m_pitch')).toBe('0.022000');
  });
});
