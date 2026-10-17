import { ENTITYNUM_NONE, TR } from '../net/protocol';
import { ANIM, animOf } from './animations';
import { copyEntityState } from '../net/delta';
import { GIB_HEALTH, bodyDie } from './combat';
import { CONTENTS, EF_DEAD, STAT } from './constants';
import type { GameEntity } from './game-entity';
import type { Level } from './level';
import { copy, vec3 } from './vec3';

/**
 * Q3's body queue: the corpses a respawn leaves behind (`g_client.c:355–500`).
 *
 * Eight entities are taken at the start of the map and never given back — `InitBodyQue` marks each
 * `neverFree`, so freeing one only unlinks it. `CopyToBodyQue` copies the dead player into the next
 * of them, round and round, so the ninth body takes the first one's place. A body lies still for
 * five seconds, then `BodySink` lowers it a unit at a time until it is gone.
 *
 * A corpse is an entity like any other, which is the whole of why it is one: it is in the world,
 * so it is in a snapshot, so a client draws it by reading its entity state rather than by being
 * told. A body copied while the player was still in the air falls to the floor first, by
 * `G_RunItem`'s rules (`item-run.ts`), and where it is at any instant is its own trajectory's
 * answer.
 *
 * A body can be hurt like anything else, and one taken to −40 or below goes to pieces (`body_die`,
 * `g_combat.c:267–277`). It is its player's own (`CopyToBodyQue` sets `r.ownerNum`), so their
 * shots pass through it as through anything they own; their blasts do not, since `G_RadiusDamage`
 * finds what it hurts by their boxes. Its health is its slot's, since `CopyToBodyQue` never sets
 * it: 0 at the start, and carried from one body to the next.
 */

/** `BODY_QUEUE_SIZE` (`g_local.h:34`). */
export const BODY_QUEUE_SIZE = 8;

/** A body lies still this long after the respawn that left it (`CopyToBodyQue`). */
export const BODY_SINK_DELAY = 5000;

/** `BodySink` runs again this long after it last ran, lowering the body a unit each time. */
export const BODY_SINK_INTERVAL = 100;

/** A body `BodySink` finds more than this long after its respawn is taken away. */
export const BODY_SINK_END = 6500;

/** A body lands dead: `CopyToBodyQue` gives it a `physicsBounce` of 0, as `G_Spawn` left it. */
const BODY_BOUNCE = 0;

/**
 * `InitBodyQue` (`g_client.c:363–374`): take the eight slots the corpses will live in.
 *
 * They are taken at the start of the map and held for all of it, which is what `neverFree` says:
 * a body that has sunk out of sight is unlinked rather than freed, so nothing else can be given
 * its number and a client that still remembers it is not shown something else instead.
 *
 * @param level - The level to take them from.
 */
export function initBodyQue(level: Level): GameEntity[] {
  return Array.from({ length: BODY_QUEUE_SIZE }, () => {
    const body = level.spawnEntity();
    body.classname = 'bodyque';
    body.neverFree = true;
    return body;
  });
}

/**
 * `CopyToBodyQue` (`g_client.c:402–500`): leave the dead player's body behind as they respawn.
 *
 * The body is a copy of the player's entity state, so it wears what they wore and lies in the
 * death they played — the animation held at its last frame, so the sequence does not start over.
 * What it is *not* a copy of is their player state: a corpse has no client, so its health is its
 * slot's, and its box is the one the world links rather than the one the move traces.
 *
 * A player who died in the air leaves a body that is still falling, and `G_RunItem` brings it
 * down; one who died on the ground leaves a body that is simply there.
 *
 * None is left in `CONTENTS_NODROP` — at the entity state's `origin`, which is not where the
 * player fell. Nothing writes it for a player in play, only spectating and the intermission, so
 * Quake 3 asks where they last watched from, or the map's origin.
 *
 * @param level - The level the body lives in.
 * @param entity - The player's entity, before the respawn puts them back.
 * @returns The corpse, or null for none.
 */
