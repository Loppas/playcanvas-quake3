import { COLOR_ESCAPE, isColorCode } from '../formats/color-codes';
import type { Settings } from '../settings/registry';
import { TEAM } from '../sim/constants';
import type { HudText } from './hud';
import { SCREEN_WIDTH, type HudRect } from './hud-layout';
import type { Rgba } from './hud-status';
import { TINYCHAR_HEIGHT, TINYCHAR_WIDTH } from './hud-text';

/**
 * The team chat box: `CG_AddToTeamChat`'s lines (`cg_servercmds.c:379–444`) and `CG_DrawTeamInfo`
 * (`cg_draw.c:1354–1408`), which shows the last few team lines over a band in the team's colour,
 * just above the status bar, each for `cg_teamChatTime`. Engine-free.
 */

/**
 * `TEAMCHAT_WIDTH` and `TEAMCHAT_HEIGHT` (`cg_local.h:71–72`): a line's characters, and the most
 * lines.
 */
export const TEAMCHAT_WIDTH = 80;
export const TEAMCHAT_HEIGHT = 8;

/** `CHATLOC_X` and `CHATLOC_Y` (`cg_draw.c:1360–1361`): the box's left edge, and its bottom. */
const CHATLOC_X = 0;
const CHATLOC_Y = 420;

/** `CG_DrawTeamInfo`'s band colours, at 0.33 (`cg_draw.c:1377–1392`). */
const RED: Rgba = [1, 0, 0, 0.33];
const BLUE: Rgba = [0, 0, 1, 0.33];
const GREEN: Rgba = [0, 1, 0, 0.33];

const WHITE: Rgba = [1, 1, 1, 1];

/** The settings the box reads: `cg_teamChatHeight` and `cg_teamChatTime`. */
export type TeamChatSettings = Pick<Settings, 'teamChatHeight' | 'teamChatTime'>;

/** `cgs.teamChatMsgs`, their times, and where the ring is written and read. */
export interface TeamChatState {
  /** `cgs.teamChatMsgs`: each line, its colour codes and all. */
  msgs: string[];
  /** `cgs.teamChatMsgTimes`: when each was said, on `cg.time`'s clock. */
  times: number[];
  /** `cgs.teamChatPos`: how many lines have been written, the next one's slot by its remainder. */
  pos: number;
  /** `cgs.teamLastChatPos`: the oldest line still showing. */
  lastPos: number;
}

/** The box as `CG_Init` leaves it, `cgs` cleared: no lines, each slot said at 0. */
export function createTeamChat(): TeamChatState {
  return {
    msgs: new Array<string>(TEAMCHAT_HEIGHT).fill(''),
    times: new Array<number>(TEAMCHAT_HEIGHT).fill(0),
    pos: 0,
    lastPos: 0
  };
}

/** How many lines the box keeps: `cg_teamChatHeight`, at most `TEAMCHAT_HEIGHT`. */
function chatHeight(setting: number): number {
  return setting < TEAMCHAT_HEIGHT ? setting : TEAMCHAT_HEIGHT;
}

/**
 * `CG_AddToTeamChat`: a team line into the box, wrapped to `TEAMCHAT_WIDTH` characters, colour
 * codes aside. A line wraps at its last space, which is dropped, or is cut where it is with none;
 * the next starts with the last colour code read, which after backing up to the space can be one
 * past it, as the C's does. With the box off, by its height or its time, nothing is kept.
 *
 * @param text - The line as cgame prints it, its markers taken out.
 * @param time - `cg.time`.
 */
export function addToTeamChat(
  state: TeamChatState,
  text: string,
  settings: TeamChatSettings,
  time: number
): void {
  const height = chatHeight(settings.teamChatHeight);
  if (height <= 0 || settings.teamChatTime <= 0) {
    state.pos = state.lastPos = 0;
    return;
  }

  const said = Math.floor(time);
  let line = '';
  let len = 0;
  let lastColor = '7';
  // Where in `line` its last space is, or -1 for none.
  let lastSpace = -1;
  let at = 0;
  while (at < text.length) {
    if (len > TEAMCHAT_WIDTH - 1) {
      if (lastSpace >= 0) {
        at -= line.length - lastSpace - 1;
        line = line.slice(0, lastSpace);
      }
      state.msgs[state.pos % height] = line;
      state.times[state.pos % height] = said;
      state.pos++;
      line = COLOR_ESCAPE + lastColor;
      len = 0;
      lastSpace = -1;
    }

    if (isColorCode(text, at)) {
      lastColor = text[at + 1];
      line += text.slice(at, at + 2);
      at += 2;
      continue;
    }
    if (text[at] === ' ') lastSpace = line.length;
    line += text[at];
    at++;
    len++;
  }
  state.msgs[state.pos % height] = line;
  state.times[state.pos % height] = said;
  state.pos++;

  if (state.pos - state.lastPos > height) state.lastPos = state.pos - height;
}

/** What `CG_DrawTeamInfo` draws this frame: the band, and the lines over it. */
export interface TeamChatFrame {
  /** `teamStatusBar` behind the lines: 640 wide on Q3's grid, laid across the screen. */
  band: HudRect;
  /** The band's colour, by the player's own team. */
  color: Rgba;
  /** The lines showing, newest first, as `CG_DrawTeamInfo` draws them. */
  lines: HudText[];
}

/**
 * `CG_DrawTeamInfo`: the lines still showing, newest at the bottom. The oldest goes once it is
 * older than `cg_teamChatTime`, one a drawn frame. Moves `state` on.
 *
 * @param time - `cg.time`.
 * @param team - `cgs.clientinfo[cg.clientNum].team`: the player's own, whoever they follow. Red and
 *   blue tint the band their colour, and any other green.
 * @returns what to draw, or `null` with the box off or nothing showing.
 */
export function drawTeamChat(
  state: TeamChatState,
  settings: TeamChatSettings,
  time: number,
  team: number
): TeamChatFrame | null {
  const height = chatHeight(settings.teamChatHeight);
  if (height <= 0 || state.lastPos === state.pos) return null;
  if (Math.floor(time) - state.times[state.lastPos % height] > settings.teamChatTime) {
    state.lastPos++;
  }
  if (state.lastPos === state.pos) return null;

  const h = (state.pos - state.lastPos) * TINYCHAR_HEIGHT;
  const lines: HudText[] = [];
  for (let i = state.pos - 1; i >= state.lastPos; i--) {
    lines.push({
      text: state.msgs[i % height],
      x: CHATLOC_X + TINYCHAR_WIDTH,
      y: CHATLOC_Y - (state.pos - i) * TINYCHAR_HEIGHT,
      charWidth: TINYCHAR_WIDTH,
      charHeight: TINYCHAR_HEIGHT,
      color: WHITE,
      shadow: false,
      anchor: 'left'
    });
  }
  return {
    band: { x: CHATLOC_X, y: CHATLOC_Y - h, w: SCREEN_WIDTH, h },
    color: team === TEAM.RED ? RED : team === TEAM.BLUE ? BLUE : GREEN,
    lines
  };
}
