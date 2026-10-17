import { describe, expect, it } from 'vitest';

import { MAX_SNAPSHOT_ENTITIES, PACKET_BACKUP, SVC } from './commands';
import { Message } from './msg';
import { createEntityState, createPlayerState, type EntityState } from './protocol';
import {
  createServerSnapshot,
  SnapshotReceiver,
  writeSnapshot,
  type ServerSnapshot,
  type SnapshotEntityRing
} from './snapshot';

/** The host's ring, as a list that grows: a test never sends enough to wrap it. */
class Ring implements SnapshotEntityRing {
  private readonly states: EntityState[] = [];

  at(index: number): EntityState {
    while (this.states.length <= index) this.states.push(createEntityState());
    return this.states[index];
  }

  /** Put a run of entities in at the end, and give back the snapshot that points at them. */
  append(entities: readonly EntityState[]): ServerSnapshot {
    const frame = createServerSnapshot();
    frame.firstEntity = this.states.length;
    frame.numEntities = entities.length;
    for (const entity of entities) {
      const state = this.at(this.states.length);
      Object.assign(state, entity, { origin: { ...entity.origin } });
    }
    return frame;
  }
}

function entity(number: number, eType: number, x = 0): EntityState {
  const state = createEntityState(number);
  state.eType = eType;
  state.origin.x = x;
  return state;
}

/** Write a snapshot as the host would, and read it as the client would. */
function roundTrip(
  receiver: SnapshotReceiver,
  ring: Ring,
  frame: ServerSnapshot,
  oldFrame: ServerSnapshot | null,
  messageNum: number,
  lastFrame: number
): number {
  const msg = Message.write();
  writeSnapshot(msg, {
    serverTime: messageNum * 50,
    lastFrame,
    snapFlags: 0,
    frame,
    oldFrame,
    entities: ring,
    baseline: (number) => createEntityState(number)
  });

  const size = msg.written.length;
  const read = Message.read(msg.written);
  expect(read.readByte()).toBe(SVC.SNAPSHOT);
  receiver.parseSnapshot(read, messageNum, 0);
  return size;
}

describe('CL_GetSnapshot', () => {
  it('hands a snapshot back by the number of the message it came in', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();
    for (let n = 1; n <= 3; n++) {
      roundTrip(receiver, ring, ring.append([entity(5, 2, n)]), null, n, 0);
    }

    const snap = receiver.get(2)!;
    expect(snap.serverTime).toBe(100);
    expect(receiver.entities(snap).map((state) => state.origin.x)).toEqual([2]);
  });

  it('has none for a message that was lost, or one the ring has gone past', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();
    // 2 never came.
    roundTrip(receiver, ring, ring.append([]), null, 1, 0);
    roundTrip(receiver, ring, ring.append([]), null, 3, 0);
    expect(receiver.get(2)).toBeNull();

    for (let n = 4; n <= 3 + PACKET_BACKUP; n++) {
      roundTrip(receiver, ring, ring.append([]), null, n, 0);
    }
    expect(receiver.get(3)).toBeNull();
    expect(receiver.get(4)).not.toBeNull();
  });

  it('has none whose entities have been written over', () => {
    // A full snapshot's worth each, so the ring of entities comes round in 32.
    const ring = new Ring();
    const receiver = new SnapshotReceiver();
    const full = Array.from({ length: MAX_SNAPSHOT_ENTITIES }, (_, i) => entity(i, 2, i));
    for (let n = 1; n <= PACKET_BACKUP; n++) {
      roundTrip(receiver, ring, ring.append(full), null, n, 0);
    }
    expect(receiver.get(1)).toBeNull();
    expect(receiver.get(2)).not.toBeNull();
  });

  it('has no newest one once cleared, as a new gamestate starts over', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();
    roundTrip(receiver, ring, ring.append([entity(5, 2, 1)]), null, 1, 0);
    receiver.clear();
    expect(receiver.snap).toMatchObject({ valid: false, messageNum: 0, serverTime: 0 });
    expect(receiver.entities()).toEqual([]);
  });

  it('decodes into the same states after a clear, nothing of their last entity left', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();
    const placed = entity(5, 2, 100);
    placed.modelindex = 21;
    roundTrip(receiver, ring, ring.append([placed]), null, 1, 0);
    const [before] = receiver.entities();

    receiver.clear();
    roundTrip(receiver, ring, ring.append([entity(7, 1)]), null, 1, 0);
    const [after] = receiver.entities();
    expect(after).toBe(before);
    expect(after).toEqual(entity(7, 1));
  });

  it('refuses one it has not been sent yet', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();
    roundTrip(receiver, ring, ring.append([]), null, 1, 0);
    expect(() => receiver.get(2)).toThrow('snapshotNumber > cl.snapshot.messageNum');
  });
});

