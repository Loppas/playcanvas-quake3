import { tokenize } from '../formats/q3config';
import { MAX_LOOPBACK } from './loopback';
import type { IceCandidate, IceServer, MasterFrame, Signal } from './master-protocol';
import { Message } from './msg';
import { adrToStringWithPort, compareAdr, isOutOfBand, type NetAdr } from './net';
import { PeerSocket, type DataChannelLike, type PeerRoute, type PeerSink } from './peer-socket';

/**
 * The half of a peer socket that opens its channels (`peer-socket.ts`): a peer connection to each
 * peer, signalled through the masters, and whatever the socket cannot send down a channel.
 *
 * Every connection is to an address a master knows, and every signal goes through a master: a
 * dial's offer and candidates go to each master until one of them brings back the peer's answer.
 * The dialling end offers and the other answers, and a new offer from a peer replaces whatever
 * connection there was with it, since the peer has given that one up.
 */

/** How long a dial waits for its answer before the next datagram for the peer dials again. */
export const ANSWER_MSEC = 3000;

/**
 * `RTCDataChannelInit` for the one channel on each connection: UDP's semantics. Both ends make it,
 * so it needs no negotiation of its own and can be handed to a worker in the task that made it.
 */
export const CHANNEL_INIT = { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 };

/** `RTCSessionDescriptionInit`, as a peer connection makes and takes one. */
export interface DescriptionInit {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

/**
 * The part of `RTCPeerConnection` the signalling uses: the browser's, node-datachannel's, or a
 * test's.
 */
export interface PeerConnectionLike {
  readonly connectionState: string;
  createDataChannel(label: string, init: typeof CHANNEL_INIT): DataChannelLike;
  createOffer(): Promise<DescriptionInit>;
  createAnswer(): Promise<DescriptionInit>;
  setLocalDescription(description: DescriptionInit): Promise<void>;
  setRemoteDescription(description: DescriptionInit): Promise<void>;
  addIceCandidate(candidate: IceCandidate): Promise<void>;
  close(): void;
  addEventListener(
    type: 'icecandidate',
    listener: (event: { type: string; candidate?: IceCandidate | null }) => void
  ): void;
  addEventListener(type: 'connectionstatechange', listener: () => void): void;
}

/** A new peer connection, gathering through the ICE servers given. */
export type PeerConnectionFactory = (iceServers: IceServer[]) => PeerConnectionLike;

/**
 * The part of a way to a master the signalling uses: a socket's `MasterLink`, or the master's
 * own way to itself.
 */
export interface SignallingLink {
  /** The address the program names the master by. */
  readonly master: NetAdr;
  /** The STUN and TURN servers the master names. */
  readonly iceServers: IceServer[];
  /** Where the master's frames go that are not about the socket itself. */
  onFrame: ((frame: MasterFrame) => void) | null;
  send(frame: MasterFrame): void;
}

export interface PeerSignallingOptions {
  /** The masters at the start: the ways to the peers each of them knows. */
  links: SignallingLink[];
  /** Where channels go as they are made, and datagrams that came through a master. */
  socket: PeerSink;
  createPeerConnection: PeerConnectionFactory;
  /**
   * Whether a datagram for a peer with no channel dials one. A client's socket does; a server's
   * never does, and drops the datagram.
   */
  dials: boolean;
  /**
   * Whether a query for a peer with no channel goes through the masters, which every socket's does
   * but the master's own: the master is the relay, and dials instead. True unless given.
   */
  relays?: boolean;
  /** `Sys_Milliseconds`, which a dial's wait for its answer is timed on. */
  now?: () => number;
}

/** A connection to one peer, from its first signal to its close. */
interface Peer {
  adr: NetAdr;
  pc: PeerConnectionLike;
  channel: DataChannelLike;
  /** The dialling end's number for this dial. */
  dial: number;
  /** The master the peer's signals come through, or null while a dial goes to every master. */
  link: SignallingLink | null;
  /** This end dialled, rather than answered. */
  dialled: boolean;
  answered: boolean;
  /** When this end began it. */
  started: number;
  /** Datagrams waiting for the channel to open, oldest first. */
  held: Uint8Array<ArrayBuffer>[];
  /** The connection's operations in order, since a description must be set before a candidate. */
  ops: Promise<void>;
}

/**
 * The connectionless messages that go through the master to a peer with no channel open: the
 * questions a server answers anyone, and their answers.
 */
const QUERIES = new Set(['getinfo', 'getstatus', 'inforesponse', 'statusresponse']);

export class PeerSignalling implements PeerRoute {
  private readonly links: SignallingLink[] = [];
  private readonly socket: PeerSink;
  private readonly createPeerConnection: PeerConnectionFactory;
  private readonly dials: boolean;
  private readonly relays: boolean;
  private readonly now: () => number;
  /** By address. */
  private readonly peers = new Map<string, Peer>();
  private nextDial = 1;

