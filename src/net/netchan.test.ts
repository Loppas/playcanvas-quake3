import { describe, expect, it } from 'vitest';

import { MAX_MSGLEN } from './msg';
import { NA, Net, netadr, stringToAdr } from './net';
import { MemoryNetwork, testCvars } from './net-test-fixtures';
import { FRAGMENT_SIZE, Netchan, netchanChecksum, type NetchanMessage } from './netchan';

const QPORT = 0x1234;
const CHALLENGE = 0x5eed;

/** A client's channel and a server's, over one process's loopback. */
function loopbackPair(values: Record<string, string> = {}) {
  const lines: string[] = [];
  const net = new Net({ cvars: testCvars(values), print: (l) => lines.push(l) });
  const client = new Netchan(net);
  client.setup('client', netadr(NA.LOOPBACK), QPORT, CHALLENGE);
  const server = new Netchan(net);
  server.setup('server', netadr(NA.LOOPBACK), QPORT, CHALLENGE);

  /** Every packet waiting for one side, as it arrived. */
  const packets = (sock: 'client' | 'server') => {
    const out: Uint8Array[] = [];
    for (let p; (p = net.getLoopPacket(sock)) !== null; ) out.push(p.data);
    return out;
  };
  /** What a side's channel makes of everything waiting for it. */
  const deliver = (sock: 'client' | 'server') =>
    packets(sock).map((data) => (sock === 'server' ? server : client).process(data));

  return { net, client, server, lines, packets, deliver };
}

function bytes(length: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + seed) & 0xff);
}

/** `CL_Netchan_Transmit`'s way: every fragment at once. */
function transmitAll(chan: Netchan, data: Uint8Array): void {
  chan.transmit(data);
  while (chan.unsentFragments) chan.transmitNextFragment();
}

function header(packet: Uint8Array) {
  return new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
}

describe('a netchan packet', () => {
  it("carries the client's sequence, qport and checksum in front of the message", () => {
    const { client, packets } = loopbackPair();
    client.transmit(Uint8Array.of(0xaa, 0xbb));

    const [packet] = packets('server');
    const view = header(packet);
    expect(packet.length).toBe(4 + 2 + 4 + 2);
    expect(view.getInt32(0, true)).toBe(1);
    expect(view.getUint16(4, true)).toBe(QPORT);
    expect(view.getInt32(6, true)).toBe(netchanChecksum(CHALLENGE, 1));
    expect(packet.subarray(10)).toEqual(Uint8Array.of(0xaa, 0xbb));
  });

  it("carries no qport on the server's", () => {
    const { server, packets } = loopbackPair();
    server.transmit(Uint8Array.of(0xaa));

    const [packet] = packets('client');
    expect(packet.length).toBe(4 + 4 + 1);
    expect(header(packet).getInt32(4, true)).toBe(netchanChecksum(CHALLENGE, 1));
  });

  it('numbers the messages from 1, one each, and says which it last had', () => {
    const { client, server, deliver } = loopbackPair();
    for (let i = 0; i < 3; i++) client.transmit(Uint8Array.of(i));

    const taken = deliver('server');
    expect(taken.map((m) => m?.sequence)).toEqual([1, 2, 3]);
    expect(taken.map((m) => m?.data)).toEqual([0, 1, 2].map((i) => Uint8Array.of(i)));
    expect(client.outgoingSequence).toBe(4);
    expect(server.incomingSequence).toBe(3);
  });

  it('still goes out when the message is empty', () => {
    const { client, deliver } = loopbackPair();
    client.transmit(new Uint8Array(0));

    expect(deliver('server')).toEqual([{ sequence: 1, data: new Uint8Array(0) }]);
  });

  it('writes every packet, whole or fragment, into one datagram buffer', () => {
    const sent: Uint8Array[] = [];
    const net = new Net({
      cvars: testCvars(),
      socket: { send: (data) => sent.push(data), receive: () => null }
    });
    const client = new Netchan(net);
    client.setup('client', stringToAdr('10.0.0.1')!, QPORT, CHALLENGE);

    client.transmit(Uint8Array.of(1, 2, 3));
    client.transmit(bytes(64, 3));
    transmitAll(client, bytes(FRAGMENT_SIZE + 40));

    // Every datagram is a view onto the channel's one buffer, and each starts at its front.
    for (const packet of sent) expect(packet.buffer).toBe(sent[0].buffer);
    expect(sent.map((packet) => packet.length)).toEqual([10 + 3, 10 + 64, 10 + 4 + 1100, 10 + 4 + 40]);
  });

  it('is thrown away when its checksum is against another challenge', () => {
    const { client, server, packets } = loopbackPair();
    client.transmit(Uint8Array.of(1));
    client.transmit(Uint8Array.of(2));
    const [, second] = packets('server');
    server.challenge = CHALLENGE + 1;

    // Not the first: sequence 1's checksum is a challenge XOR itself, which is 0 for any challenge.
    expect(server.process(second)).toBeNull();
    expect(server.incomingSequence).toBe(0);
  });

  it('refuses a message longer than any message may be', () => {
    const { client } = loopbackPair();
    expect(() => client.transmit(new Uint8Array(MAX_MSGLEN + 1))).toThrow(/length/);
  });
});

