import { adrToStringWithPort, isOutOfBand, parseAdrWithPort, type NetAdr } from './net';

/**
 * What passes between a socket and the master on the master's WebSocket: one datagram to a binary
 * frame, each out of band (`\xff\xff\xff\xff` and a line of text), as Quake 3's traffic with its
 * master is.
 *
 * Most frames are dpmaster's own messages, carried byte for byte: `heartbeat`, `getservers` and
 * their answers
 * ([techinfo.txt](https://github.com/kphillisjr/dpmaster/blob/master/doc/techinfo.txt)). The rest
 * are the port's, because a browser has no UDP and no name lookup: the master tells a socket the
 * address it is known by and the ICE servers to use, a server claims its address, the master looks
 * a name up for a client, and it carries signals and datagrams between sockets that have no data
 * channel to each other. A frame's first line names the other end of those by address,
 * `[ip]:port` for IPv6, which the master rewrites from the recipient to the sender as it passes the
 * frame on.
 *
 * - `greeting <ip:port>\n{"iceServers":[…]}`, from the master: the socket's address and its ICE
 *   servers;
 * - `register <port>`, from a server: the port it asks for;
 * - `registerResponse <ip:port>`, from the master: the address it granted;
 * - `resolve\n{"name":…,"port":…}`, from a client: a name to look up, and the port to give its
 *   addresses;
 * - `resolveResponse\n{"name":…,"port":…,"addresses":[…],"error":…}`, from the master: the name's
 *   addresses, or none and why;
 * - `signal [<ip:port>]\n{…}`: an offer, an answer or an ICE candidate, with no address when the
 *   other end is the master itself;
 * - `relay <ip:port>\n<datagram>`: a connectionless datagram.
 */

/** `RTCIceServer`: a STUN or TURN server, as a peer connection is configured with. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** `RTCSessionDescriptionInit`, as a signal carries it. */
export interface SessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

/** `RTCIceCandidateInit`, as a signal carries it. */
export interface IceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

/** One step of opening a data channel: a description or a candidate, and whose dial it is. */
export interface Signal {
  /** The dialling end's count of its dials, which tells a signal for an abandoned one apart. */
  dial: number;
  description?: SessionDescription;
  candidate?: IceCandidate;
}

/** The master's answer to a name it was asked to look up. */
export interface Resolved {
  name: string;
  port: number;
  /** Every address the name has, with the port, in the order they are best tried. */
  addresses: NetAdr[];
  /** Why the lookup failed, or null. */
  error: string | null;
}

export type MasterFrame =
  /** Anything else: a datagram to the master itself, or from it. */
  | { kind: 'datagram'; data: Uint8Array<ArrayBuffer> }
  | { kind: 'greeting'; address: NetAdr; iceServers: IceServer[] }
  | { kind: 'register'; port: number }
  | { kind: 'registerResponse'; address: NetAdr }
  | { kind: 'resolve'; name: string; port: number }
  | ({ kind: 'resolveResponse' } & Resolved)
  /** `peer` is null when the other end is the master itself. */
  | { kind: 'signal'; peer: NetAdr | null; signal: Signal }
  | { kind: 'relay'; peer: NetAdr; data: Uint8Array<ArrayBuffer> };

/** A frame as the bytes of one WebSocket message. */
export function encodeFrame(frame: MasterFrame): Uint8Array<ArrayBuffer> {
  switch (frame.kind) {
    case 'datagram':
      return frame.data;
    case 'greeting': {
      const line = `greeting ${adrToStringWithPort(frame.address)}`;
      return outOfBand(line, json({ iceServers: frame.iceServers }));
    }
    case 'register':
      return outOfBand(`register ${frame.port}`);
    case 'registerResponse':
      return outOfBand(`registerResponse ${adrToStringWithPort(frame.address)}`);
    case 'resolve':
      return outOfBand('resolve', json({ name: frame.name, port: frame.port }));
    case 'resolveResponse': {
      const { name, port, error } = frame;
      const addresses = frame.addresses.map(adrToStringWithPort);
      return outOfBand('resolveResponse', json({ name, port, addresses, error }));
    }
    case 'signal': {
      const line = frame.peer === null ? 'signal' : `signal ${adrToStringWithPort(frame.peer)}`;
      return outOfBand(line, json(frame.signal));
    }
    case 'relay':
      return outOfBand(`relay ${adrToStringWithPort(frame.peer)}`, frame.data);
  }
}

/**
 * A WebSocket message as a frame, or null for one that is not out of band or is one of the port's
 * own and malformed.
 */
