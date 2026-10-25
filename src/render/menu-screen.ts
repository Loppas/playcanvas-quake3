import {
  Color,
  ELEMENTTYPE_GROUP,
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
  type ElementMouseEvent,
  type Texture
} from 'playcanvas';

import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../view/hud-layout';
import type {
  ColoredText,
  Menu,
  MenuItem,
  MenuPage,
  MenuPlacement,
  PageDetail,
  Pointer
} from '../view/menu';
import { GRID_COLUMNS } from '../view/menu-models';
import {
  BUTTON_HEIGHT,
  BUTTON_SIZE,
  CHAR_SIZE,
  CHAR_WIDTH,
  PADDING,
  placePage,
  type PagePlacement,
  type PicturePlace,
  type PlacedItem,
  type Rect,
  type TablePlace,
  type TextPlace,
  type WrappedText
} from '../view/menu-placement';
import type { PlayerLook } from '../view/player-model';
import type { Scoreboard } from '../view/scoreboard';
import { createMenuFont, textWidth, type MenuFont } from './menu-font';

/**
 * The menu on screen: the page on top of the stack, in PlayCanvas UI and
 * the port's own style, with no Quake art or fonts. `view/menu.ts` decides everything; this draws
 * it, and tells it where the pointer is.
 *
 * The screen is Q3's 640×480 grid, scaled by the height as the HUD's is. The text is a system face,
 * drawn into an atlas at start (`menu-font.ts`). The page dims the game without hiding it, so a
 * setting shows its change as it is made; with no game under it, it is opaque.
 *
 * A menu opened in the `q3ui` placement puts each item where q3_ui does, on a 640×480 box in the
 * middle of the screen, with the port's panel where q3_ui draws its frame (`view/menu-placement.ts`).
 * A menu opened `centred` stands its page in a panel in the middle, sized to it:
 *
 * - A column page draws its items in the middle; a confirm, its answers side by side under the
 *   question, and a warning under them.
 * - A settings page draws each row's label on the left and its value on the right: a slider's
 *   bar and thumb, or a picture where the value has one. A value given in colours, as the Player
 *   page's name is, draws a text for each colour while the cursor is off it. Its tabs make a strip
 *   across its head.
 * - A page laid out for more rows than it has keeps their room, above its last item, so that its
 *   sections share one panel.
 * - The Model page draws its cells as a grid of icons, four across, over its other items, with the
 *   picked model's underlined. In q3_ui's placement a grid's cell may be named under its picture,
 *   on a strip as Start Server names its maps, or with none as Bot Select names its bots.
 * - An item may give its label a colour of its own, as Bot Select reds a bot already chosen.
 * - A page with a preview stands left of the middle. {@link MenuScreen.previewView} says where the
 *   player's model stands, right of it, and the page's caption is written under that.
 * - The item at the cursor has a bar lit behind it, and its status line under the page.
 * - A typed field's value keeps the room its `widthInChars` gives it, whatever it holds, and is
 *   drawn scrolled within it to keep its cursor shown. The cursor stands over the text.
 * - A popup stands in its box over the page it was opened from, which is drawn dimmed under it
 *   and takes no pointer. The Server Information box holds a table of settings and a board, which
 *   {@link MenuScreen.boardView} gives the board's own screen.
 *
 * The menu draws in a layer of its own, from a camera after the HUD's, enabled only while the menu
 * is up. The pointer finds the items through the app's `ElementInput`; clicks come through the
 * keys, as `MOUSE1`, the way q3_ui takes them (`key-input.ts`).
 */

/** A status line's room at the foot of a panel on q3_ui's box: a row of its 16-high characters. */
const STATUS_LINE = 16;

/** The menu's camera, after the eye's: the view weapon's is +1, the 3D icons' +2 and the HUD's +3. */
export const MENU_CAMERA_PRIORITY = 4;

/** The pages' widths on the 640×480 grid: a column of items, a settings page, and a confirm. */
const LIST_WIDTH = 300;
const FORM_WIDTH = 440;
const CONFIRM_WIDTH = 360;
/**
 * A column page's rows, each a button, `INGAME_MENU_VERTICAL_SPACING` apart (`ui_ingame.c:37`), and
 * a settings page's closer ones, so Controls' Shoot section fits the grid.
 */
const ROW_HEIGHT = BUTTON_HEIGHT;
const FORM_ROW_HEIGHT = 22;
const TEXT_SIZE = BUTTON_SIZE;
const FORM_TEXT_SIZE = 15;
/** How far a row's label and value keep in from its ends. */
const INSET = 12;
const TITLE_SIZE = 22;
const TITLE_HEIGHT = 36;
/** The gap under a strip of tabs, or a grid of cells. */
const TAB_GAP = 8;
/** A confirm's answers, each this wide, and its warning's line under them. */
const ANSWER_WIDTH = 96;
const WARNING_SIZE = 13;
const WARNING_HEIGHT = 26;
/** The status line, just under the page. */
const STATUS_SIZE = 13;
const STATUS_GAP = 10;
/** A slider's bar, from just right of a row's middle to short of its number, and its thumb. */
const TRACK_LEFT = 16;
const TRACK_RIGHT = 64;
const TRACK_HEIGHT = 4;
const THUMB_WIDTH = 8;
const THUMB_HEIGHT = 16;
/** A value's picture: 24 across, as `Crosshair_Draw` draws the crosshair (`ui_preferences.c:213`). */
const ICON_SIZE = 24;
/** A value's colour: a bar, as the Effects spin control draws one (`ui_playersettings.c:223–224`). */
const SWATCH_WIDTH = 40;
const SWATCH_HEIGHT = 12;
/** A field's cursor: a line as high as its text's size, over the text. */
const CARET_WIDTH = 1;
/** The Model page's cells, as q3_ui's grid spaces them (`ui_playermodel.c:571–604`), and the icon inside each. */
const CELL_SIZE = 64;
const CELL_GAP = 6;
const CELL_INSET = 4;
/** The line under the picked model's cell. */
const PICK_HEIGHT = 3;
/** A page beside a preview: as wide as the grid, and left of the middle. */
const BESIDE_WIDTH = GRID_COLUMNS * CELL_SIZE + (GRID_COLUMNS - 1) * CELL_GAP + 2 * PADDING;
const BESIDE_X = -160;
/** The preview's box, its middle right of the screen's, and the caption under it. */
const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 400;
const PREVIEW_X = 150;
const CAPTION_SIZE = 15;
const CAPTION_GAP = 14;
/**
 * A widget's row in q3_ui's placement: the label ends a character short of the row's x and the
 * value starts a character past it, and a slider's bar is 96 across (`Slider_Draw`, `ui_qmenu.c`).
 */
const CHAR_GAP = 8;
const SLIDER_BAR = 96;

/** Q3's orange for the accent, over a dark panel, and a warning in Q3's yellow, softened. */
const ACCENT = new Color(1, 0.55, 0.12);
const PANEL = new Color(0.07, 0.07, 0.09);
const WARNING = new Color(1, 0.85, 0.3);
const BLACK = new Color(0, 0, 0);
const WHITE = new Color(1, 1, 1);

/** How far the page dims the game, how solid its panel is, the cursor's bar, and a slider's bar. */
const BACKDROP_OPACITY = 0.55;
const PANEL_OPACITY = 0.92;
const BAR_OPACITY = 0.28;
const TRACK_OPACITY = 0.3;
/** Text: the cursor's at full, the rest at 70% as q3_ui draws them (`ui_qmenu.c:224–231`), greyed dim. */
const TEXT_FOCUSED = 1;
const TEXT_IDLE = 0.7;
const TEXT_GRAYED = 0.3;
const STATUS_OPACITY = 0.8;

/** Scratch for a swatch's or a label's colour, which the engine copies. */
const tint = new Color();

/**
 * A box on q3_ui's screen, centred on a canvas and scaled by its height, cut to the part on the
 * canvas, since a viewport may not run off its target as q3_ui's box runs off the screen: that
 * part as a camera's viewport, and which part of the box it is, from the box's bottom left. `null`
 * for a box wholly off the canvas.
 *
 * @param width - The canvas's size, in pixels.
 */
export function boxOnScreen(
  box: Rect,
  width: number,
  height: number
): Pick<PreviewView, 'rect'> & Required<Pick<PreviewView, 'window'>> | null {
  const unit = height / SCREEN_HEIGHT;
  const left = (width - SCREEN_WIDTH * unit) / 2 + box.x * unit;
  const top = box.y * unit;
  const across = box.width * unit;
  const down = box.height * unit;
  const [l, r] = [Math.max(0, left), Math.min(width, left + across)];
  const [t, b] = [Math.max(0, top), Math.min(height, top + down)];
  if (!(r > l && b > t)) return null;
  return {
    rect: [l / width, (height - b) / height, (r - l) / width, (b - t) / height],
    window: [(l - left) / across, (top + down - b) / down, (r - left) / across, (top + down - t) / down]
  };
}

