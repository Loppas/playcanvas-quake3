import { atoi } from '../formats/c-scan';
import type { CvarStore } from './cvar';
import { MasterLink, type WebSocketLike } from './master-link';
import type { IceServer, MasterFrame, Resolved } from './master-protocol';
import {
  adrToStringWithPort,
  formatIPv6,
  isLANAddress,
  NA,
  netadr,
  parseIPv6,
  PORT_MASTER,
  PORT_SERVER,
  stringToAdr,
  type NetAdr
} from './net';
import type { PeerSignalling, SignallingLink } from './peer-signalling';

/**
 * A program's masters: what the `sv_master` slots name, and the WebSocket to each.
 *
 * Quake 3 resolves each slot's name to an address its heartbeat goes to (`sv_main.c:269–331`). The
 * port's master is a WebSocket rather than a UDP port, so a slot names both: the address its
 * datagrams go to and come from, and the URL the link is opened at.
 */

/** A master as a slot names it. */
export interface MasterAt {
  /** The address the program names the master by: its host as written, and its port. */
  adr: NetAdr;
  /** Where its WebSocket is. */
  url: string;
}

/**
 * The master a `sv_master` slot names, or null for an empty slot or one that names none.
 *
 * A name or an address, with `:port` or {@link PORT_MASTER}, is reached by `ws://` when it is
 * `localhost`, a loopback or a private address, since a master on a LAN has no certificate, and by
 * `wss://` otherwise. A `ws://` or `wss://` URL is taken as given. `localhost` is the master on
 * this machine, where Quake 3's would be its own loopback.
 */
export function masterAt(slot: string): MasterAt | null {
  if (/^wss?:\/\//i.test(slot)) {
    let url: URL;
    try {
      url = new URL(slot);
    } catch {
      return null;
    }
    const port = url.port !== '' ? Number(url.port) : url.protocol === 'wss:' ? 443 : 80;
    const ip6 = url.hostname.startsWith('[') ? parseIPv6(url.hostname.slice(1, -1)) : null;
    const adr =
      ip6 !== null
        ? netadr(NA.IP6, formatIPv6(ip6), port)
        : netadr(NA.IP, url.hostname, port);
    return { adr, url: slot };
  }

  const adr =
    slot === 'localhost' ? netadr(NA.IP, slot, PORT_MASTER) : stringToAdr(slot, PORT_MASTER);
  if (adr === null) return null;
  const local = adr.ip === 'localhost' || adr.ip === '::1' || isLANAddress(adr);
  const host = adr.type === NA.IP6 ? `[${adr.ip}]` : adr.ip;
  return { adr, url: `${local ? 'ws' : 'wss'}://${host}:${adr.port}` };
}

/** The slots a program reaches its masters through: the Internet's master, then the LAN's. */
export const MASTER_SLOTS = ['sv_master1', 'sv_master2'] as const;

/** How long a master that could not be reached waits before it is tried again, at first. */
export const RETRY_MSEC = 3000;

/** The longest wait between tries: a heartbeat's period, by which Quake 3's would have tried. */
export const MAX_RETRY_MSEC = 300 * 1000;

/**
 * One master the slots name: the way to it the signalling holds, which outlasts each WebSocket to
 * it.
 */
class Master implements SignallingLink {
  readonly at: MasterAt;
  /** The slot's text that named it, as the console names it. */
  readonly name: string;
  onFrame: ((frame: MasterFrame) => void) | null = null;
  /** The connection, or null between tries. */
  link: MasterLink | null = null;
  /** When the next try may go. */
  retryAt = 0;
  /** The wait after the next try, if that fails too. */
  wait = RETRY_MSEC;
  /** Whether a WebSocket to it could not even be made, which the console is told once. */
  warned = false;

  constructor(at: MasterAt, name: string) {
    this.at = at;
    this.name = name;
  }

  get master(): NetAdr {
    return this.at.adr;
  }

  get iceServers(): IceServer[] {
    return this.link?.iceServers ?? [];
  }

