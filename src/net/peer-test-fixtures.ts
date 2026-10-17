import { MasterLink, type WebSocketLike } from './master-link';
import { decodeFrame, encodeFrame, type IceServer, type MasterFrame } from './master-protocol';
import { compareAdr, NA, netadr, parseAdrWithPort, type NetAdr, type NetPacket } from './net';
import type { DataChannelLike } from './peer-socket';
import {
  createPeerSocket,
  type CHANNEL_INIT,
  type DescriptionInit,
  type PeerConnectionFactory,
  type PeerConnectionLike
} from './peer-signalling';

/**
 * WebRTC and a master in memory, for tests: peer connections that find each other through the
 * descriptions and candidates they swap, channels between them, and a master passing frames
 * between the WebSockets connected to it.
 *
 * As in a browser, whatever the fakes do reaches a listener a task later. The tasks wait in one
 * queue until a test turns it with {@link settle}.
 */

/** The fakes' tasks, oldest first. */
const tasks: (() => void)[] = [];

/**
 * Run the fakes' tasks and every task they queue, until none is left: whatever was in flight has
 * landed. Each runs after the promises the one before it settled, as a browser's next task does.
 */
export async function settle(): Promise<void> {
  for (let idle = 0; idle < 2; ) {
    await new Promise((resolve) => setImmediate(resolve));
    const task = tasks.shift();
    if (task === undefined) {
      idle++;
    } else {
      idle = 0;
      task();
    }
  }
}

/** A promise the fakes' next task keeps. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => tasks.push(resolve));
}

/** Listeners by event type, each event dispatched a task after it happens. */
class FakeEvents {
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(type, list);
  }

  /**
   * An event, a task from now.
   *
   * @param happen - What happens with it, in that task: the state it changes, and the event to
   *   dispatch, or null for none after all.
   */
  protected dispatch(type: string, happen: () => unknown = () => ({})): void {
    tasks.push(() => {
      const event = happen();
      if (event === null) return;
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    });
  }
}

/** Peer connections that connect to each other, and a switch for what ICE makes of them. */
export class FakeRtc {
  /** Every connection made, in order. */
  readonly connections: FakePeerConnection[] = [];
  /**
   * What ICE makes of two connections that have swapped everything: they connect, they fail, or
   * null, they go on checking for ever.
   */
  verdict: (a: FakePeerConnection, b: FakePeerConnection) => 'connected' | 'failed' | null = () =>
    'connected';

  /** The factory the signalling is given. */
  readonly create = (iceServers: IceServer[]): FakePeerConnection => {
    const pc = new FakePeerConnection(this, this.connections.length + 1, iceServers);
    this.connections.push(pc);
    return pc;
  };

  /**
   * ICE's verdict on two connections, once each has the other's description and a candidate: both
   * connect and their negotiated channels of one id open, or both fail.
   */
  check(pc: FakePeerConnection): void {
    const other = this.connections.find((c) => c.id === pc.remoteId);
    if (other === undefined || other.remoteId !== pc.id) return;
    const ready = (c: FakePeerConnection) =>
      c.connectionState === 'new' && c.local !== null && c.candidates > 0;
    if (!ready(pc) || !ready(other)) return;

    const verdict = this.verdict(pc, other);
    if (verdict === null) return;
    for (const c of [pc, other]) c.iceDone(verdict);
    if (verdict === 'failed') return;
    for (const channel of pc.channels) {
      const match = other.channels.find((c) => c.init.id === channel.init.id);
      if (match === undefined || !channel.init.negotiated || !match.init.negotiated) continue;
      channel.remote = match;
      match.remote = channel;
      channel.opened();
      match.opened();
    }
  }
}

export class FakePeerConnection extends FakeEvents implements PeerConnectionLike {
  readonly id: number;
  readonly iceServers: IceServer[];
  connectionState = 'new';
  readonly channels: FakeDataChannel[] = [];
  local: DescriptionInit | null = null;
  remote: DescriptionInit | null = null;
  /** Candidates added from the other end. */
  candidates = 0;
  private readonly rtc: FakeRtc;

  constructor(rtc: FakeRtc, id: number, iceServers: IceServer[]) {
    super();
    this.rtc = rtc;
    this.id = id;
    this.iceServers = iceServers;
  }

  /** The connection the remote description came from, or 0. */
  get remoteId(): number {
    return Number(this.remote?.sdp?.slice('fake '.length) ?? 0);
  }

