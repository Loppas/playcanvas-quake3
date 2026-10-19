import { atoi, strtol } from '../src/formats/c-scan';
import { infoPairs } from '../src/net/info';
import {
  adrToStringWithPort,
  GAMENAME,
  HEARTBEAT_FOR_MASTER,
  isLANAddress,
  isOutOfBand,
  NA,
  parseIPv4,
  parseIPv6,
  type NetAdr
} from '../src/net/net';
import type { Throttle } from './clients';
import { publicAddress } from './common';
import { SV_STATE, type Server, type ServerList } from './servers';

/**
 * dpmaster's messages (`messages.c`): a server's `heartbeat` and the `getinfo` it earns, the
 * `infoResponse` that lists the server, and a client's `getservers` or `getserversExt`, answered
 * with the list. The protocol is dpmaster's
 * [techinfo.txt](https://github.com/kphillisjr/dpmaster/blob/master/doc/techinfo.txt).
 *
 * The master takes one game, the port's, and one heartbeat tag, `DarkPlaces`, which leaves the
 * game to the `infoResponse` to name. dpmaster's table of other games, with their own tags and
 * their anonymous `getservers <protocol>`, has no entry here: an unknown tag is refused, and an
 * anonymous query lists nothing, as dpmaster's would for a game it has no entry for.
 *
 * Time is dpmaster's `crt_time`, in whole seconds, so a window of 2 is 2 to 3 seconds.
 */

/** `TIMEOUT_INFORESPONSE` (`messages.c:36`): how long a valid `infoResponse` lists a server. */
export const TIMEOUT_INFORESPONSE = 15 * 60;

/** `TIMEOUT_CHALLENGE` (`messages.c:39`): how long a `getinfo`'s challenge is good. */
export const TIMEOUT_CHALLENGE = 2;

/** `MAX_PACKET_SIZE_OUT` (`messages.c:42`): the largest reply. */
export const MAX_PACKET_SIZE_OUT = 1400;

/** `MAX_PACKET_SIZE_IN` (`common.h:58`): what is read of a datagram. */
export const MAX_PACKET_SIZE_IN = 2048;

/** `MIN_PACKET_SIZE_IN` (`common.h:59`): anything shorter is refused. */
const MIN_PACKET_SIZE_IN = 5;

/** `CHALLENGE_MIN_LENGTH` and `CHALLENGE_MAX_LENGTH` (`servers.h:40–41`), each with its NUL. */
const CHALLENGE_MIN_LENGTH = 9;
const CHALLENGE_MAX_LENGTH = 12;

/** `GAMENAME_LENGTH` and `GAMETYPE_LENGTH` (`servers.h:44`, `:47`), each with its NUL. */
const GAMENAME_LENGTH = 64;
const GAMETYPE_LENGTH = 32;

export interface MessagesOptions {
  servers: ServerList;
  throttle: Throttle;
  /** `crt_time`, in whole seconds. */
  now: () => number;
  /** `rand()`'s draw, from 0 up to 1. */
  random: () => number;
  /** A `getinfo` to a server: down a data channel the master dials to it, or the server's link. */
  sendGetInfo: (to: NetAdr, data: Uint8Array) => void;
  /** Every server registered with the master, which `local` lists from. */
  registered: () => NetAdr[];
  print: (line: string) => void;
}

export class Messages {
  private readonly servers: ServerList;
  private readonly throttle: Throttle;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sendGetInfo: (to: NetAdr, data: Uint8Array) => void;
  private readonly registered: () => NetAdr[];
  private readonly print: (line: string) => void;

  constructor(options: MessagesOptions) {
    this.servers = options.servers;
    this.throttle = options.throttle;
    this.now = options.now;
    this.random = options.random;
    this.sendGetInfo = options.sendGetInfo;
    this.registered = options.registered;
    this.print = options.print;
  }

