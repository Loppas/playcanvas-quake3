import type { Message } from './msg';
import {
  DRAWN_TIME_STEPS,
  GENTITYNUM_BITS,
  MAX_GENTITIES,
  MAX_PERSISTANT,
  MAX_POWERUPS,
  MAX_STATS,
  MAX_WEAPONS,
  createEntityState,
  createPlayerState,
  type EntityState,
  type NetUserCmd,
  type PlayerState
} from './protocol';

/**
 * The delta encoding (`msg.c`): how a snapshot says what changed since the last one.
 *
 * Three ideas do all the work.
 *
 * **A field table, ordered by how often a field changes.** A delta writes the index of the last
 * field that changed and then one bit per field up to it, so putting the busy fields first makes
 * that prefix short. The order in {@link ENTITY_STATE_FIELDS} is therefore part of the protocol
 * and not a matter of taste — it is id's measurement of their own traffic, the same measurement
 * the Huffman table came from.
 *
 * **A width per field.** Every field is sent in as many bits as its values need and no more, and
 * a width of zero marks a float. Nothing on the wire says which is which; both ends read the same
 * table, and a table that disagreed would decode to plausible nonsense rather than to an error.
 *
 * **Floats that happen to be whole numbers are cheap.** An integral value between −4096 and 4095
 * goes in thirteen bits and a bias; everything else costs the full thirty-two. Most of a game's
 * floats are whole, because `SnapVector` makes them so.
 *
 * The entity and player encodings differ in two small ways that look like oversights and have to
 * be kept: an entity's fields each carry an extra "is it zero" bit that a player's do not, for
 * both floats and integers. An entity is one of hundreds and a player is one, so the extra bit
 * pays for itself in one table and not in the other.
 */

/** `FLOAT_INT_BITS` (msg.c:802): the width an integral float is sent in. */
const FLOAT_INT_BITS = 13;

/** `FLOAT_INT_BIAS` (msg.c:803): added so the range is equally positive and negative. */
const FLOAT_INT_BIAS = 1 << (FLOAT_INT_BITS - 1);

/** Scratch for reading a float's bits, so the codec does not allocate per field. */
const floatBits = new DataView(new ArrayBuffer(4));

/** A zeroed entity, which a removal is copied from as `Com_Memset` clears one. Never written. */
const NO_ENTITY = createEntityState();

/** `dummy`, the zeroed player state a delta from nothing is read against. Never written. */
const NO_PLAYER = createPlayerState();

/** A float as the 32 bits the wire carries. */
function floatToBits(value: number): number {
  floatBits.setFloat32(0, value, true);
  return floatBits.getInt32(0, true);
}

/** The float those 32 bits hold. */
function bitsToFloat(bits: number): number {
  floatBits.setInt32(0, bits, true);
  return floatBits.getFloat32(0, true);
}

/**
 * One field of a state, as the wire sees it.
 *
 * Quake 3's `netField_t` is a name and a byte offset into a C struct, which works because every
 * field of both structs is exactly four bytes. The port reaches the field by accessor instead,
 * which is the same table without the assumption.
 */
export interface NetField<T> {
  /** Quake 3's own spelling, so a trace of a message reads like Quake 3's. */
  readonly name: string;
  /** The width in bits; `0` marks a float, and a negative width is a signed integer. */
  readonly bits: number;
  readonly get: (state: T) => number;
  readonly set: (state: T, value: number) => void;
}

/** Shorthand for a table entry, so the tables read as tables. */
function field<T>(
  name: string,
  bits: number,
  get: (state: T) => number,
  set: (state: T, value: number) => void
): NetField<T> {
  return { name, bits, get, set };
}

/**
 * `entityStateFields` (msg.c:406–458), all fifty-one of them in Quake 3's order.
 *
 * `number` is not here: it is written ahead of the delta, because the reader needs it to know
 * which entity the delta is even about.
 */
