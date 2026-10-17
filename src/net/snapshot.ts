import {
  MAX_MAP_AREA_BYTES,
  MAX_PARSE_ENTITIES,
  MAX_SNAPSHOT_ENTITIES,
  PACKET_BACKUP,
  PACKET_MASK,
  SVC
} from './commands';
import { copyEntityState, copyPlayerState, readDeltaEntity, readDeltaPlayerState, writeDeltaEntity, writeDeltaPlayerState } from './delta';
import type { Message } from './msg';
import {
  createEntityState,
  createPlayerState,
  GENTITYNUM_BITS,
  MAX_GENTITIES,
  type EntityState,
  type PlayerState
} from './protocol';

/**
 * A snapshot, in both directions — Quake 3's `sv_snapshot.c` and `cl_parse.c:60–320`.
 *
 * A snapshot is the world as the host saw it on one frame, cut down to what one client is allowed
 * to know and written as a difference from something that client already has. It is the only way
 * the game's state ever reaches a client, and the two halves belong together: everything the
 * writer decides, the reader has to undo in the same order, and a test that runs one into the
 * other is the only way to know they agree.
 *
 * Nothing here decides *what* goes in a snapshot. The host picks the entities and hands them over;
 * this is the encoding alone.
 */

/**
 * `clientSnapshot_t` (`server.h:100–112`): a snapshot the host sent, kept to delta the next one
 * against.
 *
 * The entities are not in here. They live in one ring shared by every client, and a snapshot holds
 * the position it starts at and how many it took — which is why they must be written in increasing
 * entity number, and why a snapshot too old for the ring cannot be delta'd from even if the
 * snapshot itself is still held.
 */
export interface ServerSnapshot {
  /** How many of {@link areabits} are meaningful. */
  areabytes: number;
  areabits: Uint8Array;
  ps: PlayerState;
  numEntities: number;
  /** Where this snapshot's entities start in the host's ring. */
  firstEntity: number;
  /** Host time the message went out. */
  messageSent: number;
  /** Host time the client acknowledged it, which is what a ping is measured from. */
  messageAcked: number;
  messageSize: number;
}

export function createServerSnapshot(): ServerSnapshot {
  return {
    areabytes: 0,
    areabits: new Uint8Array(MAX_MAP_AREA_BYTES),
    ps: createPlayerState(),
    numEntities: 0,
    firstEntity: 0,
    messageSent: 0,
    messageAcked: 0,
    messageSize: 0
  };
}

/**
 * The host's ring of sent entity states, as the snapshot writer sees it.
 *
 * The index is the absolute count of states ever written, not a position: the ring wraps it. That
 * is what lets a snapshot say "mine start at 41,067" and stay valid until the ring has come all the
 * way round to it.
 */
export interface SnapshotEntityRing {
  at(index: number): EntityState;
}

/** What the writer needs to put one snapshot on the wire. */
export interface SnapshotWrite {
  /** The host's clock, which is what the client drifts its own time towards. */
  serverTime: number;
  /** How many messages back the delta is from, or 0 for a snapshot delta'd from nothing. */
  lastFrame: number;
  /** A mask of {@link import('./commands').SNAPFLAG}. */
  snapFlags: number;
  frame: ServerSnapshot;
  oldFrame: ServerSnapshot | null;
  entities: SnapshotEntityRing;
  /** An entity's state as it was when the map started, which a first sighting is delta'd from. */
  baseline: (number: number) => EntityState;
}

/**
 * `SV_EmitPacketEntities` (`sv_snapshot.c:53–110`): the entity half of a snapshot.
 *
 * Both lists are in increasing entity number, so the two walk together and every step is decided by
 * comparing the numbers at the front. Equal numbers mean the entity is in both snapshots and only
 * its changes are written — and since the write is unforced, an entity that did not change at all
 * costs nothing. A number present only in the new list is a first sighting, written in full against
 * its baseline. A number present only in the old list has gone, and is written as a removal.
 *
 * Reaching the end of both lists is the terminator, and it is an entity number that cannot exist.
 */
