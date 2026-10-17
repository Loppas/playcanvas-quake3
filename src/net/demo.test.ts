import { describe, expect, it } from 'vitest';

import { SVC } from './commands';
import { readDemo } from './demo';
import { writeDeltaEntity } from './delta';
import { MAX_MSGLEN, Message } from './msg';
import { createEntityState, type EntityState } from './protocol';
import { createServerSnapshot, writeSnapshot, type ServerSnapshot } from './snapshot';

/**
 * A demo is the server's messages as a client received them, so these are written by the port's
 * own server-side writers and framed as `CL_WriteDemoMessage` frames them.
 */

/** A server message: the reliable acknowledge, the commands, and `svc_EOF`. */
function message(write: (msg: Message) => void): Uint8Array {
  const msg = Message.write();
  msg.writeLong(0);
  write(msg);
  msg.writeByte(SVC.EOF);
  return msg.written.slice();
}

/** The file: each message after its sequence and length, then the end `CL_StopRecord_f` writes. */
function demoFile(messages: readonly [sequence: number, bytes: Uint8Array][], end = true) {
  const parts: number[] = [];
  const long = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value, true);
    parts.push(...bytes);
  };
  for (const [sequence, bytes] of messages) {
    long(sequence);
    long(bytes.length);
    parts.push(...bytes);
  }
  if (end) {
    long(-1);
    long(-1);
  }
  return Uint8Array.from(parts);
}

/** A rocket's state, numbered. */
function rocket(number: number, x: number): EntityState {
  const state = createEntityState(number);
  state.eType = 3;
  state.origin.x = x;
  return state;
}

/** The gamestate `CL_Record_f` writes: a configstring, a baseline, and the slot. */
const gamestate = message((msg) => {
  msg.writeByte(SVC.GAMESTATE);
  msg.writeLong(3);
  msg.writeByte(SVC.CONFIGSTRING);
  msg.writeShort(0);
  msg.writeBigString('\\mapname\\q3dm1');
  msg.writeByte(SVC.BASELINE);
  writeDeltaEntity(msg, createEntityState(), rocket(5, 64), true);
  msg.writeByte(SVC.EOF);
  msg.writeLong(2);
  msg.writeLong(0);
});

/** A frame of the server's: the player at `x`, and one entity, the ring's `firstEntity`th. */
function frame(x: number, firstEntity: number): ServerSnapshot {
  const snapshot = createServerSnapshot();
  snapshot.ps.commandTime = x * 8;
  snapshot.ps.origin.x = x;
  snapshot.firstEntity = firstEntity;
  snapshot.numEntities = 1;
  return snapshot;
}

/**
 * Two snapshots, the second delta'd from the first, as the server sends a client them.
 *
 * @param masks - The bytes of each one's areamask the server sends.
 */
function snapshots(masks: readonly (readonly number[])[] = [[], []]) {
  const ring: EntityState[] = [rocket(5, 80), rocket(5, 96)];
  const entities = { at: (index: number) => ring[index] };
  const first = frame(1, 0);
  const second = frame(2.5, 1);
  [first, second].forEach((snapshot, i) => {
    snapshot.areabits.fill(255);
    snapshot.areabits.set(masks[i]);
    snapshot.areabytes = masks[i].length;
  });
  const write = (snapshot: ServerSnapshot, old: ServerSnapshot | null, serverTime: number) =>
    message((msg) =>
      writeSnapshot(msg, {
        serverTime,
        lastFrame: old === null ? 0 : 1,
        snapFlags: 0,
        frame: snapshot,
        oldFrame: old,
        entities,
        baseline: () => rocket(5, 64)
      })
    );
  return [write(first, null, 1000), write(second, first, 1008)];
}

