// @vitest-environment jsdom
import { Texture, type AppBase, type ElementComponent, type Entity } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import { ServerLists } from '../net/server-lists';
import { GameConfig } from '../settings/game-config';
import {
  Menu,
  type ColoredText,
  type MenuPage,
  type PageDetail,
  type Pointer
} from '../view/menu';
import { mainPage } from '../view/menu-pages';
import { serversMenu } from '../view/menu-servers';
import { startServerPage } from '../view/menu-start-server';
import { DEFAULT_LOOK } from '../view/player-model';
import type { Scoreboard } from '../view/scoreboard';
import { createTestApp, squareFont } from './engine-test-fixtures';
import { boxOnScreen, MENU_CAMERA_PRIORITY, MenuScreen } from './menu-screen';

/**
 * The menu on the null device. jsdom has no canvas to draw a font on, so the text is
 * drawn with none, and each line still carries its string.
 */

describe('MenuScreen', () => {
  let app: AppBase;
  let eye: Entity;
  let menu: Menu;
  let screen: MenuScreen;

  beforeEach(() => {
    ({ app, camera: eye } = createTestApp());
    menu = new Menu();
    screen = new MenuScreen(app, eye, menu, { font: null });
  });

  afterEach(() => {
    screen.destroy();
    app.destroy();
  });

  const find = (name: string) => app.root.findByName(name) as Entity | null;
  const element = (name: string): ElementComponent => find(name)!.element!;
  const texts = (count: number, read: (text: ElementComponent) => unknown) =>
    Array.from({ length: count }, (_, i) => read(element(`menu-item-${i}-text`)));

  it('draws nothing while the menu is closed', () => {
    screen.update();
    expect(find('menu')!.enabled).toBe(false);
    expect(find('menu-camera')!.enabled).toBe(false);
  });

  it("draws the page's items, the cursor's brightest and a greyed one dim", () => {
    menu.open({
      title: 'SETUP',
      items: [{ label: 'PLAYER', grayed: true }, { label: 'CONTROLS' }, { label: 'BACK' }]
    });
    screen.update();
    expect(find('menu')!.enabled).toBe(true);
    expect(element('menu-title').text).toBe('SETUP');
    expect(texts(3, (text) => text.text)).toEqual(['PLAYER', 'CONTROLS', 'BACK']);
    expect(texts(3, (text) => text.opacity)).toEqual([0.3, 1, 0.7]);
    expect(element('menu-item-1').opacity).toBeGreaterThan(0);
    expect(element('menu-item-2').opacity).toBe(0);

    menu.key(K.DOWNARROW);
    screen.update();
    expect(texts(3, (text) => text.opacity)).toEqual([0.3, 0.7, 1]);
  });

  it("draws a list's pick in the accent colour, lit as the cursor's own row is", () => {
    // Add bots and Remove bots show their pick this way, where Q3 draws it white among orange.
    menu.open({ items: [{ label: 'Anarki' }, { label: 'Angel', selected: true }] });
    screen.update();
    const [plain, pick] = [0, 1].map((i) => element(`menu-item-${i}-text`));
    expect(pick.color.g).toBeLessThan(plain.color.g);
    // The cursor sits on the first row, so the pick is lit without being under it.
    expect(menu.cursor).toBe(0);
    expect(pick.opacity).toBe(1);
  });

  it('hands the menu the item under the pointer, and the pointer leaving it', () => {
    menu.open({ items: [{ label: 'A' }, { label: 'B' }] });
    screen.update();
    element('menu-item-1').fire('mouseenter', {});
    expect(menu.cursor).toBe(1);
    expect(menu.mouseFocus).toBe(true);
    element('menu-item-1').fire('mouseleave', {});
    expect(menu.mouseFocus).toBe(false);
  });

  it("lays a confirm's YES and NO side by side under its question", () => {
    menu.open({ items: [{ label: 'A' }] });
    menu.confirm('RESTART ARENA?', () => {});
    screen.update();
    expect(element('menu-title').text).toBe('RESTART ARENA?');
    const yes = find('menu-item-0')!.getLocalPosition();
    const no = find('menu-item-1')!.getLocalPosition();
    expect(yes.y).toBe(no.y);
    expect(yes.x).toBeLessThan(no.x);
  });

  it('lays a new page out afresh, and lets the last one go', () => {
    menu.open({ items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] });
    screen.update();
    menu.push({ items: [{ label: 'D' }] });
    screen.update();
    expect(texts(1, (text) => text.text)).toEqual(['D']);
    expect(find('menu-item-1')).toBeNull();
    expect(find('menu-title')!.enabled).toBe(false);
  });

  it("lays a settings row out with its label on the left and its value on the right, marked where the address set it", () => {
    menu.open({
      layout: 'form',
      items: [{ label: 'Draw FPS', value: 'off' }, { label: 'Draw 2D', value: 'on', marked: true }, { label: 'BACK' }]
    });
    screen.update();
    expect([element('menu-item-0-text').text, element('menu-item-0-value').text]).toEqual(['Draw FPS', 'off']);
    expect(find('menu-item-0-text')!.getLocalPosition().x).toBeLessThan(0);
    expect(find('menu-item-0-value')!.getLocalPosition().x).toBeGreaterThan(0);
    const [plain, marked] = [0, 1].map((i) => element(`menu-item-${i}-value`).color);
    expect(marked.g).toBeLessThan(plain.g);
    expect(find('menu-item-2-value')).toBeNull();
    expect(find('menu-item-2-text')!.getLocalPosition().x).toBe(0);
  });

  it("puts a slider's thumb along its bar", () => {
    let along = 0;
    menu.open({
      layout: 'form',
      items: [
        {
          label: 'Field of view',
          value: '89.2',
          get slider() {
            return along;
          }
        }
      ]
    });
    screen.update();
    const thumb = find('menu-item-0-thumb')!;
    const bar = find('menu-item-0-track')!;
    expect(thumb.getLocalPosition().x).toBe(bar.getLocalPosition().x);
    along = 1;
    screen.update();
    expect(thumb.getLocalPosition().x).toBeCloseTo(bar.getLocalPosition().x + bar.element!.width);
  });

  it("draws a strip of tabs across the page's head, the one shown lit", () => {
    menu.open({
      title: 'SYSTEM SETUP',
      layout: 'form',
      items: [
        { label: 'DISPLAY', tab: 'current' },
        { label: 'SOUND', tab: 'other' },
        { label: 'Field of view', value: '89.2' }
      ]
    });
    screen.update();
    const [display, sound, fov] = [0, 1, 2].map((i) => find(`menu-item-${i}`)!.getLocalPosition());
    expect(display.y).toBe(sound.y);
    expect(display.x).toBeLessThan(sound.x);
    expect(fov.y).toBeLessThan(display.y);
    expect(element('menu-item-0-text').color.g).toBeLessThan(element('menu-item-1-text').color.g);
  });

  it('keeps the rows a page is laid out for, with its last item at the foot', () => {
    // Two sections of one page, as a tab switches them: the shorter keeps the longer's room.
    const section = (count: number): MenuPage => ({
      title: 'CONTROLS',
      layout: 'form',
      rows: 4,
      items: [
        { label: 'LOOK', tab: 'current' },
        ...Array.from({ length: count }, (_, i) => ({ label: `row ${i}`, value: 'on' })),
        { label: 'BACK' }
      ]
    });
    menu.open(section(3));
    screen.update();
    const panel = element('menu-panel');
    const height = panel.height;
    const [first, back] = [1, 4].map((i) => find(`menu-item-${i}`)!.getLocalPosition().y);

    menu.replace(section(1));
    screen.update();
    // As tall, about the screen's middle, so its top stays put.
    expect(panel.height).toBe(height);
    expect(find('menu-item-1')!.getLocalPosition().y).toBe(first);
    expect(element('menu-item-2-text').text).toBe('BACK');
    expect(find('menu-item-2')!.getLocalPosition().y).toBe(back);
  });

  it('hides a hidden item until it is not', () => {
    let hidden = true;
    menu.open({
      layout: 'form',
      items: [
        { label: 'Renderer', value: 'opengl1' },
        {
          label: 'APPLY',
          get hidden() {
            return hidden;
          }
        }
      ]
    });
    screen.update();
    expect(find('menu-item-1')!.enabled).toBe(false);
    hidden = false;
    screen.update();
    expect(find('menu-item-1')!.enabled).toBe(true);
  });

  it('shows the status line of the item at the cursor', () => {
    menu.open({ layout: 'form', items: [{ label: 'A', value: 'on', status: 'Why it is so' }, { label: 'B', value: 'off' }] });
    screen.update();
    expect(find('menu-status')!.enabled).toBe(true);
    expect(element('menu-status').text).toBe('Why it is so');
    menu.key(K.DOWNARROW);
    screen.update();
    expect(find('menu-status')!.enabled).toBe(false);
  });

  it("draws a value's picture in place of its name, once the HUD has it", () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    menu.open({ layout: 'form', items: [{ label: 'Crosshair', value: 'e', icon: 'gfx/2d/crosshaire' }] });
    screen.update();
    expect(element('menu-item-0-value').text).toBe('e');
    expect(find('menu-item-0-icon')!.enabled).toBe(false);
    screen.images = (name) => (name === 'gfx/2d/crosshaire' ? texture : null);
    screen.update();
    expect(find('menu-item-0-icon')!.enabled).toBe(true);
    expect(element('menu-item-0-icon').texture).toBe(texture);
    expect(element('menu-item-0-value').text).toBe('');
  });

  it("draws a value's colour in place of its name", () => {
    menu.open({ layout: 'form', items: [{ label: 'Effects', value: 'red', swatch: [1, 0, 0] }] });
    screen.update();
    expect(find('menu-item-0-swatch')!.enabled).toBe(true);
    const color = element('menu-item-0-swatch').color;
    expect([color.r, color.g, color.b]).toEqual([1, 0, 0]);
    expect(element('menu-item-0-value').text).toBe('');
  });

  it("shows a field's cursor over its text while the menu's cursor is on it", () => {
    menu.open({ layout: 'form', items: [{ label: 'Name', value: 'Sarge', caret: 2 }, { label: 'B', value: 'on' }] });
    screen.update();
    expect(element('menu-item-0-value').text).toBe('Sarge');
    expect(find('menu-item-0-caret')!.enabled).toBe(true);
    menu.key(K.DOWNARROW);
    screen.update();
    expect(element('menu-item-0-value').text).toBe('Sarge');
    expect(find('menu-item-0-caret')!.enabled).toBe(false);
  });

  it('draws a value in its colours while the cursor is off it, and as typed while it is on it', () => {
    const colored: ColoredText[] = [{ text: 'Sar' }, { text: 'ge', color: [1, 0, 0] }];
    menu.open({
      layout: 'form',
      items: [
        { label: 'B', value: 'on' },
        { label: 'Name', value: 'Sar^1ge', caret: 7, colored }
      ]
    });
    screen.update();
    expect(element('menu-item-1-value').text).toBe('');
    const [sar, ge] = [0, 1].map((i) => element(`menu-item-1-run-${i}`));
    expect([sar.text, ge.text]).toEqual(['Sar', 'ge']);
    expect([ge.color.r, ge.color.g, ge.color.b]).toEqual([1, 0, 0]);
    // The first run is the value's own colour, white.
    expect([sar.color.r, sar.color.g, sar.color.b]).toEqual([1, 1, 1]);
    // Right to left from the value's right end, each run ending where the next begins.
    const x = (name: string) => find(name)!.getLocalPosition().x;
    expect(x('menu-item-1-run-1')).toBe(x('menu-item-1-value'));
    expect(x('menu-item-1-run-0')).toBe(x('menu-item-1-run-1') - ge.width);

    menu.key(K.DOWNARROW);
    screen.update();
    expect(element('menu-item-1-value').text).toBe('Sar^1ge');
    expect(find('menu-item-1-caret')!.enabled).toBe(true);
    expect([find('menu-item-1-run-0')!.enabled, find('menu-item-1-run-1')!.enabled]).toEqual([false, false]);
  });

  it("writes a confirm's warning under its answers", () => {
    menu.open({ items: [{ label: 'A' }] });
    menu.confirm('SET TO DEFAULTS?', () => {}, 'WARNING: This will reset *ALL* options.');
    screen.update();
    expect(find('menu-warning')!.enabled).toBe(true);
    expect(element('menu-warning').text).toBe('WARNING: This will reset *ALL* options.');
    expect(find('menu-warning')!.getLocalPosition().y).toBeLessThan(find('menu-item-0')!.getLocalPosition().y);
  });

  it("draws in a layer of its own, from a camera after the HUD's", () => {
    menu.open({ items: [{ label: 'A' }] });
    screen.update();
    const camera = find('menu-camera')!.camera!;
    expect(camera.priority).toBe(eye.camera!.priority + MENU_CAMERA_PRIORITY);
    expect(camera.layers).toEqual([app.scene.layers.getLayerByName('menu')!.id]);
    expect(element('menu-item-0').layers).toEqual(camera.layers);
  });

  it('takes its layer out of the scene when destroyed', () => {
    screen.destroy();
    expect(app.scene.layers.getLayerByName('menu')).toBeFalsy();
  });

  it("lays the Model page's cells four across, over the rest of its items", () => {
    const cells = Array.from({ length: 6 }, (_, i) => ({ label: `m${i}`, cell: true }));
    menu.open({ title: 'PLAYER MODEL', layout: 'grid', items: [...cells, { label: 'BACK' }] });
    screen.update();
    const at = (i: number) => find(`menu-item-${i}`)!.getLocalPosition();
    expect(at(1).y).toBe(at(0).y);
    expect(at(1).x - at(0).x).toBe(70);
    expect(at(2).x - at(1).x).toBe(70);
    expect([at(4).x, at(0).y - at(4).y]).toEqual([at(0).x, 70]);
    expect(at(6).y).toBeLessThan(at(4).y - 64);
    // A cell reads nothing: its icon says which model it is.
    expect(find('menu-item-0-text')).toBeNull();
    expect(element('menu-item-6-text').text).toBe('BACK');
  });

  it("draws a cell's icon in its middle, with the pick's line along its foot", () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    menu.open({ layout: 'grid', items: [{ label: 'sarge', cell: true, icon: 'icon_default', selected: true }] });
    screen.images = () => texture;
    screen.update();
    // Each stands on its anchor: the cell's middle, and the middle of its foot.
    expect([...find('menu-item-0-icon')!.getLocalPosition().toArray()]).toEqual([0, 0, 0]);
    expect([...find('menu-item-0-pick')!.getLocalPosition().toArray()]).toEqual([0, 0, 0]);
  });

  it("draws a cell's icon once it has loaded, and underlines the pick", () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    menu.open({
      layout: 'grid',
      items: [
        { label: 'sarge', cell: true, icon: 'models/players/sarge/icon_default', selected: true },
        { label: 'xaero', cell: true, icon: 'models/players/xaero/icon_default' }
      ]
    });
    screen.images = (name) => (name === 'models/players/sarge/icon_default' ? texture : null);
    screen.update();
    expect(find('menu-item-0-icon')!.enabled).toBe(true);
    expect(element('menu-item-0-icon').texture).toBe(texture);
    expect(find('menu-item-1-icon')!.enabled).toBe(false);
    expect([find('menu-item-0-pick')!.enabled, find('menu-item-1-pick')!.enabled]).toEqual([true, false]);
  });

  it('moves a page with a preview left, and says where the player stands right of it', () => {
    menu.open({ items: [{ label: 'A' }] });
    screen.update();
    expect(screen.previewView).toBeNull();
    expect(find('menu-panel')!.getLocalPosition().x).toBe(0);

    menu.push({ layout: 'form', preview: () => DEFAULT_LOOK, items: [{ label: 'Name', value: 'Sarge' }] });
    screen.update();
    expect(find('menu-panel')!.getLocalPosition().x).toBeLessThan(0);
    const view = screen.previewView!;
    expect([view.width, view.height, view.look]).toEqual([240, 400, DEFAULT_LOOK]);
    // On the 640×480 grid, scaled by the height about the screen's middle.
    const { width, height } = app.graphicsDevice;
    const [x, y, w, h] = view.rect;
    expect(h).toBeCloseTo(400 / 480);
    expect(w * width).toBeCloseTo((240 / 480) * height);
    expect(y).toBeCloseTo((1 - h) / 2);
    expect((x + w / 2) * width - width / 2).toBeCloseTo((150 / 480) * height);

    menu.pop();
    expect(screen.previewView).toBeNull();
    menu.pop();
    expect(screen.previewView).toBeNull();
  });

  it("writes a page's caption under its preview", () => {
    menu.open({ layout: 'grid', preview: () => DEFAULT_LOOK, caption: 'SARGE / DEFAULT', items: [{ label: 'BACK' }] });
    screen.update();
    expect(find('menu-caption')!.enabled).toBe(true);
    expect(element('menu-caption').text).toBe('SARGE / DEFAULT');
    expect(find('menu-caption')!.getLocalPosition().y).toBeLessThan(-200);
    menu.open({ items: [{ label: 'A' }] });
    screen.update();
    expect(find('menu-caption')!.enabled).toBe(false);
  });

  it('finds the pointer along a slider on a page moved aside for its preview, and on its number', () => {
    const canvas = app.graphicsDevice.canvas;
    Object.defineProperty(canvas, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 480, configurable: true });
    const pointers: (Pointer | undefined)[] = [];
    menu.open({
      layout: 'form',
      preview: () => DEFAULT_LOOK,
      items: [
        {
          label: 'Handicap',
          value: '100',
          slider: 0.5,
          key: (_key, pointer) => {
            pointers.push(pointer);
            return 'silent';
          }
        }
      ]
    });
    screen.update();
    // The bar's ends and the number's right edge: the screen's middle, the panel's move aside, then
    // along the row.
    const middle = 320 + find('menu-panel')!.getLocalPosition().x;
    const left = middle + find('menu-item-0-track')!.getLocalPosition().x;
    const right = left + element('menu-item-0-track').width;
    const number = middle + find('menu-item-0-value')!.getLocalPosition().x;
    for (const x of [left, right, number - 4]) {
      element('menu-item-0').fire('mousemove', { x });
      menu.key(K.MOUSE1);
    }
    expect(pointers).toEqual([
      { x: 0, number: false },
      { x: 1, number: false },
      { x: 1, number: true }
    ]);
  });
});

