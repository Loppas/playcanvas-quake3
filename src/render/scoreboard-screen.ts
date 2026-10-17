import {
  Color,
  ELEMENTTYPE_IMAGE,
  ELEMENTTYPE_TEXT,
  Entity,
  GAMMA_SRGB,
  Layer,
  SCALEMODE_BLEND,
  SORTMODE_MANUAL,
  TONEMAP_LINEAR,
  Vec2,
  Vec4,
  type AppBase,
  type Texture
} from 'playcanvas';

import { DEFER_SHADER, playerModelDir } from '../formats/asset-manifest';
import { COLOR_TABLE, colorRuns } from '../formats/color-codes';
import { TEAM } from '../sim/constants';
import { PW, findItemForPowerup } from '../sim/items';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../view/hud-layout';
import type { Rect } from '../view/menu-placement';
import type { ModelSkin } from '../view/player-model';
import { MAX_ROWS, type Scoreboard, type ScoreboardRow } from '../view/scoreboard';
import { createMenuFont } from './menu-font';
import type { Warmed } from './warm-up';

/**
 * The scoreboard on screen: Q3's data in the port's own style, as `view/scoreboard.ts` decides it.
 * The panel and the font are the port's own, as the menu; the icons — a row's portrait, a
 * bot's skill and a carried flag — are the install's own art, as the Model page draws its icons.
 *
 * The screen is Q3's 640×480 grid, scaled by the height as the HUD's is, with a panel in the
 * middle: the lines above the board, the column heads, then one row per client. The player's own
 * row is lit; the marker column carries a carried flag's icon, else a bot's skill art, and a
 * client whose READY bit is set reads READY over either. The lines and the names are drawn in Q3's
 * colour codes (`colorRuns`), one run entity per colour.
 *
 * The rows come in blocks, one team at a time, and are drawn as blocks: a gap between them, and a
 * band of the side's colour behind red's and blue's.
 *
 * The board draws in a layer of its own, from a camera after the HUD's and the menu's, enabled
 * only while the board is up. Q3 draws no board of the match's while the menu has the keys
 * (`cg_scoreboard.c:276–279`); the one the menu shows is a server's, in a box the menu keeps for
 * it, drawn without a panel of its own or the rows' icons.
 */

/** The board's camera, after the HUD's and the menu's, whose panel a server's board stands in. */
export const SCOREBOARD_CAMERA_PRIORITY = 5;

/** The panel's width on the 640×480 grid, and how far its contents keep in from its edges. */
const PANEL_WIDTH = 560;
const PADDING = 14;

/** A line above the board, a column head, and a row: their heights down the panel. */
const LINE_HEIGHT = 22;
const HEADER_HEIGHT = 26;
const ROW_HEIGHT = 22;
const FOOT_GAP = 8;

/**
 * What stands between one team's rows and the next's, where Q3 leaves a `BIGCHAR_HEIGHT`
 * (`cg_scoreboard.c:341–357`). The port's own size, as its rows are their own height.
 */
const BLOCK_GAP = 10;

/** A row's text sits on its bar's middle, where the bar hangs from its top edge by a whole row. */
const ROW_TEXT_Y = -ROW_HEIGHT / 2;

/** The text sizes: the lines a little larger than the columns. */
const LINE_SIZE = 15;
const TEXT_SIZE = 13;

/** Which way a text runs from where it is put. */
type Align = 'left' | 'right';

/**
 * The columns, in Q3's order (`cg_scoreboard.c:45–60`): the marker and the head's column first,
 * then the score, ping and time right-aligned to their fields, and the name. Q3 centres a row on
 * its rating width — the bot's icon at `SB_BOTICON_X + SB_RATING_WIDTH / 2` = 80 and the head at
 * `SB_HEAD_X + 48` = 112, with the score line from `SB_SCORELINE_X + 48` = 160
 * (`cg_scoreboard.c:94–95`) — which the panel's 560 scales to the marker 70 and the head's left
 * edge 42 before the score line's own place, −140.
 */
/** The marker's column: its left edge, where Q3 draws the bot's art, the handicap and READY. */
export const MARKER_X = -210;
/** The head's own column, between the marker and the score, where Q3 draws the client's head. */
export const HEAD_X = -173;
/** How big a row's portrait is drawn, from the icon's 64×64; Q3's bot art is the head's size too. */
const HEAD_SIZE = 18;
const SCORE_RIGHT = -70;
const PING_RIGHT = 0;
const TIME_RIGHT = 70;
const NAME_X = 84;
/** Clan Arena's Dmg column after the time, and the name moved along for it (CPMA's order). */
const DAMAGE_RIGHT = 140;
const DAMAGE_NAME_X = 154;

