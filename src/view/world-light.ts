import { LIGHTMAP_SIZE } from '../formats/bsp';

/**
 * A map's baked light as opengl1 loads it: every lightmap texel and every draw vertex's colour
 * shifted by `r_mapOverBrightBits` less the overbright bits in effect
 * (`R_ColorShiftLightingBytes`, `tr_bsp.c:100-126`). The maps are lit for a ramp of
 * `r_mapOverBrightBits`, and the shift gives back what the screen's own ramp will not.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** The texels of one page. */
const PAGE_TEXELS = LIGHTMAP_SIZE * LIGHTMAP_SIZE;

/**
 * `R_ColorShiftLightingBytes` on one colour: its red, green and blue read from `input` at `from`,
 * shifted, and written to `output` at `to`. Where a channel passes 255, all three are scaled by
 * 255 over the largest, in integers, so the light keeps its hue rather than turning white. Its
 * alpha is the caller's.
 *
 * @param shift - `r_mapOverBrightBits` less the overbright bits in effect. Q3 shifts left by it,
 *   which C leaves undefined below zero; a shift below zero shifts right.
 */
export function colorShiftLightingBytes(
  input: Uint8Array,
  from: number,
  output: Uint8Array,
  to: number,
  shift: number
): void {
  const shifted = (value: number) => (shift >= 0 ? value << shift : value >> -shift);
  let r = shifted(input[from]);
  let g = shifted(input[from + 1]);
  let b = shifted(input[from + 2]);
  if ((r | g | b) > 255) {
    const max = Math.max(r, g, b);
    r = Math.trunc((r * 255) / max);
    g = Math.trunc((g * 255) / max);
    b = Math.trunc((b * 255) / max);
  }
  output[to] = r;
  output[to + 1] = g;
  output[to + 2] = b;
}

/** The draw vertices' colours, four bytes each, shifted with their alpha kept. */
export function shiftedVertexColors(colors: Uint8Array, shift: number): Uint8Array {
  const shifted = new Uint8Array(colors.length);
  for (let at = 0; at < colors.length; at += 4) {
    colorShiftLightingBytes(colors, at, shifted, at, shift);
    shifted[at + 3] = colors[at + 3];
  }
  return shifted;
}

/**
 * `tr.numLightmaps`: the lump's pages, where a single page counts as two (`tr_bsp.c:152-157`), so a
 * surface asking for the second is lit by a lightmap rather than by its vertices.
 */
export function lightmapCount(pages: number): number {
  return pages === 1 ? 2 : pages;
}

/**
 * The lightmap pages as `R_LoadLightmaps` makes them (`tr_bsp.c:135-210`): each 128×128 page of
 * three-byte texels shifted into four bytes, opaque. Q3 reads a single page's second from past
 * the lump's end; here it is black.
 */
export function lightmapPages(lightmaps: readonly Uint8Array[], shift: number): Uint8Array[] {
  return Array.from({ length: lightmapCount(lightmaps.length) }, (_, i) => {
    const page = lightmaps[i] ?? new Uint8Array(PAGE_TEXELS * 3);
    const texels = new Uint8Array(PAGE_TEXELS * 4);
    for (let j = 0; j < PAGE_TEXELS; j++) {
      colorShiftLightingBytes(page, j * 3, texels, j * 4, shift);
      texels[j * 4 + 3] = 255;
    }
    return texels;
  });
}
