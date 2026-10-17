import { MAX_GENTITIES, type EntityState } from '../net/protocol';
import { f } from '../sim/cm/q-math';
import { EF_PLAYER_EVENT, SURF } from '../sim/constants';
import { NO_IMPACT_DIR, byteToDir } from '../sim/dir-byte';
import { SOLID_BMODEL } from '../sim/entity-solid';
import { EV, eventNumber } from '../sim/events';
import { ET } from '../sim/game-entity';
import { EVENT_VALID_MSEC } from '../sim/level';
import { evaluateTrajectory } from '../sim/trajectory';
import { NO_CONTENTS, type PointContentsFn, type TraceFn } from '../sim/types';
import { copy, vec3, type Vec3 } from '../sim/vec3';
import { WP, type WeaponId } from '../sim/weapons/constants';
import { ID_SHOTGUN, shotgunPattern, traceShot, type ShotgunRules } from '../sim/weapons/hitscan';
import { PELLET_BUBBLE_SPACING, pelletBubbleLine } from './bubbles';
import { RESPAWN_SOUND, itemAt, pickupSound } from './item-sounds';
import type { Rgb } from './player-color';
import { TELE_IN_SOUND, TELE_OUT_SOUND } from './teleport-events';

/**
 * What the world did, read off the entities a client is sent — `CG_CheckEvents` and the part of
 * `CG_EntityEvent` that answers for impacts (`cg_ents.c:1251`, `cg_event.c:955`).
 *
 * A client is never told that a rocket exploded. It is told about an entity, and works out for
 * itself that the entity is carrying an event it has not seen before. Two kinds of entity carry
 * one: something that still exists and had something happen to it, like a grenade that bounced,
 * and something that exists *only* because something happened, like the spark where a bullet
 * struck. The second sort says so in its entity type, `ET_EVENTS + eventNum`, which is why it
 * needs no counter — a slot that has just appeared cannot be one already seen.
 *
 * Engine-free, like the rest of `src/view/`: what comes out is where to draw and what to hear,
 * and the renderer decides how.
 */

/** An event on an entity, and where the entity was when it happened. */
export interface EntityEvent {
  /** The entity state carrying it: its weapon, whose shot it was, and its second origin. */
  state: EntityState;
  /**
   * `es->number`: the entity it happened to, and the one it is heard from. The carrier's own slot,
   * except for a player's event sent on its own, which is the player's (`EF_PLAYER_EVENT`).
   */
  number: number;
  /** The event number, with the counter bits taken off. */
  event: number;
  /** The event's one argument, whose meaning is the event's. */
  parm: number;
  /** Where it happened, which is the trajectory at this instant rather than where it started. */
  origin: Vec3;
  /**
   * Where its sounds are heard from (`CG_SetEntitySoundPosition`): {@link origin}, or for a brush
   * model, that plus its model's midpoint.
   */
  soundOrigin: Vec3;
}

/**
 * `cg_entities[]`, reduced to what "have I seen this event" needs.
 *
 * One entry per entity slot rather than per entity, because that is what the client has: a slot
 * is the only name an entity has on the wire, and two entities that use one in turn are told
 * apart by when each was seen rather than by identity.
 */
export interface EntityEvents {
  /** `cent->previousEvent`: the event field this slot was last seen carrying. */
  previousEvent: number[];
  /** `cent->snapShotTime`: when the slot was last seen at all. */
  seenTime: number[];
}

/** A client that has been told nothing yet. */
export function createEntityEvents(): EntityEvents {
  return {
    previousEvent: new Array<number>(MAX_GENTITIES).fill(0),
    // Never seen, so the first sighting of any slot starts from nothing.
    seenTime: new Array<number>(MAX_GENTITIES).fill(Number.NEGATIVE_INFINITY)
  };
}

/** A midpoint of nothing, for a client that knows of no inline models. */
const ORIGIN: Readonly<Vec3> = vec3();

