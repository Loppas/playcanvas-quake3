import type { CvarStore } from './cvar';
import { huffCompress } from './huffman';
import { Loopback, type LoopbackLike } from './loopback';

/**
 * The layer under the netchan — Quake 3's `NET_*` (`net_chan.c:416–744`, `net_ip.c`): addresses,
 * and datagrams sent to them and read from them.
 *
 * A Quake 3 process has two ways out. The loopback carries the one client that shares the process
 * with a server, and a socket carries everyone else. Both sit behind {@link Net.sendPacket}, which
 * picks by the address. What the socket is — a data channel in a browser, UDP in Node, a network in
 * memory for a test — is the program's to give.
 */

/** `netadrtype_t` (`qcommon.h:135–144`), as far as the port has addresses. */
export const NA = {
  /** A lookup that failed, or an address never set. Nothing is sent to it. */
  BAD: 0,
  /** A bot, which has no connection behind it. */
  BOT: 1,
  /** The client in the same process as the server. */
  LOOPBACK: 2,
  /**
   * Anyone reached through the socket by an IPv4 address; or a name, as a master's slot keeps one
   * for its WebSocket, or as a client has one to look up.
   */
  IP: 4,
  /** Anyone reached through the socket by an IPv6 address. */
  IP6: 5,
  /** No address: the family a name is looked up in when neither `-4` nor `-6` asks for one. */
  UNSPEC: 7
} as const;

/** `netadr_t` (`qcommon.h:146–160`): where a packet came from, or where it is going. */
export interface NetAdr {
  /** One of {@link NA}. */
  type: number;
  /**
   * The host, as the socket names it: a dotted IP address, an IPv6 address as
   * {@link formatIPv6} writes it (its one spelling, so that two addresses compare as text), or
   * whatever else the transport tells its peers apart by. Empty for the loopback and a bot.
   */
  ip: string;
  /** 0 to 65535, and 0 for the loopback and a bot. */
  port: number;
}

/** `PORT_SERVER` (`qcommon.h:274`): the port a server listens on unless it is told otherwise. */
export const PORT_SERVER = 27960;

/** `PORT_MASTER` (`qcommon.h:272`): the port a master listens on unless it is told otherwise. */
export const PORT_MASTER = 27950;

/**
 * `GAMENAME_FOR_MASTER` (`q_shared.h:49`): the game a client asks a server for, and a server tells
 * the master it runs. Quake 3's is `Quake3Arena`; the port speaks only to itself.
 */
export const GAMENAME = 'PlayCanvasQuake';

/**
 * `HEARTBEAT_FOR_MASTER` (`q_shared.h:57`): the tag on a server's heartbeat, dpmaster's for a game
 * that names itself in its `infoResponse`.
 */
export const HEARTBEAT_FOR_MASTER = 'DarkPlaces';

/** `PROTOCOL_VERSION` (`qcommon.h:247`): the port's wire, counted from its own first. */
export const PROTOCOL_VERSION = 2;

/** `netsrc_t`: which half of the program sends a packet, or reads one. */
export type NetSrc = 'client' | 'server';

/** A new address. */
export function netadr(type: number, ip = '', port = 0): NetAdr {
  return { type, ip, port };
}

/**
 * `NET_StringToAdr` (`net_chan.c:629–690`): an address from what a player typed.
 *
 * `localhost` is the loopback. An IPv6 address is bracketed when a port follows it, and one with
 * more than one colon and no brackets has no port. Anything else is a host and an optional
 * `:port`. Quake 3 resolves a name there; the port keeps it as typed, since a page has no lookup,
 * and a client's masters look it up (`ClientStatic`).
 *
 * @param defaultPort - The port when none is given: a server's, unless the caller names a master
 *   (Quake 3's return of 2, which its caller fills in).
 * @returns the address, or null for a string that names none
 */
