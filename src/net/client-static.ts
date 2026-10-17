import { atoi } from '../formats/c-scan';
import { tokenize } from '../formats/q3config';
import { CA, type ClientConnection } from './connection';
import type { CvarStore } from './cvar';
import { infoValueForKey } from './info';
import type { WebSocketLike } from './master-link';
import type { Resolved } from './master-protocol';
import { ClientMasters, masterAt, type MasterAt } from './masters';
import { Message } from './msg';
import {
  adrToStringWithPort,
  compareAdr,
  isOutOfBand,
  NA,
  Net,
  netadr,
  parseIPv4,
  PORT_SERVER,
  stringToAdr,
  type NetAdr
} from './net';
import {
  createPeerSocket,
  type PeerConnectionFactory,
  type PeerSignalling
} from './peer-signalling';
import type { PeerSocket } from './peer-socket';
import { readServersResponse, ServerLists } from './server-lists';

/**
 * Quake 3's `cls` (`client.h:263–336`): the client's state that outlasts every connection, which a
 * disconnect never wipes.
 *
 * It holds the page's own socket, the masters that socket reaches everyone through, the server
 * browser's lists, and the servers asked for their status. The socket is the page's alone: a
 * listen server in a worker has its own, and the two never share a peer.
 */

/** `MAX_SERVERSTATUSREQUESTS` (`q_shared.h:1412`): how many servers' status is kept track of. */
const MAX_SERVERSTATUSREQUESTS = 16;

/**
 * The masters `globalservers` names by number: the Internet's, `sv_master1`. The second slot is
 * the LAN's, which `localservers` asks.
 */
const GLOBAL_MASTERS = 1;

/** `Sys_StringToSockaddr`'s words for a name with no address in the family asked. */
const NO_ADDRESS = 'No address of required type found.';

/** A name the masters are looking up for a command. */
interface Lookup {
  name: string;
  port: number;
  /** `NA.IP` or `NA.IP6`, or `NA.UNSPEC` for either. */
  family: number;
  /** The masters asked that have neither answered it with an address nor closed. */
  waiting: NetAdr[];
  /** Why the first master to find no address found none. */
  error: string | null;
  /** Told the address, or null once every master has failed it. */
  then: (adr: NetAdr | null) => void;
}

/** `serverStatus_t` (`cl_main.c:142–152`): a server asked for its status. */
interface ServerStatus {
  /** The server as it was asked for: a name, where the browser keeps one. */
  address: NetAdr;
  /** Where the browser's question went, once a name is found, whose answer is this entry's. */
  sentTo: NetAdr | null;
  /** When it was asked by the browser, which the oldest is reused by and the question re-sent. */
  startTime: number;
  /** Asked, and not yet answered. */
  pending: boolean;
  /** Asked at the console, which the answer goes to. */
  print: boolean;
  /** Answered and taken, so the entry is free for another server. */
  retrieved: boolean;
  /** The last answer. */
  info: string;
  players: string[];
  board: string[];
}

/** A server's answer to `getstatus`, as the browser is handed it. */
export interface StatusReply {
  /** The serverinfo, with the asker's challenge in it. */
  info: string;
  /** A line a player: `<score> <ping> "<name>"`. */
  players: string[];
  /** What a port's server sends after the players: the `scores` command and each player's `cs`. */
  board: string[];
}

export interface ClientStaticOptions {
  /** The one store, where the master slots are read. */
  cvars: CvarStore;
  /** A peer connection: the browser's, or a test's. */
  createPeerConnection: PeerConnectionFactory;
  /** A WebSocket to a master's URL: the browser's, or a test's. */
  connect: (url: string) => WebSocketLike;
  /** `Com_Printf`. */
  print: (text: string) => void;
  /** `Sys_Milliseconds`. */
  now?: () => number;
}

/** The match being played, as the client that outlasts it knows it. */
interface Match {
  /** The match's way out: a loopback to a server in this page, or this client's own. */
  net: Net;
  connection: ClientConnection;
}

