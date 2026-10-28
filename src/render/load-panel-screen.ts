import {
  ADDRESS_CLAMP_TO_EDGE,
  Color,
  ELEMENTTYPE_GROUP,
  ELEMENTTYPE_IMAGE,
  ELEMENTTYPE_TEXT,
  Entity,
  FILTER_LINEAR,
  GAMMA_SRGB,
  Layer,
  PIXELFORMAT_RGBA8,
  SCALEMODE_BLEND,
  SORTMODE_MANUAL,
  TONEMAP_LINEAR,
  Texture,
  Vec2,
  Vec4,
  type AppBase
} from 'playcanvas';

import type { LoadScreens, Panel } from '../load-screen';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../view/hud-layout';
import { createMenuFont, ELLIPSIS, MONO_FACE, textWidth, type MenuFont } from './menu-font';

/**
 * The load and connect screens on screen: the one on top of the stack, in a panel in the middle
 * over a background that hides everything under it, and takes the pointer from it. The title, the
 * server, the bar, the step's line and its detail stand in the panel; cgame's lines, or the server's
 * print, hang under it, so it stays put as they come.
 *
 * The screen is Q3's 640×480 grid, scaled by the height as the menu's is, in the page's monospace
 * face. Its measures keep a web page's proportions: a rem of which the lines are 0.85, each line
 * box 1.2 of its size.
 *
 * It draws from a camera of its own, after the menu's and the scoreboard's, enabled only while a
 * screen is up. It reads the stack as the app is about to draw, after every update, so a screen
 * closed in a frame is gone from that frame.
 */

/** The panel's camera, after the eye's: the menu's is +4, and the scoreboard's and the player preview's +5. */
export const LOAD_PANEL_CAMERA_PRIORITY = 6;

/** The sizes the text is drawn at, on the 640×480 grid: the title, the lines, and the detail. */
const TITLE_SIZE = 22;
const LINE_SIZE = 15;
const DETAIL_SIZE = 13;
/** The panel's rem, of which a line is 0.85, and a line's box, over its size. */
const REM = LINE_SIZE / 0.85;
const LINE_BOX = 1.2;
/** cgame's lines stand further apart. */
const INFO_LINE_BOX = 1.5;

/** The panel's width, held to a share of a narrow screen's. */
const PANEL_WIDTH = 28 * REM;
const PANEL_SHARE = 0.8;
/** The gaps down the panel, each over the part it names. */
const SERVER_TOP = 0.25 * REM;
const BAR_TOP = REM;
const BAR_HEIGHT = 0.375 * REM;
const LINE_TOP = 0.75 * REM;
const DETAIL_TOP = 0.25 * REM;
const INFO_TOP = 1.5 * REM;
const GROUP_GAP = 0.75 * REM;

/** Where each part stands down the panel, from its top: each text's middle, and the bar's top. */
const TITLE_MIDDLE = (TITLE_SIZE * LINE_BOX) / 2;
const SERVER_MIDDLE = TITLE_SIZE * LINE_BOX + SERVER_TOP + (LINE_SIZE * LINE_BOX) / 2;
const BAR_Y = SERVER_MIDDLE + (LINE_SIZE * LINE_BOX) / 2 + BAR_TOP;
const LINE_MIDDLE = BAR_Y + BAR_HEIGHT + LINE_TOP + (LINE_SIZE * LINE_BOX) / 2;
const DETAIL_MIDDLE = LINE_MIDDLE + (LINE_SIZE * LINE_BOX) / 2 + DETAIL_TOP + (DETAIL_SIZE * LINE_BOX) / 2;
const PANEL_HEIGHT = DETAIL_MIDDLE + (DETAIL_SIZE * LINE_BOX) / 2;

