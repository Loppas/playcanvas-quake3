import { CONTENTS, DEFAULT_GRAVITY } from '../sim/constants';
import { NO_CONTENTS, type PointContentsFn, type TraceFn, type TraceResult } from '../sim/types';
import { copy, dot, length, madd, scale, sub, vec3, type Vec3 } from '../sim/vec3';
import { LocalEntities, type LocalEntity } from './local-entities';

/**
 * Gibs: `CG_GibPlayer` and `CG_LaunchGib`
 * (`cg_effects.c:529–639`), and the `LE_FRAGMENT` and `LE_FALL_SCALE_FADE` cases of
 * `CG_AddLocalEntities` (`cg_localents.c:121–316`, `438–465`).
 *
 * A gib is a local entity: the client throws it, moves it and lets it go, and the game never
 * knows of it. Each piece falls under gravity from where the player was, traced as a point
 * against the world every frame. Until it first hits something it trails a puff of blood every
 * 150 ms; the first hit may splat, and bounces it back at 0.6 of its speed. A bounce off a floor
 * that leaves it rising at less than 40 ups lays it to rest, and it sinks 16 units over its last
 * second before it goes. One that hits something in nodrop goes at once, silent. Its first bounce
 * leaves a mark of blood where it lands (`CG_FragmentBounceMark`).
 *
 * Engine-free, like the rest of `src/view/`. The caller runs it once a rendered frame, on the
 * game clock in whole milliseconds as `cg.time` counts, because Q3's fragments move per frame,
 * not per tick.
 */

/** `GIB_VELOCITY` (`cg_effects.c:562`): a piece flies at up to this along each axis... */
export const GIB_VELOCITY = 250;

/** `GIB_JUMP` (`cg_effects.c:563`): ...and this much more upward. */
export const GIB_JUMP = 250;

/** A piece lasts this long, and up to {@link GIB_LIFETIME_SPREAD} more (`cg_effects.c:538`). */
export const GIB_LIFETIME = 5000;
export const GIB_LIFETIME_SPREAD = 3000;

/** `bounceFactor` (`cg_effects.c:549`): what a bounce keeps of the speed. */
export const GIB_BOUNCE = 0.6;

/** A floor bounce that leaves less upward speed than this lays the piece to rest (`cg_localents.c:231–234`). */
export const FRAGMENT_REST_SPEED = 40;

/** `SINK_TIME` (`cg_local.h:52`): a piece at rest sinks over its last second... */
export const SINK_TIME = 1000;

/** ...by this far (`cg_localents.c:262`). */
export const SINK_DEPTH = 16;

/** `CG_BloodTrail` lays a puff at each multiple of this many milliseconds (`cg_localents.c:128`). */
export const BLOOD_TRAIL_STEP = 150;

/** Each puff: `CG_SmokePuff`'s radius and life (`cg_localents.c:135–142`)... */
export const BLOOD_PUFF_RADIUS = 20;
export const BLOOD_PUFF_LIFETIME = 2000;

/** ...falling this far as it fades (`cg_localents.c:146`). */
export const BLOOD_PUFF_DROP = 40;

/** `CG_AddFallScaleFade`'s `+ 16`: a puff grows from this radius (`cg_localents.c:453`). */
const BLOOD_PUFF_MIN_RADIUS = 16;

/** The pieces, as `cg_main.c:961–970` names their models: `models/gibs/<piece>.md3`. */
export type GibPiece =
  | 'skull'
  | 'brain'
  | 'abdomen'
  | 'arm'
  | 'chest'
  | 'fist'
  | 'foot'
  | 'forearm'
  | 'intestine'
  | 'leg';

/** What `CG_GibPlayer` throws after the skull or the brain, in its order: two legs. */
const GIB_BODY: readonly GibPiece[] = [
  'abdomen',
  'arm',
  'chest',
  'fist',
  'foot',
  'forearm',
  'intestine',
  'leg',
  'leg'
];

/** A first bounce's splat, by `rand()&3`: the third takes two of the four (`cg_localents.c:186–195`). */
const GIB_BOUNCE_SOUNDS = [
  'sound/player/gibimp1.wav',
  'sound/player/gibimp2.wav',
  'sound/player/gibimp3.wav',
  'sound/player/gibimp3.wav'
] as const;

/** `CG_Trace`'s `NULL` box: the fragments trace a point. */
const POINT = vec3();

/** What a fragment leaves where it bounces (`leMarkType_t`, `cg_local.h:239-243`). */
export const LEMT = { NONE: 0, BURN: 1, BLOOD: 2 } as const;

