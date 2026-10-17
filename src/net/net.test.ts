import { describe, expect, it } from 'vitest';

import { GameConfig } from '../settings/game-config';
import {
  adrToString,
  adrToStringWithPort,
  compareAdr,
  compareBaseAdr,
  formatIPv6,
  isLANAddress,
  isOutOfBand,
  NA,
  Net,
  netadr,
  parseAdrWithPort,
  parseIPv4,
  parseIPv6,
  PORT_SERVER,
  stringToAdr
} from './net';
import { MemoryNetwork, testCvars } from './net-test-fixtures';

const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('an address', () => {
  it('is the loopback when it is localhost, with no port', () => {
    expect(stringToAdr('localhost')).toEqual(netadr(NA.LOOPBACK));
  });

  it('is on the server port unless it names another', () => {
    expect(stringToAdr('10.0.0.2')).toEqual(netadr(NA.IP, '10.0.0.2', PORT_SERVER));
    expect(stringToAdr('10.0.0.2:27961')).toEqual(netadr(NA.IP, '10.0.0.2', 27961));
  });

  it('names no host when there is none to name', () => {
    expect(stringToAdr('')).toBeNull();
    expect(stringToAdr(':27960')).toBeNull();
  });

  it('is written with its port only when asked', () => {
    const adr = netadr(NA.IP, '10.0.0.2', 27961);
    expect(adrToString(adr)).toBe('10.0.0.2');
    expect(adrToStringWithPort(adr)).toBe('10.0.0.2:27961');
    expect(adrToStringWithPort(netadr(NA.LOOPBACK))).toBe('loopback');
    expect(adrToString(netadr(NA.BOT))).toBe('bot');
  });

  it('is the same host whatever the port, and the same address only on the same port', () => {
    const a = netadr(NA.IP, '10.0.0.2', 27960);
    const b = netadr(NA.IP, '10.0.0.2', 27961);
    expect(compareBaseAdr(a, b)).toBe(true);
    expect(compareAdr(a, b)).toBe(false);
    expect(compareAdr(a, { ...a })).toBe(true);
    expect(compareBaseAdr(a, netadr(NA.IP, '10.0.0.3', 27960))).toBe(false);
  });

  it('is the same loopback as every other loopback', () => {
    expect(compareAdr(netadr(NA.LOOPBACK), netadr(NA.LOOPBACK))).toBe(true);
    expect(compareBaseAdr(netadr(NA.LOOPBACK), netadr(NA.IP, '127.0.0.1'))).toBe(false);
  });

  it('is on the LAN when it is the loopback or a private address, as `Sys_IsLANAddress` has it', () => {
    expect(isLANAddress(netadr(NA.LOOPBACK))).toBe(true);
    expect(isLANAddress(netadr(NA.BOT))).toBe(false);
    expect(isLANAddress(netadr(NA.IP, '10.0.0.1'))).toBe(true);
    expect(isLANAddress(netadr(NA.IP, '10.255.255.255'))).toBe(true);
    expect(isLANAddress(netadr(NA.IP, '172.16.0.1'))).toBe(true);
    expect(isLANAddress(netadr(NA.IP, '172.31.255.255'))).toBe(true);
    expect(isLANAddress(netadr(NA.IP, '172.32.0.1'))).toBe(false);
    expect(isLANAddress(netadr(NA.IP, '192.168.1.1'))).toBe(true);
    expect(isLANAddress(netadr(NA.IP, '192.169.1.1'))).toBe(false);
    expect(isLANAddress(netadr(NA.IP, '127.0.0.1'))).toBe(true);
    expect(isLANAddress(netadr(NA.IP, '198.51.100.2'))).toBe(false);
    expect(isLANAddress(netadr(NA.IP, '8.8.8.8'))).toBe(false);
    // An address the transport names by something other than a dotted quad is not on the LAN.
    expect(isLANAddress(netadr(NA.IP, 'peer-7'))).toBe(false);
  });
});