describe('readDemo', () => {
  it("reads the slot, the configstrings, and each snapshot's player and entities", () => {
    const [first, second] = snapshots();
    const demo = readDemo(demoFile([[10, gamestate], [11, first], [12, second]]));

    expect(demo.clientNum).toBe(2);
    expect(demo.configstrings[0]).toBe('\\mapname\\q3dm1');
    expect(demo.snapshots.map((s) => [s.serverTime, s.messageNum])).toEqual([
      [1000, 11],
      [1008, 12]
    ]);
    // The second only says what changed since the first, so reading it took the first.
    expect(demo.snapshots.map((s) => [s.ps.commandTime, s.ps.origin.x])).toEqual([
      [8, 1],
      [20, 2.5]
    ]);
    expect(demo.snapshots.map((s) => s.entities.map((e) => [e.number, e.origin.x]))).toEqual([
      [[5, 80]],
      [[5, 96]]
    ]);
  });

  it("keeps each snapshot's areamask whole, clear past the bytes it was sent", () => {
    const [first, second] = snapshots([[0xfe, 0x03], [0xfc]]);
    const demo = readDemo(demoFile([[10, gamestate], [11, first], [12, second]]));

    expect(demo.snapshots.map((s) => s.areamask.length)).toEqual([32, 32]);
    expect(demo.snapshots.map((s) => Array.from(s.areamask.subarray(0, 3)))).toEqual([
      [0xfe, 0x03, 0],
      [0xfc, 0, 0]
    ]);
  });

  it('keeps each server command once, though the server sends it until it is acknowledged', () => {
    const command = (sequence: number, text: string) =>
      message((msg) => {
        msg.writeByte(SVC.SERVER_COMMAND);
        msg.writeLong(sequence);
        msg.writeBigString(text);
      });
    const demo = readDemo(
      demoFile([
        [10, gamestate],
        [11, command(4, 'print "one"')],
        [12, command(4, 'print "one"')],
        [13, command(5, 'print "two"')]
      ])
    );

    expect(demo.serverCommands).toEqual(['print "one"', 'print "two"']);
  });

  it('leaves out a snapshot it cannot decode, as one delta from a message it never had', () => {
    const [, second] = snapshots();
    const demo = readDemo(demoFile([[10, gamestate], [12, second]]));

    expect(demo.snapshots).toEqual([]);
  });

  it('ends at a length of -1, and at a message the file stops short of', () => {
    const [first, second] = snapshots();
    const ended = demoFile([[10, gamestate], [11, first]]);
    const after = demoFile([[12, second]], false);
    expect(readDemo(Uint8Array.from([...ended, ...after])).snapshots).toHaveLength(1);

    const whole = demoFile([[10, gamestate], [11, first], [12, second]], false);
    expect(readDemo(whole.subarray(0, whole.length - 1)).snapshots).toHaveLength(1);
  });

  it("refuses a message longer than Quake 3's, in its words", () => {
    const file = demoFile([[10, gamestate]], false);
    new DataView(file.buffer).setInt32(4, MAX_MSGLEN + 1, true);

    expect(() => readDemo(file)).toThrow('CL_ReadDemoMessage: demoMsglen > MAX_MSGLEN');
  });

  it('refuses a command the port does not read, as nothing after it could be', () => {
    // `svc_voipOpus`, which ioquake3 sends a client that speaks.
    const voip = message((msg) => msg.writeByte(10));

    expect(() => readDemo(demoFile([[10, gamestate], [11, voip]]))).toThrow(
      'demo: server command byte 10, which the port does not read'
    );
  });

  it('starts again at a new gamestate, as a map change sends one', () => {
    const [first] = snapshots();
    const next = message((msg) => {
      msg.writeByte(SVC.GAMESTATE);
      msg.writeLong(0);
      msg.writeByte(SVC.EOF);
      msg.writeLong(0);
      msg.writeLong(0);
    });
    const demo = readDemo(demoFile([[10, gamestate], [11, first], [12, next]]));

    expect(demo.clientNum).toBe(0);
    expect(demo.configstrings).toEqual([]);
    expect(demo.snapshots).toHaveLength(1);
  });
});
