import nodeDataChannel from 'node-datachannel';
import { RTCPeerConnection } from 'node-datachannel/polyfill';

import { PORT_MASTER } from '../src/net/net';
import { startMaster } from './node-master';

/**
 * The master, as a Node program: dpmaster for the port.
 *
 * ```
 * npm run master
 * ```
 *
 * It listens for WebSockets on {@link PORT_MASTER}, on both families where the machine has both,
 * and dials servers through node-datachannel, which stays outside the bundle with its native
 * code. It reads its own socket every {@link FRAME_MSEC}; everything else it does as a frame
 * arrives, as dpmaster does as a datagram arrives.
 */

/** How often the master reads what came down the channels it dialled. */
const FRAME_MSEC = 50;

const print = (line: string) => console.log(line);

try {
  const master = await startMaster({
    createPeerConnection: (iceServers) => new RTCPeerConnection({ iceServers }),
    print,
    port: PORT_MASTER
  });
  const loop = setInterval(() => master.frame(), FRAME_MSEC);
  process.on('SIGINT', () => {
    clearInterval(loop);
    master.close();
    // node-datachannel holds the process open until its threads are let go.
    nodeDataChannel.cleanup();
    process.exit(0);
  });
} catch (err) {
  print(`> ERROR: ${err instanceof Error ? err.message : err}`);
  nodeDataChannel.cleanup();
  process.exitCode = 1;
}
