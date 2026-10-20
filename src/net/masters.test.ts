import { describe, expect, it } from 'vitest';

import { ClientMasters, masterAt, MAX_RETRY_MSEC, RETRY_MSEC, ServerMasters } from './masters';
import { adrToStringWithPort, NA, netadr, type NetAdr } from './net';
import { testCvars } from './net-test-fixtures';
import { createPeerSocket } from './peer-signalling';
import { FakeMaster, FakeRtc, settle } from './peer-test-fixtures';

/** An out-of-band datagram. */
const oob = (text: string) =>
  Uint8Array.from([0xff, 0xff, 0xff, 0xff, ...new TextEncoder().encode(text)]);

/**
 * A server's masters at 203.0.113.9: the Internet's at master.test, the LAN's at lan.test and a
 * third at other.test, each in memory, on a clock the test moves.
 */
function rig(values: Record<string, string> = {}) {
  let time = 0;
  const cvars = testCvars({ sv_master1: 'master.test', sv_master2: 'lan.test', ...values });
  const fakes = new Map(
    ['master.test', 'lan.test', 'other.test'].map((host) => [host, new FakeMaster(host)])
  );
  const urls: string[] = [];
  const lines: string[] = [];
  const { socket, signalling } = createPeerSocket({
    links: [],
    createPeerConnection: new FakeRtc().create,
    dials: false
  });
  const masters = new ServerMasters({
    cvars,
    signalling,
    connect: (url) => {
      urls.push(url);
      const fake = fakes.get(new URL(url).hostname);
      if (fake === undefined) throw new Error(`no master at ${url}`);
      return fake.connect('203.0.113.9');
    },
    now: () => time,
    print: (line) => lines.push(line)
  });
  /** A frame at `at`, and whatever it set going landed. */
  const frame = async (at = time) => {
    time = at;
    masters.frame();
    await settle();
  };
  const master = (host: string) => fakes.get(host)!;
  /** Where a datagram for a master's address ends up. */
  const heartbeat = (to: NetAdr) => socket.send(oob('heartbeat DarkPlaces\n'), to);
  return { cvars, masters, master, urls, lines, frame, heartbeat };
}

describe('the master a slot names', () => {
  it('is on this machine for localhost, over ws:// on 27950 unless a port is given', () => {
    expect(masterAt('localhost')).toEqual({
      adr: netadr(NA.IP, 'localhost', 27950),
      url: 'ws://localhost:27950'
    });
    expect(masterAt('localhost:27951')).toEqual({
      adr: netadr(NA.IP, 'localhost', 27951),
      url: 'ws://localhost:27951'
    });
  });

  it('is reached over ws:// at a loopback or private address, which has no certificate', () => {
    expect(masterAt('127.0.0.1')?.url).toBe('ws://127.0.0.1:27950');
    expect(masterAt('192.168.1.5')?.url).toBe('ws://192.168.1.5:27950');
    expect(masterAt('10.0.0.7:9000')?.url).toBe('ws://10.0.0.7:9000');
    expect(masterAt('172.20.0.1')?.url).toBe('ws://172.20.0.1:27950');
    expect(masterAt('::1')).toEqual({ adr: netadr(NA.IP6, '::1', 27950), url: 'ws://[::1]:27950' });
    expect(masterAt('[fd00::5]:27951')).toEqual({
      adr: netadr(NA.IP6, 'fd00::5', 27951),
      url: 'ws://[fd00::5]:27951'
    });
  });

  it('is reached over wss:// by a name or a public address', () => {
    expect(masterAt('master.example.com')).toEqual({
      adr: netadr(NA.IP, 'master.example.com', 27950),
      url: 'wss://master.example.com:27950'
    });
    expect(masterAt('203.0.113.9')?.url).toBe('wss://203.0.113.9:27950');
    expect(masterAt('[2001:db8::9]')?.url).toBe('wss://[2001:db8::9]:27950');
  });

  it('is a ws:// or wss:// URL as given, named by its host and port', () => {
    expect(masterAt('wss://master.example.com/q3')).toEqual({
      adr: netadr(NA.IP, 'master.example.com', 443),
      url: 'wss://master.example.com/q3'
    });
    expect(masterAt('ws://192.168.1.5:9000')).toEqual({
      adr: netadr(NA.IP, '192.168.1.5', 9000),
      url: 'ws://192.168.1.5:9000'
    });
    expect(masterAt('ws://lan-box')?.adr).toEqual(netadr(NA.IP, 'lan-box', 80));
    expect(masterAt('WSS://[2001:DB8::9]:5')?.adr).toEqual(netadr(NA.IP6, '2001:db8::9', 5));
  });

  it('is none for an empty slot, or one that names nothing', () => {
    expect(masterAt('')).toBeNull();
    expect(masterAt(':27950')).toBeNull();
    expect(masterAt('ws://')).toBeNull();
    expect(masterAt('[1::2::3]')).toBeNull();
  });
});

