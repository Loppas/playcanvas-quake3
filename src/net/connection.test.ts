import { describe, expect, it } from 'vitest';

import { CA, ClientConnection, type ClientConnectionOptions } from './connection';
import { huffDecompress } from './huffman';
import { MAX_MSGLEN } from './msg';
import { isOutOfBand, NA, Net, netadr, stringToAdr } from './net';
import { MemoryNetwork, testCvars } from './net-test-fixtures';
import { createNetUserCmd } from './protocol';

/**
 * The client's half of the handshake, against a server the test speaks for: whatever the client
 * sends is read back as text, and the answers are written by hand.
 */
function rig(options: ClientConnectionOptions = {}) {
  const network = new MemoryNetwork();
  const now = () => network.now;
  const lines: string[] = [];
  const cvars = testCvars({ net_qport: '7' });
  const net = new Net({
    cvars,
    socket: network.socket('10.0.0.2'),
    now,
    print: (line) => lines.push(line)
  });
  const server = new Net({ cvars: testCvars(), socket: network.socket('10.0.0.1'), now });
  const proxy = new Net({ cvars: testCvars(), socket: network.socket('10.0.0.3'), now });
  const connection = new ClientConnection(cvars, options);
  connection.userinfo = '\\name\\Sarge';
  const client = stringToAdr('10.0.0.2')!;

  /** What the client has sent a server, each packet as text; a `connect` expanded. */
  const sent = (at = server): string[] => {
    const texts: string[] = [];
    for (let p; (p = at.getPacket()) !== null; ) {
      texts.push(isOutOfBand(p.data) ? outOfBand(p.data) : `sequenced ${p.data.length}`);
    }
    return texts;
  };
  /** An answer out of band, read by the client at once. */
  const reply = (text: string, from = server): void => {
    from.outOfBandPrint('server', client, text);
    for (let p; (p = net.getPacket()) !== null; ) connection.packetEvent(p.from, p.data);
  };
  /** Through the challenge, as the server at 10.0.0.1 would answer it. */
  const challenged = (challenge = 55): void => {
    connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
    connection.checkForResend();
    sent();
    reply(`challengeResponse ${challenge} ${connection.challenge} 2`);
  };
  /** Time passing for the client: the network's clock, and its own frames. */
  const elapse = (msec: number): void => {
    network.advance(msec);
    connection.clock.realtime += msec;
  };
  /** Through the whole handshake. */
  const connected = (): void => {
    challenged();
    connection.checkForResend();
    sent();
    reply('connectResponse 55');
  };
  return {
    network,
    net,
    cvars,
    lines,
    server,
    proxy,
    connection,
    sent,
    reply,
    challenged,
    connected,
    elapse
  };
}

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/** An out-of-band packet's text, a `connect`'s userinfo expanded as the server expands it. */
function outOfBand(data: Uint8Array): string {
  const connect = latin1(data.subarray(4, 11)) === 'connect';
  return latin1((connect ? huffDecompress(data, 12, MAX_MSGLEN) : data).subarray(4));
}

