import { atoi } from '../formats/c-scan';
import type { CvarStore } from './cvar';
import { infoSetValueForKey, infoValueForKey, MAX_INFO_STRING } from './info';
import {
  adrToStringWithPort,
  compareAdr,
  formatIPv6,
  NA,
  netadr,
  stringToAdr,
  type NetAdr
} from './net';

/**
 * The server browser's lists: the servers Quake 3's `cls` holds (`client.h:282–335`) and the
 * pings that fill them in (`cl_main.c:4320–4523`), read as the UI's `LAN_*` calls read them
 * (`cl_ui.c:93–340`).
 */

/** `AS_*` (`q_shared.h:1382–1385`): which list. */
export const AS = {
  /** The servers on the player's network. */
  LOCAL: 0,
  /** The Internet master's list. */
  GLOBAL: 2,
  /** The player's own. */
  FAVORITES: 3
} as const;

export type ServerSource = (typeof AS)[keyof typeof AS];

/** `MAX_GLOBAL_SERVERS` (`q_shared.h:1409`). */
export const MAX_GLOBAL_SERVERS = 4096;

/** `MAX_OTHER_SERVERS` (`q_shared.h:1410`): the most the local list or the favourites hold. */
export const MAX_OTHER_SERVERS = 128;

/** `MAX_PINGREQUESTS` (`q_shared.h:1411`): how many pings may be out at once. */
export const MAX_PINGREQUESTS = 32;

/** `MAX_SERVERSPERPACKET` (`cl_main.c:2493`). */
const MAX_SERVERSPERPACKET = 256;

/** `MAX_HOSTNAME_LENGTH` and `MAX_NAME_LENGTH` (`q_shared.h:253–254`), each with its NUL. */
const MAX_HOSTNAME_LENGTH = 80;
const MAX_NAME_LENGTH = 32;

/**
 * A ping's slot is kept from reuse while it has waited less than this for its answer, or while an
 * answer that took less than this waits to be read.
 */
const PING_KEEP_MSEC = 500;

/** A list's marks: `\` before an IPv4 server, `/` before an IPv6 one. */
const BACKSLASH = 0x5c;
const SLASH = 0x2f;

/** `serverInfo_t` (`client.h:289–305`): a server in a list, as a ping's last answer told it. */
export interface ServerInfo {
  adr: NetAdr;
  /** Its `hostname`; for a favourite, the name it was added by until an answer replaces it. */
  hostName: string;
  mapName: string;
  /** The mod it runs. */
  game: string;
  /** 1 for an IPv4 server and 2 for IPv6, once a ping's answer has been read back. */
  netType: number;
  gameType: number;
  clients: number;
  maxClients: number;
  /** The pings the server takes players between, 0 for no bound. */
  minPing: number;
  maxPing: number;
  /** −1 until pinged, 0 while a ping is out or once one has gone unanswered, else its msec. */
  ping: number;
  /**
   * Whether the ping went through the masters rather than down a channel to the server: its time
   * is then the round trip to a master and on to the server, an estimate of the way a match takes.
   */
  estimate: boolean;
  humanPlayers: number;
  needPass: number;
}

/** A ping as `CL_GetPing` reads it. */
export interface PingResult {
  /** The server, as `ip:port`, or as it was named where its address was looked up. */
  address: string;
  /** The server as it was named to the ping. */
  adr: NetAdr;
  /** The answer's msec; 0 while one may yet come; the msec waited once `cl_maxPing` has passed. */
  time: number;
  /** Whether it went through the masters. */
  estimate: boolean;
}

/** `ping_t` (`client.h:282–287`): a ping out, or answered; the slot is free while its port is 0. */
interface Ping {
  adr: NetAdr;
  /**
   * The server as the ping named it: its address, or the name the masters looked it up by, which
   * the ping is read back as, and whose rows it fills too.
   */
  named: NetAdr;
  /** When it went, in whole msec. */
  start: number;
  /** The msec its answer took, or 0 while there is none. */
  time: number;
  /** The answer's infostring, `nettype` added; the slot's last ping's until an answer comes. */
  info: string;
  /** Whether it went through the masters. */
  estimate: boolean;
}

export interface ServerListsOptions {
  /** Where `cl_maxPing` is read. */
  cvars: CvarStore;
  /** `Sys_Milliseconds`. */
  now: () => number;
  /** `Com_Printf`. */
  print: (text: string) => void;
}