  /**
   * A datagram to the master, read as dpmaster reads one (`dpmaster.c:1052–1113`): its first
   * {@link MAX_PACKET_SIZE_IN} bytes, the marker checked, and the rest as text up to its first
   * NUL. Then `HandleMessage` (`messages.c:886`), by the message's first word, case and all.
   *
   * @param reply - The way back to the sender, which the list goes by.
   */
  handle(data: Uint8Array, from: NetAdr, reply: (data: Uint8Array) => void): void {
    const packet = data.subarray(0, MAX_PACKET_SIZE_IN);
    if (packet.length < MIN_PACKET_SIZE_IN || !isOutOfBand(packet)) return;
    const body = packet.subarray(4);
    const nul = body.indexOf(0);
    const msg = String.fromCharCode(...(nul === -1 ? body : body.subarray(0, nul)));

    if (msg.startsWith('heartbeat ')) {
      this.heartbeat(msg.slice('heartbeat '.length), from);
    } else if (msg.startsWith('infoResponse\n')) {
      this.print(`> ${adrToStringWithPort(from)} ---> infoResponse`);
      const server = this.servers.get(from, this.now(), false);
      if (server === null) {
        this.print(`> WARNING: infoResponse from unknown server ${adrToStringWithPort(from)}`);
        return;
      }
      this.infoResponse(server, msg.slice('infoResponse\n'.length), from);
    } else if (msg.startsWith('getservers ')) {
      this.getServers(msg.slice('getservers '.length), from, reply, false);
    } else if (msg.startsWith('getserversExt ')) {
      this.getServers(msg.slice('getserversExt '.length), from, reply, true);
    }
  }

  /** `HandleHeartbeat` (`messages.c:245–304`): a server, added if it is new, asked its info. */
  private heartbeat(msg: string, from: NetAdr): void {
    // `sscanf( msg, "%63s", tag )`.
    const tag = /^[\t\n\v\f\r ]*([^\t\n\v\f\r ]{0,63})/.exec(msg)?.[1] ?? '';
    const name = adrToStringWithPort(from);
    this.print(`> ${name} ---> heartbeat (${tag})`);
    // dpmaster's `HEARTBEAT_DARKPLACES`, the one tag it takes here.
    if (tag !== HEARTBEAT_FOR_MASTER) {
      this.print(`> WARNING: Rejecting heartbeat from ${name} (heartbeat "${tag}" is unknown)`);
      return;
    }

    const server = this.servers.get(from, this.now(), true);
    if (server !== null) this.getInfo(server);
  }

  /**
   * `SendGetInfo` (`messages.c:210–235`): a `getinfo` with the server's challenge, which is made
   * anew once the last has timed out, so a heartbeat within its window is asked with the same one.
   */
  private getInfo(server: Server): void {
    const now = this.now();
    if (server.challengeTimeout === 0 || server.challengeTimeout < now) {
      server.challenge = this.buildChallenge();
      server.challengeTimeout = now + TIMEOUT_CHALLENGE;
    }
    this.sendGetInfo(server.address, outOfBand(`getinfo ${server.challenge}`));
    const name = adrToStringWithPort(server.address);
    this.print(`> ${name} <--- getinfo with challenge "${server.challenge}"`);
  }

  /**
   * `BuildChallenge` (`messages.c:178–200`): 8 to 11 characters from 33 to 126, less the five a
   * Quake 3 server would alter or cut, `\ ; " % /`.
   */
  private buildChallenge(): string {
    let length = CHALLENGE_MIN_LENGTH - 1;
    length += this.rand() % (CHALLENGE_MAX_LENGTH - CHALLENGE_MIN_LENGTH + 1);
    let challenge = '';
    while (challenge.length < length) {
      const c = String.fromCharCode(33 + (this.rand() % (126 - 33 + 1)));
      if (!'\\;"%/'.includes(c)) challenge += c;
    }
    return challenge;
  }

  /** `rand()` as glibc's: 31 bits. */
  private rand(): number {
    return Math.floor(this.random() * 0x80000000);
  }

