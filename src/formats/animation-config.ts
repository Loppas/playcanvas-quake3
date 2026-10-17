import { ANIM } from '../sim/animations';
import type { FOOTSTEP_SETS } from './asset-manifest';
import { atof, atoi } from './c-scan';
import { comParse, parseCursor } from './com-parse';

/**
 * `animation.cfg`: which frames of a player model make each animation.
 *
 * A port of `CG_ParseAnimationFile` (`cg_players.c:90–291`), read with `COM_Parse`
 * ({@link comParse}). Keywords come first, in any order; the first token that starts with a
 * digit begins the table, one row per `ANIM` number: first frame, frame count, looping frames and
 * frames per second.
 *
 * The file numbers every frame as one sequence, deaths then torso then legs, but `lower.md3` holds
 * only the deaths and the legs. So every legs row loses the torso's frames, the gap between
 * `LEGS_WALKCR` and `TORSO_GESTURE` ("the skip"; 63 for sarge).
 *
 * Engine-free, like the other parsers: text in, table out.
 */

/** `animation_t` (`bg_public.h:533–541`). Times are whole milliseconds, as Q3's ints hold them. */
export interface Animation {
  /** The first frame, in the part's own MD3: a legs row has the skip taken off. */
  firstFrame: number;
  numFrames: number;
  /** How many of the last frames repeat once the animation has played; 0 holds the last. */
  loopFrames: number;
  /** Milliseconds between frames: `1000 / fps`, truncated as C's assignment to an int truncates. */
  frameLerp: number;
  /** Milliseconds from the frame before to the first frame; the same as {@link frameLerp}. */
  initialLerp: number;
  /** Played last frame first: a negative frame count in the file, or a derived backwards row. */
  reversed: boolean;
  /** Played forwards and back again. Q3 sets it for no row; the lines that would are commented out. */
  flipflop: boolean;
}

/** `footstep_t`, by the name of its sound set. */
export type Footsteps = keyof typeof FOOTSTEP_SETS;

/** `gender_t`: only the obituaries read it. */
export type Gender = 'male' | 'female' | 'neuter';

/** What a model's `animation.cfg` says. */
export interface AnimationConfig {
  /** One row per `ANIM` number, `ANIM.MAX_TOTALANIMATIONS` of them, the derived ones included. */
  animations: Animation[];
  footsteps: Footsteps;
  /** Added to the head's framing, in the HUD's head only (`cg_draw.c:339`). */
  headOffset: [number, number, number];
  gender: Gender;
  /** The legs follow the torso's yaw, with no lean (`cg_players.c:1475–1479`). */
  fixedLegs: boolean;
  /** The torso does not pitch (`cg_players.c:1446–1448`). */
  fixedTorso: boolean;
}

/** The buffer Q3 reads the file into: a file of its size less one, or more, is refused. */
const TEXT_BUFFER = 20000;

/** The `footsteps` values, with `default` for `normal` (`cg_players.c:139–151`). */
const FOOTSTEP_NAMES = new Map<string, Footsteps>([
  ['default', 'normal'],
  ['normal', 'normal'],
  ['boot', 'boot'],
  ['flesh', 'flesh'],
  ['mech', 'mech'],
  ['energy', 'energy']
]);

/** `1000 / 15` in C's integer division: the flag rows' rate. */
const FLAG_LERP_15 = Math.trunc(1000 / 15);
const FLAG_LERP_20 = Math.trunc(1000 / 20);

/**
 * Parse an `animation.cfg`.
 *
 * @param text - The file's contents.
 * @param label - Its path, for messages.
 * @param warn - Where Q3's console messages go: an unknown keyword, a bad `footsteps`, and why a
 *   file was refused.
 * @returns the table, or `null` for a file Q3 refuses, which fails the model and sends cgame to
 *   sarge (`cg_players.c:593–600`)
 */