export const ENTITY_STATE_FIELDS: readonly NetField<EntityState>[] = [
  field('pos.trTime', 32, (s) => s.pos.trTime, (s, v) => { s.pos.trTime = v; }),
  field('pos.trBase[0]', 0, (s) => s.pos.trBase.x, (s, v) => { s.pos.trBase.x = v; }),
  field('pos.trBase[1]', 0, (s) => s.pos.trBase.y, (s, v) => { s.pos.trBase.y = v; }),
  field('pos.trDelta[0]', 0, (s) => s.pos.trDelta.x, (s, v) => { s.pos.trDelta.x = v; }),
  field('pos.trDelta[1]', 0, (s) => s.pos.trDelta.y, (s, v) => { s.pos.trDelta.y = v; }),
  field('pos.trBase[2]', 0, (s) => s.pos.trBase.z, (s, v) => { s.pos.trBase.z = v; }),
  field('apos.trBase[1]', 0, (s) => s.apos.trBase.y, (s, v) => { s.apos.trBase.y = v; }),
  field('pos.trDelta[2]', 0, (s) => s.pos.trDelta.z, (s, v) => { s.pos.trDelta.z = v; }),
  field('apos.trBase[0]', 0, (s) => s.apos.trBase.x, (s, v) => { s.apos.trBase.x = v; }),
  field('event', 10, (s) => s.event, (s, v) => { s.event = v; }),
  field('angles2[1]', 0, (s) => s.angles2.y, (s, v) => { s.angles2.y = v; }),
  field('eType', 8, (s) => s.eType, (s, v) => { s.eType = v; }),
  field('torsoAnim', 8, (s) => s.torsoAnim, (s, v) => { s.torsoAnim = v; }),
  field('eventParm', 8, (s) => s.eventParm, (s, v) => { s.eventParm = v; }),
  field('legsAnim', 8, (s) => s.legsAnim, (s, v) => { s.legsAnim = v; }),
  field('groundEntityNum', GENTITYNUM_BITS, (s) => s.groundEntityNum, (s, v) => { s.groundEntityNum = v; }),
  field('pos.trType', 8, (s) => s.pos.trType, (s, v) => { s.pos.trType = v; }),
  field('eFlags', 19, (s) => s.eFlags, (s, v) => { s.eFlags = v; }),
  field('otherEntityNum', GENTITYNUM_BITS, (s) => s.otherEntityNum, (s, v) => { s.otherEntityNum = v; }),
  field('weapon', 8, (s) => s.weapon, (s, v) => { s.weapon = v; }),
  field('clientNum', 8, (s) => s.clientNum, (s, v) => { s.clientNum = v; }),
  field('angles[1]', 0, (s) => s.angles.y, (s, v) => { s.angles.y = v; }),
  field('pos.trDuration', 32, (s) => s.pos.trDuration, (s, v) => { s.pos.trDuration = v; }),
  field('apos.trType', 8, (s) => s.apos.trType, (s, v) => { s.apos.trType = v; }),
  field('origin[0]', 0, (s) => s.origin.x, (s, v) => { s.origin.x = v; }),
  field('origin[1]', 0, (s) => s.origin.y, (s, v) => { s.origin.y = v; }),
  field('origin[2]', 0, (s) => s.origin.z, (s, v) => { s.origin.z = v; }),
  field('solid', 24, (s) => s.solid, (s, v) => { s.solid = v; }),
  field('powerups', MAX_POWERUPS, (s) => s.powerups, (s, v) => { s.powerups = v; }),
  field('modelindex', 8, (s) => s.modelindex, (s, v) => { s.modelindex = v; }),
  field('otherEntityNum2', GENTITYNUM_BITS, (s) => s.otherEntityNum2, (s, v) => { s.otherEntityNum2 = v; }),
  field('loopSound', 8, (s) => s.loopSound, (s, v) => { s.loopSound = v; }),
  field('generic1', 8, (s) => s.generic1, (s, v) => { s.generic1 = v; }),
  field('origin2[2]', 0, (s) => s.origin2.z, (s, v) => { s.origin2.z = v; }),
  field('origin2[0]', 0, (s) => s.origin2.x, (s, v) => { s.origin2.x = v; }),
  field('origin2[1]', 0, (s) => s.origin2.y, (s, v) => { s.origin2.y = v; }),
  field('modelindex2', 8, (s) => s.modelindex2, (s, v) => { s.modelindex2 = v; }),
  field('angles[0]', 0, (s) => s.angles.x, (s, v) => { s.angles.x = v; }),
  field('time', 32, (s) => s.time, (s, v) => { s.time = v; }),
  field('apos.trTime', 32, (s) => s.apos.trTime, (s, v) => { s.apos.trTime = v; }),
  field('apos.trDuration', 32, (s) => s.apos.trDuration, (s, v) => { s.apos.trDuration = v; }),
  field('apos.trBase[2]', 0, (s) => s.apos.trBase.z, (s, v) => { s.apos.trBase.z = v; }),
  field('apos.trDelta[0]', 0, (s) => s.apos.trDelta.x, (s, v) => { s.apos.trDelta.x = v; }),
  field('apos.trDelta[1]', 0, (s) => s.apos.trDelta.y, (s, v) => { s.apos.trDelta.y = v; }),
  field('apos.trDelta[2]', 0, (s) => s.apos.trDelta.z, (s, v) => { s.apos.trDelta.z = v; }),
  field('time2', 32, (s) => s.time2, (s, v) => { s.time2 = v; }),
  field('angles[2]', 0, (s) => s.angles.z, (s, v) => { s.angles.z = v; }),
  field('angles2[0]', 0, (s) => s.angles2.x, (s, v) => { s.angles2.x = v; }),
  field('angles2[2]', 0, (s) => s.angles2.z, (s, v) => { s.angles2.z = v; }),
  field('constantLight', 32, (s) => s.constantLight, (s, v) => { s.constantLight = v; }),
  field('frame', 16, (s) => s.frame, (s, v) => { s.frame = v; })
];

