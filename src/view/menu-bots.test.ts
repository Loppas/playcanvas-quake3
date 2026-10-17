import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import type { ClientInfo } from './client-info';
import { Menu, type MenuItem } from './menu';
import {
  BOTS_PER_PAGE,
  DELAY_STEP,
  FIRST_DELAY,
  SKILLS,
  addBotsPage,
  removeBotsPage,
  type BotActions
} from './menu-bots';

/** Add bots and Remove bots, used as a player would. */

/** Nine bots, in no order, upper and lower case mixed so the sort has something to do. */
const BOTS = ['Sarge', 'anarki', 'Visor', 'Bones', 'grunt', 'Xaero', 'Doom', 'ranger', 'Major'];

/** The skill Add bots opens on, as `addbot` takes it: the control's place, and one. */
const DEFAULT_SKILL_NUMBER = 2;

function actions() {
  return { addBot: vi.fn(), removeBot: vi.fn() } satisfies BotActions;
}

/** A client's `CS_PLAYERS` reading: a bot has a skill, a player has none. */
function client(name: string, botSkill: number): ClientInfo {
  return { name, botSkill } as ClientInfo;
}

/** What the page shows now: the labels of the items that are drawn. */
const shown = (menu: Menu) =>
  menu.page!.items.filter((item) => !item.hidden).map((item) => item.label);

/** The item on the page with this label. */
function item(menu: Menu, label: string): MenuItem {
  const found = menu.page!.items.find((each) => each.label === label);
  expect(found, label).toBeDefined();
  return found!;
}

/** The names on the page, which are the rows before PREVIOUS PAGE. */
function names(menu: Menu): string[] {
  const rows = menu.page!.items.slice(0, BOTS_PER_PAGE);
  return rows.filter((row) => !row.hidden).map((row) => row.label);
}

/** The name the page has picked, or null. */
function picked(menu: Menu): string | null {
  const row = menu.page!.items.slice(0, BOTS_PER_PAGE).find((each) => each.selected);
  return row?.label ?? null;
}

/** Point at an item by its label and press a key, as a player clicks it. */
function press(menu: Menu, label: string, key: number = K.MOUSE1): void {
  const index = menu.page!.items.findIndex((each) => each.label === label);
  expect(index, label).toBeGreaterThanOrEqual(0);
  menu.hover(index, { x: 0.5 });
  menu.key(key);
}