describe('packets out of order', () => {
  /** A channel pair across a network in memory, where the order can be chosen. */
  function networkPair() {
    const network = new MemoryNetwork();
    const lines: string[] = [];
    const clientNet = new Net({ cvars: testCvars(), socket: network.socket('10.0.0.2') });
    const serverNet = new Net({
      cvars: testCvars({ showdrop: '1' }),
      socket: network.socket('10.0.0.1'),
      print: (l) => lines.push(l)
    });
    const client = new Netchan(clientNet);
    client.setup('client', stringToAdr('10.0.0.1')!, QPORT, CHALLENGE);
    const server = new Netchan(serverNet);
    server.setup('server', stringToAdr('10.0.0.2')!, QPORT, CHALLENGE);
    return { network, client, server, lines };
  }

  it('are taken newest first and the older one thrown away', () => {
    const { network, client, server, lines } = networkPair();
    client.transmit(Uint8Array.of(1));
    client.transmit(Uint8Array.of(2));
    const [first, second] = network.sent.map((s) => s.packet.data);

    expect(server.process(second)?.sequence).toBe(2);
    expect(server.process(first)).toBeNull();
    expect(lines).toEqual([
      '10.0.0.2:Dropped 1 packets at 2',
      '10.0.0.2:Out of order packet 1 at 2'
    ]);
  });

  it('are thrown away when they repeat one already taken', () => {
    const { network, client, server } = networkPair();
    client.transmit(Uint8Array.of(1));
    const [packet] = network.sent.map((s) => s.packet.data);

    expect(server.process(packet)).not.toBeNull();
    expect(server.process(packet)).toBeNull();
  });

  it('count the ones that never came, and still give up the one that did', () => {
    const { network, client, server, lines } = networkPair();
    for (let i = 0; i < 4; i++) client.transmit(Uint8Array.of(i));
    const sent = network.sent.map((s) => s.packet.data);

    server.process(sent[0]);
    const taken = server.process(sent[3]);

    expect(taken?.data).toEqual(Uint8Array.of(3));
    expect(server.dropped).toBe(2);
    expect(lines).toEqual(['10.0.0.2:Dropped 2 packets at 4']);
  });
});

describe('a message too long for one packet', () => {
  it('goes as fragments of FRAGMENT_SIZE and the rest, and arrives whole', () => {
    const { client, packets, server } = loopbackPair();
    const message = bytes(FRAGMENT_SIZE * 2 + 400);
    transmitAll(client, message);

    const sent = packets('server');
    expect(sent.map((p) => p.length)).toEqual([1114, 1114, 414]);
    // Every fragment is the same sequence with the top bit set.
    for (const packet of sent) expect(header(packet).getUint32(0, true)).toBe(0x80000001);

    const taken = sent.map((p) => server.process(p));
    expect(taken.slice(0, 2)).toEqual([null, null]);
    expect(taken[2]).toEqual({ sequence: 1, data: message });
    expect(client.outgoingSequence).toBe(2);
    expect(client.unsentFragments).toBe(false);
  });

  it('is closed by an empty fragment when it fills its last one exactly', () => {
    const { client, packets, server } = loopbackPair();
    const message = bytes(FRAGMENT_SIZE);
    transmitAll(client, message);

    const sent = packets('server');
    expect(sent.map((p) => p.length)).toEqual([14 + FRAGMENT_SIZE, 14]);
    expect(sent.map((p) => server.process(p))).toEqual([null, { sequence: 1, data: message }]);
  });

  it('is sent one fragment a call, with the rest left until asked for', () => {
    const lines: string[] = [];
    const net = new Net({ cvars: testCvars({ showpackets: '1' }), print: (l) => lines.push(l) });
    const server = new Netchan(net);
    server.setup('server', netadr(NA.LOOPBACK), 0, 0);

    server.transmit(bytes(FRAGMENT_SIZE + 10));
    expect(server.unsentFragments).toBe(true);
    server.transmitNextFragment();
    expect(server.unsentFragments).toBe(false);

    expect(lines).toEqual([
      'server send 1112 : s=1 fragment=0,1100',
      'server send   22 : s=1 fragment=1100,10'
    ]);
  });

  it('is lost with any of its fragments, and the next message is not', () => {
    const { client, packets, server, lines } = loopbackPair({ showdrop: '1' });
    transmitAll(client, bytes(FRAGMENT_SIZE * 2 + 1));
    const [first, , third] = packets('server');

    expect(server.process(first)).toBeNull();
    expect(server.process(third)).toBeNull();
    expect(lines).toEqual(['loopback:Dropped a message fragment']);

    client.transmit(Uint8Array.of(5));
    const [next] = packets('server');
    expect(server.process(next)).toEqual({ sequence: 2, data: Uint8Array.of(5) });
    expect(server.dropped).toBe(1);
  });

  it('keeps what it has when a fragment arrives twice', () => {
    const { client, packets, server } = loopbackPair();
    const message = bytes(FRAGMENT_SIZE + 3, 9);
    transmitAll(client, message);
    const [first, last] = packets('server');

    server.process(first);
    server.process(first);
    expect(server.process(last)).toEqual<NetchanMessage>({ sequence: 1, data: message });
  });
});

describe('showpackets', () => {
  it('shows every sequenced packet sent and taken in', () => {
    const { client, deliver, lines } = loopbackPair({ showpackets: '1' });
    client.transmit(Uint8Array.of(1, 2, 3));
    deliver('server');

    expect(lines).toEqual(['client send   13 : s=1 ack=0', 'server recv   13 : s=1']);
  });
});