  constructor(options: PeerSignallingOptions) {
    this.socket = options.socket;
    this.createPeerConnection = options.createPeerConnection;
    this.dials = options.dials;
    this.relays = options.relays ?? true;
    this.now = options.now ?? (() => performance.now());
    for (const link of options.links) this.addLink(link);
  }

  /** A master to signal and relay through from now on. */
  addLink(link: SignallingLink): void {
    this.links.push(link);
    link.onFrame = (frame) => this.frame(link, frame);
  }

  /** A master no longer to be used. A connection it signalled keeps what it has. */
  removeLink(link: SignallingLink): void {
    const index = this.links.indexOf(link);
    if (index !== -1) this.links.splice(index, 1);
    link.onFrame = null;
  }

  /**
   * A datagram for a peer the socket has no open channel to. One for a master goes to it, and a
   * query or its answer goes to every master, for the one that knows the peer to pass on, if this
   * end relays. Anything else waits for a channel, up to the loopback's depth, if this end dials.
   */
  send(data: Uint8Array<ArrayBuffer>, to: NetAdr): void {
    const master = this.links.find((link) => compareAdr(link.master, to));
    if (master !== undefined) {
      master.send({ kind: 'datagram', data });
      return;
    }
    if (this.relays && isQuery(data)) {
      for (const link of this.links) link.send({ kind: 'relay', peer: to, data });
      return;
    }
    if (!this.dials) return;

    const peer = this.dialPeer(to);
    if (peer.held.length >= MAX_LOOPBACK) peer.held.shift();
    peer.held.push(data.slice());
  }

  hangUp(peer: NetAdr, channel: DataChannelLike): void {
    const current = this.peers.get(adrToStringWithPort(peer));
    if (current?.channel === channel) this.drop(current);
  }

  /** Open a channel to a peer, unless one is open or on its way. */
  dial(to: NetAdr): void {
    this.dialPeer(to);
  }

  /** Close every connection. */
  close(): void {
    for (const peer of [...this.peers.values()]) this.drop(peer);
  }

  /** The peer's connection, or a new dial if there is none or its offer has gone unanswered. */
  private dialPeer(to: NetAdr): Peer {
    const current = this.peers.get(adrToStringWithPort(to));
    if (current !== undefined) {
      const unanswered = current.dialled && !current.answered;
      if (!unanswered || this.now() - current.started < ANSWER_MSEC) return current;
      this.drop(current);
    }

    const peer = this.connect(to, null, this.nextDial++, null);
    this.describe(peer, () => peer.pc.createOffer());
    return peer;
  }

  /** A frame from a master that is not about the socket itself. */
  private frame(link: SignallingLink, frame: MasterFrame): void {
    switch (frame.kind) {
      case 'datagram':
        this.socket.deliver({ from: { ...link.master }, data: frame.data });
        return;
      case 'relay':
        this.socket.deliver({ from: frame.peer, data: frame.data });
        return;
      case 'signal':
        this.signalled(link, frame.peer ?? link.master, frame.signal);
        return;
    }
  }