/** The page's background, `#0d0d0f`; Q3's orange, the menu's accent, for the bar. */
const BACKGROUND = new Color(13 / 255, 13 / 255, 15 / 255);
const ACCENT = new Color(1, 0.55, 0.12);
const WHITE = new Color(1, 1, 1);
/** The text's white, and how far each line is dimmed from it: the title's not at all. */
const TEXT_OPACITY = 0.87;
const DIM = 0.7;
const FAINT = 0.45;
const TRACK_OPACITY = 0.12;
/** How long the bar's fill takes to reach a new fraction. */
const FILL_EASE_MS = 150;

/** A half disc's texture's size: a disc, of which each end of a bar draws half. */
const DISC_TEXELS = 32;

/** A piece of a bar: where it starts from the bar's left, how wide it is drawn, and which part of the disc it shows across. */
export interface BarPiece {
  x: number;
  width: number;
  u0: number;
  u1: number;
}

/**
 * A bar with round ends cut at `shown` of its `width` from the left, as a rounded box clips what
 * fills it: its left end, its straight middle and its right end, each cut where the fill stops.
 * The ends show the disc's halves.
 *
 * @param radius - Half the bar's height.
 */
export function barPieces(width: number, shown: number, radius: number): [BarPiece, BarPiece, BarPiece] {
  const piece = (x: number, across: number, u0: number, u1: number): BarPiece => {
    const visible = Math.min(across, Math.max(0, shown - x));
    return { x, width: visible, u0, u1: across > 0 ? u0 + ((u1 - u0) * visible) / across : u0 };
  };
  const end = Math.min(radius, width / 2);
  return [piece(0, end, 0, 0.5), piece(end, width - 2 * end, 0.5, 0.5), piece(width - end, end, 0.5, 1)];
}

/** A text cut from its end, marked, until it fits `width` at `size`, as a line cut by its box's edge is. */
export function cutLine(font: MenuFont, text: string, width: number, size: number): string {
  if (textWidth(font, text, size) <= width) return text;
  let end = text.length;
  while (end > 0 && textWidth(font, text.slice(0, end) + ELLIPSIS, size) > width) end--;
  return text.slice(0, end) + ELLIPSIS;
}

export interface LoadPanelScreenOptions {
  /**
   * The lines' font, the page's monospace face, which stays the caller's. `null` draws the text
   * with none, for a device with no canvas to draw a font on: each line still carries its string.
   */
  font: MenuFont | null;
  /** The title's, the face's bold by default, made and taken away with the panel. */
  titleFont?: MenuFont | null;
  /** The clock the bar eases by, in milliseconds. */
  now?: () => number;
}

/** A bar: the group it stands in, and its three pieces. */
interface Bar {
  group: Entity;
  pieces: [Entity, Entity, Entity];
}

/** The panel's screen, and the camera that draws it. */
export class LoadPanelScreen {
  private readonly app: AppBase;
  private readonly screens: LoadScreens;
  private readonly font: MenuFont | null;
  private readonly titleFont: MenuFont | null;
  private readonly ownsTitleFont: boolean;
  private readonly now: () => number;
  private readonly layer: Layer;
  private readonly camera: Entity;
  private readonly screen: Entity;
  private readonly disc: Texture;
  private readonly panel: Entity;
  private readonly title: Entity;
  private readonly server: Entity;
  private readonly track: Bar;
  private readonly fill: Bar;
  private readonly line: Entity;
  private readonly detail: Entity;
  private readonly info: [Entity, Entity];
  /** The screen drawn, at which revision, and in a panel how wide. */
  private shown: Panel | null = null;
  private revision = -1;
  private width = 0;
  /** The bar's fill as it eases: from where, to where, and since when. */
  private from = 0;
  private to = 0;
  private since = 0;
  private settled = true;
  private readonly draw = () => this.update();
  private destroyed = false;