/**
 * `CG_FragmentBounceMark`'s mark where a fragment bounces: the caller's, as the marks are the
 * scene's.
 *
 * @param random - The fragments' `random()`, which the mark's radius and turn are drawn from.
 */
export type BounceMark = (
  markType: number,
  origin: Vec3,
  normal: Vec3,
  random: () => number,
  time: number
) => void;

/** A piece in flight or at rest: `localEntity_t` for `LE_FRAGMENT`. */
export interface Gib {
  piece: GibPiece;
  /** `pos.trBase`, `pos.trDelta` and `pos.trTime`: the fall, from its last bounce. */
  base: Vec3;
  delta: Vec3;
  trTime: number;
  /** `TR_STATIONARY`: at rest. */
  resting: boolean;
  /**
   * `refEntity.origin`: where it was last drawn, which the next trace starts from. A bounce leaves
   * it where the fall last put it in the air, so a piece at rest lies up to a frame's fall above
   * what stopped it, as Q3's do.
   */
  origin: Vec3;
  endTime: number;
  /** `LEBS_BLOOD`: trailing blood, and due a splat on its first bounce. */
  bleeding: boolean;
  /** `leMarkType`: what its next bounce leaves, {@link LEMT}'s; none after its first. */
  markType: number;
}

/** A puff of a gib's blood trail: `LE_FALL_SCALE_FADE`. */
export interface BloodPuff {
  base: Vec3;
  startTime: number;
  endTime: number;
  /** `refEntity.rotation`, in degrees. */
  rotation: number;
}

/** A piece as drawn this frame. */
export interface DrawnGib {
  piece: GibPiece;
  origin: Vec3;
  /**
   * Where it is lit: where it rests while it sinks, "otherwise the lighting would be lost as soon
   * as the origin went into the ground" (`cg_localents.c:256–260`), and where it is drawn before.
   */
  lightOrigin: Vec3;
  /** Its place's serial among the local entities, which orders it in a scene among them. */
  serial: number;
}

/** A puff as drawn this frame: a sprite of `bloodTrail`. */
export interface DrawnPuff {
  origin: Vec3;
  radius: number;
  /** `alphaGen vertex`: its opacity. */
  alpha: number;
  rotation: number;
  /** Its place's serial among the local entities, which orders it in a scene among them. */
  serial: number;
}

/** A splat a piece made this frame, where it hit. */
export interface GibSound {
  path: string;
  origin: Vec3;
}

/** What to draw and play this frame. */
export interface FragmentFrame {
  gibs: DrawnGib[];
  puffs: DrawnPuff[];
  sounds: GibSound[];
}

/**
 * Where a fall puts a piece at `time`: `BG_EvaluateTrajectory`'s `TR_GRAVITY`
 * (`bg_misc.c:1225–1229`). Q3's 800, exactly: a local entity is never moved by pmove, so the
 * tick's velocity snap never touches it.
 */
export function fallPosition(base: Vec3, delta: Vec3, trTime: number, time: number): Vec3 {
  const dt = (time - trTime) * 0.001;
  const position = madd(base, dt, delta);
  position.z -= 0.5 * DEFAULT_GRAVITY * dt * dt;
  return position;
}

/** `BG_EvaluateTrajectoryDelta`'s `TR_GRAVITY` (`bg_misc.c:1268–1272`). */
function fallVelocity(delta: Vec3, trTime: number, time: number): Vec3 {
  const dt = (time - trTime) * 0.001;
  return vec3(delta.x, delta.y, delta.z - DEFAULT_GRAVITY * dt);
}

/**
 * A puff at `time` — `CG_AddFallScaleFade`: it falls 40 units, grows from 16 to 36 across and
 * fades out, all at one rate over its two seconds.
 */
export function drawBloodPuff(puff: BloodPuff, time: number): DrawnPuff {
  const c = (puff.endTime - time) / (puff.endTime - puff.startTime);
  return {
    origin: vec3(puff.base.x, puff.base.y, puff.base.z - (1 - c) * BLOOD_PUFF_DROP),
    radius: BLOOD_PUFF_RADIUS * (1 - c) + BLOOD_PUFF_MIN_RADIUS,
    alpha: Math.trunc(255 * c) / 255,
    rotation: puff.rotation,
    serial: 0
  };
}

/** Every gib and blood puff in the world. */
export class Fragments {
  private readonly random: () => number;
  private readonly localEntities: LocalEntities;
  private readonly bounceMark: BounceMark | null;
  private readonly gibList: Gib[] = [];
  private readonly puffList: BloodPuff[] = [];
  /** Each gib's and each puff's place among the local entities, in step with their lists. */
  private readonly gibPlaces: LocalEntity[] = [];
  private readonly puffPlaces: LocalEntity[] = [];
  /** `cg.oldTime`: the last frame's time, for `cg.frametime`. */
  private lastTime: number | null = null;