export class ClientStatic {
  /** The page's own way out: the socket, which dials a server through the masters. */
  readonly net: Net;
  /** The server browser's lists, which the UI reads. */
  readonly servers: ServerLists;

  private readonly cvars: CvarStore;
  private readonly socket: PeerSocket;
  private readonly signalling: PeerSignalling;
  private readonly masters: ClientMasters;
  private readonly print: (text: string) => void;
  /** The match being played, or null. */
  private match: Match | null = null;
  /**
   * `cl_reconnectArgs`: what the last `connect` named, its family flag and all, which nothing
   * forgets. Null before the first.
   */
  private reconnectArgs: string[] | null = null;
  /** The last `connect`, while its server is being looked up. */
  private connecting: object | null = null;
  /**
   * The LAN master a `localservers` went to, while it has not answered, and the Internet master
   * to ask in its place should it not be reached.
   */
  private lanAsk: { lan: NetAdr; internet: MasterAt | null } | null = null;
  /** The names the masters are looking up. */
  private readonly lookups: Lookup[] = [];
  /** The server the last probe dialled, as it was named and as it was found. */
  private probed: { address: string; to: NetAdr } | null = null;
  /** `cl_serverStatusList`: the servers asked for their status. */
  private readonly serverStatuses: ServerStatus[] = Array.from(
    { length: MAX_SERVERSTATUSREQUESTS },
    () => ({
      address: netadr(NA.BAD),
      sentTo: null,
      startTime: 0,
      pending: false,
      print: false,
      retrieved: false,
      info: '',
      players: [],
      board: []
    })
  );

  constructor(options: ClientStaticOptions) {
    const { cvars, print, now } = options;
    this.cvars = cvars;
    this.print = print;
    const { socket, signalling } = createPeerSocket({
      links: [],
      createPeerConnection: options.createPeerConnection,
      dials: true,
      now
    });
    this.socket = socket;
    this.signalling = signalling;
    this.net = new Net({ cvars, socket, now, print });
    this.masters = new ClientMasters({ cvars, signalling, connect: options.connect, print });
    this.masters.onClosed = (master, opened) => this.closed(master, opened);
    this.masters.onResolved = (master, answer) => this.resolved(master, answer);
    this.servers = new ServerLists({ cvars, now: this.net.now, print });
    // `CL_Init`'s `Cvar_Get` (`cl_main.c:3616`).
    if (cvars.get('cl_serverStatusResendTime') === '') {
      cvars.set('cl_serverStatusResendTime', '750');
    }
  }

  /**
   * A match starts: what its connection is sent that is this client's — a server's status — comes
   * here, and a status with no server named asks the match's.
   *
   * @param net - The match's way out: one whose loopback reaches a server in this page, or this
   *   client's own, to a server elsewhere, whose socket the match then reads.
   * @param connection - The match's connection.
   */
  attach(net: Net, connection: ClientConnection): void {
    this.match = { net, connection };
    connection.onConnectionless = (from, data, time) => this.connectionless(from, data, time);
  }

  /** The match is over. */
  detach(): void {
    if (this.match !== null) this.match.connection.onConnectionless = null;
    this.match = null;
  }

  /**
   * The client's own frame: the master slots followed, what the socket has read, and what a delay
   * held back sent. A match whose server is elsewhere reads the socket itself, as its
   * connection's, and hands on what is this client's.
   */
  frame(): void {
    this.masters.follow();
    for (let packet; this.match?.net !== this.net && (packet = this.net.getPacket()) !== null; ) {
      // With no connection on the socket, only its out-of-band answers mean anything.
      if (isOutOfBand(packet.data)) this.connectionless(packet.from, packet.data, packet.time);
    }
    this.net.flushPacketQueue();
  }

  /** Every connection closed, as the page goes. */
  close(): void {
    this.masters.close();
    this.signalling.close();
  }