export function emitPacketEntities(
  msg: Message,
  from: ServerSnapshot | null,
  to: ServerSnapshot,
  entities: SnapshotEntityRing,
  baseline: (number: number) => EntityState
): void {
  const fromCount = from === null ? 0 : from.numEntities;

  let newIndex = 0;
  let oldIndex = 0;

  while (newIndex < to.numEntities || oldIndex < fromCount) {
    // A number no entity can hold, so whichever list is exhausted always loses the comparison.
    let newNum = 9999;
    let newEnt: EntityState | null = null;
    if (newIndex < to.numEntities) {
      newEnt = entities.at(to.firstEntity + newIndex);
      newNum = newEnt.number;
    }

    let oldNum = 9999;
    let oldEnt: EntityState | null = null;
    if (from !== null && oldIndex < fromCount) {
      oldEnt = entities.at(from.firstEntity + oldIndex);
      oldNum = oldEnt.number;
    }

    if (newNum === oldNum) {
      writeDeltaEntity(msg, oldEnt, newEnt, false);
      oldIndex++;
      newIndex++;
      continue;
    }

    if (newNum < oldNum) {
      writeDeltaEntity(msg, baseline(newNum), newEnt, true);
      newIndex++;
      continue;
    }

    writeDeltaEntity(msg, oldEnt, null, true);
    oldIndex++;
  }

  msg.writeBits(MAX_GENTITIES - 1, GENTITYNUM_BITS);
}

/**
 * `SV_WriteSnapshotToClient` (`sv_snapshot.c:115–200`): one snapshot, written.
 *
 * The order is fixed and the reader depends on every part of it: the command byte, the host's
 * time, how far back the delta came from, the flags, the area bits, the player state, then the
 * entities.
 */
export function writeSnapshot(msg: Message, write: SnapshotWrite): void {
  msg.writeByte(SVC.SNAPSHOT);
  msg.writeLong(write.serverTime);
  msg.writeByte(write.lastFrame);
  msg.writeByte(write.snapFlags);

  msg.writeByte(write.frame.areabytes);
  msg.writeData(write.frame.areabits.subarray(0, write.frame.areabytes));

  writeDeltaPlayerState(msg, write.oldFrame === null ? null : write.oldFrame.ps, write.frame.ps);

  emitPacketEntities(msg, write.oldFrame, write.frame, write.entities, write.baseline);
}

/**
 * `clSnapshot_t` (`client.h:63–83`): a snapshot as the client holds it.
 *
 * Like the host's, it does not hold its own entities — {@link SnapshotReceiver} keeps those in one
 * ring and this records where in it they are.
 */
export interface ClientSnapshot {
  /** False if the delta could not be resolved, in which case nothing here may be used. */
  valid: boolean;
  snapFlags: number;
  serverTime: number;
  /** The sequence number of the message that carried it. */
  messageNum: number;
  /** The message number it was delta'd from, or -1 for a snapshot delta'd from nothing. */
  deltaNum: number;
  ping: number;
  areamask: Uint8Array;
  ps: PlayerState;
  numEntities: number;
  /** Where this snapshot's entities start in the receiver's ring. */
  parseEntitiesNum: number;
  /** Every server command up to this one is to be run before the snapshot is made current. */
  serverCommandNum: number;
}

function createClientSnapshot(): ClientSnapshot {
  return {
    valid: false,
    snapFlags: 0,
    serverTime: 0,
    messageNum: 0,
    deltaNum: 0,
    ping: 0,
    areamask: new Uint8Array(MAX_MAP_AREA_BYTES),
    ps: createPlayerState(),
    numEntities: 0,
    parseEntitiesNum: 0,
    serverCommandNum: 0
  };
}

/** A snapshot of nothing, which a parse starts from as `Com_Memset` clears Q3's. Never written. */
const NO_SNAPSHOT = createClientSnapshot();

function copyClientSnapshot(from: ClientSnapshot, to: ClientSnapshot): ClientSnapshot {
  to.valid = from.valid;
  to.snapFlags = from.snapFlags;
  to.serverTime = from.serverTime;
  to.messageNum = from.messageNum;
  to.deltaNum = from.deltaNum;
  to.ping = from.ping;
  to.areamask.set(from.areamask);
  copyPlayerState(from.ps, to.ps);
  to.numEntities = from.numEntities;
  to.parseEntitiesNum = from.parseEntitiesNum;
  to.serverCommandNum = from.serverCommandNum;
  return to;
}

/**
 * The receiving half — `cl.snapshots` and `cl.parseEntities` (`client.h:115–140`), with
 * `CL_ParseSnapshot` and `CL_ParsePacketEntities` over them.
 *
 * Decoding a snapshot needs the one it was delta'd from, so the client keeps the last 32 and every
 * entity of all of them. Three things can make a snapshot undecodable — the frame it came from was
 * never received, that slot has since been overwritten, or its entities have rolled out of the
 * ring — and in each case the message is still read to the end, because the bytes have to be
 * consumed whether or not they can be used.
 */
export class SnapshotReceiver {
  /** Each entity's state as of the gamestate, which a first sighting is delta'd from. */
  private readonly baselines: (EntityState | null)[] = new Array<EntityState | null>(
    MAX_GENTITIES
  ).fill(null);

