import type { LookupAddress } from 'node:dns';

import type { WebSocketLike } from '../src/net/master-link';
import {
  decodeFrame,
  encodeFrame,
  type IceServer,
  type MasterFrame
} from '../src/net/master-protocol';
import { MAX_MSGLEN } from '../src/net/msg';
import {
  adrToStringWithPort,
  compareAdr,
  formatIPv6,
  isOutOfBand,
  NA,
  netadr,
  parseIPv4,
  parseIPv6,
  type NetAdr
} from '../src/net/net';
import {
  createPeerSocket,
  type PeerConnectionFactory,
  type PeerSignalling,
  type SignallingLink
} from '../src/net/peer-signalling';
import type { PeerSocket } from '../src/net/peer-socket';
import { rateLimit, type LeakyBucket } from '../src/server/connectionless';
import { Throttle } from './clients';
import { publicAddress } from './common';
import { Messages } from './messages';
import { MAX_SERVERS_PER_ADDRESS, ServerList, type Server } from './servers';

/**
 * The master: dpmaster's messages (`messages.ts`) on a WebSocket to each socket, and the port's own
 * frames beside them (`master-protocol.ts`). It tells each socket the address it goes by, grants
 * a server the port it asks for, looks a name up for a client, and passes signals and
 * connectionless datagrams between sockets that have no data channel to each other.
 *
 * A heartbeat's `getinfo` goes one of two ways:
 * - given peer connections, the master has a socket of its own, as dpmaster has its UDP one, and
 *   sends it down a data channel it dials to the server, so a server is listed only once the
 *   master can reach it as a player would. That socket's signals pass through the master as any
 *   socket's do, naming no address, as a frame to or from the master itself does;
 * - without them, down the server's own WebSocket, as a datagram from the master, which shows
 *   only that the server answers.
 *
 * Where a socket can carry a record across the master's restart, as a Durable Object's WebSocket
 * can under Cloudflare's hibernation API, the master keeps in it what it knows of the connection:
 * its address, its registration and its server's listing. A master started afresh is given each
 * socket back with its record (`restore`); the rest, the rate limit's and the throttle's counts
 * among it, starts afresh.
 */

/** The ICE servers every greeting names: Cloudflare's free STUN. */
export const ICE_SERVERS: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/**
 * How many ports up from its `net_port` a server's registration looks, as Quake 3's bind walks up
 * when the port is taken (`net_ip.c:1394–1397`).
 */
export const REGISTER_PORTS = 10;

/**
 * The largest frame the master reads: a datagram of `MAX_MSGLEN`, which a `statusResponse` can
 * reach, and the line that names its peer. A socket that sends more is closed.
 */
export const MAX_FRAME = MAX_MSGLEN + 64;

/**
 * Relayed and signalled frames per socket, on Quake 3's leaky bucket (`SVC_RateLimit`): a burst of
 * this many, and one more every {@link RELAY_PERIOD} ms. A server answers ten queries a second at
 * most, and one dial is a dozen signals or so.
 */
export const RELAY_BURST = 100;
export const RELAY_PERIOD = 50;

/** `WebSocket.OPEN`. */
const OPEN = 1;

export interface MasterServerOptions {
  /**
   * The peer connections of the master's own socket, which dials a heartbeating server for its
   * `getinfo`: node-datachannel's, or a test's. Without them the `getinfo` goes down the server's
   * own WebSocket.
   */
  createPeerConnection?: PeerConnectionFactory;
  /** The ICE servers the greetings name, and the master's own socket gathers through. */
  iceServers?: IceServer[];
  /** `Sys_Milliseconds`. */
  now?: () => number;
  /** What challenges and the order of a list are drawn from. */
  random?: () => number;
  /** A name's every address: `getaddrinfo`, through Node's `dns.lookup`, or a test's. */
  lookup: (name: string) => Promise<LookupAddress[]>;
  /** A line for the console. */
  print?: (line: string) => void;
}

/**
 * A socket's WebSocket at the master. Node's `ws` carries nothing for the master, which keeps what
 * it knows in memory alone.
 */
