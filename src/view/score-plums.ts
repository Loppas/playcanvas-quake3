import { NUMBER_NAMES } from '../formats/asset-manifest';
import { copy, cross, length, madd, normalize, sub, vec3, type Vec3 } from '../sim/vec3';
import type { Rgba } from './hud-status';
import { LocalEntities, type LocalEntity } from './local-entities';
import type { FloatSprite } from './player-sprites';
import { localEntity } from './scene-sort';

/**
 * The score plums: `CG_ScorePlum` (`cg_effects.c:387–425`), which puts the points a score is worth
 * where it happened, and `CG_AddScorePlum` (`cg_localents.c:718–790`), which floats them up over
 * four seconds, swaying, and fades them out. Only the scorer sees one. Engine-free.
 */

/** How long a plum lasts (`cg_effects.c:402`). */
export const SCORE_PLUM_TIME = 4000;

/** `NUMBER_SIZE` (`cg_localents.c:716`): a digit's width, and twice its radius. */
const NUMBER_SIZE = 8;

/** The status bar's digits, 0 to 9 and then the minus sign, as `cgs.media.numberShaders`. */
const NUMBER_SHADERS = NUMBER_NAMES.map((name) => `gfx/2d/numbers/${name}_32b`);
const MINUS = 10;

const UP = vec3(0, 0, 1);

/** One plum: `le->startTime`, `endTime`, `radius` (the score) and `pos.trBase`. */
interface Plum {
  endTime: number;
  score: number;
  base: Vec3;
  /** Its place among the local entities. */
  place: LocalEntity;
}

/** A plum's colour for its score, before its fade (`cg_localents.c:729–746`). */
export function plumColor(score: number): [number, number, number] {
  if (score < 0) return [1, 0x11 / 255, 0x11 / 255];
  if (score >= 50) return [1, 0, 1];
  if (score >= 20) return [0, 0, 1];
  if (score >= 10) return [1, 1, 0];
  if (score >= 2) return [0, 1, 0];
  return [1, 1, 1];
}

export class ScorePlums {
  private plums: Plum[] = [];
  /** `CG_ScorePlum`'s `static vec3_t lastPos`: where the last plum was put, from the origin. */
  private readonly lastPos = vec3();
  private readonly localEntities: LocalEntities;

  /** @param localEntities - The pool each plum takes its place in. */
  constructor(localEntities = new LocalEntities()) {
    this.localEntities = localEntities;
  }

  /**
   * `CG_ScorePlum`: a plum for the client who scored, if that is the one this view is of and
   * `cg_scorePlums` is on. One within 20 units of the height of the last is put 20 lower, so two
   * from one spot do not overlap.
   *
   * @param client - Who scored: `otherEntityNum`.
   * @param own - `cg.predictedPlayerState.clientNum`.
   */
  add(
    client: number,
    origin: Vec3,
    score: number,
    time: number,
    own: number,
    enabled: boolean
  ): void {
    if (client !== own || !enabled) return;
    const base = copy(origin);
    if (origin.z >= this.lastPos.z - 20 && origin.z <= this.lastPos.z + 20) base.z -= 20;
    this.lastPos.x = origin.x;
    this.lastPos.y = origin.y;
    this.lastPos.z = origin.z;
    const place = this.localEntities.alloc();
    this.plums.push({ endTime: time + SCORE_PLUM_TIME, score: Math.trunc(score), base, place });
  }

  /** `CG_InitLocalEntities`, which a restart runs: every plum goes. */
  clear(): void {
    for (const { place } of this.plums) this.localEntities.free(place);
    this.plums = [];
  }

  /**
   * `CG_AddScorePlum` for every plum, a sprite for each digit. A plum whose time is up goes, and
   * so does one the view is within 20 units of, "so it doesn't add too much overdraw", or one
   * whose place the pool freed for a newer local entity.
   *
   * @param time - `cg.time`.
   * @param eye - `cg.refdef.vieworg`.
   */
  sprites(time: number, eye: Vec3): FloatSprite[] {
    const drawn: FloatSprite[] = [];
    this.plums = this.plums.filter((plum) => {
      if (plum.place.freed || time >= plum.endTime) return this.letGo(plum);
      const c = (plum.endTime - time) / SCORE_PLUM_TIME;
      const [r, g, b] = plumColor(plum.score);
      const alpha = c < 0.25 ? Math.trunc(0xff * 4 * c) / 0xff : 1;
      const color: Rgba = [r, g, b, alpha];

      let origin = vec3(plum.base.x, plum.base.y, plum.base.z + 110 - c * 100);
      const across = normalize(cross(sub(eye, origin), UP));
      origin = madd(origin, -10 + 20 * Math.sin(c * 2 * Math.PI), across);
      if (length(sub(origin, eye)) < 20) return this.letGo(plum);

      // The digits, least significant first, then the sign.
      let score = Math.abs(plum.score);
      const digits: number[] = [];
      do {
        digits.push(score % 10);
        score = Math.trunc(score / 10);
      } while (score);
      if (plum.score < 0) digits.push(MINUS);

      const count = digits.length;
      for (let i = 0; i < count; i++) {
        drawn.push({
          shader: NUMBER_SHADERS[digits[count - 1 - i]],
          origin: madd(origin, (count / 2 - i) * NUMBER_SIZE, across),
          radius: NUMBER_SIZE / 2,
          color,
          order: localEntity(plum.place.serial, i)
        });
      }
      return true;
    });
    return drawn;
  }

  /** Give a plum's place back, for the walk to drop it. */
  private letGo(plum: Plum): false {
    this.localEntities.free(plum.place);
    return false;
  }
}
