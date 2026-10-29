import {
  Color,
  ELEMENTTYPE_GROUP,
  ELEMENTTYPE_IMAGE,
  ELEMENTTYPE_TEXT,
  Entity,
  GAMMA_SRGB,
  Layer,
  SCALEMODE_NONE,
  SORTMODE_MANUAL,
  TONEMAP_LINEAR,
  Vec2,
  Vec4,
  type AppBase
} from 'playcanvas';

import { COLOR_TABLE } from '../formats/color-codes';
import type { Settings } from '../settings/registry';
import { Q3_VERSION } from '../version';
import type { ConsoleText } from '../view/console-print';
import {
  colorLayers,
  CONSOLE_COLORS,
  CONSOLE_OPEN_FRAC,
  drawnLines,
  inputLayers,
  runConsole,
  scrollMarks,
  textRows
} from '../view/console-rows';
import { cursorShown, type EditField } from '../view/edit-field';
import { smallCharHeight, smallCharWidth } from '../view/hud-text';
import { textWidth, type MenuFont } from './menu-font';

/**
 * Q3's console on screen: dropped from the top over everything else, as ioquake3's
 * `Con_DrawSolidConsole` draws it (`cl_console.c:662–765`), in the port's chrome. A panel in the
 * page's colour, a rule in the menu's accent along its foot, the version in the bottom row, the `]`
 * prompt above it with the line being typed after it, and the buffer's lines from there up, each
 * character in its colour.
 *
 * Everything stands on ioquake3's grid in the canvas's own pixels, a character `g_smallchar_width`
 * by `g_smallchar_height`, so the console holds more on a larger screen rather than drawing larger.
 * It is laid out once at its open height and moved up as it slides, so a slide writes no text.
 *
 * It draws from a camera of its own, after the load panel's, enabled only while any of it shows. It
 * reads the client as the app is about to draw, then slides on, as ioquake3 runs `Con_RunConsole`
 * after its frame is drawn.
 */

/** The console's camera, after the eye's: the load panel's is +6. */
export const CONSOLE_CAMERA_PRIORITY = 7;

/** The page's background, `#0d0d0f`, a little see-through; the menu's accent, where Q3 draws red. */
const BACKGROUND = new Color(13 / 255, 13 / 255, 15 / 255);
const BACKGROUND_OPACITY = 0.9;
const ACCENT = new Color(1, 0.55, 0.12);
const WHITE = new Color(1, 1, 1);
/** The rule's height on Q3's 480-high grid (`SCR_FillRect( 0, y, SCREEN_WIDTH, 2, color )`, `:696`). */
const RULE_HEIGHT = 2 / 480;
/**
 * The cursor's two shapes in its character's cell, in sixteenths of the cell across and down, as
 * Quake 3's charset draws them: inserting an underline (glyph 10), overstriking a block (glyph 11)
 * that hides the character under it. The port's face has no such glyphs, so they are boxes.
 */
const UNDERLINE = { x: 1, y: 12, width: 14, height: 2 };
const BLOCK = { x: 2, y: 2, width: 12, height: 12 };

/** The settings the console reads: `scr_conspeed` and `con_scale`. */
export type ConsoleSettings = Pick<Settings, 'conSpeed' | 'conScale'>;

export interface ConsoleScreenOptions {
  /**
   * The page's monospace face. `null` draws the text with none, for a device with no canvas to
   * draw a font on: each text still carries its string.
   */
  font: MenuFont | null;
  /** The clock the console slides by, in milliseconds. */
  now?: () => number;
}