/**
 * `CG_CheckEvents` (`cg_ents.c:1251–1281`): which of these entities are carrying something new.
 *
 * The two kinds are told apart by entity type and remembered differently. An event-only entity
 * fires once and is then marked as fired, whatever its slot does afterwards; an event riding on a
 * lasting entity fires whenever the field *changes*, which is what the counter in its top two
 * bits is for — the same event twice running is still two.
 *
 * A slot nobody has seen for an event window is treated as new (`CG_ResetEntity`), because by
 * then the server has freed whatever was there and may have given the slot to something else.
 *
 * @param events - The client's per-slot memory, advanced in place.
 * @param entities - The entity states this frame, as a snapshot carries them.
 * @param time - The frame's time, which is where along its trajectory each entity is.
 * @param midpoint - `cgs.inlineModelMidpoints`: the middle of an inline model's box.
 * @returns What is new, in the order the entities came.
 */
export function checkEntityEvents(
  events: EntityEvents,
  entities: readonly EntityState[],
  time: number,
  midpoint: (modelindex: number) => Readonly<Vec3> = () => ORIGIN
): EntityEvent[] {
  const found: EntityEvent[] = [];

  for (const state of entities) {
    const slot = state.number;
    if (events.seenTime[slot] < time - EVENT_VALID_MSEC) events.previousEvent[slot] = 0;
    events.seenTime[slot] = time;

    let event: number;
    let number = slot;
    if (state.eType > ET.EVENTS) {
      if (events.previousEvent[slot]) continue;
      // Any non-zero mark will do: the entity is nothing but this event, so there is no second
      // one to tell apart from it.
      events.previousEvent[slot] = 1;
      event = state.eType - ET.EVENTS;
      // "If this is a player event set the entity number of the client entity number."
      if (state.eFlags & EF_PLAYER_EVENT) number = state.otherEntityNum;
    } else {
      if (state.event === events.previousEvent[slot]) continue;
      events.previousEvent[slot] = state.event;
      if (eventNumber(state.event) === 0) continue;
      event = state.event;
    }

    const origin = evaluateTrajectory(state.pos, time);
    let soundOrigin = origin;
    if (state.solid === SOLID_BMODEL) {
      const middle = midpoint(state.modelindex);
      soundOrigin = vec3(f(origin.x + middle.x), f(origin.y + middle.y), f(origin.z + middle.z));
    }
    found.push({
      state,
      number,
      event: eventNumber(event),
      parm: state.eventParm,
      origin,
      soundOrigin
    });
  }

  return found;
}

/** Something the renderer should draw and the sound bus should play. */
export type WorldEffect =
  /**
   * A shot landed somewhere: a scorch, a spark, the weapon's impact sound and its mark, the rail's
   * in its shooter's `color1` (`CG_MissileHitWall`, `cg_weapons.c:1928-1933`).
   */
  | { type: 'impact'; weapon: WeaponId; origin: Vec3; normal: Vec3; color?: Rgb }
  /** A shot struck someone, and they bled where it did (`CG_Bleed`). */
  | { type: 'blood'; origin: Vec3 }
  /**
   * A sound the world made: an item taken or coming back, or a teleport. It is started on entity
   * `number`, which `origin` places as the event found it (`CG_SetEntitySoundPosition`), and heard
   * from wherever that entity is from then on. A global one is on the listener's own entity and
   * places nothing.
   */
  | { type: 'sound'; path: string; number: number; origin: Vec3 | null }
  /**
   * A sound the match named on an event (`EV_GENERAL_SOUND`, `EV_GLOBAL_SOUND`): its `CS_SOUNDS`
   * slot, which `cgs.gameSounds` holds it in, and the name the slot has, which is registered
   * again where the slot holds nothing (`CG_CustomSound`). Started and placed as a `sound` is; a
   * global one "from the player's head so it never diminishes".
   */
  | { type: 'gameSound'; index: number; name: string; number: number; origin: Vec3 | null }
  /**
   * A smoke puff at a point: the one a jump pad throws where the player hit it
   * (`CG_EntityEvent`'s `EV_JUMP_PAD`). It neither grows nor follows anything.
   */
  | { type: 'puff'; origin: Vec3 }
  /**
   * The puff a hasted player left at their feet as they ran (`CG_HasteTrail`). Unlike a jump
   * pad's, it grows as it fades — `LE_SCALE_FADE`.
   */
  | { type: 'hastePuff'; origin: Vec3 }
  /** Bubbles a shot left along a line under water, `spacing` units apart (`CG_BubbleTrail`). */
  | { type: 'bubbles'; start: Vec3; end: Vec3; spacing: number }
  /** A player teleported in or out here: `CG_SpawnEffect`'s fading model, at the event. */
  | { type: 'teleport'; origin: Vec3 }
  /**
   * A beam weapon drew a line. `start` is the shot's own muzzle, not the drawn gun's, and `hit`
   * is whether there is anything at the far end to crackle against. `own` is whether this
   * client fired it, and `color` is the `color1` of whoever did (`CG_RailTrail`).
   */
  | {
      type: 'beam';
      weapon: WeaponId;
      start: Vec3;
      end: Vec3;
      hit: boolean;
      own: boolean;
      color: Rgb;
    };