/** The own row's fill: Q3 starts it at the score line's field and runs it to the screen's edge. */
export const FILL_LEFT = -140;
const FILL_RIGHT = PANEL_WIDTH / 2;
const FILL_X = (FILL_LEFT + FILL_RIGHT) / 2;

/** The board's palette, the menu's: Q3's orange over a dark panel. */
const ACCENT = new Color(1, 0.55, 0.12);
const PANEL = new Color(0.07, 0.07, 0.09);
const BLACK = new Color(0, 0, 0);
const WHITE = new Color(1, 1, 1);

/** How far the board dims the game, how solid its panel is, the own row's fill, and idle text. */
const BACKDROP_OPACITY = 0.55;
const PANEL_OPACITY = 0.92;
/** `hcolor[3] = fade * 0.7`: how solid Q3's own-row fill is (`cg_scoreboard.c:214`). */
const BAR_OPACITY = 0.7;
const TEXT_IDLE = 0.7;

/**
 * `CG_DrawTeamBackground`'s own two colours and how solid it is (`cg_draw.c:487–510`): the band
 * a team's block of rows is drawn over. No other team has one, which is Q3's `else return`.
 */
const TEAM_BANDS: Readonly<Record<number, Color>> = {
  [TEAM.RED]: new Color(1, 0, 0),
  [TEAM.BLUE]: new Color(0, 0, 1)
};
const BAND_OPACITY = 0.33;

/** Q3's `hcolor` by place (`cg_scoreboard.c:196–212`): blue, red and yellow, then white. */
const RANK_FILL: readonly (readonly [number, number, number])[] = [
  [0, 0, 0.7],
  [0.7, 0, 0],
  [0.7, 0.7, 0],
  [0.7, 0.7, 0.7]
];

/** The columns' heads, in the order they stand, each over its own column's edge. */
const COLUMNS: readonly { head: string; x: number; align: Align }[] = [
  { head: 'SCORE', x: SCORE_RIGHT, align: 'right' },
  { head: 'PING', x: PING_RIGHT, align: 'right' },
  { head: 'TIME', x: TIME_RIGHT, align: 'right' },
  { head: 'NAME', x: NAME_X, align: 'left' }
];

/**
 * A column's place in the bar's own coordinates: a row's cells are the bar's children, and the
 * bar's origin is the fill's middle, not the panel's.
 */
const onBar = (x: number) => x - FILL_X;

/** How a board stands: in its own panel over the game, or in a box another screen keeps. */
interface Layout {
  /** The panel's width, and the room it keeps over its lines and under its last row. */
  readonly width: number;
  readonly padding: number;
  readonly lineHeight: number;
  readonly lineSize: number;
  readonly headerHeight: number;
  readonly rowHeight: number;
  readonly textSize: number;
  readonly blockGap: number;
  /** The columns' heads, and their places from the panel's middle: each number's right edge. */
  readonly heads: { readonly score: string; readonly ping: string; readonly time: string };
  readonly nameHead: string;
  readonly damageHead: string;
  readonly score: number;
  readonly ping: number;
  readonly time: number;
  readonly damage: number;
  /** The name's left edge, and where it moves to with Clan Arena's Dmg column. */
  readonly name: number;
  readonly damageName: number;
  /** Whether Time stands beside Dmg, rather than giving Dmg its place. */
  readonly timeWithDamage: boolean;
  /** The own row's fill, from its left to its right. */
  readonly fillLeft: number;
  readonly fillRight: number;
  /** Whether a row draws its marker and its portrait. */
  readonly icons: boolean;
  /** Where a name is cut, from the panel's middle, or null where the panel is wide enough. */
  readonly nameRight: number | null;
}

