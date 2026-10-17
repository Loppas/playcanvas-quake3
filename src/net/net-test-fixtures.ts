import type { CvarStore } from './cvar';
import {
  compareAdr,
  NA,
  parseAdrWithPort,
  parseIPv4,
  parseIPv6,
  stringToAdr,
  type DatagramSocket,
  type NetAdr,
  type NetPacket
} from './net';

/**
 * A network in memory, for tests: sockets at addresses, and datagrams between them that can arrive
 * late, out of order or not at all, on a clock the test moves.
 */

/** A process's cvars, held in a map. */
export function testCvars(initial: Record<string, string> = {}): CvarStore {
  const values = new Map(Object.entries(initial));
  const counts = new Map<string, number>();
  let total = 0;
  const set = (name: string, value: string) => {
    if ((values.get(name) ?? '') === value) return;
    values.set(name, value);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    total++;
  };
  return {
    get: (name) => values.get(name) ?? '',
    set,
    setServer: (name, value) => {
      set(name, value);
      return true;
    },
    modificationCount: (name) => counts.get(name) ?? 0,
    totalModifications: () => total
  };
}

/** A datagram on its way, and when it lands. */
interface InFlight {
  to: NetAdr;
  packet: NetPacket;
  arrives: number;
}

export interface MemoryNetworkOptions {
  /** How long every datagram takes, in milliseconds. */
  latency?: number;
  /** Up to this much longer, drawn for each datagram, so that two sent close together can swap. */
  jitter?: number;
  /** The share of datagrams lost, from 0 to 1. */
  loss?: number;
  /** Seeds the draws for loss and jitter, so that a run can be repeated. */
  seed?: number;
}

export class MemoryNetwork {
  /** The clock, in milliseconds, which only the test moves. */
  now = 0;
  latency: number;
  jitter: number;
  loss: number;
  /**
   * Decides a datagram by hand before loss and latency do: false loses it. For a test that needs
   * one particular packet gone.
   */
  filter: ((packet: NetPacket, to: NetAdr) => boolean) | null = null;

  /** Every datagram sent, lost or not, in order. */
  readonly sent: { packet: NetPacket; to: NetAdr }[] = [];
  /** How many were lost. */
  lost = 0;

  /** In the order they were sent, which settles two landing at once. */
  private readonly inFlight: InFlight[] = [];
  private seed: number;

  constructor(options: MemoryNetworkOptions = {}) {
    this.latency = options.latency ?? 0;
    this.jitter = options.jitter ?? 0;
    this.loss = options.loss ?? 0;
    this.seed = options.seed ?? 1;
  }

  /** A socket at an address, written as a player would type it: `10.0.0.2:27960`. */
  socket(address: string): MemorySocket {
    const adr = stringToAdr(address);
    if (adr === null) throw new Error(`memory network: bad address ${address}`);
    return new MemorySocket(this, adr);
  }

  /** Move the clock on. */
  advance(msec: number): void {
    this.now += msec;
  }

  /** A datagram leaving `from`, decided now: lost, or landing at a time. */
  send(from: NetAdr, data: Uint8Array, to: NetAdr): void {
    const packet = { from: { ...from }, data: data.slice() };
    this.sent.push({ packet, to: { ...to } });
    if ((this.filter !== null && !this.filter(packet, to)) || this.random() < this.loss) {
      this.lost++;
      return;
    }
    const arrives = this.now + this.latency + this.random() * this.jitter;
    this.inFlight.push({ to: { ...to }, packet, arrives });
  }

  /** The next datagram to have landed at an address, or null. */
  receive(at: NetAdr): NetPacket | null {
    let next = -1;
    for (let i = 0; i < this.inFlight.length; i++) {
      const flight = this.inFlight[i];
      if (flight.arrives > this.now || !compareAdr(flight.to, at)) continue;
      const best = this.inFlight[next];
      if (next === -1 || flight.arrives < best.arrives) next = i;
    }
    if (next === -1) return null;
    return this.inFlight.splice(next, 1)[0].packet;
  }

  /** mulberry32. */
  private random(): number {
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** One end of a {@link MemoryNetwork}. */
export class MemorySocket implements DatagramSocket {
  /** Where this socket is, as the other ends see it. */
  readonly address: NetAdr;
  private readonly network: MemoryNetwork;

  constructor(network: MemoryNetwork, address: NetAdr) {
    this.network = network;
    this.address = address;
  }

  send(data: Uint8Array, to: NetAdr): void {
    this.network.send(this.address, data, to);
  }

  receive(): NetPacket | null {
    return this.network.receive(this.address);
  }
}

/**
 * A master's `getserversResponse`, or its `getserversExtResponse`, naming servers as a list writes
 * them, `ip:port` or `[ip]:port`, and ending in `\EOT\0\0\0` unless told otherwise.
 */
export function serversResponse(
  servers: readonly string[],
  options: { extended?: boolean; end?: boolean } = {}
): Uint8Array<ArrayBuffer> {
  const bytes = (text: string) => [...text].map((c) => c.charCodeAt(0));
  const name = options.extended ? 'getserversExtResponse' : 'getserversResponse';
  const data = [0xff, 0xff, 0xff, 0xff, ...bytes(name)];
  for (const server of servers) {
    const adr = parseAdrWithPort(server)!;
    const ip6 = adr.type === NA.IP6;
    const ip = ip6 ? parseIPv6(adr.ip)! : parseIPv4(adr.ip)!;
    data.push(...bytes(ip6 ? '/' : '\\'), ...ip, adr.port >> 8, adr.port & 0xff);
  }
  if (options.end ?? true) data.push(...bytes('\\EOT\0\0\0'));
  return Uint8Array.from(data);
}