describe("MenuScreen in q3_ui's placement", () => {
  let app: AppBase;
  let menu: Menu;
  let screen: MenuScreen;

  beforeEach(() => {
    let eye: Entity;
    ({ app, camera: eye } = createTestApp());
    menu = new Menu();
    screen = new MenuScreen(app, eye, menu, { font: null });
  });

  afterEach(() => {
    screen.destroy();
    app.destroy();
  });

  const find = (name: string) => app.root.findByName(name) as Entity | null;
  const element = (name: string): ElementComponent => find(name)!.element!;
  /** Where an entity hung from the box stands, on q3_ui's screen from its top left. */
  const onBox = (name: string) => {
    const { x, y } = find(name)!.getLocalPosition();
    return [x, -y];
  };

  it("draws on q3_ui's box in place of the panel, and the panel again once opened centred", () => {
    const page: MenuPage = { id: 'setup', title: 'SETUP', items: [{ label: 'PLAYER' }] };
    menu.open(page, 'q3ui');
    screen.update();
    expect(find('menu-box')!.enabled).toBe(true);
    expect(find('menu-panel')!.enabled).toBe(false);
    expect(element('menu-box').width).toBe(640);
    expect(element('menu-banner').text).toBe('SETUP');
    expect(onBox('menu-banner')).toEqual([320, 34]);

    menu.open(page);
    screen.update();
    expect(find('menu-box')!.enabled).toBe(false);
    expect(find('menu-panel')!.enabled).toBe(true);
    expect(find('menu-item-0')!.parent!.name).toBe('menu-panel');
  });

  it("stands each item's bar where q3_ui puts it, BACK in its corner, and the panel where the frame is", () => {
    menu.open(
      {
        id: 'setup',
        title: 'SETUP',
        items: [{ label: 'PLAYER' }, { label: 'CONTROLS' }, { label: 'BACK', role: 'back' }]
      },
      'q3ui'
    );
    screen.update();
    // Each bar hangs by its middle: Setup's buttons are 28 high and 34 apart, centred down the
    // ring's 76 to 410, so these two run from 212 to 274.
    expect(onBox('menu-item-0')).toEqual([320, 212 + 14]);
    expect(onBox('menu-item-1')).toEqual([320, 246 + 14]);
    expect(element('menu-item-0-text').fontSize).toBe(17);
    expect(onBox('menu-item-2')).toEqual([64, 448]);
    expect([element('menu-item-2').width, element('menu-item-2').height]).toEqual([128, 28]);
    expect(onBox('menu-frame')).toEqual([0, 76]);
    expect([element('menu-frame').width, element('menu-frame').height]).toEqual([632, 334]);
  });

  it("lays a widget's row out as q3_ui does: the label ending short of its x, the value starting past it", () => {
    menu.open({ id: 'system.display', layout: 'form', items: [{ label: 'Brightness', value: 'On' }] }, 'q3ui');
    screen.update();
    // The row's bar hangs by its middle at x=400; its texts are put from there.
    expect(onBox('menu-item-0')).toEqual([400, 222 + 8]);
    const label = find('menu-item-0-text')!;
    const value = find('menu-item-0-value')!;
    expect(label.getLocalPosition().x).toBe(-8);
    expect(label.element!.pivot.x).toBe(1);
    expect(value.getLocalPosition().x).toBe(8);
    expect(value.element!.pivot.x).toBe(0);
    expect(value.element!.text).toBe('On');
  });

  it("runs a slider's bar 96 across from past the row's x, its thumb along it and its number after", () => {
    menu.open(
      { id: 'system.sound', layout: 'form', items: [{ label: 'Effects volume', value: '5', slider: 0.25 }] },
      'q3ui'
    );
    screen.update();
    const track = find('menu-item-0-track')!;
    expect(track.getLocalPosition().x).toBe(8);
    expect(track.element!.width).toBe(96);
    expect(find('menu-item-0-thumb')!.getLocalPosition().x).toBe(8 + 0.25 * 96);
    expect(find('menu-item-0-value')!.getLocalPosition().x).toBe(8 + 96 + 8);
  });

  it("finds the pointer along a slider's bar on q3_ui's screen, and on its number", () => {
    const canvas = app.graphicsDevice.canvas;
    Object.defineProperty(canvas, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 480, configurable: true });
    const pointers: (Pointer | undefined)[] = [];
    menu.open(
      {
        id: 'system.sound',
        layout: 'form',
        items: [
          {
            label: 'Effects volume',
            value: '5',
            slider: 0.5,
            key: (_key, pointer) => {
              pointers.push(pointer);
              return 'silent';
            }
          }
        ]
      },
      'q3ui'
    );
    screen.update();
    // At x=400 the bar runs from 408 to 504, and its number starts past its end.
    for (const x of [408, 504, 520]) {
      element('menu-item-0').fire('mousemove', { x });
      menu.key(K.MOUSE1);
    }
    expect(pointers).toEqual([
      { x: 0, number: false },
      { x: 1, number: false },
      { x: 1, number: true }
    ]);
  });

  it("puts a stacked row's value under its label, and its colours left to right from the value's start", () => {
    const runs: ColoredText[] = [{ text: 'Sa', color: [1, 0, 0] }, { text: 'rge' }];
    menu.open(
      {
        id: 'player',
        layout: 'form',
        items: [{ label: 'OTHER' }, { label: 'Name', value: 'Sarge', colored: runs }]
      },
      'q3ui'
    );
    screen.update();
    // The second row: its label at x=192 from its top at 225, its value at 256, 27 under it.
    const label = find('menu-item-1-text')!;
    const value = find('menu-item-1-value')!;
    const middle = onBox('menu-item-1');
    expect(middle[0] + label.getLocalPosition().x).toBe(192);
    expect(middle[0] + value.getLocalPosition().x).toBe(256);
    expect(label.getLocalPosition().y).toBeGreaterThan(value.getLocalPosition().y);
    const first = find('menu-item-1-run-0')!;
    const second = find('menu-item-1-run-1')!;
    // With no font a text has no width, so each run is given one, and the runs laid out again.
    for (const run of [first, second]) {
      run.element!.autoWidth = false;
      run.element!.width = 20;
    }
    screen.update();
    expect(first.getLocalPosition().x).toBe(value.getLocalPosition().x);
    expect(first.getLocalPosition().y).toBe(value.getLocalPosition().y);
    expect(first.element!.pivot.x).toBe(0);
    expect(second.getLocalPosition().x).toBe(value.getLocalPosition().x + 20);
  });

  it('reads an arrow in place of the label where q3_ui draws one', () => {
    menu.open({ id: 'model', layout: 'grid', items: [{ label: 'PREVIOUS PAGE', role: 'previous' }] }, 'q3ui');
    screen.update();
    expect(element('menu-item-0-text').text).toBe('<');
  });

  it('asks a confirm in the small ring, with its warning wrapped inside it', () => {
    menu.open({ id: 'setup', items: [{ label: 'DEFAULTS' }] }, 'q3ui');
    menu.confirm('SET TO DEFAULTS?', () => {}, 'WARNING: This will reset *ALL* options to their default values.');
    screen.update();
    expect(onBox('menu-frame')).toEqual([142, 118]);
    expect(element('menu-banner').text).toBe('SET TO DEFAULTS?');
    const warning = element('menu-box-warning');
    expect(find('menu-box-warning')!.enabled).toBe(true);
    expect(warning.wrapLines).toBe(true);
    expect(warning.width).toBeLessThan(359);
    // Its lines 27 apart, as Defaults steps its two, whatever size it was made at.
    expect([warning.fontSize, warning.lineHeight]).toEqual([18, 27]);
    // Its top line's top at y=300, however many lines it wraps to.
    expect(onBox('menu-box-warning')).toEqual([320, 300]);
    expect(warning.pivot.y).toBe(1);
  });

  it("draws the main menu with no frame, the game's name in the middle of the strip across the top", () => {
    menu.open({ id: 'main', title: 'playcanvas-quake3', items: [{ label: 'SETUP' }] }, 'q3ui');
    screen.update();
    expect(find('menu-frame')!.enabled).toBe(false);
    expect(element('menu-banner').text).toBe('playcanvas-quake3');
    expect(onBox('menu-banner')).toEqual([320, 60]);
    expect(find('menu-box-message')!.enabled).toBe(false);
  });

  it('writes an error under the strip, wrapped to 600 from its top at y=192, 20 a line', () => {
    const message = "Couldn't load maps/backyard.sog";
    menu.open({ id: 'error', title: 'playcanvas-quake3', message, items: [] }, 'q3ui');
    screen.update();
    const text = element('menu-box-message');
    expect(find('menu-box-message')!.enabled).toBe(true);
    expect(text.text).toBe(message);
    expect([text.wrapLines, text.width, text.lineHeight]).toEqual([true, 600, 20]);
    expect(onBox('menu-box-message')).toEqual([320, 192]);
    expect(text.pivot.y).toBe(1);

    // The main menu that follows it has none.
    menu.open({ id: 'main', title: 'playcanvas-quake3', items: [{ label: 'SETUP' }] }, 'q3ui');
    screen.update();
    expect(find('menu-box-message')!.enabled).toBe(false);
  });

  it('dims the game under the page, and hides what is under it with no game', () => {
    menu.open({ id: 'main', title: 'playcanvas-quake3', items: [{ label: 'SETUP' }] }, 'q3ui');
    screen.update();
    expect(element('menu-backdrop').opacity).toBeCloseTo(0.55);

    screen.opaque = true;
    screen.update();
    expect(element('menu-backdrop').opacity).toBe(1);

    screen.opaque = false;
    screen.update();
    expect(element('menu-backdrop').opacity).toBeCloseTo(0.55);
  });

  it("shows the status line of the item at the cursor on the box, and the page's caption where q3_ui names the pick", () => {
    const page: MenuPage = {
      id: 'model',
      layout: 'grid',
      preview: () => DEFAULT_LOOK,
      caption: 'SARGE / DEFAULT',
      items: [{ label: 'A', status: 'Pick one' }]
    };
    // Shown centred first, whose caption hangs from the screen rather than the panel.
    menu.open(page);
    screen.update();
    expect(find('menu-caption')!.enabled).toBe(true);
    menu.open(page, 'q3ui');
    screen.update();
    expect(element('menu-box-status').text).toBe('Pick one');
    expect(find('menu-status')!.enabled).toBe(false);
    expect(element('menu-box-caption').text).toBe('SARGE / DEFAULT');
    expect(onBox('menu-box-caption')[0]).toBe(497);
    expect(find('menu-caption')!.enabled).toBe(false);
  });

  it("draws Start Server's maps as a levelshot over a strip with its name, and the chosen map's name under the arrows", () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    const asked: string[] = [];
    screen.images = (name) => {
      asked.push(name);
      return name === 'levelshots/DM1' ? texture : null;
    };
    menu.open(
      {
        id: 'startserver',
        layout: 'grid',
        caption: 'DM1',
        items: [
          { label: 'Game type', value: 'Free For All' },
          { label: 'DM1', cell: true, icon: 'levelshots/DM1', selected: true },
          { label: 'DM2', cell: true, icon: 'levelshots/DM2' },
          { label: '', cell: true, hidden: true }
        ]
      },
      'q3ui'
    );
    screen.update();
    // The first map's box hangs by its middle, (188,84) and 128 across.
    expect(onBox('menu-item-1')).toEqual([252, 148]);
    const icon = find('menu-item-1-icon')!;
    expect(icon.enabled).toBe(true);
    expect(icon.element!.texture).toBe(texture);
    expect([icon.element!.width, icon.element!.height]).toEqual([128, 96]);
    // Its levelshot's middle at 84 + 48, and its strip's at 84 + 96 + 14, from the box's at 148.
    expect(icon.getLocalPosition().y).toBe(148 - 132);
    const strip = find('menu-item-1-strip')!;
    expect([strip.element!.width, strip.element!.height]).toEqual([128, 28]);
    expect(strip.getLocalPosition().y).toBe(148 - 194);
    const name = find('menu-item-1-text')!;
    expect(name.element!.text).toBe('DM1');
    expect(name.getLocalPosition().toArray().slice(0, 2)).toEqual([0, 148 - 192]);
    expect(find('menu-item-1-pick')!.enabled).toBe(true);
    expect(find('menu-item-2-pick')!.enabled).toBe(false);
    expect(find('menu-item-2-icon')!.enabled).toBe(false);
    expect(find('menu-item-3')!.enabled).toBe(false);
    // Only the maps shown are asked for.
    expect(asked).toEqual(['levelshots/DM1', 'levelshots/DM2']);
    expect(element('menu-box-caption').text).toBe('DM1');
    expect(onBox('menu-box-caption')).toEqual([320, 440 + 13.5]);
  });

  it("draws Server Options' map where q3_ui does, with its lines on the strip under it, once it has loaded", () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    let loaded = false;
    screen.images = (name) => (loaded && name === 'levelshots/DM1' ? texture : null);
    const page: MenuPage = {
      id: 'serveroptions',
      picture: { icon: 'levelshots/DM1', lines: ['DM1', 'Free For All'] },
      items: [
        { label: 'BACK', role: 'back' },
        { label: 'FIGHT', role: 'forward' }
      ]
    };
    menu.open(page, 'q3ui');
    screen.update();
    const image = find('menu-picture-image')!;
    expect(image.enabled).toBe(false);
    expect(onBox('menu-picture-image')).toEqual([352, 80]);
    expect([image.element!.width, image.element!.height]).toEqual([160, 120]);
    expect(onBox('menu-picture-strip')).toEqual([352, 200]);
    expect(element('menu-picture-line-0').text).toBe('DM1');
    expect(element('menu-picture-line-1').text).toBe('Free For All');
    expect(onBox('menu-picture-line-1')).toEqual([432, 228]);

    loaded = true;
    screen.update();
    expect(image.enabled).toBe(true);
    expect(image.element!.texture).toBe(texture);

    // A page with none takes it away.
    menu.open({ id: 'setup', items: [{ label: 'PLAYER' }] }, 'q3ui');
    screen.update();
    expect(find('menu-picture')).toBeNull();
    expect(find('menu-box-caption')!.enabled).toBe(false);
  });

  it("names Bot Select's portraits under them with no strip, in red where the page says, with no frame", () => {
    menu.open(
      {
        id: 'botselect',
        title: 'SELECT BOT',
        layout: 'grid',
        items: [
          { label: 'Anarki', cell: true, icon: 'models/players/anarki/icon_default' },
          { label: 'Sarge', cell: true, color: [1, 0, 0] }
        ]
      },
      'q3ui'
    );
    screen.update();
    expect(find('menu-frame')!.enabled).toBe(false);
    // The first portrait's box, (180,80) and 64 across, hangs by its middle.
    expect(onBox('menu-item-0')).toEqual([212, 112]);
    expect(find('menu-item-0-strip')).toBeNull();
    const name = find('menu-item-0-text')!;
    expect(name.element!.text).toBe('Anarki');
    // Its name's middle at (x+32, y+64+8).
    expect(name.getLocalPosition().toArray().slice(0, 2)).toEqual([0, 112 - 152]);
    expect(name.element!.fontSize).toBe(14);
    const rgb = ({ r, g, b }: { r: number; g: number; b: number }) => [r, g, b];
    expect(rgb(name.element!.color)).toEqual([1, 1, 1]);
    expect(rgb(element('menu-item-1-text').color)).toEqual([1, 0, 0]);
  });

  it("stands Server Options' slots by their names, the human's drawn as ever, and its status at (320,440)", () => {
    const page: MenuPage = {
      id: 'serveroptions',
      items: [
        { label: 'Bot skill', value: 'Bring It On', place: 'skill' },
        { label: '', value: 'Human', inactive: true, place: 'type 0' },
        { label: '', value: 'Sarge', place: 'name 1' },
        { label: 'Frag limit', value: '20', status: '0 = NO LIMIT' }
      ]
    };
    menu.open(page, 'q3ui');
    menu.hover(3);
    screen.update();
    // Bot skill's hit box runs from 40 to 248 at y=80; its value starts a character past x=128.
    expect(onBox('menu-item-0')).toEqual([144, 88]);
    expect(onBox('menu-item-0')[0] + find('menu-item-0-value')!.getLocalPosition().x).toBe(136);
    expect(element('menu-item-1-value').text).toBe('Human');
    expect(element('menu-item-1-value').opacity).toBeCloseTo(0.7);
    expect(onBox('menu-item-2')[0] + find('menu-item-2-value')!.getLocalPosition().x).toBe(104);
    expect(onBox('menu-item-3')).toEqual([456, 280]);
    expect(element('menu-box-status').text).toBe('0 = NO LIMIT');
    expect(onBox('menu-box-status')).toEqual([320, 448]);
    expect(element('menu-box-status').fontSize).toBe(14);
  });

  it("cuts q3_ui's preview box to the screen, and says which part of it shows", () => {
    const device = app.graphicsDevice;
    // A 4:3 screen, 640×480: the box at (400,−40), 320×560, runs 80 off the right and 40 off
    // the top and the bottom.
    Object.defineProperty(device, 'width', { value: 640, configurable: true });
    Object.defineProperty(device, 'height', { value: 480, configurable: true });
    menu.open(
      { id: 'player', layout: 'form', preview: () => DEFAULT_LOOK, items: [{ label: 'Name', value: 'x' }] },
      'q3ui'
    );
    const view = screen.previewView!;
    expect([view.width, view.height]).toEqual([320, 560]);
    expect(view.rect).toEqual([400 / 640, 0, 240 / 640, 1]);
    const [left, bottom, right, top] = view.window!;
    expect([left, right]).toEqual([0, 240 / 320]);
    expect(bottom).toBeCloseTo(40 / 560);
    expect(top).toBeCloseTo(520 / 560);

    // A wide screen, 16:9: the box is centred, so its right edge is on the screen.
    Object.defineProperty(device, 'width', { value: 1920, configurable: true });
    Object.defineProperty(device, 'height', { value: 1080, configurable: true });
    const wide = screen.previewView!;
    const unit = 1080 / 480;
    const boxLeft = (1920 - 640 * unit) / 2 + 400 * unit;
    expect(wide.rect[0]).toBeCloseTo(boxLeft / 1920);
    expect(wide.rect[2]).toBeCloseTo((320 * unit) / 1920);
    expect(wide.window![2]).toBeCloseTo(1);
  });
});