  /**
   * `CL_Connect_f` (`cl_main.c:1690–1777`), up to the connection: the arguments kept for
   * `reconnect`, whatever the page was playing left, and the server named looked up. Quake 3 looks
   * it up at once; the port's masters answer a name in their own time.
   *
   * @param argv - `connect [-4|-6] server`, tokenised.
   * @param leave - Shut down any server in this page and leave any match, with the words its
   *   clients elsewhere are told: "Server quit" where the server named is exactly the loopback
   *   (`SV_Shutdown`), else `sv_killserver`'s "Server was killed". Given the server as named.
   * @param found - Told the server as named and where it is, or null when it isn't found. Not
   *   told at all when another `connect` has come since.
   */
  connect(
    argv: readonly string[],
    leave: (finalMessage: string, server: string) => void,
    found: (server: string, address: NetAdr | null) => void
  ): void {
    if (argv.length !== 2 && argv.length !== 3) {
      this.print('usage: connect [-4|-6] server');
      return;
    }
    const { server, family } = this.familyArg(argv);
    this.reconnectArgs = argv.slice(1);
    leave(server === 'localhost' ? 'Server quit' : 'Server was killed', server);
    const asked = {};
    this.connecting = asked;
    this.resolve(server, family, (adr) => {
      if (this.connecting !== asked) return;
      this.connecting = null;
      if (adr === null) {
        this.print('Bad server address');
        found(server, null);
        return;
      }
      const address = adr.port === 0 ? { ...adr, port: PORT_SERVER } : adr;
      this.print(`${server} resolved to ${adrToStringWithPort(address)}`);
      this.cvars.set('cl_currentServerAddress', server);
      found(server, address);
    });
  }

  /**
   * `CL_Reconnect_f` (`cl_main.c:1677–1682`): the last `connect` again, found afresh. Before the
   * first there is nothing to do.
   */
  reconnect(
    leave: (finalMessage: string, server: string) => void,
    found: (server: string, address: NetAdr | null) => void
  ): void {
    if (this.reconnectArgs !== null) this.connect(['connect', ...this.reconnectArgs], leave, found);
  }

  /**
   * `CL_GlobalServers_f` (`cl_main.c:4227–4318`): ask the Internet master for its list, 0 asking
   * every Internet master there is. The question is always `getserversExt`, so the list names
   * servers of both families: an address is only a master's name for a socket, and a channel finds
   * its own way.
   *
   * @param argv - `globalservers <master# 0-1> <protocol> [keywords]`, tokenised.
   */
  globalServers(argv: readonly string[]): void {
    const masterNum = argv.length < 3 ? -1 : atoi(argv[1]);
    if (masterNum < 0 || masterNum > GLOBAL_MASTERS) {
      this.print(`usage: globalservers <master# 0-${GLOBAL_MASTERS}> <protocol> [keywords]`);
      return;
    }

    if (masterNum === 0) {
      let named = 0;
      for (let i = 1; i <= GLOBAL_MASTERS; i++) {
        if (this.cvars.get(`sv_master${i}`) === '') continue;
        named++;
        this.globalServers(['globalservers', String(i), ...argv.slice(2)]);
      }
      if (named === 0) this.print('CL_GlobalServers_f: Error: No master server addresses.');
      return;
    }

    const slot = this.cvars.get(`sv_master${masterNum}`);
    if (slot === '') {
      this.print('CL_GlobalServers_f: Error: No master server address given.');
      return;
    }
    const at = masterAt(slot);
    if (at === null) {
      this.print(`CL_GlobalServers_f: Error: could not resolve address of master ${slot}`);
      return;
    }

    this.print(`Requesting servers from ${slot} (${adrToStringWithPort(at.adr)})...`);
    this.servers.askGlobal();
    this.masters.follow();
    // Quake 3 sends it as its server would, which only `sv_packetdelay` tells apart.
    const question = [`getserversExt ${this.net.gamename} ${argv[2]}`, ...argv.slice(3)];
    this.net.outOfBandPrint('server', at.adr, question.join(' '));
  }