  /**
   * @param random - `random()`, a number in [0, 1); `rand()`'s bits are drawn from it too.
   * @param localEntities - The pool each piece and puff takes its place in.
   * @param bounceMark - Where a piece's bounce leaves its mark; none for none.
   */
  constructor(
    random: () => number = Math.random,
    localEntities = new LocalEntities(),
    bounceMark: BounceMark | null = null
  ) {
    this.random = random;
    this.localEntities = localEntities;
    this.bounceMark = bounceMark;
  }

  /** The pieces in the world. */
  get gibs(): readonly Gib[] {
    return this.gibList;
  }

  /** The blood puffs in the world. */
  get puffs(): readonly BloodPuff[] {
    return this.puffList;
  }

  /**
   * `CG_GibPlayer`: throw the skull or the brain from where the player was, and with `cg_gibs` on,
   * the other nine pieces after it.
   *
   * @param time - `cg.time`: whole milliseconds.
   * @param allPieces - `cg_gibs`: at 0, only the skull or the brain flies.
   */
  gibPlayer(origin: Vec3, time: number, allPieces = true): void {
    const velocity = this.velocity();
    this.launch(this.random() < 0.5 ? 'skull' : 'brain', origin, velocity, time);
    // "Allow gibs to be turned off for speed."
    if (!allPieces) return;
    for (const piece of GIB_BODY) this.launch(piece, origin, this.velocity(), time);
  }

  /** Take every gib and puff away, as a restart does (`CG_InitLocalEntities`). */
  clear(): void {
    for (const place of this.gibPlaces) this.localEntities.free(place);
    for (const place of this.puffPlaces) this.localEntities.free(place);
    this.gibList.length = 0;
    this.puffList.length = 0;
    this.gibPlaces.length = 0;
    this.puffPlaces.length = 0;
  }

  /**
   * Move everything one frame, and say what to draw and play — `CG_AddLocalEntities` for the gibs
   * and their blood. The pieces go first, so a puff one lays this frame draws this frame, as Q3's
   * walk of its list makes sure. One whose place the pool freed for a newer local entity goes.
   *
   * @param time - `cg.time`: whole milliseconds.
   * @param trace - `CG_Trace`, for the pieces to hit.
   * @param eye - `cg.refdef.vieworg`: a puff the view is inside is let go.
   * @param pointContents - `CG_PointContents`, for a piece that lands in nodrop.
   */
  update(
    time: number,
    trace: TraceFn,
    eye: Vec3,
    pointContents: PointContentsFn = NO_CONTENTS
  ): FragmentFrame {
    const frametime = this.lastTime === null ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    const frame: FragmentFrame = { gibs: [], puffs: [], sounds: [] };

    let kept = 0;
    for (let i = 0; i < this.gibList.length; i++) {
      const gib = this.gibList[i];
      const place = this.gibPlaces[i];
      if (
        place.freed ||
        time >= gib.endTime ||
        !this.addFragment(gib, time, frametime, trace, pointContents, frame)
      ) {
        this.localEntities.free(place);
        continue;
      }
      frame.gibs[frame.gibs.length - 1].serial = place.serial;
      this.gibList[kept] = gib;
      this.gibPlaces[kept++] = place;
    }
    this.gibList.length = kept;
    this.gibPlaces.length = kept;

    kept = 0;
    for (let i = 0; i < this.puffList.length; i++) {
      const puff = this.puffList[i];
      const place = this.puffPlaces[i];
      const drawn = place.freed || time >= puff.endTime ? null : drawBloodPuff(puff, time);
      // "If the view would be 'inside' the sprite, kill the sprite so it doesn't add too much
      // overdraw."
      if (!drawn || length(sub(drawn.origin, eye)) < BLOOD_PUFF_RADIUS) {
        this.localEntities.free(place);
        continue;
      }
      drawn.serial = place.serial;
      frame.puffs.push(drawn);
      this.puffList[kept] = puff;
      this.puffPlaces[kept++] = place;
    }
    this.puffList.length = kept;
    this.puffPlaces.length = kept;
    return frame;
  }

  /** `crandom()`: −1 to 1. */
  private crandom(): number {
    return 2 * (this.random() - 0.5);
  }

  /** A piece's throw (`cg_effects.c:572–574`). */
  private velocity(): Vec3 {
    const x = this.crandom() * GIB_VELOCITY;
    const y = this.crandom() * GIB_VELOCITY;
    return vec3(x, y, GIB_JUMP + this.crandom() * GIB_VELOCITY);
  }