describe('boxOnScreen', () => {
  it("says which part of a box shows, from the box's bottom left, where it runs off one edge", () => {
    // A 640×480 box 100 above the top of a 4:3 screen: its bottom 380 show, its top 100 do not.
    const shown = boxOnScreen({ x: 0, y: -100, width: 640, height: 480 }, 640, 480)!;
    expect(shown.rect).toEqual([0, 100 / 480, 1, 380 / 480]);
    expect(shown.window).toEqual([0, 0, 1, 380 / 480]);
  });

  it('says nothing of a box wholly off the screen', () => {
    expect(boxOnScreen({ x: 700, y: 0, width: 100, height: 100 }, 640, 480)).toBeNull();
  });
});

describe("MenuScreen's fitted bars in q3_ui's placement", () => {
  let app: AppBase;
  let menu: Menu;
  let screen: MenuScreen;

  beforeEach(() => {
    let eye: Entity;
    ({ app, camera: eye } = createTestApp());
    menu = new Menu();
    screen = new MenuScreen(app, eye, menu, { font: squareFont(app, 0.75) });
  });

  afterEach(() => {
    screen.destroy();
    app.destroy();
  });

  const find = (name: string) => app.root.findByName(name) as Entity;
  /**
   * Where an entity stands on q3_ui's screen from its top left, through the bars it hangs from: up
   * to its panel's content, where the panel is not yet moved, or up to the screen itself.
   */
  const at = (name: string, moved: boolean): [number, number] => {
    let x = 0;
    let y = 0;
    for (
      let entity: Entity | null = find(name);
      entity && entity.name !== 'menu-box' && (moved || entity.name !== 'menu-content');
      entity = entity.parent as Entity
    ) {
      const local = entity.getLocalPosition();
      x += local.x;
      y -= local.y;
    }
    return [x, y];
  };
  const onBox = (name: string) => at(name, false);
  const onScreen = (name: string) => at(name, true);
  /** A bar's edges on q3_ui's screen: its left, its top, its right and its bottom. */
  const edges = (name: string, moved = false) => {
    const [x, y] = at(name, moved);
    const { width, height } = find(name).element!;
    return [x - width / 2, y - height / 2, x + width / 2, y + height / 2];
  };

  it("fits a tab's bar to its word, a character's width round it, the word still right-justified at q3_ui's x", () => {
    menu.open(
      {
        id: 'system.graphics',
        layout: 'form',
        items: [
          { label: 'GRAPHICS', tab: 'current' },
          { label: 'SOUND', tab: 'other' }
        ]
      },
      'q3ui'
    );
    screen.update();
    // GRAPHICS at 17 is 8 × 17 across, ending at 216, and its capitals 0.75 × 17 high about the
    // middle of the tab's 28 at 186.
    const text = find('menu-item-0-text');
    expect(text.element!.width).toBe(8 * 17);
    expect(onBox('menu-item-0-text')).toEqual([216, 200]);
    expect(text.element!.pivot.x).toBe(1);
    expect(edges('menu-item-0')).toEqual([216 - 136 - 8, 200 - 6.375 - 8, 216 + 8, 200 + 6.375 + 8]);
    // Each tab to its own word, a button's height under the last.
    expect(edges('menu-item-1')).toEqual([216 - 85 - 8, 228 - 6.375 - 8, 216 + 8, 228 + 6.375 + 8]);
    // Fitted, it stays fitted.
    screen.update();
    expect(onBox('menu-item-0-text')).toEqual([216, 200]);
    expect(edges('menu-item-0')).toEqual([72, 185.625, 224, 214.375]);
  });

  it("fits a Player row's bar to its label and the value under it, and refits it as the value changes", () => {
    const name = { label: 'Name', value: 'Sarge' };
    menu.open({ id: 'player', layout: 'form', items: [name] }, 'q3ui');
    screen.update();
    // Name at 18 from x=192 over its middle at 153; Sarge at 14 from 256 over its middle at 178.
    expect(onBox('menu-item-0-text')).toEqual([192, 153]);
    expect(onBox('menu-item-0-value')).toEqual([256, 178]);
    const top = 153 - 6.75 - 8;
    const bottom = 178 + 5.25 + 8;
    expect(edges('menu-item-0')).toEqual([184, top, 256 + 5 * 14 + 8, bottom]);
    name.value = 'Sarge the Great';
    screen.update();
    expect(edges('menu-item-0')).toEqual([184, top, 256 + 15 * 14 + 8, bottom]);
    expect(onBox('menu-item-0-value')).toEqual([256, 178]);
    // With no value, the label alone.
    name.value = '';
    screen.update();
    expect(edges('menu-item-0')).toEqual([184, top, 192 + 4 * 18 + 8, 153 + 6.75 + 8]);
  });

  it('fits a button to the widest label it reads, so it holds still as its label changes', () => {
    const button = { label: 'DELETE', labels: ['ADD TO FAVORITES', 'DELETE'] };
    menu.open({ id: 'setup', items: [button] }, 'q3ui');
    screen.update();
    // Setup's one button, centred down the ring about 243: ADD TO FAVORITES at 17 is 16 × 17.
    const fitted = [320 - 136 - 8, 243 - 6.375 - 8, 320 + 136 + 8, 243 + 6.375 + 8];
    expect(edges('menu-item-0')).toEqual(fitted);
    button.label = 'ADD TO FAVORITES';
    screen.update();
    expect(edges('menu-item-0')).toEqual(fitted);
  });

  it("fits a column's button to its word, centred where it was", () => {
    // Setup's one button, centred down the ring about 243: PLAYER at 17 is 6 × 17 across.
    menu.open({ id: 'setup', items: [{ label: 'PLAYER' }] }, 'q3ui');
    screen.update();
    expect(edges('menu-item-0')).toEqual([320 - 51 - 8, 243 - 6.375 - 8, 320 + 51 + 8, 243 + 6.375 + 8]);
    expect(onBox('menu-item-0-text')).toEqual([320, 243]);
  });

  it('fits a widget row to its label and widest value, 3 round, a plain value to itself', () => {
    const grapple = { label: 'Offhand grapple', value: 'off', values: ['off', 'CorkScrew'] };
    menu.open(
      { id: 'system.display', layout: 'form', items: [grapple, { label: 'Name', value: 'Sarge' }] },
      'q3ui'
    );
    screen.update();
    // Rows at x=400 from 222, 18 apart: each label ending at 392, and each value from 408, their
    // capitals 0.75 × 14 high about the row's middle.
    const across = (label: number, value: number) => [392 - label * 14 - 3, 408 + value * 14 + 3];
    const down = (middle: number) => [middle - 5.25 - 3, middle + 5.25 + 3];
    const box = (name: string) => {
      const [left, top, right, bottom] = edges(name);
      return [left, right, top, bottom];
    };
    expect(box('menu-item-0')).toEqual([...across(15, 9), ...down(230)]);
    expect(box('menu-item-1')).toEqual([...across(4, 5), ...down(248)]);
    // The row holds still as its value spins.
    grapple.value = 'CorkScrew';
    screen.update();
    expect(box('menu-item-0')).toEqual([...across(15, 9), ...down(230)]);
  });

  it('fits a field to the room its widthInChars keeps, however much of it its text fills', () => {
    const name = { label: 'Name', value: 'ab', widthInChars: 3 };
    const items = [{ label: 'X', value: 'x' }, name];
    menu.open({ id: 'system.display', layout: 'form', items }, 'q3ui');
    screen.update();
    // Its 3 cells of 8 and one for the cursor from 408, and 3 round; its label ending at 392.
    const across = () => [edges('menu-item-1')[0], edges('menu-item-1')[2]];
    expect(across()).toEqual([392 - 4 * 14 - 3, 408 + 32 + 3]);
    name.value = '';
    screen.update();
    expect(across()).toEqual([392 - 4 * 14 - 3, 408 + 32 + 3]);
    name.value = 'abcdef';
    screen.update();
    expect(across()).toEqual([392 - 4 * 14 - 3, 408 + 32 + 3]);
    // Square glyphs 14 across: two fit its 32.
    expect(find('menu-item-1-value').element!.text).toBe('ab');
  });

  it("cuts a field's colours to its room while the cursor is off it", () => {
    const colored: ColoredText[] = [{ text: 'Sar' }, { text: 'ge', color: [1, 0, 0] }];
    const name = { label: 'Name', value: 'Sar^1ge', widthInChars: 3, colored };
    const items = [{ label: 'X', value: 'x' }, name];
    menu.open({ id: 'system.display', layout: 'form', items }, 'q3ui');
    screen.update();
    // Its 32 holds two square glyphs 14 across: the first run's two, and none of the second's.
    expect(find('menu-item-1-run-0').element!.text).toBe('Sa');
    expect(app.root.findByName('menu-item-1-run-1')).toBeNull();
  });

  it("scrolls a field's text in its room to keep its cursor shown, the cursor over it", () => {
    const name = { label: 'Name', value: 'abcdef', caret: 6, widthInChars: 4 };
    const items = [name, { label: 'X', value: 'x' }];
    menu.open({ id: 'system.display', layout: 'form', items }, 'q3ui');
    const shown = () => {
      screen.update();
      return [find('menu-item-0-value').element!.text, onBox('menu-item-0-caret')[0]];
    };
    // Its 40 holds two square glyphs 14 across: the end's, with the cursor after them.
    expect(shown()).toEqual(['ef', 408 + 28]);
    // At the start, the text from its start.
    name.caret = 0;
    expect(shown()).toEqual(['ab', 408]);
    // On to the third: the text moved on only as far as keeps the cursor shown.
    name.caret = 3;
    expect(shown()).toEqual(['bc', 408 + 28]);
    // Back one: the text holds where it is.
    name.caret = 2;
    expect(shown()).toEqual(['bc', 408 + 14]);
    // A text shortened under it is drawn from where it still reaches its end.
    name.value = 'abc';
    name.caret = 3;
    expect(shown()).toEqual(['bc', 408 + 28]);
    name.value = 'ab';
    name.caret = 2;
    expect(shown()).toEqual(['ab', 408 + 28]);
    // The cursor off it: the text from its start, and no cursor.
    name.value = 'abcdef';
    menu.key(K.DOWNARROW);
    expect(shown()[0]).toBe('ab');
    expect(find('menu-item-0-caret').enabled).toBe(false);
  });

  /** The panel's edges on the screen: its left, its top, its right and its bottom. */
  const panel = () => {
    const [x, y] = onScreen('menu-frame');
    const { width, height } = find('menu-frame').element!;
    return [x, y, x + width, y + height];
  };

  it('fits the panel round what it holds, 14 all round and a status line at its foot, in the middle of its band', () => {
    menu.open(
      {
        id: 'setup',
        title: 'SETUP',
        items: [{ label: 'PLAYER', status: 'Your name and model' }, { label: 'BACK', role: 'back' }]
      },
      'q3ui'
    );
    screen.update();
    // PLAYER's bar runs 261 to 379 across and about 243 down, before the panel moves. The status
    // line, 19 × 14 across, is wider, and stands under it, 16 high.
    const panelTop = 228.625 - 14;
    const panelBottom = 257.375 + 16 + 14;
    // The band runs from under the banner at 49 to over BACK at 434: its middle is 241.5.
    const down = 241.5 - (panelTop + panelBottom) / 2;
    expect(panel()).toEqual([320 - 133 - 14, panelTop + down, 320 + 133 + 14, panelBottom + down]);
    expect(onScreen('menu-item-0')).toEqual([320, 243 + down]);
    expect(onScreen('menu-box-status')).toEqual([320, 257.375 + 8 + down]);
    expect(find('menu-box-status').element!.fontSize).toBe(14);
    // BACK stands in its corner, outside the panel, where it was.
    expect(onScreen('menu-item-1')).toEqual([64, 448]);
    screen.update();
    expect(panel()).toEqual([173, panelTop + down, 467, panelBottom + down]);
  });

  it("fits the panel round the page's own status line, as round an item's", () => {
    menu.open(
      {
        id: 'setup',
        title: 'SETUP',
        status: 'Your name and model',
        items: [{ label: 'PLAYER' }, { label: 'BACK', role: 'back' }]
      },
      'q3ui'
    );
    screen.update();
    // The status line, 19 × 14 across, is wider than PLAYER's bar from 261 to 379.
    const [left, , right] = panel();
    expect([left, right]).toEqual([320 - 133 - 14, 320 + 133 + 14]);
  });

  it("moves a page's panel and all it holds to the middle across, once, at its first frame", () => {
    const backend = { label: 'Backend', value: 'WebGPU', values: ['WebGPU', 'WebGL2'] };
    menu.open(
      {
        id: 'system.graphics',
        layout: 'form',
        items: [{ label: 'GRAPHICS', tab: 'current' }, backend, { label: 'BACK', role: 'back' }]
      },
      'q3ui'
    );
    screen.update();
    // GRAPHICS' bar runs from 72, and Backend's to 408 + 6 × 14 + 3: the panel from 58 to 509.
    const across = 320 - (58 + 509) / 2;
    expect(panel()[0]).toBe(58 + across);
    expect(panel()[2]).toBe(509 + across);
    expect(onScreen('menu-item-0-text')[0]).toBe(216 + across);
    // A wider value widens the panel, but moves nothing.
    backend.value = 'WebGPU, then WebGL2';
    screen.update();
    expect(onScreen('menu-item-0-text')[0]).toBe(216 + across);
    expect(panel()[0]).toBe(58 + across);
    expect(panel()[2]).toBe(408 + 19 * 14 + 3 + 14 + across);
  });

  it("holds the player's model in the panel, and moves the preview with it", () => {
    menu.open(
      {
        id: 'player',
        layout: 'form',
        preview: () => DEFAULT_LOOK,
        items: [
          { label: 'Name', value: 'Sarge' },
          { label: 'BACK', role: 'back' }
        ]
      },
      'q3ui'
    );
    screen.update();
    // From Name's bar at 184 to the model's box at 624 across, and the box's 82 to 404 down: its
    // panel from 170 to 638 and from 68 to 434, moved 84 left and 9.5 up to its band's middle.
    expect(panel()).toEqual([86, 58.5, 554, 424.5]);
    const { width, height } = app.graphicsDevice;
    const moved = boxOnScreen({ x: 400 - 84, y: -40 - 9.5, width: 320, height: 560 }, width, height)!;
    expect(screen.previewView!.rect).toEqual(moved.rect);
  });

  it("measures a confirm's question and warning by their capitals, and centres its panel down the screen", () => {
    menu.open({ id: 'setup', items: [{ label: 'DEFAULTS' }] }, 'q3ui');
    menu.confirm('SET TO DEFAULTS?', () => {}, 'Sure?');
    screen.update();
    // The question, 16 × 23 across, about 217.5, its capitals 0.75 × 23 high; the warning's one line
    // from 300, in a cell 18 high round capitals 13.5 high, and 343 across as it wraps.
    const top = 217.5 - 8.625 - 14;
    const bottom = 300 + 18 - 2.25 + 16 + 14;
    const down = 240 - (top + bottom) / 2;
    expect(panel()).toEqual([320 - 184 - 14, top + down, 320 + 184 + 14, bottom + down]);
  });

  it("keeps one panel for a tabbed page's sections, round all of them, which holds still as they switch", () => {
    const sections: MenuPage[] = [];
    const tabs = (shown: number) =>
      ['GRAPHICS', 'SOUND'].map((label, at) => ({ label, tab: at === shown ? ('current' as const) : ('other' as const) }));
    sections.push(
      {
        id: 'system.graphics',
        layout: 'form',
        sections,
        items: [...tabs(0), { label: 'Backend', value: 'WebGPU' }, { label: 'BACK', role: 'back' }]
      },
      {
        id: 'system.sound',
        layout: 'form',
        sections,
        items: [
          ...tabs(1),
          { label: 'Sound effects volume, in steps', value: '5', status: 'Turns the effects up or down, ten steps.' },
          { label: 'BACK', role: 'back' }
        ]
      }
    );
    menu.open(sections[0], 'q3ui');
    screen.update();
    const first = panel();
    const tab = onScreen('menu-item-0-text');
    // Graphics alone runs from its tab's bar at 72 to Backend's value's at 495. Sound's label, 30 × 14
    // across and ending at 392, reaches to -28, and its bar to -31. Its status, 40 × 14 across about
    // their middle at 232, reaches from -48 to 512: the panel from -62 to 526.
    expect(first[2] - first[0]).toBe(526 + 62);
    menu.open(sections[1], 'q3ui');
    screen.update();
    expect(panel()).toEqual(first);
    expect(onScreen('menu-item-0-text')).toEqual(tab);
  });

  it("finds the pointer along a slider's bar where its panel has moved it", () => {
    const canvas = app.graphicsDevice.canvas;
    Object.defineProperty(canvas, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 480, configurable: true });
    const pointers: (Pointer | undefined)[] = [];
    const key = (_key: number, pointer?: Pointer) => {
      pointers.push(pointer);
      return 'silent' as const;
    };
    menu.open(
      { id: 'system.sound', layout: 'form', items: [{ label: 'Effects volume', value: '5', slider: 0.5, key }] },
      'q3ui'
    );
    screen.update();
    // The row runs from its label at 196 to its number's end at 526, so the panel from 179 to 543,
    // and it moves 41 left: its bar from 408 - 41 to 504 - 41, and its number past it.
    for (const x of [367, 463, 479]) {
      find('menu-item-0').element!.fire('mousemove', { x });
      menu.key(K.MOUSE1);
    }
    expect(pointers).toEqual([
      { x: 0, number: false },
      { x: 1, number: false },
      { x: 1, number: true }
    ]);
  });

  /** Click an item of the page shown, by its label, and draw what that leads to. */
  const click = (label: string) => {
    const index = menu.page!.items.findIndex((each) => each.label === label);
    expect(index, label).toBeGreaterThanOrEqual(0);
    menu.hover(index, { x: 0.5 });
    menu.key(K.MOUSE1);
    screen.update();
  };
  /** An item's bar by its label. */
  const bar = (label: string) =>
    `menu-item-${menu.page!.items.findIndex((each) => each.label === label)}`;

  it("draws MULTIPLAYER second down the main menu's column, fitted to its word", () => {
    const opened = { open: vi.fn() };
    const main = mainPage(menu, { id: 'setup', items: [] }, opened, opened, { exit: vi.fn() });
    menu.open(main, 'q3ui');
    screen.update();
    // The column 34 apart from 134, so its middle at 182; its 11 glyphs at 17 are 187 across.
    expect(find(`${bar('MULTIPLAYER')}-text`).element!.text).toBe('MULTIPLAYER');
    const [left, top, right, bottom] = edges(bar('MULTIPLAYER'));
    expect([left, right]).toEqual([320 - 93.5 - 8, 320 + 93.5 + 8]);
    expect([top, bottom]).toEqual([182 - 6.375 - 8, 182 + 6.375 + 8]);
    // Clear of the buttons over and under it.
    expect(edges(bar('SINGLE PLAYER'))[3]).toBeLessThan(top);
    expect(edges(bar('SETUP'))[1]).toBeGreaterThan(bottom);
  });

  /** The server browser as MULTIPLAYER opens it, nothing listed, over a config of its own. */
  const browser = () => {
    const config = new GameConfig({ warn: () => {} });
    const servers = new ServerLists({ cvars: config.cvars, now: () => 0, print: () => {} });
    const opened = serversMenu({
      menu,
      config,
      actions: { command: vi.fn() },
      servers,
      status: { getServerStatus: vi.fn(() => null), probe: vi.fn(), probeOpen: vi.fn(() => false) },
      favorites: { add: vi.fn(() => 1), remove: vi.fn() },
      startServer: { open: vi.fn() },
      protocol: 71,
      now: () => 0
    });
    menu.open({ items: [] }, 'q3ui');
    opened.open();
    screen.update();
  };

  it("draws SPECIFY's fields at x=206, 30 apart from 220, at their rooms, in a panel", () => {
    browser();
    click('SPECIFY');
    // Each label ending at 198 and each value's room from 214, 3 round: q3_ui's 38 and 6 cells of
    // 8, the Name's 31, and one for the cursor, with nothing typed in the Address or the Name.
    const across = (label: string) => [edges(bar(label))[0], edges(bar(label))[2]];
    expect(across('Address')).toEqual([198 - 7 * 14 - 3, 214 + 39 * 8 + 3]);
    expect(across('Port')).toEqual([198 - 4 * 14 - 3, 214 + 7 * 8 + 3]);
    expect(across('Name')).toEqual([198 - 4 * 14 - 3, 214 + 32 * 8 + 3]);
    const middle = (label: string) => (edges(bar(label))[1] + edges(bar(label))[3]) / 2;
    expect(['Address', 'Port', 'Name'].map(middle)).toEqual([228, 258, 288]);
    // The panel holds the fields alone, 14 round the Address, with ADD TO FAVORITES at the foot.
    const [left, , right, bottom] = panel();
    expect(right - left).toBe(214 + 312 + 3 - (198 - 98 - 3) + 2 * 14);
    expect(edges(bar('ADD TO FAVORITES'), true)[1]).toBeGreaterThan(bottom);
  });

  /**
   * Server Options as CREATE opens it, the game type moved on `gametype` from Free For All, for a
   * player of the name given.
   */
  const serverOptions = (gametype: number, name = 'UnnamedPlayer') => {
    const config = new GameConfig({ warn: () => {} });
    config.cvars.set('name', name);
    const startServer = startServerPage({
      menu,
      config,
      arenas: ['\\type\\ffa team\\map\\dm1'],
      bots: () => [{ name: 'Sarge', model: 'sarge' }],
      presets: () => ['vq3'],
      actions: { command: vi.fn() }
    });
    menu.open({ id: 'arenaservers', items: [] }, 'q3ui');
    startServer.open(true);
    for (let n = 0; n < gametype; n++) menu.key(K.RIGHTARROW);
    click('NEXT');
  };

  it("draws Server Options' Listed and Hostname at x=456 under the limits, at their rooms", () => {
    serverOptions(0);
    // Rows 18 apart from 272: the two limits, then Listed and Hostname, each label ending at 448
    // and its value from 464.
    expect(onBox(`${bar('Listed')}-text`)).toEqual([448, 316]);
    expect(onBox(`${bar('Listed')}-value`)).toEqual([464, 316]);
    expect(onBox(`${bar('Hostname')}-text`)).toEqual([448, 334]);
    // q3_ui's 18 cells of 8 and one for the cursor, whatever the name.
    expect(edges(bar('Hostname'))[2]).toBe(464 + 19 * 8 + 3);
  });

  it("keeps a team game's multiplayer Server Options in its band, over BACK and FIGHT", () => {
    serverOptions(1);
    expect(menu.page!.items.some((each) => each.label === 'Friendly fire')).toBe(true);
    // Under the banner at 49 and over BACK and FIGHT at 434. Across, square glyphs run wider than
    // a face's, so the face's width is measured live.
    const [, top, , bottom] = panel();
    expect([top >= 49, bottom <= 434]).toEqual([true, true]);
  });

  it("cuts a wide name to its slot's room, clear of its side's column", () => {
    serverOptions(1, 'W'.repeat(15));
    const placed = (place: string) =>
      `menu-item-${menu.page!.items.findIndex((each) => each.place === place)}`;
    // 16 cells of 8 from a character past its x=96 hold nine glyphs 14 across.
    expect(find(`${placed('name 0')}-value`).element!.text).toBe('W'.repeat(9));
    expect(edges(placed('name 0'))[2]).toBe(104 + 128 + 3);
    expect(edges(placed('name 0'))[2]).toBeLessThan(edges(placed('team 0'))[0]);
  });
});

