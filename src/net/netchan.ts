import { MAX_MSGLEN, Message } from './msg';
import { adrToString, NA, netadr, type Net, type NetAdr, type NetSrc } from './net';

/**
 * The netchan — Quake 3's `net_chan.c:20–416`: one connection's sequenced packets, over datagrams
 * that can be lost, repeated or reordered on the way.
 *
 * It makes nothing reliable. It numbers each message, so the far end throws away anything no newer
 * than what it has already taken and counts what went missing, and it cuts a message too long for
 * one datagram into fragments and puts it back together. Reliability is built above it, by
 * resending whatever has not been acknowledged.
 *
 * The header, as protocol 71 writes it, before the message itself:
 *
 * - 4 bytes: the sequence, with the top bit set on a fragment;
 * - 2 bytes: the qport, on a client's packets only;
 * - 4 bytes: a checksum of the sequence against the connection's challenge;
 * - 2 bytes each: a fragment's start and length, on fragments only.
 */

/** `MAX_PACKETLEN` (`net_chan.c:50`): the most one datagram carries. */
export const MAX_PACKETLEN = 1400;

/**
 * `FRAGMENT_SIZE` (`net_chan.c:52`): a message this long or longer goes as fragments of this size,
 * the last shorter. One that divides exactly is closed by an empty fragment, since a full one is
 * how the far end knows another follows.
 *
 * Quake 3's is `MAX_PACKETLEN - 100`, 1300. A data channel carries about 1150 bytes in one SCTP
 * packet (1191-byte packets in Chrome and Firefox, 1184 in libdatachannel), and on a channel that
 * never resends, a datagram split across two packets is lost with either, so a fragment and its
 * header must fit in one.
 */
export const FRAGMENT_SIZE = 1100;

/** `FRAGMENT_BIT` (`net_chan.c:55`). */
const FRAGMENT_BIT = 1 << 31;

/**
 * `NETCHAN_GENCHECKSUM` (`qcommon.h:191`): what a packet's sequence must agree with, so that one
 * sent from another address in this connection's name is thrown away.
 */
export function netchanChecksum(challenge: number, sequence: number): number {
  return challenge ^ Math.imul(sequence, challenge);
}

/** A message the netchan has taken in, whole. */
export interface NetchanMessage {
  /** Its sequence, which the receiver acknowledges and a delta is measured by. */
  sequence: number;
  /** The message, after the header. */
  data: Uint8Array;
}

/** `netchan_t` (`qcommon.h:197–224`). */
export class Netchan {
  /** Which side of the connection this end is: a client writes the qport, a server reads it. */
  sock: NetSrc = 'client';
  remoteAddress: NetAdr = netadr(NA.BAD);
  /** The client's qport: `net_qport` at the client, and what its connect said at the server. */
  qport = 0;
  challenge = 0;

  /** `dropped`: how many sequences were skipped before the last one taken in. */
  dropped = 0;
  /** The newest sequence taken in. */
  incomingSequence = 0;
  /** The sequence the next message goes out with. */
  outgoingSequence = 1;

  /** The message being put back together, and how much of it has arrived. */
  private fragmentSequence = 0;
  private fragmentLength = 0;
  private readonly fragmentBuffer = new Uint8Array(MAX_MSGLEN);

  /** Whether a message is part sent, with fragments still to go. */
  unsentFragments = false;
  private unsentFragmentStart = 0;
  private unsentLength = 0;
  private readonly unsentBuffer = new Uint8Array(MAX_MSGLEN);

  /**
   * The datagram every packet's header is written into, reused for all of them. What {@link send}
   * hands the net is copied on its way out, so the buffer is free the moment the packet has gone.
   */
  private readonly sendBuffer = new Message(new Uint8Array(MAX_PACKETLEN), true);

  /** When the last datagram went out, on the {@link Net}'s clock, and its size. */
  lastSentTime = 0;
  lastSentSize = 0;

  /** What the datagrams go out through. */
  private readonly net: Net;

  constructor(net: Net) {
    this.net = net;
  }

  /** `Netchan_Setup` (`net_chan.c:86–102`): a channel to an address, from the start. */
  setup(sock: NetSrc, adr: NetAdr, qport: number, challenge: number): void {
    this.sock = sock;
    this.remoteAddress = { ...adr };
    this.qport = qport;
    this.challenge = challenge;
    this.dropped = 0;
    this.incomingSequence = 0;
    this.outgoingSequence = 1;
    this.fragmentSequence = 0;
    this.fragmentLength = 0;
    this.unsentFragments = false;
    this.unsentFragmentStart = 0;
    this.unsentLength = 0;
    this.lastSentTime = 0;
    this.lastSentSize = 0;
  }