  /**
   * `CL_LocalServers_f` (`cl_main.c:4179–4216`): find the servers on the player's network. Quake 3
   * broadcasts `getinfo` there; a page can't, so it asks the LAN master for the servers that share
   * the player's network, or the Internet master when the LAN slot names none or its master can't
   * be reached. The answer is addresses alone, which the browser pings for their info.
   */
  localServers(): void {
    this.print('Scanning for servers on the local network...');
    this.servers.askLocal();
    this.masters.follow();
    const lan = masterAt(this.cvars.get('sv_master2'));
    const internet = masterAt(this.cvars.get('sv_master1'));
    this.lanAsk = lan === null ? null : { lan: lan.adr, internet };
    const master = lan ?? internet;
    if (master !== null) this.askLocal(master.adr);
  }

  /**
   * `CL_Ping_f` (`cl_main.c:4480–4523`): a `getinfo` to a server, whose answer is timed. One sent
   * through the masters, with no channel to the server open, is marked an estimate. A name the
   * masters look up holds its ping's slot meanwhile, as Quake 3's lookup holds up the command, so
   * the browser counts it out and times it out as any other.
   *
   * @param argv - `ping [-4|-6] server`, tokenised.
   */
  ping(argv: readonly string[]): void {
    if (argv.length !== 2 && argv.length !== 3) {
      this.print('usage: ping [-4|-6] server');
      return;
    }
    const { server, family } = this.familyArg(argv);
    const named = stringToAdr(server);
    let answered = false;
    let held = false;
    this.resolve(server, family, (to) => {
      answered = true;
      if (to === null) {
        if (held) this.servers.release(named!);
        return;
      }
      this.masters.follow();
      this.servers.ping(to, to.type !== NA.LOOPBACK && !this.socket.isOpen(to), named ?? to);
      this.netFor(to).outOfBandPrint('client', to, 'getinfo xxx');
    });
    if (!answered && named !== null) {
      this.servers.ping(named, true);
      held = true;
    }
  }

  /**
   * The port's own: a data channel opened to a server with nothing sent down it, so that a ping or
   * a status asked after goes straight there and is timed by the way a match would take. A name is
   * looked up first.
   *
   * @param address - The server, as a list writes it.
   */
  probe(address: string): void {
    this.resolve(address, NA.UNSPEC, (to) => {
      if (to === null || to.type === NA.LOOPBACK) return;
      this.probed = { address, to };
      this.masters.follow();
      this.signalling.dial(to);
    });
  }

  /**
   * Whether the channel the last {@link probe} opened to a server is open now, so that a ping sent
   * to it goes straight there.
   *
   * @param address - The server, as the probe was given it.
   */
  probeOpen(address: string): boolean {
    const { probed } = this;
    return probed !== null && probed.address === address && this.socket.isOpen(probed.to);
  }

  /**
   * `CL_ServerStatus_f` (`cl_main.c:4634–4684`): ask a server for its status, and print the answer
   * when it comes. With no server named, it is the one being played on.
   *
   * @param argv - `serverstatus [-4|-6] [server]`, tokenised.
   */
  serverStatus(argv: readonly string[]): void {
    if (argv.length !== 2 && argv.length !== 3) {
      const { match } = this;
      if (match === null || match.connection.state !== CA.ACTIVE) {
        this.print('Not connected to a server.');
        this.print('usage: serverstatus [-4|-6] server');
        return;
      }
      this.askServerStatus(match.connection.serverAddress);
      return;
    }
    const { server, family } = this.familyArg(argv);
    this.resolve(server, family, (to) => {
      if (to !== null) this.askServerStatus(to);
    });
  }

