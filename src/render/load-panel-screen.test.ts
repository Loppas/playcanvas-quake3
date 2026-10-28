// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBase, Entity } from 'playcanvas';

import { ConnectScreen, LoadScreen, LoadScreens } from '../load-screen';
import { CA } from '../net/connection';
import { createTestApp, squareFont } from './engine-test-fixtures';
import { barPieces, cutLine, LOAD_PANEL_CAMERA_PRIORITY, LoadPanelScreen } from './load-panel-screen';
import type { MenuFont } from './menu-font';
import { MENU_CAMERA_PRIORITY } from './menu-screen';
import { PREVIEW_CAMERA_PRIORITY } from './player-preview';
import { SCOREBOARD_CAMERA_PRIORITY } from './scoreboard-screen';

/** The load and connect screens on the null device: what each draws, and where. */

let app: AppBase;
let eye: Entity;
let screens: LoadScreens;
let panel: LoadPanelScreen;
let clock: number;

beforeEach(() => {
  ({ app, camera: eye } = createTestApp());
  screens = new LoadScreens();
  clock = 1000;
});

afterEach(() => {
  panel.destroy();
  app.destroy();
});

/** The panel on its own fonts: none, so each line keeps its string, or square glyphs. */
function drawn(font: MenuFont | null = null): LoadPanelScreen {
  panel = new LoadPanelScreen(app, screens, eye, { font, titleFont: font, now: () => clock });
  return panel;
}

const find = (name: string) => app.root.findByName(name) as Entity;
const text = (name: string) => find(name).element!.text;
const shown = (name: string) => find(name).enabled;
/** How far the fill reaches across, its pieces' widths summed. */
const filled = () =>
  ['left', 'middle', 'right'].reduce((sum, side) => {
    const piece = find(`load-fill-${side}`);
    return sum + (piece.enabled ? piece.element!.width : 0);
  }, 0);
const panelWidth = () => find('load-panel').element!.width;