/**
 * `playerStateFields` (msg.c:1093–1142), all forty-eight.
 *
 * `stats`, `persistant`, `powerups` and `ammo` are not here. Each is sixteen numbers that mostly
 * sit still, so they are sent after the table as a bitmask and the values it names — see
 * {@link writeDeltaPlayerState}. `externalEventTime` is not sent at all, though it sits between
 * two fields that are.
 */
export const PLAYER_STATE_FIELDS: readonly NetField<PlayerState>[] = [
  field('commandTime', 32, (s) => s.commandTime, (s, v) => { s.commandTime = v; }),
  field('origin[0]', 0, (s) => s.origin.x, (s, v) => { s.origin.x = v; }),
  field('origin[1]', 0, (s) => s.origin.y, (s, v) => { s.origin.y = v; }),
  field('bobCycle', 8, (s) => s.bobCycle, (s, v) => { s.bobCycle = v; }),
  field('velocity[0]', 0, (s) => s.velocity.x, (s, v) => { s.velocity.x = v; }),
  field('velocity[1]', 0, (s) => s.velocity.y, (s, v) => { s.velocity.y = v; }),
  field('viewangles[1]', 0, (s) => s.viewangles.y, (s, v) => { s.viewangles.y = v; }),
  field('viewangles[0]', 0, (s) => s.viewangles.x, (s, v) => { s.viewangles.x = v; }),
  field('weaponTime', -16, (s) => s.weaponTime, (s, v) => { s.weaponTime = v; }),
  field('origin[2]', 0, (s) => s.origin.z, (s, v) => { s.origin.z = v; }),
  field('velocity[2]', 0, (s) => s.velocity.z, (s, v) => { s.velocity.z = v; }),
  field('legsTimer', 8, (s) => s.legsTimer, (s, v) => { s.legsTimer = v; }),
  field('pm_time', -16, (s) => s.pmTime, (s, v) => { s.pmTime = v; }),
  field('eventSequence', 16, (s) => s.eventSequence, (s, v) => { s.eventSequence = v; }),
  field('torsoAnim', 8, (s) => s.torsoAnim, (s, v) => { s.torsoAnim = v; }),
  field('movementDir', 4, (s) => s.movementDir, (s, v) => { s.movementDir = v; }),
  field('events[0]', 8, (s) => s.events[0], (s, v) => { s.events[0] = v; }),
  field('legsAnim', 8, (s) => s.legsAnim, (s, v) => { s.legsAnim = v; }),
  field('events[1]', 8, (s) => s.events[1], (s, v) => { s.events[1] = v; }),
  field('pm_flags', 16, (s) => s.pmFlags, (s, v) => { s.pmFlags = v; }),
  field('groundEntityNum', GENTITYNUM_BITS, (s) => s.groundEntityNum, (s, v) => { s.groundEntityNum = v; }),
  field('weaponstate', 4, (s) => s.weaponstate, (s, v) => { s.weaponstate = v; }),
  field('eFlags', 16, (s) => s.eFlags, (s, v) => { s.eFlags = v; }),
  field('externalEvent', 10, (s) => s.externalEvent, (s, v) => { s.externalEvent = v; }),
  field('gravity', 16, (s) => s.gravity, (s, v) => { s.gravity = v; }),
  field('speed', 16, (s) => s.speed, (s, v) => { s.speed = v; }),
  field('delta_angles[1]', 16, (s) => s.deltaAngles.y, (s, v) => { s.deltaAngles.y = v; }),
  field('externalEventParm', 8, (s) => s.externalEventParm, (s, v) => { s.externalEventParm = v; }),
  field('viewheight', -8, (s) => s.viewheight, (s, v) => { s.viewheight = v; }),
  field('damageEvent', 8, (s) => s.damageEvent, (s, v) => { s.damageEvent = v; }),
  field('damageYaw', 8, (s) => s.damageYaw, (s, v) => { s.damageYaw = v; }),
  field('damagePitch', 8, (s) => s.damagePitch, (s, v) => { s.damagePitch = v; }),
  field('damageCount', 8, (s) => s.damageCount, (s, v) => { s.damageCount = v; }),
  field('generic1', 8, (s) => s.generic1, (s, v) => { s.generic1 = v; }),
  field('pm_type', 8, (s) => s.pmType, (s, v) => { s.pmType = v; }),
  field('delta_angles[0]', 16, (s) => s.deltaAngles.x, (s, v) => { s.deltaAngles.x = v; }),
  field('delta_angles[2]', 16, (s) => s.deltaAngles.z, (s, v) => { s.deltaAngles.z = v; }),
  field('torsoTimer', 12, (s) => s.torsoTimer, (s, v) => { s.torsoTimer = v; }),
  field('eventParms[0]', 8, (s) => s.eventParms[0], (s, v) => { s.eventParms[0] = v; }),
  field('eventParms[1]', 8, (s) => s.eventParms[1], (s, v) => { s.eventParms[1] = v; }),
  field('clientNum', 8, (s) => s.clientNum, (s, v) => { s.clientNum = v; }),
  field('weapon', 5, (s) => s.weapon, (s, v) => { s.weapon = v; }),
  field('viewangles[2]', 0, (s) => s.viewangles.z, (s, v) => { s.viewangles.z = v; }),
  field('grapplePoint[0]', 0, (s) => s.grapplePoint.x, (s, v) => { s.grapplePoint.x = v; }),
  field('grapplePoint[1]', 0, (s) => s.grapplePoint.y, (s, v) => { s.grapplePoint.y = v; }),
  field('grapplePoint[2]', 0, (s) => s.grapplePoint.z, (s, v) => { s.grapplePoint.z = v; }),
  field('jumppad_ent', GENTITYNUM_BITS, (s) => s.jumppadEnt, (s, v) => { s.jumppadEnt = v; }),
  field('loopSound', 16, (s) => s.loopSound, (s, v) => { s.loopSound = v; })
];