  /**
   * `CL_ServerStatus` (`cl_main.c:4023–4079`), the browser's `LAN_GetServerStatus`: a server's
   * status once its answer is in, the question re-sent every `cl_serverStatusResendTime` until
   * then. An answer is handed over for as long as it stands, so the browser lets every server go
   * before it asks afresh; until it first has, no entry is free to ask with. A name is looked up
   * each time the question goes, as `NET_StringToAdr` looks it up at every call.
   *
   * @param address - The server, or null to let every server go.
   * @param take - false to let this server go without its answer.
   * @returns the answer, or null
   */
  getServerStatus(address: string | null, take = true): StatusReply | null {
    if (address === null) {
      for (const status of this.serverStatuses) {
        status.address.port = 0;
        status.retrieved = true;
      }
      return null;
    }
    const to = stringToAdr(address);
    if (to === null) return null;
    const status = this.serverStatusFor(to);
    if (!take) {
      status.retrieved = true;
      return null;
    }

    const now = Math.floor(this.net.now());
    if (compareAdr(to, status.address)) {
      if (!status.pending) {
        status.retrieved = true;
        status.startTime = 0;
        return { info: status.info, players: [...status.players], board: [...status.board] };
      }
      const resend = atoi(this.cvars.get('cl_serverStatusResendTime'));
      if (status.startTime < now - resend) this.askStatus(status, address, now);
    } else if (status.retrieved) {
      status.address = { ...to };
      this.askStatus(status, address, now);
    }
    return null;
  }

  /** `serverstatus`' question, whose answer is printed. */
  private askServerStatus(to: NetAdr): void {
    this.masters.follow();
    this.netFor(to).outOfBandPrint('client', to, 'getstatus');
    const status = this.serverStatusFor(to);
    status.address = { ...to };
    status.sentTo = null;
    status.print = true;
    status.pending = true;
  }

  /**
   * The browser's `getstatus`, which prints nothing, sent once the server is found. A lookup that
   * ends after the entry has gone to another server, or been answered, sends nothing.
   */
  private askStatus(status: ServerStatus, address: string, now: number): void {
    status.print = false;
    status.pending = true;
    status.retrieved = false;
    status.startTime = now;
    status.sentTo = null;
    const asked = { ...status.address };
    this.resolve(address, NA.UNSPEC, (to) => {
      if (to === null || !status.pending || !compareAdr(status.address, asked)) return;
      status.sentTo = to;
      this.masters.follow();
      this.netFor(to).outOfBandPrint('client', to, 'getstatus');
    });
  }

  /** `localservers`' question, to a master. */
  private askLocal(master: NetAdr): void {
    const { gamename, protocol } = this.net;
    this.net.outOfBandPrint('client', master, `getserversExt ${gamename} ${protocol} local`);
  }

  /**
   * The server and family of `[-4|-6] server`, as `connect`, `ping` and `serverstatus` take them.
   * Any other flag is warned of, and asks for either family.
   */
  private familyArg(argv: readonly string[]): { server: string; family: number } {
    if (argv.length === 2) return { server: argv[1], family: NA.UNSPEC };
    const family = argv[1] === '-4' ? NA.IP : argv[1] === '-6' ? NA.IP6 : NA.UNSPEC;
    if (family === NA.UNSPEC) this.print('warning: only -4 or -6 as address type understood.');
    return { server: argv[2], family };
  }

  /**
   * `NET_StringToAdr` (`net_chan.c:629–690`) for a command, which goes on once the address is
   * known. `localhost` is the loopback and a number is its own address, at once. A name goes to
   * every master, since a page has no lookup of its own, and the first to answer with an address
   * of the family asked wins. When every master has found none or closed, the lookup fails with
   * `Sys_StringToSockaddr`'s line and the reason of the first master to find none.
   *
   * @param family - `NA.IP` or `NA.IP6`, or `NA.UNSPEC` for either.
   * @param then - Told the address, or null when there is none.
   */
  private resolve(s: string, family: number, then: (adr: NetAdr | null) => void): void {
    const adr = stringToAdr(s);
    if (adr === null) {
      then(null);
      return;
    }
    if (adr.type !== NA.IP || parseIPv4(adr.ip) !== null) {
      if (adr.type === NA.LOOPBACK || family === NA.UNSPEC || family === adr.type) {
        then(adr);
      } else {
        this.print(`Sys_StringToSockaddr: Error resolving ${adr.ip}: ${NO_ADDRESS}`);
        then(null);
      }
      return;
    }

    this.masters.follow();
    const waiting = this.masters.named();
    const lookup: Lookup = { name: adr.ip, port: adr.port, family, waiting, error: null, then };
    this.lookups.push(lookup);
    if (waiting.length === 0) this.failIfUnanswered(lookup);
    else this.masters.resolve(lookup.name, lookup.port);
  }