describe("a server's masters", () => {
  it('connect to each master the slots name, and register net_port there', async () => {
    const { master, urls, lines, frame } = rig({ net_port: '27961' });
    await frame();

    expect(urls).toEqual(['wss://master.test:27950', 'wss://lan.test:27950']);
    expect(master('master.test').read('register')).toEqual([{ kind: 'register', port: 27961 }]);
    expect(master('lan.test').read('register')).toEqual([{ kind: 'register', port: 27961 }]);
    expect(lines).toEqual([
      'Registered with master.test as 203.0.113.9:27961',
      'Registered with lan.test as 203.0.113.9:27961'
    ]);
  });

  it("register Q3's 27960 when net_port has no value", async () => {
    const { master, frame } = rig();
    await frame();
    expect(master('master.test').read('register')).toEqual([{ kind: 'register', port: 27960 }]);
  });

  it('share one connection between two slots that name one master', async () => {
    const { master, urls, frame } = rig({ sv_master2: 'master.test:27950' });
    await frame();
    expect(urls).toEqual(['wss://master.test:27950']);
    expect(master('master.test').read('register')).toHaveLength(1);
  });

  it('open nothing for an empty slot', async () => {
    const { urls, frame } = rig({ sv_master1: '', sv_master2: '' });
    await frame();
    expect(urls).toEqual([]);
  });

  it("carry a datagram for a master down that master's own connection", async () => {
    const { master, frame, heartbeat } = rig();
    await frame();
    heartbeat(master('master.test').adr);
    await settle();
    expect(master('master.test').datagrams).toHaveLength(1);
    expect(master('lan.test').datagrams).toHaveLength(0);
  });

  it('follow a changed slot at the next frame, letting the old master go', async () => {
    const { cvars, master, urls, frame, heartbeat } = rig();
    await frame();

    cvars.set('sv_master2', 'other.test');
    await frame();

    expect(urls).toEqual([
      'wss://master.test:27950',
      'wss://lan.test:27950',
      'wss://other.test:27950'
    ]);
    heartbeat(master('lan.test').adr);
    heartbeat(master('other.test').adr);
    await settle();
    expect(master('lan.test').datagrams).toHaveLength(0);
    expect(master('other.test').datagrams).toHaveLength(1);
    // The Internet's master was named all along, and kept its one connection.
    expect(master('master.test').read('register')).toHaveLength(1);
  });

  it('try a master that refuses again 3 s later, the wait doubling up to 300 s', async () => {
    const { master, urls, frame } = rig({ sv_master2: '' });
    master('master.test').up = false;
    const tries: number[] = [];
    for (let at = 0; at <= 1000000; at += 1000) {
      const before = urls.length;
      await frame(at);
      if (urls.length > before) tries.push(at);
    }
    expect([RETRY_MSEC, MAX_RETRY_MSEC]).toEqual([3000, 300000]);
    expect(tries).toEqual([0, 3000, 9000, 21000, 45000, 93000, 189000, 381000, 681000, 981000]);
  });

  it('connect again 3 s after a master restarts, and register again', async () => {
    const { master, urls, lines, frame } = rig({ sv_master2: '' });
    master('master.test').up = false;
    // A few refusals first, which the connection that opens puts behind it.
    for (const at of [0, 3000, 9000, 21000]) await frame(at);
    master('master.test').up = true;
    await frame(45000);
    expect(master('master.test').read('register')).toHaveLength(1);

    master('master.test').restart();
    await frame(50000);
    await frame(52999);
    expect(urls).toHaveLength(5);
    await frame(53000);
    expect(urls).toHaveLength(6);
    expect(master('master.test').read('register')).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith('Registered'))).toHaveLength(2);
  });

  it('tell the server of each registration a master grants, on every connection', async () => {
    const { masters, master, frame } = rig();
    let registered = 0;
    masters.onRegistered = () => registered++;
    await frame(0);
    expect(registered).toBe(2);

    master('master.test').restart();
    await frame(1000);
    expect(registered).toBe(2);
    await frame(4000);
    expect(registered).toBe(3);
  });

  it('read net_port as each connection opens', async () => {
    const { cvars, master, frame } = rig({ sv_master2: '', net_port: '27960' });
    await frame(0);
    cvars.set('net_port', '27970');
    master('master.test').restart();
    await frame(1000);
    await frame(4000);
    expect(master('master.test').read('register').map(({ port }) => port)).toEqual([27960, 27970]);
  });

  it('say once that a master cannot be reached at all, and go on trying it', async () => {
    const { urls, lines, frame } = rig({ sv_master1: 'nowhere.test', sv_master2: '' });
    await frame(0);
    await frame(1000);
    expect(urls).toHaveLength(1);
    await frame(3000);
    expect(urls).toEqual(['wss://nowhere.test:27950', 'wss://nowhere.test:27950']);
    expect(lines).toEqual([
      "WARNING: can't reach the master at nowhere.test: no master at wss://nowhere.test:27950"
    ]);
  });

  it('tell the signalling of each master named, and of each let go', async () => {
    const cvars = testCvars({ sv_master1: 'master.test', sv_master2: 'lan.test' });
    const fake = new FakeMaster('master.test');
    const told: string[] = [];
    const masters = new ServerMasters({
      cvars,
      signalling: {
        addLink: (link) => told.push(`+${adrToStringWithPort(link.master)}`),
        removeLink: (link) => told.push(`-${adrToStringWithPort(link.master)}`)
      },
      connect: () => fake.connect('203.0.113.9'),
      now: () => 0,
      print: () => {}
    });
    masters.frame();
    cvars.set('sv_master2', '');
    masters.frame();
    masters.close();
    expect(told).toEqual([
      '+master.test:27950',
      '+lan.test:27950',
      '-lan.test:27950',
      '-master.test:27950'
    ]);
  });

  it('close every connection as the server goes', async () => {
    const { masters, master, frame, heartbeat } = rig();
    await frame();
    masters.close();
    heartbeat(master('master.test').adr);
    await settle();
    expect(master('master.test').datagrams).toHaveLength(0);
    expect(master('lan.test').datagrams).toHaveLength(0);
  });
});

