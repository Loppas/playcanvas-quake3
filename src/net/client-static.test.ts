import type { LookupAddress } from 'node:dns';

import { describe, expect, it } from 'vitest';

import { MasterServer } from '../../master/master-server';
import { masterPeer } from '../../master/master-test-fixtures';
import { ClientStatic } from './client-static';
import { ClientConnection } from './connection';
import { adrToStringWithPort, Net, stringToAdr, type NetAdr } from './net';
import { serversResponse, testCvars } from './net-test-fixtures';
import { FakeMaster, FakeRtc, fakePeer, settle, webSocketPair } from './peer-test-fixtures';
import { AS } from './server-lists';

/** An out-of-band datagram. */
const oob = (text: string) =>
  Uint8Array.from([0xff, 0xff, 0xff, 0xff, ...new TextEncoder().encode(text)]);

/** A datagram's text behind its marker. */
const text = (data: Uint8Array) => new TextDecoder().decode(data.subarray(4));

/** A port's answer: Quake 3's, then past a blank line the board as a client reads it. */
const STATUS =
  'statusResponse\n\\sv_hostname\\Arena\\mapname\\q3dm17\n' +
  '3 0 "UnnamedPlayer"\n12 999 "Sarge"\n\nscores 2 0 0\ncs 544 "n\\Sarge"\n';

/** A port's answer to `getinfo`. */
const INFO =
  'infoResponse\n\\clients\\1\\mapname\\q3dm17\\hostname\\Arena' +
  '\\protocol\\2\\gamename\\PlayCanvasQuake\\challenge\\xxx';

/**
 * The page's client at 198.51.100.4, on a clock the test sets, whose Internet master and LAN
 * master are in memory, and two servers registered at the first: 203.0.113.9 and 203.0.113.10,
 * each on 27960.
 */
async function rig(values: Record<string, string> = {}) {
  const master = new FakeMaster('master.test');
  const lan = new FakeMaster('lan.test');
  const rtc = new FakeRtc();
  const servers = ['203.0.113.9', '203.0.113.10'].map((ip) => {
    const peer = fakePeer(master, rtc.create, ip, { dials: false });
    peer.link.register(27960);
    return peer;
  });
  await settle();

  const lines: string[] = [];
  const sockets: ReturnType<FakeMaster['connect']>[] = [];
  let connects = 0;
  let now = 1000;
  const cvars = testCvars({ sv_master1: 'master.test', sv_master2: '', ...values });
  const cls = new ClientStatic({
    cvars,
    createPeerConnection: rtc.create,
    connect: (url) => {
      connects++;
      const fake = [master, lan].find((m) => m.adr.ip === new URL(url).hostname);
      if (fake === undefined) throw new Error(`no master at ${url}`);
      const ws = fake.connect('198.51.100.4');
      sockets.push(ws);
      return ws;
    },
    print: (line) => lines.push(line),
    now: () => now
  });

  /** What a server was sent, as text, and who sent it. */
  const asked = (server: number) => {
    const got: { from: NetAdr; text: string }[] = [];
    for (let p; (p = servers[server].socket.receive()) !== null; ) {
      got.push({ from: p.from, text: text(p.data) });
    }
    return got;
  };
  /** A server's answer to an address, landed and not yet read. */
  const land = async (server: number, to: NetAdr, message: string) => {
    servers[server].socket.send(oob(message), to);
    await settle();
  };
  /** A server's answer to an address, landed and read by the client's frame. */
  const answer = async (server: number, to: NetAdr, message: string) => {
    await land(server, to, message);
    cls.frame();
  };
  const at = (ms: number) => {
    now = ms;
  };
  return {
    cls,
    cvars,
    lines,
    master,
    lan,
    rtc,
    sockets,
    asked,
    land,
    answer,
    at,
    connects: () => connects
  };
}

/** What a master was sent, as text. */
const questions = (master: FakeMaster) => master.datagrams.map((d) => text(d.data));

/**
 * The page's client at 192.168.1.9, both slots naming the port's own master, whose lookup finds
 * what `names` holds; and servers registered there on 27960 at 192.168.1.5 and at `::1`.
 */