  /** A master's answer to a name: each lookup of it waiting on the master takes its first fit. */
  private resolved(master: NetAdr, answer: Resolved): void {
    for (const lookup of [...this.lookups]) {
      if (lookup.name !== answer.name || lookup.port !== answer.port) continue;
      if (!this.answered(lookup, master)) continue;
      const { family } = lookup;
      const adr = answer.addresses.find((a) => family === NA.UNSPEC || a.type === family);
      if (adr === undefined) {
        lookup.error ??= answer.error ?? NO_ADDRESS;
        this.failIfUnanswered(lookup);
        continue;
      }
      this.lookups.splice(this.lookups.indexOf(lookup), 1);
      lookup.then(adr);
    }
  }

  /** A master's connection gone: what it was asked and has not answered, it never will. */
  private closed(master: NetAdr, opened: boolean): void {
    if (!opened) this.unreachable(master);
    for (const lookup of [...this.lookups]) {
      if (this.answered(lookup, master)) this.failIfUnanswered(lookup);
    }
  }

  /** The master taken off what a lookup waits on, and whether it was on it. */
  private answered(lookup: Lookup, master: NetAdr): boolean {
    const index = lookup.waiting.findIndex((adr) => compareAdr(adr, master));
    if (index !== -1) lookup.waiting.splice(index, 1);
    return index !== -1;
  }

  /** A lookup no master is left to answer, failed. */
  private failIfUnanswered(lookup: Lookup): void {
    if (lookup.waiting.length > 0) return;
    this.lookups.splice(this.lookups.indexOf(lookup), 1);
    const reason = lookup.error ?? 'no master answered';
    this.print(`Sys_StringToSockaddr: Error resolving ${lookup.name}: ${reason}`);
    lookup.then(null);
  }

  /**
   * A master that can't be reached. The LAN's, while a `localservers` waits on it, gives way to
   * the Internet's.
   */
  private unreachable(master: NetAdr): void {
    const ask = this.lanAsk;
    if (ask === null || !compareAdr(master, ask.lan)) return;
    this.lanAsk = null;
    if (ask.internet !== null && !compareAdr(ask.internet.adr, master)) {
      this.askLocal(ask.internet.adr);
    }
  }

  /** The way to a server: a match's loopback for one in this page, else the socket. */
  private netFor(to: NetAdr): Net {
    return to.type === NA.LOOPBACK && this.match !== null ? this.match.net : this.net;
  }

  /**
   * The answers of `CL_ConnectionlessPacket` (`cl_main.c:2623–2830`) that are this client's rather
   * than a connection's.
   *
   * @param time - When it landed, where its socket said; else now.
   */
  private connectionless(from: NetAdr, data: Uint8Array, time = this.net.now()): void {
    const msg = Message.read(data);
    msg.beginReading(true);
    msg.readLong();
    const c = tokenize(msg.readStringLine())[0] ?? '';
    switch (c.toLowerCase()) {
      case 'inforesponse':
        this.serverInfoPacket(from, msg, time);
        return;
      case 'statusresponse':
        this.serverStatusResponse(from, msg);
        return;
    }
    // By their start, since a list's entries follow its name with no space between.
    if (c.startsWith('getserversResponse')) this.serversResponse(from, data, false);
    else if (c.startsWith('getserversExtResponse')) this.serversResponse(from, data, true);
  }

