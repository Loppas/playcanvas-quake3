import { beforeEach, describe, expect, it } from 'vitest';

import { NA, netadr, type NetAdr } from './net';
import {
  CHANNEL_IDLE_MSEC,
  MAX_INCOMING,
  PeerSocket,
  type DataChannelLike,
  type PeerRoute
} from './peer-socket';
import { CHANNEL_INIT } from './peer-signalling';
import { FakeDataChannel, settle } from './peer-test-fixtures';

const peer = netadr(NA.IP, '198.51.100.4', 50001);

/** The two ends of a channel, opening. */
function channelPair(): [FakeDataChannel, FakeDataChannel] {
  const near = new FakeDataChannel(CHANNEL_INIT);
  const far = new FakeDataChannel(CHANNEL_INIT);
  near.remote = far;
  far.remote = near;
  near.opened();
  far.opened();
  return [near, far];
}

describe('a peer socket', () => {
  let now: number;
  let routed: { data: Uint8Array; to: NetAdr }[];
  let hungUp: { peer: NetAdr; channel: DataChannelLike }[];
  let socket: PeerSocket;

  beforeEach(() => {
    now = 0;
    routed = [];
    hungUp = [];
    const route: PeerRoute = {
      send: (data, to) => routed.push({ data, to }),
      hangUp: (p, channel) => hungUp.push({ peer: p, channel })
    };
    socket = new PeerSocket({ route, now: () => now });
  });

  it('sends down a peer’s open channel, and anything else to its route', async () => {
    const [near, far] = channelPair();
    socket.attach(peer, near);

    socket.send(Uint8Array.of(1), peer);
    expect(routed).toEqual([{ data: Uint8Array.of(1), to: peer }]);

    await settle();
    socket.send(Uint8Array.of(2), peer);
    socket.send(Uint8Array.of(3), netadr(NA.IP, '198.51.100.4', 50002));
    expect(near.sent).toEqual([Uint8Array.of(2)]);
    expect(routed.map((r) => r.to.port)).toEqual([50001, 50002]);
    expect(far.readyState).toBe('open');
  });

  it('says whether a peer’s channel is open', async () => {
    const [near, far] = channelPair();
    socket.attach(peer, near);
    expect(socket.isOpen(peer)).toBe(false);

    await settle();
    expect(socket.isOpen(peer)).toBe(true);
    expect(socket.isOpen(netadr(NA.IP, '198.51.100.4', 50002))).toBe(false);

    far.close();
    await settle();
    expect(socket.isOpen(peer)).toBe(false);
  });

  it('reads a channel’s datagrams as from its peer, in order with those delivered', async () => {
    const [near, far] = channelPair();
    socket.attach(peer, near);
    await settle();

    far.send(Uint8Array.of(7, 8));
    await settle();
    socket.deliver({ from: netadr(NA.IP, 'master.test', 27950), data: Uint8Array.of(9) });

    expect(near.binaryType).toBe('arraybuffer');
    expect(socket.receive()).toEqual({ from: peer, data: Uint8Array.of(7, 8), time: 0 });
    expect(socket.receive()).toEqual({
      from: netadr(NA.IP, 'master.test', 27950),
      data: Uint8Array.of(9),
      time: 0
    });
    expect(socket.receive()).toBeNull();
  });

  it('stamps each datagram with when it landed, and says so as it lands', async () => {
    const [near, far] = channelPair();
    socket.attach(peer, near);
    await settle();
    const landed: number[] = [];
    socket.onArrival = () => landed.push(now);

    now = 40;
    far.send(Uint8Array.of(1));
    await settle();
    now = 55;
    socket.deliver({ from: peer, data: Uint8Array.of(2), time: 3 });
    expect(landed).toEqual([40, 55]);

    now = 70;
    expect(socket.receive()?.time).toBe(40);
    expect(socket.receive()?.time).toBe(55);
  });

  it('lets a channel the other end closes go, and tells its route', async () => {
    const [near, far] = channelPair();
    socket.attach(peer, near);
    await settle();

    far.close();
    await settle();
    expect(hungUp).toEqual([{ peer, channel: near }]);
    socket.send(Uint8Array.of(1), peer);
    expect(routed).toHaveLength(1);
  });

  it('lets a channel go whose send throws, as one open after its peer has gone does', async () => {
    const [near] = channelPair();
    socket.attach(peer, near);
    await settle();
    near.send = () => {
      throw new Error('DataChannel is closed');
    };

    expect(() => socket.send(Uint8Array.of(1), peer)).toThrow('DataChannel is closed');
    expect(hungUp).toEqual([{ peer, channel: near }]);
    socket.send(Uint8Array.of(2), peer);
    expect(routed.map(({ data }) => data)).toEqual([Uint8Array.of(2)]);
  });

  it('keeps a peer’s newer channel when the one it replaced closes', async () => {
    const [older, olderFar] = channelPair();
    const [newer] = channelPair();
    socket.attach(peer, older);
    socket.attach(peer, newer);
    await settle();

    olderFar.close();
    await settle();
    expect(hungUp).toEqual([]);
    socket.send(Uint8Array.of(4), peer);
    expect(newer.sent).toEqual([Uint8Array.of(4)]);
  });

  it('closes a channel a minute after the last datagram it sent', async () => {
    const [near, far] = channelPair();
    socket.attach(peer, near);
    await settle();

    now = 50000;
    socket.send(Uint8Array.of(1), peer);
    now = 50000 + CHANNEL_IDLE_MSEC - 1;
    expect(socket.receive()).toBeNull();
    expect(hungUp).toEqual([]);

    now = 50000 + CHANNEL_IDLE_MSEC;
    expect(socket.receive()).toBeNull();
    expect(hungUp).toEqual([{ peer, channel: near }]);
    await settle();
    expect(far.readyState).toBe('closed');
  });

  it('closes a channel a minute after the last datagram it brought', async () => {
    const [near, far] = channelPair();
    socket.attach(peer, near);
    await settle();

    now = 50000;
    far.send(Uint8Array.of(2));
    await settle();
    expect(socket.receive()).not.toBeNull();
    now = 50000 + CHANNEL_IDLE_MSEC - 1;
    expect(socket.receive()).toBeNull();
    expect(hungUp).toEqual([]);

    now = 50000 + CHANNEL_IDLE_MSEC;
    expect(socket.receive()).toBeNull();
    expect(hungUp).toEqual([{ peer, channel: near }]);
  });

  it('loses the oldest datagram once it holds as many as a program leaves unread', () => {
    for (let i = 0; i <= MAX_INCOMING; i++) {
      socket.deliver({ from: peer, data: Uint8Array.of(i & 0xff, i >> 8) });
    }
    expect(socket.receive()?.data).toEqual(Uint8Array.of(1, 0));
    let count = 1;
    while (socket.receive() !== null) count++;
    expect(count).toBe(MAX_INCOMING);
  });

  it('holds a minute and a thousand and twenty-four datagrams', () => {
    expect(CHANNEL_IDLE_MSEC).toBe(60000);
    expect(MAX_INCOMING).toBe(1024);
  });
});