async function ownMaster(names: Record<string, LookupAddress[]> = {}) {
  const rtc = new FakeRtc();
  const master = new MasterServer({
    createPeerConnection: rtc.create,
    lookup: async (name) => names[name] ?? [],
    print: () => {}
  });
  const servers = ['192.168.1.5', '::1'].map((ip) => {
    const peer = masterPeer(master, rtc.create, ip, { dials: false });
    peer.link.register(27960);
    return peer;
  });
  await settle();
  const cls = new ClientStatic({
    cvars: testCvars({ sv_master1: 'master.test', sv_master2: 'master.test' }),
    createPeerConnection: rtc.create,
    connect: () => {
      const { client, server } = webSocketPair();
      master.connect(server, '192.168.1.9', 50100);
      return client;
    },
    print: () => {}
  });
  return { cls, servers };
}

describe("the page's client", () => {
  it('opens no master until it is asked something', async () => {
    const { cls, connects } = await rig();
    cls.frame();
    await settle();
    expect(connects()).toBe(0);
  });

  it("asks a server's status through the master, and prints it as Quake 3 does", async () => {
    const { cls, lines, asked, answer, connects } = await rig();
    cls.serverStatus(['serverstatus', '203.0.113.9:27960']);
    await settle();
    expect(connects()).toBe(1);

    const [question] = asked(0);
    expect(question.text).toBe('getstatus');
    expect(question.from.ip).toBe('198.51.100.4');
    await answer(0, question.from, STATUS);

    // `%-24s` for a key, and `%-2d   %-3d    %-3d   %s` for a player, whose name keeps its
    // quotes and whose number is its line's, not its slot's.
    expect(lines).toEqual([
      'Server settings:',
      `${'sv_hostname'.padEnd(24)}Arena`,
      `${'mapname'.padEnd(24)}q3dm17`,
      '',
      'Players:',
      'num: score: ping: name:',
      '0    3      0     "UnnamedPlayer"',
      '1    12     999   "Sarge"'
    ]);
  });

  it('takes a status only from a server it asked', async () => {
    const { cls, lines, asked, answer } = await rig();
    cls.serverStatus(['serverstatus', '203.0.113.9:27960']);
    await settle();
    const [question] = asked(0);
    await answer(1, question.from, STATUS);
    expect(lines).toEqual([]);
  });

  it('says how to use it when it names no server and is playing on none', async () => {
    const { cls, lines, connects } = await rig();
    cls.serverStatus(['serverstatus']);
    await settle();
    expect(lines).toEqual(['Not connected to a server.', 'usage: serverstatus [-4|-6] server']);
    expect(connects()).toBe(0);
  });

  it('leaves the socket to a match on it, which hands on the answers not its own', async () => {
    const { cls, cvars, lines, asked, answer } = await rig();
    const connection = new ClientConnection(cvars);
    cls.attach(cls.net, connection);
    cls.serverStatus(['serverstatus', '203.0.113.9:27960']);
    await settle();

    const [question] = asked(0);
    await answer(0, question.from, STATUS);
    expect(lines).toEqual([]);
    for (let p; (p = cls.net.getPacket()) !== null; ) connection.packetEvent(p.from, p.data);
    expect(lines[0]).toBe('Server settings:');
  });

  it("keeps what it asked over a match's end, and hears the answer after", async () => {
    const { cls, cvars, lines, asked, answer } = await rig();
    const match = new Net({ cvars });
    const connection = new ClientConnection(cvars);
    cls.attach(match, connection);
    cls.serverStatus(['serverstatus', '203.0.113.9:27960']);
    await settle();
    cls.detach();

    const [question] = asked(0);
    await answer(0, question.from, STATUS);
    expect(lines[0]).toBe('Server settings:');
    expect(connection.onConnectionless).toBeNull();
  });

  it('reads the socket again once a match on it is over', async () => {
    const { cls, cvars, lines, asked, answer } = await rig();
    cls.attach(cls.net, new ClientConnection(cvars));
    cls.detach();
    cls.serverStatus(['serverstatus', '203.0.113.9:27960']);
    await settle();

    const [question] = asked(0);
    await answer(0, question.from, STATUS);
    expect(lines[0]).toBe('Server settings:');
  });

  it('follows the master slots each frame, so what a match sends finds its server', async () => {
    const { cls, asked } = await rig();
    cls.frame();
    cls.net.outOfBandPrint('client', stringToAdr('203.0.113.9:27960')!, 'getchallenge 7');
    await settle();
    expect(asked(0).map((question) => question.text)).toEqual(['getchallenge 7']);
  });

  it('closes its masters and its channels as the page goes', async () => {
    const { cls, rtc, sockets } = await rig();
    cls.probe('203.0.113.9:27960');
    await settle();
    cls.close();
    await settle();
    expect(sockets.map((ws) => ws.readyState)).toEqual([3]);
    expect(rtc.connections[0].connectionState).toBe('closed');
  });
});