  /**
   * `HandleInfoResponse` (`messages.c:725–874`): the server's answer checked against its challenge
   * and dpmaster's rules, and, if it passes, the server listed as it says it is.
   */
  private infoResponse(server: Server, msg: string, from: NetAdr): void {
    const name = adrToStringWithPort(from);
    const invalid = (why: string) => {
      this.print(`> WARNING: invalid infoResponse from ${name} (${why})`);
    };

    const now = this.now();
    if (server.challengeTimeout === 0 || server.challengeTimeout < now) {
      this.print(`> WARNING: infoResponse with obsolete challenge from ${name}`);
      return;
    }
    const challenge = searchInfostring(msg, 'challenge');
    if (challenge !== server.challenge) {
      this.print(`> WARNING: invalid challenge from ${name} (${challenge})`);
      return;
    }

    const protocolText = searchInfostring(msg, 'protocol');
    if (protocolText === null) return invalid('no protocol value');
    const protocol = strtol(protocolText);
    if (protocol.end === 0 || protocol.end !== protocolText.length) {
      return invalid(`invalid protocol value: ${protocolText}`);
    }

    const gametype = searchInfostring(msg, 'gametype') ?? '0';
    if (gametype.includes(' ')) return invalid('game type contains whitespaces');

    // Both unsigned, as dpmaster reads them.
    const maxclients = atoi(searchInfostring(msg, 'sv_maxclients') ?? '') >>> 0;
    if (maxclients === 0) return invalid(`sv_maxclients = ${maxclients}`);
    const clientsText = searchInfostring(msg, 'clients');
    if (clientsText === null) return invalid('no "clients" value');
    const clients = atoi(clientsText) >>> 0;

    // With the `DarkPlaces` tag, the game is the reply's to name.
    const gamename = searchInfostring(msg, 'gamename');
    if (gamename === null) return invalid('no game name');
    if (gamename === '') return invalid('game name is void');
    if (gamename.includes(' ')) return invalid('game name contains whitespaces');
    if (gamename !== GAMENAME) {
      this.print(
        `> WARNING: Rejecting infoResponse from ${name} (game "${gamename}" is not accepted)`
      );
      return;
    }

    server.gamename = gamename.slice(0, GAMENAME_LENGTH - 1);
    server.protocol = protocol.value | 0;
    server.gametype = gametype.slice(0, GAMETYPE_LENGTH - 1);
    if (clients === 0) server.state = SV_STATE.EMPTY;
    else if (clients === maxclients) server.state = SV_STATE.FULL;
    else server.state = SV_STATE.OCCUPIED;
    server.timeout = now + TIMEOUT_INFORESPONSE;
  }