export interface MasterWebSocket extends WebSocketLike {
  /** `WebSocket.serializeAttachment` in Cloudflare's runtime: a structured clone of `record`, kept. */
  serializeAttachment?(record: ConnectionRecord): void;
}

/**
 * What the master knows of a connection, as its socket carries it: enough for a master started
 * afresh to go on as the one before it. Its times are the master's clock's.
 */
export interface ConnectionRecord {
  source: NetAdr;
  address: NetAdr;
  registered: boolean;
  /** The server listed at its address, or null. */
  server: Server | null;
}

/** One socket's WebSocket at the master. */
interface Connection {
  ws: MasterWebSocket;
  /** Where it came from: its IP and its connection's source port. */
  source: NetAdr;
  /** The address the master names it by: the port it registered, or else its source's. */
  address: NetAdr;
  registered: boolean;
  /** Its relayed and signalled frames. */
  bucket: LeakyBucket;
}

/** The master's own socket, its signalling, and the link that carries its signals. */
interface OwnSocket {
  socket: PeerSocket;
  signalling: PeerSignalling;
  link: SignallingLink;
}

export class MasterServer {
  private readonly iceServers: IceServer[];
  private readonly now: () => number;
  private readonly lookup: (name: string) => Promise<LookupAddress[]>;
  private readonly print: (line: string) => void;
  /** By the address each goes by. */
  private readonly connections = new Map<string, Connection>();
  private readonly servers: ServerList;
  private readonly messages: Messages;
  /** The master's own socket, which dials a heartbeating server, if it has peer connections. */
  private readonly own: OwnSocket | null = null;

  constructor(options: MasterServerOptions) {
    this.iceServers = options.iceServers ?? ICE_SERVERS;
    this.now = options.now ?? (() => performance.now());
    this.lookup = options.lookup;
    this.print = options.print ?? console.log;
    const random = options.random ?? Math.random;

    if (options.createPeerConnection !== undefined) {
      // The master names itself as a program names itself: the loopback, which no peer is.
      const link: SignallingLink = {
        master: netadr(NA.LOOPBACK),
        iceServers: this.iceServers,
        onFrame: null,
        send: (frame) => this.fromOwn(frame)
      };
      const { socket, signalling } = createPeerSocket({
        links: [link],
        createPeerConnection: options.createPeerConnection,
        dials: true,
        relays: false,
        now: this.now
      });
      this.own = { socket, signalling, link };
    }

    this.servers = new ServerList(this.print);
    this.messages = new Messages({
      servers: this.servers,
      throttle: new Throttle(),
      now: () => this.seconds(),
      random,
      sendGetInfo: (to, data) => this.sendGetInfo(to, data),
      registered: () =>
        [...this.connections.values()].filter((c) => c.registered).map((c) => c.address),
      print: this.print
    });
  }

  /**
   * A socket's WebSocket, open: greeted with the address it goes by, and its frames read from now
   * on. One from an address the master cannot read is closed.
   *
   * @param ip - The address its connection comes from, as Node writes it.
   * @param port - Its connection's source port.
   */
  connect(ws: MasterWebSocket, ip: string, port: number): void {
    const source = connectionAddress(ip, port);
    if (source === null) {
      ws.close();
      return;
    }
    const connection = this.add(ws, source, this.unclaimed(source), false);
    this.save(connection);
    this.send(connection, {
      kind: 'greeting',
      address: connection.address,
      iceServers: this.iceServers
    });
  }

  /**
   * A socket's WebSocket as the master before this one held it, from the record it carries: its
   * connection at the address it went by, registered as it was, and its server listed as it was.
   * It is not greeted, as its other end knows its address already. A master is given its sockets
   * back before any new one connects.
   */
  restore(ws: MasterWebSocket, record: ConnectionRecord): void {
    this.add(ws, record.source, record.address, record.registered);
    if (record.server !== null) this.servers.restore(record.server);
  }

  /**
   * What reached the master's own socket, if it has one: whatever servers sent down the channels
   * it dialled, their `infoResponse`s among it. Reading it is also what closes a channel gone idle.
   */
  frame(): void {
    if (this.own === null) return;
    const { socket } = this.own;
    for (let packet; (packet = socket.receive()) !== null; ) {
      const { from } = packet;
      this.messages.handle(packet.data, from, (reply) => socket.send(reply, from));
    }
  }

