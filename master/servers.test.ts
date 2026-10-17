import { describe, expect, it } from 'vitest';

import { adrToStringWithPort, NA, netadr } from '../src/net/net';
import {
  MAX_SERVERS,
  MAX_SERVERS_PER_ADDRESS,
  ServerList,
  SV_STATE,
  TIMEOUT_HEARTBEAT
} from './servers';

const ip = (host: string, port = 27960) => netadr(NA.IP, host, port);

describe("dpmaster's server list", () => {
  it('holds 4096 servers, 32 to a public address, and gives a new one 2 seconds', () => {
    expect([MAX_SERVERS, MAX_SERVERS_PER_ADDRESS, TIMEOUT_HEARTBEAT]).toEqual([4096, 32, 2]);
  });

  it('adds a server when asked to, uninitialized, and finds it by address and port', () => {
    const lines: string[] = [];
    const list = new ServerList((line) => lines.push(line));
    expect(list.get(ip('203.0.113.9'), 100, false)).toBeNull();

    const added = list.get(ip('203.0.113.9'), 100, true)!;
    const uninitialized = { state: SV_STATE.UNINITIALIZED, timeout: 102, challengeTimeout: 0 };
    expect(added).toMatchObject(uninitialized);
    expect(list.get(ip('203.0.113.9'), 101, false)).toBe(added);
    expect(list.get(ip('203.0.113.9', 27961), 101, false)).toBeNull();
    expect(lines).toEqual([
      '> New server added: 203.0.113.9:27960. 1 server(s) now registered, ' +
        'including 1 for this address quota'
    ]);
  });

  it('forgets a server once its timeout has passed, in whole seconds', () => {
    const lines: string[] = [];
    const list = new ServerList((line) => lines.push(line));
    list.get(ip('203.0.113.9'), 100, true);

    expect(list.get(ip('203.0.113.9'), 102, false)).not.toBeNull();
    expect(list.all(103, () => 0)).toEqual([]);
    expect(lines.at(-1)).toBe('> 203.0.113.9:27960 timed out; 0 server(s) currently registered');
  });

  it("refuses a public address's thirty-third server, and a timed-out one frees a place", () => {
    const list = new ServerList(() => {});
    for (let port = 1; port <= 32; port++) {
      list.get(ip('203.0.113.9', port), port === 1 ? 90 : 91, true);
    }
    expect(list.get(ip('203.0.113.9', 99), 91, true)).toBeNull();
    expect(list.get(ip('203.0.113.10', 99), 91, true)).not.toBeNull();

    // The first, added at 90, is gone at 93.
    expect(list.get(ip('203.0.113.9', 99), 93, true)).not.toBeNull();

    const v6 = (host: string) => netadr(NA.IP6, host, 27960);
    for (let host = 1; host <= 32; host++) list.get(v6(`2001:db8:0:1::${host}`), 100, true);
    expect(list.get(v6('2001:db8:0:1::99'), 100, true)).toBeNull();
    expect(list.get(v6('2001:db8:0:2::1'), 100, true)).not.toBeNull();
  });

  it('refuses a server once 4096 are listed', () => {
    const list = new ServerList(() => {});
    for (let i = 0; i < MAX_SERVERS; i++) {
      list.get(ip(`10.${i >> 8}.${i & 0xff}.1`), i === 0 ? 90 : 91, true);
    }
    expect(list.get(ip('203.0.113.9'), 91, true)).toBeNull();
    expect(list.get(ip('203.0.113.9'), 93, true)).not.toBeNull();
  });

  it('lists every server from one drawn at random, and round', () => {
    const list = new ServerList(() => {});
    for (const host of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) list.get(ip(host), 100, true);
    const order = (draw: number) =>
      list.all(100, () => draw).map((sv) => adrToStringWithPort(sv.address));

    expect(order(0)).toEqual(['10.0.0.1:27960', '10.0.0.2:27960', '10.0.0.3:27960']);
    expect(order(0.5)).toEqual(['10.0.0.2:27960', '10.0.0.3:27960', '10.0.0.1:27960']);
  });

  it('forgets a server whose socket has gone', () => {
    const list = new ServerList(() => {});
    list.get(ip('203.0.113.9'), 100, true);
    list.remove(ip('203.0.113.9'));
    expect(list.get(ip('203.0.113.9'), 100, false)).toBeNull();
  });
});