  createDataChannel(_label: string, init: typeof CHANNEL_INIT): FakeDataChannel {
    const channel = new FakeDataChannel(init);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<DescriptionInit> {
    return { type: 'offer', sdp: `fake ${this.id}` };
  }

  async createAnswer(): Promise<DescriptionInit> {
    if (this.remote?.type !== 'offer') throw new Error('InvalidStateError: no remote offer');
    return { type: 'answer', sdp: `fake ${this.id}` };
  }

  async setLocalDescription(description: DescriptionInit): Promise<void> {
    if (this.connectionState === 'closed') throw new Error('InvalidStateError: closed');
    this.local = description;
    // One host candidate, then the end of gathering.
    this.trickle();
    this.dispatch('icecandidate', () => ({ candidate: null }));
  }

  /** A candidate gathered, as a server-reflexive one comes after the host's. */
  trickle(): void {
    const candidate = {
      candidate: `candidate:fake ${this.id}`,
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null
    };
    this.dispatch('icecandidate', () => ({ candidate }));
  }

  /** Two tasks long, as a browser's is not at once: a candidate added meanwhile finds none. */
  async setRemoteDescription(description: DescriptionInit): Promise<void> {
    if (this.connectionState === 'closed') throw new Error('InvalidStateError: closed');
    if (!description.sdp?.startsWith('fake ')) throw new Error('OperationError: bad description');
    await nextTask();
    await nextTask();
    this.remote = description;
    this.rtc.check(this);
  }

  /** Takes only the other end's candidate, as ICE takes only the remote ufrag's. */
  async addIceCandidate(candidate: { candidate: string }): Promise<void> {
    if (this.remote === null) throw new Error('InvalidStateError: no remote description');
    if (candidate.candidate !== `candidate:fake ${this.remoteId}`) {
      throw new Error('OperationError: unknown ufrag');
    }
    this.candidates++;
    this.rtc.check(this);
  }

  /** As a browser's: the channels close here with no event, and at the other end with one. */
  close(): void {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    for (const channel of this.channels) {
      channel.readyState = 'closed';
      channel.remote?.remoteClosed();
    }
  }

  /** ICE's verdict. */
  iceDone(state: 'connected' | 'failed'): void {
    this.connectionState = 'connecting';
    this.dispatch('connectionstatechange', () => {
      if (this.connectionState === 'closed') return null;
      this.connectionState = state;
      return {};
    });
  }
}

export class FakeDataChannel extends FakeEvents implements DataChannelLike {
  readyState = 'connecting';
  /** Blobs until the socket asks for ArrayBuffers, so that asking is what makes a message read. */
  binaryType = 'blob';
  readonly init: typeof CHANNEL_INIT;
  /** The other end, once open. */
  remote: FakeDataChannel | null = null;
  /** Every datagram sent down it. */
  readonly sent: Uint8Array<ArrayBuffer>[] = [];

  constructor(init: typeof CHANNEL_INIT) {
    super();
    this.init = init;
  }

  send(data: Uint8Array<ArrayBuffer>): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: not open');
    const copy = data.slice();
    this.sent.push(copy);
    this.remote?.arrive(copy);
  }

  close(): void {
    if (this.readyState === 'closed' || this.readyState === 'closing') return;
    this.readyState = 'closing';
    this.dispatch('close', () => {
      this.readyState = 'closed';
      return {};
    });
    this.remote?.remoteClosed();
  }

  opened(): void {
    this.dispatch('open', () => {
      if (this.readyState !== 'connecting') return null;
      this.readyState = 'open';
      return {};
    });
  }

  remoteClosed(): void {
    this.dispatch('close', () => {
      if (this.readyState === 'closed') return null;
      this.readyState = 'closed';
      return {};
    });
  }

  private arrive(data: Uint8Array<ArrayBuffer>): void {
    this.dispatch('message', () => {
      if (this.readyState !== 'open') return null;
      return { data: this.binaryType === 'arraybuffer' ? data.buffer : new Blob([data]) };
    });
  }
}

/** One WebSocket's end at the master. */
interface Connection {
  ip: string;
  /** The connection's source port. */
  port: number;
  /** The port the master granted, or null for a socket that has not registered. */
  registered: number | null;
  /** The master's own socket, whose frames name no address. */
  self: boolean;
  ws: FakeWebSocket;
}