export function stringToAdr(s: string, defaultPort = PORT_SERVER): NetAdr | null {
  if (s === 'localhost') return netadr(NA.LOOPBACK);

  let host: string;
  let port: string | null = null;
  if (s.startsWith('[') || s.split(':').length > 2) {
    const close = s.indexOf(']');
    if (close !== -1 && s[close + 1] === ':') port = s.slice(close + 2);
    host = s.slice(s.startsWith('[') ? 1 : 0, close === -1 ? s.length : close);
  } else {
    const colon = s.indexOf(':');
    if (colon !== -1) port = s.slice(colon + 1);
    host = colon === -1 ? s : s.slice(0, colon);
  }

  const portNumber = port === null ? defaultPort : (Number.parseInt(port, 10) || 0) & 0xffff;
  const ip6 = parseIPv6(host);
  if (ip6 !== null) return netadr(NA.IP6, formatIPv6(ip6), portNumber);
  // A name, or an IPv4 address; one with a colon in it is neither.
  if (host === '' || host.includes(':')) return null;
  return netadr(NA.IP, host, portNumber);
}

/**
 * The inverse of {@link adrToStringWithPort} for an address reached through the socket: `ip:port`,
 * or `[ip]:port` for IPv6, the port in digits.
 *
 * @returns the address, or null for text that is not one
 */
export function parseAdrWithPort(text: string): NetAdr | null {
  const colon = text.lastIndexOf(':');
  const port = text.slice(colon + 1);
  if (colon < 1 || !/^\d+$/.test(port) || Number(port) > 0xffff) return null;

  const host = text.slice(0, colon);
  if (host.startsWith('[') && host.endsWith(']')) {
    const ip6 = parseIPv6(host.slice(1, -1));
    return ip6 === null ? null : netadr(NA.IP6, formatIPv6(ip6), Number(port));
  }
  if (/[:[\]]/.test(host)) return null;
  return netadr(NA.IP, host, Number(port));
}

/** `NET_AdrToString` (`net_ip.c:463–481`): an address without its port. */
export function adrToString(a: NetAdr): string {
  if (a.type === NA.LOOPBACK) return 'loopback';
  if (a.type === NA.BOT) return 'bot';
  if (a.type === NA.IP || a.type === NA.IP6) return a.ip;
  return '';
}

/** `NET_AdrToStringwPort` (`net_ip.c:483–497`): an address with its port. */
export function adrToStringWithPort(a: NetAdr): string {
  if (a.type === NA.IP) return `${a.ip}:${a.port}`;
  if (a.type === NA.IP6) return `[${a.ip}]:${a.port}`;
  return adrToString(a);
}

/**
 * `NET_CompareBaseAdr` (`net_ip.c:397–461`): the same host, whatever the port. Every loopback
 * address is the same one.
 */
export function compareBaseAdr(a: NetAdr, b: NetAdr): boolean {
  if (a.type !== b.type) return false;
  if (a.type === NA.LOOPBACK) return true;
  return (a.type === NA.IP || a.type === NA.IP6) && a.ip === b.ip;
}

/** `NET_CompareAdr` (`net_ip.c:500–514`): the same host and port. */
export function compareAdr(a: NetAdr, b: NetAdr): boolean {
  if (!compareBaseAdr(a, b)) return false;
  return (a.type !== NA.IP && a.type !== NA.IP6) || a.port === b.port;
}

/** `NET_IsLocalAddress` (`net_ip.c:517–519`). */
export function isLocalAddress(a: NetAdr): boolean {
  return a.type === NA.LOOPBACK;
}

/**
 * `Sys_IsLANAddress` (`net_ip.c:715–760`): whether a client is on the server's own network, whose
 * rate Quake 3 then leaves alone. The loopback always is, and so is an IP in one of the private
 * ranges or the loopback net, or an IPv6 address that is link-local or unique local. Quake 3 also
 * compares the address against every network the machine is a member of; a page cannot list
 * those, so the port leaves that half out.
 */
export function isLANAddress(a: NetAdr): boolean {
  if (a.type === NA.LOOPBACK) return true;
  if (a.type === NA.IP6) {
    const ip6 = parseIPv6(a.ip);
    if (ip6 === null) return false;
    // fe80::/10 and fc00::/7.
    return (ip6[0] === 0xfe && (ip6[1] & 0xc0) === 0x80) || (ip6[0] & 0xfe) === 0xfc;
  }
  if (a.type !== NA.IP) return false;

  const octets = a.ip.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return false;
  }
  const [first, second] = octets;
  if (first === 10) return true;
  if (first === 172 && (second & 0xf0) === 16) return true;
  if (first === 192 && second === 168) return true;
  if (first === 127) return true;
  return false;
}

