import { GT, TEAM } from '../sim/constants';
import type { AnnouncerCue } from './announcer';
import type { ClientInfo } from './client-info';
import { SCREEN_WIDTH } from './hud-layout';
import { BIGCHAR_HEIGHT, BIGCHAR_WIDTH, GIANT_WIDTH, stringLength } from './hud-text';
import type { HudText } from './hud';

/**
 * `CG_DrawWarmup` (`cg_draw.c:2348–2497`): what the screen says while a match waits to start —
 * "Waiting for players", the mode's name, and the countdown — and the countdown's last three
 * seconds said aloud as they are drawn. Engine-free.
 */

/** The countdown's second, which sizes the text and is said aloud as it moves on. */
export interface WarmupState {
  /** `cg.warmupCount`. */
  count: number;
  /**
   * `CS_WARMUP` as last drawn, or `null` before the first. A change of it starts the count again,
   * as `CG_ParseWarmup` does (`cg_servercmds.c:188`); the first is taken as it stands, as
   * `CG_SetConfigValues` takes it.
   */
  warmup: number | null;
  /**
   * `cg.warmup` zeroed: the countdown ran a second past its end, and is drawn no more until
   * `CS_WARMUP` changes (`:2436–2440`).
   */
  over: boolean;
}

/** The countdown's state, at the second it has not counted yet. */
export function createWarmupState(): WarmupState {
  return { count: 0, warmup: null, over: false };
}

/** What `CG_DrawWarmup` draws, and says. */
export interface WarmupBlock {
  lines: HudText[];
  /** The countdown's voice, when its second moved on to one of the three it says. */
  voice: AnnouncerCue | null;
}

/** The seconds `CG_DrawWarmup` says, by `cg.warmupCount`: one, two and three (`:2445–2457`). */
const COUNTDOWN_VOICES: readonly AnnouncerCue[] = ['count1', 'count2', 'count3'];

/** What the warmup block reads. */
export interface WarmupInput {
  /** `CS_WARMUP`: −1 waiting, the time the countdown ends at, or 0 being played. */
  warmup: number;
  /** `cg.time`, which the countdown counts down to. */
  time: number;
  /** `g_gametype`, which picks the name. */
  gametype: number;
  /** `cgs.clientinfo`, which a tournament reads the two players' names from. */
  clientInfo: (clientNum: number) => ClientInfo | null;
}

/**
 * `CG_DrawWarmup`'s names for the gametypes the port has (`:2404–2420`), and CPMA's for its own.
 */
const MODE_NAMES: Readonly<Record<number, string>> = {
  [GT.FFA]: 'Free For All',
  [GT.TEAM]: 'Team Deathmatch',
  [GT.CTF]: 'Capture the Flag',
  [GT.CA]: 'Clan Arena'
};

/** `GIANT_WIDTH` shrunk to fit the screen: `cw = 640 / w` once the line is over 20 wide. */
function giantWidth(text: string): number {
  const length = stringLength(text);
  return length > SCREEN_WIDTH / GIANT_WIDTH ? Math.floor(SCREEN_WIDTH / length) : GIANT_WIDTH;
}

/** A centred line of giant chars: `CG_DrawStringExt(320 - w * cw / 2, y, …)`. */
function giant(text: string, y: number, charWidth: number, charHeight: number): HudText {
  return {
    text,
    x: SCREEN_WIDTH / 2 - Math.trunc((stringLength(text) * charWidth) / 2),
    y,
    charWidth,
    charHeight,
    color: [1, 1, 1, 1],
    shadow: true,
    anchor: 'centre'
  };
}

/** The two players a tournament is between, as `CG_DrawWarmup` finds them (`:2373–2385`). */
function tournamentNames(input: WarmupInput): [string, string] | null {
  const names: string[] = [];
  for (let clientNum = 0; clientNum < 64 && names.length < 2; clientNum++) {
    const info = input.clientInfo(clientNum);
    if (info && info.team === TEAM.FREE) names.push(info.name);
  }
  return names.length === 2 ? [names[0], names[1]] : null;
}

/**
 * The warmup block for this frame, or nothing while a match is being played.
 *
 * Moves `state` on: the countdown's second, which sizes "Starts in" and which is said aloud when it
 * moves on to one of the last three.
 *
 * @param state - The countdown's second, from the last frame.
 * @param input - The warmup time, the clock and who is playing.
 */
export function hudWarmup(state: WarmupState, input: WarmupInput): WarmupBlock {
  const warmup = input.warmup;
  if (state.warmup !== null && warmup !== state.warmup) {
    state.count = -1;
    state.over = false;
  }
  state.warmup = warmup;
  if (!warmup || state.over) return { lines: [], voice: null };

  if (warmup < 0) {
    state.count = 0;
    const text = 'Waiting for players';
    return { lines: [giant(text, 24, BIGCHAR_WIDTH, BIGCHAR_HEIGHT)], voice: null };
  }

  const lines: HudText[] = [];
  if (input.gametype === GT.TOURNAMENT) {
    const names = tournamentNames(input);
    if (names) {
      const text = `${names[0]} vs ${names[1]}`;
      const cw = giantWidth(text);
      lines.push(giant(text, 20, cw, Math.trunc(cw * 1.5)));
    }
  } else {
    const mode = MODE_NAMES[input.gametype];
    if (mode) {
      const cw = giantWidth(mode);
      lines.push(giant(mode, 25, cw, Math.trunc(cw * 1.1)));
    }
  }

  // `sec = ( sec - cg.time ) / 1000`: a countdown a second past its end shows 1 a last time, and
  // `cg.warmup` is zeroed (`:2436–2441`).
  const sec = Math.trunc((warmup - input.time) / 1000);
  if (sec < 0) state.over = true;
  const count = Math.max(0, sec);
  const voice = count !== state.count ? (COUNTDOWN_VOICES[count] ?? null) : null;
  state.count = count;
  const starts = `Starts in: ${count + 1}`;
  const cw = count === 0 ? 28 : count === 1 ? 24 : count === 2 ? 20 : 16;
  lines.push(giant(starts, 70, cw, Math.trunc(cw * 1.5)));

  return { lines, voice };
}