  /**
   * @param screens - The screens up, of which it draws the top.
   * @param eye - The camera the world is seen through; the panel draws after the menu's.
   */
  constructor(app: AppBase, screens: LoadScreens, eye: Entity, options: LoadPanelScreenOptions) {
    this.app = app;
    this.screens = screens;
    this.font = options.font;
    this.ownsTitleFont = options.titleFont === undefined;
    this.titleFont =
      options.titleFont === undefined ? createMenuFont(app, { face: MONO_FACE, weight: '600' }) : options.titleFont;
    this.now = options.now ?? (() => performance.now());

    this.layer = new Layer({ name: 'load-panel', transparentSortMode: SORTMODE_MANUAL });
    app.scene.layers.push(this.layer);

    this.camera = new Entity('load-panel-camera');
    this.camera.addComponent('camera', {
      layers: [this.layer.id],
      clearColorBuffer: false,
      clearDepthBuffer: false,
      priority: eye.camera!.priority + LOAD_PANEL_CAMERA_PRIORITY,
      gammaCorrection: GAMMA_SRGB,
      toneMapping: TONEMAP_LINEAR
    });
    this.camera.enabled = false;
    app.root.addChild(this.camera);

    this.screen = new Entity('load-panel-screen');
    this.screen.addComponent('screen', {
      screenSpace: true,
      referenceResolution: new Vec2(SCREEN_WIDTH, SCREEN_HEIGHT),
      scaleMode: SCALEMODE_BLEND,
      // Scaled by the height alone, as the menu is.
      scaleBlend: 1
    });
    this.screen.enabled = false;
    app.root.addChild(this.screen);

    this.disc = discTexture(app);

    // Everything under it hidden, and out of the pointer's reach.
    const backdrop = this.image(this.screen, 'load-backdrop', new Vec4(0, 0, 1, 1));
    backdrop.element!.margin = new Vec4(0, 0, 0, 0);
    backdrop.element!.color = BACKGROUND;
    backdrop.element!.useInput = true;

    this.panel = new Entity('load-panel');
    this.panel.addComponent('element', {
      type: ELEMENTTYPE_GROUP,
      anchor: new Vec4(0.5, 0.5, 0.5, 0.5),
      pivot: new Vec2(0.5, 0.5),
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT
    });
    this.screen.addChild(this.panel);

    this.title = this.text('load-title', TITLE_SIZE, TITLE_MIDDLE, this.titleFont);
    this.title.element!.opacity = TEXT_OPACITY;
    this.server = this.text('load-server', LINE_SIZE, SERVER_MIDDLE);
    this.server.element!.opacity = TEXT_OPACITY * DIM;
    this.track = this.bar('load-track', WHITE, TRACK_OPACITY);
    this.fill = this.bar('load-fill', ACCENT, 1);
    this.line = this.text('load-line', LINE_SIZE, LINE_MIDDLE);
    this.line.element!.opacity = TEXT_OPACITY * DIM;
    this.detail = this.text('load-detail', DETAIL_SIZE, DETAIL_MIDDLE);
    this.detail.element!.opacity = TEXT_OPACITY * FAINT;
    this.info = [this.group('load-info-0'), this.group('load-info-1')];

    app.on('prerender', this.draw);
  }

  /** Draw the screen on top as it stands, or nothing with none up. */
  private update(): void {
    const top = this.screens.top;
    this.screen.enabled = top !== null;
    this.camera.enabled = top !== null;
    if (!top) {
      this.shown = null;
      return;
    }
    const width = this.panelWidth();
    if (top !== this.shown || top.revision !== this.revision || width !== this.width) {
      this.redraw(top, width, top !== this.shown);
    }
    this.easeFill();
  }

  /** The panel as wide as it is drawn: its own width, or a share of a narrow screen's. */
  private panelWidth(): number {
    const { width, height } = this.app.graphicsDevice;
    const across = height > 0 ? (width / height) * SCREEN_HEIGHT : SCREEN_WIDTH;
    return Math.min(PANEL_WIDTH, across * PANEL_SHARE);
  }