/** The board in its own panel. */
const OWN_LAYOUT: Layout = {
  width: PANEL_WIDTH,
  padding: PADDING,
  lineHeight: LINE_HEIGHT,
  lineSize: LINE_SIZE,
  headerHeight: HEADER_HEIGHT,
  rowHeight: ROW_HEIGHT,
  textSize: TEXT_SIZE,
  blockGap: BLOCK_GAP,
  heads: { score: 'SCORE', ping: 'PING', time: 'TIME' },
  nameHead: 'NAME',
  damageHead: 'DMG',
  score: SCORE_RIGHT,
  ping: PING_RIGHT,
  time: TIME_RIGHT,
  damage: DAMAGE_RIGHT,
  name: NAME_X,
  damageName: DAMAGE_NAME_X,
  timeWithDamage: true,
  fillLeft: FILL_LEFT,
  fillRight: FILL_RIGHT,
  icons: true,
  nameRight: null
};

/**
 * A board in a box: the menu's rows, 14-size text in 16, with no room kept round them, and the
 * heads in the menu's case. Each number's column is as wide as its head in the menu's face, a
 * character apart, and the name has the rest.
 */
const BOX_ROW_HEIGHT = 16;
const BOX_TEXT_SIZE = 14;
const BOX_GAP = 8;
const BOX_SCORE_RIGHT = 35;
const BOX_PING_RIGHT = BOX_SCORE_RIGHT + BOX_GAP + 28;
const BOX_TIME_RIGHT = BOX_PING_RIGHT + BOX_GAP + 31;
const BOX_NAME_X = BOX_TIME_RIGHT + BOX_GAP;

/**
 * The board's layout in a box on the 640×480 screen. Its rows are the menu's height until they
 * run out of room, and smaller from there, as Q3's board draws a crowded server's rows smaller
 * (`cg_scoreboard.c:353–362`). Clan Arena's Dmg stands in Time's place.
 */
function boxLayout(box: Rect, frame: Scoreboard): Layout {
  const left = -box.width / 2;
  const blocks = frame.rows.filter((row, i) => i === 0 || frame.rows[i - 1].team !== row.team);
  const fixed =
    frame.lines.length * BOX_ROW_HEIGHT + BOX_ROW_HEIGHT + Math.max(0, blocks.length - 1) * BOX_GAP;
  const rows = frame.rows.length + (frame.foot ? 1 : 0);
  const rowHeight =
    rows === 0 ? BOX_ROW_HEIGHT : Math.min(BOX_ROW_HEIGHT, (box.height - fixed) / rows);
  return {
    width: box.width,
    padding: 0,
    lineHeight: BOX_ROW_HEIGHT,
    lineSize: BOX_TEXT_SIZE,
    headerHeight: BOX_ROW_HEIGHT,
    rowHeight,
    textSize: (BOX_TEXT_SIZE * rowHeight) / BOX_ROW_HEIGHT,
    blockGap: BOX_GAP,
    heads: { score: 'Score', ping: 'Ping', time: 'Time' },
    nameHead: 'Name',
    damageHead: 'Dmg',
    score: left + BOX_SCORE_RIGHT,
    ping: left + BOX_PING_RIGHT,
    time: left + BOX_TIME_RIGHT,
    damage: left + BOX_TIME_RIGHT,
    name: left + BOX_NAME_X,
    damageName: left + BOX_NAME_X,
    timeWithDamage: false,
    fillLeft: left,
    fillRight: -left,
    icons: false,
    nameRight: -left
  };
}

/** Scratch for a colour run's tint, which each run copies as it is drawn. */
const tint = new Color();

/** A text at a size, left alone where it is already at it, since a new size lays it out again. */
function sized(entity: Entity, size: number): void {
  if (entity.element!.fontSize !== size) entity.element!.fontSize = size;
}

/**
 * The marker column's text, in Q3's order (`CG_DrawClientScore`, `cg_scoreboard.c:97–135`): READY
 * at the intermission, nothing while a flag is carried, else the handicap of a player below 100.
 * A bot's skill 1–5 is the art beside it (`skillIcon`), which READY and a flag both stand in the
 * place of, and a bot's handicap — which `G_AddBot` sets from its skill (`g_bot.c:670–678`) — is
 * never drawn, as Q3's else-if skips it.
 */
function marker(data: ScoreboardRow): string {
  if (data.ready) return 'READY';
  if (flagIcon(data) !== null) return '';
  if (data.botSkill > 0 && data.botSkill <= 5) return '';
  return data.handicap < 100 ? `${data.handicap}` : '';
}

/** A bot's skill art, as Q3 registers its `botSkillShaders` (`cg_main.c:836–840`). */
function skillIcon(skill: number): string {
  return `menu/art/skill${skill}`;
}

