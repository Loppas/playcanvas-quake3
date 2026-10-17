import { MAX_LOOPBACK } from './loopback';
import {
  decodeFrame,
  encodeFrame,
  type IceServer,
  type MasterFrame,
  type Resolved
} from './master-protocol';
import type { NetAdr } from './net';

/** The part of `WebSocket` a link uses: the browser's, `ws`'s in Node, or a test's. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(
    type: 'message',
    listener: (event: { type: string; data?: unknown }) => void
  ): void;
}

/** `WebSocket.CONNECTING` and `WebSocket.OPEN`. */
const CONNECTING = 0;
const OPEN = 1;

/**
 * One socket's connection to one master: the frames of `master-protocol.ts` over a WebSocket.
 *
 * The link keeps what the master says about the socket itself — its address and the ICE servers —
 * tells its owner the answers to what was asked of the master, and hands every other frame on.
 * Frames sent before the WebSocket opens wait for it, so that a server's first heartbeat and its
 * registration are not lost to the connect.
 */
export class MasterLink {
  /** The address the program names the master by, and that its datagrams come from. */
  readonly master: NetAdr;
  /** The socket's own address as the master knows it, or null before the master has said. */
  address: NetAdr | null = null;
  /** The STUN and TURN servers the master names for opening data channels. */
  iceServers: IceServer[] = [];
  /** Where every frame the link does not keep goes. */
  onFrame: ((frame: MasterFrame) => void) | null = null;
  /** Told the address the master grants a registration. */
  onRegistered: ((address: NetAdr) => void) | null = null;
  /** Told the master's answer to a name asked of it. */
  onResolved: ((answer: Resolved) => void) | null = null;

  private readonly ws: WebSocketLike;
  /** Frames sent while the WebSocket connects, oldest first. */
  private readonly pending: Uint8Array<ArrayBuffer>[] = [];

  /**
   * @param master - The address the program names the master by.
   * @param ws - The WebSocket to it, connecting or open.
   */
  constructor(master: NetAdr, ws: WebSocketLike) {
    this.master = { ...master };
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      for (const data of this.pending.splice(0)) ws.send(data);
    });
    ws.addEventListener('close', () => {
      this.pending.length = 0;
      this.address = null;
    });
    // A refused or broken connection says so here before it closes. The close is what counts, but
    // in Node `ws` throws an `error` that nobody hears, and would end the program with it.
    ws.addEventListener('error', () => {});
    ws.addEventListener('message', (event) => this.receive(event.data));
  }

  /**
   * A frame to the master. One sent while the link connects waits, up to the loopback's depth; one
   * sent once it has closed is lost, as a datagram to a master that is down would be.
   */
  send(frame: MasterFrame): void {
    const data = encodeFrame(frame);
    if (this.ws.readyState === OPEN) {
      this.ws.send(data);
    } else if (this.ws.readyState === CONNECTING) {
      // Kept past the call, so a copy: a datagram's sender goes on using its buffer.
      if (this.pending.length >= MAX_LOOPBACK) this.pending.shift();
      this.pending.push(data.slice());
    }
  }

  /** Claim `net_port` at the master, which answers with the address it grants. */
  register(port: number): void {
    this.send({ kind: 'register', port });
  }

  close(): void {
    this.ws.close();
  }

  private receive(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return;
    const frame = decodeFrame(new Uint8Array(data));
    if (frame === null) return;

    if (frame.kind === 'greeting') {
      this.address = frame.address;
      this.iceServers = frame.iceServers;
    } else if (frame.kind === 'registerResponse') {
      this.address = frame.address;
      this.onRegistered?.(frame.address);
    } else if (frame.kind === 'resolveResponse') {
      this.onResolved?.(frame);
    } else {
      this.onFrame?.(frame);
    }
  }
}