describe('LoadPanelScreen', () => {
  it('draws nothing with no screen up, from a camera after the menu, the board and the preview', () => {
    drawn();
    app.render();
    expect([shown('load-panel-camera'), shown('load-panel-screen')]).toEqual([false, false]);
    expect(find('load-panel-camera').camera!.priority).toBe(eye.camera!.priority + LOAD_PANEL_CAMERA_PRIORITY);
    expect(LOAD_PANEL_CAMERA_PRIORITY).toBeGreaterThan(
      Math.max(MENU_CAMERA_PRIORITY, SCOREBOARD_CAMERA_PRIORITY, PREVIEW_CAMERA_PRIORITY)
    );
  });

  it("draws a load screen's lines, its bar filled to its fraction, and cgame's groups", () => {
    drawn();
    const loading = new LoadScreen(screens, 'q3dm17');
    loading.showServer('localhost');
    const data = loading.step('game data', 3);
    loading.step('sounds');
    data.advance(0.5, 'models/players/sarge/upper.md3 (12/40)');
    loading.showInformation({ server: ['Garage', ''], match: ['Free For All', 'fraglimit 20'] });
    app.render();

    expect([shown('load-panel-camera'), shown('load-panel-screen')]).toEqual([true, true]);
    expect(['load-title', 'load-server', 'load-line', 'load-detail'].map(text)).toEqual([
      'q3dm17',
      'Connecting to localhost',
      'Loading... game data',
      'models/players/sarge/upper.md3 (12/40)'
    ]);
    // An empty line is written as a space, so the engine keeps its row.
    expect([text('load-info-0'), text('load-info-1')]).toEqual(['Garage\n ', 'Free For All\nfraglimit 20']);
    expect([shown('load-track'), shown('load-fill')]).toEqual([true, true]);
    expect(filled()).toBeCloseTo(panelWidth() * 0.375, 5);
  });

  it("stands a connect in the same panel: no title, the bar's room empty, the print under it", () => {
    drawn();
    const connect = new ConnectScreen(screens, 'localhost:27960');
    connect.show({ state: CA.CHALLENGING, connectPacketCount: 2, serverMessage: 'Server is full\n' });
    app.render();

    expect(['load-title', 'load-server', 'load-line', 'load-detail'].map(text)).toEqual([
      '',
      'Connecting to localhost:27960',
      'Awaiting connection...2',
      ''
    ]);
    expect([shown('load-track'), shown('load-fill')]).toEqual([false, false]);
    expect([shown('load-info-0'), text('load-info-0'), shown('load-info-1')]).toEqual([true, 'Server is full', false]);
  });

  it('writes its lines only when the screen changes', () => {
    drawn();
    const connect = new ConnectScreen(screens, 'localhost');
    const challenging = { state: CA.CONNECTING, connectPacketCount: 1, serverMessage: '' };
    connect.show(challenging);
    app.render();
    // A line set by hand stays while the screen holds still, though the panel draws each frame.
    find('load-line').element!.text = 'held';
    connect.show({ ...challenging });
    app.render();
    expect(text('load-line')).toBe('held');
    connect.show({ ...challenging, connectPacketCount: 2 });
    app.render();
    expect(text('load-line')).toBe('Awaiting challenge...2');
  });

  it('eases its fill out to a new fraction over 0.15 s, and shows a new screen at once', () => {
    drawn();
    const loading = new LoadScreen(screens, 'q3dm17');
    const step = loading.step('game data');
    step.advance(0.2);
    app.render();
    expect(filled()).toBeCloseTo(panelWidth() * 0.2, 5);

    step.advance(0.6);
    app.render();
    expect(filled()).toBeCloseTo(panelWidth() * 0.2, 5);
    clock += 75;
    app.render();
    // Three quarters of the way at half the time, as it eases out.
    expect(filled()).toBeCloseTo(panelWidth() * 0.5, 5);
    clock += 75;
    app.render();
    expect(filled()).toBeCloseTo(panelWidth() * 0.6, 5);

    const next = new LoadScreen(screens, 'q3dm1');
    next.step('game data').advance(0.9);
    app.render();
    expect(filled()).toBeCloseTo(panelWidth() * 0.9, 5);
  });

  it('draws the top of the stack, and the one under it once that goes', () => {
    drawn();
    const connect = new ConnectScreen(screens, 'localhost');
    const loading = new LoadScreen(screens, 'q3dm17');
    app.render();
    expect(text('load-title')).toBe('q3dm17');
    loading.close();
    app.render();
    expect([text('load-title'), shown('load-track')]).toEqual(['', false]);
    connect.close();
    app.render();
    expect(shown('load-panel-screen')).toBe(false);
  });

  it('takes the pointer from everything under it', () => {
    drawn();
    expect(find('load-backdrop').element!.useInput).toBe(true);
  });

  it('stops drawing, and leaves the scene, once destroyed', () => {
    drawn();
    expect(app.scene.layers.getLayerByName('load-panel')).toBeTruthy();
    panel.destroy();
    expect(app.scene.layers.getLayerByName('load-panel')).toBeFalsy();
    new LoadScreen(screens, 'q3dm17');
    expect(() => app.render()).not.toThrow();
  });

  it('leaves the fonts it was given to whoever made them', () => {
    const font = squareFont(app, 0.7);
    const destroyed = vi.spyOn(font, 'destroy');
    drawn(font);
    panel.destroy();
    expect(destroyed).not.toHaveBeenCalled();
  });
});