  /** `CG_LaunchGib` (`cg_effects.c:529–553`). */
  private launch(piece: GibPiece, origin: Vec3, velocity: Vec3, time: number): void {
    this.gibList.push({
      piece,
      base: copy(origin),
      delta: velocity,
      trTime: time,
      resting: false,
      origin: copy(origin),
      endTime: time + GIB_LIFETIME + Math.trunc(this.random() * GIB_LIFETIME_SPREAD),
      bleeding: true,
      markType: LEMT.BLOOD
    });
    this.gibPlaces.push(this.localEntities.alloc());
  }

  /**
   * `CG_AddFragment` (`cg_localents.c:245–316`).
   *
   * @returns whether the piece is kept: one that hits something in nodrop is not, which "keeps
   *   gibs from waiting at the bottom of pits of death". What is there is asked of the world and
   *   its solid brush models, passing entity 0.
   */
  private addFragment(
    gib: Gib,
    time: number,
    frametime: number,
    trace: TraceFn,
    pointContents: PointContentsFn,
    frame: FragmentFrame
  ): boolean {
    if (gib.resting) {
      // "Sink into the ground if near the removal time."
      const origin = copy(gib.origin);
      const t = gib.endTime - time;
      if (t < SINK_TIME) origin.z -= SINK_DEPTH * (1 - t / SINK_TIME);
      frame.gibs.push({ piece: gib.piece, origin, lightOrigin: copy(gib.origin), serial: 0 });
      return true;
    }

    const next = fallPosition(gib.base, gib.delta, gib.trTime, time);
    // `CG_Trace` at `CONTENTS_SOLID`, passing nobody (`cg_localents.c:276`): the world and the
    // brush models stop it, and a body's box, which is `CONTENTS_BODY`, does not.
    const result = trace(gib.origin, POINT, POINT, next, -1, CONTENTS.SOLID);
    if (result.fraction === 1) {
      gib.origin = next;
      frame.gibs.push({ piece: gib.piece, origin: copy(next), lightOrigin: copy(next), serial: 0 });
      if (gib.bleeding) this.bloodTrail(gib, time, frametime);
      return true;
    }

    if (pointContents(result.endpos, 0) & CONTENTS.NODROP) return false;

    // `CG_FragmentBounceMark`: "don't allow a fragment to make multiple marks, or they pile up
    // while settling".
    if (gib.markType !== LEMT.NONE) {
      this.bounceMark?.(gib.markType, result.endpos, result.normal, this.random, time);
      gib.markType = LEMT.NONE;
    }

    // `CG_FragmentBounceSound`: half the pieces splat, once.
    if (gib.bleeding) {
      if (this.random() < 0.5) {
        const sound = GIB_BOUNCE_SOUNDS[Math.floor(this.random() * GIB_BOUNCE_SOUNDS.length)];
        frame.sounds.push({ path: sound, origin: copy(result.endpos) });
      }
      gib.bleeding = false;
    }
    this.reflect(gib, result, time, frametime);
    const at = copy(gib.origin);
    frame.gibs.push({ piece: gib.piece, origin: at, lightOrigin: copy(gib.origin), serial: 0 });
    return true;
  }

  /** `CG_ReflectVelocity` (`cg_localents.c:213–238`). */
  private reflect(gib: Gib, result: TraceResult, time: number, frametime: number): void {
    const hitTime = Math.trunc(time - frametime + frametime * result.fraction);
    const velocity = fallVelocity(gib.delta, gib.trTime, hitTime);
    const along = dot(velocity, result.normal);
    gib.delta = scale(madd(velocity, -2 * along, result.normal), GIB_BOUNCE);
    gib.base = copy(result.endpos);
    gib.trTime = time;

    // "Check for stop, making sure that even on low FPS systems it doesn't bobble."
    const rising = gib.delta.z;
    if (
      result.allsolid ||
      (result.normal.z > 0 && (rising < FRAGMENT_REST_SPEED || rising < -frametime * rising))
    ) {
      gib.resting = true;
    }
  }

  /** `CG_BloodTrail` (`cg_localents.c:121–148`): a puff at each 150 ms mark this frame passed. */
  private bloodTrail(gib: Gib, time: number, frametime: number): void {
    const step = BLOOD_TRAIL_STEP;
    const last = step * Math.trunc(time / step);
    for (let t = step * Math.trunc((time - frametime + step) / step); t <= last; t += step) {
      this.puffList.push({
        base: fallPosition(gib.base, gib.delta, gib.trTime, t),
        startTime: t,
        endTime: t + BLOOD_PUFF_LIFETIME,
        rotation: this.random() * 360
      });
      this.puffPlaces.push(this.localEntities.alloc());
    }
  }
}