describe('addBotsPage', () => {
  /** The page, opened over a menu of its own. */
  function opened(bots: readonly string[] = BOTS, teamGame = false) {
    const menu = new Menu();
    const done = actions();
    const page = addBotsPage(menu, done, () => bots, () => teamGame);
    page.open();
    return { menu, actions: done, page };
  }

  it('lists the bots by name, without regard to case, seven to a page', () => {
    const { menu } = opened();
    expect(names(menu)).toEqual(['anarki', 'Bones', 'Doom', 'grunt', 'Major', 'ranger', 'Sarge']);
    press(menu, 'NEXT PAGE');
    expect(names(menu)).toEqual(['Visor', 'Xaero']);
  });

  it('draws no row past the last name, and turns no page at the ends', () => {
    const { menu } = opened();
    expect(item(menu, 'PREVIOUS PAGE').grayed).toBe(true);
    expect(item(menu, 'NEXT PAGE').grayed).toBe(false);
    press(menu, 'NEXT PAGE');
    // Nine bots, so the second page holds two and its last five rows are gone.
    expect(menu.page!.items.slice(0, BOTS_PER_PAGE).filter((row) => row.hidden)).toHaveLength(5);
    expect(item(menu, 'PREVIOUS PAGE').grayed).toBe(false);
    expect(item(menu, 'NEXT PAGE').grayed).toBe(true);
  });

  it('turns no page past either end, even asked to straight out', () => {
    // The ends are greyed, so the menu never asks; the guard is what makes that belt and braces.
    const { menu } = opened();
    const first = names(menu);
    item(menu, 'PREVIOUS PAGE').activate!();
    expect(names(menu)).toEqual(first);
    press(menu, 'NEXT PAGE');
    item(menu, 'NEXT PAGE').activate!();
    expect(names(menu)).toEqual(['Visor', 'Xaero']);
  });

  it('opens on the first name, and picks the one clicked', () => {
    const { menu } = opened();
    expect(picked(menu)).toBe('anarki');
    press(menu, 'Major');
    expect(picked(menu)).toBe('Major');
  });

  it('sends the pick, its skill and its team, and holds each back longer than the last', () => {
    // Q3's own numbers: the first waits a second, and each after it a second and a half more.
    expect(FIRST_DELAY).toBe(1000);
    expect(DELAY_STEP).toBe(1500);
    const { menu, actions: done } = opened();
    press(menu, 'Doom');
    press(menu, 'ADD');
    expect(done.addBot).toHaveBeenLastCalledWith('Doom', DEFAULT_SKILL_NUMBER, 'Free', FIRST_DELAY);
    press(menu, 'ADD');
    expect(done.addBot).toHaveBeenLastCalledWith(
      'Doom',
      DEFAULT_SKILL_NUMBER,
      'Free',
      FIRST_DELAY + DELAY_STEP
    );
    expect(done.addBot).toHaveBeenCalledTimes(2);
  });

  it("starts at Q3's skill, goes through its five names, and sends the one shown", () => {
    const { menu, actions: done } = opened();
    expect(SKILLS).toEqual([
      'I Can Win',
      'Bring It On',
      'Hurt Me Plenty',
      'Hardcore',
      'Nightmare!'
    ]);
    const skill = item(menu, 'Skill');
    expect(skill.value).toBe('Bring It On');
    press(menu, 'Skill', K.RIGHTARROW);
    expect(skill.value).toBe('Hurt Me Plenty');
    press(menu, 'ADD');
    // The third name is skill 3: the control's place, and one.
    expect(done.addBot).toHaveBeenLastCalledWith('anarki', 3, 'Free', FIRST_DELAY);
  });

  it('offers only Free, greyed, where the match has no teams', () => {
    const { menu } = opened();
    expect(item(menu, 'Team').value).toBe('Free');
    expect(item(menu, 'Team').grayed).toBe(true);
  });

  it('offers both sides in a team game, and sends the one it shows', () => {
    const { menu, actions: done } = opened(BOTS, true);
    const team = item(menu, 'Team');
    expect(team.grayed).toBe(false);
    expect(team.value).toBe('Red');
    press(menu, 'ADD');
    expect(done.addBot).toHaveBeenLastCalledWith(
      'anarki',
      DEFAULT_SKILL_NUMBER,
      'Red',
      FIRST_DELAY
    );

    press(menu, 'Team', K.RIGHTARROW);
    expect(team.value).toBe('Blue');
    press(menu, 'ADD');
    expect(done.addBot).toHaveBeenLastCalledWith(
      'anarki',
      DEFAULT_SKILL_NUMBER,
      'Blue',
      FIRST_DELAY + DELAY_STEP
    );

    // Two sides, so either way round the list wraps at once.
    press(menu, 'Team', K.RIGHTARROW);
    expect(team.value).toBe('Red');
    press(menu, 'Team', K.LEFTARROW);
    expect(team.value).toBe('Blue');
  });

  it('gives back a side the match no longer has', () => {
    let teams = true;
    const menu = new Menu();
    const done = actions();
    addBotsPage(
      menu,
      done,
      () => BOTS,
      () => teams
    ).open();
    press(menu, 'Team', K.RIGHTARROW);
    expect(item(menu, 'Team').value).toBe('Blue');

    teams = false;
    expect(item(menu, 'Team').value).toBe('Free');
    press(menu, 'ADD');
    expect(done.addBot).toHaveBeenLastCalledWith(
      'anarki',
      DEFAULT_SKILL_NUMBER,
      'Free',
      FIRST_DELAY
    );
  });

  it('starts afresh each time: the first page, the first name, the first delay', () => {
    const { menu, page, actions: done } = opened();
    press(menu, 'NEXT PAGE');
    press(menu, 'Xaero');
    press(menu, 'ADD');
    menu.pop();

    page.open();
    expect(names(menu)[0]).toBe('anarki');
    expect(picked(menu)).toBe('anarki');
    press(menu, 'ADD');
    expect(done.addBot).toHaveBeenLastCalledWith(
      'anarki',
      DEFAULT_SKILL_NUMBER,
      'Free',
      FIRST_DELAY
    );
  });

  it('has nothing to send where the install named no bots', () => {
    const { menu, actions: done } = opened([]);
    expect(names(menu)).toEqual([]);
    expect(item(menu, 'ADD').grayed).toBe(true);
    press(menu, 'ADD');
    expect(done.addBot).not.toHaveBeenCalled();
    // The button is greyed, so the menu never asks; the guard is what makes that belt and braces.
    item(menu, 'ADD').activate!();
    expect(done.addBot).not.toHaveBeenCalled();
  });
});