  private readonly snapshots: ClientSnapshot[] = Array.from({ length: PACKET_BACKUP }, () =>
    createClientSnapshot()
  );

  /**
   * Every entity of the kept snapshots, in the order decoded: a state made as the ring first
   * reaches its slot and kept from then on, as Q3's is a fixed array, each written whole before it
   * is read.
   */
  private readonly parseEntities: (EntityState | null)[] = new Array<EntityState | null>(
    MAX_PARSE_ENTITIES
  ).fill(null);

  /** How many entity states have ever been decoded, which is the ring's write position. */
  private parseEntitiesNum = 0;

  /** The newest valid snapshot. */
  readonly snap: ClientSnapshot = createClientSnapshot();

  /**
   * `CL_ParseSnapshot`'s `newSnap`: what a message is parsed into, copied out only once it is
   * known to be decodable.
   */
  private readonly newSnap: ClientSnapshot = createClientSnapshot();

  /** Set when a snapshot arrives, and cleared by whoever acts on it. */
  newSnapshots = false;

  /** Set an entity's baseline, as the gamestate does. */
  setBaseline(number: number, state: EntityState): void {
    if (number < 0 || number >= MAX_GENTITIES) {
      throw new Error(`snapshot: bad baseline entity number ${number}`);
    }
    this.baselines[number] = copyEntityState(state, createEntityState(number));
  }

  /**
   * An entity's baseline, which is a zeroed state until a gamestate says otherwise: made once a
   * number, as `cl.entityBaselines` is a fixed array.
   */
  baseline(number: number): EntityState {
    return (this.baselines[number] ??= createEntityState(number));
  }

  /** The entities of a snapshot, in increasing entity number. */
  entities(snap: ClientSnapshot = this.snap): EntityState[] {
    const states: EntityState[] = [];
    for (let i = 0; i < snap.numEntities; i++) {
      states.push(this.entityAt(snap.parseEntitiesNum + i));
    }
    return states;
  }

  /**
   * `CL_GetSnapshot` (`cl_cgame.c:122–168`): a snapshot by the sequence number of the message that
   * carried it, or null for one that was lost, could not be decoded, or is too old to be kept.
   *
   * The snapshot is the ring's own, and its entities are too: the next 32 messages write over it.
   */
  get(number: number): ClientSnapshot | null {
    if (number > this.snap.messageNum) {
      throw new Error('CL_GetSnapshot: snapshotNumber > cl.snapshot.messageNum');
    }
    if (this.snap.messageNum - number >= PACKET_BACKUP) return null;
    const snap = this.snapshots[number & PACKET_MASK];
    if (!snap.valid) return null;
    if (this.parseEntitiesNum - snap.parseEntitiesNum >= MAX_PARSE_ENTITIES) return null;
    return snap;
  }

  /** Forget everything, as a disconnect or a new gamestate does. */
  clear(): void {
    this.baselines.fill(null);
    this.parseEntitiesNum = 0;
    for (const snapshot of this.snapshots) snapshot.valid = false;
    copyClientSnapshot(NO_SNAPSHOT, this.snap);
    this.newSnapshots = false;
  }

