import { GT, SCORE_NOT_PRESENT, TEAM } from '../sim/constants';
import { SCREEN_HEIGHT, SCREEN_WIDTH, type HudRect } from './hud-layout';
import { ICON_SIZE, type Rgba } from './hud-status';
import { BIGCHAR_HEIGHT, BIGCHAR_WIDTH } from './hud-text';
import type { HudText } from './hud';

/**
 * `CG_DrawScores` (`cg_draw.c:1018–1161`): the two small score boxes at the lower right, and the
 * limit to their left. Engine-free: this says where each box and its number go and in what colour,
 * and the render layer draws them.
 */

/** What the score area reads: the configstrings' scores and limits, and the player's own numbers. */
export interface ScoresInput {
  /** `g_gametype`, which picks the two halves. */
  gametype: number;
  /** `CS_SCORES1`: the top score, or red's in a team game. */
  scores1: number;
  /** `CS_SCORES2`: the second score, or blue's. */
  scores2: number;
  /** `PERS_SCORE`: the player's own. */
  score: number;
  /** `PERS_TEAM`, which picks which box is the player's. */
  team: number;
  /** `cgs.fraglimit`. */
  fraglimit: number;
  /** `cgs.capturelimit`. */
  capturelimit: number;
  /** Clan Arena's round limit. */
  roundlimit: number;
  /** `cgs.redflag` and `cgs.blueflag`: where each flag is, or −1 for a match that has not said. */
  redflag: number;
  blueflag: number;
}

/** One score box: its fill, whether the player's frame is round it, and its number. */
export interface ScoreBox {
  rect: HudRect;
  /** The fill's colour, at Q3's 0.33 alpha. */
  color: Rgba;
  /** `gfx/2d/select`'s frame, on the player's own box. */
  framed: boolean;
  text: HudText;
  /** That side's flag, a box's height above this one in Capture the Flag; `null` otherwise. */
  flag: ScoreFlag | null;
}

/** Where a side's flag stands, drawn over its score box. */
export interface ScoreFlag {
  rect: HudRect;
  /** `icons/iconf_red1`–`3` or `icons/iconf_blu1`–`3`, by where the flag is. */
  icon: string;
}

/** The score area for a frame. */
export interface HudScores {
  /** Rightmost first, as `CG_DrawScores` draws them. */
  boxes: ScoreBox[];
  /** The frag or capture limit, unboxed, to the left. */
  limit: HudText | null;
}

/** `CG_DrawScores`' colours (`cg_draw.c:1054–1058, 1087–1094`). */
const GREY: Rgba = [0.5, 0.5, 0.5, 0.33];
const BLUE: Rgba = [0, 0, 1, 0.33];
const RED: Rgba = [1, 0, 0, 0.33];
const WHITE: Rgba = [1, 1, 1, 1];

/** `CG_DrawLowerRight` starts a row up from the bottom (`480 − ICON_SIZE`), and the scores take one. */
export const SCORES_Y = SCREEN_HEIGHT - ICON_SIZE - (BIGCHAR_HEIGHT + 8);

/** A box is a row high, 4 above and below its text (`CG_DrawScores`' `y-4` and `+8`). */
export const SCORE_BOX_TOP = SCORES_Y - 4;
export const SCORE_BOX_HEIGHT = BIGCHAR_HEIGHT + 8;

/** The text starts 4 in from the box's left edge. */
const TEXT_INSET = 4;

/**
 * Each side's three flag icons, in the order `CG_RegisterCvars` registers them
 * (`cg_main.c:898–903`): at its base, carried, and lying where it was dropped.
 */
const FLAG_ICONS: Readonly<Record<number, readonly string[]>> = {
  [TEAM.RED]: ['icons/iconf_red1', 'icons/iconf_red2', 'icons/iconf_red3'],
  [TEAM.BLUE]: ['icons/iconf_blu1', 'icons/iconf_blu2', 'icons/iconf_blu3']
};