/** A typed field's room: its `widthInChars` of q3_ui's cells, and one for the cursor. */
function fieldRoom(item: MenuItem): number {
  return item.widthInChars === undefined ? 0 : (item.widthInChars + 1) * CHAR_WIDTH;
}

/**
 * The part of a field's text shown in its room, by where it starts and ends. It starts where it
 * last did, moved as little as keeps the cursor shown, and back while the rest of the text would
 * leave room, as `MField_Draw` pulls its scroll back; it ends at the last whole character that
 * fits. With no cursor, it starts at the text's start.
 *
 * @param width - How wide a text is drawn.
 */
export function fieldWindow(
  text: string,
  caret: number | undefined,
  from: number,
  room: number,
  width: (text: string) => number
): { start: number; end: number } {
  let start = caret === undefined ? 0 : Math.min(from, caret);
  if (caret !== undefined) {
    while (start < caret && width(text.slice(start, caret)) > room) start++;
  }
  while (start > 0 && width(text.slice(start - 1)) <= room) start--;
  let end = start;
  while (end < text.length && width(text.slice(start, end + 1)) <= room) end++;
  return { start, end };
}

/** A value's runs of colour, cut after the last whole character that fits `room`. */
function cutRuns(
  runs: readonly ColoredText[],
  room: number,
  width: (text: string) => number
): ColoredText[] {
  const plain = runs.map((run) => run.text).join('');
  let { end } = fieldWindow(plain, undefined, 0, room, width);
  const cut: ColoredText[] = [];
  for (const run of runs) {
    if (end <= 0) break;
    cut.push({ ...run, text: run.text.slice(0, end) });
    end -= run.text.length;
  }
  return cut;
}

/** Which way a line of text runs from where it is put. */
type Align = 'left' | 'centre' | 'right';

