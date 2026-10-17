import { describe, expect, it } from 'vitest';

import { adrToStringWithPort, parseAdrWithPort, stringToAdr, type NetAdr } from './net';
import { serversResponse, testCvars } from './net-test-fixtures';
import { AS, readServersResponse, ServerLists } from './server-lists';

/** An address as a list writes it: `ip:port`, or `[ip]:port` for IPv6. */
const adr = (text: string): NetAdr => parseAdrWithPort(text)!;

/** A server's `getinfo` answer. */
const INFO =
  '\\g_needpass\\1\\gametype\\3\\sv_maxclients\\12\\g_humanplayers\\2\\clients\\5' +
  '\\mapname\\q3dm17\\hostname\\Arena\\protocol\\1\\gamename\\PlayCanvasQuake';

/** The lists over a clock the test turns. */
function lists(values: Record<string, string> = {}) {
  let now = 1000;
  const cvars = testCvars(values);
  const servers = new ServerLists({ cvars, now: () => now, print: () => {} });
  return {
    servers,
    cvars,
    at: (ms: number) => {
      now = ms;
    }
  };
}

describe("a master's list", () => {
  /** The servers a reply names, as text. */
  const read = (data: Uint8Array, extended: boolean) =>
    readServersResponse(data, extended).map(adrToStringWithPort);

  it('names each server up to its end mark', () => {
    const servers = ['203.0.113.9:27960', '10.0.0.5:27961'];
    expect(read(serversResponse(servers), false)).toEqual(servers);
  });

  it('names IPv6 servers only in an extended reply', () => {
    const servers = ['203.0.113.9:27960', '[2001:db8::9]:27960', '10.0.0.5:27960'];
    const data = serversResponse(servers, { extended: true });
    expect(read(data, true)).toEqual(servers);
    expect(read(data, false)).toEqual(['203.0.113.9:27960']);
  });

  it('names an IPv6 server that opens an extended reply', () => {
    const servers = ['[2001:db8::9]:27960', '203.0.113.9:27960'];
    expect(read(serversResponse(servers, { extended: true }), true)).toEqual(servers);
  });

  it('loses the entry that ends a reply with no byte behind it, as ioquake3 does', () => {
    const data = serversResponse(['203.0.113.9:27960', '203.0.113.10:27960'], { end: false });
    expect(read(data, false)).toEqual(['203.0.113.9:27960']);
  });

  it('names at most 256 servers from one reply', () => {
    const many = Array.from({ length: 300 }, (_, i) => `10.0.${i >> 8}.${i & 0xff}:27960`);
    expect(readServersResponse(serversResponse(many), false)).toHaveLength(256);
  });
});

