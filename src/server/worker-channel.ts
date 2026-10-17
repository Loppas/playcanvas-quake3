import type { InfoFile } from '../formats/arena';
import { MessageLoopback } from '../net/loopback';
import { Net } from '../net/net';
import type { Cvars } from '../settings/cvars';
import type { HostChannel } from './channel';
import { hostMapTransfer, type HostMapData } from './host-map';
import { HostPeers, type HostPeersOptions } from './host-peers';
import type { DevRequest, DevState, PageToWorker, WorkerToPage } from './worker-messages';

/**
 * The page's end of the channel to a worker's server program: the client plays over
 * the messages exactly as it plays over the loopback, and what the one store carried — the pause,
 * `sv_running`, the map asks, the console's lines — is mirrored across.
 *
 * The program is not here, so {@link program} is null and the client reads the mirrors: the state
 * the worker last sent, the map load it is in, and the failure that stopped it.
 */

/** The little of a `Worker` a channel needs, so that a test can stand in for one. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  /** Hear what the worker sends back. */
  onMessage(listener: (message: unknown) => void): void;
}

/** Where the worker finds maps: the page's search path, which does the reading. */
export interface MapFiles {
  /** Every map the search path has, as `map <n>` takes them. */
  names(): readonly string[];
  /** Read a map's files for the worker. A rejection is the load's failure. */
  read(name: string): Promise<HostMapData>;
}

export interface WorkerChannelOptions {
  /**
   * The page's store: the worker's is given its values whole, and every change after, and
   * this holds what the worker's store sets itself.
   */
  cvars: Cvars;
  /** Where the worker's `map <n>` asks are answered. */
  maps: MapFiles;
  /** The boot: the first map, the bot files and the build's mode. */
  boot: { map: HostMapData; botFiles: readonly InfoFile[]; debugMode: boolean };
  /** The server's console lines, for the page's console. */
  print?: (text: string) => void;
  /** `Sys_Milliseconds` for the client's own net, which a test drives; the page's real time. */
  now?: () => number;
  /** The worker itself. The page's own is built from `server/worker.ts` unless one is given. */
  worker?: WorkerLike;
  /**
   * How the server reaches players elsewhere: the page's peer connections and WebSockets, opened
   * once the worker says it can take a channel. Without them the server is its own client's alone.
   */
  peers?: Pick<HostPeersOptions, 'createPeerConnection' | 'connect' | 'locks' | 'schedule'>;
}

export class WorkerChannel implements HostChannel {
  /** The program is elsewhere: the client reads the mirrors, not this. */
  readonly program = null;
  /** The client's end of the wire, whose loopback crosses as messages. */
  readonly net: Net;

  /** The map the server is reading, or null, as the worker has told it. */
  mapLoad: Promise<void> | null = null;
  /** What stopped the server, a load that failed or a frame that threw, or null. */
  failure: Error | null = null;
  /**
   * Settles once the worker has built its program and read the map (`ready`), before it reads a
   * packet. The page waits on it so the client's first `connect` is answered at once rather than
   * retransmitted into a `loopback:reconnect` while the program is still being built.
   */
  readonly ready: Promise<void>;
  private readyDone: (() => void) | null = null;

  private readonly worker: WorkerLike;
  private readonly loopback = new MessageLoopback((data, transfer) =>
    this.post({ type: 'packet', data }, transfer)
  );
  private readonly printLine: (text: string) => void;
  private readonly maps: MapFiles;
  private readonly stopCvarChange: () => void;
  private readonly cvars: Cvars;
  /** While the store takes a cvar the worker's set, which is the worker's already. */
  private mirroring = false;
  private readonly now: () => number;
  private readonly peersOptions: WorkerChannelOptions['peers'];
  /** The server's peers and masters, once the worker is ready for them. */
  private peers: HostPeers | null = null;
  /** The state the worker last sent, which the getters hand to the client. */
  private paused = false;
  private running = false;
  private pending = false;
  /** How the map-load promise is settled when the load ends. */
  private mapLoadDone: (() => void) | null = null;
  /** The listeners `CL_MapLoading` comes to, as the load starts. */
  private readonly loadListeners = new Set<() => void>();
  /** The asks live checks have out, by the id they went under, and the next id. */
  private readonly devWaits = new Map<number, (state: DevState) => void>();
  private nextDev = 1;

  constructor(options: WorkerChannelOptions) {
    const { cvars } = options;
    this.cvars = cvars;
    this.now = options.now ?? (() => performance.now());
    this.peersOptions = options.peers;
    this.maps = options.maps;
    this.printLine = options.print ?? (() => {});
    this.ready = new Promise<void>((resolve) => {
      this.readyDone = resolve;
    });
    this.worker = options.worker ?? hostWorker();
    this.worker.onMessage((message) => this.receive(message as WorkerToPage));
    this.net = new Net({ cvars, loopback: this.loopback, now: options.now });
    this.worker.postMessage(
      {
        type: 'boot',
        cvars: cvars.all(),
        map: options.boot.map,
        mapNames: [...this.maps.names()],
        botFiles: options.boot.botFiles,
        debugMode: options.boot.debugMode
      },
      // The map's bytes move rather than copy: the page read them for the worker and keeps none
      // of them.
      hostMapTransfer(options.boot.map)
    );
    // Every change the page makes to its store crosses, so what a `set` or a menu writes reaches
    // the server that reads it. What the worker's store set comes back, and stays.
    this.stopCvarChange = cvars.onCvarChange((name, value) => {
      if (!this.mirroring) this.post({ type: 'cvar', name, value });
    });
  }