/** The console's screen, and the camera that draws it. */
export class ConsoleScreen {
  /** Whether `KEYCATCH_CONSOLE` is up, which drops the console: the client's, set each frame. */
  open = false;
  /** `CA_DISCONNECTED`, no match and none being joined or loaded: the client's, set each frame. */
  disconnected = true;
  private readonly app: AppBase;
  private readonly text: ConsoleText;
  private readonly settings: ConsoleSettings;
  private readonly font: MenuFont | null;
  private readonly now: () => number;
  private readonly layer: Layer;
  private readonly camera: Entity;
  private readonly screen: Entity;
  private readonly panel: Entity;
  private readonly background: Entity;
  private readonly rule: Entity;
  private readonly layers: Entity[];
  private readonly marks: Entity;
  private readonly prompt: Entity;
  private readonly version: Entity;
  private readonly field: EditField;
  private readonly inputs: Entity[];
  private readonly cursor: Entity;
  /** `con.displayFrac`. */
  private displayFrac = 0;
  private lastFrame: number;
  /**
   * The grid as laid out, in pixels: for a canvas `width` by `height` under `con_scale` `scale`, a
   * character `w` by `h`, its glyphs `lead` down their row, and the console `open` high.
   */
  private readonly grid = { width: 0, height: 0, scale: 0, w: 0, h: 0, lead: 0, open: 0 };
  /** The buffer's revision written into the grid. */
  private revision = -1;
  /** The input line as written into the grid, its text, window and width; none while hidden. */
  private input: { text: string; start: number; length: number; width: number } | null = null;
  private readonly draw = () => this.update();
  private destroyed = false;

  /**
   * @param text - The console's buffer, which it draws.
   * @param field - The console's input line, which it draws after the prompt.
   * @param eye - The camera the world is seen through; the console draws after the load panel's.
   */
  constructor(
    app: AppBase,
    eye: Entity,
    text: ConsoleText,
    field: EditField,
    settings: ConsoleSettings,
    options: ConsoleScreenOptions
  ) {
    this.app = app;
    this.text = text;
    this.field = field;
    this.settings = settings;
    this.font = options.font;
    this.now = options.now ?? (() => performance.now());
    this.lastFrame = this.now();

    this.layer = new Layer({ name: 'console', transparentSortMode: SORTMODE_MANUAL });
    app.scene.layers.push(this.layer);

    this.camera = new Entity('console-camera');
    this.camera.addComponent('camera', {
      layers: [this.layer.id],
      clearColorBuffer: false,
      clearDepthBuffer: false,
      priority: eye.camera!.priority + CONSOLE_CAMERA_PRIORITY,
      gammaCorrection: GAMMA_SRGB,
      toneMapping: TONEMAP_LINEAR
    });
    this.camera.enabled = false;
    app.root.addChild(this.camera);

    // A unit is a pixel of the canvas, as ioquake3 draws the console's characters.
    this.screen = new Entity('console-screen');
    this.screen.addComponent('screen', { screenSpace: true, scaleMode: SCALEMODE_NONE });
    this.screen.enabled = false;
    app.root.addChild(this.screen);

    this.panel = new Entity('console-panel');
    this.panel.addComponent('element', {
      type: ELEMENTTYPE_GROUP,
      anchor: new Vec4(0, 1, 0, 1),
      pivot: new Vec2(0, 1)
    });
    this.screen.addChild(this.panel);
    this.panel.setLocalPosition(0, 0, 0);

    this.background = this.image('console-background', BACKGROUND, BACKGROUND_OPACITY);
    this.rule = this.image('console-rule', ACCENT, 1);
    this.layers = Array.from({ length: CONSOLE_COLORS }, (_, color) => {
      const [r, g, b] = COLOR_TABLE[color];
      return this.textElement(`console-text-${color}`, new Color(r, g, b));
    });
    this.marks = this.textElement('console-marks', ACCENT);
    this.prompt = this.textElement('console-prompt', WHITE);
    this.prompt.element!.text = ']';
    this.version = this.textElement('console-version', ACCENT);
    this.version.element!.text = Q3_VERSION;
    this.inputs = Array.from({ length: CONSOLE_COLORS }, (_, color) => {
      const [r, g, b] = COLOR_TABLE[color];
      return this.textElement(`console-input-${color}`, new Color(r, g, b));
    });
    // After the line, so the block is drawn over the character it stands on.
    this.cursor = this.image('console-cursor', WHITE, 1);

    app.on('prerender', this.draw);
  }