export function copyToBodyQue(level: Level, entity: GameEntity): GameEntity | null {
  level.unlinkEntity(entity);

  // "If client is in a nodrop area, don't leave the body" (`g_client.c:412–416`).
  if (level.pointContents(entity.s.origin, -1) & CONTENTS.NODROP) return null;

  const body = level.bodyQue[level.bodyQueIndex];
  level.bodyQueIndex = (level.bodyQueIndex + 1) % BODY_QUEUE_SIZE;

  const slot = body.s.number;
  copyEntityState(entity.s, body.s);
  // `EF_DEAD` alone, so that the talk balloon and everything else the player was carrying goes.
  body.s.eFlags = EF_DEAD;
  body.s.powerups = 0;
  body.s.loopSound = 0;
  body.s.number = slot;
  body.timestamp = level.time;
  body.physicsObject = true;
  body.physicsBounce = BODY_BOUNCE;

  const state = entity.client?.ps;
  if (body.s.groundEntityNum === ENTITYNUM_NONE) {
    body.s.pos.trType = TR.GRAVITY;
    body.s.pos.trTime = level.time;
    body.s.pos.trDelta = state ? copy(state.velocity) : vec3();
  } else {
    body.s.pos.trType = TR.STATIONARY;
  }
  body.s.event = 0;

  const dead = deadAnim(body.s.legsAnim);
  body.s.legsAnim = dead;
  body.s.torsoAnim = dead;

  body.r.svFlags = entity.r.svFlags;
  body.r.mins = copy(entity.r.mins);
  body.r.maxs = copy(entity.r.maxs);
  body.r.absmin = copy(entity.r.absmin);
  body.r.absmax = copy(entity.r.absmax);
  // It falls through players and other corpses alike (`g_client.c:481`), and is hit by shots.
  body.clipmask = CONTENTS.SOLID | CONTENTS.PLAYERCLIP;
  body.r.contents = CONTENTS.CORPSE;
  body.r.ownerNum = entity.s.number;

  body.nextthink = level.time + BODY_SINK_DELAY;
  body.think = (self) => bodySink(self, level);
  body.die = (self) => bodyDie(level, self);
  // Already in pieces, so there is nothing left to blow apart.
  body.takedamage = (state?.stats[STAT.HEALTH] ?? 0) > GIB_HEALTH;

  body.r.currentOrigin = copy(body.s.pos.trBase);
  level.linkEntity(body);
  return body;
}

/**
 * `BodySink` (`g_client.c:383–392`): "after sitting around for five seconds, fall into the ground
 * and disappear".
 *
 * It lowers the body's trajectory base a unit every hundred milliseconds, so the sinking is the
 * same speed however often the frame runs, and takes it away once it is more than 6.5 s old. The
 * body is never freed — "the body ques are never actually freed, they are just unlinked" — which
 * is what keeps its number from being given to anything else.
 *
 * @param body - The corpse.
 * @param level - The level it is in.
 */
export function bodySink(body: GameEntity, level: Level): void {
  if (level.time - body.timestamp > BODY_SINK_END) {
    level.unlinkEntity(body);
    body.physicsObject = false;
    return;
  }
  body.nextthink = level.time + BODY_SINK_INTERVAL;
  body.s.pos.trBase.z -= 1;
}

/**
 * `G_InitGame`'s effect on the corpses (`g_main.c:453, 480`): the map that comes back has none.
 *
 * A real map load builds a level afresh and the eight slots are taken again from nothing. A
 * `map_restart` the app makes against the level it already has does not, so this is what clearing
 * them means there: unlinked, past hurting, and each slot's health back where `G_Spawn` leaves it.
 *
 * @param level - The level whose corpses go.
 */
export function clearBodyQue(level: Level): void {
  for (const body of level.bodyQue) {
    level.unlinkEntity(body);
    body.physicsObject = false;
    body.takedamage = false;
    body.health = 0;
    body.nextthink = 0;
    body.s.event = 0;
  }
  level.bodyQueIndex = 0;
}

/**
 * The death a body keeps playing: its last frame only, so the fall does not start again
 * (`CopyToBodyQue`, `g_client.c:459–473`).
 */
function deadAnim(legsAnim: number): number {
  switch (animOf(legsAnim)) {
    case ANIM.BOTH_DEATH1:
    case ANIM.BOTH_DEAD1:
      return ANIM.BOTH_DEAD1;
    case ANIM.BOTH_DEATH2:
    case ANIM.BOTH_DEAD2:
      return ANIM.BOTH_DEAD2;
    default:
      return ANIM.BOTH_DEAD3;
  }
}