/**
 * The flag a row is carrying, "unless player has flag" (`cg_scoreboard.c:97–118`): it takes the
 * marker column, ahead of the bot's skill and the handicap alike.
 *
 * Quake 3 draws `CG_DrawFlagModel` there, which under the default `cg_draw3dIcons` is the flag's
 * model turning on the spot and otherwise the flag item's own icon. The port's board is 2D
 * throughout — a row's portrait is the model's icon and a bot's skill its art — so it draws the
 * icon, which is the same picture Q3 falls back to.
 *
 * The order is Q3's else-if chain, and no game can tell it from any other: a player carries the
 * other side's flag and their own is never theirs to hold, so no row ever has both bits.
 */
function flagIcon(data: ScoreboardRow): string | null {
  for (const powerup of [PW.REDFLAG, PW.BLUEFLAG]) {
    if (data.powerups & (1 << powerup)) return findItemForPowerup(powerup)?.icon ?? null;
  }
  return null;
}

/** A text in Q3's colour runs: the slot holding the first, and the runs after it. */
interface TextSlot {
  /** Where the runs are made beside the slot. */
  parent: Entity;
  /** The slot: its text's first run, or the whole of a text with no colour codes. */
  slot: Entity;
  /** The runs after the first, made as a text first needs them (`-run-1` onward). */
  runs: Entity[];
}

/** One row's elements: the bar the player's own row lights, the columns and the marker. */
interface Row {
  bar: Entity;
  head: Entity;
  /** The cross over the portrait of a client drawn in another's look, hung from the portrait. */
  defer: Entity;
  markerIcon: Entity;
  score: Entity;
  ping: Entity;
  time: Entity;
  damage: Entity;
  marker: Entity;
  name: TextSlot;
}

/** The icon a look's head wears, as the Model page names its pictures. */
export function headIcon(head: ModelSkin): string | null {
  return head.model === '' ? null : `${playerModelDir(head.model)}icon_${head.skin}`;
}

/** A row on the board drawn for the warm-up. */
const WARM_ROW: ScoreboardRow = {
  client: 0,
  team: TEAM.RED,
  name: '^1W^7arm',
  head: { model: 'sarge', skin: 'default' },
  deferred: true,
  score: '0',
  ping: '0',
  time: '0',
  damage: '0',
  spectator: false,
  connecting: false,
  you: true,
  ready: false,
  botSkill: 1,
  handicap: 100,
  powerups: 0
};

/**
 * The board drawn for the warm-up, with an element of each kind a board has: a line and a name in
 * two colours, both sides' bands, the own row's bar, a portrait crossed out, a bot's skill art,
 * READY, and every column.
 */
const WARM_BOARD: Scoreboard = {
  fade: 1,
  rank: 0,
  lines: ['^1W^7arm'],
  rows: [WARM_ROW, { ...WARM_ROW, client: 1, team: TEAM.BLUE, you: false, ready: true, botSkill: 0 }],
  foot: null,
  damageColumn: true,
  loadDeferred: false
};

export interface ScoreboardScreenOptions {
  /**
   * The font, a system face by default. `null` draws the text with none, for a device with no
   * canvas to draw a font on: each line still carries its string.
   */
  font?: ReturnType<typeof createMenuFont> | null;
}

/** The board's screen, and the camera that draws it. */
export class ScoreboardScreen {
  /**
   * The portraits the rows draw, by shader name: each model and skin's `icon_<skin>`, as the
   * Model page draws its own. `null` from it for one that has not loaded; unset, no row has one.
   */
  images: ((name: string) => Texture | null) | null = null;

  private readonly app: AppBase;
  private readonly font: ReturnType<typeof createMenuFont> | null;
  private readonly layer: Layer;
  private readonly camera: Entity;
  private readonly screen: Entity;
  private readonly backdrop: Entity;
  private readonly panel: Entity;
  private readonly lines: TextSlot[];
  private readonly heads: Entity[];
  private readonly damageHead: Entity;
  /** One band per side, behind the rows because they are made before them. */
  private readonly bands: Entity[];
  private readonly rows: Row[];
  private readonly foot: Row;
  private destroyed = false;

