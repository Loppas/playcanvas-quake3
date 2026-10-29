// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBase, Entity } from 'playcanvas';

import { K } from '../formats/q3-keys';
import { Q3_VERSION } from '../version';
import { ConsoleBuffer } from '../view/console-buffer';
import { EditField, type EditMode } from '../view/edit-field';
import { CONSOLE_CAMERA_PRIORITY, ConsoleScreen, type ConsoleSettings } from './console-screen';
import { createTestApp, squareFont } from './engine-test-fixtures';
import { LOAD_PANEL_CAMERA_PRIORITY } from './load-panel-screen';
import type { MenuFont } from './menu-font';

/** The console on the null device: what it draws, where, and when. */

let app: AppBase;
let eye: Entity;
let buffer: ConsoleBuffer;
let mode: EditMode;
let field: EditField;
let settings: ConsoleSettings;
let screen: ConsoleScreen;
let clock: number;

beforeEach(() => {
  ({ app, camera: eye } = createTestApp());
  // A 640×480 canvas, its console 78 characters wide, as `Con_CheckResize` makes it.
  app.graphicsDevice.canvas.width = 640;
  app.graphicsDevice.canvas.height = 480;
  buffer = new ConsoleBuffer();
  buffer.resize(78);
  mode = { overstrike: false };
  field = new EditField(mode, 78);
  settings = { conSpeed: 3, conScale: 1 };
  clock = 1000;
});

afterEach(() => {
  screen.destroy();
  app.destroy();
});

/**
 * The console on its own font, none, so each text keeps its string, or square glyphs, after a
 * frame: the app's frames run before the console is opened.
 */
function drawn(font: MenuFont | null = null): ConsoleScreen {
  screen = new ConsoleScreen(app, eye, buffer, field, settings, { font, now: () => clock });
  app.render();
  return screen;
}

/** Frames `ms` apart, `count` of them. */
function frames(count: number, ms = 50): void {
  for (let i = 0; i < count; i++) {
    clock += ms;
    app.render();
  }
}

/** The console dropped all the way, from closed. */
function opened(): void {
  screen.open = true;
  frames(6);
}

const find = (name: string) => app.root.findByName(name) as Entity;
/** An element's colour, and how opaque it is drawn. */
const color = (name: string) => {
  const { color: { r, g, b }, opacity } = find(name).element!;
  return [r, g, b, opacity];
};
const text = (name: string) => find(name).element!.text;
const shown = (name: string) => find(name).enabled;
/** `text` typed at the field as a browser types it: each character after its key. */
const type = (text: string) => {
  for (const ch of text) {
    field.keyDown(ch.toLowerCase().charCodeAt(0));
    field.char(ch);
  }
};
/** How far the panel is moved up from its open place, in pixels. */
const raised = () => find('console-panel').getLocalPosition().y;
/** An element's top left from the panel's, in pixels down and across, and its size. */
const box = (name: string) => {
  const entity = find(name);
  const { x, y } = entity.getLocalPosition();
  const { width, height } = entity.element!;
  return { x, down: 0 - y, width, height };
};