describe('ClientConnection: the handshake', () => {
  it("asks a server for a challenge, with its own number and the game's name", () => {
    const { net, connection, sent } = rig();
    connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
    connection.checkForResend();

    expect(connection.state).toBe(CA.CONNECTING);
    expect(sent()).toEqual([`getchallenge ${connection.challenge} PlayCanvasQuake`]);
  });

  it('asks again every three seconds, and no sooner, for as long as it takes', () => {
    const { network, net, connection, sent } = rig();
    connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
    connection.checkForResend();
    network.advance(2999);
    connection.checkForResend();
    expect(sent()).toHaveLength(1);

    network.advance(1);
    connection.checkForResend();
    expect(sent()).toHaveLength(1);
    expect(connection.connectPacketCount).toBe(2);
  });

  it('takes a challenge only with its own number on it, from whoever answers', () => {
    const { lines, proxy, connection, sent, reply, net } = rig();
    connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
    connection.checkForResend();
    sent();

    reply(`challengeResponse 55 ${connection.challenge + 1} 2`);
    expect(lines).toContain('Bad challenge for challengeResponse. Ignored.');
    expect(connection.state).toBe(CA.CONNECTING);

    reply(`challengeResponse 55 ${connection.challenge} 2`, proxy);
    expect(connection.state).toBe(CA.CHALLENGING);
    expect(connection.challenge).toBe(55);
    // The answer's sender is the server from here, and the connect goes there at once.
    connection.checkForResend();
    expect(sent(proxy)).toEqual(['connect "\\challenge\\55\\qport\\7\\protocol\\2\\name\\Sarge"']);
  });

  it('warns of a server on another protocol, and tries it anyway', () => {
    const { lines, connection, net, reply } = rig();
    connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
    reply(`challengeResponse 55 ${connection.challenge} 71`);
    expect(lines).toContain(
      '^3Warning: Server reports protocol version 71, we have 2. Trying anyways.'
    );
    expect(connection.state).toBe(CA.CHALLENGING);
  });

  it('sends its connect with the first twelve bytes plain and the userinfo compressed', () => {
    const { server, connection, challenged } = rig();
    challenged();
    connection.checkForResend();

    const packet = server.getPacket()!.data;
    expect(latin1(packet.subarray(4, 12))).toBe('connect ');
    expect(latin1(packet.subarray(12))).not.toContain('challenge');
  });

  it('is connected by its challenge coming back from its server, and by nothing else', () => {
    const { lines, proxy, connection, sent, reply, challenged } = rig();
    challenged();
    connection.checkForResend();
    sent();

    reply('connectResponse 55', proxy);
    reply('connectResponse');
    reply('connectResponse 54');
    expect(connection.state).toBe(CA.CHALLENGING);
    expect(lines).toEqual(
      expect.arrayContaining([
        'connectResponse from wrong address. Ignored.',
        'Bad connectResponse received. Ignored.',
        'ConnectResponse with bad challenge received. Ignored.'
      ])
    );

    reply('connectResponse 55');
    expect(connection.state).toBe(CA.CONNECTED);
    expect(connection.netchan?.remoteAddress).toEqual(stringToAdr('10.0.0.1'));
    expect(connection.netchan?.qport).toBe(7);

    reply('connectResponse 55');
    expect(lines).toContain('Dup connect received. Ignored.');
  });

  it('takes no connectResponse it did not ask for', () => {
    const { lines, connection, net, reply } = rig();
    connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
    reply('connectResponse 0');
    expect(connection.state).toBe(CA.CONNECTING);
    expect(lines).toContain('connectResponse packet while not connecting. Ignored.');
  });

  it("keeps a print from its server as the server's message, and one from elsewhere not", () => {
    const { lines, proxy, connection, reply, challenged } = rig();
    challenged();

    reply('print\nServer is full\n');
    reply('print\nspoofed\n', proxy);

    expect(connection.serverMessage).toBe('Server is full\n');
    expect(lines).toContain('Server is full');
    expect(lines).not.toContain('spoofed');
  });

  it('sends a packet a second until the gamestate comes, to ask for it', () => {
    const { connection, sent, connected, elapse } = rig();
    connected();
    // Frames enough for `cl_maxpackets`, which counts from the client's start as if from a packet.
    elapse(1000);
    const cmd = createNetUserCmd();

    connection.sendCmd(cmd);
    connection.sendCmd(cmd);
    elapse(999);
    connection.sendCmd(cmd);
    expect(sent()).toHaveLength(1);

    elapse(1);
    connection.sendCmd(cmd);
    expect(sent()).toHaveLength(1);
    // And none of them carried a command, with no world yet to move in.
    expect(connection.commands.cmdNumber).toBe(0);
  });

  it('leaves saying so three times, forgets the server, and connects again', () => {
    const { net, connection, sent, connected } = rig();
    connected();

    connection.disconnect();
    // The same message each time: the command, unacknowledged, and nothing else.
    const packets = sent();
    expect(packets).toHaveLength(3);
    expect(new Set(packets).size).toBe(1);
    expect(packets[0]).toMatch(/^sequenced/);
    expect(connection.state).toBe(CA.DISCONNECTED);
    expect(connection.netchan).toBeNull();
    expect(connection.servername).toBe('');

    connection.connect(net, '10.0.0.1', stringToAdr('10.0.0.1')!);
    connection.checkForResend();
    expect(connection.state).toBe(CA.CONNECTING);
    expect(sent()).toEqual([expect.stringMatching(/^getchallenge /)]);
  });
});