  /**
   * `HandleGetServers` (`messages.c:314–715`): the list, filtered by the query's words and packed
   * in replies of up to {@link MAX_PACKET_SIZE_OUT} bytes, the last ending in `\EOT\0\0\0`.
   *
   * One word is the port's own. `local` lists every server registered with the master that shares
   * the asker's network, whether it heartbeats or not: its public address, or any private address
   * when the asker's is private, which is how a browser finds the servers on its LAN. Only the
   * family words apply to it, since the master knows nothing else of a server that has not
   * heartbeated.
   */
  private getServers(
    msg: string,
    from: NetAdr,
    reply: (data: Uint8Array) => void,
    extended: boolean
  ): void {
    if (this.throttle.blocked(from, this.now())) return;
    const request = extended ? 'getserversExt' : 'getservers';
    const name = adrToStringWithPort(from);

    // A leading number, followed by nothing or a space, is an anonymous query's protocol.
    const leading = strtol(msg);
    const anonymous =
      !extended && leading.end !== 0 && (leading.end === msg.length || msg[leading.end] === ' ');

    let gamename = '';
    let protocol = leading.value;
    let rest = msg.slice(leading.end);
    if (!anonymous) {
      let at = 0;
      while (msg[at] === ' ') at++;
      if (at === msg.length) {
        this.print(
          `> WARNING: Rejecting ${request} from ${name} (missing game name and protocol number)`
        );
        return;
      }
      gamename = msg.slice(at, at + GAMENAME_LENGTH - 1).split(' ')[0];
      const number = strtol(msg, at + gamename.length);
      const after = msg[number.end];
      if (number.end === at + gamename.length || (after !== ' ' && after !== undefined)) {
        this.print(
          `> WARNING: Rejecting ${request} from ${name} (missing or invalid protocol number)`
        );
        return;
      }
      protocol = number.value;
      rest = msg.slice(number.end);
    }
    protocol |= 0;

    this.print(`> ${name} ---> ${request} (${gamename || 'unknown game'}, ${protocol})`);
    if (gamename !== '' && gamename !== GAMENAME) {
      this.print(
        `> WARNING: Rejecting ${request} from ${name} (game "${gamename}" is not accepted)`
      );
      return;
    }

    let empty = false;
    let full = false;
    let ipv4 = !extended;
    let ipv6 = false;
    let gametype: string | null = null;
    let local = false;
    for (const word of rest.split(' ')) {
      if (word === 'empty') empty = true;
      else if (word === 'full') full = true;
      else if (word === 'ffa') gametype = '0';
      else if (word === 'tourney') gametype = '1';
      else if (word === 'team') gametype = '3';
      else if (word === 'ctf') gametype = '4';
      else if (word.startsWith('gametype=')) gametype = word.slice(9, 9 + GAMETYPE_LENGTH - 1);
      else if (word === 'local') local = true;
      else if (extended && word === 'ipv4') ipv4 = true;
      else if (extended && word === 'ipv6') ipv6 = true;
    }
    if (!ipv4 && !ipv6) ipv4 = ipv6 = true;
    const family = (adr: NetAdr) => (adr.type === NA.IP6 ? ipv6 : ipv4);

    let addresses: NetAdr[];
    if (local) {
      addresses = this.registered().filter((adr) => family(adr) && sameNetwork(adr, from));
    } else {
      addresses = this.servers
        .all(this.now(), this.random)
        .filter(
          (sv) =>
            sv.state !== SV_STATE.UNINITIALIZED &&
            sv.protocol === protocol &&
            (empty || sv.state !== SV_STATE.EMPTY) &&
            (full || sv.state !== SV_STATE.FULL) &&
            family(sv.address) &&
            (gametype === null || sv.gametype === gametype) &&
            sv.gamename === gamename
        )
        .map((sv) => sv.address);
    }

    const header = outOfBand(`${request}Response`);
    let packet: number[] = [...header];
    let count = 0;
    const send = () => {
      reply(Uint8Array.from(packet));
      this.print(`> ${name} <--- ${request}Response (${count} servers)`);
      packet = [...header];
      count = 0;
    };
    for (const adr of addresses) {
      const entry = packEntry(adr);
      if (entry === null) continue;
      if (packet.length + entry.length > MAX_PACKET_SIZE_OUT) send();
      packet.push(...entry);
      count++;
    }
    const eot = [...'\\EOT\0\0\0'].map((c) => c.charCodeAt(0));
    if (packet.length + eot.length > MAX_PACKET_SIZE_OUT) send();
    packet.push(...eot);
    send();
  }
}

/**
 * `SearchInfostring` (`messages.c:85–168`): a key's value, or null when the string has no such key.
 * Unlike Quake 3's `Info_ValueForKey`, the key's case counts, and a value over 255 characters
 * reads as none.
 */
function searchInfostring(info: string, key: string): string | null {
  if (!info.startsWith('\\')) return null;
  const value = infoPairs(info).find(([k]) => k === key)?.[1];
  return value === undefined || value.length > 255 ? null : value;
}

/** One server in a list: `\` and 4 bytes of IPv4, or `/` and 16 of IPv6, then the port's 2. */
function packEntry(adr: NetAdr): number[] | null {
  const ip = adr.type === NA.IP6 ? parseIPv6(adr.ip) : parseIPv4(adr.ip);
  if (ip === null) return null;
  const mark = adr.type === NA.IP6 ? '/' : '\\';
  return [mark.charCodeAt(0), ...ip, adr.port >> 8, adr.port & 0xff];
}

/**
 * Whether two addresses are on one network, for `local`: one public address (`common.ts`), or
 * both private, since a master on a LAN sees every machine there by its own address.
 */
function sameNetwork(a: NetAdr, b: NetAdr): boolean {
  return publicAddress(a) === publicAddress(b) || (isPrivate(a) && isPrivate(b));
}

/**
 * A private address, or the master's own machine's: a server there reaches the master over its
 * loopback, and is on the LAN the master serves. `isLANAddress` counts IPv4's loopback net but
 * not IPv6's `::1`.
 */
function isPrivate(adr: NetAdr): boolean {
  return isLANAddress(adr) || (adr.type === NA.IP6 && adr.ip === '::1');
}

/** Text behind the out-of-band marker, a byte to a character. */
function outOfBand(text: string): Uint8Array {
  return Uint8Array.from(`\xff\xff\xff\xff${text}`, (c) => c.charCodeAt(0));
}