/** A master in memory: greets, registers, and passes signals and relayed datagrams on. */
export class FakeMaster {
  /** The address the program names the master by. */
  readonly adr: NetAdr;
  /** What every greeting names. */
  iceServers: IceServer[] = [];
  /** Every datagram sent to the master itself. */
  readonly datagrams: NetPacket[] = [];
  /** Every frame the master read, and who sent it: null for the master's own socket. */
  readonly frames: { from: NetAdr | null; frame: MasterFrame }[] = [];
  /** Whether it takes connections. A master that is down refuses each, a task later. */
  up = true;
  /** The addresses each name has, in the order the master answers with them. */
  readonly names = new Map<string, string[]>();
  /** Whether it answers a name it was asked: one that doesn't leaves the client waiting. */
  answers = true;

  private readonly connections: Connection[] = [];
  private nextPort = 50000;

  /** @param host - The name the program knows the master by. */
  constructor(host = 'master.test') {
    this.adr = netadr(NA.IP, host, 27950);
  }

  /** A WebSocket from a machine at `ip`, which opens a task later and is then greeted. */
  connect(ip: string, options: { self?: boolean } = {}): FakeWebSocket {
    const connection = {
      ip,
      port: this.nextPort++,
      registered: null,
      self: options.self ?? false
    } as Connection;
    connection.ws = new FakeWebSocket(this, connection);
    if (!this.up) {
      connection.ws.refused();
      return connection.ws;
    }
    this.connections.push(connection);
    connection.ws.opened();
    this.sendFrame(connection, {
      kind: 'greeting',
      address: netadr(NA.IP, ip, connection.port),
      iceServers: this.iceServers
    });
    return connection.ws;
  }

  /** A datagram from the master itself to a socket. */
  sendDatagram(to: NetAdr, data: Uint8Array<ArrayBuffer>): void {
    this.send(to, { kind: 'datagram', data });
  }

  /** Any frame, to the socket at an address: for a test to say what a peer never would. */
  send(to: NetAdr, frame: MasterFrame): void {
    const connection = this.find(to);
    if (connection !== undefined) this.sendFrame(connection, frame);
  }

  /** The frames of one kind the master has read, in order. */
  read<K extends MasterFrame['kind']>(kind: K): Extract<MasterFrame, { kind: K }>[] {
    return this.frames
      .map(({ frame }) => frame)
      .filter((frame): frame is Extract<MasterFrame, { kind: K }> => frame.kind === kind);
  }

  /** A frame a socket sent, read a task later. */
  arrive(connection: Connection, data: Uint8Array): void {
    tasks.push(() => this.receive(connection, data));
  }

  disconnect(connection: Connection): void {
    const index = this.connections.indexOf(connection);
    if (index !== -1) this.connections.splice(index, 1);
  }

  /** The master goes down and comes back: every connection it had is closed from its end. */
  restart(): void {
    for (const connection of this.connections.splice(0)) connection.ws.lost();
  }

  private receive(connection: Connection, data: Uint8Array): void {
    if (!this.connections.includes(connection)) return;
    const frame = decodeFrame(data);
    if (frame === null) return;
    const from = this.addressOf(connection);
    this.frames.push({ from, frame });

    switch (frame.kind) {
      case 'register': {
        let port = frame.port;
        while (this.connections.some((c) => c.ip === connection.ip && c.registered === port)) {
          port++;
        }
        connection.registered = port;
        const address = netadr(NA.IP, connection.ip, port);
        this.sendFrame(connection, { kind: 'registerResponse', address });
        return;
      }
      case 'signal': {
        const to =
          frame.peer === null ? this.connections.find((c) => c.self) : this.find(frame.peer);
        if (to !== undefined) {
          this.sendFrame(to, { kind: 'signal', peer: from, signal: frame.signal });
        }
        return;
      }
      case 'relay': {
        const to = this.find(frame.peer);
        if (to !== undefined && from !== null) {
          this.sendFrame(to, { kind: 'relay', peer: from, data: frame.data });
        }
        return;
      }
      case 'datagram':
        this.datagrams.push({ from: from ?? netadr(NA.BAD), data: frame.data });
        return;
      case 'resolve': {
        if (!this.answers) return;
        const { name, port } = frame;
        const ips = this.names.get(name);
        const host = (ip: string) => (ip.includes(':') ? `[${ip}]` : ip);
        const addresses = (ips ?? []).map((ip) => parseAdrWithPort(`${host(ip)}:${port}`)!);
        const error = ips === undefined ? 'ENOTFOUND' : null;
        this.sendFrame(connection, { kind: 'resolveResponse', name, port, addresses, error });
        return;
      }
    }
  }

