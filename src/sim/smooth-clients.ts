import { createPlayerState, type PlayerState } from '../net/protocol';
import { EF_CONNECTION, GROUND_TRACE_DEPTH, MIN_WALK_NORMAL, OVERCLIP } from './constants';
import { copyVec, type GameEntity } from './game-entity';
import { PW } from './items';
import type { Level } from './level';
import { Pmove } from './pmove';
import { clipVelocity, snapVector } from './pmove-math';
import { createUserCmd, type TraceResult } from './types';
import { copy, dot, vec3, type Vec3 } from './vec3';
import { truncVector } from './weapons/hitscan';

/**
 * Unlagged's smoothing, as Excessive Plus runs it at a client's frame end: a player whose commands
 * have fallen a frame or two behind is slid on from where the last one left them, so everyone else
 * sees them go on moving between commands. A player with none for longer stands where they are and
 * shows the connection-trouble sprite.
 */

/**
 * How far behind the frames a player's last command can be and still be slid on: two of Quake 3's
 * 50 ms frames. Any further and the sprite goes up.
 */
export const SMOOTH_MSEC = 100;

/**
 * Slide a late player on, or put the sprite on them, once their entity state is built for the
 * frame. The sprite comes off the player state first and goes back on both, so the entity keeps it
 * one frame after the player state drops it.
 *
 * How late is the time from the frame a player's last command ran in to the frame before this
 * one. A command runs between frames, at the last frame's time, so one that came since the last
 * frame is on time; a bot's runs inside this frame, and is never late.
 *
 * @param entity - The player's entity, its state built from the player state this frame.
 * @param enabled - `g_smoothClients`.
 * @param gravity - `g_gravity`'s value, which the slide falls by in place of the player state's.
 */
export function smoothClient(
  level: Level,
  entity: GameEntity,
  enabled: boolean,
  gravity: number
): void {
  const client = entity.client!;
  client.ps.eFlags &= ~EF_CONNECTION;
  const late = level.previousTime - client.lastUpdateTime;
  if (late > SMOOTH_MSEC) {
    client.ps.eFlags |= EF_CONNECTION;
    entity.s.eFlags |= EF_CONNECTION;
  } else if (late > 0 && enabled) {
    slide(level, entity, late / 1000, gravity);
  }
}

/**
 * Move a player's entity on for `seconds` by the velocity it carries, writing its `trBase` and
 * `trDelta` and nothing else: not the player state, the world's link or the ground it stands on.
 */
function slide(level: Level, entity: GameEntity, seconds: number, gravity: number): void {
  const { ps } = entity.client!;
  const standIn = createPlayerState();
  standIn.origin = copy(entity.s.pos.trBase);
  standIn.velocity = copy(entity.s.pos.trDelta);
  standIn.gravity = gravity;
  standIn.powerups[PW.FLIGHT] = ps.powerups[PW.FLIGHT];
  // The slide hands back the velocity it started with while the move's timer runs, and while the
  // pain timer does: Excessive Plus reuses that timer as its frozen bodies' knockback, and tests it
  // for everyone.
  standIn.pmTime = ps.pmTime || (level.time < entity.painDebounceTime ? 1 : 0);

  new Slide(level, entity, standIn, seconds).run();

  copyVec(standIn.velocity, entity.s.pos.trDelta);
  // Whole units, as the entity state carries every player's position.
  copyVec(truncVector(standIn.origin), entity.s.pos.trBase);
}

/**
 * Excessive Plus's slide: id's move cut down to the world's say, run once over the whole time on a
 * stand-in for the player. There is no friction, acceleration, jump, landing or event, and the
 * traces are the entity's: its box, its number and `clipmask`.
 */
class Slide extends Pmove {
  private readonly entity: GameEntity;

  constructor(level: Level, entity: GameEntity, standIn: PlayerState, seconds: number) {
    super(standIn, createUserCmd(), (start, mins, maxs, end, passEntityNum, contentmask) =>
      level.trace(start, mins, maxs, end, passEntityNum, contentmask)
    );
    this.entity = entity;
    this.frametime = seconds;
  }

  /**
   * Flight slides without gravity. On walkable ground the velocity is clipped to it, and a player
   * not moving across it is left as they are; otherwise the step-slide runs without gravity. In
   * the air, or on ground too steep to stand on, it runs with gravity. The velocity is rounded
   * after, as a move's is.
   */
  override run() {
    const { state } = this;
    this.doGroundTrace();
    if (state.powerups[PW.FLIGHT]) {
      this.stepSlideMove(false);
    } else if (this.walking) {
      // Excessive Plus adds gravity here on slick ground, which the port's collision has no
      // surface flags to find.
      state.velocity = clipVelocity(state.velocity, this.groundTrace.normal, OVERCLIP);
      if (state.velocity.x === 0 && state.velocity.y === 0) return;
      this.stepSlideMove(false);
    } else {
      this.stepSlideMove(true);
    }
    state.velocity = snapVector(state.velocity);
  }

  /**
   * `PM_GroundTrace`'s tests, in its order, deciding only whether the slide walks or has a plane to
   * clip to: no ground entity, landing or animation.
   */
  protected override doGroundTrace() {
    const { origin, velocity } = this.state;
    let trace = this.trace(origin, vec3(origin.x, origin.y, origin.z - GROUND_TRACE_DEPTH));
    if (trace.allsolid) {
      const corrected = this.correctAllSolid();
      if (!corrected) return;
      trace = corrected;
    }
    this.groundTrace = trace;
    if (trace.fraction === 1) return;
    if (velocity.z > 0 && dot(velocity, trace.normal) > 10) return;
    this.groundPlane = true;
    this.walking = trace.normal.z >= MIN_WALK_NORMAL;
  }

  /** A step up raises no event: the slide is not a move anybody predicts. */
  protected override stepEvent() {}

  /** The entity's box, number and `clipmask`, where a move traces with its player state's. */
  protected override trace(start: Vec3, end: Vec3): TraceResult {
    const { entity } = this;
    return this.traceFn(start, entity.r.mins, entity.r.maxs, end, entity.s.number, entity.clipmask);
  }
}
