import dgram from 'node:dgram';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { WebSocket } from 'ws';

import { startMaster, type RunningMaster } from '../../master/node-master';
import { atoi } from '../formats/c-scan';
import type { CvarStore } from '../net/cvar';
import type { IceServer } from '../net/master-protocol';
import { ServerMasters } from '../net/masters';
import { PORT_MASTER, PORT_SERVER } from '../net/net';
import { createPeerSocket } from '../net/peer-signalling';
import type { ServerNetwork } from './dedicated';

/**
 * The Node dedicated server's network: node-datachannel's peer connections, every one of them on
 * the one UDP port Quake 3's server would bind, and its masters reached through `ws`'s client.
 */

/** How many ports Quake 3's bind tries, from `net_port` up (`net_ip.c:1394`). */
export const BIND_PORTS = 10;

/** How often a link to a master is pinged. */
export const PING_MSEC = 30 * 1000;

/**
 * `NET_OpenIP`'s walk (`net_ip.c:1391–1410`): `net_port`, else the next free port of the nine
 * above it, each try printed as `NET_IPSocket` prints it (`:820–875`).
 *
 * libdatachannel binds its peers' port only as the first of them gathers, and a port another
 * program holds leaves it with no candidates and no error, so the port is tried here first, in
 * both families: another server's peers hold theirs on IPv6, a Quake 3 server's on IPv4.
 *
 * @returns the port, or null, with Quake 3's warning, when none of the ten is free
 */
export async function openPort(
  start: number,
  print: (text: string) => void
): Promise<number | null> {
  for (let port = start; port < start + BIND_PORTS && port <= 0xffff; port++) {
    print(`Opening IP socket: 0.0.0.0:${port}`);
    const error = (await tryBind('udp4', port)) ?? (await tryBind('udp6', port));
    if (error === null) return port;
    print(`WARNING: NET_IPSocket: bind: ${error}`);
  }
  print("WARNING: Couldn't bind to a v4 ip address.");
  return null;
}

/**
 * A UDP socket bound to a port and let go: null if it bound, else why not. A family the machine
 * has not got binds nothing and stops nothing, as `NET_OpenIP` passes over one.
 */
function tryBind(type: 'udp4' | 'udp6', port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(type);
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.close();
      const absent = err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL';
      resolve(absent ? null : (err.code ?? err.message));
    });
    socket.bind(port, () => socket.close(() => resolve(null)));
  });
}

/**
 * The network, as the dedicated server's boot opens it:
 * - on `sv_runMaster 1`, a master of its own on {@link PORT_MASTER} first, for a LAN with no
 *   other, which `sv_master2`'s `localhost` then reaches;
 * - the port, found as Quake 3's bind finds it and written back to `net_port`;
 * - the peers on it, by libdatachannel's ICE UDP mux, which answer and never dial;
 * - the masters the slots name.
 *
 * A server with no port has only its loopback, as Quake 3's with no socket.
 *
 * @param masterPort - Where a master of its own listens: {@link PORT_MASTER}, but for a test.
 */
export async function nodeServerNetwork(
  cvars: CvarStore,
  print: (text: string) => void,
  masterPort = PORT_MASTER
): Promise<ServerNetwork> {
  let master: RunningMaster | null = null;
  if (atoi(cvars.get('sv_runMaster')) !== 0) {
    try {
      master = await startMaster({
        createPeerConnection: (iceServers) => new RTCPeerConnection({ iceServers }),
        print,
        port: masterPort
      });
    } catch (err) {
      print(`WARNING: no master here: ${err instanceof Error ? err.message : err}`);
    }
  }

  const netPort = cvars.get('net_port');
  const port = await openPort(netPort === '' ? PORT_SERVER : atoi(netPort), print);
  if (port === null) {
    return { socket: null, frame: () => master?.frame(), close: () => master?.close() };
  }
  cvars.set('net_port', String(port));

  const { socket, signalling } = createPeerSocket({
    links: [],
    dials: false,
    createPeerConnection: (iceServers) => muxed(iceServers, port)
  });
  const masters = new ServerMasters({
    cvars,
    signalling,
    connect: pinged,
    now: () => performance.now(),
    print
  });
  const network: ServerNetwork = {
    socket,
    onRegistered: null,
    frame: () => {
      master?.frame();
      masters.frame();
    },
    close: () => {
      masters.close();
      signalling.close();
      master?.close();
    }
  };
  masters.onRegistered = () => network.onRegistered?.();
  return network;
}

/**
 * `ws`'s client to a master, pinged every {@link PING_MSEC} once open, and ended when the pong to
 * one ping hasn't come by the next, so it is tried again as any lost connection is. Little else
 * crosses the link, a heartbeat every 5 minutes at most, so a link that died quietly, as through a
 * NAT that has forgotten it, would go unnoticed. The pings are WebSocket protocol frames, which the
 * master's WebSocket server answers itself; the browser's `WebSocket` can't send one.
 */
export function pinged(url: string): WebSocket {
  const ws = new WebSocket(url);
  let answered = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  // `ping()` throws while the socket connects, which a timer's callback would end the server with.
  ws.on('open', () => {
    timer = setInterval(() => {
      // `close()` would wait up to 30 s for the master's own close frame, which a dead link never
      // brings.
      if (!answered) ws.terminate();
      else ws.ping();
      answered = false;
    }, PING_MSEC);
  });
  ws.on('pong', () => {
    answered = true;
  });
  ws.on('close', () => clearInterval(timer));
  return ws;
}

/** A peer connection on the server's one port, which libdatachannel shares between them all. */
function muxed(iceServers: IceServer[], port: number): RTCPeerConnection {
  // libdatachannel's own keys, which its polyfill passes through beside the W3C ones.
  const config = { iceServers, enableIceUdpMux: true, portRangeBegin: port, portRangeEnd: port };
  return new RTCPeerConnection(config);
}