  private sendFrame(connection: Connection, frame: MasterFrame): void {
    connection.ws.arrive(encodeFrame(frame));
  }

  private addressOf(connection: Connection): NetAdr | null {
    if (connection.self) return null;
    return netadr(NA.IP, connection.ip, connection.registered ?? connection.port);
  }

  private find(adr: NetAdr): Connection | undefined {
    return this.connections.find((c) => {
      const address = this.addressOf(c);
      return address !== null && compareAdr(address, adr);
    });
  }
}

/** A socket's end of its WebSocket to a {@link FakeMaster}. */
export class FakeWebSocket extends FakeEvents implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  private readonly master: FakeMaster;
  private readonly connection: Connection;

  constructor(master: FakeMaster, connection: Connection) {
    super();
    this.master = master;
    this.connection = connection;
  }

  send(data: Uint8Array<ArrayBuffer>): void {
    if (this.readyState === 0) throw new Error('InvalidStateError: still connecting');
    if (this.readyState !== 1) return;
    this.master.arrive(this.connection, data.slice());
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.master.disconnect(this.connection);
    this.dispatch('close', () => {
      this.readyState = 3;
      return {};
    });
  }

  opened(): void {
    this.dispatch('open', () => {
      if (this.readyState !== 0) return null;
      this.readyState = 1;
      return {};
    });
  }

  /** Refused, as a connection to a master that is down is: an error, then the close. */
  refused(): void {
    this.dispatch('error');
    this.dispatch('close', () => {
      this.readyState = 3;
      return {};
    });
  }

  /** Closed from the master's end, a task later. */
  lost(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.dispatch('close', () => {
      this.readyState = 3;
      return {};
    });
  }

  /** A frame from the master, read as the WebSocket's binary type says when it lands. */
  arrive(data: Uint8Array): void {
    const copy = data.slice();
    this.dispatch('message', () => {
      if (this.readyState !== 1) return null;
      return { data: this.binaryType === 'arraybuffer' ? copy.buffer : new Blob([copy]) };
    });
  }
}

/** One end of a WebSocket in memory: the other end reads what it sends, a task later. */
export class FakeSocketEnd extends FakeEvents implements WebSocketLike {
  binaryType = 'blob';
  readyState: number;
  other: FakeSocketEnd | null = null;

  /** @param readyState - Open already, as a server's end is when it is handed over, or not. */
  constructor(readyState: number) {
    super();
    this.readyState = readyState;
  }

  send(data: Uint8Array<ArrayBuffer>): void {
    if (this.readyState === 0) throw new Error('InvalidStateError: still connecting');
    if (this.readyState === 1) this.other?.arrive(data.slice());
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.closed();
    this.other?.closed();
  }

  opened(): void {
    this.dispatch('open', () => {
      if (this.readyState !== 0) return null;
      this.readyState = 1;
      return {};
    });
  }

  /** The close, at this end, a task later. */
  private closed(): void {
    if (this.readyState < 2) this.readyState = 2;
    this.dispatch('close', () => {
      if (this.readyState === 3) return null;
      this.readyState = 3;
      return {};
    });
  }

  /** A message from the other end, read as this end's binary type says when it lands. */
  private arrive(data: Uint8Array<ArrayBuffer>): void {
    this.dispatch('message', () => {
      if (this.readyState !== 1) return null;
      return { data: this.binaryType === 'arraybuffer' ? data.buffer : new Blob([data]) };
    });
  }
}

/**
 * A WebSocket in memory: a client's end, which opens a task later, and a server's, open at once.
 */
export function webSocketPair(): { client: FakeSocketEnd; server: FakeSocketEnd } {
  const client = new FakeSocketEnd(0);
  const server = new FakeSocketEnd(1);
  client.other = server;
  server.other = client;
  client.opened();
  return { client, server };
}

/**
 * A program's socket at a {@link FakeMaster}: its link, its signalling and the socket itself.
 *
 * @param createPeerConnection - A {@link FakeRtc}'s, or a real library's.
 */
export function fakePeer(
  master: FakeMaster,
  createPeerConnection: PeerConnectionFactory,
  ip: string,
  options: { dials: boolean; now?: () => number; self?: boolean }
) {
  const link = new MasterLink(master.adr, master.connect(ip, { self: options.self }));
  const { socket, signalling } = createPeerSocket({
    links: [link],
    createPeerConnection,
    dials: options.dials,
    now: options.now
  });
  return { link, socket, signalling };
}