export function parseAnimationConfig(
  text: string,
  label = 'animation.cfg',
  warn: (message: string) => void = () => {}
): AnimationConfig | null {
  if (text.length >= TEXT_BUFFER - 1) {
    warn(`File ${label} too long`);
    return null;
  }
  // Q3 reads up to the file's end or its first NUL, whichever comes first.
  const reader = parseCursor(text);

  const config: AnimationConfig = {
    animations: Array.from({ length: ANIM.MAX_TOTALANIMATIONS }, emptyAnimation),
    footsteps: 'normal',
    headOffset: [0, 0, 0],
    gender: 'male',
    fixedLegs: false,
    fixedTorso: false
  };

  for (;;) {
    const before = reader.at;
    const token = comParse(reader);
    if (!token) break;
    const keyword = token.toLowerCase();
    if (keyword === 'footsteps') {
      const value = comParse(reader);
      if (!value) break;
      const footsteps = FOOTSTEP_NAMES.get(value.toLowerCase());
      if (footsteps) config.footsteps = footsteps;
      else warn(`Bad footsteps parm in ${label}: ${value}`);
      continue;
    }
    if (keyword === 'headoffset') {
      for (let i = 0; i < 3; i++) {
        const value = comParse(reader);
        if (!value) break;
        config.headOffset[i] = atof(value);
      }
      continue;
    }
    if (keyword === 'sex') {
      const value = comParse(reader);
      if (!value) break;
      const letter = value[0].toLowerCase();
      config.gender = letter === 'f' ? 'female' : letter === 'n' ? 'neuter' : 'male';
      continue;
    }
    if (keyword === 'fixedlegs') {
      config.fixedLegs = true;
      continue;
    }
    if (keyword === 'fixedtorso') {
      config.fixedTorso = true;
      continue;
    }
    // A number starts the table: put it back for the rows to read.
    if (token[0] >= '0' && token[0] <= '9') {
      reader.at = before;
      break;
    }
    warn(`unknown token '${token}' in ${label}`);
  }

  const { animations } = config;
  let skip = 0;
  let row = 0;
  for (; row < ANIM.MAX_ANIMATIONS; row++) {
    let token = comParse(reader);
    if (!token) {
      // The six Team Arena rows may be left out; each then plays the gesture.
      if (row >= ANIM.TORSO_GETFLAG && row <= ANIM.TORSO_NEGATIVE) {
        animations[row] = { ...animations[ANIM.TORSO_GESTURE], reversed: false, flipflop: false };
        continue;
      }
      break;
    }
    const animation = animations[row];
    animation.firstFrame = atoi(token);
    if (row === ANIM.LEGS_WALKCR) {
      skip = animation.firstFrame - animations[ANIM.TORSO_GESTURE].firstFrame;
    }
    if (row >= ANIM.LEGS_WALKCR && row < ANIM.TORSO_GETFLAG) animation.firstFrame -= skip;

    token = comParse(reader);
    if (!token) break;
    animation.numFrames = atoi(token);
    animation.reversed = false;
    animation.flipflop = false;
    if (animation.numFrames < 0) {
      animation.numFrames = -animation.numFrames;
      animation.reversed = true;
    }

    token = comParse(reader);
    if (!token) break;
    animation.loopFrames = atoi(token);

    token = comParse(reader);
    if (!token) break;
    let fps = atof(token);
    if (fps === 0) fps = 1;
    animation.frameLerp = Math.trunc(1000 / fps);
    animation.initialLerp = Math.trunc(1000 / fps);
  }

  if (row !== ANIM.MAX_ANIMATIONS) {
    warn(`Error parsing animation file: ${label}`);
    return null;
  }

  // Walking and crouching backwards are the forward rows played in reverse.
  animations[ANIM.LEGS_BACKCR] = { ...animations[ANIM.LEGS_WALKCR], reversed: true };
  animations[ANIM.LEGS_BACKWALK] = { ...animations[ANIM.LEGS_WALK], reversed: true };
  // The CTF flag's cloth, hard-coded (`cg_players.c:260–280`).
  animations[ANIM.FLAG_RUN] = flagRow(0, 16, 16, FLAG_LERP_15, false);
  animations[ANIM.FLAG_STAND] = flagRow(16, 5, 0, FLAG_LERP_20, false);
  animations[ANIM.FLAG_STAND2RUN] = flagRow(16, 5, 1, FLAG_LERP_15, true);
  return config;
}

/** A row the file has not set, as Q3's zeroed `clientInfo_t` holds it. */
function emptyAnimation(): Animation {
  return {
    firstFrame: 0,
    numFrames: 0,
    loopFrames: 0,
    frameLerp: 0,
    initialLerp: 0,
    reversed: false,
    flipflop: false
  };
}

function flagRow(
  firstFrame: number,
  numFrames: number,
  loopFrames: number,
  frameLerp: number,
  reversed: boolean
): Animation {
  return { firstFrame, numFrames, loopFrames, frameLerp, initialLerp: frameLerp, reversed, flipflop: false };
}
