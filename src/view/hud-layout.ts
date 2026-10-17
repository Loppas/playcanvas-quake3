/**
 * The HUD's screen: Q3's 640×480 grid, scaled by the height.
 *
 * Q3 lays every 2D element out on a 640×480 virtual screen and stretches each axis on its own
 * (`CG_AdjustFrom640`, `cg_drawtools.c:33–45`), so on a wide screen everything comes out wider.
 * The port scales both axes by the height, `H / 480`, so a glyph keeps its shape, and anchors each
 * element where its group sits on Q3's screen: the ammo slot to the left edge, the right-hand items
 * to the right edge, and the rest to the middle. At 4:3 the three agree, and the HUD is Q3's.
 *
 * Engine-free: the render layer places the HUD's pictures and each 3D icon's view by it.
 */

/** `SCREEN_WIDTH` and `SCREEN_HEIGHT` (`q_shared.h:374–375`): the virtual screen. */
export const SCREEN_WIDTH = 640;
export const SCREEN_HEIGHT = 480;

/** Which edge of the screen an element keeps its distance from, or the middle. */
export type HudAnchor = 'left' | 'centre' | 'right';

/** A rectangle on Q3's grid, or in pixels: y down from the top, as Q3 measures it. */
export interface HudRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pixels to a unit of Q3's grid, on a screen `height` pixels tall. */
export function hudScale(height: number): number {
  return height / SCREEN_HEIGHT;
}

/**
 * Where Q3's grid starts across a screen of `width` × `height` pixels, for a group kept to
 * `anchor`: its distance from that edge, or from the middle, stays Q3's.
 */
export function anchorOrigin(anchor: HudAnchor, width: number, height: number): number {
  const spare = width - SCREEN_WIDTH * hudScale(height);
  return anchor === 'left' ? 0 : anchor === 'right' ? spare : spare / 2;
}

/**
 * Where a rectangle on Q3's grid lands on a screen of `width` × `height` pixels.
 *
 * @param anchor - The rectangle's group.
 */
export function screenRect(
  rect: HudRect,
  anchor: HudAnchor,
  width: number,
  height: number
): HudRect {
  const scale = hudScale(height);
  const origin = anchorOrigin(anchor, width, height);
  return { x: origin + rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale };
}
