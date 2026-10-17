import { isSpectator, setClientViewAngle } from './client';
import { f, qvmAngleVectors } from './cm/q-math';
import { DAMAGE_NO_PROTECTION, damage } from './combat';
import { EF_TELEPORT_BIT, MOD, PM_DEAD, PMF_TIME_KNOCKBACK } from './constants';
import { EV } from './events';
import { ET, playerStateToEntityState, SVF, type GameEntity } from './game-entity';
import { JUMP_PAD_SOUND } from './jump-pad';
import type { Level } from './level';
import { pickTarget } from './targets';
import { tempEntity } from './temp-entity';
import { initTrigger } from './triggers';
import { resetHistory } from './unlagged';
import { add, vtos, type Vec3 } from './vec3';

/**
 * Teleporters: `TeleportPlayer` (`g_misc.c:79–124`), what moves a player from one place to
 * another, and the three things that call it on a map — `trigger_teleport`, which a player walks
 * into, `target_teleporter`, which something else fires, and `misc_teleporter_dest`, which only
 * marks where they arrive.
 *
 * A destination is any entity the teleporter's `target` names: a `misc_teleporter_dest`, a
 * `target_position`, or whatever else has the name. Its origin and angles are where the player
 * lands and which way they face, and they leave it at 400 ups along that facing.
 *
 * The client predicts the trigger's touch only so far as to hide the world until the snapshot
 * with the teleport arrives (`cg.hyperspace`), which is why the trigger is sent to the clients.
 */

/** Where `TeleportPlayer` lands a player: one unit over the destination (`g_misc.c:98`). */
export const TELEPORT_LIFT = 1;

/** The speed the teleporter spits a player out at (`g_misc.c:102`). */
export const TELEPORT_SPEED = 400;

/** The knockback window the spit opens, in milliseconds (`g_misc.c:103`). */
export const TELEPORT_KNOCKBACK_TIME = 160;

/** What `G_KillBox` does to whoever it finds (`g_utils.c:547`): more than anything survives. */
export const TELEFRAG_DAMAGE = 100_000;

/**
 * ioquake3's `noAngles` (`g_misc.c:83`): a destination pitch past this keeps the player's facing
 * and speed, for a caller with no facing to give.
 */
export const NO_ANGLES_PITCH = 999999;

/** `trigger_teleport`'s spawnflag 1: spectators only, and the clients are not told of it. */
export const TELEPORT_SPECTATOR_ONLY = 1;

/** The spit's forward, as the game module's `AngleVectors` writes it. */
const spitScratch = [0, 0, 0];

/**
 * `TeleportPlayer` (`g_misc.c:79–124`): move a player to a destination, facing its way and
 * moving off along it.
 *
 * A spectator is moved and nothing else: no effect at either end, no telefrag, and no link, since
 * a spectator is never in the world. The port's spectator includes a Clan Arena player waiting
 * out a round, as everywhere else that tells a spectator apart.
 *
 * The spit is `AngleVectors` in the game module's floats, times 400, so a destination facing
 * west throws the player along a y of −3.5e-5 rather than 0, as Quake 3's does.
 *
 * @param level - The level the player is in.
 * @param player - A client's entity.
 * @param origin - The destination: the player lands {@link TELEPORT_LIFT} above it.
 * @param angles - The facing, in degrees, or a pitch over {@link NO_ANGLES_PITCH} for none.
 */
export function teleportPlayer(
  level: Level,
  player: GameEntity,
  origin: Vec3,
  angles: Vec3
): void {
  const client = player.client;
  if (!client) return;
  const state = client.ps;
  const noAngles = angles.x > NO_ANGLES_PITCH;
  const spectator = isSpectator(client);

  if (!spectator) teleportEvents(level, player, state.origin, origin);

  // "unlink to make sure it can't possibly interfere with G_KillBox".
  level.unlinkEntity(player);

  state.origin.x = f(origin.x);
  state.origin.y = f(origin.y);
  state.origin.z = f(f(origin.z) + TELEPORT_LIFT);
  if (!noAngles) {
    // "spit the player out", under a knockback window that holds the speed.
    qvmAngleVectors([angles.x, angles.y, angles.z], spitScratch, null, null);
    state.velocity.x = f(spitScratch[0] * TELEPORT_SPEED);
    state.velocity.y = f(spitScratch[1] * TELEPORT_SPEED);
    state.velocity.z = f(spitScratch[2] * TELEPORT_SPEED);
    state.pmTime = TELEPORT_KNOCKBACK_TIME;
    state.pmFlags |= PMF_TIME_KNOCKBACK;
    setClientViewAngle(player, angles);
  }

  // "toggle the teleport bit so the client knows to not lerp".
  state.eFlags ^= EF_TELEPORT_BIT;
  // unlagged's: the history is filled where the player left from, before the move links them at
  // the other end, so a rewind finds one end or the other and never a point between.
  resetHistory(level, player);

  if (!spectator) killBox(level, player);

  // "save results of pmove", then link at the exact origin.
  playerStateToEntityState(state, player.s, true);
  player.r.currentOrigin.x = state.origin.x;
  player.r.currentOrigin.y = state.origin.y;
  player.r.currentOrigin.z = state.origin.z;
  if (!spectator) level.linkEntity(player);
}