  /** `CL_ServersResponsePacket` (`cl_main.c:2500–2614`): a master's list, whoever sent it. */
  private serversResponse(from: NetAdr, data: Uint8Array, extended: boolean): void {
    this.print(`CL_ServersResponsePacket from ${adrToStringWithPort(from)}`);
    if (this.lanAsk !== null && compareAdr(from, this.lanAsk.lan)) this.lanAsk = null;
    const servers = readServersResponse(data, extended);
    const total = this.servers.listed(servers);
    this.print(`${servers.length} servers parsed (total ${total})`);
  }

  /**
   * `CL_ServerInfoPacket` (`cl_main.c:3880–3918`): a server's answer to `getinfo`, taken only from
   * a server of this game and protocol.
   */
  private serverInfoPacket(from: NetAdr, msg: Message, time: number): void {
    const info = msg.readString();
    if (infoValueForKey(info, 'gamename') !== this.net.gamename) return;
    if (atoi(infoValueForKey(info, 'protocol')) !== this.net.protocol) return;
    this.servers.infoResponse(from, info, time);
  }

  /**
   * `CL_GetServerStatus` (`cl_main.c:3994–4016`): the address's own entry, else one that has been
   * answered and taken, else the one asked longest ago.
   */
  private serverStatusFor(adr: NetAdr): ServerStatus {
    const list = this.serverStatuses;
    const own = list.find((status) => compareAdr(adr, status.address));
    if (own) return own;
    const taken = list.find((status) => status.retrieved);
    if (taken) return taken;
    let oldest = list[0];
    for (const status of list) if (status.startTime < oldest.startTime) oldest = status;
    return oldest;
  }

  /**
   * `CL_ServerStatusResponse` (`cl_main.c:4086–4172`): a server's status, taken only from a server
   * that was asked, and printed if it was asked at the console.
   *
   * Quake 3 reads the players up to the first blank line. A port's server goes on past it with the
   * board, which is kept for the browser.
   */
  private serverStatusResponse(from: NetAdr, msg: Message): void {
    const status = this.serverStatuses.find(
      (entry) =>
        compareAdr(from, entry.address) || (entry.sentTo !== null && compareAdr(from, entry.sentTo))
    );
    if (!status) return;

    const info = msg.readStringLine();
    status.info = info;
    if (status.print) {
      this.print('Server settings:');
      const parts = info.split('\\');
      for (let i = parts[0] === '' ? 1 : 0; i < parts.length; i += 2) {
        const key = parts[i].padEnd(24);
        this.print(i + 1 < parts.length ? `${key}${parts[i + 1]}` : key);
      }
      this.print('');
      this.print('Players:');
      this.print('num: score: ping: name:');
    }

    status.players = [];
    for (let i = 0, line = msg.readStringLine(); line !== ''; line = msg.readStringLine(), i++) {
      status.players.push(line);
      if (!status.print) continue;
      // `sscanf( s, "%d %d" )`, and the name is whatever follows the second space, quotes and all.
      const numbers = /^\s*([+-]?\d+)(?:\s*([+-]?\d+))?/.exec(line);
      const score = numbers ? Number(numbers[1]) : 0;
      const ping = numbers?.[2] !== undefined ? Number(numbers[2]) : 0;
      const first = line.indexOf(' ');
      const second = first === -1 ? -1 : line.indexOf(' ', first + 1);
      const name = second === -1 ? 'unknown' : line.slice(second + 1);
      this.print(
        `${String(i).padEnd(2)}   ${String(score).padEnd(3)}    ${String(ping).padEnd(3)}   ${name}`
      );
    }
    status.board = [];
    for (let line = msg.readStringLine(); line !== ''; line = msg.readStringLine()) {
      status.board.push(line);
    }

    status.pending = false;
    if (status.print) status.retrieved = true;
  }
}
