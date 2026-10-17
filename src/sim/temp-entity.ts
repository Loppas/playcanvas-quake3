import { MAX_PS_EVENTS, type PlayerState } from '../net/protocol';
import { EF_PLAYER_EVENT } from './constants';
import { EV } from './events';
import { ET, SVF, playerStateToEntityState, setEntityOrigin, type GameEntity } from './game-entity';
import type { Level } from './level';
import { vec3, type Vec3 } from './vec3';

/**
 * `G_TempEntity` (`g_utils.c:602–625`): an entity that exists only to carry one event.
 *
 * A spark where a bullet struck is not a thing in the world — it is a thing that *happened*, at a
 * place. Quake 3 has no separate channel for that, so it spawns an ordinary entity whose whole
 * content is its event, sends it in one snapshot and takes its slot back.
 *
 * The event rides in the entity type rather than in `s.event`: `ET_EVENTS + eventNum` says both
 * that this entity is nothing but an event and which event it is, in the field the client reads
 * first anyway. Which is why a temp entity needs no `G_AddEvent` and carries no counter — it
 * is new, so it cannot be mistaken for one seen before.
 *
 * The origin is snapped to whole units before it is written. An impact a fraction of a unit from
 * where the trace stopped is not visible, and the wire charges for the difference.
 */

/**
 * Spawn an entity that is one event at one place.
 *
 * The caller writes whatever the event carries — `s.eventParm` for the packed direction,
 * `s.otherEntityNum` for whose shot it was, `s.weapon` for what fired it — because which of those
 * mean anything is the event's business rather than this function's.
 *
 * @param level - The level to spawn into; the entity takes one of its free slots.
 * @param origin - Where it happened. Snapped to whole units, as the wire would.
 * @param event - One of the `EV_*` numbers.
 * @returns The entity, in the world and already due to be freed once its event has been seen.
 */
export function tempEntity(level: Level, origin: Vec3, event: number): GameEntity {
  const entity = level.spawnEntity();
  entity.s.eType = ET.EVENTS + event;
  entity.classname = 'tempEntity';
  entity.eventTime = level.time;
  // The frame frees it once every client has had time to see it, which is what stops the slot
  // being reused under a client that has not read the snapshot it was in yet.
  entity.freeAfterEvent = true;

  setEntityOrigin(entity, snapVector(origin));
  level.linkEntity(entity);

  return entity;
}

/**
 * `G_Sound` (`g_utils.c:608–613`): a sound heard from where an entity stands, carried by an event
 * entity of its own. Quake 3 takes a channel too, and does nothing with it.
 *
 * @param soundIndex - Its slot in `CS_SOUNDS`, as `G_SoundIndex` gave it.
 */
export function entitySound(level: Level, entity: GameEntity, soundIndex: number): void {
  const sound = tempEntity(level, entity.r.currentOrigin, EV.GENERAL_SOUND);
  sound.s.eventParm = soundIndex;
}

/**
 * `SendPendingPredictableEvents` (`g_active.c:710–740`): send a player's next event on its own, to
 * everyone but the player.
 *
 * A player's entity carries one event at a time, and a move can raise two, so the first goes on
 * the entity and the next goes out as an entity of its own. It is everything the player's entity
 * would be, with the event in its type and {@link EF_PLAYER_EVENT} set, so the client hears it
 * from the player (`s.otherEntityNum`) as it would any of theirs. The player is left out: they have
 * every event of theirs on their player state already.
 *
 * `BG_PlayerStateToEntityState` writes it, which moves `entityEventSequence` on past the event.
 * The external event is set aside while it does, so that it is the next of the move's events that
 * goes, and the external one stays on the player's own entity.
 *
 * @param level - The level the event's entity is spawned into.
 * @param ps - The player's state; its `entityEventSequence` moves on by one if anything was sent.
 */
export function sendPendingPredictableEvents(level: Level, ps: PlayerState): void {
  if (ps.entityEventSequence >= ps.eventSequence) return;

  // Q3 puts the counter in the event's high bits here too, which the wire's eight bits of entity
  // type drop again, so it is left off.
  const event = ps.events[ps.entityEventSequence & (MAX_PS_EVENTS - 1)];
  const externalEvent = ps.externalEvent;
  ps.externalEvent = 0;

  const sent = tempEntity(level, ps.origin, event);
  const { number } = sent.s;
  playerStateToEntityState(ps, sent.s, true);
  sent.s.number = number;
  sent.s.eType = ET.EVENTS + event;
  sent.s.eFlags |= EF_PLAYER_EVENT;
  sent.s.otherEntityNum = ps.clientNum;
  sent.r.svFlags |= SVF.NOTSINGLECLIENT;
  sent.r.singleClient = ps.clientNum;

  ps.externalEvent = externalEvent;
}

/** `SnapVector`: each component truncated towards zero, as the wire would carry it. */
function snapVector(v: Vec3): Vec3 {
  return vec3(Math.trunc(v.x), Math.trunc(v.y), Math.trunc(v.z));
}
