import type { Net } from '../net/net';
import type { HostMap } from './host';
import { ServerProgram, type ServerProgramOptions } from './program';

/**
 * The client's end of the server: everything a client needs of the program, wherever it runs.
 *
 * A listen server's program runs in a worker and the tests' in the same process, and the
 * client is the same code either way. What crosses is the packets (the wire), and the side
 * channels a shared process would read in place: the console's host commands, the pause,
 * `sv_running` and the map asks.
 */
export interface HostChannel {
  /**
   * The program, where it runs in this process — the direct implementation's, which is also the
   * tests'. A channel to a worker's has none, and the client reads the mirrors instead.
   */
  readonly program: ServerProgram | null;
  /** The client's end of the wire. In this process it is the server's own net, the loopback. */
  readonly net: Net;
  /** Read the server's end of the wire: its socket and the loopback's server side. */
  readPackets(): void;
  /** Run the server's frame for `msec` of real time. A worker's runs its own; this is a no-op. */
  pump(msec: number): void;
  /** `Cbuf` on the server's machine: a console line for its next frame. */
  sendCommand(line: string): void;
  /** Whether the server has commands it has not run yet, which a `map` waits behind. */
  readonly commandsPending: boolean;
  /** `sv_paused`: whether the server is holding its world. */
  readonly svPaused: boolean;
  /** `sv_running`: whether a map is running. */
  readonly svRunning: boolean;
  /** The map the server is reading, or null. The client's frames wait for it. */
  readonly mapLoad: Promise<void> | null;
  /** What stopped the server, a load that failed or a frame that threw, or null. */
  readonly failure: Error | null;
  /** Take a listener for the start of a server map load, which is the client's `CL_MapLoading`. */
  onMapLoad(listener: () => void): void;
  /**
   * `SV_Shutdown`: the clients and the masters are told why, and the server stops, which
   * `sv_running` says.
   *
   * @param finalMessage - Why, in Quake 3's words for whatever stopped it.
   * @param error - Whether `Com_Error` is shutting it down, which tells the clients nothing.
   */
  shutdown(finalMessage: string, error?: boolean): void;
}

/**
 * Whether what a caller holds is a channel to a program elsewhere rather than the first map of
 * one in this process: the two a `LocalGame` may be given.
 */
export function isHostChannel(server: HostMap | HostChannel): server is HostChannel {
  return 'net' in server;
}

/**
 * No server in this page: the channel of a client whose server is elsewhere, reached through the
 * page's own way out. There is no program to run or to give a command to, and nothing of a
 * server's to mirror, so none is running here (`com_sv_running` 0).
 */
export class RemoteChannel implements HostChannel {
  readonly program = null;
  readonly net: Net;
  readonly commandsPending = false;
  readonly svPaused = false;
  readonly svRunning = false;
  readonly mapLoad = null;
  readonly failure = null;

  /** @param net - The page's own way out: its socket, which reaches the server. */
  constructor(net: Net) {
    this.net = net;
  }

  readPackets(): void {}

  pump(): void {}

  sendCommand(): void {}

  onMapLoad(): void {}

  shutdown(): void {}
}

/**
 * A server whose program runs in this process: the tests' arrangement, and a page's when nothing
 * leaves it. The client shares the program's `Net`, so the wire between them is the loopback.
 */
export class InProcessHost implements HostChannel {
  readonly program: ServerProgram;

  constructor(options: ServerProgramOptions) {
    this.program = new ServerProgram(options);
  }

  get net(): Net {
    return this.program.host.net;
  }

  readPackets(): void {
    this.program.readPackets();
  }

  pump(msec: number): void {
    this.program.runFrame(msec);
  }

  sendCommand(line: string): void {
    this.program.sendConsoleCommand(line);
  }

  get commandsPending(): boolean {
    return this.program.commandsPending;
  }

  get svPaused(): boolean {
    return this.program.svPaused;
  }

  get svRunning(): boolean {
    return this.program.svRunning;
  }

  get mapLoad(): Promise<void> | null {
    return this.program.mapLoad;
  }

  get failure(): Error | null {
    return this.program.failure;
  }

  onMapLoad(listener: () => void): void {
    this.program.onMapLoad = listener;
  }

  shutdown(finalMessage: string, error = false): void {
    this.program.shutdown(finalMessage, error);
  }
}
