import { MasterLink } from '../src/net/master-link';
import { formatIPv6, NA, netadr, type NetPacket } from '../src/net/net';
import { createPeerSocket, type PeerConnectionFactory } from '../src/net/peer-signalling';
import type { PeerSocket } from '../src/net/peer-socket';
import { FakeSocketEnd, webSocketPair } from '../src/net/peer-test-fixtures';
import type { ConnectionRecord, MasterServer, MasterWebSocket } from './master-server';

/**
 * Programs at a {@link MasterServer} for tests, each a socket over a WebSocket in memory, and the
 * master's lists read back.
 */

/** The name the test programs know the master by. */
export const MASTER_ADR = netadr(NA.IP, 'master.test', 27950);

/** The source port of the next connection a test makes without naming one. */
let nextPort = 50000;

/**
 * The master's end of a WebSocket that holds a record, as a Durable Object's does under
 * Cloudflare's hibernation API: a structured clone of the record last kept, so that a change the
 * master does not write again is lost, as it would be there.
 */
export class RecordedEnd extends FakeSocketEnd implements MasterWebSocket {
  record: ConnectionRecord | null = null;

  /** An end that takes `end`'s place on its connection, cutting `end` off. */
  constructor(end: FakeSocketEnd) {
    super(end.readyState);
    this.other = end.other;
    if (end.other !== null) end.other.other = this;
    end.other = null;
  }

  serializeAttachment(record: ConnectionRecord): void {
    this.record = structuredClone(record);
  }

  /**
   * The connection as an object woken from hibernation is given it: the same, at a new end that
   * nothing listens to yet, holding this end's record.
   */
  woken(): RecordedEnd {
    const end = new RecordedEnd(this);
    end.record = this.record;
    return end;
  }
}

/**
 * A program's socket at a master: its link, its signalling, the socket itself, its end of the
 * WebSocket, and the master's end if that holds a record.
 *
 * @param ip - Where its connection comes from, as Node writes it.
 * @param options.port - Its connection's source port, if the test needs one.
 * @param options.recorded - Whether the master's end holds a record ({@link RecordedEnd}).
 */
export function masterPeer(
  master: MasterServer,
  createPeerConnection: PeerConnectionFactory,
  ip: string,
  options: { dials: boolean; port?: number; now?: () => number; recorded?: boolean }
) {
  const { client, server } = webSocketPair();
  const recorded = options.recorded === true ? new RecordedEnd(server) : null;
  master.connect(recorded ?? server, ip, options.port ?? nextPort++);
  const link = new MasterLink(MASTER_ADR, client);
  const { socket, signalling } = createPeerSocket({
    links: [link],
    createPeerConnection,
    dials: options.dials,
    now: options.now
  });
  return { link, socket, signalling, ws: client, recorded };
}

/** Text behind the out-of-band marker, a byte to a character. */
export function oob(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(`\xff\xff\xff\xff${text}`, (c) => c.charCodeAt(0));
}

/** A datagram as text, a byte to a character. */
export function text(data: Uint8Array): string {
  return String.fromCharCode(...data);
}

/** Everything waiting at a socket: who sent each datagram, and what, whenever it landed. */
export function read(socket: PeerSocket): NetPacket[] {
  const packets: NetPacket[] = [];
  for (let p; (p = socket.receive()) !== null; ) packets.push({ from: p.from, data: p.data });
  return packets;
}

/**
 * The servers in a `getserversResponse` or `getserversExtResponse`, as `ip:port` and
 * `[ip]:port`, or null when the reply is not one. The reply's last entry is followed by
 * `\EOT\0\0\0`, or by nothing when the reply is full.
 */
export function readList(data: Uint8Array): string[] | null {
  const reply = text(data);
  const header = /^\xff\xff\xff\xffgetservers(Ext)?Response/.exec(reply);
  if (header === null) return null;

  const servers: string[] = [];
  let at = header[0].length;
  while (at < data.length) {
    if (reply.startsWith('\\EOT\0\0\0', at) && at + 7 === data.length) break;
    const ip6 = data[at] === 0x2f;
    const size = ip6 ? 16 : 4;
    const ip = data.subarray(at + 1, at + 1 + size);
    const port = (data[at + 1 + size] << 8) | data[at + 2 + size];
    servers.push(ip6 ? `[${formatIPv6(ip)}]:${port}` : `${ip.join('.')}:${port}`);
    at += 3 + size;
  }
  return servers;
}