/**
 * Whether a field's value changed, as Quake 3 decides it.
 *
 * Quake 3 compares the two as raw 32-bit words, which for a float compares its bits. The port's
 * numbers are doubles, so a float field is rounded to the 32 bits the wire would hold it in
 * first; without that, a difference too small for the wire to carry would be sent as a change and
 * arrive as none. `Object.is` rather than `===` because the bit comparison separates `0` from
 * `-0`, and joins a NaN to itself.
 */
function changed<T>(netField: NetField<T>, from: T, to: T): boolean {
  if (netField.bits === 0) {
    return !Object.is(Math.fround(netField.get(from)), Math.fround(netField.get(to)));
  }
  return netField.get(from) !== netField.get(to);
}

/** The index one past the last field that changed — Quake 3's `lc`. */
function lastChanged<T>(fields: readonly NetField<T>[], from: T, to: T): number {
  let last = 0;
  for (let i = 0; i < fields.length; i++) {
    if (changed(fields[i], from, to)) last = i + 1;
  }
  return last;
}

// --- entities -----------------------------------------------------------------------------

/**
 * `MSG_WriteDeltaEntity` (msg.c:465–580): write one entity's changes against the last snapshot.
 *
 * Three shapes come out of this. A `to` of null is a *remove*: the entity's number and a set bit,
 * and the client drops it. An unchanged entity writes nothing at all unless `force` says to,
 * in which case it writes its number and two clear bits. Anything else writes the number, two
 * bits, the count of fields covered, and then the fields.
 *
 * @param msg - Where to write.
 * @param from - The entity as the last snapshot left it, or null to delta against nothing.
 * @param to - The entity now, or null to remove it.
 * @param force - Write an entry even when nothing changed, which a snapshot's first frame needs.
 */
export function writeDeltaEntity(
  msg: Message,
  from: EntityState | null,
  to: EntityState | null,
  force: boolean
): void {
  if (to === null) {
    if (from === null) return;
    msg.writeBits(from.number, GENTITYNUM_BITS);
    msg.writeBits(1, 1);
    return;
  }

  if (to.number < 0 || to.number >= MAX_GENTITIES) {
    throw new Error(`delta: bad entity number ${to.number}`);
  }

  const base = from ?? createEntityState(to.number);
  const lc = lastChanged(ENTITY_STATE_FIELDS, base, to);

  if (lc === 0) {
    if (!force) return;
    msg.writeBits(to.number, GENTITYNUM_BITS);
    msg.writeBits(0, 1); // not removed
    msg.writeBits(0, 1); // no delta
    return;
  }

  msg.writeBits(to.number, GENTITYNUM_BITS);
  msg.writeBits(0, 1); // not removed
  msg.writeBits(1, 1); // a delta follows
  msg.writeByte(lc);

  for (let i = 0; i < lc; i++) {
    const netField = ENTITY_STATE_FIELDS[i];
    if (!changed(netField, base, to)) {
      msg.writeBits(0, 1);
      continue;
    }
    msg.writeBits(1, 1);

    if (netField.bits === 0) {
      const value = Math.fround(netField.get(to));
      if (value === 0) {
        msg.writeBits(0, 1);
        continue;
      }
      msg.writeBits(1, 1);
      writeFloatValue(msg, value);
    } else {
      const value = netField.get(to);
      if (value === 0) {
        msg.writeBits(0, 1);
      } else {
        msg.writeBits(1, 1);
        msg.writeBits(value, netField.bits);
      }
    }
  }
}

/**
 * `MSG_ReadDeltaEntity` (msg.c:589–706): read one entity's changes back onto a copy of the last.
 *
 * A removed entity comes back zeroed with its number set to `MAX_GENTITIES - 1`, which is the
 * signal Quake 3's client checks for rather than a flag of its own.
 *
 * @param msg - Where to read from.
 * @param from - The entity as the last snapshot left it.
 * @param to - Filled in; every field the delta does not mention is copied from `from`.
 * @param number - Which entity this is, read by the caller before the delta.
 * @returns `to`.
 */