/**
 * `CL_ServersResponsePacket`'s parse (`cl_main.c:2515–2574`): the servers in a master's
 * `getserversResponse`, or `getserversExtResponse` with its IPv6 ones.
 *
 * An entry is read only with a byte behind it, so the entry that ends a full reply is lost, as
 * ioquake3 loses it from dpmaster's.
 */
export function readServersResponse(data: Uint8Array, extended: boolean): NetAdr[] {
  const end = data.length;
  let at = 0;
  while (at < end && data[at] !== BACKSLASH && !(extended && data[at] === SLASH)) at++;

  const servers: NetAdr[] = [];
  while (at + 1 < end) {
    let adr: NetAdr;
    if (data[at] === BACKSLASH) {
      at++;
      if (end - at < 4 + 2 + 1) break;
      adr = netadr(NA.IP, data.subarray(at, at + 4).join('.'));
      at += 4;
    } else if (extended && data[at] === SLASH) {
      at++;
      if (end - at < 16 + 2 + 1) break;
      adr = netadr(NA.IP6, formatIPv6(data.subarray(at, at + 16)));
      at += 16;
    } else {
      break;
    }
    adr.port = (data[at] << 8) | data[at + 1];
    at += 2;
    if (data[at] !== BACKSLASH && data[at] !== SLASH) break;

    servers.push(adr);
    if (servers.length >= MAX_SERVERSPERPACKET) break;
  }
  return servers;
}

export class ServerLists {
  private readonly cvars: CvarStore;
  private readonly now: () => number;
  private readonly print: (text: string) => void;
  private readonly lists: Record<ServerSource, ServerInfo[]> = {
    [AS.LOCAL]: [],
    [AS.GLOBAL]: [],
    [AS.FAVORITES]: []
  };
  /**
   * `cls.pingUpdateSource`: the list asked for last. A master's list, and an answer to no ping of
   * this client's, go to the local list while it is that one.
   */
  private source: ServerSource = AS.LOCAL;
  /** `cls.numglobalservers` of −1: the Internet master asked, and nothing answered yet. */
  private globalAsked = false;
  /** `cl_pinglist`. */
  private readonly pings: Ping[] = Array.from({ length: MAX_PINGREQUESTS }, () => ({
    adr: netadr(NA.BAD),
    named: netadr(NA.BAD),
    start: 0,
    time: 0,
    info: '',
    estimate: false
  }));

  constructor(options: ServerListsOptions) {
    this.cvars = options.cvars;
    this.now = options.now;
    this.print = options.print;
    // `CL_Init`'s `Cvar_Get` (`cl_main.c:3653`).
    if (this.cvars.get('cl_maxPing') === '') this.cvars.set('cl_maxPing', '800');
  }

  /** `LAN_GetServerCount` (`cl_ui.c:214–228`): −1 for the global list while its master is asked. */
  count(source: ServerSource): number {
    if (source === AS.GLOBAL && this.globalAsked) return -1;
    return this.lists[source].length;
  }

  /** A list's `n`th server, as `LAN_GetServerInfo` and `LAN_GetServerPing` read it, or null. */
  server(source: ServerSource, n: number): Readonly<ServerInfo> | null {
    return this.lists[source][n] ?? null;
  }

  /**
   * `LAN_AddServer` (`cl_ui.c:125–165`): a server added by its address, under a name.
   *
   * @returns 1 when added, 0 when the list has it already, −1 when the list is full
   */
  add(source: ServerSource, name: string, address: string): number {
    const list = this.lists[source];
    if (list.length >= (source === AS.GLOBAL ? MAX_GLOBAL_SERVERS : MAX_OTHER_SERVERS)) return -1;
    const adr = stringToAdr(address) ?? netadr(NA.BAD);
    if (list.some((server) => compareAdr(server.adr, adr))) return 0;
    list.push({ ...serverAt(adr, 0), hostName: name.slice(0, MAX_HOSTNAME_LENGTH - 1) });
    return 1;
  }

  /** `LAN_RemoveServer` (`cl_ui.c:172–206`): the server at the address taken out of a list. */
  remove(source: ServerSource, address: string): void {
    const adr = stringToAdr(address) ?? netadr(NA.BAD);
    const list = this.lists[source];
    const index = list.findIndex((server) => compareAdr(adr, server.adr));
    if (index !== -1) list.splice(index, 1);
  }

