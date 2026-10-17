import { MessageLoopback } from '../net/loopback';
import { PeerSocket, type DataChannelLike } from '../net/peer-socket';
import { Cvars } from '../settings/cvars';
import { placePlayer } from '../sim/teleport';
import { hostMapFromData, type HostMapData } from './host-map';
import { SV_FPS } from '../net/snapshot-rate';
import type { HostMap } from './host';
import { MAX_FRAME_MSEC, ServerProgram, nextFrameWait } from './program';
import type { DevRequest, PageToWorker, WorkerToPage } from './worker-messages';

/**
 * The page's server program, running where a listen server's host runs: its own worker.
 *
 * The frames are the worker's own — {@link ServerWorker.frame} carries the real time that passed,
 * clamped as `Com_ModifyMsec` clamps a listen server's — and everything else crosses as messages:
 * the wire's packets, the console's lines, the store's values and the state the page reads.
 *
 * Players elsewhere reach the program through its own socket: the page makes each peer connection,
 * since a worker cannot, and moves its data channel here, where the socket sends and reads it with
 * no page between. What has no channel crosses to the page, whose signalling routes it.
 */

/** The worker's end of the page's messages, and of its own scope. */
export interface WorkerPort {
  /**
   * @param transfer - Buffers the message's own arrays can move in, so a packet's bytes cross
   *   without a second copy.
   */
  post(message: WorkerToPage, transfer?: Transferable[]): void;
  onMessage(listener: (message: PageToWorker) => void): void;
  /** `Sys_Milliseconds` in this scope: the clock the net's own timing reads. */
  now(): number;
  /** Let this scope go, as `self.close()` does. */
  close(): void;
  /** Whether a data channel can be moved to this scope: `RTCDataChannel` is here. */
  readonly channels: boolean;
  /**
   * Told each error a frame throws, before `Com_Error` takes it: the entry logs its stack, where
   * Q3 has none to log.
   */
  onError?(err: Error): void;
}

/** A running server worker: the entry drives it with the time its timer measured. */
export interface ServerWorker {
  /** One frame of the program, `msec` of real time after the last. */
  frame(msec: number): void;
  /**
   * How long the entry's timer waits for the next frame: one game frame, read afresh each time,
   * as `SV_FrameMsec` is. The leftover fraction is `Host`'s own accumulator.
   */
  readonly frameMsec: number;
  /**
   * How long the entry's timer waits before the next frame, as `SV_FrameMsec`'s wait: one game
   * frame less what the `Host` has already accrued and the time just spent running the frame.
   *
   * @param spentMsec - The time the frame just run has taken.
   */
  waitMsec(spentMsec: number): number;
}

/**
 * Start the program the page booted, and hear what it has to say.
 *
 * @param port - The worker's boundary: `worker.ts` passes its own scope.
 */