  /** @param eye - The camera the world is seen through; the board draws after the HUD. */
  constructor(app: AppBase, eye: Entity, options: ScoreboardScreenOptions = {}) {
    this.app = app;
    this.font = options.font === undefined ? createMenuFont(app) : options.font;

    this.layer = new Layer({ name: 'scoreboard', transparentSortMode: SORTMODE_MANUAL });
    app.scene.layers.push(this.layer);

    this.camera = new Entity('scoreboard-camera');
    this.camera.addComponent('camera', {
      layers: [this.layer.id],
      clearColorBuffer: false,
      clearDepthBuffer: false,
      priority: eye.camera!.priority + SCOREBOARD_CAMERA_PRIORITY,
      gammaCorrection: GAMMA_SRGB,
      toneMapping: TONEMAP_LINEAR
    });
    this.camera.enabled = false;
    app.root.addChild(this.camera);

    this.screen = new Entity('scoreboard');
    this.screen.addComponent('screen', {
      screenSpace: true,
      referenceResolution: new Vec2(SCREEN_WIDTH, SCREEN_HEIGHT),
      scaleMode: SCALEMODE_BLEND,
      scaleBlend: 1
    });
    this.screen.enabled = false;
    app.root.addChild(this.screen);

    this.backdrop = this.image(this.screen, 'scoreboard-backdrop', new Vec4(0, 0, 1, 1));
    this.backdrop.element!.margin = new Vec4(0, 0, 0, 0);
    this.backdrop.element!.color = BLACK;

    this.panel = this.image(this.screen, 'scoreboard-panel', new Vec4(0.5, 0.5, 0.5, 0.5));
    this.panel.element!.color = PANEL;

    // The lines hang from the panel's top, as the menu's rows hang from its own.
    this.lines = Array.from({ length: 2 }, (_unused, i) => ({
      parent: this.panel,
      slot: this.text(this.panel, `scoreboard-line-${i}`, LINE_SIZE, 0),
      runs: []
    }));
    this.heads = COLUMNS.map(({ head, x, align }, i) => {
      const entity = this.text(this.panel, `scoreboard-head-${i}`, TEXT_SIZE, x, 0, align);
      this.setText(entity, head);
      entity.element!.color = ACCENT;
      return entity;
    });
    this.damageHead = this.text(
      this.panel,
      'scoreboard-head-dmg',
      TEXT_SIZE,
      DAMAGE_RIGHT,
      0,
      'right'
    );
    this.setText(this.damageHead, 'DMG');
    this.damageHead.element!.color = ACCENT;

    // Before the rows, so that the rows are drawn over them: a screen's draw order follows the
    // order its elements hang in.
    this.bands = Array.from({ length: Object.keys(TEAM_BANDS).length }, (_unused, i) => {
      const band = this.image(this.panel, `scoreboard-band-${i}`, new Vec4(0.5, 1, 0.5, 1), new Vec2(0.5, 1));
      band.element!.width = PANEL_WIDTH;
      band.enabled = false;
      return band;
    });

    this.rows = Array.from({ length: MAX_ROWS }, (_unused, i) =>
      this.row(`scoreboard-row-${i}`)
    );
    this.foot = this.row('scoreboard-foot');
  }