/** `inet_pton`'s IPv4 (ISC's `inet_pton4`): four decimal bytes, none with a leading zero. */
export function parseIPv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  const byte = /^(0|[1-9]\d{0,2})$/;
  if (parts.length !== 4 || !parts.every((p) => byte.test(p) && Number(p) <= 255)) return null;
  return Uint8Array.from(parts, Number);
}

/**
 * `inet_pton`'s IPv6 (ISC's `inet_pton6`, as glibc has it): eight groups of up to four hex digits,
 * one run of them left out as `::`, and the last two written as a dotted IPv4 address if wished.
 * A scope (`%eth0`) is not taken.
 */
export function parseIPv6(text: string): Uint8Array | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;

  /** A half's groups as 16-bit words; a dotted address may only end the whole. */
  const words = (half: string, last: boolean): number[] | null => {
    const groups = half === '' ? [] : half.split(':');
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const ip4 = last && i === groups.length - 1 ? parseIPv4(groups[i]) : null;
      if (ip4 !== null) {
        out.push((ip4[0] << 8) | ip4[1], (ip4[2] << 8) | ip4[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(groups[i])) {
        out.push(Number.parseInt(groups[i], 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const front = words(halves[0], !compressed);
  const back = compressed ? words(halves[1], true) : [];
  if (front === null || back === null) return null;

  // What `::` stands for: one group at least.
  const left = 8 - front.length - back.length;
  if (compressed ? left < 1 : left !== 0) return null;

  const bytes = new Uint8Array(16);
  [...front, ...new Array<number>(left).fill(0), ...back].forEach((word, i) => {
    bytes[2 * i] = word >> 8;
    bytes[2 * i + 1] = word & 0xff;
  });
  return bytes;
}

/**
 * `inet_ntop`'s IPv6 (ISC's `inet_ntop6`, which glibc and libuv both have): lower-case hex groups,
 * the leftmost longest run of two or more zero groups left out as `::`, and an IPv4 address that
 * is mapped (`::ffff:a.b.c.d`) or compatible (`::a.b.c.d`) written dotted.
 */
export function formatIPv6(bytes: Uint8Array): string {
  const words = Array.from({ length: 8 }, (_, i) => (bytes[2 * i] << 8) | bytes[2 * i + 1]);

  let best = { base: -1, len: 0 };
  let run = { base: -1, len: 0 };
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && words[i] === 0) {
      run = run.base === -1 ? { base: i, len: 1 } : { base: run.base, len: run.len + 1 };
    } else if (run.base !== -1) {
      if (run.len > best.len) best = run;
      run = { base: -1, len: 0 };
    }
  }
  if (best.len < 2) best = { base: -1, len: 0 };

  let text = '';
  for (let i = 0; i < 8; i++) {
    if (best.base !== -1 && i >= best.base && i < best.base + best.len) {
      if (i === best.base) text += ':';
      continue;
    }
    if (i !== 0) text += ':';
    const ip4 = best.len === 6 || (best.len === 5 && words[5] === 0xffff);
    if (i === 6 && best.base === 0 && ip4) {
      text += bytes.subarray(12, 16).join('.');
      break;
    }
    text += words[i].toString(16);
  }
  if (best.base !== -1 && best.base + best.len === 8) text += ':';
  return text;
}

/** One datagram, and who sent it. */
export interface NetPacket {
  from: NetAdr;
  data: Uint8Array;
  /**
   * When it landed, on `Sys_Milliseconds`'s clock, from a socket that hears of each datagram as it
   * lands. Quake 3 reads a packet then (`NET_Sleep`); a page reads on its frame, and times a ping's
   * answer from here.
   */
  time?: number;
}

/**
 * A socket: `Sys_SendPacket`, and the reads `NET_GetPacket` makes.
 *
 * It delivers whole datagrams or none, in whatever order they arrive, as UDP does. Anything
 * reliable or ordered is the netchan's to build on top.
 */
export interface DatagramSocket {
  send(data: Uint8Array, to: NetAdr): void;
  /** The next datagram that has arrived, or null. */
  receive(): NetPacket | null;
  /**
   * Called as a datagram lands, by a socket that hears of one then: what `NET_Sleep`'s `select`
   * wakes for between frames. A socket that is only read never calls it.
   */
  onArrival?: (() => void) | null;
}

/** A packet held back by a delay: `packetQueue_t` (`net_chan.c:480–486`). */
interface QueuedPacket {
  sock: NetSrc;
  data: Uint8Array;
  to: NetAdr;
  /** When it may go, on {@link NetOptions.now}'s clock. */
  release: number;
}

export interface NetOptions {
  /** Where `showpackets`, the latency knobs and `net_qport` are read. */
  cvars: CvarStore;
  /** The socket to everyone but the loopback, or none for a program that talks only to itself. */
  socket?: DatagramSocket | null;
  /**
   * The way to the client in this process, or none for the default: the two queues of a shared
   * memory. A server whose client is across a worker's boundary gives a {@link MessageLoopback}
   * instead.
   */
  loopback?: LoopbackLike;
  /** `Sys_Milliseconds`, which a delayed packet's release is timed on. */
  now?: () => number;
  /** What `net_dropsim` rolls against, and `net_qport` is drawn from. */
  random?: () => number;
  /** `Com_Printf`, for `showpackets` and `showdrop`. */
  print?: (text: string) => void;
}

/**
 * One process's way out: the loopback, the socket, and the knobs that make either worse.
 *
 * `cl_packetdelay` and `sv_packetdelay` hold back what the client or the server sends, and
 * `net_dropsim` loses a share of what arrives. Quake 3 exempts the loopback from all three, so lag
 * can only be tried between two processes there; the port applies them to the loopback too, so one
 * page can play at any ping and any loss.
 */
export class Net {
  readonly loopback: LoopbackLike;
  socket: DatagramSocket | null;

  /** `Sys_Milliseconds`. */
  readonly now: () => number;

  private readonly cvars: CvarStore;
  private readonly random: () => number;
  private readonly printLine: (text: string) => void;
  /** The delayed packets, oldest first, which is also the order they are released in. */
  private readonly queue: QueuedPacket[] = [];

  constructor(options: NetOptions) {
    this.cvars = options.cvars;
    this.socket = options.socket ?? null;
    this.loopback = options.loopback ?? new Loopback();
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.printLine = options.print ?? console.log;

    // `Netchan_Init` (`net_chan.c:72–77`) and `Com_Init` (`common.c:2775–2818`). The qport is 16
    // random bits, so that two clients behind one address are told apart.
    this.registerCvar('showpackets', () => '0');
    this.registerCvar('showdrop', () => '0');
    this.registerCvar('net_qport', () => String(Math.floor(this.random() * 0x10000) & 0xffff));
    this.registerCvar('cl_packetdelay', () => '0');
    this.registerCvar('sv_packetdelay', () => '0');
    // `NET_GetCvars` (`net_ip.c:1488`): empty, so the console sets it by name.
    this.registerCvar('net_dropsim', () => '');
    this.registerCvar('com_gamename', () => GAMENAME);
    this.registerCvar('com_protocol', () => String(PROTOCOL_VERSION));
  }

  /** `com_gamename`. */
  get gamename(): string {
    return this.cvars.get('com_gamename');
  }

  /** `com_protocol`. */
  get protocol(): number {
    return this.cvarInt('com_protocol');
  }

  /** `showpackets`: every packet in and out goes to the console. */
  get showpackets(): boolean {
    return this.cvarInt('showpackets') !== 0;
  }

  /** `showdrop`: every packet the netchan throws away goes to the console. */
  get showdrop(): boolean {
    return this.cvarInt('showdrop') !== 0;
  }

  /** `net_qport`: what this process's client stamps its packets with. */
  get qport(): number {
    return this.cvarInt('net_qport') & 0xffff;
  }

  /** `Com_Printf`. */
  print(text: string): void {
    this.printLine(text);
  }

  /**
   * `NET_SendPacket` (`net_chan.c:537–564`): a datagram, down the loopback or out of the socket as
   * the address says, or held back first by the side's delay.
   */
  sendPacket(sock: NetSrc, data: Uint8Array, to: NetAdr): void {
    // Sequenced packets are shown by the netchan, so only out-of-band ones are shown here.
    if (this.showpackets && isOutOfBand(data)) {
      this.print(`send packet ${String(data.length).padStart(4)}`);
    }

    if (to.type === NA.BOT || to.type === NA.BAD) return;

    const delay = this.cvarInt(sock === 'client' ? 'cl_packetdelay' : 'sv_packetdelay');
    if (delay > 0) {
      this.queuePacket(sock, data, to, delay);
      return;
    }
    this.transmit(sock, data, to);
  }

  /**
   * `NET_FlushPacketQueue` (`net_chan.c:519–535`): send every delayed packet whose time has come.
   * The queue is in the order packets were sent, and a packet still held holds everything behind
   * it, however short its own delay.
   */
  flushPacketQueue(): void {
    while (this.queue.length > 0) {
      const packet = this.queue[0];
      if (packet.release >= this.now()) break;
      this.queue.shift();
      this.transmit(packet.sock, packet.data, packet.to);
    }
  }

  /** `NET_OutOfBandPrint` (`net_chan.c:573–590`): a line of text outside any connection. */
  outOfBandPrint(sock: NetSrc, to: NetAdr, text: string): void {
    this.sendPacket(sock, outOfBand(text), to);
  }

  /**
   * `NET_OutOfBandData` (`net_chan.c:599–619`): the same, with everything after the first twelve
   * bytes compressed. Only `connect` goes this way, and the twelve are `connect ` behind the
   * marker, which the server reads before it decompresses the rest.
   */
  outOfBandData(sock: NetSrc, to: NetAdr, text: string): void {
    this.sendPacket(sock, huffCompress(outOfBand(text), 12), to);
  }

  /**
   * `NET_GetLoopPacket` (`net_chan.c:439–461`): the next packet the other half of the process sent
   * this one, or null. `net_dropsim` loses its share here as it does from the socket.
   */
  getLoopPacket(sock: NetSrc): NetPacket | null {
    for (;;) {
      const data = this.loopback.receive(sock);
      if (data === null) return null;
      if (this.dropped()) continue;
      return { from: netadr(NA.LOOPBACK), data };
    }
  }

  /**
   * `NET_Event` (`net_ip.c:1626–1654`): the next packet the socket has, or null, less those
   * `net_dropsim` loses.
   */
  getPacket(): NetPacket | null {
    if (this.socket === null) return null;
    for (;;) {
      const packet = this.socket.receive();
      if (packet === null) return null;
      if (this.dropped()) continue;
      return packet;
    }
  }

  /**
   * `NET_SendLoopPacket` or `Sys_SendPacket` (`net_ip.c:650–703`): the packet leaves now. A send
   * the socket refuses loses its datagram and prints why, and the program goes on.
   */
  private transmit(sock: NetSrc, data: Uint8Array, to: NetAdr): void {
    if (to.type === NA.LOOPBACK) {
      this.loopback.send(sock === 'client' ? 'server' : 'client', data);
      return;
    }
    try {
      this.socket?.send(data, to);
    } catch (err) {
      this.print(`Sys_SendPacket: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** `NET_QueuePacket` (`net_chan.c:490–517`), capped at 999 ms as Quake 3 caps it. */
  private queuePacket(sock: NetSrc, data: Uint8Array, to: NetAdr, delay: number): void {
    this.queue.push({
      sock,
      data: data.slice(),
      to: { ...to },
      release: this.now() + Math.min(delay, 999)
    });
  }

  /** Whether `net_dropsim`, a percentage from 0 to 100, loses this packet. */
  private dropped(): boolean {
    const percent = Number.parseFloat(this.cvars.get('net_dropsim')) || 0;
    return percent > 0 && percent <= 100 && this.random() * 100 < percent;
  }

  /** `Cvar_Get`: the default, worked out only if the cvar has no value yet. */
  private registerCvar(name: string, fallback: () => string): void {
    if (this.cvars.get(name) === '') this.cvars.set(name, fallback());
  }

  private cvarInt(name: string): number {
    return Number.parseInt(this.cvars.get(name), 10) || 0;
  }
}

/** Text behind the out-of-band marker. */
function outOfBand(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const data = new Uint8Array(4 + body.length);
  data.fill(0xff, 0, 4);
  data.set(body, 4);
  return data;
}

/** Whether a datagram is out of band: four bytes of 0xFF where a sequence would be. */
export function isOutOfBand(data: Uint8Array): boolean {
  return (
    data.length >= 4 && data[0] === 0xff && data[1] === 0xff && data[2] === 0xff && data[3] === 0xff
  );
}
