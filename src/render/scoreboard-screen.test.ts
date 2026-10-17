// @vitest-environment jsdom
import { Texture, type AppBase, type ElementComponent, type Entity } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEAM } from '../sim/constants';
import { PW } from '../sim/items';
import type { Scoreboard, ScoreboardRow } from '../view/scoreboard';
import { MENU_CAMERA_PRIORITY } from './menu-screen';
import { createTestApp, squareFont } from './engine-test-fixtures';
import {
  FILL_LEFT,
  HEAD_X,
  MARKER_X,
  SCOREBOARD_CAMERA_PRIORITY,
  ScoreboardScreen
} from './scoreboard-screen';

/**
 * The board on the null device. jsdom has no canvas to draw a font on, so the text is drawn with
 * none, and each line still carries its string.
 */

/** One client's row, with everything unremarkable. */
function row(over: Partial<ScoreboardRow> = {}): ScoreboardRow {
  return {
    client: 0,
    team: TEAM.FREE,
    name: 'Sarge',
    head: { model: '', skin: '' },
    deferred: false,
    score: '9',
    ping: '55',
    time: '3',
    damage: '',
    spectator: false,
    connecting: false,
    you: false,
    ready: false,
    botSkill: 0,
    handicap: 100,
    powerups: 0,
    ...over
  };
}

/** A board with one row on it, the player first. */
function scoreboard(over: Partial<Scoreboard> = {}): Scoreboard {
  return {
    fade: 1,
    rank: 0,
    lines: [],
    rows: [row()],
    foot: null,
    damageColumn: false,
    loadDeferred: false,
    ...over
  };
}