/**
 * A client's masters at 198.51.100.4, over the same three masters in memory: its socket dials,
 * and what it sends is followed by what landed.
 */
function clientRig(values: Record<string, string> = {}) {
  const cvars = testCvars({ sv_master1: 'master.test', sv_master2: 'lan.test', ...values });
  const fakes = new Map(
    ['master.test', 'lan.test', 'other.test'].map((host) => [host, new FakeMaster(host)])
  );
  const urls: string[] = [];
  const lines: string[] = [];
  const { socket, signalling } = createPeerSocket({
    links: [],
    createPeerConnection: new FakeRtc().create,
    dials: true
  });
  const masters = new ClientMasters({
    cvars,
    signalling,
    connect: (url) => {
      urls.push(url);
      const fake = fakes.get(new URL(url).hostname);
      if (fake === undefined) throw new Error(`no master at ${url}`);
      return fake.connect('198.51.100.4');
    },
    print: (line) => lines.push(line)
  });
  const master = (host: string) => fakes.get(host)!;
  /** A datagram as a command sends one: the slots read first. */
  const send = async (text: string, to: NetAdr) => {
    masters.follow();
    socket.send(oob(text), to);
    await settle();
  };
  const server = netadr(NA.IP, '203.0.113.9', 27960);
  return { cvars, masters, master, urls, lines, send, server };
}