  /** `con.displayFrac` not 0: any of the console shows, which hides the notify lines (`:786–793`). */
  get shown(): boolean {
    return this.displayFrac > 0;
  }

  /** `Con_Close`'s (`:856–865`): the console gone at once, with no slide. */
  close(): void {
    this.displayFrac = 0;
  }

  /** Draw the console as far down as it stands, then slide it on by the frame's time. */
  private update(): void {
    const now = this.now();
    const frameMs = now - this.lastFrame;
    this.lastFrame = now;
    this.place(now);
    this.displayFrac = runConsole(this.displayFrac, this.open, this.settings.conSpeed, frameMs);
  }

  /** Show the console `displayFrac` down the screen, or nothing with none of it in view. */
  private place(now: number): void {
    const { width, height } = this.app.graphicsDevice;
    // `lines` (`:672–674`): the console's foot, in pixels down from the top.
    const lines = Math.trunc(height * this.displayFrac);
    const shown = lines > 0;
    this.camera.enabled = shown;
    this.screen.enabled = shown;
    if (!shown) return;

    const grid = this.grid;
    const scale = this.settings.conScale;
    if (width !== grid.width || height !== grid.height || scale !== grid.scale) {
      this.layOut(width, height, scale);
      this.revision = -1;
      this.input = null;
    }
    if (this.text.revision !== this.revision) {
      this.writeText();
      this.revision = this.text.revision;
    }
    // `Con_DrawInput`'s (`:555–557`): the prompt shows disconnected, or while the console has the keys.
    const prompted = this.open || this.disconnected;
    this.prompt.enabled = prompted;
    this.writeInput(prompted, now);
    this.panel.setLocalPosition(0, grid.open - lines, 0);
  }

  /** Size the panel to the screen, and set its fixed parts on the grid at the console's open height. */
  private layOut(width: number, height: number, scale: number): void {
    const grid = this.grid;
    const w = smallCharWidth(scale);
    const h = smallCharHeight(scale);
    const open = Math.trunc(height * CONSOLE_OPEN_FRAC);
    // The face is drawn at the size whose advance is a character's width.
    const size = this.font ? w / textWidth(this.font, 'M', 1) : h;
    // A glyph's cell stands in the middle of its row; the font has raised its glyphs to its capitals.
    const lead = (h - size * (this.font?.cell ?? 0)) / 2;
    Object.assign(grid, { width, height, scale, w, h, lead, open });

    const panel = this.panel.element!;
    panel.width = width;
    panel.height = open;
    this.setBox(this.background, 0, 0, width, open);
    this.setBox(this.rule, 0, open, width, height * RULE_HEIGHT);
    for (const entity of [...this.layers, this.marks, this.prompt, this.version, ...this.inputs]) {
      const element = entity.element!;
      element.fontSize = size;
      element.lineHeight = h;
    }
    // `:701–708`: the version in the bottom row, ending a character in from the right.
    this.setRows(this.version, width - (Q3_VERSION.length + 1) * w, open - h, Q3_VERSION.length, 1);
    // `:559–563`: the prompt in the row above.
    this.setRows(this.prompt, w, open - 2 * h, 1, 1);
  }

  /** Write the buffer's lines into their rows, and the marks while the view is scrolled back. */
  private writeText(): void {
    const { w, h, open } = this.grid;
    const text = this.text;
    const scrolledBack = text.display !== text.current;
    const rows = Math.max(0, textRows(open, h, scrolledBack));
    // `:715–726`: the text from the third row up, or the fourth under the marks.
    const bottom = open - (scrolledBack ? 4 : 3) * h;

    this.marks.enabled = scrolledBack;
    if (scrolledBack) {
      this.setRows(this.marks, w, open - 3 * h, text.lineWidth, 1);
      this.setText(this.marks, scrollMarks(text.lineWidth));
    }

    const layers = colorLayers(text, drawnLines(text, rows));
    this.layers.forEach((entity, color) => {
      entity.enabled = layers[color] !== '';
      if (!entity.enabled) return;
      this.setRows(entity, w, bottom - (rows - 1) * h, text.lineWidth, rows);
      this.setText(entity, layers[color]);
    });
  }