describe('an IPv6 address', () => {
  it('is bracketed when a port follows it, and has none when it is bare', () => {
    expect(stringToAdr('[2001:db8::7]:27961')).toEqual(netadr(NA.IP6, '2001:db8::7', 27961));
    expect(stringToAdr('[2001:db8::7]')).toEqual(netadr(NA.IP6, '2001:db8::7', PORT_SERVER));
    expect(stringToAdr('2001:db8::7')).toEqual(netadr(NA.IP6, '2001:db8::7', PORT_SERVER));
    expect(stringToAdr('::1')).toEqual(netadr(NA.IP6, '::1', PORT_SERVER));
    expect(stringToAdr('[::1]:')).toEqual(netadr(NA.IP6, '::1', 0));
    // One colon is a port's, as it is after an IPv4 address or a name.
    expect(stringToAdr('2001:3512')).toEqual(netadr(NA.IP, '2001', 3512));
  });

  it('is kept in one spelling, however it was typed', () => {
    expect(stringToAdr('[2001:0DB8:0:0:0:0:0:0007]:5')).toEqual(netadr(NA.IP6, '2001:db8::7', 5));
    expect(stringToAdr('[::FFFF:198.51.100.4]:5')).toEqual(
      netadr(NA.IP6, '::ffff:198.51.100.4', 5)
    );
  });

  it('leaves a name in brackets to be resolved, and names nothing when it is malformed', () => {
    expect(stringToAdr('[master.test]:27950')).toEqual(netadr(NA.IP, 'master.test', 27950));
    expect(stringToAdr('[1::2::3]:5')).toBeNull();
    expect(stringToAdr('[fe80::1%eth0]:5')).toBeNull();
    expect(stringToAdr('[]:5')).toBeNull();
  });

  it('is written in brackets with its port, and bare without', () => {
    const adr = netadr(NA.IP6, '2001:db8::7', 27961);
    expect(adrToString(adr)).toBe('2001:db8::7');
    expect(adrToStringWithPort(adr)).toBe('[2001:db8::7]:27961');
  });

  it('is read back from what it was written as, and nothing looser', () => {
    const v6 = netadr(NA.IP6, '2001:db8::7', 27961);
    const v4 = netadr(NA.IP, '203.0.113.9', 27960);
    for (const adr of [v6, v4]) expect(parseAdrWithPort(adrToStringWithPort(adr))).toEqual(adr);
    expect(parseAdrWithPort('[2001:DB8:0::7]:27961')).toEqual(v6);

    for (const text of [
      '2001:db8::7:27961',
      '[2001:db8::7]',
      '[2001:db8::7]:',
      '[2001:db8::7]:70000',
      '[not-v6]:1',
      '203.0.113.9',
      ':27960',
      '203.0.113.9:x'
    ]) {
      expect(parseAdrWithPort(text), text).toBeNull();
    }
  });

  it('is the same host whatever the port, and never the same as an IPv4 address', () => {
    const a = netadr(NA.IP6, '2001:db8::7', 27960);
    expect(compareBaseAdr(a, { ...a, port: 27961 })).toBe(true);
    expect(compareAdr(a, { ...a, port: 27961 })).toBe(false);
    expect(compareAdr(a, { ...a })).toBe(true);
    expect(compareBaseAdr(a, netadr(NA.IP6, '2001:db8::8', 27960))).toBe(false);
    expect(compareAdr(netadr(NA.IP6, '::ffff:10.0.0.2', 1), netadr(NA.IP, '10.0.0.2', 1))).toBe(
      false
    );
  });

  it('is on the LAN when link-local or unique local, as `Sys_IsLANAddress` has it', () => {
    const lan = (ip: string) => isLANAddress(netadr(NA.IP6, ip));
    expect(lan('fe80::1')).toBe(true);
    expect(lan('febf::1')).toBe(true);
    expect(lan('fec0::1')).toBe(false);
    expect(lan('fc00::1')).toBe(true);
    expect(lan('fdff::1')).toBe(true);
    expect(lan('fe00::1')).toBe(false);
    expect(lan('2001:db8::1')).toBe(false);
    // The loopback's IPv6 address is on the LAN only by the machine's own networks, which the
    // port cannot list.
    expect(lan('::1')).toBe(false);
  });
});

