import type { NetAdr } from '../src/net/net';
import { publicAddress } from './common';

/**
 * dpmaster's flood protection (`clients.c`), which it runs with `-f`: an asker who has sent too
 * many queries lately is ignored for a while. The master has it on.
 *
 * An asker is a public address (`common.ts`), and its count of recent queries falls by one every
 * {@link FP_DECAY_TIME} seconds. Time is dpmaster's `crt_time`, in whole seconds.
 */

/** `DEFAULT_MAX_NB_CLIENTS` (`clients.h:32`): how many askers are remembered at once. */
export const MAX_CLIENTS = 512;

/** `DEFAULT_FP_DECAY_TIME` (`clients.h:38`): the seconds it takes to forget one query. */
export const FP_DECAY_TIME = 3;

/**
 * `DEFAULT_FP_THROTTLE` (`clients.h:39`): an asker gets one less than this many queries in a row,
 * and then one every {@link FP_DECAY_TIME} seconds.
 */
export const FP_THROTTLE = 5;

/** `client_t`: an asker's recent queries. */
interface Client {
  count: number;
  /** When its count last went up. */
  lastTime: number;
}

export class Throttle {
  /** By public address, in the order they were first remembered. */
  private readonly clients = new Map<string, Client>();

  /**
   * `Cl_BlockedByThrottle` (`clients.c:273`): whether to ignore a query. One that is let
   * through counts; one that is ignored does not.
   *
   * @param now - `crt_time`, in whole seconds.
   */
  blocked(from: NetAdr, now: number): boolean {
    const key = publicAddress(from);
    const client = this.clients.get(key);
    if (client === undefined) return !this.add(key, now);

    const count = decayed(client, now) + 1;
    if (count >= FP_THROTTLE) return true;
    client.count = count;
    client.lastTime = now;
    return false;
  }

  /**
   * `Cl_AddClient` (`clients.c:88`): remember a new asker, in room to spare or in the place of
   * the first remembered that has been forgotten. With neither, the asker is refused.
   */
  private add(key: string, now: number): boolean {
    if (this.clients.size >= MAX_CLIENTS) {
      const expired = [...this.clients].find(([, client]) => decayed(client, now) === 0);
      if (expired === undefined) return false;
      this.clients.delete(expired[0]);
    }
    this.clients.set(key, { count: 1, lastTime: now });
    return true;
  }
}

/** `Cl_QueryThrottleDecay` (`clients.c:71`): an asker's count, less what time has forgiven. */
function decayed(client: Client, now: number): number {
  return Math.max(0, client.count - Math.trunc((now - client.lastTime) / FP_DECAY_TIME));
}
