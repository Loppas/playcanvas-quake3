import type { LookupAddress } from 'node:dns';

import { beforeEach, describe, expect, it } from 'vitest';

import { decodeFrame, encodeFrame, type Resolved } from '../src/net/master-protocol';
import {
  adrToStringWithPort,
  NA,
  netadr,
  PORT_MASTER,
  type NetAdr,
  type NetPacket
} from '../src/net/net';
import type { PeerConnectionFactory } from '../src/net/peer-signalling';
import { FakeRtc, settle } from '../src/net/peer-test-fixtures';
import {
  connectionAddress,
  ICE_SERVERS,
  MasterServer,
  MAX_FRAME,
  REGISTER_PORTS,
  RELAY_BURST,
  RELAY_PERIOD
} from './master-server';
import { MASTER_ADR, masterPeer, oob, read, readList, text } from './master-test-fixtures';
import { TIMEOUT_INFORESPONSE } from './messages';
import { TIMEOUT_HEARTBEAT } from './servers';

describe('the master', () => {
  let rtc: FakeRtc;
  let now: number;
  let lines: string[];
  /** What the master's lookup finds for each name; any other is not found. */
  let names: Map<string, LookupAddress[]>;
  let master: MasterServer;
  const clock = () => now;

  /**
   * A master that dials a heartbeating server with these peer connections, or else checks it down
   * the server's own link.
   */
  function newMaster(createPeerConnection?: PeerConnectionFactory): MasterServer {
    return new MasterServer({
      createPeerConnection,
      now: clock,
      random: () => 0,
      lookup: async (name) => {
        const found = names.get(name);
        if (found !== undefined) return found;
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      },
      print: (line) => lines.push(line)
    });
  }

  beforeEach(() => {
    rtc = new FakeRtc();
    now = 0;
    lines = [];
    names = new Map();
    master = newMaster(rtc.create);
  });

  /** A program's socket at the master, from `ip`. */
  function peer(ip: string, options: { dials?: boolean; port?: number; recorded?: boolean } = {}) {
    const dials = options.dials ?? true;
    return masterPeer(master, rtc.create, ip, { ...options, dials, now: clock });
  }

  /** A server at `ip` that has asked for `port`, and been answered. */
  async function server(ip: string, port = 27960, options: { recorded?: boolean } = {}) {
    const program = peer(ip, { ...options, dials: false });
    program.link.register(port);
    await settle();
    return program;
  }

  /** The master's answer to a query, from a program of its own at `ip`. */
  async function ask(line: string, ip = '198.51.100.200'): Promise<(string[] | null)[]> {
    const client = peer(ip);
    await settle();
    client.socket.send(oob(line), MASTER_ADR);
    await settle();
    return read(client.socket).map(({ data }) => readList(data));
  }

  /** A server's heartbeat, and the `getinfo` it earns, as the server read it. */
  async function getInfo(program: ReturnType<typeof peer>) {
    program.socket.send(oob('heartbeat DarkPlaces\n'), MASTER_ADR);
    await settle();
    // One down a channel already open reaches the master's own socket, which it reads by frames.
    master.frame();
    await settle();
    const [getinfo] = read(program.socket);
    return getinfo;
  }

  /** The challenge a `getinfo` carries. */
  function challengeOf(getinfo: NetPacket): string {
    return text(getinfo.data).slice('\xff\xff\xff\xffgetinfo '.length);
  }

  /** An `infoResponse` with this challenge, sent back where a `getinfo` came from. */
  async function infoResponse(
    program: ReturnType<typeof peer>,
    getinfo: NetPacket,
    challenge: string,
    clients = '1'
  ) {
    const keys = `\\challenge\\${challenge}\\gamename\\PlayCanvasQuake\\protocol\\1`;
    const counts = `\\clients\\${clients}\\sv_maxclients\\8`;
    program.socket.send(oob(`infoResponse\n${keys}${counts}`), getinfo.from);
    await settle();
    master.frame();
  }

  /**
   * A server's heartbeat, and the `getinfo` it earns read and answered as a host answers one.
   *
   * @returns the `getinfo`, as the server read it
   */
  async function heartbeat(program: ReturnType<typeof peer>, clients = '1') {
    const getinfo = await getInfo(program);
    await infoResponse(program, getinfo, challengeOf(getinfo), clients);
    return getinfo;
  }

  it('listens on 27950, and names Cloudflare\'s STUN to every socket', () => {
    expect(PORT_MASTER).toBe(27950);
    expect(ICE_SERVERS).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
    expect([REGISTER_PORTS, MAX_FRAME, RELAY_BURST, RELAY_PERIOD]).toEqual([10, 16448, 100, 50]);
  });

  describe('a socket', () => {
    it('is greeted with the address it came from, and the ICE servers', async () => {
      const program = peer('198.51.100.4', { port: 50123 });
      await settle();
      expect(program.link.address).toEqual(netadr(NA.IP, '198.51.100.4', 50123));
      expect(program.link.iceServers).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
    });

    it('is named by IPv6 in one spelling, or IPv4 when IPv4 reached an IPv6 socket', async () => {
      expect(connectionAddress('2001:DB8:0::4', 5)).toEqual(netadr(NA.IP6, '2001:db8::4', 5));
      expect(connectionAddress('::ffff:198.51.100.4', 5)).toEqual(
        netadr(NA.IP, '198.51.100.4', 5)
      );
      expect(connectionAddress('::1', 5)).toEqual(netadr(NA.IP6, '::1', 5));
      expect(connectionAddress('fe80::1%eth0', 5)).toBeNull();

      const scoped = peer('fe80::1%eth0');
      await settle();
      expect(scoped.ws.readyState).toBe(3);
      expect(scoped.link.address).toBeNull();
    });

    it('never goes by an address another live connection goes by', async () => {
      const client = peer('203.0.113.9', { port: 27960 });
      const first = await server('203.0.113.9');
      const second = peer('203.0.113.9', { port: 27961 });
      await settle();
      expect(client.link.address).toEqual(netadr(NA.IP, '203.0.113.9', 27960));
      expect(first.link.address).toEqual(netadr(NA.IP, '203.0.113.9', 27961));
      expect(second.link.address).toEqual(netadr(NA.IP, '203.0.113.9', 27962));
    });
  });

  describe('a registration', () => {
    it('grants a server its net_port, or the next free one within ten', async () => {
      const granted: (number | undefined)[] = [];
      for (let i = 0; i < 11; i++) granted.push((await server('203.0.113.9')).link.address?.port);
      expect(granted.slice(0, 10)).toEqual([...Array(10).keys()].map((i) => 27960 + i));
      // The eleventh keeps the address it came from.
      expect(granted[10]).toBeGreaterThanOrEqual(50000);
      expect(lines.at(-1)).toMatch(/can't register .* \(ports 27960 to 27969 are taken\)/);

      expect((await server('203.0.113.10')).link.address?.port).toBe(27960);
    });

    it("keeps a public address to dpmaster's 32 servers", async () => {
      const ports: (number | undefined)[] = [];
      for (let i = 0; i < 33; i++) {
        ports.push((await server('203.0.113.9', 10000 + 10 * i)).link.address?.port);
      }
      expect(ports[31]).toBe(10310);
      expect(ports[32]).toBeGreaterThanOrEqual(50000);
    });

    it('lets a server be found only locally until it heartbeats and answers', async () => {
      const program = await server('203.0.113.9');
      expect(await ask('getservers PlayCanvasQuake 1 empty full')).toEqual([[]]);
      expect(await ask('getservers PlayCanvasQuake 1 local', '203.0.113.9')).toEqual([
        ['203.0.113.9:27960']
      ]);
      expect(rtc.connections).toEqual([]);
      expect(program.link.address?.port).toBe(27960);
    });
  });

  describe('a heartbeat', () => {
    it('earns a getinfo down a channel the master dials, and its answer lists it', async () => {
      const program = await server('203.0.113.9');
      const getinfo = await heartbeat(program);

      // The master's own name for itself is the one the server knows it by.
      expect(getinfo.from).toEqual(MASTER_ADR);
      expect(rtc.connections.map((pc) => pc.connectionState)).toEqual(['connected', 'connected']);
      const [masters] = rtc.connections;
      expect(masters.channels[0].sent.map(text)).toEqual([text(getinfo.data)]);
      expect(await ask('getservers PlayCanvasQuake 1')).toEqual([['203.0.113.9:27960']]);
    });

    it('from a server whose channel is open comes down it, and dials nothing new', async () => {
      const program = await server('203.0.113.9');
      await heartbeat(program, '1');
      await heartbeat(program, '8');

      expect(rtc.connections).toHaveLength(2);
      expect(await ask('getservers PlayCanvasQuake 1')).toEqual([[]]);
      expect(await ask('getservers PlayCanvasQuake 1 full')).toEqual([['203.0.113.9:27960']]);
    });

    it('opens a channel that the master answers a query down, as it came', async () => {
      const program = await server('203.0.113.9');
      await heartbeat(program);
      program.socket.send(oob('getservers PlayCanvasQuake 1'), MASTER_ADR);
      await settle();
      master.frame();
      await settle();

      const [reply] = read(program.socket);
      expect(reply.from).toEqual(MASTER_ADR);
      expect(readList(reply.data)).toEqual(['203.0.113.9:27960']);
      const [masters] = rtc.connections;
      expect(readList(masters.channels[0].sent.at(-1)!)).toEqual(['203.0.113.9:27960']);
    });

    it('lists no server whose channel never opens', async () => {
      rtc.verdict = () => 'failed';
      const program = await server('203.0.113.9');
      program.socket.send(oob('heartbeat DarkPlaces\n'), MASTER_ADR);
      await settle();
      expect(read(program.socket)).toEqual([]);
      expect(await ask('getservers PlayCanvasQuake 1 empty full')).toEqual([[]]);
    });
  });

  describe("a heartbeat, at a master that checks down the server's own link", () => {
    beforeEach(() => {
      master = newMaster();
    });

    it("earns a getinfo as from the master's address, and its answer lists it", async () => {
      const program = await server('203.0.113.9');
      const getinfo = await heartbeat(program);

      expect(getinfo.from).toEqual(MASTER_ADR);
      expect(rtc.connections).toEqual([]);
      expect(await ask('getservers PlayCanvasQuake 1')).toEqual([['203.0.113.9:27960']]);
    });

    it('drops a signal for the master, which dials nobody', async () => {
      const client = peer('198.51.100.4');
      await settle();
      const signal = { dial: 1, description: { type: 'answer' as const, sdp: '' } };
      client.ws.send(encodeFrame({ kind: 'signal', peer: null, signal }));
      await settle();
      expect(client.ws.readyState).toBe(1);
      expect(rtc.connections).toEqual([]);
    });

    it('closes every socket when it closes', async () => {
      const program = await server('203.0.113.9');
      await heartbeat(program);
      master.close();
      await settle();
      expect(program.ws.readyState).toBe(3);
    });
  });

  describe.each([
    ['down a channel the master dials', true],
    ["down the server's own link", false]
  ])('a server checked %s', (_, dials) => {
    beforeEach(() => {
      if (!dials) master = newMaster();
    });

    it('is not listed for an answer with the wrong challenge', async () => {
      const program = await server('203.0.113.9');
      await infoResponse(program, await getInfo(program), 'wrong');
      expect(lines).toContain('> WARNING: invalid challenge from 203.0.113.9:27960 (wrong)');
      expect(await ask('getservers PlayCanvasQuake 1 empty full')).toEqual([[]]);
    });

    it('is forgotten with no answer within 2 seconds', async () => {
      const program = await server('203.0.113.9');
      const getinfo = await getInfo(program);
      // In dpmaster's whole seconds, a new server is forgotten once its third second has begun.
      now += (TIMEOUT_HEARTBEAT + 1) * 1000;
      await infoResponse(program, getinfo, challengeOf(getinfo));
      expect(lines).toContain('> WARNING: infoResponse from unknown server 203.0.113.9:27960');
      expect(await ask('getservers PlayCanvasQuake 1 empty full')).toEqual([[]]);
    });
  });

  describe('a signal', () => {
    it('goes to the socket it names, naming its sender, and the two then talk', async () => {
      const host = await server('203.0.113.9');
      const client = peer('198.51.100.4');
      await settle();

      client.socket.send(oob('getchallenge 5'), host.link.address!);
      await settle();
      expect(read(host.socket)).toEqual([
        { from: client.link.address, data: oob('getchallenge 5') }
      ]);
      expect(rtc.connections.map((pc) => pc.connectionState)).toEqual(['connected', 'connected']);
    });
  });

  describe('a relay', () => {
    it('carries a query and its answer between sockets with no channel, named', async () => {
      const host = await server('203.0.113.9');
      const client = peer('198.51.100.4');
      await settle();

      client.socket.send(oob('getinfo abc'), host.link.address!);
      await settle();
      expect(read(host.socket)).toEqual([{ from: client.link.address, data: oob('getinfo abc') }]);
      host.socket.send(oob('infoResponse\n\\challenge\\abc'), client.link.address!);
      await settle();
      expect(read(client.socket)).toEqual([
        { from: host.link.address, data: oob('infoResponse\n\\challenge\\abc') }
      ]);
      expect(rtc.connections).toEqual([]);
    });

    it('carries connectionless datagrams only', async () => {
      const host = await server('203.0.113.9');
      const client = peer('198.51.100.4');
      await settle();
      const relay = (data: Uint8Array<ArrayBuffer>) =>
        client.ws.send(encodeFrame({ kind: 'relay', peer: host.link.address!, data }));

      relay(Uint8Array.of(1, 0, 0, 0, 9));
      relay(oob('getinfo'));
      await settle();
      expect(read(host.socket).map(({ data }) => text(data))).toEqual(['\xff\xff\xff\xffgetinfo']);
    });

    it('is capped with the signals: a burst of 100, then one every 50 ms', async () => {
      const host = await server('203.0.113.9');
      const client = peer('198.51.100.4');
      const other = peer('198.51.100.5');
      await settle();
      const frame = encodeFrame({ kind: 'relay', peer: host.link.address!, data: oob('getinfo') });
      const relay = (from: typeof client) => from.ws.send(frame);
      const arrived = async () => {
        await settle();
        return read(host.socket).length;
      };

      for (let i = 0; i < 101; i++) relay(client);
      expect(await arrived()).toBe(100);
      relay(other);
      expect(await arrived()).toBe(1);

      now += 49;
      relay(client);
      expect(await arrived()).toBe(0);
      now += 1;
      relay(client);
      relay(client);
      expect(await arrived()).toBe(1);

      // A signal counts against the same bucket, so a dial now goes nowhere.
      client.socket.send(oob('getchallenge 1'), host.link.address!);
      await settle();
      expect(rtc.connections).toHaveLength(1);
    });
  });

  describe('a name', () => {
    /** The master's answers to a client's names, as each asks for them. */
    async function resolve(...asks: [string, number][]) {
      const client = peer('198.51.100.4');
      const answers: Resolved[] = [];
      client.link.onResolved = (answer) => answers.push(answer);
      await settle();
      for (const [name, port] of asks) client.ws.send(encodeFrame({ kind: 'resolve', name, port }));
      await settle();
      return answers;
    }

    it('is answered with its addresses: those a server is registered at, then IPv4', async () => {
      await server('2001:db8::9');
      names.set('quake.test', [
        { address: '2001:db8::a', family: 6 },
        { address: '198.51.100.9', family: 4 },
        { address: '2001:DB8:0::9', family: 6 },
        { address: '::ffff:198.51.100.10', family: 6 },
        { address: 'fe80::1%eth0', family: 6 }
      ]);

      const answers = await resolve(['quake.test', 27960], ['quake.test', 27961]);
      expect(answers.map(({ port, error }) => [port, error])).toEqual([
        [27960, null],
        [27961, null]
      ]);
      const [registered, unregistered] = answers.map(({ addresses }) =>
        addresses.map(adrToStringWithPort)
      );
      expect(registered).toEqual([
        '[2001:db8::9]:27960',
        '198.51.100.9:27960',
        '198.51.100.10:27960',
        '[2001:db8::a]:27960'
      ]);
      expect(unregistered).toEqual([
        '198.51.100.9:27961',
        '198.51.100.10:27961',
        '[2001:db8::a]:27961',
        '[2001:db8::9]:27961'
      ]);
    });

    it('that is not found is answered with why', async () => {
      const [answer] = await resolve(['nowhere.test', 27960]);
      expect(answer).toMatchObject({ name: 'nowhere.test', addresses: [], error: 'ENOTFOUND' });
    });

    it('is capped with the relays', async () => {
      names.set('quake.test', [{ address: '203.0.113.9', family: 4 }]);
      const ask: [string, number] = ['quake.test', 1];
      const asks = Array.from({ length: RELAY_BURST + 1 }, () => ask);
      expect(await resolve(...asks)).toHaveLength(RELAY_BURST);
    });
  });

  describe('a frame', () => {
    it('is read up to MAX_FRAME, and one longer closes its socket', async () => {
      const host = await server('203.0.113.9');
      const client = peer('198.51.100.4');
      await settle();
      const line = `\xff\xff\xff\xffrelay 203.0.113.9:27960\n`;
      const frame = (size: number) => {
        const data = new Uint8Array(size);
        data.set(oob(`relay 203.0.113.9:27960\n\xff\xff\xff\xffgetstatus`));
        return data;
      };

      client.ws.send(frame(MAX_FRAME));
      await settle();
      expect(read(host.socket).map(({ data }) => data.length)).toEqual([MAX_FRAME - line.length]);

      client.ws.send(frame(MAX_FRAME + 1));
      await settle();
      expect(read(host.socket)).toEqual([]);
      expect(client.ws.readyState).toBe(3);
    });
  });

  describe('a server that goes, or registers again', () => {
    it('frees its address, and takes its server off the list', async () => {
      const program = await server('203.0.113.9');
      await heartbeat(program);
      program.link.close();
      await settle();

      expect(await ask('getservers PlayCanvasQuake 1')).toEqual([[]]);
      expect(await ask('getservers PlayCanvasQuake 1 local', '203.0.113.9')).toEqual([[]]);
      expect((await server('203.0.113.9')).link.address?.port).toBe(27960);
    });

    it('that asks again for the port it has keeps it, and its listing', async () => {
      const program = await server('203.0.113.9');
      await heartbeat(program);
      program.link.register(27960);
      await settle();
      expect(program.link.address?.port).toBe(27960);
      expect(await ask('getservers PlayCanvasQuake 1')).toEqual([['203.0.113.9:27960']]);
    });

    it('that has registered anew is listed no more under its old address', async () => {
      const program = await server('203.0.113.9');
      await heartbeat(program);
      program.link.register(28000);
      await settle();
      expect(program.link.address?.port).toBe(28000);
      expect(await ask('getservers PlayCanvasQuake 1')).toEqual([[]]);
    });
  });

  describe('a master started afresh from the records its WebSockets hold', () => {
    beforeEach(() => {
      master = newMaster();
    });

    /** A server whose WebSocket's end at the master holds a record. */
    const recordedServer = (ip: string) => server(ip, 27960, { recorded: true });

    /**
     * The master as a Durable Object woken from hibernation has it: a new one, given the master's
     * end of each program's WebSocket back with its record, while the programs keep their links.
     */
    function wake(...programs: ReturnType<typeof peer>[]): void {
      master = newMaster();
      for (const { recorded } of programs) {
        const end = recorded!.woken();
        master.restore(end, end.record!);
      }
    }

    it('knows its sockets by the same addresses, and lists the same servers', async () => {
      const first = await recordedServer('203.0.113.9');
      const second = await recordedServer('203.0.113.9');
      const quiet = await recordedServer('203.0.113.9');
      const client = peer('198.51.100.4', { recorded: true });
      await heartbeat(first);
      await heartbeat(second, '8');
      const lists = async () => [
        await ask('getservers PlayCanvasQuake 1 full'),
        await ask('getservers PlayCanvasQuake 1 local', '203.0.113.9')
      ];
      const before = await lists();
      expect(before).toEqual([
        [['203.0.113.9:27960', '203.0.113.9:27961']],
        [['203.0.113.9:27960', '203.0.113.9:27961', '203.0.113.9:27962']]
      ]);

      const frames: string[] = [];
      for (const program of [first, second, quiet, client]) {
        program.ws.addEventListener('message', (event: { data?: unknown }) => {
          frames.push(decodeFrame(new Uint8Array(event.data as ArrayBuffer))?.kind ?? '');
        });
      }
      wake(first, second, quiet, client);
      await settle();
      // No socket is greeted again.
      expect(frames).toEqual([]);
      expect(await lists()).toEqual(before);

      // A relay goes between two of them by the addresses they went by.
      client.socket.send(oob('getinfo abc'), quiet.link.address!);
      await settle();
      expect(read(quiet.socket)).toEqual([{ from: client.link.address, data: oob('getinfo abc') }]);
      // Their ports are still taken, and one whose socket closes takes its server along.
      expect((await recordedServer('203.0.113.9')).link.address?.port).toBe(27963);
      second.link.close();
      await settle();
      expect(await ask('getservers PlayCanvasQuake 1 full')).toEqual([['203.0.113.9:27960']]);
    });

    it('takes the answer to a getinfo the master before it sent', async () => {
      const program = await recordedServer('203.0.113.9');
      const getinfo = await getInfo(program);
      wake(program);
      await infoResponse(program, getinfo, challengeOf(getinfo));
      expect(await ask('getservers PlayCanvasQuake 1')).toEqual([['203.0.113.9:27960']]);
    });

    it('drops a listing whose time ran out between the two', async () => {
      const early = await recordedServer('203.0.113.9');
      await heartbeat(early);
      now += 600_000;
      const late = await recordedServer('203.0.113.9');
      await heartbeat(late);
      // Past the first listing's 15 minutes, and within the second's.
      now += (TIMEOUT_INFORESPONSE - 600 + 1) * 1000;
      wake(early, late);

      expect(await ask('getservers PlayCanvasQuake 1')).toEqual([['203.0.113.9:27961']]);
      expect(await ask('getservers PlayCanvasQuake 1 local', '203.0.113.9')).toEqual([
        ['203.0.113.9:27960', '203.0.113.9:27961']
      ]);
    });

    it('starts the rate limit afresh', async () => {
      const host = await recordedServer('203.0.113.9');
      const client = peer('198.51.100.4', { recorded: true });
      await settle();
      const frame = encodeFrame({ kind: 'relay', peer: host.link.address!, data: oob('getinfo') });
      for (let i = 0; i <= RELAY_BURST; i++) client.ws.send(frame);
      await settle();
      expect(read(host.socket)).toHaveLength(RELAY_BURST);

      wake(host, client);
      client.ws.send(frame);
      await settle();
      expect(read(host.socket)).toHaveLength(1);
    });
  });

  it('closes every socket and channel when it closes', async () => {
    const program = await server('203.0.113.9');
    await heartbeat(program);
    master.close();
    await settle();
    expect(program.ws.readyState).toBe(3);
    expect(rtc.connections[0].connectionState).toBe('closed');
  });

  it('grants a server on IPv6 its port there, as one on IPv4', async () => {
    const addresses: NetAdr[] = [];
    for (const ip of ['203.0.113.9', '2001:db8::9']) {
      const program = await server(ip);
      addresses.push(program.link.address!);
    }
    expect(addresses).toEqual([
      netadr(NA.IP, '203.0.113.9', 27960),
      netadr(NA.IP6, '2001:db8::9', 27960)
    ]);
  });
});