  /** A frame to the master, lost between tries as a datagram to a master that is down is. */
  send(frame: MasterFrame): void {
    this.link?.send(frame);
  }
}

/** A client's master: a frame for it while it has no connection opens one. */
class ClientMaster extends Master {
  private readonly reopen: (master: Master) => void;

  constructor(at: MasterAt, name: string, reopen: (master: Master) => void) {
    super(at, name);
    this.reopen = reopen;
  }

  override send(frame: MasterFrame): void {
    if (this.link === null) this.reopen(this);
    super.send(frame);
  }
}

export interface MastersOptions {
  /** Where the slots are read. */
  cvars: CvarStore;
  /** The signalling the masters carry, told as a master is named and as one is let go. */
  signalling: Pick<PeerSignalling, 'addLink' | 'removeLink'>;
  /** A WebSocket to a URL: the browser's, `ws`'s in Node, or a test's. */
  connect: (url: string) => WebSocketLike;
  /** `Com_Printf`. */
  print: (text: string) => void;
}

/**
 * The masters the slots name, one for two slots that name the same, and the WebSocket to each:
 * what a server's and a client's have alike. When a connection is opened is each one's own.
 */
abstract class SlotMasters {
  protected readonly cvars: CvarStore;
  protected readonly print: (text: string) => void;
  protected readonly masters: Master[] = [];
  private readonly signalling: Pick<PeerSignalling, 'addLink' | 'removeLink'>;
  private readonly connect: (url: string) => WebSocketLike;
  /** The slots' text as last followed. */
  private slots: readonly string[] = [];

  constructor(options: MastersOptions) {
    this.cvars = options.cvars;
    this.signalling = options.signalling;
    this.connect = options.connect;
    this.print = options.print;
  }

  /** Every connection closed, as the program goes. The owner sends nothing after. */
  close(): void {
    for (const master of [...this.masters]) this.drop(master);
  }

  /** A master no slot names any more is let go, and one newly named is taken on. */
  protected follow(): void {
    const slots = MASTER_SLOTS.map((slot) => this.cvars.get(slot));
    if (slots.every((value, i) => value === this.slots[i])) return;
    this.slots = slots;

    const named: Master[] = [];
    for (const value of slots) {
      const at = masterAt(value);
      if (at === null) continue;
      const key = adrToStringWithPort(at.adr);
      if (named.some((master) => adrToStringWithPort(master.master) === key)) continue;
      const kept = this.masters.find((master) => adrToStringWithPort(master.master) === key);
      named.push(kept ?? this.create(at, value));
    }

    for (const master of [...this.masters]) {
      if (!named.includes(master)) this.drop(master);
    }
    for (const master of named) {
      if (this.masters.includes(master)) continue;
      this.masters.push(master);
      this.signalling.addLink(master);
    }
  }

  /** The way to a master newly named. */
  protected abstract create(at: MasterAt, name: string): Master;

  /**
   * A WebSocket to the master, and the link over it; or none where the platform will not open one,
   * which the console is told once.
   *
   * @param closed - Told as the connection closes, once the master has no link, and whether it
   *   had opened first.
   */
  protected openLink(
    master: Master,
    closed: (opened: boolean) => void
  ): { ws: WebSocketLike; link: MasterLink } | null {
    let ws: WebSocketLike;
    try {
      ws = this.connect(master.at.url);
    } catch (err) {
      // A URL the platform will not open, as `ws://` from an https page, fails as a refusal does.
      if (!master.warned) {
        const reason = err instanceof Error ? err.message : String(err);
        this.print(`WARNING: can't reach the master at ${master.name}: ${reason}`);
        master.warned = true;
      }
      return null;
    }

    const link = new MasterLink(master.at.adr, ws);
    link.onFrame = (frame) => master.onFrame?.(frame);
    let opened = false;
    ws.addEventListener('open', () => {
      opened = true;
    });
    ws.addEventListener('close', () => {
      master.link = null;
      closed(opened);
    });
    master.link = link;
    return { ws, link };
  }