export function decodeFrame(data: Uint8Array): MasterFrame | null {
  if (!isOutOfBand(data)) return null;

  const newline = data.indexOf(0x0a, 4);
  const lineEnd = newline === -1 ? data.length : newline;
  const words = new TextDecoder().decode(data.subarray(4, lineEnd)).split(' ');
  const payload = newline === -1 ? null : data.slice(newline + 1);

  switch (words[0]) {
    case 'greeting': {
      const address = parseAdrWithPort(words[1] ?? '');
      const body = parseJson(payload);
      const iceServers = isRecord(body) ? body.iceServers : undefined;
      if (address === null || !Array.isArray(iceServers) || !iceServers.every(isIceServer)) {
        return null;
      }
      return { kind: 'greeting', address, iceServers };
    }
    case 'register': {
      const port = Number(words[1]);
      if (!Number.isInteger(port) || port < 1 || port > 0xffff) return null;
      return { kind: 'register', port };
    }
    case 'registerResponse': {
      const address = parseAdrWithPort(words[1] ?? '');
      return address === null ? null : { kind: 'registerResponse', address };
    }
    case 'resolve': {
      const body = parseJson(payload);
      if (!isRecord(body) || typeof body.name !== 'string' || !isPort(body.port)) return null;
      return { kind: 'resolve', name: body.name, port: body.port };
    }
    case 'resolveResponse': {
      const body = parseJson(payload);
      if (!isRecord(body) || typeof body.name !== 'string' || !isPort(body.port)) return null;
      const { addresses, error } = body;
      if (!Array.isArray(addresses) || (error !== null && typeof error !== 'string')) return null;
      const read = addresses.map((a) => (typeof a === 'string' ? parseAdrWithPort(a) : null));
      if (read.includes(null)) return null;
      const { name, port } = body;
      return { kind: 'resolveResponse', name, port, addresses: read as NetAdr[], error };
    }
    case 'signal': {
      const peer = words.length === 1 ? null : parseAdrWithPort(words[1]);
      const signal = parseSignal(parseJson(payload));
      if ((words.length > 1 && peer === null) || signal === null) return null;
      return { kind: 'signal', peer, signal };
    }
    case 'relay': {
      const peer = parseAdrWithPort(words[1] ?? '');
      if (peer === null || payload === null) return null;
      return { kind: 'relay', peer, data: payload };
    }
    default:
      return { kind: 'datagram', data: data.slice() };
  }
}

/** The marker, a line, and what follows the line. */
function outOfBand(line: string, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
  const head = new TextEncoder().encode(line);
  const length = 4 + head.length + (payload === undefined ? 0 : 1 + payload.length);
  const data = new Uint8Array(length);
  data.fill(0xff, 0, 4);
  data.set(head, 4);
  if (payload !== undefined) {
    data[4 + head.length] = 0x0a;
    data.set(payload, 5 + head.length);
  }
  return data;
}

function json(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(value));
}

function parseJson(payload: Uint8Array | null): unknown {
  if (payload === null) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 0 to 65535: 0 is what `atoi` makes of a port that is not a number, and Quake 3 sends to it. */
function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff;
}

function isIceServer(value: unknown): value is IceServer {
  if (!isRecord(value)) return false;
  const { urls } = value;
  if (typeof urls === 'string') return true;
  return Array.isArray(urls) && urls.every((url) => typeof url === 'string');
}

/** A signal's body: a dial, and exactly one of a description or a candidate. */
function parseSignal(value: unknown): Signal | null {
  if (!isRecord(value) || !Number.isInteger(value.dial)) return null;
  const { dial, description, candidate } = value as {
    dial: number;
    description?: unknown;
    candidate?: unknown;
  };
  if ((description === undefined) === (candidate === undefined)) return null;

  if (description !== undefined) {
    if (!isRecord(description) || typeof description.sdp !== 'string') return null;
    if (description.type !== 'offer' && description.type !== 'answer') return null;
    return { dial, description: { type: description.type, sdp: description.sdp } };
  }
  if (!isRecord(candidate) || typeof candidate.candidate !== 'string') return null;
  const { sdpMid, sdpMLineIndex, usernameFragment } = candidate;
  return {
    dial,
    candidate: {
      candidate: candidate.candidate,
      sdpMid: typeof sdpMid === 'string' ? sdpMid : null,
      sdpMLineIndex: typeof sdpMLineIndex === 'number' ? sdpMLineIndex : null,
      usernameFragment: typeof usernameFragment === 'string' ? usernameFragment : null
    }
  };
}
