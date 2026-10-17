import { CA, ClientConnection } from '../net/connection';
import type { CvarStore } from '../net/cvar';
import { compareAdr, Net, stringToAdr } from '../net/net';
import { MemoryNetwork, testCvars } from '../net/net-test-fixtures';
import { createNetUserCmd, type NetUserCmd } from '../net/protocol';
import { CS, Host, type HostOptions } from './host';

/**
 * A host's clients for tests, driven as the program drives its own: the packets each side has
 * been sent are handed over when a test says so, and not before.
 */

/**
 * The clock a fixture host's net reads, which a fixture moves: a message a client's rate is
 * pacing waits until this says its time has come.
 */
interface FixtureClock {
  now: () => number;
  advance: (msec: number) => void;
}

const fixtureClocks = new WeakMap<Net, FixtureClock>();

/**
 * The net a fixture's host runs on when a test gives it none: no socket until a remote client
 * needs one, and a clock the fixtures can move, so a rate-paced message drains.
 */
export function fixtureNet(cvars: CvarStore): Net {
  let now = 0;
  const clock: FixtureClock = {
    now: () => now,
    advance: (msec) => {
      now += msec;
    }
  };
  const net = new Net({ cvars, now: () => clock.now() });
  fixtureClocks.set(net, clock);
  return net;
}

/**
 * Let a host's net time follow a network's clock, so the frames a test runs and the clock the
 * host paces by are the same one.
 */
function shareNetworkClock(net: Net, network: MemoryNetwork): void {
  const clock = fixtureClocks.get(net);
  if (clock === undefined) return;
  clock.now = () => network.now;
  clock.advance = (msec) => network.advance(msec);
}

/**
 * Move the host's clock and send what a rate has been holding back, as `SV_SendQueuedMessages`
 * does with the wait between `Com_Frame`s.
 */
export function runQueued(host: Host, msec = 50): void {
  fixtureClocks.get(host.net)?.advance(msec);
  host.sendQueuedMessages();
}

/**
 * A host for a test, on a net the fixtures can move time on, so a message a client's rate paces
 * drains: the same as `new Host`, with the clock {@link runQueued} and {@link connectLocal} move.
 */
export function fixtureHost(options: HostOptions): Host {
  return new Host({ ...options, net: options.net ?? fixtureNet(options.cvars) });
}

/**
 * Connect the client in this process through the handshake, and give it everything the host sent
 * in answer: the `connectResponse`, then the gamestate its first packet asks for.
 *
 * @param connection - The client's end, for a test that reads what it is sent.
 * @returns the slot it was given
 */
export function connectLocal(
  host: Host,
  connection = new ClientConnection(testCvars()),
  userinfo = ''
): number {
  connection.userinfo = userinfo;
  connection.mapLoading(host.net);
  readPackets(host);
  drain(host, connection);
  connection.sendCmd(createNetUserCmd());
  readPackets(host);
  drain(host, connection);
  // A gamestate too long for one datagram goes in fragments, which the client's rate paces: give
  // the queue its time until the client has the whole thing.
  for (let round = 0; round < 100 && connection.state !== CA.PRIMED; round++) {
    runQueued(host);
    drain(host, connection);
  }
  if (connection.state !== CA.PRIMED) {
    throw new Error(`connectLocal: not primed: ${connection.serverMessage}`);
  }
  return connection.clientNum;
}

/** Where a host a test gave no socket of its own is, on the network its remote clients share. */
const HOST_ADDRESS = '10.0.0.1';

/** The network each host's made-up remote clients reach it over. */
const networks = new WeakMap<Host, MemoryNetwork>();

/** How many remote clients have been made up, which gives each an address of its own. */
let remotes = 0;

/**
 * Connect a client somewhere else through the handshake, and have its first packet ask for the
 * gamestate, which it is then left to never read.
 *
 * @param userinfo - What the client says of itself, as `Cvar_InfoString` builds one.
 * @param address - Where it is, when a test needs one of its own: a private address is a LAN
 *   client, which the rate rule tells apart.
 * @returns the slot it was given
 * @throws what the host refused it with
 */
export function connectRemote(host: Host, userinfo = '', address?: string): number {
  let network = networks.get(host);
  if (network === undefined) {
    if (host.net.socket !== null) throw new Error('connectRemote: the host has a network already');
    network = new MemoryNetwork();
    host.net.socket = network.socket(HOST_ADDRESS);
    networks.set(host, network);
    shareNetworkClock(host.net, network);
  }

  remotes++;
  const adr = address ?? `198.51.100.${remotes & 0xff}`;
  const clock = network;
  const cvars = testCvars({ net_qport: String(remotes & 0xffff) });
  const net = new Net({
    cvars,
    socket: network.socket(adr),
    now: () => clock.now,
    print: () => {}
  });
  const connection = new ClientConnection(cvars);
  connection.userinfo = userinfo;
  connection.connect(net, HOST_ADDRESS, stringToAdr(HOST_ADDRESS)!);

  // `getchallenge`, `challengeResponse`, `connect`, `connectResponse`, then the first packet, each
  // round a frame of the client's.
  for (let round = 0; round < 3 && connection.state < CA.CONNECTED; round++) {
    connection.clock.realtime += 100;
    connection.checkForResend();
    readPackets(host);
    for (let p; (p = net.getPacket()) !== null; ) connection.packetEvent(p.from, p.data);
  }
  if (connection.state < CA.CONNECTED) throw new Error(connection.serverMessage.trim());
  connection.sendCmd(createNetUserCmd());
  readPackets(host);

  const from = stringToAdr(adr)!;
  return host.clients.findIndex(
    (client) => client.state !== CS.FREE && compareAdr(client.netchan.remoteAddress, from)
  );
}

/**
 * Give the local client what the host has sent it, oldest first.
 *
 * @param limit - How many messages to hand over at most.
 * @returns how many were
 */
export function drain(host: Host, connection: ClientConnection, limit = Infinity): number {
  let count = 0;
  while (count < limit) {
    const packet = host.net.getLoopPacket('client');
    if (packet === null) break;
    if (connection.packetEvent(packet.from, packet.data)) count++;
  }
  return count;
}

/** Hand the host everything its clients have sent: `Com_EventLoop`, for the server. */
export function readPackets(host: Host): void {
  for (let packet; (packet = host.net.getPacket()) !== null; ) {
    host.packetEvent(packet.from, packet.data);
  }
  for (let packet; (packet = host.net.getLoopPacket('server')) !== null; ) {
    host.packetEvent(packet.from, packet.data);
  }
}

/**
 * One packet with these user commands, whatever the client's clock says: a test's own commands,
 * stamped as it likes. Before the gamestate the packet goes without them, as a client's does.
 */
export function sendCommands(connection: ClientConnection, cmds: readonly NetUserCmd[]): void {
  const primed = connection.state === CA.PRIMED || connection.state === CA.ACTIVE;
  connection.transmit(connection.writeMovePacket(primed ? cmds : []));
}

/** One packet of user commands from the local client, which the host reads at once. */
export function sendMove(host: Host, connection: ClientConnection, cmds: NetUserCmd[]): void {
  sendCommands(connection, cmds);
  readPackets(host);
}
