import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { Net, type NetPacket } from './net';
import { testCvars } from './net-test-fixtures';
import { Netchan } from './netchan';
import type { PeerConnectionFactory } from './peer-signalling';
import type { PeerSocket } from './peer-socket';
import { FakeMaster, fakePeer, settle } from './peer-test-fixtures';

/**
 * The peer socket over real peer connections: node-datachannel's, as the dedicated server and the
 * master run it, with the master still the fake. Skipped where its native addon cannot load.
 */

const native = await import('node-datachannel').catch(() => null);
const polyfill = await import('node-datachannel/polyfill').catch(() => null);

/** Text behind the out-of-band marker. */
function oob(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(`\xff\xff\xff\xff${text}`, (c) => c.charCodeAt(0));
}

/** Turn the fakes and wait on the native side until `done` holds, for ten seconds at most. */
async function until(done: () => boolean): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > 10000) throw new Error('timed out');
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The next datagram to reach a socket: who sent it, and what, whenever it landed. */
async function next(socket: PeerSocket): Promise<NetPacket> {
  const packets: NetPacket[] = [];
  await until(() => {
    const packet = socket.receive();
    if (packet !== null) packets.push({ from: packet.from, data: packet.data });
    return packets.length > 0;
  });
  return packets[0];
}

/** A test's time where it waits: a few of until()'s can take a loaded machine past five seconds. */
const WAITING = { timeout: 30_000 };

describe.skipIf(polyfill === null)('a peer socket over node-datachannel', WAITING, () => {
  /** Every channel made, as the library reports its settings. */
  const channels: { ordered: boolean; maxRetransmits: number | null; negotiated: boolean }[] = [];
  /** Each connection's signalling state once its channel was made. */
  const states: string[] = [];
  const closers: (() => void)[] = [];

  // Loopback candidates, so the test needs no network interface but the loopback.
  const create: PeerConnectionFactory = (iceServers) => {
    const configuration = { iceServers, bindAddress: '127.0.0.1' };
    const pc = new polyfill!.RTCPeerConnection(configuration);
    const make = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (label, init) => {
      const channel = make(label, init);
      channels.push(channel);
      states.push(pc.signalingState);
      return channel;
    };
    return pc;
  };

  async function pair() {
    const master = new FakeMaster();
    const server = fakePeer(master, create, '203.0.113.9', { dials: false });
    server.link.register(27960);
    const client = fakePeer(master, create, '198.51.100.4', { dials: true });
    closers.push(() => client.signalling.close(), () => server.signalling.close());
    await until(() => server.link.address?.port === 27960 && client.link.address !== null);
    return { server, client, serverAdr: server.link.address!, clientAdr: client.link.address! };
  }

  afterEach(() => {
    for (const close of closers.splice(0)) close();
    channels.length = 0;
    states.length = 0;
  });
  afterAll(() => native?.cleanup());

  it('dials for a datagram, and carries datagrams both ways whole', async () => {
    const { server, client, serverAdr, clientAdr } = await pair();

    client.socket.send(oob('getchallenge 5'), serverAdr);
    expect(await next(server.socket)).toEqual({ from: clientAdr, data: oob('getchallenge 5') });

    const full = Uint8Array.from({ length: 1114 }, (_, i) => (i * 13) & 0xff);
    server.socket.send(full, clientAdr);
    expect(await next(client.socket)).toEqual({ from: serverAdr, data: full });

    expect(channels.map(({ ordered, maxRetransmits, negotiated }) => ({
      ordered,
      maxRetransmits,
      negotiated
    }))).toEqual([
      { ordered: false, maxRetransmits: 0, negotiated: true },
      { ordered: false, maxRetransmits: 0, negotiated: true }
    ]);
    // The library offers when a channel is made on a connection with no remote description: the
    // dialling end meant to, and the answering end, which had the offer by then, did not.
    expect(states).toEqual(['have-local-offer', 'stable']);
  });

  it('carries a netchan message too long for one datagram, in fragments', async () => {
    const { server, client, serverAdr, clientAdr } = await pair();
    const sender = new Netchan(new Net({ cvars: testCvars(), socket: client.socket }));
    sender.setup('client', serverAdr, 7, 99);
    const receiver = new Netchan(new Net({ cvars: testCvars(), socket: server.socket }));
    receiver.setup('server', clientAdr, 7, 99);

    const message = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff);
    sender.transmit(message);
    while (sender.unsentFragments) sender.transmitNextFragment();

    let whole = null;
    while (whole === null) whole = receiver.process((await next(server.socket)).data);
    expect(whole).toEqual({ sequence: 1, data: message });
  });
});
