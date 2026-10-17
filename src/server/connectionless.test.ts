import { describe, expect, it } from 'vitest';

import { NA, netadr } from '../net/net';
import { LeakyBuckets, MAX_BUCKETS, rateLimit, type LeakyBucket } from './connectionless';

describe('a leaky bucket', () => {
  /** Ask `count` times at `now`, and say how many were let through. */
  function letThrough(bucket: LeakyBucket, count: number, now: number): number {
    let passed = 0;
    for (let i = 0; i < count; i++) if (!rateLimit(bucket, 10, 1000, now)) passed++;
    return passed;
  }

  it('lets a burst through, then drops everything until one drains', () => {
    const bucket = { lastTime: 0, burst: 0 };
    expect(letThrough(bucket, 11, 0)).toBe(10);
    expect(letThrough(bucket, 1, 999)).toBe(0);
    expect(letThrough(bucket, 2, 1000)).toBe(1);
  });

  it('counts the part of a period that has gone towards the next to drain', () => {
    const bucket = { lastTime: 0, burst: 0 };
    letThrough(bucket, 10, 0);

    // One drained at 1000, and the 500 since is kept: the next drains at 2000, not 2500.
    expect(letThrough(bucket, 1, 1500)).toBe(1);
    expect(letThrough(bucket, 1, 1999)).toBe(0);
    expect(letThrough(bucket, 1, 2000)).toBe(1);
  });

  it('empties once more periods have gone than it holds, or the clock has gone back', () => {
    const bucket = { lastTime: 0, burst: 0 };
    letThrough(bucket, 10, 5000);
    expect(letThrough(bucket, 11, 16000)).toBe(10);
    expect(letThrough(bucket, 11, 3000)).toBe(10);
  });

  it('drops a sender that has no bucket', () => {
    expect(rateLimit(null, 10, 1000, 0)).toBe(true);
  });
});

describe('the buckets, one to an address', () => {
  const ip = (host: string, port = 27960) => netadr(NA.IP, host, port);

  it('counts each address on its own, whatever port it sends from', () => {
    const buckets = new LeakyBuckets();
    for (let i = 0; i < 10; i++) buckets.rateLimitAddress(ip('10.0.0.2', 1000 + i), 10, 1000, 0);

    expect(buckets.rateLimitAddress(ip('10.0.0.2', 5), 10, 1000, 0)).toBe(true);
    expect(buckets.rateLimitAddress(ip('10.0.0.3'), 10, 1000, 0)).toBe(false);
  });

  it('counts an IPv6 address on its own, as an IPv4 one', () => {
    const buckets = new LeakyBuckets();
    const ip6 = (host: string, port = 27960) => netadr(NA.IP6, host, port);
    for (let i = 0; i < 10; i++) {
      buckets.rateLimitAddress(ip6('2001:db8::2', 1000 + i), 10, 1000, 0);
    }

    expect(buckets.rateLimitAddress(ip6('2001:db8::2', 5), 10, 1000, 0)).toBe(true);
    expect(buckets.rateLimitAddress(ip6('2001:db8::3'), 10, 1000, 0)).toBe(false);
  });

  it('never limits the loopback on its own, which has no IP to be found by', () => {
    const buckets = new LeakyBuckets();
    const loopback = netadr(NA.LOOPBACK);
    for (let i = 0; i < 20; i++) {
      expect(buckets.rateLimitAddress(loopback, 10, 1000, 0)).toBe(false);
    }
  });

  it('drops a new address when every bucket is in use, until they have been left alone', () => {
    const buckets = new LeakyBuckets();
    for (let i = 0; i < MAX_BUCKETS; i++) {
      buckets.rateLimitAddress(ip(`10.${(i >> 8) & 0xff}.${i & 0xff}.1`), 10, 1000, 0);
    }

    expect(buckets.rateLimitAddress(ip('192.0.2.1'), 10, 1000, 10000)).toBe(true);
    // Left alone for longer than ten periods, which is how long a full bucket takes to drain.
    expect(buckets.rateLimitAddress(ip('192.0.2.1'), 10, 1000, 10001)).toBe(false);
  });
});