describe('MenuScreen: a settings page as wide as its rows', () => {
  let app: AppBase;
  let menu: Menu;
  let screen: MenuScreen;

  beforeEach(() => {
    let eye: Entity;
    ({ app, camera: eye } = createTestApp());
    menu = new Menu();
    screen = new MenuScreen(app, eye, menu, { font: squareFont(app, 0.75) });
  });

  afterEach(() => {
    screen.destroy();
    app.destroy();
  });

  const width = () => (app.root.findByName('menu-panel') as Entity).element!.width;

  it('keeps its own width, and grows round a row whose label and value would meet', () => {
    const page = (value: string) => ({
      layout: 'form' as const,
      items: [{ label: 'version:', value, inactive: true }, { label: 'BACK' }]
    });

    menu.open(page('1'));
    screen.update();
    expect(width()).toBe(440);
    // Square glyphs at 15: 8 and 20 of them, 12 between, 12 in from each end, 14 round the rows.
    menu.open(page('x'.repeat(20)));
    screen.update();
    expect(width()).toBe(28 * 15 + 12 + 2 * (12 + 14));
    // Never past the screen.
    menu.open(page('x'.repeat(60)));
    screen.update();
    expect(width()).toBe(640);
  });

  it("grows round a spin's widest value, not only the one it shows", () => {
    const values = ['WebGPU', 'WebGPU, then WebGL2'];
    const backend = { label: 'Backend', value: 'WebGPU', values };
    menu.open({ layout: 'form', items: [backend, { label: 'BACK' }] });
    screen.update();
    // Square glyphs at 15: 7 and 19 of them, 12 between, 12 in from each end, 14 round the rows.
    expect(width()).toBe(26 * 15 + 12 + 2 * (12 + 14));
  });

  it("keeps a field's room whatever it holds, its text cut to it", () => {
    const name = { label: 'Name', value: 'x'.repeat(40), widthInChars: 40 };
    menu.open({ layout: 'form', items: [name, { label: 'BACK' }] });
    screen.update();
    // Square glyphs at 15: 4 for the label, 12 between, the field's 41 cells of 8, 12 in from each
    // end, 14 round the rows; and 21 of its glyphs fit its 328.
    expect(width()).toBe(4 * 15 + 12 + 41 * 8 + 2 * (12 + 14));
    const value = (app.root.findByName('menu-item-0-value') as Entity).element!;
    expect(value.text).toBe('x'.repeat(21));
  });

  it("grows round every tab's rows, so its tabs share one width", () => {
    const sections: MenuPage[] = [];
    const tabs = (shown: number) =>
      ['GRAPHICS', 'SOUND'].map((label, at) => ({
        label,
        tab: at === shown ? ('current' as const) : ('other' as const)
      }));
    const backend = { label: 'Backend', value: 'WebGPU' };
    const volume = { label: 'Effects volume', value: 'x'.repeat(20) };
    sections.push(
      { layout: 'form', sections, items: [...tabs(0), backend, { label: 'BACK' }] },
      { layout: 'form', sections, items: [...tabs(1), volume, { label: 'BACK' }] }
    );
    menu.open(sections[0]);
    screen.update();
    // Sound's row, 14 and 20 glyphs at 15, widens Graphics too.
    expect(width()).toBe(34 * 15 + 12 + 2 * (12 + 14));
    menu.replace(sections[1]);
    screen.update();
    expect(width()).toBe(34 * 15 + 12 + 2 * (12 + 14));
  });
});

