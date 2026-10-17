import { adrToStringWithPort, type DatagramSocket, type NetAdr, type NetPacket } from './net';

/**
 * A socket over WebRTC data channels, one to each peer, each unordered and never resent, so what
 * crosses is UDP's datagrams and the netchan runs above it as Quake 3's does.
 *
 * The socket only reads and writes channels. Opening them, and whatever must go before one is
 * open, is its route's: the peer connections and the master (`peer-signalling.ts`). The two halves
 * can live apart, because a peer connection can only be made in a page while a channel can be
 * handed to a worker, where a tab's server runs.
 */

/** How long a channel may carry nothing either way before it is closed. */
export const CHANNEL_IDLE_MSEC = 60000;

/**
 * How many datagrams the socket holds for the program before it loses the oldest, as a UDP
 * socket's buffer fills while its program is not reading.
 */
export const MAX_INCOMING = 1024;

/** The part of `RTCDataChannel` the socket uses: the browser's, node-datachannel's, or a test's. */
export interface DataChannelLike {
  readonly readyState: string;
  binaryType: string;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: 'open' | 'close', listener: () => void): void;
  addEventListener(
    type: 'message',
    listener: (event: { type: string; data?: unknown }) => void
  ): void;
}

/** What a socket asks of the half that opens its channels. */
export interface PeerRoute {
  /** A datagram for a peer with no open channel. */
  send(data: Uint8Array<ArrayBuffer>, to: NetAdr): void;
  /** The socket has let a peer's channel go: it closed, or it was idle. */
  hangUp(peer: NetAdr, channel: DataChannelLike): void;
}

/** What the half that opens channels hands a socket. */
export interface PeerSink {
  /** A channel to a peer, as soon as it is made: open or not yet. */
  attach(peer: NetAdr, channel: DataChannelLike): void;
  /** A datagram that came another way than a channel: through the master, or from it. */
  deliver(packet: NetPacket): void;
}

export interface PeerSocketOptions {
  route: PeerRoute;
  /** `Sys_Milliseconds`, which idleness is timed on. */
  now?: () => number;
}

/** A peer's channel, and when a packet last crossed it. */
interface Channel {
  peer: NetAdr;
  channel: DataChannelLike;
  lastPacket: number;
}

export class PeerSocket implements DatagramSocket, PeerSink {
  onArrival: (() => void) | null = null;

  private readonly route: PeerRoute;
  private readonly now: () => number;
  /** By address; a peer's newest channel replaces its last. */
  private readonly channels = new Map<string, Channel>();
  /** Arrived, oldest first. */
  private readonly incoming: NetPacket[] = [];

  constructor(options: PeerSocketOptions) {
    this.route = options.route;
    this.now = options.now ?? (() => performance.now());
  }

  send(data: Uint8Array, to: NetAdr): void {
    // A channel and a WebSocket take a view of an ArrayBuffer, which every datagram the port
    // makes is, though `Uint8Array` alone does not say so.
    const datagram = data as Uint8Array<ArrayBuffer>;
    const entry = this.channels.get(adrToStringWithPort(to));
    if (entry !== undefined && entry.channel.readyState === 'open') {
      try {
        entry.channel.send(datagram);
      } catch (err) {
        // A channel can read open after its peer has gone, until its transport notices (some 20 s
        // in node-datachannel), and the send that finds out throws. The channel is let go.
        this.detach(entry);
        throw err;
      }
      entry.lastPacket = this.now();
      return;
    }
    this.route.send(datagram, to);
  }

  /** Whether a channel to the peer is open, so that what is sent to it goes straight there. */
  isOpen(peer: NetAdr): boolean {
    return this.channels.get(adrToStringWithPort(peer))?.channel.readyState === 'open';
  }

  /** The next datagram, or null; channels idle too long are closed once all are read. */
  receive(): NetPacket | null {
    const packet = this.incoming.shift();
    if (packet !== undefined) return packet;
    this.closeIdle();
    return null;
  }

  attach(peer: NetAdr, channel: DataChannelLike): void {
    const entry: Channel = { peer: { ...peer }, channel, lastPacket: this.now() };
    this.channels.set(adrToStringWithPort(peer), entry);

    channel.binaryType = 'arraybuffer';
    channel.addEventListener('message', (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      entry.lastPacket = this.now();
      this.deliver({ from: { ...entry.peer }, data: new Uint8Array(event.data) });
    });
    channel.addEventListener('close', () => this.detach(entry));
  }

  deliver(packet: NetPacket): void {
    if (this.incoming.length >= MAX_INCOMING) this.incoming.shift();
    this.incoming.push({ ...packet, time: this.now() });
    this.onArrival?.();
  }

  /** Forget a channel that has gone, unless a newer one to the peer has replaced it already. */
  private detach(entry: Channel): void {
    const key = adrToStringWithPort(entry.peer);
    if (this.channels.get(key) !== entry) return;
    this.channels.delete(key);
    this.route.hangUp(entry.peer, entry.channel);
  }

  private closeIdle(): void {
    const now = this.now();
    for (const entry of this.channels.values()) {
      if (now - entry.lastPacket < CHANNEL_IDLE_MSEC) continue;
      entry.channel.close();
      this.detach(entry);
    }
  }
}
