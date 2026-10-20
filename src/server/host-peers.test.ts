import { describe, expect, it } from 'vitest';

import { NA, netadr } from '../net/net';
import { testCvars } from '../net/net-test-fixtures';
import { CHANNEL_INIT } from '../net/peer-signalling';
import {
  FakeDataChannel,
  FakeMaster,
  FakeRtc,
  fakePeer,
  settle
} from '../net/peer-test-fixtures';
import { HostPeers } from './host-peers';
import type { PageToWorker } from './worker-messages';

/** Where the tab's server is registered, and where its player is. */
const TAB = netadr(NA.IP, '203.0.113.9', 27960);

/**
 * A tab's peers at the master on this machine, and what they post to the worker. The masters'
 * frame runs when the test says, and the Web Locks are the test's.
 */
function rig(options: { locks?: LockManager | null } = {}) {
  const master = new FakeMaster('localhost');
  const rtc = new FakeRtc();
  const posted: { message: PageToWorker; transfer: Transferable[] }[] = [];
  let tick: (() => void) | null = null;
  let stops = 0;
  const peers = new HostPeers({
    cvars: testCvars({ sv_master1: 'localhost', sv_master2: 'localhost' }),
    post: (message, transfer) => posted.push({ message, transfer }),
    createPeerConnection: rtc.create,
    connect: () => master.connect(TAB.ip),
    now: () => 0,
    print: () => {},
    locks: options.locks ?? null,
    schedule: (frame) => {
      tick = frame;
      return () => stops++;
    }
  });
  return { master, rtc, posted, peers, tick: () => tick?.(), stops: () => stops };
}

/** The channels the page has moved, by the number each went under. */
function moved(posted: ReturnType<typeof rig>['posted']) {
  return posted.flatMap(({ message, transfer }) =>
    message.type === 'channel' ? [{ id: message.id, channel: message.channel, transfer }] : []
  );
}

describe("a tab host's peers", () => {
  it('move each channel to the worker, numbered, in the task that made it', async () => {
    const { master, rtc, posted } = rig();
    await settle();
    const player = fakePeer(master, rtc.create, '198.51.100.4', { dials: true });
    await settle();

    player.signalling.dial(TAB);
    await settle();

    const channels = moved(posted);
    expect(channels.map(({ id }) => id)).toEqual([1]);
    // The channel went as it was made, before anything opened it, and it went as moved.
    const made = rtc.connections[1].channels[0];
    expect(channels[0].channel).toBe(made);
    expect(channels[0].transfer).toEqual([made]);
  });

  it('post a channel before the call that hands it over returns, as a transfer must be', () => {
    const { posted, peers } = rig();
    const channel = new FakeDataChannel(CHANNEL_INIT);
    peers.attach(netadr(NA.IP, '198.51.100.4', 50000), channel);
    expect(moved(posted).map(({ channel: sent }) => sent)).toEqual([channel]);
  });

  it('hang up only the connection the number names, not a newer one to the same peer', async () => {
    const { master, rtc, posted, peers } = rig();
    await settle();
    const player = fakePeer(master, rtc.create, '198.51.100.4', { dials: true });
    await settle();
    player.signalling.dial(TAB);
    await settle();

    // The player offers again, as one does after a restart: the page answers with a new connection.
    const from = player.link.address!;
    master.send(TAB, {
      kind: 'signal',
      peer: from,
      signal: { dial: 9, description: { type: 'offer', sdp: 'fake 1' } }
    });
    await settle();
    expect(moved(posted).map(({ id }) => id)).toEqual([1, 2]);
    // The new offer replaced the first connection; the second has not finished its ICE.
    const [, first, second] = rtc.connections;
    expect([first.connectionState, second.connectionState]).toEqual(['closed', 'new']);

    // The first's hang-up, crossing the new connection on its way, leaves it be.
    peers.hangUp(1, from);
    expect(second.connectionState).toBe('new');
    peers.hangUp(2, from);
    expect(second.connectionState).toBe('closed');
  });

  it('see to the masters at once and on each tick, and stop the ticks as they close', async () => {
    const { master, tick, stops, peers } = rig();
    await settle();
    expect(master.read('register')).toEqual([{ kind: 'register', port: 27960 }]);

    master.restart();
    await settle();
    tick();
    await settle();
    // Too soon: a lost master is tried again 3 s on.
    expect(master.read('register')).toHaveLength(1);

    peers.close();
    expect(stops()).toBe(1);
  });

  it('tell the worker of each registration a master grants', async () => {
    const { posted } = rig();
    await settle();
    const granted = posted.filter(({ message }) => message.type === 'registered');
    expect(granted).toEqual([{ message: { type: 'registered' }, transfer: [] }]);
  });

  it('let their masters go as they close', async () => {
    const { master, peers } = rig();
    await settle();
    const datagram = () => new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x41]);
    peers.route(datagram(), master.adr);
    await settle();
    expect(master.datagrams).toHaveLength(1);

    peers.close();
    peers.route(datagram(), master.adr);
    await settle();
    expect(master.datagrams).toHaveLength(1);
  });

  it('hold a shared Web Lock while they host, and let it go as they close', async () => {
    const requests: { name: string; mode?: string }[] = [];
    let released = false;
    const locks = {
      request: (name: string, options: LockOptions, callback: LockGrantedCallback<void>) => {
        requests.push({ name, mode: options.mode });
        return Promise.resolve(callback(null)).then(() => {
          released = true;
        });
      }
    } as unknown as LockManager;
    const { peers } = rig({ locks });
    await settle();
    expect(requests).toEqual([{ name: 'listen-server', mode: 'shared' }]);
    expect(released).toBe(false);

    peers.close();
    await settle();
    expect(released).toBe(true);
  });
});