/**
 * A player put where a live check wants them, standing still and facing `angles`:
 * {@link teleportPlayer}'s move and turn at the exact origin, with no effect at either end, no
 * spit and no telefrag. The teleport bit is flipped, so no client draws the jump.
 *
 * @param player - A client's entity.
 * @param link - `trap_LinkEntity`, as the host has it.
 */
export function placePlayer(
  player: GameEntity,
  origin: Vec3,
  angles: Vec3,
  link: (entity: GameEntity) => void
): void {
  const client = player.client;
  if (!client) return;
  const state = client.ps;
  state.origin.x = f(origin.x);
  state.origin.y = f(origin.y);
  state.origin.z = f(origin.z);
  state.velocity.x = 0;
  state.velocity.y = 0;
  state.velocity.z = 0;
  setClientViewAngle(player, angles);
  state.eFlags ^= EF_TELEPORT_BIT;
  playerStateToEntityState(state, player.s, true);
  player.r.currentOrigin.x = state.origin.x;
  player.r.currentOrigin.y = state.origin.y;
  player.r.currentOrigin.z = state.origin.z;
  if (!isSpectator(client)) link(player);
}

/**
 * `TeleportPlayer`'s two events (`g_misc.c:84-92`): the player's going at `from` and coming at
 * `to`, each a temp entity of its own, "to prevent the effect from getting dropped by a second
 * player event", the going first.
 */
export function teleportEvents(level: Level, player: GameEntity, from: Vec3, to: Vec3): void {
  const out = tempEntity(level, from, EV.PLAYER_TELEPORT_OUT);
  out.s.clientNum = player.s.clientNum;
  const into = tempEntity(level, to, EV.PLAYER_TELEPORT_IN);
  into.s.clientNum = player.s.clientNum;
}

/**
 * `G_KillBox` (`g_utils.c:529–550`): kill every client in the box this one has just arrived in.
 *
 * The box is the one the world links the player with, about where the move put them. Each client
 * in it takes {@link TELEFRAG_DAMAGE} from the one arriving, which god does not stop, and dies of
 * `MOD_TELEFRAG`.
 *
 * @param level - The level the player is in.
 * @param entity - The client that has arrived, which must not be in the world yet or it would
 *   find itself.
 */
export function killBox(level: Level, entity: GameEntity): void {
  const origin = level.clients[entity.s.number].ps.origin;
  const touch = level.entitiesInBox(add(origin, entity.r.mins), add(origin, entity.r.maxs));
  for (const number of touch) {
    const hit = level.gentities[number];
    if (!hit.client) continue;
    // "nail it", with the one arriving as inflictor and attacker both.
    damage(level, hit, entity, entity, null, TELEFRAG_DAMAGE, DAMAGE_NO_PROTECTION, MOD.TELEFRAG);
  }
}

/**
 * `SP_trigger_teleport` (`g_trigger.c:305–323`): a brush that teleports whoever walks into it to
 * a destination its `target` names, sent to the clients so they can hide the world as they go.
 * A spectators-only one is not sent.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnTriggerTeleport(level: Level, self: GameEntity): void {
  initTrigger(level, self);

  // "unlike other triggers, we need to send this one to the client unless is a spectator
  // trigger".
  if (self.spawnflags & TELEPORT_SPECTATOR_ONLY) {
    self.r.svFlags |= SVF.NOCLIENT;
  } else {
    self.r.svFlags &= ~SVF.NOCLIENT;
  }

  // "make sure the client precaches this sound", which is the jump pad's.
  level.itemMatch.soundIndex(JUMP_PAD_SOUND);

  self.s.eType = ET.TELEPORT_TRIGGER;
  self.touch = (it, other) => touchTriggerTeleport(level, it, other);
  level.linkEntity(self);
}

/**
 * `trigger_teleporter_touch` (`g_trigger.c:271–294`): a living client goes to one of the
 * destinations, picked at random. A dead one is refused, and so is anyone not spectating at a
 * spectators-only trigger.
 */
function touchTriggerTeleport(level: Level, self: GameEntity, other: GameEntity): void {
  const client = other.client;
  if (!client) return;
  if (client.ps.pmType === PM_DEAD) return;
  // "Spectators only?"
  if (self.spawnflags & TELEPORT_SPECTATOR_ONLY && !isSpectator(client)) return;

  teleportToTarget(level, self, other);
}

/**
 * `SP_target_teleporter` (`g_target.c:362–367`): teleports whoever set it off to a destination
 * its `target` names. It is never linked: it has no shape, and is found by its `targetname`.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 */
export function spawnTargetTeleporter(level: Level, self: GameEntity): void {
  if (self.targetname === null) {
    level.itemMatch.print(`untargeted ${self.classname} at ${vtos(self.s.origin)}`);
  }
  // `target_teleporter_use` (`g_target.c:345–357`): only a client is moved.
  self.use = (it, _other, activator) => {
    if (!activator?.client) return;
    teleportToTarget(level, it, activator);
  };
}

/** The part both teleporters share: a destination by `G_PickTarget`, and the move. */
function teleportToTarget(level: Level, self: GameEntity, player: GameEntity): void {
  const { random, print } = level.itemMatch;
  const dest = pickTarget(level, self.target, random, print);
  if (!dest) {
    print("Couldn't find teleporter destination");
    return;
  }
  teleportPlayer(level, player, dest.s.origin, dest.s.angles);
}