describe('LoadPanelScreen: where things stand', () => {
  /** Each part of the panel's place and size, as laid out; a group's height grows at its foot. */
  const boxes = () =>
    ['load-panel', 'load-title', 'load-server', 'load-track', 'load-line', 'load-detail', 'load-info-0'].map((name) => {
      const entity = find(name);
      const { x, y } = entity.getLocalPosition();
      const { width, height } = entity.element!;
      return { name, x, y, width, height: name === 'load-info-0' ? null : height };
    });

  it('hands a connect over to the map it loads without moving anything', () => {
    drawn(squareFont(app, 0.7));
    const connect = new ConnectScreen(screens, 'localhost');
    connect.show({ state: CA.CONNECTED, connectPacketCount: 0, serverMessage: '' });
    app.render();
    const before = boxes();
    const loading = new LoadScreen(screens, 'q3dm17');
    loading.showServer('localhost');
    loading.showInformation({ server: [], match: ['Free For All'] });
    loading.step('game data');
    app.render();
    expect(boxes()).toEqual(before);
  });

  it("hangs cgame's groups under the panel, so more of them move nothing above", () => {
    drawn(squareFont(app, 0.7));
    const loading = new LoadScreen(screens, 'q3dm17');
    loading.showInformation({ server: [], match: ['Free For All'] });
    app.render();
    const above = boxes().slice(0, -1);
    const one = find('load-info-0').element!.height;

    loading.showInformation({ server: ['Garage', ''], match: ['Free For All', 'fraglimit 20'] });
    app.render();
    expect(boxes().slice(0, -1)).toEqual(above);
    const first = find('load-info-0');
    const second = find('load-info-1');
    // Each row a box 1.5 of its 15 high, the glyphs' 15-high cells in their middles; an empty row
    // keeps its box. The groups stand a gap apart.
    expect(one).toBe(15);
    expect(first.element!.height).toBe(15 + 22.5);
    const firstTop = -1.5 * (15 / 0.85);
    expect(first.getLocalPosition().y).toBeCloseTo(firstTop - (22.5 - 15) / 2, 5);
    expect(second.getLocalPosition().y).toBeCloseTo(firstTop - 2 * 22.5 - 0.75 * (15 / 0.85) - (22.5 - 15) / 2, 5);
  });

  it('cuts a long line at the panel’s edge, and wraps a long group within it', () => {
    drawn(squareFont(app, 0.7));
    const loading = new LoadScreen(screens, 'q3dm17');
    const path = 'models/players/sarge/'.repeat(4);
    loading.step('game data').advance(0.5, path);
    loading.showInformation({ server: [], match: ['word '.repeat(60)] });
    app.render();
    // Square glyphs 13 wide in a panel 494 wide: 38 of them, and the mark, which the square font lacks.
    expect(text('load-detail')).toBe(`${path.slice(0, 38)}…`);
    const group = find('load-info-0').element!;
    expect(group.height).toBeGreaterThan(15 * 1.5 * 2);
  });

  it('keeps the panel in the middle, held to a share of a narrow screen', () => {
    drawn(squareFont(app, 0.7));
    new LoadScreen(screens, 'q3dm17');
    app.render();
    const element = find('load-panel').element!;
    expect([element.anchor.x, element.anchor.y, element.pivot.x, element.pivot.y]).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(element.width).toBeCloseTo(28 * (15 / 0.85), 5);

    // A screen a third as wide as it is high is 160 across.
    app.graphicsDevice.canvas.width = 100;
    app.graphicsDevice.canvas.height = 300;
    app.render();
    expect(find('load-panel').element!.width).toBeCloseTo(160 * 0.8, 5);
    // Every line's box and cgame's wrap go with it.
    for (const name of ['load-title', 'load-server', 'load-line', 'load-detail', 'load-info-0']) {
      expect(find(name).element!.width).toBeCloseTo(160 * 0.8, 5);
    }
  });
});

describe('barPieces', () => {
  it('draws a whole bar as its two round ends round a straight middle', () => {
    expect(barPieces(100, 100, 3)).toEqual([
      { x: 0, width: 3, u0: 0, u1: 0.5 },
      { x: 3, width: 94, u0: 0.5, u1: 0.5 },
      { x: 97, width: 3, u0: 0.5, u1: 1 }
    ]);
  });

  it('cuts each piece where the fill stops, as a rounded box clips it', () => {
    expect(barPieces(100, 50, 3)).toEqual([
      { x: 0, width: 3, u0: 0, u1: 0.5 },
      { x: 3, width: 47, u0: 0.5, u1: 0.5 },
      { x: 97, width: 0, u0: 0.5, u1: 0.5 }
    ]);
    // Inside the left end, part of it; inside the right, part of that.
    expect(barPieces(100, 1.5, 3)[0]).toEqual({ x: 0, width: 1.5, u0: 0, u1: 0.25 });
    expect(barPieces(100, 98.5, 3)[2]).toEqual({ x: 97, width: 1.5, u0: 0.5, u1: 0.75 });
  });
});

describe('cutLine', () => {
  it('leaves a line that fits, and cuts one that does not to fit with its mark', () => {
    const { app: own } = createTestApp();
    const font = squareFont(own, 0.7);
    expect(cutLine(font, 'abcd', 40, 10)).toBe('abcd');
    expect(cutLine(font, 'abcdef', 40, 10)).toBe('abcd…');
    own.destroy();
  });
});
