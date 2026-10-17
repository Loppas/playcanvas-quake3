import dgram from 'node:dgram';
import { createServer } from 'node:net';

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { startMaster } from '../../master/master-server';
import { MASTER_ADR, oob, readList, text } from '../../master/master-test-fixtures';
import { MasterLink } from '../net/master-link';
import { masterAt } from '../net/masters';
import type { DatagramSocket, NetPacket } from '../net/net';
import { testCvars } from '../net/net-test-fixtures';
import { createPeerSocket, type PeerConnectionFactory } from '../net/peer-signalling';
import { BIND_PORTS, nodeServerNetwork, openPort } from './node-network';

/**
 * The Node dedicated server's network: Quake 3's bind walk over real UDP ports, and the server's
 * peers on one port, registered with a master over `ws` and dialled by it through node-datachannel.
 * The second half is skipped where node-datachannel's native addon cannot load.
 *
 * The ports are fixed, 28960 to 28998, below those the system hands a socket bound to port 0
 * (from 32768 on Linux, 49152 on Windows and macOS), as the peer connections of other files, run
 * alongside, take those.
 */

/** Whether the machine binds IPv6 at all: a runner may have IPv4 alone. */
const ipv6 = await new Promise<boolean>((resolve) => {
  const socket = dgram.createSocket('udp6');
  socket.once('error', () => {
    socket.close();
    resolve(false);
  });
  socket.bind(0, () => socket.close(() => resolve(true)));
});

/**
 * A UDP socket holding a port until the test lets it go, as another program would: a Quake 3
 * server on IPv4, or another of the port's, whose libdatachannel holds its port on both families.
 */
const held: dgram.Socket[] = [];

async function hold(type: 'udp4' | 'udp6', port: number): Promise<void> {
  const socket = dgram.createSocket(type);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, resolve);
  });
  held.push(socket);
}

afterEach(() => {
  for (const socket of held.splice(0)) socket.close();
});

describe("Quake 3's bind walk", () => {
  it('takes net_port when it is free, and says it is opening it', async () => {
    const lines: string[] = [];
    expect(await openPort(28960, (line) => lines.push(line))).toBe(28960);
    expect(lines).toEqual(['Opening IP socket: 0.0.0.0:28960']);
  });

  it.skipIf(!ipv6)('walks up past a port held in either family, warning of each', async () => {
    await hold('udp4', 28970);
    await hold('udp6', 28971);
    const lines: string[] = [];
    expect(await openPort(28970, (line) => lines.push(line))).toBe(28972);
    expect(lines).toEqual([
      'Opening IP socket: 0.0.0.0:28970',
      'WARNING: NET_IPSocket: bind: EADDRINUSE',
      'Opening IP socket: 0.0.0.0:28971',
      'WARNING: NET_IPSocket: bind: EADDRINUSE',
      'Opening IP socket: 0.0.0.0:28972'
    ]);
  });

  it("writes the port it opened back to net_port, as Q3's bind does", async () => {
    await hold('udp4', 28993);
    const cvars = testCvars({ sv_master1: '', sv_master2: '', net_port: '28993' });
    const network = await nodeServerNetwork(cvars, () => {});
    network.close();
    expect(cvars.get('net_port')).toBe('28994');
  });

  it('gives up after ten, as Quake 3 does', async () => {
    for (let i = 0; i < BIND_PORTS; i++) await hold('udp4', 28980 + i);
    const lines: string[] = [];
    expect(await openPort(28980, (line) => lines.push(line))).toBeNull();
    expect(lines.filter((line) => line.startsWith('Opening'))).toHaveLength(10);
    expect(lines.at(-1)).toBe("WARNING: Couldn't bind to a v4 ip address.");
  });
});

const native = await import('node-datachannel').catch(() => null);
const polyfill = await import('node-datachannel/polyfill').catch(() => null);
afterAll(() => native?.cleanup());

/** Wait until `done` holds, for ten seconds at most. */
async function until(done: () => boolean): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > 10000) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A test's time where it waits: a few of until()'s can take a loaded machine past five seconds. */
const WAITING = { timeout: 30_000 };

/** The next datagram to reach a socket. */
async function next(socket: DatagramSocket): Promise<NetPacket> {
  let packet: NetPacket | null = null;
  await until(() => (packet = socket.receive()) !== null);
  return packet!;
}

