import { lookup } from 'node:dns/promises';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import { MasterServer, MAX_FRAME, type MasterServerOptions } from './master-server';

/**
 * The master on Node: a {@link MasterServer} on a WebSocket server of `ws`'s, looking names up as
 * Quake 3's client does, with `getaddrinfo` through Node's `dns.lookup`.
 */

/**
 * The master on a WebSocket server of `ws`'s, on both families where the machine has both: each
 * connection handed over with its IP and source port, and a frame past {@link MAX_FRAME} refused
 * by closing its socket before it is read.
 */
export function listen(master: MasterServer, port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port, maxPayload: MAX_FRAME });
    server.on('connection', (ws, request) => {
      // A frame past the limit, or any other fault, closes the socket, and the error is only the
      // reason why; unheard, Node would throw it.
      ws.on('error', () => {});
      const { remoteAddress, remotePort } = request.socket;
      if (remoteAddress === undefined || remotePort === undefined) ws.close();
      else master.connect(ws, remoteAddress, remotePort);
    });
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/** A master listening, for the program it runs in to drive. */
export interface RunningMaster {
  /** The port it listens on: the one asked for, or the system's pick for 0. */
  readonly port: number;
  /** Read what came down the channels the master dialled. */
  frame(): void;
  /** Stop listening, and close every connection. */
  close(): void;
}

/**
 * A master on a port, as its own program runs one and as a dedicated server runs one inside
 * itself: the same master either way.
 *
 * @throws what `listen` met, as a port already taken
 */
export async function startMaster(
  options: Omit<MasterServerOptions, 'lookup'> & { port: number }
): Promise<RunningMaster> {
  const print = options.print ?? console.log;
  const master = new MasterServer({
    ...options,
    lookup: (name) => lookup(name, { all: true }),
    print
  });
  let server: WebSocketServer;
  try {
    server = await listen(master, options.port);
  } catch (err) {
    master.close();
    throw err;
  }
  const { port } = server.address() as AddressInfo;
  print(`> Listening on port ${port}`);
  return {
    port,
    frame: () => master.frame(),
    close: () => {
      master.close();
      server.close();
    }
  };
}