describe("MenuScreen's scrolled list in q3_ui's placement", () => {
  let app: AppBase;
  let menu: Menu;
  let screen: MenuScreen;

  beforeEach(() => {
    let eye: Entity;
    ({ app, camera: eye } = createTestApp());
    menu = new Menu();
    screen = new MenuScreen(app, eye, menu, { font: squareFont(app, 0.75) });
  });

  afterEach(() => {
    screen.destroy();
    app.destroy();
  });

  const find = (name: string) => app.root.findByName(name) as Entity | null;
  const element = (name: string): ElementComponent => find(name)!.element!;
  /** A cell of the list, the page's first item, by its row and column. */
  const cell = (row: number, column: number) => element(`menu-item-0-line-${row}-cell-${column}`);
  const GREEN: [number, number, number] = [0, 1, 0];
  /** A row, its numbers short enough for their columns in glyphs 14 across. */
  const row = (name: string, ping: string): ColoredText[] => [
    { text: name },
    { text: 'Q3DM17' },
    { text: '12' },
    { text: 'DM' },
    { text: ping, color: GREEN }
  ];

  /** The server browser as its placement stands it, over what its list shows. */
  const browser = (
    view: { rows: ColoredText[][]; selected: number },
    extra: Partial<MenuPage> = {}
  ) => {
    const pointers: (Pointer | undefined)[] = [];
    const page: MenuPage = {
      id: 'arenaservers',
      items: [
        {
          label: '',
          place: 'list',
          get list() {
            return view;
          },
          activate: () => {},
          key: (_key, pointer) => {
            pointers.push(pointer);
            return 'silent';
          }
        },
        { label: 'BACK', role: 'back' }
      ],
      ...extra
    };
    menu.open(page, 'q3ui');
    screen.update();
    return { page, pointers };
  };

  it('draws the rows in their columns, each cell cut to its width, the numbers run right', () => {
    browser({ rows: [row('A VERY LONG HOST NAME', '~400'), row('ARENA', '120')], selected: 0 });
    // Square glyphs 14 across: 160 of the host name's column holds 11 of them, and 56 of the
    // ping's four.
    expect(cell(0, 0).text).toBe('A VERY LONG');
    const rest = [1, 2, 3, 4].map((column) => cell(0, column).text);
    expect(rest).toEqual(['Q3DM17', '12', 'DM', '~400']);
    expect(cell(1, 0).text).toBe('ARENA');
    expect(cell(0, 2).pivot.x).toBe(1);
    expect(cell(0, 0).pivot.x).toBe(0);
    // A row past the list's end draws nothing.
    expect(find('menu-item-0-line-2-cell-0')!.enabled).toBe(false);
    // Each row 16 under the last.
    const y = (line: number) => find(`menu-item-0-line-${line}-cell-0`)!.getLocalPosition().y;
    expect(y(0) - y(1)).toBe(16);
  });

  it('lights the chosen row while the list has the cursor, and draws it in the accent', () => {
    browser({ rows: [row('ARENA', '40'), row('OFFICE', '60')], selected: 1 });
    expect(element('menu-item-0').opacity).toBe(0);
    expect(find('menu-item-0-line-1')!.enabled).toBe(true);
    expect(find('menu-item-0-line-0')!.enabled).toBe(false);
    expect(cell(1, 0).color.g).toBeLessThan(cell(0, 0).color.g);
    expect([cell(0, 0).opacity, cell(1, 0).opacity]).toEqual([0.7, 1]);
    // A cell of its own colour keeps it, the chosen row's too.
    expect([cell(1, 4).color.r, cell(1, 4).color.g]).toEqual([0, 1]);

    menu.select(1);
    screen.update();
    expect(find('menu-item-0-line-1')!.enabled).toBe(false);
    expect(cell(1, 0).color.g).toBeLessThan(1);
  });

  it('greys every row of a greyed list, and lights none', () => {
    const { page } = browser({ rows: [row('ARENA', '40')], selected: 0 });
    menu.open({ ...page, items: [{ ...page.items[0], grayed: true }, page.items[1]] }, 'q3ui');
    screen.update();
    expect(find('menu-item-0-line-0')!.enabled).toBe(false);
    expect(cell(0, 0).opacity).toBe(0.3);
  });

  it('tells the list where down it the pointer is, where its panel has moved it', () => {
    const canvas = app.graphicsDevice.canvas;
    Object.defineProperty(canvas, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 480, configurable: true });
    const { pointers } = browser({ rows: [row('ARENA', '40')], selected: 0 });
    // The list's bar on the screen, its panel moved: its middle, 176 high.
    let middle = 0;
    let entity = find('menu-item-0');
    for (; entity && entity.name !== 'menu-box'; entity = entity.parent as Entity) {
      middle -= entity.getLocalPosition().y;
    }
    for (const y of [middle, middle - 88 + 8]) {
      element('menu-item-0').fire('mousemove', { x: 320, y });
      menu.key(K.MOUSE1);
    }
    expect(pointers.map((pointer) => pointer?.y)).toEqual([0.5, 8 / 176]);
  });

  it("writes the page's own status line where the item at the cursor gives none", () => {
    browser({ rows: [], selected: -1 }, { status: 'Press SPACE to stop' });
    expect(element('menu-box-status').text).toBe('Press SPACE to stop');
    const items = [{ label: 'A', status: 'own' }];
    menu.open({ id: 'arenaservers', status: 'page', items }, 'q3ui');
    screen.update();
    expect(element('menu-box-status').text).toBe('own');
  });

  it('draws a picture with no strip under it, and nothing in its place while there is none', () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    screen.images = (name) => (name === 'levelshots/Q3DM17' ? texture : null);
    let shown: MenuPage['picture'];
    const { page } = browser({ rows: [row('ARENA', '40')], selected: 0 });
    menu.open(
      {
        id: page.id,
        items: page.items,
        get picture() {
          return shown;
        }
      },
      'q3ui'
    );
    screen.update();
    expect(find('menu-picture')).not.toBeNull();
    expect(find('menu-picture-strip')).toBeNull();
    expect(find('menu-picture-image')!.enabled).toBe(false);
    shown = { icon: 'levelshots/Q3DM17', lines: [] };
    screen.update();
    expect(find('menu-picture-image')!.enabled).toBe(true);
    shown = undefined;
    screen.update();
    expect(find('menu-picture-image')!.enabled).toBe(false);
  });

  it("keeps the list's arrows a button's margin clear of it, each fitted round its glyph", () => {
    const list = { label: '', place: 'list', list: { rows: [], selected: -1 } };
    const items = [list, { label: '▲', place: 'up' }, { label: '▼', place: 'down' }];
    menu.open({ id: 'arenaservers', items }, 'q3ui');
    screen.update();
    const span = (name: string) => {
      const { x } = find(name)!.getLocalPosition();
      const { width } = element(name);
      return [x - width / 2, x + width / 2];
    };
    for (const arrow of ['menu-item-1', 'menu-item-2']) {
      expect(span(arrow)[0] - span('menu-item-0')[1]).toBe(8);
      // A glyph 17 across, and 8 round it.
      expect(span(arrow)[1] - span(arrow)[0]).toBe(17 + 2 * 8);
    }
  });

  it("fits the panel round the list at q3_ui's place, and moves it to the middle across", () => {
    browser({ rows: [], selected: -1 });
    const frame = find('menu-frame')!;
    // From the list's left at 72 to its right at 526, and 14 round them, moved 21 right.
    expect(frame.element!.width).toBe(454 + 2 * 14);
    expect(frame.getLocalPosition().x).toBe(72 - 14 + 21);
  });
});

