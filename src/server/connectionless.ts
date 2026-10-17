import { tokenize } from '../formats/q3config';
import { huffDecompress } from '../net/huffman';
import { Message, MAX_MSGLEN } from '../net/msg';
import { compareAdr, NA, netadr, type NetAdr } from '../net/net';

/**
 * The server's side of the packets that arrive outside any connection: Quake 3's challenge table,
 * its leaky buckets, and the reading every such packet starts with (`sv_main.c`, `sv_client.c`).
 */

/** `MAX_CHALLENGES` (`server.h:210`): how many challenges are outstanding at once. */
export const MAX_CHALLENGES = 2048;

/**
 * `MAX_CHALLENGES_MULTI` (`server.h:214`): past this far into the table, a scan that has already
 * met the asker stops looking for an older slot, so one address cannot turn the whole table over.
 */
const MAX_CHALLENGES_MULTI = MAX_CHALLENGES / 2;

/** `challenge_t` (`server.h:217–227`), less what only the authorize server used. */
export interface Challenge {
  adr: NetAdr;
  /** The server's number, which the client's `connect` must carry back. */
  challenge: number;
  /** The client's own number, echoed so the client knows the answer is to its question. */
  clientChallenge: number;
  /** `svs.time` when it was issued; the oldest is the next to be reused. */
  time: number;
  /** `svs.time` when the answer went, which the connect measures a ping from. */
  pingTime: number;
  firstTime: number;
  /** Refused once for its ping, so a retransmitted connect is dropped without another answer. */
  wasrefused: boolean;
  /** Used by a connect, so a new `getchallenge` from the same address does not count it. */
  connected: boolean;
}

function emptyChallenge(): Challenge {
  return {
    adr: netadr(NA.BAD),
    challenge: 0,
    clientChallenge: 0,
    time: 0,
    pingTime: 0,
    firstTime: 0,
    wasrefused: false,
    connected: false
  };
}

/** `svs.challenges`: the challenges handed out, which a `connect` is checked against. */
export class ChallengeTable {
  private readonly entries: Challenge[] = Array.from({ length: MAX_CHALLENGES }, emptyChallenge);

  /**
   * `SV_GetChallenge`'s slot and number (`sv_client.c:102–145`): every request takes a slot of its
   * own, the oldest there is, and gets a new number. An address's earlier challenges stay good.
   *
   * @param time - `svs.time`.
   * @param random - Where the number's bits come from, as `rand()`.
   */
  issue(from: NetAdr, clientChallenge: number, time: number, random: () => number): Challenge {
    let oldest = 0;
    let oldestTime = 0x7fffffff;
    let found = false;
    for (let i = 0; i < MAX_CHALLENGES; i++) {
      const entry = this.entries[i];
      if (!entry.connected && compareAdr(from, entry.adr)) found = true;
      if (found && i >= MAX_CHALLENGES_MULTI) break;
      if (entry.time < oldestTime) {
        oldestTime = entry.time;
        oldest = i;
      }
    }

    const entry = this.entries[oldest];
    entry.clientChallenge = clientChallenge;
    entry.adr = { ...from };
    entry.firstTime = time;
    entry.connected = false;

    entry.challenge = (((rand(random) << 16) ^ rand(random)) ^ time) | 0;
    entry.wasrefused = false;
    entry.time = time;
    entry.pingTime = time;
    return entry;
  }

  /**
   * `SV_DirectConnect`'s lookup (`sv_client.c:403–417`): the challenge an address was given with
   * this number, whether or not a connect has used it already, since connects are retransmitted.
   *
   * @returns the challenge and its index, which the connect's print names, or null
   */
  find(from: NetAdr, challenge: number): { index: number; entry: Challenge } | null {
    for (let index = 0; index < MAX_CHALLENGES; index++) {
      const entry = this.entries[index];
      if (compareAdr(from, entry.adr) && entry.challenge === challenge) return { index, entry };
    }
    return null;
  }

  /**
   * `SV_DropClient`'s clearing (`sv_client.c:645–657`): the first challenge an address holds, so
   * a dropped client has to ask again.
   */
  clear(adr: NetAdr): void {
    const index = this.entries.findIndex((entry) => compareAdr(adr, entry.adr));
    if (index !== -1) this.entries[index] = emptyChallenge();
  }
}

