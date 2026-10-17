import { describe, expect, it } from 'vitest';

import type { PlayerModelSkin } from '../formats/asset-manifest';
import { K } from '../formats/q3-keys';
import { GameConfig } from '../settings/game-config';
import { Menu, type MenuItem, type MenuPage, type MenuSound } from './menu';
import { MODELS_PER_PAGE, modelPage } from './menu-models';

/** q3_ui's Model page (`ui_playermodel.c`), used as a player would. */

/** Twenty models in their default skins, the eighteenth xaero in blue: a page of sixteen, and one of four. */
const MODELS: readonly PlayerModelSkin[] = Array.from({ length: 20 }, (_, i) =>
  i === 17 ? { model: 'xaero', skin: 'blue' } : { model: `m${i}`, skin: 'default' }
);

/** The Model page, opened over a page to go back to, with the player wearing `model`. */
function opened(model = 'm0') {
  const config = new GameConfig({ warn: () => {} });
  config.cvars.set('model', model);
  const sounds: MenuSound[] = [];
  const menu = new Menu({ sound: (sound) => sounds.push(sound) });
  const player: MenuPage = { items: [{ label: 'MODEL' }] };
  menu.open(player);
  const { page, open } = modelPage(menu, config, () => MODELS);
  open();
  sounds.length = 0;
  return { menu, config, page, player, sounds };
}

const cells = (page: MenuPage) => page.items.slice(0, MODELS_PER_PAGE);

/** The item on the page with this label. */
const labelled = (page: MenuPage, label: string) => page.items.find((item) => item.label === label)!;

/** Point at an item, and click it. */
function click(menu: Menu, item: MenuItem): void {
  menu.hover(menu.page!.items.indexOf(item));
  menu.key(K.MOUSE1);
}

describe('the Model page', () => {
  it('opens on the page of the model worn, found without regard to case, and picks it', () => {
    const { menu, page } = opened('Xaero/Blue');
    expect(menu.page).toBe(page);
    expect(cells(page).map((cell) => cell.icon)).toEqual([
      'models/players/m16/icon_default',
      'models/players/xaero/icon_blue',
      'models/players/m18/icon_default',
      'models/players/m19/icon_default',
      ...Array<undefined>(12).fill(undefined)
    ]);
    // A slot past the last model is dead.
    expect(cells(page).map((cell) => cell.hidden)).toEqual([...Array(4).fill(false), ...Array(12).fill(true)]);
    expect(cells(page).findIndex((cell) => cell.selected)).toBe(1);
    expect(page.caption).toBe('XAERO / BLUE');
    expect([labelled(page, 'PREVIOUS PAGE').hidden, labelled(page, 'NEXT PAGE').hidden]).toEqual([false, true]);
  });

  it('opens on the first page, with nothing picked, for a model the paks lack', () => {
    const { page } = opened('nobody');
    expect(cells(page)[0].icon).toBe('models/players/m0/icon_default');
    expect(cells(page).some((cell) => cell.selected)).toBe(false);
    expect(page.caption).toBe('NOBODY / DEFAULT');
    expect([labelled(page, 'PREVIOUS PAGE').hidden, labelled(page, 'NEXT PAGE').hidden]).toEqual([true, false]);
  });

  it('picks a model by its icon and shows it beside the page, writing nothing yet', () => {
    const { menu, config, page, sounds } = opened();
    click(menu, cells(page)[2]);
    expect(cells(page).map((cell) => cell.selected).indexOf(true)).toBe(2);
    expect(cells(page)[2].status).toBe('m2 / default');
    expect(page.caption).toBe('M2 / DEFAULT');
    const m2 = { model: 'm2', skin: 'default' };
    expect(page.preview!()).toEqual({ body: m2, head: m2 });
    expect(config.cvars.settings.model).toBe('m0');
    expect(sounds).toEqual(['move', 'move']);
  });

  it('writes the pick to all four model cvars on the way back, by Escape or by BACK', () => {
    const first = opened();
    click(first.menu, cells(first.page)[2]);
    first.menu.key(K.ESCAPE);
    expect(first.menu.page).toBe(first.player);
    const { settings } = first.config.cvars;
    // `PlayerModel_SaveChanges` writes the team pair beside the other two.
    expect([settings.model, settings.headModel, settings.teamModel, settings.teamHeadModel]).toEqual(
      ['m2/default', 'm2/default', 'm2/default', 'm2/default']
    );

    const second = opened();
    click(second.menu, cells(second.page)[5]);
    click(second.menu, labelled(second.page, 'BACK'));
    expect(second.menu.page).toBe(second.player);
    expect(second.config.cvars.settings.model).toBe('m5/default');
  });

  it('turns the page with its arrows, each hidden at its end', () => {
    const { menu, page } = opened();
    click(menu, labelled(page, 'NEXT PAGE'));
    expect(cells(page)[0].icon).toBe('models/players/m16/icon_default');
    expect(labelled(page, 'NEXT PAGE').hidden).toBe(true);
    click(menu, labelled(page, 'PREVIOUS PAGE'));
    expect(cells(page)[0].icon).toBe('models/players/m0/icon_default');
    expect(labelled(page, 'PREVIOUS PAGE').hidden).toBe(true);
  });

  it('steps through the icons with left and right, turning the page at its ends, and buzzes at the first and the last', () => {
    const { menu, page, sounds } = opened();
    expect(menu.cursor).toBe(0);
    menu.key(K.LEFTARROW);
    expect(menu.cursor).toBe(0);
    expect(sounds).toEqual(['buzz']);

    menu.key(K.RIGHTARROW);
    expect(menu.cursor).toBe(1);
    menu.select(MODELS_PER_PAGE - 1);
    menu.key(K.RIGHTARROW);
    expect([menu.cursor, cells(page)[0].icon]).toEqual([0, 'models/players/m16/icon_default']);
    menu.key(K.LEFTARROW);
    expect([menu.cursor, cells(page)[15].icon]).toEqual([15, 'models/players/m15/icon_default']);

    menu.key(K.RIGHTARROW);
    menu.select(3);
    sounds.length = 0;
    menu.key(K.KP_RIGHTARROW);
    expect(menu.cursor).toBe(3);
    expect(sounds).toEqual(['buzz']);
  });

  it('reads the models each time it opens, since they come after the menu', () => {
    let list: readonly PlayerModelSkin[] = [];
    const menu = new Menu();
    const { page, open } = modelPage(menu, new GameConfig({ warn: () => {} }), () => list);
    open();
    expect(cells(page).every((cell) => cell.hidden)).toBe(true);
    menu.key(K.ESCAPE);
    list = MODELS;
    open();
    expect(cells(page)[0].icon).toBe('models/players/m0/icon_default');
  });
});
