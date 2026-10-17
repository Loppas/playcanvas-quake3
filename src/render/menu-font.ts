import { CanvasFont, Texture, type AppBase } from 'playcanvas';

import { LIST_ARROWS } from '../view/menu-widgets';

/**
 * The menu's font: a system face, drawn white into an atlas at start (`CanvasFont`), and settled for
 * the way the engine draws it:
 * - Each glyph is raised so that its capitals' middle stands on its line's. The engine centres a
 *   line by its glyphs' cells, whose middle stands above the capitals' by an amount the face sets.
 * - The atlas's empty texels are made clear. The engine clears its atlas to the text's colour at an
 *   alpha of 1/255, which shows as a faint box round each word.
 */

/** The face, and the size its atlas is drawn at: large, so the text stays sharp at any scale. */
const FONT_FACE = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_ATLAS_SIZE = 64;
const FONT_ATLAS_PIXELS = 1024;
/** Every character the menu shows: printable ASCII, which a Q3 name keeps to, and list arrows. */
const PRINTABLE = String.fromCharCode(...Array.from({ length: 95 }, (_, i) => 32 + i));
const CHARACTERS = PRINTABLE + LIST_ARROWS.up + LIST_ARROWS.down;

/** A glyph as `CanvasFont` records it: its cell in its atlas, in pixels, and its offsets. */
interface Glyph {
  x: number;
  y: number;
  width: number;
  height: number;
  yoffset: number;
  /** The size the atlas is drawn at, over 32: its offsets are in pixels over this. */
  scale: number;
  map: number;
}

/** A `CanvasFont`'s atlas: the canvas it is drawn on, and the texture the text samples. */
interface Atlas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: Texture;
}

/** The menu's font, and the height of its capitals. */
export class MenuFont extends CanvasFont {
  /** The capitals' height, as a fraction of the size the text is drawn at. */
  capitals = 0;
  /** A glyph's cell's height, which the engine boxes a line of text by, as a fraction of the size. */
  cell = 0;
}

/** The menu's font, its atlas drawn and settled now, for every character the menu shows. */
export function createMenuFont(app: AppBase): MenuFont {
  const font = new MenuFont(app, {
    fontName: FONT_FACE,
    fontSize: FONT_ATLAS_SIZE,
    width: FONT_ATLAS_PIXELS,
    height: FONT_ATLAS_PIXELS,
    padding: 2
  });
  // Each drawing of the atlas remakes its glyphs and redraws its canvas, so each is settled afresh.
  font.on('render', () => settle(app, font));
  font.createTextures(CHARACTERS);
  return font;
}

/**
 * Raise a font's glyphs to its capitals' middle, measured on its `H`, and give its atlases clear
 * empty texels.
 */
export function settle(app: AppBase, font: MenuFont): void {
  const glyphs = (font.data as { chars: Record<string, Glyph> }).chars;
  const capital = glyphs.H;
  const atlases = font.atlases as Atlas[];
  atlases.forEach((atlas, map) => {
    const { canvas, ctx, texture } = atlas;
    const { width, height } = canvas;
    const texels = clearTexels(ctx.getImageData(0, 0, width, height).data);
    if (map === capital.map) {
      const ink = inkRows(texels, width, capital);
      font.capitals = ink.height / (capital.scale * 32);
      font.cell = capital.height / (capital.scale * 32);
      const raise = ink.middle - capital.height / 2;
      for (const glyph of Object.values(glyphs)) glyph.yoffset -= raise / glyph.scale;
    }
    atlas.texture = new Texture(app.graphicsDevice, {
      name: texture.name,
      format: texture.format,
      width,
      height,
      mipmaps: texture.mipmaps,
      minFilter: texture.minFilter,
      magFilter: texture.magFilter,
      addressU: texture.addressU,
      addressV: texture.addressV,
      levels: [texels]
    });
    texture.destroy();
  });
}

/**
 * How wide a line of text is drawn at `size`, as the engine lays it: each glyph's advance, which
 * a font records at 32. A character the font lacks counts for nothing.
 */
export function textWidth(font: CanvasFont, text: string, size: number): number {
  const glyphs = (font.data as { chars: Record<string, { xadvance: number } | undefined> }).chars;
  let width = 0;
  for (const char of text) width += glyphs[char]?.xadvance ?? 0;
  return (width * size) / 32;
}

/** A rectangle of an atlas, in pixels. */
export interface Cell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a glyph's ink stands down its cell, from an atlas's RGBA texels, `stride` across: its
 * middle, down from the cell's top, and its height. Each row counts by its most-covered texel, so
 * that a capital's stems cover each row they cross whole.
 */
export function inkRows(rgba: ArrayLike<number>, stride: number, cell: Cell): { middle: number; height: number } {
  let height = 0;
  let moment = 0;
  for (let row = 0; row < cell.height; row++) {
    let most = 0;
    for (let column = 0; column < cell.width; column++) {
      most = Math.max(most, rgba[4 * ((cell.y + row) * stride + cell.x + column) + 3]);
    }
    height += most / 255;
    moment += (most / 255) * (row + 0.5);
  }
  return { middle: height > 0 ? moment / height : cell.height / 2, height };
}

/**
 * An atlas's texels as the text samples them: white throughout, so that filtering at a glyph's
 * edge blends with white rather than black, and clear where the engine's clear left only its 1/255.
 */
export function clearTexels(rgba: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = out[i + 1] = out[i + 2] = 255;
    out[i + 3] = rgba[i + 3] > 1 ? rgba[i + 3] : 0;
  }
  return out;
}