describe("the server browser's lists", () => {
  it('count the global list as -1 while its master has not answered, keeping what it held', () => {
    const { servers } = lists();
    expect(servers.count(AS.GLOBAL)).toBe(0);
    servers.askGlobal();
    expect(servers.count(AS.GLOBAL)).toBe(-1);
    expect(servers.listed([adr('203.0.113.9:27960'), adr('203.0.113.10:27960')])).toBe(2);
    expect(servers.server(AS.GLOBAL, 0)?.ping).toBe(-1);

    servers.askGlobal();
    expect(servers.count(AS.GLOBAL)).toBe(-1);
    expect(servers.server(AS.GLOBAL, 1)?.adr).toEqual(adr('203.0.113.10:27960'));
    servers.listed([adr('198.51.100.7:27960')]);
    servers.listed([adr('198.51.100.8:27960')]);
    expect(servers.count(AS.GLOBAL)).toBe(2);
    expect(servers.server(AS.GLOBAL, 1)?.adr).toEqual(adr('198.51.100.8:27960'));
  });

  it('put a master\'s servers in the local list after it was asked for, once each, to 128', () => {
    const { servers } = lists();
    servers.askLocal();
    const many = Array.from({ length: 130 }, (_, i) => adr(`192.168.1.${i}:27960`));
    expect(servers.listed([many[0], ...many])).toBe(128);
    expect(servers.count(AS.LOCAL)).toBe(128);
    expect(servers.count(AS.GLOBAL)).toBe(0);

    servers.askLocal();
    expect(servers.count(AS.LOCAL)).toBe(0);
  });

  it('hold a slot for a name being looked up, fill its rows by name, and free it unfound', () => {
    const { servers, at } = lists();
    const named = stringToAdr('quake.test')!;
    servers.add(AS.FAVORITES, 'Mine', 'quake.test');
    servers.ping(named, true);
    expect(servers.pingQueueCount()).toBe(1);
    // The address found goes in the held slot, its time from then.
    at(1030);
    const found = adr('203.0.113.9:27960');
    servers.ping(found, false, named);
    expect(servers.pingQueueCount()).toBe(1);
    at(1072);
    servers.infoResponse(found, INFO);
    const address = 'quake.test:27960';
    expect(servers.getPing(0)).toMatchObject({ address, adr: named, time: 43, estimate: false });
    expect(servers.server(AS.FAVORITES, 0)).toMatchObject({ hostName: 'Arena', ping: 43 });

    servers.clearPing(0);
    servers.ping(named, true);
    servers.release(named);
    expect(servers.pingQueueCount()).toBe(0);
    // An address pinged twice takes a slot each time, as Q3's does.
    servers.ping(found, true);
    servers.ping(found, true);
    expect(servers.pingQueueCount()).toBe(2);
  });

  it('fill the rows under the address a name was found at, and those under the name', () => {
    const { servers, at } = lists();
    const named = stringToAdr('quake.test')!;
    const found = adr('203.0.113.9:27960');
    servers.add(AS.FAVORITES, 'Mine', 'quake.test');
    servers.askGlobal();
    servers.listed([found]);
    servers.ping(named, true);
    servers.ping(found, false, named);
    at(1042);
    servers.infoResponse(found, INFO);
    for (const source of [AS.GLOBAL, AS.FAVORITES]) {
      expect(servers.server(source, 0)).toMatchObject({ hostName: 'Arena', ping: 43 });
    }
  });

  it("fill in every list's row for a server from its answer to a ping", () => {
    const { servers, at } = lists();
    const server = adr('203.0.113.9:27960');
    expect(servers.add(AS.FAVORITES, 'Home', '203.0.113.9:27960')).toBe(1);
    expect(servers.server(AS.FAVORITES, 0)).toMatchObject({ hostName: 'Home', ping: 0 });
    servers.askGlobal();
    servers.listed([server, adr('203.0.113.10:27960')]);

    servers.ping(server, true);
    expect(servers.server(AS.GLOBAL, 0)).toMatchObject({ ping: 0, estimate: true });
    const named = { ...server };
    const address = '203.0.113.9:27960';
    expect(servers.getPing(0)).toEqual({ address, adr: named, time: 0, estimate: true });

    at(1042);
    servers.infoResponse(server, INFO);
    expect(servers.getPing(0)).toEqual({ address, adr: named, time: 43, estimate: true });
    expect(servers.getPingInfo(0)).toBe(`\\nettype\\1${INFO}`);
    for (const source of [AS.GLOBAL, AS.FAVORITES]) {
      expect(servers.server(source, 0)).toMatchObject({
        hostName: 'Arena',
        mapName: 'q3dm17',
        clients: 5,
        maxClients: 12,
        humanPlayers: 2,
        gameType: 3,
        needPass: 1,
        netType: 1,
        ping: 43,
        estimate: true
      });
    }
    expect(servers.server(AS.GLOBAL, 1)?.ping).toBe(-1);
  });

  it("time an answer from when it landed, plus id's 1, so one in the ping's msec is 1", () => {
    const { servers, at } = lists();
    const [first, second] = [adr('203.0.113.9:27960'), adr('203.0.113.10:27960')];
    servers.ping(first, false);
    at(1097);
    servers.infoResponse(first, INFO, 1080.6);
    expect(servers.getPing(0)?.time).toBe(81);

    servers.ping(second, false);
    servers.infoResponse(second, INFO, 1097.9);
    expect(servers.getPing(1)?.time).toBe(1);
  });

  it('time a ping out once cl_maxPing has passed, and never under 100 msec', () => {
    const { servers, cvars, at } = lists({ cl_maxPing: '50' });
    const server = adr('203.0.113.9:27960');
    servers.askGlobal();
    servers.listed([server]);
    servers.ping(server, false);

    at(1099);
    expect(servers.getPing(0)?.time).toBe(0);
    at(1100);
    expect(servers.getPing(0)?.time).toBe(100);
    expect(servers.server(AS.GLOBAL, 0)?.ping).toBe(0);

    cvars.set('cl_maxPing', '800');
    at(1799);
    expect(servers.getPing(0)?.time).toBe(0);
  });

  it("wait cl_maxPing's 800 msec for an answer when nothing has set it", () => {
    const { servers, at } = lists();
    servers.ping(adr('203.0.113.9:27960'), false);
    at(1799);
    expect(servers.getPing(0)?.time).toBe(0);
    at(1800);
    expect(servers.getPing(0)?.time).toBe(800);
  });

  it('keep a ping 500 msec for its answer, and an answer that took less until read', () => {
    const { servers, at } = lists();
    servers.ping(adr('203.0.113.9:27960'), false);
    at(1499);
    servers.ping(adr('203.0.113.10:27960'), false);
    at(1500);
    servers.ping(adr('203.0.113.11:27960'), false);
    expect([0, 1].map((n) => servers.getPing(n)?.address)).toEqual([
      '203.0.113.11:27960',
      '203.0.113.10:27960'
    ]);

    at(1510);
    servers.infoResponse(adr('203.0.113.11:27960'), INFO);
    at(9000);
    servers.ping(adr('203.0.113.12:27960'), false);
    expect([0, 1].map((n) => servers.getPing(n)?.address)).toEqual([
      '203.0.113.11:27960',
      '203.0.113.12:27960'
    ]);
    expect(servers.pingQueueCount()).toBe(2);
    servers.clearPing(0);
    expect(servers.getPing(0)).toBeNull();
    expect(servers.getPingInfo(0)).toBe('');
    expect(servers.pingQueueCount()).toBe(1);
  });

  it('reuse the oldest ping when every slot is kept', () => {
    const { servers, at } = lists();
    for (let i = 0; i < 32; i++) {
      at(1000 + i);
      servers.ping(adr(`203.0.113.${i}:27960`), false);
    }
    servers.ping(adr('198.51.100.7:27960'), false);
    expect(servers.getPing(0)?.address).toBe('198.51.100.7:27960');
    expect(servers.pingQueueCount()).toBe(32);
  });

  it('add a server found by its answer alone to the local list, while it is the one asked', () => {
    const { servers } = lists();
    servers.askLocal();
    servers.infoResponse(adr('192.168.1.5:27960'), INFO);
    servers.infoResponse(adr('192.168.1.5:27960'), INFO);
    expect(servers.count(AS.LOCAL)).toBe(1);
    expect(servers.server(AS.LOCAL, 0)?.ping).toBe(-1);

    servers.askGlobal();
    servers.infoResponse(adr('192.168.1.6:27960'), INFO);
    expect(servers.count(AS.LOCAL)).toBe(1);
  });

  it('take a favourite by address and name once, to 128, and let it go', () => {
    const { servers } = lists();
    const name = 'x'.repeat(100);
    expect(servers.add(AS.FAVORITES, name, '203.0.113.9')).toBe(1);
    expect(servers.add(AS.FAVORITES, 'Again', '203.0.113.9:27960')).toBe(0);
    expect(servers.server(AS.FAVORITES, 0)?.hostName).toBe('x'.repeat(79));

    for (let i = 1; i < 128; i++) servers.add(AS.FAVORITES, '', `10.0.0.${i}`);
    expect(servers.add(AS.FAVORITES, '', '10.0.1.1')).toBe(-1);

    servers.remove(AS.FAVORITES, '203.0.113.9:27960');
    expect(servers.count(AS.FAVORITES)).toBe(127);
    expect(servers.server(AS.FAVORITES, 0)?.adr).toEqual(adr('10.0.0.1:27960'));
  });
});