  /** `CL_LocalServers_f`'s start (`cl_main.c:4186–4194`): the local list emptied, and asked for. */
  askLocal(): void {
    this.lists[AS.LOCAL].length = 0;
    this.source = AS.LOCAL;
  }

  /**
   * `CL_GlobalServers_f`'s (`cl_main.c:4285–4286`): the global list asked for. What it held stays
   * until the master's first answer replaces it.
   */
  askGlobal(): void {
    this.globalAsked = true;
    this.source = AS.GLOBAL;
  }

  /**
   * `CL_ServersResponsePacket`'s lists half (`cl_main.c:2509–2613`): a master's servers added, each
   * once, and none pinged yet. They go to the local list after `localservers`, whose master lists
   * the servers on the player's network, and to the global one otherwise.
   *
   * @returns how many the list holds
   */
  listed(servers: readonly NetAdr[]): number {
    const local = this.source === AS.LOCAL;
    if (!local && this.globalAsked) {
      this.globalAsked = false;
      this.lists[AS.GLOBAL].length = 0;
    }
    const list = this.lists[local ? AS.LOCAL : AS.GLOBAL];
    const max = local ? MAX_OTHER_SERVERS : MAX_GLOBAL_SERVERS;
    for (const adr of servers) {
      if (list.length >= max) break;
      if (list.some((server) => compareAdr(server.adr, adr))) continue;
      list.push(serverAt(adr, -1));
    }
    return list.length;
  }

  /**
   * `CL_ServerInfoPacket`'s lists half (`cl_main.c:3920–3978`): the answer to a ping out to the
   * server, which fills in every list's row for it; or, after `localservers`, a server found on the
   * player's network by its answer alone, to be pinged for its info.
   *
   * @param time - When the answer landed, which a ping is timed to: Quake 3 reads it then.
   */
  infoResponse(from: NetAdr, info: string, time = this.now()): void {
    for (const ping of this.pings) {
      if (ping.adr.port === 0 || ping.time !== 0 || !compareAdr(from, ping.adr)) continue;
      // id's `+ 1` (1.32's `cl_main.c:2535`; ioquake3 has none): an answer in the millisecond its
      // ping went is 1, not the 0 of no answer yet.
      ping.time = Math.floor(time) - ping.start + 1;
      const kept = info.slice(0, MAX_INFO_STRING - 1);
      ping.info = infoSetValueForKey(kept, 'nettype', String(netType(from)), this.print);
      this.setByPing(ping, info);
      return;
    }

    if (this.source !== AS.LOCAL) return;
    const local = this.lists[AS.LOCAL];
    if (local.some((server) => compareAdr(from, server.adr))) return;
    if (local.length >= MAX_OTHER_SERVERS) return;
    local.push(serverAt(from, -1));
  }

  /**
   * `CL_Ping_f`'s slot (`cl_main.c:4514–4520`): a ping to the server, going now, and every list's
   * row for the server waiting on it.
   *
   * A server named by a name holds a slot as the name while the masters look it up, where Quake 3
   * looks it up before it takes one; the ping to the address found goes in that slot, its time
   * from then.
   *
   * @param estimate - Whether it goes through the masters.
   * @param named - The server as the ping was asked for it, where that was a name.
   */
  ping(to: NetAdr, estimate: boolean, named: NetAdr = to): void {
    const held = compareAdr(to, named)
      ? undefined
      : this.pings.find((p) => p.adr.port !== 0 && p.time === 0 && compareAdr(p.adr, named));
    const ping = held ?? this.freePing();
    ping.adr = { ...to };
    ping.named = { ...named };
    ping.start = this.millis();
    ping.time = 0;
    ping.estimate = estimate;
    this.setByPing(ping, null);
  }

  /**
   * The slot held for a name no master found, freed, as Quake 3 takes none for a name it can't
   * look up.
   */
  release(named: NetAdr): void {
    const held = this.pings.find(
      (p) =>
        p.adr.port !== 0 && p.time === 0 && compareAdr(p.adr, named) && compareAdr(p.named, named)
    );
    if (held) held.adr.port = 0;
  }

