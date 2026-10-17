import type { EntityState, PlayerState } from '../net/protocol';
import { f, vectorNormalize } from './cm/q-math';
import { CONTENTS, PM_NORMAL } from './constants';
import { addPredictableEvent, EV } from './events';
import { ET, setMovedir, SVF, type GameEntity } from './game-entity';
import { FRAMETIME } from './item-spawn';
import { PW } from './items';
import type { Level } from './level';
import { angleNormalize180, vectorToAngles } from './pmove-math';
import { pickTarget } from './targets';
import { entitySound } from './temp-entity';
import { initTrigger } from './triggers';
import { copy, vec3, type Vec3 } from './vec3';

/**
 * The jump pad: `SP_trigger_push`, `AimAtTarget` and `target_push` (`g_trigger.c:143–261`) on the
 * server, and `BG_TouchJumpPad` (`bg_misc.c:1421–1454`) where the launch itself happens.
 *
 * A pad is aimed at a `target_position`, which marks the **apex** of the leap rather than a
 * direction: the velocity is solved from the height and the distance so the player lands on the
 * target. That is why a pad is armed a frame after it spawns rather than at spawn, and why a pad
 * with no target, or a target level with it, takes itself out of the world.
 *
 * `BG_TouchJumpPad` is a `bg_` function because the client predicts it as it walks: the server
 * runs it from the trigger pass and the client from its replay, each on the pad's own state.
 */

/**
 * The box a pad with no `model` is given, which a splat map's pad is: a splat has no brushes to
 * take one from.
 *
 * Quake 3 stops on such a pad (`SV_SetBrushModel: NULL`). The port gives it the same 64 × 64 × 32
 * box about its origin on the server and in the client's prediction. Every pad of a BSP names
 * its brush.
 */
export const JUMP_PAD_MINS: Vec3 = vec3(-32, -32, -16);
export const JUMP_PAD_MAXS: Vec3 = vec3(32, 32, 16);

/** `sound/world/jumppad.wav`: a pad's sound, and a bounce pad's, which the clients precache. */
export const JUMP_PAD_SOUND = 'sound/world/jumppad.wav';

/** `sound/misc/windfly.wav`: the sound of any other `target_push`. */
export const WINDFLY_SOUND = 'sound/misc/windfly.wav';

/** A `target_push`'s `speed` when the map gives none (`g_trigger.c:243–245`). */
export const TARGET_PUSH_SPEED = 1000;

/** "Play fly sound every 1.5 seconds" (`g_trigger.c:229–233`), in milliseconds. */
export const FLY_SOUND_DEBOUNCE = 1500;

/**
 * `SP_trigger_push` (`g_trigger.c:199–213`): a trigger that launches whoever walks into it.
 *
 * @param level - The level it is spawning into.
 * @param entity - The entity the map's pairs filled in, its `model` and `target` among them.
 * @throws as `trap_SetBrushModel` does, for a `model` the map has not got
 */
export function spawnJumpPad(level: Level, entity: GameEntity): void {
  if (entity.model !== null) {
    initTrigger(level, entity);
  } else {
    // `InitTrigger` with the box for the brush a pad without a model has not got.
    const { angles } = entity.s;
    if (angles.x !== 0 || angles.y !== 0 || angles.z !== 0) setMovedir(angles, entity.movedir);
    entity.r.mins = copy(JUMP_PAD_MINS);
    entity.r.maxs = copy(JUMP_PAD_MAXS);
    entity.r.contents = CONTENTS.TRIGGER;
    entity.r.svFlags = SVF.NOCLIENT;
  }

  // "Unlike other triggers, we need to send this one to the client."
  entity.r.svFlags &= ~SVF.NOCLIENT;

  // "Make sure the client precaches this sound."
  level.itemMatch.soundIndex(JUMP_PAD_SOUND);

  entity.s.eType = ET.PUSH_TRIGGER;
  entity.touch = (self, other) => {
    // `trigger_push_touch` (`g_trigger.c:143–150`): only a client is launched.
    if (!other.client) return;
    touchJumpPad(other.client.ps, self.s);
  };

  // "We must have some delay to make sure our use targets are present": a frame's think, which
  // is where the apex is solved.
  entity.think = (self) => aimAtTarget(level, self);
  entity.nextthink = level.time + FRAMETIME;
  level.linkEntity(entity);
}

/**
 * `AimAtTarget` (`g_trigger.c:160–192`): solve the launch velocity that reaches the target.
 *
 * The pad is a projectile launcher: with gravity fixed and the target's height known, the time of
 * flight follows, and the horizontal speed is whatever covers the distance in that time. The
 * vertical speed is `time * gravity`, which is what the trajectory needs to peak at the target.
 *
 * The arithmetic is the game module's QVM's, which is what ioquake3 runs it as: every value a
 * float, `.5` among them since q3lcc's double is a float, and the square roots a trap's double
 * rounded to one. Doubles miss a pad's velocity by up to 7e-5, which the move then carries.
 *
 * Quake 3's `if (!time)` misses a NaN, so a target *below* the pad arms it with a NaN velocity;
 * the port frees the pad instead, because a NaN in the player's velocity would poison the move.
 *
 * @param level - Whose gravity and target names to read.
 * @param self - The pad, its `target` naming the apex.
 */