  private drop(master: Master): void {
    this.masters.splice(this.masters.indexOf(master), 1);
    this.signalling.removeLink(master);
    const { link } = master;
    master.link = null;
    link?.close();
  }
}

export interface ServerMastersOptions extends MastersOptions {
  /** `Sys_Milliseconds`, which the tries are timed on. */
  now: () => number;
}

/**
 * A server's connections to its masters: one to each master the slots name, one for two slots
 * that name the same. Each registers `net_port` as it connects, and the address the master grants
 * is printed; that is what makes the server reachable, as Quake 3's socket is by being bound.
 *
 * A connection that fails or is lost is tried again {@link RETRY_MSEC} later, the wait doubling up
 * to {@link MAX_RETRY_MSEC} and starting over once one opens. A slot changed is followed at the
 * next frame. The server's heartbeat keeps its own clock, so a master that has restarted lists the
 * server again when its next heartbeat comes, as Quake 3's does.
 */
export class ServerMasters extends SlotMasters {
  private readonly now: () => number;

  constructor(options: ServerMastersOptions) {
    super(options);
    this.now = options.now;
  }

  /** The slots followed, and each master with no connection tried if its time has come. */
  frame(): void {
    this.follow();
    const now = this.now();
    for (const master of this.masters) {
      if (master.link === null && now >= master.retryAt) this.open(master);
    }
  }

  protected create(at: MasterAt, name: string): Master {
    return new Master(at, name);
  }

  /** A WebSocket to the master, and `net_port` registered on it, as it is read now. */
  private open(master: Master): void {
    const opened = this.openLink(master, () => this.failed(master));
    if (opened === null) {
      this.failed(master);
      return;
    }
    const { ws, link } = opened;
    ws.addEventListener('open', () => {
      master.wait = RETRY_MSEC;
    });
    link.onRegistered = (address) =>
      this.print(`Registered with ${master.name} as ${adrToStringWithPort(address)}`);
    const port = this.cvars.get('net_port');
    link.register(port === '' ? PORT_SERVER : atoi(port));
  }

  /** The next try, a wait from now, and the wait after it doubled. */
  private failed(master: Master): void {
    master.retryAt = this.now() + master.wait;
    master.wait = Math.min(master.wait * 2, MAX_RETRY_MSEC);
  }
}

/**
 * A client's connections to the masters the slots name. Nothing goes to a master until the
 * client sends it something — a list's question, a query to relay, a dial's signals, a name to
 * look up — and a frame for a master with no connection opens one, so a master that was down is
 * tried again by the next thing asked of it, as each of Quake 3's datagrams is a fresh try. A
 * client never registers, so no master lists it.
 */
export class ClientMasters extends SlotMasters {
  /**
   * Told as a master's connection closes, and whether it had opened first; one the platform would
   * not make closes at once, unopened. What was sent it and not yet answered is lost.
   */
  onClosed: ((master: NetAdr, opened: boolean) => void) | null = null;
  /** Told a master's answer to a name asked of it. */
  onResolved: ((master: NetAdr, answer: Resolved) => void) | null = null;

  /** The slots followed, before anything goes out: Quake 3 reads a slot as each command runs. */
  override follow(): void {
    super.follow();
  }

  /** The masters the slots named when last followed. */
  named(): NetAdr[] {
    return this.masters.map((master) => ({ ...master.master }));
  }

  /** A name asked of every master the slots name, for addresses with this port. */
  resolve(name: string, port: number): void {
    for (const master of this.masters) master.send({ kind: 'resolve', name, port });
  }

  protected create(at: MasterAt, name: string): Master {
    return new ClientMaster(at, name, (master) => {
      const closed = (opened: boolean) => this.onClosed?.(master.master, opened);
      const opened = this.openLink(master, closed);
      if (opened === null) closed(false);
      else opened.link.onResolved = (answer) => this.onResolved?.(master.master, answer);
    });
  }
}