  /**
   * `CL_GetPing` (`cl_main.c:4326–4362`): a ping's server and time, or null for a free slot. Each
   * read also writes the ping's answer, or the lack of one, to every list's row for the server.
   */
  getPing(n: number): PingResult | null {
    const ping = this.pings[n];
    if (ping === undefined || ping.adr.port === 0) return null;

    let time = ping.time;
    if (time === 0) {
      time = this.millis() - ping.start;
      if (time < Math.max(atoi(this.cvars.get('cl_maxPing')), 100)) time = 0;
    }
    this.setByPing(ping, ping.info);
    const adr = { ...ping.named };
    return { address: adrToStringWithPort(adr), adr, time, estimate: ping.estimate };
  }

  /** `CL_GetPingInfo` (`cl_main.c:4369–4380`): the answer's infostring, or empty. */
  getPingInfo(n: number): string {
    const ping = this.pings[n];
    return ping === undefined || ping.adr.port === 0 ? '' : ping.info;
  }

  /** `CL_ClearPing` (`cl_main.c:4387–4393`): the slot freed. */
  clearPing(n: number): void {
    const ping = this.pings[n];
    if (ping !== undefined) ping.adr.port = 0;
  }

  /** `CL_GetPingQueueCount` (`cl_main.c:4400–4416`): the slots in use. */
  pingQueueCount(): number {
    return this.pings.filter((ping) => ping.adr.port !== 0).length;
  }

  /**
   * `CL_GetFreePing` (`cl_main.c:4423–4473`): a free slot, or one no longer kept
   * ({@link PING_KEEP_MSEC}); else the oldest.
   */
  private freePing(): Ping {
    const now = this.millis();
    for (const ping of this.pings) {
      if (ping.adr.port === 0) return ping;
      const kept = ping.time === 0 ? now - ping.start : ping.time;
      if (kept >= PING_KEEP_MSEC) return ping;
    }
    let oldest = this.pings[0];
    for (const ping of this.pings) if (ping.start < oldest.start) oldest = ping;
    return oldest;
  }

  /**
   * `CL_SetServerInfoByAddress` (`cl_main.c:3852–3873`) for a ping: every list's row for the
   * server, by its address and by the name it was asked for by.
   */
  private setByPing(ping: Ping, info: string | null): void {
    for (const list of Object.values(this.lists)) {
      for (const server of list) {
        if (compareAdr(ping.adr, server.adr) || compareAdr(ping.named, server.adr)) {
          setServerInfo(server, info, ping.time, ping.estimate);
        }
      }
    }
  }

  /** `Sys_Milliseconds`: whole msec. */
  private millis(): number {
    return Math.floor(this.now());
  }
}

/**
 * A row for a server with nothing known of it: `CL_InitServerInfo`'s (`cl_main.c:2476–2491`),
 * whose ping is −1, or a slot never used, whose ping is 0.
 */
function serverAt(adr: NetAdr, ping: number): ServerInfo {
  return {
    adr: { ...adr },
    hostName: '',
    mapName: '',
    game: '',
    netType: 0,
    gameType: 0,
    clients: 0,
    maxClients: 0,
    minPing: 0,
    maxPing: 0,
    ping,
    estimate: false,
    humanPlayers: 0,
    needPass: 0
  };
}

/** `CL_SetServerInfo` (`cl_main.c:3832–3850`): a row from a server's info, or only its ping. */
function setServerInfo(
  server: ServerInfo,
  info: string | null,
  ping: number,
  estimate: boolean
): void {
  if (info !== null) {
    const value = (key: string) => infoValueForKey(info, key);
    server.clients = atoi(value('clients'));
    server.hostName = value('hostname').slice(0, MAX_HOSTNAME_LENGTH - 1);
    server.mapName = value('mapname').slice(0, MAX_NAME_LENGTH - 1);
    server.maxClients = atoi(value('sv_maxclients'));
    server.game = value('game').slice(0, MAX_NAME_LENGTH - 1);
    server.gameType = atoi(value('gametype'));
    server.netType = atoi(value('nettype'));
    server.minPing = atoi(value('minping'));
    server.maxPing = atoi(value('maxping'));
    server.humanPlayers = atoi(value('g_humanplayers'));
    server.needPass = atoi(value('g_needpass'));
  }
  server.ping = ping;
  server.estimate = estimate;
}

/** The `nettype` a ping's answer is marked with (`cl_main.c:3934–3947`). */
function netType(from: NetAdr): number {
  if (from.type === NA.IP) return 1;
  if (from.type === NA.IP6) return 2;
  return 0;
}