describe("a client's masters", () => {
  it('open nothing until something is sent through one', async () => {
    const { masters, urls } = clientRig();
    masters.follow();
    await settle();
    expect(urls).toEqual([]);
  });

  it('open only the master a datagram is for, and never register there', async () => {
    const { master, urls, send } = clientRig();
    await send('getserversExt PlayCanvasQuake 1', master('master.test').adr);

    expect(urls).toEqual(['wss://master.test:27950']);
    // Sent while the connection opened, and held for it.
    expect(master('master.test').datagrams).toHaveLength(1);
    expect(master('master.test').read('register')).toEqual([]);
  });

  it('open every master for a query they relay, and share one between two slots', async () => {
    const both = clientRig();
    await both.send('getinfo xxx', both.server);
    expect(both.urls).toEqual(['wss://master.test:27950', 'wss://lan.test:27950']);
    expect(both.master('master.test').read('relay')).toHaveLength(1);
    expect(both.master('lan.test').read('relay')).toHaveLength(1);

    const one = clientRig({ sv_master2: 'master.test:27950' });
    await one.send('getinfo xxx', one.server);
    expect(one.urls).toEqual(['wss://master.test:27950']);
  });

  it("open every master for a dial's signals", async () => {
    const { master, urls, send, server } = clientRig();
    await send('getchallenge 1 PlayCanvasQuake', server);
    expect(urls).toEqual(['wss://master.test:27950', 'wss://lan.test:27950']);
    expect(master('master.test').read('signal')).not.toEqual([]);
    expect(master('lan.test').read('signal')).not.toEqual([]);
  });

  it('try a master that refused again with the next thing sent it, at once', async () => {
    const { master, urls, send } = clientRig({ sv_master2: '' });
    master('master.test').up = false;
    await send('getserversExt PlayCanvasQuake 1', master('master.test').adr);
    await send('getserversExt PlayCanvasQuake 1', master('master.test').adr);
    expect(urls).toHaveLength(2);

    master('master.test').up = true;
    await send('getserversExt PlayCanvasQuake 1', master('master.test').adr);
    expect(urls).toHaveLength(3);
    expect(master('master.test').datagrams).toHaveLength(1);
  });

  it('open a master that was lost again with the next thing sent it', async () => {
    const { master, urls, send } = clientRig({ sv_master2: '' });
    await send('getserversExt PlayCanvasQuake 1', master('master.test').adr);
    master('master.test').restart();
    await settle();
    await send('getserversExt PlayCanvasQuake 1', master('master.test').adr);
    expect(urls).toHaveLength(2);
    expect(master('master.test').datagrams).toHaveLength(2);
  });

  it('follow a changed slot as the next command reads it, letting the old master go', async () => {
    const { cvars, master, urls, send, server } = clientRig();
    await send('getinfo xxx', server);
    cvars.set('sv_master2', 'other.test');
    await send('getinfo xxx', server);

    expect(urls).toEqual([
      'wss://master.test:27950',
      'wss://lan.test:27950',
      'wss://other.test:27950'
    ]);
    expect(master('lan.test').read('relay')).toHaveLength(1);
    expect(master('other.test').read('relay')).toHaveLength(1);
    expect(master('master.test').read('relay')).toHaveLength(2);
  });

  it('say once that a master cannot be reached at all, and try it with each send', async () => {
    const { lines, urls, send, server } = clientRig({ sv_master1: 'nowhere.test', sv_master2: '' });
    await send('getinfo xxx', server);
    await send('getinfo xxx', server);
    expect(urls).toEqual(['wss://nowhere.test:27950', 'wss://nowhere.test:27950']);
    expect(lines).toEqual([
      "WARNING: can't reach the master at nowhere.test: no master at wss://nowhere.test:27950"
    ]);
  });

  it('tell of a connection closed, and whether it had opened first', async () => {
    const { masters, master, send, server } = clientRig({ sv_master1: 'nowhere.test' });
    const closed: string[] = [];
    masters.onClosed = (adr, opened) => closed.push(`${adr.ip} ${opened}`);
    master('lan.test').up = false;
    await send('getinfo xxx', server);
    expect(closed).toEqual(['nowhere.test false', 'lan.test false']);

    master('lan.test').up = true;
    await send('getinfo xxx', server);
    master('lan.test').restart();
    await settle();
    expect(closed.slice(2)).toEqual(['nowhere.test false', 'lan.test true']);
  });

  it('ask a name of every master the slots name, and hand on each answer', async () => {
    const { masters, master, urls } = clientRig();
    master('master.test').names.set('quake.test', ['203.0.113.9', '2001:db8::9']);
    const answers: string[] = [];
    masters.onResolved = (adr, { name, port, addresses, error }) => {
      const found = addresses.map(adrToStringWithPort).join(' ');
      answers.push(`${adr.ip}: ${name} ${port} [${found}] ${error}`);
    };
    masters.follow();
    expect(masters.named()).toEqual([master('master.test').adr, master('lan.test').adr]);

    masters.resolve('quake.test', 27961);
    await settle();
    expect(urls).toEqual(['wss://master.test:27950', 'wss://lan.test:27950']);
    expect(answers).toEqual([
      'master.test: quake.test 27961 [203.0.113.9:27961 [2001:db8::9]:27961] null',
      'lan.test: quake.test 27961 [] ENOTFOUND'
    ]);
  });

  it('close every connection as the page goes', async () => {
    const { masters, master, send, server } = clientRig();
    await send('getinfo xxx', server);
    masters.close();
    await send('getinfo xxx', server);
    expect(master('master.test').read('relay')).toHaveLength(1);
    expect(master('lan.test').read('relay')).toHaveLength(1);
  });
});