describe("the page's client's server lists", () => {
  it('asks the Internet master for its list by getserversExt, and lists its answer', async () => {
    const { cls, lines, master } = await rig();
    cls.globalServers(['globalservers', '0', '1', 'empty', 'full']);
    await settle();
    expect(questions(master)).toEqual(['getserversExt PlayCanvasQuake 1 empty full']);
    expect(cls.servers.count(AS.GLOBAL)).toBe(-1);

    const list = serversResponse(['203.0.113.9:27960', '[2001:db8::9]:27960'], { extended: true });
    master.sendDatagram(master.datagrams[0].from, list);
    await settle();
    cls.frame();
    expect(cls.servers.count(AS.GLOBAL)).toBe(2);
    expect(adrToStringWithPort(cls.servers.server(AS.GLOBAL, 1)!.adr)).toBe('[2001:db8::9]:27960');
    expect(lines).toEqual([
      'Requesting servers from master.test (master.test:27950)...',
      'CL_ServersResponsePacket from master.test:27950',
      '2 servers parsed (total 2)'
    ]);
  });

  it('says how to ask for the global list, and when no master is named', async () => {
    const { cls, cvars, lines, connects } = await rig();
    cls.globalServers(['globalservers', '1']);
    cls.globalServers(['globalservers', '2', '1']);
    cvars.set('sv_master1', 'a:b:c');
    cls.globalServers(['globalservers', '1', '1']);
    cvars.set('sv_master1', '');
    cls.globalServers(['globalservers', '0', '1']);
    cls.globalServers(['globalservers', '1', '1']);
    await settle();
    expect(lines).toEqual([
      'usage: globalservers <master# 0-1> <protocol> [keywords]',
      'usage: globalservers <master# 0-1> <protocol> [keywords]',
      'CL_GlobalServers_f: Error: could not resolve address of master a:b:c',
      'CL_GlobalServers_f: Error: No master server addresses.',
      'CL_GlobalServers_f: Error: No master server address given.'
    ]);
    expect(connects()).toBe(0);
  });

  it("asks the LAN master for the servers on the player's network, and lists them", async () => {
    const { cls, lines, master, lan } = await rig({ sv_master2: 'lan.test' });
    cls.localServers();
    await settle();
    expect(questions(lan)).toEqual(['getserversExt PlayCanvasQuake 2 local']);
    expect(questions(master)).toEqual([]);

    const list = serversResponse(['192.168.1.5:27960'], { extended: true });
    lan.sendDatagram(lan.datagrams[0].from, list);
    await settle();
    cls.frame();
    expect(cls.servers.count(AS.LOCAL)).toBe(1);
    expect(cls.servers.count(AS.GLOBAL)).toBe(0);
    expect(lines[0]).toBe('Scanning for servers on the local network...');
  });

  it('asks the Internet master when the LAN slot names none or its master is down', async () => {
    for (const slot of ['', 'lan.test', 'nowhere.test']) {
      const { cls, master, lan } = await rig({ sv_master2: slot });
      lan.up = false;
      cls.localServers();
      await settle();
      expect(questions(master)).toEqual(['getserversExt PlayCanvasQuake 2 local']);
    }
  });

  it('lists what the LAN master answers afresh each time, after the global list', async () => {
    const { cls, lan } = await rig({ sv_master2: 'lan.test' });
    cls.globalServers(['globalservers', '1', '1']);
    for (const server of ['192.168.1.5:27960', '192.168.1.6:27960']) {
      cls.localServers();
      await settle();
      lan.sendDatagram(lan.datagrams[0].from, serversResponse([server], { extended: true }));
      await settle();
      cls.frame();
    }
    expect(cls.servers.count(AS.LOCAL)).toBe(1);
    expect(adrToStringWithPort(cls.servers.server(AS.LOCAL, 0)!.adr)).toBe('192.168.1.6:27960');
    expect(cls.servers.count(AS.GLOBAL)).toBe(-1);
  });

  it('pings through the masters as an estimate, and down a probed channel truly', async () => {
    const { cls, master, asked, answer, at } = await rig();
    cls.ping(['ping', '203.0.113.9:27960']);
    await settle();
    const [question] = asked(0);
    expect(question.text).toBe('getinfo xxx');
    at(1080);
    await answer(0, question.from, INFO);
    const address = '203.0.113.9:27960';
    const adr = stringToAdr(address);
    expect(cls.servers.getPing(0)).toEqual({ address, adr, time: 81, estimate: true });
    expect(master.read('relay')).toHaveLength(2);

    // The probe's channel is seen open once it is, and only by the server it was given.
    cls.probe(address);
    expect(cls.probeOpen(address)).toBe(false);
    await settle();
    expect(cls.probeOpen(address)).toBe(true);
    expect(cls.probeOpen('198.51.100.7:27960')).toBe(false);
    cls.ping(['ping', address]);
    await settle();
    const [probed] = asked(0);
    at(1090);
    await answer(0, probed.from, INFO);
    expect(cls.servers.getPing(1)).toEqual({ address, adr, time: 11, estimate: false });
    expect(master.read('relay')).toHaveLength(2);
  });

  it("takes a server's info only from a server of this game and protocol", async () => {
    const { cls, asked, answer, at } = await rig();
    cls.ping(['ping', '203.0.113.9:27960']);
    await settle();
    const [question] = asked(0);
    at(1050);
    await answer(0, question.from, INFO.replace('PlayCanvasQuake', 'Quake3Arena'));
    await answer(0, question.from, INFO.replace('\\protocol\\2', '\\protocol\\68'));
    expect(cls.servers.getPing(0)?.time).toBe(0);
    await answer(0, question.from, INFO);
    expect(cls.servers.getPing(0)?.time).toBe(51);
  });

  it('times a ping from when its answer landed, not from the frame that reads it', async () => {
    const { cls, asked, land, at } = await rig();
    cls.ping(['ping', '203.0.113.9:27960']);
    await settle();
    const [question] = asked(0);
    at(1080);
    await land(0, question.from, INFO);
    at(1097);
    cls.frame();
    expect(cls.servers.getPing(0)?.time).toBe(81);
  });

  it('times a ping by its landing through a match on the socket, which hands it on', async () => {
    const { cls, cvars, asked, land, at } = await rig();
    const connection = new ClientConnection(cvars);
    cls.attach(cls.net, connection);
    cls.ping(['ping', '203.0.113.9:27960']);
    await settle();
    const [question] = asked(0);
    at(1080);
    await land(0, question.from, INFO);
    at(1097);
    for (let p; (p = cls.net.getPacket()) !== null; ) {
      connection.packetEvent(p.from, p.data, p.time);
    }
    expect(cls.servers.getPing(0)?.time).toBe(81);
  });

  it('says how to ping, and pings nothing it cannot read an address from', async () => {
    const { cls, lines, connects } = await rig();
    cls.ping(['ping']);
    cls.ping(['ping', '-4', '203.0.113.9', 'extra']);
    cls.ping(['ping', 'a:b:c']);
    await settle();
    expect(lines).toEqual(['usage: ping [-4|-6] server', 'usage: ping [-4|-6] server']);
    expect(cls.servers.pingQueueCount()).toBe(0);
    expect(connects()).toBe(0);
  });

  it('pings a name at the address the masters find, and reads it back by the name', async () => {
    const { cls, master, asked, answer, at } = await rig();
    master.names.set('quake.test', ['203.0.113.9']);
    cls.servers.add(AS.FAVORITES, 'Mine', 'quake.test');
    cls.ping(['ping', 'quake.test']);
    // The name holds its slot while the masters look it up, as Q3's lookup holds up the command.
    expect(cls.servers.pingQueueCount()).toBe(1);
    await settle();
    expect(master.read('resolve')).toEqual([{ kind: 'resolve', name: 'quake.test', port: 27960 }]);

    const [question] = asked(0);
    expect(question.text).toBe('getinfo xxx');
    at(1040);
    await answer(0, question.from, INFO);
    expect(cls.servers.pingQueueCount()).toBe(1);
    expect(cls.servers.getPing(0)).toMatchObject({ address: 'quake.test:27960', time: 41 });
    // The favourite named so fills in from the answer.
    expect(cls.servers.server(AS.FAVORITES, 0)).toMatchObject({ hostName: 'Arena', ping: 41 });
  });

  it('waits past a master that finds no address for one that finds one in the family', async () => {
    const { cls, lines, master, lan } = await rig({ sv_master2: 'lan.test' });
    lan.names.set('quake.test', ['2001:db8::9', '203.0.113.9']);
    cls.serverStatus(['serverstatus', '-4', 'quake.test:27961']);
    cls.serverStatus(['serverstatus', '-6', 'quake.test:27961']);
    await settle();

    const asked = master.read('relay').map((frame) => adrToStringWithPort(frame.peer));
    expect(asked).toEqual(['203.0.113.9:27961', '[2001:db8::9]:27961']);
    expect(lines).toEqual([]);
  });

  it('fails a name every master has failed, with the first reason, once each has', async () => {
    const { cls, lines, lan } = await rig({ sv_master2: 'lan.test' });
    lan.up = false;
    cls.ping(['ping', 'nowhere.test']);
    expect(cls.servers.pingQueueCount()).toBe(1);
    await settle();
    expect(lines).toEqual(['Sys_StringToSockaddr: Error resolving nowhere.test: ENOTFOUND']);
    expect(cls.servers.pingQueueCount()).toBe(0);
  });

  it("keeps the first master's reason when the next fails the name too", async () => {
    const { cls, lines, master } = await rig({ sv_master2: 'lan.test' });
    master.names.set('quake.test', ['203.0.113.9']);
    cls.ping(['ping', '-6', 'quake.test']);
    await settle();
    expect(lines).toEqual([
      'Sys_StringToSockaddr: Error resolving quake.test: No address of required type found.'
    ]);
  });

  it('pings a name two masters find once', async () => {
    const { cls, master, lan, asked } = await rig({ sv_master2: 'lan.test' });
    master.names.set('quake.test', ['203.0.113.9']);
    lan.names.set('quake.test', ['203.0.113.9']);
    cls.ping(['ping', 'quake.test']);
    await settle();
    expect(asked(0).map((question) => question.text)).toEqual(['getinfo xxx']);
  });

  it('fails a name when no master is named, or each is gone before it answered', async () => {
    const { cls, cvars, lines, master } = await rig();
    master.answers = false;
    cls.ping(['ping', 'quake.test']);
    await settle();
    expect(lines).toEqual([]);
    master.restart();
    await settle();

    cvars.set('sv_master1', '');
    cls.ping(['ping', 'quake.test']);
    const failed = 'Sys_StringToSockaddr: Error resolving quake.test: no master answered';
    expect(lines).toEqual([failed, failed]);
    expect(cls.servers.pingQueueCount()).toBe(0);
  });

  it('takes a number as it is, in its own family only, and warns of an unknown flag', async () => {
    const { cls, lines, master } = await rig();
    cls.ping(['ping', '-6', '203.0.113.9']);
    cls.ping(['ping', '-4', '[2001:db8::9]:27960']);
    cls.ping(['ping', '-5', '203.0.113.9']);
    await settle();
    expect(lines).toEqual([
      'Sys_StringToSockaddr: Error resolving 203.0.113.9: No address of required type found.',
      'Sys_StringToSockaddr: Error resolving 2001:db8::9: No address of required type found.',
      'warning: only -4 or -6 as address type understood.'
    ]);
    expect(master.read('resolve')).toEqual([]);
    expect(cls.servers.getPing(0)?.address).toBe('203.0.113.9:27960');
  });

  it('hands the browser a status once in, asking again every 750 msec till then', async () => {
    const { cls, lines, asked, answer, at } = await rig();
    const address = '203.0.113.9:27960';
    // No entry is free until the browser has let every server go.
    expect(cls.getServerStatus(address)).toBeNull();
    await settle();
    expect(asked(0)).toEqual([]);

    cls.getServerStatus(null);
    expect(cls.getServerStatus(address)).toBeNull();
    at(1750);
    expect(cls.getServerStatus(address)).toBeNull();
    await settle();
    expect(asked(0).map((q) => q.text)).toEqual(['getstatus']);

    at(1751);
    cls.getServerStatus(address);
    await settle();
    const [again] = asked(0);
    expect(again.text).toBe('getstatus');
    await answer(0, again.from, STATUS);
    const reply = {
      info: '\\sv_hostname\\Arena\\mapname\\q3dm17',
      players: ['3 0 "UnnamedPlayer"', '12 999 "Sarge"'],
      board: ['scores 2 0 0', 'cs 544 "n\\Sarge"']
    };
    expect(cls.getServerStatus(address)).toEqual(reply);
    expect(cls.getServerStatus(address)).toEqual(reply);
    expect(lines).toEqual([]);

    cls.getServerStatus(null);
    expect(cls.getServerStatus(address)).toBeNull();
    await settle();
    expect(asked(0).map((q) => q.text)).toEqual(['getstatus']);
  });

  it("asks a name's status where the masters find it, and hands it over by the name", async () => {
    const { cls, master, asked, answer } = await rig();
    master.names.set('quake.test', ['203.0.113.9']);
    cls.getServerStatus(null);
    expect(cls.getServerStatus('quake.test')).toBeNull();
    // Let go before the masters answer, the question is never sent.
    cls.getServerStatus(null);
    await settle();
    expect(asked(0)).toEqual([]);

    expect(cls.getServerStatus('quake.test')).toBeNull();
    await settle();
    expect(master.read('resolve')).toHaveLength(2);
    const [question] = asked(0);
    expect(question.text).toBe('getstatus');
    await answer(0, question.from, STATUS);
    const players = ['3 0 "UnnamedPlayer"', '12 999 "Sarge"'];
    expect(cls.getServerStatus('quake.test')).toMatchObject({ players });
  });

  it('opens a channel to a name where the masters find it', async () => {
    const { cls, master, asked, answer, at } = await rig();
    master.names.set('quake.test', ['203.0.113.9']);
    cls.probe('quake.test');
    await settle();
    // Seen open by the name it was given.
    expect(cls.probeOpen('quake.test')).toBe(true);
    cls.ping(['ping', '203.0.113.9:27960']);
    await settle();
    const [question] = asked(0);
    at(1010);
    await answer(0, question.from, INFO);
    expect(cls.servers.getPing(0)).toMatchObject({ time: 11, estimate: false });
  });

  it("lists its network's servers from the port's own master, and pings them", async () => {
    const { cls, servers } = await ownMaster();
    cls.localServers();
    await settle();
    cls.frame();
    const rows = [0, 1].map((n) => cls.servers.server(AS.LOCAL, n)!);
    expect(rows.map((row) => adrToStringWithPort(row.adr)).sort()).toEqual([
      '192.168.1.5:27960',
      '[::1]:27960'
    ]);

    cls.ping(['ping', '[::1]:27960']);
    await settle();
    const question = servers[1].socket.receive()!;
    expect(text(question.data)).toBe('getinfo xxx');
    servers[1].socket.send(oob(INFO), question.from);
    await settle();
    cls.frame();
    const loopback = rows.find((row) => row.adr.ip === '::1');
    expect(loopback).toMatchObject({ hostName: 'Arena', mapName: 'q3dm17', estimate: true });
  });

  it("pings a name the port's own master looks up, at the address a server holds", async () => {
    const found: LookupAddress[] = [
      { address: '198.51.100.9', family: 4 },
      { address: '::1', family: 6 }
    ];
    const { cls, servers } = await ownMaster({ 'quake.test': found });
    cls.ping(['ping', 'quake.test']);
    await settle();
    expect(text(servers[1].socket.receive()!.data)).toBe('getinfo xxx');
    expect(cls.servers.getPing(0)?.address).toBe('quake.test:27960');
  });
});