export function readDeltaEntity(
  msg: Message,
  from: EntityState,
  to: EntityState,
  number: number
): EntityState {
  if (number < 0 || number >= MAX_GENTITIES) {
    throw new Error(`delta: bad entity number ${number}`);
  }

  if (msg.readBits(1) === 1) {
    copyEntityState(NO_ENTITY, to);
    to.number = MAX_GENTITIES - 1;
    return to;
  }

  if (msg.readBits(1) === 0) {
    copyEntityState(from, to);
    to.number = number;
    return to;
  }

  const lc = msg.readByte();
  if (lc > ENTITY_STATE_FIELDS.length || lc < 0) {
    throw new Error(`delta: invalid entityState field count ${lc}`);
  }

  copyEntityState(from, to);
  to.number = number;

  for (let i = 0; i < lc; i++) {
    const netField = ENTITY_STATE_FIELDS[i];
    if (!msg.readBits(1)) {
      netField.set(to, netField.get(from));
      continue;
    }

    if (netField.bits === 0) {
      if (msg.readBits(1) === 0) netField.set(to, 0);
      else netField.set(to, readFloatValue(msg));
    } else {
      if (msg.readBits(1) === 0) netField.set(to, 0);
      else netField.set(to, msg.readBits(netField.bits));
    }
  }

  return to;
}

// --- player state -------------------------------------------------------------------------

/**
 * `MSG_WriteDeltaPlayerstate` (msg.c:1160–1265).
 *
 * Unlike an entity's, this carries no entity number and no removal bit — there is exactly one
 * player state in a snapshot and it is always there. Its fields also skip the "is it zero" bit
 * that an entity's carry, in both the float and the integer cases.
 *
 * After the table come the four arrays, each as a sixteen-bit mask of which entries moved
 * followed by those entries: stats, persistant and ammo as shorts, and powerups as longs,
 * because a powerup holds the `level.time` it expires at.
 *
 * @param msg - Where to write.
 * @param from - The state as the last snapshot left it, or null to delta against nothing.
 * @param to - The state now.
 */
export function writeDeltaPlayerState(
  msg: Message,
  from: PlayerState | null,
  to: PlayerState
): void {
  const base = from ?? createPlayerState();
  const lc = lastChanged(PLAYER_STATE_FIELDS, base, to);

  msg.writeByte(lc);

  for (let i = 0; i < lc; i++) {
    const netField = PLAYER_STATE_FIELDS[i];
    if (!changed(netField, base, to)) {
      msg.writeBits(0, 1);
      continue;
    }
    msg.writeBits(1, 1);

    if (netField.bits === 0) writeFloatValue(msg, Math.fround(netField.get(to)));
    else msg.writeBits(netField.get(to), netField.bits);
  }

  const statsBits = arrayMask(base.stats, to.stats, MAX_STATS);
  const persistantBits = arrayMask(base.persistant, to.persistant, MAX_PERSISTANT);
  const ammoBits = arrayMask(base.ammo, to.ammo, MAX_WEAPONS);
  const powerupBits = arrayMask(base.powerups, to.powerups, MAX_POWERUPS);

  if (!statsBits && !persistantBits && !ammoBits && !powerupBits) {
    msg.writeBits(0, 1);
    return;
  }
  msg.writeBits(1, 1);

  writeArray(msg, statsBits, to.stats, MAX_STATS, false);
  writeArray(msg, persistantBits, to.persistant, MAX_PERSISTANT, false);
  writeArray(msg, ammoBits, to.ammo, MAX_WEAPONS, false);
  writeArray(msg, powerupBits, to.powerups, MAX_POWERUPS, true);
}

/**
 * `MSG_ReadDeltaPlayerstate` (msg.c:1271–1408).
 *
 * @param msg - Where to read from.
 * @param from - The state as the last snapshot left it, or null for nothing.
 * @param to - Filled in; it starts as a copy of `from`, so the fields the table does not reach —
 *   `ping` and the three below it — carry over.
 * @returns `to`.
 */
export function readDeltaPlayerState(
  msg: Message,
  from: PlayerState | null,
  to: PlayerState
): PlayerState {
  const base = from ?? NO_PLAYER;
  copyPlayerState(base, to);

  const lc = msg.readByte();
  if (lc > PLAYER_STATE_FIELDS.length || lc < 0) {
    throw new Error(`delta: invalid playerState field count ${lc}`);
  }

  for (let i = 0; i < lc; i++) {
    const netField = PLAYER_STATE_FIELDS[i];
    if (!msg.readBits(1)) {
      netField.set(to, netField.get(base));
      continue;
    }
    if (netField.bits === 0) netField.set(to, readFloatValue(msg));
    else netField.set(to, msg.readBits(netField.bits));
  }

  if (msg.readBits(1)) {
    readArray(msg, to.stats, MAX_STATS, false);
    readArray(msg, to.persistant, MAX_PERSISTANT, false);
    readArray(msg, to.ammo, MAX_WEAPONS, false);
    readArray(msg, to.powerups, MAX_POWERUPS, true);
  }

  return to;
}