  /**
   * Draw this frame's board, or nothing while it is down.
   *
   * @param box - Where on the 640×480 screen a board shown in another screen's room stands, as
   *   the server browser shows a server's: with no backdrop, panel or icons of its own. Without
   *   one, the board stands in its own panel over the game.
   */
  update(frame: Scoreboard | null, box?: Rect): void {
    if (this.destroyed) return;
    const shown = frame !== null;
    this.screen.enabled = shown;
    this.camera.enabled = shown;
    if (!frame) return;

    const layout = box ? boxLayout(box, frame) : OWN_LAYOUT;
    const fade = frame.fade;
    this.backdrop.enabled = !box;
    this.backdrop.element!.opacity = BACKDROP_OPACITY * fade;
    this.panel.element!.opacity = box ? 0 : PANEL_OPACITY * fade;
    // The panel hangs from the screen's middle, up the screen for a positive y.
    const [x, y] = box
      ? [box.x + box.width / 2 - SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 - (box.y + box.height / 2)]
      : [0, 0];
    this.panel.setLocalPosition(x, y, 0);

    let top = layout.padding;
    this.lines.forEach((line, i) => {
      const text = frame.lines[i];
      if (text === undefined) {
        this.hideSlot(line);
        return;
      }
      const middle = -(top + layout.lineHeight / 2);
      this.drawRuns(line, text, layout.lineSize, WHITE, fade, 0, middle, true);
      top += layout.lineHeight;
    });

    const damaged = frame.damageColumn;
    const timed = !damaged || layout.timeWithDamage;
    const nameX = damaged ? layout.damageName : layout.name;
    const [scoreHead, pingHead, timeHead, nameHead] = this.heads;
    const heads: [Entity, string, number, boolean][] = [
      [scoreHead, layout.heads.score, layout.score, true],
      [pingHead, layout.heads.ping, layout.ping, true],
      [timeHead, layout.heads.time, layout.time, timed],
      [nameHead, layout.nameHead, nameX, true],
      [this.damageHead, layout.damageHead, layout.damage, damaged]
    ];
    for (const [head, text, at, on] of heads) {
      head.enabled = on;
      this.setText(head, text);
      sized(head, layout.textSize);
      head.setLocalPosition(at, -(top + layout.headerHeight / 2), 0);
      head.element!.opacity = TEXT_IDLE * fade;
    }
    top += layout.headerHeight;

    const fillX = (layout.fillLeft + layout.fillRight) / 2;
    const rowY = -layout.rowHeight / 2;
    const draw = (row: Row, data: ScoreboardRow): void => {
      const bar = row.bar.element!;
      row.bar.enabled = true;
      row.bar.setLocalPosition(fillX, -top, 0);
      bar.width = layout.fillRight - layout.fillLeft;
      bar.height = layout.rowHeight;
      const fill = RANK_FILL[frame.rank >= 0 && frame.rank < RANK_FILL.length - 1 ? frame.rank : RANK_FILL.length - 1];
      bar.color = tint.set(fill[0], fill[1], fill[2]);
      bar.opacity = data.you ? BAR_OPACITY * fade : 0;
      const lit = data.you ? 1 : TEXT_IDLE;
      const cells: [Entity, string, number, boolean][] = [
        [row.score, data.score, layout.score, true],
        [row.ping, data.ping, layout.ping, true],
        [row.time, data.time, layout.time, timed],
        [row.damage, data.damage, layout.damage, damaged]
      ];
      for (const [cell, text, at, on] of cells) {
        cell.enabled = on;
        this.setText(cell, text);
        sized(cell, layout.textSize);
        cell.setLocalPosition(at - fillX, rowY, 0);
        cell.element!.color = data.you ? ACCENT : WHITE;
        cell.element!.opacity = lit * fade;
      }
      const cutAt = layout.nameRight === null ? null : layout.nameRight - fillX;
      const own = data.you ? ACCENT : WHITE;
      const nameAt = nameX - fillX;
      const opacity = lit * fade;
      this.drawRuns(row.name, data.name, layout.textSize, own, opacity, nameAt, rowY, false, cutAt);
      if (layout.icons) this.drawIcons(row, data, lit, fade);
      else for (const icon of [row.head, row.markerIcon, row.marker]) icon.enabled = false;
      top += layout.rowHeight;
    };

    // The rows arrive in blocks, one team at a time (`orderRows`), and Q3 draws them as blocks: a
    // gap between one and the next, and a band of the side's own colour behind each of the two
    // that have one (`cg_scoreboard.c:341–357`).
    const blocks: { team: number; top: number; height: number }[] = [];
    frame.rows.forEach((data, i) => {
      const block = blocks[blocks.length - 1];
      if (block === undefined || block.team !== data.team) {
        if (block !== undefined) top += layout.blockGap;
        blocks.push({ team: data.team, top, height: 0 });
      }
      draw(this.rows[i], data);
      blocks[blocks.length - 1].height += layout.rowHeight;
    });
    for (let i = frame.rows.length; i < this.rows.length; i++) this.hide(this.rows[i]);

    const banded = blocks.filter((block) => TEAM_BANDS[block.team] !== undefined);
    this.bands.forEach((band, i) => {
      const block = banded[i];
      band.enabled = block !== undefined;
      if (block === undefined) return;
      band.element!.color = TEAM_BANDS[block.team];
      band.element!.width = layout.width;
      band.element!.height = block.height;
      band.element!.opacity = BAND_OPACITY * fade;
      band.setLocalPosition(0, -block.top, 0);
    });

    if (frame.foot) {
      top += FOOT_GAP;
      draw(this.foot, frame.foot);
    } else {
      this.hide(this.foot);
    }

    const panel = this.panel.element!;
    panel.width = layout.width;
    panel.height = box ? box.height : top + layout.padding;
  }

