import { beforeEach, describe, expect, it } from 'vitest';

import { MasterLink, type WebSocketLike } from './master-link';
import { compareAdr, NA, Net, netadr, type NetPacket } from './net';
import { testCvars } from './net-test-fixtures';
import { Netchan } from './netchan';
import {
  ANSWER_MSEC,
  CHANNEL_INIT,
  createPeerSocket,
  type PeerConnectionFactory
} from './peer-signalling';
import type { DataChannelLike, PeerSocket } from './peer-socket';
import { FakeDataChannel, FakeMaster, FakeRtc, fakePeer, settle } from './peer-test-fixtures';

/** Text behind the out-of-band marker. */
function oob(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(`\xff\xff\xff\xff${text}`, (c) => c.charCodeAt(0));
}

/** Everything waiting at a socket: who sent each datagram, and what, whenever it landed. */
function read(socket: PeerSocket): NetPacket[] {
  const packets: NetPacket[] = [];
  for (let p; (p = socket.receive()) !== null; ) packets.push({ from: p.from, data: p.data });
  return packets;
}

describe('peer signalling', () => {
  let master: FakeMaster;
  let rtc: FakeRtc;
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    master = new FakeMaster();
    rtc = new FakeRtc();
    now = 0;
  });

  /** A server that has registered 27960, and a client, both greeted by the master. */
  async function pair() {
    const server = fakePeer(master, rtc.create, '203.0.113.9', { dials: false, now: clock });
    server.link.register(27960);
    const client = fakePeer(master, rtc.create, '198.51.100.4', { dials: true, now: clock });
    await settle();
    return { server, client, serverAdr: server.link.address!, clientAdr: client.link.address! };
  }

  it('dials a peer for a datagram, and then both ends talk over the channel', async () => {
    const { server, client, serverAdr, clientAdr } = await pair();
    expect(serverAdr).toEqual(netadr(NA.IP, '203.0.113.9', 27960));

    client.socket.send(oob('getchallenge 5'), serverAdr);
    await settle();
    expect(read(server.socket)).toEqual([{ from: clientAdr, data: oob('getchallenge 5') }]);

    server.socket.send(oob('challengeResponse 1 5 1'), clientAdr);
    await settle();
    expect(read(client.socket)).toEqual([
      { from: serverAdr, data: oob('challengeResponse 1 5 1') }
    ]);

    expect(rtc.connections.map((pc) => pc.connectionState)).toEqual(['connected', 'connected']);
    expect(rtc.connections.map((pc) => pc.channels.map((c) => c.init))).toEqual([
      [{ negotiated: true, id: 0, ordered: false, maxRetransmits: 0 }],
      [{ negotiated: true, id: 0, ordered: false, maxRetransmits: 0 }]
    ]);
    expect(master.read('relay')).toEqual([]);
  });

  it('carries a query and its answer through the master while no channel is open', async () => {
    const { server, client, serverAdr, clientAdr } = await pair();

    client.socket.send(oob('getinfo xyz'), serverAdr);
    client.socket.send(oob('GETSTATUS xyz'), serverAdr);
    await settle();
    expect(read(server.socket)).toEqual([
      { from: clientAdr, data: oob('getinfo xyz') },
      { from: clientAdr, data: oob('GETSTATUS xyz') }
    ]);

    server.socket.send(oob('infoResponse\n\\challenge\\xyz'), clientAdr);
    server.socket.send(oob('statusResponse\n\\challenge\\xyz\n'), clientAdr);
    await settle();
    expect(read(client.socket)).toEqual([
      { from: serverAdr, data: oob('infoResponse\n\\challenge\\xyz') },
      { from: serverAdr, data: oob('statusResponse\n\\challenge\\xyz\n') }
    ]);

    expect(rtc.connections).toEqual([]);
    expect(master.read('relay')).toHaveLength(4);
  });

  it('sends a query down the channel once one is open', async () => {
    const { server, client, serverAdr, clientAdr } = await pair();
    client.socket.send(oob('getchallenge 5'), serverAdr);
    await settle();
    read(server.socket);

    client.socket.send(oob('getinfo xyz'), serverAdr);
    await settle();
    server.socket.send(oob('infoResponse\n\\challenge\\xyz'), clientAdr);
    await settle();

    expect(read(server.socket)).toEqual([{ from: clientAdr, data: oob('getinfo xyz') }]);
    expect(read(client.socket)).toEqual([
      { from: serverAdr, data: oob('infoResponse\n\\challenge\\xyz') }
    ]);
    expect(master.read('relay')).toEqual([]);
    expect(rtc.connections[0].channels[0].sent).toHaveLength(2);
  });

  it('never dials from a server, which drops what it cannot deliver', async () => {
    const { server, client, clientAdr } = await pair();
    server.socket.send(oob('print "hello"'), clientAdr);
    server.socket.send(Uint8Array.of(1, 0, 0, 0, 9), clientAdr);
    await settle();

    expect(rtc.connections).toEqual([]);
    expect(master.read('signal')).toEqual([]);
    expect(read(client.socket)).toEqual([]);
  });

  it('holds what a client sends while it dials, sixteen at most, then sends it', async () => {
    const { server, client, serverAdr } = await pair();
    for (let i = 0; i < 20; i++) client.socket.send(Uint8Array.of(i), serverAdr);
    await settle();

    expect(read(server.socket).map((p) => p.data[0])).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 4)
    );
    expect(rtc.connections).toHaveLength(2);
  });

  it('holds a copy of what it holds, since its sender goes on using the buffer', async () => {
    const { server, client, serverAdr } = await pair();
    const data = Uint8Array.of(1, 0, 0, 0, 7);
    client.socket.send(data, serverAdr);
    data[4] = 8;
    await settle();
    expect(read(server.socket).map((p) => p.data)).toEqual([Uint8Array.of(1, 0, 0, 0, 7)]);
  });

  it('sends nothing for a dial it closes on its way', async () => {
    const { client, serverAdr } = await pair();
    client.socket.send(oob('getchallenge 1'), serverAdr);
    client.signalling.close();
    await settle();
    expect(master.read('signal')).toEqual([]);
    expect(rtc.connections.map((pc) => pc.connectionState)).toEqual(['closed']);
  });

  it('hangs up only the connection whose channel the socket lets go', async () => {
    const { client, serverAdr } = await pair();
    client.socket.send(oob('getchallenge 1'), serverAdr);
    await settle();
    const [clientPc] = rtc.connections;

    client.signalling.hangUp(serverAdr, new FakeDataChannel(CHANNEL_INIT));
    expect(clientPc.connectionState).toBe('connected');
    client.signalling.hangUp(serverAdr, clientPc.channels[0]);
    expect(clientPc.connectionState).toBe('closed');
  });

  it('takes an answer only to its own offer, and only once', async () => {
    const { client, serverAdr, clientAdr } = await pair();
    client.socket.send(oob('getchallenge 1'), serverAdr);
    await settle();
    const [clientPc, serverPc] = rtc.connections;

    const answer = (sdp: string) => ({
      kind: 'signal' as const,
      signal: { dial: 1, description: { type: 'answer' as const, sdp } }
    });
    master.send(serverAdr, { ...answer('fake 99'), peer: clientAdr });
    master.send(clientAdr, { ...answer('fake 98'), peer: serverAdr });
    await settle();
    expect(serverPc.remote?.type).toBe('offer');
    expect(clientPc.remote?.sdp).toBe(`fake ${serverPc.id}`);
  });

  it('dials again for a datagram once its offer has gone three seconds unanswered', async () => {
    const { client } = await pair();
    const nobody = netadr(NA.IP, '192.0.2.77', 27960);
    const offers = () =>
      master
        .read('signal')
        .filter(({ signal }) => signal.description?.type === 'offer')
        .map(({ signal }) => signal.dial);

    client.socket.send(oob('getchallenge 1'), nobody);
    await settle();
    now = ANSWER_MSEC - 1;
    client.socket.send(oob('getchallenge 1'), nobody);
    await settle();
    expect(offers()).toEqual([1]);

    now = ANSWER_MSEC;
    client.socket.send(oob('getchallenge 1'), nobody);
    await settle();
    expect(offers()).toEqual([1, 2]);
    expect(rtc.connections.map((pc) => pc.connectionState)).toEqual(['closed', 'new']);

    // The first dial's answer, come late, is not taken for the second's.
    master.send(client.link.address!, {
      kind: 'signal',
      peer: nobody,
      signal: { dial: 1, description: { type: 'answer', sdp: 'fake 99' } }
    });
    await settle();
    expect(rtc.connections[1].remote).toBeNull();
    expect(ANSWER_MSEC).toBe(3000);
  });

  it('waits on a dial that was answered, however long its connection takes', async () => {
    const { server, client, serverAdr } = await pair();
    rtc.verdict = () => null;
    client.socket.send(oob('getchallenge 1'), serverAdr);
    await settle();

    now = 10 * ANSWER_MSEC;
    client.socket.send(oob('getchallenge 2'), serverAdr);
    await settle();
    expect(rtc.connections).toHaveLength(2);
    expect(read(server.socket)).toEqual([]);
  });

  it('gives up a dial that fails, and dials again for the next datagram', async () => {
    const { server, client, serverAdr } = await pair();
    rtc.verdict = () => 'failed';
    client.socket.send(oob('getchallenge 1'), serverAdr);
    await settle();
    expect(rtc.connections.map((pc) => pc.connectionState)).toEqual(['closed', 'closed']);

    rtc.verdict = () => 'connected';
    client.socket.send(oob('getchallenge 2'), serverAdr);
    await settle();
    expect(read(server.socket).map((p) => p.data)).toEqual([oob('getchallenge 2')]);
  });

  it('answers a new offer with a new connection, and takes no signal of the old dial', async () => {
    const { client, serverAdr, clientAdr } = await pair();
    client.socket.send(oob('getchallenge 1'), serverAdr);
    await settle();
    const [clientPc, oldServerPc] = rtc.connections;

    // A second dial from the client's address, of a connection its signalling never made.
    const redial = rtc.create([]);
    redial.createDataChannel('', CHANNEL_INIT);
    const offer = await redial.createOffer();
    await redial.setLocalDescription(offer);
    master.send(serverAdr, {
      kind: 'signal',
      peer: clientAdr,
      signal: { dial: 2, description: { type: 'offer', sdp: offer.sdp! } }
    });
    await settle();

    const newServerPc = rtc.connections[3];
    expect(newServerPc.remoteId).toBe(redial.id);
    // The connection it replaced has ended at both ends.
    expect(oldServerPc.connectionState).toBe('closed');
    expect(clientPc.connectionState).toBe('closed');
    expect(rtc.connections).toHaveLength(4);

    master.send(serverAdr, {
      kind: 'signal',
      peer: clientAdr,
      signal: {
        dial: 1,
        candidate: {
          candidate: `candidate:fake ${redial.id}`,
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: null
        }
      }
    });
    await settle();
    expect(newServerPc.candidates).toBe(0);
  });

  it('closes a connection whose channel the socket lets go, and dials again after', async () => {
    const { server, client, serverAdr } = await pair();
    client.socket.send(oob('getchallenge 1'), serverAdr);
    await settle();
    read(server.socket);

    now = 60000;
    read(client.socket);
    read(server.socket);
    await settle();
    expect(rtc.connections.map((pc) => pc.connectionState)).toEqual(['closed', 'closed']);

    client.socket.send(oob('getchallenge 2'), serverAdr);
    await settle();
    expect(read(server.socket).map((p) => p.data)).toEqual([oob('getchallenge 2')]);
    expect(rtc.connections).toHaveLength(4);
  });

  it('sends the master’s datagrams down the link, and reads its answers as from it', async () => {
    const { client, clientAdr } = await pair();

    client.socket.send(oob('getservers PlayCanvasQuake 1 empty full'), master.adr);
    await settle();
    expect(master.datagrams).toEqual([
      { from: clientAdr, data: oob('getservers PlayCanvasQuake 1 empty full') }
    ]);

    master.sendDatagram(clientAdr, oob('getserversResponse\\EOT\0\0\0'));
    await settle();
    expect(read(client.socket)).toEqual([
      { from: master.adr, data: oob('getserversResponse\\EOT\0\0\0') }
    ]);
    expect(rtc.connections).toEqual([]);
  });

  it('answers the master’s own dial through it, and its challenge rides the channel', async () => {
    const { server, serverAdr } = await pair();
    const own = fakePeer(master, rtc.create, '192.0.2.1', { dials: true, now: clock, self: true });
    await settle();

    own.signalling.dial(serverAdr);
    await settle();
    own.socket.send(oob('getinfo abcdefgh'), serverAdr);
    await settle();
    expect(read(server.socket)).toEqual([{ from: master.adr, data: oob('getinfo abcdefgh') }]);

    server.socket.send(oob('infoResponse\n\\challenge\\abcdefgh'), master.adr);
    await settle();
    expect(read(own.socket)).toEqual([
      { from: serverAdr, data: oob('infoResponse\n\\challenge\\abcdefgh') }
    ]);

    expect(master.datagrams).toEqual([]);
    expect(master.read('relay')).toEqual([]);
    const fromServer = master.frames.filter(
      ({ from }) => from !== null && compareAdr(from, serverAdr)
    );
    const signals = fromServer.filter(({ frame }) => frame.kind === 'signal');
    expect(signals.length).toBeGreaterThan(0);
    for (const { frame } of signals) expect(frame).toMatchObject({ peer: null });
  });

  it('goes through every master, and meets a peer through the one that knows it', async () => {
    const lan = new FakeMaster('lan.test');
    const server = fakePeer(lan, rtc.create, '192.168.1.5', { dials: false, now: clock });
    server.link.register(27960);
    const links = [
      new MasterLink(master.adr, master.connect('198.51.100.4')),
      new MasterLink(lan.adr, lan.connect('192.168.1.10'))
    ];
    const client = createPeerSocket({
      links,
      createPeerConnection: rtc.create,
      dials: true,
      now: clock
    });
    await settle();
    const serverAdr = server.link.address!;

    client.socket.send(oob('getinfo xyz'), serverAdr);
    client.socket.send(oob('getchallenge 3'), serverAdr);
    await settle();
    expect(read(server.socket)).toEqual([
      { from: links[1].address, data: oob('getinfo xyz') },
      { from: links[1].address, data: oob('getchallenge 3') }
    ]);
    // The other master was asked too, and knew nobody there.
    expect(master.read('relay')).toHaveLength(1);
    expect(master.read('signal').filter(({ signal }) => signal.description)).toHaveLength(1);

    // A candidate gathered after the answer goes only to the master that brought it.
    const signals = [master.read('signal').length, lan.read('signal').length];
    rtc.connections[0].trickle();
    await settle();
    expect([master.read('signal').length, lan.read('signal').length]).toEqual([
      signals[0],
      signals[1] + 1
    ]);

    client.socket.send(oob('getservers PlayCanvasQuake 1'), lan.adr);
    await settle();
    expect(lan.datagrams).toHaveLength(1);
    expect(master.datagrams).toEqual([]);
  });

  it('takes a master on and lets one go while it runs', async () => {
    const lan = new FakeMaster('lan.test');
    const { client, serverAdr } = await pair();
    const link = new MasterLink(lan.adr, lan.connect('198.51.100.4'));
    client.signalling.addLink(link);
    await settle();

    client.socket.send(oob('getinfo xyz'), serverAdr);
    client.socket.send(oob('getservers PlayCanvasQuake 1'), lan.adr);
    await settle();
    expect(lan.read('relay')).toHaveLength(1);
    expect(lan.datagrams).toHaveLength(1);

    client.signalling.removeLink(link);
    expect(link.onFrame).toBeNull();
    client.socket.send(oob('getinfo xyz'), serverAdr);
    client.socket.send(oob('getservers PlayCanvasQuake 1'), lan.adr);
    await settle();
    expect(lan.read('relay')).toHaveLength(1);
    expect(lan.datagrams).toHaveLength(1);
    expect(master.read('relay')).toHaveLength(2);
  });

  it('dials for a query too when it does not relay, as the master’s own socket does', async () => {
    const { server, serverAdr } = await pair();
    const link = new MasterLink(master.adr, master.connect('198.51.100.7', { self: true }));
    const own = createPeerSocket({
      links: [link],
      createPeerConnection: rtc.create,
      dials: true,
      relays: false,
      now: clock
    });
    await settle();

    own.socket.send(oob('getinfo xyz'), serverAdr);
    await settle();
    expect(master.read('relay')).toEqual([]);
    expect(read(server.socket)).toEqual([{ from: master.adr, data: oob('getinfo xyz') }]);
    expect(rtc.connections.map((pc) => pc.connectionState)).toEqual(['connected', 'connected']);
  });

  it('takes the browser’s own peer connections, channels and WebSockets as they are', () => {
    // A typecheck more than a test: the page hands these over with no adapter.
    const connection: PeerConnectionFactory = (iceServers) => new RTCPeerConnection({ iceServers });
    const channel = (c: RTCDataChannel): DataChannelLike => c;
    const webSocket = (url: string): WebSocketLike => new WebSocket(url);
    expect([connection, channel, webSocket]).toHaveLength(3);
  });

  it('gathers through the ICE servers the masters name', async () => {
    master.iceServers = [{ urls: 'stun:stun.test:3478' }];
    const { client, serverAdr } = await pair();
    client.socket.send(oob('getchallenge 1'), serverAdr);
    await settle();
    expect(rtc.connections.map((pc) => pc.iceServers)).toEqual([
      [{ urls: 'stun:stun.test:3478' }],
      [{ urls: 'stun:stun.test:3478' }]
    ]);
  });

  it('carries a long netchan message in fragments that each fit one SCTP packet', async () => {
    const { server, client, serverAdr, clientAdr } = await pair();
    const sender = new Netchan(new Net({ cvars: testCvars(), socket: client.socket, now: clock }));
    sender.setup('client', serverAdr, 7, 99);
    const serverNet = new Net({ cvars: testCvars(), socket: server.socket, now: clock });
    const receiver = new Netchan(serverNet);
    receiver.setup('server', clientAdr, 7, 99);

    const message = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff);
    sender.transmit(message);
    while (sender.unsentFragments) sender.transmitNextFragment();
    await settle();

    const taken = [];
    for (let p; (p = serverNet.getPacket()) !== null; ) {
      const whole = receiver.process(p.data);
      if (whole !== null) taken.push(whole);
    }
    expect(taken).toEqual([{ sequence: 1, data: message }]);
    const sizes = rtc.connections[0].channels[0].sent.map((data) => data.length);
    expect(sizes).toEqual([1114, 1114, 814]);
  });
});