  /** Nothing to read: the worker's packets arrive as messages, and are delivered then. */
  readPackets(): void {}

  /** Nothing to run: the worker runs its own frames. */
  pump(_msec: number): void {}

  sendCommand(line: string): void {
    this.post({ type: 'command', line });
  }

  get commandsPending(): boolean {
    return this.pending;
  }

  get svPaused(): boolean {
    return this.paused;
  }

  get svRunning(): boolean {
    return this.running;
  }

  onMapLoad(listener: () => void): void {
    this.loadListeners.add(listener);
  }

  shutdown(finalMessage: string, error = false): void {
    this.post({ type: 'shutdown', finalMessage, error });
    this.stopCvarChange();
  }

  /**
   * Ask the worker's program for its own state, or move a cvar where it reads it. The live
   * checks' handle, and DEV only: a built page carries no route to it and answers null here.
   */
  dev(request: DevRequest): Promise<DevState> | null {
    if (!import.meta.env.DEV) return null;
    const id = this.nextDev++;
    this.post({ type: 'dev', id, request });
    return new Promise((resolve) => this.devWaits.set(id, resolve));
  }

  /** One message from the worker: the wire, the mirrors, the console's words, a map ask. */
  private receive(message: WorkerToPage): void {
    switch (message.type) {
      case 'packet':
        this.loopback.deliver(message.data);
        break;
      case 'state':
        this.paused = message.svPaused;
        this.running = message.svRunning;
        this.pending = message.commandsPending;
        break;
      case 'mapLoad':
        this.setMapLoad(message.loading);
        break;
      case 'failure':
        this.failure = new Error(message.message);
        break;
      case 'print':
        this.printLine(message.text);
        break;
      case 'cvar':
        this.mirror(message.name, message.value);
        break;
      case 'readMap':
        void this.answerRead(message.id, message.name);
        break;
      case 'devResult': {
        const waiting = this.devWaits.get(message.id);
        this.devWaits.delete(message.id);
        waiting?.(message.state);
        break;
      }
      case 'ready':
        this.readyDone?.();
        this.readyDone = null;
        this.openPeers(message.channels);
        break;
      case 'route':
        this.peers?.route(message.data, message.to);
        break;
      case 'hangUp':
        this.peers?.hangUp(message.id, message.peer);
        break;
      case 'closed':
        this.peers?.close();
        this.peers = null;
        break;
    }
  }

  /**
   * A cvar the server or the game set in the worker's store, held in the page's as it is held
   * there, and not sent back.
   */
  private mirror(name: string, value: string): void {
    this.mirroring = true;
    try {
      this.cvars.mirror(name, value);
    } finally {
      this.mirroring = false;
    }
  }

  /** The server's peers and masters, where the page has them and the worker can take channels. */
  private openPeers(channels: boolean): void {
    const options = this.peersOptions;
    if (options === undefined) return;
    if (!channels) {
      this.printLine(
        "WARNING: this browser can't hand a data channel to a worker, so only this tab can play " +
          'on this server'
      );
      return;
    }
    this.peers = new HostPeers({
      ...options,
      cvars: this.cvars,
      post: (message, transfer) => this.worker.postMessage(message, transfer),
      now: this.now,
      print: this.printLine
    });
  }

  /** `CL_MapLoading`: the client's world is going away, as the server's load starts. */
  private setMapLoad(loading: boolean): void {
    if (loading === (this.mapLoad !== null)) return;
    if (loading) {
      this.mapLoad = new Promise<void>((resolve) => {
        this.mapLoadDone = resolve;
      });
      for (const listener of this.loadListeners) listener();
    } else {
      this.mapLoadDone?.();
      this.mapLoadDone = null;
      this.mapLoad = null;
    }
  }

  /** Read the map the worker asked for, and answer with it or with what went wrong. */
  private async answerRead(id: number, name: string): Promise<void> {
    try {
      const data = await this.maps.read(name);
      const answer: PageToWorker = { type: 'map', id, data };
      // The map's bytes move rather than copy: the page read them for the worker.
      this.worker.postMessage(answer, hostMapTransfer(data));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'mapFailed', id, message });
    }
  }

  private post(message: PageToWorker, transfer?: Transferable[]): void {
    this.worker.postMessage(message, transfer);
  }
}

/** The page's own worker: the server program in its own thread. */
function hostWorker(): WorkerLike {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
    onMessage: (listener) => {
      worker.onmessage = (event) => listener(event.data);
    }
  };
}
