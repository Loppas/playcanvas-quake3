import { beforeEach, describe, expect, it } from 'vitest';

import { MasterLink } from './master-link';
import type { MasterFrame } from './master-protocol';
import { NA, netadr } from './net';
import { FakeMaster, settle } from './peer-test-fixtures';

/** A datagram, numbered. */
function datagram(n: number): MasterFrame {
  return { kind: 'datagram', data: Uint8Array.of(0xff, 0xff, 0xff, 0xff, n) };
}

describe('a link to a master', () => {
  let master: FakeMaster;

  beforeEach(() => {
    master = new FakeMaster();
    master.iceServers = [{ urls: 'stun:stun.test:3478' }];
  });

  it('keeps what the master says of the socket: the greeting, then the registration', async () => {
    const link = new MasterLink(master.adr, master.connect('203.0.113.9'));
    expect(link.address).toBeNull();

    await settle();
    expect(link.address).toEqual(netadr(NA.IP, '203.0.113.9', 50000));
    expect(link.iceServers).toEqual([{ urls: 'stun:stun.test:3478' }]);

    link.register(27960);
    await settle();
    expect(link.address).toEqual(netadr(NA.IP, '203.0.113.9', 27960));
  });

  it('tells its owner the address a registration is granted, not the greeting', async () => {
    const link = new MasterLink(master.adr, master.connect('203.0.113.9'));
    const granted: unknown[] = [];
    link.onRegistered = (address) => granted.push(address);
    await settle();
    expect(granted).toEqual([]);

    link.register(27960);
    await settle();
    expect(granted).toEqual([netadr(NA.IP, '203.0.113.9', 27960)]);
  });

  it('tells its owner the answer to a name, and hands it to nothing else', async () => {
    const link = new MasterLink(master.adr, master.connect('198.51.100.4'));
    const answers: unknown[] = [];
    const frames: MasterFrame[] = [];
    link.onResolved = (answer) => answers.push(answer);
    link.onFrame = (frame) => frames.push(frame);
    master.names.set('quake.test', ['203.0.113.9']);

    link.send({ kind: 'resolve', name: 'quake.test', port: 27960 });
    await settle();
    expect(answers).toEqual([
      {
        kind: 'resolveResponse',
        name: 'quake.test',
        port: 27960,
        addresses: [netadr(NA.IP, '203.0.113.9', 27960)],
        error: null
      }
    ]);
    expect(frames).toEqual([]);
  });

  it('holds what is sent while it connects, and sends it in order once open', async () => {
    const link = new MasterLink(master.adr, master.connect('203.0.113.9'));
    link.register(27960);
    link.send(datagram(1));
    await settle();

    expect(master.frames.map(({ frame }) => frame.kind)).toEqual(['register', 'datagram']);
    expect(master.datagrams).toEqual([
      { from: netadr(NA.IP, '203.0.113.9', 27960), data: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 1) }
    ]);
  });

  it('holds no more than the loopback’s sixteen while it connects, losing the oldest', async () => {
    const link = new MasterLink(master.adr, master.connect('203.0.113.9'));
    for (let n = 0; n < 17; n++) link.send(datagram(n));
    await settle();
    expect(master.datagrams.map(({ data }) => data[4])).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1)
    );
  });

  it('holds a copy of a datagram, since its sender goes on using the buffer', async () => {
    const link = new MasterLink(master.adr, master.connect('203.0.113.9'));
    const data = Uint8Array.of(0xff, 0xff, 0xff, 0xff, 1);
    link.send({ kind: 'datagram', data });
    data[4] = 2;
    await settle();
    expect(master.datagrams.map(({ data: held }) => held[4])).toEqual([1]);
  });

  it('hands on every frame that is not about the socket itself', async () => {
    const link = new MasterLink(master.adr, master.connect('203.0.113.9'));
    const frames: MasterFrame[] = [];
    link.onFrame = (frame) => frames.push(frame);
    await settle();

    master.sendDatagram(link.address!, Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x41));
    await settle();
    expect(frames).toEqual([
      { kind: 'datagram', data: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x41) }
    ]);
  });

  it('loses what is sent once it has closed, and forgets its address', async () => {
    const link = new MasterLink(master.adr, master.connect('203.0.113.9'));
    await settle();
    link.close();
    link.send(datagram(1));
    await settle();

    expect(link.address).toBeNull();
    expect(master.datagrams).toEqual([]);
  });
});
