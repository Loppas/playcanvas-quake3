// @vitest-environment jsdom
import { type AppBase, type Entity } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import { GameConfig } from '../settings/game-config';
import { Menu } from '../view/menu';
import { inGamePage, setupPage, type MenuActions, type MenuContext } from '../view/menu-pages';
import { createTestApp } from './engine-test-fixtures';
import { MenuScreen } from './menu-screen';

/**
 * The in-game menu as it draws: every page a player can reach from it, and every confirm, laid
 * out and snapshotted entity by entity. It pins what the other tests leave free, the panel's
 * widths, the rows' pitch, the text's sizes and every absolute place, so that a second placement
 * can be added beside this one without this one moving.
 */

function actions(): MenuActions {
  return {
    resume: vi.fn(),
    restart: vi.fn(),
    vidRestart: vi.fn(),
    exportConfig: vi.fn(),
    importConfig: vi.fn(),
    exit: vi.fn(),
    addBot: vi.fn(),
    removeBot: vi.fn(),
    setTeam: vi.fn(),
    command: vi.fn(),
    addFavorite: vi.fn()
  };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

describe('the in-game menu on screen', () => {
  let app: AppBase;
  let menu: Menu;
  let screen: MenuScreen;
  /** Whether the match is this page's own server's, `sv_running`. */
  let running: boolean;

  beforeEach(() => {
    running = true;
    const test = createTestApp();
    app = test.app;
    menu = new Menu();
    screen = new MenuScreen(app, test.camera, menu, { font: null });
    const config = new GameConfig({ warn: () => {} });
    const done = actions();
    const models = () => [
      { model: 'sarge', skin: 'default' },
      { model: 'xaero', skin: 'blue' }
    ];
    const context: MenuContext = {
      menu,
      config,
      actions: done,
      models,
      bots: () => ['Anarki', 'Angel', 'Biker'],
      presets: () => ['vq3', 'cpm'],
      clientInfo: () => null,
      gametype: () => 0,
      maxClients: () => 8,
      serverinfo: () => '\\mapname\\garage_rats\\sv_hostname\\Arena',
      // A listen server's, whose host's items are live, unless a test makes it a remote server's.
      serverRunning: () => running
    };
    menu.open(inGamePage(context, setupPage(context)));
  });

  afterEach(() => {
    screen.destroy();
    app.destroy();
  });

  /**
   * Every entity the menu draws this frame, a line each, in the order the tree holds them: its
   * place, its size, its anchor and pivot, its colour and opacity, and a text's string and size.
   */
  function drawn(): string[] {
    screen.update();
    const out: string[] = [];
    const walk = (entity: Entity) => {
      if (!entity.enabled) return;
      // The engine's own children of an element are not the menu's.
      if (entity.name.startsWith('menu')) {
        const element = entity.element;
        const { x, y } = entity.getLocalPosition();
        let line = `${entity.name} @${round(x)},${round(y)}`;
        if (element) {
          const { anchor, pivot, color } = element;
          line +=
            ` ${round(element.width)}x${round(element.height)}` +
            ` a${anchor.x},${anchor.y},${anchor.z},${anchor.w} p${pivot.x},${pivot.y}` +
            ` rgb${round(color.r)},${round(color.g)},${round(color.b)} o${round(element.opacity)}`;
          if (element.type === 'text') line += ` f${element.fontSize} "${element.text}"`;
        }
        out.push(line);
      }
      for (const child of entity.children) walk(child as Entity);
    };
    walk(app.root.findByName('menu') as Entity);
    return out;
  }

  /** Point at an item by its label and click it. */
  function press(label: string): void {
    const index = menu.page!.items.findIndex((item) => item.label === label);
    expect(index, label).toBeGreaterThanOrEqual(0);
    menu.hover(index, { x: 0.5 });
    menu.key(K.MOUSE1);
  }

  /** Go through pages by their items' labels, and draw where that lands. */
  function at(...path: string[]): string[] {
    for (const label of path) press(label);
    return drawn();
  }

  it('draws the root page', () => {
    expect(drawn()).toMatchSnapshot();
  });

  it('draws the team page', () => {
    expect(at('START')).toMatchSnapshot();
  });

  it('draws the bot pages', () => {
    expect(at('ADD BOTS')).toMatchSnapshot();
    menu.key(K.ESCAPE);
    expect(at('REMOVE BOTS')).toMatchSnapshot();
  });

  it('draws Setup and each of its pages', () => {
    expect(at('SETUP')).toMatchSnapshot();
    expect(at('PLAYER')).toMatchSnapshot();
    expect(screen.previewView && { ...screen.previewView, look: undefined }).toMatchSnapshot();
    expect(at('MODEL')).toMatchSnapshot();
    expect(screen.previewView && { ...screen.previewView, look: undefined }).toMatchSnapshot();
    menu.key(K.ESCAPE);
    menu.key(K.ESCAPE);
    expect(at('CONTROLS')).toMatchSnapshot();
    expect(at('MOVE')).toMatchSnapshot();
    expect(at('SHOOT')).toMatchSnapshot();
    expect(at('MISC')).toMatchSnapshot();
    menu.key(K.ESCAPE);
    expect(at('SYSTEM')).toMatchSnapshot();
    expect(at('DISPLAY')).toMatchSnapshot();
    expect(at('SOUND')).toMatchSnapshot();
    expect(at('NETWORK')).toMatchSnapshot();
    menu.key(K.ESCAPE);
    expect(at('GAME OPTIONS')).toMatchSnapshot();
    menu.key(K.ESCAPE);
    expect(at('DEFAULTS')).toMatchSnapshot();
  });

  it('draws Server info, each value beside its key', () => {
    expect(at('SERVER INFO')).toMatchSnapshot();
  });

  it("draws a remote server's root page and Server info", () => {
    // The host's items greyed, and Server info's favourite live.
    running = false;
    expect(drawn()).toMatchSnapshot();
    expect(at('SERVER INFO')).toMatchSnapshot();
  });

  it('draws the server options and debug pages', () => {
    expect(at('SERVER OPTIONS')).toMatchSnapshot();
    menu.key(K.ESCAPE);
    expect(at('DEBUG')).toMatchSnapshot();
    expect(at('RESET DEBUG OPTIONS')).toMatchSnapshot();
  });

  it('draws the root page\'s confirms', () => {
    expect(at('RESTART ARENA')).toMatchSnapshot();
    press('NO');
    expect(at('EXIT GAME')).toMatchSnapshot();
  });
});