  /** Lay the screen's lines in the panel, each written only where it has changed. */
  private redraw(top: Panel, width: number, fresh: boolean): void {
    this.shown = top;
    this.revision = top.revision;
    if (width !== this.width) {
      this.width = width;
      this.panel.element!.width = width;
      for (const text of [this.title, this.server, this.line, this.detail, ...this.info]) text.element!.width = width;
    }
    this.setText(this.title, this.cut(this.titleFont, top.title, TITLE_SIZE));
    this.setText(this.server, this.cut(this.font, top.server, LINE_SIZE));
    this.setText(this.line, this.cut(this.font, top.line, LINE_SIZE));
    this.setText(this.detail, this.cut(this.font, top.detail, DETAIL_SIZE));

    // The groups hang one under another from the panel's foot, each line in its box.
    let y = -INFO_TOP;
    this.info.forEach((group, index) => {
      const lines = top.groups[index];
      group.enabled = lines !== undefined;
      if (!lines) return;
      // An empty line keeps its row, which the engine gives a last line only if it holds something.
      this.setText(group, lines.map((line) => line || ' ').join('\n'));
      const { rows, leading } = this.rows(group);
      group.setLocalPosition(0, y - leading, 0);
      y -= rows * LINE_SIZE * INFO_LINE_BOX + GROUP_GAP;
    });

    this.track.group.enabled = top.bar;
    this.fill.group.enabled = top.bar;
    this.placeBar(this.track, 1);
    // A screen newly on top shows its fill at once; one already shown eases to its new fraction.
    if (fresh) {
      this.from = this.to = top.fraction;
      this.since = -Infinity;
    } else if (top.fraction !== this.to) {
      this.from = this.eased().fraction;
      this.to = top.fraction;
      this.since = this.now();
    }
    this.settled = false;
  }

  /** The fill as it eases out to its target: its fraction, and whether it is there. */
  private eased(): { fraction: number; done: boolean } {
    const progress = Math.min(1, (this.now() - this.since) / FILL_EASE_MS);
    const eased = 1 - (1 - progress) ** 2;
    return { fraction: this.from + (this.to - this.from) * eased, done: progress >= 1 };
  }

  /** Move the fill on, each frame until it is there. */
  private easeFill(): void {
    if (this.settled || !this.shown?.bar) return;
    const { fraction, done } = this.eased();
    this.placeBar(this.fill, fraction);
    this.settled = done;
  }

  /** Cut a bar's pieces at `fraction` of the panel's width. */
  private placeBar(bar: Bar, fraction: number): void {
    const pieces = barPieces(this.width, this.width * fraction, BAR_HEIGHT / 2);
    pieces.forEach((piece, index) => {
      const entity = bar.pieces[index];
      const element = entity.element!;
      entity.enabled = piece.width > 0;
      if (element.width !== piece.width) element.width = piece.width;
      entity.setLocalPosition(piece.x, 0, 0);
      if (index !== 1) {
        const rect = element.rect;
        if (rect?.x !== piece.u0 || rect.z !== piece.u1 - piece.u0) element.rect = new Vec4(piece.u0, 0, piece.u1 - piece.u0, 1);
      }
    });
  }

  /**
   * How many rows a group's text wrapped to, and the gap over its first glyphs' cells in its first
   * row's box. The engine boxes text by the rows between its first cell's top and its last's
   * foot, where a page boxes each row whole.
   */
  private rows(group: Entity): { rows: number; leading: number } {
    const box = LINE_SIZE * INFO_LINE_BOX;
    const cell = LINE_SIZE * (this.font?.cell ?? 0);
    const { height } = group.element!;
    if (!this.font || height <= 0) return { rows: 0, leading: 0 };
    return { rows: Math.round((height - cell) / box) + 1, leading: (box - cell) / 2 };
  }

  /** A line cut at the panel's edge, or as it is with no font to measure it by. */
  private cut(font: MenuFont | null, text: string, size: number): string {
    return font ? cutLine(font, text, this.width, size) : text;
  }