  /**
   * `Netchan_Transmit` (`net_chan.c:177–233`): send a message, or the first fragment of one too
   * long for a datagram. An empty message is still a packet.
   */
  transmit(data: Uint8Array): void {
    if (data.length > MAX_MSGLEN) throw new Error(`Netchan_Transmit: length = ${data.length}`);

    this.unsentFragmentStart = 0;

    if (data.length >= FRAGMENT_SIZE) {
      this.unsentFragments = true;
      this.unsentLength = data.length;
      this.unsentBuffer.set(data);
      this.transmitNextFragment();
      return;
    }

    const send = this.header(this.outgoingSequence);
    this.outgoingSequence++;
    send.writeData(data);
    this.send(send);

    if (this.net.showpackets) {
      const sent = this.outgoingSequence - 1;
      this.net.print(
        `${this.sock} send ${pad(send.curSize)} : s=${sent} ack=${this.incomingSequence}`
      );
    }
  }

  /** `Netchan_TransmitNextFragment` (`net_chan.c:109–170`): the next fragment of a message. */
  transmitNextFragment(): void {
    const send = this.header(this.outgoingSequence | FRAGMENT_BIT);

    const start = this.unsentFragmentStart;
    const length = Math.min(FRAGMENT_SIZE, this.unsentLength - start);
    send.writeShort(start);
    send.writeShort(length);
    send.writeData(this.unsentBuffer.subarray(start, start + length));
    this.send(send);

    if (this.net.showpackets) {
      const fragment = `${start},${length}`;
      this.net.print(
        `${this.sock} send ${pad(send.curSize)} : s=${this.outgoingSequence} fragment=${fragment}`
      );
    }

    this.unsentFragmentStart += length;
    // A fragment that fills its size says another follows, so a message ending exactly on one goes
    // on to an empty fragment before it is done.
    if (this.unsentFragmentStart === this.unsentLength && length !== FRAGMENT_SIZE) {
      this.outgoingSequence++;
      this.unsentFragments = false;
    }
  }

  /**
   * `Netchan_Process` (`net_chan.c:244–404`): a packet that arrived on this connection.
   *
   * @returns the message, or null when there is nothing to act on: an old or repeated packet, one
   *   that fails the checksum, or a fragment of a message that is not complete yet
   */
  process(packet: Uint8Array): NetchanMessage | null {
    const msg = Message.read(packet);
    msg.beginReading(true);

    let sequence = msg.readLong();
    const fragmented = (sequence & FRAGMENT_BIT) !== 0;
    if (fragmented) sequence &= ~FRAGMENT_BIT;

    if (this.sock === 'server') msg.readShort();

    if (msg.readLong() !== netchanChecksum(this.challenge, sequence)) return null;

    let fragmentStart = 0;
    let fragmentLength = 0;
    if (fragmented) {
      fragmentStart = msg.readShort();
      fragmentLength = msg.readShort();
    }

    if (this.net.showpackets) {
      const fragment = fragmented ? ` fragment=${fragmentStart},${fragmentLength}` : '';
      this.net.print(`${this.sock} recv ${pad(packet.length)} : s=${sequence}${fragment}`);
    }

    const verbose = this.net.showdrop || this.net.showpackets;
    const from = adrToString(this.remoteAddress);

    if (sequence <= this.incomingSequence) {
      if (verbose) {
        this.net.print(`${from}:Out of order packet ${sequence} at ${this.incomingSequence}`);
      }
      return null;
    }

    // Dropped packets don't keep the message from being used.
    this.dropped = sequence - (this.incomingSequence + 1);
    if (this.dropped > 0 && verbose) {
      this.net.print(`${from}:Dropped ${this.dropped} packets at ${sequence}`);
    }

    if (!fragmented) {
      this.incomingSequence = sequence;
      return { sequence, data: packet.subarray(msg.readCount) };
    }

    // Fragments are put back together only in order. One that arrives out of it starts the
    // message over or is thrown away, and the sender's next copy of the message is waited for.
    if (sequence !== this.fragmentSequence) {
      this.fragmentSequence = sequence;
      this.fragmentLength = 0;
    }

    if (fragmentStart !== this.fragmentLength) {
      if (verbose) this.net.print(`${from}:Dropped a message fragment`);
      return null;
    }

    if (
      fragmentLength < 0 ||
      msg.readCount + fragmentLength > msg.curSize ||
      this.fragmentLength + fragmentLength > this.fragmentBuffer.length
    ) {
      if (verbose) this.net.print(`${from}:illegal fragment length`);
      return null;
    }

    this.fragmentBuffer.set(
      packet.subarray(msg.readCount, msg.readCount + fragmentLength),
      this.fragmentLength
    );
    this.fragmentLength += fragmentLength;

    if (fragmentLength === FRAGMENT_SIZE) return null;

    const data = this.fragmentBuffer.slice(0, this.fragmentLength);
    this.fragmentLength = 0;
    this.incomingSequence = sequence;
    return { sequence, data };
  }

  /** The header every packet starts with, as far as the fragment's own fields. */
  private header(sequence: number): Message {
    const send = this.sendBuffer;
    send.clear();
    send.writeLong(sequence);
    if (this.sock === 'client') send.writeShort(this.qport);
    send.writeLong(netchanChecksum(this.challenge, this.outgoingSequence));
    return send;
  }

  private send(send: Message): void {
    this.net.sendPacket(this.sock, send.written, this.remoteAddress);
    this.lastSentTime = this.net.now();
    this.lastSentSize = send.curSize;
  }
}

/** `%4i`. */
function pad(n: number): string {
  return String(n).padStart(4);
}