describe('ScoreboardScreen', () => {
  let app: AppBase;
  let eye: Entity;
  let screen: ScoreboardScreen;

  beforeEach(() => {
    ({ app, camera: eye } = createTestApp());
    screen = new ScoreboardScreen(app, eye, { font: null });
  });

  afterEach(() => {
    screen.destroy();
    app.destroy();
  });

  const find = (name: string) => app.root.findByName(name) as Entity | null;
  const element = (name: string): ElementComponent => find(name)!.element!;
  /** An element's colour, red, green and blue. */
  const channels = (name: string): number[] => {
    const { r, g, b } = element(name).color;
    return [r, g, b];
  };

  it('draws nothing while the board is down', () => {
    screen.update(null);
    expect(find('scoreboard')!.enabled).toBe(false);
    expect(find('scoreboard-camera')!.enabled).toBe(false);
  });

  it('draws a board of every kind of element for the warm-up, through its own camera, then takes it down', () => {
    const icon = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    screen.images = () => icon;
    const warmed = screen.warm();
    warmed.at(0);

    expect(find('scoreboard')!.enabled).toBe(true);
    expect(find('scoreboard-camera')!.enabled).toBe(true);
    const shown = [
      'scoreboard-backdrop',
      'scoreboard-line-0',
      'scoreboard-line-0-run-1',
      'scoreboard-head-dmg',
      'scoreboard-band-0',
      'scoreboard-band-1',
      'scoreboard-row-0-bar',
      'scoreboard-row-0-head',
      'scoreboard-row-0-defer',
      'scoreboard-row-0-name-run-1',
      'scoreboard-row-0-marker-icon',
      'scoreboard-row-0-damage',
      'scoreboard-row-1-marker'
    ];
    expect(shown.filter((name) => !find(name)!.enabled)).toEqual([]);
    expect(element('scoreboard-row-0-bar').opacity).toBeGreaterThan(0);

    warmed.end();
    expect(find('scoreboard')!.enabled).toBe(false);
    expect(find('scoreboard-camera')!.enabled).toBe(false);
    icon.destroy();
  });

  it('draws after the HUD and the menu, whose panel a server\'s board stands in', () => {
    expect(find('scoreboard-camera')!.camera!.priority).toBe(
      eye.camera!.priority + SCOREBOARD_CAMERA_PRIORITY
    );
    expect(SCOREBOARD_CAMERA_PRIORITY).toBeGreaterThan(MENU_CAMERA_PRIORITY);
  });

  it("draws the lines, the column heads, and a row per client, the player's own lit", () => {
    screen.update(
      scoreboard({
        lines: ['Fragged by Visor', '1st place with 12'],
        rows: [
          row({ client: 1, name: 'Visor', score: '9', ping: '55', time: '3' }),
          row({ client: 0, name: 'Sarge', score: '12', ping: '60', time: '2', you: true })
        ]
      })
    );

    expect(find('scoreboard')!.enabled).toBe(true);
    expect(element('scoreboard-line-0').text).toBe('Fragged by Visor');
    expect(element('scoreboard-line-1').text).toBe('1st place with 12');
    expect(
      ['scoreboard-head-0', 'scoreboard-head-1', 'scoreboard-head-2', 'scoreboard-head-3'].map(
        (name) => element(name).text
      )
    ).toEqual(['SCORE', 'PING', 'TIME', 'NAME']);

    expect(element('scoreboard-row-0-name').text).toBe('Visor');
    expect(element('scoreboard-row-0-score').text).toBe('9');
    expect(element('scoreboard-row-0-ping').text).toBe('55');
    expect(element('scoreboard-row-0-time').text).toBe('3');
    expect(element('scoreboard-row-1-name').text).toBe('Sarge');
    // The player's own bar is lit, and the other's is not.
    expect(element('scoreboard-row-1-bar').opacity).toBeGreaterThan(0);
    expect(element('scoreboard-row-0-bar').opacity).toBe(0);
    // No third row, and no foot row.
    expect(find('scoreboard-row-2-name')!.enabled).toBe(false);
    expect(find('scoreboard-foot-name')!.enabled).toBe(false);
  });

  it("puts Clan Arena's Dmg column between the time and the name, and none elsewhere", () => {
    const x = (name: string): number => {
      const entity = find(name)!;
      const parent = entity.parent!;
      const bar = parent.name.endsWith('-bar') ? parent.getLocalPosition().x : 0;
      return entity.getLocalPosition().x + bar;
    };

    screen.update(scoreboard({ rows: [row({ damage: '640' })] }));
    expect(find('scoreboard-head-dmg')!.enabled).toBe(false);
    expect(find('scoreboard-row-0-damage')!.enabled).toBe(false);
    const name = x('scoreboard-row-0-name');
    const nameHead = x('scoreboard-head-3');

    screen.update(scoreboard({ rows: [row({ damage: '640' })], damageColumn: true }));
    expect(element('scoreboard-head-dmg').text).toBe('DMG');
    expect(find('scoreboard-head-dmg')!.enabled).toBe(true);
    expect(element('scoreboard-row-0-damage').text).toBe('640');
    expect(find('scoreboard-row-0-damage')!.enabled).toBe(true);
    expect(x('scoreboard-row-0-time')).toBeLessThan(x('scoreboard-row-0-damage'));
    expect(x('scoreboard-row-0-damage')).toBeLessThan(x('scoreboard-row-0-name'));
    expect(x('scoreboard-head-2')).toBeLessThan(x('scoreboard-head-dmg'));
    expect(x('scoreboard-head-dmg')).toBeLessThan(x('scoreboard-head-3'));
    // The name moves along for it, head and all.
    expect(x('scoreboard-row-0-name')).toBeGreaterThan(name);
    expect(x('scoreboard-head-3') - x('scoreboard-row-0-name')).toBeCloseTo(nameHead - name);
  });

  it("lays a row out in Q3's order, the numbers right-aligned to their fields", () => {
    screen.update(scoreboard({ rows: [row({ name: 'Visor', score: '9', ping: '55', time: '3' })] }));

    // Where an element sits on the panel: a row's cells hang from their bar, which is offset by
    // the fill's own place.
    const x = (name: string): number => {
      const entity = find(name)!;
      const parent = entity.parent!;
      const bar = parent.name.endsWith('-bar') ? parent.getLocalPosition().x : 0;
      return entity.getLocalPosition().x + bar;
    };
    // The marker leads, then the head's column, then the score, ping and time, and the name last.
    expect(x('scoreboard-row-0-marker')).toBeLessThan(x('scoreboard-row-0-head'));
    expect(x('scoreboard-row-0-head')).toBeLessThan(x('scoreboard-row-0-score'));
    expect(x('scoreboard-row-0-score')).toBeLessThan(x('scoreboard-row-0-ping'));
    expect(x('scoreboard-row-0-ping')).toBeLessThan(x('scoreboard-row-0-time'));
    expect(x('scoreboard-row-0-time')).toBeLessThan(x('scoreboard-row-0-name'));

    // Q3 centres a row on its rating width — the bot's icon at 80 and the head at 112, with the
    // score line from 160 (`cg_scoreboard.c:94–95`) — so the marker leads the score line by 70 and
    // the head's left edge by 42, scaled to the panel.
    expect(FILL_LEFT - MARKER_X).toBeCloseTo(70);
    const head = element('scoreboard-row-0-head');
    expect(FILL_LEFT - (x('scoreboard-row-0-head') - head.width / 2)).toBeCloseTo(42);

    // A right-aligned cell's own x is its right edge, which its column head shares.
    const heads = ['scoreboard-head-0', 'scoreboard-head-1', 'scoreboard-head-2'];
    ['score', 'ping', 'time'].forEach((cell, i) => {
      expect(element(`scoreboard-row-0-${cell}`).pivot.x, cell).toBe(1);
      expect(element(heads[i]).pivot.x, heads[i]).toBe(1);
      expect(x(heads[i]), heads[i]).toBeCloseTo(x(`scoreboard-row-0-${cell}`));
    });
    // The name runs right from its own column, as its head does.
    expect(element('scoreboard-row-0-name').pivot.x).toBe(0);
    expect(x('scoreboard-head-3')).toBeCloseTo(x('scoreboard-row-0-name'));
  });

  it("draws a row's head from its model and skin, as the menu draws its icons", () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    const asked: string[] = [];
    screen.images = (name) => {
      asked.push(name);
      return name === 'models/players/sarge/icon_default' ? texture : null;
    };
    screen.update(
      scoreboard({
        rows: [
          row({ head: { model: 'sarge', skin: 'default' } }),
          row({ head: { model: 'xaero', skin: 'red' } }),
          row()
        ]
      })
    );

    expect(find('scoreboard-row-0-head')!.enabled).toBe(true);
    expect(element('scoreboard-row-0-head').texture).toBe(texture);
    // A model the install has no icon for draws none, and a row with no client asks for none.
    expect(find('scoreboard-row-1-head')!.enabled).toBe(false);
    expect(find('scoreboard-row-2-head')!.enabled).toBe(false);
    expect(asked).not.toContain('models/players//icon_');
  });

  it('takes a head off a row the next board does not draw', () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    screen.images = () => texture;
    const look = { model: 'sarge', skin: 'default' };

    screen.update(scoreboard({ rows: [row({ head: look }), row({ head: look })] }));
    expect(find('scoreboard-row-1-head')!.enabled).toBe(true);

    // The row is off the screen, so its head is not drawn: `enabled` reads the hierarchy, and the
    // bar it hangs from is what `hide` turns off.
    screen.update(scoreboard({ rows: [row({ head: look })] }));
    expect(find('scoreboard-row-1-head')!.enabled).toBe(false);
  });

  it('draws a head on the head column, square and on the row\'s middle', () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    screen.images = () => texture;
    screen.update(
      scoreboard({
        rows: [row({ head: { model: 'sarge', skin: 'default' } })],
        foot: row({ you: true, head: { model: 'sarge', skin: 'default' } })
      })
    );

    const head = find('scoreboard-row-0-head')!;
    const bar = find('scoreboard-row-0-bar')!;
    expect(head.getLocalPosition().x + bar.getLocalPosition().x).toBeCloseTo(HEAD_X);
    expect(head.getLocalPosition().y).toBeCloseTo(-element('scoreboard-row-0-bar').height / 2);
    expect(element('scoreboard-row-0-head').width).toBe(element('scoreboard-row-0-head').height);
    // The foot row's own head is drawn too, at the foot's bar.
    expect(find('scoreboard-foot-head')!.enabled).toBe(true);
  });

  it("crosses out the head of a client drawn in another's look, over it and its size", () => {
    const portrait = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    const cross = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    screen.images = (name) => (name === 'gfx/2d/defer' ? cross : portrait);
    const head = { model: 'sarge', skin: 'default' };
    screen.update(scoreboard({ rows: [row({ head, deferred: true }), row({ head })] }));

    expect(find('scoreboard-row-0-defer')!.enabled).toBe(true);
    expect(element('scoreboard-row-0-defer').texture).toBe(cross);
    const [crossed, under] = ['defer', 'head'].map((part) =>
      element(`scoreboard-row-0-${part}`).screenCorners.map(({ x, y }) => [x, y])
    );
    crossed.flat().forEach((at, i) => expect(at).toBeCloseTo(under.flat()[i], 6));
    expect(element('scoreboard-row-0-defer').width).toBe(element('scoreboard-row-0-head').width);
    expect(find('scoreboard-row-1-defer')!.enabled).toBe(false);

    // No portrait, no cross: it hangs from the portrait.
    screen.images = (name) => (name === 'gfx/2d/defer' ? cross : null);
    screen.update(scoreboard({ rows: [row({ head, deferred: true })] }));
    expect(find('scoreboard-row-0-defer')!.enabled).toBe(false);
  });

  it("fills the own row in Q3's rank colour, from the score column to the panel's right", () => {
    const fills: readonly (readonly [number, readonly number[]])[] = [
      [0, [0, 0, 0.7]],
      [1, [0.7, 0, 0]],
      [2, [0.7, 0.7, 0]],
      [3, [0.7, 0.7, 0.7]],
      [-1, [0.7, 0.7, 0.7]]
    ];
    for (const [rank, fill] of fills) {
      screen.update(scoreboard({ rank, rows: [row({ you: true })] }));
      expect(channels('scoreboard-row-0-bar'), `rank ${rank}`).toEqual(fill);
      expect(element('scoreboard-row-0-bar').opacity).toBeCloseTo(0.7);
    }

    // Only the own row is filled, and the fill starts at the score column, not the panel's edge.
    screen.update(scoreboard({ rank: 0, rows: [row({ you: true }), row()] }));
    expect(element('scoreboard-row-1-bar').opacity).toBe(0);
    const bar = find('scoreboard-row-0-bar')!;
    expect(bar.getLocalPosition().x - element('scoreboard-row-0-bar').width / 2).toBeCloseTo(FILL_LEFT);
  });

  it("centres each row's text in its bar, where the highlight is", () => {
    screen.update(scoreboard({ lines: ['Fragged by Visor'], rows: [row({ you: true })] }));

    // A bar hangs from its top edge by a whole row, so a cell on its middle is half a row down.
    const half = element('scoreboard-row-0-bar').height / 2;
    for (const cell of ['score', 'ping', 'time', 'marker', 'name']) {
      expect(find(`scoreboard-row-0-${cell}`)!.getLocalPosition().y, cell).toBeCloseTo(-half);
    }
  });

  it("draws a name and the lines in their colour codes, as Q3's colours do", () => {
    screen.update(
      scoreboard({
        lines: ['Fragged by ^2Visor^7'],
        rows: [row({ name: '^1Sar^7ge' }), row({ name: 'Visor' })],
        foot: row({ name: '^3Sarge', you: true })
      })
    );

    // A name with codes is split into runs, the first on the slot itself.
    expect(element('scoreboard-row-0-name').text).toBe('Sar');
    expect(channels('scoreboard-row-0-name')).toEqual([1, 0, 0]);
    expect(element('scoreboard-row-0-name-run-1').text).toBe('ge');
    expect(channels('scoreboard-row-0-name-run-1')).toEqual([1, 1, 1]);

    // A name without codes is the slot's alone, and no run is made for it.
    expect(element('scoreboard-row-1-name').text).toBe('Visor');
    expect(find('scoreboard-row-1-name-run-1')).toBeNull();

    // The lines above the board carry their colours too, the killer's name among them.
    expect(element('scoreboard-line-0').text).toBe('Fragged by ');
    expect(element('scoreboard-line-0-run-1').text).toBe('Visor');
    expect(channels('scoreboard-line-0-run-1')).toEqual([0, 1, 0]);
    expect(element('scoreboard-foot-name').text).toBe('Sarge');
    expect(channels('scoreboard-foot-name')).toEqual([1, 1, 0]);
  });

  it('takes a run off a slot when the next board has fewer', () => {
    screen.update(scoreboard({ rows: [row({ name: '^1Sar^7ge' })] }));
    expect(find('scoreboard-row-0-name-run-1')!.enabled).toBe(true);

    screen.update(scoreboard({ rows: [row({ name: 'Visor' })] }));
    expect(find('scoreboard-row-0-name-run-1')!.enabled).toBe(false);
  });

  it('takes a line and its runs off the board when the next board has fewer lines', () => {
    screen.update(scoreboard({ lines: ['Fragged by ^2Visor^7', '^41st^7 place with 12'] }));
    expect(find('scoreboard-line-1-run-1')!.enabled).toBe(true);

    screen.update(scoreboard({ lines: ['1st place with 12'] }));
    expect(find('scoreboard-line-1')!.enabled).toBe(false);
    expect(find('scoreboard-line-1-run-1')!.enabled).toBe(false);
    expect(find('scoreboard-line-0-run-1')!.enabled).toBe(false);
  });

  it("draws the player's own row at the foot when the list was cut short", () => {
    screen.update(scoreboard({ rows: [row({ name: 'Visor' })], foot: row({ name: 'Sarge', you: true }) }));

    expect(element('scoreboard-foot-name').text).toBe('Sarge');
    expect(find('scoreboard-foot-name')!.enabled).toBe(true);
    expect(element('scoreboard-foot-bar').opacity).toBeGreaterThan(0);
  });

  it('draws READY in the marker column at the intermission, and the handicap otherwise', () => {
    const art = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    screen.images = () => art;
    screen.update(
      scoreboard({
        rows: [row({ ready: true, botSkill: 2 }), row({ handicap: 70 })]
      })
    );

    expect(element('scoreboard-row-0-marker').text).toBe('READY');
    // READY stands in the marker's place, as it does for the skill's number.
    expect(find('scoreboard-row-0-marker-icon')!.enabled).toBe(false);
    expect(element('scoreboard-row-1-marker').text).toBe('70');
  });

  it("draws a bot's skill as Q3's own art, and the handicap only for a player", () => {
    const textures = new Map<string, Texture>();
    const asked: string[] = [];
    screen.images = (name) => {
      asked.push(name);
      const art = new Texture(app.graphicsDevice, { width: 1, height: 1 });
      textures.set(name, art);
      return art;
    };
    screen.update(
      scoreboard({
        rows: [
          // A bot's handicap is its skill's (`G_AddBot`, g_bot.c:670–678), and Q3 draws the art.
          row({ name: 'Grunt', botSkill: 4 }),
          row({ name: 'Sarge', handicap: 70 }),
          row({ name: 'Visor', botSkill: 6, handicap: 100 })
        ]
      })
    );

    // Q3 registers the art as `menu/art/skill1`–`skill5` (`cg_main.c:836–840`).
    expect(asked).toEqual(['menu/art/skill4']);
    expect(find('scoreboard-row-0-marker-icon')!.enabled).toBe(true);
    expect(element('scoreboard-row-0-marker-icon').texture).toBe(textures.get('menu/art/skill4'));
    // A bot's marker is the art alone: Q3 draws no number beside it.
    expect(find('scoreboard-row-0-marker')!.enabled).toBe(false);

    // A player below 100 keeps the handicap number, and no art.
    expect(element('scoreboard-row-1-marker').text).toBe('70');
    expect(find('scoreboard-row-1-marker-icon')!.enabled).toBe(false);

    // Past Q3's five, a skill is no bot marker either, and nothing is drawn.
    expect(find('scoreboard-row-2-marker')!.enabled).toBe(false);
    expect(find('scoreboard-row-2-marker-icon')!.enabled).toBe(false);
  });

  it("draws a carrier's flag in the marker column, ahead of the skill and the handicap", () => {
    const textures = new Map<string, Texture>();
    const asked: string[] = [];
    screen.images = (name) => {
      asked.push(name);
      const art = new Texture(app.graphicsDevice, { width: 1, height: 1 });
      textures.set(name, art);
      return art;
    };
    screen.update(
      scoreboard({
        rows: [
          row({ name: 'Sarge', powerups: 1 << PW.REDFLAG, botSkill: 4 }),
          row({ name: 'Grunt', powerups: 1 << PW.BLUEFLAG, handicap: 70 })
        ]
      })
    );

    // The flag item's own icon (`bg_misc.c`), which is what `CG_DrawFlagModel` falls back to.
    expect(asked).toEqual(['icons/iconf_red1', 'icons/iconf_blu1']);
    expect(element('scoreboard-row-0-marker-icon').texture).toBe(textures.get('icons/iconf_red1'));
    expect(element('scoreboard-row-1-marker-icon').texture).toBe(textures.get('icons/iconf_blu1'));
    // "Unless player has flag": neither the skill art nor the handicap number is drawn.
    expect(find('scoreboard-row-0-marker')!.enabled).toBe(false);
    expect(find('scoreboard-row-1-marker')!.enabled).toBe(false);
  });

  it('lets READY stand over a carried flag, as it does over a skill', () => {
    const art = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    screen.images = () => art;
    screen.update(scoreboard({ rows: [row({ ready: true, powerups: 1 << PW.REDFLAG })] }));

    expect(element('scoreboard-row-0-marker').text).toBe('READY');
    expect(find('scoreboard-row-0-marker-icon')!.enabled).toBe(false);
  });

  it('draws no flag for a powerup that is not one', () => {
    const asked: string[] = [];
    screen.images = (name) => {
      asked.push(name);
      return new Texture(app.graphicsDevice, { width: 1, height: 1 });
    };
    screen.update(scoreboard({ rows: [row({ powerups: 1 << PW.QUAD, handicap: 70 })] }));

    expect(asked).toEqual([]);
    expect(element('scoreboard-row-0-marker').text).toBe('70');
  });

  it("stands the skill art on the marker column, the head's own size", () => {
    const art = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    screen.images = () => art;
    screen.update(scoreboard({ rows: [row({ botSkill: 3 })] }));

    const icon = find('scoreboard-row-0-marker-icon')!;
    const bar = find('scoreboard-row-0-bar')!;
    // Q3 draws it from the marker column's own place (`iconx`), the head's size, on the row's
    // middle.
    expect(icon.getLocalPosition().x + bar.getLocalPosition().x).toBeCloseTo(
      MARKER_X + element('scoreboard-row-0-marker-icon').width / 2
    );
    expect(element('scoreboard-row-0-marker-icon').width).toBe(element('scoreboard-row-0-head').width);
    expect(element('scoreboard-row-0-marker-icon').height).toBe(element('scoreboard-row-0-marker-icon').width);
    expect(icon.getLocalPosition().y).toBeCloseTo(-element('scoreboard-row-0-bar').height / 2);
  });

  /** A team game's board: two a side, then a spectator, in the order the view puts them. */
  const teamBoard = () =>
    scoreboard({
      rows: [
        row({ client: 0, team: TEAM.RED }),
        row({ client: 1, team: TEAM.RED }),
        row({ client: 2, team: TEAM.BLUE }),
        row({ client: 3, team: TEAM.SPECTATOR })
      ]
    });

  /** How far below the panel's top a row's bar hangs. */
  const rowTop = (i: number) => -find(`scoreboard-row-${i}-bar`)!.getLocalPosition().y;

  it('leaves a gap where one team block ends and the next begins', () => {
    screen.update(teamBoard());

    const height = element('scoreboard-row-0-bar').height;
    // Inside a block the rows follow one another; between two blocks there is more than a row.
    expect(rowTop(1) - rowTop(0)).toBeCloseTo(height);
    expect(rowTop(2) - rowTop(1)).toBeGreaterThan(height);
    expect(rowTop(3) - rowTop(2)).toBeGreaterThan(height);
  });

  it("bands each side's block in its own colour, and leaves the others bare", () => {
    screen.update(teamBoard());

    // Red's band covers its two rows from the first's top; blue's covers its one.
    expect(find('scoreboard-band-0')!.enabled).toBe(true);
    expect(channels('scoreboard-band-0')).toEqual([1, 0, 0]);
    expect(-find('scoreboard-band-0')!.getLocalPosition().y).toBeCloseTo(rowTop(0));
    expect(element('scoreboard-band-0').height).toBeCloseTo(element('scoreboard-row-0-bar').height * 2);

    expect(find('scoreboard-band-1')!.enabled).toBe(true);
    expect(channels('scoreboard-band-1')).toEqual([0, 0, 1]);
    expect(-find('scoreboard-band-1')!.getLocalPosition().y).toBeCloseTo(rowTop(2));
    expect(element('scoreboard-band-1').height).toBeCloseTo(element('scoreboard-row-2-bar').height);
  });

  it('bands no block but a side, as `CG_DrawTeamBackground` returns for any other team', () => {
    screen.update(
      scoreboard({
        rows: [row({ client: 2, team: TEAM.BLUE }), row({ client: 3, team: TEAM.SPECTATOR })]
      })
    );

    expect(channels('scoreboard-band-0')).toEqual([0, 0, 1]);
    expect(find('scoreboard-band-1')!.enabled).toBe(false);
  });

  it('bands blue first where blue leads, as the rows arrive that way round', () => {
    screen.update(
      scoreboard({ rows: [row({ client: 2, team: TEAM.BLUE }), row({ client: 0, team: TEAM.RED })] })
    );

    expect(channels('scoreboard-band-0')).toEqual([0, 0, 1]);
    expect(channels('scoreboard-band-1')).toEqual([1, 0, 0]);
  });

  it('bands nothing in a free-for-all, where every row is on the same side', () => {
    screen.update(scoreboard({ rows: [row({ client: 0 }), row({ client: 1 })] }));

    expect(find('scoreboard-band-0')!.enabled).toBe(false);
    expect(find('scoreboard-band-1')!.enabled).toBe(false);
    // One block, so the rows follow one another with no gap between them.
    expect(rowTop(1) - rowTop(0)).toBeCloseTo(element('scoreboard-row-0-bar').height);
  });

  it("fades every element by the frame's fade", () => {
    screen.update(
      scoreboard({ fade: 0.5, lines: ['Fragged by Visor'], rows: [row({ team: TEAM.RED })] })
    );

    expect(element('scoreboard-backdrop').opacity).toBeCloseTo(0.275);
    expect(element('scoreboard-panel').opacity).toBeCloseTo(0.46);
    expect(element('scoreboard-line-0').opacity).toBeCloseTo(0.5);
    expect(element('scoreboard-row-0-name').opacity).toBeCloseTo(0.35);
    expect(element('scoreboard-band-0').opacity).toBeCloseTo(0.165);
  });
});

