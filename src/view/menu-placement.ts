import { SCREEN_HEIGHT, SCREEN_WIDTH } from './hud-layout';
import type { MenuItem, MenuPage } from './menu';
import { GRID_COLUMNS } from './menu-models';
import { PLAYER_SLOTS } from './menu-start-server';

/**
 * Where q3_ui puts each page's items on its 640×480 screen, for a menu opened in the `q3ui`
 * placement. Engine-free: `render/menu-screen.ts` draws what this says, in the port's own style.
 *
 * A page is placed by its id, and by its layout where it has none. Within a page, an item is placed
 * by the part it plays: its role (BACK, the way on, an arrow), a tab, a cell of a grid, a place the
 * page names, or one of the page's rows. An item q3_ui hasn't got takes the next place in its group,
 * at the group's step.
 * The text is the port's face: a button's at the port's own button size, and the rest at a size
 * that fills the height q3_ui's font fills there. Each bar but a grid's cell is fitted to its text
 * as it is drawn, with the same margin across as up and down.
 */

/** A rectangle on the 640×480 screen: its left, its top, its width and its height. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A scrolled list's column: where its cells stand, which way they run, and how wide they are. */
export interface ListColumn {
  readonly x: number;
  readonly align: 'left' | 'right';
  readonly width: number;
}

/** How an item's text sits on its bar. Every x is on the 640×480 screen. */
export type ItemText =
  /**
   * A scrolled list: its rows down the bar, each `ROW_HEIGHT` high, and each row's cells in the
   * columns, cut to their widths (`ScrollList_Draw`, `ui_qmenu.c:1233–1290`).
   */
  | {
      readonly kind: 'list';
      readonly rows: number;
      readonly size: number;
      readonly columns: readonly ListColumn[];
    }
  /** A line: the label, or a glyph in its place, run from `x` as `align` says. */
  | {
      readonly kind: 'line';
      readonly x: number;
      readonly align: 'left' | 'centre' | 'right';
      readonly size: number;
      readonly glyph?: string;
    }
  /**
   * A widget's row: its label ending a character short of `x`, and its value, or a slider's bar,
   * starting a character past it (`SpinControl_Draw`, `Slider_Draw`, `ui_qmenu.c`).
   */
  | { readonly kind: 'row'; readonly x: number; readonly size: number }
  /** The label, and its value under it, as the Player page draws its rows. */
  | {
      readonly kind: 'stacked';
      readonly x: number;
      readonly labelSize: number;
      readonly valueX: number;
      readonly valueY: number;
      readonly size: number;
    }
  /**
   * A cell of a grid of pictures: its picture, and, where the cell is named, a strip under the
   * picture with the name on it.
   */
  | {
      readonly kind: 'cell';
      readonly picture: Rect;
      readonly strip: Rect | null;
      readonly name: TextPlace | null;
    };

/** One item's place: the bar the pointer finds and the cursor lights, and its text. */
export interface PlacedItem {
  readonly bar: Rect;
  readonly text: ItemText;
  /**
   * For a bar fitted to its text as the text is drawn, the margin it keeps all round the text;
   * `bar` is where it stands until then.
   */
  readonly fit?: number;
}