/** What a client knows of the players, which is whose each shot was and who it struck. */
export interface Players {
  /** `cg.snap->ps.clientNum`: the player this client is. */
  own: number;
  /** `cgs.clientinfo[clientNum].color1`. */
  color(clientNum: number): Rgb;
  /** Whether the snapshot's entity of this number is a player (`eType == ET_PLAYER`). */
  isPlayer(number: number): boolean;
}

/** Nobody: a client told of no one, whose shots are nobody's and strike nobody. */
const NO_PLAYERS: Players = { own: -1, color: () => [0, 0, 0], isPlayer: () => false };

/**
 * `CG_EntityEvent`'s impacts (`cg_event.c:962–1020`): what each world event means on screen.
 *
 * The shotgun is the interesting one. Its event carries a seed and the aim, and the client runs
 * the same eleven pellets the server traced and traces each one itself — so eleven marks appear
 * for the price of one event, and they are the same eleven marks every client draws. A pellet
 * that strikes a player bleeds them instead, if the client's trace finds them where the server's
 * did.
 *
 * @param events - What {@link checkEntityEvents} found.
 * @param trace - `CG_Trace`, through the map and everyone it was sent, for the shotgun's pellets.
 * @param players - Who fired each rail, which is whose colour it is, and who a pellet struck.
 * @param gameSound - `CG_ConfigString( CS_SOUNDS + index )`: the path of a sound the match named,
 *   which is what `EV_GENERAL_SOUND` and `EV_GLOBAL_SOUND` carry instead of a file name.
 * @param shotgun - The shotgun's pattern, as the serverinfo names it.
 * @param pointContents - `CG_PointContents`, for the pellets' bubbles.
 */