describe('ClientConnection: a silent server', () => {
  /** Run the timeout check `frames` times, as that many client frames would. */
  function check(connection: ClientConnection, frames: number): void {
    for (let i = 0; i < frames; i++) connection.checkTimeout();
  }

  it('gives a server 200 seconds', () => {
    const { cvars } = rig();
    expect(cvars.get('cl_timeout')).toBe('200');
  });

  it('leaves a server silent for cl_timeout, six frames after, saying so', () => {
    const { network, cvars, lines, connection, sent, connected } = rig();
    cvars.set('cl_timeout', '1');
    connected();

    network.advance(1000);
    check(connection, 10);
    expect(connection.state).toBe(CA.CONNECTED);

    network.advance(1);
    check(connection, 5);
    expect(connection.state).toBe(CA.CONNECTED);
    check(connection, 1);

    expect(connection.state).toBe(CA.DISCONNECTED);
    expect(lines.slice(-2)).toEqual(['', 'Server connection timed out.']);
    expect(sent()).toHaveLength(3);
  });

  it('is put off by any packet at all, whoever sent it', () => {
    const { network, proxy, cvars, connection, reply, connected } = rig();
    cvars.set('cl_timeout', '1');
    connected();

    network.advance(900);
    reply('print\nnot the server\n', proxy);
    network.advance(900);
    check(connection, 10);

    expect(connection.state).toBe(CA.CONNECTED);
  });

  it('starts the six frames again for a server heard from within them', () => {
    const { network, cvars, connection, reply, connected } = rig();
    cvars.set('cl_timeout', '1');
    connected();

    network.advance(1001);
    check(connection, 3);
    reply('print\nstill here\n');
    check(connection, 1);
    network.advance(1001);
    check(connection, 3);

    expect(connection.state).toBe(CA.CONNECTED);
  });

  it('never times out while the server has yet to take the connection', () => {
    const { network, cvars, connection, challenged } = rig();
    cvars.set('cl_timeout', '1');
    challenged();

    network.advance(5000);
    check(connection, 10);

    expect(connection.state).toBe(CA.CHALLENGING);
  });
});

describe('ClientConnection: the pause', () => {
  it('counts the frame cl_paused changed in as paused, as CL_CheckPaused does', () => {
    const { connection, cvars } = rig();
    expect(connection.checkPaused()).toBe(false);

    cvars.set('cl_paused', '1');
    expect(connection.checkPaused()).toBe(true);
    expect(connection.checkPaused()).toBe(true);

    cvars.set('cl_paused', '0');
    // The frame the change came in is still paused, so a client just back cannot leave its server
    // behind (`cl_parse.c:225–227`); a snapshot clears it (the program's own test pins that).
    expect(connection.checkPaused()).toBe(true);
  });

  it('is not timed out by a paused local server, as Q3 exempts it', () => {
    const { connection, cvars, connected, elapse } = rig();
    connected();
    cvars.set('cl_timeout', '1');
    cvars.set('sv_paused', '1');
    cvars.set('cl_paused', '1');

    elapse(2000);
    for (let i = 0; i < 10; i++) connection.checkTimeout();

    expect(connection.state).not.toBe(CA.DISCONNECTED);
  });

  it("takes the server's pause from the channel where it is given one, not its store", () => {
    // The store says nothing, as a page's does whose server is a worker's; the channel's word is
    // the one that exempts.
    const { connection, cvars, connected, elapse } = rig({ serverPaused: () => true });
    connected();
    cvars.set('cl_timeout', '1');
    cvars.set('cl_paused', '1');

    elapse(2000);
    for (let i = 0; i < 10; i++) connection.checkTimeout();

    expect(connection.state).not.toBe(CA.DISCONNECTED);
  });

  it('lets the channel override a store that says the server is paused', () => {
    const { connection, cvars, connected, elapse } = rig({ serverPaused: () => false });
    connected();
    cvars.set('cl_timeout', '1');
    cvars.set('cl_paused', '1');
    cvars.set('sv_paused', '1');

    elapse(2000);
    for (let i = 0; i < 10; i++) connection.checkTimeout();

    expect(connection.state).toBe(CA.DISCONNECTED);
  });
});