describe("the page's client connecting", () => {
  /** What `connect` asked of the page: to leave what it played, and to join what it found. */
  function page() {
    const told: string[] = [];
    return {
      told,
      leave: (finalMessage: string, server: string) => {
        told.push(`leave ${server}: ${finalMessage}`);
      },
      found: (server: string, address: NetAdr | null) => {
        told.push(`found ${server}: ${address === null ? null : adrToStringWithPort(address)}`);
      }
    };
  }

  it('says how to connect, and warns of an unknown flag', async () => {
    const { cls, lines } = await rig();
    const { told, leave, found } = page();
    cls.connect(['connect'], leave, found);
    cls.connect(['connect', '-5', '203.0.113.9'], leave, found);
    expect(lines).toEqual([
      'usage: connect [-4|-6] server',
      'warning: only -4 or -6 as address type understood.',
      '203.0.113.9 resolved to 203.0.113.9:27960'
    ]);
    expect(told).toEqual([
      'leave 203.0.113.9: Server was killed',
      'found 203.0.113.9: 203.0.113.9:27960'
    ]);
  });

  it("leaves what the page played, then finds a number at once, in Quake 3's words", async () => {
    const { cls, cvars, lines } = await rig();
    const { told, leave, found } = page();
    cls.connect(['connect', '203.0.113.9:27961'], leave, found);
    cls.connect(['connect', 'localhost'], leave, found);
    expect(told).toEqual([
      'leave 203.0.113.9:27961: Server was killed',
      'found 203.0.113.9:27961: 203.0.113.9:27961',
      'leave localhost: Server quit',
      'found localhost: loopback'
    ]);
    expect(lines).toEqual([
      '203.0.113.9:27961 resolved to 203.0.113.9:27961',
      'localhost resolved to loopback'
    ]);
    expect(cvars.get('cl_currentServerAddress')).toBe('localhost');
  });

  it("takes a port of 0 for the server's own", async () => {
    const { cls, lines } = await rig();
    const { told, leave, found } = page();
    cls.connect(['connect', '203.0.113.9:0'], leave, found);
    expect(told.at(-1)).toBe('found 203.0.113.9:0: 203.0.113.9:27960');
    expect(lines).toEqual(['203.0.113.9:0 resolved to 203.0.113.9:27960']);
  });

  it('looks a name up at the masters, and says when there is no such server', async () => {
    const { cls, lines, master } = await rig();
    master.names.set('quake.test', ['203.0.113.9']);
    const { told, leave, found } = page();
    cls.connect(['connect', 'quake.test'], leave, found);
    cls.connect(['connect', '-6', '203.0.113.10'], leave, found);
    expect(told.at(-1)).toBe('found 203.0.113.10: null');
    await settle();

    cls.connect(['connect', 'quake.test'], leave, found);
    cls.connect(['connect', 'nowhere.test'], leave, found);
    await settle();
    // The first name's answer came after the connect that took its place, and went nowhere.
    expect(told.filter((line) => line.startsWith('found'))).toEqual([
      'found 203.0.113.10: null',
      'found nowhere.test: null'
    ]);
    expect(lines).toEqual([
      'Sys_StringToSockaddr: Error resolving 203.0.113.10: No address of required type found.',
      'Bad server address',
      'Sys_StringToSockaddr: Error resolving nowhere.test: ENOTFOUND',
      'Bad server address'
    ]);

    cls.connect(['connect', 'quake.test'], leave, found);
    await settle();
    expect(told.at(-1)).toBe('found quake.test: 203.0.113.9:27960');
  });

  it('reconnects to the last server named, flag and all, and to none before one', async () => {
    const { cls, lines } = await rig();
    const { told, leave, found } = page();
    cls.reconnect(leave, found);
    expect(told).toEqual([]);
    expect(lines).toEqual([]);

    cls.connect(['connect', '-6', '203.0.113.9'], leave, found);
    cls.reconnect(leave, found);
    expect(told).toEqual([
      'leave 203.0.113.9: Server was killed',
      'found 203.0.113.9: null',
      'leave 203.0.113.9: Server was killed',
      'found 203.0.113.9: null'
    ]);
    expect(lines.filter((line) => line === 'Bad server address')).toHaveLength(2);
  });
});