/** A box on q3_ui's screen by its edges, down from the top. */
interface Extent {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A box that holds nothing yet, which {@link grow} widens. */
function emptyExtent(): Extent {
  return { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
}

/** Widen a box to hold another. */
function grow(extent: Extent, by: Extent): void {
  extent.left = Math.min(extent.left, by.left);
  extent.top = Math.min(extent.top, by.top);
  extent.right = Math.max(extent.right, by.right);
  extent.bottom = Math.max(extent.bottom, by.bottom);
}

/** A bar's box on its parent, from the middle it hangs by. */
function barExtent(bar: Entity): Extent {
  const { x, y } = bar.getLocalPosition();
  const { width, height } = bar.element!;
  return { left: x - width / 2, top: -y - height / 2, right: x + width / 2, bottom: -y + height / 2 };
}

/** Whether a point stands inside a rectangle. */
function inside(rect: Rect, x: number, y: number): boolean {
  return x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height;
}

/** Where a cell's picture stands: its middle, from the cell's, and its size. */
interface CellPicture {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A page's table of settings on q3_ui's box: a label and a value a row, where they stand. */
interface Table {
  group: Entity;
  place: TablePlace;
  labels: Entity[];
  values: Entity[];
}

/** Where a page's board draws: its box on q3_ui's screen, and the board. */
export interface BoardView {
  box: Rect;
  board: Scoreboard;
}

/** A page's picture on q3_ui's box: the image, and the texts on the strip under it. */
interface Picture {
  group: Entity;
  image: Entity;
  lines: Entity[];
}

/** A popup on screen: its page, its placement, and its box with all it holds. */
interface Popup {
  page: MenuPage;
  placement: PagePlacement;
  group: Entity;
  rows: Row[];
  table: Table | null;
}

/** An item's row. */
interface Row {
  /** The bar the pointer finds and the cursor lights. */
  bar: Entity;
  /** What it reads; a cell reads its name, or nothing, its icon saying which model it is. */
  label: Entity | null;
  /** A settings row's value, and the picture or colour drawn in its place. */
  value: Entity | null;
  /** The picture drawn for a settings row's value, or a cell's icon. */
  icon: Entity | null;
  swatch: Entity | null;
  /** A cell's line, under the picked model. */
  pick: Entity | null;
  /** A slider's thumb, and its bar: from the row's middle, and how long. */
  thumb: Entity | null;
  track: { left: number; width: number } | null;
  /** A settings row's value drawn in colours: a text for each run, made as the runs first need them. */
  runs: Entity[];
  /** A field's cursor, over its value, and where the part of its text shown starts. */
  caret: Entity | null;
  scroll: number;
  /** Its text's size, and which way its value runs from where it is put. */
  size: number;
  valueAlign: Align;
  /** What it reads in its label's place: an arrow, where q3_ui draws one. */
  glyph?: string;
  /** For a bar fitted to what it shows, the margin it keeps round it. */
  fit?: number;
  /** Whether it stands across where the status line does. */
  withStatus?: true;
  /** A scrolled list's rows, each with the bar that lights it and a text for each column. */
  lines?: ListLine[];
}

/** A row of a scrolled list on the screen. */
interface ListLine {
  bar: Entity;
  cells: { text: Entity; width: number }[];
}

/** Where a row goes on the panel, and what it holds. */
interface RowShape {
  /** Its middle, from the panel's. */
  x: number;
  /** Its top, down from the panel's. */
  top: number;
  width: number;
  height: number;
  /** The label on the left and the value on the right, as a settings row has them. */
  split?: boolean;
  /** A slider's. */
  sliding?: boolean;
  /** A cell of the grid: an icon, and the pick's line. */
  cell?: boolean;
}

/** Where a page's player preview draws, and whom it shows. */
export interface PreviewView {
  /** The box as a camera's viewport: its left, its bottom, its width and its height, each a fraction of the screen's. */
  rect: readonly [number, number, number, number];
  /** Its size on the 640×480 grid, which the view is framed by. */
  width: number;
  height: number;
  /**
   * The part of the box on the screen, where the box runs off it, as q3_ui's does: its left, bottom,
   * right and top, each a fraction of the box from its bottom left. The whole box when absent.
   */
  window?: readonly [number, number, number, number];
  look: PlayerLook;
}

export interface MenuScreenOptions {
  /**
   * The font, a system face by default. `null` draws the text with none, for a device with no
   * canvas to draw a font on: each line still carries its string.
   */
  font?: MenuFont | null;
}

/** The menu's screen, and the camera that draws it. */
export class MenuScreen {
  /**
   * The pictures a value or a cell draws, by shader name: the HUD's crosshairs and the models'
   * icons. `null` from it for one that has not loaded.
   */
  images: ((name: string) => Texture | null) | null = null;
  /**
   * Whether the page hides what is under it, as q3_ui's full-screen menus do: with no match there is
   * no game to dim.
   */
  opaque = false;

  private readonly app: AppBase;
  private readonly menu: Menu;
  private readonly font: MenuFont | null;
  private readonly layer: Layer;
  private readonly camera: Entity;
  private readonly screen: Entity;
  private readonly backdrop: Entity;
  private readonly panel: Entity;
  private readonly title: Entity;
  private readonly warning: Entity;
  private readonly status: Entity;
  private readonly caption: Entity;
  /** q3_ui's 640×480 box, and what stands on it besides the rows. */
  private readonly box: Entity;
  private readonly frame: Entity;
  private readonly banner: Entity;
  private readonly boxWarning: Entity;
  private readonly boxMessage: Entity;
  private readonly boxStatus: Entity;
  private readonly boxCaption: Entity;
  /** What stands in the page's panel on the box, moved with it. */
  private readonly content: Entity;
  /** The page's placement on the box, and how far its panel is moved, fixed at its first frame. */
  private placement: PagePlacement | null = null;
  private shift: { x: number; y: number } | null = null;
  /** What a tabbed page's other tabs hold in its panel, and their widest status. */
  private sections: { held: Extent; widest: number } | null = null;
  /** Whether the placement gives the page's caption a place. */
  private captioned = false;
  private picture: Picture | null = null;
  private rows: Row[] = [];
  /** What dims the page under a popup and takes the pointer from it, and the popups' layer. */
  private readonly popupDim: Entity;
  private readonly overlay: Entity;
  private popup: Popup | null = null;
  /** The page the rows were laid out for, and how. */
  private shown: MenuPage | null = null;
  private shownPlacement: MenuPlacement = 'centred';
  /** Where its panel stands, and its rows' height and text size, in the centred placement. */
  private panelX = 0;
  private rowHeight = ROW_HEIGHT;
  private textSize = TEXT_SIZE;
  private destroyed = false;

  /** @param eye - The camera the world is seen through; the menu draws after it. */
  constructor(app: AppBase, eye: Entity, menu: Menu, options: MenuScreenOptions = {}) {
    this.app = app;
    this.menu = menu;
    this.font = options.font === undefined ? createMenuFont(app) : options.font;

    this.layer = new Layer({ name: 'menu', transparentSortMode: SORTMODE_MANUAL });
    app.scene.layers.push(this.layer);

    this.camera = new Entity('menu-camera');
    this.camera.addComponent('camera', {
      layers: [this.layer.id],
      clearColorBuffer: false,
      clearDepthBuffer: false,
      priority: eye.camera!.priority + MENU_CAMERA_PRIORITY,
      // Encoded as the eye's is, so the menu blends over the game in display space.
      gammaCorrection: GAMMA_SRGB,
      toneMapping: TONEMAP_LINEAR
    });
    this.camera.enabled = false;
    app.root.addChild(this.camera);

    this.screen = new Entity('menu');
    this.screen.addComponent('screen', {
      screenSpace: true,
      referenceResolution: new Vec2(SCREEN_WIDTH, SCREEN_HEIGHT),
      scaleMode: SCALEMODE_BLEND,
      // Scaled by the height alone, as the HUD is.
      scaleBlend: 1
    });
    this.screen.enabled = false;
    app.root.addChild(this.screen);

    // The game, dimmed, over the whole screen.
    this.backdrop = this.image(this.screen, 'menu-backdrop', new Vec4(0, 0, 1, 1));
    this.backdrop.element!.margin = new Vec4(0, 0, 0, 0);
    this.backdrop.element!.color = BLACK;
    this.backdrop.element!.opacity = BACKDROP_OPACITY;

    this.panel = this.image(this.screen, 'menu-panel', new Vec4(0.5, 0.5, 0.5, 0.5));
    this.panel.element!.color = PANEL;
    this.panel.element!.opacity = PANEL_OPACITY;
    this.title = this.text(this.panel, 'menu-title', TITLE_SIZE);
    this.title.element!.anchor = new Vec4(0.5, 1, 0.5, 1);
    this.title.element!.color = ACCENT;
    this.warning = this.text(this.panel, 'menu-warning', WARNING_SIZE);
    this.warning.element!.anchor = new Vec4(0.5, 1, 0.5, 1);
    this.warning.element!.color = WARNING;
    this.status = this.text(this.panel, 'menu-status', STATUS_SIZE);
    this.status.element!.anchor = new Vec4(0.5, 0, 0.5, 0);
    this.status.element!.pivot = new Vec2(0.5, 1);
    this.status.element!.opacity = STATUS_OPACITY;
    this.status.setLocalPosition(0, -STATUS_GAP, 0);
    this.caption = this.text(this.screen, 'menu-caption', CAPTION_SIZE);
    this.caption.setLocalPosition(PREVIEW_X, -(PREVIEW_HEIGHT / 2 + CAPTION_GAP), 0);

    // q3_ui's screen, in the middle and scaled by the height, as `UI_AdjustFrom640` puts it on a
    // wide one (`ui_atoms.c`, `uis.bias`).
    this.box = this.boxGroup(this.screen, 'menu-box');
    this.box.enabled = false;
    this.frame = this.image(this.box, 'menu-frame', new Vec4(0, 1, 0, 1), new Vec2(0, 1));
    this.frame.element!.color = PANEL;
    this.frame.element!.opacity = PANEL_OPACITY;
    this.content = this.boxGroup(this.box, 'menu-content');
    this.banner = this.boxText('menu-banner', TITLE_SIZE);
    this.banner.element!.color = ACCENT;
    this.boxWarning = this.boxText('menu-box-warning', WARNING_SIZE);
    this.boxWarning.element!.color = WARNING;
    this.boxMessage = this.boxText('menu-box-message', CHAR_SIZE);
    this.boxStatus = this.boxText('menu-box-status', STATUS_SIZE);
    this.boxStatus.element!.opacity = STATUS_OPACITY;
    this.boxCaption = this.boxText('menu-box-caption', CAPTION_SIZE);

    // Over every page, a popup's: the dimming, which takes the pointer, and the box.
    this.popupDim = this.image(this.screen, 'menu-popup-dim', new Vec4(0, 0, 1, 1));
    this.popupDim.element!.margin = new Vec4(0, 0, 0, 0);
    this.popupDim.element!.color = BLACK;
    this.popupDim.element!.opacity = BACKDROP_OPACITY;
    this.popupDim.element!.useInput = true;
    this.popupDim.enabled = false;
    this.overlay = this.boxGroup(this.screen, 'menu-popup');
    this.overlay.enabled = false;
  }

  /**
   * Where the page's player preview draws, and whom it shows: a box right of the middle, on the
   * grid scaled by the height; `null` for a page with none, or with the menu closed.
   */
  get previewView(): PreviewView | null {
    const page = this.menu.page;
    const { width, height } = this.app.graphicsDevice;
    if (this.destroyed || !page?.preview || !(width > 0 && height > 0)) return null;
    const unit = height / SCREEN_HEIGHT;
    const placed = this.menu.placement === 'q3ui' ? placePage(page).preview : null;
    // The preview stands in its panel, and moves with it.
    const shift = page === this.shown ? this.shift : null;
    const box = placed && shift ? { ...placed, x: placed.x + shift.x, y: placed.y + shift.y } : placed;
    if (box) return this.clipped(box, width, height, page.preview());
    const left = width / 2 + (PREVIEW_X - PREVIEW_WIDTH / 2) * unit;
    const bottom = height / 2 - (PREVIEW_HEIGHT / 2) * unit;
    return {
      rect: [left / width, bottom / height, (PREVIEW_WIDTH * unit) / width, (PREVIEW_HEIGHT * unit) / height],
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      look: page.preview()
    };
  }

  /**
   * Where the popup's board draws, and the board: its box on q3_ui's screen. `null` for a popup
   * with none, before it has drawn, or with no popup up.
   */
  get boardView(): BoardView | null {
    const { popup } = this;
    const board = popup?.page.detail?.board;
    const place = popup?.placement.detail;
    if (this.destroyed || !popup || !board || !place || popup.page !== this.menu.page) return null;
    return { box: place.board, board };
  }

  /** A preview box on q3_ui's screen, as {@link boxOnScreen} cuts it, framed by the whole box. */
  private clipped(box: Rect, width: number, height: number, look: PlayerLook): PreviewView | null {
    const shown = boxOnScreen(box, width, height);
    return shown && { ...shown, width: box.width, height: box.height, look };
  }

  /** Draw this frame's page, or nothing with the menu closed. */
  update(): void {
    if (this.destroyed) return;
    const top = this.menu.page;
    this.screen.enabled = top !== null;
    this.camera.enabled = top !== null;
    if (!top) {
      this.shown = null;
      this.showPopup(null);
      return;
    }
    // A popup stands over the page it opened from, which is drawn as ever but with no cursor.
    const page = (top.layout === 'popup' ? this.menu.under : null) ?? top;
    const popup = page === top ? null : top;
    this.backdrop.element!.opacity = this.opaque ? 1 : BACKDROP_OPACITY;
    const { placement } = this.menu;
    const q3 = placement === 'q3ui';
    this.panel.enabled = !q3;
    this.box.enabled = q3;
    if (page !== this.shown || placement !== this.shownPlacement) {
      this.shownPlacement = placement;
      if (q3) this.place(page);
      else this.build(page);
    }
    const cursor = popup ? -1 : this.menu.cursor;
    page.items.forEach((item, index) => this.style(this.rows[index], item, index === cursor));
    const focused = page.items[cursor];
    const status = (focused && !focused.hidden ? focused.status : undefined) ?? page.status ?? '';
    const statusText = q3 ? this.boxStatus : this.status;
    this.setText(statusText, status);
    statusText.enabled = status !== '';
    const caption = (q3 ? this.captioned : page.preview) ? (page.caption ?? '') : '';
    const captionText = q3 ? this.boxCaption : this.caption;
    this.setText(captionText, caption);
    captionText.enabled = caption !== '';
    // The centred caption hangs from the screen rather than the panel, so the panel doesn't take it.
    if (q3) this.caption.enabled = false;
    if (this.picture) this.showPicture(this.picture, page.picture);
    if (q3 && this.placement?.frame && this.font) this.settle(page, this.placement);
    this.showPopup(popup);
  }

  /** The popup as it is this frame, over the page under it; nothing while none is up. */
  private showPopup(page: MenuPage | null): void {
    if (this.popup && this.popup.page !== page) {
      this.popup.group.destroy();
      this.popup = null;
    }
    this.popupDim.enabled = this.overlay.enabled = page !== null;
    if (!page) return;
    this.popup ??= this.buildPopup(page);
    const { rows, table } = this.popup;
    const cursor = this.menu.cursor;
    page.items.forEach((item, index) => this.style(rows[index], item, index === cursor));
    if (table) this.showTable(table, page.detail ?? null);
  }

  /** A popup's box where its placement puts it, its title, its items, and its table. */
  private buildPopup(page: MenuPage): Popup {
    const placement = placePage(page);
    const group = this.boxGroup(this.overlay, 'menu-popup-box');
    const panel = this.image(group, 'menu-popup-panel', new Vec4(0, 1, 0, 1), new Vec2(0, 1));
    panel.element!.color = PANEL;
    panel.element!.opacity = PANEL_OPACITY;
    if (placement.frame) this.boxRect(panel, placement.frame);
    const title = this.text(group, 'menu-popup-title', placement.title.size);
    title.element!.anchor = new Vec4(0, 1, 0, 1);
    title.element!.color = ACCENT;
    this.setText(title, page.title ?? '');
    this.boxPlace(title, placement.title);
    const rows: Row[] = [];
    page.items.forEach((item, index) => {
      const name = `menu-popup-item-${index}`;
      rows.push(this.placedRow(index, item, placement.items[index], group, rows, name));
    });
    const table = placement.detail && this.tableParts(placement.detail.settings, group);
    return { page, placement, group, rows, table };
  }

  /** A group as large as q3_ui's screen, in the middle of its parent, as the box is. */
  private boxGroup(parent: Entity, name: string): Entity {
    const group = new Entity(name);
    group.addComponent('element', {
      type: ELEMENTTYPE_GROUP,
      anchor: new Vec4(0.5, 0.5, 0.5, 0.5),
      pivot: new Vec2(0.5, 0.5),
      width: SCREEN_WIDTH,
      height: SCREEN_HEIGHT
    });
    parent.addChild(group);
    return group;
  }

  /** The rows the pointer can reach: the popup's while one is up, else the page's. */
  private get pointed(): Row[] {
    return this.popup?.rows ?? this.rows;
  }

  /**
   * The page's picture as it is this frame, once it has loaded, and its lines; nothing in its
   * place while the page has none to show.
   */
  private showPicture(picture: Picture, shown: MenuPage['picture']): void {
    const texture = shown ? (this.images?.(shown.icon) ?? null) : null;
    picture.image.enabled = texture !== null;
    if (texture && picture.image.element!.texture !== texture) picture.image.element!.texture = texture;
    picture.lines.forEach((line, index) => this.setText(line, shown?.lines[index] ?? ''));
  }

  /**
   * The page's settings as they are this frame, each value cut at the table's edge; nothing
   * while the page shows none.
   */
  private showTable(table: Table, detail: PageDetail | null): void {
    const { place } = table;
    const room = place.right - (place.x + CHAR_GAP);
    table.labels.forEach((label, index) => {
      const row = detail?.settings[index];
      this.setText(label, row?.label ?? '');
      this.setText(table.values[index], this.cut(row?.value ?? '', room, place.size));
    });
  }

  /** Take the menu off the screen and give back its font's textures. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.screen.destroy();
    this.camera.destroy();
    this.app.scene.layers.remove(this.layer);
    this.font?.destroy();
  }

  /**
   * Lay a page out: the panel sized for it, and moved aside for a preview; its title, its tabs,
   * its grid, and a row for each other item.
   */
  private build(page: MenuPage): void {
    for (const row of this.rows) row.bar.destroy();
    this.rows = [];
    this.shown = page;
    this.clearPicture();

    const layout = page.layout ?? 'list';
    const beside = page.preview !== undefined;
    const width =
      beside || layout === 'grid'
        ? BESIDE_WIDTH
        : layout === 'form'
          ? this.formWidth(page)
          : layout === 'confirm'
            ? CONFIRM_WIDTH
            : LIST_WIDTH;
    this.panelX = beside ? BESIDE_X : 0;
    this.panel.setLocalPosition(this.panelX, 0, 0);
    this.rowHeight = layout === 'form' ? FORM_ROW_HEIGHT : ROW_HEIGHT;
    this.textSize = layout === 'form' ? FORM_TEXT_SIZE : TEXT_SIZE;
    const inner = width - 2 * PADDING;
    const head = page.title === undefined ? 0 : TITLE_HEIGHT;
    const tabs = page.items.filter((item) => item.tab !== undefined).length;
    const strip = PADDING + head;
    let top = strip + (tabs > 0 ? this.rowHeight + TAB_GAP : 0);
    let tabIndex = 0;
    // The cells go a line at a time from the top, and the other items under them.
    const cells = page.items.filter((item) => item.cell).length;
    const pitch = CELL_SIZE + CELL_GAP;
    const grid = top;
    if (cells > 0) top += Math.ceil(cells / GRID_COLUMNS) * pitch - CELL_GAP + TAB_GAP;
    let cellIndex = 0;
    // The room a page laid out for more rows than it has keeps, above its last item.
    const column = page.items.filter((item) => item.tab === undefined && !item.cell).length;
    const spare = Math.max(0, (page.rows ?? column) - column) * this.rowHeight;

    this.title.enabled = page.title !== undefined;
    this.setText(this.title, page.title ?? '');
    this.title.setLocalPosition(0, -(PADDING + head / 2), 0);

    page.items.forEach((item, index) => {
      if (layout === 'confirm') {
        // YES left of the middle and NO right of it, as `UI_ConfirmMenu` lays out "YES/NO".
        const x = (index - (page.items.length - 1) / 2) * ANSWER_WIDTH;
        this.rows.push(this.row(index, { x, top: strip, width: ANSWER_WIDTH, height: this.rowHeight }));
      } else if (item.tab !== undefined) {
        const tabWidth = inner / tabs;
        const x = -inner / 2 + tabWidth * (tabIndex++ + 0.5);
        this.rows.push(this.row(index, { x, top: strip, width: tabWidth, height: this.rowHeight }));
      } else if (item.cell) {
        const column = cellIndex % GRID_COLUMNS;
        const line = Math.floor(cellIndex++ / GRID_COLUMNS);
        const x = -inner / 2 + CELL_SIZE / 2 + column * pitch;
        this.rows.push(
          this.row(index, { x, top: grid + line * pitch, width: CELL_SIZE, height: CELL_SIZE, cell: true })
        );
      } else {
        if (index === page.items.length - 1) top += spare;
        const split = layout === 'form' && (item.value !== undefined || item.slider !== undefined);
        const sliding = item.slider !== undefined;
        this.rows.push(this.row(index, { x: 0, top, width: inner, height: this.rowHeight, split, sliding }));
        top += this.rowHeight;
      }
    });

    let bottom = top;
    this.warning.enabled = layout === 'confirm' && page.warning !== undefined;
    if (layout === 'confirm') {
      bottom = strip + this.rowHeight;
      this.setText(this.warning, page.warning ?? '');
      this.warning.setLocalPosition(0, -(bottom + WARNING_HEIGHT / 2), 0);
      if (page.warning !== undefined) bottom += WARNING_HEIGHT;
    }
    const panel = this.panel.element!;
    panel.width = width;
    panel.height = bottom + PADDING;
  }

  /**
   * A settings page's width: its own, or as wide as its widest row's label and value need, as a
   * box with a minimum width grows round its content, up to the 640 box. The rows of every tab are
   * measured, so the tabs share one width, a spin control's widest value and a field's room, so
   * each holds still.
   */
  private formWidth(page: MenuPage): number {
    const font = this.font;
    if (!font) return FORM_WIDTH;
    const measure = (text: string) => textWidth(font, text, FORM_TEXT_SIZE);
    const rows = (page.sections ?? [page]).flatMap((section) => section.items);
    const widest = Math.max(
      0,
      ...rows
        .filter((item) => item.value !== undefined)
        .map((item) => {
          const values = item.values ?? [item.value ?? ''];
          const room = fieldRoom(item);
          return measure(item.label) + INSET + (room > 0 ? room : Math.max(...values.map(measure)));
        })
    );
    return Math.min(SCREEN_WIDTH, Math.max(FORM_WIDTH, Math.ceil(widest) + 2 * (INSET + PADDING)));
  }

  /**
   * An item's row, hung from the panel's top: the bar and its label. A settings row adds its value,
   * the picture drawn in its place, and a slider's bar and thumb; a cell, its icon and the pick's
   * line.
   */
  private row(index: number, shape: RowShape): Row {
    const { x, top, width, height } = shape;
    const name = `menu-item-${index}`;
    const bar = this.image(this.panel, name, new Vec4(0.5, 1, 0.5, 1), new Vec2(0.5, 1));
    const element = bar.element!;
    element.color = ACCENT;
    element.width = width;
    element.height = height;
    element.useInput = true;
    bar.setLocalPosition(x, -top, 0);

    const edge = width / 2 - INSET;
    const label = shape.cell
      ? null
      : this.text(bar, `${name}-text`, this.textSize, shape.split ? 'left' : 'centre', shape.split ? -edge : 0);
    let value: Entity | null = null;
    let icon: Entity | null = null;
    let swatch: Entity | null = null;
    let pick: Entity | null = null;
    if (shape.cell) {
      const picture = { x: 0, y: 0, width: width - 2 * CELL_INSET, height: height - 2 * CELL_INSET };
      ({ icon, pick } = this.cellParts(bar, width, picture));
    }
    let caret: Entity | null = null;
    if (shape.split) {
      value = this.text(bar, `${name}-value`, this.textSize, 'right', edge);
      caret = this.caretPart(bar, this.textSize);
      icon = this.image(bar, `${name}-icon`, new Vec4(0.5, 0.5, 0.5, 0.5), new Vec2(1, 0.5));
      icon.element!.width = ICON_SIZE;
      icon.element!.height = ICON_SIZE;
      icon.setLocalPosition(edge, 0, 0);
      icon.enabled = false;
      swatch = this.image(bar, `${name}-swatch`, new Vec4(0.5, 0.5, 0.5, 0.5), new Vec2(1, 0.5));
      swatch.element!.width = SWATCH_WIDTH;
      swatch.element!.height = SWATCH_HEIGHT;
      swatch.setLocalPosition(edge, 0, 0);
      swatch.enabled = false;
    }
    let thumb: Entity | null = null;
    let track: Row['track'] = null;
    if (shape.sliding) {
      track = { left: TRACK_LEFT, width: width / 2 - TRACK_RIGHT - TRACK_LEFT };
      ({ thumb } = this.sliderParts(bar, track));
    }

    // The panel's middle is moved aside from the screen's for a preview.
    this.listen(bar, index, this.rows, this.panelX + x, width, track);
    const size = this.textSize;
    const parts = { bar, label, value, icon, swatch, pick, thumb, track, runs: [], caret };
    return { ...parts, scroll: 0, size, valueAlign: 'right' };
  }

  /** A field's cursor on a row's bar, hidden until it is drawn. */
  private caretPart(bar: Entity, size: number): Entity {
    const caret = this.image(bar, `${bar.name}-caret`, new Vec4(0.5, 0.5, 0.5, 0.5));
    caret.element!.width = CARET_WIDTH;
    caret.element!.height = size;
    caret.enabled = false;
    return caret;
  }

  /** A cell's parts: its icon, where its picture stands, and the pick's line along its foot. */
  private cellParts(bar: Entity, width: number, picture: CellPicture): { icon: Entity; pick: Entity } {
    const name = bar.name;
    const icon = this.image(bar, `${name}-icon`, new Vec4(0.5, 0.5, 0.5, 0.5));
    icon.element!.width = picture.width;
    icon.element!.height = picture.height;
    icon.setLocalPosition(picture.x, picture.y, 0);
    icon.enabled = false;
    const pick = this.image(bar, `${name}-pick`, new Vec4(0.5, 0, 0.5, 0), new Vec2(0.5, 0));
    pick.element!.width = width;
    pick.element!.height = PICK_HEIGHT;
    pick.element!.color = ACCENT;
    pick.enabled = false;
    return { icon, pick };
  }

  /**
   * Tell the menu where the pointer is along a row, or along its slider's bar, on the grid from the
   * screen's middle (`UI_MouseEvent`). Right of a slider's bar, past its thumb at the end, it is on
   * the number. A row gone with its page says nothing.
   *
   * @param rows - The rows it is among: it says nothing while the pointer can't reach them.
   * @param middle - The row's middle, on the grid from the screen's.
   * @param moved - Whether it stands in a panel on q3_ui's box, and moves with it.
   * @param down - A list's span down q3_ui's box, where the pointer's row is wanted.
   */
  private listen(
    bar: Entity,
    index: number,
    rows: Row[],
    middle: number,
    width: number,
    track: Row['track'],
    moved = false,
    down?: readonly [number, number]
  ): void {
    const span: [number, number] = track
      ? [middle + track.left, middle + track.left + track.width]
      : [middle - width / 2, middle + width / 2];
    const numberLeft = track ? span[1] + THUMB_WIDTH / 2 : undefined;
    const reached = () => rows[index]?.bar === bar && rows === this.pointed;
    const point = (event?: ElementMouseEvent) => {
      if (!reached()) return;
      const by = moved ? (this.shift?.x ?? 0) : 0;
      const byY = moved ? (this.shift?.y ?? 0) : 0;
      const at: [number, number] = [span[0] + by, span[1] + by];
      const number = numberLeft === undefined ? undefined : numberLeft + by;
      const shifted: [number, number] | undefined = down && [down[0] + byY, down[1] + byY];
      this.menu.hover(index, this.pointer(event, at, number, shifted));
    };
    const element = bar.element!;
    element.on('mouseenter', point);
    element.on('mousemove', point);
    element.on('mouseleave', () => {
      if (reached()) this.menu.hover(null);
    });
  }

  /**
   * Lay a page out where q3_ui lays it: the panel where its frame stands, the banner, a confirm's
   * warning, and each item on its own place.
   */
  private place(page: MenuPage): void {
    for (const row of this.rows) row.bar.destroy();
    this.rows = [];
    this.shown = page;
    this.clearPicture();
    const placed = placePage(page);
    this.placement = placed;
    this.shift = null;
    this.content.setLocalPosition(0, 0, 0);
    // What q3_ui's frame holds stands in the page's panel. The status line stands at its foot,
    // where the panel is fitted.
    const { frame } = placed;
    const on = (place: { x: number; y: number } | null) =>
      place && frame && inside(frame, place.x, place.y) ? this.content : this.box;
    this.banner.reparent(on(placed.title));
    this.boxWarning.reparent(on(placed.warning));
    this.boxCaption.reparent(on(placed.caption));
    this.boxStatus.reparent(frame && this.font ? this.content : this.box);
    this.sections = frame && this.font && page.sections ? this.measureSections(page) : null;

    this.frame.enabled = frame !== null;
    if (frame) this.boxRect(this.frame, frame);
    this.banner.enabled = page.title !== undefined;
    this.setText(this.banner, page.title ?? '');
    this.boxPlace(this.banner, placed.title);
    this.boxWarning.enabled = placed.warning !== null && page.warning !== undefined;
    if (placed.warning) this.wrapped(this.boxWarning, placed.warning, page.warning ?? '');
    this.boxMessage.enabled = placed.message !== null && page.message !== undefined;
    if (placed.message) this.wrapped(this.boxMessage, placed.message, page.message ?? '');
    this.boxPlace(this.boxStatus, placed.status);
    this.captioned = placed.caption !== null;
    if (placed.caption) this.boxPlace(this.boxCaption, placed.caption);
    if (placed.picture) {
      const { picture } = placed.picture;
      const parent = on({ x: picture.x + picture.width / 2, y: picture.y + picture.height / 2 });
      this.picture = this.pictureParts(placed.picture, parent);
    }

    page.items.forEach((item, index) => {
      const { bar } = placed.items[index];
      const parent = on({ x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 });
      this.rows.push(this.placedRow(index, item, placed.items[index], parent, this.rows));
    });
  }

  /**
   * Fit the page's panel round what stands in it, `PADDING` all round, with a line at its foot for
   * the status line as wide as the widest status the page's items give. The status line, and the
   * lines that stand with it, stand across in the middle of the rest. At the page's first frame,
   * move the panel and all it holds to the middle of the screen across, and of its band down.
   */
  private settle(page: MenuPage, placed: PagePlacement): void {
    const held = emptyExtent();
    const hold = (extent: Extent) => grow(held, extent);
    const holdRect = ({ x, y, width, height }: Rect) => hold({ left: x, top: y, right: x + width, bottom: y + height });
    const rows = this.rows.filter((row) => row.bar.parent === this.content);
    for (const row of rows) {
      if (row.bar.enabled && !row.withStatus) hold(barExtent(row.bar));
    }
    if (this.sections) hold(this.sections.held);
    if (placed.picture && this.picture?.group.parent === this.content) {
      holdRect(placed.picture.picture);
      if (placed.picture.strip) holdRect(placed.picture.strip);
    }
    for (const text of [this.banner, this.boxWarning, this.boxCaption]) {
      if (text.parent === this.content && text.enabled && text.element!.text !== '') hold(this.capitalsOf(text));
    }
    if (placed.figure) holdRect(placed.figure);
    if (!(held.right >= held.left)) return;

    const middle = (held.left + held.right) / 2;
    for (const row of rows) {
      if (!row.withStatus) continue;
      const { y, z } = row.bar.getLocalPosition();
      row.bar.setLocalPosition(middle, y, z);
      if (row.bar.enabled) hold(barExtent(row.bar));
    }
    const { size } = placed.status;
    const widest = Math.max(this.widestStatus(page, size), this.sections?.widest ?? 0);
    const left = Math.min(held.left, middle - widest / 2) - PADDING;
    const right = Math.max(held.right, middle + widest / 2) + PADDING;
    const top = held.top - PADDING;
    const bottom = held.bottom + STATUS_LINE + PADDING;
    this.shift ??= {
      x: SCREEN_WIDTH / 2 - (left + right) / 2,
      y: (placed.band.top + placed.band.bottom) / 2 - (top + bottom) / 2
    };
    const { x, y } = this.shift;
    this.content.setLocalPosition(x, -y, 0);
    this.boxRect(this.frame, { x: left + x, y: top + y, width: right - left, height: bottom - top });
    this.boxStatus.element!.fontSize = size;
    this.boxStatus.setLocalPosition(middle, -(held.bottom + STATUS_LINE / 2), 0);
  }

  /** The widest status a page's items give, or the page itself, at `size`. */
  private widestStatus(page: MenuPage, size: number): number {
    const statuses = [page.status, ...page.items.map((item) => item.status)];
    return Math.max(0, ...statuses.map((status) => textWidth(this.font!, status ?? '', size)));
  }

  /**
   * What a tabbed page's other tabs hold in its panel, and their widest status: their rows laid out
   * and fitted as they would be, measured, and taken away before anything is drawn.
   */
  private measureSections(page: MenuPage): { held: Extent; widest: number } {
    const held = emptyExtent();
    let widest = 0;
    for (const other of page.sections ?? []) {
      if (other === page) continue;
      const placed = placePage(other);
      const { frame } = placed;
      other.items.forEach((item, index) => {
        const place = placed.items[index];
        const { bar } = place;
        if (!frame || !inside(frame, bar.x + bar.width / 2, bar.y + bar.height / 2)) return;
        const row = this.placedRow(index, item, place, this.content, []);
        this.style(row, item, false);
        if (row.bar.enabled) grow(held, barExtent(row.bar));
        row.bar.destroy();
      });
      widest = Math.max(widest, this.widestStatus(other, placed.status.size));
    }
    return { held, widest };
  }

  /** A text's capitals on its parent, down from its top: from its first line's top to its last's foot. */
  private capitalsOf(text: Entity): Extent {
    const element = text.element!;
    const { x, y } = text.getLocalPosition();
    // Each line is boxed by its glyphs' cells, its capitals in their middle.
    const inset = (element.fontSize * (this.font!.cell - this.font!.capitals)) / 2;
    const top = -y - (1 - element.pivot.y) * element.height;
    const left = x - element.pivot.x * element.width;
    return { left, top: top + inset, right: left + element.width, bottom: top + element.height - inset };
  }

  /**
   * A page's picture where the placement puts it, and the strip under it, with a text for each of
   * its lines: the picture shows once it has loaded.
   */
  private pictureParts(place: PicturePlace, parent: Entity): Picture {
    const group = new Entity('menu-picture');
    group.addComponent('element', {
      type: ELEMENTTYPE_GROUP,
      anchor: new Vec4(0, 1, 0, 1),
      pivot: new Vec2(0, 1),
      width: SCREEN_WIDTH,
      height: SCREEN_HEIGHT
    });
    parent.addChild(group);
    group.setLocalPosition(0, 0, 0);
    if (place.strip) {
      const strip = this.image(group, 'menu-picture-strip', new Vec4(0, 1, 0, 1), new Vec2(0, 1));
      strip.element!.color = BLACK;
      this.boxRect(strip, place.strip);
    }
    const image = this.image(group, 'menu-picture-image', new Vec4(0, 1, 0, 1), new Vec2(0, 1));
    this.boxRect(image, place.picture);
    image.enabled = false;
    const lines = place.lines.map((line, index) => {
      const text = this.text(group, `menu-picture-line-${index}`, line.size);
      text.element!.anchor = new Vec4(0, 1, 0, 1);
      this.boxPlace(text, line);
      return text;
    });
    return { group, image, lines };
  }

  /** Take the last page's picture away. */
  private clearPicture(): void {
    this.picture?.group.destroy();
    this.picture = null;
  }

  /**
   * A table's rows where the placement puts them, as a widget's row stands: each label ending a
   * character short of the table's x, and each value starting a character past it.
   */
  private tableParts(place: TablePlace, parent: Entity): Table {
    const group = new Entity('menu-table');
    group.addComponent('element', {
      type: ELEMENTTYPE_GROUP,
      anchor: new Vec4(0, 1, 0, 1),
      pivot: new Vec2(0, 1),
      width: SCREEN_WIDTH,
      height: SCREEN_HEIGHT
    });
    parent.addChild(group);
    group.setLocalPosition(0, 0, 0);
    const text = (name: string, align: Align, x: number, y: number) => {
      const entity = this.text(group, name, place.size, align);
      entity.element!.anchor = new Vec4(0, 1, 0, 1);
      entity.element!.opacity = TEXT_IDLE;
      entity.setLocalPosition(x, -y, 0);
      return entity;
    };
    const ys = Array.from({ length: place.rows }, (_, index) => place.y + index * place.step);
    return {
      group,
      place,
      labels: ys.map((y, index) =>
        text(`menu-table-label-${index}`, 'right', place.x - CHAR_GAP, y)
      ),
      values: ys.map((y, index) => text(`menu-table-value-${index}`, 'left', place.x + CHAR_GAP, y))
    };
  }

  /**
   * An item's row where q3_ui puts it: the bar, and its text as its kind lays it. A widget's row
   * has its label ending short of its x and its value, or a slider's bar and number, starting past
   * it; a stacked row has its value under its label; a cell, its icon.
   *
   * @param parent - The box, the panel's content where the row stands in the panel, or a popup's
   *   box.
   * @param rows - The rows it is among.
   * @param name - Its bar's name, which its parts' names start with.
   */
  private placedRow(
    index: number,
    item: MenuItem,
    placed: PlacedItem,
    parent: Entity,
    rows: Row[],
    name = `menu-item-${index}`
  ): Row {
    const { bar: rect, text } = placed;
    const bar = this.image(parent, name, new Vec4(0, 1, 0, 1));
    const element = bar.element!;
    element.color = ACCENT;
    element.width = rect.width;
    element.height = rect.height;
    element.useInput = true;
    // Hung by its middle, so its texts are put from there as a centred row's are.
    const middleX = rect.x + rect.width / 2;
    const middleY = rect.y + rect.height / 2;
    bar.setLocalPosition(middleX, -middleY, 0);

    const row: Row = {
      bar,
      label: null,
      value: null,
      icon: null,
      swatch: null,
      pick: null,
      thumb: null,
      track: null,
      runs: [],
      caret: null,
      scroll: 0,
      // A cell reads nothing, so its size is never used.
      size: text.kind === 'cell' ? CHAR_SIZE : text.size,
      valueAlign: 'left',
      // Fitted by the face's capitals, which a menu with no font has none of.
      ...(placed.fit !== undefined && this.font ? { fit: placed.fit } : {}),
      ...(placed.withStatus ? { withStatus: true } : {})
    };
    const valued = item.value !== undefined || item.slider !== undefined;
    switch (text.kind) {
      case 'cell': {
        const { picture, strip, name: named } = text;
        // Its picture's middle, from the cell's, the grid's y running down.
        const at = {
          x: picture.x + picture.width / 2 - middleX,
          y: middleY - (picture.y + picture.height / 2),
          width: picture.width,
          height: picture.height
        };
        ({ icon: row.icon, pick: row.pick } = this.cellParts(bar, rect.width, at));
        if (strip) {
          const back = this.image(bar, `${name}-strip`, new Vec4(0.5, 0.5, 0.5, 0.5));
          back.element!.color = BLACK;
          back.element!.width = strip.width;
          back.element!.height = strip.height;
          back.setLocalPosition(strip.x + strip.width / 2 - middleX, middleY - (strip.y + strip.height / 2), 0);
        }
        if (named) {
          row.label = this.text(bar, `${name}-text`, named.size, 'centre', named.x - middleX);
          row.label.setLocalPosition(named.x - middleX, middleY - named.y, 0);
          row.size = named.size;
        }
        break;
      }
      case 'line':
        row.label = this.text(bar, `${name}-text`, text.size, text.align, text.x - middleX);
        row.glyph = text.glyph;
        break;
      case 'row': {
        row.label = this.text(bar, `${name}-text`, text.size, 'right', text.x - CHAR_GAP - middleX);
        if (!valued) break;
        let start = text.x + CHAR_GAP - middleX;
        if (item.slider !== undefined) {
          row.track = { left: start, width: SLIDER_BAR };
          ({ thumb: row.thumb } = this.sliderParts(bar, row.track));
          start += SLIDER_BAR + CHAR_GAP;
        }
        this.valueParts(row, start, 0);
        break;
      }
      case 'stacked': {
        row.label = this.text(bar, `${name}-text`, text.labelSize, 'left', text.x - middleX);
        row.label.setLocalPosition(text.x - middleX, middleY - (rect.y + text.labelSize / 2), 0);
        if (valued) this.valueParts(row, text.valueX - middleX, middleY - (text.valueY + text.size / 2));
        break;
      }
      case 'list':
        row.lines = this.listLines(bar, rect, text);
        break;
    }
    const down: [number, number] | undefined =
      text.kind === 'list' ? [rect.y, rect.y + rect.height] : undefined;
    const moved = parent === this.content;
    this.listen(bar, index, rows, middleX - SCREEN_WIDTH / 2, rect.width, row.track, moved, down);
    return row;
  }

  /**
   * A scrolled list's rows down its bar, each a bar that lights the chosen row and a text for each
   * column, run from the column's x the way it says.
   */
  private listLines(
    bar: Entity,
    rect: Rect,
    list: Extract<PlacedItem['text'], { kind: 'list' }>
  ): ListLine[] {
    const height = rect.height / list.rows;
    const middleX = rect.x + rect.width / 2;
    const middleY = rect.y + rect.height / 2;
    return Array.from({ length: list.rows }, (_, index) => {
      const name = `${bar.name}-line-${index}`;
      const y = middleY - (rect.y + (index + 0.5) * height);
      const line = this.image(bar, name, new Vec4(0.5, 0.5, 0.5, 0.5));
      line.element!.color = ACCENT;
      line.element!.opacity = BAR_OPACITY;
      line.element!.width = rect.width;
      line.element!.height = height;
      line.setLocalPosition(0, y, 0);
      line.enabled = false;
      const cells = list.columns.map((column, at) => {
        const x = column.x - middleX;
        const text = this.text(bar, `${name}-cell-${at}`, list.size, column.align, x);
        text.setLocalPosition(x, y, 0);
        return { text, width: column.width };
      });
      return { bar: line, cells };
    });
  }

  /**
   * A value, and the picture or colour drawn in its place, run rightward from `x`, and `y` from the
   * bar's middle.
   */
  private valueParts(row: Row, x: number, y: number): void {
    const name = row.bar.name;
    row.value = this.text(row.bar, `${name}-value`, row.size, 'left', x);
    row.value.setLocalPosition(x, y, 0);
    row.icon = this.image(row.bar, `${name}-icon`, new Vec4(0.5, 0.5, 0.5, 0.5), new Vec2(0, 0.5));
    row.icon.element!.width = ICON_SIZE;
    row.icon.element!.height = ICON_SIZE;
    row.icon.setLocalPosition(x, y, 0);
    row.icon.enabled = false;
    row.swatch = this.image(row.bar, `${name}-swatch`, new Vec4(0.5, 0.5, 0.5, 0.5), new Vec2(0, 0.5));
    row.swatch.element!.width = SWATCH_WIDTH;
    row.swatch.element!.height = SWATCH_HEIGHT;
    row.swatch.setLocalPosition(x, y, 0);
    row.swatch.enabled = false;
    row.caret = this.caretPart(row.bar, row.size);
  }

  /** A slider's bar and its thumb, along `track` from the bar's middle. */
  private sliderParts(bar: Entity, track: NonNullable<Row['track']>): { thumb: Entity } {
    const name = bar.name;
    const bed = this.image(bar, `${name}-track`, new Vec4(0.5, 0.5, 0.5, 0.5), new Vec2(0, 0.5));
    bed.element!.width = track.width;
    bed.element!.height = TRACK_HEIGHT;
    bed.element!.color = WHITE;
    bed.element!.opacity = TRACK_OPACITY;
    bed.setLocalPosition(track.left, 0, 0);
    const thumb = this.image(bar, `${name}-thumb`, new Vec4(0.5, 0.5, 0.5, 0.5));
    thumb.element!.width = THUMB_WIDTH;
    thumb.element!.height = THUMB_HEIGHT;
    thumb.element!.color = WHITE;
    return { thumb };
  }

  /**
   * Write a text wrapped where the box says, hung from its top whatever lines it wraps to. Its line
   * height is set with its size, since the engine keeps the one it was made with.
   */
  private wrapped(entity: Entity, place: WrappedText, text: string): void {
    const element = entity.element!;
    element.autoWidth = false;
    element.wrapLines = true;
    element.width = place.width;
    element.lineHeight = place.lineHeight;
    element.pivot = new Vec2(0.5, 1);
    this.setText(entity, text);
    this.boxPlace(entity, place);
  }

  /** A text on q3_ui's box, hung from its top left. */
  private boxText(name: string, size: number): Entity {
    const entity = this.text(this.box, name, size);
    entity.element!.anchor = new Vec4(0, 1, 0, 1);
    return entity;
  }

  /** Put a text's middle at a point on q3_ui's box, at the size given there. */
  private boxPlace(entity: Entity, place: TextPlace): void {
    entity.element!.fontSize = place.size;
    entity.setLocalPosition(place.x, -place.y, 0);
  }

  /** Put an image, pivoted at its top left, on a rectangle of q3_ui's box. */
  private boxRect(entity: Entity, rect: Rect): void {
    entity.element!.width = rect.width;
    entity.element!.height = rect.height;
    entity.setLocalPosition(rect.x, -rect.y, 0);
  }

  /**
   * Show a row as its item is this frame: the cursor's bar, the text, the value, the picture, the
   * pick and the thumb.
   */
  private style(row: Row, item: MenuItem, focused: boolean): void {
    row.bar.enabled = !item.hidden;
    if (item.hidden) return;
    if (row.lines) {
      // A list lights its chosen row rather than itself.
      row.bar.element!.opacity = 0;
      this.styleList(row.lines, row.size, item, focused);
      return;
    }
    row.bar.element!.opacity = focused && !item.grayed ? BAR_OPACITY : 0;
    const current = item.tab === 'current';
    // The Model page's pick lights its cell's icon below; a list's lights its own text, as the
    // bot pages draw theirs white among orange (`ui_addbots.c:121–123`). A cell has no text.
    const picked = item.selected === true;
    const lit = current || picked;
    const opacity = item.grayed ? TEXT_GRAYED : focused || lit ? TEXT_FOCUSED : TEXT_IDLE;
    if (row.label) {
      this.setText(row.label, row.glyph ?? item.label);
      const { color } = item;
      row.label.element!.color = color ? tint.set(color[0], color[1], color[2]) : lit ? ACCENT : WHITE;
      row.label.element!.opacity = opacity;
    }
    const texture = row.icon && item.icon ? (this.images?.(item.icon) ?? null) : null;
    if (row.icon) {
      row.icon.enabled = texture !== null;
      if (texture && row.icon.element!.texture !== texture) row.icon.element!.texture = texture;
    }
    // A cell's icon is lit at the cursor and at the pick, which is underlined.
    if (row.pick && row.icon) {
      row.pick.enabled = item.selected === true;
      row.icon.element!.opacity = focused || item.selected ? TEXT_FOCUSED : TEXT_IDLE;
    }
    if (row.value && row.swatch) {
      const { swatch } = item;
      row.swatch.enabled = swatch !== undefined;
      if (swatch) row.swatch.element!.color = tint.set(swatch[0], swatch[1], swatch[2]);
      // A field shows its cursor while the menu's is on it (`MField_Draw`), and a value given in
      // colours shows them while it is not. Either is cut to a field's room.
      const value = item.value ?? '';
      const caret = focused && !texture && !swatch ? item.caret : undefined;
      const colored = focused || texture || swatch ? [] : (item.colored ?? []);
      const room = this.font ? fieldRoom(item) : 0;
      const measure = (text: string) => textWidth(this.font!, text, row.size);
      if (room === 0 || colored.length > 0) row.scroll = 0;
      const shown =
        room === 0 || colored.length > 0
          ? { start: 0, end: value.length }
          : fieldWindow(value, caret, row.scroll, room, measure);
      row.scroll = shown.start;
      const runs = room > 0 ? cutRuns(colored, room, measure) : colored;
      const text = value.slice(shown.start, shown.end);
      this.setText(row.value, texture || swatch || runs.length > 0 ? '' : text);
      const own = item.marked ? ACCENT : WHITE;
      row.value.element!.color = own;
      row.value.element!.opacity = opacity;
      this.colorRuns(row, runs, own, opacity);
      this.showCaret(row, caret === undefined ? null : text.slice(0, caret - shown.start), text);
      if (row.caret) {
        row.caret.element!.color = own;
        row.caret.element!.opacity = opacity;
      }
    }
    if (row.thumb && row.track) {
      row.thumb.setLocalPosition(row.track.left + (item.slider ?? 0) * row.track.width, 0, 0);
      row.thumb.element!.opacity = opacity;
    }
    if (row.fit !== undefined) this.refit(row, item, row.fit);
  }

  /**
   * A field's cursor over its value, after `before` of the text shown, or none for `null`. The
   * text runs from the value's place the way the value does.
   */
  private showCaret(row: Row, before: string | null, text: string): void {
    const { caret, value } = row;
    if (!caret || !value) return;
    caret.enabled = before !== null;
    if (before === null) return;
    const measure = (part: string) => (this.font ? textWidth(this.font, part, row.size) : 0);
    const at = value.getLocalPosition();
    const start = row.valueAlign === 'right' ? at.x - measure(text) : at.x;
    const x = start + measure(before);
    caret.setLocalPosition(x, at.y, 0);
  }

  /**
   * A scrolled list's rows as it shows them this frame (`ScrollList_Draw`): each row's cells, cut
   * to their columns, and the chosen row in the accent colour, with the cursor's bar behind it
   * while the list has the cursor. A cell with a colour of its own keeps it, as q3_ui's ping does.
   */
  private styleList(lines: ListLine[], size: number, item: MenuItem, focused: boolean): void {
    const view = item.list ?? { rows: [], selected: -1 };
    lines.forEach((line, index) => {
      const cells = view.rows[index];
      const chosen = index === view.selected;
      line.bar.enabled = chosen && focused && !item.grayed;
      const opacity = item.grayed ? TEXT_GRAYED : chosen ? TEXT_FOCUSED : TEXT_IDLE;
      line.cells.forEach((cell, at) => {
        const run = cells?.[at];
        cell.text.enabled = run !== undefined;
        if (!run) return;
        this.setText(cell.text, this.cut(run.text, cell.width, size));
        const { color } = run;
        const own = chosen ? ACCENT : WHITE;
        cell.text.element!.color = color ? tint.set(color[0], color[1], color[2]) : own;
        cell.text.element!.opacity = opacity;
      });
    });
  }

  /** A text cut from its end until it fits `width` at `size`, as a column cuts its cells. */
  private cut(text: string, width: number, size: number): string {
    const font = this.font;
    if (!font) return text;
    let end = text.length;
    while (end > 0 && textWidth(font, text.slice(0, end), size) > width) end--;
    return text.slice(0, end);
  }

  /**
   * Fit a bar to what it shows this frame, with `margin` all round: each text across its width and
   * up and down its capitals, and a value's picture or colour. A value from a set reaches as far as
   * the widest of them, a field's as far as its room, and a label that changes as far as its
   * widest. The bar moves to its new middle and its parts move back, so that nothing it shows moves
   * on the screen.
   */
  private refit(row: Row, item: MenuItem, margin: number): void {
    const values = (item.values ?? []).map((value) => textWidth(this.font!, value, row.size));
    const widest = Math.max(0, fieldRoom(item), ...values);
    const labelSize = row.label?.element?.fontSize ?? row.size;
    const labels = (item.labels ?? []).map((label) => textWidth(this.font!, label, labelSize));
    const widestLabel = Math.max(0, ...labels);
    let left = Infinity;
    let right = -Infinity;
    let bottom = Infinity;
    let top = -Infinity;
    for (const part of [row.label, row.value, row.icon, row.swatch, ...row.runs]) {
      const element = part?.element;
      if (!part?.enabled || !element) continue;
      const text = element.type === ELEMENTTYPE_TEXT;
      // A value keeps the room it is given, empty or not.
      if (text && element.text === '' && !(part === row.value && widest > 0)) continue;
      const { x, y } = part.getLocalPosition();
      // A text stands by its capitals' middle, where its middle is put.
      const height = text ? element.fontSize * this.font!.capitals : element.height;
      const reach = part === row.value ? widest : part === row.label ? widestLabel : 0;
      const width = Math.max(element.width, reach);
      const start = x - element.pivot.x * width;
      const foot = y - (text ? 0.5 : element.pivot.y) * height;
      left = Math.min(left, start);
      right = Math.max(right, start + width);
      bottom = Math.min(bottom, foot);
      top = Math.max(top, foot + height);
    }
    if (!(right >= left)) return;
    const bar = row.bar.element!;
    bar.width = right - left + 2 * margin;
    bar.height = top - bottom + 2 * margin;
    const moveX = (left + right) / 2;
    const moveY = (bottom + top) / 2;
    if (Math.abs(moveX) < 1e-6 && Math.abs(moveY) < 1e-6) return;
    const at = row.bar.getLocalPosition();
    row.bar.setLocalPosition(at.x + moveX, at.y + moveY, at.z);
    for (const part of row.bar.children as Entity[]) {
      if (!part.name.startsWith(row.bar.name)) continue;
      const { x, y, z } = part.getLocalPosition();
      part.setLocalPosition(x - moveX, y - moveY, z);
    }
  }

  /**
   * Draw a value in colours: a text for each run, each as wide as its text, laid from where the
   * value is put the way it runs, right to left from a right-aligned value's end. A run with no
   * colour of its own takes the value's.
   */
  private colorRuns(row: Row, runs: readonly ColoredText[], own: Color, opacity: number): void {
    const leftward = row.valueAlign === 'right';
    const at = row.value!.getLocalPosition();
    let x = at.x;
    for (let step = 0; step < runs.length; step++) {
      const i = leftward ? runs.length - 1 - step : step;
      const { text, color } = runs[i];
      row.runs[i] ??= this.text(row.bar, `${row.bar.name}-run-${i}`, row.size, row.valueAlign);
      const entity = row.runs[i];
      entity.enabled = true;
      entity.setLocalPosition(x, at.y, 0);
      this.setText(entity, text);
      const element = entity.element!;
      element.color = color ? tint.set(color[0], color[1], color[2]) : own;
      element.opacity = opacity;
      x += leftward ? -element.width : element.width;
    }
    for (let i = runs.length; i < row.runs.length; i++) row.runs[i].enabled = false;
  }

  /**
   * The pointer on a row: where it is along a span of the grid, from 0 to 1, and whether it is on a
   * slider's number, which starts at `numberLeft`; and, given a span down q3_ui's box, where it is
   * down that. ElementInput gives the pointer in CSS pixels from the canvas's corner, and the grid
   * is scaled by the canvas's height about its middle, the box's top at the canvas's. Nothing is
   * known of an event with no place, or on a canvas with no size.
   */
  private pointer(
    event: ElementMouseEvent | undefined,
    [left, right]: readonly [number, number],
    numberLeft: number | undefined,
    down?: readonly [number, number]
  ): Pointer {
    const canvas = this.app.graphicsDevice.canvas;
    const unit = canvas.clientHeight / SCREEN_HEIGHT;
    if (!event || !Number.isFinite(event.x) || !(unit > 0)) return {};
    const x = (event.x - canvas.clientWidth / 2) / unit;
    const along = (at: number, [from, to]: readonly [number, number]) =>
      Math.min(1, Math.max(0, (at - from) / (to - from)));
    return {
      x: along(x, [left, right]),
      number: numberLeft !== undefined && x > numberLeft,
      ...(down && Number.isFinite(event.y) ? { y: along(event.y / unit, down) } : {})
    };
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
    // On its anchor: the engine starts a new element off it, by its pivot times its first size
    // of 32 units.
    entity.setLocalPosition(0, 0, 0);
    return entity;
  }

  /**
   * A line of text on its parent's middle.
   *
   * @param align - Which way it runs from `x`.
   * @param x - Where it is put, from the parent's middle.
   */
  private text(parent: Entity, name: string, size: number, align: Align = 'centre', x = 0): Entity {
    const across = align === 'left' ? 0 : align === 'right' ? 1 : 0.5;
    const entity = new Entity(name);
    entity.addComponent('element', {
      type: ELEMENTTYPE_TEXT,
      anchor: new Vec4(0.5, 0.5, 0.5, 0.5),
      pivot: new Vec2(across, 0.5),
      alignment: new Vec2(across, 0.5),
      fontSize: size,
      autoWidth: true,
      autoHeight: true,
      text: '',
      layers: [this.layer.id],
      ...(this.font ? { font: this.font } : {})
    });
    entity.setLocalPosition(x, 0, 0);
    parent.addChild(entity);
    return entity;
  }
}
