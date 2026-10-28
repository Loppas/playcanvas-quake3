import { colorIndex, isColorCode } from '../formats/color-codes';

/**
 * Q3's text on the HUD: characters cut from `gfx/2d/bigchars`, a grid of 16×16 cells
 * (`CG_DrawChar`, `CG_DrawStringExt`; `cg_drawtools.c:122–215`). Engine-free.
 */

/** Q3's character sizes on the virtual screen (`q_shared.h:377–387`). */
export const BIGCHAR_WIDTH = 16;
export const BIGCHAR_HEIGHT = 16;
export const SMALLCHAR_WIDTH = 8;
export const SMALLCHAR_HEIGHT = 16;
export const TINYCHAR_WIDTH = 8;
export const TINYCHAR_HEIGHT = 8;
export const GIANT_WIDTH = 32;
export const GIANT_HEIGHT = 48;

/**
 * `g_smallchar_width` and `g_smallchar_height` (`cl_console.c:289–293`): the console's character,
 * in the screen's own pixels, under `con_scale`. The console's text, its width in characters and
 * the notify lines all take it, so they are scaled together.
 */
export function smallCharWidth(conScale: number): number {
  return Math.trunc(SMALLCHAR_WIDTH * conScale);
}

export function smallCharHeight(conScale: number): number {
  return Math.trunc(SMALLCHAR_HEIGHT * conScale);
}

/** `CG_DrawStringExt`'s drop shadow: black, 2 right and 2 down (`cg_drawtools.c:175–191`). */
export const SHADOW_OFFSET = 2;

/** `bigchars` is 16 cells across and 16 down. */
export const CHARSET_CELLS = 16;

/** One character: where it starts, its cell in the grid, and the colour a code set for it. */
export interface Glyph {
  x: number;
  row: number;
  col: number;
  /** `ColorIndex` of the `^` code before it, or none: `CG_DrawStringExt`'s `newColor`. */
  color?: number;
}

/**
 * The characters of a line, one every `charWidth` from `x`, as `CG_DrawStringExt` lays them.
 *
 * A `^` code is not drawn and takes no place: it colours what follows, as Q3 reads one
 * (`cg_drawtools.c:155–165`). A space keeps its place and draws nothing (`CG_DrawChar`).
 */
export function stringGlyphs(text: string, x: number, charWidth: number): Glyph[] {
  const glyphs: Glyph[] = [];
  let color: number | undefined;
  let place = 0;
  for (let at = 0; at < text.length; at++) {
    if (isColorCode(text, at)) {
      color = colorIndex(text[at + 1]);
      at++;
      continue;
    }
    const ch = text.charCodeAt(at) & 255;
    if (ch !== 32) {
      const glyph: Glyph = { x: x + place * charWidth, row: ch >> 4, col: ch & 15 };
      if (color !== undefined) glyph.color = color;
      glyphs.push(glyph);
    }
    place++;
  }
  return glyphs;
}

/** `CG_DrawStrlen`: the characters a line draws, colour codes aside. */
export function stringLength(text: string): number {
  let length = 0;
  for (let at = 0; at < text.length; at++) {
    if (isColorCode(text, at)) {
      at++;
      continue;
    }
    length++;
  }
  return length;
}

/** `CG_DrawStrlen` times the character width. */
export function stringWidth(text: string, charWidth: number): number {
  return stringLength(text) * charWidth;
}
