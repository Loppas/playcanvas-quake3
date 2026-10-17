import { beforeEach, describe, expect, it } from 'vitest';

import { NA, netadr, type NetAdr } from '../src/net/net';
import { Throttle } from './clients';
import { oob, readList, text } from './master-test-fixtures';
import {
  MAX_PACKET_SIZE_IN,
  MAX_PACKET_SIZE_OUT,
  Messages,
  TIMEOUT_CHALLENGE,
  TIMEOUT_INFORESPONSE
} from './messages';
import { ServerList, SV_STATE } from './servers';

const SERVER = netadr(NA.IP, '203.0.113.9', 27960);
const CLIENT = netadr(NA.IP, '198.51.100.4', 50000);

/** How many askers have been made up, which gives each an address, and a throttle, its own. */
let askers = 0;

/** An asker the throttle has not seen. */
function asker(): NetAdr {
  askers++;
  return netadr(NA.IP, `198.18.${(askers >> 8) & 0xff}.${askers & 0xff}`, 50000);
}

/** An info string, in the order given. */
function info(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `\\${key}\\${value}`)
    .join('');
}

/** mulberry32: draws from 0 up to 1 that a test can repeat. */
function draws(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("dpmaster's messages", () => {
  let now: number;
  let random: () => number;
  let getinfos: { to: NetAdr; text: string }[];
  let registered: NetAdr[];
  let lines: string[];
  let servers: ServerList;
  let messages: Messages;

  beforeEach(() => {
    now = 1000;
    random = draws(1);
    getinfos = [];
    registered = [];
    lines = [];
    servers = new ServerList((line) => lines.push(line));
    messages = new Messages({
      servers,
      throttle: new Throttle(),
      now: () => now,
      random: () => random(),
      sendGetInfo: (to, data) => getinfos.push({ to, text: text(data) }),
      registered: () => registered,
      print: (line) => lines.push(line)
    });
  });

  /** The replies to a datagram, from an asker of its own unless it says. */
  function send(datagram: string | Uint8Array, from = asker()): Uint8Array[] {
    const replies: Uint8Array[] = [];
    messages.handle(typeof datagram === 'string' ? oob(datagram) : datagram, from, (data) => {
      replies.push(data);
    });
    return replies;
  }

  /** The challenge in the last `getinfo` the master sent. */
  function lastChallenge(): string {
    return getinfos.at(-1)!.text.slice('\xff\xff\xff\xffgetinfo '.length);
  }

  /** A server's answer to its `getinfo`, the keys given over those of a valid one. */
  function infoResponse(keys: Record<string, string> = {}): string {
    const valid = {
      challenge: lastChallenge(),
      gamename: 'PlayCanvasQuake',
      protocol: '1',
      clients: '1',
      sv_maxclients: '8'
    };
    return `infoResponse\n${info({ ...valid, ...keys })}`;
  }

  /** A heartbeat, and the answer to its `getinfo`. */
  function answer(from: NetAdr, keys: Record<string, string> = {}): void {
    send('heartbeat DarkPlaces\n', from);
    send(infoResponse(keys), from);
  }

  /** The servers in the replies to a query, each reply's apart, sorted within it. */
  function query(line: string, from = asker()): string[][] {
    return send(line, from).map((data) => readList(data)!.sort());
  }

  it('keep a server 15 minutes, a challenge 2 seconds, and a reply to 1400 bytes', () => {
    expect([TIMEOUT_INFORESPONSE, TIMEOUT_CHALLENGE]).toEqual([900, 2]);
    expect([MAX_PACKET_SIZE_OUT, MAX_PACKET_SIZE_IN]).toEqual([1400, 2048]);
  });

  describe('a heartbeat', () => {
    it('is answered with a getinfo and its challenge, and adds the server, not yet listed', () => {
      expect(send('heartbeat DarkPlaces\n', SERVER)).toEqual([]);

      expect(getinfos).toEqual([
        { to: SERVER, text: expect.stringMatching(/^\xff{4}getinfo [!-~]{8,11}$/) }
      ]);
      expect(servers.get(SERVER, now, false)?.state).toBe(SV_STATE.UNINITIALIZED);
      expect(query('getservers PlayCanvasQuake 1 empty full')).toEqual([[]]);
      expect(lines[0]).toBe('> 203.0.113.9:27960 ---> heartbeat (DarkPlaces)');
    });

    it('is taken only with the DarkPlaces tag, after any spaces', () => {
      for (const line of [
        'heartbeat QuakeArena-1\n',
        'heartbeat darkplaces\n',
        'heartbeat DarkPlacesX\n',
        'heartbeat \n',
        'HEARTBEAT DarkPlaces\n'
      ]) {
        send(line, SERVER);
      }
      expect(getinfos).toEqual([]);
      expect(servers.get(SERVER, now, false)).toBeNull();

      send('heartbeat \t DarkPlaces', SERVER);
      expect(getinfos).toHaveLength(1);
    });

    it('asks again with the same challenge while it is good, and a new one after', () => {
      answer(SERVER);
      const first = lastChallenge();

      now += TIMEOUT_CHALLENGE;
      send('heartbeat DarkPlaces\n', SERVER);
      expect(lastChallenge()).toBe(first);

      now += 1;
      send('heartbeat DarkPlaces\n', SERVER);
      expect(lastChallenge()).not.toBe(first);
    });
  });

  describe('a challenge', () => {
    it('is 8 to 11 characters from 33 to 126, never \\ ; " % or /', () => {
      const made = new Set<string>();
      const lengths = new Set<number>();
      for (let i = 0; i < 400; i++) {
        send('heartbeat DarkPlaces\n', netadr(NA.IP, `10.0.${i >> 8}.${i & 0xff}`, 27960));
        const challenge = lastChallenge();
        lengths.add(challenge.length);
        for (const c of challenge) made.add(c);
      }
      expect([...lengths].sort((a, b) => a - b)).toEqual([8, 9, 10, 11]);
      for (const c of made) {
        expect(c.charCodeAt(0)).toBeGreaterThanOrEqual(33);
        expect(c.charCodeAt(0)).toBeLessThanOrEqual(126);
      }
      expect([...'\\;"%/'].filter((c) => made.has(c))).toEqual([]);
      expect(made.size).toBe(94 - 5);
    });

    it("draws its length, then each character, skipping one it may not use, as rand()", () => {
      // rand() is 31 bits: a draw of n / 2^31 is n.
      const rand = (n: number) => n / 0x80000000;
      // Eleven long; then a backslash, 33 + 59, skipped; then eleven of 33 + 2, "#".
      const sequence = [rand(3), rand(59), ...new Array<number>(11).fill(rand(2))];
      random = () => sequence.shift()!;
      send('heartbeat DarkPlaces\n', SERVER);
      expect(lastChallenge()).toBe('#'.repeat(11));
    });
  });

  describe('an infoResponse', () => {
    it('lists the server as it says it is: empty, occupied or full', () => {
      const [empty, occupied, full] = [1, 2, 3].map((i) => netadr(NA.IP, `203.0.113.${i}`, 27960));
      answer(empty, { clients: '0' });
      answer(occupied, { clients: '7' });
      answer(full, { clients: '8' });

      expect(query('getservers PlayCanvasQuake 1')).toEqual([['203.0.113.2:27960']]);
      expect(query('getservers PlayCanvasQuake 1 empty')).toEqual([
        ['203.0.113.1:27960', '203.0.113.2:27960']
      ]);
      expect(query('getservers PlayCanvasQuake 1 full')).toEqual([
        ['203.0.113.2:27960', '203.0.113.3:27960']
      ]);
      expect(servers.get(full, now, false)).toMatchObject({
        state: SV_STATE.FULL,
        protocol: 1,
        gamename: 'PlayCanvasQuake',
        gametype: '0',
        timeout: now + 900
      });
    });

    it('is refused when it breaks one of the rules, and the master says which', () => {
      const rules: [Record<string, string>, string][] = [
        [{ challenge: 'wrong' }, 'invalid challenge from 203.0.113.9:1000 (wrong)'],
        [{ protocol: '' }, '(invalid protocol value: )'],
        [{ protocol: 'x1' }, '(invalid protocol value: x1)'],
        [{ protocol: '1x' }, '(invalid protocol value: 1x)'],
        [{ gametype: 'c t f' }, '(game type contains whitespaces)'],
        [{ sv_maxclients: '0' }, '(sv_maxclients = 0)'],
        [{ sv_maxclients: '' }, '(sv_maxclients = 0)'],
        [{ gamename: '' }, '(game name is void)'],
        [{ gamename: 'Play Canvas' }, '(game name contains whitespaces)'],
        [{ gamename: 'Quake3Arena' }, '(game "Quake3Arena" is not accepted)'],
        [{ gamename: 'playcanvasquake' }, '(game "playcanvasquake" is not accepted)']
      ];
      rules.forEach(([keys, reason], i) => {
        const server = netadr(NA.IP, '203.0.113.9', 1000 + i);
        answer(server, keys);
        const state = servers.get(server, now, false)?.state;
        expect(state, JSON.stringify(keys)).toBe(SV_STATE.UNINITIALIZED);
        expect(lines.at(-1)).toContain(reason);
      });

      // And each key the rules need, left out.
      const server = netadr(NA.IP, '203.0.113.10', 27960);
      for (const key of ['challenge', 'protocol', 'sv_maxclients', 'clients', 'gamename']) {
        send('heartbeat DarkPlaces\n', server);
        const reply = infoResponse();
        send(reply.replace(new RegExp(`\\\\${key}\\\\[^\\\\]*`), ''), server);
        expect(servers.get(server, now, false)?.state, key).toBe(SV_STATE.UNINITIALIZED);
      }
      expect(query('getservers PlayCanvasQuake 1 empty full')).toEqual([[]]);
    });

    it('reads a protocol as strtol does, and a key only as it is spelled', () => {
      answer(SERVER, { protocol: '0x1', gametype: '4' });
      const upper = netadr(NA.IP, '203.0.113.10', 27960);
      send('heartbeat DarkPlaces\n', upper);
      send(infoResponse().replace('\\gamename\\', '\\GAMENAME\\'), upper);

      expect(query('getservers PlayCanvasQuake 1 ctf')).toEqual([['203.0.113.9:27960']]);
      expect(servers.get(upper, now, false)?.state).toBe(SV_STATE.UNINITIALIZED);
    });

    it('reads a value of 255 characters, cut to its field, and one longer as none', () => {
      const [short, long] = [1, 2].map((i) => netadr(NA.IP, `203.0.113.${i}`, 27960));
      answer(short, { gametype: '7'.repeat(255) });
      answer(long, { gametype: '7'.repeat(256) });
      expect(servers.get(short, now, false)?.gametype).toBe('7'.repeat(31));
      expect(servers.get(long, now, false)?.gametype).toBe('0');
    });

    it('is taken only from a server asked, and only while its challenge is good', () => {
      send(`infoResponse\n${info({ challenge: 'x', gamename: 'PlayCanvasQuake' })}`, SERVER);
      expect(lines.at(-1)).toBe('> WARNING: infoResponse from unknown server 203.0.113.9:27960');

      answer(SERVER, { clients: '1' });
      now += 10;
      send('heartbeat DarkPlaces\n', SERVER);
      const late = infoResponse({ clients: '8' });
      now += TIMEOUT_CHALLENGE + 1;
      send(late, SERVER);
      expect(lines.at(-1)).toBe(
        '> WARNING: infoResponse with obsolete challenge from 203.0.113.9:27960'
      );
      expect(servers.get(SERVER, now, false)?.state).toBe(SV_STATE.OCCUPIED);
    });

    it('keeps the server listed 15 minutes after the last one', () => {
      answer(SERVER);
      now += 900;
      expect(query('getservers PlayCanvasQuake 1')).toEqual([['203.0.113.9:27960']]);
      now += 1;
      expect(query('getservers PlayCanvasQuake 1')).toEqual([[]]);
    });
  });

  describe('a getservers', () => {
    const v6 = netadr(NA.IP6, '2001:db8::9', 27960);
    const four = ['203.0.113.10:27960', '203.0.113.11:27960', '203.0.113.12:27960'];

    beforeEach(() => {
      answer(SERVER, { gametype: '0' });
      answer(netadr(NA.IP, '203.0.113.10', 27960), { gametype: '3' });
      answer(netadr(NA.IP, '203.0.113.11', 27960), { gametype: '4' });
      answer(netadr(NA.IP, '203.0.113.12', 27960), { gametype: '7' });
      answer(netadr(NA.IP, '203.0.113.13', 27960), { gametype: '1', protocol: '2' });
      answer(v6, { gametype: '0' });
    });

    it("filters by protocol and game type, with Quake 3's names for four of them", () => {
      expect(query('getservers PlayCanvasQuake 1 ffa')).toEqual([['203.0.113.9:27960']]);
      expect(query('getservers PlayCanvasQuake 1 team')).toEqual([['203.0.113.10:27960']]);
      expect(query('getservers PlayCanvasQuake 1 ctf')).toEqual([['203.0.113.11:27960']]);
      expect(query('getservers PlayCanvasQuake 1 gametype=7')).toEqual([['203.0.113.12:27960']]);
      expect(query('getservers PlayCanvasQuake 1 tourney')).toEqual([[]]);
      expect(query('getservers PlayCanvasQuake 2 tourney')).toEqual([['203.0.113.13:27960']]);
    });

    it('lists IPv4 servers only, and getserversExt both families unless told one', () => {
      expect(query('getservers PlayCanvasQuake 1 bogus')).toEqual([
        [...four, '203.0.113.9:27960']
      ]);
      expect(query('getserversExt PlayCanvasQuake 1')).toEqual([
        [...four, '203.0.113.9:27960', '[2001:db8::9]:27960']
      ]);
      expect(query('getserversExt PlayCanvasQuake 1 ipv6')).toEqual([['[2001:db8::9]:27960']]);
      expect(query('getserversExt PlayCanvasQuake 1 ipv4 ffa')).toEqual([['203.0.113.9:27960']]);
    });

    it('packs an entry as a mark, the address and the port, and ends with \\EOT', () => {
      const [ffa] = send('getserversExt PlayCanvasQuake 1 ffa');
      const header = [...oob('getserversExtResponse')];
      const eot = [...'\\EOT\0\0\0'].map((c) => c.charCodeAt(0));
      const entry4 = [0x5c, 203, 0, 113, 9, 0x6d, 0x38];
      const ip6 = [0x20, 0x01, 0x0d, 0xb8, ...new Array<number>(11).fill(0), 9];
      const entry6 = [0x2f, ...ip6, 0x6d, 0x38];

      const bytes = [...ffa];
      expect(bytes.slice(0, header.length)).toEqual(header);
      expect(bytes.slice(-eot.length)).toEqual(eot);
      const entries = bytes.slice(header.length, -eot.length);
      const first = entries[0] === 0x2f ? 19 : 7;
      expect([entries.slice(0, first), entries.slice(first)].sort()).toEqual(
        [entry4, entry6].sort()
      );
    });

    it('is refused for another game, or with no protocol, and lists nothing for no game', () => {
      expect(send('getservers Quake3Arena 68')).toEqual([]);
      expect(send('getservers PlayCanvasQuake')).toEqual([]);
      expect(send('getservers PlayCanvasQuake 1x')).toEqual([]);
      expect(send('getservers    ')).toEqual([]);
      // A game's name may start with a digit: only a number followed by a space or nothing is a
      // protocol alone.
      expect(send('getservers 1x')).toEqual([]);
      // An anonymous query names only a protocol, which no game of the port's answers to, and
      // an unanswered server, whose protocol is 0 and game none, is never listed.
      expect(query('getservers 1 empty full')).toEqual([[]]);
      send('heartbeat DarkPlaces\n', netadr(NA.IP, '203.0.113.20', 27960));
      expect(query('getservers 0 empty full')).toEqual([[]]);
      expect(query('getserversExt PlayCanvasQuake 0x1 ffa ipv4')).toEqual([['203.0.113.9:27960']]);
    });

    it('is read as dpmaster reads a datagram: to its first NUL, and 2048 bytes at most', () => {
      expect(query('getservers PlayCanvasQuake 1 gametype=7\0 ffa')).toEqual([
        ['203.0.113.12:27960']
      ]);
      const long = `getservers PlayCanvasQuake 1${' '.repeat(MAX_PACKET_SIZE_IN)} gametype=7`;
      expect(query(long)).toEqual([[...four, '203.0.113.9:27960']]);

      expect(send(Uint8Array.of(0xff, 0xff, 0xff, 0xff))).toEqual([]);
      const unmarked = oob('getservers PlayCanvasQuake 1');
      unmarked[3] = 0;
      expect(send(unmarked)).toEqual([]);
    });

    it('is throttled: four in a row from one address, then one every three seconds', () => {
      const answered = () => send('getservers PlayCanvasQuake 1', CLIENT).length;
      expect([1, 2, 3, 4, 5].map(answered)).toEqual([1, 1, 1, 1, 0]);
      now += 3;
      expect([1, 2].map(answered)).toEqual([1, 0]);
      expect(send('getservers PlayCanvasQuake 1')).toHaveLength(1);
    });
  });

  describe('a full list', () => {
    /** Servers enough to list, seven addresses of up to 29 ports. */
    function listed(count: number): void {
      for (let i = 0; i < count; i++) {
        answer(netadr(NA.IP, `203.0.113.${i % 7}`, 27960 + Math.floor(i / 7)));
      }
    }

    it('goes in one reply while 195 servers and the end fit in 1400 bytes', () => {
      listed(195);
      const replies = send('getservers PlayCanvasQuake 1');
      expect(replies.map((r) => r.length)).toEqual([22 + 195 * 7 + 7]);
      expect(readList(replies[0])).toHaveLength(195);
    });

    it('goes on in another reply once the next server does not fit', () => {
      listed(197);
      const replies = send('getservers PlayCanvasQuake 1');
      expect(replies.map((r) => r.length)).toEqual([22 + 196 * 7, 22 + 7 + 7]);
      expect(replies.map((r) => readList(r)!.length)).toEqual([196, 1]);
      expect(text(replies[0]).includes('EOT')).toBe(false);
      expect(text(replies[1]).endsWith('\\EOT\0\0\0')).toBe(true);
    });

    it('fills a reply to 1400 bytes exactly when the servers come to that', () => {
      // 25 of header, 65 IPv6 servers of 19 and 20 IPv4 of 7: 1400.
      for (let i = 0; i < 65; i++) {
        answer(netadr(NA.IP6, `2001:db8:0:${i % 3}::${Math.floor(i / 3) + 1}`, 27960));
      }
      listed(20);
      const replies = send('getserversExt PlayCanvasQuake 1');
      expect(replies.map((r) => r.length)).toEqual([1400, 25 + 7]);
      expect(replies.map((r) => readList(r)!.length)).toEqual([85, 0]);
    });

    it('ends in a reply of its own when the last full one has no room for the end', () => {
      listed(196);
      const replies = send('getservers PlayCanvasQuake 1');
      expect(replies.map((r) => r.length)).toEqual([22 + 196 * 7, 22 + 7]);
      expect(replies.map((r) => readList(r)!.length)).toEqual([196, 0]);
    });
  });

  describe('a local list', () => {
    const at = (host: string, port = 27960) =>
      host.includes(':') ? netadr(NA.IP6, host, port) : netadr(NA.IP, host, port);

    beforeEach(() => {
      registered = [
        at('203.0.113.9'),
        at('203.0.113.9', 27961),
        at('203.0.113.10'),
        at('192.168.1.5'),
        at('10.0.0.5'),
        at('2001:db8:0:1::5'),
        at('fd00::5')
      ];
    });

    const local = (line: string, from: NetAdr) => query(`${line} local`, from);

    it("names every registered server with the asker's public address, answered or not", () => {
      expect(local('getservers PlayCanvasQuake 1', at('203.0.113.9', 50000))).toEqual([
        ['203.0.113.9:27960', '203.0.113.9:27961']
      ]);
      expect(local('getserversExt PlayCanvasQuake 1', at('2001:db8:0:1::99', 50000))).toEqual([
        ['[2001:db8:0:1::5]:27960']
      ]);
      expect(local('getservers PlayCanvasQuake 1', at('198.51.100.4', 50000))).toEqual([[]]);
    });

    it('names every private one to a private asker, as one network, whatever else it asks', () => {
      const lan = at('192.168.1.9', 50000);
      expect(local('getservers PlayCanvasQuake 1', lan)).toEqual([
        ['10.0.0.5:27960', '192.168.1.5:27960']
      ]);
      expect(local('getserversExt PlayCanvasQuake 1 empty ffa', lan)).toEqual([
        ['10.0.0.5:27960', '192.168.1.5:27960', '[fd00::5]:27960']
      ]);
    });

    it("counts the master's own machine as on its LAN, by either family's loopback", () => {
      registered = [at('::1'), at('127.0.0.1', 27961), at('203.0.113.9')];
      expect(local('getserversExt PlayCanvasQuake 1', at('192.168.1.9', 50000))).toEqual([
        ['127.0.0.1:27961', '[::1]:27960']
      ]);
      expect(local('getserversExt PlayCanvasQuake 1', at('::1', 50000))).toEqual([
        ['127.0.0.1:27961', '[::1]:27960']
      ]);
    });

    it('names the registered servers, not the heartbeating ones', () => {
      answer(at('203.0.113.9', 27962));
      expect(local('getservers PlayCanvasQuake 1', at('203.0.113.9', 50000))).toEqual([
        ['203.0.113.9:27960', '203.0.113.9:27961']
      ]);
    });
  });
});
