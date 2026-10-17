import { ENTITYNUM_NONE, TR } from '../net/protocol';
import { CONTENTS, MASK } from './constants';
import type { GameEntity } from './game-entity';
import { IT } from './items';
import type { Level } from './level';
import { teamFreeEntity } from './team';
import { evaluateTrajectory, evaluateTrajectoryDelta } from './trajectory';
import type { TraceFn, TraceResult } from './types';
import { add, copy, dot, madd, scale, vec3 } from './vec3';
import { truncVector } from './weapons/hitscan';

/**
 * `G_RunItem` (`g_items.c:958–1017`) and `G_BounceItem` (`:923–949`): what the frame does with
 * anything that falls and can be pushed about.
 *
 * One function serves all of them, as it does in Quake 3 — `g_main.c:1847` runs it for
 * "`ET_ITEM || physicsObject`". An item the map placed is stationary and only thinks; a *dropped*
 * item, a corpse, and anything a mover pushes fall by their own trajectory, are traced to where
 * it puts them, and bounce off whatever they meet by `physicsBounce`: an item the map placed keeps
 * half its speed (`G_SpawnItem`), a dropped one and a corpse keep none, which is why a dropped
 * weapon stops dead at its first floor contact. Whatever hits something while in
 * `CONTENTS_NODROP` is taken away, and a flag sent home.
 */

/** `G_BounceItem` stops a fall on a floor if it is rising slower than this. */
export const ITEM_STOP_SPEED = 40;

/**
 * `G_RunItem` (`g_items.c:958–1017`): where a falling thing has got to, its think, and what it
 * does about whatever it landed on.
 *
 * Anything whose ground has gone from under it falls, whatever it was doing — which is how an
 * item standing on a mover that moved away drops. A stationary one only thinks; the rest are
 * traced from where they were to where their trajectory puts them, and linked where the trace
 * ended, which is a unit or so short of the floor.
 *
 * @param level - The level the entity is in.
 * @param entity - The item, corpse or other physics object.
 * @param trace - `trap_Trace`.
 */
export function runItem(level: Level, entity: GameEntity, trace: TraceFn): void {
  // "if its groundentity has been set to none, it may have been pushed off an edge" (`:964–970`).
  if (entity.s.groundEntityNum === ENTITYNUM_NONE) {
    if (entity.s.pos.trType !== TR.GRAVITY) {
      entity.s.pos.trType = TR.GRAVITY;
      entity.s.pos.trTime = level.time;
    }
  }

  if (entity.s.pos.trType === TR.STATIONARY) {
    // "check think function" (`:972–976`).
    level.runThink(entity);
    return;
  }

  const to = evaluateTrajectory(entity.s.pos, level.time);
  // Past whatever it belongs to, and stopped by what its clip mask names.
  const mask = entity.clipmask || (MASK.PLAYERSOLID & ~CONTENTS.BODY);
  const result = trace(
    entity.r.currentOrigin,
    entity.r.mins,
    entity.r.maxs,
    to,
    entity.r.ownerNum,
    mask
  );
  entity.r.currentOrigin = copy(result.endpos);
  // `trap_LinkEntity`, after the trace (`:996`).
  level.linkEntity(entity);
  const fraction = result.startsolid ? 0 : result.fraction;

  level.runThink(entity);
  if (fraction === 1) return;

  // "If it is in a nodrop volume, remove it" (`:1006–1014`), and a flag goes home.
  if (level.pointContents(entity.r.currentOrigin, -1) & CONTENTS.NODROP) {
    if (entity.item?.giType === IT.TEAM) teamFreeEntity(level, entity);
    else level.freeEntity(entity);
    return;
  }

  bounceItem(level, entity, { ...result, fraction });
}

/**
 * `G_BounceItem` (`g_items.c:923–949`): reflect the velocity the thing had at the moment of
 * contact, keep `physicsBounce` of it, and come to rest if what it hit is a floor and it is rising
 * slower than {@link ITEM_STOP_SPEED}. Off a wall it slides down.
 *
 * @param level - The level it is in.
 * @param entity - The thing that hit something.
 * @param trace - What the fall ran into, its fraction 0 if it started inside something.
 */
function bounceItem(level: Level, entity: GameEntity, trace: TraceResult): void {
  const { endpos, normal, fraction } = trace;
  const hitTime = Math.trunc(
    level.previousTime + (level.time - level.previousTime) * fraction
  );
  const velocity = evaluateTrajectoryDelta(entity.s.pos, hitTime);
  entity.s.pos.trDelta = scale(
    madd(velocity, -2 * dot(velocity, normal), normal),
    entity.physicsBounce
  );

  if (normal.z > 0 && entity.s.pos.trDelta.z < ITEM_STOP_SPEED) {
    // A unit up, so it is off the ground, then truncated to whole units; `G_SetOrigin` makes it
    // stationary and it stands on whatever it landed on.
    const rest = truncVector(vec3(endpos.x, endpos.y, endpos.z + 1));
    entity.s.pos.trType = TR.STATIONARY;
    entity.s.pos.trTime = 0;
    entity.s.pos.trDuration = 0;
    entity.s.pos.trBase = copy(rest);
    entity.s.pos.trDelta = vec3();
    entity.r.currentOrigin = copy(rest);
    entity.s.origin = copy(rest);
    entity.s.groundEntityNum = trace.entityNum;
    return;
  }

  entity.r.currentOrigin = add(entity.r.currentOrigin, normal);
  entity.s.pos.trBase = copy(entity.r.currentOrigin);
  entity.s.pos.trTime = level.time;
}