describe("MenuScreen's popups", () => {
  let app: AppBase;
  let menu: Menu;
  let screen: MenuScreen;

  beforeEach(() => {
    let eye: Entity;
    ({ app, camera: eye } = createTestApp());
    menu = new Menu();
    screen = new MenuScreen(app, eye, menu, { font: squareFont(app, 0.75) });
  });

  afterEach(() => {
    screen.destroy();
    app.destroy();
  });

  const find = (name: string) => app.root.findByName(name) as Entity | null;
  const element = (name: string): ElementComponent => find(name)!.element!;

  /** A board with nothing on it. */
  const board: Scoreboard = {
    fade: 1,
    rank: -1,
    lines: [],
    rows: [],
    foot: null,
    damageColumn: false,
    loadDeferred: false
  };

  /**
   * The Server Information box, over a page of two items in q3_ui's placement, showing what
   * `detail` gives.
   */
  const popup = (detail: () => PageDetail | null = () => null) => {
    menu.open(
      { id: 'setup', items: [{ label: 'PLAYER' }, { label: 'BACK', role: 'back' }] },
      'q3ui'
    );
    screen.update();
    const box: MenuPage = {
      id: 'serverinfo',
      title: 'Server Information',
      layout: 'popup',
      items: [
        { label: 'REFRESH', place: 'refresh', activate: () => {} },
        { label: 'CLOSE', place: 'close', activate: () => menu.pop() }
      ],
      cursor: 1,
      get detail() {
        return detail();
      }
    };
    menu.push(box);
    screen.update();
    return box;
  };

  it('draws a popup in its box over its page, which is drawn on under it with no cursor', () => {
    popup();
    expect(find('menu-popup-dim')!.enabled).toBe(true);
    const panel = find('menu-popup-panel')!;
    const { x, y } = panel.getLocalPosition();
    expect([x, -y, panel.element!.width, panel.element!.height]).toEqual([160, 16, 320, 448]);
    expect(element('menu-popup-title').text).toBe('Server Information');
    // The page under it drawn as ever, but with no cursor on any of its items.
    expect(element('menu-item-0-text').text).toBe('PLAYER');
    expect([0, 1].map((index) => element(`menu-item-${index}`).opacity)).toEqual([0, 0]);
    // The popup's own items, the cursor on CLOSE.
    expect(element('menu-popup-item-1-text').text).toBe('CLOSE');
    expect(element('menu-popup-item-1').opacity).toBeGreaterThan(0);
    expect(element('menu-popup-item-0').opacity).toBe(0);

    menu.pop();
    screen.update();
    expect(find('menu-popup-dim')!.enabled).toBe(false);
    expect(find('menu-popup-panel')).toBeNull();
    expect(element('menu-item-0').opacity).toBeGreaterThan(0);
  });

  it('takes the pointer from the page under a popup, and gives it to the popup', () => {
    popup();
    expect(element('menu-popup-dim').useInput).toBe(true);
    element('menu-item-0').fire('mouseenter', {});
    expect([menu.cursor, menu.mouseFocus]).toEqual([1, false]);
    element('menu-popup-item-0').fire('mouseenter', {});
    expect([menu.cursor, menu.mouseFocus]).toEqual([0, true]);
    element('menu-popup-item-0').fire('mouseleave', {});
    expect(menu.mouseFocus).toBe(false);
  });

  it("tables the popup's settings, each value cut at its padding", () => {
    let detail: PageDetail | null = {
      settings: [
        { label: 'Host', value: 'LIVE CHECK ARENA' },
        { label: 'Map', value: 'Q3DM17' }
      ],
      board: null
    };
    popup(() => detail);
    const place = (name: string) => {
      const { x, y } = find(name)!.getLocalPosition();
      return [x, -y, element(name).pivot.x];
    };
    // Each label ends a character short of 246 and each value starts one past it, 16 apart from
    // 73, as a widget's row stands.
    expect(place('menu-table-label-0')).toEqual([238, 73, 1]);
    expect(place('menu-table-value-0')).toEqual([254, 73, 0]);
    expect(place('menu-table-value-9')).toEqual([254, 217, 0]);
    expect(element('menu-table-label-0').text).toBe('Host');
    // Square glyphs 14 across: the 212 from 254 to the padding's edge holds fifteen.
    expect(element('menu-table-value-0').text).toBe('LIVE CHECK AREN');
    expect(element('menu-table-value-1').text).toBe('Q3DM17');
    expect(element('menu-table-label-2').text).toBe('');

    detail = null;
    screen.update();
    expect(element('menu-table-label-0').text).toBe('');
    expect(element('menu-table-value-0').text).toBe('');
  });

  it("gives the board's own screen the popup's board and its box, while it is up", () => {
    let detail: PageDetail | null = { settings: [], board };
    popup(() => detail);
    expect(screen.boardView).toEqual({ board, box: { x: 174, y: 233, width: 292, height: 181 } });

    detail = { settings: [], board: null };
    expect(screen.boardView).toBeNull();
    detail = { settings: [], board };
    menu.pop();
    expect(screen.boardView).toBeNull();
  });
});
