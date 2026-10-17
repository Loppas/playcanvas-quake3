import { adrToStringWithPort, type NetAdr } from '../src/net/net';
import { publicAddress } from './common';

/**
 * dpmaster's server list (`servers.c`): the servers that have heartbeated, by address, each
 * forgotten at its timeout.
 *
 * A heartbeat adds a server, which then has {@link TIMEOUT_HEARTBEAT} seconds to answer the
 * master's `getinfo`, and a valid answer keeps it 15 minutes more (`messages.ts`). A server past
 * its timeout is dropped the next time the list is read, as `Sv_IsActive` drops it. Time is
 * dpmaster's `crt_time`, in whole seconds.
 *
 * dpmaster refuses a server on a loopback address unless it runs with `--allow-loopback`. The
 * port's master takes them, since the dev master's servers share its machine.
 */

/** `DEFAULT_MAX_NB_SERVERS` (`servers.h:31`). */
export const MAX_SERVERS = 4096;

/** `DEFAULT_MAX_NB_SERVERS_PER_ADDRESS` (`servers.h:34`): per public address (`common.ts`). */
export const MAX_SERVERS_PER_ADDRESS = 32;

/** `TIMEOUT_HEARTBEAT` (`servers.c:32`): a new server's seconds to answer its `getinfo`. */
export const TIMEOUT_HEARTBEAT = 2;

/** `server_state_t` (`servers.h:63–70`), less the unused slot, which a map has no need of. */
export const SV_STATE = {
  /** Heartbeated, and not yet answered: never listed. */
  UNINITIALIZED: 1,
  EMPTY: 2,
  OCCUPIED: 3,
  FULL: 4
} as const;

/**
 * `server_t` (`servers.h:74–87`). The heartbeat's game, `hb_properties`, is not kept: the only tag
 * the master takes is `DarkPlaces`, whose game is whatever the `infoResponse` names.
 */
export interface Server {
  address: NetAdr;
  /** When it is forgotten. */
  timeout: number;
  /** When its challenge stops being good, or 0 before it has one. */
  challengeTimeout: number;
  challenge: string;
  protocol: number;
  /** One of {@link SV_STATE}. */
  state: number;
  gametype: string;
  gamename: string;
}

export class ServerList {
  /** By address, in the order they were added. */
  private readonly servers = new Map<string, Server>();
  private readonly print: (line: string) => void;

  constructor(print: (line: string) => void) {
    this.print = print;
  }

  /**
   * `Sv_GetByAddr` (`servers.c:523–647`): the server at an address, or, if `add` is set, a new one
   * there, unless its public address has its quota or the list is full.
   *
   * @param now - `crt_time`.
   */
  get(address: NetAdr, now: number, add: boolean): Server | null {
    this.checkTimeouts(now);
    const found = this.servers.get(adrToStringWithPort(address));
    if (found !== undefined || !add) return found ?? null;

    const name = adrToStringWithPort(address);
    const quota = publicAddress(address);
    const same = [...this.servers.values()].filter((sv) => publicAddress(sv.address) === quota);
    if (same.length >= MAX_SERVERS_PER_ADDRESS) {
      this.print(
        `> WARNING: server ${name} isn't allowed (max number of servers reached for this address)`
      );
      return null;
    }
    if (this.servers.size >= MAX_SERVERS) {
      this.print(`> WARNING: can't add server ${name} (server list is full)`);
      return null;
    }

    const server: Server = {
      address: { ...address },
      timeout: now + TIMEOUT_HEARTBEAT,
      challengeTimeout: 0,
      challenge: '',
      protocol: 0,
      state: SV_STATE.UNINITIALIZED,
      gametype: '',
      gamename: ''
    };
    this.servers.set(name, server);
    this.print(
      `> New server added: ${name}. ${this.servers.size} server(s) now registered, ` +
        `including ${same.length + 1} for this address quota`
    );
    return server;
  }

  /**
   * `Sv_GetFirst` and `Sv_GetNext` (`servers.c:657`, `:687`): every server not timed out, from one
   * picked at random and round.
   *
   * @param random - `rand()`'s draw, from 0 up to 1.
   */
  all(now: number, random: () => number): Server[] {
    this.checkTimeouts(now);
    const list = [...this.servers.values()];
    const first = Math.floor(random() * list.length);
    return [...list.slice(first), ...list.slice(0, first)];
  }

  /**
   * A server whose socket has closed, or that has taken another address. dpmaster's servers only
   * time out; the port's are connected to the master, which knows when one has gone.
   */
  remove(address: NetAdr): void {
    this.servers.delete(adrToStringWithPort(address));
  }

  /** `Sv_CheckTimeouts` (`servers.c:213`), and `Sv_Remove`'s report. */
  private checkTimeouts(now: number): void {
    for (const [name, server] of this.servers) {
      if (server.timeout >= now) continue;
      this.servers.delete(name);
      this.print(`> ${name} timed out; ${this.servers.size} server(s) currently registered`);
    }
  }
}