/** `rand()` as glibc's: 31 bits. */
function rand(random: () => number): number {
  return Math.floor(random() * 0x80000000);
}

/** `MAX_BUCKETS` (`sv_main.c:364`): how many addresses are counted at once. */
export const MAX_BUCKETS = 16384;

/**
 * `leakyBucket_t` (`server.h:313–328`): the requests still counted against a sender. One drains
 * every period, and a request that finds the bucket full is dropped.
 */
export interface LeakyBucket {
  /** `Sys_Milliseconds()` when it last drained. */
  lastTime: number;
  /** The requests still counted. */
  burst: number;
}

/**
 * `SVC_RateLimit` (`sv_main.c:486–509`): one request more into a bucket that holds `burst` and
 * drains one every `period` milliseconds. A sender with no bucket is dropped.
 *
 * @param now - `Sys_Milliseconds()`.
 * @returns whether the request is over the limit, and is to be dropped
 */
export function rateLimit(
  bucket: LeakyBucket | null,
  burst: number,
  period: number,
  now: number
): boolean {
  if (bucket === null) return true;

  const interval = now - bucket.lastTime;
  const expired = Math.trunc(interval / period);
  if (expired > bucket.burst || interval < 0) {
    bucket.burst = 0;
    bucket.lastTime = now;
  } else {
    bucket.burst -= expired;
    // The part of a period that has gone counts towards the next to drain.
    bucket.lastTime = now - (interval % period);
  }

  if (bucket.burst < burst) {
    bucket.burst++;
    return false;
  }
  return true;
}

/**
 * The per-address buckets: `SVC_BucketForAddress` (`sv_main.c:405–479`).
 *
 * Quake 3 finds an address's bucket by its IP bytes, IPv4's or IPv6's, so any other address, the
 * loopback's, is given a new one every time and is never over its own limit. A new address takes
 * back the buckets left alone for `burst × period`, and is dropped if that leaves no room.
 */
export class LeakyBuckets {
  private readonly buckets = new Map<string, LeakyBucket>();

  /**
   * `SVC_RateLimitAddress` (`sv_main.c:518–522`).
   *
   * @param now - `Sys_Milliseconds()`.
   * @returns whether the request is over the address's limit, and is to be dropped
   */
  rateLimitAddress(from: NetAdr, burst: number, period: number, now: number): boolean {
    return rateLimit(this.forAddress(from, burst, period, now), burst, period, now);
  }

  private forAddress(from: NetAdr, burst: number, period: number, now: number): LeakyBucket | null {
    // Found by its text: an IPv6 address has one spelling, and it never reads as an IPv4 one.
    if (from.type !== NA.IP && from.type !== NA.IP6) return { lastTime: now, burst: 0 };

    const known = this.buckets.get(from.ip);
    if (known !== undefined) return known;

    if (this.buckets.size >= MAX_BUCKETS) {
      for (const [ip, bucket] of this.buckets) {
        const interval = now - bucket.lastTime;
        if (interval > burst * period || interval < 0) this.buckets.delete(ip);
      }
      if (this.buckets.size >= MAX_BUCKETS) return null;
    }

    const bucket = { lastTime: now, burst: 0 };
    this.buckets.set(from.ip, bucket);
    return bucket;
  }
}

/**
 * `SV_ConnectionlessPacket`'s reading (`sv_main.c:789–797`): the marker skipped, a `connect`'s
 * compressed userinfo expanded, and the first line split into its words.
 *
 * The test for `connect` is a case-sensitive match on the bytes, made before anything is read;
 * the dispatch after it is not case-sensitive.
 */
export function readConnectionless(data: Uint8Array): string[] {
  let bytes = data;
  if (matches(bytes, 4, 'connect')) bytes = huffDecompress(bytes, 12, MAX_MSGLEN);
  const msg = Message.read(bytes);
  msg.beginReading(true);
  msg.readLong();
  return tokenize(msg.readStringLine());
}

/** `Q_strncmp` on raw bytes: whether `text` is at `offset`. */
function matches(data: Uint8Array, offset: number, text: string): boolean {
  if (data.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (data[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}
