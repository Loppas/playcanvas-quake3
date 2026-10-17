import { describe, expect, it } from 'vitest';

import { NA, netadr } from '../src/net/net';
import { FP_DECAY_TIME, FP_THROTTLE, MAX_CLIENTS, Throttle } from './clients';
import { publicAddress } from './common';

const ip = (host: string, port = 50000) => netadr(NA.IP, host, port);
const ip6 = (host: string, port = 50000) => netadr(NA.IP6, host, port);

/** How many of `count` queries at `now` the throttle lets through. */
function letThrough(throttle: Throttle, from = ip('198.51.100.4'), count = 1, now = 0): number {
  let passed = 0;
  for (let i = 0; i < count; i++) if (!throttle.blocked(from, now)) passed++;
  return passed;
}

describe("dpmaster's throttle", () => {
  it('is five queries, forgotten one every three seconds, over 512 askers', () => {
    expect([FP_THROTTLE, FP_DECAY_TIME, MAX_CLIENTS]).toEqual([5, 3, 512]);
  });

  it('lets four queries through in a row, and ignores the rest without counting them', () => {
    const throttle = new Throttle();
    expect(letThrough(throttle, undefined, 10, 100)).toBe(4);
    // Those ignored did not count: one second short of a query forgotten, still nothing.
    expect(letThrough(throttle, undefined, 1, 102)).toBe(0);
    expect(letThrough(throttle, undefined, 2, 103)).toBe(1);
  });

  it('forgets one query every three seconds, in whole ones, from the last let through', () => {
    const throttle = new Throttle();
    letThrough(throttle, undefined, 4, 100);
    // Twelve seconds forget all four.
    expect(letThrough(throttle, undefined, 10, 112)).toBe(4);
    // Five seconds forget one, the other two being lost when the count went up at 117.
    expect(letThrough(throttle, undefined, 10, 117)).toBe(1);
    expect(letThrough(throttle, undefined, 1, 119)).toBe(0);
    expect(letThrough(throttle, undefined, 1, 120)).toBe(1);
  });

  it('counts an asker by its public address, whatever the port', () => {
    const throttle = new Throttle();
    for (let port = 1; port <= 4; port++) letThrough(throttle, ip('198.51.100.4', port));
    expect(letThrough(throttle, ip('198.51.100.4', 9))).toBe(0);
    expect(letThrough(throttle, ip('198.51.100.5', 9))).toBe(1);

    for (let host = 1; host <= 4; host++) letThrough(throttle, ip6(`2001:db8:0:1::${host}`));
    expect(letThrough(throttle, ip6('2001:db8:0:1::99'))).toBe(0);
    expect(letThrough(throttle, ip6('2001:db8:0:2::1'))).toBe(1);
  });

  it('refuses a new asker while every place is held, until one has forgotten its queries', () => {
    const throttle = new Throttle();
    for (let i = 0; i < MAX_CLIENTS; i++) {
      letThrough(throttle, ip(`10.0.${i >> 8}.${i & 0xff}`), 1, 100 + (i === 7 ? 0 : 3));
    }
    expect(letThrough(throttle, ip('198.51.100.4'), 1, 102)).toBe(0);
    // At 103 the eighth asker has forgotten its one query, and its place is taken.
    expect(letThrough(throttle, ip('198.51.100.4'), 1, 103)).toBe(1);
    expect(letThrough(throttle, ip('198.51.100.5'), 1, 103)).toBe(0);
  });
});

describe('a public address', () => {
  it('is an IPv4 address whole, and an IPv6 address by its first 64 bits', () => {
    expect(publicAddress(ip('198.51.100.4', 1))).toBe('198.51.100.4');
    expect(publicAddress(ip6('2001:db8:0:1:aaaa::1', 1))).toBe('2001:db8:0:1::/64');
    expect(publicAddress(ip6('2001:db8:0:1::ffff:2'))).toBe(
      publicAddress(ip6('2001:db8:0:1:1:2:3:4'))
    );
    expect(publicAddress(ip6('2001:db8:0:2::1'))).not.toBe(publicAddress(ip6('2001:db8:0:1::1')));
  });
});