describe.skipIf(polyfill === null)('the dedicated server on its masters', WAITING, () => {
  const closers: (() => void)[] = [];

  afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
  });

  it('registers net_port, heartbeats, and is dialled and listed', async () => {
    const running = await startMaster({
      createPeerConnection: (iceServers) => new polyfill!.RTCPeerConnection({ iceServers }),
      iceServers: [],
      print: () => {},
      port: 0
    });
    const slot = `ws://127.0.0.1:${running.port}`;
    const masterAdr = masterAt(slot)!.adr;

    const lines: string[] = [];
    const cvars = testCvars({ sv_master1: slot, sv_master2: slot, net_port: '28990' });
    const network = await nodeServerNetwork(cvars, (line) => lines.push(line));
    const loop = setInterval(() => {
      running.frame();
      network.frame();
    }, 5);
    closers.push(() => {
      clearInterval(loop);
      network.close();
      running.close();
    });
    const socket = network.socket!;

    await until(() => lines.some((line) => line.startsWith('Registered')));
    expect(cvars.get('net_port')).toBe('28990');
    expect(lines).toEqual([
      'Opening IP socket: 0.0.0.0:28990',
      `Registered with ${slot} as 127.0.0.1:28990`
    ]);

    socket.send(oob('heartbeat DarkPlaces\n'), masterAdr);
    const getinfo = await next(socket);
    const challenge = text(getinfo.data).slice('\xff\xff\xff\xffgetinfo '.length);
    const keys = `\\challenge\\${challenge}\\gamename\\PlayCanvasQuake\\protocol\\1\\clients\\0`;
    socket.send(oob(`infoResponse\n${keys}\\sv_maxclients\\8`), getinfo.from);

    const link = new MasterLink(MASTER_ADR, new WebSocket(slot));
    const client = createPeerSocket({
      links: [link],
      createPeerConnection: (() => {
        throw new Error('a client asking the list dials nobody');
      }) as PeerConnectionFactory,
      dials: true
    });
    closers.push(() => {
      client.signalling.close();
      link.close();
    });
    await until(() => link.address !== null);
    let listed: string[] = [];
    for (let tries = 0; tries < 4 && listed.length === 0; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      client.socket.send(oob('getservers PlayCanvasQuake 1 empty'), MASTER_ADR);
      listed = readList((await next(client.socket)).data) ?? [];
    }
    expect(listed).toEqual(['127.0.0.1:28990']);

    // Its peers hold the port it opened, so another server walks past it.
    expect(await openPort(28990, () => {})).toBe(28991);

    // Closed, it leaves its master, which lists it no more.
    network.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    client.socket.send(oob('getservers PlayCanvasQuake 1 empty'), MASTER_ADR);
    expect(readList((await next(client.socket)).data)).toEqual([]);
  });
});

describe.skipIf(polyfill === null)('a dedicated server with a master of its own', WAITING, () => {
  it('starts the master before its links open, and registers with it at localhost', async () => {
    const lines: string[] = [];
    const cvars = testCvars({
      sv_runMaster: '1',
      sv_master1: '',
      sv_master2: 'localhost:28998',
      net_port: '28991'
    });
    const network = await nodeServerNetwork(cvars, (line) => lines.push(line), 28998);
    const socket = network.socket!;
    const loop = setInterval(() => network.frame(), 5);
    const link = new MasterLink(MASTER_ADR, new WebSocket('ws://localhost:28998'));
    const client = createPeerSocket({
      links: [link],
      createPeerConnection: (() => {
        throw new Error('a client asking the list dials nobody');
      }) as PeerConnectionFactory,
      dials: true
    });
    try {
      await until(() => lines.some((line) => line.startsWith('Registered')));
      // The master's own lines come first, and it names the server by the family localhost took.
      expect(lines[0]).toBe('> Listening on port 28998');
      expect(lines).toContain('Opening IP socket: 0.0.0.0:28991');
      const registered = lines.find((line) => line.startsWith('Registered'))!;
      expect(registered).toMatch(
        /^Registered with localhost:28998 as (127\.0\.0\.1|\[::1\]):28991$/
      );

      // Listed once its master has read the answer to the getinfo it dialled for.
      socket.send(oob('heartbeat DarkPlaces\n'), masterAt('localhost:28998')!.adr);
      const getinfo = await next(socket);
      const challenge = text(getinfo.data).slice('\xff\xff\xff\xffgetinfo '.length);
      const keys = `\\challenge\\${challenge}\\gamename\\PlayCanvasQuake\\protocol\\1`;
      socket.send(oob(`infoResponse\n${keys}\\clients\\0\\sv_maxclients\\8`), getinfo.from);
      await until(() => link.address !== null);
      let listed: string[] = [];
      for (let tries = 0; tries < 4 && listed.length === 0; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        client.socket.send(oob('getserversExt PlayCanvasQuake 1 empty'), MASTER_ADR);
        listed = readList((await next(client.socket)).data) ?? [];
      }
      expect(listed).toEqual([registered.slice(registered.lastIndexOf(' ') + 1)]);
    } finally {
      clearInterval(loop);
      client.signalling.close();
      link.close();
      network.close();
    }
  });

  it('goes on without a master of its own when its port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(28997, resolve));
    const lines: string[] = [];
    const cvars = testCvars({
      sv_runMaster: '1',
      sv_master1: '',
      sv_master2: '',
      net_port: '28992'
    });
    const network = await nodeServerNetwork(cvars, (line) => lines.push(line), 28997);
    network.close();
    blocker.close();

    expect(lines[0]).toMatch(/^WARNING: no master here: .*EADDRINUSE/);
    expect(network.socket).not.toBeNull();
  });
});