  /**
   * `CL_ParseSnapshot` (`cl_parse.c:203–320`): read one snapshot out of a message.
   *
   * The result goes into a snapshot of its own and only replaces the current one if it turns out to
   * be decodable, so a snapshot that cannot be resolved leaves the client exactly as it was.
   *
   * @param ping - The snapshot's ping, by how far its player state's commands have reached.
   */
  parseSnapshot(
    msg: Message,
    messageNum: number,
    serverCommandSequence: number,
    ping: (commandTime: number) => number = () => 999
  ): void {
    const newSnap = copyClientSnapshot(NO_SNAPSHOT, this.newSnap);
    newSnap.serverCommandNum = serverCommandSequence;
    newSnap.serverTime = msg.readLong();
    newSnap.messageNum = messageNum;

    const deltaNum = msg.readByte();
    newSnap.deltaNum = deltaNum === 0 ? -1 : newSnap.messageNum - deltaNum;
    newSnap.snapFlags = msg.readByte();

    let old: ClientSnapshot | null = null;
    if (newSnap.deltaNum <= 0) {
      newSnap.valid = true;
    } else {
      const candidate = this.snapshots[newSnap.deltaNum & PACKET_MASK];
      if (!candidate.valid) {
        // The frame it delta'd from never arrived.
      } else if (candidate.messageNum !== newSnap.deltaNum) {
        // That slot has been taken by a newer frame, so the one wanted is gone.
      } else if (
        this.parseEntitiesNum - candidate.parseEntitiesNum >
        MAX_PARSE_ENTITIES - MAX_SNAPSHOT_ENTITIES
      ) {
        // Its entities have rolled out of the ring.
      } else {
        old = candidate;
        newSnap.valid = true;
      }
    }

    const areabytes = msg.readByte();
    if (areabytes > newSnap.areamask.length) {
      throw new Error(`CL_ParseSnapshot: Invalid size ${areabytes} for areamask`);
    }
    msg.readData(areabytes, newSnap.areamask);

    readDeltaPlayerState(msg, old === null ? null : old.ps, newSnap.ps);

    this.parsePacketEntities(msg, old, newSnap);

    if (!newSnap.valid) return;

    // Any snapshot between the last one received and this one was dropped. Their slots are marked
    // invalid so that a later delta cannot resolve against whatever the ring still holds there.
    let oldMessageNum = this.snap.messageNum + 1;
    if (newSnap.messageNum - oldMessageNum >= PACKET_BACKUP) {
      oldMessageNum = newSnap.messageNum - (PACKET_BACKUP - 1);
    }
    for (; oldMessageNum < newSnap.messageNum; oldMessageNum++) {
      this.snapshots[oldMessageNum & PACKET_MASK].valid = false;
    }

    newSnap.ping = ping(newSnap.ps.commandTime);
    copyClientSnapshot(newSnap, this.snap);
    copyClientSnapshot(this.snap, this.snapshots[this.snap.messageNum & PACKET_MASK]);
    this.newSnapshots = true;
  }

  /**
   * `CL_ParsePacketEntities` (`cl_parse.c:86–190`): the entity half, undone.
   *
   * The writer's three cases come back as four, because the one thing it never writes is an entity
   * that did not change: the reader meets that as a gap in the numbers and copies the old state
   * forward. Every entity of the new snapshot is written into the ring, changed or not, because
   * the next snapshot may be delta'd from this one and will look for it there.
   */
  private parsePacketEntities(
    msg: Message,
    oldframe: ClientSnapshot | null,
    newframe: ClientSnapshot
  ): void {
    newframe.parseEntitiesNum = this.parseEntitiesNum;
    newframe.numEntities = 0;

    let oldIndex = 0;
    let oldState: EntityState | null = null;
    let oldNum = 99999;
    if (oldframe !== null && oldIndex < oldframe.numEntities) {
      oldState = this.entityAt(oldframe.parseEntitiesNum + oldIndex);
      oldNum = oldState.number;
    }

    const advanceOld = (): void => {
      oldIndex++;
      if (oldframe === null || oldIndex >= oldframe.numEntities) {
        oldNum = 99999;
        return;
      }
      oldState = this.entityAt(oldframe.parseEntitiesNum + oldIndex);
      oldNum = oldState.number;
    };

    for (;;) {
      const newNum = msg.readBits(GENTITYNUM_BITS);
      if (newNum === MAX_GENTITIES - 1) break;

      if (msg.readCount > msg.curSize) {
        throw new Error('snapshot: ran off the end of the message');
      }

      while (oldNum < newNum) {
        this.deltaEntity(msg, newframe, oldNum, oldState, true);
        advanceOld();
      }

      if (oldNum === newNum) {
        this.deltaEntity(msg, newframe, newNum, oldState, false);
        advanceOld();
        continue;
      }

      this.deltaEntity(msg, newframe, newNum, this.baseline(newNum), false);
    }

    while (oldNum !== 99999) {
      this.deltaEntity(msg, newframe, oldNum, oldState, true);
      advanceOld();
    }
  }

  /**
   * `CL_DeltaEntity` (`cl_parse.c:60–80`): one entity into the ring.
   *
   * An entity the writer removed decodes to the terminator number and is simply not counted, which
   * is how it leaves the snapshot without anything having to be deleted.
   */
  private deltaEntity(
    msg: Message,
    frame: ClientSnapshot,
    newNum: number,
    old: EntityState | null,
    unchanged: boolean
  ): void {
    const state = this.entityAt(this.parseEntitiesNum);

    if (unchanged) {
      if (old === null) throw new Error('snapshot: unchanged entity with no previous state');
      copyEntityState(old, state);
    } else {
      readDeltaEntity(msg, old ?? this.baseline(newNum), state, newNum);
    }

    if (state.number === MAX_GENTITIES - 1) return;

    this.parseEntitiesNum++;
    frame.numEntities++;
  }

  private entityAt(index: number): EntityState {
    const slot = index % MAX_PARSE_ENTITIES;
    return (this.parseEntities[slot] ??= createEntityState());
  }
}