  /**
   * A row's portrait, crossed out for a client drawn in another's look (`CG_DrawHead`,
   * `cg_draw.c:345–349`), and its marker column: a carried flag's icon, else a bot's skill art,
   * and READY or the handicap as text.
   */
  private drawIcons(row: Row, data: ScoreboardRow, lit: number, fade: number): void {
    const icon = headIcon(data.head);
    const portrait = icon === null ? null : (this.images?.(icon) ?? null);
    row.head.enabled = portrait !== null;
    if (portrait !== null) {
      row.head.element!.texture = portrait;
      row.head.element!.opacity = lit * fade;
    }
    const cross = data.deferred ? (this.images?.(DEFER_SHADER) ?? null) : null;
    row.defer.enabled = cross !== null;
    if (cross !== null) {
      row.defer.element!.texture = cross;
      row.defer.element!.opacity = lit * fade;
    }
    const flag = flagIcon(data);
    const art =
      data.ready
        ? null
        : flag !== null
          ? flag
          : data.botSkill > 0 && data.botSkill <= 5
            ? skillIcon(data.botSkill)
            : null;
    const skill = art === null ? null : (this.images?.(art) ?? null);
    row.markerIcon.enabled = skill !== null;
    if (skill !== null) {
      row.markerIcon.element!.texture = skill;
      row.markerIcon.element!.opacity = lit * fade;
    }
    const marked = marker(data);
    this.setText(row.marker, marked);
    row.marker.enabled = marked !== '';
    row.marker.element!.color = data.ready ? ACCENT : WHITE;
    row.marker.element!.opacity = TEXT_IDLE * fade;
  }

  /**
   * A board for the warm-up (`warm-up.ts`), drawn through the board's own camera so that its first
   * showing in play makes nothing; taken down after, for the next frame to draw what is due.
   */
  warm(): Warmed {
    return {
      at: () => this.update(WARM_BOARD),
      end: () => this.update(null)
    };
  }

  /** Take the board off the screen and give back its font's textures. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.screen.destroy();
    this.camera.destroy();
    this.app.scene.layers.remove(this.layer);
    this.font?.destroy();
  }

  /** A row's elements, hung from the panel's top and hidden until it is drawn. */
  private row(name: string): Row {
    const bar = this.image(this.panel, `${name}-bar`, new Vec4(0.5, 1, 0.5, 1), new Vec2(0.5, 1));
    bar.element!.width = FILL_RIGHT - FILL_LEFT;
    bar.element!.height = ROW_HEIGHT;
    bar.element!.color = ACCENT;
    const head = this.image(bar, `${name}-head`, new Vec4(0.5, 1, 0.5, 1));
    head.element!.width = HEAD_SIZE;
    head.element!.height = HEAD_SIZE;
    head.setLocalPosition(onBar(HEAD_X), ROW_TEXT_Y, 0);
    const defer = this.image(head, `${name}-defer`, new Vec4(0.5, 0.5, 0.5, 0.5));
    defer.element!.width = HEAD_SIZE;
    defer.element!.height = HEAD_SIZE;
    // Q3 draws the bot's skill from the marker column's own place, the head's size
    // (`cg_scoreboard.c:122–127`).
    const markerIcon = this.image(bar, `${name}-marker-icon`, new Vec4(0.5, 1, 0.5, 1));
    markerIcon.element!.width = HEAD_SIZE;
    markerIcon.element!.height = HEAD_SIZE;
    markerIcon.setLocalPosition(onBar(MARKER_X + HEAD_SIZE / 2), ROW_TEXT_Y, 0);
    const [score, ping, time, own] = COLUMNS;
    const row: Row = {
      bar,
      head,
      defer,
      markerIcon,
      score: this.text(bar, `${name}-score`, TEXT_SIZE, onBar(score.x), ROW_TEXT_Y, score.align),
      ping: this.text(bar, `${name}-ping`, TEXT_SIZE, onBar(ping.x), ROW_TEXT_Y, ping.align),
      time: this.text(bar, `${name}-time`, TEXT_SIZE, onBar(time.x), ROW_TEXT_Y, time.align),
      damage: this.text(bar, `${name}-damage`, TEXT_SIZE, onBar(DAMAGE_RIGHT), ROW_TEXT_Y, 'right'),
      marker: this.text(bar, `${name}-marker`, TEXT_SIZE, onBar(MARKER_X), ROW_TEXT_Y),
      name: {
        parent: bar,
        slot: this.text(bar, `${name}-name`, TEXT_SIZE, onBar(own.x), ROW_TEXT_Y, own.align),
        runs: []
      }
    };
    this.hide(row);
    return row;
  }