/** A box's width: its digits, and 8 more (`w = CG_DrawStrlen(s) * BIGCHAR_WIDTH + 8`). */
function boxWidth(text: string): number {
  return text.length * BIGCHAR_WIDTH + 8;
}

/** `%2i`: the number right-aligned in two places, which is what Q3 measures the box from. */
function numberText(value: number): string {
  return String(value).padStart(2);
}

/**
 * The score area for this frame.
 *
 * @param input - The scores, the limits and who the player is.
 * @returns the boxes and the limit, with the rightmost box first as Q3 draws them.
 */
export function hudScores(input: ScoresInput): HudScores {
  const boxes: ScoreBox[] = [];
  let x = SCREEN_WIDTH;
  let limit: HudText | null = null;

  const text = (value: number, at: number): HudText => ({
    text: numberText(value),
    x: at + TEXT_INSET,
    y: SCORES_Y,
    charWidth: BIGCHAR_WIDTH,
    charHeight: BIGCHAR_HEIGHT,
    color: WHITE,
    shadow: true,
    anchor: 'right'
  });

  const box = (value: number, color: Rgba, framed: boolean, flagTeam: number = TEAM.FREE): void => {
    const shown = numberText(value);
    const w = boxWidth(shown);
    x -= w;
    boxes.push({
      rect: { x, y: SCORE_BOX_TOP, w, h: SCORE_BOX_HEIGHT },
      color,
      framed,
      text: text(value, x),
      flag: scoreFlag(input, flagTeam, x, w)
    });
  };

  const unboxed = (value: number): void => {
    const shown = numberText(value);
    x -= boxWidth(shown);
    limit = text(value, x);
  };

  if (input.gametype >= GT.TEAM) {
    // Blue's box, then red's (`cg_draw.c:1035–1097`): the rightmost is blue's.
    box(input.scores2, BLUE, input.team === TEAM.BLUE, TEAM.BLUE);
    box(input.scores1, RED, input.team === TEAM.RED, TEAM.RED);

    const limitValue =
      input.gametype === GT.CA
        ? input.roundlimit
        : input.gametype >= GT.CTF
          ? input.capturelimit
          : input.fraglimit;
    if (limitValue) unboxed(limitValue);
    return { boxes, limit };
  }

  const spectator = input.team === TEAM.SPECTATOR;
  const { scores1 } = input;
  // "Always show your score in the second box if not in first place" (`:1119–1122`).
  let scores2 = input.score !== scores1 ? input.score : input.scores2;

  if (scores2 !== SCORE_NOT_PRESENT) {
    const mine = !spectator && input.score === scores2 && input.score !== scores1;
    box(scores2, mine ? RED : GREY, mine);
  }
  if (scores1 !== SCORE_NOT_PRESENT) {
    const mine = !spectator && input.score === scores1;
    box(scores1, mine ? BLUE : GREY, mine);
  }
  if (input.fraglimit) unboxed(input.fraglimit);

  return { boxes, limit };
}

/**
 * A side's flag over its score box (`cg_draw.c:1050–1060`, `:1074–1084`): the same width and the
 * same left edge, one box-height up.
 *
 * Only Capture the Flag has flags, and only a status Quake 3 has an icon for is drawn — "0 is at
 * base, 1 is taken, 2 is dropped", and anything else, an unset −1 among them, draws nothing.
 */
function scoreFlag(input: ScoresInput, team: number, x: number, w: number): ScoreFlag | null {
  if (input.gametype !== GT.CTF) return null;
  const status = team === TEAM.RED ? input.redflag : input.blueflag;
  const icon = FLAG_ICONS[team]?.[status];
  if (icon === undefined) return null;
  return { rect: { x, y: SCORE_BOX_TOP - SCORE_BOX_HEIGHT, w, h: SCORE_BOX_HEIGHT }, icon };
}
