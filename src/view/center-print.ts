import { BIGCHAR_HEIGHT, BIGCHAR_WIDTH, GIANT_WIDTH, stringLength } from './hud-text';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from './hud-layout';
import { fadeAlpha } from './weapon-bar';

/**
 * `CG_CenterPrint` and `CG_DrawCenterString` (`cg_draw.c:1752–1846`): the message that stays in
 * the middle of the screen for a few moments — "No item to use", "Use Medkit", the match's `cp`
 * prints, "You fragged" and "FIGHT!". Engine-free, so the placement and the fade are testable
 * without a device.
 *
 * The state is `cg.centerPrint` and its four companions, and the drawing is one line at a time:
 * the message is split on its newlines, each line centred on the 640-wide grid, drawn
 * `charWidth` across and `1.5 ×` that down, in the one colour the fade gives, with no shadow.
 */

/** `cg.centerPrint` and the four numbers `CG_CenterPrint` keeps with it (`cg_local.h`). */
export interface CenterPrintState {
  /** The message, newlines and all. */
  text: string;
  /** `cg.centerPrintTime`: when it was raised, or 0 for one never raised. */
  time: number;
  /** `cg.centerPrintY`: the middle of the block, on Q3's grid. */
  y: number;
  /** `cg.centerPrintCharWidth`: how wide a character is drawn. */
  charWidth: number;
  /** `cg.centerPrintLines`: the message's lines, counted as it is raised. */
  lines: number;
}

/** Nothing raised: Q3's `cg` starts zeroed, and a time of 0 is what `CG_FadeColor` refuses. */
export function createCenterPrint(): CenterPrintState {
  return { text: '', time: 0, y: 0, charWidth: BIGCHAR_WIDTH, lines: 1 };
}

/** A message for `CG_CenterPrint`: its text, and where and how big it is to be drawn. */
export interface CenterPrintRequest {
  text: string;
  y: number;
  charWidth: number;
}

/** Where `CG_MapRestart` puts "FIGHT!": 120 down, in `GIANTCHAR_WIDTH * 2` (`cg_servercmds.c:488`). */
export const FIGHT_Y = 120;
export const FIGHT_CHAR_WIDTH = GIANT_WIDTH * 2;

/**
 * Where `CG_UseItem` puts its message: `SCREEN_HEIGHT * 0.30` down, in big chars
 * (`cg_event.c:360, 363`).
 */
export const USE_ITEM_Y = SCREEN_HEIGHT * 0.3;
/** `CG_UseItem`'s character width, which is `BIGCHAR_WIDTH` (`cg_event.c:360, 363`). */
export const USE_ITEM_CHAR_WIDTH = BIGCHAR_WIDTH;

/**
 * `CG_CenterPrint` (`cg_draw.c:1760–1777`): take the message, and count its lines.
 *
 * A later message simply replaces the one showing, as Q3's does.
 */
export function centerPrint(
  state: CenterPrintState,
  text: string,
  y: number,
  charWidth: number,
  time: number
): void {
  state.text = text;
  state.time = time;
  state.y = y;
  state.charWidth = charWidth;
  state.lines = 1;
  for (const ch of text) {
    if (ch === '\n') state.lines++;
  }
}

/** One line `CG_DrawCenterString` draws: where it starts, how big, and how faded. */
export interface CenterPrintLine {
  text: string;
  /** The first character's left edge, on Q3's grid, the line centred about the screen. */
  x: number;
  /** The line's top. */
  y: number;
  charWidth: number;
  charHeight: number;
  /** `CG_FadeColor`'s alpha, 1 until the last 200 ms. */
  alpha: number;
}

/** `CG_DrawCenterString`'s 50-character line buffer: a longer line is cut off there (`:1812–1817`). */
const LINE_LIMIT = 50;

/** The message's raw lines, each cut to what Q3's line buffer would carry. */
function messageLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split('\n')) lines.push(line.slice(0, LINE_LIMIT));
  return lines;
}

/**
 * `CG_DrawCenterString` (`cg_draw.c:1785–1846`): the lines to draw this frame, or none.
 *
 * Nothing is drawn before a message was raised or once its time is up, and the fade takes the
 * last {@link FADE_TIME} of `duration` — Q3's `CG_FadeColor(start, 1000 * cg_centertime)`.
 *
 * @param state - The message and how it was raised.
 * @param time - The game's clock, in milliseconds.
 * @param duration - How long it stays up, from `cg_centertime`.
 */
export function centerPrintLines(
  state: CenterPrintState,
  time: number,
  duration: number
): CenterPrintLine[] {
  if (!state.time) return [];
  const alpha = fadeAlpha(state.time, duration, time);
  if (alpha === null) return [];

  // The block's top: half of the message's lines, each counted as a BIGCHAR_HEIGHT whether or
  // not it draws that tall, as `cg.centerPrintLines * BIGCHAR_HEIGHT / 2` works it out (`:1807`).
  const lines = messageLines(state.text);
  let y = Math.trunc(state.y - (state.lines * BIGCHAR_HEIGHT) / 2);
  const height = Math.trunc(state.charWidth * 1.5);
  const drawn = lines.map((text) => {
    const line: CenterPrintLine = {
      text,
      x: Math.trunc((SCREEN_WIDTH - stringLength(text) * state.charWidth) / 2),
      y,
      charWidth: state.charWidth,
      charHeight: height,
      alpha
    };
    y += height;
    return line;
  });
  return drawn;
}