describe('ClientConnection: the server in this process', () => {
  /** A process's net, and the client's `connect` as the server half would read it. */
  function local() {
    const cvars = testCvars({ net_qport: '7' });
    const net = new Net({ cvars, now: () => 0 });
    const connection = new ClientConnection(cvars);
    const toServer = (): string[] => {
      const texts: string[] = [];
      for (let p; (p = net.getLoopPacket('server')) !== null; ) {
        texts.push(isOutOfBand(p.data) ? outOfBand(p.data) : 'sequenced');
      }
      return texts;
    };
    const accept = (): void => {
      net.outOfBandPrint('server', netadr(NA.LOOPBACK), 'connectResponse 0');
      for (let p; (p = net.getLoopPacket('client')) !== null; ) {
        connection.packetEvent(p.from, p.data);
      }
    };
    return { net, connection, toServer, accept };
  }

  it('sends its connect at once, with no challenge to ask for', () => {
    const { net, connection, toServer } = local();
    connection.mapLoading(net);

    expect(connection.state).toBe(CA.CHALLENGING);
    expect(connection.servername).toBe('localhost');
    expect(toServer()).toEqual(['connect "\\challenge\\0\\qport\\7\\protocol\\2"']);
  });

  it('stays connected over a map change, and asks for the new gamestate at once', () => {
    const { net, connection, toServer, accept } = local();
    connection.mapLoading(net);
    accept();
    connection.sendCmd(createNetUserCmd());
    const { netchan } = connection;
    toServer();

    connection.mapLoading(net);

    expect(connection.state).toBe(CA.CONNECTED);
    expect(connection.netchan).toBe(netchan);
    connection.sendCmd(createNetUserCmd());
    expect(toServer()).toEqual(['sequenced']);
  });

  it('writes every move packet into one message, cleared to its front', () => {
    const { net, connection, toServer, accept } = local();
    connection.mapLoading(net);
    accept();
    toServer();

    const first = connection.writeMovePacket([createNetUserCmd()]);
    const withACommand = first.curSize;
    const second = connection.writeMovePacket([]);

    expect(second).toBe(first);
    // A packet with no commands is the three-long header and no more. Written from the front of
    // the buffer, it is shorter than the packet before it and no longer than one written fresh;
    // the bits past its last are whatever the buffer held, as Quake 3's own are.
    expect(second.curSize).toBeLessThan(withACommand);
    const fresh = new ClientConnection(testCvars({ net_qport: '7' })).writeMovePacket([]);
    expect(second.curSize).toBeLessThanOrEqual(fresh.curSize);
  });
});

describe("ClientConnection: the answers that aren't a connect's", () => {
  it('hands them to the client that outlasts it, from whoever sent them', () => {
    const { lines, proxy, connection, reply } = rig();
    const handed: string[] = [];
    connection.onConnectionless = (from, data) => handed.push(`${from.ip} ${outOfBand(data)}`);

    // Not connected anywhere yet: a status or a list's answer is the page's client's even so.
    reply('statusResponse\n\\sv_hostname\\Arena\n');
    reply('infoResponse\n\\hostname\\Arena', proxy);
    reply('challengeResponse 1 2 2');
    reply('connectResponse 1');
    reply('print\nServer is full.\n');

    expect(handed).toEqual([
      '10.0.0.1 statusResponse\n\\sv_hostname\\Arena\n',
      '10.0.0.3 infoResponse\n\\hostname\\Arena'
    ]);
    expect(lines).toEqual([]);
  });

  it("takes a connect's answers itself", () => {
    const { lines, connection, reply, challenged } = rig();
    const handed: string[] = [];
    connection.onConnectionless = (_from, data) => handed.push(outOfBand(data));
    challenged();
    reply('print\nServer is full.\n');
    reply('connectResponse 55');

    expect(connection.state).toBe(CA.CONNECTED);
    expect(lines).toContain('Server is full.');
    expect(handed).toEqual([]);
  });
});