describe('inet_pton and inet_ntop', () => {
  /** An address read and written again, as the port keeps it. */
  const spelled = (text: string) => {
    const bytes = parseIPv6(text);
    return bytes === null ? null : formatIPv6(bytes);
  };

  it('read an IPv6 address to its sixteen bytes', () => {
    expect(parseIPv6('::')).toEqual(new Uint8Array(16));
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual(
      Uint8Array.of(0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8)
    );
    expect(parseIPv6('ABCD::1.2.3.4')).toEqual(
      Uint8Array.of(0xab, 0xcd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4)
    );
  });

  it('write one spelling: the leftmost longest run of zeros left out, lower case', () => {
    expect(spelled('0:0:0:0:0:0:0:0')).toBe('::');
    expect(spelled('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(spelled('1:0:0:0:0:0:0:0')).toBe('1::');
    expect(spelled('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    // A lone zero group stays, and of two runs the longer goes, or the first of two alike.
    expect(spelled('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
    expect(spelled('1:0:0:2:0:0:0:3')).toBe('1:0:0:2::3');
    expect(spelled('1:0:0:2:0:0:3:4')).toBe('1::2:0:0:3:4');
    expect(spelled('FE80::ABCD')).toBe('fe80::abcd');
  });

  it('write an IPv4 address mapped or compatible dotted, and nothing else', () => {
    expect(spelled('::ffff:c633:6404')).toBe('::ffff:198.51.100.4');
    expect(spelled('::c633:6404')).toBe('::198.51.100.4');
    expect(spelled('::1:ffff:c633:6404')).toBe('::1:ffff:c633:6404');
    expect(spelled('::2')).toBe('::2');
  });

  it('refuse what is not an address', () => {
    for (const text of [
      '',
      ':',
      ':::',
      '1::2::3',
      ':1::2',
      '1::2:',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7:8::',
      '1:2:3:4:5:6:7:8::9::0',
      '12345::',
      '::g',
      '1.2.3.4',
      '1.2.3.4::',
      '::1.2.3',
      '::1.2.3.4:5',
      'fe80::1%eth0'
    ]) {
      expect(parseIPv6(text), text).toBeNull();
    }
    expect(spelled('1:2:3:4:5:6:7::')).toBe('1:2:3:4:5:6:7:0');
  });

  it('read an IPv4 address as four bytes, none with a leading zero', () => {
    expect(parseIPv4('198.51.100.4')).toEqual(Uint8Array.of(198, 51, 100, 4));
    expect(parseIPv4('0.0.0.0')).toEqual(new Uint8Array(4));
    for (const text of ['1.2.3', '1.2.3.4.5', '256.0.0.1', '01.2.3.4', '1.2.3.x', '', '1..3.4']) {
      expect(parseIPv4(text), text).toBeNull();
    }
  });
});

describe('the net', () => {
  it("sends one half of the process's packets down the loopback to the other", () => {
    const net = new Net({ cvars: testCvars() });
    net.sendPacket('client', Uint8Array.of(1, 2), netadr(NA.LOOPBACK));

    expect(net.getLoopPacket('client')).toBeNull();
    expect(net.getLoopPacket('server')).toEqual({
      from: netadr(NA.LOOPBACK),
      data: Uint8Array.of(1, 2)
    });
  });

  it('sends everyone else through the socket, and reads what the socket has', () => {
    const network = new MemoryNetwork();
    const server = new Net({ cvars: testCvars(), socket: network.socket('10.0.0.1') });
    const client = new Net({ cvars: testCvars(), socket: network.socket('10.0.0.2:27961') });

    client.sendPacket('client', Uint8Array.of(9), stringToAdr('10.0.0.1')!);

    expect(server.getPacket()).toEqual({
      from: netadr(NA.IP, '10.0.0.2', 27961),
      data: Uint8Array.of(9)
    });
    expect(server.getPacket()).toBeNull();
  });

  it('sends nothing to a bot, or to an address that failed', () => {
    const network = new MemoryNetwork();
    const net = new Net({ cvars: testCvars(), socket: network.socket('10.0.0.1') });

    net.sendPacket('server', Uint8Array.of(1), netadr(NA.BOT));
    net.sendPacket('server', Uint8Array.of(1), netadr(NA.BAD));

    expect(network.sent).toEqual([]);
    expect(net.getLoopPacket('client')).toBeNull();
  });

  it('writes a line out of band behind four bytes of 0xFF', () => {
    const net = new Net({ cvars: testCvars() });
    net.outOfBandPrint('server', netadr(NA.LOOPBACK), 'disconnect');

    const { data } = net.getLoopPacket('client')!;
    expect(isOutOfBand(data)).toBe(true);
    expect(text(data.subarray(4))).toBe('disconnect');
  });

  it('draws a qport of 16 bits for its client, once', () => {
    const cvars = testCvars();
    const net = new Net({ cvars, random: () => 0.5 });

    expect(cvars.get('net_qport')).toBe('32768');
    expect(net.qport).toBe(32768);
    new Net({ cvars, random: () => 0.25 });
    expect(cvars.get('net_qport')).toBe('32768');
  });

  it('shows the out-of-band packets it sends when showpackets is on', () => {
    const lines: string[] = [];
    const net = new Net({ cvars: testCvars({ showpackets: '1' }), print: (l) => lines.push(l) });

    net.outOfBandPrint('client', netadr(NA.LOOPBACK), 'getinfo');
    net.sendPacket('client', Uint8Array.of(1, 0, 0, 0), netadr(NA.LOOPBACK));

    expect(lines).toEqual(['send packet   11']);
  });

  it('loses a packet the socket refuses, says why, and goes on', () => {
    const lines: string[] = [];
    const socket = {
      send: () => {
        throw new Error('DataChannel is closed');
      },
      receive: () => null
    };
    const net = new Net({ cvars: testCvars(), socket, print: (l) => lines.push(l) });

    const to = stringToAdr('10.0.0.2')!;
    expect(() => net.sendPacket('server', Uint8Array.of(1), to)).not.toThrow();
    expect(lines).toEqual(['Sys_SendPacket: DataChannel is closed\n']);
  });
});

describe('the latency knobs', () => {
  function clocked(values: Record<string, string>) {
    let now = 0;
    const cvars = testCvars(values);
    const net = new Net({ cvars, now: () => now, random: () => 0.5 });
    return { net, cvars, advance: (ms: number) => (now += ms) };
  }

  it('hold back what the client sends by cl_packetdelay, on the loopback too', () => {
    const { net, advance } = clocked({ cl_packetdelay: '100' });
    net.sendPacket('client', Uint8Array.of(1), netadr(NA.LOOPBACK));

    advance(100);
    net.flushPacketQueue();
    expect(net.getLoopPacket('server')).toBeNull();

    advance(1);
    net.flushPacketQueue();
    expect(net.getLoopPacket('server')?.data).toEqual(Uint8Array.of(1));
  });

  it('hold back what the server sends by sv_packetdelay, and leave the client alone', () => {
    const { net, advance } = clocked({ sv_packetdelay: '50' });
    net.sendPacket('server', Uint8Array.of(1), netadr(NA.LOOPBACK));
    net.sendPacket('client', Uint8Array.of(2), netadr(NA.LOOPBACK));

    expect(net.getLoopPacket('server')?.data).toEqual(Uint8Array.of(2));
    expect(net.getLoopPacket('client')).toBeNull();

    advance(51);
    net.flushPacketQueue();
    expect(net.getLoopPacket('client')?.data).toEqual(Uint8Array.of(1));
  });

  it('release packets in the order they were sent, a short delay waiting on a long one', () => {
    const { net, cvars, advance } = clocked({ cl_packetdelay: '100' });
    net.sendPacket('client', Uint8Array.of(1), netadr(NA.LOOPBACK));
    cvars.set('cl_packetdelay', '10');
    net.sendPacket('client', Uint8Array.of(2), netadr(NA.LOOPBACK));

    advance(50);
    net.flushPacketQueue();
    expect(net.getLoopPacket('server')).toBeNull();

    advance(51);
    net.flushPacketQueue();
    expect(net.getLoopPacket('server')?.data).toEqual(Uint8Array.of(1));
    expect(net.getLoopPacket('server')?.data).toEqual(Uint8Array.of(2));
  });

  it('hold nothing longer than 999 ms', () => {
    const { net, advance } = clocked({ cl_packetdelay: '5000' });
    net.sendPacket('client', Uint8Array.of(1), netadr(NA.LOOPBACK));

    advance(1000);
    net.flushPacketQueue();
    expect(net.getLoopPacket('server')).not.toBeNull();
  });

  it('copy what they hold, so the sender may reuse its buffer', () => {
    const { net, advance } = clocked({ cl_packetdelay: '10' });
    const buffer = Uint8Array.of(7);
    net.sendPacket('client', buffer, netadr(NA.LOOPBACK));
    buffer[0] = 0;

    advance(11);
    net.flushPacketQueue();
    expect(net.getLoopPacket('server')?.data).toEqual(Uint8Array.of(7));
  });

  it('lose the share of arriving packets net_dropsim says, on the loopback too', () => {
    const rolls = [0.2, 0.7, 0.4];
    const cvars = testCvars({ net_dropsim: '50', net_qport: '1' });
    const net = new Net({ cvars, random: () => rolls.shift()! });
    for (let i = 1; i <= 3; i++) net.sendPacket('client', Uint8Array.of(i), netadr(NA.LOOPBACK));

    const kept: number[] = [];
    for (let packet; (packet = net.getLoopPacket('server')) !== null; ) kept.push(packet.data[0]);
    expect(kept).toEqual([2]);
  });

  it('lose nothing when net_dropsim is out of its range', () => {
    const net = new Net({ cvars: testCvars({ net_dropsim: '101' }), random: () => 0 });
    net.sendPacket('client', Uint8Array.of(1), netadr(NA.LOOPBACK));
    expect(net.getLoopPacket('server')).not.toBeNull();
  });

  it('are registered, net_dropsim empty as NET_GetCvars has it, so the console sets each', () => {
    const config = new GameConfig({ debugMode: true, warn: () => {} });
    expect(config.command(['net_dropsim', '5'])).toBe(false);

    new Net({ cvars: config.cvars });
    const knobs = ['cl_packetdelay', 'sv_packetdelay', 'net_dropsim'];
    expect(knobs.map((name) => config.cvars.string(name))).toEqual(['0', '0', '']);
    expect(config.command(['net_dropsim', '5'])).toBe(true);
    expect(config.cvars.get('net_dropsim')).toBe('5');
    // A value it already holds is kept, as `Cvar_Get` keeps it.
    new Net({ cvars: config.cvars });
    expect(config.cvars.get('net_dropsim')).toBe('5');
  });
});