export function transitionEntityEvents(
  events: readonly EntityEvent[],
  trace: TraceFn,
  players: Players = NO_PLAYERS,
  gameSound: (index: number) => string = () => '',
  shotgun: Readonly<ShotgunRules> = ID_SHOTGUN,
  pointContents: PointContentsFn = NO_CONTENTS
): WorldEffect[] {
  const effects: WorldEffect[] = [];

  for (const { event, parm, state, number, origin, soundOrigin } of events) {
    switch (event) {
      case EV.MISSILE_HIT:
        // `CG_MissileHitPlayer` (`cg_weapons.c:1945–1963`): the blood, and for the grenade and
        // the rocket their explosion as well.
        bleed(effects, origin, state.otherEntityNum, players);
        if (state.weapon !== WP.GRENADE_LAUNCHER && state.weapon !== WP.ROCKET_LAUNCHER) break;
        effects.push({
          type: 'impact',
          weapon: state.weapon as WeaponId,
          origin: copy(origin),
          normal: byteToDir(parm)
        });
        break;

      case EV.MISSILE_MISS:
      // Metal sounds different only for Team Arena's guns (`cg_weapons.c:1770-1779`).
      case EV.MISSILE_MISS_METAL:
        effects.push({
          type: 'impact',
          weapon: impactWeapon(state.weapon),
          origin: copy(origin),
          normal: byteToDir(parm)
        });
        break;

      case EV.BULLET_HIT_WALL:
        effects.push({
          type: 'impact',
          weapon: WP.MACHINEGUN,
          origin: copy(origin),
          normal: byteToDir(parm)
        });
        break;

      case EV.BULLET_HIT_FLESH:
        // `CG_Bullet`: flesh bleeds rather than being marked, and its parm names who was hit
        // rather than a surface.
        bleed(effects, origin, parm, players);
        break;

      case EV.SHOTGUN: {
        const { pos, origin2, otherEntityNum } = state;
        effects.push(
          ...shotgunBlast(
            pos.trBase,
            origin2,
            parm,
            otherEntityNum,
            trace,
            players,
            shotgun,
            pointContents
          )
        );
        break;
      }

      case EV.ITEM_PICKUP:
      case EV.GLOBAL_ITEM_PICKUP: {
        const item = itemAt(parm);
        if (!item) break;
        // A powerup's pickup is heard as the health sound at prediction time, so that the owner
        // hears it at once; the item's own sound follows from the world, and a map's
        // `noglobalsound` is what leaves that second one out.
        const path = pickupSound(item, event === EV.GLOBAL_ITEM_PICKUP);
        if (path) {
          effects.push(
            event === EV.GLOBAL_ITEM_PICKUP
              ? { type: 'sound', path, number: players.own, origin: null }
              : { type: 'sound', path, number, origin: copy(soundOrigin) }
          );
        }
        break;
      }

      case EV.ITEM_RESPAWN:
        effects.push({ type: 'sound', path: RESPAWN_SOUND, number, origin: copy(soundOrigin) });
        break;

      case EV.PLAYER_TELEPORT_IN:
      case EV.PLAYER_TELEPORT_OUT:
        // Each end's sound from the event, and the effect where it is (`cg_event.c:885–895`).
        effects.push({
          type: 'sound',
          path: event === EV.PLAYER_TELEPORT_IN ? TELE_IN_SOUND : TELE_OUT_SOUND,
          number,
          origin: copy(soundOrigin)
        });
        effects.push({ type: 'teleport', origin: copy(origin) });
        break;

      case EV.GENERAL_SOUND:
      case EV.GLOBAL_SOUND: {
        // A name starting `*` is a model's own sound, which `cgs.gameSounds` never holds
        // (`CG_RegisterSounds`): the general one is played in the entity's voice
        // (`other-player-events.ts`), and the game sends no global one.
        const name = gameSound(parm);
        if (name.startsWith('*')) break;
        effects.push(
          event === EV.GLOBAL_SOUND
            ? { type: 'gameSound', index: parm, name, number: players.own, origin: null }
            : { type: 'gameSound', index: parm, name, number, origin: copy(soundOrigin) }
        );
        break;
      }

      case EV.RAILTRAIL:
        // The beam is drawn whatever it struck; the entity's own weapon is not read, because
        // only the railgun sends this. It is in its shooter's colour (`CG_RailTrail`).
        effects.push({
          type: 'beam',
          weapon: WP.RAILGUN,
          start: copy(state.origin2),
          end: copy(origin),
          hit: parm !== NO_IMPACT_DIR,
          own: state.clientNum === players.own,
          color: players.color(state.clientNum)
        });
        if (parm !== NO_IMPACT_DIR) {
          effects.push({
            type: 'impact',
            weapon: WP.RAILGUN,
            origin: copy(origin),
            normal: byteToDir(parm),
            color: players.color(state.clientNum)
          });
        }
        break;

      default:
        break;
    }
  }

  return effects;
}