export function startServerWorker(port: WorkerPort): ServerWorker {
  /** The program, once the boot has come. Nothing crosses before it. */
  let program: ServerProgram | null = null;
  /** The worker's store: the page's values, and every change it tells. */
  let store: Cvars | null = null;
  /** While the store takes a change the page told, which is the page's already. */
  let fromPage = false;
  /** The wire's loopback: what the page sent, and what is posted back. */
  let loopback: MessageLoopback | null = null;
  /** The socket to players elsewhere, where channels can be moved here. */
  let socket: PeerSocket | null = null;
  /** Each channel the page moved here, by the number it gave it. */
  const channelIds = new WeakMap<DataChannelLike, number>();
  /** The maps the page's search path had at the boot, which `SV_Map_f`'s check reads. */
  let names: ReadonlySet<string> = new Set();
  /** The map reads waiting for the page's answer, by the id they went out under. */
  const reads = new Map<number, { resolve: (map: HostMap) => void; reject: (err: Error) => void }>();
  let nextRead = 1;
  /** What the page was last told, so that only what moved crosses. */
  let toldPaused = false;
  let toldRunning = false;
  let toldPending = false;
  let toldLoading = false;
  let toldFailure: string | null = null;
  /** `Com_Printf`: the program's lines, and collision's, for the page's console. */
  const print = (text: string): void => port.post({ type: 'print', text });
  /**
   * A map the page read, built here as `CM_LoadMap` builds it, with the store collision reads.
   * What collision refuses is thrown, as its `ERR_DROP`.
   */
  const buildMap = (data: HostMapData): HostMap =>
    hostMapFromData(data, { cvars: store ?? undefined, print });

  const tell = (running: ServerProgram): void => {
    if (
      running.svPaused !== toldPaused ||
      running.svRunning !== toldRunning ||
      running.commandsPending !== toldPending
    ) {
      toldPaused = running.svPaused;
      toldRunning = running.svRunning;
      toldPending = running.commandsPending;
      port.post({
        type: 'state',
        svPaused: toldPaused,
        svRunning: toldRunning,
        commandsPending: toldPending
      });
    }
    const loading = running.mapLoad !== null;
    if (loading !== toldLoading) {
      toldLoading = loading;
      port.post({ type: 'mapLoad', loading });
    }
    const failure = running.failure?.message ?? null;
    if (failure !== null && failure !== toldFailure) {
      toldFailure = failure;
      port.post({ type: 'failure', message: failure });
    }
  };

  /**
   * `Com_Frame`'s `setjmp( abortframe )` (`common.c:3097–3099`) round a turn of the program's:
   * whatever throws is `Com_Error`'s drop. The program stands where it stopped, and the page, told
   * as a failed load tells it, drops the match and shuts the server down with it.
   */
  const guarded = (turn: (running: ServerProgram) => void): void => {
    if (program === null) return;
    if (program.failure === null) {
      try {
        turn(program);
      } catch (err) {
        program.failure = err instanceof Error ? err : new Error(String(err));
        port.onError?.(program.failure);
      }
    }
    tell(program);
  };

  /** `SV_Map_f`'s read, answered by the page's search path. */
  const readMap = (name: string): Promise<HostMap> =>
    new Promise((resolve, reject) => {
      const id = nextRead++;
      reads.set(id, { resolve, reject });
      port.post({ type: 'readMap', id, name });
    });

  /**
   * A live check's ask: the server's own state — the host's clock and map, which the page
   * holds only as mirrors — and the debug mutations, a cvar set where the server reads it and a
   * client put somewhere.
   */
  const answerDev = (id: number, request: DevRequest): void => {
    if (program === null) return;
    if (request.op === 'cvar') store?.load(request.name, request.value);
    if (request.op === 'place') {
      const { host } = program;
      placePlayer(host.gentityNum(request.client), request.origin, request.angles, (entity) =>
        host.linkEntity(entity)
      );
    }
    port.post({
      type: 'devResult',
      id,
      state: {
        hostTime: program.host.time,
        map: program.host.map?.name ?? null,
        entities: program.host.map?.entities.length ?? 0,
        svPaused: program.svPaused,
        svRunning: program.svRunning,
        commandsPending: program.commandsPending,
        clients: program.host.clients.length
      }
    });
  };

  port.onMessage((message) => {
    switch (message.type) {
      case 'boot': {
        store = new Cvars({ debugMode: message.debugMode });
        for (const { name, value } of message.cvars) store.load(name, value);
        // What the store sets from here on, the program's own writes from its first, crosses to the
        // page's, so the page holds what Quake 3's one store would.
        store.onCvarChange((name, value) => {
          if (!fromPage) port.post({ type: 'cvar', name, value });
        });
        names = new Set(message.mapNames);
        loopback = new MessageLoopback((data, transfer) =>
          port.post({ type: 'packet', data }, transfer)
        );
        socket = port.channels
          ? new PeerSocket({
              now: () => port.now(),
              route: {
                send: (data, to) => port.post({ type: 'route', data, to }),
                hangUp: (peer, channel) => {
                  const id = channelIds.get(channel);
                  if (id !== undefined) port.post({ type: 'hangUp', id, peer });
                }
              }
            })
          : null;
        // `SV_SpawnServer`'s `CM_LoadMap`: a map collision refuses stops the server as it starts.
        let map: HostMap | undefined;
        let refused: Error | null = null;
        try {
          map = buildMap(message.map);
        } catch (err) {
          refused = err instanceof Error ? err : new Error(String(err));
        }
        program = new ServerProgram({
          cvars: store,
          map,
          maps: {
            // The search path lowercases what it reads, and `map <n>` takes any case.
            exists: (name) => names.has(name.toLowerCase()),
            load: (name) => readMap(name)
          },
          botFiles: message.botFiles,
          loopback,
          socket,
          now: () => port.now(),
          print
        });
        if (socket !== null) socket.onArrival = () => guarded((running) => running.readArrivals());
        program.failure = refused;
        port.post({ type: 'ready', channels: port.channels });
        tell(program);
        break;
      }
      case 'channel':
        channelIds.set(message.channel, message.id);
        socket?.attach(message.peer, message.channel);
        break;
      case 'deliver':
        socket?.deliver({ from: message.from, data: message.data });
        break;
      case 'packet':
        loopback?.deliver(message.data);
        break;
      case 'command':
        program?.sendConsoleCommand(message.line);
        break;
      case 'cvar':
        // `load`, as `exec` sets one at start: a value the page holds is the value here, whether
        // or not the store's own rules would take it from a client.
        fromPage = true;
        try {
          store?.load(message.name, message.value);
        } finally {
          fromPage = false;
        }
        break;
      case 'map': {
        const read = reads.get(message.id);
        reads.delete(message.id);
        if (!read) break;
        try {
          read.resolve(buildMap(message.data));
        } catch (err) {
          read.reject(err instanceof Error ? err : new Error(String(err)));
        }
        break;
      }
      case 'mapFailed': {
        const read = reads.get(message.id);
        reads.delete(message.id);
        read?.reject(new Error(message.message));
        break;
      }
      case 'shutdown':
        program?.shutdown(message.finalMessage, message.error);
        port.post({ type: 'closed' });
        port.close();
        break;
      case 'dev':
        // The live checks' handle. DEV only: a built worker answers nothing, and a built
        // page never asks.
        if (import.meta.env.DEV) answerDev(message.id, message.request);
        break;
    }
  });

  return {
    frame(msec: number): void {
      guarded((running) => {
        running.runFrame(Math.min(msec, MAX_FRAME_MSEC));
        running.flushPackets();
      });
    },
    // Before the boot there is no host, and the default frame is as good a wait as any.
    get frameMsec(): number {
      return program?.host.frameMsec ?? 1000 / SV_FPS;
    },
    waitMsec(spentMsec: number): number {
      return nextFrameWait(
        program?.host.frameMsec ?? 1000 / SV_FPS,
        program?.residualMsec ?? 0,
        spentMsec
      );
    }
  };
}