// --- user commands ------------------------------------------------------------------------

/**
 * `MSG_WriteDeltaKey` (msg.c:588–595): a field that is either unchanged or sent scrambled.
 *
 * The key is what stops a replayed or forged command packet from being useful: the value goes out
 * XORed with a key both ends derive from the server's message sequence and the command's own
 * time, so a packet lifted from the wire decodes to nonsense anywhere else.
 */
export function writeDeltaKey(
  msg: Message,
  key: number,
  oldValue: number,
  newValue: number,
  bits: number
): void {
  if (oldValue === newValue) {
    msg.writeBits(0, 1);
    return;
  }
  msg.writeBits(1, 1);
  msg.writeBits(newValue ^ key, bits);
}

/**
 * `MSG_ReadDeltaKey` (msg.c:597–602). The key is masked to the field's own width before the XOR,
 * since only that many bits were sent.
 */
export function readDeltaKey(msg: Message, key: number, oldValue: number, bits: number): number {
  if (msg.readBits(1)) {
    const mask = bits === 32 ? key : key & ((1 << bits) - 1);
    return msg.readBits(bits) ^ mask;
  }
  return oldValue;
}

/**
 * `MSG_WriteDeltaUsercmdKey` (msg.c:733–770).
 *
 * The time goes first and on its own: a command within 256 ms of the last costs eight bits and a
 * flag, which is every command in a healthy connection. The other eight fields are all-or-nothing
 * — a single bit says whether *any* of them moved, because a player holding still changes none of
 * them and a player doing anything at all changes the angles. The frame the input was read under
 * follows, the port's own ({@link writeDrawnFrame}).
 *
 * @param msg - Where to write.
 * @param key - The caller's key, which this mixes with the command's own time.
 * @param from - The last command sent.
 * @param to - The command now.
 */
export function writeDeltaUserCmdKey(
  msg: Message,
  key: number,
  from: NetUserCmd,
  to: NetUserCmd
): void {
  if (to.serverTime - from.serverTime < 256) {
    msg.writeBits(1, 1);
    msg.writeBits(to.serverTime - from.serverTime, 8);
  } else {
    msg.writeBits(0, 1);
    msg.writeBits(to.serverTime, 32);
  }

  if (
    from.angles[0] === to.angles[0] &&
    from.angles[1] === to.angles[1] &&
    from.angles[2] === to.angles[2] &&
    from.forwardmove === to.forwardmove &&
    from.rightmove === to.rightmove &&
    from.upmove === to.upmove &&
    from.buttons === to.buttons &&
    from.weapon === to.weapon
  ) {
    msg.writeBits(0, 1);
  } else {
    const mixed = key ^ to.serverTime;
    msg.writeBits(1, 1);
    writeDeltaKey(msg, mixed, from.angles[0], to.angles[0], 16);
    writeDeltaKey(msg, mixed, from.angles[1], to.angles[1], 16);
    writeDeltaKey(msg, mixed, from.angles[2], to.angles[2], 16);
    writeDeltaKey(msg, mixed, from.forwardmove, to.forwardmove, 8);
    writeDeltaKey(msg, mixed, from.rightmove, to.rightmove, 8);
    writeDeltaKey(msg, mixed, from.upmove, to.upmove, 8);
    writeDeltaKey(msg, mixed, from.buttons, to.buttons, 16);
    writeDeltaKey(msg, mixed, from.weapon, to.weapon, 8);
  }

  writeDrawnFrame(msg, from, to);
}

/**
 * The port's own, at protocol 2: the frame a command's input was read under, which the server
 * rewinds a shot by. One bit when it is the last command's frame, as it is for every command one
 * long frame makes; otherwise each of its three times as a signed byte back from the command's
 * own time, or the whole time where that does not reach, and then the drawn time's part of a
 * millisecond, in {@link DRAWN_TIME_STEPS}.
 */
function writeDrawnFrame(msg: Message, from: NetUserCmd, to: NetUserCmd): void {
  if (
    from.drawnTime === to.drawnTime &&
    from.drawnSnapTime === to.drawnSnapTime &&
    from.drawnNextSnapTime === to.drawnNextSnapTime
  ) {
    msg.writeBits(0, 1);
    return;
  }
  msg.writeBits(1, 1);
  const whole = Math.floor(to.drawnTime);
  writeDrawnTime(msg, to.serverTime, whole);
  writeDrawnTime(msg, to.serverTime, to.drawnSnapTime);
  writeDrawnTime(msg, to.serverTime, to.drawnNextSnapTime);
  msg.writeBits(Math.round((to.drawnTime - whole) * DRAWN_TIME_STEPS), 8);
}