  /** Take every element of a row off the screen. */
  private hide(row: Row): void {
    row.bar.enabled = false;
    const cells = [row.head, row.markerIcon, row.score, row.ping, row.time, row.damage, row.marker];
    for (const cell of cells) {
      cell.enabled = false;
    }
    this.hideSlot(row.name);
  }

  /** Take a slot and every run of its text off the screen. */
  private hideSlot(text: TextSlot): void {
    text.slot.enabled = false;
    for (const run of text.runs) run.enabled = false;
  }

  /**
   * A slot's text in Q3's colour runs (`colorRuns`): the first piece on the slot itself, the rest
   * on run entities beside it, made as they are first needed. A piece with no code of its own keeps
   * `own`. A centred text is placed by the width of all its runs, from the middle out.
   *
   * @param cutAt - Where the text is cut from its end to end, from the parent's middle, or null.
   */
  private drawRuns(
    text: TextSlot,
    raw: string,
    size: number,
    own: Color,
    opacity: number,
    x: number,
    y: number,
    centered: boolean,
    cutAt: number | null = null
  ): void {
    const pieces = colorRuns(raw);
    if (pieces.length === 0) {
      this.hideSlot(text);
      return;
    }

    let total = 0;
    pieces.forEach((piece, i) => {
      const entity =
        i === 0
          ? text.slot
          : (text.runs[i - 1] ??= this.text(text.parent, `${text.slot.name}-run-${i}`, size, 0, y));
      entity.enabled = true;
      this.setText(entity, piece.text);
      sized(entity, size);
      const element = entity.element!;
      element.color = piece.color === undefined ? own : tint.set(...COLOR_TABLE[piece.color]);
      element.opacity = opacity;
      total += element.width;
    });
    for (let i = pieces.length - 1; i < text.runs.length; i++) text.runs[i].enabled = false;

    let at = centered ? -total / 2 : x;
    pieces.forEach((piece, i) => {
      const entity = i === 0 ? text.slot : text.runs[i - 1];
      entity.setLocalPosition(at, y, 0);
      if (cutAt !== null) this.cut(entity, piece.text, cutAt - at);
      at += entity.element!.width;
    });
  }

  /** A run cut from its end until it fits `room`, and off the screen where none of it does. */
  private cut(entity: Entity, full: string, room: number): void {
    let end = full.length;
    while (end > 0 && entity.element!.width > room) this.setText(entity, full.slice(0, --end));
    entity.enabled = end > 0;
  }

  private setText(entity: Entity, text: string): void {
    const element = entity.element!;
    if (element.text !== text) element.text = text;
  }

  /** A flat rectangle in its element's colour, on its anchor. */
  private image(parent: Entity, name: string, anchor: Vec4, pivot = new Vec2(0.5, 0.5)): Entity {
    const entity = new Entity(name);
    entity.addComponent('element', { type: ELEMENTTYPE_IMAGE, anchor, pivot, layers: [this.layer.id] });
    parent.addChild(entity);
    entity.setLocalPosition(0, 0, 0);
    return entity;
  }

  /**
   * A line of text, running right from `x` on its parent's top. A text that is centred is placed
   * by the width of its runs, from the middle out (`drawRuns`).
   *
   * @param x - Where its left edge is put, from the parent's middle.
   * @param y - How far below the parent's top its middle is put.
   */
  private text(
    parent: Entity,
    name: string,
    size: number,
    x: number,
    y = 0,
    align: Align = 'left'
  ): Entity {
    const across = align === 'right' ? 1 : 0;
    const entity = new Entity(name);
    entity.addComponent('element', {
      type: ELEMENTTYPE_TEXT,
      anchor: new Vec4(0.5, 1, 0.5, 1),
      pivot: new Vec2(across, 0.5),
      alignment: new Vec2(across, 0.5),
      fontSize: size,
      autoWidth: true,
      autoHeight: true,
      text: '',
      color: WHITE,
      layers: [this.layer.id],
      ...(this.font ? { font: this.font } : {})
    });
    entity.setLocalPosition(x, y, 0);
    parent.addChild(entity);
    return entity;
  }
}