/**
 * `CG_ShotgunPattern` (`cg_weapons.c:2033–2055`): a blast's pellets, and what each one struck.
 *
 * A fixed pattern is drawn on the aim's axes as CPMA's client draws it, which puts it turned about
 * the aim from where its server's pellets went when the aim is steep.
 *
 * A pellet leaves its bubbles under water whatever it struck. One into the sky leaves nothing
 * else (`cg_weapons.c:2006`). One on metal is drawn as on anything else, as baseq3 hears an
 * impact's surface only for Team Arena's guns (`cg_weapons.c:1770`).
 *
 * @param start - Where the pellets leave from: the blast's origin.
 * @param wire - The aim, as the wire carries it.
 * @param seed - The blast's seed, 0–255.
 * @param shooter - Whoever fired it, whom the pellets pass.
 * @param trace - `CG_Trace`, through the map and everyone it was sent.
 * @param players - Who a pellet struck, and whether it was this client.
 * @param shotgun - The pattern, the pellets and the spread.
 * @param pointContents - `CG_PointContents`, for the bubbles.
 */
export function shotgunBlast(
  start: Vec3,
  wire: Vec3,
  seed: number,
  shooter: number,
  trace: TraceFn,
  players: Players,
  shotgun: Readonly<ShotgunRules>,
  pointContents: PointContentsFn = NO_CONTENTS
): WorldEffect[] {
  const effects: WorldEffect[] = [];
  for (const end of shotgunPattern(start, wire, seed, shotgun)) {
    // Past whoever fired it (`CG_ShotgunPellet`, `cg_weapons.c:1980–2023`).
    const pellet = traceShot(trace, start, end, shooter);
    const bubbles = pelletBubbleLine(start, end, pellet.endpos, trace, pointContents);
    if (bubbles) effects.push({ type: 'bubbles', ...bubbles, spacing: PELLET_BUBBLE_SPACING });
    if (pellet.surfaceFlags & SURF.NOIMPACT || !pellet.hit) continue;
    // A player bleeds, as `CG_MissileHitPlayer` has the shotgun do, and nothing else does.
    if (players.isPlayer(pellet.entityNum)) {
      bleed(effects, pellet.endpos, pellet.entityNum, players);
      continue;
    }
    effects.push({
      type: 'impact',
      weapon: WP.SHOTGUN,
      origin: copy(pellet.endpos),
      normal: pellet.normal
    });
  }
  return effects;
}

/**
 * `CG_Bleed` (`cg_effects.c:496–520`): the spurt of blood where a shot struck someone.
 *
 * The player's own is flagged `RF_THIRD_PERSON`, which the renderer draws only in a mirror or a
 * portal, even with the camera behind the body. The port has neither, so the player never sees
 * their own blood, and none is made. `com_blood`, which turns all of it off, the port has no
 * setting for.
 *
 * @param entityNum - Who bled.
 */
function bleed(effects: WorldEffect[], origin: Vec3, entityNum: number, players: Players): void {
  if (entityNum === players.own) return;
  effects.push({ type: 'blood', origin: copy(origin) });
}

/**
 * Which weapon's impact to draw for an event that names none.
 *
 * `CG_MissileHitWall`'s `default` label sits on the lightning gun's case, so an impact with no
 * weapon on it looks and sounds like the lightning gun's — which is exactly what the lightning
 * gun sends, since `Weapon_LightningFire` leaves the weapon off its miss.
 *
 * The grapple's catch arrives the same way, and vanilla draws and sounds it the same way for
 * the same reason. CorkScrew gives the hook a case of its own playing `corkscrew_sfx/hit.wav`;
 * only the mod's pk3 has that file, so the port lets it fall to the default as vanilla does.
 */
function impactWeapon(weapon: number): WeaponId {
  return (weapon || WP.LIGHTNING) as WeaponId;
}