  /**
   * `Con_DrawInput`'s field (`:559–566`): the line's window from the column after the prompt, a
   * text per colour, rewritten only when it moves; and the cursor in its place, blinking on the
   * clock in the mode's shape.
   */
  private writeInput(shown: boolean, now: number): void {
    const field = this.field;
    if (!shown) {
      for (const entity of this.inputs) entity.enabled = false;
      this.cursor.enabled = false;
      this.input = null;
      return;
    }
    const { w, h, open } = this.grid;
    const window = field.window();
    const width = field.widthInChars;
    const last = this.input;
    if (
      !last ||
      last.text !== field.text ||
      last.start !== window.start ||
      last.length !== window.length ||
      last.width !== width
    ) {
      this.input = { text: field.text, ...window, width };
      const layers = inputLayers(field.text, window);
      this.inputs.forEach((entity, color) => {
        entity.enabled = layers[color] !== '';
        if (!entity.enabled) return;
        this.setRows(entity, 2 * w, open - 2 * h, width, 1);
        this.setText(entity, layers[color]);
      });
    }
    const cell = field.overstrike ? BLOCK : UNDERLINE;
    const across = (2 + field.cursor - window.start) * w;
    const down = open - 2 * h;
    this.setBox(
      this.cursor,
      across + (cell.x * w) / 16,
      down + (cell.y * h) / 16,
      (cell.width * w) / 16,
      (cell.height * h) / 16
    );
    this.cursor.enabled = cursorShown(now);
  }

  /** Take the screen, its camera and its layer away. The font is the caller's. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app.off('prerender', this.draw);
    this.screen.destroy();
    this.camera.destroy();
    this.app.scene.layers.remove(this.layer);
  }

  private setText(entity: Entity, text: string): void {
    const element = entity.element!;
    if (element.text !== text) element.text = text;
  }

  /** Put an element's top left `down` pixels below the panel's top and `across` from its left. */
  private setBox(entity: Entity, across: number, down: number, width: number, height: number): void {
    const element = entity.element!;
    element.width = width;
    element.height = height;
    entity.setLocalPosition(across, -down, 0);
  }

  /** A text `columns` characters wide and `rows` high, its top row `down` from the panel's top. */
  private setRows(entity: Entity, across: number, down: number, columns: number, rows: number): void {
    const { w, h, lead } = this.grid;
    this.setBox(entity, across, down + lead, columns * w, rows * h);
  }

  /** A flat rectangle in a colour, by its top left. */
  private image(name: string, color: Color, opacity: number): Entity {
    const entity = new Entity(name);
    entity.addComponent('element', {
      type: ELEMENTTYPE_IMAGE,
      anchor: new Vec4(0, 1, 0, 1),
      pivot: new Vec2(0, 1),
      color,
      opacity,
      layers: [this.layer.id]
    });
    this.panel.addChild(entity);
    entity.setLocalPosition(0, 0, 0);
    return entity;
  }

  /** A text by its top left, its rows from the top, in a box that holds still whatever it says. */
  private textElement(name: string, color: Color): Entity {
    const entity = new Entity(name);
    entity.addComponent('element', {
      type: ELEMENTTYPE_TEXT,
      anchor: new Vec4(0, 1, 0, 1),
      pivot: new Vec2(0, 1),
      alignment: new Vec2(0, 1),
      autoWidth: false,
      autoHeight: false,
      wrapLines: false,
      text: '',
      color,
      layers: [this.layer.id],
      ...(this.font ? { font: this.font } : {})
    });
    this.panel.addChild(entity);
    entity.setLocalPosition(0, 0, 0);
    return entity;
  }
}
