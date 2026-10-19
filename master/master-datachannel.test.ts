import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';

import { MasterLink, type WebSocketLike } from '../src/net/master-link';
import { NA, netadr } from '../src/net/net';
import { createPeerSocket, type PeerConnectionFactory } from '../src/net/peer-signalling';
import type { PeerSocket } from '../src/net/peer-socket';
import { MasterServer, MAX_FRAME } from './master-server';
import { MASTER_ADR, oob, readList, text } from './master-test-fixtures';
import { listen } from './node-master';

/**
 * The master as `npm run master` runs it, on `ws` and node-datachannel, with programs of the port's
 * own at it over real WebSockets and real peer connections. Skipped where node-datachannel's native
 * addon cannot load.
 */

const native = await import('node-datachannel').catch(() => null);
const polyfill = await import('node-datachannel/polyfill').catch(() => null);

/** A test's time where it waits: a few of until()'s can take a loaded machine past five seconds. */
const WAITING = { timeout: 30_000 };

describe.skipIf(polyfill === null)('the master over ws and node-datachannel', WAITING, () => {
  // Loopback candidates, so the test needs no network interface but the loopback. The library
  // takes its own settings beside the W3C ones.
  const create: PeerConnectionFactory = (iceServers) => {
    const configuration = { iceServers, bindAddress: '127.0.0.1' };
    return new polyfill!.RTCPeerConnection(configuration);
  };
  const closers: (() => void)[] = [];

  afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
  });
  afterAll(() => native?.cleanup());

  /** The master on a port of its own, reading its socket as its program does. */
  async function start() {
    const master = new MasterServer({
      createPeerConnection: create,
      iceServers: [],
      lookup: async () => [],
      print: () => {}
    });
    const server: WebSocketServer = await listen(master, 0);
    const loop = setInterval(() => master.frame(), 5);
    closers.push(() => {
      clearInterval(loop);
      master.close();
      server.close();
    });
    return { master, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  /** A program at the master, over a WebSocket of `ws`'s as the dedicated server makes one. */
  function program(url: string, dials: boolean) {
    // `ws`'s WebSocket is the link's as it is.
    const ws: WebSocketLike = new WebSocket(url);
    const link = new MasterLink(MASTER_ADR, ws);
    const { socket, signalling } = createPeerSocket({
      links: [link],
      createPeerConnection: create,
      dials
    });
    closers.push(() => {
      signalling.close();
      link.close();
    });
    return { link, socket };
  }

  /** Wait until `done` holds, for ten seconds at most. */
  async function until(done: () => boolean): Promise<void> {
    const start = Date.now();
    while (!done()) {
      if (Date.now() - start > 10000) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** The next datagram to reach a socket. */
  async function next(socket: PeerSocket) {
    let packet: ReturnType<PeerSocket['receive']> = null;
    await until(() => (packet = socket.receive()) !== null);
    return packet!;
  }

  it('greets, registers, dials a heartbeating server for its getinfo, and lists it', async () => {
    const { url } = await start();
    const server = program(url, false);
    server.link.register(27960);
    await until(() => server.link.address?.port === 27960);
    // Node hands the master an IPv4 connection to its IPv6 socket as ::ffff:127.0.0.1.
    expect(server.link.address).toEqual(netadr(NA.IP, '127.0.0.1', 27960));

    server.socket.send(oob('heartbeat DarkPlaces\n'), MASTER_ADR);
    const getinfo = await next(server.socket);
    expect(getinfo.from).toEqual(MASTER_ADR);
    const challenge = text(getinfo.data).slice('\xff\xff\xff\xffgetinfo '.length);
    const keys = `\\challenge\\${challenge}\\gamename\\PlayCanvasQuake\\protocol\\1\\clients\\2`;
    server.socket.send(oob(`infoResponse\n${keys}\\sv_maxclients\\8`), MASTER_ADR);

    // The answer lists the server once the master's loop has read it: asked four times at most,
    // as the throttle allows in a row.
    const client = program(url, true);
    await until(() => client.link.address !== null);
    let listed: string[] = [];
    for (let tries = 0; tries < 4 && listed.length === 0; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      client.socket.send(oob('getservers PlayCanvasQuake 1'), MASTER_ADR);
      listed = readList((await next(client.socket)).data) ?? [];
    }
    expect(listed).toEqual(['127.0.0.1:27960']);
  });

  it("hears the error of a WebSocket of ws's that is refused, which Node would throw", async () => {
    const ws = new WebSocket('ws://127.0.0.1:1');
    const link = new MasterLink(MASTER_ADR, ws);
    await new Promise((resolve) => ws.once('close', resolve));
    expect(link.address).toBeNull();
  });

  it('closes a WebSocket that sends a frame past MAX_FRAME', async () => {
    const { url } = await start();
    const ws = new WebSocket(url);
    closers.push(() => ws.close());
    await new Promise((resolve) => ws.once('open', resolve));

    const code = new Promise<number>((resolve) => ws.once('close', resolve));
    ws.send(new Uint8Array(MAX_FRAME + 1));
    expect(await code).toBe(1009);
  });
});