describe('ScoreboardScreen in a box', () => {
  let app: AppBase;
  let eye: Entity;
  let screen: ScoreboardScreen;

  beforeEach(() => {
    ({ app, camera: eye } = createTestApp());
    screen = new ScoreboardScreen(app, eye, { font: squareFont(app, 0.75) });
  });

  afterEach(() => {
    screen.destroy();
    app.destroy();
  });

  const find = (name: string) => app.root.findByName(name) as Entity | null;
  const element = (name: string): ElementComponent => find(name)!.element!;
  const x = (name: string) => find(name)!.getLocalPosition().x;
  /** The server browser's room for a board: 168 across and 128 down from (456,248). */
  const BOX = { x: 456, y: 248, width: 168, height: 128 };
  /** A spectator's board of `count` rows. */
  const rows = (count: number, over: Partial<Scoreboard> = {}) =>
    scoreboard({
      rank: -1,
      rows: Array.from({ length: count }, (_unused, client) => row({ client })),
      ...over
    });

  it("stands in the box with no backdrop or panel of its own, its heads in the menu's case", () => {
    screen.update(rows(1), BOX);
    // Its middle at the box's, (540,312), from the screen's.
    const { x: across, y: down } = find('scoreboard-panel')!.getLocalPosition();
    expect([across, down]).toEqual([220, -72]);
    const panel = element('scoreboard-panel');
    expect([panel.width, panel.height]).toEqual([168, 128]);
    expect(element('scoreboard-panel').opacity).toBe(0);
    expect(find('scoreboard-backdrop')!.enabled).toBe(false);
    const heads = [0, 1, 2, 3].map((i) => element(`scoreboard-head-${i}`).text);
    expect(heads).toEqual(['Score', 'Ping', 'Time', 'Name']);
    expect(element('scoreboard-head-0').fontSize).toBe(14);
  });

  it('keeps each number\'s column as wide as its head, a character apart, and no icons', () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    screen.images = () => texture;
    const bot = row({ botSkill: 3, handicap: 70, head: { model: 'sarge', skin: 'default' } });
    screen.update(scoreboard({ rank: -1, rows: [bot] }), BOX);
    // From the box's left at −84: the score's right edge 35 in, the ping's 71, the time's 110,
    // and the name from 118.
    expect([0, 1, 2, 3].map((i) => x(`scoreboard-head-${i}`))).toEqual([-49, -13, 26, 34]);
    const cells = ['score', 'ping', 'time', 'name'].map((cell) => x(`scoreboard-row-0-${cell}`));
    expect(cells).toEqual([-49, -13, 26, 34]);
    expect(element('scoreboard-row-0-score').fontSize).toBe(14);
    for (const icon of ['head', 'marker-icon', 'marker']) {
      expect(find(`scoreboard-row-0-${icon}`)!.enabled, icon).toBe(false);
    }
  });

  it('gives Clan Arena\'s Dmg the time\'s place', () => {
    screen.update(rows(1, { damageColumn: true, rows: [row({ damage: '1234' })] }), BOX);
    expect(find('scoreboard-head-2')!.enabled).toBe(false);
    expect(find('scoreboard-row-0-time')!.enabled).toBe(false);
    expect(element('scoreboard-head-dmg').text).toBe('Dmg');
    expect([x('scoreboard-head-dmg'), x('scoreboard-row-0-damage')]).toEqual([26, 26]);
    expect(element('scoreboard-row-0-damage').text).toBe('1234');
    expect(x('scoreboard-row-0-name')).toBe(34);
  });

  it('draws its rows at the menu\'s 16 till the box is full, and smaller past that', () => {
    const height = () => element('scoreboard-row-0-bar').height;
    screen.update(rows(7), BOX);
    // The heads and 7 rows fill the 128.
    expect(height()).toBe(16);
    screen.update(rows(10), BOX);
    expect(height()).toBeCloseTo(112 / 10);
    expect(element('scoreboard-row-0-score').fontSize).toBeCloseTo((14 * 11.2) / 16);
    screen.update(rows(7, { lines: ['Red leads 3 to 1'] }), BOX);
    expect(height()).toBeCloseTo(96 / 7);
  });

  it("counts the player's own row at the foot among the rows the box holds", () => {
    screen.update(rows(7, { foot: row({ client: 9, you: true }) }), BOX);
    // The heads, 7 rows and the foot share the 128: 14 each.
    expect(element('scoreboard-row-0-bar').height).toBe(14);
    expect(element('scoreboard-foot-bar').height).toBe(14);
  });

  it("draws a name's colour runs and the lines at the box's size, after its own panel's", () => {
    const board = rows(1, { lines: ['^1Red^7 leads'], rows: [row({ name: '^1B^7it' })] });
    screen.update(board);
    screen.update(board, BOX);
    for (const text of ['line-0', 'line-0-run-1', 'row-0-name', 'row-0-name-run-1']) {
      expect(element(`scoreboard-${text}`).fontSize, text).toBe(14);
    }
  });

  it('takes the icons off the rows its own panel drew them on', () => {
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    screen.images = () => texture;
    const bot = row({ botSkill: 3, head: { model: 'sarge', skin: 'default' } });
    const board = scoreboard({ rank: -1, rows: [bot, row({ client: 1, handicap: 70 })] });
    const icons = ['row-0-head', 'row-0-marker-icon', 'row-1-marker'];
    const shown = () => icons.map((icon) => find(`scoreboard-${icon}`)!.enabled);
    screen.update(board);
    expect(shown()).toEqual([true, true, true]);
    screen.update(board, BOX);
    expect(shown()).toEqual([false, false, false]);
  });

  it("bands a side's block across the box, and across its own panel again after", () => {
    const board = rows(2, { rows: [row({ team: TEAM.RED }), row({ client: 1, team: TEAM.BLUE })] });
    const widths = () => [0, 1].map((i) => element(`scoreboard-band-${i}`).width);
    screen.update(board, BOX);
    expect(widths()).toEqual([168, 168]);
    screen.update(board);
    expect(widths()).toEqual([560, 560]);
  });

  it('cuts a name at the box\'s edge, and in its own panel cuts none', () => {
    const named = (name: string) => rows(1, { rows: [row({ name })] });
    screen.update(named('Bitterman'), BOX);
    // Square glyphs 14 across: the 50 from 118 to the edge holds three.
    expect(element('scoreboard-row-0-name').text).toBe('Bit');
    screen.update(named('^1Bit^7terman'), BOX);
    expect(element('scoreboard-row-0-name').text).toBe('Bit');
    expect(find('scoreboard-row-0-name-run-1')!.enabled).toBe(false);

    screen.update(named('Bitterman'));
    expect(element('scoreboard-row-0-name').text).toBe('Bitterman');
    expect(find('scoreboard-panel')!.getLocalPosition().x).toBe(0);
    expect(find('scoreboard-backdrop')!.enabled).toBe(true);
    expect(element('scoreboard-head-0').text).toBe('SCORE');
    expect(element('scoreboard-row-0-score').fontSize).toBe(13);
  });
});