export function aimAtTarget(level: Level, self: GameEntity): void {
  const { absmin, absmax } = self.r;
  const origin = [
    f(f(absmin.x + absmax.x) * 0.5),
    f(f(absmin.y + absmax.y) * 0.5),
    f(f(absmin.z + absmax.z) * 0.5)
  ];

  const target = pickTarget(level, self.target, level.itemMatch.random, level.itemMatch.print);
  if (!target) {
    level.freeEntity(self);
    return;
  }

  const apex = target.s.origin;
  const height = f(f(apex.z) - origin[2]);
  const gravity = level.itemMatch.gravity();
  const time = f(Math.sqrt(f(height / f(0.5 * gravity))));
  if (!time) {
    level.freeEntity(self);
    return;
  }

  // "Set s.origin2 to the push velocity": the horizontal run first, then the climb.
  const push = [f(f(apex.x) - origin[0]), f(f(apex.y) - origin[1]), 0];
  const dist = vectorNormalize(push);
  const forward = f(dist / time);
  self.s.origin2 = vec3(f(push[0] * forward), f(push[1] * forward), f(time * gravity));
}

/**
 * `SP_target_push` (`g_trigger.c:242–261`): a push something else fires, at `speed` along its
 * angle, or, with a target, at the target's apex as a pad aims. Spawnflag 1 is a bounce pad, which
 * sounds like one; any other sounds like the wind.
 *
 * It is never linked: it has no shape, and is found by its `targetname`.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 */
export function spawnTargetPush(level: Level, self: GameEntity): void {
  if (!self.speed) self.speed = TARGET_PUSH_SPEED;
  setMovedir(self.s.angles, self.s.origin2);
  const { origin2 } = self.s;
  const { speed } = self;
  self.s.origin2 = vec3(f(origin2.x * speed), f(origin2.y * speed), f(origin2.z * speed));

  const sound = self.spawnflags & 1 ? JUMP_PAD_SOUND : WINDFLY_SOUND;
  self.noiseIndex = level.itemMatch.soundIndex(sound);
  if (self.target !== null) {
    // Its centre for the aim, which a pad's link would otherwise give it.
    self.r.absmin = copy(self.s.origin);
    self.r.absmax = copy(self.s.origin);
    self.think = (it) => aimAtTarget(level, it);
    self.nextthink = level.time + FRAMETIME;
  }
  self.use = (it, _other, activator) => useTargetPush(level, it, activator);
}

/**
 * `Use_target_push` (`g_trigger.c:216–235`): give whoever set it off the push's velocity, as a
 * pad does, but not to a spectator or a flyer. Its sound is heard at most every
 * {@link FLY_SOUND_DEBOUNCE}, by the player's own clock rather than the push's.
 */
function useTargetPush(level: Level, self: GameEntity, activator: GameEntity | null): void {
  if (!activator?.client) return;
  const client = activator.client;
  if (client.ps.pmType !== PM_NORMAL) return;
  if (client.ps.powerups[PW.FLIGHT]) return;

  client.ps.velocity = copy(self.s.origin2);

  if (activator.flySoundDebounceTime < level.time) {
    activator.flySoundDebounceTime = level.time + FLY_SOUND_DEBOUNCE;
    entitySound(level, activator, self.noiseIndex);
  }
}

/**
 * `BG_TouchJumpPad` (`bg_misc.c:1421–1454`): launch a player, once.
 *
 * Spectators and flying players are not launched at all. The event is raised only when the pad is
 * not the one already being ridden, so a pad with a fat trigger does not repeat its sound every
 * frame, but the velocity is set every time — that is what keeps a player moving along the arc
 * while they are still inside it.
 *
 * @param ps - The player state to launch.
 * @param pad - The pad's entity state, carrying the launch velocity in `origin2`.
 */
export function touchJumpPad(ps: PlayerState, pad: EntityState): void {
  // "spectators don't use jump pads".
  if (ps.pmType !== PM_NORMAL) return;
  // "flying characters don't hit bounce pads".
  if (ps.powerups[PW.FLIGHT]) return;

  if (ps.jumppadEnt !== pad.number) {
    // A pad steeper than 45 degrees is a launcher rather than a shove, and sounds like one.
    const angles = vectorToAngles(pad.origin2);
    const pitch = Math.abs(angleNormalize180(angles.x));
    addPredictableEvent(ps, EV.JUMP_PAD, pitch < 45 ? 0 : 1);
  }

  // "remember hitting this jumppad this frame", and give the player its velocity.
  ps.jumppadEnt = pad.number;
  ps.jumppadFrame = ps.pmoveFramecount;
  ps.velocity = copy(pad.origin2);
}