  /** Every connection and every channel, closed. */
  close(): void {
    this.own?.signalling.close();
    for (const connection of [...this.connections.values()]) connection.ws.close();
  }

  /** A connection at `address`, its frames read from now on. */
  private add(
    ws: MasterWebSocket,
    source: NetAdr,
    address: NetAdr,
    registered: boolean
  ): Connection {
    const connection: Connection = {
      ws,
      source,
      address,
      registered,
      bucket: { lastTime: 0, burst: 0 }
    };
    this.connections.set(adrToStringWithPort(address), connection);

    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (event) => this.receive(connection, event.data));
    ws.addEventListener('close', () => this.disconnect(connection));
    return connection;
  }

  private receive(connection: Connection, data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return;
    if (data.byteLength > MAX_FRAME) {
      connection.ws.close();
      return;
    }
    const frame = decodeFrame(new Uint8Array(data));
    if (frame === null) return;

    switch (frame.kind) {
      case 'datagram': {
        const reply = (data: Uint8Array) => {
          this.send(connection, { kind: 'datagram', data: data as Uint8Array<ArrayBuffer> });
        };
        this.messages.handle(frame.data, connection.address, reply);
        // A heartbeat or an `infoResponse` may have listed or changed the server behind it.
        this.save(connection);
        return;
      }
      case 'register':
        this.register(connection, frame.port);
        return;
      case 'resolve':
        if (this.overLimit(connection)) return;
        void this.resolve(connection, frame.name, frame.port);
        return;
      case 'signal': {
        if (this.overLimit(connection)) return;
        const { signal } = frame;
        const passed: MasterFrame = { kind: 'signal', peer: connection.address, signal };
        if (frame.peer === null) this.own?.link.onFrame?.(passed);
        else this.sendTo(frame.peer, passed);
        return;
      }
      case 'relay':
        // Connectionless datagrams only: the game itself goes down a channel.
        if (!isOutOfBand(frame.data) || this.overLimit(connection)) return;
        this.sendTo(frame.peer, { kind: 'relay', peer: connection.address, data: frame.data });
        return;
    }
  }

  /**
   * A server's claim to its `net_port`: that port on its IP, or the next free one within
   * {@link REGISTER_PORTS}, granted with a `registerResponse`. With none free, or its public
   * address over dpmaster's quota of servers, it is granted nothing.
   */
  private register(connection: Connection, port: number): void {
    const quota = publicAddress(connection.source);
    const name = adrToStringWithPort(connection.source);
    const same = [...this.connections.values()].filter(
      (c) => c.registered && c !== connection && publicAddress(c.address) === quota
    );
    if (same.length >= MAX_SERVERS_PER_ADDRESS) {
      this.print(`> WARNING: can't register ${name} (max number of servers for this address)`);
      return;
    }

    for (let p = port; p < port + REGISTER_PORTS && p <= 0xffff; p++) {
      const address = { ...connection.source, port: p };
      const holder = this.connections.get(adrToStringWithPort(address));
      if (holder !== undefined && holder !== connection) continue;

      this.readdress(connection, address);
      connection.registered = true;
      this.save(connection);
      this.send(connection, { kind: 'registerResponse', address });
      this.print(`> ${name} registered as ${adrToStringWithPort(address)}`);
      return;
    }
    const last = port + REGISTER_PORTS - 1;
    this.print(`> WARNING: can't register ${name} (ports ${port} to ${last} are taken)`);
  }

  /**
   * A name looked up for a client, as Quake 3's client looks one up itself with `getaddrinfo`, and
   * answered with every address it has: those a server is registered at first, then IPv4 before
   * IPv6, as ioquake3's client picks when a name has both (`net_enabled` 3). A lookup that fails
   * is answered with why.
   */
  private async resolve(connection: Connection, name: string, port: number): Promise<void> {
    let found: LookupAddress[];
    try {
      found = await this.lookup(name);
    } catch (err) {
      const error = lookupError(err);
      this.send(connection, { kind: 'resolveResponse', name, port, addresses: [], error });
      return;
    }
    const addresses = found.flatMap(({ address }) => connectionAddress(address, port) ?? []);
    const rank = (adr: NetAdr) => {
      const registered = this.connections.get(adrToStringWithPort(adr))?.registered === true;
      return (registered ? 0 : 2) + (adr.type === NA.IP ? 0 : 1);
    };
    addresses.sort((a, b) => rank(a) - rank(b));
    this.send(connection, { kind: 'resolveResponse', name, port, addresses, error: null });
  }

  /** A connection gone: its address free, and its server off the list. */
  private disconnect(connection: Connection): void {
    const key = adrToStringWithPort(connection.address);
    if (this.connections.get(key) === connection) this.connections.delete(key);
    this.servers.remove(connection.address);
  }

  /** A connection's new address; a server listed under the old one is listed no more. */
  private readdress(connection: Connection, address: NetAdr): void {
    if (compareAdr(connection.address, address)) return;
    this.connections.delete(adrToStringWithPort(connection.address));
    this.servers.remove(connection.address);
    connection.address = address;
    this.connections.set(adrToStringWithPort(address), connection);
  }

  /** What the master knows of a connection, kept in its socket if the socket can carry it. */
  private save(connection: Connection): void {
    const { ws, source, address, registered } = connection;
    if (ws.serializeAttachment === undefined) return;
    const server = this.servers.get(address, this.seconds(), false);
    ws.serializeAttachment({ source, address, registered, server });
  }

  /**
   * An address for a new connection: its source, or the next port up that no live connection
   * goes by, so that a server registered on that port keeps it.
   */
  private unclaimed(source: NetAdr): NetAdr {
    let address = source;
    while (this.connections.has(adrToStringWithPort(address))) {
      address = { ...address, port: address.port === 0xffff ? 1 : address.port + 1 };
    }
    return address;
  }

  /**
   * A `getinfo` to a server: down a channel the master's own socket dials, or else down the
   * server's link as a datagram from the master, which the server answers the same way.
   */
  private sendGetInfo(to: NetAdr, data: Uint8Array): void {
    if (this.own !== null) this.own.socket.send(data, to);
    else this.sendTo(to, { kind: 'datagram', data: data as Uint8Array<ArrayBuffer> });
  }

  /** A frame the master's own socket sends: a signal to a server it has dialled. */
  private fromOwn(frame: MasterFrame): void {
    if (frame.kind !== 'signal' || frame.peer === null) return;
    this.sendTo(frame.peer, { kind: 'signal', peer: null, signal: frame.signal });
  }

  private sendTo(peer: NetAdr, frame: MasterFrame): void {
    const connection = this.connections.get(adrToStringWithPort(peer));
    if (connection !== undefined) this.send(connection, frame);
  }

  private send(connection: Connection, frame: MasterFrame): void {
    if (connection.ws.readyState === OPEN) connection.ws.send(encodeFrame(frame));
  }

  private overLimit(connection: Connection): boolean {
    return rateLimit(connection.bucket, RELAY_BURST, RELAY_PERIOD, Math.floor(this.now()));
  }

  /** dpmaster's `crt_time`: the master's clock in whole seconds, as its lists keep time. */
  private seconds(): number {
    return Math.floor(this.now() / 1000);
  }
}

/**
 * An address as Node writes one — a connection's, or a name's — as the master names it: IPv4 as
 * it is, IPv6 in its one spelling, and IPv4 mapped into IPv6, `::ffff:a.b.c.d`, as IPv4 again.
 *
 * @returns the address, or null for one with a scope or none at all
 */
export function connectionAddress(ip: string, port: number): NetAdr | null {
  if (parseIPv4(ip) !== null) return netadr(NA.IP, ip, port);
  const ip6 = parseIPv6(ip);
  if (ip6 === null) return null;
  const mapped = ip6.subarray(0, 12).every((byte, i) => byte === (i < 10 ? 0 : 0xff));
  if (mapped) return netadr(NA.IP, ip6.subarray(12).join('.'), port);
  return netadr(NA.IP6, formatIPv6(ip6), port);
}

/** Why a lookup failed: Node's code for `getaddrinfo`'s error, as `ENOTFOUND`, or its message. */
function lookupError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.message : String(err);
}