describe('removeBotsPage', () => {
  /** Slot 0 is the player, slot 3 nobody, and the rest are bots. */
  const MATCH: (ClientInfo | null)[] = [
    client('UnnamedPlayer', 0),
    client('^1Grunt', 4),
    client('Hunter', 2),
    null,
    client('Major', 5)
  ];

  function opened(match: (ClientInfo | null)[] = [...MATCH]) {
    const menu = new Menu();
    const done = actions();
    const page = removeBotsPage(
      menu,
      done,
      (n) => match[n] ?? null,
      () => match.length
    );
    page.open();
    return { menu, actions: done, match };
  }

  it('lists the bots in the match, by slot, with their colours taken out', () => {
    const { menu } = opened();
    expect(names(menu)).toEqual(['Grunt', 'Hunter', 'Major']);
  });

  it('kicks the slot the pick is in, not the row it is on', () => {
    const { menu, actions: done } = opened();
    press(menu, 'Hunter');
    press(menu, 'DELETE');
    // Hunter is the second name and the third slot.
    expect(done.removeBot).toHaveBeenCalledWith(2);
  });

  it('loses a bot from the list as it goes, and picks the first again', () => {
    const { menu, actions: done, match } = opened();
    press(menu, 'Major');
    press(menu, 'DELETE');
    expect(done.removeBot).toHaveBeenCalledWith(4);

    // The kick reaches the match a frame later, when the command buffer runs it; the page reads
    // the match afresh, so the bot goes from the list without the page being opened again.
    match[4] = null;
    expect(names(menu)).toEqual(['Grunt', 'Hunter']);
    expect(picked(menu)).toBe('Grunt');
  });

  it('looks through as many slots as the server has, and no further', () => {
    const { menu } = opened();
    expect(names(menu)).toEqual(['Grunt', 'Hunter', 'Major']);

    const menu2 = new Menu();
    const page = removeBotsPage(
      menu2,
      actions(),
      (n) => MATCH[n] ?? null,
      () => 3
    );
    page.open();
    expect(names(menu2)).toEqual(['Grunt', 'Hunter']);
  });

  it('has nothing to kick in a match with no bots', () => {
    const { menu, actions: done } = opened([client('UnnamedPlayer', 0)]);
    expect(names(menu)).toEqual([]);
    expect(item(menu, 'DELETE').grayed).toBe(true);
    press(menu, 'DELETE');
    expect(done.removeBot).not.toHaveBeenCalled();
  });

  it('shows every item of its own and nothing else', () => {
    expect(shown(opened().menu)).toEqual([
      'Grunt',
      'Hunter',
      'Major',
      'PREVIOUS PAGE',
      'NEXT PAGE',
      'DELETE',
      'BACK'
    ]);
  });
});