function writeDrawnTime(msg: Message, serverTime: number, time: number): void {
  const back = serverTime - time;
  if (back >= -128 && back < 128) {
    msg.writeBits(1, 1);
    msg.writeBits(back, -8);
  } else {
    msg.writeBits(0, 1);
    msg.writeBits(time, 32);
  }
}

/**
 * `MSG_ReadDeltaUsercmdKey` (msg.c:815–853).
 *
 * The three move axes land in a `signed char`, so they wrap; and −128 is then corrected to −127,
 * because `cmdScale` divides by 127 and a move of −128 would make the player faster than their
 * own speed allows.
 *
 * @param msg - Where to read from.
 * @param key - The same key the writer used.
 * @param from - The last command read.
 * @param to - Filled in.
 * @returns `to`.
 */
export function readDeltaUserCmdKey(
  msg: Message,
  key: number,
  from: NetUserCmd,
  to: NetUserCmd
): NetUserCmd {
  if (msg.readBits(1)) to.serverTime = from.serverTime + msg.readBits(8);
  else to.serverTime = msg.readBits(32);

  if (msg.readBits(1)) {
    const mixed = key ^ to.serverTime;
    to.angles[0] = readDeltaKey(msg, mixed, from.angles[0], 16);
    to.angles[1] = readDeltaKey(msg, mixed, from.angles[1], 16);
    to.angles[2] = readDeltaKey(msg, mixed, from.angles[2], 16);
    to.forwardmove = moveAxis(readDeltaKey(msg, mixed, from.forwardmove, 8));
    to.rightmove = moveAxis(readDeltaKey(msg, mixed, from.rightmove, 8));
    to.upmove = moveAxis(readDeltaKey(msg, mixed, from.upmove, 8));
    to.buttons = readDeltaKey(msg, mixed, from.buttons, 16);
    to.weapon = readDeltaKey(msg, mixed, from.weapon, 8);
  } else {
    to.angles[0] = from.angles[0];
    to.angles[1] = from.angles[1];
    to.angles[2] = from.angles[2];
    to.forwardmove = from.forwardmove;
    to.rightmove = from.rightmove;
    to.upmove = from.upmove;
    to.buttons = from.buttons;
    to.weapon = from.weapon;
  }

  if (msg.readBits(1)) {
    to.drawnTime = readDrawnTime(msg, to.serverTime);
    to.drawnSnapTime = readDrawnTime(msg, to.serverTime);
    to.drawnNextSnapTime = readDrawnTime(msg, to.serverTime);
    to.drawnTime += msg.readBits(8) / DRAWN_TIME_STEPS;
  } else {
    to.drawnTime = from.drawnTime;
    to.drawnSnapTime = from.drawnSnapTime;
    to.drawnNextSnapTime = from.drawnNextSnapTime;
  }

  return to;
}

/** {@link writeDrawnTime}'s read. */
function readDrawnTime(msg: Message, serverTime: number): number {
  return msg.readBits(1) ? serverTime - msg.readBits(-8) : msg.readBits(32);
}

// --- the pieces ---------------------------------------------------------------------------

/** A move axis as the `signed char` it lands in, with Quake 3's −128 correction. */
function moveAxis(value: number): number {
  const signed = (value << 24) >> 24;
  return signed === -128 ? -127 : signed;
}

/**
 * A float's value, once something has said it is not zero: thirteen bits and a bias if it is a
 * whole number in range, and the full thirty-two if it is not.
 */
function writeFloatValue(msg: Message, value: number): void {
  const truncated = Math.trunc(value);
  if (
    truncated === value &&
    truncated + FLOAT_INT_BIAS >= 0 &&
    truncated + FLOAT_INT_BIAS < 1 << FLOAT_INT_BITS
  ) {
    msg.writeBits(0, 1);
    msg.writeBits(truncated + FLOAT_INT_BIAS, FLOAT_INT_BITS);
  } else {
    msg.writeBits(1, 1);
    msg.writeBits(floatToBits(value), 32);
  }
}

/** The other half of {@link writeFloatValue}. */
function readFloatValue(msg: Message): number {
  if (msg.readBits(1) === 0) return msg.readBits(FLOAT_INT_BITS) - FLOAT_INT_BIAS;
  return bitsToFloat(msg.readBits(32));
}

/** Which entries of one of the player state's four arrays moved. */
function arrayMask(from: readonly number[], to: readonly number[], length: number): number {
  let mask = 0;
  for (let i = 0; i < length; i++) {
    if (to[i] !== from[i]) mask |= 1 << i;
  }
  return mask;
}

/**
 * One of the player state's four arrays: a bit for whether anything moved, then the mask, then
 * the entries it names.
 *
 * @param asLong - Send each entry as 32 bits rather than 16, which only the powerups need.
 */
