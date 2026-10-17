import type { CvarStore } from '../net/cvar';
import type { WebSocketLike } from '../net/master-link';
import { ServerMasters } from '../net/masters';
import { adrToStringWithPort, type NetAdr, type NetPacket } from '../net/net';
import { PeerSignalling, type PeerConnectionFactory } from '../net/peer-signalling';
import type { DataChannelLike, PeerSink } from '../net/peer-socket';
import type { PageToWorker } from './worker-messages';

/**
 * A tab's listen server, the page's half of its socket: the peer connections, which only a page
 * can make, and the masters, over which the server registers and is signalled. Each channel is
 * moved to the worker in the task that made it; the worker's socket sends and reads it there, and
 * what it cannot send down one comes back here to be routed (`worker-server.ts`).
 *
 * The page holds a Web Lock while it hosts. A tab whose data channels have all gone to a worker no
 * longer counts as using WebRTC to Chrome, which is what keeps a hidden tab from being frozen; a
 * held lock keeps it too.
 */

/**
 * How often the masters' connections are seen to: on a page timer, which a hidden tab still runs
 * about once a second, where its frames stop.
 */
export const MASTERS_FRAME_MSEC = 1000;

/** The Web Lock's name. Shared, so that every tab hosting holds it at once. */
const LOCK_NAME = 'listen-server';

export interface HostPeersOptions {
  /** The page's store: the master slots and `net_port`, which the worker's mirrors. */
  cvars: CvarStore;
  /** A message to the worker, with what moves rather than copies. */
  post: (message: PageToWorker, transfer: Transferable[]) => void;
  /** The browser's `RTCPeerConnection`, or a test's. */
  createPeerConnection: PeerConnectionFactory;
  /** The browser's `WebSocket`, or a test's. */
  connect: (url: string) => WebSocketLike;
  /** `Sys_Milliseconds`, which a master's retries are timed on. */
  now: () => number;
  /** `Com_Printf`. */
  print: (text: string) => void;
  /** The page's Web Locks, or null where there are none. */
  locks?: LockManager | null;
  /**
   * Run the masters' frame every {@link MASTERS_FRAME_MSEC} until the returned stop is called; a
   * test runs it by hand.
   */
  schedule?: (frame: () => void) => () => void;
}

export class HostPeers implements PeerSink {
  private readonly post: HostPeersOptions['post'];
  private readonly signalling: PeerSignalling;
  private readonly masters: ServerMasters;
  private readonly stopFrames: () => void;
  /** Lets the Web Lock go, once it is held. */
  private releaseLock: (() => void) | null = null;
  private closed = false;
  /** The channels moved to the worker, by number, and each peer's latest number. */
  private readonly channels = new Map<number, DataChannelLike>();
  private readonly latest = new Map<string, number>();
  private nextId = 1;

  constructor(options: HostPeersOptions) {
    this.post = options.post;
    this.signalling = new PeerSignalling({
      links: [],
      socket: this,
      createPeerConnection: options.createPeerConnection,
      dials: false,
      now: options.now
    });
    this.masters = new ServerMasters({
      cvars: options.cvars,
      signalling: this.signalling,
      connect: options.connect,
      now: options.now,
      print: options.print
    });
    this.masters.frame();
    const schedule = options.schedule ?? everySecond;
    this.stopFrames = schedule(() => this.masters.frame());
    this.holdLock(options.locks ?? globalThis.navigator?.locks ?? null);
  }

  /** A peer's channel, moved to the worker at once, while it still can be. */
  attach(peer: NetAdr, channel: DataChannelLike): void {
    const id = this.nextId++;
    const key = adrToStringWithPort(peer);
    const older = this.latest.get(key);
    if (older !== undefined) this.channels.delete(older);
    this.latest.set(key, id);
    this.channels.set(id, channel);
    // An `RTCDataChannel` is transferable where the worker can take one, which is the only place
    // this runs; the interface says only what the socket uses of it.
    this.post({ type: 'channel', id, peer, channel }, [channel as unknown as Transferable]);
  }

  /** A datagram that came through a master, for the worker's socket. */
  deliver(packet: NetPacket): void {
    this.post({ type: 'deliver', from: packet.from, data: packet.data }, []);
  }

  /** The worker's datagram for a peer with no open channel. */
  route(data: Uint8Array, to: NetAdr): void {
    // Every datagram the port makes is a view of an ArrayBuffer, which the frames take.
    this.signalling.send(data as Uint8Array<ArrayBuffer>, to);
  }

  /**
   * The worker has let a channel go. The number names the channel the page moved, so a hang-up
   * that crossed a newer connection on its way closes only the one it meant.
   */
  hangUp(id: number, peer: NetAdr): void {
    const channel = this.channels.get(id);
    if (channel === undefined) return;
    this.channels.delete(id);
    this.signalling.hangUp(peer, channel);
  }

  /** The server has said its last: the masters, the peers and the lock go. */
  close(): void {
    this.closed = true;
    this.stopFrames();
    this.masters.close();
    this.signalling.close();
    this.releaseLock?.();
    this.releaseLock = null;
  }

  private holdLock(locks: LockManager | null): void {
    if (locks === null) return;
    // The lock is held until the callback's promise settles.
    void locks.request(LOCK_NAME, { mode: 'shared' }, () =>
      new Promise<void>((release) => {
        if (this.closed) release();
        else this.releaseLock = release;
      })
    );
  }
}

/** The page's own timer, which goes on at a second or so in a hidden tab. */
function everySecond(frame: () => void): () => void {
  const timer = setInterval(frame, MASTERS_FRAME_MSEC);
  return () => clearInterval(timer);
}