  private signalled(link: SignallingLink, from: NetAdr, signal: Signal): void {
    const { description, candidate } = signal;
    const current = this.peers.get(adrToStringWithPort(from));

    if (description?.type === 'offer') {
      if (current !== undefined) this.drop(current);
      const peer = this.connect(from, link, signal.dial, description);
      this.describe(peer, () => peer.pc.createAnswer());
      return;
    }
    // A signal for a dial given up, or for none.
    if (current === undefined || current.dial !== signal.dial) return;

    if (description !== undefined) {
      if (!current.dialled || current.answered) return;
      current.answered = true;
      current.link = link;
      this.step(current, () => current.pc.setRemoteDescription(description));
    } else if (candidate !== undefined) {
      // A candidate the connection cannot use, as one naming a host it cannot resolve, leaves the
      // rest to try.
      current.ops = current.ops.then(() => current.pc.addIceCandidate(candidate)).catch(() => {});
    }
  }

  /**
   * A connection and its channel, handed to the socket at once. An answering end sets the offer
   * before it makes its channel: node-datachannel offers of its own when a channel is made on a
   * connection with no remote description, and would have to roll that offer back.
   */
  private connect(
    adr: NetAdr,
    link: SignallingLink | null,
    dial: number,
    offer: DescriptionInit | null
  ): Peer {
    const pc = this.createPeerConnection(this.links.flatMap((l) => l.iceServers));
    const described = offer === null ? Promise.resolve() : pc.setRemoteDescription(offer);
    const channel = pc.createDataChannel('', CHANNEL_INIT);
    const peer: Peer = {
      adr: { ...adr },
      pc,
      channel,
      dial,
      link,
      dialled: offer === null,
      answered: false,
      started: this.now(),
      held: [],
      ops: described
    };
    this.peers.set(adrToStringWithPort(adr), peer);

    pc.addEventListener('icecandidate', ({ candidate: found }) => {
      if (!found) return;
      const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = found;
      const init = { candidate, sdpMid, sdpMLineIndex, usernameFragment };
      this.signal(peer, { dial, candidate: init });
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') this.drop(peer);
    });
    channel.addEventListener('open', () => this.flush(peer));
    this.socket.attach(adr, channel);
    return peer;
  }

  /** This end's description, made, set and sent: the offer if it dialled, else the answer. */
  private describe(peer: Peer, make: () => Promise<DescriptionInit>): void {
    this.step(peer, async () => {
      const made = await make();
      await peer.pc.setLocalDescription(made);
      const type = peer.dialled ? 'offer' : 'answer';
      this.signal(peer, { dial: peer.dial, description: { type, sdp: made.sdp ?? '' } });
    });
  }

  /** The connection's next operation, after the last; one that fails ends the connection. */
  private step(peer: Peer, op: () => Promise<void>): void {
    peer.ops = peer.ops.then(op).catch(() => this.drop(peer));
  }

  /** A signal to the peer: through its master, or every master until one has answered. */
  private signal(peer: Peer, signal: Signal): void {
    for (const link of peer.link === null ? this.links : [peer.link]) {
      // A master's own frames name no address for it.
      const to = compareAdr(peer.adr, link.master) ? null : peer.adr;
      link.send({ kind: 'signal', peer: to, signal });
    }
  }

  /** What waited for the channel, now that it is open. */
  private flush(peer: Peer): void {
    for (const data of peer.held.splice(0)) peer.channel.send(data);
  }

  /** Close a connection, and forget it unless a newer one to the peer has replaced it. */
  private drop(peer: Peer): void {
    const key = adrToStringWithPort(peer.adr);
    if (this.peers.get(key) === peer) this.peers.delete(key);
    peer.pc.close();
  }
}

/**
 * A socket and the connections that open its channels, both in one program: a page's client, a
 * Node server, the master.
 */
export function createPeerSocket(options: Omit<PeerSignallingOptions, 'socket'>): {
  socket: PeerSocket;
  signalling: PeerSignalling;
} {
  const socket = new PeerSocket({
    now: options.now,
    route: {
      send: (data, to) => signalling.send(data, to),
      hangUp: (peer, channel) => signalling.hangUp(peer, channel)
    }
  });
  const signalling = new PeerSignalling({ ...options, socket });
  return { socket, signalling };
}

/** Whether a datagram is one of {@link QUERIES}, read as the host and the client read one. */
function isQuery(data: Uint8Array): boolean {
  if (!isOutOfBand(data)) return false;
  const msg = Message.read(data);
  msg.beginReading(true);
  msg.readLong();
  return QUERIES.has((tokenize(msg.readStringLine())[0] ?? '').toLowerCase());
}