function writeArray(
  msg: Message,
  mask: number,
  values: readonly number[],
  length: number,
  asLong: boolean
): void {
  if (!mask) {
    msg.writeBits(0, 1);
    return;
  }
  msg.writeBits(1, 1);
  msg.writeBits(mask, length);
  for (let i = 0; i < length; i++) {
    if (!(mask & (1 << i))) continue;
    if (asLong) msg.writeLong(values[i]);
    else msg.writeShort(values[i]);
  }
}

/** The other half of {@link writeArray}, writing into `values` in place. */
function readArray(msg: Message, values: number[], length: number, asLong: boolean): void {
  if (!msg.readBits(1)) return;
  const mask = msg.readBits(length);
  for (let i = 0; i < length; i++) {
    if (!(mask & (1 << i))) continue;
    values[i] = asLong ? msg.readLong() : msg.readShort();
  }
}

/** `*to = *from` for an entity state, which the C gets from the assignment. */
export function copyEntityState(from: EntityState, to: EntityState): EntityState {
  to.number = from.number;
  to.eType = from.eType;
  to.eFlags = from.eFlags;
  copyTrajectory(from.pos, to.pos);
  copyTrajectory(from.apos, to.apos);
  to.time = from.time;
  to.time2 = from.time2;
  copyVec(from.origin, to.origin);
  copyVec(from.origin2, to.origin2);
  copyVec(from.angles, to.angles);
  copyVec(from.angles2, to.angles2);
  to.otherEntityNum = from.otherEntityNum;
  to.otherEntityNum2 = from.otherEntityNum2;
  to.groundEntityNum = from.groundEntityNum;
  to.constantLight = from.constantLight;
  to.loopSound = from.loopSound;
  to.modelindex = from.modelindex;
  to.modelindex2 = from.modelindex2;
  to.clientNum = from.clientNum;
  to.frame = from.frame;
  to.solid = from.solid;
  to.event = from.event;
  to.eventParm = from.eventParm;
  to.powerups = from.powerups;
  to.weapon = from.weapon;
  to.legsAnim = from.legsAnim;
  to.torsoAnim = from.torsoAnim;
  to.generic1 = from.generic1;
  return to;
}

/** `*to = *from` for a player state. */
export function copyPlayerState(from: PlayerState, to: PlayerState): PlayerState {
  to.commandTime = from.commandTime;
  to.pmType = from.pmType;
  to.bobCycle = from.bobCycle;
  to.pmFlags = from.pmFlags;
  to.pmTime = from.pmTime;
  copyVec(from.origin, to.origin);
  copyVec(from.velocity, to.velocity);
  to.weaponTime = from.weaponTime;
  to.gravity = from.gravity;
  to.speed = from.speed;
  copyVec(from.deltaAngles, to.deltaAngles);
  to.groundEntityNum = from.groundEntityNum;
  to.legsTimer = from.legsTimer;
  to.legsAnim = from.legsAnim;
  to.torsoTimer = from.torsoTimer;
  to.torsoAnim = from.torsoAnim;
  to.movementDir = from.movementDir;
  copyVec(from.grapplePoint, to.grapplePoint);
  to.eFlags = from.eFlags;
  to.eventSequence = from.eventSequence;
  copyInto(from.events, to.events);
  copyInto(from.eventParms, to.eventParms);
  to.externalEvent = from.externalEvent;
  to.externalEventParm = from.externalEventParm;
  to.externalEventTime = from.externalEventTime;
  to.clientNum = from.clientNum;
  to.weapon = from.weapon;
  to.weaponstate = from.weaponstate;
  copyVec(from.viewangles, to.viewangles);
  to.viewheight = from.viewheight;
  to.damageEvent = from.damageEvent;
  to.damageYaw = from.damageYaw;
  to.damagePitch = from.damagePitch;
  to.damageCount = from.damageCount;
  copyInto(from.stats, to.stats);
  copyInto(from.persistant, to.persistant);
  copyInto(from.powerups, to.powerups);
  copyInto(from.ammo, to.ammo);
  to.generic1 = from.generic1;
  to.loopSound = from.loopSound;
  to.jumppadEnt = from.jumppadEnt;
  to.ping = from.ping;
  to.pmoveFramecount = from.pmoveFramecount;
  to.jumppadFrame = from.jumppadFrame;
  to.entityEventSequence = from.entityEventSequence;
  return to;
}

/** A trajectory's fields into another's, in place. */
export function copyTrajectory(from: EntityState['pos'], to: EntityState['pos']): void {
  to.trType = from.trType;
  to.trTime = from.trTime;
  to.trDuration = from.trDuration;
  copyVec(from.trBase, to.trBase);
  copyVec(from.trDelta, to.trDelta);
}

function copyVec(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}

function copyInto(from: readonly number[], to: number[]): void {
  for (let i = 0; i < from.length; i++) to[i] = from[i];
}