describe('a snapshot on the wire', () => {
  it('comes back with the player state it went out with', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();

    const frame = ring.append([]);
    frame.ps = createPlayerState();
    frame.ps.clientNum = 3;
    frame.ps.commandTime = 1234;
    frame.ps.origin.z = 512;
    frame.ps.velocity.x = -90;

    roundTrip(receiver, ring, frame, null, 1, 0);

    const snap = receiver.snap;
    expect(snap.valid).toBe(true);
    expect(snap.serverTime).toBe(50);
    expect(snap.ps.clientNum).toBe(3);
    expect(snap.ps.commandTime).toBe(1234);
    expect(snap.ps.origin.z).toBe(512);
    expect(snap.ps.velocity.x).toBe(-90);
  });

  it('comes back with the area bits it carried, and none past them that the last one had', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();

    const first = ring.append([]);
    first.areabytes = 3;
    first.areabits.set([1, 2, 3]);
    roundTrip(receiver, ring, first, null, 1, 0);
    expect([...receiver.snap.areamask.subarray(0, 4)]).toEqual([1, 2, 3, 0]);

    const second = ring.append([]);
    second.areabytes = 1;
    second.areabits.set([7]);
    roundTrip(receiver, ring, second, first, 2, 1);
    expect([...receiver.snap.areamask.subarray(0, 4)]).toEqual([7, 0, 0, 0]);
    expect([...receiver.get(1)!.areamask.subarray(0, 4)]).toEqual([1, 2, 3, 0]);
  });

  it("is dropped, in ioquake3's words, for more area bits than a snapshot holds", () => {
    const msg = Message.write();
    msg.writeLong(50);
    // No delta, no flags, and 33 bytes of areamask.
    msg.writeByte(0);
    msg.writeByte(0);
    msg.writeByte(33);
    const receiver = new SnapshotReceiver();
    expect(() => receiver.parseSnapshot(Message.read(msg.written), 1, 0)).toThrow(
      'CL_ParseSnapshot: Invalid size 33 for areamask'
    );
  });

  it('comes back with its entities, in the order they were written', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();

    const frame = ring.append([entity(5, 2, 100), entity(9, 3, 200), entity(12, 1, 300)]);
    roundTrip(receiver, ring, frame, null, 1, 0);

    expect(receiver.entities().map((state) => [state.number, state.origin.x])).toEqual([
      [5, 100],
      [9, 200],
      [12, 300]
    ]);
  });

  it('carries an unchanged entity forward without spending bytes on it', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();

    const first = ring.append([entity(5, 2, 100), entity(9, 3, 200)]);
    const firstSize = roundTrip(receiver, ring, first, null, 1, 0);

    const second = ring.append([entity(5, 2, 100), entity(9, 3, 200)]);
    const secondSize = roundTrip(receiver, ring, second, first, 2, 1);

    expect(secondSize).toBeLessThan(firstSize);
    expect(receiver.entities().map((state) => state.number)).toEqual([5, 9]);
    expect(receiver.entities()[0].origin.x).toBe(100);
  });

  it('carries only what changed about an entity that did', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();

    const first = ring.append([entity(5, 2, 100)]);
    roundTrip(receiver, ring, first, null, 1, 0);

    const second = ring.append([entity(5, 2, 164)]);
    roundTrip(receiver, ring, second, first, 2, 1);

    expect(receiver.entities()[0].origin.x).toBe(164);
    expect(receiver.entities()[0].eType).toBe(2);
  });

  it('takes an entity away when it is not in the next snapshot', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();

    const first = ring.append([entity(5, 2), entity(9, 3)]);
    roundTrip(receiver, ring, first, null, 1, 0);

    const second = ring.append([entity(9, 3)]);
    roundTrip(receiver, ring, second, first, 2, 1);

    expect(receiver.entities().map((state) => state.number)).toEqual([9]);
  });

  it('adds an entity that was not there before, against its baseline', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();

    const first = ring.append([entity(9, 3)]);
    roundTrip(receiver, ring, first, null, 1, 0);

    const second = ring.append([entity(5, 2, 42), entity(9, 3)]);
    roundTrip(receiver, ring, second, first, 2, 1);

    expect(receiver.entities().map((state) => state.number)).toEqual([5, 9]);
    expect(receiver.entities()[0].origin.x).toBe(42);
  });

  it('reads each sighting of an entity with no baseline against a zeroed one, made once', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();
    const baseline = receiver.baseline(5);
    expect(baseline).toEqual(createEntityState(5));

    // In, out and in again, each time from nothing.
    const first = ring.append([entity(5, 2, 42)]);
    roundTrip(receiver, ring, first, null, 1, 0);
    const gone = ring.append([]);
    roundTrip(receiver, ring, gone, first, 2, 1);
    const back = ring.append([entity(5, 3)]);
    roundTrip(receiver, ring, back, gone, 3, 1);

    const read = receiver.entities().map(({ number, eType, origin }) => [number, eType, origin.x]);
    expect(read).toEqual([[5, 3, 0]]);
    expect(receiver.baseline(5)).toBe(baseline);
    expect(baseline).toEqual(createEntityState(5));
  });

  it('decodes a first sighting against the baseline the gamestate gave it', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();

    const placed = entity(7, 2, 640);
    placed.modelindex = 21;
    receiver.setBaseline(7, placed);

    // The host writes the same entity against the same baseline, so nothing at all changed.
    const frame = ring.append([placed]);
    const msg = Message.write();
    writeSnapshot(msg, {
      serverTime: 50,
      lastFrame: 0,
      snapFlags: 0,
      frame,
      oldFrame: null,
      entities: ring,
      baseline: () => placed
    });

    const read = Message.read(msg.written);
    read.readByte();
    receiver.parseSnapshot(read, 1, 0);

    expect(receiver.entities()[0].modelindex).toBe(21);
    expect(receiver.entities()[0].origin.x).toBe(640);
  });

  it('reads a snapshot delta’d from a frame it never received, and keeps the old one', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();

    const first = ring.append([entity(5, 2, 100)]);
    roundTrip(receiver, ring, first, null, 1, 0);
    const good = receiver.snap.serverTime;

    // Message 2 is lost, and message 3 says it was delta'd from it.
    const second = ring.append([entity(5, 2, 200)]);
    const third = ring.append([entity(5, 2, 300)]);
    roundTrip(receiver, ring, third, second, 3, 1);

    expect(receiver.snap.serverTime).toBe(good);
    expect(receiver.entities()[0].origin.x).toBe(100);
  });

  it('makes a full snapshot readable whatever came before it', () => {
    const ring = new Ring();
    const receiver = new SnapshotReceiver();

    const first = ring.append([entity(5, 2, 100)]);
    roundTrip(receiver, ring, first, null, 1, 0);

    const lost = ring.append([entity(5, 2, 200)]);
    roundTrip(receiver, ring, ring.append([entity(5, 2, 300)]), lost, 3, 1);
    expect(receiver.entities()[0].origin.x).toBe(100);

    // The client asks for one delta'd from nothing, and is back in step.
    const full = ring.append([entity(5, 2, 300), entity(8, 1)]);
    roundTrip(receiver, ring, full, null, 4, 0);

    expect(receiver.snap.valid).toBe(true);
    expect(receiver.entities().map((state) => state.number)).toEqual([5, 8]);
    expect(receiver.entities()[0].origin.x).toBe(300);
  });
});
