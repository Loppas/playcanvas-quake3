import { SCREEN_WIDTH, type HudRect } from './hud-layout';
import { BIGCHAR_HEIGHT, BIGCHAR_WIDTH, stringLength } from './hud-text';
import type { HudText } from './hud';
import { LAGOMETER_BOX } from './speedometer';

/**
 * `CG_DrawDisconnect` (`cg_draw.c:1589–1623`): what the screen says once the server has stopped
 * answering, a line across the top and the phone jack blinking at the bottom right. Engine-free.
 */

/** The line, as Q3 words it. */
export const INTERRUPTED = 'Connection Interrupted';

/** Its top on Q3's grid (`cg_draw.c:1607`). */
const INTERRUPTED_Y = 100;

/** What the screen shows for an interrupted connection this frame. */
export interface HudDisconnect {
  /** The line, white and shadowed, centred. */
  text: HudText;
  /** The icon's box, the lagometer's (`cg_draw.c:1618–1622`), or `null` while it blinks off. */
  icon: HudRect | null;
}

/**
 * The line, and the icon on and off every 512 ms: off while `cg.time`'s ninth bit is set
 * (`cg_draw.c:1610–1612`).
 *
 * @param time - `cg.time`, whose whole milliseconds the blink reads.
 */
export function disconnectFrame(time: number): HudDisconnect {
  return {
    text: {
      text: INTERRUPTED,
      x: SCREEN_WIDTH / 2 - (stringLength(INTERRUPTED) * BIGCHAR_WIDTH) / 2,
      y: INTERRUPTED_Y,
      charWidth: BIGCHAR_WIDTH,
      charHeight: BIGCHAR_HEIGHT,
      color: [1, 1, 1, 1],
      shadow: true,
      anchor: 'centre'
    },
    icon: (time >> 9) & 1 ? null : LAGOMETER_BOX
  };
}