/** A point on the 640×480 screen, and the size of the text there. */
export interface TextPlace {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** Text wrapped at a width: the middle of its top line's top, and each line's step down. */
export interface WrappedText extends TextPlace {
  readonly width: number;
  readonly lineHeight: number;
}

/**
 * A page's picture, the strip under it where it has one, and a place on the strip for each of its
 * lines.
 */
export interface PicturePlace {
  readonly picture: Rect;
  readonly strip: Rect | null;
  readonly lines: readonly TextPlace[];
}

/**
 * A table of labels and values, a row each, as a widget's row stands: its label ending a character
 * short of `x` and its value starting a character past it, cut at `right`.
 */
export interface TablePlace {
  readonly x: number;
  /** The first row's middle, and how far each is under the last. */
  readonly y: number;
  readonly step: number;
  readonly rows: number;
  readonly right: number;
  readonly size: number;
}

/** Where a page draws what it shows of its own: its room, and its table and board within it. */
export interface DetailPlace {
  /** What the page's panel keeps room for, whatever is drawn in it. */
  readonly room: Rect;
  readonly settings: TablePlace;
  readonly board: Rect;
}

/** A page's whole placement. */
export interface PagePlacement {
  /**
   * Where q3_ui draws the page's frame, `null` where it draws none. What stands in it is the page's
   * panel: the renderer fits the port's panel round it, and moves the two to `band`'s middle.
   */
  readonly frame: Rect | null;
  /** The span down the screen a panel stands in the middle of, across it from 0 to 640. */
  readonly band: { readonly top: number; readonly bottom: number };
  /** Where the player's model stands in its preview, which the page's panel holds. */
  readonly figure: Rect | null;
  /** The banner's middle: Setup's title, or a confirm's question. */
  readonly title: TextPlace;
  /** One for each of the page's items, in its order. */
  readonly items: readonly PlacedItem[];
  /** The status line's middle. */
  readonly status: TextPlace;
  /** The player's preview, where q3_ui draws it, running off the screen as q3_ui's does. */
  readonly preview: Rect | null;
  /** The page's own line: under the preview, or under a grid's arrows. */
  readonly caption: TextPlace | null;
  /** The page's picture. */
  readonly picture: PicturePlace | null;
  /**
   * Where the page shows its own detail, drawn apart from its items: the Server Information box's
   * settings and board of the highlighted server.
   */
  readonly detail: DetailPlace | null;
  /** A confirm's warning. */
  readonly warning: WrappedText | null;
  /** The page's message. */
  readonly message: WrappedText | null;
}

/**
 * The frames, which the port's panels stand in for. The Setup ring is `frame2_l` at (0,78),
 * 256×329, with `frame1_r` at (376,76), 256×334 (`ui_setup.c:170–184`), and the panel covers what
 * the two enclose; `cut_frame` is the confirm's smaller ring (`ui_confirm.c`).
 */
export const RING: Rect = { x: 0, y: 76, width: 632, height: 334 };
export const CUT_FRAME: Rect = { x: 142, y: 118, width: 359, height: 256 };

/**
 * q3_ui's art for its two corner buttons: `back_0` at (0,416) and the way on R@512, each 128×64.
 * Each button is a bar across the middle of its art.
 */
export const BACK_CORNER: Rect = { x: 0, y: 416, width: 128, height: 64 };
export const FORWARD_CORNER: Rect = { x: 512, y: 416, width: 128, height: 64 };

/** A button, at the size the port's centred menu draws its rows: 17-size text in a bar 28 high. */
export const BUTTON_SIZE = 17;
export const BUTTON_HEIGHT = 28;

/** A panel's margin round what it holds, in both placements. */
export const PADDING = 14;

/**
 * The text's sizes on the 640×480 screen, in the port's face: the banner's (`PROPB_HEIGHT`, 36),
 * the big proportional font's (`PROP_HEIGHT`, 27), the small one's (0.75 of it), and the 16-high
 * characters a widget's row is drawn in.
 */
export const BANNER_SIZE = 30;
export const BIG_SIZE = 23;
export const SMALL_SIZE = 18;
export const CHAR_SIZE = 14;

/** The banner, white and centred at (320,16) (`ui_setup.c:163–168`), by its middle. */
const BANNER: TextPlace = { x: 320, y: 34, size: BANNER_SIZE };

/**
 * The main menu's screen, and its error screen's: no frame, and the strip across the top, (0,0) to
 * (640,120), where q3_ui turns its banner model (`Main_MenuDraw`, `ui_menu.c`), holding the game's
 * name in its middle.
 */
const MAIN_SCREENS: ReadonlySet<string> = new Set(['main', 'error']);
const LOGO: TextPlace = { x: 320, y: 60, size: 48 };

/** The error, wrapped to 600 across from (320,192), 20 a line, in the small font (`Main_MenuDraw`). */
const ERROR_MESSAGE: WrappedText = { x: 320, y: 192, size: SMALL_SIZE, width: 600, lineHeight: 20 };

/** The status line, where Controls writes its help (`ui_controls2.c:698–704`), by its middle. */
const STATUS: TextPlace = { x: 320, y: 392, size: CHAR_SIZE };

/** `PROP_HEIGHT`, and a widget's row: `SMALLCHAR_HEIGHT` high and a character wide. */
const PROP_HEIGHT = 27;
const ROW_HEIGHT = 16;
export const CHAR_WIDTH = 8;
/** How far a row's bar reaches either side of its `x`: about Controls' hit box, x 168 to 488 about 320. */
const ROW_REACH = 160;

/**
 * The margin a fitted bar keeps round its text: what a button's 28 leaves round its capitals, and
 * what a row's 16 leaves round its own.
 */
const BUTTON_MARGIN = CHAR_WIDTH;
const ROW_MARGIN = 3;

/** How far apart the main menu's buttons stand down its column (`ui_menu.c`). */
const MAIN_COLUMN_STEP = 34;

/** The Player and Model pages' preview, at (400,−40), 320×560 (`ui_playersettings.c:437–443`). */
const PLAYER_PREVIEW: Rect = { x: 400, y: -40, width: 320, height: 560 };

/**
 * Where a model stands in the preview, with its weapon and its idle's reach: measured over q3's
 * own models, of which Sorlag reaches furthest.
 */
const PLAYER_FIGURE: Rect = { x: 408, y: 82, width: 216, height: 322 };

/**
 * Model names the pick's skin at x=497 (`ui_playermodel.c:602–624`), on the line of the grid's
 * arrows, whose art's middle is at 385.
 */
const MODEL_CAPTION: TextPlace = { x: 497, y: 385, size: SMALL_SIZE };

/**
 * A grid of pictures, a line of them `columns` across from its first cell's top left, each cell
 * `stepX` right of the last and each line `stepY` under the last. A cell is the box the pointer
 * finds; its picture, the strip under it and its name are placed from the cell's top left. The
 * arrows turn its pages, and the caption is the page's line.
 */
interface Grid {
  readonly x: number;
  readonly y: number;
  readonly columns: number;
  readonly stepX: number;
  readonly stepY: number;
  readonly width: number;
  readonly height: number;
  readonly picture: Rect;
  /** A strip under the picture, for the name to stand on. */
  readonly strip?: Rect;
  /** The middle of the cell's name, where a cell is named. */
  readonly name?: TextPlace;
  readonly previous: Rect;
  readonly next: Rect;
  readonly caption?: TextPlace;
}

/**
 * Model's grid: 64×64 cells, 70 apart from x=50, each icon a little inside its cell, and the halves
 * of `gs_arrows_0`, 128×32, at x 125 and 186 (`ui_playermodel.c:571–656`).
 *
 * The grid and its arrows stand 29 under q3_ui's (50,59) and (125,340), centred down the ring,
 * whose top q3_ui's first line of cells crosses.
 */
const MODEL_GRID: Grid = {
  x: 50,
  y: 88,
  columns: GRID_COLUMNS,
  stepX: 70,
  stepY: 70,
  width: 64,
  height: 64,
  picture: { x: 4, y: 4, width: 56, height: 56 },
  previous: { x: 125, y: 369, width: 61, height: 32 },
  next: { x: 186, y: 369, width: 64, height: 32 },
  caption: MODEL_CAPTION
};

/**
 * Start Server's grid (`ui_startserver.c:435–503`): two across, 136 apart from x=188. Each map's
 * box is 128×128, its levelshot 128×96 at its top, and the strip under it 28 high with the name 4
 * down from its top. The arrows' halves stand at x 260 and 321, 64 across, and the chosen map's name
 * at (320,440) in the big font.
 *
 * The grid starts at y=84, 12 over q3_ui's 96, so that the game type's row and the arrows fit under
 * it inside the panel: q3_ui's arrows, at y=400, cross the ring's foot.
 */
const START_SERVER_GRID: Grid = {
  x: 188,
  y: 84,
  columns: 2,
  stepX: 136,
  stepY: 136,
  width: 128,
  height: 128,
  picture: { x: 0, y: 0, width: 128, height: 96 },
  strip: { x: 0, y: 96, width: 128, height: 28 },
  name: { x: 64, y: 96 + 4 + ROW_HEIGHT / 2, size: CHAR_SIZE },
  previous: { x: 260, y: 377, width: 64, height: BUTTON_HEIGHT },
  next: { x: 321, y: 377, width: 64, height: BUTTON_HEIGHT },
  caption: { x: 320, y: 440 + PROP_HEIGHT / 2, size: BIG_SIZE }
};

/**
 * Bot select's grid (`ui_startserver.c:1869–1935`): four by four from (180,80), 70 across and 86
 * down. Each portrait is 64×64, the box the pointer finds, with the bot's name centred under it at
 * (x+32, y+64). The arrows' halves stand at (260,440) and (321,440), 64×32.
 */
const BOT_SELECT_GRID: Grid = {
  x: 180,
  y: 80,
  columns: 4,
  stepX: 70,
  stepY: 64 + ROW_HEIGHT + 6,
  width: 64,
  height: 64,
  picture: { x: 0, y: 0, width: 64, height: 64 },
  name: { x: 32, y: 64 + ROW_HEIGHT / 2, size: CHAR_SIZE },
  previous: { x: 260, y: 440, width: 64, height: 32 },
  next: { x: 321, y: 440, width: 64, height: 32 }
};

/**
 * Server Options' map (`ui_startserver.c:1009–1034, 1265–1272`): its levelshot 160×120 at (352,80),
 * and a 40-high strip under it, with the name and the game type a line apart, from 4 down.
 */
const MAP_PICTURE: PicturePlace = {
  picture: { x: 352, y: 80, width: 160, height: 120 },
  strip: { x: 352, y: 200, width: 160, height: 40 },
  lines: [
    { x: 432, y: 204 + ROW_HEIGHT / 2, size: CHAR_SIZE },
    { x: 432, y: 220 + ROW_HEIGHT / 2, size: CHAR_SIZE }
  ]
};

/** A row of Server Options' left column, at `x`, with q3_ui's hit box from `left` to `right`. */
function slotRow(x: number, y: number, left: number, right: number): PlacedItem {
  return {
    bar: { x: left, y, width: right - left, height: ROW_HEIGHT },
    text: { kind: 'row', x, size: CHAR_SIZE },
    fit: ROW_MARGIN
  };
}

/**
 * Server Options' left column (`ui_startserver.c:1362–1410`), by the names its page gives the
 * items, each bar q3_ui's hit box (`SpinControl_Init`, `ui_qmenu.c`):
 * - `skill`: Bot Skill, at (128,80);
 * - `type n`, `name n` and `team n`: slot n's type, name and side, at x 32, 96 and 240, the slots
 *   20 apart from 112.
 */
const SERVER_OPTIONS_PLACES: ReadonlyMap<string, PlacedItem> = new Map([
  ['skill', slotRow(128, 80, 40, 248)],
  ...Array.from({ length: PLAYER_SLOTS }, (_, n) => {
    const y = 112 + (ROW_HEIGHT + 4) * n;
    return [
      [`type ${n}`, slotRow(32, y, 24, 72)],
      [`name ${n}`, slotRow(96, y, 88, 224)],
      [`team ${n}`, slotRow(240, y, 232, 280)]
    ] as const;
  }).flat()
]);

/**
 * GAME DATA's rows, at x=256 from 172 where CD Key's field stands, each hit box a character inside
 * `cut_frame`, and the line saying a change waits, centred at (320,352) as the status line is
 * centred (`ui_cdkey.c:198–231`).
 */
const GAME_DATA_LEFT = CUT_FRAME.x + CHAR_WIDTH;
const GAME_DATA_ROWS: Rows = {
  x: 256,
  ys: [172],
  step: 18,
  left: GAME_DATA_LEFT,
  right: CUT_FRAME.x + CUT_FRAME.width - CHAR_WIDTH
};
const GAME_DATA_PLACES: ReadonlyMap<string, PlacedItem> = new Map([
  [
    'pending',
    centred(
      { x: GAME_DATA_LEFT, y: 352, width: 2 * (STATUS.x - GAME_DATA_LEFT), height: ROW_HEIGHT },
      CHAR_SIZE,
      ROW_MARGIN
    )
  ]
]);

/** Server Options' status line, "0 = NO LIMIT" at (320,440) (`ServerOptions_StatusBar`). */
const SERVER_OPTIONS_STATUS: TextPlace = { x: 320, y: 440 + ROW_HEIGHT / 2, size: CHAR_SIZE };

/**
 * ARENA SERVERS (`ui_servers2.c:1356–1531`), at q3_ui's places:
 * - The levelshot at (72,80), and the spins at x=320, 16 apart from 80.
 * - ADD TO FAVORITES in q3_ui's corner, across the middle of DELETE's 48-high art at (450,86), and
 *   SERVER INFO under it, a column's step down. Each bar starts where the art does, its text a
 *   margin in: centred, a bar reaches back over the spins' widest values.
 * - The list's 11 rows at (72,192), and its columns at q3_ui's characters, each cut to its width:
 *   the host name 20 across, the map 12, the players 5 and the game 8, a character apart, then the
 *   ping where q3_ui's address type and ping stand, the numbers run right. q3_ui's row runs on
 *   with PunkBuster, which the port hasn't, and the list ends with the ping.
 * - Its arrows beside it, top and bottom, a button's margin clear of it, as q3_ui's art stands
 *   right of its list; each bar from its art's left, as the corner's are.
 * - The count line under the list at q3_ui's 376, centred on the page as the status line under it
 *   is.
 * - SPECIFY, REFRESH and CREATE across the foot between the corners, each over q3_ui's art.
 */
const SERVERS_X = 72;
const SERVERS_LIST_Y = 192;
const SERVERS_LIST_ROWS = 11;
/** Where a cell starts along the list's row, by its character in q3_ui's. */
const cellX = (character: number) => SERVERS_X + ROW_MARGIN + character * CHAR_WIDTH;
const SERVERS_LIST_WIDTH = cellX(56) + ROW_MARGIN - SERVERS_X;
const SERVERS_ARROWS_X = SERVERS_X + SERVERS_LIST_WIDTH + BUTTON_MARGIN;
const SERVERS_LIST_BOTTOM = SERVERS_LIST_Y + SERVERS_LIST_ROWS * ROW_HEIGHT;
const SERVERS_ROWS: Rows = { x: 320, ys: [80], step: ROW_HEIGHT };
const SERVERS_COLUMNS: readonly ListColumn[] = [
  { x: cellX(0), align: 'left', width: 20 * CHAR_WIDTH },
  { x: cellX(21), align: 'left', width: 12 * CHAR_WIDTH },
  { x: cellX(39), align: 'right', width: 5 * CHAR_WIDTH },
  { x: cellX(40), align: 'left', width: 8 * CHAR_WIDTH },
  { x: cellX(56), align: 'right', width: 7 * CHAR_WIDTH }
];
/** A button centred on `x`, its art `width` across, with its top at `y`. */
const buttonAt = (x: number, y: number, width: number) =>
  centred({ x: x - width / 2, y, width, height: BUTTON_HEIGHT }, BUTTON_SIZE, BUTTON_MARGIN);
/** A foot button over q3_ui's 128×64 art at x. */
const footButton = (x: number) => button({ ...BACK_CORNER, x });
/** A button whose bar starts at art's left, across its middle, its text a margin in. */
function leftButton(art: Rect): PlacedItem {
  const { x } = art;
  return {
    bar: { ...art, y: art.y + (art.height - BUTTON_HEIGHT) / 2, height: BUTTON_HEIGHT },
    text: { kind: 'line', x: x + BUTTON_MARGIN, align: 'left', size: BUTTON_SIZE },
    fit: BUTTON_MARGIN
  };
}
/** q3_ui's DELETE art (`ui_servers2.c:1497–1506`). */
const SERVERS_CORNER: Rect = { x: 450, y: 86, width: 96, height: 48 };
const ARENA_SERVERS_PLACES: ReadonlyMap<string, PlacedItem> = new Map([
  ['favorite', leftButton(SERVERS_CORNER)],
  ['info', leftButton({ ...SERVERS_CORNER, y: SERVERS_CORNER.y + MAIN_COLUMN_STEP })],
  [
    'list',
    {
      bar: {
        x: SERVERS_X,
        y: SERVERS_LIST_Y,
        width: SERVERS_LIST_WIDTH,
        height: SERVERS_LIST_BOTTOM - SERVERS_LIST_Y
      },
      text: { kind: 'list', rows: SERVERS_LIST_ROWS, size: CHAR_SIZE, columns: SERVERS_COLUMNS }
    }
  ],
  [
    'up',
    leftButton({
      x: SERVERS_ARROWS_X,
      y: SERVERS_LIST_Y,
      width: BUTTON_HEIGHT,
      height: BUTTON_HEIGHT
    })
  ],
  [
    'down',
    leftButton({
      x: SERVERS_ARROWS_X,
      y: SERVERS_LIST_BOTTOM - BUTTON_HEIGHT,
      width: BUTTON_HEIGHT,
      height: BUTTON_HEIGHT
    })
  ],
  [
    'count',
    centred(
      {
        x: SERVERS_X,
        y: SERVERS_LIST_BOTTOM + 8,
        width: 2 * (STATUS.x - SERVERS_X),
        height: ROW_HEIGHT
      },
      CHAR_SIZE,
      ROW_MARGIN
    )
  ],
  ['specify', footButton(128)],
  ['refresh', footButton(256)],
  ['create', footButton(384)]
]);
const ARENA_SERVERS_PICTURE: PicturePlace = {
  picture: { x: SERVERS_X, y: 80, width: 128, height: 96 },
  strip: null,
  lines: []
};

/**
 * The Server Information box (Team Arena's `serverinfo_popmenu`): 320 across as Team Arena's, and
 * as tall as the screen less a row each end, centred. In it, a panel's padding in:
 * - the title across its top, in the big font as a confirm's question;
 * - the settings, ten rows of the list's 14-in-16, each label ending a character short of the
 *   table's x and each value starting a character past it, as `UI_GetServerStatusInfo` lists a
 *   server's keys;
 * - the board, from under them to over the buttons;
 * - REFRESH and CLOSE at the foot's right, as Team Arena's Refresh and Close stand, each centred
 *   over 88 across.
 */
const INFO_WIDTH = 320;
const INFO_BOX: Rect = {
  x: (SCREEN_WIDTH - INFO_WIDTH) / 2,
  y: ROW_HEIGHT,
  width: INFO_WIDTH,
  height: SCREEN_HEIGHT - 2 * ROW_HEIGHT
};
const INFO_LEFT = INFO_BOX.x + PADDING;
const INFO_RIGHT = INFO_BOX.x + INFO_BOX.width - PADDING;
const INFO_TOP = INFO_BOX.y + PADDING;
const INFO_BUTTONS_Y = INFO_BOX.y + INFO_BOX.height - PADDING - BUTTON_HEIGHT;
const INFO_BUTTON_WIDTH = 88;
/** The settings' rows, and the widest label they give ("Password"), with room to spare. */
const INFO_SETTINGS_ROWS = 10;
const INFO_LABEL_WIDTH = 64;
const INFO_SETTINGS_Y = INFO_TOP + PROP_HEIGHT + CHAR_WIDTH;
const INFO_BOARD_Y = INFO_SETTINGS_Y + INFO_SETTINGS_ROWS * ROW_HEIGHT + CHAR_WIDTH;
const SERVER_INFO: Popup = {
  box: INFO_BOX,
  title: { x: INFO_BOX.x + INFO_BOX.width / 2, y: INFO_TOP + PROP_HEIGHT / 2, size: BIG_SIZE },
  places: new Map([
    ['refresh', buttonAt(INFO_RIGHT - 1.5 * INFO_BUTTON_WIDTH, INFO_BUTTONS_Y, INFO_BUTTON_WIDTH)],
    ['close', buttonAt(INFO_RIGHT - INFO_BUTTON_WIDTH / 2, INFO_BUTTONS_Y, INFO_BUTTON_WIDTH)]
  ]),
  detail: {
    room: {
      x: INFO_LEFT,
      y: INFO_SETTINGS_Y,
      width: INFO_RIGHT - INFO_LEFT,
      height: INFO_BUTTONS_Y - CHAR_WIDTH - INFO_SETTINGS_Y
    },
    settings: {
      x: INFO_LEFT + INFO_LABEL_WIDTH + CHAR_WIDTH,
      y: INFO_SETTINGS_Y + ROW_HEIGHT / 2,
      step: ROW_HEIGHT,
      rows: INFO_SETTINGS_ROWS,
      right: INFO_RIGHT,
      size: CHAR_SIZE
    },
    board: {
      x: INFO_LEFT,
      y: INFO_BOARD_Y,
      width: INFO_RIGHT - INFO_LEFT,
      height: INFO_BUTTONS_Y - CHAR_WIDTH - INFO_BOARD_Y
    }
  }
};

/**
 * SPECIFY SERVER (`ui_specifyserver.c:136–150`): Address and Port at x=206, 30 apart from 220, and
 * the Name the port adds under them; ADD TO FAVORITES across the foot between the corners, as the
 * browser's own buttons stand, so the panel holds the fields alone.
 */
const SPECIFY_ROWS: Rows = { x: 206, ys: [220], step: 30 };
const SPECIFY_PLACES: ReadonlyMap<string, PlacedItem> = new Map([['favorite', footButton(256)]]);

/**
 * A column of buttons centred at `x`, `step` apart, as the main menu's and Setup's are: from `y`, or
 * centred down the page's frame.
 */
interface Column {
  readonly x: number;
  readonly y?: number;
  readonly step: number;
  readonly width: number;
}

/** The main menu's column: 34 apart from 134, centred at 320 (`ui_menu.c`). */
const MAIN_COLUMN: Column = { x: 320, y: 134, step: MAIN_COLUMN_STEP, width: 256 };

/**
 * Setup's column, 34 apart and centred at 320 (`ui_setup.c:186–275`), and centred down the ring:
 * from q3_ui's 134, the port's extra items would run it to the ring's foot.
 */
const SETUP_COLUMN: Column = { x: 320, step: 34, width: 256 };

/**
 * A column of tabs, right-justified at `right` from 186, each bar fitted to its word, and a
 * button's height apart: q3_ui's stand 27 apart, which bars 28 high would overlap. A bar is `width`
 * across until its word is drawn.
 */
interface Tabs {
  readonly right: number;
  readonly width: number;
}

/** Controls' tabs at x=152 (`ui_controls2.c:1225–1263`), and System's at x=216 (`ui_display.c`). */
const CONTROLS_TABS: Tabs = { right: 152, width: 136 };
const SYSTEM_TABS: Tabs = { right: 216, width: 176 };
const TABS_Y = 186;

/**
 * A page's widget rows: at `x`, from the first of `ys` and then `step` apart, each with its hit box
 * from `left` to `right` where it has one of its own.
 */
interface Rows {
  readonly x: number;
  readonly ys: readonly number[];
  readonly step: number;
  readonly left?: number;
  readonly right?: number;
}

/**
 * How each of q3_ui's pages places its items, by the page's id:
 * - the main menu's column, which is Setup's (`ui_menu.c`);
 * - Setup's column (`ui_setup.c`);
 * - Player's rows, each label over its value, at x=192 from 144, 81 apart (`ui_playersettings.c`);
 * - Model's grid, and its arrows (`ui_playermodel.c`);
 * - Controls' tabs, and each section's rows centred on the screen, 16 apart (`ui_controls2.c`);
 * - System's tabs, and its rows at x=400: Graphics' from 168, where its GL Driver stands,
 *   Display's from 222, Sound's from 213, 18 apart (`ui_video.c`, `ui_display.c`, `ui_sound.c`);
 * - Game Options' rows at x=360, from 144 (`ui_preferences.c`);
 * - Start Server's grid, and its game type's row under it, across the grid and split at q3_ui's
 *   x=296; Server Options' map, its slots
 *   by name, and its other rows at x=456 from 272; Bot Select's grid, with no frame
 *   (`ui_startserver.c`);
 * - GAME DATA's rows in `cut_frame`, where CD Key's stand (`ui_cdkey.c`);
 * - ARENA SERVERS' spins, levelshot, list and arrows, by name (`ui_servers2.c`), and SPECIFY
 *   SERVER's fields (`ui_specifyserver.c`).
 *
 * A grid's other items, where it has no rows, go under its arrows.
 */
type Rule = (
  | { readonly kind: 'column'; readonly column: Column }
  | { readonly kind: 'player' }
  | { readonly kind: 'grid'; readonly grid: Grid; readonly rows?: Rows }
  | { readonly kind: 'rows'; readonly rows: Rows | 'centred'; readonly tabs?: Tabs }
  /** Each item with a place by name where the names say, and the rest in rows. */
  | { readonly kind: 'named'; readonly places: ReadonlyMap<string, PlacedItem>; readonly rows: Rows }
) & {
  readonly picture?: PicturePlace;
  /** Where the status line stands, if not under the frame. */
  readonly status?: TextPlace;
  /** The frame's panel: `null` where q3_ui draws no frame, and the ring's where none is given. */
  readonly frame?: Rect | null;
};

const RULES: Readonly<Record<string, Rule>> = {
  main: { kind: 'column', column: MAIN_COLUMN },
  setup: { kind: 'column', column: SETUP_COLUMN },
  player: { kind: 'player' },
  model: { kind: 'grid', grid: MODEL_GRID },
  controls: { kind: 'rows', rows: 'centred', tabs: CONTROLS_TABS },
  'system.graphics': { kind: 'rows', rows: { x: 400, ys: [168], step: 18 }, tabs: SYSTEM_TABS },
  'system.display': { kind: 'rows', rows: { x: 400, ys: [222], step: 18 }, tabs: SYSTEM_TABS },
  'system.sound': { kind: 'rows', rows: { x: 400, ys: [213], step: 18 }, tabs: SYSTEM_TABS },
  // Data Rate, at 240 - 18 (`ui_network.c:209–217`).
  'system.network': { kind: 'rows', rows: { x: 400, ys: [222], step: 18 }, tabs: SYSTEM_TABS },
  // The crosshair's row stands taller than the rest, and Marks on Walls only 16 under the row above
  // it (`ui_preferences.c:255–299`).
  options: { kind: 'rows', rows: { x: 360, ys: [144, 166, 182], step: 18 } },
  startserver: {
    kind: 'grid',
    grid: START_SERVER_GRID,
    // The game type's row, 8 under the tiles as q3_ui's, and as wide as the grid.
    rows: {
      x: 296,
      ys: [START_SERVER_GRID.y + START_SERVER_GRID.stepY + START_SERVER_GRID.height + 8],
      step: 18,
      left: START_SERVER_GRID.x,
      right: START_SERVER_GRID.x + START_SERVER_GRID.stepX + START_SERVER_GRID.width
    }
  },
  serveroptions: {
    kind: 'named',
    places: SERVER_OPTIONS_PLACES,
    rows: { x: 456, ys: [272], step: 18 },
    picture: MAP_PICTURE,
    status: SERVER_OPTIONS_STATUS
  },
  botselect: { kind: 'grid', grid: BOT_SELECT_GRID, frame: null },
  gamedata: { kind: 'named', places: GAME_DATA_PLACES, rows: GAME_DATA_ROWS, frame: CUT_FRAME },
  arenaservers: {
    kind: 'named',
    places: ARENA_SERVERS_PLACES,
    rows: SERVERS_ROWS,
    picture: ARENA_SERVERS_PICTURE
  },
  specifyserver: { kind: 'named', places: SPECIFY_PLACES, rows: SPECIFY_ROWS }
};

/** A page with no rule of its own, by its layout: a column, widget rows, or a grid. */
function fallback(page: MenuPage): Rule {
  switch (page.layout ?? 'list') {
    case 'form':
      return { kind: 'rows', rows: { x: 320, ys: [134], step: 18 }, tabs: CONTROLS_TABS };
    case 'grid':
      return { kind: 'grid', grid: MODEL_GRID };
    default:
      return { kind: 'column', column: MAIN_COLUMN };
  }
}

/**
 * The corner or arrow an item's role puts it in, or `null` for one with none. The arrows are the
 * grid's, or Model's on a page with none.
 */
function byRole(item: MenuItem, grid: Grid = MODEL_GRID): PlacedItem | null {
  switch (item.role) {
    case 'back':
      return button(BACK_CORNER);
    case 'forward':
      return button(FORWARD_CORNER);
    case 'previous':
      return button(grid.previous, '<');
    case 'next':
      return button(grid.next, '>');
    default:
      return null;
  }
}

/** A button across the middle of q3_ui's art for it, reading its label, or `glyph` in its place. */
function button(art: Rect, glyph?: string): PlacedItem {
  const bar = { ...art, y: art.y + (art.height - BUTTON_HEIGHT) / 2, height: BUTTON_HEIGHT };
  return centred(bar, BUTTON_SIZE, BUTTON_MARGIN, glyph);
}

/** A rectangle moved by a point. */
function offset(rect: Rect, x: number, y: number): Rect {
  return { ...rect, x: rect.x + x, y: rect.y + y };
}

/** The `index`th cell of a grid. */
function gridCell(grid: Grid, index: number): PlacedItem {
  const x = grid.x + grid.stepX * (index % grid.columns);
  const y = grid.y + grid.stepY * Math.floor(index / grid.columns);
  const { strip, name } = grid;
  return {
    bar: { x, y, width: grid.width, height: grid.height },
    text: {
      kind: 'cell',
      picture: offset(grid.picture, x, y),
      strip: strip ? offset(strip, x, y) : null,
      name: name ? { ...name, x: x + name.x, y: y + name.y } : null
    }
  };
}

/** A line centred on its bar, reading its label, or `glyph` in its place, the bar fitted to it. */
function centred(bar: Rect, size: number, fit: number, glyph?: string): PlacedItem {
  const text = { kind: 'line', x: bar.x + bar.width / 2, align: 'centre', size } as const;
  return { bar, text: glyph === undefined ? text : { ...text, glyph }, fit };
}

/** The y of the `index`th row: from the listed places, then on at the step. */
function rowY(rows: Rows, index: number): number {
  const { ys, step } = rows;
  return index < ys.length ? ys[index] : ys[ys.length - 1] + (index - ys.length + 1) * step;
}

/** A widget's row, its bar reaching either side of `x`. */
function widgetRow(x: number, y: number): PlacedItem {
  return {
    bar: { x: x - ROW_REACH, y, width: 2 * ROW_REACH, height: ROW_HEIGHT },
    text: { kind: 'row', x, size: CHAR_SIZE },
    fit: ROW_MARGIN
  };
}

/** The `index`th of a page's widget rows, with their own hit box where they have one. */
function nthRow(rows: Rows, index: number): PlacedItem {
  const y = rowY(rows, index);
  const { left, right } = rows;
  return left !== undefined && right !== undefined ? slotRow(rows.x, y, left, right) : widgetRow(rows.x, y);
}

/** Place a page's items by its rule, in its frame. */
function placeItems(page: MenuPage, rule: Rule, frame: Rect | null): PlacedItem[] {
  const { items } = page;
  // Each group counts its own, so an item q3_ui lacks takes its group's next place.
  let tab = 0;
  let cell = 0;
  let row = 0;
  const rowCount = items.filter((item) => !item.role && item.tab === undefined && !item.cell).length;
  const grid = rule.kind === 'grid' ? rule.grid : undefined;
  return items.map((item): PlacedItem => {
    const role = byRole(item, grid);
    if (role) return role;
    if (item.tab !== undefined) {
      const { right, width } = rule.kind === 'rows' ? (rule.tabs ?? CONTROLS_TABS) : CONTROLS_TABS;
      return {
        bar: { x: right - width, y: TABS_Y + BUTTON_HEIGHT * tab++, width, height: BUTTON_HEIGHT },
        text: { kind: 'line', x: right, align: 'right', size: BUTTON_SIZE },
        fit: BUTTON_MARGIN
      };
    }
    if (item.cell) return gridCell(grid ?? MODEL_GRID, cell++);
    const named = rule.kind === 'named' && item.place !== undefined ? rule.places.get(item.place) : undefined;
    if (named) return named;
    const index = row++;
    switch (rule.kind) {
      case 'column': {
        const { x, step, width } = rule.column;
        const within = frame ?? RING;
        const top = rule.column.y ?? within.y + (within.height - step * (rowCount - 1) - BUTTON_HEIGHT) / 2;
        return {
          bar: { x: x - width / 2, y: top + step * index, width, height: BUTTON_HEIGHT },
          text: { kind: 'line', x, align: 'centre', size: BUTTON_SIZE },
          fit: BUTTON_MARGIN
        };
      }
      case 'player': {
        // The label at x=192 and the value under it at 256, 27 lower (`ui_playersettings.c:387–413`),
        // the bar fitted to the two, and q3_ui's hit box, 184 to 392, until they are drawn.
        const y = 144 + 81 * index;
        return {
          bar: { x: 184, y, width: 208, height: 2 * PROP_HEIGHT - 6 },
          text: {
            kind: 'stacked',
            x: 192,
            labelSize: SMALL_SIZE,
            valueX: 256,
            valueY: y + PROP_HEIGHT,
            size: CHAR_SIZE
          },
          fit: CHAR_WIDTH
        };
      }
      case 'grid': {
        if (rule.rows) return nthRow(rule.rows, index);
        const { x, y } = rule.grid.previous;
        const bar = { x, y: y + 40 + PROP_HEIGHT * index, width: 128, height: PROP_HEIGHT };
        return centred(bar, SMALL_SIZE, BUTTON_MARGIN);
      }
      case 'named':
        return nthRow(rule.rows, index);
      case 'rows': {
        if (rule.rows !== 'centred') return nthRow(rule.rows, index);
        // Controls' sections, each centred on the screen: y₀ = (480 − 16n) / 2
        // (`ui_controls2.c:578–588`).
        const top = (480 - ROW_HEIGHT * rowCount) / 2;
        return widgetRow(320, top + ROW_HEIGHT * index);
      }
    }
  });
}

/** The top of a confirm's answers (`ui_confirm.c:212–223`). */
const ANSWERS_Y = 264;

/**
 * A confirm: the question at (320,204), YES and NO as buttons from y=264 either side of the
 * middle, and a warning, its lines 27 apart, all in `cut_frame` (`ui_confirm.c:147, 212–223`;
 * `ui_setup.c:93–96`). The warning starts a button's margin under the answers: q3_ui's, from
 * y=356, runs over the ring's foot.
 */
function placeConfirm(page: MenuPage): PagePlacement {
  const answer = (index: number): PlacedItem => {
    const x = 320 + (index - (page.items.length - 1) / 2) * 88;
    return centred({ x: x - 40, y: ANSWERS_Y, width: 80, height: BUTTON_HEIGHT }, BUTTON_SIZE, BUTTON_MARGIN);
  };
  return {
    frame: CUT_FRAME,
    band: SCREEN_BAND,
    figure: null,
    title: { x: 320, y: 204 + PROP_HEIGHT / 2, size: BIG_SIZE },
    items: page.items.map((_, index) => answer(index)),
    status: STATUS,
    preview: null,
    caption: null,
    picture: null,
    detail: null,
    warning: {
      x: 320,
      y: ANSWERS_Y + BUTTON_HEIGHT + BUTTON_MARGIN,
      size: SMALL_SIZE,
      width: CUT_FRAME.width - 2 * CHAR_WIDTH,
      lineHeight: PROP_HEIGHT
    },
    message: null
  };
}

/** The whole screen down, for a page with no banner over its panel and no buttons under it. */
const SCREEN_BAND = { top: 0, bottom: 480 };

/** A popup: its box, its title, each of its items by its place, and its detail. */
interface Popup {
  readonly box: Rect;
  readonly title: TextPlace;
  readonly places: ReadonlyMap<string, PlacedItem>;
  readonly detail: DetailPlace;
}

/** The popups, by their pages' ids. */
const POPUPS: Readonly<Record<string, Popup>> = { serverinfo: SERVER_INFO };

/**
 * A popup in its box, drawn where it is placed over the page it was opened from: every one of its
 * items has a place by name.
 */
function placePopup(page: MenuPage): PagePlacement {
  const popup = POPUPS[page.id ?? ''];
  if (!popup) throw new Error(`No box for the popup ${page.id}`);
  return {
    frame: popup.box,
    band: SCREEN_BAND,
    figure: null,
    title: popup.title,
    items: page.items.map((item) => {
      const place = popup.places.get(item.place ?? '');
      if (!place) throw new Error(`No place in the popup ${page.id} for ${item.label}`);
      return place;
    }),
    status: STATUS,
    preview: null,
    caption: null,
    picture: null,
    detail: popup.detail,
    warning: null,
    message: null
  };
}

/** Under the banner, and over the corner buttons where the page has them, or else the screen's foot. */
function bandOf(page: MenuPage): PagePlacement['band'] {
  const cornered = page.items.some((item) => item.role === 'back' || item.role === 'forward');
  return { top: BANNER.y + BANNER.size / 2, bottom: cornered ? button(BACK_CORNER).bar.y : SCREEN_BAND.bottom };
}

/** Where a page's items stand in q3_ui's placement. */
export function placePage(page: MenuPage): PagePlacement {
  if (page.layout === 'confirm') return placeConfirm(page);
  if (page.layout === 'popup') return placePopup(page);
  const rule = (page.id !== undefined ? RULES[page.id] : undefined) ?? fallback(page);
  const pictured = page.preview !== undefined;
  const main = page.id !== undefined && MAIN_SCREENS.has(page.id);
  const frame = main ? null : rule.frame === undefined ? RING : rule.frame;
  return {
    frame,
    band: frame ? bandOf(page) : SCREEN_BAND,
    figure: pictured ? PLAYER_FIGURE : null,
    title: main ? LOGO : BANNER,
    items: placeItems(page, rule, frame),
    status: rule.status ?? STATUS,
    preview: pictured ? PLAYER_PREVIEW : null,
    caption: rule.kind === 'grid' ? (rule.grid.caption ?? null) : pictured ? MODEL_CAPTION : null,
    picture: rule.picture ?? null,
    detail: null,
    warning: null,
    message: main ? ERROR_MESSAGE : null
  };
}