describe('ConsoleScreen', () => {
  it('draws nothing while closed, from a camera after the load panel’s', () => {
    drawn();
    frames(3);
    expect([shown('console-camera'), shown('console-screen'), screen.shown]).toEqual([false, false, false]);
    expect(find('console-camera').camera!.priority).toBe(eye.camera!.priority + CONSOLE_CAMERA_PRIORITY);
    expect(CONSOLE_CAMERA_PRIORITY).toBeGreaterThan(LOAD_PANEL_CAMERA_PRIORITY);
  });

  it('drops to half the screen at scr_conspeed on the clock, then lifts away', () => {
    drawn();
    screen.open = true;
    // The frame the console opens draws it where it stood, closed; it slides after.
    frames(1);
    expect(shown('console-screen')).toBe(false);
    expect(screen.shown).toBe(true);
    // 3 screens a second: 0.15 of 480 down after 50 ms, 72 of the open 240.
    frames(1);
    expect(shown('console-screen')).toBe(true);
    expect(raised()).toBe(240 - 72);
    frames(1);
    expect(raised()).toBe(240 - 144);
    frames(2);
    expect(raised()).toBe(0);
    frames(3);
    expect(raised()).toBe(0);

    // Closed, it draws where it stood once more, then lifts.
    screen.open = false;
    frames(1);
    expect(raised()).toBe(0);
    frames(1);
    expect(raised()).toBe(72);
    // 0.5 less three steps of 0.15 is a hair under 0.05 in floats, and the pixel is cut, as
    // ioquake3's int cuts it: 23 of it left in view.
    frames(2);
    expect(raised()).toBe(240 - 23);
    expect(screen.shown).toBe(false);
    frames(1);
    expect(shown('console-screen')).toBe(false);
  });

  it('goes at once on a close, with no slide', () => {
    drawn();
    opened();
    screen.open = false;
    screen.close();
    expect(screen.shown).toBe(false);
    frames(1);
    expect([shown('console-camera'), shown('console-screen')]).toEqual([false, false]);
  });

  it('draws the buffer from the third row up, a text for each colour printed in', () => {
    drawn();
    buffer.print('^1Sarge^7 was railed\n', 1000);
    buffer.print('hello\n', 1000);
    opened();
    // 240 high: 14 rows of text over the prompt's and the version's.
    const blanks = ' \n'.repeat(12);
    expect(text('console-text-1')).toBe(`${blanks}Sarge\n `);
    expect(text('console-text-7')).toBe(`${blanks}      was railed\nhello`);
    expect(shown('console-text-1')).toBe(true);
    expect(shown('console-text-4')).toBe(false);
    // Each in Quake 3's colour for it.
    expect(color('console-text-1')).toEqual([1, 0, 0, 1]);
    expect(color('console-text-7')).toEqual([1, 1, 1, 1]);
  });

  it('shows the version in the bottom row, a character in from the right, and the prompt above it', () => {
    drawn(squareFont(app, 0.7));
    buffer.print('hello\n', 1000);
    opened();
    expect(text('console-version')).toBe(Q3_VERSION);
    // A square glyph drawn 8 across is 8 high, standing in the middle of its 16-pixel row.
    expect(box('console-version')).toEqual({
      x: 640 - (Q3_VERSION.length + 1) * 8,
      down: 240 - 16 + 4,
      width: Q3_VERSION.length * 8,
      height: 16
    });
    expect(text('console-prompt')).toBe(']');
    expect(box('console-prompt')).toEqual({ x: 8, down: 240 - 32 + 4, width: 8, height: 16 });
    // A row of text every 16 pixels.
    expect(find('console-text-7').element!.lineHeight).toBe(16);
    // The text from the third row up, the top one past the screen's top, a character in.
    expect(box('console-text-7')).toMatchObject({ x: 8, down: 240 - 48 - 13 * 16 + 4, height: 14 * 16 });
    // The panel down to its foot, and the rule under it, 2 of 480 high.
    expect(box('console-background')).toEqual({ x: 0, down: 0, width: 640, height: 240 });
    expect(box('console-rule')).toEqual({ x: 0, down: 240, width: 640, height: 2 });
    // The port's chrome: the page's colour, see-through a little, and the menu's accent where
    // Quake 3 draws red.
    expect(color('console-background')).toEqual([13 / 255, 13 / 255, 15 / 255, 0.9]);
    for (const name of ['console-rule', 'console-version', 'console-marks']) {
      expect(color(name)).toEqual([1, 0.55, 0.12, 1]);
    }
    expect(color('console-prompt')).toEqual([1, 1, 1, 1]);
  });

  it('shows the prompt while disconnected, or while the console has the keys', () => {
    drawn();
    screen.disconnected = false;
    opened();
    expect(shown('console-prompt')).toBe(true);
    screen.open = false;
    frames(1);
    expect(shown('console-prompt')).toBe(false);
    screen.disconnected = true;
    frames(1);
    expect(shown('console-prompt')).toBe(true);
  });

  it('draws the line typed after the prompt, a text per colour, its codes drawn as typed', () => {
    drawn(squareFont(app, 0.7));
    type('say ^1hi^7 all');
    opened();
    expect(text('console-input-7')).toBe('say     ^7 all');
    expect(text('console-input-1')).toBe('    ^1hi');
    expect([shown('console-input-7'), shown('console-input-1'), shown('console-input-2')]).toEqual([
      true,
      true,
      false
    ]);
    expect(color('console-input-1')).toEqual([1, 0, 0, 1]);
    // From the column after the prompt's, on its row, as wide as the field.
    const row = { x: 16, down: 240 - 32 + 4, width: 78 * 8, height: 16 };
    expect(box('console-input-7')).toEqual(row);
    expect(box('console-input-1')).toEqual(box('console-input-7'));
  });

  it('scrolls a long line to keep its cursor in view', () => {
    drawn();
    const line = 'abcdefghij'.repeat(10);
    type(line);
    opened();
    // A character short of the field's 78, the cursor in the last.
    expect(text('console-input-7')).toBe(line.slice(100 - 77));
    field.keyDown(K.HOME);
    frames(1);
    expect(text('console-input-7')).toBe(line.slice(0, 77));
  });

  it('shows the line and its cursor only with the prompt', () => {
    drawn();
    screen.disconnected = false;
    type('hi');
    opened();
    // On the blink's shown half.
    frames(1, 1536 - clock);
    expect([shown('console-input-7'), shown('console-cursor')]).toEqual([true, true]);
    screen.open = false;
    frames(1, 1);
    expect([shown('console-input-7'), shown('console-cursor')]).toEqual([false, false]);
    screen.disconnected = true;
    frames(1, 1);
    expect([shown('console-input-7'), shown('console-cursor')]).toEqual([true, true]);
  });

  it('draws the cursor white, an underline inserting and a block overstriking', () => {
    const cursor = () => box('console-cursor');
    drawn();
    type('hello');
    clock = 1024;
    opened();
    // In the cell after the line's last character: 2 for the prompt's, then 5.
    expect(cursor()).toEqual({ x: 7 * 8 + 0.5, down: 240 - 32 + 12, width: 7, height: 2 });
    expect(color('console-cursor')).toEqual([1, 1, 1, 1]);
    field.keyDown(K.HOME);
    field.keyDown(K.INS);
    frames(1);
    expect(cursor()).toEqual({ x: 2 * 8 + 1, down: 240 - 32 + 2, width: 6, height: 12 });
    // Twice the size under con_scale 2.
    settings.conScale = 2;
    frames(1);
    expect(cursor()).toEqual({ x: 2 * 16 + 2, down: 240 - 64 + 4, width: 12, height: 24 });
    // The line laid out again with it.
    expect(box('console-input-7')).toMatchObject({ x: 32, down: 240 - 64 + 16, height: 32 });
  });

  it('draws the cursor over the line, so the block hides the character it stands on', () => {
    drawn();
    type('hello');
    clock = 1024;
    opened();
    const order = (name: string) => find(name).element!.drawOrder;
    for (let color = 0; color < 8; color++) {
      expect(order('console-cursor')).toBeGreaterThan(order(`console-input-${color}`));
    }
  });

  it('blinks the cursor 256 ms on and 256 ms off on the clock', () => {
    drawn();
    opened();
    frames(1, 1536 - clock);
    const blink: boolean[] = [];
    for (let t = 0; t < 6; t++) {
      blink.push(shown('console-cursor'));
      frames(1, 128);
    }
    // 1536 on, 1664 on, 1792 off, 1920 off, 2048 on, 2176 on.
    expect(blink).toEqual([true, true, false, false, true, true]);
  });

  it('writes the line only when it changes', () => {
    drawn();
    type('hello');
    opened();
    find('console-input-7').element!.text = 'held';
    frames(3);
    expect(text('console-input-7')).toBe('held');
    type('!');
    frames(1);
    expect(text('console-input-7')).toBe('hello!');
  });

  it('marks a view scrolled back, and draws its text a row higher', () => {
    drawn(squareFont(app, 0.7));
    for (let i = 0; i < 20; i++) buffer.print(`line ${i}\n`, 1000);
    opened();
    expect(shown('console-marks')).toBe(false);
    buffer.pageUp();
    frames(1);
    expect(shown('console-marks')).toBe(true);
    expect(text('console-marks')).toBe('^   '.repeat(20).trimEnd());
    expect(box('console-marks')).toMatchObject({ x: 8, down: 240 - 48 + 4 });
    // One row fewer, its foot a row higher: line 17 at the bottom, a row over the marks.
    expect(box('console-text-7')).toMatchObject({ down: 240 - 64 - 12 * 16 + 4, height: 13 * 16 });
    expect(text('console-text-7').split('\n').at(-1)).toBe('line 17');
    buffer.bottom();
    frames(1);
    expect(shown('console-marks')).toBe(false);
  });

  it('writes its text only when the buffer changes', () => {
    drawn();
    buffer.print('hello\n', 1000);
    opened();
    // Text set by hand stays while the buffer holds still, though the console draws each frame.
    find('console-text-7').element!.text = 'held';
    frames(3);
    expect(text('console-text-7')).toBe('held');
    buffer.print('again\n', 1000);
    frames(1);
    expect(text('console-text-7').split('\n').slice(-2)).toEqual(['hello', 'again']);
  });

  it('moves nothing as it fills', () => {
    drawn(squareFont(app, 0.7));
    buffer.print('first\n', 1000);
    opened();
    const parts = ['console-panel', 'console-background', 'console-rule', 'console-text-7', 'console-prompt', 'console-version'];
    const before = parts.map(box);
    for (let i = 0; i < 40; i++) buffer.print(`^${i % 8}line ${i}^7 of text\n`, 1000);
    frames(1);
    expect(parts.map(box)).toEqual(before);
    // Each colour's text stands in the same box.
    expect(box('console-text-3')).toEqual(box('console-text-7'));
  });

  it("lays its grid out again for con_scale, and for the screen's size", () => {
    drawn(squareFont(app, 0.7));
    buffer.print('hello\n', 1000);
    opened();
    // 16 by 32 a character: the face drawn 16 across, and 6 rows of text in the 240.
    settings.conScale = 2;
    frames(1);
    expect(box('console-version')).toEqual({
      x: 640 - (Q3_VERSION.length + 1) * 16,
      down: 240 - 32 + 8,
      width: Q3_VERSION.length * 16,
      height: 32
    });
    expect(box('console-prompt')).toMatchObject({ x: 16, down: 240 - 64 + 8 });
    expect(find('console-version').element!.fontSize).toBe(16);
    expect(box('console-text-7')).toMatchObject({ down: 240 - 96 - 5 * 32 + 8, height: 6 * 32 });
    expect(text('console-text-7').split('\n')).toHaveLength(6);

    // Taller, the console is half of it.
    app.graphicsDevice.canvas.height = 960;
    frames(1);
    expect(box('console-background')).toMatchObject({ width: 640, height: 480 });
    expect(box('console-version')).toMatchObject({ down: 480 - 32 + 8 });

    // Wider, the version stands in from the new edge.
    app.graphicsDevice.canvas.width = 1920;
    frames(1);
    expect(box('console-version')).toMatchObject({ x: 1920 - (Q3_VERSION.length + 1) * 16 });
    expect(box('console-background')).toMatchObject({ width: 1920, height: 480 });
    expect(box('console-rule')).toMatchObject({ down: 480, height: 4 });
  });

  it('stops drawing, and leaves the scene and its font, once destroyed', () => {
    const font = squareFont(app, 0.7);
    const destroyed = vi.spyOn(font, 'destroy');
    drawn(font);
    expect(app.scene.layers.getLayerByName('console')).toBeTruthy();
    screen.destroy();
    expect(app.scene.layers.getLayerByName('console')).toBeFalsy();
    expect(destroyed).not.toHaveBeenCalled();
    screen.open = true;
    expect(() => frames(3)).not.toThrow();
  });
});