  /** Take the screen, its camera, its layer and its title's font away. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app.off('prerender', this.draw);
    this.screen.destroy();
    this.camera.destroy();
    this.app.scene.layers.remove(this.layer);
    this.disc.destroy();
    if (this.ownsTitleFont) this.titleFont?.destroy();
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
   * A line of text in its box, as wide as the panel and its line high, its middle `down` from the
   * panel's top: the box holds still whatever the line says.
   */
  private text(name: string, size: number, down: number, font = this.font): Entity {
    const entity = new Entity(name);
    entity.addComponent('element', {
      type: ELEMENTTYPE_TEXT,
      anchor: new Vec4(0.5, 1, 0.5, 1),
      pivot: new Vec2(0.5, 0.5),
      alignment: new Vec2(0.5, 0.5),
      fontSize: size,
      width: PANEL_WIDTH,
      height: size * LINE_BOX,
      autoWidth: false,
      autoHeight: false,
      text: '',
      color: WHITE,
      layers: [this.layer.id],
      ...(font ? { font } : {})
    });
    this.panel.addChild(entity);
    entity.setLocalPosition(0, -down, 0);
    return entity;
  }

  /** A group of cgame's lines under the panel, wrapped at its width, hung by its top. */
  private group(name: string): Entity {
    const entity = new Entity(name);
    entity.addComponent('element', {
      type: ELEMENTTYPE_TEXT,
      anchor: new Vec4(0.5, 0, 0.5, 0),
      pivot: new Vec2(0.5, 1),
      alignment: new Vec2(0.5, 1),
      fontSize: LINE_SIZE,
      lineHeight: LINE_SIZE * INFO_LINE_BOX,
      width: PANEL_WIDTH,
      autoWidth: false,
      autoHeight: true,
      wrapLines: true,
      text: '',
      color: WHITE,
      opacity: TEXT_OPACITY * DIM,
      layers: [this.layer.id],
      ...(this.font ? { font: this.font } : {})
    });
    this.panel.addChild(entity);
    entity.enabled = false;
    return entity;
  }

  /** A bar across the panel, `BAR_Y` down: a round end each side of a straight middle. */
  private bar(name: string, color: Color, opacity: number): Bar {
    const group = new Entity(name);
    group.addComponent('element', {
      type: ELEMENTTYPE_GROUP,
      anchor: new Vec4(0, 1, 0, 1),
      pivot: new Vec2(0, 1),
      width: 0,
      height: BAR_HEIGHT
    });
    this.panel.addChild(group);
    group.setLocalPosition(0, -BAR_Y, 0);
    const pieces = ['left', 'middle', 'right'].map((side, index) => {
      const piece = this.image(group, `${name}-${side}`, new Vec4(0, 1, 0, 1), new Vec2(0, 1));
      const element = piece.element!;
      element.height = BAR_HEIGHT;
      element.color = color;
      element.opacity = opacity;
      if (index !== 1) element.texture = this.disc;
      return piece;
    }) as [Entity, Entity, Entity];
    return { group, pieces };
  }
}

/** A white disc on clear texels, its edge's coverage blended, of which each end of a bar shows half. */
function discTexture(app: AppBase): Texture {
  const texels = new Uint8Array(DISC_TEXELS * DISC_TEXELS * 4).fill(255);
  const radius = DISC_TEXELS / 2;
  for (let y = 0; y < DISC_TEXELS; y++) {
    for (let x = 0; x < DISC_TEXELS; x++) {
      const distance = Math.hypot(x + 0.5 - radius, y + 0.5 - radius);
      texels[4 * (y * DISC_TEXELS + x) + 3] = Math.round(255 * Math.min(1, Math.max(0, radius - distance + 0.5)));
    }
  }
  return new Texture(app.graphicsDevice, {
    name: 'load-panel-disc',
    format: PIXELFORMAT_RGBA8,
    width: DISC_TEXELS,
    height: DISC_TEXELS,
    mipmaps: false,
    minFilter: FILTER_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
    levels: [texels]
  });
}
