import { cleanStr } from '../formats/color-codes';
import { GT } from '../sim/constants';
import { SCREEN_WIDTH } from './hud-layout';
import { BIGCHAR_HEIGHT, BIGCHAR_WIDTH, GIANT_HEIGHT, GIANT_WIDTH, stringLength } from './hud-text';
import type { HudText } from './hud';

/**
 * What the screen says to somebody who is not playing: `CG_DrawSpectator` (`cg_draw.c:2083–2091`)
 * and `CG_DrawFollow` (`cg_draw.c:2249–2277`). Engine-free.
 */

/** White, which both of these are drawn in. */
const WHITE: HudText['color'] = [1, 1, 1, 1];

/**
 * A line of big chars where Quake 3 puts it, hand-centred: `CG_DrawBigString(320 - n * 8, y, …)`,
 * where `n` is the line's length and 8 is half a character. Written as the centring it is, which
 * comes to Q3's own numbers.
 */
function big(text: string, y: number): HudText {
  return {
    text,
    x: SCREEN_WIDTH / 2 - (stringLength(text) * BIGCHAR_WIDTH) / 2,
    y,
    charWidth: BIGCHAR_WIDTH,
    charHeight: BIGCHAR_HEIGHT,
    color: WHITE,
    shadow: true,
    anchor: 'centre'
  };
}

/**
 * `CG_DrawSpectator`: SPECTATOR along the bottom, and under it what to do about it.
 *
 * A tournament says to wait, because a place in it is the queue's to give. A game of sides says
 * to pick one, since nobody is put on a side without asking.
 *
 * @param gametype - `cgs.gametype`.
 */
export function spectatorLines(gametype: number): HudText[] {
  const lines = [big('SPECTATOR', 440)];
  if (gametype === GT.TOURNAMENT) lines.push(big('waiting to play', 460));
  else if (gametype >= GT.TEAM) lines.push(big('press ESC and use the JOIN menu to play', 460));
  return lines;
}

/**
 * `CG_DrawFollow`: "following" at the top, and under it, in giant characters, whoever is being
 * watched.
 *
 * The name is drawn with `forceColor`, so the colours its owner chose are not used; the port
 * takes the codes out, which is what drawing them in one colour comes to.
 *
 * @param name - `cgs.clientinfo[ps.clientNum].name`.
 */
export function followLines(name: string): HudText[] {
  const plain = cleanStr(name);
  return [
    big('following', 24),
    {
      text: plain,
      x: 0.5 * (SCREEN_WIDTH - GIANT_WIDTH * stringLength(plain)),
      y: 40,
      charWidth: GIANT_WIDTH,
      charHeight: GIANT_HEIGHT,
      color: WHITE,
      shadow: true,
      anchor: 'centre'
    }
  ];
}
